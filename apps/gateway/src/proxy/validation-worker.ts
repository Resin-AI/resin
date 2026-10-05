/**
 * The gateway's half of a recorded workflow's validation: answering an ask the cloud cannot answer
 * itself.
 *
 * A recording's values, and the environment its steps run in, never leave the machine that made
 * them, so deciding whether its proposals hold is a local service (`workflow-validation.ts`). What
 * is missing without this file is the wiring that lets a cloud-issued ask reach that service: a
 * client that speaks to the validation routes on the authenticated connection, and a worker that
 * takes each pending ask, substantiates it against this identity, checks it against this device's
 * own recording, and posts the decision back.
 *
 * Nothing here decides what a proposal means — the recording check does. An ask this worker cannot
 * substantiate is left unanswered rather than answered with a guess, and an answer the cloud
 * declines is reported and never retried forever: the ask is the cloud's to re-issue.
 */

import os from "node:os";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowValidationDecision,
  type WorkflowValidationRequest,
  WorkflowValidationRequestSchema,
  type WorkflowValidationVerdict,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import {
  type CloudRequestIdentity,
  FilePrivateValueStore,
  type LocalCallIdentity,
  LocalSessionDiscoveryUnavailableError,
  type PrivateValueStore,
  createLocalCallIdentity,
} from "@resin/observer";
import { DEVICE_SYNC_SAFETY_REFRESH_MS, PROTOCOL_VERSION } from "@resin/protocol";
import { z } from "zod";
import type { FileValidationAskLedger } from "./validation-ask-ledger.js";
import type {
  WorkflowValidationPassLease,
  WorkflowValidationPassLeaseHandle,
} from "./validation-lease.js";
import { WORKFLOW_CAPABILITIES, WORKFLOW_CAPABILITIES_HEADER } from "./workflow-capabilities.js";
import {
  type LocalWorkflowValidationResult,
  createRecordingCheckValidator,
  planRecordedHere,
} from "./workflow-validation.js";

/** Where an ask is listed from, and where its answer is delivered. */
const PENDING_ROUTE = "/v1/evolution/workflow-validation/pending";
const DECISIONS_ROUTE = "/v1/evolution/workflow-validation/decisions";
const MAX_RESPONSE_BYTES = 512 * 1024;
/**
 * The poll cadence, which adapts the way the control plane's does (`@resin/protocol`
 * `CONTROL_PLANE_*`). Asks arrive in bursts, after the cloud finds a workflow in freshly uploaded
 * observations, and then none arrive for hours, so a fixed 15 s poll cost an idle device about 5,200
 * cloud calls a day. The worker polls every 15 s while asks keep arriving. After three consecutive
 * empty polls it doubles the interval on each further empty poll (30 s, then 60 s) until it reaches
 * the quiet 120 s. A non-empty poll or a local wake puts it straight back on 15 s. Jitter only ever
 * lengthens an interval, by up to 20%, so a fleet does not wake in lockstep. An ask lives for days,
 * so at the quiet cadence an answer is delayed by at most about 2.4 minutes.
 */
export const DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_WORKFLOW_VALIDATION_QUIET_POLL_INTERVAL_MS = 120_000;
export const WORKFLOW_VALIDATION_QUIET_POLL_THRESHOLD = 3;
export const WORKFLOW_VALIDATION_POLL_BACKOFF_FACTOR = 2;
export const DEFAULT_WORKFLOW_VALIDATION_POLL_JITTER_RATIO = 0.2;
/**
 * A check that outlives this bound is refused rather than allowed to run on forever. Recorded steps
 * are answered from the recording; the bound is for sandboxed derivation steps.
 */
export const DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS = 120_000;
/** No caller may hand the worker a check bound beyond this. */
export const MAX_WORKFLOW_VALIDATION_TIMEOUT_MS = 120_000;
/** Identity the decision names for the device whose recording the plan was checked against. */
export const DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT = `resin-gateway-recording:${os.hostname()}`;

/**
 * The outcomes the decision route reports.
 *
 * `recorded` and `duplicate` are the only successes: the cloud holds one decision for the attempt,
 * either the one just delivered or an identical earlier delivery. Everything else is a refusal the
 * worker reports and does not retry — the ask, not the answer, is what has to change. `unknown`
 * covers any answer this client cannot place.
 */
export type WorkflowValidationSubmitStatus =
  | "recorded"
  | "duplicate"
  | "conflict"
  | "stale"
  | "mismatched_attempt"
  | "mismatched_plan"
  | "mismatched_evidence"
  | "mismatched_device"
  | "rejected"
  | "unknown";

