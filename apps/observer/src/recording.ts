/**
 * Parser-free reconstruction of recordings whose frozen workflow carriers have already been
 * captured and projected.
 *
 * This module deliberately consumes only metadata.workflowCall and metadata.workflowResult. It never
 * examines raw source, re-runs native derivation, or guesses a callable from a tool name.
 */

import type {
  AgentArgumentOrigin,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
  WorkflowValuePath,
  WorkflowValueSource,
  WorkflowValueTemplate,
} from "@resin/contracts";
import {
  type DemonstrationCall,
  type DemonstrationObservation,
  selectDemonstration,
} from "./analytics/demonstration-evidence.js";
import { compareRecordedEvents } from "./analytics/recorded-event-order.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  type RecordableEvent,
  type WorkflowCallCandidate,
  type WorkflowCallCarrier,
  type WorkflowCallHeldOut,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./analytics/workflow-carrier.js";
import {
  type RecordedCallObservation,
  type RecordedRecipe,
  recordWorkflowRecipe,
} from "./analytics/workflow-recipe-builder.js";
export {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_INVOKE_TOOL_RUNTIME,
  RESIN_NATIVE_RUNTIMES,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./analytics/workflow-carrier.js";
export type {
  DiscoveredCallable,
  RecordableEvent,
  WorkflowCallCandidate,
  WorkflowCallCarrier,
  WorkflowCallHeldOut,
} from "./analytics/workflow-carrier.js";
export type {
  InputProposal,
  InputProposalSet,
  ObservedResourceFlow,
  RecordedArgumentOrigin,
  RecordedCallObservation,
  RecordedRecipe,
} from "./analytics/workflow-recipe-builder.js";

/** Context required to resolve the frozen reference and demonstration carriers. */
export interface CarriedRecordingOptions {
  /** Scope used by callers of the reference-aware surface. */
  referenceScopeId?: string;
  /** Other events from the same session, used only as demonstration evidence. */
  supportingEvents?: readonly RecordableEvent[];
}

const callIdOf = (event: RecordableEvent): string | undefined =>
  event.callId ?? event.toolCallId ?? (event.type === "tool_call" ? event.eventId : undefined);

function scopedKey(sessionId: string, callId: string): string {
  return `${sessionId.length}:${sessionId}${callId}`;
}

/** The display shape of a carrier origin; executable templates come from the origin itself. */
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

/** Binds carrier references to the selected recording's step identities without matching values. */
function bindCarrierOrigin(
  origin: AgentArgumentOrigin,
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
        if (stepId !== undefined) return { type: "result", stepId, path: origin.path };
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
      return origin;
  }
}

function extractResultValue(content: unknown): WorkflowJsonValue | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
    return content;
  }
  if (content === null) return null;
  if (Array.isArray(content)) return content as WorkflowJsonValue;
  if (typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
    return content as WorkflowJsonValue;
  }
  return undefined;
}

function collectTemplateReferences(template: WorkflowValueTemplate, into: Set<string>): void {
  switch (template.type) {
    case "private":
      into.add(template.reference);
      return;
    case "object":
      for (const entry of Object.values(template.entries)) collectTemplateReferences(entry, into);
      return;
    case "array":
      for (const item of template.items) collectTemplateReferences(item, into);
      return;
    case "program":
      collectTemplateReferences(template.source, into);
      for (const hole of template.holes) collectTemplateReferences(hole.binding, into);
      return;
    default:
      return;
  }
}

function collectSourceReferences(source: WorkflowValueSource, into: Set<string>): void {
  if (source.kind === "private") into.add(source.reference);
  else if (source.kind === "template") collectTemplateReferences(source.template, into);
}

function identityOf(carrier: WorkflowCallCarrier): string {
  return JSON.stringify([
    carrier.runtime,
    carrier.name,
    carrier.connection ?? null,
    carrier.program?.kind ?? null,
    carrier.program?.argument ?? null,
    Object.keys(carrier.origins).sort(),
  ]);
}

function snapshotOf(
  event: RecordableEvent,
  carrier: WorkflowCallCarrier | undefined,
): WorkflowCallHeldOut | undefined {
  if (event.type === "tool_call") return carrier?.heldOut;
  if (event.type !== "tool_result") return undefined;
  return readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])?.heldOut;
}
function candidateForStep(
  candidate: WorkflowCallCandidate,
  stepId: string,
  stepIdByCallId: ReadonlyMap<string, string>,
  sessionId: string,
): WorkflowBindingCandidate | undefined {
  const proposed =
    candidate.proposed.kind === "result"
      ? (() => {
          const producer = stepIdByCallId.get(scopedKey(sessionId, candidate.proposed.callId));
          return producer === undefined
            ? undefined
            : { kind: "result" as const, stepId: producer, path: candidate.proposed.path };
        })()
      : candidate.proposed;
  if (proposed === undefined) return undefined;
  return {
    stepId,
    argument: candidate.argument,
    path: candidate.path,
    proposed,
    reason: candidate.reason,
    ...(candidate.evidence === undefined ? {} : { evidence: candidate.evidence }),
    missing: candidate.missing,
  };
}

