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

import { RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY } from "@resin/adapter-omp";
import {
  type AgentArgumentOrigin,
  type NormalizedSessionEvent,
  type ProgramLanguage,
  type WorkflowArgumentProvenance,
  type WorkflowJsonValue,
  type WorkflowRecordedProgram,
  type WorkflowValuePath,
  analyzeAgentArguments,
  tokenizeProgram,
} from "@resin/contracts";
import {
  localWorkflowEvent,
  localWorkflowResultObservation,
} from "../normalization/local-workflow-payload.js";
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
import { workflowPrivateReference } from "./workflow-private-reference.js";

import {
  type DiscoveredCallable,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_NATIVE_RUNTIMES,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  type WorkflowCallCandidate,
  type WorkflowCallCarrier,
  type WorkflowCallHeldOut,
} from "./workflow-carrier.js";

export {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_NATIVE_RUNTIMES,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-carrier.js";
export type {
  DiscoveredCallable,
  WorkflowCallCandidate,
  WorkflowCallCarrier,
  WorkflowCallHeldOut,
} from "./workflow-carrier.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-carrier.js";

function withoutLocalOmpSourceInterface(event: NormalizedSessionEvent): NormalizedSessionEvent {
  if (!Object.hasOwn(event.metadata ?? {}, RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY)) return event;
  const metadata = { ...event.metadata };
  delete metadata[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY];
  return { ...event, metadata };
}

/** One observed call kept locally: its real values never leave this machine. */
interface LocalCall {
  callId: string;
  toolName: string;
  connection?: string;
  position: number;
  arguments: Record<string, WorkflowJsonValue>;
  argumentReferences: Record<string, string>;
  result?: WorkflowJsonValue;
  resultReference?: string;
  resultComparison?: "text-trim";
  reads?: string[];
  writes?: string[];
  /** The callable's discovered input schema, when discovery recorded one. */
  inputSchema?: WorkflowJsonValue;
  /** Arguments this call kept as local resources rather than as caller values. */
  privateArguments?: string[];
  /**
   * The program this call ran: the language its record established and the argument whose text
   * holds it. Kept so the derivation can read the text as the program it is rather than as one
   * opaque argument.
   */
  program?: {
    kind: ProgramLanguage;
    argument: string;
    sourceInterface?: "python-eval" | "javascript-eval";
  };
  /** The execution this call belongs to, so two executions of one session can be told apart. */
  executionIndex: number;
}

/** One execution of a session: the calls one task made, in order. */
interface LocalExecution {
  index: number;
  calls: LocalCall[];
  /** The demonstration this execution is, accumulated as its calls and results arrive. */
  accumulatedHeldOut?: WorkflowCallHeldOut;
  /**
   * The demonstration this execution is, once it has been seen to repeat an earlier one. Values are
   * stored as they are observed, so a replay has what the repeat actually produced.
   */
  heldOut?: WorkflowCallHeldOut;
}

/** Executions kept per session: enough to recognise a repeat, bounded so a long session cannot grow. */
const MAX_EXECUTIONS = 8;

/** Per-session derivation state, bounded so a long session cannot grow without limit. */
interface SessionDerivationState {
  turnKey: string;
  position: number;
  /** The current execution, which is the last one seen. */
  executions: LocalExecution[];
  /** The first value each argument position took, for comparing later tasks against it. */
  baseline: Map<string, WorkflowJsonValue>;
  /**
   * A new instruction arrived, so the next call begins a new piece of work. A task boundary is what
   * a person means by "and then I asked for it again"; it is the only boundary a harness reports
   * uniformly, and the turn index a transcript may carry is not set by every decoder.
   */
  newExecutionPending: boolean;
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

/**
 * The reference-aware invocation surface, however the harness spelled it: bare
 * `invoke_tool`/`sys_invoke_tool`, or an MCP-prefixed `mcp__<server>__invoke_tool`.
 */
function isInvokeToolCallName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "invoke_tool" || value === "sys_invoke_tool") return true;
  return value.endsWith("__invoke_tool") && value.startsWith("mcp__");
}

export interface WorkflowCallRecorderOptions {
  /** The local store private leaves are written to; defaults to the daemon's store. */
  privateValues?: PrivateValueStore;
  /** Paired cloud workspace that owns captured private values; local session workspace otherwise. */
  privateValueOwnerWorkspaceId?: string;
}

