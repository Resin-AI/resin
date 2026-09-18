/**
 * Workflow call recorder: attaches the per-call carrier the general compiler consumes.
 *
 * A call routed through the reference-aware invocation surface (`invoke_tool`) arrives
 * in the transcript with its argument envelopes verbatim. This recorder reads those
 * envelopes with the same shared analyzer the dispatcher used, so the recorded origin
 * of every argument is exactly what the caller stated — a literal, a declared input,
 * or a reference to an earlier result — never a guess from a matching value.
 *
 * The carrier is attached to the normalized event BEFORE privacy projection, as
 * `metadata.workflowCall`, so the live path and the import path produce identical
 * records. Projection re-reads it through `readWorkflowCallCarrier` and copies it
 * through by value; literal values ride along (they are what the workflow is made of)
 * while private leaves were already replaced by `private:` references whose originals
 * stay in the local value store.
 */

import {
  type AgentArgumentOrigin,
  type NormalizedSessionEvent,
  type WorkflowArgumentProvenance,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  type WorkflowValuePath,
  analyzeAgentArguments,
} from "@resin/contracts";
import { extractComputationSourceFrames } from "./computation/source-frames.js";
import { extractRawCommandStringFromEvent } from "./deterministic-command-sequence.js";
import { deriveNativeCalls } from "./native-argument-derivation.js";
import {
  FilePrivateValueStore,
  type PrivateValueOrigin,
  type PrivateValueStore,
  containsRedactionPlaceholder,
} from "./private-value-store.js";
import { declaredFlowOfToolCall } from "./tool-links/declared-flow.js";

export const RESIN_WORKFLOW_CALL_METADATA_KEY = "workflowCall";
export const RESIN_WORKFLOW_RESULT_METADATA_KEY = "workflowResult";

/** The runtime family every invoke_tool-routed callable belongs to. */
export const RESIN_INVOKE_TOOL_RUNTIME = "resin-invoke-tool";

/**
 * A callable the harness reached over a tool protocol (an MCP server, a harness builtin surface).
 * The call is re-made by name through the connection discovery recorded for it.
 */
export const RESIN_TOOL_PROTOCOL_RUNTIME = "resin-tool-protocol";

/** A callable whose recorded artifact is a process program: a shell command or an exact argv. */
export const RESIN_PROCESS_RUNTIME = "resin-process";

/** A callable whose recorded artifact is a program in a language, run through its interpreter. */
export const RESIN_PROGRAM_RUNTIME = "resin-program";

/** The runtime families an ordinary native call can belong to, decided by the record, not by name. */
export const RESIN_NATIVE_RUNTIMES = [
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
] as const;

/** What discovery recorded about a callable, keyed by the name the harness called it by. */
export interface DiscoveredCallable {
  provider?: string;
  inputSchema?: WorkflowJsonValue;
}

/** The carrier attached to a tool_call event: how to call the callable again. */
export interface WorkflowCallCarrier {
  runtime: string;
  /** The effective callable: the tool the call was routed to, not the router. */
  name: string;
  /** The provider or connection the call was reached through, when discovery recorded one. */
  connection?: string;
  /** The schema discovery recorded for this callable, when the record carries one. */
  inputSchema?: WorkflowJsonValue;
  /** The directory the program ran in, when the record identifies one. */
  cwd?: string;
  /**
   * The program this call executed, preserved verbatim, for a callable whose runtime is a program.
   * It is a record of what ran; a host executes it through the argument the program arrived in so
   * that resolved private leaves and inputs reach the program text before it is run.
   */
  program?: WorkflowRecordedProgram;
  /** Per top-level argument, the origin the caller stated, swept for private values. */
  origins: Record<string, AgentArgumentOrigin>;
  /** Declared caller inputs, with the types the caller used. */
  inputs: Array<{
    name: string;
    argument: string;
    path: ReadonlyArray<string | number>;
    type: string;
  }>;
  /**
   * Per top-level argument, what the record says about the origin above. Absent for the composed
   * surface, where every origin is what the caller itself stated.
   */
  provenance?: Record<string, WorkflowArgumentProvenance>;
  /** Calls this one must follow, because both declared use of the same resource. */
  dependsOnCallIds?: string[];
  /** Bindings the values only suggest. Reported here; never executable as recorded. */
  candidates?: WorkflowCallCandidate[];
}

