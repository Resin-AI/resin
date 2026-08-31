import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPDATE_POLICY,
  MAX_UPDATE_CHECK_INTERVAL_MINUTES,
  MIN_UPDATE_CHECK_INTERVAL_MINUTES,
  UpdatePolicyValidationError,
  mergeUpdatePolicy,
  parseUpdatePolicy,
} from "../src/updates/policy.js";
import {
  INITIAL_OFFLINE_UPDATE_BACKOFF_MS,
  MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS,
  UpdateCheckTimeoutError,
  UpdateScheduler,
  calculateOfflineUpdateBackoffMs,
  createUpdateSchedulerState,
  decideUpdateSchedule,
  getNextUpdateMaintenanceWindowStart,
  isWithinUpdateMaintenanceWindow,
  recordOfflineUpdateCheck,
  recordSuccessfulUpdateCheck,
} from "../src/updates/scheduler.js";
import {
  UPDATE_LOCK_METADATA_VERSION,
  UnsafeUpdateLockError,
  type UpdateLock,
  type UpdateLockMetadata,
  UpdateLockOwnershipError,
  type UpdateLockProcessIdentity,
  UpdateLockUnavailableError,
  acquireUpdateLock,
} from "../src/updates/update-lock.js";

const temporaryRoots: string[] = [];
const fixtureBootId = "fixture-boot";

function fixtureProcessIdentity(processStartId: string): UpdateLockProcessIdentity {
  return { bootId: fixtureBootId, processStartId };
}

async function createTemporaryLockPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "resin-update-policy-"));
  temporaryRoots.push(root);
  return path.join(root, "locks", "update.lock");
}

async function writeLockMetadata(
  lockPath: string,
  metadata: UpdateLockMetadata,
  mode = 0o600,
): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(lockPath), 0o700);
  await writeFile(lockPath, `${JSON.stringify(metadata)}\n`, { mode });
  await chmod(lockPath, mode);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("update policy", () => {
  it("uses safe automatic stable-channel defaults", () => {
    expect(parseUpdatePolicy()).toEqual({
      autoUpdate: true,
      channel: "stable",
      checkIntervalMinutes: 360,
      maintenanceWindow: null,
      allowDowngrades: false,
    });
    expect(DEFAULT_UPDATE_POLICY).toEqual(parseUpdatePolicy({}));
  });

  it("preserves an explicit opt-out and merges layers from left to right", () => {
    expect(
      mergeUpdatePolicy(
        { channel: "beta", checkIntervalMinutes: 720, allowDowngrades: true },
        { autoUpdate: false, channel: "nightly", maintenanceWindow: null },
      ),
    ).toEqual({
      autoUpdate: false,
      channel: "nightly",
      checkIntervalMinutes: 720,
      maintenanceWindow: null,
      allowDowngrades: true,
    });
  });

  it.each(["stable", "beta", "nightly"] as const)("accepts the %s channel", (channel) => {
    expect(parseUpdatePolicy({ channel }).channel).toBe(channel);
  });

  it("strictly rejects unknown, mistyped, and out-of-bounds settings", () => {
    const invalidPolicies: unknown[] = [
      null,
      { autoUpdates: false },
      { autoUpdate: "false" },
      { channel: "canary" },
      { checkIntervalMinutes: MIN_UPDATE_CHECK_INTERVAL_MINUTES - 1 },
      { checkIntervalMinutes: MAX_UPDATE_CHECK_INTERVAL_MINUTES + 1 },
      { checkIntervalMinutes: 12.5 },
      { allowDowngrades: undefined },
      { maintenanceWindow: { start: "2:00", end: "03:00" } },
      { maintenanceWindow: { start: "02:00", end: "02:00" } },
      { maintenanceWindow: { start: "02:00", end: "03:00", extra: true } },
      { maintenanceWindow: { start: "02:00", end: "03:00", timeZone: "Mars/Olympus" } },
    ];

    for (const policy of invalidPolicies) {
      expect(() => parseUpdatePolicy(policy)).toThrow(UpdatePolicyValidationError);
    }
  });
});

