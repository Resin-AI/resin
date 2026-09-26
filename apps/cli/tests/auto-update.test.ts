import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { mcpCommand } from "../src/commands/mcp.js";
import { formatStaleMcpGateways } from "../src/commands/status.js";
import type { ResolvedProductionRelease } from "../src/installer/release-client.js";
import { detectPlatform } from "../src/platform/index.js";
import { runServiceSupervisor } from "../src/service/manager.js";
import type { RecoveryStateTracker } from "../src/service/recovery-state.js";
import {
  type AutoUpdateState,
  createAutoUpdateState,
  readAutoUpdateNotice,
  readAutoUpdateState,
  writeAutoUpdateState,
} from "../src/updates/auto-update-state.js";
import {
  type AutoUpdateAutomationOptions,
  UPDATE_WORKER_COMMAND,
  buildSystemdRunArguments,
  isManagedReleaseInstall,
  launchUpdateWorker,
  runUpdateWorker,
  runUpdateWorkerCommand,
  startAutoUpdateAutomation,
} from "../src/updates/auto-update.js";
import {
  type UpdateCheckResult,
  UpdateEngine,
  type UpdateEngineResult,
  type UpdateStatusSnapshot,
} from "../src/updates/engine.js";
import {
  listRunningGateways,
  registerRunningGateway,
  resolveGatewayRegistryDir,
} from "../src/updates/gateway-registry.js";
import { DEFAULT_UPDATE_POLICY, type UpdatePolicy } from "../src/updates/policy.js";
import type { SchedulerTimerHandle } from "../src/updates/scheduler.js";

const START = Date.parse("2026-09-26T12:00:00.000Z");
const MINUTE = 60_000;

interface ManualTimer {
  readonly handle: { id: number; unref: () => void };
  readonly at: number;
  readonly callback: () => void;
}

