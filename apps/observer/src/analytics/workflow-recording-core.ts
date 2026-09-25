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
  WorkflowBindingCandidate,
  WorkflowJsonValue,
  WorkflowObservedOutput,
  WorkflowValuePath,
  WorkflowValueTemplate,
} from "@resin/contracts";
import {
  RESIN_TOOL_LINK_EVIDENCE_KEY,
  collectWorkflowPrivateReferences,
  readToolLinkEvidence,
} from "@resin/contracts";
import type { deriveNativeCalls } from "./native-argument-derivation.js";
import { containsRedactionPlaceholder } from "./private-value-store.js";
import { compareRecordedEvents } from "./recorded-event-order.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  type WorkflowCallCandidate,
  type WorkflowCallCarrier,
  type WorkflowCallHeldOut,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-carrier.js";

import {
  type ObservedResourceFlow,
  type RecordedArgumentOrigin,
  type RecordedCallObservation,
  type RecordedRecipe,
  recordWorkflowRecipe,
} from "./workflow-recipe-builder.js";

export interface WorkflowRecordingCoreOptions {
  discoveryFor?: (toolName: string) => { runtime?: string; connection?: string } | undefined;
  referenceScopeId?: string;
  supportingEvents?: readonly RecordableEvent[];
  /** Full/native capture supplies this callback; carried capture deliberately does not. */
  deriveNativeCalls?: typeof deriveNativeCalls;
  /** Require frozen carriers and confine reconstruction to their selected session. */
  carrierRequired?: boolean;
}

export type { RecordableEvent } from "./workflow-carrier.js";
import type { RecordableEvent } from "./workflow-carrier.js";
export interface RecordedReferenceUse {
  reference: string;
  path?: Array<string | number>;
}

const callIdOf = (event: RecordableEvent): string =>
  event.callId ?? event.toolCallId ?? event.eventId;

function scopedKey(scopeId: string, callId: string): string {
  return `${scopeId.length}:${scopeId}${callId}`;
}

const inputTypeOf = (
  value: string,
): "string" | "number" | "boolean" | "object" | "array" | undefined =>
  value === "string" ||
  value === "number" ||
  value === "boolean" ||
  value === "object" ||
  value === "array"
    ? value
    : undefined;

/**
 * Binds a carrier origin's references to the steps this recording observed. The
 * reference token carries its own scope; the producing call's recorded handle maps
 * the invocation surface's call id onto this recording's call id. A reference that
 * names nothing stays unresolved rather than being guessed from a matching value.
 */
function bindCarrierOrigin(
  origin: WorkflowCallCarrier["origins"][string],
  aliasByScopeCall: Map<string, string>,
  stepIdByCallId: Map<string, string>,
  eventSessionId: string,
  referenceScopeId: string | undefined,
): WorkflowValueTemplate {
  switch (origin.type) {
    case "reference": {
      const parts = origin.reference.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        const scope = parts[1]!;
        const refCallId = parts.slice(2).join(":");
        const producingKey =
          aliasByScopeCall.get(scopedKey(scope, refCallId)) ??
          (scope === referenceScopeId ? scopedKey(eventSessionId, refCallId) : undefined);
        const stepId = producingKey === undefined ? undefined : stepIdByCallId.get(producingKey);
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
        entries[key] = bindCarrierOrigin(
          entry,
          aliasByScopeCall,
          stepIdByCallId,
          eventSessionId,
          referenceScopeId,
        );
      }
      return { type: "object", entries };
    }
    case "array":
      return {
        type: "array",
        items: origin.items.map((item) =>
          bindCarrierOrigin(
            item,
            aliasByScopeCall,
            stepIdByCallId,
            eventSessionId,
            referenceScopeId,
          ),
        ),
      };
    default:
      // Literal/input/private leaves and native program projections carry through verbatim.
      return origin;
  }
}

/**
 * The display value a carrier origin stands for: literals keep their recorded value;
 * inputs, references and private leaves have no uploadable value, so they read as null.
 * The executable template comes from the origin itself, never from this value.
 */
