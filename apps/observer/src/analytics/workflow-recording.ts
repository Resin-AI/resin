/** Full/native workflow recording entry point.
 *
 * The reconstruction itself lives in workflow-recording-core.ts so the public parser-free entry can
 * use the same carrier semantics without importing native derivation or its program tokenizer.
 */

import { deriveNativeCalls } from "./native-argument-derivation.js";
import type { RecordableEvent } from "./workflow-carrier.js";
import type { RecordedRecipe } from "./workflow-recipe-builder.js";
import { reconstructWorkflowFromEvents } from "./workflow-recording-core.js";

export {
  acceptInputProposals,
  recordWorkflowRecipe,
} from "./workflow-recipe-builder.js";
export type {
  InputProposal,
  RecordedArgumentOrigin,
  RecordedCallObservation,
  RecordedRecipe,
} from "./workflow-recipe-builder.js";

export type { RecordableEvent } from "./workflow-carrier.js";
export type { RecordedReferenceUse } from "./workflow-recording-core.js";

export interface WorkflowRecordingOptions {
  /** Runtime and connection as discovery/dispatch recorded them. */
  discoveryFor?: (toolName: string) => { runtime?: string; connection?: string } | undefined;
  /** Scope used by the caller's reference-aware interface. */
  referenceScopeId?: string;
  /** Other events read from this session, used only as demonstration evidence. */
  supportingEvents?: readonly RecordableEvent[];
}

export function recordCallsFromEvents(
  workflowId: string,
  events: readonly RecordableEvent[],
  options: WorkflowRecordingOptions = {},
): RecordedRecipe | undefined {
  return reconstructWorkflowFromEvents(workflowId, events, {
    ...options,
    deriveNativeCalls,
    referenceScopeId: options.referenceScopeId ?? workflowId,
  });
}