/**
 * A binding an ordinary call's values suggest.
 *
 * It is expressed against the call that produced the value, not against a step id, because the
 * capture does not know how the recording will be numbered — and it is never applied by capture.
 */
export interface WorkflowCallCandidate {
  argument: string;
  path: WorkflowValuePath;
  proposed:
    | { kind: "result"; callId: string; path: WorkflowValuePath }
    | {
        kind: "input";
        name: string;
        type: "string" | "number" | "boolean" | "object" | "array";
      };
  reason:
    | "equal-to-earlier-result"
    | "varies-across-executions"
    | "declared-by-the-callable"
    | "tracks-earlier-result-across-executions";
  evidence?: WorkflowJsonValue;
  /** The fact the record does not establish, so a refusal can be reported instead of silent. */
  missing: string;
}

/** One observed call kept locally: its real values never leave this machine. */
interface LocalCall {
  callId: string;
  toolName: string;
  /** Ordinal inside its task, so two tasks can be compared position by position. */
  position: number;
  arguments: Record<string, WorkflowJsonValue>;
  result?: WorkflowJsonValue;
  reads?: string[];
  writes?: string[];
  /** The callable's discovered input schema, when discovery recorded one. */
  inputSchema?: WorkflowJsonValue;
  /** Arguments this call kept as local resources rather than as caller values. */
  privateArguments?: string[];
}

/** Per-session derivation state, bounded so a long session cannot grow without limit. */
interface SessionDerivationState {
  turnKey: string;
  position: number;
  calls: LocalCall[];
  /** The first value each argument position took, for comparing later tasks against it. */
  baseline: Map<string, WorkflowJsonValue>;
}

/** Observed calls kept per session for derivation. */
const MAX_LOCAL_CALLS = 64;
/** Sessions retained before the least recently used is dropped. */
const MAX_SESSIONS = 16;
/** Shortest string offered as a caller-input candidate, for the same reason as a binding. */
const MIN_INPUT_CANDIDATE_LENGTH = 4;

function isPlainObject(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROGRAM_KINDS: Readonly<Record<string, true>> = {
  shell: true,
  python: true,
  javascript: true,
  typescript: true,
};

function isJsonValue(value: unknown): value is WorkflowJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

/** Reads a recorded program back through the frozen vocabulary, dropping anything else. */
function readProgram(value: unknown): WorkflowRecordedProgram | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = value.kind;
  if (typeof kind !== "string" || PROGRAM_KINDS[kind] !== true) return undefined;
  if (typeof value.source !== "string") return undefined;
  const program: WorkflowRecordedProgram = {
    kind: kind as WorkflowRecordedProgram["kind"],
    source: value.source,
  };
  if (value.argv !== undefined) {
    if (!Array.isArray(value.argv) || !value.argv.every((entry) => typeof entry === "string")) {
      return undefined;
    }
    program.argv = value.argv as string[];
  }
  if (value.argument !== undefined) {
    if (typeof value.argument !== "string") return undefined;
    program.argument = value.argument;
  }
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string") return undefined;
    program.cwd = value.cwd;
  }
  return program;
}

const PROVENANCE_STANDINGS: Readonly<Record<string, true>> = {
  recorded: true,
  derived: true,
  candidate: true,
};

