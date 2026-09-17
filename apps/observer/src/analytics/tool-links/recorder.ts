import { RESIN_LOCAL_OMP_NATIVE_CALL_KEY } from "@resin/adapter-omp";
import {
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_TOOL_LINK_EVIDENCE_KEY,
  TOOL_LINK_EVIDENCE_LIMITS,
  type ToolLinkContentKind,
  type ToolLinkEvidenceV1,
  ToolLinkEvidenceV1Schema,
  type ToolLinkObservation,
} from "@resin/contracts";
import {
  type DeclaredFlow,
  type DeclaredResource,
  declaredContentKindsOfText,
  declaredFlowOfCommandExec,
  declaredFlowOfToolCall,
} from "./declared-flow.js";

/**
 * Tool link recorder: attaches declared data-flow evidence to normalized events, as metadata only.
 *
 * The recorder runs next to the computation-evidence recorder, on the post-dedup, pre-projection
 * event stream — the last place where the agent's DECLARED arguments are still observable. It
 * attaches a strict, privacy-projected carrier under `metadata.resinToolLinkV1`; it never rewrites an
 * event id, a call id, a causal reference or an event order, so a consumer can still match a carrier
 * against the original stored events.
 *
 * The local native-call handoff (`__resinLocalOmpNativeCallV1`) is READ and never removed here: the
 * computation recorder that runs after this one consumes it and strips it, so both recorders see the
 * embedded arguments of a persisted eval call exactly once each, and the handoff still leaves the
 * chain before anything is projected.
 *
 * Pairing rules, in the order they are enforced:
 *   - a call (`tool_call`, or a self-contained `command_exec`) opens a pending observation;
 *   - a carrier is attached to the call side only as `pending`;
 *   - a `tool_result` closes the observation only when the call was observed first, the tool name
 *     matches and the result's causal sequence is strictly later, and only then is it `success` or
 *     `failure` with that result's event id;
 *   - `success` is asserted from the ACTUAL observed outcome: a harness `isError: false` is not
 *     trusted, and a nonzero exit code or a traceback marks the call failed.
 *
 * Scope and identity:
 *   - `scopeId` is the first call event id this recorder captures in the session/capture epoch. A full
 *     replay re-observes the same first call and therefore reconstructs the same scope id and the same
 *     ordinal map; a capture that starts or resumes at a later call observes a different first call, so
 *     its ordinals are never the earlier epoch's ordinals;
 *   - resource ordinals are allocated per scope in first-observed order over the DECLARED resources
 *     only, so two resources share a ref exactly when the agent declared the same value, and a
 *     replayed event sequence reproduces the same carriers;
 *   - state is bounded per session (pending calls, remembered carriers, remembered command
 *     spellings, resource ordinals) and sessions are bounded with LRU eviction.
 *
 * Nothing here executes, replays or resolves a declared value: an unresolvable or ambiguous flow
 * omits evidence entirely rather than reporting a partial one.
 */

/** Sessions whose scope, pending and remembered state is retained before the oldest is evicted. */
const MAX_SESSIONS = 32;
/** Unresolved calls retained per session. */
const MAX_PENDING_PER_SESSION = 64;
/** Emitted carriers remembered per session, for idempotent re-observation of a replayed event. */
const MAX_EMITTED_PER_SESSION = 256;
/** Call ids quarantined per scope, because two unresolved calls claimed the same id. */
const MAX_BLOCKED_CALLS = 64;
/** Total result text inspected for outcome and content shape. */
const MAX_RESULT_TEXT_CHARS = 8_192;
/** Head/tail split of that budget, so a trailing error footer in a long stream is still seen. */
const RESULT_TEXT_HEAD_CHARS = 6_144;
const RESULT_TEXT_TAIL_CHARS = 2_048;
/** Most distinct text parts taken from one result. */
const MAX_RESULT_TEXT_PARTS = 32;
/** Nodes visited by the bounded outcome scan. */
const MAX_SCANNED_NODES = 128;
const MAX_SCANNED_DEPTH = 4;

interface PendingCall {
  readonly callId: string;
  readonly callEventId: string;
  readonly callSequence: number;
  readonly toolName: string;
  /** Declared flow parsed from the call's own arguments, when it declared one. */
  readonly flow?: DeclaredFlow;
}

