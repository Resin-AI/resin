import {
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
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
import { evaluateSuppression } from "../../src/opportunity/suppression.js";
import type { WorkflowCluster } from "../../src/opportunity/types.js";

const SCHEMA_VERSION = "1.0.0" as const;
const timestamp = "2026-01-01T00:00:00.000Z";
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

function fixtureReplay(): {
  call: NormalizedSessionEvent;
  result: NormalizedSessionEvent;
  evidence: ResinComputationEvidenceV1;
} {
  const variant = variantOf("record-join-lineage", "corrected-helper");
  const recorder = createComputationEvidenceRecorder();
  replayEval(recorder, variant, "call-join-def-v2", 1);
  const replay = replayEval(recorder, variant, "call-join-use-a-v2", 3);
  const evidence = readComputationEvidence(
    replay.result.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
  );
  expect(evidence).toBeDefined();
  expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
  return { ...replay, evidence: evidence! };
}

function genericEvalEvents(metadata?: Record<string, unknown>): NormalizedSessionEvent[] {
  return [
    {
      eventId: "evt_generic_call",
      schemaVersion: SCHEMA_VERSION,
      sessionId: "sess_generic_eval",
      timestamp,
      causalRef: causal(1),
      redaction: redaction(["parameters"]),
      metadata: { scenarioId: "sess_generic_eval", ...(metadata ?? {}) },
      type: "tool_call",
      callId: "call_generic_eval",
      toolName: "eval",
      parameters: { code: "JSON.stringify(input)" },
      isShadow: false,
    } as NormalizedToolCallEvent,
    {
      eventId: "evt_generic_result",
      schemaVersion: SCHEMA_VERSION,
      sessionId: "sess_generic_eval",
      timestamp,
      causalRef: causal(2),
      redaction: redaction(["result"]),
      metadata: { scenarioId: "sess_generic_eval", ...(metadata ?? {}) },
      type: "tool_result",
      callId: "call_generic_eval",
      toolName: "eval",
      result: "{}",
      isError: false,
      executionDurationMs: 5,
      isShadow: false,
    } as NormalizedToolResultEvent,
  ];
}

function cluster(
  events: NormalizedSessionEvent[],
  semanticOperations: unknown[] = [],
): WorkflowCluster {
  return {
    clusterId: "cluster_computation",
    workspaceId: "workspace_computation",
    version: "1.0.0",
    structuralHash: "compute_hash",
    representativeSignature: {
      signatureId: "signature_computation",
      structuralHash: "compute_hash",
      operations: ["compute:fixture"],
      toolClasses: ["data_transform"],
      commandPatterns: [],
      normalizedPaths: [],
      argumentSchemaHashes: [],
      semanticOperations,
      stepCount: 1,
      durationMs: 5,
      tokenCount: 10,
      retryCount: 0,
      estimatedCostUsd: null,
    },
    episodes: [
      {
        episodeId: "episode_computation",
        sessionId: events[0]?.sessionId ?? "sess_computation",
        scenarioId: events[0]?.sessionId ?? "sess_computation",
        startTime: timestamp,
        endTime: timestamp,
        events,
        metrics: {
          stepCount: 1,
          totalTokens: 10,
          retryCount: 0,
          estimatedCostUsd: null,
          costSource: "unknown",
          totalDurationMs: 5,
        },
      },
    ],
    episodeCount: 1,
    distinctSessionIds: [events[0]?.sessionId ?? "sess_computation"],
    completedOccurrences: 1,
    metrics: {
      totalDurationMs: 5,
      avgDurationMs: 5,
      totalTokens: 10,
      avgTokens: 10,
      totalCostUsd: null,
      totalRetries: 0,
      totalStepCount: 1,
      avgStepCount: 1,
    },
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    evidenceEventIds: events.map((event) => event.eventId ?? "").filter((id) => id.length > 0),
  };
}

describe("computation opportunity suppression", () => {
  it("admits one strict successful substantive native computation carrier", () => {
    const replay = fixtureReplay();

    expect(evaluateSuppression(cluster([replay.call, replay.result]))).toMatchObject({
      suppressed: false,
      reason: "none",
    });
  });

  it("also reads actual computation carriers from semantic operations", () => {
    const replay = fixtureReplay();

    expect(
      evaluateSuppression(
        cluster(genericEvalEvents(), [
          { computationEvidence: replay.evidence, toolClass: "data_transform" },
        ]),
      ),
    ).toMatchObject({ suppressed: false, reason: "none" });
  });

  it("rejects generic eval wrappers with missing, invalid, or pending evidence", () => {
    const replay = fixtureReplay();
    const missing = evaluateSuppression(cluster(genericEvalEvents()));
    const invalid = evaluateSuppression(
      cluster(genericEvalEvents({ [RESIN_COMPUTATION_EVIDENCE_KEY]: { invalid: true } })),
    );
    const pending = evaluateSuppression(cluster([replay.call]));

    expect(missing.suppressed).toBe(true);
    expect(["no_tool_operations", "trivial"]).toContain(missing.reason);
    expect(invalid.suppressed).toBe(true);
    expect(["no_tool_operations", "trivial"]).toContain(invalid.reason);
    expect(pending.suppressed).toBe(true);
    expect(["no_tool_operations", "trivial"]).toContain(pending.reason);
  });
});
