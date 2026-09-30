import {
  type ErrorReporterLike,
  type EventProperties,
  getErrorReporter,
} from "@resin/observer/error-reporting/core";
import {
  type UpdateTelemetryState,
  createUpdateTelemetryState,
  readUpdateTelemetryState,
  writeUpdateTelemetryState,
} from "./auto-update-state.js";
import {
  type UpdateCheckStatus,
  type UpdateDeferralCode,
  type UpdateEngineResult,
  type UpdateFailureStage,
  type UpdateRollbackOutcome,
  updateFailureCode,
  updateFailureStageOf,
} from "./engine.js";

/**
 * Update telemetry: four fixed-vocabulary PostHog events that show how each release reaches users
 * and where updates get stuck. Properties are versions, fixed codes, durations, counts and
 * booleans only; never paths, URLs, host names or error text.
 *
 * Every public method is synchronous, never throws, and queues its work (rate-limit bookkeeping,
 * then a non-blocking `capture`), so telemetry can never fail or delay an update. Nothing is
 * queued, read or written while reporting is disabled or unconfigured.
 */

export const UPDATE_CHECK_REPORT_INTERVAL_MS = 6 * 60 * 60_000;
export const UPDATE_DEFERRAL_REPORT_INTERVAL_MS = 60 * 60_000;
/** The reporter's own exit bound: the most a process waits for telemetry before it exits. */
export const UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;
/** A single bookkeeping step (state read + write) that takes longer than this is abandoned. */
const UPDATE_TELEMETRY_TASK_TIMEOUT_MS = 5_000;

export type UpdateCheckTrigger = "scheduled" | "startup" | "offline_retry" | "manual";
export type UpdateRunTrigger = "auto" | "manual";
export type UpdateCheckTelemetryOutcome =
  | "up_to_date"
  | "update_available"
  | "offline"
  | "failed"
  | "skipped_disabled"
  | "skipped_window"
  | "blocked_quarantine"
  | "blocked_downgrade";
/** Engine stages plus `launch`: the supervisor could not start the out-of-service worker. */
export type UpdateTelemetryStage = UpdateFailureStage | "launch";

/** Outcomes that repeat without anything changing (backoff retries, policy re-evaluation). */
const RATE_LIMITED_CHECK_OUTCOMES: ReadonlySet<UpdateCheckTelemetryOutcome> = new Set([
  "offline",
  "skipped_disabled",
  "skipped_window",
]);

export function checkOutcomeFor(status: UpdateCheckStatus): UpdateCheckTelemetryOutcome {
  switch (status) {
    case "update-available":
      return "update_available";
    case "already-current":
      return "up_to_date";
    case "disabled":
      return "skipped_disabled";
    case "quarantined":
      return "blocked_quarantine";
    case "downgrade-blocked":
      return "blocked_downgrade";
    case "offline":
      return "offline";
    default:
      return "failed";
  }
}

export interface UpdateTelemetryStore {
  read(): Promise<UpdateTelemetryState | null>;
  write(state: UpdateTelemetryState): Promise<void>;
}

export function createFileUpdateTelemetryStore(resinHome: string): UpdateTelemetryStore {
  return {
    read: () => readUpdateTelemetryState(resinHome),
    write: (state) => writeUpdateTelemetryState(resinHome, state),
  };
}

export interface IntervalReportDecision {
  readonly send: boolean;
  /** Events with the same key suppressed since the last one sent; carried on the next send. */
  readonly suppressedCount: number;
  readonly state: UpdateTelemetryState;
}

/**
 * At most one event per key per six hours; the rest are counted as suppressed and the count
 * rides on the next event sent. Keys are check outcomes (`offline`) or `failed:<stage>`.
 */
export function decideIntervalReport(
  state: UpdateTelemetryState,
  key: string,
  nowMs: number,
): IntervalReportDecision {
  const previous = state.checks[key];
  if (
    previous !== undefined &&
    nowMs >= previous.lastSentAtMs &&
    nowMs - previous.lastSentAtMs < UPDATE_CHECK_REPORT_INTERVAL_MS
  ) {
    return {
      send: false,
      suppressedCount: previous.suppressed + 1,
      state: {
        ...state,
        checks: { ...state.checks, [key]: { ...previous, suppressed: previous.suppressed + 1 } },
      },
    };
  }
  return {
    send: true,
    suppressedCount: previous?.suppressed ?? 0,
    state: {
      ...state,
      checks: { ...state.checks, [key]: { lastSentAtMs: nowMs, suppressed: 0 } },
    },
  };
}

