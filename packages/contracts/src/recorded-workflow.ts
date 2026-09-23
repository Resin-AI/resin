/**
 * Recorded workflows: the shared representation of what Resin observed.
 *
 * The unit is the original call. A workflow is an ordered set of calls to the callables that were
 * actually used — a tool discovered over a protocol, a shell program, or any other executable
 * runtime — together with where each argument came from and what each call returned.
 *
 * The representation is deliberately identity-agnostic: it never says which applications are
 * supported. A newly discovered tool is described by its discovered schema and its connection, and
 * a workflow that uses it needs no compiler change.
 */

export const RECORDED_WORKFLOW_SCHEMA_VERSION = 1 as const;
/** Maximum setup cells a captured Python closure may require before it fails closed. */
export const MAX_WORKFLOW_PYTHON_SETUP_CELLS = 32;
/** Maximum UTF-8 bytes for one captured Python source cell. */
export const MAX_WORKFLOW_PYTHON_SOURCE_BYTES = 262_144;
/** Maximum UTF-8 bytes for the complete fresh-process Python replay source. */
export const MAX_WORKFLOW_PYTHON_REPLAY_BYTES = 1_048_576;

/** Values the schema validator accepts without importing a JSON library. */
export type WorkflowJsonValue =
  | string
  | number
  | boolean
  | null
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };

/** A path into a returned value: object keys and array indexes, in order. */
export type WorkflowValuePath = ReadonlyArray<string | number>;

/** One leaf of a recursively constructed argument. */
export type WorkflowValueTemplate =
  | { type: "literal"; value: WorkflowJsonValue }
  | { type: "input"; name: string }
  | { type: "result"; stepId: string; path: WorkflowValuePath }
  | { type: "private"; reference: string }
  /** Origin the record does not establish: preserved as such, never guessed. */
  | { type: "unresolved"; reason: string }
  | { type: "object"; entries: Record<string, WorkflowValueTemplate> }
  | { type: "array"; items: WorkflowValueTemplate[] }
  /**
   * A recorded program with the values a replay bound inside it.
   *
   * The program text stays where it was recorded — `source` resolves it locally, exactly as a
   * private leaf does — because the program is the user's own work. `holes` says which token of the
   * program is a binding rather than a literal of that program, by token index, so re-running the
   * program renders the bound value into the recorded token and leaves every other byte alone.
   * Token indices are the ones `tokenizeProgram(language, source)` yields, so the capture that
   * found the token and the runtime that renders it agree on its position.
   */
  | {
      type: "program";
      language: WorkflowRecordedProgram["kind"];
      source: WorkflowValueTemplate;
      holes: Array<{ token: number; binding: WorkflowValueTemplate }>;
    };

export type WorkflowValueSource =
  | { kind: "literal"; value: WorkflowJsonValue }
  /** Supplied by the caller of the generated tool. */
  | { kind: "input"; name: string }
  /** The value a previous step returned, addressed by path — never by matching text. */
  | { kind: "result"; stepId: string; path: WorkflowValuePath }
  /** A private resource resolved locally at execution time and never uploaded. */
  | { kind: "private"; reference: string }
  /**
   * The record does not establish where this value came from. It is preserved as unknown rather
   * than bound by guessing or frozen as a constant.
   */
  | { kind: "unresolved"; reason: string }
  /** A recursively constructed value whose leaves carry their own sources. */
  | { kind: "template"; template: WorkflowValueTemplate };

/**
 * A successful Python cell captured in the same persistent kernel interval as a target program.
 *
 * The source itself never crosses the recording boundary: `reference` is resolved by the owning
 * workspace at replay time. Event identifiers are structural identities used to reject replaying a
 * workflow call twice; they are not source names or executable metadata.
 */
export type WorkflowPythonStateSetup = {
  callId: string;
  sourceEventId: string;
  resultEventId: string;
  reference: string;
};

/**
 * The bounded closure facts needed to replay a Python program in a fresh disposable process.
 *
 * `unresolved` is retained in the wire vocabulary so an observer can explain why a candidate was
 * not closed; executable consumers reject it rather than guessing ambient session state.
 */
export type WorkflowPythonState = {
  schemaVersion: 1;
  status: "closed" | "unresolved";
  unresolvedReadCount: number;
  setup: WorkflowPythonStateSetup[];
};

/**
 * A program the recording actually executed, preserved verbatim.
 *
 * The program is the executable artifact: it is never split, re-parsed, re-quoted or reduced to a
 * list of commands, because a shell's `&&`, pipelines, redirections and exit status are part of what
 * the call did. Reuse means running this text again through the same family of runtime, not
 * reconstructing an equivalent one.
 */
