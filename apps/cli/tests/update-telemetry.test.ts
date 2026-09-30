import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upgradeCommand } from "../src/commands/upgrade.js";
import type { UpdateTelemetryState } from "../src/updates/auto-update-state.js";
import {
  type AutoUpdateAutomation,
  type AutoUpdateAutomationOptions,
  buildSystemdRunArguments,
  runUpdateWorker,
  startAutoUpdateAutomation,
} from "../src/updates/auto-update.js";
import {
  type UpdateCheckResult,
  UpdateEngine,
  type UpdateEngineResult,
  type UpdateStatusSnapshot,
} from "../src/updates/engine.js";
import { DEFAULT_UPDATE_POLICY, type UpdatePolicy } from "../src/updates/policy.js";
import {
  UPDATE_CHECK_REPORT_INTERVAL_MS,
  UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS,
  decideDeferralReport,
  decideIntervalReport,
} from "../src/updates/update-telemetry.js";
import {
  type FakeReporter,
  type MemoryTelemetryStore,
  createFakeReporter,
  createMemoryTelemetryStore,
  createTestTelemetry,
} from "./support/update-telemetry-fakes.js";

const START = Date.parse("2026-09-26T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(patch: Partial<UpdateStatusSnapshot> = {}): UpdateStatusSnapshot {
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

function engineResult(patch: Partial<UpdateEngineResult>): UpdateEngineResult {
  return {
    success: true,
    mode: "background",
    status: "activated",
    channel: "stable",
    currentVersion: "1.0.0",
    activeVersion: "1.1.0",
    targetVersion: "1.1.0",
    staged: true,
    activated: true,
    healthGatePassed: true,
    stepsCompleted: ["preflight", "lock_acquired", "channel_resolved", "signed_release_resolved"],
    snapshot: snapshot(),
    ...patch,
  };
}

function checkResult(
  status: UpdateCheckResult["status"],
  policy: UpdatePolicy = { ...DEFAULT_UPDATE_POLICY },
): UpdateCheckResult {
  return {
    status,
    policy,
    channel: policy.channel,
    currentVersion: "1.0.0",
    targetVersion: status === "disabled" ? undefined : "1.1.0",
  };
}

/** An automation on fake timers with in-memory state; `check` is the channel answer. */
function startAutomation(options: {
  reporter: FakeReporter;
  store?: MemoryTelemetryStore;
  policy?: UpdatePolicy;
  check?: () => Promise<UpdateCheckResult>;
  journal?: UpdateStatusSnapshot | null;
  launchWorker?: () => Promise<void>;
}): { automation: AutoUpdateAutomation; store: MemoryTelemetryStore; launches: () => number } {
  const store = options.store ?? createMemoryTelemetryStore();
  const policy = options.policy ?? { ...DEFAULT_UPDATE_POLICY };
  let launches = 0;
  const automationOptions: AutoUpdateAutomationOptions = {
    resinHome: "/unused/.resin",
    checker: {
      checkForUpdate: options.check ?? (async () => checkResult("update-available", policy)),
      readPolicy: async () => policy,
    },
    launchWorker: async () => {
      launches += 1;
      await options.launchWorker?.();
    },
    readJournal: async () => options.journal ?? null,
    publishNotification: async () => undefined,
    readState: async () => null,
    writeState: async () => undefined,
    random: () => 0.5,
    report: () => undefined,
    telemetry: createTestTelemetry(options.reporter, store),
  };
  return {
    automation: startAutoUpdateAutomation(automationOptions),
    store,
    launches: () => launches,
  };
}

describe("update_check_completed from the service supervisor", () => {
  it("reports the startup check and later scheduled checks with versions, channel and duration", async () => {
    const reporter = createFakeReporter();
    let status: UpdateCheckResult["status"] = "update-available";
    const { automation, launches } = startAutomation({
      reporter,
      check: async () => {
        vi.setSystemTime(Date.now() + 1_500);
        return checkResult(status);
      },
    });

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(launches()).toBe(1);
    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      {
        trigger: "startup",
        outcome: "update_available",
        current_version: "1.0.0",
        available_version: "1.1.0",
        channel: "stable",
        duration_ms: 1_500,
      },
    ]);

    status = "already-current";
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(reporter.eventsNamed("update_check_completed").at(-1)).toEqual({
      trigger: "scheduled",
      outcome: "up_to_date",
      current_version: "1.0.0",
      available_version: "1.1.0",
      channel: "stable",
      duration_ms: 1_500,
    });
    automation.stop();
  });

  it("maps quarantine and downgrade refusals to blocked outcomes", async () => {
    const reporter = createFakeReporter();
    const outcomes: UpdateCheckResult["status"][] = ["quarantined", "downgrade-blocked", "failed"];
    const { automation } = startAutomation({
      reporter,
      check: async () => checkResult(outcomes.shift() ?? "already-current"),
    });

    await vi.advanceTimersByTimeAsync(MINUTE + 12 * HOUR);

    expect(
      reporter.eventsNamed("update_check_completed").map((properties) => properties.outcome),
    ).toEqual(["blocked_quarantine", "blocked_downgrade", "failed"]);
    automation.stop();
  });

  it("sends at most one offline check per six hours across backoff retries and restarts", async () => {
    const reporter = createFakeReporter();
    const store = createMemoryTelemetryStore();
    const first = startAutomation({ reporter, store, check: async () => checkResult("offline") });

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      expect.objectContaining({ trigger: "startup", outcome: "offline", suppressed_count: 0 }),
    ]);

    // Backoff retries at 1, 2, 4, 8, ... 60 minutes: none of them is sent.
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(reporter.eventsNamed("update_check_completed")).toHaveLength(1);
    const suppressedBeforeRestart = store.state?.checks.offline?.suppressed ?? 0;
    expect(suppressedBeforeRestart).toBeGreaterThan(3);

    // A service restart keeps the limit: the state is persisted.
    first.automation.stop();
    const second = startAutomation({ reporter, store, check: async () => checkResult("offline") });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(reporter.eventsNamed("update_check_completed")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3 * HOUR);
    const sent = reporter.eventsNamed("update_check_completed");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ outcome: "offline" });
    expect(sent[1]?.suppressed_count).toBeGreaterThan(suppressedBeforeRestart);
    second.automation.stop();
  });

  it("reports a disabled updater as skipped_disabled", async () => {
    const reporter = createFakeReporter();
    const { automation } = startAutomation({
      reporter,
      policy: { ...DEFAULT_UPDATE_POLICY, autoUpdate: false },
    });

    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      { trigger: "startup", outcome: "skipped_disabled", channel: "stable", suppressed_count: 0 },
    ]);
    automation.stop();
  });

  it("reports a due check held back by the maintenance window as skipped_window", async () => {
    const reporter = createFakeReporter();
    const { automation, launches } = startAutomation({
      reporter,
      policy: {
        ...DEFAULT_UPDATE_POLICY,
        maintenanceWindow: { start: "02:00", end: "03:00", timeZone: "UTC" },
      },
    });

    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(launches()).toBe(0);
    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      expect.objectContaining({ trigger: "startup", outcome: "skipped_window" }),
    ]);
    automation.stop();
  });

  it("rate-limits worker launch failures retried on the offline backoff", async () => {
    const reporter = createFakeReporter();
    const { automation, launches } = startAutomation({
      reporter,
      launchWorker: async () => {
        throw Object.assign(new Error("systemd-run failed: unit resin-update-1 exists"), {
          code: "ERR_SYSTEMD_RUN",
        });
      },
    });

    await vi.advanceTimersByTimeAsync(MINUTE + 3 * HOUR);

    expect(launches()).toBeGreaterThan(3);
    expect(reporter.eventsNamed("update_failed")).toEqual([
      expect.objectContaining({
        trigger: "auto",
        stage: "launch",
        error_code: "ERR_SYSTEMD_RUN",
        rolled_back: false,
        suppressed_count: 0,
      }),
    ]);
    expect(reporter.exceptions).toHaveLength(1);
    automation.stop();
  });
});