function carrierArgumentValue(origin: WorkflowCallCarrier["origins"][string]): WorkflowJsonValue {
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

/**
 * One call of an execution other than the recording's own, kept only as far as re-targeting what it
 * suggested at a step of this recording needs: the callable it reached and what it proposed.
 */
interface RepeatCall {
  /** The id this call was recorded under, which a result proposal from that execution names. */
  callId: string;
  runtime: string;
  name: string;
  connection?: string;
  candidates: readonly WorkflowCallCandidate[];
}

export function reconstructWorkflowFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: WorkflowRecordingCoreOptions = {},
): RecordedRecipe | undefined {
  const allOrdered = [...events].sort(compareRecordedEvents);
  const firstExecutionCall = allOrdered.find(
    (event) =>
      event.type === "tool_call" &&
      readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])
        ?.executionIndex !== undefined,
  );
  const firstCall = allOrdered.find((event) => event.type === "tool_call");
  const recordingSession = firstExecutionCall?.sessionId ?? firstCall?.sessionId;
  const ordered =
    options.carrierRequired && recordingSession !== undefined
      ? allOrdered.filter((event) => event.sessionId === recordingSession)
      : allOrdered;
  const supporting = (options.supportingEvents ?? []).filter(
    (event) => !options.carrierRequired || event.sessionId === recordingSession,
  );
  const allEvents = [...ordered, ...supporting].sort(compareRecordedEvents);

  const resultsByCallId = new Map<
    string,
    {
      value: WorkflowJsonValue | undefined;
      isError: boolean | undefined;
      baselineReference?: string;
      output?: WorkflowObservedOutput;
      baselineComparison?: "text-trim";
    }
  >();
  /**
   * The handle a composed call returned for its result, keyed by scope: it maps the
   * invocation surface's call id onto this recording's call id, so a later reference
   * token binds to the call that produced the value it names.
   */
  const resultAliasByCallId = new Map<string, string>();
  for (const event of ordered) {
    if (event.type !== "tool_result") continue;
    const callId = event.callId ?? event.toolCallId;
    if (!callId) continue;
    const eventKey = scopedKey(event.sessionId, callId);
    const resultCarrier = readWorkflowResultCarrier(
      event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
    );
    resultsByCallId.set(eventKey, {
      value: event.result ?? extractResultValue(event.content),
      isError: event.isError,
      ...(resultCarrier?.output === undefined ? {} : { output: resultCarrier.output }),
      ...(resultCarrier?.baselineReference === undefined
        ? {}
        : { baselineReference: resultCarrier.baselineReference }),
      ...(resultCarrier?.baselineComparison === undefined
        ? {}
        : { baselineComparison: resultCarrier.baselineComparison }),
    });
    const handle = resultCarrier?.handle;
    if (handle === undefined) continue;
    const parts = handle.split(":");
    if (parts.length < 3 || parts[0] !== "ref") continue;
    const scope = parts[1]!;
    const gatewayCallId = parts.slice(2).join(":");
    const aliasKey = scopedKey(scope, gatewayCallId);
    // Keep the first recorded producer when a selected result handle is redelivered.
    if (!resultAliasByCallId.has(aliasKey)) resultAliasByCallId.set(aliasKey, eventKey);
  }

  const stepIdByCallId = new Map<string, string>();
  /** Inputs the calling program supplied, with the types it used. */
  const recordedInputTypes = new Map<string, string>();
  /**
   * A reference is only usable when it names this recording's scope. Call ids are not unique across
   * scopes, so a reference from another recording must never bind to a local call sharing its id.
   */
  const localCallIdOf = (reference: unknown, scopeId: string | undefined): string | undefined => {
    if (scopeId === undefined || typeof reference !== "string") return undefined;
    const parts = reference.split(":");
    if (parts.length < 3 || parts[0] !== "ref") return undefined;
    if (parts[1] !== scopeId) return undefined;
    return parts.slice(2).join(":");
  };
  const referenceScopeId = options.referenceScopeId;

  // One piece of work is one execution. When the capture recorded which execution each call belongs
  // to, the recording is built from the one a later, matching execution demonstrates: the calls of
  // the other executions are the same work performed again, and running them as extra steps of one
  // tool would make the tool do the job twice.
  const selectedExecutionIndex = selectedExecution(ordered);
  const observations: RecordedCallObservation[] = [];
  const stepIdByPosition = new Map<number, string>();
  const seenCallIds = new Set<string>();
  /** Suggestions the capture made, related to the steps of this recording. */
  const carrierCandidates: WorkflowBindingCandidate[] = [];
  /**
   * The other executions of this session, kept only as far as one of their calls can be about a
   * step of this recording: the callable each call reached, in order, and what that call proposed.
   */
  const repeats = new Map<number, RepeatCall[]>();
  const skipped: Array<{ callId: string; reason: string }> = [];
  /**
   * The callable an event reached, exactly as a step of this recording would state it: the name the
   * carrier gives, the connection it was reached through, and the runtime discovery recorded. One
   * resolution for the recording's own calls and for a repeat's, so the two are comparable.
   */
  const callableOf = (
    event: RecordableEvent,
    carrier: WorkflowCallCarrier | undefined,
  ): { runtime: string; name: string; connection?: string } => {
    const name = carrier?.name ?? event.toolName ?? "unknown";
    const discovery = options.discoveryFor?.(name);
    const connection =
      carrier?.connection ??
      discovery?.connection ??
      (event.metadata?.connection as string | undefined);
    return {
      runtime:
        carrier?.runtime ??
        discovery?.runtime ??
        (event.metadata?.runtime as string | undefined) ??
        "unknown",
      name,
      ...(connection === undefined ? {} : { connection }),
    };
  };
  /**
   * Records one call of an execution other than the recording's own.
   *
   * A repeat is not part of this recording, and its calls never become steps of it, but a candidate
   * the capture minted on one of its calls can still be about a step of it: the same argument of the
   * same callable, reached at the same ordinal. Which candidates those are is decided where the
   * recording's own callables are known, so the call is kept whole here.
   */
  const noteRepeatCall = (
    event: RecordableEvent,
    carrier: WorkflowCallCarrier | undefined,
    executionIndex: number,
  ): void => {
    if (options.carrierRequired && carrier === undefined) return;
    let calls = repeats.get(executionIndex);
    if (calls === undefined) {
      calls = [];
      repeats.set(executionIndex, calls);
    }
    const callable = callableOf(event, carrier);
    calls.push({
      callId: callIdOf(event),
      runtime: callable.runtime,
      name: callable.name,
      ...(callable.connection === undefined ? {} : { connection: callable.connection }),
      candidates: carrier?.candidates ?? [],
    });
  };
  /**
   * Claims a call for reading, once: the key it is read under, or undefined when the event is not a
   * call or its call was already read. A call is classified by the execution its carrier names,
   * never by the set of events it arrived in, and a redelivered call is the same execution rather
   * than a second step of it.
   */
  const claimCall = (event: RecordableEvent): string | undefined => {
    if (event.type !== "tool_call") return undefined;
    const scopedCallKey = scopedKey(event.sessionId, callIdOf(event));
    if (seenCallIds.has(scopedCallKey)) return undefined;
    seenCallIds.add(scopedCallKey);
    return scopedCallKey;
  };
  for (const event of ordered) {
    if (event.type !== "tool_call") continue;
    const callId = callIdOf(event);
    const scopedCallKey = claimCall(event);
    if (scopedCallKey === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (options.carrierRequired && carrier === undefined) {
      skipped.push({ callId, reason: "missing or malformed workflowCall carrier" });
      continue;
    }
    const executionIndex = carrier?.executionIndex;
    if (executionIndex !== undefined && executionIndex !== selectedExecutionIndex) {
      noteRepeatCall(event, carrier, executionIndex);
      continue;
    }
    const declaredFlow = declaredResourceFlowOf(event);
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
        const type = inputTypeOf(input.type);
        if (
          type === undefined ||
          typeof input.name !== "string" ||
          typeof input.argument !== "string"
        )
          continue;
        recordedInputTypes.set(input.name, type);
        argumentTypes[input.argument] = type;
      }
      for (const [argumentName, origin] of Object.entries(carrier.origins)) {
        argumentOrigins[argumentName] = bindCarrierOrigin(
          origin,
          resultAliasByCallId,
          stepIdByCallId,
          event.sessionId,
          referenceScopeId,
        );
        callArguments[argumentName] = carrierArgumentValue(origin);
      }
    } else {
      // Legacy metadata remains a fallback only for calls without a frozen carrier. It
      // must never overwrite an origin the carrier already froze.
      for (const input of recordedInputs) {
        const type = inputTypeOf(input.type);
        if (type === undefined) continue;
        argumentOrigins[input.argument] = { type: "input", name: input.name };
        recordedInputTypes.set(input.name, type);
      }
      for (const [argumentName, use] of Object.entries(recordedReferences)) {
        const producingCallId = localCallIdOf(use.reference, referenceScopeId);
        const producingStepId = producingCallId
          ? stepIdByCallId.get(scopedKey(event.sessionId, producingCallId))
          : undefined;
        if (producingStepId !== undefined) {
          argumentOrigins[argumentName] = {
            type: "result",
            stepId: producingStepId,
            path: (use.path ?? []) as WorkflowValuePath,
          };
        }
      }
    }
    const recordedResult = resultsByCallId.get(scopedCallKey);
    const callable = callableOf(event, carrier);
    const maskedValues = options.carrierRequired ? undefined : event.metadata?.maskedValues;
    const privateValues = Array.isArray(maskedValues)
      ? maskedValues.filter((value): value is string => typeof value === "string")
      : [];
    const isPrivateValue =
      privateValues.length > 0
        ? (value: string) => privateValues.includes(value)
        : carrier !== undefined
          ? containsRedactionPlaceholder
          : undefined;
    const observation: RecordedCallObservation = {
      callId,
      ...(event.causalRef?.causalSequence === undefined
        ? {}
        : { causalSequence: event.causalRef.causalSequence }),
      callable: {
        runtime: callable.runtime,
        name: callable.name,
        ...(callable.connection === undefined ? {} : { connection: callable.connection }),
        ...(carrier?.inputSchema === undefined ? {} : { inputSchema: carrier.inputSchema }),
        ...(carrier?.program === undefined ? {} : { program: carrier.program }),
      },
      arguments: carrier !== undefined ? callArguments : (event.parameters ?? {}),
      ...(Object.keys(argumentOrigins).length > 0 ? { argumentOrigins } : {}),
      ...(Object.keys(argumentTypes).length > 0 ? { argumentTypes } : {}),
      ...(carrier?.provenance === undefined ? {} : { argumentProvenance: carrier.provenance }),
      ...(carrier?.dependsOnCallIds === undefined
        ? {}
        : {
            establishedDependsOn: carrier.dependsOnCallIds
              .map((dependency) => stepIdByCallId.get(scopedKey(event.sessionId, dependency)))
              .filter((dependency): dependency is string => dependency !== undefined),
          }),
      ...(recordedResult?.baselineReference === undefined
        ? {}
        : { baselineReference: recordedResult.baselineReference }),
      ...(recordedResult?.baselineComparison === undefined
        ? {}
        : { baselineComparison: recordedResult.baselineComparison }),
      ...(declaredFlow === undefined ? {} : { flow: declaredFlow }),
      ...(recordedResult?.value === undefined ? {} : { result: recordedResult.value }),
      ...(isPrivateValue ? { isPrivateValue } : {}),
      ...(recordedResult?.output === undefined ? {} : { output: recordedResult.output }),
      observed:
        recordedResult === undefined
          ? "unknown"
          : recordedResult.isError === true
            ? "failed"
            : recordedResult.isError === false
              ? "succeeded"
              : "unknown",
    };
    if (carrier?.dependsOnCallIds !== undefined) {
      for (const dependency of carrier.dependsOnCallIds) {
        if (!stepIdByCallId.has(scopedKey(event.sessionId, dependency))) {
          skipped.push({
            callId,
            reason: `recorded dependency '${dependency}' is not an earlier selected call`,
          });
        }
      }
    }
    observations.push(observation);
    // The observation was just pushed, so this call's step is the last one.
    const ownStepId = `step${observations.length - 1}`;
    stepIdByCallId.set(scopedCallKey, ownStepId);
    // Steps are numbered in the order the calls arrived, which is the order the demonstration used.
    if (executionIndex !== undefined) stepIdByPosition.set(observations.length - 1, ownStepId);
    if (carrier?.candidates !== undefined) {
      for (const candidate of carrier.candidates) {
        if (candidate.proposed.kind !== "result") {
          carrierCandidates.push({
            stepId: ownStepId,
            argument: candidate.argument,
            path: candidate.path,
            proposed: candidate.proposed,
            reason: candidate.reason,
            ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
            missing: candidate.missing,
          });
          continue;
        }
        // The suggestion names the call that produced the value; the recording numbers that call as
        // a step, so the two are related here and only here.
        const producingStepId = stepIdByCallId.get(
          scopedKey(event.sessionId, candidate.proposed.callId),
        );
        if (producingStepId === undefined) continue;
        carrierCandidates.push({
          stepId: ownStepId,
          argument: candidate.argument,
          path: candidate.path,
          proposed: { kind: "result", stepId: producingStepId, path: candidate.proposed.path },
          reason: candidate.reason,
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
          missing: candidate.missing,
        });
      }
    }
  }
  if (observations.length === 0) return undefined;

  // The recording's own calls are the evidence's, and the session read beside it is where its other
  // executions live. A repeat is the same work performed again wherever it was read, so the calls of
  // the executions the evidence did not name are read here for exactly what they minted — never as
  // steps: only the selected execution's calls are numbered.
  for (const event of supporting) {
    if (claimCall(event) === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    const executionIndex = carrier?.executionIndex;
    if (executionIndex === undefined || executionIndex === selectedExecutionIndex) continue;
    noteRepeatCall(event, carrier, executionIndex);
  }

  // A selected workflow can be a slice of a larger execution. Match repetitions against the
  // complete original execution, then map only the selected call ids to steps. Unselected calls
  // remain supporting evidence; their proposals and effects never become extra executable steps.
  const selectedSession = ordered.find((event) => event.type === "tool_call")?.sessionId;
  const baselineCalls = new Map<string, RepeatCall>();
  for (const event of [...ordered, ...supporting].sort(compareRecordedEvents)) {
    if (event.type !== "tool_call" || event.sessionId !== selectedSession) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (options.carrierRequired && carrier === undefined) continue;
    if (carrier?.executionIndex !== selectedExecutionIndex) continue;
    const id = callIdOf(event);
    if (!baselineCalls.has(id)) {
      baselineCalls.set(id, {
        callId: id,
        ...callableOf(event, carrier),
        candidates: carrier?.candidates ?? [],
      });
    }
  }
  const baseline = [...baselineCalls.values()];
  for (const calls of repeats.values()) {
    if (calls.length !== baseline.length) continue;
    if (
      calls.some((call, ordinal) => {
        const original = baseline[ordinal]!;
        return (
          call.name !== original.name ||
          call.runtime !== original.runtime ||
          call.connection !== original.connection
        );
      })
    )
      continue;
    const stepIdByRepeatCallId = new Map<string, string>();
    for (const [ordinal, call] of calls.entries()) {
      const original = baseline[ordinal]!;
      const stepId = stepIdByCallId.get(scopedKey(selectedSession!, original.callId));
      if (stepId !== undefined) stepIdByRepeatCallId.set(call.callId, stepId);
    }
    for (const call of calls) {
      const stepId = stepIdByRepeatCallId.get(call.callId);
      if (stepId === undefined) continue;
      for (const candidate of call.candidates) {
        const producingStepId =
          candidate.proposed.kind === "result"
            ? stepIdByRepeatCallId.get(candidate.proposed.callId)
            : undefined;
        if (candidate.proposed.kind === "result" && producingStepId === undefined) continue;
        if (
          carrierCandidates.some(
            (entry) =>
              entry.stepId === stepId &&
              entry.argument === candidate.argument &&
              entry.path.length === candidate.path.length &&
              entry.path.every((part, index) => part === candidate.path[index]),
          )
        )
          continue;
        carrierCandidates.push({
          stepId,
          argument: candidate.argument,
          path: candidate.path,
          proposed:
            candidate.proposed.kind === "result"
              ? { kind: "result", stepId: producingStepId!, path: candidate.proposed.path }
              : candidate.proposed,
          reason: candidate.reason,
          ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
          missing: candidate.missing,
        });
      }
    }
  }

  // What the calls themselves establish about their own arguments: the dependencies their declared
  // resource use proves, and the bindings their values only suggest. A suggestion never becomes
  // executable here — it is reported so a replay can confirm or refuse it.
  const derivation = options.deriveNativeCalls?.(
    observations.map((observation, index) => ({
      callId: observation.callId,
      stepId: `step${index}`,
      toolName: observation.callable.name,
      runtime: observation.callable.runtime,
      arguments: observation.arguments,
      ...(observation.result === undefined ? {} : { result: observation.result }),
      ...(observation.flow === undefined ? {} : { flow: observation.flow }),
    })),
  );
  if (derivation !== undefined) {
    const dependsOnByStep = new Map(
      derivation.calls.map((call) => [call.stepId, call.dependsOn] as const),
    );
    for (const [index, observation] of observations.entries()) {
      const established = dependsOnByStep.get(`step${index}`) ?? [];
      const merged = [...new Set([...(observation.establishedDependsOn ?? []), ...established])];
      if (merged.length > 0) observation.establishedDependsOn = merged;
    }
  }

  const recipe = recordWorkflowRecipe(workflowId, observations, derivation?.candidates);
  if (!recipe) return undefined;
  recipe.skipped.push(...skipped);
  const heldOut = demonstratedWorkflow(
    demonstrationOf(allEvents, selectedExecutionIndex),
    stepIdByPosition,
  );
  if (heldOut !== undefined) recipe.workflow.heldOut = heldOut;
  if (carrierCandidates.length > 0) {
    recipe.workflow.candidates = [...(recipe.workflow.candidates ?? []), ...carrierCandidates];
  }
  const privateReferences = collectWorkflowPrivateReferences(recipe.workflow);
  if (privateReferences.length > 0) recipe.workflow.privateReferences = privateReferences;
  else delete recipe.workflow.privateReferences;
  const declared = new Map(recipe.workflow.inputs.map((input) => [input.name, input]));
  for (const [name, type] of recordedInputTypes) {
    const inputType = inputTypeOf(type);
    if (inputType !== undefined) declared.set(name, { name, type: inputType });
  }
  recipe.workflow.inputs = [...declared.values()];
  return recipe;
}

