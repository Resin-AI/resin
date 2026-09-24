import type { NormalizedSessionEvent } from "@resin/contracts";

export type LocalWorkflowResultComparison = "text-trim";

/** Value-free persisted signal that a result cannot establish workflow/computation success. */
export const RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY =
  "__resinLocalWorkflowResultSuppressedV1";

export interface LocalWorkflowResultObservation {
  result: string;
  comparison?: LocalWorkflowResultComparison;
}

interface RetainLocalWorkflowPayloadOptions {
  /** A result recovered from the source-native artifact, rather than the normalized display value. */
  resultObservation?: LocalWorkflowResultObservation;
  /** Hide an untrusted native display result from local workflow derivation. */
  suppressResult?: boolean;
}

interface LocalWorkflowPayload {
  parameters?: unknown;
  result?: unknown;
  resultComparison?: LocalWorkflowResultComparison;
  resultSuppressed?: true;
}

/** Exact payloads stay beside an event in this process, never in serialized metadata or storage. */
const payloads = new WeakMap<NormalizedSessionEvent, LocalWorkflowPayload>();

export function retainLocalWorkflowPayload(
  event: NormalizedSessionEvent,
  original: Record<string, unknown>,
  options: RetainLocalWorkflowPayloadOptions = {},
): void {
  const field =
    event.type === "tool_call" ? "parameters" : event.type === "tool_result" ? "result" : undefined;
  const hasOriginalField = field !== undefined && Object.hasOwn(original, field);
  const hasNativeResult =
    event.type === "tool_result" &&
    options.resultObservation !== undefined &&
    typeof options.resultObservation.result === "string";
  const suppressResult = event.type === "tool_result" && options.suppressResult === true;
  if (!hasOriginalField && !hasNativeResult && !suppressResult) return;

  const payload: LocalWorkflowPayload = {};
  if (hasOriginalField) payload[field] = structuredClone(original[field]);
  if (hasNativeResult) {
    payload.result = structuredClone(options.resultObservation!.result);
    if (options.resultObservation!.comparison !== undefined) {
      payload.resultComparison = options.resultObservation!.comparison;
    }
  } else if (suppressResult) {
    payload.result = undefined;
    payload.resultSuppressed = true;
  }
  payloads.set(event, payload);
}

/** The workflow recorder is the only consumer. Its caller continues using the redacted event. */
export function localWorkflowEvent<T extends NormalizedSessionEvent>(event: T): T | undefined {
  const payload = payloads.get(event);
  if (payload === undefined) return undefined;
  const field =
    event.type === "tool_call" ? "parameters" : event.type === "tool_result" ? "result" : undefined;
  if (field === undefined || !Object.hasOwn(payload, field)) return event;
  return { ...event, [field]: payload[field] } as T;
}

/** Reads the source-native result and its optional comparison mode without publishing either. */
export function localWorkflowResultObservation(
  event: NormalizedSessionEvent,
): LocalWorkflowResultObservation | undefined {
  const payload = payloads.get(event);
  if (payload === undefined || typeof payload.result !== "string") return undefined;
  return payload.resultComparison === undefined
    ? { result: payload.result }
    : { result: payload.result, comparison: payload.resultComparison };
}

/** True when a result is unavailable for local evidence, including after metadata-only reload. */
export function isLocalWorkflowResultSuppressed(event: NormalizedSessionEvent): boolean {
  if (event.type !== "tool_result") return false;
  if (
    event.metadata?.[RESIN_LOCAL_WORKFLOW_RESULT_SUPPRESSED_METADATA_KEY] === true ||
    payloads.get(event)?.resultSuppressed === true
  ) {
    return true;
  }
  if (event.isError) return false;
  const codexNative = event.metadata?.codexNative;
  return (
    typeof codexNative === "object" &&
    codexNative !== null &&
    !Array.isArray(codexNative) &&
    (codexNative as Record<string, unknown>).outcome !== "completed"
  );
}