interface RecordedScope {
  readonly sessionId: string;
  /** First captured call event id of this session/capture epoch. */
  scopeId?: string;
  readonly refs: Map<string, string>;
  nextOrdinal: number;
  readonly pending: Map<string, PendingCall>;
  readonly emitted: Map<string, ToolLinkEvidenceV1>;
  /** Call ids a later result may never pair with: two unresolved calls claimed the same id. */
  readonly blocked: Set<string>;
  touch: number;
}

export interface ToolLinkEvidenceRecorderOptions {
  /** Guard overrides; tests use these to exercise eviction and retention deterministically. */
  maxSessions?: number;
  maxPendingPerSession?: number;
  maxEmittedPerSession?: number;
}

function boundedOption(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return maximum;
  }
  const floored = Math.floor(value);
  return floored >= 1 && floored <= maximum ? floored : maximum;
}

/**
 * Drops an inbound carrier before any trusted derivation.
 *
 * `metadata.resinToolLinkV1` is a capture product: a record's custom metadata, a replayed or forged
 * event, or any other inbound source may spell that key, and a structurally valid carrier is not
 * proof that capture derived it (its identifier strings are free text). It is therefore removed
 * first, and only a carrier this recorder derives is ever attached.
 */
function withoutInboundCarrier(event: NormalizedSessionEvent): NormalizedSessionEvent {
  if (!Object.prototype.hasOwnProperty.call(event.metadata ?? {}, RESIN_TOOL_LINK_EVIDENCE_KEY)) {
    return event;
  }
  const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
  delete metadata[RESIN_TOOL_LINK_EVIDENCE_KEY];
  return { ...event, metadata } as NormalizedSessionEvent;
}

function attachCarrier(
  event: NormalizedSessionEvent,
  carrier: ToolLinkEvidenceV1,
): NormalizedSessionEvent {
  const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
  metadata[RESIN_TOOL_LINK_EVIDENCE_KEY] = carrier;
  return { ...event, metadata } as NormalizedSessionEvent;
}

const FAILURE_ERROR_KEYS: Readonly<Record<string, true>> = {
  isError: true,
  is_error: true,
};
const FAILURE_EXIT_CODE_KEYS: Readonly<Record<string, true>> = { exitCode: true, exit_code: true };
const FAILURE_STATUS_KEYS: Readonly<Record<string, true>> = { status: true, state: true };
const FAILURE_STATUS_VALUES: Readonly<Record<string, true>> = {
  error: true,
  failed: true,
  failure: true,
};
/** Statuses that explicitly say the execution has not finished: never a completion. */
const UNFINISHED_STATUS_VALUES: Readonly<Record<string, true>> = {
  in_progress: true,
  pending: true,
  queued: true,
  running: true,
  started: true,
};
/** Keys that make an object an execution record, so its `status` is about the call and not data. */
const EXECUTION_RECORD_KEYS: Readonly<Record<string, true>> = {
  exitCode: true,
  exit_code: true,
  durationMs: true,
  duration_ms: true,
  wallTimeMs: true,
};

interface OutcomeScan {
  failure: boolean;
  /** True once an explicit execution outcome (an exit code or an execution status) was observed. */
  outcomeObserved: boolean;
  /** True when the result explicitly reports an execution that has not finished yet. */
  unfinished: boolean;
}

function descriptorValue(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Bounded scan of a tool result for an ACTUAL execution outcome. A harness `isError: false` is never
 * read as success; only an explicit nonzero exit code, an error flag, or an execution record's error
 * status makes the scan report a failure, and only an exit code or execution status makes it report
 * an observed outcome at all.
 */
function scanResultOutcome(result: unknown): OutcomeScan {
  const scan: OutcomeScan = { failure: false, outcomeObserved: false, unfinished: false };
  let budget = MAX_SCANNED_NODES;
  const visit = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > MAX_SCANNED_DEPTH) {
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && index < 16; index++) {
        visit(descriptorValue(value, String(index)), depth + 1);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(record);
    const executionRecord = keys.some((key) => EXECUTION_RECORD_KEYS[key] === true);
    for (const key of keys) {
      const member = descriptorValue(record, key);
      if (FAILURE_ERROR_KEYS[key] === true && member === true) {
        scan.failure = true;
        continue;
      }
      if (FAILURE_EXIT_CODE_KEYS[key] === true && typeof member === "number") {
        scan.outcomeObserved = true;
        if (member !== 0) {
          scan.failure = true;
        }
        continue;
      }
      if (FAILURE_STATUS_KEYS[key] === true && typeof member === "string") {
        const status = member.trim().toLowerCase();
        if (UNFINISHED_STATUS_VALUES[status] === true && (executionRecord || depth === 0)) {
          // An explicitly unfinished execution is not a completion, whatever else the result says.
          scan.unfinished = true;
          continue;
        }
        if (FAILURE_STATUS_VALUES[status] === true && executionRecord) {
          scan.outcomeObserved = true;
          scan.failure = true;
          continue;
        }
      }
      visit(member, depth + 1);
    }
  };
  visit(result, 0);
  return scan;
}

