/**
 * Invocation of recorded calls through their own runtime.
 *
 * Adapters implement communication or execution for one runtime family — a protocol reached over a
 * connection, a program run on the host, a broker. The registry is keyed by the family the record
 * names, never by the tool, application or task: a callable discovered after this code was written
 * is callable as soon as its runtime family has an adapter, and a workflow that uses it needs no
 * change here.
 */

import {
  analyzeProgramSourceProjection,
  applyProgramTokenValues,
  tokenizeProgram,
  validateWorkflowProgramProjection,
} from "@resin/contracts";
import type {
  ProgramToken,
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowStep,
  WorkflowValuePath,
  WorkflowValueTemplate,
} from "@resin/contracts";

/** One call, with the callable the record names and the arguments resolved for it. */
export interface RecordedCallRequest {
  step: WorkflowStep;
  arguments: Record<string, WorkflowJsonValue>;
  /** Local private-reference resolver used by composite Python setup cells. */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Workspace scope forwarded to the private resolver. */
  access?: { workspaceId?: string };
}

/**
 * A runtime adapter: it talks to or runs the callable. It never decides whether a workflow is
 * supported.
 */
export interface RuntimeAdapter {
  /** The runtime family this adapter serves, matching `step.callable.runtime`. */
  readonly runtime: string;
  call(request: RecordedCallRequest): Promise<WorkflowJsonValue>;
}

export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.runtime)) {
      throw new Error(`runtime adapter already registered for '${adapter.runtime}'`);
    }
    this.adapters.set(adapter.runtime, adapter);
  }

  has(runtime: string): boolean {
    return this.adapters.has(runtime);
  }

  /** The adapter for a callable, or undefined when its runtime family is not reachable here. */
  resolve(step: WorkflowStep): RuntimeAdapter | undefined {
    return this.adapters.get(step.callable.runtime);
  }
}

export interface RecordedWorkflowExecutionOptions {
  inputs: Record<string, WorkflowJsonValue>;
  adapters: RuntimeAdapterRegistry;
  /** The workspace this invocation runs in, checked before any private reference resolves. */
  access?: { workspaceId?: string };
  /**
   * Private resources are resolved here, at execution time; they are never part of the plan.
   * The access context names the workspace the invocation runs in so the host can refuse a
   * reference recorded elsewhere, instead of treating the reference string as a capability.
   */
  resolvePrivate?: (
    reference: string,
    access?: { workspaceId?: string },
  ) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  /** Reported when a required adapter or binding is missing, instead of pretending to succeed. */
  onUnavailable?: (step: WorkflowStep, reason: string) => void;
}

export type RecordedStepOutcome =
  | { stepId: string; status: "completed"; result: WorkflowJsonValue }
  | { stepId: string; status: "failed"; error: string }
  | { stepId: string; status: "skipped"; reason: string };

export type RecordedWorkflowExecution = {
  status: "completed" | "failed";
  steps: RecordedStepOutcome[];
  /** The last completed step's result. */
  result: WorkflowJsonValue | undefined;
  error?: string;
};

export class WorkflowBindingError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    public readonly argument: string,
  ) {
    super(message);
    this.name = "WorkflowBindingError";
  }
}

function matchesWorkflowInputType(
  value: unknown,
  type: RecordedWorkflow["inputs"][number]["type"],
): value is WorkflowJsonValue {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  return false;
}

function copyWorkflowJsonValue(value: WorkflowJsonValue): WorkflowJsonValue {
  return value !== null && typeof value === "object"
    ? (JSON.parse(JSON.stringify(value)) as WorkflowJsonValue)
    : value;
}

function readPath(
  value: WorkflowJsonValue,
  path: WorkflowValuePath,
): WorkflowJsonValue | undefined {
  let current: WorkflowJsonValue | undefined = value;
  for (const part of path) {
    if (current === undefined || current === null) return undefined;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, WorkflowJsonValue>)[part];
  }
  return current;
}

