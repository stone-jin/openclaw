import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildChildArgv,
  readWatchdogState,
  startGatewayWatchdog,
  WATCHDOG_CHILD_ENV,
} from "./gateway-watchdog.js";

function createFakeChild(): EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid: 9999,
    killed: false,
    kill: vi.fn(),
  });
}

describe("buildChildArgv", () => {
  it("strips --watchdog from argv", () => {
    expect(buildChildArgv(["gateway", "run", "--watchdog", "--port", "18789"])).toEqual([
      "gateway",
      "run",
      "--port",
      "18789",
    ]);
  });

  it("returns unchanged argv when --watchdog is absent", () => {
    expect(buildChildArgv(["gateway", "run", "--port", "18789"])).toEqual([
      "gateway",
      "run",
      "--port",
      "18789",
    ]);
  });

  it("handles empty argv", () => {
    expect(buildChildArgv([])).toEqual([]);
  });
});

describe("startGatewayWatchdog", () => {
  const tmpDir = path.join("/tmp", `test-watchdog-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips when supervised environment detected", async () => {
    const promise = startGatewayWatchdog({
      env: { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" },
      stateDir: tmpDir,
    });
    await promise;
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns child and exits cleanly on code 0", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
      onChildExit: (code, signal) => exits.push({ code, signal }),
    });

    // Simulate clean exit
    fakeChild.emit("exit", 0, null);
    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([{ code: 0, signal: null }]);

    // Verify child args don't include --watchdog
    const spawnArgs = spawnMock.mock.calls[0];
    expect(spawnArgs[1]).toEqual(["gateway", "run"]);

    // Verify child env has OPENCLAW_WATCHDOG_CHILD=1
    expect(spawnArgs[2].env[WATCHDOG_CHILD_ENV]).toBe("1");

    // State file should show stopped
    const state = readWatchdogState(tmpDir);
    expect(state?.status).toBe("stopped");
  });

  it("restarts child on crash exit", async () => {
    vi.useFakeTimers();
    const children: Array<ReturnType<typeof createFakeChild>> = [];

    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });

    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
      onChildExit: (code, signal) => exits.push({ code, signal }),
    });

    // First child crashes
    children[0].emit("exit", 1, null);
    expect(exits).toEqual([{ code: 1, signal: null }]);

    // Advance past initial backoff (1s)
    await vi.advanceTimersByTimeAsync(1_100);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Second child exits cleanly
    children[1].emit("exit", 0, null);
    await promise;

    expect(exits).toHaveLength(2);
    expect(exits[1]).toEqual({ code: 0, signal: null });

    // State should show 1 restart
    const state = readWatchdogState(tmpDir);
    expect(state?.restarts).toBe(1);

    vi.useRealTimers();
  });

  it("gives up after exceeding max restarts per hour", async () => {
    vi.useFakeTimers();
    const children: Array<ReturnType<typeof createFakeChild>> = [];

    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });

    let gaveUp = false;
    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
      maxRestartsPerHour: 2,
      onGiveUp: () => {
        gaveUp = true;
      },
    });

    // Crash #1
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_100);

    // Crash #2
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(2_200);

    // Crash #3 — should give up (exceeded max 2)
    children[2].emit("exit", 1, null);
    await promise;

    expect(gaveUp).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    const state = readWatchdogState(tmpDir);
    expect(state?.status).toBe("stopped");

    vi.useRealTimers();
  });

  it("resets backoff after stable uptime", async () => {
    vi.useFakeTimers();
    const children: Array<ReturnType<typeof createFakeChild>> = [];

    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });

    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
      stableUptimeMs: 100, // short threshold for test
    });

    // Crash #1 — backoff starts at 1s
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Simulate stable uptime (>100ms) then crash — backoff should reset
    await vi.advanceTimersByTimeAsync(200);
    children[1].emit("exit", 1, null);

    // If backoff reset, next wait should be ~1s (not 2s)
    await vi.advanceTimersByTimeAsync(1_100);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // Clean exit
    children[2].emit("exit", 0, null);
    await promise;

    vi.useRealTimers();
  });

  it("forwards SIGTERM to child on shutdown", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
    });

    // Simulate SIGTERM
    process.emit("SIGTERM" as unknown as "exit");

    // Child should receive the signal
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate child exiting after signal
    fakeChild.emit("exit", 0, "SIGTERM");
    await promise;
  });

  it("writes state file on startup", async () => {
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const promise = startGatewayWatchdog({
      argv: ["gateway", "run", "--watchdog"],
      execPath: "/usr/bin/node",
      execArgv: [],
      stateDir: tmpDir,
      env: {},
    });

    // State should be written immediately
    const state = readWatchdogState(tmpDir);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("running");
    expect(state?.pid).toBe(process.pid);
    expect(state?.childPid).toBe(9999);
    expect(state?.restarts).toBe(0);

    fakeChild.emit("exit", 0, null);
    await promise;
  });
});

describe("readWatchdogState", () => {
  const tmpDir = path.join("/tmp", `test-watchdog-read-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when state file does not exist", () => {
    expect(readWatchdogState(tmpDir)).toBeNull();
  });

  it("reads state from file", () => {
    const state = {
      pid: 1234,
      childPid: 5678,
      restarts: 3,
      lastCrashAt: "2026-02-25T00:00:00.000Z",
      startedAt: "2026-02-25T00:00:00.000Z",
      status: "running",
    };
    fs.writeFileSync(path.join(tmpDir, "watchdog.json"), JSON.stringify(state));
    const result = readWatchdogState(tmpDir);
    expect(result).toEqual(state);
  });

  it("returns null on corrupted file", () => {
    fs.writeFileSync(path.join(tmpDir, "watchdog.json"), "not json");
    expect(readWatchdogState(tmpDir)).toBeNull();
  });
});
