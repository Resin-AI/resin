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
  /**
   * Inputs proposed by comparing demonstrations, with the argument each came from. They are a
   * proposal: an established binding is never replaced by a caller input, and an input that a caller
   * declines to supply leaves the workflow refusing rather than inventing a value.
   */
  proposedInputs?: Array<{ name: string; from: string }>;
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
  // A value may be classified private only after a later call is processed, so the union of every
  // predicate seen is applied to the finished workflow as well.
  const privatePredicates: Array<(value: string) => boolean> = [];
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
    /**
     * A recorded literal is rebuilt so privacy applies inside it too: a composite literal becomes an
     * object/array template whose leaves are literals, except the private ones.
     */
    const literalTemplate = (value: WorkflowJsonValue): WorkflowValueTemplate => {
      const privateLeaf = privateHere(value);
      if (privateLeaf) return privateLeaf;
      if (Array.isArray(value)) return { type: "array", items: value.map(literalTemplate) };
      if (isPlainObjectValue(value)) {
        const entries: Record<string, WorkflowValueTemplate> = {};
        for (const [key, entry] of Object.entries(value)) entries[key] = literalTemplate(entry);
        return { type: "object", entries };
      }
      return { type: "literal", value };
    };
    switch (origin?.type) {
      case "literal":
        // Only a literal may be replaced by a private reference. A recorded binding stays a binding:
        // the value it names is fetched fresh and resolved locally at execution time, so privacy
        // does not cost the workflow its connection.
        return literalTemplate(value);
      case "input":
      case "result":
      case "private":
      case "unresolved":
        return origin;
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
    if (observation.isPrivateValue) privatePredicates.push(observation.isPrivateValue);
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

  // Final privacy sweep: any literal leaf the record classifies as private becomes a private
  // reference, wherever it ended up in the workflow.
  const sweep = (template: WorkflowValueTemplate): WorkflowValueTemplate => {
    switch (template.type) {
      case "literal": {
        const expand = (value: WorkflowJsonValue): WorkflowValueTemplate => {
          if (
            typeof value === "string" &&
            privatePredicates.some((predicate) => predicate(value))
          ) {
            return makePrivate(value);
          }
          if (Array.isArray(value)) return { type: "array", items: value.map(expand) };
          if (isPlainObjectValue(value)) {
            const entries: Record<string, WorkflowValueTemplate> = {};
            for (const [key, entry] of Object.entries(value)) entries[key] = expand(entry);
            return { type: "object", entries };
          }
          return { type: "literal", value };
        };
        return expand(template.value);
      }
      case "object": {
        const entries: Record<string, WorkflowValueTemplate> = {};
        for (const [key, entry] of Object.entries(template.entries)) entries[key] = sweep(entry);
        return { type: "object", entries };
      }
      case "array":
        return { type: "array", items: template.items.map(sweep) };
      default:
        return template;
    }
  };
  for (const step of steps) {
    step.arguments = step.arguments.map((argument) =>
      argument.source.kind === "template"
        ? {
            ...argument,
            source: { kind: "template" as const, template: sweep(argument.source.template) },
          }
        : argument,
    );
  }

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

/**
 * Turns values that varied between demonstrations of the same workflow into caller inputs.
 *
 * This is evidence, not inference: a literal that took different values across recorded executions
 * of the same call cannot be a constant of the workflow, and the type of the input is the type those
 * values actually had. Values that were identical in every demonstration stay constants, and a value
 * the record marked private is never promoted to an input.
 */
export function promoteVariationToInputs(
  recipes: readonly RecordedRecipe[],
): RecordedRecipe | undefined {
  if (recipes.length < 2) return recipes[0];
  const proposedInputs: Array<{ name: string; from: string }> = [];
  const base = recipes[0]!;
  const workflow: RecordedWorkflow = JSON.parse(JSON.stringify(base.workflow)) as RecordedWorkflow;
  const inputs = new Map<string, { name: string; type: string }>(
    workflow.inputs.map((input) => [input.name, { name: input.name, type: input.type }]),
  );

  const literalAt = (
    recipe: RecordedRecipe,
    stepIndex: number,
    argumentName: string,
  ): WorkflowValueTemplate | undefined => {
    const step = recipe.workflow.steps[stepIndex];
    const argument = step?.arguments.find((entry) => entry.name === argumentName);
    if (!argument || argument.source.kind !== "template") return undefined;
    return argument.source.template;
  };

  for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex += 1) {
    const step = workflow.steps[stepIndex]!;
    const template = literalAt(base, stepIndex, step.arguments[0]?.name ?? "") && undefined;
    void template;
    for (const argument of step.arguments) {
      const first = literalAt(base, stepIndex, argument.name);
      if (!first || first.type !== "literal") continue;
      const values = recipes.map((recipe) => {
        const candidate = literalAt(recipe, stepIndex, argument.name);
        return candidate?.type === "literal" ? candidate.value : undefined;
      });
      if (values.some((value) => value === undefined)) continue;
      const distinct = new Set(values.map((value) => JSON.stringify(value)));
      if (distinct.size < 2) continue;
      const type = (() => {
        if (values.every((value) => typeof value === "number")) return "number";
        if (values.every((value) => typeof value === "boolean")) return "boolean";
        if (values.every((value) => Array.isArray(value))) return "array";
        if (
          values.every(
            (value) => typeof value === "object" && value !== null && !Array.isArray(value),
          )
        )
          return "object";
        return "string";
      })();
      const name = `${step.id}_${argument.name}`;
      inputs.set(name, { name, type });
      proposedInputs.push({ name, from: `${step.id}.${argument.name}` });
      argument.source = {
        kind: "template",
        template: { type: "input", name },
      };
    }
  }

  const promoted: RecordedWorkflow = {
    ...workflow,
    inputs: [...inputs.values()].map((input) => ({
      name: input.name,
      type: input.type as RecordedWorkflow["inputs"][number]["type"],
    })),
  };
  return {
    workflow: promoted,
    privateValues: base.privateValues,
    skipped: base.skipped,
    proposedInputs,
  };
}