export type WorkflowRecordedProgram = {
  /** How the program runs: the family of shell or interpreter the record establishes. */
  kind: "shell" | "python" | "javascript" | "typescript";
  /** The complete program text exactly as recorded. Empty when the record carries only an argv. */
  source: string;
  /**
   * Adapter-established execution semantics. Python Eval renders the final expression as well as
   * captured output; absent means ordinary process stdout, never inferred from a callable name.
   */
  sourceInterface?: "python-eval";
  /** The exact argument vector, when the record has one and it is not a shell wrapper. */
  argv?: string[];
  /** The argument the program arrived in, when it came as a tool argument rather than an event. */
  argument?: string;
  /** Working directory the program ran in, when the record identifies one. */
  cwd?: string;
  /**
   * Private closure metadata for Python programs captured from a persistent kernel interval.
   * It contains only local reference identities; setup source is resolved at replay time.
   */
  pythonState?: WorkflowPythonState;
};

/** How a step is called again: the original callable and the connection it was reached through. */
export type WorkflowCallable = {
  /** Protocol/runtime family the callable speaks, e.g. a tool protocol or a program runner. */
  runtime: string;
  /** Name the callable was recorded under, exactly as the record has it. */
  name: string;
  /** Connection or session the callable was reached through, if the record identifies one. */
  connection?: string;
  /**
   * The discovered input schema of the callable, when the record carries one. Compilation validates
   * against it; a missing schema is reported rather than guessed.
   */
  inputSchema?: WorkflowJsonValue;
  /** The output contract observed for this call, when the record carries one. */
  outputSchema?: WorkflowJsonValue;
  /** The recorded program this callable runs, when the call was a program execution. */
  program?: WorkflowRecordedProgram;
};

/**
 * Where one argument's origin came from, and how firmly the record establishes it.
 *
 * `recorded` is a fact the caller stated; `derived` is a conclusion local analysis reached from the
 * record and can point at; `candidate` is a suggestion the record only *suggests* (for instance a
 * value that merely equals an earlier result) and that may never execute as recorded. Keeping the
 * three apart is what stops a coincidence from becoming a dependency.
 */
export type WorkflowArgumentProvenance = {
  standing: "recorded" | "derived" | "candidate";
  /** Finite rule vocabulary — never free text, so a consumer can act on it without parsing prose. */
  rule:
    | "caller-stated"
    | "declared-resource"
    | "variation-across-executions"
    | "replay-confirmed"
    | "equal-to-earlier-result"
    | "invariant-across-executions"
    | "single-observation";
  /** Structural, privacy-safe evidence for the rule. Never a value the recording may not carry. */
  evidence?: WorkflowJsonValue;
  /** For a candidate: the exact fact the record does not establish. */
  missing?: string;
};

export type WorkflowArgument = {
  /** Argument name as the callable's schema names it. */
  name: string;
  source: WorkflowValueSource;
  /** What the record says about this origin. Absent means the recording predates the vocabulary. */
  provenance?: WorkflowArgumentProvenance;
};

/**
 * A binding the capture proposes but has not established.
 *
 * A candidate is deliberately NOT executable: the plan keeps the recorded value until a caller
 * validates the proposed behaviour on different inputs in a disposable environment. Every candidate
 * names the fact the record is missing, so a refusal is reportable instead of silent.
 */
export type WorkflowBindingCandidate = {
  stepId: string;
  argument: string;
  /**
   * Where inside the argument the value sits; empty for the whole argument.
   *
   * A path of `["tokens", <index>]` names a token of the program the argument holds, as
   * `tokenizeProgram` numbers it — the position inside a recorded program text, for a value the
   * capture found embedded in it. Everything else is a path through the argument's own structure.
   */
  path: WorkflowValuePath;
  proposed:
    | { kind: "result"; stepId: string; path: WorkflowValuePath }
    | {
        kind: "input";
        name: string;
        type: "string" | "number" | "boolean" | "object" | "array";
      };
  reason:
    | "equal-to-earlier-result"
    | "tracks-earlier-result-across-executions"
    | "varies-across-executions"
    | "declared-by-the-callable"
    | "shares-value-with-declared-input";
  /** Structural, privacy-safe evidence: identities and shapes, never the values themselves. */
  evidence?: WorkflowJsonValue;
  missing: string;
};

export type WorkflowStepFailureBehavior = "abort" | "continue";

