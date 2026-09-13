import {
  COMPUTATION_IR_VERSION,
  type NormalizedCommandExecEvent,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
} from "@resin/contracts";
import {
  type ComputationFixtureVariant,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
} from "@resin/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  ComputationEvidenceRecorder,
  createComputationEvidenceRecorder,
} from "../../../src/analytics/computation/recorder.js";
import { extractComputationSourceFrames } from "../../../src/analytics/computation/source-frames.js";

// ============================================================================
// Native normalized event builders
// ============================================================================

const SCHEMA_VERSION = "1.0.0" as const;

function causal(sequence: number): NormalizedSessionEvent["causalRef"] {
  return { parentId: null, causalSequence: sequence };
}

function redaction(fields: string[] = []): NormalizedSessionEvent["redaction"] {
  return {
    isRedacted: fields.length > 0,
    redactedFields: fields,
    redactionStrategy: fields.length > 0 ? "drop" : "none",
    scrubbedPatterns: [],
  };
}

function toolCall(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  sequence: number;
}): NormalizedToolCallEvent {
  return {
    eventId: `evt_call_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["parameters"]),
    metadata: { scenarioId: options.sessionId },
    type: "tool_call",
    callId: options.callId,
    toolName: options.toolName,
    parameters: options.parameters,
    isShadow: false,
  };
}

function toolResult(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  sequence: number;
  isError?: boolean;
  result?: unknown;
}): NormalizedToolResultEvent {
  return {
    eventId: `evt_result_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["result"]),
    metadata: { scenarioId: options.sessionId },
    type: "tool_result",
    callId: options.callId,
    toolName: options.toolName,
    result: options.result ?? "",
    isError: options.isError ?? false,
    executionDurationMs: 5,
    isShadow: false,
  };
}

function commandExec(options: {
  sessionId: string;
  command: string;
  sequence: number;
  exitCode?: number;
}): NormalizedCommandExecEvent {
  return {
    eventId: `evt_cmd_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 2, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["command", "args", "stdout"]),
    metadata: { scenarioId: options.sessionId },
    type: "command_exec",
    command: options.command,
    args: [],
    exitCode: options.exitCode ?? 0,
    durationMs: 5,
  };
}

function lifecycle(
  sessionId: string,
  lifecycleType: "start" | "end" | "crash",
  sequence: number,
): NormalizedSessionEvent {
  return {
    eventId: `evt_life_${lifecycleType}_${sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 3, sequence)).toISOString(),
    causalRef: causal(sequence),
    redaction: redaction(),
    metadata: { scenarioId: sessionId },
    type: "session_lifecycle",
    lifecycleType,
  };
}

function evidenceOf(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
}

function readOf(event: NormalizedSessionEvent) {
  return readComputationEvidence(evidenceOf(event));
}

// ============================================================================
// Shared fixture sources (no hand-written algorithm text)
// ============================================================================

const families = buildComputationFixtureFamilies();

function variantOf(familyId: string, kind: string): ComputationFixtureVariant {
  const family = families.find((entry) => entry.familyId === familyId);
  if (family === undefined) throw new Error(`unknown fixture family ${familyId}`);
  const variant = family.variants.find((entry) => entry.kind === kind);
  if (variant === undefined) throw new Error(`no ${kind} variant in ${familyId}`);
  return variant;
}

function argsOf(variant: ComputationFixtureVariant, callId: string): Record<string, unknown> {
  const call = collectOmpFixtureToolCalls(variant.records).find(
    (candidate) => candidate.callId === callId,
  );
  if (call === undefined) throw new Error(`no fixture call ${callId}`);
  return call.toolArguments as unknown as Record<string, unknown>;
}

function toolNameOf(variant: ComputationFixtureVariant, callId: string): string {
  const call = collectOmpFixtureToolCalls(variant.records).find(
    (candidate) => candidate.callId === callId,
  );
  if (call === undefined) throw new Error(`no fixture call ${callId}`);
  return call.toolName;
}

/** Replays one fixture call + its result through the recorder as an eval tool. */
function replayEval(
  recorder: ComputationEvidenceRecorder,
  variant: ComputationFixtureVariant,
  callId: string,
  sequence: number,
  options: { isError?: boolean } = {},
): { call: NormalizedSessionEvent; result: NormalizedSessionEvent } {
  const sessionId = variant.sessionId;
  const call = recorder.observe(
    toolCall({
      sessionId,
      callId,
      toolName: toolNameOf(variant, callId),
      parameters: argsOf(variant, callId),
      sequence,
    }),
  );
  const result = recorder.observe(
    toolResult({
      sessionId,
      callId,
      toolName: toolNameOf(variant, callId),
      sequence: sequence + 1,
      isError: options.isError,
    }),
  );
  return { call, result };
}

