import { RESIN_LOCAL_OMP_NATIVE_CALL_KEY } from "@resin/adapter-omp";
import {
  COMPUTATION_IR_LIMITS,
  type ComputationCorrectionV1,
  type ComputationDependencyV1,
  type ComputationLanguage,
  type ComputationObservationKind,
  type ComputationObservationV1,
  type ComputationOriginKind,
  type ComputationProgramV1,
  MAX_WORKFLOW_PYTHON_SETUP_CELLS,
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  type WorkflowPythonState,
  computeComputationEvidenceDigest,
  computeComputationProgramDigest,
  hashCanonicalContent,
  readComputationEvidence,
} from "@resin/contracts";
import { RESIN_WORKFLOW_CALL_METADATA_KEY, readWorkflowCallCarrier } from "../workflow-carrier.js";
import { parseJavaScriptComputation } from "./javascript.js";
import { parsePythonComputation } from "./python.js";
import { extractComputationSourceFrames } from "./source-frames.js";
import type {
  ComputationExecutionScope,
  ComputationFileAction,
  ComputationParseContext,
  ComputationParseLocal,
  ComputationParseResult,
  ComputationSourceFrame,
  LocalComputationDefinition,
  LocalComputationDefinitionBinding,
  LocalComputationImport,
  LocalComputationModule,
} from "./types.js";

function withoutLocalNativeArguments(event: NormalizedSessionEvent): NormalizedSessionEvent {
  if (
    !Object.prototype.hasOwnProperty.call(event.metadata ?? {}, RESIN_LOCAL_OMP_NATIVE_CALL_KEY)
  ) {
    return event;
  }
  const metadata = { ...event.metadata };
  delete metadata[RESIN_LOCAL_OMP_NATIVE_CALL_KEY];
  return { ...event, metadata } as NormalizedSessionEvent;
}
function pythonSourceReferenceOf(event: NormalizedSessionEvent): string | undefined {
  if (event.type !== "tool_call") {
    return undefined;
  }
  const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
  const program = carrier?.program;
  if (program?.kind !== "python" || program.argument === undefined) {
    return undefined;
  }
  const origin = carrier?.origins[program.argument];
  return origin?.type === "private" ? origin.reference : undefined;
}

/**
 * Session source recorder: turns observed native tool traffic into bounded, privacy-safe computation
 * evidence carriers attached to the *same* normalized event that the local sink and the cloud
 * projection both consume.
 *
 * Invariants enforced here rather than by callers:
 *  - The hook runs after normalized ids/dedup, so an event id is seen at most once per logical event;
 *    an identical replay is idempotent and never doubles cached state or emits a second carrier.
 *  - A pending call and its matching success closure are distinct snapshots. The call carrier holds
 *    bounded pending evidence; only a causally matched, successful result commits definitions,
 *    imports and known file bodies and receives success evidence. An already-emitted call event
 *    object is never mutated.
 *  - Resolution uses ONLY in-memory observed state. Persistent eval kernels share definitions per
 *    session+language; a shell interpreter process shares nothing; a file write or read body is an
 *    observation (definition-only evidence). No disk access, no subprocess, no crawling.
 *  - Every cache is bounded and fail-closed: eviction and reset invalidate rather than revive, a
 *    correction replaces the prior version of a helper, and a helper that cannot be resolved from
 *    observed state is left unresolved instead of being guessed.
 */

/** Sessions that retain kernel/file/pending state before the oldest is evicted. */
const MAX_SESSIONS = 32;
/** Unresolved code calls retained recorder-wide before the oldest is evicted. */
const MAX_PENDING_CALLS = 64;
/** Pinned per-source-frame byte cap; a larger frame is discarded unparsed. */
const MAX_FRAME_BYTES = 262_144;
/** Pinned total retained private source bytes across every session. */
const MAX_RETAINED_SOURCE_BYTES = 8_388_608;
/** Definitions retained per session+language kernel (the pinned definition limit). */
const MAX_KERNEL_DEFINITIONS = COMPUTATION_IR_LIMITS.definitions;
/** Known file bodies retained per session. */
const MAX_KNOWN_FILES = 32;
/** Superseded-version records retained per kernel; only their digests survive. */
const MAX_SUPERSESSIONS = COMPUTATION_IR_LIMITS.dependencies;
/** Consumed call identities retained per session, for replay safety. */
const MAX_CONSUMED_CALLS = 4096;
/** Distinct event identities memoized recorder-wide, so an identical replay stays idempotent. */
const MAX_REPLAY_EVENTS = 512;
/** Dependency/correction entries emitted per carrier (the pinned envelope limits). */
const MAX_EMITTED_ENTRIES = COMPUTATION_IR_LIMITS.dependencies;
interface CachedDefinition {
  name: string;
  /** Private source text, required to re-resolve this helper for a later cell. */
  source: string;
  /** Parser-reported reference and binding names, reused verbatim when re-resolving. */
  references: string[];
  writtenNames: string[];
  sourceEventId: string;
  /** The original native call that authored this helper, kept private for Python setup closure. */
  callId?: string;
  /** Matching successful result event, kept private for Python setup closure. */
  resultEventId?: string;
  /** Existing local immutable source reference, never raw source. */
  sourceReference?: string;
  /** Digest of the evidence program in which this version was observed. */
  programDigest: string;
  bytes: number;
}

interface CachedFile {
  module: LocalComputationModule;
  bytes: number;
}

interface Supersession {
  nameKey: string;
  supersededDigest: string;
  replacingDigest: string;
}

/** One successful persistent Python cell, retained only as private closure bookkeeping. */
interface PythonCell {
  callId: string;
  sourceEventId: string;
  resultEventId: string;
  sourceReference: string;
  requiredNames: string[];
  writtenNames: string[];
  order: number;
}

interface PythonKernelState {
  /** Incremented on reset/uncertain mutation; cells never cross an epoch. */
  epoch: number;
  cells: Map<string, PythonCell>;
  /** Latest successful cell that established each module-level name. */
  bindings: Map<string, PythonCell>;
}

interface KernelState {
  /** Current version per helper name; a correction replaces rather than appends. */
  definitions: Map<string, CachedDefinition>;
  /** Recognized imports authored in this kernel, keyed by their normalized source text. */
  imports: Map<string, LocalComputationImport>;
  supersessions: Supersession[];
  /** Python-only replay bookkeeping; absent for JavaScript/TypeScript kernels. */
  python?: PythonKernelState;
}

interface PendingCall {
  callId: string;
  callEventId: string;
  toolName: string;
  callSequence: number;
  order: number;
  /** Minimal read framing only; never retain the original tool arguments or result. */
  readPath?: string;
  /** Retain a known kernel identity even when its body cannot produce a prepared frame. */
  language?: ComputationLanguage;
  prepared?: PreparedFrame;
  /** Retained frame source bytes this pending call contributes to the session budget. */
  retainedBytes: number;
  /** Existing local immutable source reference for a Python program argument. */
  pythonSourceReference?: string;
}