/**
 * How the workflow behaves when this step fails, kept separate from what was observed.
 *
 * `policy` says where the behavior came from: `recorded` when the record shows the control flow,
 * `default` when this representation chose it because the record does not say. An observed failure
 * is evidence about one execution, not a description of the workflow's behavior.
 */
export type WorkflowStepFailurePolicy = {
  onError: WorkflowStepFailureBehavior;
  policy: "recorded" | "default";
};

/** What an observed demonstration result may project before comparison. */
export type WorkflowObservedComparison = "text-trim";

/** What the recording observed about this step's execution, for diagnostics only. */
export type WorkflowStepObservation = {
  outcome: "succeeded" | "failed" | "unknown";
};

export type WorkflowStep = {
  /** Stable identity of this step inside the workflow. */
  id: string;
  /** Identity of the recording this step came from: the call and its result. */
  callId: string;
  callable: WorkflowCallable;
  arguments: WorkflowArgument[];
  /** Steps that must complete first, preserving the recorded ordering and dependencies. */
  dependsOn: string[];
  /** Recorded control flow, with the policy label it was derived under. */
  failurePolicy: WorkflowStepFailurePolicy;
  /** What the recording saw happen; never used as the workflow's behavior. */
  observed: WorkflowStepObservation;
  /** Execution permissions the recorded call used, for reporting and for the runtime to enforce. */
  permissions?: WorkflowJsonValue;
};

/**
 * A second execution of the same work, on inputs the recording under compilation did not use.
 *
 * The plan is compiled from one execution; this is what a replay is checked against. Every value in
 * it is a local reference the host resolves, never a value the plan carries: a demonstration is the
 * user's own work, and it stays on the machine that performed it.
 */
export type WorkflowHeldOutDemonstration = {
  /** The inputs the demonstration used, at the argument each one landed in. */
  inputs: Array<{ stepId: string; argument: string; reference: string }>;
  /** What each step of the demonstration produced. */
  observed: Array<{
    stepId: string;
    reference: string;
    /** An explicit projection for textual output whose trailing whitespace is incidental. */
    comparison?: WorkflowObservedComparison;
  }>;
};

export type RecordedWorkflow = {
  schemaVersion: typeof RECORDED_WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  /** Caller-supplied inputs, in the order the workflow exposes them, with their recorded types. */
  inputs: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
  }>;
  steps: WorkflowStep[];
  /** Private resources the workflow needs locally, addressed by reference only. */
  privateReferences?: string[];
  /**
   * Bindings the capture proposes but has not established. They are diagnostic, never executable:
   * the steps above keep the recorded values until a validator confirms a candidate on different
   * inputs in a disposable environment.
   */
  candidates?: WorkflowBindingCandidate[];
  /**
   * The original execution's inputs and outputs, retained locally for a zero-candidate baseline
   * replay. It is separate from `heldOut`: this record can prove the captured plan ran in a fresh
   * process without becoming evidence for promoting any candidate.
   */
  baseline?: WorkflowHeldOutDemonstration;
  /**
   * A second execution of the same work, kept locally by reference. It is what makes a candidate
   * decidable without anyone supplying inputs or expectations by hand: the replay runs the plan on
   * the demonstration's inputs and compares each step with what that execution actually produced.
   */
  heldOut?: WorkflowHeldOutDemonstration;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is WorkflowJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}
const PYTHON_STATE_KEYS = ["schemaVersion", "status", "unresolvedReadCount", "setup"] as const;
const PYTHON_SETUP_KEYS = ["callId", "sourceEventId", "resultEventId", "reference"] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Rejects interface/language mismatches rather than silently replaying under different semantics. */
export function validateWorkflowProgramSourceInterface(
  program: { kind?: unknown; sourceInterface?: unknown },
  stepId: string,
  errors: string[],
): void {
  if (program.sourceInterface === undefined) return;
  if (program.sourceInterface !== "python-eval") {
    errors.push(`step ${stepId} has an unsupported program sourceInterface`);
  } else if (program.kind !== "python") {
    errors.push(`step ${stepId} has a Python Eval sourceInterface on a non-Python program`);
  }
}