function readProvenance(value: unknown): WorkflowArgumentProvenance | undefined {
  if (!isPlainObject(value)) return undefined;
  const standing = value.standing;
  const rule = value.rule;
  if (typeof standing !== "string" || PROVENANCE_STANDINGS[standing] !== true) return undefined;
  if (typeof rule !== "string" || rule.length === 0) return undefined;
  const provenance: WorkflowArgumentProvenance = {
    standing: standing as WorkflowArgumentProvenance["standing"],
    rule: rule as WorkflowArgumentProvenance["rule"],
  };
  if (value.evidence !== undefined) {
    if (!isJsonValue(value.evidence)) return undefined;
    provenance.evidence = value.evidence;
  }
  if (value.missing !== undefined) {
    if (typeof value.missing !== "string") return undefined;
    provenance.missing = value.missing;
  }
  return provenance;
}

const CANDIDATE_REASONS: Readonly<Record<string, true>> = {
  "equal-to-earlier-result": true,
  "varies-across-executions": true,
  "declared-by-the-callable": true,
};

/** Reads one suggested binding back through the frozen vocabulary, or drops it. */
function readCandidate(value: unknown): WorkflowCallCandidate | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.argument !== "string" || value.argument.length === 0) return undefined;
  if (value.path !== undefined && !Array.isArray(value.path)) return undefined;
  if (typeof value.reason !== "string" || CANDIDATE_REASONS[value.reason] !== true)
    return undefined;
  if (typeof value.missing !== "string" || value.missing.length === 0) return undefined;
  const proposed = value.proposed;
  if (!isPlainObject(proposed)) return undefined;
  let read: WorkflowCallCandidate["proposed"] | undefined;
  if (proposed.kind === "result" && typeof proposed.callId === "string") {
    read = { kind: "result", callId: proposed.callId, path: readValuePath(proposed.path) };
  } else if (proposed.kind === "input" && typeof proposed.name === "string") {
    const type =
      proposed.type === "number"
        ? "number"
        : proposed.type === "boolean"
          ? "boolean"
          : proposed.type === "object"
            ? "object"
            : proposed.type === "array"
              ? "array"
              : "string";
    read = { kind: "input", name: proposed.name, type };
  }
  if (read === undefined) return undefined;
  const candidate: WorkflowCallCandidate = {
    argument: value.argument,
    path: readValuePath(value.path),
    proposed: read,
    reason: value.reason as WorkflowCallCandidate["reason"],
    missing: value.missing,
  };
  if (value.evidence !== undefined) {
    if (!isJsonValue(value.evidence)) return undefined;
    candidate.evidence = value.evidence;
  }
  return candidate;
}

function readValuePath(value: unknown): WorkflowValuePath {
  if (!Array.isArray(value)) return [];
  const path: Array<string | number> = [];
  for (const part of value) {
    if (typeof part === "string") path.push(part);
    else if (typeof part === "number" && Number.isFinite(part)) path.push(part);
  }
  return path;
}
/**
 * The reference-aware invocation surface, however the harness spelled it: bare
 * `invoke_tool`/`sys_invoke_tool`, or an MCP-prefixed `mcp__<server>__invoke_tool`.
 */
function isInvokeToolCallName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "invoke_tool" || value === "sys_invoke_tool") return true;
  return value.endsWith("__invoke_tool") && value.startsWith("mcp__");
}

function isWorkflowCallCarrier(value: unknown): value is WorkflowCallCarrier {
  if (!isPlainObject(value)) return false;
  if (typeof value.runtime !== "string" || typeof value.name !== "string") return false;
  if (!isPlainObject(value.origins)) return false;
  if (value.connection !== undefined && typeof value.connection !== "string") return false;
  if (!Array.isArray(value.inputs)) return false;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
  if (value.inputSchema !== undefined && !isJsonValue(value.inputSchema)) return false;
  if (value.program !== undefined && readProgram(value.program) === undefined) return false;
  if (value.provenance !== undefined) {
    if (!isPlainObject(value.provenance)) return false;
    for (const entry of Object.values(value.provenance)) {
      if (readProvenance(entry) === undefined) return false;
    }
  }
  if (value.dependsOnCallIds !== undefined) {
    if (
      !Array.isArray(value.dependsOnCallIds) ||
      !value.dependsOnCallIds.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      return false;
    }
  }
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates)) return false;
    for (const entry of value.candidates) {
      if (readCandidate(entry) === undefined) return false;
    }
  }
  return true;
}