describe("update_deferred", () => {
  it("sends the first deferral per target, then at most hourly with the running counts", async () => {
    const reporter = createFakeReporter();
    const store = createMemoryTelemetryStore();
    const telemetry = createTestTelemetry(reporter, store);

    for (let index = 0; index < 9; index += 1) {
      telemetry.deferred({
        trigger: "auto",
        reason: "active_tool_executions",
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
      });
      await telemetry.settled();
      await vi.advanceTimersByTimeAsync(15 * MINUTE);
    }
    telemetry.deferred({ trigger: "auto", reason: "locked", targetVersion: "1.2.0" });
    await telemetry.settled();

    expect(reporter.eventsNamed("update_deferred")).toEqual([
      {
        trigger: "auto",
        reason: "active_tool_executions",
        current_version: "1.0.0",
        target_version: "1.1.0",
        deferral_count: 1,
        deferred_for_ms: 0,
      },
      expect.objectContaining({ deferral_count: 5, deferred_for_ms: HOUR }),
      expect.objectContaining({ deferral_count: 9, deferred_for_ms: 2 * HOUR }),
      {
        trigger: "auto",
        reason: "locked",
        target_version: "1.2.0",
        deferral_count: 1,
        deferred_for_ms: 0,
      },
    ]);
  });

  it("reports a staged release held outside the maintenance window from the supervisor", async () => {
    const reporter = createFakeReporter();
    const { automation } = startAutomation({
      reporter,
      policy: {
        ...DEFAULT_UPDATE_POLICY,
        maintenanceWindow: { start: "02:00", end: "03:00", timeZone: "UTC" },
      },
      journal: snapshot({ lastResult: "activation-deferred", pendingVersion: "1.1.0" }),
    });

    await vi.advanceTimersByTimeAsync(MINUTE + 75 * MINUTE);

    expect(reporter.eventsNamed("update_deferred")).toEqual([
      expect.objectContaining({
        reason: "maintenance_window",
        target_version: "1.1.0",
        deferral_count: 1,
      }),
      expect.objectContaining({ deferral_count: 5, deferred_for_ms: HOUR }),
    ]);
    automation.stop();
  });

  it("keeps the rate-limit arithmetic pure", () => {
    const empty: UpdateTelemetryState = { schemaVersion: 1, checks: {}, deferral: null };
    const first = decideDeferralReport(empty, "1.1.0", START);
    const second = decideDeferralReport(first.state, "1.1.0", START + 30 * MINUTE);
    expect([first.send, second.send, second.deferralCount]).toEqual([true, false, 2]);

    const sent = decideIntervalReport(empty, "offline", START);
    const held = decideIntervalReport(
      sent.state,
      "offline",
      START + UPDATE_CHECK_REPORT_INTERVAL_MS - 1,
    );
    const next = decideIntervalReport(
      held.state,
      "offline",
      START + UPDATE_CHECK_REPORT_INTERVAL_MS,
    );
    expect([sent.send, held.send, next.send, next.suppressedCount]).toEqual([true, false, true, 1]);
  });
});

