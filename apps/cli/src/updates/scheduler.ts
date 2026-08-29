import {
  type PolicyValue,
  type UpdateMaintenanceWindow,
  type UpdatePolicy,
  type UpdatePolicyPatch,
  parseUpdatePolicy,
} from "./policy.js";

export type SchedulerTimerHandle = NodeJS.Timeout | number | { unref?: () => void };

export const INITIAL_OFFLINE_UPDATE_BACKOFF_MS = 60_000;
export const MAX_OFFLINE_UPDATE_BACKOFF_MS = 60 * 60_000;
export const OFFLINE_UPDATE_BACKOFF_JITTER_RATIO = 0.2;
export const MIN_UPDATE_SCHEDULER_DELAY_MS = 1_000;
export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 5 * 60_000;
export const MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS = 2_147_483_647;

export interface UpdateSchedulerState {
  readonly lastSuccessfulCheckAtMs: number | null;
  readonly offlineFailureCount: number;
  readonly offlineRetryAtMs: number | null;
}

export type UpdateSchedulerDecision =
  | {
      readonly kind: "disabled";
      readonly decidedAtMs: number;
      readonly wakeAtMs: null;
    }
  | {
      readonly kind: "check";
      readonly reason: "initial" | "interval" | "offline-retry";
      readonly decidedAtMs: number;
      readonly wakeAtMs: number;
    }
  | {
      readonly kind: "wait";
      readonly reason: "interval" | "offline-backoff" | "maintenance-window";
      readonly decidedAtMs: number;
      readonly wakeAtMs: number;
      readonly delayMs: number;
    };

export type UpdateCheckOutcome = "checked" | "offline";

export interface UpdateSchedulerCycleResult {
  readonly decision: UpdateSchedulerDecision;
  readonly outcome?: UpdateCheckOutcome;
  readonly error?: unknown;
  readonly state: UpdateSchedulerState;
  readonly nextDecision: UpdateSchedulerDecision;
}

export interface UpdateSchedulerOptions {
  readonly policy?: PolicyValue | undefined;
  readonly initialState?: UpdateSchedulerState;
  readonly onCheck: (
    decision: Extract<UpdateSchedulerDecision, { kind: "check" }>,
    signal: AbortSignal,
  ) => UpdateCheckOutcome | Promise<UpdateCheckOutcome>;
  readonly onDecision?: (decision: UpdateSchedulerDecision) => void;
  readonly onError?: (cause: unknown) => void;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => SchedulerTimerHandle;
  readonly cancelTimer?: (handle: SchedulerTimerHandle) => void;
  readonly minimumTimerDelayMs?: number;
  readonly checkTimeoutMs?: number;
}

export class UpdateCheckTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Update check did not settle within ${timeoutMs}ms`);
    this.name = "UpdateCheckTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

interface ZonedDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const formatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

function requireTimestamp(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite timestamp`);
  }
  return Math.trunc(value);
}

function normalizeSchedulerState(state: UpdateSchedulerState): UpdateSchedulerState {
  const lastSuccessfulCheckAtMs =
    state.lastSuccessfulCheckAtMs === null
      ? null
      : requireTimestamp(state.lastSuccessfulCheckAtMs, "Last successful update check");
  if (!Number.isSafeInteger(state.offlineFailureCount) || state.offlineFailureCount < 0) {
    throw new RangeError("Offline update failure count must be a non-negative safe integer");
  }
  const offlineRetryAtMs =
    state.offlineRetryAtMs === null
      ? null
      : requireTimestamp(state.offlineRetryAtMs, "Offline update retry");
  if (
    (state.offlineFailureCount === 0 && offlineRetryAtMs !== null) ||
    (state.offlineFailureCount > 0 && offlineRetryAtMs === null)
  ) {
    throw new TypeError("Offline update failure count and retry timestamp must be set together");
  }

  return {
    lastSuccessfulCheckAtMs,
    offlineFailureCount: state.offlineFailureCount,
    offlineRetryAtMs,
  };
}

