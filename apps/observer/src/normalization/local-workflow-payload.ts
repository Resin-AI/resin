import type { NormalizedSessionEvent } from "@resin/contracts";

/** Exact payloads stay beside an event in this process, never in serialized metadata or storage. */
const payloads = new WeakMap<NormalizedSessionEvent, Record<string, unknown>>();

export function retainLocalWorkflowPayload(event: NormalizedSessionEvent, original: Record<string, unknown>): void {
  const field = event.type === "tool_call" ? "parameters" : event.type === "tool_result" ? "result" : undefined;
  if (field === undefined || !Object.hasOwn(original, field)) return;
  payloads.set(event, { [field]: structuredClone(original[field]) });
}

/** The workflow recorder is the only consumer. Its caller continues using the redacted event. */
export function localWorkflowEvent<T extends NormalizedSessionEvent>(event: T): T | undefined {
  const payload = payloads.get(event);
  return payload === undefined ? undefined : ({ ...event, ...payload } as T);
}
