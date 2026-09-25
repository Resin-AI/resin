/**
 * Parser-free reconstruction of recordings whose frozen workflow carriers have already been
 * projected. This entry deliberately shares the full reconstruction core without importing native
 * derivation or a program tokenizer.
 */

import type { RecordableEvent } from "./analytics/workflow-carrier.js";
import type { RecordedRecipe } from "./analytics/workflow-recipe-builder.js";
import { reconstructWorkflowFromEvents } from "./analytics/workflow-recording-core.js";

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
  WorkflowResultCarrier,
} from "./analytics/workflow-carrier.js";
export type {
  InputProposal,
  ObservedResourceFlow,
  RecordedArgumentOrigin,
  RecordedCallObservation,
  RecordedRecipe,
} from "./analytics/workflow-recipe-builder.js";
export type { RecordedReferenceUse } from "./analytics/workflow-recording-core.js";

/** Context required to resolve the frozen reference and demonstration carriers. */
export interface CarriedRecordingOptions {
  /** Scope used by callers of the reference-aware surface. */
  referenceScopeId?: string;
  /** Other events from the same session, used only as demonstration evidence. */
  supportingEvents?: readonly RecordableEvent[];
}

/**
 * Reconstructs a workflow from already-carried events. Carrier fields are the only executable
 * authority; raw parameters and discovery metadata are intentionally unavailable on this surface.
 */
export function recordCarriedCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: CarriedRecordingOptions = {},
): RecordedRecipe | undefined {
  return reconstructWorkflowFromEvents(workflowId, events, {
    ...options,
    carrierRequired: true,
  });
}
