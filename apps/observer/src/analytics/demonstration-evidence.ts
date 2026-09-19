/** Evidence selection is separate from executable step selection. */
export interface DemonstrationSnapshot {
  repeats: number;
  inputs: Array<{ position: number; argument: string; reference: string }>;
  observed: Array<{ position: number; reference: string }>;
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
  const matching = new Set<number>();
  for (const [index, members] of executions) {
    if (index === first.executionIndex || members.length !== selected.length) continue;
    if (members.every((call, ordinal) => call.identity === selected[ordinal]!.identity)) {
      matching.add(index);
    }
  }
  let chosen: DemonstrationSnapshot | undefined;
  let observedCount = -1;
  let inputCount = -1;
  for (const observation of observations) {
    if (observation.sessionId !== first.sessionId) continue;
    const execution = executionByCall.get(observation.callId);
    if (execution === undefined || !matching.has(execution)) continue;
    const snapshot = observation.snapshot;
    if (snapshot.repeats !== first.executionIndex) continue;
    const inRange = (position: number): boolean =>
      Number.isSafeInteger(position) && position >= 0 && position < selected.length;
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
    if (
      snapshot.observed.length < observedCount ||
      (snapshot.observed.length === observedCount && snapshot.inputs.length <= inputCount)
    ) {
      continue;
    }
    observedCount = snapshot.observed.length;
    inputCount = snapshot.inputs.length;
    chosen = {
      repeats: snapshot.repeats,
      inputs: snapshot.inputs.map((entry) => ({ ...entry })),
      observed: snapshot.observed.map((entry) => ({ ...entry })),
    };
  }
  return chosen;
}