/**
 * Whether a check event goes through the six-hour limiter: outcomes that repeat without anything
 * changing (offline, skipped) and every result of an offline-backoff retry. Manual checks never.
 */
export function isRateLimitedCheck(
  trigger: UpdateCheckTrigger,
  outcome: UpdateCheckTelemetryOutcome,
): boolean {
  if (trigger === "manual") return false;
  return trigger === "offline_retry" || RATE_LIMITED_CHECK_OUTCOMES.has(outcome);
}

export interface DeferralReportDecision {
  readonly send: boolean;
  /** Consecutive deferrals for this target, including this one. */
  readonly deferralCount: number;
  /** Time since the first deferral for this target. */
  readonly deferredForMs: number;
  readonly state: UpdateTelemetryState;
}

/** The first deferral for a target is sent, then at most one per hour while it stays deferred. */
export function decideDeferralReport(
  state: UpdateTelemetryState,
  targetVersion: string | null,
  nowMs: number,
): DeferralReportDecision {
  const previous = state.deferral;
  if (previous === null || previous.targetVersion !== targetVersion) {
    return {
      send: true,
      deferralCount: 1,
      deferredForMs: 0,
      state: {
        ...state,
        deferral: { targetVersion, firstDeferredAtMs: nowMs, lastSentAtMs: nowMs, count: 1 },
      },
    };
  }
  const count = previous.count + 1;
  const deferredForMs = Math.max(0, nowMs - previous.firstDeferredAtMs);
  const send =
    nowMs < previous.lastSentAtMs ||
    nowMs - previous.lastSentAtMs >= UPDATE_DEFERRAL_REPORT_INTERVAL_MS;
  return {
    send,
    deferralCount: count,
    deferredForMs,
    state: {
      ...state,
      deferral: { ...previous, count, lastSentAtMs: send ? nowMs : previous.lastSentAtMs },
    },
  };
}

export interface UpdateCheckEvent {
  readonly trigger: UpdateCheckTrigger;
  readonly outcome: UpdateCheckTelemetryOutcome;
  readonly currentVersion?: string;
  readonly availableVersion?: string;
  readonly channel?: string;
  readonly durationMs?: number;
}

export interface UpdateDeferredEvent {
  readonly trigger: UpdateRunTrigger;
  readonly reason: UpdateDeferralCode;
  readonly currentVersion?: string;
  readonly targetVersion?: string;
}

export interface UpdateInstalledEvent {
  readonly trigger: UpdateRunTrigger;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel?: string;
  readonly durationMs?: number;
  /** Signed release date (ISO); yields `publish_to_install_ms`. */
  readonly releaseDate?: string;
}

export interface UpdateFailedEvent {
  readonly trigger: UpdateRunTrigger;
  readonly stage: UpdateTelemetryStage;
  readonly errorCode: string;
  readonly fromVersion?: string;
  readonly targetVersion?: string;
  readonly channel?: string;
  readonly rollback: UpdateRollbackOutcome;
  readonly quarantined: boolean;
  /** The original error: only its class name and stack frames reach Error Tracking. */
  readonly cause?: unknown;
  /** False for conditions that are not exceptions (offline); no Error Tracking entry. */
  readonly trackError?: boolean;
  /**
   * For failures the supervisor retries on the offline backoff (worker launch): at most one
   * event per stage per six hours, with `suppressed_count`.
   */
  readonly rateLimited?: boolean;
}

export interface UpdateRunContext {
  readonly trigger: UpdateRunTrigger;
  /** When the worker or command started; `duration_ms` runs from here to healthy. */
  readonly startedAtMs: number;
  /** `resin upgrade` checks the channel itself, so it also reports the check. */
  readonly reportCheck?: boolean;
  /** `resin upgrade --rollback` is not an update: only its failures are reported. */
  readonly explicitRollback?: boolean;
}