// ============================================================================
// Tests
// ============================================================================

describe("ComputationEvidenceRecorder", () => {
  it("attaches success evidence only to the causally matched result of a real fixture invocation", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();

    const definition = replayEval(recorder, variant, "call-join-def-v1", 1);
    // A definition-only cell is never a successful invocation, only a definition observation.
    const definitionEvidence = readOf(definition.result);
    expect(definitionEvidence).toBeDefined();
    expect(definitionEvidence?.observation.kind).toBe("definition");
    expect(definitionEvidence?.observation.status).toBe("success");
    expect(isSubstantiveComputationEvidence(definitionEvidence)).toBe(false);

    const use = replayEval(recorder, variant, "call-join-use-a-v1", 3);
    // The call snapshot is pending, and the matching success closure lands on the result.
    const pending = readOf(use.call);
    expect(pending?.observation.status).toBe("pending");
    expect(pending?.observation.resultEventId).toBeUndefined();
    expect(isSubstantiveComputationEvidence(pending)).toBe(false);

    const success = readOf(use.result);
    expect(success).toBeDefined();
    expect(success?.observation.kind).toBe("invocation");
    expect(success?.observation.status).toBe("success");
    expect(success?.observation.callId).toBe("call-join-use-a-v1");
    expect(success?.observation.resultEventId).toBe(
      (use.result as NormalizedToolResultEvent).eventId,
    );
    expect(isSubstantiveComputationEvidence(success)).toBe(true);
  });

  it("never mutates an event object it already returned", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;
    const original = toolCall({
      sessionId,
      callId: "call-join-def-v1",
      toolName: "eval",
      parameters: argsOf(variant, "call-join-def-v1"),
      sequence: 1,
    });

    const observedCall = recorder.observe(original);
    expect(evidenceOf(original)).toBeUndefined();
    const pendingBefore = readOf(observedCall);

    recorder.observe(
      toolResult({ sessionId, callId: "call-join-def-v1", toolName: "eval", sequence: 2 }),
    );

    // The emitted call snapshot still reports pending: the success closure is a distinct record.
    expect(readOf(observedCall)).toEqual(pendingBefore);
    expect(readOf(observedCall)?.observation.status).toBe("pending");
  });

  it("is idempotent when the same normalized event is replayed", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;
    const call = toolCall({
      sessionId,
      callId: "call-join-def-v1",
      toolName: "eval",
      parameters: argsOf(variant, "call-join-def-v1"),
      sequence: 1,
    });

    const first = recorder.observe(call);
    const replay = recorder.observe(call);
    expect(evidenceOf(replay)).toEqual(evidenceOf(first));

    const result = toolResult({
      sessionId,
      callId: "call-join-def-v1",
      toolName: "eval",
      sequence: 2,
    });
    const firstResult = recorder.observe(result);
    const replayedResult = recorder.observe(result);
    expect(readOf(firstResult)?.observation.status).toBe("success");
    expect(readOf(replayedResult)).toEqual(readOf(firstResult));

    // A late duplicate result cannot produce a second success closure.
    const lateResult = recorder.observe({
      ...result,
      eventId: "evt_result_call-join-def-v1_late",
      causalRef: causal(3),
    });
    expect(evidenceOf(lateResult)).toBeUndefined();
  });

  it("resolves the corrected helper version and reports a superseded digest", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const supersededCallId = variant.datasets[0]!.superseded!.invocationCallId;
    const currentCallId = variant.datasets[0]!.invocationCallId;
    const recorder = createComputationEvidenceRecorder();

    replayEval(recorder, variant, "call-join-def-v1", 1);
    const beforeCorrection = replayEval(recorder, variant, supersededCallId, 3);
    const beforeEvidence = readOf(beforeCorrection.result);
    expect(beforeEvidence).toBeDefined();
    expect(beforeEvidence?.corrections).toHaveLength(0);

    // Correct the helper, then re-run the same use cell.
    replayEval(recorder, variant, "call-join-def-v2", 5);
    const afterCorrection = replayEval(recorder, variant, currentCallId, 7);
    const afterEvidence = readOf(afterCorrection.result);

    expect(afterEvidence).toBeDefined();
    expect(afterEvidence?.observation.status).toBe("success");
    // The corrected observation is a different algorithm from the pre-correction one.
    expect(afterEvidence?.programDigest).not.toBe(beforeEvidence?.programDigest);
    // And it reports the superseded version it replaced, pointing at a materialized dependency.
    expect(afterEvidence!.corrections.length).toBeGreaterThan(0);
    expect(afterEvidence?.dependencies.length).toBeGreaterThan(0);

    // The corrected carrier resolves exactly one helper version, and every correction it reports is
    // the version that this closure replaced: never the digest it currently resolves.
    const resolvedDigests = new Set(
      afterEvidence!.dependencies.map((entry) => entry.programDigest),
    );
    expect(resolvedDigests.size).toBe(afterEvidence!.dependencies.length);
    for (const correction of afterEvidence!.corrections) {
      expect(correction.supersededProgramDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(correction.supersedesDefinitionId).toMatch(/^def[0-9]+$/);
      expect(resolvedDigests.has(correction.supersededProgramDigest)).toBe(false);
      // A correction names either a helper materialized in this closure or a definition authored by
      // this very cell (whose id is not a dependency entry).
      const supersedesAuthored = afterEvidence!.program.definitions.some(
        (definition) => definition.id === correction.supersedesDefinitionId,
      );
      expect(
        supersedesAuthored ||
          afterEvidence!.dependencies.some(
            (entry) => entry.definitionId === correction.supersedesDefinitionId,
          ),
      ).toBe(true);
    }
    // The pre-correction carrier resolves the superseded version and reports no correction yet.
    expect(beforeEvidence?.corrections).toHaveLength(0);
    expect(beforeEvidence!.dependencies.map((entry) => entry.programDigest)).toContain(
      afterEvidence!.corrections[0]!.supersededProgramDigest,
    );
  });

  it("reports the superseded digest on the defining cell that replaced a helper", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();

    // The first use cell pins the helper version that the correction later replaces.
    replayEval(recorder, variant, "call-join-def-v1", 1);
    const useV1 = replayEval(recorder, variant, "call-join-use-a-v1", 3);
    const helperDigestBefore = readOf(useV1.result)?.dependencies[0]?.programDigest;
    expect(helperDigestBefore).toMatch(/^[a-f0-9]{64}$/);

    // The defining cell that rewrites the helper reports what it superseded.
    const correcting = replayEval(recorder, variant, "call-join-def-v2", 5);
    const correctingEvidence = readOf(correcting.result);
    expect(correctingEvidence).toBeDefined();
    expect(correctingEvidence?.observation.kind).toBe("definition");
    expect(correctingEvidence?.observation.status).toBe("success");
    expect(correctingEvidence!.corrections.length).toBeGreaterThan(0);
    expect(correctingEvidence!.corrections[0]?.supersededProgramDigest).toBe(helperDigestBefore);
  });

  it("invalidates touched bindings on a failed cell so a stale helper cannot revive", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();

    // A healthy kernel first, so we can show the failure only removes what it touched.
    replayEval(recorder, variant, "call-join-def-v1", 1);
    const healthyUse = replayEval(recorder, variant, "call-join-use-a-v1", 3);
    expect(readOf(healthyUse.result)?.dependencies.length).toBeGreaterThan(0);

    // A cell that rebinds the helper with a corrected definition fails.
    const failed = replayEval(recorder, variant, "call-join-def-v2", 5, { isError: true });
    const failedEvidence = readOf(failed.result);
    expect(failedEvidence?.observation.status).toBe("error");
    expect(isSubstantiveComputationEvidence(failedEvidence)).toBe(false);

    // The failed rebinding was discarded, so the next use cell resolves no helper version at all
    // rather than reviving the pre-failure or the half-applied version.
    const afterFailure = replayEval(recorder, variant, "call-join-use-b-v1", 7);
    const afterEvidence = readOf(afterFailure.result);
    expect(afterEvidence).toBeDefined();
    expect(afterEvidence?.observation.status).toBe("success");
    expect(afterEvidence?.dependencies).toHaveLength(0);
  });

  it("does not pair a reused call id optimistically", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;
    const callId = "call-reused";

    recorder.observe(
      toolCall({
        sessionId,
        callId,
        toolName: "eval",
        parameters: argsOf(variant, "call-join-def-v1"),
        sequence: 1,
      }),
    );
    // A second, different unresolved call reusing the id makes both unpairable.
    recorder.observe(
      toolCall({
        sessionId,
        callId,
        toolName: "eval",
        parameters: argsOf(variant, "call-join-def-v2"),
        sequence: 2,
      }),
    );
    // Neither the pending snapshot nor the result pairs: the reuse made the id unpairable.
    const result = recorder.observe(
      toolResult({ sessionId, callId, toolName: "eval", sequence: 3 }),
    );
    expect(evidenceOf(result)).toBeUndefined();
  });

  it("ignores missing, mismatched and unknown-id results", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;

    recorder.observe(
      toolCall({
        sessionId,
        callId: "call-x",
        toolName: "eval",
        parameters: argsOf(variant, "call-join-def-v1"),
        sequence: 1,
      }),
    );

    // Wrong tool name, wrong call id, and a result that precedes its call are all ignored.
    expect(
      evidenceOf(
        recorder.observe(
          toolResult({ sessionId, callId: "call-x", toolName: "bash", sequence: 2 }),
        ),
      ),
    ).toBeUndefined();
    expect(
      evidenceOf(
        recorder.observe(
          toolResult({ sessionId, callId: "call-unknown", toolName: "eval", sequence: 3 }),
        ),
      ),
    ).toBeUndefined();
    expect(
      evidenceOf(
        recorder.observe(
          toolResult({ sessionId, callId: "call-x", toolName: "eval", sequence: 4 }),
        ),
      ),
    ).toBeDefined();
  });

  it("keeps a persistent eval kernel across cells but never across a shell interpreter process", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;

    // A persistent eval kernel shares the helper with a later cell.
    replayEval(recorder, variant, "call-join-def-v1", 1);
    const shared = replayEval(recorder, variant, variant.datasets[0]!.invocationCallId, 3);
    expect(readOf(shared.result)?.dependencies.length).toBeGreaterThan(0);

    // An isolated `python -c` process resolves nothing from that kernel, even for the same code.
    // A safely delimited inline program: the framer recovers it, but as a fresh isolated process.
    const useCode = "rows = [1, 2, 3]; print(len(rows))";
    const isolated = recorder.observe(
      commandExec({ sessionId, command: `python3 -c '${useCode}'`, sequence: 5 }),
    );
    const isolatedEvidence = readOf(isolated);
    expect(isolatedEvidence).toBeDefined();
    expect(isolatedEvidence?.observation.kind).toBe("invocation");
    expect(isolatedEvidence?.observation.status).toBe("success");
    expect(isolatedEvidence?.dependencies).toHaveLength(0);

    // A failing isolated process is an error observation and never substantive.
    const failedIsolated = recorder.observe(
      commandExec({
        sessionId,
        command: `python3 -c '${useCode}'`,
        sequence: 6,
        exitCode: 1,
      }),
    );
    expect(readOf(failedIsolated)?.observation.status).toBe("error");
    expect(isSubstantiveComputationEvidence(readOf(failedIsolated))).toBe(false);
  });

  it("clears kernel state on session termination", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;

    replayEval(recorder, variant, "call-join-def-v1", 1);
    recorder.observe(lifecycle(sessionId, "end", 3));

    const afterEnd = replayEval(recorder, variant, variant.datasets[0]!.invocationCallId, 4);
    expect(readOf(afterEnd.result)?.dependencies).toHaveLength(0);
  });

  it("never promotes an authored file body to a successful invocation of its own text", () => {
    const joinVariant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = joinVariant.sessionId;
    // Fixture-owned helper source, authored to a file whose text also calls the helper at module level.
    const body = `${joinVariant.supersededDefinitionSource}\njoin_records([], {}, {})\n`;

    const write = recorder.observe(
      toolCall({
        sessionId,
        callId: "call-write-script",
        toolName: "write",
        parameters: { path: "tools/join.py", content: body },
        sequence: 1,
      }),
    );
    const writeResult = recorder.observe(
      toolResult({
        sessionId,
        callId: "call-write-script",
        toolName: "write",
        sequence: 2,
        result: "Wrote tools/join.py",
      }),
    );

    const observed = readOf(writeResult) ?? readOf(write);
    expect(observed).toBeDefined();
    // Observing a file body is never an invocation, however its text reads.
    expect(observed?.observation.kind).toBe("definition");
    expect(observed?.origin.kind).toBe("authored_file");
    expect(isSubstantiveComputationEvidence(observed)).toBe(false);
    expect(observed?.observation.status).toBe("success");
  });

  it("retains no raw identifier, literal value or canary in a carrier", () => {
    const family = families.find((entry) => entry.familyId === "record-join-lineage")!;
    const variant = family.variants[0]!;
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;

    replayEval(recorder, variant, "call-join-def-v1", 1);
    const use = replayEval(recorder, variant, variant.datasets[0]!.invocationCallId, 3);

    const evidence = readOf(use.result);
    expect(evidence).toBeDefined();
    const serialized = JSON.stringify(evidence);
    expect(evidence?.version).toBe(COMPUTATION_IR_VERSION);
    expect(evidence?.analysisOnly).toBe(true);
    // No raw local identifier, no arbitrary literal payload and no canary reaches the wire. Safe
    // structural key selection may be preserved, but never the values or the source text itself.
    for (const leaked of [
      "join_records",
      "by_owner",
      "missing_owners",
      "_emit",
      "_DATA",
      "record.get",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    for (const canary of [family.canaries[0]!, ...variant.datasets[0]!.canaries]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain(variant.datasets[0]!.expected.stdout);
  });

  it("evicts the oldest unresolved call instead of exceeding the pending bound", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder({ maxPendingCalls: 2 });
    const sessionId = variant.sessionId;

    for (const [index, callId] of ["call-a", "call-b", "call-c"].entries()) {
      recorder.observe(
        toolCall({
          sessionId,
          callId,
          toolName: "eval",
          parameters: argsOf(variant, "call-join-def-v1"),
          sequence: index + 1,
        }),
      );
    }

    // The oldest call was evicted, so its late result cannot pair.
    expect(
      evidenceOf(
        recorder.observe(
          toolResult({ sessionId, callId: "call-a", toolName: "eval", sequence: 4 }),
        ),
      ),
    ).toBeUndefined();
    expect(
      evidenceOf(
        recorder.observe(
          toolResult({ sessionId, callId: "call-c", toolName: "eval", sequence: 5 }),
        ),
      ),
    ).toBeDefined();
  });

  it("evicts older session state rather than exceeding the session bound", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder({ maxSessions: 1 });
    const sessionId = variant.sessionId;
    const otherSession = "sess_other";

    replayEval(recorder, variant, "call-join-def-v1", 1);
    // Touching a new session evicts the previous session's kernel.
    recorder.observe(
      toolCall({
        sessionId: otherSession,
        callId: "call-other",
        toolName: "eval",
        parameters: argsOf(variant, "call-join-def-v1"),
        sequence: 3,
      }),
    );

    const evicted = replayEval(recorder, variant, variant.datasets[0]!.invocationCallId, 4);
    expect(readOf(evicted.result)?.dependencies).toHaveLength(0);
  });

  it("drops every session's retained state on clear()", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = new ComputationEvidenceRecorder();

    replayEval(recorder, variant, "call-join-def-v1", 1);
    recorder.clear();

    const afterClear = replayEval(recorder, variant, variant.datasets[0]!.invocationCallId, 3);
    expect(readOf(afterClear.result)?.dependencies).toHaveLength(0);
  });

  it("returns the same event unchanged when no bounded evidence applies", () => {
    const recorder = createComputationEvidenceRecorder();
    const message: NormalizedSessionEvent = {
      eventId: "evt_message_1",
      schemaVersion: SCHEMA_VERSION,
      sessionId: "sess_no_evidence",
      timestamp: new Date().toISOString(),
      causalRef: causal(1),
      redaction: redaction(),
      metadata: { scenarioId: "sess_no_evidence" },
      type: "message",
      role: "assistant",
      content: "text",
    };
    expect(recorder.observe(message)).toBe(message);
  });

  it("keeps secret-like source values and key names out of a carrier", () => {
    const recorder = createComputationEvidenceRecorder();
    const secretValue = "sk_live_CANARY_SOURCE_SECRET_9f31";
    const code = [`authToken = "${secretValue}"`, "rows = [1, 2, 3]", "print(len(rows))", ""].join(
      "\n",
    );

    const call = recorder.observe(
      toolCall({
        sessionId: "sess_recorder_secret",
        callId: "call-secret",
        toolName: "eval",
        parameters: { language: "python", code },
        sequence: 1,
      }),
    );
    const result = recorder.observe(
      toolResult({
        sessionId: "sess_recorder_secret",
        callId: "call-secret",
        toolName: "eval",
        sequence: 2,
      }),
    );

    const evidence = readOf(result) ?? readOf(call);
    expect(evidence).toBeDefined();
    const serialized = JSON.stringify(evidence);
    // The literal value never egresses, and the secret-like key is captured as a field slot rather
    // than preserved as a structural name.
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("authToken");
    expect(serialized).not.toContain("sk_live");
  });
});