/**
 * Re-reads a carrier for projection: only the frozen carrier vocabulary survives, so a
 * malformed or smuggled field is dropped rather than carried upstream.
 */
export function readWorkflowCallCarrier(value: unknown): WorkflowCallCarrier | undefined {
  if (!isWorkflowCallCarrier(value)) return undefined;
  const carrier: WorkflowCallCarrier = {
    runtime: value.runtime,
    name: value.name,
    origins: JSON.parse(JSON.stringify(value.origins)) as Record<string, AgentArgumentOrigin>,
    inputs: JSON.parse(JSON.stringify(value.inputs)) as WorkflowCallCarrier["inputs"],
  };
  if (value.connection !== undefined) carrier.connection = value.connection;
  if (value.cwd !== undefined) carrier.cwd = value.cwd;
  if (value.inputSchema !== undefined) {
    carrier.inputSchema = JSON.parse(JSON.stringify(value.inputSchema)) as WorkflowJsonValue;
  }
  const program = value.program === undefined ? undefined : readProgram(value.program);
  if (program !== undefined) carrier.program = program;
  if (value.provenance !== undefined) {
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    for (const [argument, entry] of Object.entries(value.provenance)) {
      const read = readProvenance(entry);
      if (read !== undefined) provenance[argument] = read;
    }
    carrier.provenance = provenance;
  }
  if (value.dependsOnCallIds !== undefined) {
    carrier.dependsOnCallIds = [...value.dependsOnCallIds];
  }
  if (value.candidates !== undefined) {
    const candidates: WorkflowCallCandidate[] = [];
    for (const entry of value.candidates) {
      const read = readCandidate(entry);
      if (read !== undefined) candidates.push(read);
    }
    carrier.candidates = candidates;
  }
  return carrier;
}

/** Re-reads a result carrier for projection: the handle token only. */
export function readWorkflowResultCarrier(value: unknown): { handle: string } | undefined {
  if (!isPlainObject(value) || typeof value.handle !== "string" || value.handle.length === 0) {
    return undefined;
  }
  return { handle: value.handle };
}

export interface WorkflowCallRecorderOptions {
  /** The local store private leaves are written to; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
}

export class WorkflowCallRecorder {
  private readonly privateValues: PrivateValueStore;
  /** The workspace whose session is being observed; stamped on every private entry. */
  private observeAccess: PrivateValueOrigin | undefined;
  /** Tool name → what the session's discovery events reported about the callable. */
  private readonly discovered = new Map<string, DiscoveredCallable>();
  /**
   * Per-session derivation state: the observed calls whose values must stay here for the
   * conclusions that need them. Bounded per session and by session count.
   */
  private readonly sessions = new Map<string, SessionDerivationState>();
  private privateCounter = 0;

  constructor(options: WorkflowCallRecorderOptions = {}) {
    this.privateValues = options.privateValues ?? FilePrivateValueStore.default();
  }

  /** Drops per-session state; the coordinator calls this between sessions. */
  clear(): void {
    this.discovered.clear();
    this.sessions.clear();
    this.privateCounter = 0;
    this.observeAccess = undefined;
  }

