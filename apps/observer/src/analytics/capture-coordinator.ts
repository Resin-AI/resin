import { createHash } from "node:crypto";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  isHarnessIntrospectionProgram,
  isResinDiscoveryToolCall,
  readCodexCommandMetadata,
  referencesHarnessState,
  windowsShellInvocation,
} from "@resin/contracts";
import {
  type HarnessSession,
  RESIN_LOCAL_SOURCE_INTERFACE_KEY,
  type RawHarnessRecord,
} from "@resin/harness-contracts";
import { ExponentialBackoff } from "@resin/protocol";
import { z } from "zod";
import { AuthRecoveryError, ResourceForbiddenError } from "../auth-recovery.js";
import type { CloudObservationClient } from "../cloud-runtime.js";
import type { Logger } from "../lifecycle.js";
import { localWorkflowEvent } from "../normalization/local-workflow-payload.js";
import {
  NormalizationPipeline,
  type PipelineProcessContext,
  type PipelineProcessResult,
  generateDeterministicEventId,
} from "../normalization/pipeline.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { TelemetryAggregator } from "../observability/telemetry-aggregator.js";
import type { TailerRecordHandler } from "../tailing/tailer.js";
import type { CloudUploadStatusRecorder } from "./cloud-upload-status.js";
import { ComputationEvidenceRecorder } from "./computation/recorder.js";
import { extractRawCommandStringFromEvent } from "./deterministic-command-sequence.js";
import { MetadataEventProjector } from "./metadata-event-projector.js";
import { ToolLinkEvidenceRecorder } from "./tool-links/recorder.js";
import {
  TrajectoryAlreadyFinalizedError,
  type TrajectoryAttributionContextInput,
  TrajectoryAttributionContextSchema,
  type TrajectoryEmitter,
  createTrajectoryEmitter,
} from "./trajectory-emitter.js";
import { WorkflowCallRecorder } from "./workflow-call-recorder.js";

/**
 * Upload batching policy for generic observation sessions. Every constant that decides when a
 * buffered session is sent to the cloud lives here.
 *
 * Rationale: each `POST /v1/observations/batch` costs a fixed ~13-15 DynamoDB WRU on the cloud side
 * (ingestion receipt + outbox item + cursor-head update in one transaction) on top of the
 * per-event writes. Flushing on every turn boundary produced ~88 uploads per active user-hour at
 * ~6 events each, so the fixed per-request cost dominated. A longer window amortizes it over more
 * events while bounded latency is kept for detection:
 * - `windowMs`: a batch is sent at most 45 s after its first buffered event. Replaying local OMP
 *   and Codex sessions with the 15 s window gave ~116-158 uploads per active session-hour at ~5
 *   events each; continuous agent work sends one batch per window, so the window sets the rate.
 * - `turnHintWindowMs`: turn boundaries no longer force a send. A settled turn (an assistant reply
 *   that requests no tool call, i.e. the agent now waits on the user) shortens the remaining
 *   window to at most 5 s so the cloud's detection gate sees it promptly. Assistant steps that
 *   request tools are mid-turn and keep the full window: in agent sessions nearly every step is
 *   an assistant message, and replaying local sessions showed hinting on every step would keep
 *   ~62% of today's uploads versus ~40% when only settled turns hint.
 * - `settledTurnMinIntervalMs`: a settled turn never pulls a send closer than 45 s after the
 *   session's previous send. Harnesses that write assistant text between tool calls (Codex
 *   commentary, for example) look settled many times per turn; without this bound they kept
 *   ~65% of the uploads under the 45 s window, with it ~45%. The hold never exceeds the window,
 *   and a settled turn after a quiet period still sends within 5 s.
 *   Replay of the same sessions, 15 s window → this policy: OMP 115.9 → 57.0 and Codex 158.0 →
 *   71.3 uploads per active session-hour (−54% overall); events uploaded are unchanged.
 * - Session end, terminal lifecycle events and shutdown/stop (`waitForIdle`/`flush`) still send
 *   immediately; unsent records are never acknowledged to the tailer, so nothing is lost.
 * - `maxEvents`/`maxBytes`: flush thresholds. A batch is sent as soon as a delivery brings it to
 *   500 events or 4 MiB of uncompressed JSON. Cloud ingestion allows at most 1,000 events and
 *   10 MiB of wire bytes (50 MiB decompressed) per request (ingestion validator and quota
 *   limiter), so the thresholds sit at half of those limits. Whole deliveries are buffered, so a
 *   batch can overshoot a threshold; one that outgrows a request is split by the per-request
 *   ceilings below.
 * - `maxPendingDeliveries`: the tailer stops delivering a session after 100 unacknowledged
 *   deliveries (`defaultMaxInFlightBatches` in trajectory-capture-module), so a batch is sent
 *   before it could stall the tailer for the rest of its window.
 * - `requestMaxEvents`/`requestMaxBytes`: hard per-request ceilings used when a buffer outgrew one
 *   request (e.g. records kept arriving while a failed send was backing off). They sit at the
 *   server's event limit and at half its byte limit, before compression.
 */
export const OBSERVATION_UPLOAD_POLICY = {
  windowMs: 45_000,
  turnHintWindowMs: 5_000,
  settledTurnMinIntervalMs: 45_000,
  maxEvents: 500,
  maxBytes: 4 * 1024 * 1024,
  maxPendingDeliveries: 100,
  requestMaxEvents: 1_000,
  requestMaxBytes: 5 * 1024 * 1024,
} as const;

function serializedByteLength(event: unknown): number {
  return Buffer.byteLength(JSON.stringify(event));
}

/**
 * Splits an ordered upload into request-sized chunks without reordering. A buffer that fits one
 * request by bytes is split by event count only, exactly as before byte-bounded chunking existed.
 * A single event larger than the byte ceiling travels alone.
 */