/**
 * Reconstructs a workflow from already-carried events. Carriers are the authority for callable
 * identity, argument origins, candidates, dependencies, inputs, private references, and held-out
 * evidence; projected event values are used only for observed result status when present.
 */
export function recordCarriedCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: CarriedRecordingOptions = {},
): RecordedRecipe | undefined {
  const ordered = [...events].sort(compareRecordedEvents);
  const first = ordered.find(
    (event) =>
      event.type === "tool_call" &&
      readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])
        ?.executionIndex !== undefined,
  );
  const firstCall = ordered.find((event) => event.type === "tool_call");
  const session = first?.sessionId ?? firstCall?.sessionId;
  if (session === undefined) return undefined;

  const selectedExecution = first
    ? readWorkflowCallCarrier(first.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])?.executionIndex
    : undefined;
  const ownCallIds = new Set<string>();
  if (selectedExecution !== undefined) {
    for (const event of ordered) {
      if (event.type !== "tool_call" || event.sessionId !== session) continue;
      const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
      const callId = callIdOf(event);
      if (
        callId !== undefined &&
        (carrier === undefined || carrier.executionIndex === selectedExecution)
      )
        ownCallIds.add(callId);
    }
  }
  const selectedIds = new Set<string>();
  const selected = ordered.filter((event) => {
    if (event.sessionId !== session) return false;
    if (event.type !== "tool_call" && event.type !== "tool_result") return false;
    const callId = callIdOf(event);
    if (callId === undefined) return false;
    if (selectedExecution === undefined || ownCallIds.has(callId)) {
      selectedIds.add(event.eventId);
      return true;
    }
    return false;
  });
  const supporting = [...ordered, ...(options.supportingEvents ?? [])]
    .filter((event) => event.sessionId === session && !selectedIds.has(event.eventId))
    .sort(compareRecordedEvents);
  const allEvents = [...selected, ...supporting].sort(compareRecordedEvents);

  const resultsByCallId = new Map<
    string,
    { value: WorkflowJsonValue | undefined; isError: boolean | undefined }
  >();
  const aliasByScopeCall = new Map<string, string>();
  for (const event of allEvents) {
    if (event.type !== "tool_result") continue;
    const callId = event.callId ?? event.toolCallId;
    if (callId === undefined) continue;
    const key = scopedKey(event.sessionId, callId);
    resultsByCallId.set(key, {
      value: event.result ?? extractResultValue(event.content),
      isError: event.isError,
    });
    const handle = readWorkflowResultCarrier(
      event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
    )?.handle;
    if (handle !== undefined) {
      const parts = handle.split(":");
      if (parts.length >= 3 && parts[0] === "ref") {
        aliasByScopeCall.set(scopedKey(parts[1]!, parts.slice(2).join(":")), key);
      }
    }
  }

  const selectedCalls = selected.filter((event) => event.type === "tool_call");
  const uniqueSelectedCalls: RecordableEvent[] = [];
  const seenSelected = new Set<string>();
  const carriers = new Map<RecordableEvent, WorkflowCallCarrier>();
  const skipped: Array<{ callId: string; reason: string }> = [];
  for (const event of selectedCalls) {
    const callId = callIdOf(event);
    if (callId === undefined) continue;
    const key = scopedKey(event.sessionId, callId);
    if (seenSelected.has(key)) continue;
    seenSelected.add(key);
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier === undefined) {
      skipped.push({ callId, reason: "missing or malformed workflowCall carrier" });
      continue;
    }
    carriers.set(event, carrier);
    uniqueSelectedCalls.push(event);
  }
  const stepIdByCallId = new Map<string, string>();
  for (const [index, event] of uniqueSelectedCalls.entries()) {
    const callId = callIdOf(event);
    if (callId !== undefined)
      stepIdByCallId.set(scopedKey(event.sessionId, callId), `step${index}`);
  }

  const observations: RecordedCallObservation[] = [];
  const carriedCandidates: WorkflowBindingCandidate[] = [];
  const precedingCallIds = new Set<string>();

  for (const event of uniqueSelectedCalls) {
    const callId = callIdOf(event);
    if (callId === undefined) continue;
    const carrier = carriers.get(event)!;
    for (const dependency of carrier.dependsOnCallIds ?? []) {
      if (!precedingCallIds.has(dependency)) {
        skipped.push({ callId, reason: "recorded dependency is not an earlier selected call" });
      }
    }
    const argumentOrigins: Record<string, WorkflowValueTemplate> = {};
    const argumentsByName: Record<string, WorkflowJsonValue> = {};
    for (const [argument, origin] of Object.entries(carrier.origins)) {
      argumentOrigins[argument] = bindCarrierOrigin(
        origin,
        aliasByScopeCall,
        stepIdByCallId,
        event.sessionId,
        options.referenceScopeId,
      );
      argumentsByName[argument] = carrierArgumentValue(origin);
    }
    const argumentTypes: Record<string, "string" | "number" | "boolean" | "object" | "array"> = {};
    for (const input of carrier.inputs) {
      if (typeof input.argument !== "string" || typeof input.name !== "string") continue;
      const inputType = input.type;
      if (
        inputType !== "string" &&
        inputType !== "number" &&
        inputType !== "boolean" &&
        inputType !== "object" &&
        inputType !== "array"
      )
        continue;
      argumentTypes[input.argument] = inputType;
    }
    const recordedResult = resultsByCallId.get(scopedKey(event.sessionId, callId));
    const observation: RecordedCallObservation = {
      callId,
      ...(event.causalRef?.causalSequence === undefined
        ? {}
        : { causalSequence: event.causalRef.causalSequence }),
      callable: {
        runtime: carrier.runtime,
        name: carrier.name,
        ...(carrier.connection === undefined ? {} : { connection: carrier.connection }),
        ...(carrier.inputSchema === undefined ? {} : { inputSchema: carrier.inputSchema }),
        ...(carrier.program === undefined ? {} : { program: carrier.program }),
      },
      arguments: argumentsByName,
      ...(Object.keys(argumentOrigins).length === 0 ? {} : { argumentOrigins }),
      ...(Object.keys(argumentTypes).length === 0 ? {} : { argumentTypes }),
      ...(carrier.provenance === undefined ? {} : { argumentProvenance: carrier.provenance }),
      ...(recordedResult?.value === undefined ? {} : { result: recordedResult.value }),
      ...(carrier.dependsOnCallIds === undefined
        ? {}
        : {
            establishedDependsOn: carrier.dependsOnCallIds
              .map((dependency) => stepIdByCallId.get(scopedKey(event.sessionId, dependency)))
              .filter((dependency): dependency is string => dependency !== undefined),
          }),
      observed:
        recordedResult === undefined
          ? "unknown"
          : recordedResult.isError === true
            ? "failed"
            : recordedResult.isError === false
              ? "succeeded"
              : "unknown",
    };
    observations.push(observation);
    precedingCallIds.add(callId);
    const stepId = stepIdByCallId.get(scopedKey(event.sessionId, callId));
    if (stepId !== undefined) {
      for (const candidate of carrier.candidates ?? []) {
        const converted = candidateForStep(candidate, stepId, stepIdByCallId, event.sessionId);
        if (converted !== undefined) {
          carriedCandidates.push(converted);
        } else {
          skipped.push({
            callId,
            reason: "recorded binding proposal refers outside the selected recording",
          });
        }
      }
    }
  }
  if (observations.length === 0) return undefined;

  const recipe = recordWorkflowRecipe(workflowId, observations, carriedCandidates);
  if (recipe === undefined) return undefined;
  recipe.skipped = skipped;

  const calls: DemonstrationCall[] = [];
  const observationsByCall: DemonstrationObservation[] = [];
  for (const event of allEvents) {
    const callId = callIdOf(event);
    if (callId === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (event.type === "tool_call" && carrier?.executionIndex !== undefined) {
      calls.push({
        sessionId: event.sessionId,
        callId,
        executionIndex: carrier.executionIndex,
        identity: identityOf(carrier),
      });
    }
    const snapshot = snapshotOf(event, carrier);
    if (snapshot !== undefined)
      observationsByCall.push({ sessionId: event.sessionId, callId, snapshot });
  }
  if (selectedExecution !== undefined) {
    const selectedDemonstrationCalls = recipe.workflow.steps.map((step) =>
      calls.find(
        (call) =>
          call.sessionId === session &&
          call.executionIndex === selectedExecution &&
          call.callId === step.callId,
      ),
    );
    if (selectedDemonstrationCalls.every((call): call is DemonstrationCall => call !== undefined)) {
      const demonstration = selectDemonstration(
        selectedDemonstrationCalls,
        calls,
        observationsByCall,
      );
      if (demonstration !== undefined) {
        recipe.workflow.heldOut = {
          inputs: demonstration.inputs.flatMap((entry) => {
            const step = recipe.workflow.steps[entry.position];
            return step === undefined
              ? []
              : [{ stepId: step.id, argument: entry.argument, reference: entry.reference }];
          }),
          observed: demonstration.observed.flatMap((entry) => {
            const step = recipe.workflow.steps[entry.position];
            return step === undefined ? [] : [{ stepId: step.id, reference: entry.reference }];
          }),
        };
      }
    }
  }

  const references = new Set<string>();
  for (const step of recipe.workflow.steps) {
    for (const argument of step.arguments) collectSourceReferences(argument.source, references);
  }
  for (const entry of recipe.workflow.heldOut?.inputs ?? []) references.add(entry.reference);
  for (const entry of recipe.workflow.heldOut?.observed ?? []) references.add(entry.reference);
  if (references.size > 0) recipe.workflow.privateReferences = [...references];
  else delete recipe.workflow.privateReferences;
  return recipe;
}
