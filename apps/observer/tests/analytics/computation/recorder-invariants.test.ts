import {
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
  type ComputationEvidenceRecorder,
  createComputationEvidenceRecorder,
} from "../../../src/analytics/computation/recorder.js";

const SCHEMA_VERSION = "1.0.0" as const;
const families = buildComputationFixtureFamilies();

function causal(sequence: number): NormalizedSessionEvent["causalRef"] {
  return { parentId: null, causalSequence: sequence };
}

function redaction(
  fields: string[] = [],
  scrubbedPatterns: string[] = [],
): NormalizedSessionEvent["redaction"] {
  return {
    isRedacted: fields.length > 0 || scrubbedPatterns.length > 0,
    redactedFields: fields,
    redactionStrategy: fields.length > 0 || scrubbedPatterns.length > 0 ? "drop" : "none",
    scrubbedPatterns,
  };
}

function toolCall(options: {
  sessionId: string;
  callId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  sequence: number;
  eventId?: string;
  scrubbedPatterns?: string[];
}): NormalizedToolCallEvent {
  return {
    eventId: options.eventId ?? `evt_call_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, options.sequence)).toISOString(),
    causalRef: causal(options.sequence),
    redaction: redaction(["parameters"], options.scrubbedPatterns ?? []),
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
  eventId?: string;
  causalSequence?: number;
}): NormalizedToolResultEvent {
  return {
    eventId: options.eventId ?? `evt_result_${options.callId}_${options.sequence}`,
    schemaVersion: SCHEMA_VERSION,
    sessionId: options.sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, options.sequence)).toISOString(),
    causalRef: causal(options.causalSequence ?? options.sequence),
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
  eventId?: string;
}): NormalizedCommandExecEvent {
  return {
    eventId: options.eventId ?? `evt_cmd_${options.sequence}`,
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

function evidenceOf(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
}

function readOf(event: NormalizedSessionEvent) {
  return readComputationEvidence(evidenceOf(event));
}

function variantOf(familyId: string, kind: string): ComputationFixtureVariant {
  const family = families.find((entry) => entry.familyId === familyId);
  if (family === undefined) {
    throw new Error(`unknown fixture family ${familyId}`);
  }
  const variant = family.variants.find((entry) => entry.kind === kind);
  if (variant === undefined) {
    throw new Error(`no ${kind} variant in ${familyId}`);
  }
  return variant;
}

function argsOf(variant: ComputationFixtureVariant, callId: string): Record<string, unknown> {
  const call = collectOmpFixtureToolCalls(variant.records).find(
    (candidate) => candidate.callId === callId,
  );
  if (call === undefined) {
    throw new Error(`no fixture call ${callId}`);
  }
  return call.toolArguments as Record<string, unknown>;
}

function toolNameOf(variant: ComputationFixtureVariant, callId: string): string {
  const call = collectOmpFixtureToolCalls(variant.records).find(
    (candidate) => candidate.callId === callId,
  );
  if (call === undefined) {
    throw new Error(`no fixture call ${callId}`);
  }
  return call.toolName;
}

function evalCall(options: {
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  reset?: boolean;
  scrubbedPatterns?: string[];
}): NormalizedToolCallEvent {
  return toolCall({
    sessionId: options.sessionId,
    callId: options.callId,
    toolName: "eval",
    parameters: {
      language: "python",
      code: options.code,
      ...(options.reset === true ? { reset: true } : {}),
    },
    sequence: options.sequence,
    ...(options.scrubbedPatterns === undefined
      ? {}
      : { scrubbedPatterns: options.scrubbedPatterns }),
  });
}

function observeEval(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  result?: unknown;
  isError?: boolean;
  reset?: boolean;
}) {
  const call = options.recorder.observe(
    evalCall({
      sessionId: options.sessionId,
      callId: options.callId,
      code: options.code,
      sequence: options.sequence,
      ...(options.reset === true ? { reset: true } : {}),
    }),
  );
  const result = options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "eval",
      sequence: options.sequence + 1,
      ...(options.result === undefined ? {} : { result: options.result }),
      ...(options.isError === undefined ? {} : { isError: options.isError }),
    }),
  );
  return { call, result, evidence: readOf(result) };
}

describe("ComputationEvidenceRecorder invariants", () => {
  it("requires distinct result identity and strictly later causality before pairing", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const sessionId = variant.sessionId;
    const callId = "call-join-def-v1";
    const toolName = toolNameOf(variant, callId);

    const call = recorder.observe(
      toolCall({
        sessionId,
        callId,
        toolName,
        parameters: argsOf(variant, callId),
        sequence: 1,
      }),
    );
    expect(readOf(call)?.observation.status).toBe("pending");

    const sameEventIdResult = recorder.observe(
      toolResult({
        sessionId,
        callId,
        toolName,
        sequence: 2,
        eventId: call.eventId,
      }),
    );
    expect(evidenceOf(sameEventIdResult)).toBeUndefined();

    const equalSequenceResult = recorder.observe(
      toolResult({
        sessionId,
        callId,
        toolName,
        sequence: 3,
        causalSequence: 1,
      }),
    );
    expect(evidenceOf(equalSequenceResult)).toBeUndefined();

    const matched = recorder.observe(
      toolResult({ sessionId, callId, toolName, sequence: 4, result: "" }),
    );
    const matchedEvidence = readOf(matched);
    expect(matchedEvidence?.observation.status).toBe("success");
    expect(matchedEvidence?.observation.callEventId).toBe(call.eventId);
    expect(matchedEvidence?.observation.resultEventId).toBe(matched.eventId);

    const replayedResult = recorder.observe(
      toolResult({ sessionId, callId, toolName, sequence: 5, result: "" }),
    );
    expect(evidenceOf(replayedResult)).toBeUndefined();
  });

  it("rejects a settled callId reused by a later call/result pair", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "settled-reuse";
    const first = observeEval({
      recorder,
      sessionId,
      callId: "cell-1",
      code: "def double(value):\n    return value * 2\n",
      sequence: 1,
    });
    expect(first.evidence?.observation.status).toBe("success");

    const reusedCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "cell-1",
        code: "answer = double(21)\n",
        sequence: 3,
      }),
    );
    expect(evidenceOf(reusedCall)).toBeUndefined();

    const reusedResult = recorder.observe(
      toolResult({ sessionId, callId: "cell-1", toolName: "eval", sequence: 4 }),
    );
    expect(evidenceOf(reusedResult)).toBeUndefined();
  });

  it("poisons an unresolved callId collision and rejects a third reuse", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "unresolved-collision";

    const firstCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "cell-collision",
        code: "def first(value):\n    return value + 1\n",
        sequence: 1,
      }),
    );
    expect(readOf(firstCall)?.observation.status).toBe("pending");

    const secondCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "cell-collision",
        code: "def second(value):\n    return value + 2\n",
        sequence: 2,
      }),
    );
    expect(evidenceOf(secondCall)).toBeUndefined();

    const lateFirstResult = recorder.observe(
      toolResult({ sessionId, callId: "cell-collision", toolName: "eval", sequence: 3 }),
    );
    expect(evidenceOf(lateFirstResult)).toBeUndefined();

    const thirdCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "cell-collision",
        code: "answer = first(1)\n",
        sequence: 4,
      }),
    );
    expect(evidenceOf(thirdCall)).toBeUndefined();

    const thirdResult = recorder.observe(
      toolResult({ sessionId, callId: "cell-collision", toolName: "eval", sequence: 5 }),
    );
    expect(evidenceOf(thirdResult)).toBeUndefined();
  });

  it("does not revive an evicted pending call when its result arrives late", () => {
    const recorder = createComputationEvidenceRecorder({ maxPendingCalls: 1 });
    const sessionId = "late-success-after-pending-eviction";

    const evictedCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "old-pending",
        code: "def old_helper(value):\n    return value + 1\n",
        sequence: 1,
      }),
    );
    expect(readOf(evictedCall)?.observation.status).toBe("pending");

    const survivorCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "new-pending",
        code: "def new_helper(value):\n    return value + 2\n",
        sequence: 2,
      }),
    );
    expect(readOf(survivorCall)?.observation.status).toBe("pending");

    const lateOldResult = recorder.observe(
      toolResult({ sessionId, callId: "old-pending", toolName: "eval", sequence: 3 }),
    );
    expect(evidenceOf(lateOldResult)).toBeUndefined();

    const survivorResult = recorder.observe(
      toolResult({ sessionId, callId: "new-pending", toolName: "eval", sequence: 4 }),
    );
    expect(readOf(survivorResult)?.observation.status).toBe("success");
  });

  it("records successful atomic command_exec events and rejects nonzero command exits", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "atomic-command";

    const success = recorder.observe(
      commandExec({
        sessionId,
        command: "python3 -c 'print(6 * 7)'",
        sequence: 1,
      }),
    );
    const successEvidence = readOf(success);
    expect(successEvidence).toBeDefined();
    expect(successEvidence?.observation.callEventId).toBe(success.eventId);
    expect(successEvidence?.observation.resultEventId).toBe(success.eventId);
    expect(successEvidence?.observation.callId).toBe(success.eventId);
    expect(successEvidence?.observation.status).toBe("success");
    expect(isSubstantiveComputationEvidence(successEvidence)).toBe(true);

    const failed = recorder.observe(
      commandExec({
        sessionId,
        command: "python3 -c 'raise SystemExit(1)'",
        sequence: 2,
        exitCode: 1,
      }),
    );
    expect(readOf(failed)?.observation.status).toBe("error");
  });

  it("treats explicit nonzero native result exit codes as failures even with isError false", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "native-exit-codes";

    recorder.observe(
      evalCall({
        sessionId,
        callId: "top-level-exit",
        code: "def top_level(value):\n    return value * 2\n",
        sequence: 1,
      }),
    );
    const failedTop = recorder.observe(
      toolResult({
        sessionId,
        callId: "top-level-exit",
        toolName: "eval",
        sequence: 2,
        isError: false,
        result: { exitCode: 4, stdout: "" },
      }),
    );
    expect(readOf(failedTop)?.observation.status).toBe("error");

    recorder.observe(
      evalCall({
        sessionId,
        callId: "nested-exit",
        code: "def nested(value):\n    return value * 3\n",
        sequence: 3,
      }),
    );
    const failedNested = recorder.observe(
      toolResult({
        sessionId,
        callId: "nested-exit",
        toolName: "eval",
        sequence: 4,
        isError: false,
        result: { details: { exitCode: 7 }, stdout: "" },
      }),
    );
    expect(readOf(failedNested)?.observation.status).toBe("error");

    recorder.observe(
      evalCall({
        sessionId,
        callId: "zero-exit",
        code: "def okay(value):\n    return value - 1\n",
        sequence: 5,
      }),
    );
    const acceptedZero = recorder.observe(
      toolResult({
        sessionId,
        callId: "zero-exit",
        toolName: "eval",
        sequence: 6,
        isError: false,
        result: { details: { exitCode: 0 }, stdout: "" },
      }),
    );
    expect(readOf(acceptedZero)?.observation.status).toBe("success");
  });

  it("reset plus truncation rejection clears stale persistent helper state", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "reset-truncation";

    const helper = observeEval({
      recorder,
      sessionId,
      callId: "define-helper",
      code: "def retained_helper(value):\n    return value + 10\n",
      sequence: 1,
    });
    expect(helper.evidence?.observation.status).toBe("success");

    const beforeReset = observeEval({
      recorder,
      sessionId,
      callId: "use-before-reset",
      code: "answer = retained_helper(5)\n",
      sequence: 3,
    });
    expect(beforeReset.evidence?.dependencies).toHaveLength(1);

    const rejectedResetCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "reset-with-truncated-body",
        code: "def retained_helper(value):\n    return value + 99\n... [TRUNCATED 100 chars]",
        reset: true,
        scrubbedPatterns: ["truncation:parameters.code"],
        sequence: 5,
      }),
    );
    expect(evidenceOf(rejectedResetCall)).toBeUndefined();
    const rejectedResetResult = recorder.observe(
      toolResult({ sessionId, callId: "reset-with-truncated-body", toolName: "eval", sequence: 6 }),
    );
    expect(evidenceOf(rejectedResetResult)).toBeUndefined();

    const afterReset = observeEval({
      recorder,
      sessionId,
      callId: "use-after-reset",
      code: "answer = retained_helper(5)\n",
      sequence: 7,
    });
    expect(afterReset.evidence?.observation.status).toBe("success");
    expect(afterReset.evidence?.dependencies).toHaveLength(0);
  });

  it("invalidates observed importable helper files on failed overwrite", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "import-helper-overwrite";
    const path = "imported_helper.py";

    recorder.observe(
      toolCall({
        sessionId,
        callId: "write-imported-helper",
        toolName: "write",
        parameters: {
          path,
          content: "def imported_helper(value):\n    return value + 1\n",
        },
        sequence: 1,
      }),
    );
    const writeResult = recorder.observe(
      toolResult({ sessionId, callId: "write-imported-helper", toolName: "write", sequence: 2 }),
    );
    expect(readOf(writeResult)?.observation.status).toBe("success");

    const beforeFailedOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-imported-helper-before-failure",
      code: "from imported_helper import imported_helper\nanswer = imported_helper(2)\n",
      sequence: 3,
    });
    expect(beforeFailedOverwrite.evidence?.dependencies).toHaveLength(1);

    recorder.observe(
      toolCall({
        sessionId,
        callId: "failed-imported-helper-overwrite",
        toolName: "write",
        parameters: {
          path,
          content: "def imported_helper(value):\n    return value + 99\n",
        },
        sequence: 5,
      }),
    );
    const failedWrite = recorder.observe(
      toolResult({
        sessionId,
        callId: "failed-imported-helper-overwrite",
        toolName: "write",
        sequence: 6,
        isError: true,
      }),
    );
    expect(readOf(failedWrite)?.observation.status).toBe("error");

    const afterFailedOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-imported-helper-after-failure",
      code: "from imported_helper import imported_helper\nanswer = imported_helper(2)\n",
      sequence: 7,
    });
    expect(afterFailedOverwrite.evidence?.observation.status).toBe("success");
    expect(afterFailedOverwrite.evidence?.dependencies).toHaveLength(0);
  });

  it("invalidates helpers on failed overwrite and drops them on successful non-definition overwrite", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "helper-overwrite";

    const original = observeEval({
      recorder,
      sessionId,
      callId: "define-transform",
      code: "def transform(value):\n    return value + 1\n",
      sequence: 1,
    });
    expect(original.evidence?.observation.status).toBe("success");

    const beforeOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-before-failed-overwrite",
      code: "answer = transform(1)\n",
      sequence: 3,
    });
    expect(beforeOverwrite.evidence?.dependencies).toHaveLength(1);

    const failedOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "failed-transform-overwrite",
      code: "def transform(value):\n    return value + 100\n",
      sequence: 5,
      isError: true,
    });
    expect(failedOverwrite.evidence?.observation.status).toBe("error");

    const afterFailedOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-after-failed-overwrite",
      code: "answer = transform(1)\n",
      sequence: 7,
    });
    expect(afterFailedOverwrite.evidence?.observation.status).toBe("success");
    expect(afterFailedOverwrite.evidence?.dependencies).toHaveLength(0);

    const redefined = observeEval({
      recorder,
      sessionId,
      callId: "redefine-transform",
      code: "def transform(value):\n    return value + 2\n",
      sequence: 9,
    });
    expect(redefined.evidence?.observation.status).toBe("success");

    const beforeNonDefinition = observeEval({
      recorder,
      sessionId,
      callId: "use-before-non-definition",
      code: "answer = transform(1)\n",
      sequence: 11,
    });
    expect(beforeNonDefinition.evidence?.dependencies).toHaveLength(1);

    const nonDefinitionOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "successful-non-definition-overwrite",
      code: "transform = 42\n",
      sequence: 13,
    });
    expect(nonDefinitionOverwrite.evidence?.observation.status).toBe("success");

    const afterNonDefinition = observeEval({
      recorder,
      sessionId,
      callId: "use-after-non-definition",
      code: "answer = transform\n",
      sequence: 15,
    });
    expect(afterNonDefinition.evidence?.observation.status).toBe("success");
    expect(afterNonDefinition.evidence?.dependencies).toHaveLength(0);
  });

  it("does not promote an assigned helper result without observable output", () => {
    const recorder = createComputationEvidenceRecorder();
    const assigned = observeEval({
      recorder,
      sessionId: "unobserved-assignment",
      callId: "assigned-only",
      code: "def compute(value):\n    return value * 2\nanswer = compute(21)\n",
      sequence: 1,
    });
    expect(assigned.evidence?.observation.kind).toBe("invocation");
    expect(assigned.evidence?.observation.status).toBe("success");
    expect(assigned.evidence?.program.complete).toBe(true);
    expect(
      assigned.evidence?.program.outputs.every((output) => output.definitionId !== undefined),
    ).toBe(true);
    expect(isSubstantiveComputationEvidence(assigned.evidence)).toBe(false);
  });
});
