/**
 * Recording the recipe of a session's executable work.
 *
 * This runs on the pre-privacy record, locally. Where the record establishes where an argument came
 * from, that origin is kept; where it does not, the argument is preserved as unresolved — the
 * recorder never infers a dependency from a matching value and never freezes a value it cannot
 * explain.
 *
 * Private values are decided per leaf, recursively: a secret inside a larger string or inside a
 * nested object becomes a private reference for that leaf, so a call that carries one remains
 * executable instead of being discarded.
 */

import type {
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowStep,
  WorkflowValueTemplate,
} from "@resin/contracts";

/** Where a recorded argument's value came from, as the record establishes it. */
export type RecordedArgumentOrigin = WorkflowValueTemplate;

export interface RecordedCallObservation {
  callId: string;
  /** Position in the session, for ordering the calls. */
  causalSequence?: number;
  callable: { runtime: string; name: string; connection?: string };
  /** Values the call was made with, exactly as recorded. */
  arguments: Record<string, WorkflowJsonValue>;
  /**
   * Origins the record establishes, per argument name. An argument without one is recorded as
   * unresolved.
   */
  argumentOrigins?: Record<string, RecordedArgumentOrigin>;
  /** Recorded types of the arguments, used for the workflow's input schema. */
  argumentTypes?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
  result?: WorkflowJsonValue;
  /**
   * Whether this value is private, decided by the privacy layer. It may match a whole value or a
   * substring of one, which is how a secret inside a larger string is caught.
   */
  isPrivateValue?: (value: string) => boolean;
  /** The recorded control flow when this call failed. Absent when the record does not say. */
  recordedFailureControl?: "abort" | "continue";
  /** What the recording observed; never treated as the workflow's behavior. */
  observed?: "succeeded" | "failed" | "unknown";
  permissions?: WorkflowJsonValue;
}

export interface RecordedRecipe {
  workflow: RecordedWorkflow;
  /** Values the workflow needs locally at execution time, addressed by reference only. */
  privateValues: Map<string, WorkflowJsonValue>;
  /** Calls the recorder could not represent, with the reason. Never silently dropped. */
  skipped: Array<{ callId: string; reason: string }>;
}