/** Deterministic clock and timer queue shared by the automation and its scheduler. */
function createManualTime(start = START) {
  let now = start;
  let nextId = 1;
  let pending: ManualTimer[] = [];
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  };
  return {
    clock: () => now,
    scheduleTimer(callback: () => void, delayMs: number): SchedulerTimerHandle {
      const handle = { id: nextId++, unref: () => undefined };
      pending.push({ handle, at: now + delayMs, callback });
      return handle;
    },
    cancelTimer(handle: SchedulerTimerHandle): void {
      pending = pending.filter((timer) => timer.handle !== handle);
    },
    get pendingCount() {
      return pending.length;
    },
    flush,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      await flush();
      while (true) {
        const due = pending
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        pending = pending.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        due.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function checkResult(
  status: UpdateCheckResult["status"],
  policy: UpdatePolicy = { ...DEFAULT_UPDATE_POLICY },
  extra: Partial<UpdateCheckResult> = {},
): UpdateCheckResult {
  return {
    status,
    policy,
    channel: policy.channel,
    currentVersion: "1.0.0",
    targetVersion: status === "disabled" ? undefined : "1.1.0",
    ...extra,
  };
}

function createAutomationFixture(
  options: {
    policy?: UpdatePolicy;
    check?: () => Promise<UpdateCheckResult>;
    initialState?: AutoUpdateState | null;
    journal?: UpdateStatusSnapshot | null;
    launchWorker?: () => Promise<void>;
  } = {},
) {
  const time = createManualTime();
  let policy = options.policy ?? { ...DEFAULT_UPDATE_POLICY };
  const checkForUpdate = vi.fn(
    options.check ?? (async () => checkResult("update-available", policy)),
  );
  const readPolicy = vi.fn(async () => policy);
  const launchWorker = vi.fn(options.launchWorker ?? (async () => undefined));
  const notifications: string[] = [];
  const writes: AutoUpdateState[] = [];
  const reports: string[] = [];
  let journal = options.journal ?? null;
  const automationOptions: AutoUpdateAutomationOptions = {
    resinHome: "/unused/.resin",
    checker: { checkForUpdate, readPolicy },
    launchWorker,
    readJournal: async () => journal,
    publishNotification: async (state) => {
      notifications.push(state);
    },
    readState: async () => options.initialState ?? null,
    writeState: async (state) => {
      writes.push(state);
    },
    clock: time.clock,
    random: () => 0.5,
    scheduleTimer: time.scheduleTimer,
    cancelTimer: time.cancelTimer,
    report: (message) => {
      reports.push(message);
    },
  };
  return {
    time,
    checkForUpdate,
    readPolicy,
    launchWorker,
    notifications,
    writes,
    reports,
    automationOptions,
    setPolicy(next: UpdatePolicy) {
      policy = next;
    },
    setJournal(next: UpdateStatusSnapshot | null) {
      journal = next;
    },
    get lastState() {
      return writes.at(-1);
    },
  };
}

function journal(patch: Partial<UpdateStatusSnapshot>): UpdateStatusSnapshot {
  return {
    schemaVersion: 1,
    channel: "stable",
    currentVersion: "1.0.0",
    targetVersion: null,
    pendingVersion: null,
    lastCheckAt: null,
    lastResult: null,
    lastError: null,
    lastRollback: null,
    quarantine: [],
    ...patch,
  };
}

describe("resident automatic update automation", () => {
  it("checks after startup and launches the out-of-service worker for a newer signed release", async () => {
    const fixture = createAutomationFixture();
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(59_000);
    expect(fixture.checkForUpdate).not.toHaveBeenCalled();

    await fixture.time.advance(1_000);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    expect(fixture.launchWorker).toHaveBeenCalledOnce();
    expect(fixture.lastState).toMatchObject({
      scheduler: { lastSuccessfulCheckAtMs: START + MINUTE, offlineFailureCount: 0 },
      lastCheck: { outcome: "worker-launched", targetVersion: "1.1.0", error: null },
      nextCheckAt: new Date(START + MINUTE + 360 * MINUTE).toISOString(),
    });

    // Next check happens one interval later, not before.
    await fixture.time.advance(359 * MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    await fixture.time.advance(MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledTimes(2);
    automation.stop();
  });

  it("performs no checks or installs while updates.autoUpdate is false, and resumes when re-enabled", async () => {
    const disabled = { ...DEFAULT_UPDATE_POLICY, autoUpdate: false };
    const fixture = createAutomationFixture({ policy: disabled });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(3 * 24 * 60 * MINUTE);
    expect(fixture.checkForUpdate).not.toHaveBeenCalled();
    expect(fixture.launchWorker).not.toHaveBeenCalled();

    fixture.setPolicy({ ...DEFAULT_UPDATE_POLICY });
    await fixture.time.advance(5 * MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    expect(fixture.launchWorker).toHaveBeenCalledOnce();
    automation.stop();
  });

  it("defers checks outside the maintenance window until it opens", async () => {
    const windowed: UpdatePolicy = {
      ...DEFAULT_UPDATE_POLICY,
      maintenanceWindow: { start: "02:00", end: "04:00", timeZone: "UTC" },
    };
    const fixture = createAutomationFixture({ policy: windowed });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(13 * 60 * MINUTE); // 01:00 UTC next day
    expect(fixture.checkForUpdate).not.toHaveBeenCalled();
    expect(fixture.lastState?.nextCheckAt).toBe("2026-09-27T02:00:00.000Z");

    await fixture.time.advance(60 * MINUTE); // 02:00 UTC
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    automation.stop();
  });

  it("backs off without crashing or installing while the release endpoint is unreachable", async () => {
    const fixture = createAutomationFixture({
      check: async () => checkResult("offline", undefined, { error: "ECONNREFUSED" }),
    });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    expect(fixture.lastState).toMatchObject({
      scheduler: { offlineFailureCount: 1, lastSuccessfulCheckAtMs: null },
      lastCheck: { outcome: "offline", error: "ECONNREFUSED" },
    });

    // Backoff grows (60s, 120s, 240s...) instead of retrying in a tight loop.
    await fixture.time.advance(59_000);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    await fixture.time.advance(2 * MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledTimes(2);
    await fixture.time.advance(60 * MINUTE);
    expect(fixture.checkForUpdate.mock.calls.length).toBeLessThanOrEqual(7);
    expect(fixture.launchWorker).not.toHaveBeenCalled();
    automation.stop();
  });

  it("resumes the persisted interval instead of checking again after a restart", async () => {
    const initialState: AutoUpdateState = {
      ...createAutoUpdateState(),
      scheduler: {
        lastSuccessfulCheckAtMs: START - 60 * MINUTE,
        offlineFailureCount: 0,
        offlineRetryAtMs: null,
      },
    };
    const fixture = createAutomationFixture({ initialState });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(290 * MINUTE);
    expect(fixture.checkForUpdate).not.toHaveBeenCalled();
    await fixture.time.advance(10 * MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
    automation.stop();
  });

  it("retries a staged activation deferred by in-flight work", async () => {
    const fixture = createAutomationFixture({
      check: async () => checkResult("already-current"),
      journal: journal({ lastResult: "activation-deferred", pendingVersion: "1.1.0" }),
    });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(MINUTE);
    expect(fixture.launchWorker).not.toHaveBeenCalled();
    await fixture.time.advance(15 * MINUTE);
    expect(fixture.launchWorker).toHaveBeenCalledOnce();
    expect(fixture.lastState?.lastCheck).toMatchObject({
      outcome: "activation-retry",
      targetVersion: "1.1.0",
    });

    fixture.setJournal(journal({ lastResult: "activated", currentVersion: "1.1.0" }));
    await fixture.time.advance(15 * MINUTE);
    expect(fixture.launchWorker).toHaveBeenCalledOnce();
    automation.stop();
  });

  it("raises a failure notification for rejected releases and clears it once current", async () => {
    let status: UpdateCheckResult["status"] = "failed";
    const fixture = createAutomationFixture({
      check: async () => checkResult(status, undefined, { error: "signature verification failed" }),
    });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(MINUTE);
    expect(fixture.launchWorker).not.toHaveBeenCalled();
    expect(fixture.notifications).toEqual(["failed"]);
    expect(fixture.lastState?.lastCheck?.outcome).toBe("failed");

    status = "already-current";
    await fixture.time.advance(360 * MINUTE);
    expect(fixture.notifications).toEqual(["failed", "clear"]);
    automation.stop();
  });

  it("backs off when the worker cannot be started", async () => {
    const fixture = createAutomationFixture({
      launchWorker: async () => {
        throw new Error("systemd-run failed");
      },
    });
    const automation = startAutoUpdateAutomation(fixture.automationOptions);

    await fixture.time.advance(MINUTE);
    expect(fixture.lastState).toMatchObject({
      scheduler: { offlineFailureCount: 1 },
      lastCheck: { outcome: "worker-launch-failed", error: "systemd-run failed" },
    });
    automation.stop();
  });

  it("stops all timers when the resident service shuts down", async () => {
    const fixture = createAutomationFixture();
    const automation = startAutoUpdateAutomation(fixture.automationOptions);
    await fixture.time.advance(MINUTE);
    expect(fixture.time.pendingCount).toBeGreaterThan(0);

    automation.stop();
    expect(fixture.time.pendingCount).toBe(0);
    await fixture.time.advance(7 * 24 * 60 * MINUTE);
    expect(fixture.checkForUpdate).toHaveBeenCalledOnce();
  });
});

describe("resident service entrypoint", () => {
  it("starts automatic updates with the supervisor and triggers a background update", async () => {
    const fixture = createAutomationFixture();
    const shutdown = new AbortController();
    const { promise: stateReady, resolve: releaseState } = Promise.withResolvers<void>();
    const state = {
      version: 1 as const,
      status: "HEALTHY" as const,
      restartCount: 0,
      crashTimestamps: [],
    };
    // SAFETY: Partial tracker implementing only getState, which the supervisor loop reads.
    const tracker = {
      getState: vi.fn(async () => {
        await stateReady;
        return state;
      }),
    } as unknown as RecoveryStateTracker;
    const stop = vi.fn();
    const factory = vi.fn((options: { resinHome: string }) => {
      const automation = startAutoUpdateAutomation({
        ...fixture.automationOptions,
        resinHome: options.resinHome,
      });
      return {
        stop() {
          stop();
          automation.stop();
        },
      };
    });

    const supervisor = runServiceSupervisor({
      command: process.execPath,
      args: ["-e", ""],
      resinHome: "/home/supervisor/.resin",
      tracker,
      signal: shutdown.signal,
      autoUpdateFactory: factory,
    });

    expect(factory).toHaveBeenCalledWith({ resinHome: "/home/supervisor/.resin" });
    await fixture.time.advance(MINUTE);
    expect(fixture.launchWorker).toHaveBeenCalledOnce();

    shutdown.abort();
    releaseState();
    await expect(supervisor).resolves.toMatchObject({ reason: "SHUTDOWN" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps supervising the daemon when automatic updates fail to start", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    // SAFETY: Partial tracker implementing only getState, which the supervisor loop reads.
    const tracker = {
      getState: vi.fn(async () => ({
        version: 1 as const,
        status: "HEALTHY" as const,
        restartCount: 0,
        crashTimestamps: [],
      })),
    } as unknown as RecoveryStateTracker;
    const reports: string[] = [];

    const result = await runServiceSupervisor({
      command: "unused",
      resinHome: "/home/supervisor/.resin",
      tracker,
      signal: shutdown.signal,
      report: (message) => reports.push(message),
      autoUpdateFactory: () => {
        throw new Error("boom");
      },
    });

    expect(result.reason).toBe("SHUTDOWN");
    expect(reports.join("\n")).toContain("automatic updates unavailable");
  });

  it("only enables automatic updates for versioned release installs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-managed-install-"));
    try {
      const resinHome = path.join(root, ".resin");
      const versionEntry = path.join(resinHome, "versions", "v1.0.0", "apps", "cli", "dist");
      await fs.mkdir(versionEntry, { recursive: true });
      await fs.writeFile(path.join(versionEntry, "index.js"), "");
      await fs.symlink(path.join(resinHome, "versions", "v1.0.0"), path.join(resinHome, "current"));
      const checkout = path.join(root, "checkout", "apps", "cli", "dist");
      await fs.mkdir(checkout, { recursive: true });
      await fs.writeFile(path.join(checkout, "index.js"), "");

      expect(
        isManagedReleaseInstall(resinHome, path.join(resinHome, "current/apps/cli/dist/index.js")),
      ).toBe(true);
      expect(isManagedReleaseInstall(resinHome, path.join(checkout, "index.js"))).toBe(false);
      expect(
        isManagedReleaseInstall(path.join(root, "missing"), path.join(checkout, "index.js")),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("update worker launch", () => {
  it("uses a separate transient systemd unit when the service runs under systemd", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const spawnDetached = vi.fn();

    const method = await launchUpdateWorker({
      resinHome: "/home/u/.resin",
      nodePath: "/usr/bin/node",
      entryPath: "/home/u/.resin/versions/v1.0.0/apps/cli/dist/index.js",
      env: {
        INVOCATION_ID: "abc",
        PATH: "/usr/bin",
        RESIN_RELEASE_CHANNEL_URL: "https://dist.resin.sh/releases/v1/channels.json",
        RESIN_API_TOKEN: "secret-value",
      },
      runner: { run },
      spawnDetached,
      now: () => 42,
    });

    expect(method).toBe("systemd-run");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    const [command, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("systemd-run");
    expect(args.slice(0, 4)).toEqual(["--user", "--collect", "--quiet", "--unit=resin-update-42"]);
    expect(args).toContain(
      "--setenv=RESIN_RELEASE_CHANNEL_URL=https://dist.resin.sh/releases/v1/channels.json",
    );
    expect(args.join(" ")).not.toContain("secret-value");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      "/usr/bin/node",
      "/home/u/.resin/versions/v1.0.0/apps/cli/dist/index.js",
      UPDATE_WORKER_COMMAND,
      "--resin-home",
      "/home/u/.resin",
    ]);
  });

  it("fails closed instead of starting a worker that the service stop would kill", async () => {
    const spawnDetached = vi.fn();
    await expect(
      launchUpdateWorker({
        resinHome: "/home/u/.resin",
        env: { INVOCATION_ID: "abc" },
        runner: { run: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }) },
        spawnDetached,
      }),
    ).rejects.toThrow("systemd-run failed: not found");
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("starts a detached session leader outside systemd", async () => {
    const resinHome = await fs.mkdtemp(path.join(os.tmpdir(), "resin-worker-launch-"));
    try {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      const spawnDetached = vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      });

      const method = await launchUpdateWorker({
        resinHome,
        nodePath: "/usr/bin/node",
        entryPath: "/entry.js",
        env: { PATH: "/usr/bin", RESIN_API_TOKEN: "secret-value" },
        spawnDetached,
      });

      expect(method).toBe("detached");
      expect(spawnDetached).toHaveBeenCalledWith(
        "/usr/bin/node",
        ["/entry.js", UPDATE_WORKER_COMMAND, "--resin-home", resinHome],
        expect.objectContaining({ detached: true, env: { PATH: "/usr/bin" } }),
      );
      expect(child.unref).toHaveBeenCalledOnce();
      await expect(
        fs.stat(path.join(resinHome, "logs", "update-worker.log")),
      ).resolves.toBeTruthy();
    } finally {
      await fs.rm(resinHome, { recursive: true, force: true });
    }
  });

  it("drops forwarded values that cannot be represented safely", () => {
    const args = buildSystemdRunArguments({
      unitName: "u",
      workerArgs: ["node"],
      env: { RESIN_HOME: "/a\nb", PATH: "/usr/bin" },
    });
    expect(args).toContain("--setenv=PATH=/usr/bin");
    expect(args.join(" ")).not.toContain("RESIN_HOME");
  });
});

function engineResult(patch: Partial<UpdateEngineResult>): UpdateEngineResult {
  return {
    success: true,
    mode: "background",
    status: "already-current",
    channel: "stable",
    currentVersion: "1.0.0",
    activeVersion: "1.0.0",
    staged: false,
    activated: false,
    healthGatePassed: false,
    stepsCompleted: [],
    snapshot: journal({}),
    ...patch,
  };
}

describe("update worker", () => {
  it("runs the engine in background mode and records a one-time success notice", async () => {
    const resinHome = await fs.mkdtemp(path.join(os.tmpdir(), "resin-worker-"));
    try {
      const run = vi.fn(async () =>
        engineResult({ status: "activated", activeVersion: "1.1.0", activated: true }),
      );
      const published: string[] = [];

      const result = await runUpdateWorker({
        resinHome,
        engine: { run },
        publishNotification: async (state) => {
          published.push(state);
        },
        report: () => undefined,
        clock: () => START,
      });

      expect(run).toHaveBeenCalledWith({ mode: "background" });
      expect(result.status).toBe("activated");
      expect(published).toEqual(["clear"]);
      await expect(readAutoUpdateNotice({ resinHome })).resolves.toEqual({
        schemaVersion: 1,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        activatedAt: new Date(START).toISOString(),
      });
    } finally {
      await fs.rm(resinHome, { recursive: true, force: true });
    }
  });

  it.each([
    [engineResult({ status: "rolled-back", success: false, rolledBack: true }), ["rolled-back"]],
    [engineResult({ status: "failed", success: false, error: "bad signature" }), ["failed"]],
    [engineResult({ status: "activation-deferred", deferralReason: "active-sessions" }), []],
    [engineResult({ status: "locked", success: false }), []],
  ])("maps %s to user-visible notifications", async (engineOutcome, expected) => {
    const published: string[] = [];
    const writeNotice = vi.fn(async () => undefined);
    await runUpdateWorker({
      resinHome: "/unused",
      engine: { run: async () => engineOutcome },
      publishNotification: async (state) => {
        published.push(state);
      },
      writeNotice,
      report: () => undefined,
    });
    expect(published).toEqual(expected);
    expect(writeNotice).not.toHaveBeenCalled();
  });

  it("validates worker arguments", async () => {
    await expect(runUpdateWorkerCommand(["__update-worker"])).rejects.toThrow("--resin-home");
    await expect(runUpdateWorkerCommand(["other", "--resin-home", "/x"])).rejects.toThrow(
      "Invalid update worker invocation",
    );
  });
});

describe("auto-update state persistence", () => {
  it("round-trips private scheduler state", async () => {
    const resinHome = await fs.mkdtemp(path.join(os.tmpdir(), "resin-auto-state-"));
    try {
      const state: AutoUpdateState = {
        ...createAutoUpdateState(),
        scheduler: {
          lastSuccessfulCheckAtMs: START,
          offlineFailureCount: 0,
          offlineRetryAtMs: null,
        },
        nextCheckAt: new Date(START + 360 * MINUTE).toISOString(),
      };
      await writeAutoUpdateState(resinHome, state);
      await expect(readAutoUpdateState({ resinHome })).resolves.toEqual(state);
      const stats = await fs.stat(path.join(resinHome, "updates", "auto-update-state.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(resinHome, { recursive: true, force: true });
    }
  });
});

function createMemoryFsBridge(initialFiles: Record<string, string> = {}): ConfigFsBridge {
  const files = new Map(Object.entries(initialFiles));
  return {
    async readFile(filePath) {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath, content) {
      files.set(filePath, content);
    },
    async exists(filePath) {
      return files.has(filePath);
    },
    async mkdirp() {},
    async copyFile(source, destination) {
      const content = files.get(source);
      if (content !== undefined) files.set(destination, content);
    },
    async unlink(filePath) {
      files.delete(filePath);
    },
  };
}

function signedRelease(version: string): ResolvedProductionRelease {
  // SAFETY: checkForUpdate reads only version and provenance fields validated by assertTrustedRelease.
  return {
    version,
    provenance: {
      version,
      signingKeyIds: ["release-key-1"],
      channelSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
    },
  } as unknown as ResolvedProductionRelease;
}

describe("UpdateEngine.checkForUpdate", () => {
  const homeDir = "/home/check";
  const resinHome = path.join(homeDir, ".resin");
  const configPath = path.join(resinHome, "config.json");

  function createChecker(options: {
    current?: string;
    target?: string;
    config?: object;
    journalFile?: object;
    resolveError?: Error;
  }) {
    const files: Record<string, string> = {
      [path.join(resinHome, "version.json")]: JSON.stringify({
        version: options.current ?? "1.0.0",
      }),
    };
    if (options.config) files[configPath] = JSON.stringify(options.config);
    if (options.journalFile) {
      files[path.join(resinHome, "journal.json")] = JSON.stringify(options.journalFile);
    }
    const fsBridge = createMemoryFsBridge(files);
    const writeFile = vi.spyOn(fsBridge, "writeFile");
    const acquireLock = vi.fn(async () => ({ async release() {} }));
    const serviceManager = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
    const engine = new UpdateEngine({
      homeDir,
      resinHome,
      configPath,
      fsBridge,
      platformInfo: detectPlatform({ platform: "linux", arch: "x64", release: "6.8.0" }),
      readActiveVersion: async () => null,
      acquireLock,
      serviceManager,
      resolveRelease: async () => {
        if (options.resolveError) throw options.resolveError;
        return signedRelease(options.target ?? "1.1.0");
      },
    });
    return { engine, writeFile, acquireLock, serviceManager };
  }

  it("reports an available release without locking, writing, or touching the service", async () => {
    const checker = createChecker({});
    await expect(checker.engine.checkForUpdate()).resolves.toMatchObject({
      status: "update-available",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      channel: "stable",
    });
    expect(checker.writeFile).not.toHaveBeenCalled();
    expect(checker.acquireLock).not.toHaveBeenCalled();
    expect(checker.serviceManager.stop).not.toHaveBeenCalled();
  });

  it.each([
    [{ target: "1.0.0" }, "already-current"],
    [{ target: "0.9.0" }, "downgrade-blocked"],
    [{ config: { updates: { autoUpdate: false } } }, "disabled"],
    [
      {
        journalFile: {
          ...journal({}),
          quarantine: [
            {
              version: "1.1.0",
              channel: "stable",
              quarantinedAt: "2026-09-01T00:00:00.000Z",
              reason: "failed health",
            },
          ],
        },
      },
      "quarantined",
    ],
    [
      { resolveError: Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }) },
      "offline",
    ],
    [{ resolveError: new Error("manifest signature verification failed") }, "failed"],
  ] as const)("classifies %j as %s", async (options, expected) => {
    const checker = createChecker(options);
    await expect(checker.engine.checkForUpdate()).resolves.toMatchObject({ status: expected });
  });

  it("honours the configured channel", async () => {
    const checker = createChecker({ config: { updates: { channel: "beta" } } });
    await expect(checker.engine.checkForUpdate()).resolves.toMatchObject({
      channel: "beta",
      policy: expect.objectContaining({ channel: "beta" }),
    });
  });
});

describe("MCP gateway version registry", () => {
  it("tracks live gateways, prunes exited ones, and reports stale versions", async () => {
    const resinHome = await fs.mkdtemp(path.join(os.tmpdir(), "resin-gateway-registry-"));
    try {
      const unregisterOld = registerRunningGateway({ resinHome, version: "v1.0.0", pid: 101 });
      registerRunningGateway({ resinHome, version: "1.1.0", pid: 102 });
      registerRunningGateway({ resinHome, version: "1.0.0", pid: 103 });
      const alive = new Set([101, 102]);

      const live = await listRunningGateways({ resinHome, isAlive: (pid) => alive.has(pid) });
      expect(live.map((gateway) => [gateway.pid, gateway.version]).sort()).toEqual([
        [101, "1.0.0"],
        [102, "1.1.0"],
      ]);
      await expect(fs.readdir(resolveGatewayRegistryDir(resinHome))).resolves.not.toContain(
        "103.json",
      );

      unregisterOld();
      unregisterOld();
      const remaining = await listRunningGateways({ resinHome, isAlive: () => true });
      expect(remaining.map((gateway) => gateway.pid)).toEqual([102]);
    } finally {
      await fs.rm(resinHome, { recursive: true, force: true });
    }
  });

  it("tells the user which harness gateways need a restart", () => {
    expect(formatStaleMcpGateways({ count: 0, versions: [] })).toBeNull();
    expect(formatStaleMcpGateways({ count: 2, versions: ["1.0.0"] })).toBe(
      "2 MCP gateway process(es) still run an older Resin (v1.0.0); restart the harness to load the updated version.",
    );
  });

  it("registers the running `resin mcp` version and releases it when the gateway fails", async () => {
    const unregister = vi.fn();
    const registerGateway = vi.fn(() => unregister);

    const exitCode = await mcpCommand([], {
      stderr: { write: () => true },
      registerGateway,
      shimFactory: () => ({ start: async () => ({ mode: "failed" }), stop: async () => {} }),
    });

    expect(exitCode).toBe(1);
    expect(registerGateway).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
    expect(unregister).toHaveBeenCalled();
  });
});