export class WorkflowCallRecorder {
  private readonly privateValues: PrivateValueStore;
  private readonly privateValueOwnerWorkspaceId: string | undefined;
  /** The workspace owner stamped on every private entry for the current observation. */
  private observeAccess: PrivateValueOrigin | undefined;
  private privateRepresentation: "literal" | "redacted" = "redacted";
  private redactedArguments: Record<string, unknown> | undefined;
  /**
   * What each session's discovery events reported about the callables it saw, keyed by the name the
   * harness called them by and then by the connection that reported it. Discovery is per session
   * because a connection is: two sessions, or two workspaces, may reach the same tool name over
   * different servers, and one session's discovery must never supply the other's connection. Two
   * connections of one session may expose the same name — that is ordinary for MCP — so what each
   * of them reported is kept apart, and a report that carries less than an earlier one for the same
   * connection (a device surface names the connection and nothing else) is merged into it.
   */
  private readonly discovered = new Map<string, Map<string, Map<string, DiscoveredCallable>>>();
  /**
   * Per-session derivation state: the observed calls whose values must stay here for the
   * conclusions that need them. Bounded per session and by session count.
   */
  private readonly sessions = new Map<string, SessionDerivationState>();

  constructor(options: WorkflowCallRecorderOptions = {}) {
    this.privateValues = options.privateValues ?? FilePrivateValueStore.default();
    this.privateValueOwnerWorkspaceId = options.privateValueOwnerWorkspaceId;
  }

