/** Shared live/import reconstruction, with executable selection separate from learning evidence. */
import { collectWorkflowPrivateReferences } from "@resin/contracts";
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
} from "./workflow-carrier.js";
import {
  type RecordableEvent,
  type RecordedRecipe,
  recordCallsFromEvents as reconstructCalls,
} from "./workflow-recording.js";

export {
  acceptInputProposals,
  recordWorkflowRecipe,
  type InputProposal,
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
        ...(entry.comparison === undefined ? {} : { comparison: entry.comparison }),
      })),
    };
  }
  recipe.workflow.privateReferences = collectWorkflowPrivateReferences(recipe.workflow);
  if (recipe.workflow.privateReferences.length === 0) delete recipe.workflow.privateReferences;
  return recipe;
}