function normalizeSchedulerStateForTime(
  stateInput: UpdateSchedulerState,
  now: number,
): UpdateSchedulerState {
  const state = normalizeSchedulerState(stateInput);
  const retryCeiling = Math.min(Number.MAX_SAFE_INTEGER, now + MAX_OFFLINE_UPDATE_BACKOFF_MS);
  return {
    lastSuccessfulCheckAtMs:
      state.lastSuccessfulCheckAtMs !== null && state.lastSuccessfulCheckAtMs > now
        ? now
        : state.lastSuccessfulCheckAtMs,
    offlineFailureCount: state.offlineFailureCount,
    offlineRetryAtMs:
      state.offlineRetryAtMs !== null && state.offlineRetryAtMs > retryCeiling
        ? retryCeiling
        : state.offlineRetryAtMs,
  };
}

export function createUpdateSchedulerState(): UpdateSchedulerState {
  return {
    lastSuccessfulCheckAtMs: null,
    offlineFailureCount: 0,
    offlineRetryAtMs: null,
  };
}

export function calculateOfflineUpdateBackoffMs(
  failureCount: number,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(failureCount) || failureCount < 1) {
    throw new RangeError("Offline update failure count must be a positive safe integer");
  }

  const exponent = Math.min(failureCount - 1, 30);
  const baseDelay = Math.min(
    INITIAL_OFFLINE_UPDATE_BACKOFF_MS * 2 ** exponent,
    MAX_OFFLINE_UPDATE_BACKOFF_MS,
  );
  const sample = random();
  if (!Number.isFinite(sample)) {
    throw new RangeError("Offline update jitter source must return a finite number");
  }

  const boundedSample = Math.min(1, Math.max(0, sample));
  const multiplier =
    1 -
    OFFLINE_UPDATE_BACKOFF_JITTER_RATIO +
    boundedSample * OFFLINE_UPDATE_BACKOFF_JITTER_RATIO * 2;
  return Math.min(MAX_OFFLINE_UPDATE_BACKOFF_MS, Math.round(baseDelay * multiplier));
}

function parseClockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function getZonedDateParts(timestampMs: number, timeZone: string): ZonedDateParts {
  if (timeZone === "UTC") {
    const date = new Date(timestampMs);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }

  let formatter = formatterByTimeZone.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterByTimeZone.set(timeZone, formatter);
  }

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(timestampMs)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new RangeError(`Unable to resolve calendar fields for time zone ${timeZone}`);
  }
  return { year, month, day, hour, minute };
}

function sameZonedDateTime(left: ZonedDateParts, right: ZonedDateParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function localDateTimeCandidates(parts: ZonedDateParts, timeZone: string): number[] {
  const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  if (timeZone === "UTC") {
    return [desiredAsUtc];
  }

  const offsets = new Set<number>();
  const sampleStepMs = 6 * 60 * MINUTE_MS;
  for (
    let sample = desiredAsUtc - 2 * DAY_MS;
    sample <= desiredAsUtc + 2 * DAY_MS;
    sample += sampleStepMs
  ) {
    const observed = getZonedDateParts(sample, timeZone);
    offsets.add(
      Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute) -
        sample,
    );
  }

  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = desiredAsUtc - offset;
    if (sameZonedDateTime(getZonedDateParts(candidate, timeZone), parts)) {
      candidates.add(candidate);
    }
  }
  return [...candidates].sort((left, right) => left - right);
}

function instantBelongsToWindowStartingOnDate(
  timestampMs: number,
  startDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  window: UpdateMaintenanceWindow,
): boolean {
  const parts = getZonedDateParts(timestampMs, window.timeZone ?? "UTC");
  const currentDateAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const startDateAsUtc = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
  const currentMinute = parts.hour * 60 + parts.minute;
  const startMinute = parseClockMinutes(window.start);
  const endMinute = parseClockMinutes(window.end);
  if (startMinute < endMinute) {
    return (
      currentDateAsUtc === startDateAsUtc &&
      currentMinute >= startMinute &&
      currentMinute < endMinute
    );
  }
  return (
    (currentDateAsUtc === startDateAsUtc && currentMinute >= startMinute) ||
    (currentDateAsUtc === startDateAsUtc + DAY_MS && currentMinute < endMinute)
  );
}

