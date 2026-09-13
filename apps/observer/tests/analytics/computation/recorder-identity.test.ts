import {
  ComputationProgramV1Schema,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  readComputationEvidence,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type ComputationEvidenceRecorder,
  createComputationEvidenceRecorder,
} from "../../../src/analytics/computation/recorder.js";

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
  eventId?: string;
}): NormalizedToolCallEvent {
  return {
    eventId:
      options.eventId ?? `evt_call_${options.sessionId}_${options.callId}_${options.sequence}`,
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
  result?: unknown;
  isError?: boolean;
  eventId?: string;
}): NormalizedSessionEvent {
  return {
    eventId:
      options.eventId ?? `evt_result_${options.sessionId}_${options.callId}_${options.sequence}`,
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
  } as NormalizedSessionEvent;
}

function evalCall(options: {
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  eventId?: string;
}): NormalizedToolCallEvent {
  return toolCall({
    sessionId: options.sessionId,
    callId: options.callId,
    toolName: "eval",
    parameters: { language: "python", code: options.code },
    sequence: options.sequence,
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
  });
}

function evidenceOf(event: NormalizedSessionEvent): unknown {
  return event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
}

function readOf(event: NormalizedSessionEvent): ResinComputationEvidenceV1 | undefined {
  return readComputationEvidence(evidenceOf(event));
}

function expectEvidence(event: NormalizedSessionEvent): ResinComputationEvidenceV1 {
  const evidence = readOf(event);
  expect(evidence).toBeDefined();
  if (evidence === undefined) {
    throw new Error("expected computation evidence");
  }
  const parsed = ComputationProgramV1Schema.safeParse(evidence.program);
  if (!parsed.success) {
    throw new Error(
      `program did not validate: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | ")}`,
    );
  }
  return evidence;
}

function observeEval(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  code: string;
  sequence: number;
  isError?: boolean;
}) {
  options.recorder.observe(
    evalCall({
      sessionId: options.sessionId,
      callId: options.callId,
      code: options.code,
      sequence: options.sequence,
    }),
  );
  const result = options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "eval",
      sequence: options.sequence + 1,
      isError: options.isError,
    }),
  );
  return { result, evidence: readOf(result) };
}

function observeWrite(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  path: string;
  content: string;
  sequence: number;
  isError?: boolean;
}) {
  options.recorder.observe(
    toolCall({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "write",
      parameters: { path: options.path, content: options.content },
      sequence: options.sequence,
    }),
  );
  const result = options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "write",
      sequence: options.sequence + 1,
      isError: options.isError,
    }),
  );
  return { result, evidence: readOf(result) };
}

function observeReadTextPair(options: {
  recorder: ComputationEvidenceRecorder;
  sessionId: string;
  callId: string;
  sequence: number;
}) {
  options.recorder.observe(
    toolCall({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "read",
      parameters: { path: `notes/${options.callId}.txt` },
      sequence: options.sequence,
    }),
  );
  return options.recorder.observe(
    toolResult({
      sessionId: options.sessionId,
      callId: options.callId,
      toolName: "read",
      result: `plain text ${options.callId}`,
      sequence: options.sequence + 1,
    }),
  );
}