/** The execution a recording is built from, and the demonstration a later one offers for it. */
/**
 * The execution a recording is built from: the earliest piece of work the events themselves name.
 *
 * Only the events of the work being compiled decide this. Evidence read from elsewhere in the
 * session says what a replay may be checked against; it never chooses, replaces or extends the
 * executable workflow, because a recording is one piece of work and a session is not.
 */
function selectedExecution(events: readonly RecordableEvent[]): number | undefined {
  const indices = new Set<number>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier?.executionIndex === undefined) continue;
    indices.add(carrier.executionIndex);
  }
  return indices.size === 0 ? undefined : Math.min(...indices);
}

/**
 * The most complete demonstration that repeats the selected execution, from anywhere it was read.
 *
 * A repeat reports itself one call at a time and its observations arrive on the result side, so the
 * last carrier that names it is the fullest. A demonstration of any other execution is not a
 * demonstration of this work and is ignored.
 */
function demonstrationOf(
  events: readonly RecordableEvent[],
  target: number | undefined,
): WorkflowCallHeldOut | undefined {
  if (target === undefined) return undefined;
  let demonstration: WorkflowCallHeldOut | undefined;
  for (const event of events) {
    const candidate =
      event.type === "tool_call"
        ? readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])?.heldOut
        : event.type === "tool_result"
          ? readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])?.heldOut
          : undefined;
    if (candidate === undefined || candidate.repeats !== target) continue;
    if (
      demonstration === undefined ||
      candidate.inputs.length + candidate.observed.length >
        demonstration.inputs.length + demonstration.observed.length
    ) {
      demonstration = candidate;
    }
  }
  return demonstration;
}