export function chunkObservationsForUpload<T>(events: readonly T[], totalBytes: number): T[][] {
  const { requestMaxEvents, requestMaxBytes } = OBSERVATION_UPLOAD_POLICY;
  const chunks: T[][] = [];
  if (totalBytes <= requestMaxBytes) {
    for (let start = 0; start < events.length; start += requestMaxEvents) {
      chunks.push(events.slice(start, start + requestMaxEvents));
    }
    return chunks;
  }
  let chunk: T[] = [];
  let chunkBytes = 0;
  for (const event of events) {
    const eventBytes = serializedByteLength(event);
    if (
      chunk.length > 0 &&
      (chunk.length >= requestMaxEvents || chunkBytes + eventBytes > requestMaxBytes)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(event);
    chunkBytes += eventBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** The upload form of an event: without the daemon-local workspace id a lifecycle event carries. */
function withoutLocalWorkspaceId(event: NormalizedSessionEvent): NormalizedSessionEvent {
  if (event.type !== "session_lifecycle" || event.workspaceId === undefined) return event;
  const { workspaceId: _localWorkspaceId, ...wire } = event;
  return wire;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const MAX_HARNESS_INTROSPECTION_SESSIONS = 256;
const MAX_HARNESS_INTROSPECTION_CALLS = 4096;

/**
 * A tracked session that recorded nothing for this long is not active work: it ended without a
 * terminal record (a subagent, a killed process) or sits open unused. It counts as active again as
 * soon as it records something. Background updates activate only while no session is active, so a
 * session that could never stop counting would hold every update back until the daemon restarted.
 */
export const ACTIVE_SESSION_IDLE_MS = 30 * 60_000;

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return undefined;
}

/**
 * Function signature for resolving trajectory attribution context from a harness session.
 */
export type TrajectoryAttributionResolverFn = (
  session: HarnessSession,
) =>
  | Promise<TrajectoryAttributionContextInput | null | undefined>
  | TrajectoryAttributionContextInput
  | null
  | undefined;

/**
 * Object interface for resolving trajectory attribution context.
 */
export interface TrajectoryAttributionResolverObject {
  resolveAttribution: TrajectoryAttributionResolverFn;
}

/**
 * Async resolver for trajectory attribution context, accepting either a function or an object.
 */
export type TrajectoryAttributionResolver =
  | TrajectoryAttributionResolverFn
  | TrajectoryAttributionResolverObject;

export interface PrivacyCutoffRecordsResult {
  records: RawHarnessRecord[];
  timestampMs: number[];
}

/**
 * Terminal/attribution context accompanying a local session event notification.
 */
export interface SessionEventSinkContext {
  /** True when the harness session reached a terminal status or emitted a terminal event. */
  isTerminal: boolean;
  /** True for trajectory-attributed sessions; false for generic observation sessions. */
  isAttributed: boolean;
}

/**
 * Local-only sink for metadata-projected normalized events.
 *
 * Receives the same metadata-projected form that is eligible for cloud observation batches.
 * Implementations MUST be side-effect-safe: a throwing sink never fails capture.
 */
export type SessionEventSink = (
  session: HarnessSession,
  events: NormalizedSessionEvent[],
  context: SessionEventSinkContext,
) => void | Promise<void>;

/**
 * Options for configuring TrajectoryCaptureCoordinator.
 */
export interface TrajectoryCaptureCoordinatorOptions {
  pipeline: NormalizationPipeline;
  observationClient?: CloudObservationClient;
  cloudClient?: CloudObservationClient;
  attributionResolver?: TrajectoryAttributionResolver;
  /**
   * Local store the redaction pipeline and workflow recorder mint placeholder aliases into. Its
   * pending writes are persisted before any batch is acknowledged or any event leaves the device,
   * so a placeholder never outlives the alias that resolves it.
   */
  privateValueStore?: { flush(): void };
  logger?: Logger;
  /**
   * Dynamic transmission gate. Any value other than an explicit `true` fails closed.
   */
  isTelemetryEnabled?: () => boolean;
  /**
   * Authoritative account-level consent check performed before processing and immediately before
   * every outbound request. The record timestamps describe the payload being authorized. Any
   * value other than an explicit `true` fails closed.
   */
  authorizeTelemetryEmission?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;
  /**
   * Records at or before this privacy cutoff are acknowledged locally without normalization or
   * transmission.
   */
  minimumRecordTimestampMs?: number;
  /**
   * Upload window in milliseconds for generic observation sessions, measured from the first
   * buffered event. Defaults to `OBSERVATION_UPLOAD_POLICY.windowMs`. Set to 0 to disable
   * coalescing.
   */
  coalesceDwellMs?: number;
  /**
   * Upper bound on the remaining window once a turn settles. Defaults to
   * `OBSERVATION_UPLOAD_POLICY.turnHintWindowMs`.
   */
  turnHintDwellMs?: number;
  /**
   * Minimum time between a session's previous send and a send pulled forward by a settled turn.
   * Defaults to `OBSERVATION_UPLOAD_POLICY.settledTurnMinIntervalMs`. Set to 0 to let every
   * settled turn shorten the window.
   */
  settledTurnMinIntervalMs?: number;
  /**
   * Maximum batch size (number of observations) before an immediate flush occurs.
   * Defaults to `OBSERVATION_UPLOAD_POLICY.maxEvents`.
   */
  maxBatchSize?: number;
  /**
   * Maximum serialized batch size in bytes before an immediate flush occurs.
   * Defaults to `OBSERVATION_UPLOAD_POLICY.maxBytes`.
   */
  maxBatchBytes?: number;
  /**
   * Optional local telemetry aggregator for recording batch metrics.
   */
  telemetry?: TelemetryAggregator;
  /**
   * Records each upload batch the cloud accepts, generic and trajectory alike, so status surfaces
   * can show when capture last reached the cloud.
   */
  uploadStatus?: CloudUploadStatusRecorder;
  /**
   * Optional local-only sink for metadata-projected normalized events. Invoked once per
   * processed batch (and once per terminal transition) so local consumers such as the
   * opportunity tracker observe the same event stream as cloud observation batches.
   */
  onSessionEvents?: SessionEventSink;
  /**
   * Bounded observed-source evidence recorder. Defaults to a new recorder so every coordinator
   * instance produces computation evidence without any new user-facing flag. Sessions are cleared
   * on teardown.
   */
  computationEvidenceRecorder?: ComputationEvidenceRecorder;
  /**
   * Bounded declared data-flow recorder. Defaults to a new recorder so every coordinator instance
   * produces tool link evidence without any new user-facing flag. It observes each post-dedup event
   * BEFORE the computation recorder removes the local native-call handoff, because that handoff is
   * the embedded copy of a persisted eval call's arguments.
   */
  toolLinkEvidenceRecorder?: ToolLinkEvidenceRecorder;
  /**
   * Per-call workflow carrier recorder. Defaults to a new recorder so every coordinator
   * instance records invoke_tool compositions without a new flag. It observes each
   * post-dedup event alongside the other evidence recorders, before projection.
   */
  workflowCallRecorder?: WorkflowCallRecorder;
  /**
   * Local-only observer of every normalization batch, after dedup and dead-lettering. It feeds
   * the per-harness-version decode stats and must be cheap and synchronous; a throwing observer
   * is ignored and never affects capture.
   */
  onPipelineResults?: (session: HarnessSession, results: readonly PipelineProcessResult[]) => void;
  /**
   * Resolves the harness version stamped on events when the adapter's session metadata carries no
   * `harnessVersion`. The resolver must cache; it runs on every batch.
   */
  resolveHarnessVersion?: (harnessId: string) => Promise<string | null>;
}

interface GenericSessionTail {
  eventId: string;
  causalSequence: number;
  stepIndex: number;
}

interface GenericCoalescingBuffer {
  sessionId: string;
  session: HarnessSession;
  validEvents: NormalizedSessionEvent[];
  projectedEvents: NormalizedSessionEvent[];
  acks: Array<() => Promise<void>>;
  timer: NodeJS.Timeout | null;
  /** Wall-clock time the pending timer fires; null when no timer is pending. */
  flushDueAtMs: number | null;
  /** A retry timer carries backoff and is never shortened by a turn hint. */
  timerKind: "window" | "retry" | null;
  /** Serialized JSON bytes of `projectedEvents`. */
  projectedBytes: number;
  telemetryRecordTimestampMs: number[];
  latestTail?: GenericSessionTail;
  isTerminal: boolean;
}

/**
 * Coordinates raw record ingestion through normalization, per-session trajectory aggregation,
 * attribution resolution, and privacy-safe cloud observation submission.
 */
export class TrajectoryCaptureCoordinator {
  private readonly pipeline: NormalizationPipeline;
  private readonly observationClient: CloudObservationClient;
  private readonly attributionResolver?: TrajectoryAttributionResolver;
  private readonly logger?: Logger;
  private readonly isTelemetryEnabledFn?: () => boolean;
  private readonly authorizeTelemetryEmissionFn?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;
  private minimumRecordTimestampMs: number;
  private telemetryEnabled = true;
  private telemetryGeneration = 0;

  private readonly activeSessions = new Map<string, TrajectoryEmitter>();
  private readonly activeGenericSessions = new Set<string>();
  private readonly finalizedSessions = new Map<string, "generic" | "attributed">();
  private readonly genericSessions = new Set<string>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly genericSessionTails = new Map<string, GenericSessionTail>();
  /** When each session last delivered records (wall clock); see {@link ACTIVE_SESSION_IDLE_MS}. */
  private readonly sessionActivityAtMs = new Map<string, number>();
  private readonly coalesceDwellMs: number;
  private readonly turnHintDwellMs: number;
  private readonly settledTurnMinIntervalMs: number;
  /**
   * When each generic session last sent a batch. Only entries younger than
   * `settledTurnMinIntervalMs` matter; older ones are pruned whenever a send is recorded.
   */
  private readonly genericLastSendAtMs = new Map<string, number>();
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly telemetry?: TelemetryAggregator;
  private readonly onPipelineResults?: TrajectoryCaptureCoordinatorOptions["onPipelineResults"];
  private readonly resolveHarnessVersion?: TrajectoryCaptureCoordinatorOptions["resolveHarnessVersion"];
  private onSessionEvents?: SessionEventSink;
  private computationEvidenceRecorder: ComputationEvidenceRecorder;
  private toolLinkEvidenceRecorder: ToolLinkEvidenceRecorder;
  private workflowCallRecorder: WorkflowCallRecorder;
  /**
   * Per session (least recently used first), the calls dropped as harness introspection, so their
   * results and edits drop too, and the calls kept, so their results never fall back to text.
   */
  private readonly harnessIntrospectionCalls = new Map<
    string,
    { dropped: Set<string>; seen: Set<string> }
  >();
  private readonly metadataEventProjector = new MetadataEventProjector();
  private readonly genericCoalescingBuffers = new Map<string, GenericCoalescingBuffer>();
  private readonly sessionBackoffs = new Map<string, ExponentialBackoff>();

  private readonly genericResourceForbiddenRetries = new Map<string, number>();
  private readonly trajectoryResourceForbiddenRetries = new Map<string, number>();
  private totalGenericBatchesUploaded = 0;
  private totalGenericObservationsUploaded = 0;
  private lastGenericBatchSize = 0;
  private totalGenericBatchesAccepted = 0;
  private totalGenericObservationsAccepted = 0;
  private readonly privateValueStore?: { flush(): void };
  private readonly uploadStatus?: CloudUploadStatusRecorder;
  constructor(options: TrajectoryCaptureCoordinatorOptions);
  constructor(
    pipeline: NormalizationPipeline,
    observationClient: CloudObservationClient,
    attributionResolver?: TrajectoryAttributionResolver,
    options?: { logger?: Logger },
  );
  constructor(
    pipelineOrOptions: NormalizationPipeline | TrajectoryCaptureCoordinatorOptions,
    observationClient?: CloudObservationClient,
    attributionResolver?: TrajectoryAttributionResolver,
    options?: { logger?: Logger },
  ) {
    if (pipelineOrOptions instanceof NormalizationPipeline) {
      this.pipeline = pipelineOrOptions;
      this.observationClient = observationClient!;
      this.attributionResolver = attributionResolver;
      this.logger = options?.logger;
      this.isTelemetryEnabledFn = undefined;
      this.minimumRecordTimestampMs = 0;
      this.coalesceDwellMs = OBSERVATION_UPLOAD_POLICY.windowMs;
      this.turnHintDwellMs = OBSERVATION_UPLOAD_POLICY.turnHintWindowMs;
      this.settledTurnMinIntervalMs = OBSERVATION_UPLOAD_POLICY.settledTurnMinIntervalMs;
      this.maxBatchSize = OBSERVATION_UPLOAD_POLICY.maxEvents;
      this.maxBatchBytes = OBSERVATION_UPLOAD_POLICY.maxBytes;
      this.telemetry = undefined;
      this.onSessionEvents = undefined;
      this.computationEvidenceRecorder = new ComputationEvidenceRecorder();
      this.toolLinkEvidenceRecorder = new ToolLinkEvidenceRecorder();
      this.workflowCallRecorder = new WorkflowCallRecorder();
    } else {
      this.pipeline = pipelineOrOptions.pipeline;
      this.observationClient =
        pipelineOrOptions.observationClient ?? pipelineOrOptions.cloudClient!;
      this.attributionResolver = pipelineOrOptions.attributionResolver;
      this.logger = pipelineOrOptions.logger;
      this.isTelemetryEnabledFn = pipelineOrOptions.isTelemetryEnabled;
      this.minimumRecordTimestampMs =
        z.number().safeParse(pipelineOrOptions.minimumRecordTimestampMs).data ?? 0;
      this.coalesceDwellMs =
        pipelineOrOptions.coalesceDwellMs !== undefined
          ? Math.max(0, pipelineOrOptions.coalesceDwellMs)
          : OBSERVATION_UPLOAD_POLICY.windowMs;
      this.turnHintDwellMs = Math.max(
        0,
        pipelineOrOptions.turnHintDwellMs ?? OBSERVATION_UPLOAD_POLICY.turnHintWindowMs,
      );
      this.settledTurnMinIntervalMs = Math.max(
        0,
        pipelineOrOptions.settledTurnMinIntervalMs ??
          OBSERVATION_UPLOAD_POLICY.settledTurnMinIntervalMs,
      );
      this.maxBatchSize = Math.max(
        1,
        pipelineOrOptions.maxBatchSize ?? OBSERVATION_UPLOAD_POLICY.maxEvents,
      );
      this.maxBatchBytes = Math.max(
        1,
        pipelineOrOptions.maxBatchBytes ?? OBSERVATION_UPLOAD_POLICY.maxBytes,
      );
      this.telemetry = pipelineOrOptions.telemetry;
      this.uploadStatus = pipelineOrOptions.uploadStatus;
      this.onPipelineResults = pipelineOrOptions.onPipelineResults;
      this.resolveHarnessVersion = pipelineOrOptions.resolveHarnessVersion;
      this.onSessionEvents = pipelineOrOptions.onSessionEvents;
      this.computationEvidenceRecorder =
        pipelineOrOptions.computationEvidenceRecorder ?? new ComputationEvidenceRecorder();
      this.toolLinkEvidenceRecorder =
        pipelineOrOptions.toolLinkEvidenceRecorder ?? new ToolLinkEvidenceRecorder();
      this.workflowCallRecorder =
        pipelineOrOptions.workflowCallRecorder ?? new WorkflowCallRecorder();
    }

    this.authorizeTelemetryEmissionFn = !(pipelineOrOptions instanceof NormalizationPipeline)
      ? pipelineOrOptions.authorizeTelemetryEmission
      : undefined;
    this.privateValueStore = !(pipelineOrOptions instanceof NormalizationPipeline)
      ? pipelineOrOptions.privateValueStore
      : undefined;
  }
  private getSessionBackoff(sessionId: string): ExponentialBackoff {
    let backoff = this.sessionBackoffs.get(sessionId);
    if (!backoff) {
      backoff = new ExponentialBackoff({
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        factor: 2,
        jitter: 0.2,
      });
      this.sessionBackoffs.set(sessionId, backoff);
    }
    return backoff;
  }

  private isTelemetryAllowed(generation = this.telemetryGeneration): boolean {
    if (!this.telemetryEnabled || generation !== this.telemetryGeneration) {
      return false;
    }
    if (!this.isTelemetryEnabledFn) {
      return true;
    }
    try {
      return this.isTelemetryEnabledFn() === true;
    } catch {
      return false;
    }
  }

  /**
   * Whether an event belongs to a program that introspects Resin or the agent harness (see
   * `isHarnessIntrospectionProgram`). Such a call, the result answering it and anything it produced
   * never reach a recorder, the local sink or the cloud: a tool learned from them describes the
   * observer, not the user's work. Classification reads the local original, never a redacted view.
   *
   * A result or edit whose call this process never saw (capture resumed after a restart) cannot be
   * paired, so it is dropped when its own text names Resin's tool namespace or harness home state.
   */
  private isHarnessIntrospection(event: NormalizedSessionEvent): boolean {
    let calls = this.harnessIntrospectionCalls.get(event.sessionId);
    if (calls === undefined) {
      calls = { dropped: new Set(), seen: new Set() };
      // Least recently used session state goes first, like the recorders' per-session state.
      if (this.harnessIntrospectionCalls.size >= MAX_HARNESS_INTROSPECTION_SESSIONS) {
        const oldest = this.harnessIntrospectionCalls.keys().next().value;
        if (oldest !== undefined) this.harnessIntrospectionCalls.delete(oldest);
      }
    } else {
      this.harnessIntrospectionCalls.delete(event.sessionId);
    }
    this.harnessIntrospectionCalls.set(event.sessionId, calls);
    const original = localWorkflowEvent(event) ?? event;

    if (original.type === "tool_result" || original.type === "file_edit") {
      const codex = readCodexCommandMetadata(original.metadata);
      const callIds = [
        original.type === "tool_result" ? original.callId : original.producedByCallId,
        codex?.kind === "result" ? codex.association?.callId : undefined,
      ].filter((callId): callId is string => callId !== undefined);
      if (callIds.some((callId) => calls.dropped.has(callId))) return true;
      if (callIds.some((callId) => calls.seen.has(callId))) return false;
      const text =
        original.type === "file_edit"
          ? `${original.filePath}\n${original.patch ?? ""}`
          : typeof original.result === "string"
            ? original.result
            : JSON.stringify(original.result ?? null);
      return referencesHarnessState(text);
    }
    if (original.type !== "tool_call" && original.type !== "command_exec") return false;

    // A PowerShell or cmd program Codex recorded running on Windows is read in its own grammar; a
    // PowerShell tool whose edition is unknown is read in the wider PowerShell 7 grammar.
    const windows =
      original.type === "command_exec" && Array.isArray(original.args)
        ? windowsShellInvocation(original.command, original.args)
        : undefined;
    const command = windows?.program ?? extractRawCommandStringFromEvent(original);
    const commandLanguage =
      windows?.dialect ??
      (original.type === "tool_call" &&
      ((original.toolName === "PowerShell" && original.connection === undefined) ||
        original.metadata?.[RESIN_LOCAL_SOURCE_INTERFACE_KEY] === "codex-unproven-shell")
        ? "pwsh"
        : "shell");
    const parameters = original.type === "tool_call" ? original.parameters : undefined;
    const language =
      typeof parameters?.language === "string" ? parameters.language.trim().toLowerCase() : "";
    const introspects =
      (original.type === "tool_call" &&
        isResinDiscoveryToolCall(original.toolName, original.connection)) ||
      (command !== null
        ? isHarnessIntrospectionProgram(command, commandLanguage)
        : typeof parameters?.code === "string" &&
          isHarnessIntrospectionProgram(
            parameters.code,
            language === "py" || language === "python" ? "python" : "javascript",
          ));
    const codex =
      original.type === "command_exec" ? readCodexCommandMetadata(original.metadata) : undefined;
    const callIds =
      original.type === "tool_call"
        ? [original.callId]
        : codex?.kind === "command"
          ? [codex.nativeId, ...(codex.association ? [codex.association.callId] : [])]
          : [];
    const record = introspects ? calls.dropped : calls.seen;
    for (const callId of callIds) {
      record.add(callId);
      if (record.size > MAX_HARNESS_INTROSPECTION_CALLS) {
        const oldest = record.values().next().value;
        if (oldest !== undefined) record.delete(oldest);
      }
    }
    return introspects;
  }

  private async isTelemetryAuthorized(
    generation = this.telemetryGeneration,
    recordTimestampMs: readonly number[] = [],
  ): Promise<boolean> {
    if (!this.isTelemetryAllowed(generation)) {
      return false;
    }
    if (!this.authorizeTelemetryEmissionFn) {
      return true;
    }
    try {
      const authorized = (await this.authorizeTelemetryEmissionFn(recordTimestampMs)) === true;
      return authorized && this.isTelemetryAllowed(generation);
    } catch {
      return false;
    }
  }

  private recordsAfterPrivacyCutoff(records: RawHarnessRecord[]): PrivacyCutoffRecordsResult {
    if (this.minimumRecordTimestampMs <= 0 && !this.authorizeTelemetryEmissionFn) {
      return { records, timestampMs: [] };
    }

    const authorizedRecords: RawHarnessRecord[] = [];
    const timestampMs: number[] = [];
    for (const record of records) {
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= this.minimumRecordTimestampMs) {
        continue;
      }
      authorizedRecords.push(record);
      timestampMs.push(timestamp);
    }
    return { records: authorizedRecords, timestampMs };
  }

  private acknowledgeBufferedAcks(acks: ReadonlyArray<() => Promise<void>>): void {
    void (async () => {
      for (const ack of acks) {
        await ack();
      }
    })().catch((err: unknown) => {
      this.logger?.error("Failed to acknowledge locally discarded observation records", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Advances the privacy cutoff monotonically and invalidates work that began before it.
   */
  public setPrivacyCutoff(cutoffMs: number): void {
    const normalizedCutoff = Number.isFinite(cutoffMs)
      ? Math.max(0, Math.trunc(cutoffMs))
      : Number.MAX_SAFE_INTEGER;
    if (normalizedCutoff <= this.minimumRecordTimestampMs) {
      return;
    }
    this.minimumRecordTimestampMs = normalizedCutoff;
    this.telemetryGeneration += 1;
    // Observed source state predates the new boundary: drop it so a helper or file body observed
    // before revocation can never be revived into later evidence.
    this.clearComputationEvidence();
    this.clearToolLinkEvidence();
    this.clearWorkflowCallEvidence();
    this.clearCommandSequenceEvidence();
    for (const buf of this.genericCoalescingBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      this.acknowledgeBufferedAcks(buf.acks);
    }
    this.genericCoalescingBuffers.clear();
    this.activeSessions.clear();
    this.activeGenericSessions.clear();
    this.genericSessions.clear();
    this.genericSessionTails.clear();
  }

  /**
   * Changes the local transmission gate synchronously so in-flight record handlers observe
   * consent withdrawal before they can reach an outbound client call.
   */
  public setTelemetryEnabled(enabled: boolean): void {
    const nextEnabled = enabled === true;
    if (nextEnabled === this.telemetryEnabled) {
      return;
    }
    this.telemetryEnabled = nextEnabled;
    this.telemetryGeneration += 1;
    if (!nextEnabled) {
      // Consent withdrawal is terminal for already-observed source state: nothing observed before
      // revocation may be revived into evidence if telemetry is later re-enabled.
      this.clearComputationEvidence();
      this.clearToolLinkEvidence();
      this.clearWorkflowCallEvidence();
      this.clearCommandSequenceEvidence();
      for (const buf of this.genericCoalescingBuffers.values()) {
        if (buf.timer) clearTimeout(buf.timer);
        this.acknowledgeBufferedAcks(buf.acks);
      }
      this.genericCoalescingBuffers.clear();
      this.activeSessions.clear();
      this.activeGenericSessions.clear();
      this.genericSessions.clear();
      this.genericSessionTails.clear();
    }
  }

  private async acknowledgeWithoutTelemetry(
    sessionId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    this.metadataEventProjector.clear(sessionId);
    const buffer = this.genericCoalescingBuffers.get(sessionId);
    if (buffer) {
      if (buffer.timer) clearTimeout(buffer.timer);
      this.genericCoalescingBuffers.delete(sessionId);
      for (const bufferedAck of buffer.acks) {
        await bufferedAck();
      }
    }
    this.activeSessions.delete(sessionId);
    this.activeGenericSessions.delete(sessionId);
    this.genericSessionTails.delete(sessionId);
    this.genericSessions.delete(sessionId);
    await ack();
  }

  /**
   * The adapter's session metadata, plus the harness version when the adapter reports none. The
   * pipeline stamps this onto every event so the cloud can attribute sessions per harness version.
   */
  private async sessionCustomMetadata(session: HarnessSession): Promise<JsonObject | undefined> {
    const base = JsonObjectSchema.safeParse(session.metadata).data;
    if (!this.resolveHarnessVersion || typeof base?.harnessVersion === "string") return base;
    const version = await this.resolveHarnessVersion(session.harnessId).catch(() => null);
    return version ? { ...base, harnessVersion: version } : base;
  }

  private observePipelineResults(
    session: HarnessSession,
    results: readonly PipelineProcessResult[],
  ): void {
    try {
      this.onPipelineResults?.(session, results);
    } catch {
      // Decode statistics are advisory; they must never affect capture.
    }
  }

  /**
   * Per-session serial lock to ensure records within the same session are processed in order
   * while allowing concurrent sessions to execute in parallel without cross-session blocking.
   */
  private async runSessionTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const { promise: current, resolve: release } = Promise.withResolvers<void>();
    this.sessionLocks.set(sessionId, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Record handler callback compatible with ObserverCoordinator.onRecords and TailerRecordHandler.
   */
  public readonly handleRecords: TailerRecordHandler = async (
    session: HarnessSession,
    records: RawHarnessRecord[],
    sourceAck: () => Promise<void>,
  ): Promise<void> => {
    const { sessionId } = session;
    if (records.length > 0) this.sessionActivityAtMs.set(sessionId, Date.now());
    // Aliases minted while processing this batch are persisted before the batch becomes durable
    // (cursor ack); uploads flush the same way before events leave the device.
    const ack = async () => {
      this.privateValueStore?.flush();
      await sourceAck();
    };
    const telemetryGeneration = this.telemetryGeneration;
    const { records: telemetryRecords, timestampMs: telemetryRecordTimestampMs } =
      this.recordsAfterPrivacyCutoff(records);

    await this.runSessionTask(sessionId, async () => {
      if (
        !this.isTelemetryAllowed(telemetryGeneration) ||
        (records.length > 0 && telemetryRecords.length === 0)
      ) {
        await this.acknowledgeWithoutTelemetry(sessionId, ack);
        return;
      }
      if (
        telemetryRecords.length > 0 &&
        !(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))
      ) {
        await this.acknowledgeWithoutTelemetry(sessionId, ack);
        return;
      }

      // Attributed observations are immutable. Generic conversations, however, can resume;
      // let their nonempty batches reach event-level deduplication rather than dropping them.
      const finalizedKind = this.finalizedSessions.get(sessionId);
      if (finalizedKind === "attributed" || (finalizedKind && telemetryRecords.length === 0)) {
        await ack();
        return;
      }

      // 2. Classify session as Attributed or Generic
      let emitter: TrajectoryEmitter | undefined;

      if (this.activeSessions.has(sessionId)) {
        emitter = this.activeSessions.get(sessionId)!;
      } else if (!this.activeGenericSessions.has(sessionId) && finalizedKind !== "generic") {
        // Resolve attribution once per session if not yet classified
        let rawContext: TrajectoryAttributionContextInput | null | undefined;
        try {
          if (this.attributionResolver instanceof Function) {
            rawContext = await this.attributionResolver(session);
          } else if (this.attributionResolver && "resolveAttribution" in this.attributionResolver) {
            rawContext = await this.attributionResolver.resolveAttribution(session);
          } else {
            rawContext = null;
          }
        } catch (err) {
          this.logger?.error(`Failed to resolve attribution for session ${sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // Resolution error -> do NOT ack, let error throw so tailer retries
          throw err;
        }

        if (rawContext) {
          const parsedContext = TrajectoryAttributionContextSchema.safeParse(rawContext);
          if (parsedContext.success) {
            try {
              emitter = createTrajectoryEmitter(parsedContext.data);
              this.activeSessions.set(sessionId, emitter);
            } catch (err) {
              this.logger?.warn(
                `Failed to construct TrajectoryEmitter for session ${sessionId}; falling back to generic observation submission`,
                { error: err instanceof Error ? err.message : String(err) },
              );
              this.genericSessions.add(sessionId);
              this.activeGenericSessions.add(sessionId);
            }
          } else {
            this.logger?.info(
              `Session ${sessionId} has invalid attribution context; falling back to generic observation submission`,
              { errors: parsedContext.error.issues.map((issue) => issue.message) },
            );
            this.genericSessions.add(sessionId);
            this.activeGenericSessions.add(sessionId);
          }
        } else {
          this.logger?.debug(
            `Session ${sessionId} has no trajectory attribution; processing as generic observation session`,
          );
          this.genericSessions.add(sessionId);
          this.activeGenericSessions.add(sessionId);
        }
      }

      // 3. Process records through NormalizationPipeline
      if (emitter) {
        // ATTRIBUTED SESSION PATH
        const ingestedEvents: NormalizedSessionEvent[] = [];
        if (telemetryRecords.length > 0) {
          const customMetadata = await this.sessionCustomMetadata(session);
          const pipelineContext: PipelineProcessContext = {
            sessionId: session.sessionId,
            harnessId: session.harnessId,
            workspaceId: session.workspaceId,
            customMetadata,
          };

          let pipelineResults: PipelineProcessResult[];
          try {
            pipelineResults = await this.pipeline.processBatch(telemetryRecords, pipelineContext);
            this.observePipelineResults(session, pipelineResults);
          } catch (err) {
            this.logger?.error(`Normalization pipeline failed for session ${sessionId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
          if (!this.isTelemetryAllowed(telemetryGeneration)) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }

          for (const res of pipelineResults) {
            if (res.status === "dead_letter" || (res.status === "success" && res.isDuplicate)) {
              continue;
            }
            if (res.event && !this.isHarnessIntrospection(res.event)) {
              try {
                // Bounded source evidence is produced after normalized ids/dedup and before both
                // the local sink and cloud projection, so the two surfaces carry identical carriers.
                const observed = this.computationEvidenceRecorder.observe(
                  this.toolLinkEvidenceRecorder.observe(
                    this.workflowCallRecorder.observe(res.event, {
                      workspaceId: session.workspaceId,
                    }),
                  ),
                );
                emitter.ingest(observed);
                ingestedEvents.push(this.metadataEventProjector.project(observed));
              } catch (err) {
                if (err instanceof TrajectoryAlreadyFinalizedError) {
                  break;
                }
                throw err;
              }
            }
          }
        }

        // A discovered terminal snapshot may still have unread source batches.
        // Infer completion from status only on the tailer's drained notification.
        if (records.length === 0 && !emitter.isFinalized()) {
          if (session.status === "completed") {
            emitter.finalize({ status: "success" });
          } else if (session.status === "failed") {
            emitter.finalize({ status: "failure" });
          } else if (session.status === "interrupted") {
            emitter.finalize({ status: "timeout" });
          }
        }

        if (emitter.isFinalized()) this.metadataEventProjector.endSession(sessionId);
        // Local consumers observe the same normalized events regardless of cloud submission outcome.
        await this.notifySessionEvents(session, ingestedEvents, emitter.isFinalized(), true);

        // If finalized, submit trajectory to Cloud
        if (emitter.isFinalized()) {
          if (
            !(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))
          ) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }
          const observation = emitter.getObservation() ?? emitter.finalize();
          try {
            this.privateValueStore?.flush();
            await this.observationClient.sendTrajectoryObservationBatch({
              observations: [observation],
            });
            this.uploadStatus?.recordSuccess(1);
            this.trajectoryResourceForbiddenRetries.delete(sessionId);
          } catch (err) {
            if (err instanceof ResourceForbiddenError) {
              const retries = (this.trajectoryResourceForbiddenRetries.get(sessionId) ?? 0) + 1;
              this.trajectoryResourceForbiddenRetries.set(sessionId, retries);
              const workspaceId = err.workspaceId ?? "unknown";

              if (retries < 3) {
                this.logger?.warn(
                  `Resource forbidden for workspace ${workspaceId} on trajectory session ${sessionId} (attempt ${retries}/3); will retry`,
                  {
                    sessionId,
                    workspaceId,
                    retries,
                    error: err.message,
                  },
                );
                throw err;
              }

              this.logger?.warn(
                `Resource forbidden for workspace ${workspaceId} on trajectory session ${sessionId}: max retries exceeded, dead-lettering batch`,
                {
                  sessionId,
                  workspaceId,
                  retries,
                  error: err.message,
                },
              );

              try {
                await this.pipeline.createAndSaveDeadLetter(
                  "trajectory_observation_batch",
                  { observations: [observation], workspaceId },
                  `Resource forbidden for workspace ${workspaceId}: ${err.message}`,
                );
              } catch (dlErr) {
                this.logger?.error(
                  `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
                );
              }

              this.trajectoryResourceForbiddenRetries.delete(sessionId);
              this.finalizedSessions.set(sessionId, "attributed");
              this.activeSessions.delete(sessionId);
              await ack();
              return;
            }

            const status = extractHttpStatus(err);
            const isTerminal4xx =
              typeof status === "number" &&
              status >= 400 &&
              status < 500 &&
              status !== 401 &&
              status !== 403 &&
              status !== 408 &&
              status !== 429;

            if (isTerminal4xx) {
              this.logger?.error(
                `Terminal failure submitting trajectory observation batch for session ${sessionId} with HTTP ${status}: dead-lettering batch`,
                {
                  sessionId,
                  status,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              try {
                await this.pipeline.createAndSaveDeadLetter(
                  "trajectory_observation_batch",
                  { observations: [observation] },
                  `Trajectory observation batch failed with HTTP ${status}: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch (dlErr) {
                this.logger?.error(
                  `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
                );
              }

              this.finalizedSessions.set(sessionId, "attributed");
              this.activeSessions.delete(sessionId);
              await ack();
              return;
            }

            this.logger?.error(
              `Failed to submit trajectory observation batch for session ${sessionId}`,
              { error: err instanceof Error ? err.message : String(err) },
            );
            throw err;
          }
          this.finalizedSessions.set(sessionId, "attributed");
          this.activeSessions.delete(sessionId);
        }

        if (!this.isTelemetryAllowed(telemetryGeneration)) {
          await this.acknowledgeWithoutTelemetry(sessionId, ack);
          return;
        }

        await ack();
      } else {
        // GENERIC SESSION PATH
        const validEvents: NormalizedSessionEvent[] = [];
        let latestTail = this.genericSessionTails.get(sessionId);

        const existingBuffer = this.genericCoalescingBuffers.get(sessionId);
        let hasExplicitTerminal = existingBuffer?.isTerminal ?? false;
        if (existingBuffer?.latestTail) {
          if (
            !latestTail ||
            existingBuffer.latestTail.causalSequence >= latestTail.causalSequence
          ) {
            latestTail = existingBuffer.latestTail;
          }
        }

        if (telemetryRecords.length > 0) {
          const customMetadata = await this.sessionCustomMetadata(session);
          const pipelineContext: PipelineProcessContext = {
            sessionId: session.sessionId,
            harnessId: session.harnessId,
            workspaceId: session.workspaceId,
            customMetadata,
            deferCommitUntilCloudAck: true,
          };

          let pipelineResults: PipelineProcessResult[];
          try {
            pipelineResults = await this.pipeline.processBatch(telemetryRecords, pipelineContext);
            this.observePipelineResults(session, pipelineResults);
          } catch (err) {
            this.logger?.error(`Normalization pipeline failed for generic session ${sessionId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }

          for (const res of pipelineResults) {
            if (res.status === "dead_letter") {
              continue;
            }
            if (res.status === "success" && res.event) {
              const ev = res.event;
              // A dropped event never becomes the tail a later synthetic event continues from.
              if (this.isHarnessIntrospection(ev)) continue;
              const seq = ev.causalRef?.causalSequence ?? 0;
              const stepIndex = ev.causalRef?.stepIndex ?? 0;
              if (
                !latestTail ||
                seq > latestTail.causalSequence ||
                (seq === latestTail.causalSequence && stepIndex >= latestTail.stepIndex)
              ) {
                latestTail = { eventId: ev.eventId, causalSequence: seq, stepIndex };
                // A later source event can resume a conversation after an explicit end,
                // including when the old end is redelivered in the same batch.
                hasExplicitTerminal =
                  ev.type === "session_lifecycle" &&
                  (ev.lifecycleType === "end" || ev.lifecycleType === "crash");
              }
              if (!res.isDuplicate) {
                // Same post-dedup hook as the attributed path: local sink and cloud batch project
                // the identical carrier-bearing event.
                validEvents.push(
                  this.computationEvidenceRecorder.observe(
                    this.toolLinkEvidenceRecorder.observe(
                      this.workflowCallRecorder.observe(ev, {
                        workspaceId: session.workspaceId,
                      }),
                    ),
                  ),
                );
              }
            }
          }
        }

        if (!this.isTelemetryAllowed(telemetryGeneration)) {
          await this.acknowledgeWithoutTelemetry(sessionId, ack);
          return;
        }
        const projectedEvents = validEvents.map((event) =>
          this.metadataEventProjector.project(event),
        );

        const isTerminalStatus =
          records.length === 0 &&
          (session.status === "completed" ||
            session.status === "failed" ||
            session.status === "interrupted");

        if (isTerminalStatus && !hasExplicitTerminal && latestTail) {
          const syntheticEvent = this.createSyntheticTerminalEvent(session, latestTail);
          validEvents.push(syntheticEvent);
          projectedEvents.push(this.metadataEventProjector.project(syntheticEvent));
          latestTail = {
            eventId: syntheticEvent.eventId,
            causalSequence: syntheticEvent.causalRef.causalSequence,
            stepIndex: syntheticEvent.causalRef.stepIndex ?? 0,
          };
        }

        const isTerminal = isTerminalStatus || hasExplicitTerminal;
        if (isTerminal) this.metadataEventProjector.endSession(sessionId);

        if (validEvents.length === 0 && !existingBuffer) {
          if (!this.isTelemetryAllowed(telemetryGeneration)) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }
          if (isTerminal) {
            this.finalizedSessions.set(sessionId, "generic");
            this.activeGenericSessions.delete(sessionId);
            this.genericSessionTails.delete(sessionId);
          }
          await ack();
          return;
        }

        if (validEvents.length > 0) {
          this.finalizedSessions.delete(sessionId);
          this.activeGenericSessions.add(sessionId);
          this.genericSessions.add(sessionId);
        }

        let buffer = existingBuffer;
        if (!buffer) {
          buffer = {
            sessionId,
            session,
            validEvents: [],
            projectedEvents: [],
            acks: [],
            timer: null,
            flushDueAtMs: null,
            timerKind: null,
            projectedBytes: 0,
            telemetryRecordTimestampMs: [],
            latestTail,
            isTerminal: false,
          };
          this.genericCoalescingBuffers.set(sessionId, buffer);
        }

        buffer.session = session;
        buffer.validEvents.push(...validEvents);
        buffer.projectedEvents.push(...projectedEvents);
        for (const event of projectedEvents) {
          buffer.projectedBytes += serializedByteLength(event);
        }
        buffer.acks.push(ack);
        buffer.telemetryRecordTimestampMs.push(...telemetryRecordTimestampMs);
        if (latestTail) {
          buffer.latestTail = latestTail;
        }
        if (isTerminal || validEvents.length > 0) {
          buffer.isTerminal = isTerminal;
        }

        // Session end and terminal lifecycle events send now; a settled turn only shortens the
        // window (see OBSERVATION_UPLOAD_POLICY).
        const isTerminalSignal =
          buffer.isTerminal || this.isTerminalSignal(session, validEvents, hasExplicitTerminal);
        const reachedMaxSize =
          buffer.validEvents.length >= this.maxBatchSize ||
          buffer.acks.length >=
            Math.min(this.maxBatchSize, OBSERVATION_UPLOAD_POLICY.maxPendingDeliveries) ||
          buffer.projectedBytes >= this.maxBatchBytes;
        const shouldFlushImmediately =
          this.coalesceDwellMs === 0 || isTerminalSignal || reachedMaxSize;

        if (shouldFlushImmediately) {
          try {
            await this.flushGenericSession(sessionId);
          } catch (err) {
            if (err instanceof AuthRecoveryError) {
              throw err;
            }
            if (this.coalesceDwellMs === 0) {
              throw err;
            }
            const nextDelay = Math.min(60_000, this.getSessionBackoff(sessionId).nextDelay());
            this.scheduleGenericFlush(sessionId, buffer, "retry", nextDelay);
          }
        } else {
          this.scheduleGenericFlush(sessionId, buffer, "window", this.coalesceDwellMs);
          if (this.isSettledTurn(records, validEvents)) {
            this.shortenGenericFlushWindow(
              sessionId,
              buffer,
              this.settledTurnRemainingMs(sessionId),
            );
          }
        }
      }
    });
  };

  /**
   * Attaches or detaches the local-only normalized event sink.
   *
   * Local consumers must never break capture, so sink failures are logged and swallowed.
   */
  public setSessionEventSink(sink?: SessionEventSink): void {
    this.onSessionEvents = sink;
  }

  private async notifySessionEvents(
    session: HarnessSession,
    events: readonly NormalizedSessionEvent[],
    isTerminal: boolean,
    isAttributed: boolean,
  ): Promise<void> {
    if (!this.onSessionEvents || events.length === 0) {
      return;
    }
    try {
      this.privateValueStore?.flush();
      await this.onSessionEvents(
        session,
        events.map((event) => structuredClone(event)),
        { isTerminal, isAttributed },
      );
    } catch (err) {
      // Local consumers must never break capture or cloud submission.
      this.logger?.warn(`Local session event sink failed for session ${session.sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Session end or a terminal lifecycle event: the batch is sent without waiting. */
  private isTerminalSignal(
    session: HarnessSession,
    events: readonly NormalizedSessionEvent[],
    hasExplicitTerminal: boolean,
  ): boolean {
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "interrupted" ||
      hasExplicitTerminal
    ) {
      return true;
    }
    return events.some(
      (ev) =>
        ev.type === "session_lifecycle" &&
        (ev.lifecycleType === "end" || ev.lifecycleType === "crash"),
    );
  }

  /**
   * A settled turn: the delivery ends with an assistant reply that requests no tool call, so the
   * agent is waiting on the user. That is what the cloud's detection gate needs promptly, so it
   * shortens the window; an assistant step that requests tools keeps the full window because the
   * agent carries on. Tool calls requested by the same source record share its causal sequence.
   */
  private isSettledTurn(
    records: readonly RawHarnessRecord[],
    events: readonly NormalizedSessionEvent[],
  ): boolean {
    let lastToolCallSequence = Number.NEGATIVE_INFINITY;
    for (const ev of events) {
      if (ev.type === "tool_call") {
        lastToolCallSequence = Math.max(lastToolCallSequence, ev.causalRef.causalSequence);
      }
    }
    if (
      events.some(
        (ev) =>
          ev.type === "message" &&
          ev.role === "assistant" &&
          ev.causalRef.causalSequence > lastToolCallSequence,
      )
    ) {
      return true;
    }
    // Record-level completion markers carry no call detail; trust them only when this delivery
    // requested no tool at all.
    if (lastToolCallSequence !== Number.NEGATIVE_INFINITY) {
      return false;
    }
    return records.some((record) => {
      if (record.recordType === "completion") {
        return true;
      }
      const rawPayload = record.rawPayload;
      if (!rawPayload || typeof rawPayload !== "object") {
        return false;
      }
      return (
        ("type" in rawPayload && rawPayload.type === "completion") ||
        ("role" in rawPayload && rawPayload.role === "assistant")
      );
    });
  }

  private scheduleGenericFlush(
    sessionId: string,
    buffer: GenericCoalescingBuffer,
    kind: "window" | "retry",
    delayMs: number,
  ): void {
    if (buffer.timer || this.coalesceDwellMs === 0) {
      return;
    }
    buffer.flushDueAtMs = Date.now() + delayMs;
    buffer.timerKind = kind;
    buffer.timer = setTimeout(() => {
      void this.runSessionTask(sessionId, async () => {
        try {
          await this.flushGenericSession(sessionId);
        } catch (err) {
          this.logger?.error(`Deferred flush failed for generic session ${sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          const retryBuffer = this.genericCoalescingBuffers.get(sessionId);
          if (retryBuffer) {
            const nextDelay = Math.min(60_000, this.getSessionBackoff(sessionId).nextDelay());
            this.scheduleGenericFlush(sessionId, retryBuffer, "retry", nextDelay);
          }
        }
      });
    }, delayMs);
  }

  /**
   * How soon a settled turn may send: within `turnHintDwellMs`, but not sooner than
   * `settledTurnMinIntervalMs` after the session's previous send, so assistant text written
   * between tool calls, or a quick reply from the user, shares the next upload instead of
   * sending one per message. It only ever shortens the window, never lengthens it.
   */
  private settledTurnRemainingMs(sessionId: string): number {
    const lastSendAtMs = this.genericLastSendAtMs.get(sessionId);
    if (lastSendAtMs === undefined) {
      return this.turnHintDwellMs;
    }
    return Math.max(
      this.turnHintDwellMs,
      lastSendAtMs + this.settledTurnMinIntervalMs - Date.now(),
    );
  }

  /** Remembers a session's send time; entries that can no longer delay a send are dropped. */
  private recordGenericSend(sessionId: string, isTerminal: boolean): void {
    const nowMs = Date.now();
    for (const [trackedSessionId, atMs] of this.genericLastSendAtMs) {
      if (nowMs - atMs >= this.settledTurnMinIntervalMs) {
        this.genericLastSendAtMs.delete(trackedSessionId);
      }
    }
    if (isTerminal || this.settledTurnMinIntervalMs === 0) {
      this.genericLastSendAtMs.delete(sessionId);
    } else {
      this.genericLastSendAtMs.set(sessionId, nowMs);
    }
  }

  /**
   * Pulls a pending window timer forward so it fires within `maxRemainingMs`. Retry timers keep
   * their backoff.
   */
  private shortenGenericFlushWindow(
    sessionId: string,
    buffer: GenericCoalescingBuffer,
    maxRemainingMs: number,
  ): void {
    if (!buffer.timer || buffer.timerKind !== "window" || buffer.flushDueAtMs === null) {
      return;
    }
    if (buffer.flushDueAtMs - Date.now() <= maxRemainingMs) {
      return;
    }
    clearTimeout(buffer.timer);
    buffer.timer = null;
    this.scheduleGenericFlush(sessionId, buffer, "window", maxRemainingMs);
  }

  private async flushGenericSession(sessionId: string): Promise<void> {
    const buffer = this.genericCoalescingBuffers.get(sessionId);
    if (!buffer) {
      return;
    }
    clearTimeout(buffer.timer ?? undefined);
    buffer.timer = null;
    buffer.flushDueAtMs = null;
    buffer.timerKind = null;
    this.genericCoalescingBuffers.delete(sessionId);

    const { validEvents, acks, telemetryRecordTimestampMs } = buffer;

    if (validEvents.length === 0) {
      for (const ack of acks) {
        await ack();
      }
      return;
    }

    const telemetryGeneration = this.telemetryGeneration;
    if (!this.isTelemetryAllowed(telemetryGeneration)) {
      this.metadataEventProjector.clear(sessionId);
      this.genericSessionTails.delete(sessionId);
      this.activeGenericSessions.delete(sessionId);
      this.genericSessions.delete(sessionId);
      for (const ack of acks) {
        await ack();
      }
      return;
    }

    if (!(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))) {
      this.metadataEventProjector.clear(sessionId);
      this.genericSessionTails.delete(sessionId);
      this.activeGenericSessions.delete(sessionId);
      this.genericSessions.delete(sessionId);
      for (const ack of acks) {
        await ack();
      }
      return;
    }

    // A lifecycle event's workspaceId is this daemon's local workspace identifier (for example
    // ws_codex_<root>_<hash>), which the cloud has never seen: uploads are addressed to the paired
    // cloud workspace, and forwarding the local id makes cloud detection attribute the session to
    // another workspace and drop its evidence. Local consumers keep it.
    const projectedEvents = buffer.projectedEvents.map(withoutLocalWorkspaceId);
    // Cloud ingestion rejects batches whose consecutive event timestamps regress by
    // more than 1000ms (CURSOR_ORDERING_ERROR). Transcript records can arrive out of
    // order, and records missing a timestamp fall back to a wall-clock stamp, so sort
    // the wire payload by event time. Local consumers keep ingestion order via
    // buffer.projectedEvents; only the uploaded batch is reordered.
    projectedEvents.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    // Local consumers observe the same normalized events regardless of cloud submission outcome.
    await this.notifySessionEvents(
      buffer.session,
      buffer.projectedEvents,
      buffer.isTerminal,
      false,
    );
    // Local consumers may yield while consent or the cutoff changes. A projected completion
    // retained by this in-flight flush must not cross that privacy boundary, even after re-enable.
    if (!this.isTelemetryAllowed(telemetryGeneration)) {
      for (const ack of acks) {
        await this.acknowledgeWithoutTelemetry(sessionId, ack);
      }
      return;
    }
    const sessionKey = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const chunkBatchId = (chunk: readonly NormalizedSessionEvent[]): string => {
      const firstSeq = chunk[0]?.causalRef.causalSequence ?? 0;
      const batchDigest = createHash("sha256")
        .update(chunk.map((event) => event.eventId).join("\0"))
        .digest("hex")
        .slice(0, 16);
      return `obs_${batchDigest}_${sessionKey}_${firstSeq}`.slice(0, 128);
    };
    let batchId = chunkBatchId(projectedEvents);

    try {
      // A buffer can outgrow what one request may carry: a large read batch, or records that kept
      // arriving while an earlier failed flush was being retried. Cloud ingestion refuses a batch
      // above its per-batch event or byte limit, and no retry can satisfy that, so the buffer is
      // sent in bounded chunks, in event order, and acknowledged only after every chunk is accepted.
      for (const chunk of chunkObservationsForUpload(projectedEvents, buffer.projectedBytes)) {
        batchId = chunkBatchId(chunk);
        this.privateValueStore?.flush();
        const receipt = await this.observationClient.sendObservationBatch({
          batchId,
          observations: chunk,
        });
        this.uploadStatus?.recordSuccess(chunk.length);
        if (receipt?.acceptedCount > 0) {
          this.totalGenericBatchesAccepted++;
          this.totalGenericObservationsAccepted += receipt.acceptedCount;
        }
      }
      await this.pipeline.commitCloudAcknowledgedEvents(validEvents);
      this.sessionBackoffs.delete(sessionId);
      this.genericResourceForbiddenRetries.delete(sessionId);
      this.recordGenericSend(sessionId, buffer.isTerminal);
    } catch (err) {
      if (err instanceof ResourceForbiddenError) {
        const retries = (this.genericResourceForbiddenRetries.get(sessionId) ?? 0) + 1;
        this.genericResourceForbiddenRetries.set(sessionId, retries);
        const workspaceId = err.workspaceId ?? "unknown";

        if (retries < 3) {
          this.logger?.warn(
            `Resource forbidden for workspace ${workspaceId} on session ${sessionId} (attempt ${retries}/3); will retry`,
            {
              sessionId,
              workspaceId,
              batchId,
              retries,
              error: err.message,
            },
          );
          this.genericCoalescingBuffers.set(sessionId, buffer);
          throw err;
        }

        this.logger?.warn(
          `Resource forbidden for workspace ${workspaceId} on session ${sessionId}: max retries exceeded, dead-lettering observation batch`,
          {
            sessionId,
            workspaceId,
            batchId,
            retries,
            error: err.message,
          },
        );

        try {
          await this.pipeline.createAndSaveDeadLetter(
            "observation_batch",
            { batchId, workspaceId, observations: projectedEvents },
            `Resource forbidden for workspace ${workspaceId}: ${err.message}`,
          );
        } catch (dlErr) {
          this.logger?.error(
            `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
          );
        }

        this.genericResourceForbiddenRetries.delete(sessionId);
        this.sessionBackoffs.delete(sessionId);
        this.recordBatchTelemetry(projectedEvents.length);

        if (buffer.latestTail) {
          this.genericSessionTails.set(sessionId, buffer.latestTail);
        }

        if (buffer.isTerminal) {
          this.finalizedSessions.set(sessionId, "generic");
          this.activeGenericSessions.delete(sessionId);
          this.genericSessionTails.delete(sessionId);
        }

        for (const ack of acks) {
          await ack();
        }

        return;
      }
      const status = extractHttpStatus(err);
      const isTerminal4xx =
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 401 &&
        status !== 403 &&
        status !== 408 &&
        status !== 429;

      if (isTerminal4xx) {
        this.logger?.error(
          `Terminal failure submitting observation batch for generic session ${sessionId} with HTTP ${status}: dead-lettering batch`,
          {
            sessionId,
            status,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        try {
          await this.pipeline.createAndSaveDeadLetter(
            "observation_batch",
            { batchId, observations: projectedEvents },
            `Observation batch failed with HTTP ${status}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch (dlErr) {
          this.logger?.error(
            `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
          );
        }

        this.sessionBackoffs.delete(sessionId);

        this.recordBatchTelemetry(projectedEvents.length);

        if (buffer.latestTail) {
          this.genericSessionTails.set(sessionId, buffer.latestTail);
        }

        if (buffer.isTerminal) {
          this.finalizedSessions.set(sessionId, "generic");
          this.activeGenericSessions.delete(sessionId);
          this.genericSessionTails.delete(sessionId);
        }

        for (const ack of acks) {
          await ack();
        }

        return;
      }

      this.logger?.error(`Failed to submit observation batch for generic session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!(err instanceof AuthRecoveryError)) {
        this.genericCoalescingBuffers.set(sessionId, buffer);
      }
      throw err;
    }

    this.recordBatchTelemetry(projectedEvents.length);

    if (buffer.latestTail) {
      this.genericSessionTails.set(sessionId, buffer.latestTail);
    }

    if (buffer.isTerminal) {
      this.finalizedSessions.set(sessionId, "generic");
      this.activeGenericSessions.delete(sessionId);
      this.genericSessionTails.delete(sessionId);
    }

    for (const ack of acks) {
      await ack();
    }
  }

  private async flushAllGenericBuffers(): Promise<void> {
    const sessionIds = Array.from(this.genericCoalescingBuffers.keys());
    for (const sessionId of sessionIds) {
      await this.runSessionTask(sessionId, async () => {
        await this.flushGenericSession(sessionId);
      });
    }
  }

  /**
   * Flushes any in-flight coalesced generic observation buffers immediately.
   */
  public async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.runSessionTask(sessionId, async () => {
        await this.flushGenericSession(sessionId);
      });
    } else {
      await this.flushAllGenericBuffers();
    }
  }

  /**
   * Sends a session's buffered batch on the next tick instead of at the end of its window, e.g.
   * when the tailer is draining a session that ended. A batch backing off after a failed send
   * keeps its retry delay, and a failure here retries exactly like a window flush.
   */
  public expediteFlush(sessionId: string): void {
    const buffer = this.genericCoalescingBuffers.get(sessionId);
    if (buffer) {
      this.shortenGenericFlushWindow(sessionId, buffer, 0);
    }
  }

  private recordBatchTelemetry(batchSize: number): void {
    this.totalGenericBatchesUploaded++;
    this.totalGenericObservationsUploaded += batchSize;
    this.lastGenericBatchSize = batchSize;

    if (this.telemetry) {
      this.telemetry.incrementCounter("observer.batches.generic.uploaded", 1);
      this.telemetry.incrementCounter("observer.batches.generic.observations_uploaded", batchSize);
      this.telemetry.setGauge("observer.batches.generic.last_size", batchSize);
    }
  }

  /**
   * Returns current generic batching telemetry metrics.
   */
  public getBatchMetrics(): {
    totalBatchesUploaded: number;
    totalObservationsUploaded: number;
    lastBatchSize: number;
    totalBatchesAccepted: number;
    totalObservationsAccepted: number;
  } {
    return {
      totalBatchesUploaded: this.totalGenericBatchesUploaded,
      totalObservationsUploaded: this.totalGenericObservationsUploaded,
      lastBatchSize: this.lastGenericBatchSize,
      totalBatchesAccepted: this.totalGenericBatchesAccepted,
      totalObservationsAccepted: this.totalGenericObservationsAccepted,
    };
  }

  /**
   * Waits for every session handler already admitted through the tailer boundary to settle,
   * flushing any pending generic coalescing buffers.
   */
  public async waitForIdle(): Promise<void> {
    await Promise.all(Array.from(this.sessionLocks.values()));
    await this.flushAllGenericBuffers();
  }

  /**
   * Clears bounded observed-source evidence without detaching local session event subscribers.
   *
   * Restartable capture stops and telemetry-boundary changes must discard retained source state
   * while preserving in-process consumers that are expected to survive a stop/start cycle.
   */
  public clearComputationEvidence(): void {
    this.computationEvidenceRecorder.clear();
  }

  /** Clears per-session workflow carrier state (discovery providers) without detaching. */
  public clearWorkflowCallEvidence(): void {
    this.workflowCallRecorder.clear();
  }
  /** Clears bounded declared data-flow state (scopes, pending calls, ordinals) without detaching. */
  public clearToolLinkEvidence(): void {
    this.toolLinkEvidenceRecorder.clear();
  }

  /** Clears bounded command pairing and retry metadata without detaching the local sink. */
  public clearCommandSequenceEvidence(): void {
    this.metadataEventProjector.clear();
  }

  /**
   * Releases bounded observed-source state and the local sink. Terminal disposal keeps the
   * historical teardown behavior: retained source is cleared and session-event subscribers are
   * detached.
   */
  public dispose(): void {
    this.clearComputationEvidence();
    this.clearToolLinkEvidence();
    this.clearWorkflowCallEvidence();
    this.clearCommandSequenceEvidence();
    this.onSessionEvents = undefined;
  }

  /**
   * Tracked sessions that recorded something within {@link ACTIVE_SESSION_IDLE_MS}: the sessions
   * doing work now. Entries idle past the window are dropped here, which keeps the map bounded.
   */
  public getActiveSessionCount(nowMs = Date.now()): number {
    let active = 0;
    for (const [sessionId, atMs] of this.sessionActivityAtMs) {
      if (nowMs - atMs > ACTIVE_SESSION_IDLE_MS) {
        this.sessionActivityAtMs.delete(sessionId);
      } else if (this.activeSessions.has(sessionId) || this.activeGenericSessions.has(sessionId)) {
        active += 1;
      }
    }
    return active;
  }

  /**
   * Returns the count of finalized and submitted sessions.
   */
  public getFinalizedSessionCount(): number {
    return this.finalizedSessions.size;
  }

  /**
   * Returns the count of unattributed discarded sessions.
   */
  public getUnattributedSessionCount(): number {
    return 0;
  }

  /**
   * Returns the count of generic (non-attributed) sessions processed.
   */
  public getGenericSessionCount(): number {
    return this.genericSessions.size;
  }

  /**
   * Whether a session is currently active and accumulating events.
   */
  public hasActiveSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) || this.activeGenericSessions.has(sessionId);
  }

  /**
   * Whether a session has been finalized and submitted.
   */
  public isSessionFinalized(sessionId: string): boolean {
    return this.finalizedSessions.has(sessionId);
  }

  /**
   * Whether a session has no trajectory attribution (processed as generic observations).
   */
  public isSessionUnattributed(sessionId: string): boolean {
    return this.genericSessions.has(sessionId);
  }

  /**
   * Retrieves the active emitter for a session if currently in-flight.
   */
  public getActiveEmitter(sessionId: string): TrajectoryEmitter | undefined {
    return this.activeSessions.get(sessionId);
  }
  private createSyntheticTerminalEvent(
    session: HarnessSession,
    tail: GenericSessionTail,
  ): NormalizedSessionEvent {
    // Completion is derived from the last observed record, not a new source record.
    // Reserving the next sequence would collide with a resumed conversation's first row.
    const causalSequence = tail.causalSequence;
    const parentId = tail.eventId;

    const lifecycleType: "end" | "crash" = session.status === "failed" ? "crash" : "end";
    const exitReason =
      session.status === "completed"
        ? "completed"
        : session.status === "failed"
          ? "failed"
          : "interrupted";

    const timestamp = session.updatedAt;

    const payloadForHash = {
      schemaVersion: "1.0.0",
      sessionId: session.sessionId,
      type: "session_lifecycle" as const,
      lifecycleType,
      exitReason,
      timestamp,
      causalRef: {
        parentId,
        causalSequence,
        stepIndex: tail.stepIndex + 1,
      },
      redaction: {
        isRedacted: true,
        redactedFields: [],
        redactionStrategy: "drop" as const,
        scrubbedPatterns: [],
        redactedAt: timestamp,
      },
      metadata: {},
      ...(typeof session.harnessId === "string" && session.harnessId.length > 0
        ? { harnessName: session.harnessId }
        : {}),
      ...(typeof session.workspaceId === "string" && session.workspaceId.length > 0
        ? { workspaceId: session.workspaceId }
        : {}),
    };

    const eventId = generateDeterministicEventId(session.sessionId, causalSequence, payloadForHash);

    const event: NormalizedSessionEvent = {
      ...payloadForHash,
      eventId,
    };

    return NormalizedSessionEventSchema.parse(event);
  }
}
