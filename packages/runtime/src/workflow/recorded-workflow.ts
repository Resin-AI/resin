/**
 * Invocation of recorded calls through their own runtime.
 *
 * Adapters implement communication or execution for one runtime family — a protocol reached over a
 * connection, a program run on the host, a broker. The registry is keyed by the family the record
 * names, never by the tool, application or task: a callable discovered after this code was written
 * is callable as soon as its runtime family has an adapter, and a workflow that uses it needs no
 * change here.
 */

import type {
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowStep,
  WorkflowValuePath,
} from "@resin/contracts";

/** One call, with the callable the record names and the arguments resolved for it. */
export interface RecordedCallRequest {
  step: WorkflowStep;
  arguments: Record<string, WorkflowJsonValue>;
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
  /** Private resources are resolved here, at execution time; they are never part of the plan. */
  resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
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

async function resolveArgument(
  step: WorkflowStep,
  argumentName: string,
  source: WorkflowStep["arguments"][number]["source"],
  options: RecordedWorkflowExecutionOptions,
  results: Map<string, WorkflowJsonValue>,
): Promise<WorkflowJsonValue> {
  switch (source.kind) {
    case "literal":
      return source.value;
    case "input": {
      if (!(source.name in options.inputs)) {
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
      return await options.resolvePrivate(source.reference);
    }
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
  const outcomes: RecordedStepOutcome[] = [];
  const results = new Map<string, WorkflowJsonValue>();
  const state = new Map<string, "completed" | "failed" | "skipped">();
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

    const adapter = options.adapters.resolve(step);
    if (!adapter) {
      const reason = `no adapter for runtime '${step.callable.runtime}'`;
      options.onUnavailable?.(step, reason);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: reason });
      if (step.failure === "abort") aborted = true;
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
          options,
          results,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failure === "abort") aborted = true;
      continue;
    }

    try {
      const result = await adapter.call({ step, arguments: args });
      results.set(step.id, result);
      state.set(step.id, "completed");
      outcomes.push({ stepId: step.id, status: "completed", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.set(step.id, "failed");
      outcomes.push({ stepId: step.id, status: "failed", error: message });
      if (step.failure === "abort") aborted = true;
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

/** The input schema of a recorded workflow: every declared input is required. */
export function recordedWorkflowInputSchema(workflow: RecordedWorkflow): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const input of workflow.inputs) {
    properties[input.name] = {
      type: "string",
      ...(input.description ? { description: input.description } : {}),
    };
  }
  return {
    type: "object",
    properties,
    required: workflow.inputs.map((input) => input.name),
    additionalProperties: false,
  };
}
