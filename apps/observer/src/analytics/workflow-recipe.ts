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
  AgentArgumentOrigin,
  RecordedWorkflow,
  WorkflowJsonValue,
  WorkflowStep,
  WorkflowValuePath,
  WorkflowValueTemplate,
} from "@resin/contracts";
import { containsRedactionPlaceholder } from "./private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-call-recorder.js";

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
        // The recorded literal is rebuilt from the origin's own value so privacy applies
        // inside it too: a composite literal becomes an object/array template whose
        // leaves are literals, except the private ones. The origin's value is the record;
        // the observed argument may be a projected shape that no longer carries it.
        return literalTemplate(origin.value);
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
 * Proposes parameterization from what varied between demonstrations.
 *
 * A proposal is not the workflow: nothing executable changes here. The proposal names the arguments
 * that took different values across recorded executions, with the values seen and the type they had,
 * so a caller (or an operator) can accept it deliberately. An established binding is never proposed
 * for replacement, and nothing the record marked private is ever proposed.
 */
export interface InputProposal {
  name: string;
  from: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  seenValues: WorkflowJsonValue[];
}

export interface InputProposalSet {
  /** The recorded workflow, unchanged: accepting the proposals is a separate, deliberate step. */
  workflow: RecordedWorkflow;
  proposals: InputProposal[];
}

