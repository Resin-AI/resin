import type {
  EpisodeSignature,
  NormalizedSessionEvent,
  NormalizedToolCallEvent,
  NormalizedToolResultEvent,
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
import {
  clusterWorkflowEpisodes,
  computeSignatureSimilarity,
} from "../../src/opportunity/clustering.js";
import type { Episode } from "../../src/opportunity/types.js";

const SCHEMA_VERSION = "1.0.0" as const;
const families = buildComputationFixtureFamilies();

function sig(partial: Partial<EpisodeSignature>): EpisodeSignature {
  return {
    signatureId: "sig_test",
    structuralHash: "hash_test",
    operations: [],
    toolClasses: [],
    commandPatterns: [],
    normalizedPaths: [],
    argumentSchemaHashes: [],
    stepCount: 1,
    durationMs: 100,
    tokenCount: 0,
    retryCount: 0,
    estimatedCostUsd: null,
    ...partial,
  };
}

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

function fixtureCall(variant: ComputationFixtureVariant, callId: string) {
  const call = collectOmpFixtureToolCalls(variant.records).find(
    (candidate) => candidate.callId === callId,
  );
  if (call === undefined) throw new Error(`no fixture call ${callId}`);
  return call;
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
    result: "ok",
    isError: false,
    executionDurationMs: 5,
    isShadow: false,
  };
}

function replayFixtureCall(
  recorder: ComputationEvidenceRecorder,
  variant: ComputationFixtureVariant,
  callId: string,
  sequence: number,
): { call: NormalizedSessionEvent; result: NormalizedSessionEvent } {
  const fixture = fixtureCall(variant, callId);
  const call = recorder.observe(
    toolCall({
      sessionId: variant.sessionId,
      callId,
      toolName: fixture.toolName,
      parameters: fixture.toolArguments as Record<string, unknown>,
      sequence,
    }),
  );
  const result = recorder.observe(
    toolResult({
      sessionId: variant.sessionId,
      callId,
      toolName: fixture.toolName,
      sequence: sequence + 1,
    }),
  );
  return { call, result };
}

function episode(id: string, events: NormalizedSessionEvent[]): Episode {
  return {
    id,
    sessionId: events[0]?.sessionId ?? id,
    workspaceId: "workspace",
    events,
    startedAt: events[0]?.timestamp ?? new Date(0).toISOString(),
    endedAt: events[events.length - 1]?.timestamp ?? new Date(0).toISOString(),
    durationMs: 10,
    isCompleted: true,
    hasErrors: false,
    metrics: {
      stepCount: events.length,
      totalTokens: 0,
      cachedInputTokens: 0,
      retryCount: 0,
      estimatedCostUsd: null,
      costSource: "unknown",
      totalDurationMs: 10,
    },
  };
}

describe("computation clustering", () => {
  it("does not merge disjoint computation digests through shared transport shape", () => {
    const a = sig({
      structuralHash: "a",
      operations: [`compute:${"a".repeat(64)}`],
      toolClasses: ["data_transform"],
      argumentSchemaHashes: ["slot-profile"],
    });
    const b = sig({
      structuralHash: "b",
      operations: [`compute:${"b".repeat(64)}`],
      toolClasses: ["data_transform"],
      argumentSchemaHashes: ["slot-profile"],
    });

    expect(computeSignatureSimilarity(a, b)).toBe(0);
  });

  it("extracts a substantive singleton computation subworkflow from a mixed fixture episode", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const use = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);
    const fileEdit: NormalizedSessionEvent = {
      eventId: "evt_edit_after_compute",
      schemaVersion: SCHEMA_VERSION,
      sessionId: variant.sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 3, 0)).toISOString(),
      causalRef: causal(6),
      redaction: redaction(["diff"]),
      metadata: { scenarioId: variant.sessionId },
      type: "file_edit",
      filePath: "src/report.json",
      operation: "update",
      diffStats: { linesAdded: 1, linesRemoved: 1 },
    };

    const clusters = clusterWorkflowEpisodes([
      episode("ep_mixed_compute", [use.call, use.result, fileEdit]),
    ]);
    const singleton = clusters.find(
      (cluster) =>
        cluster.representativeSignature.operations.length === 1 &&
        cluster.representativeSignature.operations[0]?.startsWith("compute:"),
    );

    expect(singleton).toBeDefined();
    expect(singleton?.representativeSignature.operations).toHaveLength(1);
    expect(singleton?.representativeSignature.toolClasses).toEqual(["data_transform"]);
  });
});
