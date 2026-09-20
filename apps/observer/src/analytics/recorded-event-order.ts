/** Compare original recording positions, never delivery order or tool names. */
export function compareRecordedEvents(
  left: RecordedEventPosition,
  right: RecordedEventPosition,
): number {
  const session = (left.sessionId ?? "").localeCompare(right.sessionId ?? "");
  if (session !== 0) return session;
  const sequence = (event: RecordedEventPosition): number => {
    const value = event.causalRef?.causalSequence ?? event.sequenceNum;
    return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  const delta = sequence(left) - sequence(right);
  if (delta !== 0) return delta;
  // Several calls can be embedded in one source message. Their block positions are not optional
  // ordering information: sorting by timestamp/id instead can put a consumer before its producer.
  const block = (left.causalRef?.stepIndex ?? 0) - (right.causalRef?.stepIndex ?? 0);
  if (block !== 0) return block;
  const time = (left.timestamp ?? "").localeCompare(right.timestamp ?? "");
  if (time !== 0) return time;
  const rank = (type: string | undefined): number =>
    type === "tool_call" ? 0 : type === "tool_result" ? 1 : 2;
  return (
    rank(left.type) - rank(right.type) || (left.eventId ?? "").localeCompare(right.eventId ?? "")
  );
}

interface RecordedEventPosition {
  sessionId?: string;
  causalRef?: { causalSequence?: number; stepIndex?: number };
  sequenceNum?: number;
  timestamp?: string;
  eventId?: string;
  type?: string;
}