/** The statuses above, as the membership table the reply parser reads. */
const SUBMIT_STATUSES: Record<string, true> = {
  recorded: true,
  duplicate: true,
  conflict: true,
  stale: true,
  mismatched_attempt: true,
  mismatched_plan: true,
  mismatched_evidence: true,
  mismatched_device: true,
  rejected: true,
  unknown: true,
};

export interface WorkflowValidationSubmitResult {
  status: WorkflowValidationSubmitStatus;
  requestId?: string;
  reason?: string;
}

export interface WorkflowValidationClientOptions {
  identityProvider: (options?: {
    forceRefresh?: boolean;
  }) => Promise<CloudRequestIdentity | null>;
  fetchImpl?: typeof fetch;
}

export class WorkflowValidationClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WorkflowValidationClientError";
  }
}

/** The asks addressed to one installation's device. */
export interface WorkflowValidationTransport {
  listPending(deviceId: string, signal?: AbortSignal): Promise<WorkflowValidationRequest[]>;
  submitDecision(
    decision: WorkflowValidationDecision,
    signal?: AbortSignal,
  ): Promise<WorkflowValidationSubmitResult>;
}

const PendingEnvelopeSchema = z.object({ requests: z.array(z.unknown()) });
const DecisionReplySchema = z.object({
  status: z.string().optional(),
  requestId: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

type WorkflowValidationDecisionReply = z.infer<typeof DecisionReplySchema>;

/**
 * The JSON a reply carries, when it carries one. A body that is not JSON is a protocol failure, not
 * an empty answer: the caller must know that what it received was not the shape both sides agreed.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new WorkflowValidationClientError(
      "Cloud workflow-validation response exceeded the size limit",
      502,
    );
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkflowValidationClientError(
      "Cloud workflow-validation response was not valid JSON",
      502,
    );
  }
}

function replyResult(
  reply: WorkflowValidationDecisionReply | null,
  fallback: WorkflowValidationSubmitStatus,
): WorkflowValidationSubmitResult {
  const status =
    reply?.status !== undefined && Object.hasOwn(SUBMIT_STATUSES, reply.status)
      ? (reply.status as WorkflowValidationSubmitStatus)
      : fallback;
  const reason = reply?.reason ?? reply?.error;
  return {
    status,
    ...(reply?.requestId === undefined ? {} : { requestId: reply.requestId }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The validation routes on the authenticated cloud connection.
 *
 * The identity tuple is the one every other daemon route sends, so the cloud can attribute an ask
 * and its answer to the same account, workspace, device and installation. A single forced refresh
 * is attempted when the stored credentials are refused: an access token that expired while the
 * worker was idle must not stall validation until the next process start.
 */
export class WorkflowValidationClient implements WorkflowValidationTransport {
  private readonly identityProvider: WorkflowValidationClientOptions["identityProvider"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkflowValidationClientOptions) {
    this.identityProvider = options.identityProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(route: string, init: RequestInit, forceRefresh = false): Promise<Response> {
    const identity = await this.identityProvider(forceRefresh ? { forceRefresh: true } : undefined);
    if (!identity) throw new WorkflowValidationClientError("Cloud credentials are unavailable");
    const response = await this.fetchImpl(`${identity.cloudUrl.replace(/\/$/, "")}${route}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${identity.accessToken}`,
        "x-account-id": identity.accountId,
        "x-workspace-id": identity.workspaceId,
        "x-device-id": identity.deviceId,
        "x-installation-id": identity.installationId,
        "x-protocol-version": PROTOCOL_VERSION,
        [WORKFLOW_CAPABILITIES_HEADER]: WORKFLOW_CAPABILITIES,
        ...init.headers,
      },
    });
    // Only an unauthenticated (401) answer can be cured by a new access token; a 403 is an
    // authorization decision that rotating the refresh token cannot change.
    if (!forceRefresh && response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return await this.request(route, init, true);
    }
    return response;
  }

  /**
   * The asks pending for this device.
   *
   * An entry that is not a well-formed request cannot be checked and is left out — it is not
   * answerable, and answering it from a guessed shape would decide a plan nobody asked about.
   */
  async listPending(deviceId: string, signal?: AbortSignal): Promise<WorkflowValidationRequest[]> {
    const response = await this.request(
      `${PENDING_ROUTE}?deviceId=${encodeURIComponent(deviceId)}`,
      { method: "GET", signal },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new WorkflowValidationClientError(
        `Cloud workflow-validation read failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const envelope = PendingEnvelopeSchema.safeParse(await readJson(response));
    if (!envelope.success) {
      throw new WorkflowValidationClientError(
        "Cloud workflow-validation response failed schema validation",
        502,
      );
    }
    const requests: WorkflowValidationRequest[] = [];
    for (const entry of envelope.data.requests) {
      const request = WorkflowValidationRequestSchema.safeParse(entry);
      if (request.success) requests.push(request.data as unknown as WorkflowValidationRequest);
    }
    return requests;
  }

  /**
   * Delivers one decision.
   *
   * The route's non-success answers are protocol outcomes, not transport failures: a decision the
   * cloud declined must be reported as declined, never retried as if it had never arrived.
   */
  async submitDecision(
    decision: WorkflowValidationDecision,
    signal?: AbortSignal,
  ): Promise<WorkflowValidationSubmitResult> {
    const response = await this.request(DECISIONS_ROUTE, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const parsed = DecisionReplySchema.safeParse(await readJson(response));
    const reply = parsed.success ? parsed.data : null;
    if (response.status === 200) {
      if (reply?.status === undefined) {
        throw new WorkflowValidationClientError(
          "Cloud workflow-validation decision reply carried no outcome",
          502,
        );
      }
      return replyResult(reply, "unknown");
    }
    if (response.status === 404) return replyResult(reply, "unknown");
    if (response.status === 409) return replyResult(reply, "conflict");
    if (response.status === 410) return replyResult(reply, "stale");
    // A delivery the route could not even read is declined, not deferred: the same bytes will not
    // be read any better on the next pass, and repeating them would only repeat the refusal.
    if (response.status === 400) return replyResult(reply, "rejected");
    throw new WorkflowValidationClientError(
      `Cloud workflow-validation decision failed with HTTP ${response.status}`,
      response.status,
    );
  }
}

/** What one pass over the pending asks did, for tests and for the caller's own reporting. */
export interface WorkflowValidationPassSummary {
  /** Asks the cloud listed for this device. */
  pending: number;
  /** Decisions the cloud recorded, or recognized as an identical re-delivery. */
  answered: number;
  /** Asks the worker will not answer yet: another workspace, a mismatched plan, or no session discovery. */
  refused: number;

  /** Decisions the cloud declined (conflict, stale, mismatched); reported, never retried here. */
  rejected: number;
  /** Asks left for the next pass because a transport call failed. */
  deferred: number;
  /** True when another process on this device held the pass lease, so nothing was listed. */
  skipped: boolean;
}

/** Checks one plan; the validator `workflow-validation.ts` builds, or a test's stand-in. */
export type WorkflowPlanValidator = (
  plan: RecordedWorkflow,
) => Promise<LocalWorkflowValidationResult>;

export interface WorkflowValidationWorkerOptions {
  client: WorkflowValidationTransport;
  /**
   * The identity the worker answers as. An ask for another workspace is refused: a decision is
   * only ever accepted on the authenticated connection that also matches the workspace it names.
   */
  identity: { workspaceId: string; deviceId: string };
  /**
   * Builds the validator one ask is checked with. Defaults to `createRecordingCheckValidator` with
   * this worker's store, recorded-call identity and bound; a test may substitute one that answers
   * deterministically.
   */
  createValidator?: (request: WorkflowValidationRequest) => WorkflowPlanValidator;
  /** Store the recording is read from; the same one the artifact executor uses. */
  privateValues?: PrivateValueStore;
  /** Reads this device's recorded calls; defaults to discovery over the local harness sessions. */
  localCalls?: LocalCallIdentity;
  /** Identity the decision reports for the validation environment. */
  environmentIdentity?: string;
  /** Wall-clock bound for one check; a caller's value is clamped, never unbounded. */
  timeoutMs?: number;
  /** Time between passes while asks are arriving; defaults to 15s. */
  pollIntervalMs?: number;
  /**
   * Time between passes once the cadence has backed off after empty polls; defaults to 120s and is
   * never shorter than `pollIntervalMs`.
   */
  quietPollIntervalMs?: number;
  /** Fraction of the interval each delay is lengthened by, at most; defaults to 0.2. */
  pollJitterRatio?: number;
  now?: () => Date;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
  /**
   * Where the worker reports what it could not answer and what the cloud declined. The gateway is
   * a library, so the sink is the caller's: a daemon writes it to its stderr, a test records it.
   */
  log?: (message: string) => void;
  /**
   * Device-wide owner of a pass, shared by the daemon and every gateway on the device. A worker
   * that cannot take it skips the pass, so no two processes check and deliver the same ask.
   */
  passLease?: WorkflowValidationPassLease;
  /**
   * Bounds how often one recorded call is checked and keeps the local audit of every check. The
   * daemon and gateway pass the owner-only ledger under the Resin state directory.
   */
  askLedger?: Pick<FileValidationAskLedger, "admit">;
  /**
   * True while the device's consolidated sync is following this device's pending-ask token and
   * runs a pass (`runOnce`) whenever it changes. The timer then lists asks only to retry what the
   * last pass left undecided or undelivered, or once `DEVICE_SYNC_SAFETY_REFRESH_MS` has passed
   * since the last listing; otherwise it keeps its own adaptive polling, exactly as without it.
   */
  followsDeviceSync?: () => boolean | Promise<boolean>;
}

/** How long an ask without an expiry stays remembered as another device's to answer. */
const SKIPPED_ASK_RETENTION_MS = 60 * 60 * 1000;
/**
 * How soon a skipped ask is checked again: its recording may still be arriving on this device (or
 * this is the workspace's only device), so a skip is a short backoff, never a verdict.
 */
const SKIPPED_ASK_RECHECK_MS = 2 * 60 * 1000;
/** How long an ask refused because the check ledger was unavailable waits before trying again. */
const LEDGER_UNAVAILABLE_RETRY_MS = 5 * 60 * 1000;

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS;
  }
  return Math.min(value, MAX_WORKFLOW_VALIDATION_TIMEOUT_MS);
}

function boundedInterval(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** Identifies one delivery of an ask, so a re-listed ask can be told apart from a new one. */
function askKey(request: WorkflowValidationRequest): string {
  return `${request.requestId}\u0000${request.attempt}`;
}

function boundedJitter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WORKFLOW_VALIDATION_POLL_JITTER_RATIO;
  }
  return Math.min(value, 1);
}

/**
 * Answers the cloud's pending validation asks from the machine the recording was made on.
 *
 * A pass is the unit of work: list the pending asks, decide each one, deliver each decision. One
 * pass runs at a time, so two timers firing close together cannot check the same plan twice, and
 * a pass that takes longer than the interval delays the next one instead of overlapping it.
 *
 * The timer's cadence adapts (see `DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS`). A pass counts
 * as empty when it lists no ask, or only asks the previous pass already refused or saw declined:
 * those stay pending until they expire, and re-listing them is not a sign that more are coming.
 */
export class WorkflowValidationWorker {
  private readonly client: WorkflowValidationTransport;
  private readonly workspaceId: string;
  private readonly deviceId: string;
  private readonly createValidator?: WorkflowValidationWorkerOptions["createValidator"];
  private readonly privateValues?: PrivateValueStore;
  private readonly localCalls?: LocalCallIdentity;
  private readonly environmentIdentity: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly quietPollIntervalMs: number;
  private readonly pollJitterRatio: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly passLease?: WorkflowValidationPassLease;
  private readonly askLedger?: Pick<FileValidationAskLedger, "admit">;
  private readonly followsDeviceSync?: () => boolean | Promise<boolean>;
  /** When asks were last listed successfully, in `Date.now()` time. */
  private lastListedAt = Number.NEGATIVE_INFINITY;
  /** The last pass left asks this device must retry locally (deferred or not yet decidable). */
  private localRetryPending = false;
  /** When the worker last started; the device sync safety refresh counts from here at the latest. */
  private startedAt = Number.NEGATIVE_INFINITY;
  /** The timer's device sync check in flight, which stop() waits for. */
  private followCheck?: Promise<boolean>;
  /** Advanced by every start and stop; fences fresh passes queued before a stop. */
  private generation = 0;
  private timer?: NodeJS.Timeout;
  /** When the armed timer fires, in `Date.now()` time; lets a wake pull it earlier. */
  private timerDueAt?: number;
  private abortController?: AbortController;
  private inFlight?: Promise<WorkflowValidationPassSummary>;
  /** Consecutive empty passes; the cadence backs off once this reaches the quiet threshold. */
  private emptyPolls = 0;
  /** Asks the last pass listed but left undecided or saw declined, keyed by `askKey`. */
  private settledAsks = new Set<string>();
  /** Asks this device did not record, by `askKey`, with when to stop remembering them. */
  private readonly skippedAsks = new Map<string, { until: number; recheckAt: number }>();

  constructor(options: WorkflowValidationWorkerOptions) {
    this.client = options.client;
    this.workspaceId = options.identity.workspaceId;
    this.deviceId = options.identity.deviceId;
    this.createValidator = options.createValidator;
    this.privateValues = options.privateValues;
    this.localCalls = options.localCalls;
    this.environmentIdentity =
      options.environmentIdentity ?? DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
    this.pollIntervalMs = boundedInterval(
      options.pollIntervalMs,
      DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS,
    );
    this.quietPollIntervalMs = Math.max(
      this.pollIntervalMs,
      boundedInterval(
        options.quietPollIntervalMs,
        DEFAULT_WORKFLOW_VALIDATION_QUIET_POLL_INTERVAL_MS,
      ),
    );
    this.pollJitterRatio = boundedJitter(options.pollJitterRatio);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
    this.passLease = options.passLease;
    this.askLedger = options.askLedger;
    this.followsDeviceSync = options.followsDeviceSync;
  }

  /** Arms the poll, on the fast cadence. Passes never hold the process open: the timer is unref'd. */
  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    this.generation += 1;
    this.emptyPolls = 0;
    // While a device sync follows the ask token, its owner runs the passes a token change calls for;
    // the timer's own listing is then only the hourly safety refresh, counted from start.
    this.startedAt = Date.now();
    this.armTimer();
  }

  /**
   * Stops polling and cancels a transport call in flight. The returned promise settles once a pass
   * already running has finished, so no ledger, lease or store write outlives the stop.
   */
  async stop(): Promise<void> {
    // Fresh passes queued behind the one in flight belong to the run being stopped.
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDueAt = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    await this.followCheck?.catch(() => undefined);
    await this.inFlight?.catch(() => undefined);
  }

  /**
   * A local sign that an ask may be on its way, such as a catalog revision change: the cadence goes
   * back to fast, and a timer armed for a quiet interval is pulled in to one fast interval from
   * now. It never polls on the spot, so a burst of wakes costs no more calls than one.
   */
  wake(): void {
    this.emptyPolls = 0;
    // With no timer armed, a pass is running or the worker is stopped; the next arm reads the reset.
    if (this.timer === undefined || this.timerDueAt === undefined) return;
    const delay = this.nextDelay();
    if (Date.now() + delay >= this.timerDueAt) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.armTimer(delay);
  }

  isRunning(): boolean {
    return this.abortController !== undefined && !this.abortController.signal.aborted;
  }

  /**
   * Runs one pass now, or joins the pass already running. Deterministic for tests and for a host
   * that wants to answer immediately rather than wait for the timer.
   */
  async runOnce(): Promise<WorkflowValidationPassSummary> {
    const existing = this.inFlight;
    if (existing) return await existing;
    const signal = this.abortController?.signal;
    const pass = this.runLeasedPass(signal);
    this.inFlight = pass;
    try {
      const summary = await pass;
      // A pass skipped because another process held the lease listed nothing: what it was run for
      // is still owed, so it stays pending for the timer to retry.
      this.localRetryPending = summary.skipped || summary.deferred > 0 || summary.refused > 0;
      return summary;
    } finally {
      if (this.inFlight === pass) this.inFlight = undefined;
    }
  }

  /**
   * Runs a pass whose listing starts after this call: one already running may have listed before
   * whatever prompted the call, so it is waited out first, then `runOnce` runs (or joins) the next.
   */
  async runFresh(): Promise<WorkflowValidationPassSummary | undefined> {
    const generation = this.generation;
    await this.inFlight?.catch(() => undefined);
    // Stopped (or stopped and restarted) while waiting: the fresh pass is cancelled.
    if (generation !== this.generation || !this.isRunning()) return undefined;
    return await this.runOnce();
  }

  /** When asks were last listed successfully, in `Date.now()` time; -Infinity before the first. */
  listedAt(): number {
    return this.lastListedAt;
  }

  private armTimer(delay: number = this.nextDelay()): void {
    if (!this.abortController || this.abortController.signal.aborted) return;
    this.timerDueAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = undefined;
      void this.timedPass()
        // A pass reports its own failures; the poll must survive every one of them.
        .catch(() => undefined)
        .finally(() => this.armTimer());
    }, delay);
    this.timer.unref?.();
  }

  /**
   * The timer's pass. While a device sync follows the pending-ask token, a pass with nothing to
   * retry locally and no safety refresh due lists nothing and counts as empty, so the timer backs
   * off to its quiet interval.
   */
  private async timedPass(): Promise<void> {
    const generation = this.generation;
    const followsDeviceSync = this.followsDeviceSync;
    if (
      followsDeviceSync &&
      !this.localRetryPending &&
      Date.now() - Math.max(this.lastListedAt, this.startedAt) < DEVICE_SYNC_SAFETY_REFRESH_MS
    ) {
      // The check reads local files; stop() waits for it like for a pass in flight.
      const check = (async () => {
        try {
          return await followsDeviceSync();
        } catch {
          return false;
        }
      })();
      this.followCheck = check;
      let follows: boolean;
      try {
        follows = await check;
      } finally {
        if (this.followCheck === check) this.followCheck = undefined;
      }
      if (follows) {
        this.emptyPolls += 1;
        return;
      }
    }
    // Stopped (or stopped and restarted) during the check: the timer's pass belongs to that run.
    if (generation !== this.generation || !this.isRunning()) return;
    await this.runOnce();
  }

  /** The interval the cadence is at: fast, then doubling per empty poll past the threshold, capped. */
  private currentInterval(): number {
    const steps = this.emptyPolls - WORKFLOW_VALIDATION_QUIET_POLL_THRESHOLD + 1;
    if (steps <= 0) return this.pollIntervalMs;
    return Math.min(
      this.quietPollIntervalMs,
      this.pollIntervalMs * WORKFLOW_VALIDATION_POLL_BACKOFF_FACTOR ** steps,
    );
  }

  /** The interval, lengthened by a jitter of up to `pollJitterRatio` of it; never shortened. */
  private nextDelay(): number {
    const interval = this.currentInterval();
    const jitter = Math.max(0, Math.min(1, this.random())) * interval * this.pollJitterRatio;
    return Math.round(interval + jitter);
  }

  /**
   * Moves the cadence after a pass that listed `requests`. It stays fast when any of them is new
   * since the last pass; otherwise the pass counts as empty. `settled` are the asks this pass left
   * undecided or saw declined, which the next pass will not count as new.
   */
  private recordPass(requests: WorkflowValidationRequest[], settled: Set<string>): void {
    const arriving = requests.some((request) => !this.settledAsks.has(askKey(request)));
    this.settledAsks = settled;
    this.emptyPolls = arriving ? 0 : this.emptyPolls + 1;
  }

  private async runLeasedPass(signal?: AbortSignal): Promise<WorkflowValidationPassSummary> {
    const summary: WorkflowValidationPassSummary = {
      pending: 0,
      answered: 0,
      refused: 0,
      rejected: 0,
      deferred: 0,
      skipped: false,
    };
    if (!this.passLease) return await this.runPass(summary, signal);
    let lease: WorkflowValidationPassLeaseHandle | undefined;
    try {
      lease = await this.passLease.tryAcquire();
    } catch (error) {
      this.log(`workflow validation: could not take the pass lease (${describe(error)})`);
      summary.deferred += 1;
      return summary;
    }
    if (lease === undefined) {
      // Another process on this device is answering; its answers are gone from the next listing.
      summary.skipped = true;
      this.emptyPolls += 1;
      return summary;
    }
    const held = lease;
    try {
      return await this.runPass(summary, signal, {
        lease: held,
        deadline: Date.now() + this.passLease.maxHoldMs,
      });
    } finally {
      await held
        .release()
        .catch((error: unknown) =>
          this.log(`workflow validation: could not release the pass lease (${describe(error)})`),
        );
    }
  }

  private async runPass(
    summary: WorkflowValidationPassSummary,
    signal?: AbortSignal,
    held?: { lease: WorkflowValidationPassLeaseHandle; deadline: number },
  ): Promise<WorkflowValidationPassSummary> {
    let requests: WorkflowValidationRequest[];
    try {
      requests = await this.client.listPending(this.deviceId, signal);
      this.lastListedAt = Date.now();
    } catch (error) {
      this.log(`workflow validation: could not list pending asks (${describe(error)})`);
      summary.deferred += 1;
      // A failed poll is retried on the fast cadence, as it always was.
      this.emptyPolls = 0;
      return summary;
    }
    const settled = new Set<string>();
    summary.pending = requests.length;
    for (const request of requests) {
      if (signal?.aborted) break;
      if (held) {
        // Asks past the lease's hold bound wait for the next pass; the rest keep the lease fresh.
        if (Date.now() >= held.deadline) {
          summary.deferred += 1;
          continue;
        }
        await held.lease.renew();
      }
      const decision = await this.decide(request);
      if (decision === undefined) {
        summary.refused += 1;
        settled.add(askKey(request));
        continue;
      }
      let answer: WorkflowValidationSubmitResult;
      try {
        answer = await this.client.submitDecision(decision, signal);
      } catch (error) {
        this.log(
          `workflow validation: the decision for '${request.requestId}' was left for the next pass (${describe(error)})`,
        );
        summary.deferred += 1;
        continue;
      }
      if (answer.status === "recorded" || answer.status === "duplicate") {
        summary.answered += 1;
        continue;
      }
      summary.rejected += 1;
      settled.add(askKey(request));
      this.log(
        `workflow validation: the cloud did not record the decision for '${request.requestId}' (${answer.status}${
          answer.reason === undefined ? "" : `: ${answer.reason}`
        })`,
      );
    }
    this.recordPass(requests, settled);
    return summary;
  }

  /**
   * Builds the decision for one ask, or refuses to build one.
   *
   * Four things decide whether an ask may be answered at all: it must name this identity's
   * workspace and device, its plan must be the exact plan whose digest it carries, and it must not have
   * expired. A refusal is not an answer — the ask stays pending for the cloud to re-issue.
   */
  private async decide(
    request: WorkflowValidationRequest,
  ): Promise<WorkflowValidationDecision | undefined> {
    if (request.workspaceId !== this.workspaceId) {
      this.log(
        `workflow validation: refused ask '${request.requestId}': it names workspace '${request.workspaceId}', not this identity's workspace`,
      );
      return undefined;
    }
    // The listing is already scoped to this device; an ask that names one must name this one.
    if (request.deviceId !== undefined && request.deviceId !== this.deviceId) {
      this.log(
        `workflow validation: refused ask '${request.requestId}': it names device '${request.deviceId}', not this identity's device`,
      );
      return undefined;
    }
    const planDigest = workflowValidationPlanDigest(request.plan);
    if (planDigest !== request.planDigest) {
      this.log(
        `workflow validation: refused ask '${request.requestId}': the plan digests to ${planDigest}, not the requested ${request.planDigest}`,
      );
      return undefined;
    }
    if (request.expiresAt !== undefined && Date.parse(request.expiresAt) <= this.now().getTime()) {
      this.log(
        `workflow validation: refused ask '${request.requestId}': it expired at ${request.expiresAt}`,
      );
      return undefined;
    }
    const now = this.now().getTime();
    for (const [key, skip] of this.skippedAsks) if (skip.until <= now) this.skippedAsks.delete(key);
    const skipped = this.skippedAsks.get(askKey(request));
    if (skipped !== undefined && now < skipped.recheckAt) return undefined;
    // Every recorded call the plan names, from both demonstrations, and every private reference
    // it resolves: what this answer is about.
    const references = new Set<string>();
    JSON.stringify(request.plan, (_key, value) => {
      if (typeof value === "string" && value.startsWith("private:")) references.add(value);
      return value;
    });
    const keys = [
      ...request.plan.steps.flatMap((step) =>
        step.origin !== "derivation" && step.callId !== undefined && step.callId.length > 0
          ? [`call:${step.callId}`]
          : [],
      ),
      ...(request.plan.heldOut?.calls ?? []).flatMap((entry) =>
        entry.callIds.map((callId) => `call:${callId}`),
      ),
      ...[...references].map((reference) => `reference:${reference}`),
    ];
    // An ask another device recorded is that device's to answer: finding that out reads only
    // whether this device holds the calls, so it is settled before the ask spends a check.
    const localCalls =
      this.localCalls ??
      (this.createValidator === undefined
        ? createLocalCallIdentity({
            workspaceId: this.workspaceId,
            privateValues: this.privateValues ?? FilePrivateValueStore.default(),
          })
        : undefined);
    if (localCalls !== undefined) {
      // A lookup that fails another way is left to the recording check, which reports it.
      let recordedHere = true;
      try {
        recordedHere = await planRecordedHere(request.plan, localCalls);
      } catch (error) {
        if (error instanceof LocalSessionDiscoveryUnavailableError) {
          this.log(
            `workflow validation: ask '${request.requestId}' deferred because local session discovery is unavailable`,
          );
          return undefined;
        }
      }
      if (!recordedHere) return this.skipNotRecordedHere(request);
    }
    const admission = await this.askLedger?.admit({
      requestId: request.requestId,
      planDigest,
      keys,
    });
    if (admission?.admitted === false) {
      if (admission.reason === "ledger-unavailable") {
        // Nothing says when the ledger frees up, so the ask backs off rather than being refused
        // and logged again on every pass.
        const retryAt = now + LEDGER_UNAVAILABLE_RETRY_MS;
        this.log(
          `workflow validation: refused ask '${request.requestId}': the local check ledger is unavailable; checking it again after ${new Date(retryAt).toISOString()}`,
        );
        this.skippedAsks.set(askKey(request), { until: retryAt, recheckAt: retryAt });
        return undefined;
      }
      // Nothing changes before the window frees a check, so the ask waits for it instead of being
      // refused again on every pass. It stays pending for the cloud, which re-issues or expires it.
      const retryAt = new Date(admission.retryAt).toISOString();
      this.log(
        `workflow validation: refused ask '${request.requestId}': ${admission.key.startsWith("reference:") ? "a private value" : "a recorded call"} it checks reached its daily check limit; checking it again after ${retryAt}`,
      );
      this.skippedAsks.set(askKey(request), {
        until: admission.retryAt,
        recheckAt: admission.retryAt,
      });
      return undefined;
    }
    let result: LocalWorkflowValidationResult;
    try {
      result = await this.buildValidator(request, localCalls)(request.plan);
    } catch (error) {
      if (error instanceof LocalSessionDiscoveryUnavailableError) {
        this.log(
          `workflow validation: ask '${request.requestId}' deferred because local session discovery is unavailable`,
        );
        return undefined;
      }
      this.log(
        `workflow validation: ask '${request.requestId}' recording check failed (${describe(error)})`,
      );
      return this.failedDecision(
        request,
        planDigest,
        "the local recording check failed before it could verify the recorded workflow",
      );
    }
    if (result.notRecordedHere === true) return this.skipNotRecordedHere(request);
    if (
      result.unavailable !== undefined ||
      (result.verdicts.length === 0 && result.verification === undefined)
    ) {
      const reason =
        result.unavailable ?? "the validator returned no verdicts and no whole-plan verification";
      this.log(
        `workflow validation: ask '${request.requestId}' recording check failed (${reason})`,
      );
      return this.failedDecision(request, planDigest, reason);
    }
    const verdicts: WorkflowValidationVerdict[] = result.verdicts.map((verdict) => ({
      candidate: {
        stepId: verdict.candidate.stepId,
        argument: verdict.candidate.argument,
        path: verdict.candidate.path,
        proposed: verdict.candidate.proposed,
      },
      confirmed: verdict.confirmed,
      ...(verdict.confirmedType === undefined ? {} : { confirmedType: verdict.confirmedType }),
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.composed === undefined ? {} : { composed: verdict.composed }),
      ...(verdict.form === undefined ? {} : { form: verdict.form }),
    }));
    return {
      schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
      requestId: request.requestId,
      attempt: request.attempt,
      planDigest,
      evidenceDigest: request.evidenceDigest,
      environment: this.environmentIdentity,
      verdicts,
      ...(result.verification === undefined ? {} : { verification: result.verification }),
      accepted: verdicts
        .filter((verdict) => verdict.confirmed)
        .map((verdict) => ({
          stepId: verdict.candidate.stepId,
          argument: verdict.candidate.argument,
          path: verdict.candidate.path,
        })),
      decidedAt: this.now().toISOString(),
    };
  }

  private failedDecision(
    request: WorkflowValidationRequest,
    planDigest: string,
    reason: string,
  ): WorkflowValidationDecision {
    const candidates = request.plan.candidates ?? [];
    return {
      schemaVersion: WORKFLOW_VALIDATION_SCHEMA_VERSION,
      requestId: request.requestId,
      attempt: request.attempt,
      planDigest,
      evidenceDigest: request.evidenceDigest,
      environment: this.environmentIdentity,
      verdicts: candidates.map((candidate) => ({
        candidate: {
          stepId: candidate.stepId,
          argument: candidate.argument,
          path: candidate.path,
          proposed: candidate.proposed,
        },
        confirmed: false,
        reason,
      })),
      verification: {
        status: "failed",
        reproduced: [],
        missed: request.plan.steps.map((step) => ({ stepId: step.id, detail: reason })),
        dropped: candidates.map((candidate) => ({ candidate, reason })),
      },
      accepted: [],
      decidedAt: this.now().toISOString(),
    };
  }

  /** Remembers an ask another device recorded; it answers, or the ask lapses at its TTL. */
  private skipNotRecordedHere(request: WorkflowValidationRequest): undefined {
    this.log(
      `workflow validation: skipped ask '${request.requestId}': this device did not record its demonstration`,
    );
    const skippedAt = this.now().getTime();
    const until =
      request.expiresAt !== undefined && Number.isFinite(Date.parse(request.expiresAt))
        ? Date.parse(request.expiresAt)
        : skippedAt + SKIPPED_ASK_RETENTION_MS;
    this.skippedAsks.set(askKey(request), {
      until,
      recheckAt: Math.min(skippedAt + SKIPPED_ASK_RECHECK_MS, until),
    });
    return undefined;
  }

  private buildValidator(
    request: WorkflowValidationRequest,
    localCalls: LocalCallIdentity | undefined,
  ): WorkflowPlanValidator {
    const create = this.createValidator;
    if (create) return create(request);
    const privateValues = this.privateValues ?? FilePrivateValueStore.default();
    return createRecordingCheckValidator({
      // References resolve the way an invocation resolves them: only the ones this identity's
      // workspace recorded.
      workspaceId: this.workspaceId,
      privateValues,
      localCalls:
        localCalls ?? createLocalCallIdentity({ workspaceId: this.workspaceId, privateValues }),
      timeoutMs: this.timeoutMs,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
