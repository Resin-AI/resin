import {
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
import { extractEpisodeSignature } from "../../src/opportunity/signature.js";
import type { Episode } from "../../src/opportunity/types.js";

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
    result: "ok",
    isError: options.isError ?? false,
    executionDurationMs: 5,
    isShadow: false,
  };
}

function replayFixtureCall(
  recorder: ComputationEvidenceRecorder,
  variant: ComputationFixtureVariant,
  callId: string,
  sequence: number,
  options: { isError?: boolean } = {},
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
      isError: options.isError,
    }),
  );
  return { call, result };
}

function evidenceOf(event: NormalizedSessionEvent) {
  return readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]);
}

function resealEvidence(evidence: ResinComputationEvidenceV1): ResinComputationEvidenceV1 {
  const { evidenceId: _evidenceId, ...body } = evidence;
  return { evidenceId: computeComputationEvidenceDigest(body), ...body };
}

function episode(events: NormalizedSessionEvent[]): Episode {
  return {
    id: `ep_${events[0]?.sessionId ?? "empty"}`,
    sessionId: events[0]?.sessionId ?? "session",
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

describe("computation signature extraction", () => {
  it("promotes one strict successful fixture closure to a data_transform operation", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const definition = replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const use = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);

    const success = evidenceOf(use.result);
    expect(success).toBeDefined();
    expect(isSubstantiveComputationEvidence(success)).toBe(true);

    const signature = extractEpisodeSignature(
      episode([definition.call, definition.result, use.call, use.result]),
    );
    const computeOps = signature.semanticOperations?.filter((operation) =>
      operation.operation?.startsWith("compute:"),
    );

    expect(signature.operations).toEqual([`compute:${success!.programDigest}`]);
    expect(signature.toolClasses).toEqual(["data_transform"]);
    expect(computeOps).toHaveLength(1);
    expect(computeOps?.[0]?.rawEventId).toBe(success!.observation.callEventId);
    expect(computeOps?.[0]?.eventIds).toEqual(
      expect.arrayContaining([
        success!.observation.callEventId,
        success!.observation.resultEventId,
        ...success!.dependencies.map((dependency) => dependency.sourceEventId),
      ]),
    );
    expect(computeOps?.[0]?.computationEvidence).toEqual(success);
    expect(signature.operations.some((operation) => operation.startsWith("tool:eval"))).toBe(false);
  });

  it("materializes a result-only closure when the call precedes the episode", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const use = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);
    const success = evidenceOf(use.result)!;

    const signature = extractEpisodeSignature(episode([use.result]));

    expect(signature.operations).toEqual([`compute:${success.programDigest}`]);
    expect(signature.semanticOperations?.[0]?.rawEventId).toBe(success.observation.callEventId);
    expect(signature.semanticOperations?.[0]?.eventIds).toContain(
      success.observation.resultEventId,
    );
  });

  it("uses algorithm identity instead of fixture data identity", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const first = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);
    const second = replayFixtureCall(recorder, variant, "call-join-use-b-v1", 5);
    const firstEvidence = evidenceOf(first.result)!;
    const secondEvidence = evidenceOf(second.result)!;

    const firstSig = extractEpisodeSignature(episode([first.result]));
    const secondSig = extractEpisodeSignature(episode([second.result]));

    expect(firstEvidence.evidenceId).not.toBe(secondEvidence.evidenceId);
    expect(firstEvidence.programDigest).toBe(secondEvidence.programDigest);
    expect(firstSig.operations).toEqual(secondSig.operations);
    expect(firstSig.argumentSchemaHashes).toEqual(secondSig.argumentSchemaHashes);
  });

  it("excludes pending, failed and definition-only carriers from structural work", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const definition = replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const pendingOnly = recorder.observe(
      toolCall({
        sessionId: variant.sessionId,
        callId: "call-join-use-a-v1",
        toolName: fixtureCall(variant, "call-join-use-a-v1").toolName,
        parameters: fixtureCall(variant, "call-join-use-a-v1").toolArguments as Record<
          string,
          unknown
        >,
        sequence: 3,
      }),
    );
    const failed = replayFixtureCall(recorder, variant, "call-join-use-b-v1", 5, { isError: true });

    expect(evidenceOf(definition.result)?.observation.kind).toBe("definition");
    expect(evidenceOf(pendingOnly)?.observation.status).toBe("pending");
    expect(evidenceOf(failed.result)?.observation.status).toBe("error");

    const signature = extractEpisodeSignature(
      episode([definition.call, definition.result, pendingOnly, failed.call, failed.result]),
    );

    expect(signature.operations.filter((operation) => operation.startsWith("compute:"))).toEqual(
      [],
    );
    expect(signature.toolClasses).not.toContain("data_transform");
  });

  it("rejects successful evidence attached away from its matching result event", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const use = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);
    const success = evidenceOf(use.result)!;
    const forgedCarrier: NormalizedSessionEvent = {
      ...use.call,
      metadata: {
        ...(use.call.metadata ?? {}),
        [RESIN_COMPUTATION_EVIDENCE_KEY]: success,
      },
    };

    const signature = extractEpisodeSignature(episode([forgedCarrier]));

    expect(signature.operations.filter((operation) => operation.startsWith("compute:"))).toEqual(
      [],
    );
  });

  it("supersedes stale corrected invocations without letting provenance fragment identity", () => {
    const variant = variantOf("record-join-lineage", "corrected-helper");
    const recorder = createComputationEvidenceRecorder();
    const definitionV1 = replayFixtureCall(recorder, variant, "call-join-def-v1", 1);
    const before = replayFixtureCall(recorder, variant, "call-join-use-a-v1", 3);
    const definitionV2 = replayFixtureCall(recorder, variant, "call-join-def-v2", 5);
    const after = replayFixtureCall(recorder, variant, "call-join-use-a-v2", 7);
    const beforeEvidence = evidenceOf(before.result)!;
    const afterEvidence = evidenceOf(after.result)!;

    const fullSig = extractEpisodeSignature(
      episode([
        definitionV1.call,
        definitionV1.result,
        before.call,
        before.result,
        definitionV2.call,
        definitionV2.result,
        after.call,
        after.result,
      ]),
    );
    const afterSig = extractEpisodeSignature(episode([after.result]));
    const alternateEvidence = resealEvidence({
      ...afterEvidence,
      dependencies: afterEvidence.dependencies.map((dependency, index) => ({
        ...dependency,
        sourceEventId: `evt_alternate_dependency_${index}`,
      })),
      corrections: [],
    });
    const alternateResult: NormalizedSessionEvent = {
      ...after.result,
      metadata: {
        ...(after.result.metadata ?? {}),
        [RESIN_COMPUTATION_EVIDENCE_KEY]: alternateEvidence,
      },
    };
    const alternateSig = extractEpisodeSignature(episode([alternateResult]));

    expect(afterEvidence.corrections.length).toBeGreaterThan(0);
    expect(beforeEvidence.dependencies.map((dependency) => dependency.programDigest)).toContain(
      afterEvidence.corrections[0]!.supersededProgramDigest,
    );
    expect(fullSig.operations).toEqual([`compute:${afterEvidence.programDigest}`]);
    expect(afterSig.structuralHash).toBe(alternateSig.structuralHash);
    expect(afterSig.argumentSchemaHashes).toEqual(alternateSig.argumentSchemaHashes);

    const restoredCallId = "call-restored-v1";
    const restoredResultEventId = "evt_result_restored_v1";
    const restoredEvidence = resealEvidence({
      ...beforeEvidence,
      observation: {
        ...beforeEvidence.observation,
        callEventId: "evt_call_restored_v1",
        callId: restoredCallId,
        resultEventId: restoredResultEventId,
      },
      corrections: [],
    });
    const restoredResultSource = before.result as NormalizedToolResultEvent;
    const restoredResult: NormalizedSessionEvent = {
      ...restoredResultSource,
      eventId: restoredResultEventId,
      callId: restoredCallId,
      causalRef: causal(9),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, 9)).toISOString(),
      metadata: {
        ...(before.result.metadata ?? {}),
        [RESIN_COMPUTATION_EVIDENCE_KEY]: restoredEvidence,
      },
    };
    const restoredSig = extractEpisodeSignature(
      episode([before.result, after.result, restoredResult]),
    );
    const restoredV1Ops = restoredSig.operations.filter(
      (operation) => operation === `compute:${beforeEvidence.programDigest}`,
    );
    expect(restoredV1Ops).toHaveLength(1);
    expect(restoredSig.operations).toContain(`compute:${afterEvidence.programDigest}`);
  });
});