describe("ComputationEvidenceRecorder identity safety", () => {
  it("keys replay memoization by session as well as event id", () => {
    const recorder = createComputationEvidenceRecorder();

    const first = recorder.observe(
      evalCall({
        sessionId: "same-event-a",
        callId: "print-answer-a",
        code: "print(6 * 7)\n",
        sequence: 1,
        eventId: "shared-event-id",
      }),
    );
    const firstEvidence = expectEvidence(first);
    expect(firstEvidence.observation.status).toBe("pending");
    expect(firstEvidence.program.outputs.length).toBeGreaterThan(0);

    const second = recorder.observe(
      evalCall({
        sessionId: "same-event-b",
        callId: "print-answer-b",
        code: "print(7 * 7)\n",
        sequence: 1,
        eventId: "shared-event-id",
      }),
    );
    const secondEvidence = expectEvidence(second);
    expect(secondEvidence.observation.status).toBe("pending");
    expect(secondEvidence.program.outputs.length).toBeGreaterThan(0);
    expect(secondEvidence.origin.sourceEventId).toBe("shared-event-id");
    expect(secondEvidence.programDigest).not.toBe(firstEvidence.programDigest);
  });

  it("keeps consumed call ids poisoned after more than the pending-call window later settles", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "consumed-poison-history";

    const consumed = observeEval({
      recorder,
      sessionId,
      callId: "already-consumed",
      code: "print(20 + 22)\n",
      sequence: 1,
    });
    const consumedEvidence = expectEvidence(consumed.result);
    expect(consumedEvidence.observation.status).toBe("success");
    expect(consumedEvidence.program.outputs.length).toBeGreaterThan(0);

    for (let index = 0; index < 65; index += 1) {
      const later = observeEval({
        recorder,
        sessionId,
        callId: `later-settled-${index}`,
        code: `print(${index} + 1)\n`,
        sequence: 3 + index * 2,
      });
      expect(later.evidence?.observation.status).toBe("success");
    }

    const replayedCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "already-consumed",
        code: "print(999 + 1)\n",
        sequence: 200,
        eventId: "replayed-consumed-call",
      }),
    );
    expect(evidenceOf(replayedCall)).toBeUndefined();

    const replayedResult = recorder.observe(
      toolResult({
        sessionId,
        callId: "already-consumed",
        toolName: "eval",
        sequence: 201,
        eventId: "replayed-consumed-result",
      }),
    );
    expect(evidenceOf(replayedResult)).toBeUndefined();
  });

  it("disables matching at the consumed-id bound instead of forgetting older identities", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "consumed-bound-disable";

    for (let index = 0; index < 4_097; index += 1) {
      const result = observeReadTextPair({
        recorder,
        sessionId,
        callId: `cheap-text-read-${index}`,
        sequence: index * 2 + 1,
      });
      expect(evidenceOf(result)).toBeUndefined();
    }

    const afterBoundCall = recorder.observe(
      evalCall({
        sessionId,
        callId: "valid-after-bound",
        code: "print(100 + 23)\n",
        sequence: 10_000,
      }),
    );
    expect(evidenceOf(afterBoundCall)).toBeUndefined();

    const afterBoundResult = recorder.observe(
      toolResult({
        sessionId,
        callId: "valid-after-bound",
        toolName: "eval",
        sequence: 10_001,
      }),
    );
    expect(evidenceOf(afterBoundResult)).toBeUndefined();
  });

  it("preserves import-only context through helper resolution and invalidates failed import overwrites", () => {
    const recorder = createComputationEvidenceRecorder();
    const sessionId = "persistent-import-identity";

    const moduleWrite = observeWrite({
      recorder,
      sessionId,
      callId: "write-math-helpers",
      path: "math_helpers.py",
      content: "def scale_value(value):\n    return value * 10\n",
      sequence: 1,
    });
    const moduleEvidence = expectEvidence(moduleWrite.result);
    expect(moduleEvidence.observation.status).toBe("success");

    const importOnly = observeEval({
      recorder,
      sessionId,
      callId: "import-scale-alias",
      code: "from math_helpers import scale_value as scale\n",
      sequence: 3,
    });
    const importEvidence = expectEvidence(importOnly.result);
    expect(importEvidence.observation.status).toBe("success");
    expect(importEvidence.program.outputs).toHaveLength(0);

    const dependentHelper = observeEval({
      recorder,
      sessionId,
      callId: "define-dependent-helper",
      code: "def scaled_total(value):\n    return scale(value) + 1\n",
      sequence: 5,
    });
    const dependentHelperEvidence = expectEvidence(dependentHelper.result);
    expect(dependentHelperEvidence.observation.status).toBe("success");
    expect(dependentHelperEvidence.observation.kind).toBe("definition");

    const unrelatedHelper = observeEval({
      recorder,
      sessionId,
      callId: "define-unrelated-helper",
      code: "def unrelated_total(value):\n    return value - 3\n",
      sequence: 7,
    });
    const unrelatedHelperEvidence = expectEvidence(unrelatedHelper.result);
    expect(unrelatedHelperEvidence.observation.status).toBe("success");

    const beforeFailedImportOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-dependent-before-failed-import-overwrite",
      code: "print(scaled_total(4))\n",
      sequence: 9,
    });
    const beforeEvidence = expectEvidence(beforeFailedImportOverwrite.result);
    expect(beforeEvidence.observation.status).toBe("success");
    expect(beforeEvidence.program.complete).toBe(true);
    expect(beforeEvidence.program.outputs.length).toBeGreaterThan(0);
    expect(beforeEvidence.dependencies.map((dependency) => dependency.sourceEventId)).toEqual(
      expect.arrayContaining([moduleWrite.result.eventId, dependentHelper.result.eventId]),
    );

    const failedImportOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "failed-import-overwrite",
      code: "from broken_helpers import scale_value as scale\n",
      sequence: 11,
      isError: true,
    });
    const failedEvidence = expectEvidence(failedImportOverwrite.result);
    expect(failedEvidence.observation.status).toBe("error");

    // The failed import overwrite is targeted: it drops the stale import binding but must not erase
    // unrelated persistent helpers. The unresolved dependent invocation below is intentionally later,
    // because committing an unknown invocation conservatively clears the persistent kernel.
    const unrelatedUse = observeEval({
      recorder,
      sessionId,
      callId: "use-unrelated-after-failed-import-overwrite",
      code: "print(unrelated_total(10))\n",
      sequence: 13,
    });
    const unrelatedUseEvidence = expectEvidence(unrelatedUse.result);
    expect(unrelatedUseEvidence.observation.status).toBe("success");
    expect(unrelatedUseEvidence.program.complete).toBe(true);
    expect(unrelatedUseEvidence.program.outputs.length).toBeGreaterThan(0);
    expect(
      unrelatedUseEvidence.dependencies.map((dependency) => dependency.sourceEventId),
    ).toContain(unrelatedHelper.result.eventId);

    const afterFailedImportOverwrite = observeEval({
      recorder,
      sessionId,
      callId: "use-dependent-after-failed-import-overwrite",
      code: "print(scaled_total(5))\n",
      sequence: 15,
    });
    const afterEvidence = expectEvidence(afterFailedImportOverwrite.result);
    expect(afterEvidence.observation.status).toBe("success");
    expect(afterEvidence.program.complete).toBe(false);
    expect(afterEvidence.dependencies.map((dependency) => dependency.sourceEventId)).not.toContain(
      moduleWrite.result.eventId,
    );
  });
});
