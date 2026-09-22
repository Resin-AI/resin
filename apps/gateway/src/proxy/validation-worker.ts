/**
 * The gateway's half of a recorded workflow's validation: answering an ask the cloud cannot answer
 * itself.
 *
 * A recording's values, and the environment its steps run in, never leave the machine that made
 * them, so deciding whether its proposals hold is a local service (`workflow-validation.ts`). What
 * is missing without this file is the wiring that lets a cloud-issued ask reach that service: a
 * client that speaks to the validation routes on the authenticated connection, and a worker that
 * takes each pending ask, substantiates it against this identity, replays it through the local
 * execution path, and posts the decision back.
 *
 * Nothing here decides what a proposal means — the replay does. An ask this worker cannot
 * substantiate is left unanswered rather than answered with a guess, and an answer the cloud
 * declines is reported and never retried forever: the ask is the cloud's to re-issue.
 */

import os from "node:os";
import {
  type RecordedWorkflow,
  WORKFLOW_VALIDATION_SCHEMA_VERSION,
  type WorkflowJsonValue,
  type WorkflowValidationDecision,
  type WorkflowValidationRequest,
  WorkflowValidationRequestSchema,
  type WorkflowValidationVerdict,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import type { CloudRequestIdentity, PrivateValueStore } from "@resin/observer";
import { PROTOCOL_VERSION } from "@resin/protocol";
import type {
  McpToolConnection,
  RuntimeAdapter,
  ToolProtocolDispatchRequest,
} from "@resin/runtime";
import { z } from "zod";
import {
  type LocalWorkflowValidationResult,
  createLocalWorkflowValidator,
} from "./workflow-validation.js";

/** Where an ask is listed from, and where its answer is delivered. */
const PENDING_ROUTE = "/v1/evolution/workflow-validation/pending";
const DECISIONS_ROUTE = "/v1/evolution/workflow-validation/decisions";
const MAX_RESPONSE_BYTES = 512 * 1024;

/** The time between passes when the caller does not name one. */
export const DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS = 15_000;
/** Passes are spread over this fraction of the interval so a fleet does not wake in lockstep. */
export const DEFAULT_WORKFLOW_VALIDATION_POLL_JITTER_RATIO = 0.2;
/** A replay that outlives this bound is refused rather than allowed to run on forever. */
export const DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS = 30_000;
/** No caller may hand the worker a replay bound beyond this; the work is a replay, not a job. */
export const MAX_WORKFLOW_VALIDATION_TIMEOUT_MS = 120_000;
/** Identity the decision names for the disposable environment a replay ran in. */
export const DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT = `resin-gateway-replay:${os.hostname()}`;

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
        ...init.headers,
      },
    });
    if (!forceRefresh && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel().catch(() => undefined);
      return await this.request(route, init, true);
    }
    return response;
  }

  /**
   * The asks pending for this device.
   *
   * An entry that is not a well-formed request cannot be replayed and is left out — it is not
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
  /** Asks this worker would not answer: another workspace, a mismatched plan, or no replay. */
  refused: number;
  /** Decisions the cloud declined (conflict, stale, mismatched); reported, never retried here. */
  rejected: number;
  /** Asks left for the next pass because a transport call failed. */
  deferred: number;
}

/** Replays one plan; the validator `workflow-validation.ts` builds, or a test's stand-in. */
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
   * Builds the validator one ask is replayed with. Defaults to `createLocalWorkflowValidator` with
   * this worker's store, dispatch, environment and bound; a test may substitute one that answers
   * deterministically.
   */
  createValidator?: (request: WorkflowValidationRequest) => WorkflowPlanValidator;
  /** Store the plan's local references resolve from; the same one the artifact executor uses. */
  privateValues?: PrivateValueStore;
  /** Dispatches a tool-protocol step through the host's own routing. */
  dispatch?: (request: ToolProtocolDispatchRequest) => Promise<WorkflowJsonValue>;
  /**
   * Protocol connections already open, by the name a plan's callable carries, and the resolver
   * that dials one that is not. A replay resolves a recorded callable over the connection the
   * record names, exactly as an invocation does.
   */
  connections?: Record<string, McpToolConnection>;
  openConnection?: (name: string) => Promise<McpToolConnection | undefined>;
  /** Additional host-owned runtime families, built for each replay workspace. */
  runtimeAdapters?: (workspaceDir: string) => readonly RuntimeAdapter[];
  /**
   * Environment the replayed programs may see, and nothing else: a program recorded by somebody
   * else's session must not be able to read this operator's credentials.
   */
  environment?: Record<string, string>;
  /** Identity the decision reports for the replay environment. */
  environmentIdentity?: string;
  /** Wall-clock bound for one replay; a caller's value is clamped, never unbounded. */
  timeoutMs?: number;
  /** Time between passes; defaults to 15s. */
  pollIntervalMs?: number;
  /** Fraction of the interval the passes are spread over; defaults to 0.2. */
  pollJitterRatio?: number;
  now?: () => Date;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
  /**
   * Where the worker reports what it could not answer and what the cloud declined. The gateway is
   * a library, so the sink is the caller's: a daemon writes it to its stderr, a test records it.
   */
  log?: (message: string) => void;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WORKFLOW_VALIDATION_TIMEOUT_MS;
  }
  return Math.min(value, MAX_WORKFLOW_VALIDATION_TIMEOUT_MS);
}

function boundedInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WORKFLOW_VALIDATION_POLL_INTERVAL_MS;
  }
  return value;
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
 * pass runs at a time, so two timers firing close together cannot replay the same plan twice, and
 * a pass that takes longer than the interval delays the next one instead of overlapping it.
 */
export class WorkflowValidationWorker {
  private readonly client: WorkflowValidationTransport;
  private readonly workspaceId: string;
  private readonly deviceId: string;
  private readonly createValidator?: WorkflowValidationWorkerOptions["createValidator"];
  private readonly privateValues?: PrivateValueStore;
  private readonly dispatch?: (request: ToolProtocolDispatchRequest) => Promise<WorkflowJsonValue>;
  private readonly connections?: Record<string, McpToolConnection>;
  private readonly openConnection?: (name: string) => Promise<McpToolConnection | undefined>;
  private readonly runtimeAdapters?: (workspaceDir: string) => readonly RuntimeAdapter[];
  private readonly environment?: Record<string, string>;
  private readonly environmentIdentity: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollJitterRatio: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private timer?: NodeJS.Timeout;
  private abortController?: AbortController;
  private inFlight?: Promise<WorkflowValidationPassSummary>;

  constructor(options: WorkflowValidationWorkerOptions) {
    this.client = options.client;
    this.workspaceId = options.identity.workspaceId;
    this.deviceId = options.identity.deviceId;
    this.createValidator = options.createValidator;
    this.privateValues = options.privateValues;
    this.dispatch = options.dispatch;
    this.connections = options.connections;
    this.openConnection = options.openConnection;
    this.environment = options.environment;
    this.runtimeAdapters = options.runtimeAdapters;
    this.environmentIdentity =
      options.environmentIdentity ?? DEFAULT_WORKFLOW_VALIDATION_ENVIRONMENT;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
    this.pollIntervalMs = boundedInterval(options.pollIntervalMs);
    this.pollJitterRatio = boundedJitter(options.pollJitterRatio);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
  }

  /** Arms the poll. Passes never hold the process open: the timer is unref'd. */
  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    this.armTimer();
  }

  /** Stops polling and cancels a transport call in flight; a replay already running finishes. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abortController?.abort();
    this.abortController = undefined;
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
    const pass = this.runPass(signal);
    this.inFlight = pass;
    try {
      return await pass;
    } finally {
      if (this.inFlight === pass) this.inFlight = undefined;
    }
  }

  private armTimer(): void {
    if (!this.abortController || this.abortController.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        // A pass reports its own failures; the poll must survive every one of them.
        .catch(() => undefined)
        .finally(() => this.armTimer());
    }, this.nextDelay());
    this.timer.unref?.();
  }

  private nextDelay(): number {
    const spread = this.pollIntervalMs * this.pollJitterRatio;
    return Math.round(this.pollIntervalMs + this.random() * spread);
  }

  private async runPass(signal?: AbortSignal): Promise<WorkflowValidationPassSummary> {
    const summary: WorkflowValidationPassSummary = {
      pending: 0,
      answered: 0,
      refused: 0,
      rejected: 0,
      deferred: 0,
    };
    let requests: WorkflowValidationRequest[];
    try {
      requests = await this.client.listPending(this.deviceId, signal);
    } catch (error) {
      this.log(`workflow validation: could not list pending asks (${describe(error)})`);
      summary.deferred += 1;
      return summary;
    }
    summary.pending = requests.length;
    for (const request of requests) {
      if (signal?.aborted) break;
      const decision = await this.decide(request);
      if (decision === undefined) {
        summary.refused += 1;
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
      this.log(
        `workflow validation: the cloud did not record the decision for '${request.requestId}' (${answer.status}${
          answer.reason === undefined ? "" : `: ${answer.reason}`
        })`,
      );
    }
    return summary;
  }

  /**
   * Builds the decision for one ask, or refuses to build one.
   *
   * Three things decide whether an ask may be answered at all: it must name this identity's
   * workspace, its plan must be the exact plan whose digest it carries, and it must not have
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
    let result: LocalWorkflowValidationResult;
    try {
      result = await this.buildValidator(request)(request.plan);
    } catch (error) {
      this.log(
        `workflow validation: ask '${request.requestId}' replay failed (${describe(error)})`,
      );
      return this.failedDecision(
        request,
        planDigest,
        "the local replay failed before it could verify the recorded workflow",
      );
    }
    if (
      result.unavailable !== undefined ||
      (result.verdicts.length === 0 && result.verification === undefined)
    ) {
      const reason =
        result.unavailable ?? "the validator returned no verdicts and no whole-plan verification";
      this.log(`workflow validation: ask '${request.requestId}' replay failed (${reason})`);
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
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
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

  private buildValidator(request: WorkflowValidationRequest): WorkflowPlanValidator {
    const create = this.createValidator;
    if (create) return create(request);
    return createLocalWorkflowValidator({
      // The replay resolves references the way an invocation does: only the ones this identity's
      // workspace recorded.
      workspaceId: this.workspaceId,
      ...(this.privateValues === undefined ? {} : { privateValues: this.privateValues }),
      ...(this.dispatch === undefined ? {} : { dispatch: this.dispatch }),
      ...(this.connections === undefined ? {} : { connections: this.connections }),
      ...(this.openConnection === undefined ? {} : { openConnection: this.openConnection }),
      ...(this.runtimeAdapters === undefined ? {} : { runtimeAdapters: this.runtimeAdapters }),
      ...(this.environment === undefined ? {} : { environment: this.environment }),
      timeoutMs: this.timeoutMs,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