function isPlainObjectValue(value: unknown): value is Record<string, WorkflowJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(
  value: WorkflowJsonValue,
): "string" | "number" | "boolean" | "object" | "array" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function recordWorkflowRecipeInternal(
  workflowId: string,
  observations: readonly RecordedCallObservation[],
): RecordedRecipe | undefined {
  const ordered = [...observations].sort(
    (left, right) =>
      (left.causalSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.causalSequence ?? Number.MAX_SAFE_INTEGER),
  );
  const privateValues = new Map<string, WorkflowJsonValue>();
  const skipped: Array<{ callId: string; reason: string }> = [];
  const steps: WorkflowStep[] = [];
  const inputTypes = new Map<string, "string" | "number" | "boolean" | "object" | "array">();
  let privateCounter = 0;

  const makePrivate = (value: WorkflowJsonValue): WorkflowValueTemplate => {
    const reference = `private:${workflowId}:${privateCounter++}`;
    privateValues.set(reference, value);
    return { type: "private", reference };
  };

  /** Builds a template for one value, deciding privacy per leaf and keeping recorded origins. */
  const templateFor = (
    value: WorkflowJsonValue,
    origin: RecordedArgumentOrigin | undefined,
    isPrivate: ((value: string) => boolean) | undefined,
  ): WorkflowValueTemplate => {
    const privateHere = (leaf: WorkflowJsonValue): WorkflowValueTemplate | undefined => {
      if (typeof leaf === "string" && isPrivate?.(leaf) === true) return makePrivate(leaf);
      return undefined;
    };
    switch (origin?.type) {
      case "literal":
      case "input":
      case "result":
      case "private":
      case "unresolved":
        return privateHere(value) ?? origin;
      case "object":
        // A recorded origin may describe only part of the value; keep its leaves, and decide the rest
        // from the record.
        if (isPlainObjectValue(value)) {
          const entries: Record<string, WorkflowValueTemplate> = {};
          for (const [key, entry] of Object.entries(value)) {
            entries[key] = templateFor(entry, origin.entries[key], isPrivate);
          }
          return { type: "object", entries };
        }
        return privateHere(value) ?? origin;
      case "array":
        if (Array.isArray(value)) {
          return {
            type: "array",
            items: value.map((entry, index) => templateFor(entry, origin.items[index], isPrivate)),
          };
        }
        return privateHere(value) ?? origin;
      case undefined:
      default: {
        const privateLeaf = privateHere(value);
        if (privateLeaf) return privateLeaf;
        if (Array.isArray(value)) {
          return {
            type: "array",
            items: value.map((entry) => templateFor(entry, undefined, isPrivate)),
          };
        }
        if (isPlainObjectValue(value)) {
          const entries: Record<string, WorkflowValueTemplate> = {};
          for (const [key, entry] of Object.entries(value)) {
            entries[key] = templateFor(entry, undefined, isPrivate);
          }
          return { type: "object", entries };
        }
        // The origin is not established by the record: it is preserved as unknown, never guessed
        // from a matching value and never frozen as a constant.
        return {
          type: "unresolved",
          reason: "the record does not establish this argument's origin",
        };
      }
    }
  };

  for (const observation of ordered) {
    if (steps.some((step) => step.callId === observation.callId)) {
      // Repeated delivery of one execution is not a second step.
      continue;
    }
    const stepId = `step${steps.length}`;
    const sources: Record<string, WorkflowValueTemplate> = {};
    for (const [name, value] of Object.entries(observation.arguments)) {
      const origin = observation.argumentOrigins?.[name];
      if (origin?.type === "input") {
        const recorded = observation.argumentTypes?.[name] ?? jsonTypeOf(value);
        const existing = inputTypes.get(origin.name);
        inputTypes.set(origin.name, existing ?? recorded);
      }
      sources[name] = templateFor(value, origin, observation.isPrivateValue);
    }

    const dependsOn = [
      ...new Set(
        Object.values(sources)
          .flatMap(function collect(template: WorkflowValueTemplate): string[] {
            switch (template.type) {
              case "result":
                return [template.stepId];
              case "object":
                return Object.values(template.entries).flatMap(collect);
              case "array":
                return template.items.flatMap(collect);
              default:
                return [];
            }
          })
          .filter((dependency) => steps.some((step) => step.id === dependency)),
      ),
    ];

    steps.push({
      id: stepId,
      callId: observation.callId,
      callable: {
        runtime: observation.callable.runtime,
        name: observation.callable.name,
        ...(observation.callable.connection ? { connection: observation.callable.connection } : {}),
      },
      arguments: Object.entries(sources).map(([name, template]) => ({
        name,
        source: { kind: "template" as const, template },
      })),
      dependsOn,
      failurePolicy:
        observation.recordedFailureControl === undefined
          ? { onError: "abort", policy: "default" as const }
          : { onError: observation.recordedFailureControl, policy: "recorded" as const },
      observed: { outcome: observation.observed ?? "unknown" },
      ...(observation.permissions === undefined ? {} : { permissions: observation.permissions }),
    });
  }

  if (steps.length === 0) return undefined;
  const workflow: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId,
    inputs: [...inputTypes.entries()].map(([name, type]) => ({ name, type })),
    steps,
    ...(privateValues.size > 0 ? { privateReferences: [...privateValues.keys()] } : {}),
  };
  return { workflow, privateValues, skipped };
}

export function recordWorkflowRecipe(
  workflowId: string,
  observations: readonly RecordedCallObservation[],
): RecordedRecipe | undefined {
  return recordWorkflowRecipeInternal(workflowId, observations);
}