describe("update scheduling", () => {
  const morningWindow = { start: "02:00", end: "04:00", timeZone: "UTC" } as const;
  const overnightWindow = { start: "23:00", end: "01:00", timeZone: "UTC" } as const;

  it("handles ordinary and cross-midnight maintenance windows", () => {
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 27, 2, 0), morningWindow)).toBe(true);
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 27, 3, 59), morningWindow)).toBe(true);
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 27, 4, 0), morningWindow)).toBe(false);
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 27, 23, 30), overnightWindow)).toBe(
      true,
    );
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 28, 0, 30), overnightWindow)).toBe(
      true,
    );
    expect(isWithinUpdateMaintenanceWindow(Date.UTC(2026, 7, 28, 1, 0), overnightWindow)).toBe(
      false,
    );
    expect(getNextUpdateMaintenanceWindowStart(Date.UTC(2026, 7, 27, 4, 0), morningWindow)).toBe(
      Date.UTC(2026, 7, 28, 2, 0),
    );
  });

  it("checks immediately, waits for the interval, and becomes due deterministically", () => {
    const policy = parseUpdatePolicy({ checkIntervalMinutes: 60 });
    const initial = createUpdateSchedulerState();
    const start = Date.UTC(2026, 7, 27, 12, 0);

    expect(decideUpdateSchedule(policy, initial, start)).toMatchObject({
      kind: "check",
      reason: "initial",
    });

    const checked = recordSuccessfulUpdateCheck(initial, start);
    expect(decideUpdateSchedule(policy, checked, start + 59 * 60_000)).toMatchObject({
      kind: "wait",
      reason: "interval",
      wakeAtMs: start + 60 * 60_000,
    });
    expect(decideUpdateSchedule(policy, checked, start + 60 * 60_000)).toMatchObject({
      kind: "check",
      reason: "interval",
    });
  });

  it("defers a due check until the next maintenance window rather than using an old window", () => {
    const now = Date.UTC(2026, 7, 27, 12, 0);
    const policy = parseUpdatePolicy({
      checkIntervalMinutes: 60,
      maintenanceWindow: morningWindow,
    });
    const state = recordSuccessfulUpdateCheck(createUpdateSchedulerState(), now - 24 * 60 * 60_000);

    expect(decideUpdateSchedule(policy, state, now)).toMatchObject({
      kind: "wait",
      reason: "maintenance-window",
      wakeAtMs: Date.UTC(2026, 7, 28, 2, 0),
    });
    expect(decideUpdateSchedule(policy, state, Date.UTC(2026, 7, 28, 2, 30))).toMatchObject({
      kind: "check",
      reason: "interval",
    });
  });

  it("emits a disabled decision for explicit opt-out", () => {
    expect(
      decideUpdateSchedule(
        parseUpdatePolicy({ autoUpdate: false }),
        createUpdateSchedulerState(),
        1_000,
      ),
    ).toEqual({ kind: "disabled", decidedAtMs: 1_000, wakeAtMs: null });
  });

  it("uses deterministic jittered offline backoff without zero-delay retries", () => {
    const start = 10_000;
    const first = recordOfflineUpdateCheck(createUpdateSchedulerState(), start, () => 0.5);
    expect(first.offlineRetryAtMs).toBe(start + INITIAL_OFFLINE_UPDATE_BACKOFF_MS);
    expect(calculateOfflineUpdateBackoffMs(2, () => 0.5)).toBe(
      INITIAL_OFFLINE_UPDATE_BACKOFF_MS * 2,
    );

    const waiting = decideUpdateSchedule(parseUpdatePolicy(), first, start);
    expect(waiting).toMatchObject({
      kind: "wait",
      reason: "offline-backoff",
      delayMs: INITIAL_OFFLINE_UPDATE_BACKOFF_MS,
    });
    expect(decideUpdateSchedule(parseUpdatePolicy(), first, first.offlineRetryAtMs!)).toMatchObject(
      {
        kind: "check",
        reason: "offline-retry",
      },
    );
  });

  it("invokes check and decision callbacks while retaining scheduling ownership only", async () => {
    let now = Date.UTC(2026, 7, 27, 12, 0);
    const checks = vi.fn(() => "offline" as const);
    const decisions: string[] = [];
    const scheduler = new UpdateScheduler({
      clock: () => now,
      random: () => 0.5,
      onCheck: checks,
      onDecision: (decision) => decisions.push(decision.kind),
    });

    const cycle = await scheduler.runOnce();
    expect(checks).toHaveBeenCalledOnce();
    expect(decisions).toEqual(["check", "wait"]);
    expect(cycle.nextDecision).toMatchObject({
      kind: "wait",
      reason: "offline-backoff",
      delayMs: INITIAL_OFFLINE_UPDATE_BACKOFF_MS,
    });

    now = cycle.nextDecision.wakeAtMs!;
    expect(scheduler.decide()).toMatchObject({ kind: "check", reason: "offline-retry" });
  });

  it("handles DST overlaps, fold re-entry, and empty spring gaps", () => {
    const overlapWindow = {
      start: "02:30",
      end: "03:00",
      timeZone: "Europe/Berlin",
    } as const;
    const overlapStart = getNextUpdateMaintenanceWindowStart(
      Date.UTC(2026, 9, 25, 0, 0),
      overlapWindow,
    );
    expect(overlapStart).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(isWithinUpdateMaintenanceWindow(overlapStart, overlapWindow)).toBe(true);

    const foldReentryWindow = {
      start: "01:30",
      end: "02:15",
      timeZone: "Europe/Berlin",
    } as const;
    const foldReentry = getNextUpdateMaintenanceWindowStart(
      Date.UTC(2026, 9, 25, 0, 30),
      foldReentryWindow,
    );
    expect(foldReentry).toBe(Date.UTC(2026, 9, 25, 1, 0));
    expect(isWithinUpdateMaintenanceWindow(foldReentry, foldReentryWindow)).toBe(true);

    const skippedWindow = {
      start: "02:30",
      end: "03:00",
      timeZone: "Europe/Berlin",
    } as const;
    const skippedStart = getNextUpdateMaintenanceWindowStart(
      Date.UTC(2026, 2, 29, 0, 0),
      skippedWindow,
    );
    expect(skippedStart).toBe(Date.UTC(2026, 2, 30, 0, 30));
    expect(isWithinUpdateMaintenanceWindow(skippedStart, skippedWindow)).toBe(true);

    const partialGapWindow = {
      start: "02:30",
      end: "04:00",
      timeZone: "Europe/Berlin",
    } as const;
    expect(getNextUpdateMaintenanceWindowStart(Date.UTC(2026, 2, 29, 0, 0), partialGapWindow)).toBe(
      Date.UTC(2026, 2, 29, 1, 0),
    );
  });

  it("normalizes future persisted state after clock rollback", () => {
    const now = 1_000;
    const decision = decideUpdateSchedule(
      parseUpdatePolicy(),
      {
        lastSuccessfulCheckAtMs: now + MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS * 2,
        offlineFailureCount: 1,
        offlineRetryAtMs: now + MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS * 2,
      },
      now,
    );

    expect(decision).toMatchObject({ kind: "wait", reason: "interval" });
    expect(decision.wakeAtMs! - now).toBeLessThan(MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS);
  });

  it("re-arms promptly and never exceeds the Node timer bound after clock rollback", async () => {
    const initialNow = MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS + 60_000;
    let now = initialNow;
    const delays: number[] = [];
    const cancelTimer = vi.fn();
    const scheduler = new UpdateScheduler({
      initialState: {
        lastSuccessfulCheckAtMs: initialNow,
        offlineFailureCount: 0,
        offlineRetryAtMs: null,
      },
      clock: () => now,
      onCheck: () => "checked",
      minimumTimerDelayMs: 1,
      scheduleTimer: (_callback, delayMs) => {
        delays.push(delayMs);
        return { unref: vi.fn() };
      },
      cancelTimer,
    });

    scheduler.start();
    now = 0;
    await Promise.resolve();
    await Promise.resolve();
    expect(delays).toEqual([1]);
    scheduler.stop();
    expect(cancelTimer).toHaveBeenCalledOnce();

    expect(
      () =>
        new UpdateScheduler({
          onCheck: () => "checked",
          minimumTimerDelayMs: MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS + 1,
        }),
    ).toThrow(RangeError);
  });

  it("times out a non-settling check and schedules offline backoff", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new UpdateScheduler({
        checkTimeoutMs: 25,
        clock: () => 10_000,
        random: () => 0.5,
        onCheck: () => new Promise<"checked">(() => undefined),
      });

      const cyclePromise = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(25);
      const cycle = await cyclePromise;
      expect(cycle).toMatchObject({
        outcome: "offline",
        error: expect.any(UpdateCheckTimeoutError),
        nextDecision: {
          kind: "wait",
          reason: "offline-backoff",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a stopped hung cycle before starting a replacement cycle", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const scheduler = new UpdateScheduler({
      checkTimeoutMs: 10_000,
      onCheck: (_decision, signal) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise<"checked">(() => undefined);
        }
        return "checked";
      },
    });

    scheduler.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    scheduler.stop();
    expect(firstSignal?.aborted).toBe(true);
    scheduler.start();
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    expect(calls).toBe(2);
    scheduler.stop();
  });
  it("stops and reports clock or timer backend failures", async () => {
    const clockError = new Error("clock unavailable");
    const clockErrors: unknown[] = [];
    const clockFailure = new UpdateScheduler({
      clock: () => {
        throw clockError;
      },
      onCheck: () => "checked",
      onError: (error) => clockErrors.push(error),
    });
    clockFailure.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(clockFailure.isRunning).toBe(false);
    expect(clockErrors).toContain(clockError);

    const timerError = new Error("timer unavailable");
    const timerErrors: unknown[] = [];
    const timerFailure = new UpdateScheduler({
      initialState: {
        lastSuccessfulCheckAtMs: 1_000,
        offlineFailureCount: 0,
        offlineRetryAtMs: null,
      },
      clock: () => 1_000,
      onCheck: () => "checked",
      scheduleTimer: () => {
        throw timerError;
      },
      onError: (error) => timerErrors.push(error),
    });
    timerFailure.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(timerFailure.isRunning).toBe(false);
    expect(timerErrors).toContain(timerError);
  });
});

