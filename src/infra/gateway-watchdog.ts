import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isLikelySupervisedProcess } from "./process-respawn.js";

const log = createSubsystemLogger("watchdog");

const MAX_RESTARTS_PER_HOUR = 5;
const STABLE_UPTIME_RESET_MS = 300_000; // 5 min of stable uptime resets backoff
const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const RESTART_WINDOW_MS = 3_600_000; // 1 hour

export const WATCHDOG_CHILD_ENV = "OPENCLAW_WATCHDOG_CHILD";

export type WatchdogState = {
  pid: number;
  childPid: number | null;
  restarts: number;
  lastCrashAt: string | null;
  startedAt: string;
  status: "running" | "restarting" | "gave-up" | "stopped";
};

export type WatchdogOptions = {
  /** Override process.argv for the child (testing). */
  argv?: string[];
  /** Override process.execPath for the child (testing). */
  execPath?: string;
  /** Override process.execArgv for the child (testing). */
  execArgv?: string[];
  /** Override state directory (testing). */
  stateDir?: string;
  /** Override env for supervised detection (testing). */
  env?: NodeJS.ProcessEnv;
  /** Override max restarts per hour (testing). */
  maxRestartsPerHour?: number;
  /** Override stable uptime threshold for backoff reset (testing). */
  stableUptimeMs?: number;
  /** Callback when child exits — for testing observability. */
  onChildExit?: (code: number | null, signal: string | null) => void;
  /** Callback when watchdog gives up — for testing. */
  onGiveUp?: () => void;
};

function resolveWatchdogStatePath(stateDir?: string): string {
  const dir = stateDir ?? resolveStateDir();
  return path.join(dir, "watchdog.json");
}

function writeWatchdogState(state: WatchdogState, stateDir?: string): void {
  const statePath = resolveWatchdogStatePath(stateDir);
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    log.warn(`failed to write watchdog state: ${String(err)}`);
  }
}

export function readWatchdogState(stateDir?: string): WatchdogState | null {
  const statePath = resolveWatchdogStatePath(stateDir);
  try {
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content) as WatchdogState;
  } catch {
    return null;
  }
}

/** Build child argv by stripping --watchdog from parent args. */
export function buildChildArgv(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--watchdog");
}

/**
 * Start the gateway watchdog supervisor.
 * Spawns the gateway as a child process and monitors it for crashes.
 * On crash: restarts with exponential backoff, rate-limited.
 * On clean exit (code 0): stops.
 * Returns a promise that resolves when the watchdog stops.
 */
export async function startGatewayWatchdog(opts: WatchdogOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;

  if (isLikelySupervisedProcess(env)) {
    log.info("supervised environment detected (launchd/systemd); skipping watchdog");
    return;
  }

  const maxRestarts = opts.maxRestartsPerHour ?? MAX_RESTARTS_PER_HOUR;
  const stableUptime = opts.stableUptimeMs ?? STABLE_UPTIME_RESET_MS;
  const restartTimestamps: number[] = [];
  let backoffMs = INITIAL_BACKOFF_MS;
  let child: ChildProcess | null = null;
  let shuttingDown = false;

  const state: WatchdogState = {
    pid: process.pid,
    childPid: null,
    restarts: 0,
    lastCrashAt: null,
    startedAt: new Date().toISOString(),
    status: "running",
  };

  writeWatchdogState(state, opts.stateDir);

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child && !child.killed) {
      child.kill(signal);
    }
  };

  const onSigterm = () => {
    log.info("watchdog received SIGTERM; forwarding to child and shutting down");
    shuttingDown = true;
    forwardSignal("SIGTERM");
  };
  const onSigint = () => {
    log.info("watchdog received SIGINT; forwarding to child and shutting down");
    shuttingDown = true;
    forwardSignal("SIGINT");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  const cleanup = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    // Preserve terminal statuses like "gave-up"; only default to "stopped"
    if (state.status !== "gave-up") {
      state.status = "stopped";
    }
    state.childPid = null;
    writeWatchdogState(state, opts.stateDir);
  };

  const spawnChild = (): ChildProcess => {
    const execPath = opts.execPath ?? process.execPath;
    const execArgv = opts.execArgv ?? process.execArgv;
    const rawArgv = opts.argv ?? process.argv.slice(1);
    const childArgv = buildChildArgv(rawArgv);
    const args = [...execArgv, ...childArgv];

    const childEnv = { ...env, [WATCHDOG_CHILD_ENV]: "1" };

    const spawned = spawn(execPath, args, {
      env: childEnv,
      stdio: "inherit",
    });

    // Prevent unhandled 'error' from crashing the watchdog (e.g. invalid execPath)
    spawned.on("error", (err) => {
      log.warn(`child process error: ${String(err)}`);
    });

    state.childPid = spawned.pid ?? null;
    state.status = "running";
    writeWatchdogState(state, opts.stateDir);

    log.info(`spawned gateway child pid=${spawned.pid ?? "unknown"}`);
    return spawned;
  };

  const isRateLimited = (): boolean => {
    const now = Date.now();
    // Prune timestamps older than 1 hour
    while (restartTimestamps.length > 0 && now - restartTimestamps[0] > RESTART_WINDOW_MS) {
      restartTimestamps.shift();
    }
    return restartTimestamps.length >= maxRestarts;
  };

  return new Promise<void>((resolve) => {
    const runChild = () => {
      child = spawnChild();
      const childStartedAt = Date.now();

      child.on("exit", (code, signal) => {
        opts.onChildExit?.(code, signal);

        if (shuttingDown || code === 0) {
          const reason = shuttingDown ? "watchdog shutting down" : "child exited cleanly";
          log.info(`${reason} (code=${code}, signal=${signal})`);
          cleanup();
          resolve();
          return;
        }

        log.warn(`gateway child crashed (code=${code}, signal=${signal})`);
        state.lastCrashAt = new Date().toISOString();

        // Reset backoff if child was stable long enough
        const uptime = Date.now() - childStartedAt;
        if (uptime >= stableUptime) {
          backoffMs = INITIAL_BACKOFF_MS;
        }

        if (isRateLimited()) {
          log.error(
            `gateway crashed ${maxRestarts} times in the last hour; giving up. ` +
              "Check logs and restart manually.",
          );
          state.status = "gave-up";
          state.childPid = null;
          writeWatchdogState(state, opts.stateDir);
          opts.onGiveUp?.();
          cleanup();
          resolve();
          return;
        }

        restartTimestamps.push(Date.now());
        state.restarts++;
        state.status = "restarting";
        writeWatchdogState(state, opts.stateDir);

        log.info(`restarting gateway in ${backoffMs}ms (restart #${state.restarts})`);

        setTimeout(() => {
          if (shuttingDown) {
            cleanup();
            resolve();
            return;
          }
          runChild();
        }, backoffMs);

        // Exponential backoff
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      });
    };

    runChild();
  });
}
