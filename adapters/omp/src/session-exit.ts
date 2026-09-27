/** Recognizes the normal custom exit emitted by OMP v18.2.6; unknown kinds stay unclaimed. */
export function getOmpSessionExitReason(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "custom" ||
    !("customType" in value) ||
    value.customType !== "session_exit" ||
    !("data" in value)
  ) {
    return undefined;
  }
  const data = value.data;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("kind" in data) ||
    data.kind !== "normal" ||
    !("reason" in data) ||
    typeof data.reason !== "string" ||
    data.reason.trim().length === 0
  ) {
    return undefined;
  }
  return data.reason;
}