export function validateWorkflowPythonState(
  program: { kind?: unknown; pythonState?: unknown },
  stepId: string,
  targetCallId: string | undefined,
  workflowCallIds: ReadonlySet<string>,
  declaredPrivates: ReadonlySet<string> | undefined,
  errors: string[],
): void {
  const state = program.pythonState;
  if (state === undefined) return;
  if (program.kind !== "python") {
    errors.push(`step ${stepId} has pythonState on a non-Python program`);
    return;
  }
  if (!isPlainObject(state)) {
    errors.push(`step ${stepId} pythonState must be an object`);
    return;
  }
  if (!hasOnlyKeys(state, PYTHON_STATE_KEYS)) {
    errors.push(`step ${stepId} pythonState contains unsupported metadata`);
  }
  if (state.schemaVersion !== 1) {
    errors.push(`step ${stepId} pythonState has an unsupported schemaVersion`);
  }
  if (state.status !== "closed" && state.status !== "unresolved") {
    errors.push(`step ${stepId} pythonState needs a closed or unresolved status`);
  }
  if (
    typeof state.unresolvedReadCount !== "number" ||
    !Number.isInteger(state.unresolvedReadCount) ||
    state.unresolvedReadCount < 0
  ) {
    errors.push(`step ${stepId} pythonState.unresolvedReadCount must be a non-negative integer`);
  } else if (state.status === "closed" && state.unresolvedReadCount !== 0) {
    errors.push(`step ${stepId} closed pythonState cannot have unresolved reads`);
  }
  if (state.status === "unresolved") {
    errors.push(`step ${stepId} pythonState is unresolved`);
  }
  if (!Array.isArray(state.setup)) {
    errors.push(`step ${stepId} pythonState.setup must be an array`);
    return;
  }
  if (state.setup.length > MAX_WORKFLOW_PYTHON_SETUP_CELLS) {
    errors.push(
      `step ${stepId} pythonState.setup exceeds ${MAX_WORKFLOW_PYTHON_SETUP_CELLS} cells`,
    );
  }
  const callIds = new Set<string>();
  const sourceEventIds = new Set<string>();
  const resultEventIds = new Set<string>();
  const descriptorIds = new Set<string>();
  const references = new Set<string>();
  for (const [index, descriptor] of state.setup.entries()) {
    const where = `step ${stepId} pythonState.setup[${index}]`;
    if (!isPlainObject(descriptor)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (!hasOnlyKeys(descriptor, PYTHON_SETUP_KEYS)) {
      errors.push(`${where} contains unsupported metadata`);
    }
    const fields: Array<keyof WorkflowPythonStateSetup> = [
      "callId",
      "sourceEventId",
      "resultEventId",
      "reference",
    ];
    for (const field of fields) {
      if (typeof descriptor[field] !== "string" || descriptor[field].length === 0) {
        errors.push(`${where}.${field} must be a non-empty string`);
      }
    }
    const callId = typeof descriptor.callId === "string" ? descriptor.callId : undefined;
    const sourceEventId =
      typeof descriptor.sourceEventId === "string" ? descriptor.sourceEventId : undefined;
    const resultEventId =
      typeof descriptor.resultEventId === "string" ? descriptor.resultEventId : undefined;
    for (const id of [callId, sourceEventId, resultEventId]) {
      if (id === undefined) continue;
      if (descriptorIds.has(id)) errors.push(`${where} duplicates descriptor identity ${id}`);
      descriptorIds.add(id);
      if (targetCallId !== undefined && id === targetCallId) {
        errors.push(`${where} references its target callId ${id}`);
      }
    }
    const reference = typeof descriptor.reference === "string" ? descriptor.reference : undefined;
    if (callId !== undefined) {
      if (callIds.has(callId)) errors.push(`${where} duplicates callId ${callId}`);
      callIds.add(callId);
      if (workflowCallIds.has(callId)) {
        errors.push(`${where} overlaps workflow callId ${callId}`);
      }
    }
    if (sourceEventId !== undefined) {
      if (sourceEventIds.has(sourceEventId)) {
        errors.push(`${where} duplicates sourceEventId ${sourceEventId}`);
      }
      sourceEventIds.add(sourceEventId);
    }
    if (resultEventId !== undefined) {
      if (resultEventIds.has(resultEventId)) {
        errors.push(`${where} duplicates resultEventId ${resultEventId}`);
      }
      resultEventIds.add(resultEventId);
    }
    if (
      callId !== undefined &&
      ((sourceEventId !== undefined && callId === sourceEventId) ||
        (resultEventId !== undefined && callId === resultEventId))
    ) {
      errors.push(`${where} self-references its own call event`);
    }
    if (
      sourceEventId !== undefined &&
      resultEventId !== undefined &&
      sourceEventId === resultEventId
    ) {
      errors.push(`${where} uses the same source and result event`);
    }
    if (reference !== undefined) {
      if (references.has(reference)) errors.push(`${where} duplicates reference ${reference}`);
      references.add(reference);
      if (declaredPrivates !== undefined && !declaredPrivates.has(reference)) {
        errors.push(`${where} reads undeclared private reference '${reference}'`);
      }
    }
  }
}

function validateDemonstration(
  label: "heldOut" | "baseline",
  demonstration: unknown,
  order: ReadonlyMap<string, number>,
  declaredPrivates: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isPlainObject(demonstration)) {
    errors.push(`${label} must be an object when present`);
    return;
  }
  const entries: ReadonlyArray<readonly [string, unknown]> = [
    ["inputs", demonstration.inputs],
    ["observed", demonstration.observed],
  ];
  for (const [entryLabel, list] of entries) {
    if (!Array.isArray(list)) {
      errors.push(`${label}.${entryLabel} must be an array`);
      continue;
    }
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        errors.push(`every ${label}.${entryLabel} entry must be an object`);
        continue;
      }
      if (
        entryLabel === "observed" &&
        entry.comparison !== undefined &&
        entry.comparison !== "text-trim"
      ) {
        errors.push(
          `${label}.observed entry for step ${String(entry.stepId)} has unsupported comparison ${String(entry.comparison)}`,
        );
      }
      if (!order.has(String(entry.stepId))) {
        errors.push(
          `every ${label}.${entryLabel} entry names unknown step ${String(entry.stepId)}`,
        );
      }
      if (typeof entry.reference !== "string" || !declaredPrivates.has(entry.reference)) {
        errors.push(
          `${label}.${entryLabel} reads undeclared local reference ${String(entry.reference)}`,
        );
      }
      if (entryLabel === "inputs" && typeof entry.argument !== "string") {
        errors.push(`every ${label}.inputs entry needs the argument it was supplied for`);
      }
    }
  }
}

