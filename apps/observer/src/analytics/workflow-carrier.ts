/** Frozen workflow carrier vocabulary shared by live capture, projection, and import reconstruction. */

import { validateWorkflowProgramSourceInterface } from "@resin/contracts";
import type {
  AgentArgumentOrigin,
  WorkflowArgumentProvenance,
  WorkflowJsonValue,
  WorkflowPythonState,
  WorkflowRecordedProgram,
  WorkflowValuePath,
} from "@resin/contracts";

export const RESIN_WORKFLOW_CALL_METADATA_KEY = "workflowCall";
export const RESIN_WORKFLOW_RESULT_METADATA_KEY = "workflowResult";

/** The runtime family every invoke_tool-routed callable belongs to. */
export const RESIN_INVOKE_TOOL_RUNTIME = "resin-invoke-tool";

/** A native builtin owned and executed by the recording harness. */
export const RESIN_HARNESS_TOOL_RUNTIME = "resin-harness-tool";

/** A callable the harness reached over an external tool protocol such as MCP. */
export const RESIN_TOOL_PROTOCOL_RUNTIME = "resin-tool-protocol";

/** A callable whose recorded artifact is a process program: a shell command or an exact argv. */
export const RESIN_PROCESS_RUNTIME = "resin-process";

/** A callable whose recorded artifact is a program in a language, run through its interpreter. */
export const RESIN_PROGRAM_RUNTIME = "resin-program";

/** The runtime families an ordinary native call can belong to, decided by the record, not by name. */
export const RESIN_NATIVE_RUNTIMES = [
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
] as const;

/** What discovery recorded about a callable: the connection that exposed it, and its own schema. */
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
  /** Which execution of this session this call belongs to, so a recording can keep them apart. */
  executionIndex?: number;
  /** The repeat of earlier work this call is part of, as far as it has repeated it yet. */
  heldOut?: WorkflowCallHeldOut;
}

/**
 * A second execution of the same work, offered by the capture itself.
 *
 * An ordinary session repeats itself: the same callables in the same order, on different values.
 * That repeat is the only evidence a recording can hold about what its own proposals would do on
 * inputs it never used, so the capture keeps it — by reference, because it is the user's own work —
 * and a replay can then check a candidate against what actually happened, with nothing supplied by
 * hand.
 */
export interface WorkflowCallHeldOut {
  /** The earlier execution this one repeats: the one a recording is compiled from. */
  repeats: number;
  inputs: Array<{ position: number; argument: string; reference: string }>;
  observed: Array<{
    position: number;
    reference: string;
    comparison?: "text-trim";
  }>;
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
    | "shares-value-with-declared-input"
    | "tracks-earlier-result-across-executions";
  evidence?: WorkflowJsonValue;
  /** The fact the record does not establish, so a refusal can be reported instead of silent. */
  missing: string;
}