/** The demonstration, addressed by the steps this recording gave the work it demonstrates. */
function demonstratedWorkflow(
  demonstration: WorkflowCallHeldOut | undefined,
  stepIdByPosition: ReadonlyMap<number, string>,
): RecordedWorkflow["heldOut"] | undefined {
  if (demonstration === undefined) return undefined;
  const inputs: NonNullable<RecordedWorkflow["heldOut"]>["inputs"] = [];
  const observed: NonNullable<RecordedWorkflow["heldOut"]>["observed"] = [];
  for (const entry of demonstration.inputs) {
    const stepId = stepIdByPosition.get(entry.position);
    if (stepId === undefined) continue;
    inputs.push({ stepId, argument: entry.argument, reference: entry.reference });
  }
  for (const entry of demonstration.observed) {
    const stepId = stepIdByPosition.get(entry.position);
    if (stepId === undefined) continue;
    observed.push({
      stepId,
      reference: entry.reference,
      ...(entry.comparison === undefined ? {} : { comparison: entry.comparison }),
    });
  }
  if (inputs.length === 0 && observed.length === 0) return undefined;
  return { inputs, observed };
}

/**
 * The declared resources a call read and wrote, as the capture recorded them.
 *
 * The carrier names resources by a per-scope ordinal and never by their value, so two calls share a
 * resource exactly when the capture held the same value for both. The scope is part of the identity:
 * two sessions number their resources independently, and an ordinal alone would make one session's
 * file look like another's.
 */
function declaredResourceFlowOf(event: RecordableEvent): ObservedResourceFlow | undefined {
  const evidence = readToolLinkEvidence(event.metadata?.[RESIN_TOOL_LINK_EVIDENCE_KEY]);
  if (evidence === undefined) return undefined;
  if (evidence.reads.length === 0 && evidence.writes.length === 0) return undefined;
  const identityOf = (ref: { kind: string; ref: string }): string =>
    `${evidence.scopeId}|${ref.kind}:${ref.ref}`;
  return {
    reads: evidence.reads.map(identityOf),
    writes: evidence.writes.map(identityOf),
  };
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