describe("update_installed and update_failed from the update worker", () => {
  it("reports an installed update with duration, publish latency and prior deferrals", async () => {
    const reporter = createFakeReporter();
    const store = createMemoryTelemetryStore({
      schemaVersion: 1,
      checks: {},
      deferral: {
        targetVersion: "1.1.0",
        firstDeferredAtMs: START - HOUR,
        lastSentAtMs: START - HOUR,
        count: 3,
      },
    });
    const releaseDate = new Date(START - 2 * HOUR).toISOString();

    await runUpdateWorker({
      resinHome: "/unused/.resin",
      engine: {
        run: async () => {
          vi.setSystemTime(Date.now() + 90_000);
          return engineResult({ releaseDate });
        },
      },
      publishNotification: async () => undefined,
      writeNotice: async () => undefined,
      report: () => undefined,
      telemetry: createTestTelemetry(reporter, store),
    });

    expect(reporter.eventsNamed("update_installed")).toEqual([
      {
        trigger: "auto",
        from_version: "1.0.0",
        to_version: "1.1.0",
        channel: "stable",
        duration_ms: 90_000,
        publish_to_install_ms: 2 * HOUR + 90_000,
        deferral_count: 3,
      },
    ]);
    expect(store.state?.deferral).toBeNull();
    expect(reporter.flushCalls).toBe(1);
  });

  it("reports a rolled-back failure and a sanitized handled error with the same code", async () => {
    const reporter = createFakeReporter();
    const cause = new Error("candidate on /home/alice/.resin/versions/v1.1.0 never became healthy");
    cause.name = "CandidateHealthError";

    await runUpdateWorker({
      resinHome: "/unused/.resin",
      engine: {
        run: async () =>
          engineResult({
            success: false,
            status: "rolled-back",
            activeVersion: "1.0.0",
            rolledBack: true,
            quarantined: true,
            failure: {
              stage: "health_check",
              errorCode: "CandidateHealthError",
              rollback: "succeeded",
              cause,
            },
          }),
      },
      publishNotification: async () => undefined,
      report: () => undefined,
      telemetry: createTestTelemetry(reporter),
    });

    expect(reporter.eventsNamed("update_failed")).toEqual([
      {
        trigger: "auto",
        stage: "health_check",
        error_code: "CandidateHealthError",
        from_version: "1.0.0",
        target_version: "1.1.0",
        channel: "stable",
        rolled_back: true,
        rollback_outcome: "succeeded",
        quarantined: true,
      },
    ]);
    expect(reporter.exceptions).toHaveLength(1);
    const [tracked] = reporter.exceptions;
    expect(tracked).toMatchObject({
      handled: true,
      failureClass: "update_failed",
      errorCode: "CandidateHealthError",
    });
    const error = tracked?.error;
    if (!(error instanceof Error)) throw new Error("expected the tracked failure to be an Error");
    expect(error.message).toBe("Update failed during health_check (CandidateHealthError)");
    expect(error.stack).not.toContain("alice");
    expect(error.stack).toContain("update-telemetry.test.ts");
  });

  it("distinguishes a failed rollback from a successful one", async () => {
    const reporter = createFakeReporter();

    await runUpdateWorker({
      resinHome: "/unused/.resin",
      engine: {
        run: async () =>
          engineResult({
            success: false,
            status: "failed",
            activeVersion: "1.1.0",
            rolledBack: false,
            quarantined: false,
            failure: { stage: "restart", errorCode: "restart_failed", rollback: "failed" },
          }),
      },
      publishNotification: async () => undefined,
      report: () => undefined,
      telemetry: createTestTelemetry(reporter),
    });

    expect(reporter.eventsNamed("update_failed")).toEqual([
      expect.objectContaining({
        stage: "restart",
        rolled_back: false,
        rollback_outcome: "failed",
        quarantined: false,
      }),
    ]);
  });

  it("reports an engine that throws at the lock with a fixed code and no path text", async () => {
    const reporter = createFakeReporter();
    const engine = new UpdateEngine({
      homeDir: "/nonexistent-update-home",
      resinHome: "/nonexistent-update-home/.resin",
      acquireLock: async () => {
        throw Object.assign(
          new Error("EACCES: permission denied, open '/home/alice/.resin/locks/update.lock'"),
          { code: "EACCES" },
        );
      },
      logger: () => undefined,
    });

    await expect(
      runUpdateWorker({
        resinHome: "/nonexistent-update-home/.resin",
        engine,
        report: () => undefined,
        telemetry: createTestTelemetry(reporter),
      }),
    ).rejects.toThrow("EACCES");

    expect(reporter.eventsNamed("update_failed")).toEqual([
      expect.objectContaining({ trigger: "auto", stage: "lock", error_code: "EACCES" }),
    ]);
    expect(JSON.stringify(reporter.events)).not.toContain("alice");
    expect(reporter.exceptions[0]?.error).toMatchObject({
      message: "Update failed during lock (EACCES)",
    });
    expect(reporter.flushCalls).toBe(1);
  });

  it("reports a deferred activation and a lock refusal as deferrals", async () => {
    const reporter = createFakeReporter();
    const telemetry = createTestTelemetry(reporter);
    const run = (result: UpdateEngineResult) =>
      runUpdateWorker({
        resinHome: "/unused/.resin",
        engine: { run: async () => result },
        report: () => undefined,
        telemetry,
      });

    await run(
      engineResult({
        status: "activation-deferred",
        activeVersion: "1.0.0",
        pendingVersion: "1.1.0",
        deferralReason: "active-sessions",
        deferralCode: "in_flight_requests",
      }),
    );
    await run(
      engineResult({
        success: false,
        status: "locked",
        activeVersion: "1.0.0",
        targetVersion: undefined,
        pendingVersion: "1.2.0",
        deferralCode: "locked",
      }),
    );

    expect(reporter.eventsNamed("update_deferred")).toEqual([
      expect.objectContaining({ reason: "in_flight_requests", target_version: "1.1.0" }),
      expect.objectContaining({ reason: "locked", target_version: "1.2.0", deferral_count: 1 }),
    ]);
  });
});