/** A normalized event, as much of it as recording calls needs. */
export interface RecordableEvent {
  type: string;
  eventId: string;
  sessionId: string;
  timestamp?: string;
  causalRef?: { causalSequence?: number; stepIndex?: number };
  /** Tool calls carry the name and arguments; results carry the value and the call they answer. */
  toolName?: string;
  callId?: string;
  toolCallId?: string;
  parameters?: Record<string, WorkflowJsonValue>;
  result?: WorkflowJsonValue;
  content?: unknown;
  /** Whether the recorded result reported an error; absent means the record does not say. */
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
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
function readPythonState(value: unknown): WorkflowPythonState | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (value.status !== "closed" && value.status !== "unresolved") return undefined;
  if (
    typeof value.unresolvedReadCount !== "number" ||
    !Number.isInteger(value.unresolvedReadCount) ||
    value.unresolvedReadCount < 0 ||
    !Array.isArray(value.setup)
  ) {
    return undefined;
  }
  const setup: WorkflowPythonState["setup"] = [];
  for (const entry of value.setup) {
    if (!isPlainObject(entry)) return undefined;
    if (
      typeof entry.callId !== "string" ||
      entry.callId.length === 0 ||
      typeof entry.sourceEventId !== "string" ||
      entry.sourceEventId.length === 0 ||
      typeof entry.resultEventId !== "string" ||
      entry.resultEventId.length === 0 ||
      typeof entry.reference !== "string" ||
      entry.reference.length === 0
    ) {
      return undefined;
    }
    setup.push({
      callId: entry.callId,
      sourceEventId: entry.sourceEventId,
      resultEventId: entry.resultEventId,
      reference: entry.reference,
    });
  }
  return {
    schemaVersion: 1,
    status: value.status,
    unresolvedReadCount: value.unresolvedReadCount,
    setup,
  };
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
  if (value.sourceInterface !== undefined) {
    const errors: string[] = [];
    validateWorkflowProgramSourceInterface(
      { kind: program.kind, sourceInterface: value.sourceInterface },
      "carrier",
      errors,
    );
    if (errors.length > 0 || value.sourceInterface !== "python-eval") return undefined;
    program.sourceInterface = value.sourceInterface;
  }
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
  if (value.pythonState !== undefined) {
    const pythonState = readPythonState(value.pythonState);
    if (pythonState === undefined) return undefined;
    program.pythonState = pythonState;
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
  "shares-value-with-declared-input": true,
  "tracks-earlier-result-across-executions": true,
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
  if (value.executionIndex !== undefined && !Number.isInteger(value.executionIndex)) return false;
  if (value.heldOut !== undefined && readHeldOut(value.heldOut) === undefined) return false;
  return true;
}

/** Reads a demonstration back through the frozen vocabulary, or drops it. */
function readHeldOut(value: unknown): WorkflowCallHeldOut | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!Number.isInteger(value.repeats)) return undefined;
  if (!Array.isArray(value.inputs) || !Array.isArray(value.observed)) return undefined;

  const inputs: WorkflowCallHeldOut["inputs"] = [];
  for (const entry of value.inputs) {
    if (
      !isPlainObject(entry) ||
      !Number.isInteger(entry.position) ||
      typeof entry.argument !== "string" ||
      typeof entry.reference !== "string" ||
      entry.reference.length === 0
    ) {
      return undefined;
    }
    inputs.push({
      position: entry.position as number,
      argument: entry.argument,
      reference: entry.reference,
    });
  }

  const observed: WorkflowCallHeldOut["observed"] = [];
  for (const entry of value.observed) {
    if (
      !isPlainObject(entry) ||
      !Number.isInteger(entry.position) ||
      typeof entry.reference !== "string" ||
      entry.reference.length === 0
    ) {
      return undefined;
    }
    if (entry.comparison !== undefined && entry.comparison !== "text-trim") {
      return undefined;
    }
    observed.push({
      position: entry.position as number,
      reference: entry.reference,
      ...(entry.comparison === undefined ? {} : { comparison: entry.comparison }),
    });
  }
  return { repeats: value.repeats as number, inputs, observed };
}

/**
 * Re-reads a carrier for projection: only the frozen carrier vocabulary survives, so a malformed or
 * smuggled field is dropped rather than carried upstream.
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
  if (value.dependsOnCallIds !== undefined) carrier.dependsOnCallIds = [...value.dependsOnCallIds];
  if (value.candidates !== undefined) {
    const candidates: WorkflowCallCandidate[] = [];
    for (const entry of value.candidates) {
      const read = readCandidate(entry);
      if (read !== undefined) candidates.push(read);
    }
    carrier.candidates = candidates;
  }
  if (value.executionIndex !== undefined) carrier.executionIndex = value.executionIndex;
  if (value.heldOut !== undefined) {
    const heldOut = readHeldOut(value.heldOut);
    if (heldOut !== undefined) carrier.heldOut = heldOut;
  }
  return carrier;
}

export interface WorkflowResultCarrier {
  handle?: string;
  heldOut?: WorkflowCallHeldOut;
  /** Private reference to the original successful result for baseline replay. */
  baselineReference?: string;
  /** How the original baseline result may be projected before comparison. */
  baselineComparison?: "text-trim";
}

/** Re-reads a result carrier for projection. */
export function readWorkflowResultCarrier(value: unknown): WorkflowResultCarrier | undefined {
  if (!isPlainObject(value)) return undefined;
  const carrier: WorkflowResultCarrier = {};
  if (typeof value.handle === "string" && value.handle.length > 0) carrier.handle = value.handle;
  if (value.heldOut !== undefined) {
    const heldOut = readHeldOut(value.heldOut);
    if (heldOut !== undefined) carrier.heldOut = heldOut;
  }
  if (typeof value.baselineReference === "string" && value.baselineReference.length > 0) {
    carrier.baselineReference = value.baselineReference;
  }
  if (value.baselineComparison !== undefined) {
    if (value.baselineComparison !== "text-trim") return undefined;
    carrier.baselineComparison = value.baselineComparison;
  }
  return carrier.handle === undefined &&
    carrier.heldOut === undefined &&
    carrier.baselineReference === undefined &&
    carrier.baselineComparison === undefined
    ? undefined
    : carrier;
}