const RESULT_TEXT_KEYS: Readonly<Record<string, true>> = {
  text: true,
  output: true,
  stdout: true,
  stderr: true,
  outputText: true,
  content: true,
};

/**
 * Bounded inspection window over a result's text parts (in observation order).
 *
 * Each part is windowed head+tail, and the joined window keeps a head and a tail of the whole stream,
 * so a diagnostic at the END of a long output is still inspected. `truncated` is true whenever any
 * observed text was left out of the window, which is what lets a caller refuse to claim success on a
 * stream it did not fully read.
 */
function inspectResultText(result: unknown): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let truncated = false;
  let budget = MAX_SCANNED_NODES;
  const visit = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > MAX_SCANNED_DEPTH || parts.length >= MAX_RESULT_TEXT_PARTS) {
      return;
    }
    if (typeof value === "string") {
      if (value.length <= MAX_RESULT_TEXT_CHARS) {
        parts.push(value);
        return;
      }
      parts.push(
        `${value.slice(0, RESULT_TEXT_HEAD_CHARS)}\n${value.slice(-RESULT_TEXT_TAIL_CHARS)}`,
      );
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && index < 16; index++) {
        visit(descriptorValue(value, String(index)), depth + 1);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(record)) {
      if (RESULT_TEXT_KEYS[key] !== true) {
        continue;
      }
      visit(descriptorValue(record, key), depth + 1);
    }
  };
  visit(result, 0);

  const joined = parts.join("\n");
  if (joined.length <= MAX_RESULT_TEXT_CHARS) {
    return { text: joined, truncated };
  }
  let head = "";
  let index = 0;
  while (index < parts.length) {
    const part = parts[index]!;
    if (head.length + part.length + 1 > RESULT_TEXT_HEAD_CHARS) {
      break;
    }
    head = head.length === 0 ? part : `${head}\n${part}`;
    index += 1;
  }
  let tail = "";
  let back = parts.length - 1;
  while (back >= index) {
    const part = parts[back]!;
    if (tail.length + part.length + 1 > RESULT_TEXT_TAIL_CHARS) {
      break;
    }
    tail = tail.length === 0 ? part : `${part}\n${tail}`;
    back -= 1;
  }
  return { text: `${head}\n${tail}`, truncated: true };
}

/**
 * Output of a failed interpreter program: Python's traceback header, or the `SomeError: message` line
 * an uncaught exception (Python, Node, a CLI) ends with. Never a bare word such as `failed`, which
 * ordinary fetched content contains.
 */
const PROGRAM_FAILURE_OUTPUT =
  /^(?:Traceback \(most recent call last\):|\s*[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):)/m;

/**
 * Observed outcome of one completed call. A harness error flag is authoritative; then an explicit
 * execution outcome decides (a nonzero exit code, an error flag inside the result, an execution
 * record's error status); and program output decides only for an interpreter frame whose result
 * carried no explicit outcome at all — so a file or issue body that merely quotes a traceback cannot
 * mark a successful read as a failure. A harness `isError: false` is never read as success, and a
 * program stream that was only partly inspected (and carries no authoritative completion) proves
 * neither outcome, so it is reported as `unknown` and no carrier is emitted for it. A result that
 * explicitly reports an execution still running (or pending) is `unfinished`: not a completion, and
 * not evidence that the call succeeded.
 */
function observedOutcome(
  result: unknown,
  isError: boolean,
  programOutput: boolean,
): "success" | "failure" | "unknown" | "unfinished" {
  if (isError) {
    return "failure";
  }
  const scan = scanResultOutcome(result);
  if (scan.failure) {
    return "failure";
  }
  if (scan.unfinished) {
    return "unfinished";
  }
  if (!programOutput || scan.outcomeObserved) {
    return "success";
  }
  const inspection = inspectResultText(result);
  if (PROGRAM_FAILURE_OUTPUT.test(inspection.text)) {
    return "failure";
  }
  return inspection.truncated ? "unknown" : "success";
}