  /** Drops per-session state; the coordinator calls this between sessions. */
  clear(): void {
    this.discovered.clear();
    this.sessions.clear();
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
      executions: [],
      baseline: new Map(),
      newExecutionPending: false,
    };
    this.sessions.set(sessionId, created);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    return created;
  }

  /**
   * What one session's discovery reported about a callable; nothing is taken from another session.
   *
   * A call that resolved its own connection asks for what that connection reported: that report is
   * the callable's own statement, and a same-named entry reported by another connection is not it.
   * A call that established no connection takes the name's own report — the most recently reported
   * one, which is all the record establishes.
   */
  private discoveredCallable(
    sessionId: string,
    toolName: string,
    connection?: string,
  ): DiscoveredCallable | undefined {
    const byName = this.discovered.get(sessionId)?.get(toolName);
    if (byName === undefined) return undefined;
    if (connection !== undefined) {
      return byName.get(connection);
    }
    let latest: DiscoveredCallable | undefined;
    for (const reported of byName.values()) latest = reported;
    return latest;
  }

  /** One session's discovery state, evicting the least recently created when the bound is reached. */
  private discoveryState(sessionId: string): Map<string, Map<string, DiscoveredCallable>> {
    const existing = this.discovered.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, Map<string, DiscoveredCallable>>();
    this.discovered.set(sessionId, created);
    while (this.discovered.size > MAX_SESSIONS) {
      const oldest = this.discovered.keys().next();
      if (oldest.done === true) break;
      this.discovered.delete(oldest.value);
    }
    return created;
  }

  observe(
    event: NormalizedSessionEvent,
    /**
     * The local workspace the observed session belongs to. Unpaired capture stamps private entries
     * with it; paired capture uses the recorder's cloud workspace owner instead.
     */
    access?: PrivateValueOrigin,
  ): NormalizedSessionEvent {
    this.observeAccess = this.privateValueOwnerWorkspaceId
      ? { workspaceId: this.privateValueOwnerWorkspaceId }
      : access;
    this.redactedArguments = event.type === "tool_call" ? event.parameters : undefined;
    const original = localWorkflowEvent(event);
    this.privateRepresentation =
      original !== undefined || event.redaction?.isRedacted === false ? "literal" : "redacted";
    if (event.type === "tool_discovery") {
      const session = this.discoveryState(event.sessionId);
      for (const tool of event.tools) {
        let byConnection = session.get(tool.name);
        if (byConnection === undefined) {
          byConnection = new Map<string, DiscoveredCallable>();
          session.set(tool.name, byConnection);
        }
        // A report that carried no connection is filed under the name itself, so a session whose
        // harness reports a bare tool list still supplies what it established.
        const key = tool.provider ?? "";
        const previous = byConnection.get(key);
        // Merge: a later report for the same connection that carries less than an earlier one — a
        // device surface names the connection and nothing else — does not drop what was established.
        const recorded: DiscoveredCallable = { ...previous };
        if (tool.provider !== undefined) recorded.provider = tool.provider;
        if (tool.inputSchema !== undefined) {
          recorded.inputSchema = tool.inputSchema as WorkflowJsonValue;
        }
        // Re-insert so the most recently reported entry for a name is the last one seen.
        byConnection.delete(key);
        byConnection.set(key, recorded);
      }
      return event;
    }
    if (event.type === "message" && event.role === "user") {
      // The instruction that starts a piece of work. Nothing else in a transcript separates one
      // piece of work from the next often enough to rely on.
      this.sessionState(event.sessionId).newExecutionPending = true;
      return event;
    }
    if (event.type === "tool_call") return this.observeCall(event);
    if (event.type === "tool_result") {
      const observed = this.observeResult(
        original ?? event,
        event,
        localWorkflowResultObservation(event),
      );
      return { ...event, metadata: observed.metadata };
    }
    return event;
  }

  /**
   * Replaces literal leaves that still carry a redaction placeholder with `private:`
   * references, writing the redacted leaf to the local store so the executor can
   * reconstruct the original at invocation time.
   */
  private sweepOrigin(
    origin: AgentArgumentOrigin,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (
          value: WorkflowJsonValue,
          currentPath: WorkflowValuePath,
        ): AgentArgumentOrigin => {
          if (typeof value === "string" && containsRedactionPlaceholder(value)) {
            return this.storeLocalValue(value, sessionId, callId, currentPath);
          }
          if (Array.isArray(value)) {
            return {
              type: "array",
              items: value.map((item, index) => expand(item, [...currentPath, index])),
            };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) {
              entries[key] = expand(entry, [...currentPath, key]);
            }
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(origin.value, path);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.sweepOrigin(entry, sessionId, callId, [...path, key]);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item, index) =>
            this.sweepOrigin(item, sessionId, callId, [...path, index]),
          ),
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
    if (isInvokeToolCallName(event.toolName)) {
      this.privateRepresentation = "redacted";
      return this.observeComposedCall(event);
    }
    const observed = this.observeNativeCall(localWorkflowEvent(event) ?? event);
    // Only reference-bearing metadata leaves the local raw view.
    return { ...event, metadata: observed.metadata };
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
      origins[argument] = this.sweepOrigin(origin, event.sessionId, event.callId, [argument]);
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
    const discovered = this.discoveredCallable(event.sessionId, routedName, event.connection);
    // The connection is the resolution the call itself carries, or what this session's discovery
    // recorded for the callable. Nothing else: not the harness, never a guess from the name.
    const connection = event.connection ?? discovered?.provider;
    if (connection !== undefined) carrier.connection = connection;
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
    const origins: Record<string, AgentArgumentOrigin> = {};
    const provenance: Record<string, WorkflowArgumentProvenance> = {};
    // Ordinary native JSON is data, not the explicit composition interface.
    for (const [argument, value] of Object.entries(parameters)) {
      origins[argument] = this.launderOrigin(
        { type: "literal", value },
        event.sessionId,
        event.callId,
        [argument],
      );
      provenance[argument] = { standing: "derived", rule: "single-observation" };
    }
    const discovered = this.discoveredCallable(event.sessionId, event.toolName, event.connection);
    const connection = event.connection ?? discovered?.provider;
    const carrier: WorkflowCallCarrier = {
      runtime:
        program === undefined
          ? connection === undefined
            ? RESIN_HARNESS_TOOL_RUNTIME
            : RESIN_TOOL_PROTOCOL_RUNTIME
          : program.kind === "shell"
            ? RESIN_PROCESS_RUNTIME
            : RESIN_PROGRAM_RUNTIME,
      name: event.toolName,
      origins,
      inputs: [],
      provenance,
    };
    if (program !== undefined) carrier.program = program;
    if (connection !== undefined) carrier.connection = connection;
    if (discovered?.inputSchema !== undefined) carrier.inputSchema = discovered.inputSchema;

    const state = this.sessionState(event.sessionId);
    const call = this.recordLocalCall(state, event, parameters, program);
    const relationships = this.relateLocalCall(state, call);
    carrier.executionIndex = call.executionIndex;
    const heldOut = this.heldOutSoFar(state, call);
    if (heldOut !== undefined && heldOut.inputs.length > 0) carrier.heldOut = heldOut;
    if (relationships.dependsOnCallIds.length > 0) {
      carrier.dependsOnCallIds = relationships.dependsOnCallIds;
    }
    if (relationships.candidates.length > 0) carrier.candidates = relationships.candidates;
    return this.withCallCarrier(withoutLocalOmpSourceInterface(event), carrier);
  }

  /**
   * Replaces every leaf of a recorded value with a local reference, so the value itself never leaves
   * this machine. A composite keeps its shape — which is what a workflow argument is made of — and
   * each leaf is stored locally, exactly as a private leaf already is.
   */
  private launderOrigin(
    origin: AgentArgumentOrigin,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    switch (origin.type) {
      case "literal": {
        const expand = (
          value: WorkflowJsonValue,
          currentPath: WorkflowValuePath,
        ): AgentArgumentOrigin => {
          if (Array.isArray(value)) {
            return {
              type: "array",
              items: value.map((item, index) => expand(item, [...currentPath, index])),
            };
          }
          if (isPlainObject(value)) {
            const entries: Record<string, AgentArgumentOrigin> = {};
            for (const [key, entry] of Object.entries(value)) {
              entries[key] = expand(entry, [...currentPath, key]);
            }
            return { type: "object", entries };
          }
          return this.storeLocalValue(value, sessionId, callId, currentPath);
        };
        return expand(origin.value, path);
      }
      case "object": {
        const entries: Record<string, AgentArgumentOrigin> = {};
        for (const [key, entry] of Object.entries(origin.entries)) {
          entries[key] = this.launderOrigin(entry, sessionId, callId, [...path, key]);
        }
        return { type: "object", entries };
      }
      case "array":
        return {
          type: "array",
          items: origin.items.map((item, index) =>
            this.launderOrigin(item, sessionId, callId, [...path, index]),
          ),
        };
      default:
        return origin;
    }
  }

  /** Stores one value of a demonstration and returns the stable reference a replay resolves it by. */
  private localReference(
    value: WorkflowJsonValue,
    sessionId: string,
    callId: string,
    slot: string,
  ): string {
    const reference = workflowPrivateReference(
      "demonstration",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [sessionId, callId, slot],
    );
    this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);
    return reference;
  }

  private storeLocalValue(
    value: WorkflowJsonValue,
    sessionId: string,
    callId: string,
    path: WorkflowValuePath,
  ): AgentArgumentOrigin {
    const reference = workflowPrivateReference(
      "value",
      this.observeAccess?.workspaceId,
      this.privateRepresentation,
      [sessionId, callId, path],
    );
    this.privateValues.set(reference, value, this.observeAccess, this.privateRepresentation);
    return { type: "private", reference };
  }

  /** Keeps the observed call locally, so the conclusions that need its values are reached here. */
  private recordLocalCall(
    state: SessionDerivationState,
    event: Extract<NormalizedSessionEvent, { type: "tool_call" }>,
    parameters: Record<string, WorkflowJsonValue>,
    /** The program the record established for this call, when it established one. */
    program?: WorkflowRecordedProgram,
  ): LocalCall {
    const startsExecution = state.executions.length === 0 || state.newExecutionPending;
    if (startsExecution) {
      state.newExecutionPending = false;
      state.position = 0;
      state.executions.push({
        index:
          state.executions.length === 0
            ? 0
            : state.executions[state.executions.length - 1]!.index + 1,
        calls: [],
      });
      while (state.executions.length > MAX_EXECUTIONS) state.executions.shift();
    }
    const execution = state.executions[state.executions.length - 1]!;
    const flow = declaredFlowOfToolCall(event);
    const discovered = this.discoveredCallable(event.sessionId, event.toolName, event.connection);
    const heldLocally = Object.entries(this.redactedArguments ?? parameters)
      .filter(([, value]) => typeof value === "string" && containsRedactionPlaceholder(value))
      .map(([argument]) => argument);
    const call: LocalCall = {
      callId: event.callId,
      toolName: event.toolName,
      ...((event.connection ?? discovered?.provider) === undefined
        ? {}
        : { connection: event.connection ?? discovered?.provider }),
      position: state.position,
      executionIndex: execution.index,
      arguments: parameters,
      argumentReferences: Object.fromEntries(
        Object.entries(parameters).map(([argument, value]) => [
          argument,
          this.localReference(value, event.sessionId, event.callId, `argument:${argument}`),
        ]),
      ),
      ...(discovered?.inputSchema === undefined ? {} : { inputSchema: discovered.inputSchema }),
      ...(heldLocally.length === 0 ? {} : { privateArguments: heldLocally }),
      // Only a program whose text arrived in a named argument can be read as a program here: with
      // no argument there is no text to tokenize, and a program that only arrived as an argv has no
      // token positions to address.
      ...(program?.argument === undefined
        ? {}
        : {
            program: {
              kind: program.kind,
              argument: program.argument,
              ...(program.sourceInterface === undefined
                ? {}
                : { sourceInterface: program.sourceInterface }),
            },
          }),
      ...(flow === undefined
        ? {}
        : {
            reads: flow.reads.map((resource) => `${resource.kind}:${resource.identity}`),
            writes: flow.writes.map((resource) => `${resource.kind}:${resource.identity}`),
          }),
    };
    state.position += 1;
    execution.calls.push(call);
    return call;
  }

  /** The calls of the execution a call belongs to. */
  private callsOf(state: SessionDerivationState, executionIndex: number): LocalCall[] {
    return state.executions.find((entry) => entry.index === executionIndex)?.calls ?? [];
  }

  /**
   * The earlier work this execution is repeating, as far as it has repeated it.
   *
   * "The same work" is the same callables in the same order — a shape two executions share, which is
   * what makes their values comparable. The demonstration is THIS execution's values: it is the one
   * that ran on different inputs, so a replay of the earlier, recorded execution has both inputs the
   * recording never used and what those inputs actually produced. It never extends past the point
   * the repeat has reached, so a session that diverges half way never presents the earlier half as
   * if the whole thing had been performed twice.
   *
   * Values are stored by reference: they are the user's own work and stay where they were performed.
   */
  private heldOutSoFar(
    state: SessionDerivationState,
    call: LocalCall,
  ): WorkflowCallHeldOut | undefined {
    const execution = state.executions.find((entry) => entry.index === call.executionIndex);
    if (execution === undefined) return undefined;
    const earlier = [...state.executions].reverse().find(
      (entry) =>
        entry.index < call.executionIndex &&
        execution.calls.length <= entry.calls.length &&
        execution.calls.every((mine, position) => {
          const theirs = entry.calls[position];
          return (
            theirs !== undefined &&
            mine.toolName === theirs.toolName &&
            mine.connection === theirs.connection &&
            mine.program?.kind === theirs.program?.kind &&
            mine.program?.argument === theirs.program?.argument &&
            mine.program?.sourceInterface === theirs.program?.sourceInterface
          );
        }),
    );
    if (earlier === undefined) {
      // A diverging prefix must not leave an old demonstration advertised on later results.
      execution.accumulatedHeldOut = undefined;
      return undefined;
    }
    const inputs: WorkflowCallHeldOut["inputs"] = [];
    const observed: WorkflowCallHeldOut["observed"] = [];
    for (const mine of execution.calls) {
      const theirs = earlier.calls.find((entry) => entry.position === mine.position);
      if (theirs === undefined || mine.toolName !== theirs.toolName) break;
      for (const [argument, reference] of Object.entries(mine.argumentReferences)) {
        // Nested arguments are part of an ordinary call too. Keep the complete value by local
        // reference; validation selects the candidate's nested path without uploading the value.
        inputs.push({
          position: mine.position,
          argument,
          reference,
        });
      }
      if (mine.resultReference !== undefined) {
        observed.push({
          position: mine.position,
          reference: mine.resultReference,
        });
      }
    }
    if (inputs.length === 0 && observed.length === 0) return undefined;
    execution.accumulatedHeldOut = { repeats: earlier.index, inputs, observed };
    return execution.accumulatedHeldOut;
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
   * it. A program argument is never offered whole, because replacing it would replace the work:
   * a program that ran with one token's text changed is offered token by token, and only when the
   * two texts read as the same program. Both are reported, neither executes.
   */
  private relateLocalCall(
    state: SessionDerivationState,
    call: LocalCall,
  ): { dependsOnCallIds: string[]; candidates: WorkflowCallCandidate[] } {
    const candidates: WorkflowCallCandidate[] = [];
    const calls = this.callsOf(state, call.executionIndex);

    // Resources the earlier calls declared they wrote and this call declared it reads. Both sides
    // named the resource, so the order is a fact of the record rather than a guess from the values.
    const dependsOnCallIds: string[] = [];
    if (call.reads !== undefined && call.reads.length > 0) {
      const reads = new Set(call.reads);
      for (const earlier of calls) {
        if (earlier === call) break;
        if (earlier.writes === undefined) continue;
        if (!earlier.writes.some((resource) => reads.has(resource))) continue;
        dependsOnCallIds.push(earlier.callId);
      }
    }

    // What the calls of this execution establish about their own arguments, reached before the
    // variation rule below because it is what owns a token an earlier call produced.
    const index = calls.indexOf(call);
    const ownStepId = index < 0 ? undefined : `local${index}`;
    const derivation = deriveNativeCalls(
      calls.map((entry, position) => ({
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
        ...(entry.program === undefined ? {} : { program: entry.program }),
      })),
    );
    /** Positions an earlier call produced; the producer rule owns them instead of variation. */
    const producedPositions = new Set<string>();
    for (const candidate of derivation.candidates) {
      if (candidate.stepId !== ownStepId || candidate.proposed.kind !== "result") continue;
      producedPositions.add(JSON.stringify([candidate.argument, candidate.path]));
    }

    // The same argument position, in another task, with a different value.
    for (const [argument, value] of Object.entries(call.arguments)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      const key = JSON.stringify([call.connection ?? null, call.toolName, call.position, argument]);
      const previous = state.baseline.get(key);
      if (previous === undefined) {
        state.baseline.set(key, value);
        continue;
      }
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      if (typeof previous !== typeof value) continue;
      // A program argument is the work: replacing the whole of it would replace what the tool does,
      // so it is offered only token by token — and only when the two texts read as the same program
      // with the text of some of its tokens changed. Anything else is a different program, and a
      // position inside one program is not a position inside another.
      if (call.program?.argument === argument) {
        if (typeof value === "string" && typeof previous === "string") {
          const tokens = tokenizeProgram(call.program.kind, value);
          const earlierTokens = tokenizeProgram(call.program.kind, previous);
          const changed: number[] = [];
          let aligned = tokens.length === earlierTokens.length;
          if (aligned) {
            for (const [tokenIndex, token] of tokens.entries()) {
              const earlierToken = earlierTokens[tokenIndex]!;
              // A kind that changed, or an operator whose text changed, is a change in the program
              // itself: an operator denotes no value, so it is never a position offered here.
              if (token.kind !== earlierToken.kind) {
                aligned = false;
                break;
              }
              if (token.kind === "operator" && token.raw !== earlierToken.raw) {
                aligned = false;
                break;
              }
              if (token.raw !== earlierToken.raw) changed.push(tokenIndex);
            }
          }
          if (aligned) {
            for (const tokenIndex of changed) {
              // A token an earlier call of this execution produced is that call's output, and the
              // producer rule already offers it at this position; a second candidate on one token
              // would be decided against the first.
              if (producedPositions.has(JSON.stringify([argument, ["tokens", tokenIndex]])))
                continue;
              candidates.push({
                argument,
                path: ["tokens", tokenIndex],
                proposed: {
                  kind: "input",
                  name: `${call.toolName}_${argument}_${tokenIndex}`.replace(
                    /[^A-Za-z0-9_]+/g,
                    "_",
                  ),
                  type: "string",
                },
                reason: "varies-across-executions",
                evidence: { tasks: 2, tokens: tokens.length, token: tokenIndex },
                missing:
                  "this token took a different text in another task, but no task used a value the record had never seen, so the record does not establish that a caller supplies it",
              });
            }
          }
        }
        continue;
      }
      // A changed value that still came from an earlier step is data flow, not a caller input.
      if (producedPositions.has(JSON.stringify([argument, []]))) continue;
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

    if (index < 0) return { dependsOnCallIds, candidates };
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
      const producingCall = calls[producingIndex];
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
   * frames executed source in a language is a program in that language. Observing source in a file
   * read or write is not execution. Neither is decided by a list of tool names, and a plain shell
   * chain is preserved whole — its operators, pipes, redirections and exit status are part of it.
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
    const language =
      typeof parameters.language === "string" ? parameters.language.trim().toLowerCase() : "";
    const sourceInterface =
      event.toolName === "eval" && typeof parameters.code === "string"
        ? event.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY] === "python-eval" &&
          (language === "py" || language === "python")
          ? "python-eval"
          : event.metadata?.[RESIN_LOCAL_OMP_SOURCE_INTERFACE_KEY] === "javascript-eval" &&
              (language === "js" || language === "javascript")
            ? "javascript-eval"
            : undefined
        : undefined;
    for (const frame of extractComputationSourceFrames(event)) {
      if (frame.rejectionReason !== undefined || frame.executionScope === "file_observation") {
        continue;
      }
      const interfaceMatchesFrame =
        sourceInterface !== undefined &&
        frame.executionScope === "persistent" &&
        frame.source === parameters.code &&
        ((sourceInterface === "python-eval" && frame.language === "python") ||
          (sourceInterface === "javascript-eval" && frame.language === "javascript"));
      const program: WorkflowRecordedProgram = { kind: frame.language, source: "" };
      if (interfaceMatchesFrame && sourceInterface !== undefined) {
        program.argument = "code";
        program.sourceInterface = sourceInterface;
      } else {
        const argument = this.argumentHolding(parameters, frame.source);
        if (argument !== undefined) program.argument = argument;
      }
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

  private observeResult(
    event: NormalizedSessionEvent,
    publicEvent: NormalizedSessionEvent = event,
    localResultObservation?: { result: string; comparison?: "text-trim" },
  ): NormalizedSessionEvent {
    let baselineReference: string | undefined;
    let baselineComparison: "text-trim" | undefined;
    if (event.type === "tool_result") {
      // The result's own value is what a later call's argument may have carried, so it is kept
      // locally for that comparison and never attached to the event.
      const state = this.sessionState(event.sessionId);
      for (let e = state.executions.length - 1; e >= 0; e -= 1) {
        const execution = state.executions[e]!;
        const call = execution.calls.find((entry) => entry.callId === event.callId);
        if (call === undefined) continue;
        call.result = extractResultValueOf(localResultObservation?.result ?? event.result);
        call.resultComparison = localResultObservation?.comparison;
        call.resultReference =
          call.result === undefined
            ? undefined
            : this.localReference(
                call.result,
                event.sessionId,
                call.callId,
                localResultObservation === undefined
                  ? "result"
                  : `native-result:v1:${localResultObservation.comparison ?? "exact"}`,
              );
        if (event.isError === false) {
          baselineReference = call.resultReference;
          baselineComparison = baselineReference === undefined ? undefined : call.resultComparison;
        }
        // A repeat's own observations are what its results produced, so the demonstration grows
        // here rather than at a call that was recorded before they happened.
        if (execution.accumulatedHeldOut !== undefined && call.resultReference !== undefined) {
          execution.accumulatedHeldOut.observed = [
            ...execution.accumulatedHeldOut.observed.filter(
              (entry) => entry.position !== call.position,
            ),
            {
              position: call.position,
              reference: call.resultReference,
              ...(call.resultComparison === undefined ? {} : { comparison: call.resultComparison }),
            },
          ];
        }
        break;
      }
    }
    const handle = this.resultHandle(publicEvent);
    const heldOut =
      event.type === "tool_result"
        ? this.demonstrationCarrier(event.sessionId, event.callId)
        : undefined;
    if (
      handle === undefined &&
      heldOut === undefined &&
      baselineReference === undefined &&
      baselineComparison === undefined
    ) {
      return event;
    }
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
    metadata[RESIN_WORKFLOW_RESULT_METADATA_KEY] = {
      ...(handle === undefined ? {} : { handle }),
      ...(heldOut === undefined ? {} : { heldOut }),
      ...(baselineReference === undefined ? {} : { baselineReference }),
      ...(baselineComparison === undefined ? {} : { baselineComparison }),
    };
    return { ...event, metadata } as NormalizedSessionEvent;
  }

  /** The demonstration so far of the execution this result belongs to, when it is a repeat. */
  private demonstrationCarrier(sessionId: string, callId: string): WorkflowCallHeldOut | undefined {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return undefined;
    for (let index = state.executions.length - 1; index >= 0; index -= 1) {
      const execution = state.executions[index]!;
      if (!execution.calls.some((call) => call.callId === callId)) continue;
      const heldOut = execution.accumulatedHeldOut;
      if (heldOut === undefined || heldOut.observed.length === 0) return undefined;
      return {
        repeats: heldOut.repeats,
        inputs: [...heldOut.inputs],
        observed: [...heldOut.observed],
      };
    }
    return undefined;
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
