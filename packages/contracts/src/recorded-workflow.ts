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

export type WorkflowValueSource =
  | { kind: "literal"; value: WorkflowJsonValue }
  /** Supplied by the caller of the generated tool. */
  | { kind: "input"; name: string }
  /** The value a previous step returned, addressed by path — never by matching text. */
  | { kind: "result"; stepId: string; path: WorkflowValuePath }
  /** A private resource resolved locally at execution time and never uploaded. */
  | { kind: "private"; reference: string };

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
};

export type WorkflowArgument = {
  /** Argument name as the callable's schema names it. */
  name: string;
  source: WorkflowValueSource;
};

export type WorkflowStepFailureBehavior =
  /** A failure stops the workflow, as the recorded control flow did. */
  | "abort"
  /** The recorded control flow continued after this call's failure. */
  | "continue";

export type WorkflowStep = {
  /** Stable identity of this step inside the workflow. */
  id: string;
  /** Identity of the recording this step came from: the call and its result. */
  callId: string;
  callable: WorkflowCallable;
  arguments: WorkflowArgument[];
  /** Steps that must complete first, preserving the recorded ordering and dependencies. */
  dependsOn: string[];
  failure: WorkflowStepFailureBehavior;
  /** Execution permissions the recorded call used, for reporting and for the runtime to enforce. */
  permissions?: WorkflowJsonValue;
};

export type RecordedWorkflow = {
  schemaVersion: typeof RECORDED_WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  /** Caller-supplied inputs, in the order the workflow exposes them. */
  inputs: Array<{ name: string; description?: string }>;
  steps: WorkflowStep[];
  /** Private resources the workflow needs locally, addressed by reference only. */
  privateReferences?: string[];
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
  for (const input of inputs ?? []) {
    if (!isPlainObject(input) || typeof input.name !== "string" || input.name.length === 0) {
      errors.push("every input needs a non-empty name");
      continue;
    }
    if (inputNames.has(input.name)) errors.push(`duplicate input: ${input.name}`);
    inputNames.add(input.name);
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
    const failure = (step as { failure?: unknown }).failure;
    if (failure !== "abort" && failure !== "continue") {
      errors.push(`step ${step.id} failure must be 'abort' or 'continue'`);
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
      if (source.kind === "private") {
        if (typeof source.reference !== "string" || source.reference.length === 0) {
          errors.push(`step ${step.id} argument ${argument.name} needs a private reference`);
        } else if (!declaredPrivates.has(source.reference)) {
          errors.push(
            `step ${step.id} argument ${argument.name} reads undeclared private reference '${source.reference}'`,
          );
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