export class ToolLinkEvidenceRecorder {
  private readonly maxSessions: number;
  private readonly maxPendingPerSession: number;
  private readonly maxEmittedPerSession: number;
  private readonly sessions = new Map<string, RecordedScope>();
  private touchCounter = 0;

  constructor(options: ToolLinkEvidenceRecorderOptions = {}) {
    this.maxSessions = boundedOption(options.maxSessions, MAX_SESSIONS);
    this.maxPendingPerSession = boundedOption(
      options.maxPendingPerSession,
      MAX_PENDING_PER_SESSION,
    );
    this.maxEmittedPerSession = boundedOption(
      options.maxEmittedPerSession,
      MAX_EMITTED_PER_SESSION,
    );
  }

  /**
   * Observes one normalized event after id/dedup processing.
   *
   * Returns the unchanged event when no declared flow applies, otherwise a clone carrying a strict
   * validated carrier under `metadata.resinToolLinkV1`. Event ids, call ids, causal references and
   * ordering are copied through untouched. Never throws: capture must not fail because a declared
   * flow could not be represented.
   */
  public observe(event: NormalizedSessionEvent): NormalizedSessionEvent {
    try {
      return this.observeEvent(withoutInboundCarrier(event));
    } catch {
      return withoutInboundCarrier(event);
    }
  }

  /** Clears every scope, pending call, remembered carrier and ordinal. */
  public clear(): void {
    this.sessions.clear();
    this.touchCounter = 0;
  }

