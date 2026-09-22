/** Evidence selection is separate from executable step selection. */
export interface DemonstrationSnapshot {
  repeats: number;
  inputs: Array<{ position: number; argument: string; reference: string }>;
  observed: Array<{
    position: number;
    reference: string;
    comparison?: "text-trim";
  }>;
}

export interface DemonstrationCall {
  sessionId: string;
  callId: string;
  executionIndex: number;
  /** Canonical runtime, callable, connection, and argument/program structure. */
  identity: string;
}

export interface DemonstrationObservation {
  sessionId: string;
  callId: string;
  snapshot: DemonstrationSnapshot;
}

/**
 * A session-local execution number is not a global identity. Require an actual,
 * structurally matching repeat in the same recording session before using its
 * observed values. Read snapshots from both calls and results without combining
 * different demonstrations into a fictitious run.
 */
export function selectDemonstration(
  selected: readonly DemonstrationCall[],
  calls: readonly DemonstrationCall[],
  observations: readonly DemonstrationObservation[],
): DemonstrationSnapshot | undefined {
  const first = selected[0];
  if (
    !first ||
    selected.some(
      (call) => call.sessionId !== first.sessionId || call.executionIndex !== first.executionIndex,
    )
  ) {
    return undefined;
  }
  const executions = new Map<number, DemonstrationCall[]>();
  const seenCalls = new Set<string>();
  const executionByCall = new Map<string, number>();
  for (const call of calls) {
    if (call.sessionId !== first.sessionId || seenCalls.has(call.callId)) continue;
    seenCalls.add(call.callId);
    executionByCall.set(call.callId, call.executionIndex);
    const members = executions.get(call.executionIndex) ?? [];
    members.push(call);
    executions.set(call.executionIndex, members);
  }
  const baseline = executions.get(first.executionIndex);
  if (baseline === undefined) return undefined;
  const selectedPosition = new Map<number, number>();
  let previous = -1;
  for (const [ordinal, call] of selected.entries()) {
    const position = baseline.findIndex(
      (entry) => entry.callId === call.callId && entry.identity === call.identity,
    );
    if (position <= previous) return undefined;
    selectedPosition.set(position, ordinal);
    previous = position;
  }
  const selectedIdentities = selected.map((call) => call.identity);
  const positionsByExecution = new Map<number, ReadonlyMap<number, number>>();
  for (const [index, members] of executions) {
    if (index === first.executionIndex || members.length < selectedIdentities.length) continue;
    const starts: number[] = [];
    for (let start = 0; start <= members.length - selectedIdentities.length; start++) {
      if (
        selectedIdentities.every(
          (identity, offset) => members[start + offset]!.identity === identity,
        )
      )
        starts.push(start);
    }
    if (starts.length !== 1) continue;
    positionsByExecution.set(
      index,
      new Map(selectedIdentities.map((_, ordinal) => [starts[0]! + ordinal, ordinal])),
    );
  }
  let chosen: DemonstrationSnapshot | undefined;
  let observedCount = -1;
  let inputCount = -1;
  for (const observation of observations) {
    if (observation.sessionId !== first.sessionId) continue;
    const execution = executionByCall.get(observation.callId);
    if (execution === undefined) continue;
    const selectedRepeatPositions = positionsByExecution.get(execution);
    if (selectedRepeatPositions === undefined) continue;
    const snapshot = observation.snapshot;
    if (snapshot.repeats !== first.executionIndex) continue;
    const members = executions.get(execution)!;
    const inRange = (position: number): boolean =>
      Number.isSafeInteger(position) && position >= 0 && position < members.length;
    if (
      snapshot.inputs.some((entry) => !inRange(entry.position)) ||
      snapshot.observed.some((entry) => !inRange(entry.position))
    ) {
      continue;
    }
    // Duplicate positions are malformed evidence, not extra coverage.
    if (
      new Set(snapshot.observed.map((entry) => entry.position)).size !== snapshot.observed.length
    ) {
      continue;
    }
    if (
      new Set(snapshot.inputs.map((entry) => JSON.stringify([entry.position, entry.argument])))
        .size !== snapshot.inputs.length
    ) {
      continue;
    }
    // Snapshot positions belong to the repeated execution. Preserve only the uniquely matching
    // selected slice and compact those positions to workflow step numbers.
    const inputs = snapshot.inputs
      .filter((entry) => selectedRepeatPositions.has(entry.position))
      .map((entry) => ({
        ...entry,
        position: selectedRepeatPositions.get(entry.position)!,
      }));
    const observed = snapshot.observed
      .filter((entry) => selectedRepeatPositions.has(entry.position))
      .map((entry) => ({
        ...entry,
        position: selectedRepeatPositions.get(entry.position)!,
      }));
    if (
      observed.length < observedCount ||
      (observed.length === observedCount && inputs.length <= inputCount)
    )
      continue;
    observedCount = observed.length;
    inputCount = inputs.length;
    chosen = { repeats: snapshot.repeats, inputs, observed };
  }
  return chosen;
}