describe("cross-process update lock", () => {
  it("allows exactly one concurrent exclusive owner", async () => {
    const lockPath = await createTemporaryLockPath();
    const attempts = await Promise.allSettled([
      acquireUpdateLock({ lockPath, timeoutMs: 0 }),
      acquireUpdateLock({ lockPath, timeoutMs: 0 }),
    ]);
    const acquired = attempts.filter(
      (result): result is PromiseFulfilledResult<UpdateLock> => result.status === "fulfilled",
    );
    const refused = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(UpdateLockUnavailableError);
    await acquired[0]!.value.release();
  });

  it("supports the full lock lifecycle through Darwin's verified directory path", async () => {
    const lockPath = await createTemporaryLockPath();
    const processIdentity = fixtureProcessIdentity("darwin-owner");
    const lock = await acquireUpdateLock({
      lockPath,
      timeoutMs: 0,
      platform: "darwin",
      processIdentity,
    });

    expect(lock.metadata).toMatchObject(processIdentity);
    const renewed = await lock.renew(60_000);
    expect(renewed.leaseExpiresAtMs).toBeGreaterThan(renewed.acquiredAtMs);
    await lock.release();
    await lock.release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an expired lease while the exact local process incarnation is live", async () => {
    const lockPath = await createTemporaryLockPath();
    const hostname = "fixture-host";
    const ownerPid = 4_101;
    const contenderPid = 4_102;
    const ownerIdentity = fixtureProcessIdentity("owner-start");
    const getProcessIdentity = vi.fn((pid: number) => (pid === ownerPid ? ownerIdentity : null));
    const isProcessAlive = vi.fn(() => true);
    const metadata: UpdateLockMetadata = {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "live-owner",
      pid: ownerPid,
      hostname,
      ...ownerIdentity,
      acquiredAtMs: 1,
      leaseExpiresAtMs: 2,
    };
    await writeLockMetadata(lockPath, metadata);

    await expect(
      acquireUpdateLock({
        lockPath,
        timeoutMs: 0,
        clock: () => 10_000,
        isProcessAlive,
        processIdentity: fixtureProcessIdentity("contender-start"),
        getProcessIdentity,
        pid: contenderPid,
        hostname,
      }),
    ).rejects.toMatchObject({
      name: "UpdateLockUnavailableError",
      owner: metadata,
    });
    expect(getProcessIdentity).toHaveBeenCalledWith(ownerPid);
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it("recovers an expired lock after PID reuse or a host reboot", async () => {
    const lockPath = await createTemporaryLockPath();
    const hostname = "fixture-host";
    const reusedPid = 4_101;
    const formerIdentity = fixtureProcessIdentity("former-start");
    await writeLockMetadata(lockPath, {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "former-owner",
      pid: reusedPid,
      hostname,
      ...formerIdentity,
      acquiredAtMs: 1,
      leaseExpiresAtMs: 2,
    });

    const replacement = await acquireUpdateLock({
      lockPath,
      timeoutMs: 0,
      clock: () => 10_000,
      isProcessAlive: () => true,
      processIdentity: { bootId: "replacement-boot", processStartId: "replacement-start" },
      getProcessIdentity: () => ({
        bootId: "replacement-boot",
        processStartId: "replacement-start",
      }),
      pid: reusedPid,
      hostname,
      createOwnerId: () => "replacement-owner",
    });

    expect(replacement.metadata.ownerId).toBe("replacement-owner");
    await replacement.release();
  });

  it("recovers a third-party Darwin lock after PID reuse with shell-free ps arguments", async () => {
    const lockPath = await createTemporaryLockPath();
    const hostname = "fixture-host";
    const ownerPid = 4_101;
    const contenderPid = 4_102;
    const bootStart = "Fri Aug 28 00:00:00 2026";
    const processStarts = {
      "1": bootStart,
      [String(ownerPid)]: "Fri Aug 28 09:00:00 2026",
      [String(contenderPid)]: "Fri Aug 28 10:00:00 2026",
    };
    const runProcessIdentityCommand = vi.fn(async (executable: string, args: readonly string[]) => {
      if (
        executable !== "/bin/ps" ||
        args[0] !== "-p" ||
        args[2] !== "-o" ||
        args[3] !== "lstart="
      ) {
        throw new Error("Unexpected process identity command");
      }
      const processStart = processStarts[args[1] ?? ""];
      if (processStart === undefined) {
        throw new Error("Unexpected process identity pid");
      }
      return `  ${processStart}\n`;
    });
    const isProcessAlive = vi.fn(() => true);
    await writeLockMetadata(lockPath, {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "former-third-party-owner",
      pid: ownerPid,
      hostname,
      bootId: `darwin-pid1:${bootStart}`,
      processStartId: "darwin-lstart:Fri Aug 28 08:00:00 2026",
      acquiredAtMs: 1,
      leaseExpiresAtMs: 2,
    });

    const replacement = await acquireUpdateLock({
      lockPath,
      timeoutMs: 0,
      clock: () => 10_000,
      isProcessAlive,
      platform: "darwin",
      runProcessIdentityCommand,
      pid: contenderPid,
      hostname,
      createOwnerId: () => "darwin-replacement-owner",
    });

    expect(replacement.metadata.ownerId).toBe("darwin-replacement-owner");
    expect(runProcessIdentityCommand).toHaveBeenCalledWith("/bin/ps", [
      "-p",
      String(ownerPid),
      "-o",
      "lstart=",
    ]);
    expect(isProcessAlive).not.toHaveBeenCalled();
    await replacement.release();
  });

  it("safely recovers a stale lock whose local owner is dead", async () => {
    const lockPath = await createTemporaryLockPath();
    const hostname = "fixture-host";
    const staleOwnerPid = 4_101;
    const isProcessAlive = vi.fn((pid: number) => pid !== staleOwnerPid);
    await writeLockMetadata(lockPath, {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "dead-owner",
      pid: staleOwnerPid,
      hostname,
      ...fixtureProcessIdentity("dead-start"),
      acquiredAtMs: 1,
      leaseExpiresAtMs: 20_000,
    });

    const replacement = await acquireUpdateLock({
      lockPath,
      timeoutMs: 0,
      clock: () => 10_000,
      isProcessAlive,
      pid: 4_102,
      hostname,
      processIdentity: fixtureProcessIdentity("contender-start-1"),
      createOwnerId: () => "replacement-owner",
    });

    expect(replacement.metadata.ownerId).toBe("replacement-owner");
    expect(isProcessAlive).toHaveBeenCalledWith(staleOwnerPid);
    await expect(
      acquireUpdateLock({
        lockPath,
        timeoutMs: 0,
        clock: () => 10_000,
        isProcessAlive,
        pid: 4_103,
        hostname,
        processIdentity: fixtureProcessIdentity("contender-start-2"),
        createOwnerId: () => "refused-owner",
      }),
    ).rejects.toBeInstanceOf(UpdateLockUnavailableError);
    await replacement.release();
  });

  it("bounds lock waiting by timeout even when an injected clock does not advance", async () => {
    const lockPath = await createTemporaryLockPath();
    const hostname = "fixture-host";
    const owner = await acquireUpdateLock({
      lockPath,
      timeoutMs: 0,
      clock: () => 1_000,
      pid: 4_101,
      hostname,
      createOwnerId: () => "waiting-owner",
    });
    const sleeps: number[] = [];

    await expect(
      acquireUpdateLock({
        lockPath,
        timeoutMs: 25,
        retryDelayMs: 10,
        clock: () => 1_000,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
        isProcessAlive: () => true,
        pid: 4_102,
        hostname,
      }),
    ).rejects.toBeInstanceOf(UpdateLockUnavailableError);
    expect(sleeps).toEqual([10, 10, 5]);
    await owner.release();
  });

  it("creates 0600 metadata and removes it on idempotent release", async () => {
    const lockPath = await createTemporaryLockPath();
    const lock = await acquireUpdateLock({ lockPath, timeoutMs: 0, label: "background" });
    const fileStats = await stat(lockPath);
    // SAFETY: Update lock metadata format verified in test.
    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as UpdateLockMetadata;

    expect(fileStats.mode & 0o777).toBe(0o600);
    expect(persisted).toMatchObject({
      version: UPDATE_LOCK_METADATA_VERSION,
      pid: process.pid,
      label: "background",
    });

    await lock.release();
    await lock.release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never follows or deletes a lock-path symlink", async () => {
    const lockPath = await createTemporaryLockPath();
    const targetPath = path.join(path.dirname(lockPath), "foreign-file");
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, "do not delete", { mode: 0o600 });
    await symlink(targetPath, lockPath);

    await expect(acquireUpdateLock({ lockPath, timeoutMs: 0 })).rejects.toBeInstanceOf(
      UnsafeUpdateLockError,
    );
    expect(await readFile(targetPath, "utf8")).toBe("do not delete");
  });

  it.each(["renew", "release"] as const)(
    "never lets a stale %s mutate a replacement owner after waiting for the fence",
    async (operation) => {
      const lockPath = await createTemporaryLockPath();
      const hostname = "fixture-host";
      const oldPid = 5_101;
      const fencePid = 5_102;
      const oldIdentity = fixtureProcessIdentity(`old-${operation}`);
      const fenceIdentity = fixtureProcessIdentity(`fence-${operation}`);
      let notifySleepStarted!: () => void;
      const sleepStarted = new Promise<void>((resolve) => {
        notifySleepStarted = resolve;
      });
      let resumeSleep!: () => void;
      const sleepCanFinish = new Promise<void>((resolve) => {
        resumeSleep = resolve;
      });
      const oldLock = await acquireUpdateLock({
        lockPath,
        timeoutMs: 100,
        retryDelayMs: 10,
        clock: () => 10_000,
        sleep: async () => {
          notifySleepStarted();
          await sleepCanFinish;
        },
        isProcessAlive: () => true,
        processIdentity: oldIdentity,
        getProcessIdentity: (pid) => (pid === fencePid ? fenceIdentity : null),
        pid: oldPid,
        hostname,
        createOwnerId: () => `old-owner-${operation}`,
      });
      const fencePath = `${lockPath}.reclaim`;
      await writeLockMetadata(fencePath, {
        version: UPDATE_LOCK_METADATA_VERSION,
        ownerId: `reclaimer-${operation}`,
        pid: fencePid,
        hostname,
        ...fenceIdentity,
        acquiredAtMs: 10_000,
        leaseExpiresAtMs: 20_000,
      });

      const staleMutation = operation === "renew" ? oldLock.renew() : oldLock.release();
      await sleepStarted;
      const replacementIdentity = fixtureProcessIdentity(`replacement-${operation}`);
      const replacementMetadata: UpdateLockMetadata = {
        version: UPDATE_LOCK_METADATA_VERSION,
        ownerId: `replacement-owner-${operation}`,
        pid: 5_103,
        hostname,
        ...replacementIdentity,
        acquiredAtMs: 10_001,
        leaseExpiresAtMs: 20_001,
      };
      await unlink(lockPath);
      await writeLockMetadata(lockPath, replacementMetadata);
      await unlink(fencePath);
      resumeSleep();

      await expect(staleMutation).rejects.toBeInstanceOf(UpdateLockOwnershipError);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacementMetadata);
    },
  );

  it("fails closed instead of reclaiming an expired remote mutation fence", async () => {
    const lockPath = await createTemporaryLockPath();
    const localHostname = "fixture-host";
    const fencePid = 5_201;
    const fenceIdentity = fixtureProcessIdentity("active-fence");
    const staleMetadata: UpdateLockMetadata = {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "expired-remote-owner",
      pid: 5_200,
      hostname: "remote-host",
      ...fixtureProcessIdentity("expired-remote"),
      acquiredAtMs: 1,
      leaseExpiresAtMs: 2,
    };
    await writeLockMetadata(lockPath, staleMetadata);
    await writeLockMetadata(`${lockPath}.reclaim`, {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId: "expired-remote-reclaimer",
      pid: fencePid,
      hostname: "remote-fence-host",
      ...fenceIdentity,
      acquiredAtMs: 1,
      leaseExpiresAtMs: 2,
    });

    await expect(
      acquireUpdateLock({
        lockPath,
        timeoutMs: 0,
        clock: () => 10_000,
        processIdentity: fixtureProcessIdentity("blocked-contender"),
        getProcessIdentity: (pid) => (pid === fencePid ? fenceIdentity : null),
        pid: 5_202,
        hostname: localHostname,
      }),
    ).rejects.toBeInstanceOf(UpdateLockUnavailableError);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(staleMetadata);
  });

  it("rejects a symlinked lock directory without chmod or target mutation", async () => {
    const lockPath = await createTemporaryLockPath();
    const root = path.dirname(path.dirname(lockPath));
    const targetDirectory = path.join(root, "foreign-locks");
    await mkdir(targetDirectory, { mode: 0o755 });
    await chmod(targetDirectory, 0o755);
    await symlink(targetDirectory, path.dirname(lockPath));

    await expect(acquireUpdateLock({ lockPath, timeoutMs: 0 })).rejects.toBeInstanceOf(
      UnsafeUpdateLockError,
    );
    expect((await stat(targetDirectory)).mode & 0o777).toBe(0o755);
    await expect(access(path.join(targetDirectory, "update.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when an ancestor is writable by other users", async () => {
    const lockPath = await createTemporaryLockPath();
    const root = path.dirname(path.dirname(lockPath));
    await chmod(root, 0o777);

    await expect(acquireUpdateLock({ lockPath, timeoutMs: 0 })).rejects.toBeInstanceOf(
      UnsafeUpdateLockError,
    );
  });

  it.each(["linux", "darwin"] as const)(
    "never mutates a replacement lock directory after its inode changes on %s",
    async (platform) => {
      const lockPath = await createTemporaryLockPath();
      const lock = await acquireUpdateLock({
        lockPath,
        timeoutMs: 0,
        platform,
        processIdentity: fixtureProcessIdentity(`${platform}-directory-owner`),
      });
      const lockDirectory = path.dirname(lockPath);
      const originalDirectory = `${lockDirectory}.original`;
      await rename(lockDirectory, originalDirectory);
      await mkdir(lockDirectory, { mode: 0o700 });
      const replacementMetadata: UpdateLockMetadata = {
        version: UPDATE_LOCK_METADATA_VERSION,
        ownerId: "replacement-after-directory-swap",
        pid: process.pid,
        hostname: os.hostname(),
        ...fixtureProcessIdentity("replacement-directory-owner"),
        acquiredAtMs: 1,
        leaseExpiresAtMs: 20_000,
      };
      await writeLockMetadata(lockPath, replacementMetadata);

      await expect(lock.release()).rejects.toBeInstanceOf(UnsafeUpdateLockError);
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacementMetadata);
    },
  );
});
