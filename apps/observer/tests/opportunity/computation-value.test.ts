import {
  type ComputationEvidenceBody,
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  computeComputationEvidenceDigest,
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
} from "../../src/analytics/computation/recorder.js";
import { deriveEstimatedSavedWork, evaluateRightSizing } from "../../src/opportunity/saved-work.js";
import type { WorkflowCluster } from "../../src/opportunity/types.js";

const SCHEMA_VERSION = "1.0.0" as const;
const families = buildComputationFixtureFamilies();

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
    result: "",
    isError: options.isError ?? false,
    executionDurationMs: 5,
    isShadow: false,
  };
}

function replayEval(
  recorder: ComputationEvidenceRecorder,
  variant: ComputationFixtureVariant,
  callId: string,
  sequence: number,
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
    }),
  );
  return { call, result };
}

function evidenceOf(event: NormalizedSessionEvent): ResinComputationEvidenceV1 | undefined {
  return readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]);
}

function fixtureEvidence(): {
  evidence: ResinComputationEvidenceV1;
  pending: ResinComputationEvidenceV1 | undefined;
} {
  const variant = variantOf("record-join-lineage", "corrected-helper");
  const recorder = createComputationEvidenceRecorder();
  replayEval(recorder, variant, "call-join-def-v2", 1);
  const replay = replayEval(recorder, variant, "call-join-use-a-v2", 3);
  const evidence = evidenceOf(replay.result);
  expect(evidence).toBeDefined();
  expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
  return { evidence: evidence!, pending: evidenceOf(replay.call) };
}

function obsoleteFixtureEvidence(): ResinComputationEvidenceV1 {
  const variant = variantOf("record-join-lineage", "corrected-helper");
  const recorder = createComputationEvidenceRecorder();
  replayEval(recorder, variant, "call-join-def-v1", 1);
  const replay = replayEval(recorder, variant, "call-join-use-a-v1", 3);
  const evidence = evidenceOf(replay.result);
  expect(evidence).toBeDefined();
  expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
  return evidence!;
}

function reseal(evidence: ResinComputationEvidenceV1): ResinComputationEvidenceV1 {
  const { evidenceId: _discarded, ...body } = evidence;
  return { evidenceId: computeComputationEvidenceDigest(body as ComputationEvidenceBody), ...body };
}

function clusterWithComputationEvidence(options: {
  evidence: ResinComputationEvidenceV1;
  avgTokens: number;
  completedOccurrences: number;
}): WorkflowCluster {
  return {
    clusterId: "cluster_computation_value",
    workspaceId: "workspace_computation_value",
    version: "1.0.0",
    structuralHash: "compute_hash",
    representativeSignature: {
      signatureId: "signature_computation_value",
      structuralHash: "compute_hash",
      operations: ["compute:fixture"],
      toolClasses: ["data_transform"],
      commandPatterns: [],
      normalizedPaths: [],
      argumentSchemaHashes: [],
      semanticOperations: [{ computationEvidence: options.evidence }],
      stepCount: 1,
      durationMs: 5,
      tokenCount: options.avgTokens,
      retryCount: 0,
      estimatedCostUsd: null,
    },
    episodes: [],
    episodeCount: options.completedOccurrences,
    distinctSessionIds: ["session_computation_value"],
    completedOccurrences: options.completedOccurrences,
    metrics: {
      totalDurationMs: 5 * options.completedOccurrences,
      avgDurationMs: 5,
      totalTokens: options.avgTokens * options.completedOccurrences,
      avgTokens: options.avgTokens,
      totalCostUsd: null,
      totalRetries: 0,
      totalStepCount: options.completedOccurrences,
      avgStepCount: 1,
    },
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    evidenceEventIds: [],
  };
}