function earliestValidWindowInstantForDate(
  timestampMs: number,
  startDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  window: UpdateMaintenanceWindow,
): number | null {
  const startDateAsUtc = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
  const firstCandidateAfterTimestamp = Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (
    let candidate = Math.max(startDateAsUtc - DAY_MS, firstCandidateAfterTimestamp);
    candidate <= startDateAsUtc + 2 * DAY_MS;
    candidate += MINUTE_MS
  ) {
    if (instantBelongsToWindowStartingOnDate(candidate, startDate, window)) {
      return candidate;
    }
  }
  return null;
}

function isWithinWindow(timestampMs: number, window: UpdateMaintenanceWindow): boolean {
  const timeZone = window.timeZone ?? "UTC";
  const parts = getZonedDateParts(timestampMs, timeZone);
  const currentMinute = parts.hour * 60 + parts.minute;
  const startMinute = parseClockMinutes(window.start);
  const endMinute = parseClockMinutes(window.end);

  if (startMinute < endMinute) {
    return currentMinute >= startMinute && currentMinute < endMinute;
  }
  return currentMinute >= startMinute || currentMinute < endMinute;
}

function nextWindowStart(timestampMs: number, window: UpdateMaintenanceWindow): number {
  if (isWithinWindow(timestampMs, window)) {
    return timestampMs;
  }

  const timeZone = window.timeZone ?? "UTC";
  const currentDate = getZonedDateParts(timestampMs, timeZone);
  const startMinute = parseClockMinutes(window.start);
  const startHour = Math.floor(startMinute / 60);
  const startMinuteWithinHour = startMinute % 60;

  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const shiftedDate = new Date(
      Date.UTC(currentDate.year, currentDate.month - 1, currentDate.day) + dayOffset * DAY_MS,
    );
    const desired = {
      year: shiftedDate.getUTCFullYear(),
      month: shiftedDate.getUTCMonth() + 1,
      day: shiftedDate.getUTCDate(),
      hour: startHour,
      minute: startMinuteWithinHour,
    };
    const matchingCandidates = localDateTimeCandidates(desired, timeZone);
    const matchingCandidate = matchingCandidates.find((candidate) => candidate > timestampMs);
    if (matchingCandidate !== undefined) {
      return matchingCandidate;
    }
    const nextValid = earliestValidWindowInstantForDate(timestampMs, desired, window);
    if (nextValid !== null) {
      return nextValid;
    }
  }

  throw new RangeError("Unable to find the next update maintenance window");
}

export function isWithinUpdateMaintenanceWindow(
  timestampMs: number,
  window: UpdateMaintenanceWindow,
): boolean {
  const parsed = parseUpdatePolicy({ maintenanceWindow: window }).maintenanceWindow;
  if (parsed === null) {
    return true;
  }
  return isWithinWindow(requireTimestamp(timestampMs, "Maintenance window timestamp"), parsed);
}

export function getNextUpdateMaintenanceWindowStart(
  timestampMs: number,
  window: UpdateMaintenanceWindow,
): number {
  const parsed = parseUpdatePolicy({ maintenanceWindow: window }).maintenanceWindow;
  if (parsed === null) {
    return requireTimestamp(timestampMs, "Maintenance window timestamp");
  }
  return nextWindowStart(requireTimestamp(timestampMs, "Maintenance window timestamp"), parsed);
}

export function recordSuccessfulUpdateCheck(
  state: UpdateSchedulerState,
  completedAtMs: number,
): UpdateSchedulerState {
  normalizeSchedulerState(state);
  return {
    lastSuccessfulCheckAtMs: requireTimestamp(completedAtMs, "Successful update check"),
    offlineFailureCount: 0,
    offlineRetryAtMs: null,
  };
}