export function proposeInputsFromVariation(
  recipes: readonly RecordedRecipe[],
): InputProposalSet | undefined {
  if (recipes.length === 0) return undefined;
  const base = recipes[0]!;
  const proposals: InputProposal[] = [];
  if (recipes.length < 2) return { workflow: base.workflow, proposals };

  const templateAt = (
    recipe: RecordedRecipe,
    stepIndex: number,
    argumentName: string,
  ): WorkflowValueTemplate | undefined => {
    const argument = recipe.workflow.steps[stepIndex]?.arguments.find(
      (entry) => entry.name === argumentName,
    );
    return argument?.source.kind === "template" ? argument.source.template : undefined;
  };

  for (let stepIndex = 0; stepIndex < base.workflow.steps.length; stepIndex += 1) {
    const step = base.workflow.steps[stepIndex]!;
    for (const argument of step.arguments) {
      const first = templateAt(base, stepIndex, argument.name);
      // Only a constant can be proposed as an input; a recorded binding stays a binding.
      if (!first || first.type !== "literal") continue;
      const values = recipes.map((recipe) => {
        const candidate = templateAt(recipe, stepIndex, argument.name);
        return candidate?.type === "literal" ? candidate.value : undefined;
      });
      if (values.some((entry) => entry === undefined)) continue;
      if (new Set(values.map((entry) => JSON.stringify(entry))).size < 2) continue;
      const seen = values as WorkflowJsonValue[];
      const type: InputProposal["type"] = seen.every((entry) => typeof entry === "number")
        ? "number"
        : seen.every((entry) => typeof entry === "boolean")
          ? "boolean"
          : seen.every((entry) => Array.isArray(entry))
            ? "array"
            : seen.every(
                  (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
                )
              ? "object"
              : "string";
      proposals.push({
        name: `${step.id}_${argument.name}`,
        from: `${step.id}.${argument.name}`,
        type,
        seenValues: seen,
      });
    }
  }
  return { workflow: base.workflow, proposals };
}

/**
 * Applies accepted proposals. Only this step changes the executable workflow, and it is the caller's
 * decision: a proposal that was not accepted leaves the workflow exactly as recorded.
 */
export function acceptInputProposals(
  workflow: RecordedWorkflow,
  proposals: readonly InputProposal[],
): RecordedWorkflow {
  const accepted: RecordedWorkflow = JSON.parse(JSON.stringify(workflow)) as RecordedWorkflow;
  const inputs = new Map(accepted.inputs.map((input) => [input.name, input]));
  for (const proposal of proposals) {
    const [stepId, argumentName] = proposal.from.split(".");
    const step = accepted.steps.find((entry) => entry.id === stepId);
    const argument = step?.arguments.find((entry) => entry.name === argumentName);
    if (!argument || argument.source.kind !== "template") continue;
    inputs.set(proposal.name, { name: proposal.name, type: proposal.type });
    argument.source = { kind: "template", template: { type: "input", name: proposal.name } };
  }
  accepted.inputs = [...inputs.values()];
  return accepted;
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
 * A connection the capture actually observed: the call consumed a reference the scope assigned to an
 * earlier result, at an optional nested field. Present only when the calling program used the
 * reference-aware interface; a plain-JSON recording has none.
 */
export interface RecordedReferenceUse {
  reference: string;
  path?: Array<string | number>;
}

/**
 * Binds a carrier origin's references to the steps this recording observed. The
 * reference token carries its own scope; the producing call's recorded handle maps the
 * invocation surface's call id onto this recording's call id. A reference that names
 * nothing stays unresolved rather than being guessed from a matching value.
 */
function bindCarrierOrigin(
  origin: AgentArgumentOrigin,
  aliasByScopeCall: Map<string, string>,
  stepIdByCallId: Map<string, string>,
  eventSessionId: string,
): WorkflowValueTemplate {
  switch (origin.type) {
    case "reference": {
      const parts = origin.reference.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        const scope = parts[1]!;
        const refCallId = parts.slice(2).join(":");
        const producingKey =
          aliasByScopeCall.get(`${scope}${refCallId}`) ?? `${eventSessionId}${refCallId}`;
        const stepId = stepIdByCallId.get(producingKey);
        if (stepId !== undefined) {
          return { type: "result", stepId, path: origin.path };
        }
      }
      return {
        type: "unresolved",
        reason: `reference '${origin.reference}' does not name a recorded call in this session`,
      };
    }
    case "object": {
      const entries: Record<string, WorkflowValueTemplate> = {};
      for (const [key, entry] of Object.entries(origin.entries)) {
        entries[key] = bindCarrierOrigin(entry, aliasByScopeCall, stepIdByCallId, eventSessionId);
      }
      return { type: "object", entries };
    }
    case "array":
      return {
        type: "array",
        items: origin.items.map((item) =>
          bindCarrierOrigin(item, aliasByScopeCall, stepIdByCallId, eventSessionId),
        ),
      };
    default:
      // literal / input / private carry through verbatim.
      return origin;
  }
}

/**
 * The display value a carrier origin stands for: literals keep their recorded value;
 * inputs, references and private leaves have no uploadable value, so they read as null.
 * The executable template comes from the origin itself, never from this value.
 */
function carrierArgumentValue(origin: AgentArgumentOrigin): WorkflowJsonValue {
  switch (origin.type) {
    case "literal":
      return origin.value;
    case "object": {
      const out: Record<string, WorkflowJsonValue> = {};
      for (const [key, entry] of Object.entries(origin.entries)) {
        out[key] = carrierArgumentValue(entry);
      }
      return out;
    }
    case "array":
      return origin.items.map(carrierArgumentValue);
    default:
      return null;
  }
}

export function recordCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: {
    /**
     * Runtime and connection as discovery/dispatch recorded them. A callable the record only names
     * keeps an unknown runtime: the runtime is not guessed from the tool's name.
     */
    discoveryFor?: (toolName: string) => { runtime?: string; connection?: string } | undefined;
    /**
     * The reference scope the calling program used for this session. A reference from another scope
     * never binds, so the scope must be stated rather than assumed from the workflow's name.
     */
    referenceScopeId?: string;
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
  /**
   * The handle a composed call returned for its result, keyed by scope: it maps the
   * invocation surface's call id onto this recording's call id, so a later reference
   * token binds to the call that produced the value it names.
   */
  const resultAliasByCallId = new Map<string, string>();
  const scopedKey = (sessionId: string, callId: string): string => `${sessionId}${callId}`;
  for (const event of ordered) {
    if (event.type !== "tool_result") continue;
    const callId = event.callId ?? event.toolCallId;
    if (!callId) continue;
    resultsByCallId.set(scopedKey(event.sessionId, callId), {
      value: event.result ?? extractResultValue(event.content),
      isError: event.isError,
    });
    const carrier = readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY]);
    const handle = carrier?.handle;
    if (handle !== undefined) {
      const parts = handle.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        const scope = parts[1]!;
        const gatewayCallId = parts.slice(2).join(":");
        resultAliasByCallId.set(`${scope}${gatewayCallId}`, scopedKey(event.sessionId, callId));
      }
    }
  }

  const stepIdByCallId = new Map<string, string>();
  /** Inputs the calling program supplied, with the types it used. */
  const recordedInputTypes = new Map<string, string>();
  /**
   * A reference is only usable when it names this recording's scope. Call ids are not unique across
   * scopes, so a reference from another recording must never bind to a local call sharing its id.
   */
  const localCallIdOf = (reference: string, scopeId: string): string | undefined => {
    const parts = reference.split(":");
    if (parts.length < 3 || parts[0] !== "ref") return undefined;
    if (parts[1] !== scopeId) return undefined;
    return parts.slice(2).join(":");
  };
  const scopeId = options.referenceScopeId ?? workflowId;

  const observations: RecordedCallObservation[] = [];
  const seenCallIds = new Set<string>();
  for (const event of ordered) {
    if (event.type !== "tool_call") continue;
    const callId = event.callId ?? event.toolCallId ?? event.eventId;
    const scopedCallKey = scopedKey(event.sessionId, callId);
    // A redelivered call is the same execution, not a second step.
    if (seenCallIds.has(scopedCallKey)) continue;
    seenCallIds.add(scopedCallKey);

    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const recordedReferences =
      (event.metadata?.references as Record<string, RecordedReferenceUse> | undefined) ?? {};
    const recordedInputs =
      (event.metadata?.inputs as
        | Array<{ name: string; argument: string; type: string }>
        | undefined) ?? [];
    const argumentOrigins: Record<string, RecordedArgumentOrigin> = {};
    const argumentTypes: Record<string, "string" | "number" | "boolean" | "object" | "array"> = {};
    const callArguments: Record<string, WorkflowJsonValue> = {};

    if (carrier !== undefined) {
      // The carrier is the caller's own statement of every argument's origin. A
      // reference binds through the producing call's recorded handle; one that names
      // nothing this session recorded stays unbound rather than being guessed.
      for (const input of carrier.inputs) {
        recordedInputTypes.set(input.name, input.type);
        argumentTypes[input.argument] = input.type as (typeof argumentTypes)[string];
      }
      for (const [argumentName, origin] of Object.entries(carrier.origins)) {
        argumentOrigins[argumentName] = bindCarrierOrigin(
          origin,
          resultAliasByCallId,
          stepIdByCallId,
          event.sessionId,
        );
        callArguments[argumentName] = carrierArgumentValue(origin);
      }
    }

    for (const input of recordedInputs) {
      argumentOrigins[input.argument] = { type: "input", name: input.name };
      recordedInputTypes.set(input.name, input.type);
    }
    for (const [argumentName, use] of Object.entries(recordedReferences)) {
      const producingCallId = localCallIdOf(use.reference, scopeId);
      const producingStepId = producingCallId
        ? stepIdByCallId.get(scopedKey(event.sessionId, producingCallId))
        : undefined;
      // rather than being guessed from the value that happens to be there.
      if (producingStepId) {
        argumentOrigins[argumentName] = {
          type: "result",
          stepId: producingStepId,
          path: (use.path ?? []) as WorkflowValuePath,
        };
      }
    }
    const toolName = carrier?.name ?? event.toolName ?? "unknown";
    const recordedResult = resultsByCallId.get(scopedCallKey);
    const discovery = options.discoveryFor?.(toolName);
    const privateValues = (event.metadata?.maskedValues as string[] | undefined) ?? [];
    const isPrivateValue =
      privateValues.length > 0
        ? (value: string) => privateValues.includes(value)
        : carrier !== undefined
          ? containsRedactionPlaceholder
          : undefined;
    observations.push({
      callId,
      ...(event.causalRef?.causalSequence === undefined
        ? {}
        : { causalSequence: event.causalRef.causalSequence }),
      callable: {
        runtime:
          carrier?.runtime ??
          discovery?.runtime ??
          (event.metadata?.runtime as string | undefined) ??
          "unknown",
        name: toolName,
        ...((carrier?.connection ??
        discovery?.connection ??
        (event.metadata?.connection as string | undefined))
          ? {
              connection: (carrier?.connection ??
                discovery?.connection ??
                event.metadata?.connection) as string,
            }
          : {}),
      },
      arguments: carrier !== undefined ? callArguments : (event.parameters ?? {}),
      ...(Object.keys(argumentOrigins).length > 0 ? { argumentOrigins } : {}),
      ...(Object.keys(argumentTypes).length > 0 ? { argumentTypes } : {}),
      ...(recordedResult?.value === undefined ? {} : { result: recordedResult.value }),
      ...(isPrivateValue ? { isPrivateValue } : {}),
      observed:
        recordedResult === undefined
          ? "unknown"
          : recordedResult.isError === true
            ? "failed"
            : recordedResult.isError === false
              ? "succeeded"
              : "unknown",
    });
    // The observation was just pushed, so this call's step is the last one.
    stepIdByCallId.set(scopedCallKey, `step${observations.length - 1}`);
  }
  if (observations.length === 0) return undefined;
  const recipe = recordWorkflowRecipe(workflowId, observations);
  if (!recipe) return undefined;
  const declared = new Map(recipe.workflow.inputs.map((input) => [input.name, input]));
  for (const [name, type] of recordedInputTypes) {
    declared.set(name, { name, type: type as RecordedWorkflow["inputs"][number]["type"] });
  }
  recipe.workflow.inputs = [...declared.values()];
  return recipe;
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