export interface UpdateTelemetryOptions {
  /** Resolved on every event; defaults to the process-wide reporter. */
  readonly reporter?: () => ErrorReporterLike;
  readonly store: UpdateTelemetryStore;
  readonly clock?: () => number;
  /**
   * Long-lived processes (the service supervisor) send each event right away, so a service
   * restart during cutover cannot drop it from the client's queue.
   */
  readonly eager?: boolean;
}

/** An error that carries only a fixed message and the original stack frames. */
class UpdateFailedError extends Error {
  constructor(stage: UpdateTelemetryStage, code: string, cause: unknown) {
    super(`Update failed during ${stage} (${code})`);
    this.name = "UpdateFailedError";
    const frames =
      cause instanceof Error && typeof cause.stack === "string"
        ? cause.stack.split("\n").filter((line) => /^\s*at\s/.test(line))
        : [];
    if (frames.length > 0) {
      this.stack = [`${this.name}: ${this.message}`, ...frames].join("\n");
    }
  }
}

/**
 * Resolves when `promise` settles or `timeoutMs` passes, whichever is first; never rejects.
 * `keepAlive` waits hold the process open (an exit flush); others must not.
 */
function boundedWait(
  promise: Promise<unknown>,
  timeoutMs: number,
  keepAlive: boolean,
): Promise<void> {
  const timeout = Promise.withResolvers<void>();
  const timer = setTimeout(timeout.resolve, Math.max(0, timeoutMs));
  if (!keepAlive) timer.unref?.();
  return Promise.race([promise.then(noop, noop), timeout.promise]).finally(() =>
    clearTimeout(timer),
  );
}

function noop(): void {}

function nonNegative(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.round(value));
}