describe("computation value right-sizing", () => {
  it("admits a real native fixture computation as one advisory valid computation", () => {
    const { evidence } = fixtureEvidence();

    const result = evaluateRightSizing(1, 1, { computationEvidence: evidence });

    expect(result).toMatchObject({ isRightSized: true, decision: "valid_computation" });
    expect(result.description).toContain("advisory authoring benefit");
    expect(result.description).toContain("priced usage unknown/incomplete");
  });

  it("rejects missing, invalid, pending, and failed-substantive evidence for cheap eval wrappers", () => {
    const { pending } = fixtureEvidence();

    expect(evaluateRightSizing(1, 1).decision).toBe("cheap_single_operation");
    expect(
      evaluateRightSizing(1, 1, {
        computationEvidence: {
          resinComputationEvidenceV1: true,
        } as unknown as ResinComputationEvidenceV1,
      }).decision,
    ).toBe("cheap_single_operation");
    expect(evaluateRightSizing(1, 1, { computationEvidence: pending }).decision).toBe(
      "cheap_single_operation",
    );
  });

  it("admits a small or negative advisory authoring estimate while bare wrappers stay rejected", () => {
    const { evidence } = fixtureEvidence();

    // Force a net-negative bounded estimate by shrinking the source cap below the fixed overhead.
    const tinySource = reseal({
      ...evidence,
      metrics: { ...evidence.metrics, sourceBytes: 64 },
    });
    expect(readComputationEvidence(tinySource)).toBeDefined();
    expect(isSubstantiveComputationEvidence(tinySource)).toBe(true);

    const negative = evaluateRightSizing(1, 1, { computationEvidence: tinySource });
    expect(negative).toMatchObject({
      isRightSized: true,
      decision: "valid_computation",
    });
    expect(negative.description).toContain("authoring benefit: -");

    // The same admission path rejects a trivial single step and an empty subworkflow outright.
    expect(evaluateRightSizing(1, 1).decision).toBe("cheap_single_operation");
    expect(evaluateRightSizing(1, 1, { avgTokens: 1_000 }).decision).toBe("cheap_single_operation");
    expect(evaluateRightSizing(0, 1)).toMatchObject({
      isRightSized: false,
      decision: "negligible",
    });
  });

  it("admits obsolete join V1 evidence while never inflating its estimate with native I/O", () => {
    const evidence = obsoleteFixtureEvidence();

    const rightSizing = evaluateRightSizing(1, 1, {
      avgTokens: 1_000_000,
      computationEvidence: evidence,
    });
    const savedWork = deriveEstimatedSavedWork(
      clusterWithComputationEvidence({ evidence, avgTokens: 1_000_000, completedOccurrences: 3 }),
      1,
    );

    // V1 is a strictly validated substantive capture, so its advisory authoring estimate does not
    // block admission; the estimate itself is still never inflated by huge native I/O.
    expect(rightSizing).toMatchObject({
      isRightSized: true,
      decision: "valid_computation",
    });
    expect(savedWork.estimatedTokensSaved).toBe(0);
    expect(savedWork.savedTokens).toBe(0);
    expect(savedWork.estimatedDurationSavedMs).toBe(0);
  });

  it("deduplicates repeated carriers and does not inflate cached helper authoring by invocations", () => {
    const { evidence } = fixtureEvidence();

    const single = evaluateRightSizing(1, 1, { computationEvidence: evidence });
    const repeated = evaluateRightSizing(1, 1, {
      computationEvidence: [evidence, evidence, evidence],
    });

    expect(single.decision).toBe("valid_computation");
    expect(repeated.decision).toBe("valid_computation");
    expect(repeated.description).toContain("1 unique program digest");
    expect(repeated.description).toBe(single.description);
  });

  it("caps authoring value by semantic nodes rather than huge source payload bytes", () => {
    const { evidence } = fixtureEvidence();
    const inflatedSource = reseal({
      ...evidence,
      metrics: { ...evidence.metrics, sourceBytes: 65_536 },
    });
    const hugeSource = reseal({
      ...evidence,
      metrics: { ...evidence.metrics, sourceBytes: 4_194_304 },
    });

    expect(readComputationEvidence(inflatedSource)).toBeDefined();
    expect(readComputationEvidence(hugeSource)).toBeDefined();
    expect(evaluateRightSizing(1, 1, { computationEvidence: hugeSource }).description).toBe(
      evaluateRightSizing(1, 1, { computationEvidence: inflatedSource }).description,
    );
  });

  it("derives one capped authoring estimate invariant to repeated observations", () => {
    const { evidence } = fixtureEvidence();
    const once = deriveEstimatedSavedWork(
      clusterWithComputationEvidence({ evidence, avgTokens: 1_000, completedOccurrences: 1 }),
      1,
    );
    const repeated = deriveEstimatedSavedWork(
      clusterWithComputationEvidence({ evidence, avgTokens: 1_000, completedOccurrences: 8 }),
      1,
    );

    expect(repeated.estimatedTokensSaved).toBe(once.estimatedTokensSaved);
    expect(repeated.savedTokens).toBe(once.savedTokens);
    expect(repeated.estimatedStepsSaved).toBe(0);
    expect(repeated.savedToolCalls).toBe(0);
    expect(repeated.estimatedDurationSavedMs).toBe(0);
    expect("estimatedCostSavedUsd" in repeated).toBe(false);
    expect("savedCostUsd" in repeated).toBe(false);
  });

  it("does not credit half of huge observed native I/O as computation authoring savings", () => {
    const { evidence } = fixtureEvidence();
    const estimate = deriveEstimatedSavedWork(
      clusterWithComputationEvidence({ evidence, avgTokens: 1_000_000, completedOccurrences: 2 }),
      1,
    );

    expect(estimate.estimatedTokensSaved).toBeLessThan(500_000);
    expect(estimate.savedTokens).toBe(estimate.estimatedTokensSaved);
    expect(estimate.estimatedDurationSavedMs).toBe(0);
  });
});