export function recordOfflineUpdateCheck(
  state: UpdateSchedulerState,
  failedAtMs: number,
  random: () => number = Math.random,
): UpdateSchedulerState {
  const current = normalizeSchedulerState(state);
  const failureCount = Math.min(Number.MAX_SAFE_INTEGER, current.offlineFailureCount + 1);
  const failureTime = requireTimestamp(failedAtMs, "Offline update check");
  const retryAtMs = failureTime + calculateOfflineUpdateBackoffMs(failureCount, random);
  if (!Number.isSafeInteger(retryAtMs)) {
    throw new RangeError("Offline update retry exceeds the safe timestamp range");
  }

  return {
    lastSuccessfulCheckAtMs: current.lastSuccessfulCheckAtMs,
    offlineFailureCount: failureCount,
    offlineRetryAtMs: retryAtMs,
  };
}

export function decideUpdateSchedule(
  policyInput: UpdatePolicy | UpdatePolicyPatch | null | undefined,
  stateInput: UpdateSchedulerState,
  timestampMs: number = Date.now(),
): UpdateSchedulerDecision {
  const policy = parseUpdatePolicy(policyInput);
  const now = requireTimestamp(timestampMs, "Update scheduler timestamp");
  const state = normalizeSchedulerStateForTime(stateInput, now);

  if (!policy.autoUpdate) {
    return { kind: "disabled", decidedAtMs: now, wakeAtMs: null };
  }

  const intervalDueAtMs =
    state.lastSuccessfulCheckAtMs === null
      ? now
      : state.lastSuccessfulCheckAtMs + policy.checkIntervalMinutes * MINUTE_MS;
  if (!Number.isSafeInteger(intervalDueAtMs)) {
    throw new RangeError("Next update interval exceeds the safe timestamp range");
  }

  const retryAtMs = state.offlineRetryAtMs;
  const candidateAtMs = Math.max(intervalDueAtMs, retryAtMs ?? 0);
  let wakeAtMs = candidateAtMs;
  if (policy.maintenanceWindow !== null) {
    const windowCandidateAtMs = Math.max(candidateAtMs, now);
    wakeAtMs = isWithinWindow(windowCandidateAtMs, policy.maintenanceWindow)
      ? windowCandidateAtMs
      : nextWindowStart(windowCandidateAtMs, policy.maintenanceWindow);
  }

  if (wakeAtMs <= now) {
    const reason =
      state.offlineFailureCount > 0
        ? "offline-retry"
        : state.lastSuccessfulCheckAtMs === null
          ? "initial"
          : "interval";
    return { kind: "check", reason, decidedAtMs: now, wakeAtMs: now };
  }

  const reason =
    wakeAtMs > candidateAtMs
      ? "maintenance-window"
      : retryAtMs !== null && retryAtMs >= intervalDueAtMs
        ? "offline-backoff"
        : "interval";
  return {
    kind: "wait",
    reason,
    decidedAtMs: now,
    wakeAtMs,
    delayMs: wakeAtMs - now,
  };
}

function defaultScheduleTimer(callback: () => void, delayMs: number): SchedulerTimerHandle {
  return setTimeout(callback, delayMs);
}

function defaultCancelTimer(handle: SchedulerTimerHandle): void {
  // SAFETY: Node/browser clearTimeout accepts timeout handles and numeric timer ids.
  clearTimeout(handle as NodeJS.Timeout);
}

class SchedulerCycleCancelledError extends Error {
  constructor() {
    super("Update scheduler cycle was cancelled");
    this.name = "SchedulerCycleCancelledError";
  }
}

export class UpdateScheduler {
  private currentPolicy: UpdatePolicy;
  private currentState: UpdateSchedulerState;
  private readonly onCheck: UpdateSchedulerOptions["onCheck"];
  private readonly onDecision?: UpdateSchedulerOptions["onDecision"];
  private readonly onError?: UpdateSchedulerOptions["onError"];
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly scheduleTimer: NonNullable<UpdateSchedulerOptions["scheduleTimer"]>;
  private readonly cancelTimer: NonNullable<UpdateSchedulerOptions["cancelTimer"]>;
  private readonly minimumTimerDelayMs: number;
  private readonly checkTimeoutMs: number;
  private timerHandle: SchedulerTimerHandle | undefined;
  private timerGeneration = 0;
  private lifecycleGeneration = 0;
  private started = false;
  private driving = false;
  private cyclePromise: Promise<UpdateSchedulerCycleResult> | null = null;
  private activeCheckController: AbortController | null = null;