describe("update telemetry never blocks or breaks an update", () => {
  function activatedWorker(
    reporter: FakeReporter,
    order: string[],
    store: MemoryTelemetryStore = createMemoryTelemetryStore(),
  ) {
    return runUpdateWorker({
      resinHome: "/unused/.resin",
      engine: {
        run: async () => {
          order.push("engine");
          return engineResult({});
        },
      },
      publishNotification: async () => {
        order.push("notify");
      },
      writeNotice: async () => {
        order.push("notice");
      },
      report: () => undefined,
      telemetry: createTestTelemetry(reporter, store),
    });
  }

  it("completes the update when every reporter method throws", async () => {
    const order: string[] = [];

    const result = await activatedWorker(createFakeReporter({ throws: true }), order);

    expect(result.status).toBe("activated");
    expect(order).toEqual(["engine", "notify", "notice"]);
  });

  it("finishes the update first and exits within the flush bound when the reporter hangs", async () => {
    const order: string[] = [];
    const reporter = createFakeReporter({ hangs: true });
    let settled = false;

    const pending = activatedWorker(reporter, order).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["engine", "notify", "notice"]);
    expect(reporter.eventsNamed("update_installed")).toHaveLength(1);
    expect(reporter.flushCalls).toBe(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "activated" });
  });

  it("exits within the flush bound when the telemetry state store hangs", async () => {
    const order: string[] = [];
    const store = createMemoryTelemetryStore();
    store.read = () => Promise.withResolvers<UpdateTelemetryState | null>().promise;
    let settled = false;

    const pending = activatedWorker(createFakeReporter(), order, store).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS - 1);
    expect(order).toEqual(["engine", "notify", "notice"]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await pending;
  });

  it("keeps the supervisor checking and launching when the reporter throws", async () => {
    const reporter = createFakeReporter({ throws: true });
    const { automation, launches } = startAutomation({ reporter });

    await vi.advanceTimersByTimeAsync(MINUTE + 6 * HOUR);

    expect(launches()).toBe(2);
    automation.stop();
  });
});

