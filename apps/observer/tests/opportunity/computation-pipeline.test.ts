import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  ProvenPatternDtoSchema,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
} from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import {
  type ComputationFixtureFamily,
  type ComputationFixtureVariant,
  type OmpFixtureRecord,
  buildComputationFixtureFamilies,
} from "@resin/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  SessionOpportunityTracker,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../src/index.js";
import { StructuralClusterer } from "../../src/opportunity/clustering.js";
import { segmentSessionEvents } from "../../src/opportunity/episode.js";
import { deriveEstimatedSavedWork, evaluateRightSizing } from "../../src/opportunity/saved-work.js";
import { SignatureExtractor } from "../../src/opportunity/signature.js";
import { evaluateSuppression } from "../../src/opportunity/suppression.js";
import type { Episode, WorkflowCluster } from "../../src/opportunity/types.js";

const decoder = new OmpRecordDecoder();
const families = buildComputationFixtureFamilies();
const extractor = new SignatureExtractor();
const clusterer = new StructuralClusterer();

function rawRecord(record: OmpFixtureRecord, index: number): RawHarnessRecord {
  const sessionId = "sessionId" in record ? record.sessionId : "";
  const timestamp = record.timestamp;
  return {
    recordId: `rec_pipeline_${index}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: index + 1,
    timestamp,
    recordType: record.type === "custom" ? "custom" : "transcript_line",
    rawPayload: JSON.stringify(record),
    cursor: { offset: index * 100, line: index + 1, sequence: index + 1, timestamp },
    metadata: {},
  };
}

function sessionFor(variant: ComputationFixtureVariant): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId: variant.sessionId,
    workspaceId: `ws_public_${variant.familyId}`,
    harnessId: "omp",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { tool: "omp" },
  };
}

function createFakeCloudClient() {
  const submitted: TrajectoryObservation[] = [];
  const batches: unknown[] = [];
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendTrajectoryObservationBatch = vi.fn(
    async (input: { observations: TrajectoryObservation[] }) => {
      submitted.push(...input.observations);
      return { batchId: "fixture_traj_batch", accepted: 1, rejected: 0, errors: [] };
    },
  );
  client.sendObservationBatch = vi.fn(async (input: { observations: unknown[] }) => {
    batches.push(...input.observations);
    return {
      batchId: "fixture_obs_batch",
      status: "accepted",
      acceptedCount: input.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  return { client, submitted, batches };
}

function createCaptureEnvironment() {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(decoder);
  const cloud = createFakeCloudClient();
  const localEvents: NormalizedSessionEvent[] = [];
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: cloud.client,
    attributionResolver: async () => null,
    coalesceDwellMs: 0,
  });
  coordinator.setSessionEventSink((_session, events) => {
    localEvents.push(...events);
  });
  return { coordinator, pipeline, cloud, localEvents };
}

async function captureVariant(
  variant: ComputationFixtureVariant,
): Promise<NormalizedSessionEvent[]> {
  const environment = createCaptureEnvironment();
  const session = sessionFor(variant);
  const records = variant.records.map((record, index) => rawRecord(record, index));
  for (const record of records) {
    await environment.coordinator.handleRecords(session, [record], async () => {});
  }
  await environment.coordinator.handleRecords(
    { ...session, status: "completed" },
    [],
    async () => {},
  );
  await environment.coordinator.waitForIdle();
  return environment.localEvents
    .filter((event) => event.sessionId === variant.sessionId)
    .map((event) => {
      const projected = projectEventToMetadataOnly(event);
      return { ...event, metadata: projected.metadata ?? {} } as NormalizedSessionEvent;
    });
}

function canaryValues(
  family: ComputationFixtureFamily,
  variant: ComputationFixtureVariant,
): string[] {
  return [...family.canaries, ...variant.datasets.flatMap((dataset) => dataset.canaries)]
    .map((canary) => String(canary))
    .filter((value) => value.length > 8);
}

function evidenceFrom(events: readonly NormalizedSessionEvent[]): ResinComputationEvidenceV1[] {
  return events
    .map((event) => readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]))
    .filter((evidence): evidence is ResinComputationEvidenceV1 => evidence !== undefined);
}

function substantiveByCallId(
  events: readonly NormalizedSessionEvent[],
  callId: string,
): ResinComputationEvidenceV1[] {
  return evidenceFrom(events).filter(
    (evidence) =>
      evidence.observation.callId === callId && isSubstantiveComputationEvidence(evidence),
  );
}

function episodesFrom(events: NormalizedSessionEvent[]): Episode[] {
  const episodes = segmentSessionEvents(events);
  expect(episodes.length).toBeGreaterThan(0);
  return episodes;
}

function clustersFrom(events: NormalizedSessionEvent[]): WorkflowCluster[] {
  const clusters = clusterer.clusterEpisodes(episodesFrom(events));
  expect(clusters.length).toBeGreaterThan(0);
  return clusters;
}

function singletonClusterFor(
  clusters: WorkflowCluster[],
  evidence: ResinComputationEvidenceV1,
): WorkflowCluster {
  const cluster = clusters.find(
    (candidate) =>
      candidate.representativeSignature.operations.length === 1 &&
      candidate.representativeSignature.operations[0] === `compute:${evidence.programDigest}`,
  );
  expect(cluster, `missing computation singleton for ${evidence.observation.callId}`).toBeDefined();
  return cluster!;
}

function assertProjectedPrivacy(
  family: ComputationFixtureFamily,
  variant: ComputationFixtureVariant,
  events: readonly NormalizedSessionEvent[],
): void {
  for (const value of canaryValues(family, variant)) {
    for (const event of events) {
      expect(
        JSON.stringify(event.metadata ?? {}),
        `${variant.variantId} leaked ${value}`,
      ).not.toContain(value);
    }
  }
}

function assertClosureProvenance(
  variant: ComputationFixtureVariant,
  events: readonly NormalizedSessionEvent[],
  evidence: ResinComputationEvidenceV1,
): void {
  const eventIds = new Set(events.map((event) => event.eventId));
  expect(eventIds.has(evidence.observation.callEventId), variant.variantId).toBe(true);
  expect(evidence.observation.resultEventId, variant.variantId).toBeDefined();
  expect(eventIds.has(evidence.observation.resultEventId!), variant.variantId).toBe(true);
  for (const dependency of evidence.dependencies) {
    expect(dependency.sourceEventId, variant.variantId).toMatch(/^evt_/);
    expect(eventIds.has(dependency.sourceEventId), variant.variantId).toBe(true);
    expect(dependency.programDigest).toMatch(/^[a-f0-9]{64}$/);
  }
}

describe("public computation pipeline from native fixture records", () => {
  let stores: LocalStateStore[] = [];

  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
  });

  it("promotes all four ordinary families through capture, public projection, signatures, clusters, right-sizing and suppression", async () => {
    expect(families.map((family) => family.familyId).sort()).toEqual([
      "cpu-pss-delta",
      "process-snapshot-ownership",
      "record-join-lineage",
      "record-schema-order",
    ]);

    for (const family of families) {
      for (const variant of family.variants) {
        const events = await captureVariant(variant);
        assertProjectedPrivacy(family, variant, events);

        const episodes = episodesFrom(events);
        const signature = extractor.extractSignature(episodes[0]!);
        const clusters = clustersFrom(events);
        const computeOperations =
          signature.semanticOperations?.filter((operation) =>
            operation.operation?.startsWith("compute:"),
          ) ?? [];
        const emittedEvidenceIds = new Set<string>();
        for (const operation of computeOperations) {
          const evidence = operation.computationEvidence;
          expect(evidence, `${variant.variantId} compute op missing evidence`).toBeDefined();
          expect(isSubstantiveComputationEvidence(evidence), variant.variantId).toBe(true);
          expect(evidence!.observation.kind).toBe("invocation");
          expect(evidence!.observation.status).toBe("success");
          expect(evidence!.observation.resultEventId).toBeDefined();
          emittedEvidenceIds.add(evidence!.evidenceId);
        }
        const nonCandidateEvidence = evidenceFrom(events).filter(
          (evidence) => !isSubstantiveComputationEvidence(evidence),
        );
        expect(
          nonCandidateEvidence.length,
          `${variant.variantId} needs real pending/definition carriers`,
        ).toBeGreaterThan(0);
        for (const evidence of nonCandidateEvidence) {
          expect(
            emittedEvidenceIds.has(evidence.evidenceId),
            `${variant.variantId} promoted non-success evidence`,
          ).toBe(false);
        }

        for (const dataset of variant.datasets) {
          const [evidence] = substantiveByCallId(events, dataset.invocationCallId);
          expect(evidence, `${variant.variantId} ${dataset.invocationCallId}`).toBeDefined();
          assertClosureProvenance(variant, events, evidence!);

          const dataTransforms = computeOperations.filter(
            (operation) => operation.computationEvidence?.evidenceId === evidence!.evidenceId,
          );
          expect(dataTransforms, `${variant.variantId} ${dataset.invocationCallId}`).toHaveLength(
            1,
          );
          const dataTransform = dataTransforms[0]!;
          expect(dataTransform.toolClass).toBe("data_transform");
          expect(dataTransform.rawEventId).toBe(evidence!.observation.callEventId);
          expect(dataTransform.computationEvidence).toEqual(evidence);

          const cluster = singletonClusterFor(clusters, evidence!);
          const operation = cluster.representativeSignature.semanticOperations?.find(
            (candidate) => candidate.computationEvidence?.programDigest === evidence!.programDigest,
          );
          expect(cluster.representativeSignature.operations).toEqual([
            `compute:${evidence!.programDigest}`,
          ]);
          expect(cluster.representativeSignature.toolClasses).toEqual(["data_transform"]);
          expect(operation?.toolClass).toBe("data_transform");
          expect(operation?.computationEvidence?.programDigest).toBe(evidence!.programDigest);
          expect(cluster.representativeSignature.operations).not.toContain("tool:eval");

          expect(evaluateSuppression(cluster)).toMatchObject({ suppressed: false, reason: "none" });
          expect(
            evaluateRightSizing(1, 1, { computationEvidence: evidence }).decision,
            `${variant.variantId} ${dataset.invocationCallId}`,
          ).toBe("valid_computation");
          const saved = deriveEstimatedSavedWork(cluster, 1);
          expect(saved.estimatedTokensSaved, `${variant.variantId} saved tokens`).toBeGreaterThan(
            0,
          );
          expect(saved.savedTokens).toBe(saved.estimatedTokensSaved);
        }

        if (variant.datasets.length >= 2) {
          const [first, second] = variant.datasets;
          const [firstEvidence] = substantiveByCallId(events, first!.invocationCallId);
          const [secondEvidence] = substantiveByCallId(events, second!.invocationCallId);
          expect(firstEvidence?.evidenceId).not.toBe(secondEvidence?.evidenceId);
          expect(firstEvidence?.programDigest).toBe(secondEvidence?.programDigest);
          expect(
            extractor.extractSignature(
              episodesFrom(
                events.filter((event) => {
                  const evidence = readComputationEvidence(
                    event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
                  );
                  return evidence?.observation.callId === first!.invocationCallId;
                }),
              )[0]!,
            ).operations,
          ).toEqual(
            extractor.extractSignature(
              episodesFrom(
                events.filter((event) => {
                  const evidence = readComputationEvidence(
                    event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
                  );
                  return evidence?.observation.callId === second!.invocationCallId;
                }),
              )[0]!,
            ).operations,
          );
        }
      }
    }
  }, 30_000);

  it("admits both obsolete join V1 and corrected V2 as strict substantive computation", async () => {
    const join = families.find((family) => family.familyId === "record-join-lineage")!;
    const variant = join.variants[0]!;
    const events = await captureVariant(variant);

    for (const dataset of variant.datasets) {
      expect(dataset.superseded).toBeDefined();
      const [oldEvidence] = substantiveByCallId(events, dataset.superseded!.invocationCallId);
      const [newEvidence] = substantiveByCallId(events, dataset.invocationCallId);
      expect(oldEvidence?.programDigest).not.toBe(newEvidence?.programDigest);
      // Both are strictly validated substantive captures. Their advisory estimates differ, but
      // neither is refused on estimated value.
      const oldSizing = evaluateRightSizing(1, 1, { computationEvidence: oldEvidence });
      const newSizing = evaluateRightSizing(1, 1, { computationEvidence: newEvidence });
      expect(oldSizing.decision).toBe("valid_computation");
      expect(newSizing.decision).toBe("valid_computation");
      expect(oldSizing.description).toContain("advisory authoring benefit");
    }
  });

  it("dispatches the real default tracker callback for public computation candidates", async () => {
    const store = await createInMemoryStateStore();
    stores.push(store);
    const proven: unknown[] = [];
    const tracker = new SessionOpportunityTracker({
      opportunities: store.opportunities,
      onPatternProven: (pattern) => proven.push(pattern),
    });
    const family = families.find((entry) => entry.familyId === "record-join-lineage")!;
    const variant = family.variants[0]!;
    const events = await captureVariant(variant);

    await tracker.handleSessionEvents(sessionFor(variant), events, {
      isTerminal: true,
      isAttributed: true,
    });

    expect(proven.length).toBeGreaterThan(0);
    const payloads = proven.map((pattern) => ProvenPatternDtoSchema.parse(pattern));
    // Every dispatched candidate is suppression-free; none is filtered on estimated value.
    for (const payload of payloads) {
      expect(payload.localVerdicts.suppression).toMatchObject({
        suppressed: false,
        reason: "none",
      });
    }
    const computationCandidate = payloads.find(
      (payload) =>
        payload.signature.toolClasses.includes("data_transform") &&
        payload.localVerdicts.estimatedSavedWork.estimatedTokensSaved > 0,
    );
    expect(computationCandidate).toBeDefined();
    expect(await store.opportunities.listPendingPatterns()).toHaveLength(proven.length);
  });
});