interface PreparedFrame {
  language: ComputationLanguage;
  originKind: ComputationOriginKind;
  executionScope: ComputationExecutionScope;
  fileAction?: ComputationFileAction;
  path?: string;
  pathPattern?: string;
  sourceEventId: string;
  /** Private frame source, retained only for the duration of this call's evidence. */
  source: string;
  program: ComputationProgramV1;
  /** Canonical algorithm identity of this frame's program, computed once per frame. */
  programDigest: string;
  local: ComputationParseLocal;
  bindings?: readonly LocalComputationDefinitionBinding[];
  metrics: { sourceLines: number; sourceBytes: number };
  observationKind: ComputationObservationKind;
}

interface RecordedSession {
  sessionId: string;
  touch: number;
  kernels: Map<ComputationLanguage, KernelState>;
  files: Map<string, CachedFile>;
  pending: Map<string, PendingCall>;
  consumedSet: Set<string>;
  retainedBytes: number;
  pairingDisabled: boolean;
}

export interface ComputationEvidenceRecorderOptions {
  /** Guard overrides; tests use these to exercise eviction and retention deterministically. */
  maxSessions?: number;
  maxPendingCalls?: number;
  maxFrameBytes?: number;
  maxRetainedSourceBytes?: number;
}

export class ComputationEvidenceRecorder {
  private readonly maxSessions: number;
  private readonly maxPendingCalls: number;
  private readonly maxFrameBytes: number;
  private readonly maxRetainedSourceBytes: number;
  private readonly sessions = new Map<string, RecordedSession>();
  /** Weak replay snapshots cannot retain arbitrary native source, arguments or results. */
  private readonly replayed = new Map<
    string,
    {
      event: WeakRef<NormalizedSessionEvent>;
      observed: WeakRef<NormalizedSessionEvent>;
      sessionId: string;
    }
  >();
  private readonly replayIds = new Set<string>();
  private pendingCount = 0;
  private nextOrder = 0;
  private touchCounter = 0;

  constructor(options: ComputationEvidenceRecorderOptions = {}) {
    this.maxSessions = boundedOption(options.maxSessions, MAX_SESSIONS);
    this.maxPendingCalls = boundedOption(options.maxPendingCalls, MAX_PENDING_CALLS);
    this.maxFrameBytes = boundedOption(options.maxFrameBytes, MAX_FRAME_BYTES);
    this.maxRetainedSourceBytes = boundedOption(
      options.maxRetainedSourceBytes,
      MAX_RETAINED_SOURCE_BYTES,
    );
  }

  /**
   * Observes one normalized event after id/dedup processing.
   *
   * Returns the unchanged event when no bounded evidence applies, otherwise a clone carrying a
   * strict validated carrier under `metadata.resinComputationEvidenceV1`. Never throws: capture and
   * cloud submission must not fail because source analysis could not be represented.
   */
  public observe(event: NormalizedSessionEvent): NormalizedSessionEvent {
    try {
      // An identical replay of an already-processed event is idempotent: the same emitted carrier is
      // returned and no cached state, pending call or pending budget is touched a second time.
      const replayKey = `${event.sessionId}\u0000${event.eventId}`;
      const replayed = this.replayed.get(replayKey);
      if (replayed !== undefined) {
        return withoutLocalNativeArguments(
          replayed.event.deref() === event ? (replayed.observed.deref() ?? event) : event,
        );
      }
      const observed = withoutLocalNativeArguments(this.observeEvent(event));
      if (this.replayIds.size >= MAX_REPLAY_EVENTS) {
        const oldest = this.replayIds.values().next().value;
        if (oldest !== undefined) {
          this.replayIds.delete(oldest);
          this.replayed.delete(oldest);
        }
      }
      this.replayIds.add(replayKey);
      this.replayed.set(replayKey, {
        event: new WeakRef(event),
        observed: new WeakRef(observed),
        sessionId: event.sessionId,
      });
      return observed;
    } catch {
      return withoutLocalNativeArguments(event);
    }
  }

  /** Clears every session's kernel, file and pending state. */
  public clear(): void {
    this.sessions.clear();
    this.pendingCount = 0;
    this.replayIds.clear();
    this.replayed.clear();
  }

