import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { windowsPrivacyProblem } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import { mcpCommand } from "../src/commands/mcp.js";
import {
  collectStatus,
  formatStaleMcpGateways,
  readStaleMcpGateways,
} from "../src/commands/status.js";
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
  createActivatedReleaseNotice,
  isCredentialUnsafeGatewayVersion,
  listCredentialUnsafeGateways,
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
      // A junction on Windows (no symlink privilege needed); the type is ignored elsewhere.
      await fs.symlink(
        path.join(resinHome, "versions", "v1.0.0"),
        path.join(resinHome, "current"),
        "junction",
      );
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
      const statePath = path.join(resinHome, "updates", "auto-update-state.json");
      if (process.platform === "win32") {
        // NTFS has no mode bits; privacy is the owner-only DACL.
        expect(windowsPrivacyProblem(statePath)).toBeUndefined();
      } else {
        expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
      }
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
    expect(
      formatStaleMcpGateways({
        count: 0,
        versions: [],
        unknownVersionCount: 0,
        credentialUnsafe: [],
      }),
    ).toBeNull();
    expect(
      formatStaleMcpGateways({
        count: 2,
        versions: ["1.0.122"],
        unknownVersionCount: 0,
        credentialUnsafe: [],
      }),
    ).toBe(
      "2 MCP gateway process(es) still run an older Resin (v1.0.122); restart the harness to load the updated version.",
    );
    expect(
      formatStaleMcpGateways({
        count: 1,
        versions: [],
        unknownVersionCount: 1,
        credentialUnsafe: [{ pid: 77, version: null }],
      }),
    ).toBe(
      "1 MCP gateway process(es) still run an older Resin (unknown version); restart the harness to load the updated version. 1 running MCP gateway process(es) use a Resin credential client older than v1.0.122: PID 77 (unknown version). Sharing this device's sign-in with them can replay a rotated refresh token and get the sign-in revoked. Restart the harness sessions that own these PIDs (exit and reopen them). `resin login` will not pair while they run.",
    );
  });

  it("classifies only 1.x releases before v1.0.122 as credential-unsafe", () => {
    expect(isCredentialUnsafeGatewayVersion("1.0.106")).toBe(true);
    expect(isCredentialUnsafeGatewayVersion("v1.0.121")).toBe(true);
    expect(isCredentialUnsafeGatewayVersion("1.0.122-rc.1")).toBe(true);
    expect(isCredentialUnsafeGatewayVersion("1.0.122")).toBe(false);
    expect(isCredentialUnsafeGatewayVersion("1.1.0")).toBe(false);
    // Source builds report the workspace version and run current code.
    expect(isCredentialUnsafeGatewayVersion("0.1.0")).toBe(false);
    expect(isCredentialUnsafeGatewayVersion("garbage")).toBe(false);
  });

  it("counts live `resin mcp` processes of this home that never registered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-gateway-proc-"));
    const resinHome = path.join(root, ".resin");
    const procRoot = path.join(root, "proc");
    try {
      await fs.mkdir(path.join(resinHome, "versions", "v1.1.0"), { recursive: true });
      await fs.symlink(
        path.join(resinHome, "versions", "v1.1.0"),
        path.join(resinHome, "current"),
        "junction",
      );
      registerRunningGateway({ resinHome, version: "1.0.0", pid: 102 });
      const processes: Record<string, string[]> = {
        // Registered: counted once, by its recorded version.
        "102": ["node", path.join(resinHome, "bin", "resin"), "mcp"],
        // A gateway from before the registry existed.
        "201": ["node", path.join(resinHome, "bin", "resin"), "mcp"],
        // Another Resin home's gateway, a non-gateway command and an unrelated process.
        "202": ["node", path.join(root, "other", ".resin", "bin", "resin"), "mcp"],
        "203": ["node", path.join(resinHome, "bin", "resin"), "status"],
        "204": ["bash", "-c", "sleep 60"],
      };
      for (const [pid, args] of Object.entries(processes)) {
        await fs.mkdir(path.join(procRoot, pid), { recursive: true });
        await fs.writeFile(path.join(procRoot, pid, "cmdline"), `${args.join("\0")}\0`);
      }
      await fs.mkdir(path.join(procRoot, "self"));

      const stale = await readStaleMcpGateways(resinHome, { procRoot, isAlive: () => true });
      expect(stale).toEqual({
        count: 2,
        versions: ["1.0.0"],
        unknownVersionCount: 1,
        credentialUnsafe: [
          { pid: 102, version: "1.0.0" },
          { pid: 201, version: null },
        ],
      });
      expect(formatStaleMcpGateways(stale)).toBe(
        "2 MCP gateway process(es) still run an older Resin (v1.0.0, unknown version); restart the harness to load the updated version. 2 running MCP gateway process(es) use a Resin credential client older than v1.0.122: PID 102 (v1.0.0), 201 (unknown version). Sharing this device's sign-in with them can replay a rotated refresh token and get the sign-in revoked. Restart the harness sessions that own these PIDs (exit and reopen them). `resin login` will not pair while they run.",
      );
      // Without /proc (macOS, Windows) only registered gateways are reported.
      await expect(
        readStaleMcpGateways(resinHome, {
          procRoot: path.join(root, "missing"),
          isAlive: () => true,
        }),
      ).resolves.toEqual({
        count: 1,
        versions: ["1.0.0"],
        unknownVersionCount: 0,
        credentialUnsafe: [{ pid: 102, version: "1.0.0" }],
      });
      // Login detects them without an active install; hardened gateways are not listed.
      registerRunningGateway({ resinHome, version: "1.0.122", pid: 103 });
      await fs.rm(path.join(resinHome, "current"));
      await expect(
        listCredentialUnsafeGateways({ resinHome, procRoot, isAlive: () => true }),
      ).resolves.toEqual([
        { pid: 102, version: "1.0.0" },
        { pid: 201, version: null },
      ]);
      await expect(
        readStaleMcpGateways(resinHome, { procRoot, isAlive: () => true }),
      ).resolves.toMatchObject({ count: 0, credentialUnsafe: [{ pid: 102 }, { pid: 201 }] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes a stale registration whose PID was reused by a later process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-gateway-reuse-"));
    const resinHome = path.join(root, ".resin");
    const procRoot = path.join(root, "proc");
    try {
      const bootSeconds = 1_800_000_000;
      const registeredAtMs = (bootSeconds + 600) * 1000;
      // A SIGKILLed pre-v1.0.122 gateway left 301.json; PID 301 now belongs to an unrelated
      // process started an hour later. PID 302 is the gateway that registered.
      registerRunningGateway({
        resinHome,
        version: "1.0.106",
        pid: 301,
        now: () => registeredAtMs,
      });
      registerRunningGateway({
        resinHome,
        version: "1.0.106",
        pid: 302,
        now: () => registeredAtMs,
      });
      await fs.mkdir(procRoot, { recursive: true });
      await fs.writeFile(path.join(procRoot, "stat"), `cpu  1 2 3\nbtime ${bootSeconds}\n`);
      const startTicks: Record<string, number> = { "301": 4_200 * 100, "302": 599 * 100 };
      for (const [pid, ticks] of Object.entries(startTicks)) {
        await fs.mkdir(path.join(procRoot, pid), { recursive: true });
        // Fields after the command name start at `state` (field 3); `starttime` is field 22.
        const fields = Array.from({ length: 50 }, (_, index) =>
          index === 0 ? "S" : index === 19 ? String(ticks) : "0",
        );
        await fs.writeFile(
          path.join(procRoot, pid, "stat"),
          `${pid} (node (worker) x) ${fields.join(" ")}\n`,
        );
      }

      await expect(
        listCredentialUnsafeGateways({ resinHome, procRoot, isAlive: () => true }),
      ).resolves.toEqual([{ pid: 302, version: "1.0.106" }]);
      await expect(fs.readdir(resolveGatewayRegistryDir(resinHome))).resolves.toEqual(["302.json"]);

      // The real /proc (where present) keeps a registration written by the live process.
      const ownHome = path.join(root, "own");
      registerRunningGateway({ resinHome: ownHome, version: "1.0.106" });
      await expect(listRunningGateways({ resinHome: ownHome })).resolves.toMatchObject([
        { pid: process.pid },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("registers the running `resin mcp` version and releases it when the gateway fails", async () => {
    const unregister = vi.fn();
    const registerGateway = vi.fn(() => unregister);
    const home = path.join(os.tmpdir(), "resin-gateway-user");
    let shimClientVersion: string | undefined;

    const exitCode = await mcpCommand([], {
      stderr: { write: () => true },
      home,
      env: {},
      registerGateway,
      shimFactory: (options) => {
        shimClientVersion = options.clientVersion;
        return { start: async () => ({ mode: "failed" }), stop: async () => {} };
      },
    });

    expect(exitCode).toBe(1);
    expect(registerGateway).toHaveBeenCalledWith({
      resinHome: path.resolve(home, ".resin"),
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    expect(unregister).toHaveBeenCalled();
    // The gateway's own credential store reports the same release on token rotation.
    expect(shimClientVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(registerGateway).toHaveBeenCalledWith(
      expect.objectContaining({ version: shimClientVersion }),
    );
  });

  it("registers gateways under a custom RESIN_HOME, where status reports them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-gateway-custom-home-"));
    const home = path.join(root, "user");
    const resinHome = path.join(root, "custom-resin");
    const env = { HOME: home, RESIN_HOME: resinHome };
    try {
      await fs.mkdir(path.join(resinHome, "versions", "v1.1.0"), { recursive: true });
      await fs.symlink(
        path.join(resinHome, "versions", "v1.1.0"),
        path.join(resinHome, "current"),
        "junction",
      );
      // An older gateway (this live test process) registering through `resin mcp`'s resolution.
      const unregister = vi.fn();
      const registerGateway = vi.fn((registration: { resinHome: string; version: string }) => {
        registerRunningGateway({ ...registration, version: "1.0.0", pid: process.pid });
        return unregister;
      });

      await mcpCommand([], {
        stderr: { write: () => true },
        home,
        env,
        registerGateway,
        shimFactory: () => ({ start: async () => ({ mode: "failed" }), stop: async () => {} }),
      });

      expect(registerGateway).toHaveBeenCalledWith(
        expect.objectContaining({ resinHome: path.resolve(resinHome) }),
      );
      const summary = await collectStatus({ home, env, fsBridge: createMemoryFsBridge() });
      expect(summary.update.staleMcpGateways).toEqual({
        count: 1,
        versions: ["1.0.0"],
        unknownVersionCount: 0,
        credentialUnsafe: [{ pid: process.pid, version: "1.0.0" }],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("tells a long-lived gateway's agent once a newer release is active, re-reading at most per interval", () => {
    let active: string | null = "1.0.0";
    let now = 0;
    const reads = vi.fn((_resinHome: string) => active);
    const notice = createActivatedReleaseNotice({
      resinHome: "/home/user/.resin",
      runningVersion: "v1.0.0",
      readActiveVersion: reads,
      clock: () => now,
      intervalMs: 60_000,
    });

    expect(notice()).toBeUndefined();
    active = "1.1.0";
    now = 59_999;
    expect(notice()).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);
    now = 60_000;
    expect(notice()).toBe(
      "Resin v1.1.0 was activated, but this Resin MCP server still runs v1.0.0. Restart this session to use v1.1.0.",
    );
    expect(reads).toHaveBeenCalledTimes(2);
    // A rollback to an older release, or a same-version reinstall, needs no restart.
    active = "1.0.0+resin-reinstall.54d5b0120836";
    now = 120_000;
    expect(notice()).toBeUndefined();
    active = "0.9.0";
    now = 180_000;
    expect(notice()).toBeUndefined();
  });

  it("gives `resin mcp` a release notice that reads the active install's pointer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-gateway-release-notice-"));
    const home = path.join(root, "user");
    const resinHome = path.join(home, ".resin");
    try {
      await fs.mkdir(path.join(resinHome, "versions", "v999.0.0"), { recursive: true });
      await fs.symlink(
        path.join(resinHome, "versions", "v999.0.0"),
        path.join(resinHome, "current"),
        "junction",
      );
      let releaseNotice: (() => string | undefined) | undefined;

      await mcpCommand([], {
        stderr: { write: () => true },
        home,
        env: {},
        shimFactory: (options) => {
          releaseNotice = options.releaseNotice;
          return { start: async () => ({ mode: "failed" }), stop: async () => {} };
        },
      });

      expect(releaseNotice?.()).toMatch(
        /^Resin v999\.0\.0 was activated, but this Resin MCP server still runs v\d+\.\d+\.\d+.*\. Restart this session to use v999\.0\.0\.$/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