  constructor(options: UpdateSchedulerOptions) {
    this.currentPolicy = parseUpdatePolicy(options.policy);
    this.currentState = normalizeSchedulerState(
      options.initialState ?? createUpdateSchedulerState(),
    );
    this.onCheck = options.onCheck;
    this.onDecision = options.onDecision;
    this.onError = options.onError;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.cancelTimer = options.cancelTimer ?? defaultCancelTimer;
    this.minimumTimerDelayMs = options.minimumTimerDelayMs ?? MIN_UPDATE_SCHEDULER_DELAY_MS;
    if (
      !Number.isSafeInteger(this.minimumTimerDelayMs) ||
      this.minimumTimerDelayMs < 1 ||
      this.minimumTimerDelayMs > MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        `Minimum update scheduler timer delay must be a whole number from 1 through ${MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS}`,
      );
    }
    this.checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.checkTimeoutMs) ||
      this.checkTimeoutMs < 1 ||
      this.checkTimeoutMs > MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        `Update check timeout must be a whole number from 1 through ${MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS}`,
      );
    }
  }

  get policy(): UpdatePolicy {
    return parseUpdatePolicy(this.currentPolicy);
  }

  get state(): UpdateSchedulerState {
    return { ...this.currentState };
  }

  get isRunning(): boolean {
    return this.started;
  }

  decide(timestampMs: number = getSchedulerTime(this.clock)): UpdateSchedulerDecision {
    const now = requireTimestamp(timestampMs, "Update scheduler timestamp");
    this.currentState = normalizeSchedulerStateForTime(this.currentState, now);
    return decideUpdateSchedule(this.currentPolicy, this.currentState, now);
  }

  updatePolicy(policy: UpdatePolicy | UpdatePolicyPatch | null | undefined): UpdatePolicy {
    this.currentPolicy = parseUpdatePolicy(policy);
    if (this.started) {
      try {
        this.cancelScheduledCycle();
        this.drive();
      } catch (error: unknown) {
        this.failScheduler(error);
      }
    }
    return this.policy;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.lifecycleGeneration += 1;
    try {
      this.drive();
    } catch (error: unknown) {
      this.failScheduler(error);
    }
  }

  stop(): void {
    this.started = false;
    this.lifecycleGeneration += 1;
    this.activeCheckController?.abort(new SchedulerCycleCancelledError());
    try {
      this.cancelScheduledCycle();
    } catch (error: unknown) {
      this.notifyError(error);
    }
  }

  runOnce(): Promise<UpdateSchedulerCycleResult> {
    if (this.cyclePromise) {
      return this.cyclePromise;
    }

    const execution = this.executeOnce();
    this.cyclePromise = execution;
    execution.then(
      () => {
        if (this.cyclePromise === execution) {
          this.cyclePromise = null;
        }
      },
      () => {
        if (this.cyclePromise === execution) {
          this.cyclePromise = null;
        }
      },
    );
    return execution;
  }

  private notifyDecision(decision: UpdateSchedulerDecision): void {
    try {
      this.onDecision?.(decision);
    } catch (error: unknown) {
      this.notifyError(error);
    }
  }

  private notifyError(cause: unknown): void {
    try {
      this.onError?.(cause);
    } catch {
      // Error reporting must not create a scheduler loop.
    }
  }

  private async runCheck(
    decision: Extract<UpdateSchedulerDecision, { kind: "check" }>,
  ): Promise<UpdateCheckOutcome> {
    const controller = new AbortController();
    const { signal } = controller;
    this.activeCheckController = controller;
    const timeoutError = new UpdateCheckTimeoutError(this.checkTimeoutMs);
    let rejectCancellation: ((error: Error) => void) | null = null;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = (): void => {
      rejectCancellation?.(signal.reason ?? new SchedulerCycleCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError);
    }, this.checkTimeoutMs);
    timeoutHandle.unref();

    try {
      const check = Promise.resolve().then(() => this.onCheck(decision, signal));
      return await Promise.race([check, cancellation]);
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      if (this.activeCheckController === controller) {
        this.activeCheckController = null;
      }
    }
  }

  private async executeOnce(): Promise<UpdateSchedulerCycleResult> {
    const decision = this.decide();
    this.notifyDecision(decision);
    if (decision.kind !== "check") {
      return {
        decision,
        state: this.state,
        nextDecision: decision,
      };
    }

    let outcome: UpdateCheckOutcome;
    let callbackError: unknown;
    try {
      outcome = await this.runCheck(decision);
      if (outcome !== "checked" && outcome !== "offline") {
        throw new TypeError('Update check callback must return "checked" or "offline"');
      }
    } catch (error: unknown) {
      if (error instanceof SchedulerCycleCancelledError) {
        throw error;
      }
      callbackError = error;
      outcome = "offline";
      this.notifyError(error);
    }

    const completedAtMs = getSchedulerTime(this.clock);
    this.currentState = normalizeSchedulerStateForTime(this.currentState, completedAtMs);
    this.currentState =
      outcome === "checked"
        ? recordSuccessfulUpdateCheck(this.currentState, completedAtMs)
        : recordOfflineUpdateCheck(this.currentState, completedAtMs, this.random);
    const nextDecision = this.decide(completedAtMs);
    this.notifyDecision(nextDecision);

    const cycleResult: UpdateSchedulerCycleResult =
      callbackError !== undefined
        ? {
            decision,
            outcome,
            error: callbackError,
            state: this.state,
            nextDecision,
          }
        : {
            decision,
            outcome,
            state: this.state,
            nextDecision,
          };
    return cycleResult;
  }

  private drive(): void {
    if (!this.started || this.driving) {
      return;
    }
    this.driving = true;
    const generation = this.lifecycleGeneration;
    this.runOnce().then(
      (result) => {
        this.driving = false;
        if (generation !== this.lifecycleGeneration) {
          if (this.started) {
            this.drive();
          }
          return;
        }
        if (!this.started) {
          return;
        }
        try {
          this.scheduleNextCycle(result.nextDecision);
        } catch (error: unknown) {
          this.failScheduler(error);
        }
      },
      (cause: unknown) => {
        this.driving = false;
        if (
          cause instanceof SchedulerCycleCancelledError &&
          generation !== this.lifecycleGeneration
        ) {
          if (this.started) {
            this.drive();
          }
          return;
        }
        this.failScheduler(cause);
      },
    );
  }

  private failScheduler(cause: unknown): void {
    this.started = false;
    this.lifecycleGeneration += 1;
    this.activeCheckController?.abort(new SchedulerCycleCancelledError());
    try {
      this.cancelScheduledCycle();
    } catch (cancelError: unknown) {
      this.notifyError(cancelError);
    }
    this.notifyError(cause);
  }

  private scheduleNextCycle(decision: UpdateSchedulerDecision): void {
    this.cancelScheduledCycle();
    if (!this.started || decision.kind === "disabled") {
      return;
    }

    const now = getSchedulerTime(this.clock);
    const requestedDelayMs =
      now < decision.decidedAtMs ? 0 : decision.kind === "wait" ? decision.wakeAtMs - now : 0;
    const delayMs = Math.min(
      MAX_UPDATE_SCHEDULER_TIMER_DELAY_MS,
      Math.max(this.minimumTimerDelayMs, requestedDelayMs),
    );
    const generation = this.timerGeneration;
    const handle = this.scheduleTimer(() => {
      if (!this.started || generation !== this.timerGeneration) {
        return;
      }
      this.timerHandle = undefined;
      try {
        this.drive();
      } catch (error: unknown) {
        this.failScheduler(error);
      }
    }, delayMs);
    this.timerHandle = handle;

    if (handle instanceof Object && "unref" in handle && handle.unref instanceof Function) {
      handle.unref();
    }
  }

  private cancelScheduledCycle(): void {
    this.timerGeneration += 1;
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    if (handle !== undefined) {
      this.cancelTimer(handle);
    }
  }
}

function getSchedulerTime(clock: () => number): number {
  return requireTimestamp(clock(), "Update scheduler clock");
}