describe("update telemetry when reporting is disabled", () => {
  it("sends nothing and writes no state from the supervisor, worker or upgrade command", async () => {
    const reporter = createFakeReporter({ enabled: false });
    const store = createMemoryTelemetryStore();
    const { automation } = startAutomation({
      reporter,
      store,
      check: async () => checkResult("offline"),
    });
    await vi.advanceTimersByTimeAsync(MINUTE + HOUR);
    automation.stop();

    await runUpdateWorker({
      resinHome: "/unused/.resin",
      engine: {
        run: async () =>
          engineResult({
            success: false,
            status: "failed",
            failure: { stage: "download", errorCode: "ECONNRESET", rollback: "not_attempted" },
          }),
      },
      publishNotification: async () => undefined,
      report: () => undefined,
      telemetry: createTestTelemetry(reporter, store),
    });
    await upgradeCommand(["--json"], {
      engine: { run: async () => engineResult({ mode: "manual" }) },
      stdout: { write: () => true },
      stderr: { write: () => true },
      fsBridge: {
        readFile: async () => null,
        writeFile: async () => undefined,
        exists: async () => false,
        mkdirp: async () => undefined,
        copyFile: async () => undefined,
        unlink: async () => undefined,
      },
      telemetry: createTestTelemetry(reporter, store),
    });

    expect(reporter.events).toEqual([]);
    expect(reporter.exceptions).toEqual([]);
    expect(store.writes).toBe(0);
  });
});

