/**
 * Recording the recipe of a session's executable work.
 *
 * This runs on the pre-privacy record, locally: it keeps the values so a later call can be bound to
 * the value an earlier call actually produced, and it hands the compiler a representation in which
 * private values exist only as references.
 *
 * Provenance is never inferred from text. A value is bound to an earlier call only when exactly one
 * earlier call in the session produced it and the value is a leaf of that call's structured result;
 * a value several calls happen to produce stays a constant, because ambiguity is not evidence.
 */

import type {
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowStep,
  WorkflowValuePath,
  WorkflowValueSource,
} from "@resin/contracts";

/** One recorded call, as the recorder saw it before any privacy filtering. */
export interface RecordedCallObservation {
  callId: string;
  /** Position in the session, for ordering the calls. */
  causalSequence?: number;
  callable: {
    runtime: string;
    name: string;
    connection?: string;
  };
  /** Arguments the call was made with, exactly as recorded. */
  arguments: Record<string, WorkflowJsonValue>;
  /** The call's structured result, when the record carries one. */
  result?: WorkflowJsonValue;
  /** Values the privacy filter masked locally; they become private references, never literals. */
  maskedValues?: string[];
  /** True when the recorded call failed. */
  failed?: boolean;
  permissions?: WorkflowJsonValue;
}

export interface RecordedRecipe {
  /** The workflow in a form that carries no private or session-local values. */
  workflow: RecordedWorkflow;
  /** Values the workflow needs locally at execution time, addressed by reference. */
  privateValues: Map<string, WorkflowJsonValue>;
  /** Observations the recorder could not turn into steps, with the reason. */
  skipped: Array<{ callId: string; reason: string }>;
}

interface Producer {
  callId: string;
  stepId: string;
  path: WorkflowValuePath;
  value: WorkflowJsonValue;
}

function leafEntries(
  value: WorkflowJsonValue,
  path: WorkflowValuePath = [],
): Array<{ path: WorkflowValuePath; value: WorkflowJsonValue }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leafEntries(entry, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => leafEntries(entry, [...path, key]));
  }
  return path.length === 0 ? [] : [{ path, value }];
}

/**
 * Builds the recipe of a session from its recorded calls.
 *
 * A call becomes one step. Its arguments become bindings to an earlier call's result when exactly
 * one earlier call produced that value, a private reference when the privacy filter masked it, and a
 * constant otherwise. Calls the recorder cannot represent are reported, never guessed.
 */
export function recordWorkflowRecipe(
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
  // Producers indexed by the exact value they returned, built only from calls already recorded.
  const producersByValue = new Map<string, Producer[]>();

  for (const observation of ordered) {
    if (steps.some((step) => step.callId === observation.callId)) {
      // Repeated delivery of one execution is not a second step.
      continue;
    }
    const stepId = `step${steps.length}`;
    const privateForCall = new Map<string, string>();
    for (const masked of observation.maskedValues ?? []) {
      const reference = `private:${observation.callId}:${privateForCall.size}`;
      privateForCall.set(JSON.stringify(masked), reference);
    }

    const sources: Array<{ name: string; source: WorkflowValueSource }> = [];
    for (const [name, value] of Object.entries(observation.arguments)) {
      const maskedReference = privateForCall.get(JSON.stringify(value));
      if (maskedReference) {
        privateValues.set(maskedReference, value);
        sources.push({ name, source: { kind: "private", reference: maskedReference } });
        continue;
      }
      const key = JSON.stringify(value);
      const producers = producersByValue.get(key) ?? [];
      // Exactly one earlier step produced this value: a binding, at the first place that step
      // returned it. Several steps did, or none did: a constant, because matching text is not
      // evidence of the same origin.
      const producingSteps = [...new Set(producers.map((producer) => producer.stepId))];
      if (producingSteps.length === 1) {
        const producer = producers[0]!;
        sources.push({
          name,
          source: { kind: "result", stepId: producer.stepId, path: producer.path },
        });
      } else {
        sources.push({ name, source: { kind: "literal", value } });
      }
    }

    if (observation.result !== undefined) {
      for (const leaf of leafEntries(observation.result)) {
        const key = JSON.stringify(leaf.value);
        const producers = producersByValue.get(key);
        const producer = { callId: observation.callId, stepId, path: leaf.path, value: leaf.value };
        if (producers) producers.push(producer);
        else producersByValue.set(key, [producer]);
      }
    }

    steps.push({
      id: stepId,
      callId: observation.callId,
      callable: {
        runtime: observation.callable.runtime,
        name: observation.callable.name,
        ...(observation.callable.connection ? { connection: observation.callable.connection } : {}),
      },
      arguments: sources,
      dependsOn: [
        ...new Set(
          sources
            .map((entry) => (entry.source.kind === "result" ? entry.source.stepId : undefined))
            .filter((value): value is string => value !== undefined),
        ),
      ],
      failure: observation.failed === true ? "continue" : "abort",
      ...(observation.permissions === undefined ? {} : { permissions: observation.permissions }),
    });
  }

  if (steps.length === 0) return undefined;
  const workflow: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId,
    inputs: [],
    steps,
    ...(privateValues.size > 0 ? { privateReferences: [...privateValues.keys()] } : {}),
  };
  return { workflow, privateValues, skipped };
}