  private observeEvent(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type === "session_lifecycle") {
      if (event.lifecycleType === "end" || event.lifecycleType === "crash") {
        this.sessions.delete(event.sessionId);
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

  private observeToolCall(event: NormalizedToolCallEvent): NormalizedSessionEvent {
    const scope = this.scope(event.sessionId);
    if (scope.scopeId === undefined) {
      // The first captured call of this session/capture epoch fixes the scope of every ordinal.
      scope.scopeId = event.eventId;
    }
    const remembered = scope.emitted.get(event.eventId);
    if (remembered !== undefined) {
      return attachCarrier(event, remembered);
    }
    const existing = scope.pending.get(event.callId);
    if (existing !== undefined) {
      if (existing.callEventId === event.eventId) {
        // An identical replay of an unresolved call: already captured, nothing pending to redo.
        return event;
      }
      // A different unresolved call reused this id. Neither call may pair a later result, and the id
      // stays quarantined for the rest of the scope so no replacement is registered optimistically.
      scope.pending.delete(event.callId);
      this.quarantine(scope, event.callId);
      return event;
    }
    if (scope.blocked.has(event.callId)) {
      return event;
    }

    const flow = declaredFlowOfToolCall(event);
    const pending: PendingCall = {
      callId: event.callId,
      callEventId: event.eventId,
      callSequence: event.causalRef.causalSequence,
      toolName: event.toolName,
      ...(flow === undefined ? {} : { flow }),
    };
    this.rememberPending(scope, pending);
    if (flow === undefined) {
      return event;
    }

    const carrier = this.buildCarrier(scope, flow, {
      callId: event.callId,
      callEventId: event.eventId,
      status: "pending",
    });
    if (carrier === undefined) {
      return event;
    }
    this.rememberCarrier(scope, event.eventId, carrier);
    return attachCarrier(event, carrier);
  }

  private observeToolResult(event: NormalizedToolResultEvent): NormalizedSessionEvent {
    const scope = this.sessions.get(event.sessionId);
    if (scope === undefined) {
      return event;
    }
    const remembered = scope.emitted.get(event.eventId);
    if (remembered !== undefined) {
      return attachCarrier(event, remembered);
    }
    const pending = scope.pending.get(event.callId);
    if (
      pending === undefined ||
      scope.blocked.has(event.callId) ||
      pending.toolName !== event.toolName ||
      event.causalRef.causalSequence <= pending.callSequence ||
      event.eventId === pending.callEventId
    ) {
      // A result without a matched, strictly earlier call is not evidence of anything.
      return event;
    }
    const flow = pending.flow ?? this.embeddedFlow(event);
    if (flow === undefined) {
      // The call declared nothing and the result carries nothing to derive: release the pairing.
      scope.pending.delete(event.callId);
      return event;
    }
    const status = observedOutcome(event.result, event.isError, flow.programOutput);
    if (status === "unknown" || status === "unfinished") {
      // A program stream this recorder only partly read, or an execution the result itself reports as
      // still running, proves no outcome — so this result completes nothing. The call STAYS pending so
      // a later matching terminal result can still be its completion; bounded eviction (and the
      // original strictly-later ordering rule) remain the backstop.
      return event;
    }
    scope.pending.delete(event.callId);
    const contentKinds: readonly ToolLinkContentKind[] =
      flow.operation === "file.read" || flow.operation === "github.issue.read"
        ? declaredContentKindsOfText(inspectResultText(event.result).text)
        : [];
    const carrier = this.buildCarrier(
      scope,
      flow,
      {
        callId: event.callId,
        callEventId: pending.callEventId,
        resultEventId: event.eventId,
        status,
      },
      contentKinds,
    );
    if (carrier === undefined) {
      return event;
    }
    this.rememberCarrier(scope, event.eventId, carrier);
    return attachCarrier(event, carrier);
  }

  /**
   * A self-contained `command_exec` observes a command and its exit code together, so it is both the
   * call and the result side. A command whose spelling was already captured in this scope is skipped:
   * a harness that reports one execution both as a tool call and as a command record must not be
   * counted twice, and a captured command spelling is never attributed to a second event.
   */
  private observeCommand(event: NormalizedCommandExecEvent): NormalizedSessionEvent {
    const scope = this.scope(event.sessionId);
    if (scope.scopeId === undefined) {
      scope.scopeId = event.eventId;
    }
    const remembered = scope.emitted.get(event.eventId);
    if (remembered !== undefined) {
      return attachCarrier(event, remembered);
    }
    const flow = declaredFlowOfCommandExec(event);
    if (flow === undefined) {
      return event;
    }
    const carrier = this.buildCarrier(scope, flow, {
      callId: event.eventId,
      callEventId: event.eventId,
      resultEventId: event.eventId,
      status: event.exitCode === 0 ? "success" : "failure",
    });
    if (carrier === undefined) {
      return event;
    }
    this.rememberCarrier(scope, event.eventId, carrier);
    return attachCarrier(event, carrier);
  }

  /**
   * Declared flow recovered from the native call handoff a result may carry. The handoff is accepted
   * only when it names this very result's call and tool, so a forged or stale handoff contributes
   * nothing.
   */
  private embeddedFlow(event: NormalizedToolResultEvent): DeclaredFlow | undefined {
    const raw = event.metadata?.[RESIN_LOCAL_OMP_NATIVE_CALL_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const handoff = raw as Record<string, unknown>;
    const parameters = handoff.parameters;
    if (
      handoff.callId !== event.callId ||
      handoff.toolName !== event.toolName ||
      typeof parameters !== "object" ||
      parameters === null ||
      Array.isArray(parameters)
    ) {
      return undefined;
    }
    const synthetic: NormalizedToolCallEvent = {
      ...event,
      type: "tool_call",
      parameters: parameters as Record<string, unknown>,
    };
    return declaredFlowOfToolCall(synthetic);
  }

  /**
   * Strict carrier for one declared flow. Resource ordinals are allocated only when the carrier is
   * about to be emitted: a flow that cannot be represented does not consume ordinals, so later
   * carriers keep the same refs a full replay would assign them.
   */
  private buildCarrier(
    scope: RecordedScope,
    flow: DeclaredFlow,
    observation: ToolLinkObservation,
    extraContentKinds: readonly ToolLinkContentKind[] = [],
  ): ToolLinkEvidenceV1 | undefined {
    if (scope.scopeId === undefined) {
      return undefined;
    }
    if (
      flow.reads.length > TOOL_LINK_EVIDENCE_LIMITS.reads ||
      flow.writes.length > TOOL_LINK_EVIDENCE_LIMITS.writes ||
      flow.inputs.length > TOOL_LINK_EVIDENCE_LIMITS.inputs
    ) {
      // More declared resources than a bounded carrier states: no carrier rather than a partial one.
      return undefined;
    }
    const fresh = new Set<string>();
    for (const resource of [...flow.reads, ...flow.writes]) {
      if (!scope.refs.has(resource.identity)) {
        fresh.add(resource.identity);
      }
    }
    if (scope.nextOrdinal + fresh.size > TOOL_LINK_EVIDENCE_LIMITS.maxRefIndex + 1) {
      return undefined;
    }
    for (const identity of fresh) {
      scope.refs.set(identity, `r${scope.nextOrdinal}`);
      scope.nextOrdinal += 1;
    }

    const dedupe = (
      resources: readonly DeclaredResource[],
    ): { kind: DeclaredResource["kind"]; ref: string }[] => {
      const seen = new Set<string>();
      const entries: { kind: DeclaredResource["kind"]; ref: string }[] = [];
      for (const resource of resources) {
        const ref = scope.refs.get(resource.identity);
        if (ref === undefined || seen.has(ref)) {
          continue;
        }
        seen.add(ref);
        entries.push({ kind: resource.kind, ref });
      }
      return entries;
    };
    const reads = dedupe(flow.reads);
    const writes = dedupe(flow.writes);
    const inputs: { name: DeclaredFlow["inputs"][number]["name"]; ref: string }[] = [];
    for (const input of flow.inputs) {
      const ref = scope.refs.get(input.resource.identity);
      if (ref === undefined || inputs.some((entry) => entry.name === input.name)) {
        continue;
      }
      inputs.push({ name: input.name, ref });
    }
    const contentKinds: ToolLinkContentKind[] = [];
    for (const kind of [...flow.contentKinds, ...extraContentKinds]) {
      if (!contentKinds.includes(kind)) {
        contentKinds.push(kind);
      }
    }

    const parsed = ToolLinkEvidenceV1Schema.safeParse({
      version: 1,
      scopeId: scope.scopeId,
      operation: flow.operation,
      reads,
      writes,
      inputs,
      contentKinds: contentKinds.slice(0, TOOL_LINK_EVIDENCE_LIMITS.contentKinds),
      observation,
    });
    return parsed.success ? parsed.data : undefined;
  }

  private rememberPending(scope: RecordedScope, pending: PendingCall): void {
    if (scope.pending.size >= this.maxPendingPerSession) {
      const oldest = scope.pending.keys().next().value;
      if (oldest !== undefined) {
        scope.pending.delete(oldest);
      }
    }
    scope.pending.set(pending.callId, pending);
  }

  /**
   * Quarantines one call id for the rest of the scope, with FIFO eviction so the set stays bounded.
   * A quarantined id never registers a pending call and never pairs a result: the observed events are
   * kept, but no dataflow is attributed to them.
   */
  private quarantine(scope: RecordedScope, callId: string): void {
    while (scope.blocked.size >= MAX_BLOCKED_CALLS) {
      const oldest = scope.blocked.values().next().value;
      if (oldest === undefined) {
        break;
      }
      scope.blocked.delete(oldest);
    }
    scope.blocked.add(callId);
  }

  private rememberCarrier(
    scope: RecordedScope,
    eventId: string,
    carrier: ToolLinkEvidenceV1,
  ): void {
    while (scope.emitted.size >= this.maxEmittedPerSession) {
      const oldest = scope.emitted.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      scope.emitted.delete(oldest);
    }
    scope.emitted.set(eventId, carrier);
  }

  /** Session scope state, with LRU eviction so a long-lived recorder stays bounded. */
  private scope(sessionId: string): RecordedScope {
    const existing = this.sessions.get(sessionId);
    this.touchCounter += 1;
    if (existing !== undefined) {
      existing.touch = this.touchCounter;
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      let oldestId: string | undefined;
      let oldestTouch = Number.POSITIVE_INFINITY;
      for (const [id, scope] of this.sessions) {
        if (scope.touch < oldestTouch) {
          oldestTouch = scope.touch;
          oldestId = id;
        }
      }
      if (oldestId !== undefined) {
        this.sessions.delete(oldestId);
      }
    }
    const created: RecordedScope = {
      sessionId,
      refs: new Map<string, string>(),
      nextOrdinal: 0,
      pending: new Map<string, PendingCall>(),
      emitted: new Map<string, ToolLinkEvidenceV1>(),
      blocked: new Set<string>(),
      touch: this.touchCounter,
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}

export function createToolLinkEvidenceRecorder(
  options: ToolLinkEvidenceRecorderOptions = {},
): ToolLinkEvidenceRecorder {
  return new ToolLinkEvidenceRecorder(options);
}