/** Validate projection metadata before trusting it to select the executable source. */
function projectedProgramSource(
  template: Extract<WorkflowValueTemplate, { type: "program" }>,
  stepId: string,
  argumentName: string,
): string | undefined {
  const hasReference = Object.prototype.hasOwnProperty.call(template, "sourceReference");
  const hasProtectedTokens = Object.prototype.hasOwnProperty.call(template, "protectedTokens");
  if (!hasReference && !hasProtectedTokens) return undefined;
  const errors: string[] = [];
  validateWorkflowProgramProjection(template, `${stepId}.${argumentName}`, errors);
  if (errors.length > 0) {
    throw new WorkflowBindingError(errors.join("; "), stepId, argumentName);
  }
  if (typeof template.sourceReference !== "string") {
    throw new WorkflowBindingError(
      "the projected program source reference is malformed",
      stepId,
      argumentName,
    );
  }
  return template.sourceReference;
}

/** Builds a recursively constructed argument: every leaf keeps its own source. */
async function buildTemplate(
  template: WorkflowValueTemplate,
  step: WorkflowStep,
  argumentName: string,
  options: RecordedWorkflowExecutionOptions,
  results: Map<string, WorkflowJsonValue>,
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowJsonValue> {
  const resolveLeaf = async (leaf: WorkflowValueTemplate): Promise<WorkflowJsonValue> =>
    buildTemplate(leaf, step, argumentName, options, results, declaredPrivateReferences);
  switch (template.type) {
    case "literal":
      return template.value;
    case "input": {
      if (!Object.hasOwn(options.inputs, template.name)) {
        throw new WorkflowBindingError(
          `input '${template.name}' was not supplied`,
          step.id,
          argumentName,
        );
      }
      return options.inputs[template.name] as WorkflowJsonValue;
    }
    case "result": {
      if (!results.has(template.stepId)) {
        throw new WorkflowBindingError(
          `step '${template.stepId}' has no result in this invocation; it did not complete`,
          step.id,
          argumentName,
        );
      }
      const value = readPath(results.get(template.stepId) as WorkflowJsonValue, template.path);
      if (value === undefined) {
        throw new WorkflowBindingError(
          `step '${template.stepId}' returned no value at path ${JSON.stringify(template.path)}`,
          step.id,
          argumentName,
        );
      }
      return value;
    }
    case "private": {
      if (!options.resolvePrivate) {
        throw new WorkflowBindingError(
          `private reference '${template.reference}' cannot be resolved in this environment`,
          step.id,
          argumentName,
        );
      }
      return await options.resolvePrivate(template.reference, options.access);
    }
    case "unresolved":
      throw new WorkflowBindingError(
        `the origin of this value was not recorded (${template.reason}); re-record the call or supply it as an input`,
        step.id,
        argumentName,
      );
    case "object": {
      const built: Record<string, WorkflowJsonValue> = {};
      for (const [key, entry] of Object.entries(template.entries)) {
        built[key] = await resolveLeaf(entry);
      }
      return built;
    }
    case "array": {
      const built: WorkflowJsonValue[] = [];
      for (const item of template.items) built.push(await resolveLeaf(item));
      return built;
    }
    case "program": {
      // A projected literal is only a bounded, secret-redacted view. Its whole original is the
      // execution authority and must resolve locally before tokenization or binding substitution.
      const projection = projectedProgramSource(template, step.id, argumentName);
      if (projection !== undefined && !declaredPrivateReferences.has(projection)) {
        throw new WorkflowBindingError(
          "the projected program source reference is not declared by the workflow",
          step.id,
          argumentName,
        );
      }
      let text: string;
      if (projection !== undefined) {
        if (!options.resolvePrivate) {
          throw new WorkflowBindingError(
            "the original program source reference cannot be resolved in this environment",
            step.id,
            argumentName,
          );
        }
        const original = await options.resolvePrivate(projection, options.access);
        if (typeof original !== "string") {
          throw new WorkflowBindingError(
            "the original program source reference did not resolve to program text",
            step.id,
            argumentName,
          );
        }
        text = original;
      } else {
        const sourceText = await resolveLeaf(template.source);
        if (typeof sourceText !== "string") {
          throw new WorkflowBindingError(
            "the recorded program did not resolve to program text",
            step.id,
            argumentName,
          );
        }
        text = sourceText;
      }
      let tokens: ProgramToken[] | undefined;
      if (projection !== undefined) {
        const sanitizedSource = template.source;
        if (
          sanitizedSource.type !== "literal" ||
          typeof sanitizedSource.value !== "string" ||
          template.protectedTokens === undefined
        ) {
          throw new WorkflowBindingError(
            "the projected program metadata is malformed",
            step.id,
            argumentName,
          );
        }
        tokens = analyzeProgramSourceProjection(
          template.language,
          text,
          sanitizedSource.value,
          template.protectedTokens,
        ).tokens;
      }
      const values = new Map<number, string | number | boolean | null>();
      for (const hole of template.holes) {
        const bound = await resolveLeaf(hole.binding);
        values.set(
          hole.token,
          typeof bound === "string" ||
            typeof bound === "number" ||
            typeof bound === "boolean" ||
            bound === null
            ? bound
            : JSON.stringify(bound),
        );
      }
      return applyProgramTokenValues(
        text,
        tokens ?? tokenizeProgram(template.language, text),
        values,
        template.language,
      );
    }
    default: {
      const exhaustive: never = template;
      throw new WorkflowBindingError(
        `unsupported template node ${JSON.stringify(exhaustive)}`,
        step.id,
        argumentName,
      );
    }
  }
}

async function resolveArgument(
  step: WorkflowStep,
  argumentName: string,
  source: WorkflowStep["arguments"][number]["source"],
  options: RecordedWorkflowExecutionOptions,
  results: Map<string, WorkflowJsonValue>,
  declaredPrivateReferences: ReadonlySet<string>,
): Promise<WorkflowJsonValue> {
  switch (source.kind) {
    case "literal":
      return source.value;
    case "input": {
      if (!Object.hasOwn(options.inputs, source.name)) {
        throw new WorkflowBindingError(
          `input '${source.name}' was not supplied`,
          step.id,
          argumentName,
        );
      }
      return options.inputs[source.name] as WorkflowJsonValue;
    }
    case "result": {
      if (!results.has(source.stepId)) {
        throw new WorkflowBindingError(
          `step '${source.stepId}' has no result in this invocation; it did not complete`,
          step.id,
          argumentName,
        );
      }
      const value = readPath(results.get(source.stepId) as WorkflowJsonValue, source.path);
      if (value === undefined) {
        throw new WorkflowBindingError(
          `step '${source.stepId}' returned no value at path ${JSON.stringify(source.path)}`,
          step.id,
          argumentName,
        );
      }
      return value;
    }
    case "private": {
      if (!options.resolvePrivate) {
        throw new WorkflowBindingError(
          `private reference '${source.reference}' cannot be resolved in this environment`,
          step.id,
          argumentName,
        );
      }
      return await options.resolvePrivate(source.reference, options.access);
    }
    case "unresolved":
      throw new WorkflowBindingError(
        `the origin of this value was not recorded (${source.reason}); re-record the call or supply it as an input`,
        step.id,
        argumentName,
      );
    case "template":
      return await buildTemplate(
        source.template,
        step,
        argumentName,
        options,
        results,
        declaredPrivateReferences,
      );
    default: {
      const exhaustive: never = source;
      throw new WorkflowBindingError(
        `unsupported value source ${JSON.stringify(exhaustive)}`,
        step.id,
        argumentName,
      );
    }
  }
}

/**
 * Runs a recorded workflow: each step's arguments are resolved from this invocation's inputs, the
 * results this invocation produced, and locally resolved private references — never from recorded
 * values — and the recorded order and failure behavior are preserved.
 */
export async function executeRecordedWorkflow(
  workflow: RecordedWorkflow,
  options: RecordedWorkflowExecutionOptions,
): Promise<RecordedWorkflowExecution> {
  const suppliedNames = new Set(Object.keys(options.inputs));
  const declaredNames = new Set(workflow.inputs.map((input) => input.name));
  for (const name of suppliedNames) {
    if (!declaredNames.has(name)) throw new TypeError(`unknown workflow input '${name}'`);
  }

  const inputs: Record<string, WorkflowJsonValue> = Object.create(null);
  for (const input of workflow.inputs) {
    if (Object.hasOwn(options.inputs, input.name)) {
      const value = options.inputs[input.name];
      if (!matchesWorkflowInputType(value, input.type)) {
        throw new TypeError(`workflow input '${input.name}' must be a ${input.type}`);
      }
      inputs[input.name] = value;
    } else if (Object.hasOwn(input, "default")) {
      if (!matchesWorkflowInputType(input.default, input.type)) {
        throw new TypeError(
          `workflow input '${input.name}' has a default incompatible with ${input.type}`,
        );
      }
      inputs[input.name] = copyWorkflowJsonValue(input.default);
    } else {
      throw new TypeError(`missing required workflow input '${input.name}'`);
    }
  }
  const executionOptions = { ...options, inputs };
  const outcomes: RecordedStepOutcome[] = [];
  const results = new Map<string, WorkflowJsonValue>();
  const state = new Map<string, "completed" | "failed" | "skipped">();
  const declaredPrivateReferences = new Set(workflow.privateReferences ?? []);
  let aborted = false;

  for (const step of workflow.steps) {
    if (aborted) {
      state.set(step.id, "skipped");
      outcomes.push({ stepId: step.id, status: "skipped", reason: "an earlier step failed" });
      continue;
    }
    const blockedBy = step.dependsOn.find((dependency) => state.get(dependency) !== "completed");
    if (blockedBy) {
      state.set(step.id, "skipped");
      outcomes.push({
        stepId: step.id,
        status: "skipped",
        reason: `dependency '${blockedBy}' did not complete`,
      });
      continue;
    }

    const adapter = executionOptions.adapters.resolve(step);
    if (!adapter) {
      const reason = `no adapter for runtime '${step.callable.runtime}'`;
      executionOptions.onUnavailable?.(step, reason);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: reason });
      if (step.failurePolicy.onError === "abort") aborted = true;
      continue;
    }

    let args: Record<string, WorkflowJsonValue>;
    try {
      args = {};
      for (const argument of step.arguments) {
        args[argument.name] = await resolveArgument(
          step,
          argument.name,
          argument.source,
          executionOptions,
          results,
          declaredPrivateReferences,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failurePolicy.onError === "abort") aborted = true;
      continue;
    }

    try {
      const result = await adapter.call({
        step,
        arguments: args,
        ...(options.resolvePrivate ? { resolvePrivate: options.resolvePrivate } : {}),
        ...(options.access ? { access: options.access } : {}),
      });
      results.set(step.id, result);
      state.set(step.id, "completed");
      outcomes.push({ stepId: step.id, status: "completed", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failurePolicy.onError === "abort") aborted = true;
    }
  }

  const failure = outcomes.find((outcome) => outcome.status === "failed");
  const lastCompleted = [...outcomes].reverse().find((outcome) => outcome.status === "completed");
  return {
    status: failure ? "failed" : "completed",
    steps: outcomes,
    result: lastCompleted?.status === "completed" ? lastCompleted.result : undefined,
    ...(failure?.status === "failed" ? { error: failure.error } : {}),
  };
}

/** The input schema of a recorded workflow, with defaults optional and other inputs required. */
export function recordedWorkflowInputSchema(workflow: RecordedWorkflow): Record<string, unknown> {
  const JSON_SCHEMA_TYPES: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    object: "object",
    array: "array",
  };
  const properties: Record<string, unknown> = {};
  for (const input of workflow.inputs) {
    properties[input.name] = {
      type: JSON_SCHEMA_TYPES[input.type] ?? "string",
      ...(input.description ? { description: input.description } : {}),
      ...(Object.hasOwn(input, "default") ? { default: input.default } : {}),
    };
  }
  return {
    type: "object",
    properties,
    required: workflow.inputs
      .filter((input) => !Object.hasOwn(input, "default"))
      .map((input) => input.name),
    additionalProperties: false,
  };
}
