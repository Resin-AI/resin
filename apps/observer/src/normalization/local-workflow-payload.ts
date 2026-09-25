import type { NormalizedSessionEvent } from "@resin/contracts";

export type LocalWorkflowResultComparison = "text-trim";

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
  stdout?: unknown;
  stderr?: unknown;
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
  const commandFields =
    event.type === "command_exec"
      ? (["stdout", "stderr"] as const).filter((name) => Object.hasOwn(original, name))
      : [];
  const hasNativeResult =
    event.type === "tool_result" &&
    options.resultObservation !== undefined &&
    typeof options.resultObservation.result === "string";
  const suppressResult = event.type === "tool_result" && options.suppressResult === true;
  if (!hasOriginalField && commandFields.length === 0 && !hasNativeResult && !suppressResult)
    return;

  const payload: LocalWorkflowPayload = {};
  if (hasOriginalField) payload[field] = structuredClone(original[field]);
  for (const name of commandFields) payload[name] = structuredClone(original[name]);
  if (hasNativeResult) {
    payload.result = structuredClone(options.resultObservation!.result);
    if (options.resultObservation!.comparison !== undefined) {
      payload.resultComparison = options.resultObservation!.comparison;
    }
  } else if (suppressResult) {
    payload.result = undefined;
  }
  payloads.set(event, payload);
}

/** The workflow recorder is the only consumer. Its caller continues using the redacted event. */
export function localWorkflowEvent<T extends NormalizedSessionEvent>(event: T): T | undefined {
  const payload = payloads.get(event);
  if (payload === undefined) return undefined;
  const field =
    event.type === "tool_call" ? "parameters" : event.type === "tool_result" ? "result" : undefined;
  if (event.type === "command_exec") {
    if (!Object.hasOwn(payload, "stdout")) return undefined;
    return {
      ...event,
      ...(Object.hasOwn(payload, "stdout") ? { stdout: payload.stdout } : {}),
      ...(Object.hasOwn(payload, "stderr") ? { stderr: payload.stderr } : {}),
    } as T;
  }
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