  /** The state of one session, evicting the least recently touched when the bound is reached. */
  private sessionState(sessionId: string): SessionDerivationState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      // Re-insert so iteration order keeps the most recently used session last.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionDerivationState = {
      turnKey: "",
      position: 0,
      calls: [],
      baseline: new Map(),
    };
    this.sessions.set(sessionId, created);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    return created;
  }

  observe(
    event: NormalizedSessionEvent,
    /**
     * The workspace the observed session belongs to. Private entries are stamped with it so a
     * later executor can refuse a workflow that only knows the reference string.
     */
    access?: PrivateValueOrigin,
  ): NormalizedSessionEvent {
    this.observeAccess = access;
    if (event.type === "tool_discovery") {
      for (const tool of event.tools) {
        const recorded: DiscoveredCallable = {};
        if (tool.provider !== undefined) recorded.provider = tool.provider;
        if (tool.inputSchema !== undefined) {
          recorded.inputSchema = tool.inputSchema as WorkflowJsonValue;
        }
        this.discovered.set(tool.name, recorded);
      }
      return event;
    }
    if (event.type === "tool_call") return this.observeCall(event);
    if (event.type === "tool_result") return this.observeResult(event);
    return event;
  }

  /**
   * Replaces literal leaves that still carry a redaction placeholder with `private:`
   * references, writing the redacted leaf to the local store so the executor can
   * reconstruct the original at invocation time.
   */
  private sweepOrigin(origin: AgentArgumentOrigin, sessionId: string): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (value: WorkflowJsonValue): AgentArgumentOrigin => {
          if (typeof value === "string" && containsRedactionPlaceholder(value)) {
            const reference = `private:${sessionId}:${this.privateCounter++}`;
            this.privateValues.set(reference, value, this.observeAccess);
            return { type: "private", reference };
          }
          if (Array.isArray(value)) {
            return { type: "array", items: value.map(expand) };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) entries[key] = expand(entry);
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(origin.value);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.sweepOrigin(entry, sessionId);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item) => this.sweepOrigin(item, sessionId)),
        };
      default:
        return origin;
    }
  }

  /**
   * Attaches the carrier the compiler consumes.
   *
   * Both surfaces are recorded the same way, and neither one changes what the caller wrote: a call
   * through the reference-aware invocation surface keeps the origins the caller itself stated, and
   * a call the model made with its ordinary tools is recorded from what the harness actually
   * dispatched — the callable it named, the arguments it passed, and the program the record shows
   * it ran. Nothing here asks the model to spell its calls differently.
   */
  private observeCall(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type !== "tool_call") return event;
    if (isInvokeToolCallName(event.toolName)) return this.observeComposedCall(event);
    return this.observeNativeCall(event);
  }

  /** Records a call composed through the reference-aware surface, keeping the caller's envelopes. */
  private observeComposedCall(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
  ): NormalizedSessionEvent {
    const parameters = event.parameters;
    if (!isPlainObject(parameters)) return event;
    const routedName =
      typeof parameters.toolName === "string"
        ? parameters.toolName
        : typeof parameters.name === "string"
          ? parameters.name
          : typeof parameters.tool_name === "string"
            ? parameters.tool_name
            : typeof parameters.toolId === "string"
              ? parameters.toolId
              : undefined;
    if (routedName === undefined) return event;
    const inner = parameters.parameters ?? parameters.arguments;
    const analysis = analyzeAgentArguments(isPlainObject(inner) ? inner : {});
    const origins: Record<string, AgentArgumentOrigin> = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    for (const [argument, origin] of Object.entries(analysis.origins)) {
      origins[argument] = this.sweepOrigin(origin, event.sessionId);
      provenance[argument] = { standing: "recorded", rule: "caller-stated" };
    }
    const carrier: WorkflowCallCarrier = {
      runtime: RESIN_INVOKE_TOOL_RUNTIME,
      name: routedName,
      origins,
      inputs: analysis.inputs.map((input) => ({
        name: input.name,
        argument: input.argument,
        path: input.path,
        type: input.type,
      })),
      provenance,
    };
    const discovered = this.discovered.get(routedName);
    if (discovered?.provider !== undefined) carrier.connection = discovered.provider;
    return this.withCallCarrier(event, carrier);
  }

  /**
   * Records a call the model made with an ordinary tool.
   *
   * The values and the program of an ordinary call are the user's own work, and they stay on this
   * machine: every argument leaf, and the program text itself, is replaced by a local reference the
   * executor resolves at invocation time. What travels is the structure — which callable, over which
   * connection, with which argument names — plus the conclusions the record supports.
   *
   * Those conclusions need the values, so they are reached here, on the pre-privacy record, and
   * travel as conclusions: the calls this one must follow because of declared resource use, and the
   * bindings the values only suggest, each naming the fact this recording does not establish.
   */
  private observeNativeCall(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
  ): NormalizedSessionEvent {
    const parameters = isPlainObject(event.parameters) ? event.parameters : {};
    const program = this.programOf(event, parameters);
    const analysis = analyzeAgentArguments(parameters);
    const origins: Record<string, AgentArgumentOrigin> = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    for (const [argument, origin] of Object.entries(analysis.origins)) {
      origins[argument] = this.launderOrigin(origin, event.sessionId);
      provenance[argument] = { standing: "derived", rule: "single-observation" };
    }
    const carrier: WorkflowCallCarrier = {
      runtime:
        program === undefined
          ? RESIN_TOOL_PROTOCOL_RUNTIME
          : program.kind === "shell"
            ? RESIN_PROCESS_RUNTIME
            : RESIN_PROGRAM_RUNTIME,
      name: event.toolName,
      origins,
      inputs: [],
      provenance,
    };
    if (program !== undefined) carrier.program = program;
    const discovered = this.discovered.get(event.toolName);
    if (discovered?.provider !== undefined) carrier.connection = discovered.provider;
    if (discovered?.inputSchema !== undefined) carrier.inputSchema = discovered.inputSchema;

    const state = this.sessionState(event.sessionId);
    const call = this.recordLocalCall(state, event, parameters);
    const relationships = this.relateLocalCall(state, call);
    if (relationships.dependsOnCallIds.length > 0) {
      carrier.dependsOnCallIds = relationships.dependsOnCallIds;
    }
    if (relationships.candidates.length > 0) carrier.candidates = relationships.candidates;
    return this.withCallCarrier(event, carrier);
  }

  /**
   * Replaces every leaf of a recorded value with a local reference, so the value itself never leaves
   * this machine. A composite keeps its shape — which is what a workflow argument is made of — and
   * each leaf is stored locally, exactly as a private leaf already is.
   */
  private launderOrigin(origin: AgentArgumentOrigin, sessionId: string): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (value: WorkflowJsonValue): AgentArgumentOrigin => {
          if (Array.isArray(value)) return { type: "array", items: value.map(expand) };
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) entries[key] = expand(entry);
            return { type: "object", entries };
          }
          return this.storeLocalValue(value, sessionId);
        };
        return expand(origin.value);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.launderOrigin(entry, sessionId);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item) => this.launderOrigin(item, sessionId)),
        };
      default:
        return origin;
    }
  }

  private storeLocalValue(value: WorkflowJsonValue, sessionId: string): AgentArgumentOrigin {
    const reference = `private:${sessionId}:${this.privateCounter++}`;
    this.privateValues.set(reference, value, this.observeAccess);
    return { type: "private", reference };
  }

  /** Keeps the observed call locally, so the conclusions that need its values are reached here. */
  private recordLocalCall(
    state: SessionDerivationState,
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
    parameters: Record<string, WorkflowJsonValue>,
  ): LocalCall {
    const turnKey = `${event.causalRef?.turnIndex ?? 0}`;
    if (state.turnKey !== turnKey) {
      state.turnKey = turnKey;
      state.position = 0;
    }
    const flow = declaredFlowOfToolCall(event);
    const discovered = this.discovered.get(event.toolName);
    const heldLocally = Object.entries(parameters)
      .filter(([, value]) => typeof value === "string" && containsRedactionPlaceholder(value))
      .map(([argument]) => argument);
    const call: LocalCall = {
      callId: event.callId,
      toolName: event.toolName,
      position: state.position,
      arguments: parameters,
      ...(discovered?.inputSchema === undefined ? {} : { inputSchema: discovered.inputSchema }),
      ...(heldLocally.length === 0 ? {} : { privateArguments: heldLocally }),
      ...(flow === undefined
        ? {}
        : {
            reads: flow.reads.map((resource) => `${resource.kind}:${resource.identity}`),
            writes: flow.writes.map((resource) => `${resource.kind}:${resource.identity}`),
          }),
    };
    state.position += 1;
    state.calls.push(call);
    while (state.calls.length > MAX_LOCAL_CALLS) state.calls.shift();
    return call;
  }

  /**
   * What the calls observed so far establish about this one: the calls it must follow, and the
   * bindings its values only suggest.
   *
   * A suggestion is never a binding. The only value offered as a result binding is one that first
   * appeared in an earlier call's result — a value the record already contained before that call
   * produced it is not evidence of anything, and offering it would turn a coincidence into a
   * dependency. An argument that took a different value in another task is offered as a caller
   * input: evidence that the value is not a constant of the work, not proof that a caller supplies
   * it. Both are reported, neither executes.
   */
  private relateLocalCall(
    state: SessionDerivationState,
    call: LocalCall,
  ): { dependsOnCallIds: string[]; candidates: WorkflowCallCandidate[] } {
    const candidates: WorkflowCallCandidate[] = [];

    // Resources the earlier calls declared they wrote and this call declared it reads. Both sides
    // named the resource, so the order is a fact of the record rather than a guess from the values.
    const dependsOnCallIds: string[] = [];
    if (call.reads !== undefined && call.reads.length > 0) {
      const reads = new Set(call.reads);
      for (const earlier of state.calls) {
        if (earlier === call) break;
        if (earlier.writes === undefined) continue;
        if (!earlier.writes.some((resource) => reads.has(resource))) continue;
        dependsOnCallIds.push(earlier.callId);
      }
    }

    // The same argument position, in another task, with a different value.
    for (const [argument, value] of Object.entries(call.arguments)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      const key = `${call.toolName}|${call.position}|${argument}`;
      const previous = state.baseline.get(key);
      if (previous === undefined) {
        state.baseline.set(key, value);
        continue;
      }
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      if (typeof previous !== typeof value) continue;
      if (typeof value === "string" && value.length < MIN_INPUT_CANDIDATE_LENGTH) continue;
      candidates.push({
        argument,
        path: [],
        proposed: {
          kind: "input",
          name: `${call.toolName}_${argument}`.replace(/[^A-Za-z0-9_]+/g, "_"),
          type:
            typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean",
        },
        reason: "varies-across-executions",
        evidence: { tasks: 2 },
        missing:
          "this argument took a different value in an earlier task, but no task used a value the record had never seen, so the record does not establish that a caller supplies it",
      });
    }

    // Bindings the values suggest, over the calls this session has observed.
    const index = state.calls.indexOf(call);
    if (index < 0) return { dependsOnCallIds, candidates };
    const derivation = deriveNativeCalls(
      state.calls.map((entry, position) => ({
        callId: entry.callId,
        stepId: `local${position}`,
        toolName: entry.toolName,
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: entry.arguments,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.inputSchema === undefined ? {} : { inputSchema: entry.inputSchema }),
        ...(entry.privateArguments === undefined
          ? {}
          : { privateArguments: entry.privateArguments }),
      })),
    );
    const ownStepId = `local${index}`;
    for (const candidate of derivation.candidates) {
      if (candidate.stepId !== ownStepId) continue;
      if (candidate.proposed.kind === "input") {
        candidates.push({
          argument: candidate.argument,
          path: candidate.path,
          proposed: candidate.proposed,
          reason: candidate.reason,
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
          missing: candidate.missing,
        });
        continue;
      }
      const producingIndex = Number.parseInt(candidate.proposed.stepId.slice("local".length), 10);
      const producingCall = state.calls[producingIndex];
      if (producingCall === undefined) continue;
      candidates.push({
        argument: candidate.argument,
        path: candidate.path,
        proposed: { kind: "result", callId: producingCall.callId, path: candidate.proposed.path },
        reason: "equal-to-earlier-result",
        ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
        missing: candidate.missing,
      });
    }
    return { dependsOnCallIds, candidates };
  }

  /**
   * The program this call ran, as the record establishes it.
   *
   * A command-bearing call is a process program whatever the callable is called; a call whose record
   * frames source in a language is a program in that language. Neither is decided by a list of tool
   * names, and a plain shell chain is preserved whole — it is never split into steps or reduced to
   * an argv, because its operators, pipes, redirections and exit status are part of what it did.
   *
   * The program text is not carried: it is the user's own work, so it stays in the local value store
   * behind the argument it arrived in, and the host resolves it before running. What travels is that
   * this call WAS a program, which language it was, and which argument holds it.
   */
  private programOf(
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
    parameters: Record<string, WorkflowJsonValue>,
  ): WorkflowRecordedProgram | undefined {
    const command = extractRawCommandStringFromEvent(event);
    if (command !== null) {
      const program: WorkflowRecordedProgram = { kind: "shell", source: "" };
      const argument = this.argumentHolding(parameters, command);
      if (argument !== undefined) program.argument = argument;
      return program;
    }
    for (const frame of extractComputationSourceFrames(event)) {
      if (frame.rejectionReason !== undefined) continue;
      const program: WorkflowRecordedProgram = { kind: frame.language, source: "" };
      const argument = this.argumentHolding(parameters, frame.source);
      if (argument !== undefined) program.argument = argument;
      return program;
    }
    return undefined;
  }

  /** The top-level argument that carries this program text, so a host can resolve it before running. */
  private argumentHolding(
    parameters: Record<string, WorkflowJsonValue>,
    program: string,
  ): string | undefined {
    const trimmed = program.trim();
    for (const [name, value] of Object.entries(parameters)) {
      if (typeof value !== "string") continue;
      if (value === program || value.trim() === trimmed) return name;
    }
    return undefined;
  }

  private withCallCarrier(
    event: NormalizedSessionEvent,
    carrier: WorkflowCallCarrier,
  ): NormalizedSessionEvent {
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_CALL_METADATA_KEY] = carrier;
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  private observeResult(event: NormalizedSessionEvent): NormalizedSessionEvent {
    if (event.type === "tool_result") {
      // The result's own value is what a later call's argument may have carried, so it is kept
      // locally for that comparison and never attached to the event.
      const state = this.sessionState(event.sessionId);
      for (let index = state.calls.length - 1; index >= 0; index -= 1) {
        const call = state.calls[index]!;
        if (call.callId !== event.callId) continue;
        call.result = extractResultValueOf(event.result);
        break;
      }
    }
    const handle = this.resultHandle(event);
    if (handle === undefined) return event;
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_RESULT_METADATA_KEY] = { handle };
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  /**
   * The handle a composed call returned for its result, when the record carries one.
   * A tool that happens to return a `ref:`-shaped handle field is indistinguishable
   * from a real one — and harmless, since the value genuinely came from that call.
   */
  private resultHandle(event: NormalizedSessionEvent): string | undefined {
    if (event.type !== "tool_result" || !isPlainObject(event.result)) return undefined;
    const handle = event.result.handle;
    return typeof handle === "string" && handle.startsWith("ref:") ? handle : undefined;
  }
}

/** A tool result as a comparable value: its text when it is text, its own value otherwise. */
function extractResultValueOf(result: unknown): WorkflowJsonValue | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
    return result;
  }
  if (result === null) return null;
  if (Array.isArray(result)) return result as WorkflowJsonValue;
  if (typeof result === "object") return result as WorkflowJsonValue;
  return undefined;
}