/** A normalized event, as much of it as recording calls needs. */
export interface RecordableEvent {
  type: string;
  eventId: string;
  sessionId: string;
  timestamp?: string;
  causalRef?: { causalSequence?: number };
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

/**
 * Pairs recorded calls with their results and records the workflow of a session.
 *
 * This is the capture entry point both the live tailer and the historical importer use: the calls
 * come from the record itself, arguments are their recorded values, and a result is attached only
 * when the record ties it to that call's identity. Nothing is inferred from equal values.
 */
export function recordCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: {
    /**
     * Runtime and connection as discovery/dispatch recorded them. A callable the record only names
     * keeps an unknown runtime: the runtime is not guessed from the tool's name.
     */
    discoveryFor?: (toolName: string) => { runtime?: string; connection?: string } | undefined;
  } = {},
): RecordedRecipe | undefined {
  const ordered = [...events].sort(
    (left, right) =>
      (left.causalRef?.causalSequence ?? Number.MAX_SAFE_INTEGER) -
      (right.causalRef?.causalSequence ?? Number.MAX_SAFE_INTEGER),
  );
  const resultsByCallId = new Map<
    string,
    { value: WorkflowJsonValue | undefined; isError: boolean | undefined }
  >();
  for (const event of ordered) {
    if (event.type !== "tool_result") continue;
    const callId = event.callId ?? event.toolCallId;
    if (!callId) continue;
    resultsByCallId.set(callId, {
      value: event.result ?? extractResultValue(event.content),
      isError: event.isError,
    });
  }

  const observations: RecordedCallObservation[] = [];
  for (const event of ordered) {
    if (event.type !== "tool_call") continue;
    const callId = event.callId ?? event.toolCallId ?? event.eventId;
    const toolName = event.toolName ?? "unknown";
    const recordedResult = resultsByCallId.get(callId);
    const discovery = options.discoveryFor?.(toolName);
    const privateValues = (event.metadata?.maskedValues as string[] | undefined) ?? [];
    observations.push({
      callId,
      ...(event.causalRef?.causalSequence === undefined
        ? {}
        : { causalSequence: event.causalRef.causalSequence }),
      callable: {
        runtime: discovery?.runtime ?? (event.metadata?.runtime as string | undefined) ?? "unknown",
        name: toolName,
        ...((discovery?.connection ?? (event.metadata?.connection as string | undefined))
          ? { connection: (discovery?.connection ?? event.metadata?.connection) as string }
          : {}),
      },
      arguments: event.parameters ?? {},
      ...(recordedResult?.value === undefined ? {} : { result: recordedResult.value }),
      ...(privateValues.length > 0
        ? { isPrivateValue: (value) => privateValues.includes(value) }
        : {}),
      observed:
        recordedResult === undefined
          ? "unknown"
          : recordedResult.isError === true
            ? "failed"
            : recordedResult.isError === false
              ? "succeeded"
              : "unknown",
    });
  }
  if (observations.length === 0) return undefined;
  return recordWorkflowRecipe(workflowId, observations);
}

function extractResultValue(content: unknown): WorkflowJsonValue | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
    return content;
  }
  if (Array.isArray(content)) return content as WorkflowJsonValue;
  if (typeof content === "object" && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
    return content as WorkflowJsonValue;
  }
  return undefined;
}
