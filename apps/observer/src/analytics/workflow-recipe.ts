/** Shared live/import reconstruction, with executable selection separate from learning evidence. */
import type { WorkflowValueSource, WorkflowValueTemplate } from "@resin/contracts";
import {
  type DemonstrationCall,
  type DemonstrationObservation,
  selectDemonstration,
} from "./demonstration-evidence.js";
import { compareRecordedEvents } from "./recorded-event-order.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowCallCarrier,
  readWorkflowResultCarrier,
} from "./workflow-call-recorder.js";
import {
  type RecordableEvent,
  type RecordedRecipe,
  recordCallsFromEvents as reconstructCalls,
} from "./workflow-recording.js";

export {
  acceptInputProposals,
  proposeInputsFromVariation,
  recordWorkflowRecipe,
  type InputProposal,
  type InputProposalSet,
  type RecordableEvent,
  type RecordedArgumentOrigin,
  type RecordedCallObservation,
  type RecordedRecipe,
  type RecordedReferenceUse,
} from "./workflow-recording.js";

type CaptureOptions = NonNullable<Parameters<typeof reconstructCalls>[2]>;
const callIdOf = (event: RecordableEvent): string | undefined =>
  event.callId ?? event.toolCallId ?? (event.type === "tool_call" ? event.eventId : undefined);

export function recordCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: CaptureOptions = {},
): RecordedRecipe | undefined {
  const ordered = [...events].sort(compareRecordedEvents);
  const first = ordered.find(
    (event) =>
      event.type === "tool_call" &&
      readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])
        ?.executionIndex !== undefined,
  );
  // Older explicitly composed recordings have no execution indices. Preserve their existing path.
  if (!first) return reconstructCalls(workflowId, events, options);
  const execution = readWorkflowCallCarrier(first.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])!
    .executionIndex!;
  const session = first.sessionId;
  const ownCallIds = new Set<string>();
  for (const event of ordered) {
    if (event.sessionId !== session || event.type !== "tool_call") continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (carrier?.executionIndex === execution) ownCallIds.add(callIdOf(event)!);
  }
  const selected = ordered.filter((event) => {
    const callId = callIdOf(event);
    return event.sessionId === session && callId !== undefined && ownCallIds.has(callId);
  });
  const selectedIds = new Set(selected.map((event) => event.eventId));
  const supporting = [...ordered, ...(options.supportingEvents ?? [])]
    .filter((event) => event.sessionId === session && !selectedIds.has(event.eventId))
    .sort(compareRecordedEvents);
  const recipe = reconstructCalls(workflowId, selected, {
    ...options,
    supportingEvents: supporting,
  });
  if (!recipe) return undefined;

  const calls: DemonstrationCall[] = [];
  const observations: DemonstrationObservation[] = [];
  for (const event of [...selected, ...supporting].sort(compareRecordedEvents)) {
    const callId = callIdOf(event);
    if (callId === undefined) continue;
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (event.type === "tool_call" && carrier?.executionIndex !== undefined) {
      const discovered = options.discoveryFor?.(carrier.name);
      calls.push({
        sessionId: event.sessionId,
        callId,
        executionIndex: carrier.executionIndex,
        identity: JSON.stringify([
          carrier.runtime,
          carrier.name,
          carrier.connection ?? discovered?.connection ?? event.metadata?.connection ?? null,
          carrier.program?.kind ?? null,
          carrier.program?.argument ?? null,
          Object.keys(carrier.origins).sort(),
        ]),
      });
    }
    // The last result often holds the ONLY snapshot with the final observation. Reading only
    // tool_call carriers leaves every normal one-call repetition without an observed output.
    const snapshot =
      event.type === "tool_result"
        ? readWorkflowResultCarrier(event.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])?.heldOut
        : carrier?.heldOut;
    if (snapshot) observations.push({ sessionId: event.sessionId, callId, snapshot });
  }
  const byId = new Map(
    calls.filter((call) => call.executionIndex === execution).map((call) => [call.callId, call]),
  );
  const selectedCalls = recipe.workflow.steps.map((step) => byId.get(step.callId ?? ""));
  const demonstration = selectedCalls.every((call): call is DemonstrationCall => call !== undefined)
    ? selectDemonstration(selectedCalls, calls, observations)
    : undefined;
  delete recipe.workflow.heldOut;
  if (demonstration) {
    recipe.workflow.heldOut = {
      inputs: demonstration.inputs.map((entry) => ({
        stepId: recipe.workflow.steps[entry.position]!.id,
        argument: entry.argument,
        reference: entry.reference,
      })),
      observed: demonstration.observed.map((entry) => ({
        stepId: recipe.workflow.steps[entry.position]!.id,
        reference: entry.reference,
      })),
    };
  }
  // Only references used by the actual arguments and the selected demonstration are authorized.
  const references = new Set<string>();
  const collectTemplate = (template: WorkflowValueTemplate): void => {
    if (template.type === "private") references.add(template.reference);
    else if (template.type === "object") {
      for (const entry of Object.values(template.entries)) collectTemplate(entry);
    } else if (template.type === "array") {
      for (const item of template.items) collectTemplate(item);
    } else if (template.type === "program") {
      collectTemplate(template.source);
      for (const hole of template.holes) collectTemplate(hole.binding);
    }
  };
  const collect = (source: WorkflowValueSource): void => {
    if (source.kind === "private") references.add(source.reference);
    else if (source.kind === "template") collectTemplate(source.template);
  };
  for (const step of recipe.workflow.steps) {
    for (const argument of step.arguments) collect(argument.source);
  }
  for (const entry of recipe.workflow.heldOut?.inputs ?? []) references.add(entry.reference);
  for (const entry of recipe.workflow.heldOut?.observed ?? []) references.add(entry.reference);
  if (references.size > 0) recipe.workflow.privateReferences = [...references];
  else delete recipe.workflow.privateReferences;
  return recipe;
}