/**
 * Collects all local references an executable workflow may resolve.
 *
 * The result is metadata only: it contains opaque reference identities, never resolved values or
 * Python source. Keeping this traversal in the shared contract prevents compiler/runtime callers
 * from forgetting closure setup or baseline evidence when calculating required private resources.
 */
export function collectWorkflowPrivateReferences(workflow: RecordedWorkflow): string[] {
  const references = new Set<string>(workflow.privateReferences ?? []);
  const walkTemplate = (template: WorkflowValueTemplate): void => {
    switch (template.type) {
      case "private":
        references.add(template.reference);
        return;
      case "object":
        for (const entry of Object.values(template.entries)) walkTemplate(entry);
        return;
      case "array":
        for (const entry of template.items) walkTemplate(entry);
        return;
      case "program":
        walkTemplate(template.source);
        for (const hole of template.holes) walkTemplate(hole.binding);
        return;
      default:
        return;
    }
  };
  for (const step of workflow.steps) {
    for (const argument of step.arguments) {
      if (argument.source.kind === "private") references.add(argument.source.reference);
      if (argument.source.kind === "template") walkTemplate(argument.source.template);
    }
    const state = step.callable.program?.pythonState;
    for (const descriptor of state?.setup ?? []) references.add(descriptor.reference);
  }
  for (const demonstration of [workflow.baseline, workflow.heldOut]) {
    if (demonstration === undefined) continue;
    for (const entry of demonstration.inputs) references.add(entry.reference);
    for (const entry of demonstration.observed) references.add(entry.reference);
  }
  return [...references];
}

/**
 * Validates a recorded workflow structurally.
 *
 * Structural only on purpose: nothing here inspects callable names, applications, or task
 * categories. What makes a workflow compilable is that its calls, arguments and connections are
 * representable — not which tools it happens to use.
 */