  private observeEvent(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type === "session_lifecycle") {
      if (event.lifecycleType === "end" || event.lifecycleType === "crash") {
        const session = this.sessions.get(event.sessionId);
        if (session !== undefined) {
          this.releaseSession(session);
        }
      }
      return event;
    }
    if (event.type === "file_edit") {
      // Framing reports a patch as unusable, so the touched observed body is invalidated rather than
      // reconstructed from a diff. A non-code edit observes nothing.
      const session = this.sessions.get(event.sessionId);
      if (session !== undefined) {
        this.touch(session);
        const frame = extractComputationSourceFrames(event, {
          knownFiles: this.knownFiles(session),
        })[0];
        if (frame !== undefined && frame.path !== undefined) {
          this.invalidateFile(session, frame.path);
        }
      }
      return event;
    }
    if (event.type === "tool_call") {
      return this.observeToolCall(event);
    }
    if (event.type === "tool_result") {
      return this.observeToolResult(event);
    }
    if (event.type === "command_exec") {
      return this.observeCommand(event);
    }
    return event;
  }

  /**
   * A command event is self-contained: it carries the interpreter invocation and its own exit code, so
   * the call and its outcome are the same observed event. A non-zero exit is a failed cell and
   * invalidates what it touched, exactly like a matched failed result.
   */
  private observeCommand(event: NormalizedCommandExecEvent): NormalizedSessionEvent {
    const session = this.session(event.sessionId);
    if (session.pairingDisabled) {
      return event;
    }
    const frame = this.framesFor(event, session, undefined)[0];
    if (frame === undefined || this.applyFrameControl(session, frame)) {
      return event;
    }
    const prepared = this.prepareFrame(frame, session);
    if (prepared === undefined) {
      this.invalidateEventFrame(session, event);
      return event;
    }
    if (event.exitCode !== 0) {
      this.invalidateTouched(session, prepared);
      return this.attach(
        event,
        prepared,
        observationOf(prepared, "error", event.eventId, event.eventId, event.eventId),
      );
    }
    this.commitFrame(session, prepared, event.eventId);
    return this.attach(
      event,
      prepared,
      observationOf(prepared, "success", event.eventId, event.eventId, event.eventId),
      this.resolveDependencies(session, prepared),
      this.resolveCorrections(session, prepared),
    );
  }

  private observeToolCall(event: NormalizedToolCallEvent): NormalizedSessionEvent {
    const session = this.session(event.sessionId);
    if (session.pairingDisabled) {
      return event;
    }
    const existing = session.pending.get(event.callId);
    if (existing !== undefined) {
      if (existing.callEventId === event.eventId) {
        // Identical replay: the pending snapshot already describes this call.
        if (existing.prepared === undefined) {
          return event;
        }
        return this.attach(
          event,
          existing.prepared,
          observationOf(existing.prepared, "pending", event.eventId, event.callId),
        );
      }
      // A different unresolved call reused this id: never pair either call optimistically.
      this.abandonPending(session, event.callId, existing);
      this.invalidateEventFrame(session, event);
      return event;
    }
    if (session.consumedSet.has(event.callId)) {
      // A replayed call whose result was already consumed must not pair a second result.
      this.invalidateEventFrame(session, event);
      return event;
    }

    const frame = this.framesFor(event, session, undefined)[0];
    if (frame === undefined) {
      // A read is framed from its result, so the call is retained only when a result body is possible.
      this.retainResultBodyCandidate(session, event);
      return event;
    }
    // A reset or overlapping write must not let an older, unresolved call restore stale bindings.
    for (const [callId, pending] of session.pending) {
      const earlier = pending.prepared;
      if (
        earlier === undefined &&
        pending.toolName === "eval" &&
        frame.executionScope === "persistent"
      ) {
        this.abandonPending(session, callId, pending);
        continue;
      }
      if (
        earlier !== undefined &&
        ((frame.executionScope === "persistent" &&
          earlier.executionScope === "persistent" &&
          earlier.language === frame.language) ||
          (earlier.executionScope === "file_observation" && earlier.fileAction === "write"))
      ) {
        this.abandonPending(session, callId, pending);
      }
    }
    while (this.pendingCount >= this.maxPendingCalls && this.evictOldestPending()) {
      // Evict before resolving a new closure, not after it has captured old bindings.
    }
    if (session.pairingDisabled) {
      return event;
    }
    if (this.applyFrameControl(session, frame)) {
      this.rememberConsumed(session, event.callId);
      return event;
    }
    const pending: PendingCall = {
      callId: event.callId,
      callEventId: event.eventId,
      toolName: event.toolName,
      callSequence: event.causalRef.causalSequence,
      order: this.nextOrder++,
      ...(frame.executionScope === "persistent" ? { language: frame.language } : {}),
      ...(frame.language === "python" &&
      (frame.executionScope === "persistent" || frame.executionScope === "isolated")
        ? { pythonSourceReference: pythonSourceReferenceOf(event) }
        : {}),
      // The frame source is retained while the call is unresolved; released on settlement.
      retainedBytes: 0,
    };
    const prepared = this.prepareFrame(frame, session);
    if (prepared !== undefined) {
      pending.prepared = prepared;
      pending.retainedBytes =
        byteLength(prepared.source) + byteLength(JSON.stringify(prepared.local));
    }
    if (prepared === undefined) {
      this.invalidateEventFrame(session, event);
      this.rememberConsumed(session, event.callId);
      return event;
    }
    if (!this.addPending(session, event.callId, pending)) {
      this.invalidateTouched(session, prepared);
      this.rememberConsumed(session, event.callId);
      return event;
    }
    return this.attach(
      event,
      prepared,
      observationOf(prepared, "pending", event.eventId, event.callId),
    );
  }

  private observeToolResult(event: NormalizedToolResultEvent): NormalizedSessionEvent {
    const session = this.sessions.get(event.sessionId);
    if (session === undefined) {
      return event;
    }
    const pending = session.pending.get(event.callId);
    if (
      pending === undefined ||
      pending.toolName !== event.toolName ||
      event.causalRef.causalSequence < pending.callSequence ||
      event.eventId === pending.callEventId
    ) {
      return event;
    }

    let prepared = pending.prepared;
    if (prepared === undefined) {
      const relatedCall: NormalizedToolCallEvent = {
        ...event,
        type: "tool_call",
        eventId: pending.callEventId,
        parameters: pending.readPath === undefined ? {} : { path: pending.readPath },
      };
      const frame = this.framesFor(event, session, relatedCall)[0];
      if (frame === undefined) {
        this.abandonPending(session, event.callId, pending);
        return event;
      }
      if (frame.executionScope === "persistent") {
        pending.language = frame.language;
      }
      if (this.applyFrameControl(session, frame)) {
        // No bounded representation: settle the pairing so a late result cannot revive it.
        this.settlePending(session, event.callId, pending, true);
        return event;
      }
      prepared = this.prepareFrame(frame, session);
    }
    this.settlePending(session, event.callId, pending, true);
    if (prepared === undefined || session.pairingDisabled) {
      if (pending.prepared === undefined && pending.toolName === "eval") {
        if (pending.language !== undefined) {
          this.resetKernel(session, pending.language);
        } else {
          this.resetUnknownNativeKernels(session);
        }
      }
      return event;
    }

    if (event.isError || hasFailedNativeExitCode(event.result)) {
      // A failed cell may have partially mutated a real kernel: commit nothing and invalidate the
      // bindings and files this frame touched, so a stale helper can never be revived.
      this.invalidateTouched(session, prepared);
      return this.attach(
        event,
        prepared,
        observationOf(prepared, "error", pending.callEventId, event.callId, event.eventId),
      );
    }

    this.commitFrame(
      session,
      prepared,
      event.eventId,
      pending.callId,
      pending.pythonSourceReference,
    );
    return this.attach(
      event,
      prepared,
      observationOf(prepared, "success", pending.callEventId, event.callId, event.eventId),
      this.resolveDependencies(session, prepared),
      this.resolveCorrections(session, prepared),
    );
  }

  private attach(
    event: NormalizedSessionEvent,
    prepared: PreparedFrame,
    observation: ComputationObservationV1,
    dependencies: readonly ComputationDependencyV1[] = [],
    corrections: readonly ComputationCorrectionV1[] = [],
  ): NormalizedSessionEvent {
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    let changed = false;
    if (event.type === "tool_call" && pythonSourceReferenceOf(event) !== undefined) {
      const carrier = readWorkflowCallCarrier(metadata[RESIN_WORKFLOW_CALL_METADATA_KEY]);
      if (carrier?.program?.kind === "python") {
        const session = this.sessions.get(event.sessionId);
        if (session !== undefined) {
          const pythonState = this.pythonStateFor(session, prepared);
          if (pythonState !== undefined) {
            carrier.program.pythonState = pythonState;
            metadata[RESIN_WORKFLOW_CALL_METADATA_KEY] = carrier;
            changed = true;
          }
        }
      }
    }
    const evidence = this.buildEvidence(prepared, observation, dependencies, corrections);
    if (evidence !== undefined) {
      metadata[RESIN_COMPUTATION_EVIDENCE_KEY] = evidence;
      changed = true;
    }
    return changed ? ({ ...event, metadata } as NormalizedSessionEvent) : event;
  }

  // ==========================================================================
  // Session / pending bookkeeping
  // ==========================================================================

  private session(sessionId: string): RecordedSession {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = createSession(sessionId);
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.values().next().value;
        if (oldest !== undefined) {
          this.releaseSession(oldest);
        }
      }
      this.sessions.set(sessionId, session);
    }
    this.touch(session);
    return session;
  }

  private touch(session: RecordedSession): void {
    session.touch = this.touchCounter++;
  }

  private releaseSession(session: RecordedSession): void {
    // A released session cannot replay its own pre-termination results, so its memo goes with it.
    for (const [eventId, memo] of this.replayed) {
      if (memo.sessionId === session.sessionId) {
        this.replayed.delete(eventId);
        this.replayIds.delete(eventId);
      }
    }
    this.pendingCount -= session.pending.size;
    session.pending.clear();
    session.files.clear();
    session.kernels.clear();
    session.consumedSet.clear();
    session.retainedBytes = 0;
    this.sessions.delete(session.sessionId);
  }

  private kernel(session: RecordedSession, language: ComputationLanguage): KernelState {
    let kernel = session.kernels.get(language);
    if (kernel === undefined) {
      kernel = {
        definitions: new Map(),
        imports: new Map(),
        supersessions: [],
        ...(language === "python"
          ? { python: { epoch: 0, cells: new Map(), bindings: new Map() } }
          : {}),
      };
      session.kernels.set(language, kernel);
    }
    return kernel;
  }

  private resetKernel(session: RecordedSession, language: ComputationLanguage): void {
    const kernel = session.kernels.get(language);
    if (kernel === undefined) {
      return;
    }
    for (const name of kernel.definitions.keys()) {
      this.dropDefinition(session, kernel, name);
    }
    for (const source of kernel.imports.keys()) {
      this.dropImport(session, kernel, source);
    }
    session.kernels.delete(language);
  }

  /**
   * Applies a frame's control meaning before any analysis.
   *
   * A rejection frame (empty source) means INVALIDATE: the body could not be used, so the observation
   * it touches never becomes a definition or an invocation, and the frame is never parsed.
   *
   * A reset frame terminates the persistent kernel of THIS session and language BEFORE the source is
   * parsed, so nothing from before the reset can be inlined into the resetting cell, while the cell's
   * own definitions still observe against the fresh kernel. File caches and the other language's
   * kernel are untouched, and a shell interpreter invocation is isolated, never a persistent reset.
   *
   * Returns true when the frame must not be analyzed further.
   */
  private applyFrameControl(session: RecordedSession, frame: ComputationSourceFrame): boolean {
    if (frame.reset === true && frame.executionScope === "persistent") {
      this.resetKernel(session, frame.language);
    }
    if (frame.rejectionReason !== undefined) {
      if (frame.path !== undefined) {
        this.invalidateFile(session, frame.path);
      }
      if (frame.executionScope === "persistent") {
        this.resetKernel(session, frame.language);
      }
      return true;
    }
    return false;
  }

  private invalidateEventFrame(session: RecordedSession, event: NormalizedSessionEvent): void {
    for (const frame of this.framesFor(event, session, undefined)) {
      if (frame.executionScope === "persistent") {
        this.resetKernel(session, frame.language);
      } else if (frame.executionScope === "file_observation" && frame.path !== undefined) {
        this.invalidateFile(session, frame.path);
      }
    }
  }

  /**
   * Retains a read-path call or an identity-only native eval marker whose observed arguments arrive
   * later. No raw arguments or results are retained by this pending entry.
   */
  private retainResultBodyCandidate(
    session: RecordedSession,
    event: NormalizedToolCallEvent,
  ): void {
    const parameters = (event.parameters ?? {}) as Readonly<Record<string, unknown>>;
    if (event.toolName === "eval") {
      for (const [callId, pending] of [...session.pending]) {
        if (pending.toolName === "eval" || pending.prepared?.executionScope === "persistent") {
          this.abandonPending(session, callId, pending);
          this.resetUnknownNativeKernels(session);
        }
      }
      this.addPending(session, event.callId, {
        callId: event.callId,
        callEventId: event.eventId,
        toolName: event.toolName,
        callSequence: event.causalRef.causalSequence,
        order: this.nextOrder++,
        retainedBytes: 0,
      });
      return;
    }
    const path =
      parameters.path ?? parameters.filePath ?? parameters.file_path ?? parameters.target;
    if (typeof path !== "string" || path.length === 0 || byteLength(path) > 4096) {
      return;
    }
    this.addPending(session, event.callId, {
      callId: event.callId,
      callEventId: event.eventId,
      toolName: event.toolName,
      callSequence: event.causalRef.causalSequence,
      order: this.nextOrder++,
      readPath: path,
      retainedBytes: byteLength(path),
    });
  }

  private resetUnknownNativeKernels(session: RecordedSession): void {
    for (const language of [...session.kernels.keys()]) {
      this.resetKernel(session, language);
    }
  }

  private addPending(session: RecordedSession, key: string, pending: PendingCall): boolean {
    while (this.pendingCount >= this.maxPendingCalls) {
      if (!this.evictOldestPending()) {
        // The pinned bound cannot be satisfied: refuse the call rather than exceed it.
        return false;
      }
    }
    session.pending.set(key, pending);
    this.pendingCount += 1;
    session.retainedBytes += pending.retainedBytes;
    this.enforceRetention(session);
    return session.pending.get(key) === pending;
  }

  /** Drops one unresolved call and the transient frame source it retains. */
  private dropPending(session: RecordedSession, key: string, pending: PendingCall): void {
    if (session.pending.get(key) !== pending) {
      return;
    }
    session.pending.delete(key);
    this.pendingCount -= 1;
    session.retainedBytes = Math.max(0, session.retainedBytes - pending.retainedBytes);
  }

  private evictOldestPending(): boolean {
    let oldestSession: RecordedSession | undefined;
    let oldestKey: string | undefined;
    let oldestOrder = Number.POSITIVE_INFINITY;
    for (const session of this.sessions.values()) {
      for (const [key, pending] of session.pending) {
        if (pending.order < oldestOrder) {
          oldestOrder = pending.order;
          oldestSession = session;
          oldestKey = key;
        }
      }
    }
    if (oldestSession === undefined || oldestKey === undefined) {
      return false;
    }
    const pending = oldestSession.pending.get(oldestKey);
    if (pending === undefined) {
      return false;
    }
    this.abandonPending(oldestSession, oldestKey, pending);
    return true;
  }

  /**
   * Settles a pending call, optionally recording its identity as consumed. A consumed identity means
   * a replayed call event can never pair a second result or re-emit pending evidence.
   */
  private settlePending(
    session: RecordedSession,
    callId: string,
    pending: PendingCall,
    markConsumed: boolean,
  ): void {
    if (session.pending.get(callId) === pending) {
      this.dropPending(session, callId, pending);
    }
    if (!markConsumed) {
      return;
    }
    this.rememberConsumed(session, pending.callId);
  }

  private abandonPending(session: RecordedSession, callId: string, pending: PendingCall): void {
    if (pending.prepared !== undefined) {
      this.invalidateTouched(session, pending.prepared);
    } else if (pending.readPath !== undefined) {
      this.invalidateFile(session, pending.readPath);
    } else if (pending.toolName === "eval") {
      if (pending.language !== undefined) {
        this.resetKernel(session, pending.language);
      } else {
        // Only an unattributable body may have changed either persistent kernel.
        this.resetUnknownNativeKernels(session);
      }
    }
    this.settlePending(session, callId, pending, true);
  }

  private rememberConsumed(session: RecordedSession, callId: string): void {
    if (session.consumedSet.has(callId) || session.pairingDisabled) {
      return;
    }
    if (session.consumedSet.size >= MAX_CONSUMED_CALLS) {
      // Never forget an identity and then pretend a late result is unambiguous.
      session.pairingDisabled = true;
      this.pendingCount -= session.pending.size;
      session.pending.clear();
      session.kernels.clear();
      session.files.clear();
      session.retainedBytes = 0;
      return;
    }
    session.consumedSet.add(callId);
  }

  // ==========================================================================
  // Frame preparation (parse only; never execute)
  // ==========================================================================

  private framesFor(
    event: NormalizedSessionEvent,
    session: RecordedSession,
    relatedCall: NormalizedToolCallEvent | undefined,
  ): readonly ComputationSourceFrame[] {
    return extractComputationSourceFrames(event, {
      knownFiles: this.knownFiles(session),
      ...(relatedCall === undefined ? {} : { relatedCall }),
    });
  }

  private knownFiles(session: RecordedSession): ReadonlyMap<string, LocalComputationModule> {
    const modules = new Map<string, LocalComputationModule>();
    for (const [path, file] of session.files) {
      modules.set(path, file.module);
    }
    return modules;
  }

  /**
   * Private context carrying only the state a frame of this scope is allowed to resolve: a persistent
   * eval kernel resolves its own language's kernel definitions, while an isolated interpreter process
   * or a file body resolves nothing from another process.
   */
  private parseContext(
    frame: ComputationSourceFrame,
    session: RecordedSession,
  ): ComputationParseContext {
    const persistent = frame.executionScope === "persistent";
    const kernel = persistent ? this.kernel(session, frame.language) : undefined;
    return {
      definitions:
        kernel === undefined
          ? []
          : Array.from(kernel.definitions.values()).map((definition) => ({
              name: definition.name,
              source: definition.source,
              references: [...definition.references],
              writtenNames: [...definition.writtenNames],
              sourceEventId: definition.sourceEventId,
              programDigest: definition.programDigest,
            })),
      imports: kernel === undefined ? [] : Array.from(kernel.imports.values()),
      modules: Array.from(this.knownFiles(session).values()),
      ...(frame.path === undefined ? {} : { sourcePath: frame.path }),
    };
  }

  private prepareFrame(
    frame: ComputationSourceFrame,
    session: RecordedSession,
  ): PreparedFrame | undefined {
    if (typeof frame.source !== "string" || frame.source.length === 0) {
      return undefined;
    }
    if (byteLength(frame.source) > this.maxFrameBytes) {
      return undefined;
    }
    const context = this.parseContext(frame, session);
    const parsed = parseFrame(frame.language, frame.source, context);
    return this.assemblePrepared(frame, frame.source, parsed, context.definitions ?? []);
  }

  private assemblePrepared(
    frame: ComputationSourceFrame,
    source: string,
    parsed: ComputationParseResult | undefined,
    resolvedDefinitions: readonly LocalComputationDefinition[],
  ): PreparedFrame | undefined {
    if (parsed === undefined) {
      return undefined;
    }
    const program = parsed.program;
    const local = parsed.local;
    // Python imports/definitions are lexical kernel state even when the computation visitor emits no
    // executable IR nodes for the cell. Keep those successful frames so later cells can close over
    // their bindings; ordinary empty frames remain non-substantive.
    const lexicalPythonCell =
      frame.language === "python" &&
      frame.executionScope === "persistent" &&
      (local.imports.length > 0 || local.definitions.length > 0 || local.writtenNames.length > 0);
    if (!lexicalPythonCell && (program.nodes.length === 0 || program.roots.length === 0)) {
      return undefined;
    }
    const observationKind: ComputationObservationKind =
      frame.executionScope === "file_observation" || !local.hasInvocation
        ? "definition"
        : "invocation";
    const pathPattern = toPathPattern(frame.path);
    return {
      language: frame.language,
      originKind: frame.originKind,
      executionScope: frame.executionScope,
      ...(frame.fileAction === undefined ? {} : { fileAction: frame.fileAction }),
      ...(frame.path === undefined ? {} : { path: frame.path }),
      ...(pathPattern === undefined ? {} : { pathPattern }),
      // The frame names the event that carried the body: the call for an inline/heredoc/write body,
      // the result for a read body.
      sourceEventId: frame.sourceEventId,
      source,
      program,
      programDigest: computeComputationProgramDigest(program),
      local,
      ...(local.definitionBindings === undefined ? {} : { bindings: local.definitionBindings }),
      metrics: estimateAuthoringSize(
        source,
        resolvedDefinitions.filter((definition) =>
          local.definitionBindings?.some((binding) => binding.name === definition.name),
        ),
      ),
      observationKind,
    };
  }

  // ==========================================================================
  // Commit / invalidate
  // ==========================================================================

  private commitFrame(
    session: RecordedSession,
    prepared: PreparedFrame,
    resultEventId: string,
    callId?: string,
    sourceReference?: string,
  ): void {
    if (prepared.executionScope === "file_observation") {
      // A written or read body is retained only as an observed file the recorder may later resolve.
      if (prepared.path !== undefined) {
        this.cacheFile(session, prepared, prepared.source, resultEventId);
      }
      return;
    }
    if (prepared.executionScope === "isolated") {
      // The interpreter process is gone; its definitions must never be revived later.
      return;
    }
    const committed = this.commitDefinitions(
      session,
      prepared,
      resultEventId,
      callId,
      sourceReference,
    );
    if (
      committed &&
      prepared.language === "python" &&
      callId !== undefined &&
      sourceReference !== undefined
    ) {
      this.commitPythonCell(session, prepared, callId, resultEventId, sourceReference);
    } else if (prepared.language === "python") {
      // A source without a private resolver reference cannot safely seed later setup.
      this.clearPythonState(session, prepared.language);
    }
  }

  private commitDefinitions(
    session: RecordedSession,
    prepared: PreparedFrame,
    sourceEventId: string,
    callId?: string,
    sourceReference?: string,
  ): boolean {
    const local = prepared.local;
    const kernel = this.kernel(session, prepared.language);
    if (
      local.invalidatesState ||
      (prepared.language !== "python" &&
        prepared.observationKind === "invocation" &&
        !prepared.program.complete)
    ) {
      // Unknown mutation may have changed any binding, even if some definitions were parsed.
      this.resetKernel(session, prepared.language);
      return false;
    }
    const authored = new Set(local.definitions.map((definition) => definition.name));
    const written = new Set([
      ...local.writtenNames,
      ...local.imports.flatMap((imported) => imported.names),
    ]);
    for (const name of written) {
      if (!authored.has(name)) {
        this.dropDefinition(session, kernel, name);
      }
    }
    for (const [source, imported] of kernel.imports) {
      if (imported.names.some((name) => written.has(name) || authored.has(name))) {
        this.dropImport(session, kernel, source);
      }
    }
    for (const definition of local.definitions) {
      // A frame digest includes unrelated code. Re-observing an identical helper body is not a
      // correction, even when its latest provenance belongs to a different containing frame.
      const digest = definition.programDigest ?? prepared.programDigest;
      const text = definition.source.length > 0 ? definition.source : prepared.source;
      const existing = kernel.definitions.get(definition.name);
      const nameKey = hashCanonicalContent(["computation-helper", definition.name]);
      if (existing !== undefined && existing.programDigest !== digest) {
        kernel.supersessions = kernel.supersessions.filter(
          (entry) => entry.nameKey !== nameKey || entry.supersededDigest !== digest,
        );
        for (const entry of kernel.supersessions) {
          if (entry.nameKey === nameKey && entry.replacingDigest === existing.programDigest) {
            entry.replacingDigest = digest;
          }
        }
      }
      if (existing !== undefined && existing.source !== text && existing.programDigest !== digest) {
        kernel.supersessions.push({
          nameKey,
          supersededDigest: existing.programDigest,
          replacingDigest: digest,
        });
        while (kernel.supersessions.length > MAX_SUPERSESSIONS) {
          kernel.supersessions.shift();
        }
      }
      if (existing !== undefined) {
        session.retainedBytes = Math.max(0, session.retainedBytes - existing.bytes);
      }
      // Re-insert so map order always reflects the most recently observed version.
      kernel.definitions.delete(definition.name);
      const cached: CachedDefinition = {
        name: detachedPrivateText(definition.name),
        source: detachedPrivateText(text),
        references: definition.references.map(detachedPrivateText),
        writtenNames: definition.writtenNames.map(detachedPrivateText),
        sourceEventId,
        ...(callId === undefined ? {} : { callId }),
        ...(sourceEventId === undefined ? {} : { resultEventId: sourceEventId }),
        ...(sourceReference === undefined ? {} : { sourceReference }),
        programDigest: digest,
        bytes: 0,
      };
      cached.bytes = [
        cached.name,
        cached.source,
        ...cached.references,
        ...cached.writtenNames,
      ].reduce((total, value) => total + byteLength(value), 0);
      kernel.definitions.set(cached.name, cached);
      session.retainedBytes += cached.bytes;
    }
    for (const imported of local.imports) {
      if (imported.source.length === 0) {
        continue;
      }
      this.dropImport(session, kernel, imported.source);
      const cachedImport: LocalComputationImport = {
        names: imported.names.map(detachedPrivateText),
        source: detachedPrivateText(imported.source),
        sourceEventId,
      };
      kernel.imports.set(cachedImport.source, cachedImport);
      session.retainedBytes +=
        byteLength(cachedImport.source) +
        cachedImport.names.reduce((total, name) => total + byteLength(name), 0);
      while (kernel.imports.size > MAX_KERNEL_DEFINITIONS) {
        const oldest = kernel.imports.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.clearPythonStateForKernel(session, kernel);
        this.dropImport(session, kernel, oldest);
      }
    }
    while (kernel.definitions.size > MAX_KERNEL_DEFINITIONS) {
      const oldest = kernel.definitions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.clearPythonStateForKernel(session, kernel);
      this.dropDefinition(session, kernel, oldest);
    }
    this.enforceRetention(session);
    return true;
  }

  private clearPythonState(session: RecordedSession, language: ComputationLanguage): void {
    if (language !== "python") return;
    const kernel = session.kernels.get(language);
    const python = kernel?.python;
    if (python === undefined) return;
    python.epoch += 1;
    python.cells.clear();
    python.bindings.clear();
  }
  private clearPythonStateForKernel(session: RecordedSession, kernel: KernelState): void {
    if (session.kernels.get("python") === kernel) {
      this.clearPythonState(session, "python");
    }
  }

  /** Commit one successful, causally matched persistent Python cell to the private state graph. */
  private commitPythonCell(
    session: RecordedSession,
    prepared: PreparedFrame,
    callId: string,
    resultEventId: string,
    sourceReference: string,
  ): void {
    if (prepared.language !== "python" || prepared.executionScope !== "persistent") {
      return;
    }
    const kernel = this.kernel(session, "python");
    const python = kernel.python;
    if (python === undefined) return;
    const written = new Set([
      ...prepared.local.writtenNames,
      ...prepared.local.imports.flatMap((entry) => entry.names),
      ...prepared.local.definitions.map((entry) => entry.name),
    ]);
    const required =
      prepared.local.requiredNames === undefined
        ? prepared.local.referencedNames.filter((name) => !written.has(name))
        : prepared.local.requiredNames;
    const cell: PythonCell = {
      callId,
      sourceEventId: prepared.sourceEventId,
      resultEventId,
      sourceReference,
      requiredNames: required.map(detachedPrivateText),
      writtenNames: [...written].map(detachedPrivateText),
      order: this.nextOrder++,
    };
    if (python.cells.size >= MAX_WORKFLOW_PYTHON_SETUP_CELLS) {
      // Do not leave a partially remembered closure after eviction: old setup cannot be trusted.
      this.clearPythonState(session, "python");
    }
    python.cells.set(callId, cell);
    for (const name of written) {
      python.bindings.set(name, cell);
    }
  }

  /**
   * Derive the smallest successful setup closure for one Python frame. This follows parser-reported
   * scope-aware required names and the latest successful binding for each name; it never replays every
   * prior cell and never treats a value/result equality as a definition.
   */
  private pythonStateFor(
    session: RecordedSession,
    prepared: PreparedFrame,
  ): WorkflowPythonState | undefined {
    if (prepared.language !== "python" || prepared.executionScope === "file_observation") {
      return undefined;
    }
    const written = new Set([
      ...prepared.local.writtenNames,
      ...prepared.local.imports.flatMap((entry) => entry.names),
      ...prepared.local.definitions.map((entry) => entry.name),
    ]);
    const required =
      prepared.local.requiredNames === undefined
        ? prepared.local.referencedNames.filter((name) => !written.has(name))
        : prepared.local.requiredNames;
    const unresolved = new Set<string>();
    const selected = new Map<string, PythonCell>();
    const visiting = new Set<string>();
    const python =
      prepared.executionScope === "persistent" ? session.kernels.get("python")?.python : undefined;

    const visitCell = (cell: PythonCell): void => {
      if (selected.has(cell.callId)) return;
      if (visiting.has(cell.callId)) {
        unresolved.add(cell.callId);
        return;
      }
      visiting.add(cell.callId);
      for (const name of cell.requiredNames) {
        const dependency = python?.bindings.get(name);
        if (dependency === undefined) {
          unresolved.add(name);
        } else {
          visitCell(dependency);
        }
      }
      visiting.delete(cell.callId);
      selected.set(cell.callId, cell);
    };

    if (prepared.local.invalidatesState) {
      unresolved.add("opaque_state");
    } else {
      for (const name of required) {
        const cell = python?.bindings.get(name);
        if (cell === undefined) {
          unresolved.add(name);
        } else {
          visitCell(cell);
        }
      }
    }
    if (unresolved.size > 0) {
      return {
        schemaVersion: 1,
        status: "unresolved",
        unresolvedReadCount: unresolved.size,
        setup: [],
      };
    }
    const selectedCells = [...selected.values()].sort((left, right) => left.order - right.order);
    if (selectedCells.length > MAX_WORKFLOW_PYTHON_SETUP_CELLS) {
      return {
        schemaVersion: 1,
        status: "unresolved",
        unresolvedReadCount: 1,
        setup: [],
      };
    }
    const setup = selectedCells.map((cell) => ({
      callId: cell.callId,
      sourceEventId: cell.sourceEventId,
      resultEventId: cell.resultEventId,
      reference: cell.sourceReference,
    }));
    return {
      schemaVersion: 1,
      status: "closed",
      unresolvedReadCount: 0,
      setup,
    };
  }

  private dropImport(session: RecordedSession, kernel: KernelState, source: string): void {
    const imported = kernel.imports.get(source);
    if (imported === undefined) {
      return;
    }
    kernel.imports.delete(source);
    session.retainedBytes = Math.max(
      0,
      session.retainedBytes -
        byteLength(imported.source) -
        imported.names.reduce((total, name) => total + byteLength(name), 0),
    );
  }

  private dropDefinition(session: RecordedSession, kernel: KernelState, name: string): void {
    const existing = kernel.definitions.get(name);
    if (existing === undefined) {
      return;
    }
    kernel.definitions.delete(name);
    session.retainedBytes = Math.max(0, session.retainedBytes - existing.bytes);
  }

  private cacheFile(
    session: RecordedSession,
    prepared: PreparedFrame,
    source: string,
    sourceEventId: string,
  ): void {
    const path = prepared.path;
    if (path === undefined || byteLength(source) > this.maxFrameBytes) {
      return;
    }
    const previous = session.files.get(path);
    if (previous !== undefined) {
      session.retainedBytes = Math.max(0, session.retainedBytes - previous.bytes);
    }
    session.files.delete(path);
    const bytes = byteLength(source) + byteLength(path);
    const cachedPath = detachedPrivateText(path);
    session.files.set(cachedPath, {
      module: {
        path: cachedPath,
        source: detachedPrivateText(source),
        language: prepared.language,
        sourceEventId,
        programDigest: prepared.programDigest,
      },
      bytes,
    });
    session.retainedBytes += bytes;
    while (session.files.size > MAX_KNOWN_FILES) {
      const oldest = session.files.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.invalidateFile(session, oldest);
    }
    this.enforceRetention(session);
  }

  /** Fail-closed invalidation of one observed file body. */
  private invalidateFile(session: RecordedSession, path: string): void {
    const file = session.files.get(path);
    if (file === undefined) {
      return;
    }
    session.files.delete(path);
    session.retainedBytes = Math.max(0, session.retainedBytes - file.bytes);
  }

  /**
   * Failed cell: this frame's bindings and files may be partially mutated, so every definition and
   * file body it could have introduced is discarded while unrelated prior state survives.
   */
  private invalidateTouched(session: RecordedSession, prepared: PreparedFrame): void {
    if (prepared.executionScope === "file_observation" && prepared.path !== undefined) {
      this.invalidateFile(session, prepared.path);
      return;
    }
    if (prepared.executionScope !== "persistent") {
      return;
    }
    if (
      prepared.local.invalidatesState ||
      (prepared.observationKind === "invocation" && !prepared.program.complete)
    ) {
      this.resetKernel(session, prepared.language);
      return;
    }
    const kernel = session.kernels.get(prepared.language);
    if (kernel === undefined) {
      return;
    }
    const written = new Set([
      ...prepared.local.writtenNames,
      ...prepared.local.definitions.map((definition) => definition.name),
      ...prepared.local.imports.flatMap((imported) => imported.names),
    ]);
    for (const name of Array.from(kernel.definitions.keys())) {
      if (written.has(name)) {
        this.dropDefinition(session, kernel, name);
      }
    }
    for (const [source, imported] of kernel.imports) {
      if (imported.names.some((name) => written.has(name))) {
        this.dropImport(session, kernel, source);
      }
    }
  }

  private enforceRetention(session: RecordedSession): void {
    while (
      Array.from(this.sessions.values()).reduce((total, entry) => total + entry.retainedBytes, 0) >
      this.maxRetainedSourceBytes
    ) {
      if (this.evictOldestPending()) {
        continue;
      }
      let oldest = session;
      for (const candidate of this.sessions.values()) {
        if (
          candidate.retainedBytes > 0 &&
          (oldest.retainedBytes === 0 || candidate.touch < oldest.touch)
        ) {
          oldest = candidate;
        }
      }
      const path = oldest.files.keys().next().value;
      if (path !== undefined) {
        this.invalidateFile(oldest, path);
        continue;
      }
      const definition = this.oldestDefinition(oldest);
      if (definition !== undefined) {
        this.clearPythonStateForKernel(oldest, definition.kernel);
        this.dropDefinition(oldest, definition.kernel, definition.name);
        continue;
      }
      let dropped = false;
      for (const kernel of oldest.kernels.values()) {
        const source = kernel.imports.keys().next().value;
        if (source !== undefined) {
          this.clearPythonStateForKernel(oldest, kernel);
          this.dropImport(oldest, kernel, source);
          dropped = true;
          break;
        }
      }
      if (!dropped) {
        // Accounting disagreement is not permission to retain unbounded private state.
        this.clear();
        return;
      }
    }
  }

  private oldestDefinition(
    session: RecordedSession,
  ): { kernel: KernelState; name: string } | undefined {
    for (const kernel of session.kernels.values()) {
      const name = kernel.definitions.keys().next().value;
      if (name !== undefined) {
        return { kernel, name };
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Closure attribution and emission
  // ==========================================================================

  /**
   * Materialized dependency closure attribution: only definitions the frame actually resolved are
   * reported, mapped through the parser's private bindings to the exact inlined version. A helper
   * inlined from a persistent kernel resolves against the kernel; one inlined from an observed file
   * module resolves against that bounded file body.
   */
  private resolveDependencies(
    session: RecordedSession,
    prepared: PreparedFrame,
  ): ComputationDependencyV1[] {
    const bindings = prepared.bindings;
    if (bindings === undefined) {
      return [];
    }
    const authored = new Set(prepared.local.definitions.map((definition) => definition.name));
    const dependencies: ComputationDependencyV1[] = [];
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (authored.has(binding.name) || seen.has(binding.definitionId)) {
        continue;
      }
      const origin = this.originOfResolvedHelper(session, prepared.language, binding);
      if (origin === undefined) {
        continue;
      }
      seen.add(binding.definitionId);
      dependencies.push({
        definitionId: binding.definitionId,
        programDigest: origin.programDigest,
        sourceEventId: origin.sourceEventId,
      });
      if (dependencies.length >= MAX_EMITTED_ENTRIES) {
        break;
      }
    }
    return dependencies;
  }

  /**
   * Observed origin of one inlined helper.
   *
   * The language visitor alone knows which cached version it inlined, and it reports that provenance
   * on the binding. The recorder therefore trusts the reported `sourceEventId`/`programDigest` when
   * present and otherwise resolves the binding against the current kernel version (an authored
   * binding has no provenance). A helper whose version cannot be established is never asserted as a
   * dependency, so a stale or unknown version cannot be passed off as the observed closure.
   */
  private originOfResolvedHelper(
    session: RecordedSession,
    language: ComputationLanguage,
    binding: LocalComputationDefinitionBinding,
  ): { programDigest: string; sourceEventId: string } | undefined {
    if (binding.sourceEventId !== undefined && binding.programDigest !== undefined) {
      return { programDigest: binding.programDigest, sourceEventId: binding.sourceEventId };
    }
    const cached = session.kernels.get(language)?.definitions.get(binding.name);
    if (cached === undefined) {
      return undefined;
    }
    if (binding.sourceEventId !== undefined && binding.sourceEventId !== cached.sourceEventId) {
      // The visitor resolved an older version than the kernel now holds: never vouch for it.
      return undefined;
    }
    if (binding.programDigest !== undefined && binding.programDigest !== cached.programDigest) {
      return undefined;
    }
    return { programDigest: cached.programDigest, sourceEventId: cached.sourceEventId };
  }

  /** Corrections relative to the versions this frame actually materialized. */
  private resolveCorrections(
    session: RecordedSession,
    prepared: PreparedFrame,
  ): ComputationCorrectionV1[] {
    const kernel = session.kernels.get(prepared.language);
    const bindings = prepared.bindings;
    if (kernel === undefined || bindings === undefined || kernel.supersessions.length === 0) {
      return [];
    }
    const corrections: ComputationCorrectionV1[] = [];
    const seen = new Set<string>();
    const bindingsByNameKey = new Map(
      bindings.map((binding) => [
        hashCanonicalContent(["computation-helper", binding.name]),
        binding,
      ]),
    );
    for (const supersession of kernel.supersessions) {
      const binding = bindingsByNameKey.get(supersession.nameKey);
      if (binding === undefined) {
        continue;
      }
      const current = kernel.definitions.get(binding.name);
      if (current === undefined || current.programDigest !== supersession.replacingDigest) {
        continue;
      }
      const key = `${binding.definitionId}:${supersession.supersededDigest}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      corrections.push({
        supersedesDefinitionId: binding.definitionId,
        supersededProgramDigest: supersession.supersededDigest,
      });
      if (corrections.length >= MAX_EMITTED_ENTRIES) {
        break;
      }
    }
    return corrections;
  }

  /**
   * Builds and re-validates the bounded envelope. Returns `undefined` when the carrier cannot be
   * represented inside the pinned limits, so an unvalidated carrier is never attached.
   */
  private buildEvidence(
    prepared: PreparedFrame,
    observation: ComputationObservationV1,
    dependencies: readonly ComputationDependencyV1[],
    corrections: readonly ComputationCorrectionV1[],
  ): ResinComputationEvidenceV1 | undefined {
    const { program } = prepared;
    const { sourceBytes, sourceLines } = prepared.metrics;
    if (
      sourceBytes > COMPUTATION_IR_LIMITS.sourceBytes ||
      sourceLines > COMPUTATION_IR_LIMITS.sourceLines
    ) {
      return undefined;
    }
    const body = {
      version: "1.0.0" as const,
      program,
      programDigest: prepared.programDigest,
      origin: {
        kind: prepared.originKind,
        sourceEventId: prepared.sourceEventId,
        ...(prepared.pathPattern === undefined ? {} : { pathPattern: prepared.pathPattern }),
      },
      observation,
      dependencies: [...dependencies],
      corrections: [...corrections],
      metrics: {
        sourceLines,
        sourceBytes,
        nodeCount: program.nodes.length,
        symbolCount: program.symbols.length,
        slotCount: program.slots.length,
        definitionCount: program.definitions.length,
      },
      analysisOnly: true as const,
    };
    return readComputationEvidence({
      evidenceId: computeComputationEvidenceDigest(body),
      ...body,
    });
  }
}

function hasFailedNativeExitCode(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const details = Object.getOwnPropertyDescriptor(result, "details")?.value;
  for (const candidate of [result, details]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const exitCode = Object.getOwnPropertyDescriptor(candidate, "exitCode")?.value;
    if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode !== 0) {
      return true;
    }
  }
  return false;
}

function createSession(sessionId: string): RecordedSession {
  return {
    sessionId,
    touch: 0,
    kernels: new Map(),
    files: new Map(),
    pending: new Map(),
    consumedSet: new Set(),
    retainedBytes: 0,
    pairingDisabled: false,
  };
}

function boundedOption(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return maximum;
  }
  return Math.min(value, maximum);
}

function observationOf(
  prepared: PreparedFrame,
  status: ComputationObservationV1["status"],
  callEventId: string,
  callId: string,
  resultEventId?: string,
): ComputationObservationV1 {
  return {
    kind: prepared.observationKind,
    status,
    callEventId,
    callId,
    ...(resultEventId === undefined ? {} : { resultEventId }),
  };
}

/**
 * Language dispatch. TypeScript is parsed by the JavaScript visitor, which lowers the syntax both
 * share; parameter-annotation-only offsets cannot change algorithm identity.
 */
function parseFrame(
  language: ComputationLanguage,
  source: string,
  context: ComputationParseContext,
): ComputationParseResult | undefined {
  try {
    if (language === "python") {
      return parsePythonComputation(source, context);
    }
    return parseJavaScriptComputation(source, context, language);
  } catch {
    return undefined;
  }
}

/** Detach slices so a small cached helper cannot keep its entire old native payload alive in V8. */
function detachedPrivateText(value: string): string {
  // UTF-16 preserves even unpaired surrogates; UTF-8 round-tripping could change source semantics.
  return Buffer.from(value, "utf16le").toString("utf16le");
}

const PATH_PATTERN_RE = /^[A-Za-z0-9_][A-Za-z0-9_./*-]*$/;

/**
 * Normalized relative path pattern, or `undefined` when the observed path is absolute, a Windows
 * drive path, home-relative or traversing. An unnormalizable path is omitted, never truncated.
 */
function toPathPattern(rawPath: string | undefined): string | undefined {
  if (rawPath === undefined) {
    return undefined;
  }
  let candidate = rawPath.replace(/\\/g, "/").trim();
  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  if (candidate.length === 0 || candidate.length > 128) {
    return undefined;
  }
  if (candidate.startsWith("/") || candidate.startsWith("~") || /^[A-Za-z]:/.test(candidate)) {
    return undefined;
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return undefined;
  }
  return PATH_PATTERN_RE.test(candidate) ? candidate : undefined;
}

function byteLength(source: string): number {
  return Buffer.byteLength(source, "utf8");
}

/**
 * Estimated authoring work over the bounded, deduplicated source set this frame actually resolves:
 * its own source plus each materialized helper body counted once, even when several names share one
 * body. Never a model-usage or measured-savings figure.
 */
function estimateAuthoringSize(
  source: string,
  resolvedDefinitions: readonly LocalComputationDefinition[],
): { sourceLines: number; sourceBytes: number } {
  const bodies = new Map<string, string>([[source, source]]);
  for (const definition of resolvedDefinitions) {
    // Deduplicate retained same-source helper bodies, e.g. one shared helper under two aliases.
    bodies.set(definition.source, definition.source);
  }
  let sourceBytes = 0;
  let sourceLines = 0;
  for (const body of bodies.values()) {
    sourceBytes += byteLength(body);
    sourceLines += countLines(body);
  }
  return { sourceLines, sourceBytes };
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  let lines = source.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

export function createComputationEvidenceRecorder(
  options: ComputationEvidenceRecorderOptions = {},
): ComputationEvidenceRecorder {
  return new ComputationEvidenceRecorder(options);
}
