/**
 * Deterministic compilation of a recorded workflow into a callable artifact.
 *
 * Compilation is a pure function of the recording: it validates the workflow, refuses anything whose
 * behaviour the recording does not establish, and emits the plan, the input schema, the output
 * contract and the runtime requirements. No model writes code here, and nothing is re-planned at
 * invocation time — the artifact executes the plan through the runtime adapters.
 */

import {
  type RecordedWorkflow,
  type WorkflowValueTemplate,
  validateRecordedWorkflow,
} from "@resin/contracts";
import {
  type RecordedWorkflowExecution,
  type RuntimeAdapterRegistry,
  type WorkflowJsonValue,
  executeRecordedWorkflow,
} from "./recorded-workflow.js";

export class RecordedWorkflowCompilationError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_workflow" | "unresolved_origin" | "missing_output_contract",
  ) {
    super(message);
    this.name = "RecordedWorkflowCompilationError";
  }
}

export interface CompiledWorkflowArtifact {
  /** The frozen plan: exactly what the recording established. */
  plan: RecordedWorkflow;
  /** Identity of this artifact: stable for the same recorded workflow. */
  digest: string;
  /** Deterministic name derived from the callables, never from a model. */
  name: string;
  /** Caller-facing input schema, using the recorded types. */
  inputSchema: Record<string, unknown>;
  /** What the artifact returns: the last step's recorded result shape. */
  outputContract: { fromStep: string; callable: string };
  /** Runtimes the artifact needs adapters for. */
  requiredRuntimes: string[];
  /** Private references the host must resolve locally at invocation time. */
  requiredPrivateReferences: string[];
  /** Permissions the recorded calls used, per step. */
  permissions: Array<{ stepId: string; permissions: WorkflowJsonValue }>;
}

function collectUnresolved(workflow: RecordedWorkflow): string[] {
  const unresolved: string[] = [];
  const walk = (template: WorkflowValueTemplate, where: string): void => {
    switch (template.type) {
      case "unresolved":
        unresolved.push(`${where}: ${template.reason}`);
        return;
      case "object":
        for (const [key, entry] of Object.entries(template.entries)) walk(entry, `${where}.${key}`);
        return;
      case "array":
        template.items.forEach((entry, index) => walk(entry, `${where}[${index}]`));
        return;
      default:
        return;
    }
  };
  for (const step of workflow.steps) {
    for (const argument of step.arguments) {
      if (argument.source.kind === "template") {
        walk(argument.source.template, `${step.id}.${argument.name}`);
      }
    }
  }
  return unresolved;
}

function canonicalise(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalise(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Small stable digest; identity only, not a security boundary. */
function digestOf(value: unknown): string {
  const text = canonicalise(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wf_${hash.toString(16).padStart(8, "0")}_${text.length.toString(16)}`;
}

/** A deterministic name from the runtime family and callable names, never from a model. */
function nameOf(workflow: RecordedWorkflow): string {
  const parts = workflow.steps.map((step) => step.callable.name);
  const base = parts
    .join("_and_")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base.length > 0
    ? `${base}_${digestOf(workflow).slice(3, 11)}`
    : `workflow_${digestOf(workflow).slice(3, 11)}`;
}

/**
 * Compiles a recorded workflow. Compilation refuses what the recording does not establish rather
 * than inventing behaviour; everything else compiles, independently of which tools it uses.
 */
export function compileRecordedWorkflow(workflow: RecordedWorkflow): CompiledWorkflowArtifact {
  const validation = validateRecordedWorkflow(workflow);
  if (!validation.valid) {
    throw new RecordedWorkflowCompilationError(
      `recorded workflow is not valid: ${validation.errors.join("; ")}`,
      "invalid_workflow",
    );
  }
  const unresolved = collectUnresolved(workflow);
  if (unresolved.length > 0) {
    throw new RecordedWorkflowCompilationError(
      `the recording does not establish this behaviour: ${unresolved.join("; ")}`,
      "unresolved_origin",
    );
  }
  const last = workflow.steps[workflow.steps.length - 1]!;

  const JSON_SCHEMA_TYPES: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    object: "object",
    array: "array",
  };
  const properties: Record<string, unknown> = {};
  for (const input of workflow.inputs) {
    properties[input.name] = { type: JSON_SCHEMA_TYPES[input.type] ?? "string" };
  }

  return {
    plan: workflow,
    digest: digestOf(workflow),
    name: nameOf(workflow),
    inputSchema: {
      type: "object",
      properties,
      required: workflow.inputs.map((input) => input.name),
      additionalProperties: false,
    },
    outputContract: { fromStep: last.id, callable: last.callable.name },
    requiredRuntimes: [...new Set(workflow.steps.map((step) => step.callable.runtime))],
    requiredPrivateReferences: [...(workflow.privateReferences ?? [])],
    permissions: workflow.steps
      .filter((step) => step.permissions !== undefined)
      .map((step) => ({ stepId: step.id, permissions: step.permissions as WorkflowJsonValue })),
  };
}

/**
 * The callable form of a compiled artifact: it runs the frozen plan through the host's adapters and
 * private resolver, and returns the last step's result.
 */
export function instantiateRecordedWorkflow(
  artifact: CompiledWorkflowArtifact,
  host: {
    adapters: RuntimeAdapterRegistry;
    resolvePrivate?: (reference: string) => WorkflowJsonValue | Promise<WorkflowJsonValue>;
  },
): {
  name: string;
  inputSchema: Record<string, unknown>;
  invoke: (inputs: Record<string, WorkflowJsonValue>) => Promise<RecordedWorkflowExecution>;
} {
  const missing = artifact.requiredRuntimes.filter((runtime) => !host.adapters.has(runtime));
  return {
    name: artifact.name,
    inputSchema: artifact.inputSchema,
    invoke: async (inputs) => {
      if (missing.length > 0) {
        throw new Error(`this host cannot run the workflow: no adapter for ${missing.join(", ")}`);
      }
      return executeRecordedWorkflow(artifact.plan, {
        inputs,
        adapters: host.adapters,
        ...(host.resolvePrivate ? { resolvePrivate: host.resolvePrivate } : {}),
      });
    },
  };
}