export function validateRecordedWorkflow(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["workflow must be an object"] };
  if (value.schemaVersion !== RECORDED_WORKFLOW_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (typeof value.workflowId !== "string" || value.workflowId.length === 0) {
    errors.push("workflowId must be a non-empty string");
  }
  const inputs = Array.isArray(value.inputs) ? value.inputs : null;
  if (!inputs) errors.push("inputs must be an array");
  const inputNames = new Set<string>();
  const inputTypes = new Map<string, string>();
  for (const input of inputs ?? []) {
    if (!isPlainObject(input) || typeof input.name !== "string" || input.name.length === 0) {
      errors.push("every input needs a non-empty name");
      continue;
    }
    if (inputNames.has(input.name)) errors.push(`duplicate input: ${input.name}`);
    inputNames.add(input.name);
    if (
      input.type !== "string" &&
      input.type !== "number" &&
      input.type !== "boolean" &&
      input.type !== "object" &&
      input.type !== "array"
    ) {
      errors.push(`input ${input.name} needs a recorded type`);
    } else {
      inputTypes.set(input.name, input.type);
    }
  }
  const declaredPrivates = new Set<string>();
  const privateReferences = (value as { privateReferences?: unknown }).privateReferences;
  if (privateReferences !== undefined) {
    if (!Array.isArray(privateReferences)) {
      errors.push("privateReferences must be an array when present");
    } else {
      for (const reference of privateReferences) {
        if (typeof reference !== "string" || reference.length === 0) {
          errors.push("every private reference must be a non-empty string");
          continue;
        }
        declaredPrivates.add(reference);
      }
    }
  }
  const steps = Array.isArray(value.steps) ? value.steps : null;
  if (!steps || steps.length === 0) errors.push("steps must be a non-empty array");
  const workflowCallIds = new Set<string>();
  for (const step of steps ?? []) {
    if (isPlainObject(step) && typeof step.callId === "string" && step.callId.length > 0) {
      workflowCallIds.add(step.callId);
    }
  }
  const stepIds = new Set<string>();
  for (const step of steps ?? []) {
    if (!isPlainObject(step) || typeof step.id !== "string" || step.id.length === 0) {
      errors.push("every step needs a non-empty id");
      continue;
    }
    if (stepIds.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (typeof step.callId !== "string" || step.callId.length === 0) {
      errors.push(`step ${step.id} needs the callId it was recorded from`);
    }
    const callable = step.callable;
    if (
      !isPlainObject(callable) ||
      typeof callable.runtime !== "string" ||
      typeof callable.name !== "string" ||
      callable.name.length === 0
    ) {
      errors.push(`step ${step.id} needs a callable with a runtime and a recorded name`);
    }
    const failurePolicy = (step as { failurePolicy?: unknown }).failurePolicy;
    if (
      !isPlainObject(failurePolicy) ||
      (failurePolicy.onError !== "abort" && failurePolicy.onError !== "continue") ||
      (failurePolicy.policy !== "recorded" && failurePolicy.policy !== "default")
    ) {
      errors.push(`step ${step.id} needs a failurePolicy with onError and policy`);
    }
    const observed = (step as { observed?: unknown }).observed;
    if (
      !isPlainObject(observed) ||
      (observed.outcome !== "succeeded" &&
        observed.outcome !== "failed" &&
        observed.outcome !== "unknown")
    ) {
      errors.push(`step ${step.id} needs an observed outcome`);
    }
    const permissions = (step as { permissions?: unknown }).permissions;
    if (permissions !== undefined && !isJsonValue(permissions)) {
      errors.push(`step ${step.id} permissions must be JSON`);
    }
  }
  // Dependencies and bindings may only address steps that exist and come earlier.
  const order = new Map<string, number>();
  (steps ?? []).forEach((step, index) => {
    if (isPlainObject(step) && typeof step.id === "string") order.set(step.id, index);
  });
  for (const step of steps ?? []) {
    if (!isPlainObject(step) || typeof step.id !== "string") continue;
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn : null;
    if (!dependsOn) {
      errors.push(`step ${step.id} dependsOn must be an array`);
    }
    for (const dependency of dependsOn ?? []) {
      if (typeof dependency !== "string" || !order.has(dependency)) {
        errors.push(`step ${step.id} depends on unknown step ${String(dependency)}`);
        continue;
      }
      if ((order.get(dependency) ?? 0) >= (order.get(step.id) ?? 0)) {
        errors.push(`step ${step.id} depends on ${dependency}, which does not come earlier`);
      }
    }
    const args = Array.isArray(step.arguments) ? step.arguments : null;
    if (!args) {
      errors.push(`step ${step.id} arguments must be an array`);
      continue;
    }
    for (const argument of args) {
      if (!isPlainObject(argument) || typeof argument.name !== "string") {
        errors.push(`step ${step.id} has an argument without a name`);
        continue;
      }
      const source = argument.source;
      if (!isPlainObject(source) || typeof source.kind !== "string") {
        errors.push(`step ${step.id} argument ${argument.name} needs a value source`);
        continue;
      }
      if (source.kind === "input" && !inputNames.has(String(source.name))) {
        errors.push(
          `step ${step.id} argument ${argument.name} reads unknown input ${String(source.name)}`,
        );
      }
      if (source.kind === "result") {
        const stepRef = String(source.stepId);
        if (!order.has(stepRef)) {
          errors.push(`step ${step.id} argument ${argument.name} reads unknown step ${stepRef}`);
        } else if ((order.get(stepRef) ?? 0) >= (order.get(step.id) ?? 0)) {
          errors.push(
            `step ${step.id} argument ${argument.name} reads ${stepRef}, which does not come earlier`,
          );
        }
        const path = source.path;
        if (
          !Array.isArray(path) ||
          !path.every((part) => typeof part === "string" || typeof part === "number")
        ) {
          errors.push(`step ${step.id} argument ${argument.name} has an invalid result path`);
        }
      }
      if (source.kind === "literal" && !isJsonValue(source.value)) {
        errors.push(`step ${step.id} argument ${argument.name} has a non-JSON literal`);
      }
      if (source.kind === "unresolved" && typeof source.reason !== "string") {
        errors.push(
          `step ${step.id} argument ${argument.name} needs a reason for its unknown origin`,
        );
      }
      if (source.kind === "template") {
        const problems: string[] = [];
        const walk = (template: unknown, where: string): void => {
          if (!isPlainObject(template)) {
            problems.push(`${where} is not a template node`);
            return;
          }
          switch (template.type) {
            case "literal":
              if (!isJsonValue(template.value)) problems.push(`${where} has a non-JSON literal`);
              return;
            case "input":
              if (typeof template.name !== "string" || !inputNames.has(template.name)) {
                problems.push(`${where} reads unknown input ${String(template.name)}`);
              }
              return;
            case "result": {
              const stepRef = typeof template.stepId === "string" ? template.stepId : "";
              if (!order.has(stepRef)) problems.push(`${where} reads unknown step ${stepRef}`);
              else if (
                (order.get(stepRef) ?? 0) >=
                (order.get(
                  typeof (step as { id?: unknown }).id === "string"
                    ? (step as { id: string }).id
                    : "",
                ) ?? 0)
              ) {
                problems.push(`${where} reads ${stepRef}, which does not come earlier`);
              }
              return;
            }
            case "private":
              if (
                typeof template.reference !== "string" ||
                !declaredPrivates.has(template.reference)
              ) {
                problems.push(
                  `${where} reads undeclared private reference ${String(template.reference)}`,
                );
              }
              return;
            case "unresolved":
              if (typeof template.reason !== "string") problems.push(`${where} needs a reason`);
              return;
            case "object": {
              if (!isPlainObject(template.entries)) {
                problems.push(`${where} object entries must be an object`);
                return;
              }
              for (const [key, entry] of Object.entries(template.entries)) {
                walk(entry, `${where}.${key}`);
              }
              return;
            }
            case "array": {
              if (!Array.isArray(template.items)) {
                problems.push(`${where} array items must be an array`);
                return;
              }
              template.items.forEach((entry, index) => walk(entry, `${where}[${index}]`));
              return;
            }
            case "program": {
              if (
                template.language !== "shell" &&
                template.language !== "python" &&
                template.language !== "javascript" &&
                template.language !== "typescript"
              ) {
                problems.push(`${where} program needs the language it runs in`);
              }
              if (!isPlainObject(template.source)) {
                problems.push(`${where} program needs the recorded text it resolves`);
              } else {
                walk(template.source, `${where}<text>`);
              }
              if (!Array.isArray(template.holes)) {
                problems.push(`${where} program holes must be an array`);
                return;
              }
              for (const [index, hole] of template.holes.entries()) {
                if (
                  !isPlainObject(hole) ||
                  typeof hole.token !== "number" ||
                  !Number.isInteger(hole.token) ||
                  hole.token < 0
                ) {
                  problems.push(`${where} hole ${index} must name a recorded token index`);
                  continue;
                }
                walk(hole.binding, `${where}<token ${hole.token}>`);
              }
              return;
            }
            default:
              problems.push(`${where} has unknown template type ${String(template.type)}`);
          }
        };
        walk(source.template, `step ${step.id} argument ${argument.name}`);
        errors.push(...problems);
      }
      if (source.kind === "private") {
        if (typeof source.reference !== "string" || source.reference.length === 0) {
          errors.push(`step ${step.id} argument ${argument.name} needs a private reference`);
        } else if (!declaredPrivates.has(source.reference)) {
          errors.push(
            `step ${step.id} argument ${argument.name} reads undeclared private reference '${source.reference}'`,
          );
        }
      }
      const provenance = argument.provenance;
      if (provenance !== undefined) {
        if (
          !isPlainObject(provenance) ||
          (provenance.standing !== "recorded" &&
            provenance.standing !== "derived" &&
            provenance.standing !== "candidate") ||
          typeof provenance.rule !== "string"
        ) {
          errors.push(`step ${step.id} argument ${argument.name} has an invalid provenance`);
        } else if (provenance.standing === "candidate" && typeof provenance.missing !== "string") {
          // A candidate that does not name what the record is missing is not reportable.
          errors.push(
            `step ${step.id} argument ${argument.name} is a candidate without the missing fact`,
          );
        }
      }
    }
    const callable = step.callable;
    const program = isPlainObject(callable) ? callable.program : undefined;
    if (program !== undefined) {
      if (
        !isPlainObject(program) ||
        (program.kind !== "shell" &&
          program.kind !== "python" &&
          program.kind !== "javascript" &&
          program.kind !== "typescript") ||
        typeof program.source !== "string"
      ) {
        errors.push(`step ${step.id} has an invalid recorded program`);
      } else if (
        program.source.length === 0 &&
        (!Array.isArray(program.argv) || program.argv.length === 0) &&
        typeof program.argument !== "string"
      ) {
        errors.push(
          `step ${step.id} records neither a program source, an argument vector, nor the argument the program arrives in`,
        );
      } else {
        validateWorkflowProgramSourceInterface(program, step.id, errors);
        validateWorkflowPythonState(
          program,
          step.id,
          typeof step.callId === "string" ? step.callId : undefined,
          workflowCallIds,
          declaredPrivates,
          errors,
        );
      }
    }
  }
  // A candidate addresses a real argument of a real step, and never executes.
  const candidates = value.candidates;
  if (candidates !== undefined) {
    if (!Array.isArray(candidates)) {
      errors.push("candidates must be an array when present");
    } else {
      for (const candidate of candidates) {
        if (!isPlainObject(candidate) || typeof candidate.argument !== "string") {
          errors.push("every candidate needs a step and an argument");
          continue;
        }
        const stepId = typeof candidate.stepId === "string" ? candidate.stepId : "";
        if (!order.has(stepId)) {
          errors.push(`candidate names unknown step ${stepId}`);
          continue;
        }
        const step = (steps ?? []).find((entry) => isPlainObject(entry) && entry.id === stepId);
        const args = isPlainObject(step) && Array.isArray(step.arguments) ? step.arguments : [];
        if (!args.some((entry) => isPlainObject(entry) && entry.name === candidate.argument)) {
          errors.push(`candidate ${stepId}.${candidate.argument} names no such argument`);
        }
        // A token path addresses the text of the program the step's own record names; a token that
        // points anywhere else would be applied to a value no tokenizer has read.
        const path = Array.isArray(candidate.path) ? candidate.path : [];
        if (path[0] === "tokens") {
          if (!Number.isInteger(path[1]) || (path[1] as number) < 0 || path.length !== 2) {
            errors.push(`candidate ${stepId}.${candidate.argument} has an invalid token position`);
          }
          const program = isPlainObject(step) ? step.callable : undefined;
          const recorded = isPlainObject(program) ? program.program : undefined;
          if (!isPlainObject(recorded) || recorded.argument !== candidate.argument) {
            errors.push(
              `candidate ${stepId}.${candidate.argument} names a token of a program the step's record does not hold in that argument`,
            );
          }
        }
        const proposed = candidate.proposed;
        if (!isPlainObject(proposed) || typeof proposed.kind !== "string") {
          errors.push(`candidate ${stepId}.${candidate.argument} needs a proposal`);
        } else if (proposed.kind === "result") {
          const stepRef = String(proposed.stepId);
          if (!order.has(stepRef)) {
            errors.push(`candidate ${stepId}.${candidate.argument} reads unknown step ${stepRef}`);
          }
        } else if (proposed.kind === "input") {
          if (typeof proposed.name !== "string" || proposed.name.length === 0) {
            errors.push(`candidate ${stepId}.${candidate.argument} needs an input name`);
          }
          if (
            proposed.type !== "string" &&
            proposed.type !== "number" &&
            proposed.type !== "boolean" &&
            proposed.type !== "object" &&
            proposed.type !== "array"
          ) {
            errors.push(`candidate ${stepId}.${candidate.argument} needs an input type`);
          }
        } else {
          errors.push(`candidate ${stepId}.${candidate.argument} has an unknown proposal kind`);
        }
        if (typeof candidate.missing !== "string" || candidate.missing.length === 0) {
          errors.push(
            `candidate ${stepId}.${candidate.argument} must name the fact the record is missing`,
          );
        }
      }
    }
  }
  // Demonstration references and baseline references are local only; neither carries values.
  if (value.baseline !== undefined) {
    validateDemonstration("baseline", value.baseline, order, declaredPrivates, errors);
  }
  if (value.heldOut !== undefined) {
    validateDemonstration("heldOut", value.heldOut, order, declaredPrivates, errors);
  }
  return { valid: errors.length === 0, errors };
}