export class UpdateTelemetry {
  private readonly reporter: () => ErrorReporterLike;
  private readonly store: UpdateTelemetryStore;
  private readonly clock: () => number;
  private readonly eager: boolean;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: UpdateTelemetryOptions) {
    this.reporter = options.reporter ?? getErrorReporter;
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
    this.eager = options.eager ?? false;
  }

  /** `update_check_completed`; offline and skipped outcomes are rate-limited unless manual. */
  checkCompleted(event: UpdateCheckEvent): void {
    this.enqueue(async (reporter) => {
      const properties = {
        trigger: event.trigger,
        outcome: event.outcome,
        current_version: event.currentVersion,
        available_version: event.availableVersion,
        channel: event.channel,
        duration_ms: nonNegative(event.durationMs),
      };
      if (!isRateLimitedCheck(event.trigger, event.outcome)) {
        this.send(reporter, "update_check_completed", properties);
        return;
      }
      const decision = decideIntervalReport(await this.readState(), event.outcome, this.clock());
      if (decision.send) {
        this.send(reporter, "update_check_completed", {
          ...properties,
          suppressed_count: decision.suppressedCount,
        });
      }
      await this.store.write(decision.state);
    });
  }

  /** `update_deferred`: the first deferral per target, then at most hourly with the counts. */
  deferred(event: UpdateDeferredEvent): void {
    this.enqueue(async (reporter) => {
      const decision = decideDeferralReport(
        await this.readState(),
        event.targetVersion ?? null,
        this.clock(),
      );
      if (decision.send) {
        this.send(reporter, "update_deferred", {
          trigger: event.trigger,
          reason: event.reason,
          current_version: event.currentVersion,
          target_version: event.targetVersion,
          deferral_count: decision.deferralCount,
          deferred_for_ms: decision.deferredForMs,
        });
      }
      await this.store.write(decision.state);
    });
  }

  /** `update_installed` after the switch, restart and health gate succeeded. */
  installed(event: UpdateInstalledEvent): void {
    this.enqueue(async (reporter) => {
      const state = await this.readState();
      const deferralCount =
        state.deferral !== null && state.deferral.targetVersion === event.toVersion
          ? state.deferral.count
          : 0;
      const releasedAtMs =
        event.releaseDate === undefined ? Number.NaN : Date.parse(event.releaseDate);
      const publishToInstallMs = Number.isFinite(releasedAtMs)
        ? this.clock() - releasedAtMs
        : undefined;
      this.send(reporter, "update_installed", {
        trigger: event.trigger,
        from_version: event.fromVersion,
        to_version: event.toVersion,
        channel: event.channel,
        duration_ms: nonNegative(event.durationMs),
        publish_to_install_ms: nonNegative(publishToInstallMs),
        deferral_count: deferralCount,
      });
      if (state.deferral !== null) await this.store.write({ ...state, deferral: null });
    });
  }

  /** `update_failed`, plus a sanitized handled exception with failure class `update_failed`. */
  failed(event: UpdateFailedEvent): void {
    this.enqueue(async (reporter) => {
      const properties = {
        trigger: event.trigger,
        stage: event.stage,
        error_code: event.errorCode,
        from_version: event.fromVersion,
        target_version: event.targetVersion,
        channel: event.channel,
        rolled_back: event.rollback === "succeeded",
        rollback_outcome: event.rollback,
        quarantined: event.quarantined,
      } satisfies EventProperties;
      let state = await this.readState();
      let suppressedCount: number | undefined;
      if (event.rateLimited) {
        const decision = decideIntervalReport(state, `failed:${event.stage}`, this.clock());
        state = decision.state;
        if (!decision.send) {
          await this.store.write(state);
          return;
        }
        suppressedCount = decision.suppressedCount;
      }
      this.send(reporter, "update_failed", { ...properties, suppressed_count: suppressedCount });
      if (event.trackError !== false) {
        try {
          reporter.captureException(
            new UpdateFailedError(event.stage, event.errorCode, event.cause),
            {
              handled: true,
              level: "error",
              failureClass: "update_failed",
              errorCode: event.errorCode,
              properties,
            },
          );
        } catch {
          // Reporting never affects the update.
        }
      }
      // A failure ends the run of consecutive deferrals.
      if (state.deferral !== null || event.rateLimited) {
        await this.store.write({ ...state, deferral: null });
      }
    });
  }

  /** Maps one engine run to its events. */
  recordRun(result: UpdateEngineResult, context: UpdateRunContext): void {
    try {
      this.recordRunUnsafe(result, context);
    } catch {
      // Reporting never affects the update.
    }
  }

  /** An engine run that threw: `update_failed` at the stage the engine was in. */
  recordThrown(
    error: unknown,
    context: { readonly trigger: UpdateRunTrigger; readonly currentVersion?: string },
  ): void {
    try {
      const stage = updateFailureStageOf(error) ?? "preflight";
      this.failed({
        trigger: context.trigger,
        stage,
        errorCode: updateFailureCode(error, stage),
        fromVersion: context.currentVersion,
        rollback: "not_attempted",
        quarantined: false,
        cause: error,
      });
    } catch {
      // Reporting never affects the update.
    }
  }

  /** Waits (bounded) for queued bookkeeping so the events are in the reporter's queue. */
  async settled(timeoutMs: number = UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS): Promise<void> {
    await boundedWait(this.chain, timeoutMs, true);
  }

  /**
   * Settles queued events and flushes the reporter, all within `timeoutMs` (the reporter's own
   * exit bound). Resolves even when the reporter throws or never answers.
   */
  async flush(timeoutMs: number = UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.settled(timeoutMs);
    const remaining = Math.max(0, deadline - Date.now());
    let flushing: Promise<void>;
    try {
      flushing = Promise.resolve(this.reporter().flush(remaining));
    } catch {
      return;
    }
    await boundedWait(flushing, remaining, true);
  }

  private recordRunUnsafe(result: UpdateEngineResult, context: UpdateRunContext): void {
    const { trigger } = context;
    const failure = result.failure;
    if (context.explicitRollback) {
      if (failure) this.recordFailure(result, trigger);
      return;
    }
    if (context.reportCheck) this.recordManualCheck(result);
    switch (result.status) {
      case "activated":
        this.installed({
          trigger,
          fromVersion: result.currentVersion,
          toVersion: result.activeVersion,
          channel: result.channel,
          durationMs: this.clock() - context.startedAtMs,
          releaseDate: result.releaseDate,
        });
        return;
      case "activation-deferred":
      case "locked":
        this.deferred({
          trigger,
          reason:
            result.deferralCode ?? (result.status === "locked" ? "locked" : "activity_unknown"),
          currentVersion: result.currentVersion,
          targetVersion: result.pendingVersion ?? result.targetVersion,
        });
        return;
      case "offline":
        // Offline before the channel answered is only a check outcome; after it, the download
        // of a known update stalled.
        if (result.stepsCompleted.includes("signed_release_resolved")) {
          this.failed({
            trigger,
            stage: "download",
            errorCode: "offline",
            fromVersion: result.currentVersion,
            targetVersion: result.targetVersion,
            channel: result.channel,
            rollback: "not_attempted",
            quarantined: false,
            trackError: false,
          });
        }
        return;
      case "failed":
      case "rolled-back":
        if (failure && !(context.reportCheck && this.isCheckFailure(result))) {
          this.recordFailure(result, trigger);
        }
        return;
      default:
        return;
    }
  }

  private recordFailure(result: UpdateEngineResult, trigger: UpdateRunTrigger): void {
    const failure = result.failure;
    if (!failure) return;
    this.failed({
      trigger,
      stage: failure.stage,
      errorCode: failure.errorCode,
      fromVersion: result.currentVersion,
      targetVersion: result.targetVersion,
      channel: result.channel,
      rollback: failure.rollback,
      quarantined: result.quarantined === true,
      cause: failure.cause,
    });
  }

  /** A manual run that failed while fetching or authenticating the channel: a failed check. */
  private isCheckFailure(result: UpdateEngineResult): boolean {
    return (
      result.status === "failed" &&
      !result.stepsCompleted.includes("signed_release_resolved") &&
      (result.failure?.stage === "download" || result.failure?.stage === "verify")
    );
  }

  private recordManualCheck(result: UpdateEngineResult): void {
    const resolved = result.stepsCompleted.includes("signed_release_resolved");
    let outcome: UpdateCheckTelemetryOutcome | undefined;
    if (result.status === "already-current") outcome = "up_to_date";
    else if (result.status === "quarantined") outcome = "blocked_quarantine";
    else if (result.status === "downgrade-blocked") outcome = "blocked_downgrade";
    else if (result.status === "offline" && !resolved) outcome = "offline";
    else if (this.isCheckFailure(result)) outcome = "failed";
    else if (resolved) {
      outcome =
        result.targetVersion !== undefined && result.targetVersion !== result.currentVersion
          ? "update_available"
          : "up_to_date";
    }
    if (outcome === undefined) return;
    this.checkCompleted({
      trigger: "manual",
      outcome,
      currentVersion: result.currentVersion,
      availableVersion: result.targetVersion,
      channel: result.channel,
      durationMs: result.checkDurationMs,
    });
  }

  private enqueue(task: (reporter: ErrorReporterLike) => Promise<void>): void {
    let reporter: ErrorReporterLike;
    try {
      reporter = this.reporter();
      if (!reporter.isEnabled()) return;
    } catch {
      return;
    }
    this.chain = this.chain.then(() =>
      boundedWait(
        Promise.resolve().then(() => task(reporter)),
        UPDATE_TELEMETRY_TASK_TIMEOUT_MS,
        false,
      ),
    );
  }

  private async readState(): Promise<UpdateTelemetryState> {
    try {
      return (await this.store.read()) ?? createUpdateTelemetryState();
    } catch {
      return createUpdateTelemetryState();
    }
  }

  private send(reporter: ErrorReporterLike, event: string, properties: EventProperties): void {
    try {
      reporter.capture(event, properties);
    } catch {
      return;
    }
    if (!this.eager) return;
    try {
      void Promise.resolve(reporter.flush(UPDATE_TELEMETRY_FLUSH_TIMEOUT_MS)).catch(noop);
    } catch {
      // Reporting never affects the update.
    }
  }
}

export function createUpdateTelemetry(options: {
  readonly resinHome: string;
  readonly reporter?: () => ErrorReporterLike;
  readonly clock?: () => number;
  readonly eager?: boolean;
}): UpdateTelemetry {
  return new UpdateTelemetry({
    reporter: options.reporter,
    store: createFileUpdateTelemetryStore(options.resinHome),
    clock: options.clock,
    eager: options.eager,
  });
}