describe("resin upgrade (trigger manual)", () => {
  const fsBridge = {
    readFile: async () => JSON.stringify({ version: "1.0.0" }),
    writeFile: async () => undefined,
    exists: async () => true,
    mkdirp: async () => undefined,
    copyFile: async () => undefined,
    unlink: async () => undefined,
  };

  async function upgrade(
    reporter: FakeReporter,
    result: UpdateEngineResult | Error,
    args: string[] = ["--json"],
  ): Promise<number> {
    return upgradeCommand(args, {
      engine: {
        run: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      },
      fsBridge,
      stdout: { write: () => true },
      stderr: { write: () => true },
      telemetry: createTestTelemetry(reporter),
    });
  }

  it("reports the channel check and the install", async () => {
    const reporter = createFakeReporter();

    await upgrade(reporter, engineResult({ mode: "manual", checkDurationMs: 420 }));

    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      {
        trigger: "manual",
        outcome: "update_available",
        current_version: "1.0.0",
        available_version: "1.1.0",
        channel: "stable",
        duration_ms: 420,
      },
    ]);
    expect(reporter.eventsNamed("update_installed")).toEqual([
      expect.objectContaining({ trigger: "manual", from_version: "1.0.0", to_version: "1.1.0" }),
    ]);
  });

  it("reports a channel verification failure as a failed check only", async () => {
    const reporter = createFakeReporter();

    await upgrade(
      reporter,
      engineResult({
        mode: "manual",
        success: false,
        status: "failed",
        activeVersion: "1.0.0",
        targetVersion: undefined,
        stepsCompleted: ["preflight", "lock_acquired", "channel_resolved", "release_rejected"],
        failure: { stage: "verify", errorCode: "verify_failed", rollback: "not_attempted" },
      }),
    );

    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      expect.objectContaining({ trigger: "manual", outcome: "failed" }),
    ]);
    expect(reporter.eventsNamed("update_failed")).toEqual([]);
  });

  it("never rate-limits manual offline checks", async () => {
    const reporter = createFakeReporter();
    const offline = engineResult({
      mode: "manual",
      success: false,
      status: "offline",
      activeVersion: "1.0.0",
      targetVersion: undefined,
      stepsCompleted: ["preflight", "lock_acquired", "channel_resolved", "offline_deferred"],
    });

    await upgrade(reporter, offline);
    await upgrade(reporter, offline);

    expect(
      reporter.eventsNamed("update_check_completed").map((properties) => properties.outcome),
    ).toEqual(["offline", "offline"]);
    expect(reporter.eventsNamed("update_failed")).toEqual([]);
  });

  it("reports a staging failure after the check as update_failed with trigger manual", async () => {
    const reporter = createFakeReporter();

    const exitCode = await upgrade(
      reporter,
      engineResult({
        mode: "manual",
        success: false,
        status: "failed",
        activeVersion: "1.0.0",
        failure: { stage: "download", errorCode: "ECONNRESET", rollback: "not_attempted" },
      }),
    );

    expect(exitCode).toBe(1);
    expect(reporter.eventsNamed("update_check_completed")).toEqual([
      expect.objectContaining({ outcome: "update_available" }),
    ]);
    expect(reporter.eventsNamed("update_failed")).toEqual([
      expect.objectContaining({ trigger: "manual", stage: "download", error_code: "ECONNRESET" }),
    ]);
    expect(reporter.eventsNamed("upgrade_failed")).toEqual([]);
    expect(reporter.exceptions).toEqual([
      expect.objectContaining({ failureClass: "update_failed", errorCode: "ECONNRESET" }),
    ]);
  });

  it("reports only failures of an explicit rollback", async () => {
    const reporter = createFakeReporter();

    await upgrade(
      reporter,
      engineResult({
        mode: "manual",
        status: "rolled-back",
        activeVersion: "0.9.0",
        rolledBack: true,
      }),
      ["--rollback", "--json"],
    );

    expect(reporter.events).toEqual([]);
  });

  it("reports an engine that throws once, as update_failed", async () => {
    const reporter = createFakeReporter();

    const exitCode = await upgrade(reporter, new Error("boom"));

    expect(exitCode).toBe(1);
    expect(reporter.eventsNamed("update_failed")).toEqual([
      expect.objectContaining({
        trigger: "manual",
        stage: "preflight",
        error_code: "preflight_failed",
      }),
    ]);
    // The error travels as update_failed only; the generic `upgrade` report is not duplicated.
    expect(reporter.exceptions).toHaveLength(1);
  });
});

describe("update worker environment", () => {
  it("forwards error-reporting consent so an opted-out user stays opted out in the worker", () => {
    const args = buildSystemdRunArguments({
      unitName: "resin-update-1",
      workerArgs: ["node", "index.js"],
      env: { DO_NOT_TRACK: "1", RESIN_ERROR_REPORTING: "0", RESIN_TELEMETRY_ENABLED: "0" },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--setenv=DO_NOT_TRACK=1",
        "--setenv=RESIN_ERROR_REPORTING=0",
        "--setenv=RESIN_TELEMETRY_ENABLED=0",
      ]),
    );
  });
});
