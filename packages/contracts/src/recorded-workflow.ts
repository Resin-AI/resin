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

/** One leaf of a recursively constructed argument. */
export type WorkflowValueTemplate =
  | { type: "literal"; value: WorkflowJsonValue }
  | { type: "input"; name: string }
  | { type: "result"; stepId: string; path: WorkflowValuePath }
  | { type: "private"; reference: string }
  /** Origin the record does not establish: preserved as such, never guessed. */
  | { type: "unresolved"; reason: string }
  | { type: "object"; entries: Record<string, WorkflowValueTemplate> }
  | { type: "array"; items: WorkflowValueTemplate[] };

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
    }
  }
  return { valid: errors.length === 0, errors };
}
