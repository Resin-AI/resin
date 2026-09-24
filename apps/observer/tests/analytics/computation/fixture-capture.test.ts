import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  COMPUTATION_IR_LIMITS,
  COMPUTATION_IR_VERSION,
  type NormalizedSessionEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  type ResinComputationEvidenceV1,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import {
  COMPUTATION_FIXTURE_FAMILY_IDS,
  type ComputationFixtureFamily,
  type ComputationFixtureVariant,
  type OmpFixtureRecord,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
} from "@resin/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../../src/analytics/metadata-projection.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../../src/index.js";

/**
 * Capture coverage for every variant of all four `buildComputationFixtureFamilies` families.
 *
 * Each variant's authored OMP transcript records are replayed in their own causal order through the
 * shipped decoder -> normalization pipeline -> capture coordinator, so every carrier asserted here is
 * produced by the shipped recorder over the shipped parsers for the real fixture sources. Nothing in
 * this file fabricates a normalized event, a classification or a program: each expectation is a
 * contract property read back from the produced carrier.
 */

/** Current wire envelope limit for one evidence payload. */
const WIRE_EVIDENCE_BYTES_LIMIT = 65_536;

// ============================================================================
// Native fixture records -> raw harness records
// ============================================================================

function rawRecord(record: OmpFixtureRecord, index: number): RawHarnessRecord {
  const sessionId = "sessionId" in record ? record.sessionId : "";
  const timestamp = record.timestamp;
  return {
    recordId: `rec_fixture_${index}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: index + 1,
    timestamp,
    recordType: record.type === "custom" ? "custom" : "transcript_line",
    // The decoder accepts the serialized object directly; the fixture also models the JSONL form.
    rawPayload: JSON.stringify(record),
    cursor: { offset: index * 100, line: index + 1, sequence: index + 1, timestamp },
    metadata: {},
  };
}

function sessionFor(sessionId: string): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_computation_fixture",
    harnessId: "omp",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { tool: "omp" },
  };
}

// ============================================================================
// Real capture path
// ============================================================================

interface CaptureEnvironment {
  coordinator: TrajectoryCaptureCoordinator;
  /** Rows the local sink observed, carrying the same metadata-only projection as the cloud batch. */
  localEvents: NormalizedSessionEvent[];
  /** Rows handed to the cloud observation batch. */
  cloudRows: NormalizedSessionEvent[];
}

function createCaptureEnvironment(customSecrets: string[]): CaptureEnvironment {
  const pipeline = new NormalizationPipeline({ redactionConfig: { customSecrets } });
  pipeline.registerDecoder(new OmpRecordDecoder());
  const localEvents: NormalizedSessionEvent[] = [];
  const cloudRows: NormalizedSessionEvent[] = [];
  // SAFETY: Fake implements the two submission methods the coordinator calls.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendTrajectoryObservationBatch = vi.fn(async () => ({
    batchId: "fixture_traj_batch",
    accepted: 1,
    rejected: 0,
    errors: [],
  }));
  client.sendObservationBatch = vi.fn(async (input: { observations: unknown[] }) => {
    cloudRows.push(...(input.observations as NormalizedSessionEvent[]));
    return {
      batchId: "fixture_obs_batch",
      status: "accepted",
      acceptedCount: input.observations.length,
      rejectedCount: 0,
      errors: [],
    };
  });
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: client,
    // No attribution: the variant sessions take the generic observation path.
    attributionResolver: async () => null,
    // Coalescing off so each handled batch is asserted on its own boundaries.
    coalesceDwellMs: 0,
  });
  coordinator.setSessionEventSink((_session, events) => {
    localEvents.push(...events);
  });
  return { coordinator, localEvents, cloudRows };
}

/** Replays one variant's own transcript records, one appended line per batch, in causal order. */
async function capture(
  family: ComputationFixtureFamily,
  variant: ComputationFixtureVariant,
): Promise<CaptureEnvironment> {
  // Planted fixture values are configured private; ordinary source literals remain visible.
  const environment = createCaptureEnvironment(canaryValues(family, variant));
  const session = sessionFor(variant.sessionId);
  for (const [index, record] of variant.records.entries()) {
    await environment.coordinator.handleRecords(
      session,
      [rawRecord(record, index)],
      async () => {},
    );
  }
  // A terminal status flushes the generic coalescing buffer immediately.
  await environment.coordinator.handleRecords(
    { ...session, status: "completed" },
    [],
    async () => {},
  );
  await environment.coordinator.waitForIdle();
  return environment;
}

interface Carrier {
  surface: "local" | "cloud";
  eventId: string;
  evidence: unknown;
}

interface ParsedCarrier {
  carrier: Carrier;
  evidence: ResinComputationEvidenceV1;
}

function successfulInvocationCarriers(parsed: ParsedCarrier[], callId: string): ParsedCarrier[] {
  return parsed.filter(({ evidence }) => {
    const { observation } = evidence;
    return (
      observation.callId === callId &&
      observation.kind === "invocation" &&
      observation.status === "success"
    );
  });
}

/** Every carrier the pipeline produced for a variant, from both local and cloud surfaces. */
function carriersFor(
  environment: CaptureEnvironment,
  variant: ComputationFixtureVariant,
): Carrier[] {
  const carriers: Carrier[] = [];
  for (const event of environment.localEvents) {
    if (event.sessionId !== variant.sessionId) continue;
    const evidence = event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
    if (evidence !== undefined) {
      carriers.push({ surface: "local", eventId: event.eventId, evidence });
    }
  }
  for (const row of environment.cloudRows) {
    if (row.sessionId !== variant.sessionId) continue;
    const evidence = row.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
    if (evidence !== undefined) {
      carriers.push({ surface: "cloud", eventId: row.eventId, evidence });
    }
  }
  return carriers;
}

/** The strict public reader is the only way evidence is read here; a rejection fails the assertion. */
function strictEvidence(carrier: Carrier, label: string): ResinComputationEvidenceV1 {
  const parsed = readComputationEvidence(carrier.evidence);
  expect(parsed, `${label} was rejected by the strict public reader`).toBeDefined();
  if (parsed === undefined) {
    throw new Error(`${label} was rejected by the strict public reader`);
  }
  return parsed;
}

// ============================================================================
// Evidence/event helpers
// ============================================================================

function eventsByEventId(
  environment: CaptureEnvironment,
  variant: ComputationFixtureVariant,
): Map<string, NormalizedSessionEvent> {
  const byEventId = new Map<string, NormalizedSessionEvent>();
  for (const event of [...environment.localEvents, ...environment.cloudRows]) {
    if (event.sessionId !== variant.sessionId) continue;
    byEventId.set(event.eventId, event);
  }
  return byEventId;
}

function evidenceFromEvent(
  event: NormalizedSessionEvent,
  label: string,
): ResinComputationEvidenceV1 {
  const parsed = readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]);
  expect(parsed, `${label} must expose valid evidence`).toBeDefined();
  if (parsed === undefined) {
    throw new Error(`${label} must expose valid evidence`);
  }
  return parsed;
}

// ============================================================================
// Fixture-declared facts
// ============================================================================

/** Successful invocation calls the fixture declares as real business computation. */
function declaredInvocationCallIds(variant: ComputationFixtureVariant): string[] {
  return variant.datasets.flatMap((dataset) => [
    dataset.invocationCallId,
    ...(dataset.superseded === undefined ? [] : [dataset.superseded.invocationCallId]),
  ]);
}

/** The authored code bodies this variant actually wrote or evaluated. */
function authoredBodies(variant: ComputationFixtureVariant): string[] {
  const bodies: string[] = [];
  for (const call of collectOmpFixtureToolCalls(variant.records)) {
    const args = call.toolArguments;
    if (call.toolName === "eval" && "code" in args) {
      bodies.push(args.code);
    }
    if (call.toolName === "write" && "content" in args) {
      bodies.push(args.content);
    }
  }
  return bodies;
}

function canaryValues(
  family: ComputationFixtureFamily,
  variant: ComputationFixtureVariant,
): string[] {
  const canaries = new Set<string>([
    ...family.canaries,
    ...variant.datasets.flatMap((dataset) => dataset.canaries),
  ]);
  return [...canaries].filter((value) => value.length > 8);
}

/**
 * True when a variant's datasets resolve a helper observed outside the executing cell: an earlier
 * eval-kernel definition (`definition-use`, `corrected-helper`) or an imported observed module
 * (`sharedHelperSource`). The remaining variant inlines its helper in the executed file body, so its
 * closure is legitimately its own authored definitions.
 */
function requiresObservedHelperClosure(variant: ComputationFixtureVariant): boolean {
  return (
    variant.kind === "definition-use" ||
    variant.sharedHelperSource !== undefined ||
    variant.supersededDefinitionSource !== undefined
  );
}

// ============================================================================
// Coverage
// ============================================================================

const families = buildComputationFixtureFamilies();

describe("Computation fixture capture (every family variant through the real pipeline)", () => {
  it("covers all four families, every variant and every declared invocation", () => {
    expect(families.map((family) => family.familyId).sort()).toEqual(
      [...COMPUTATION_FIXTURE_FAMILY_IDS].sort(),
    );

    const kinds = new Set<string>();
    for (const family of families) {
      expect(family.variants.length).toBeGreaterThan(0);
      for (const variant of family.variants) {
        expect(variant.records.length).toBeGreaterThan(0);
        expect(variant.datasets.length).toBeGreaterThan(0);
        kinds.add(variant.kind);

        const callIds = new Set(
          collectOmpFixtureToolCalls(variant.records).map((call) => call.callId),
        );
        for (const dataset of variant.datasets) {
          expect(callIds.has(dataset.invocationCallId), dataset.datasetId).toBe(true);
          if (dataset.superseded !== undefined) {
            expect(callIds.has(dataset.superseded.invocationCallId), dataset.datasetId).toBe(true);
          }
        }
      }
    }
    // The corpus exercises every capture shape the families define.
    expect([...kinds].sort()).toEqual([
      "corrected-helper",
      "definition-use",
      "file-write-then-execute",
    ]);
  });

  it("yields a strict, complete, substantive successful carrier for every variant dataset", async () => {
    expect(COMPUTATION_IR_LIMITS.serializedBytes, "wire envelope cap is fixed at 65536").toBe(
      WIRE_EVIDENCE_BYTES_LIMIT,
    );

    let carriersSeen = 0;
    let substantiveSeen = 0;
    let pendingSeen = 0;
    let definitionOnlySeen = 0;

    for (const family of families) {
      for (const variant of family.variants) {
        const label = `${family.familyId}/${variant.variantId}`;
        const environment = await capture(family, variant);
        const carriers = carriersFor(environment, variant);
        const parsed = carriers.map((carrier) => ({
          carrier,
          evidence: strictEvidence(carrier, `${label} ${carrier.surface}:${carrier.eventId}`),
        }));

        expect(parsed.length, `${label} produced no carrier at all`).toBeGreaterThan(0);

        const canaries = canaryValues(family, variant);
        const bodies = authoredBodies(variant);
        const declared = declaredInvocationCallIds(variant);
        expect(canaries.length, `${label} declares no canary`).toBeGreaterThan(0);
        expect(bodies.length, `${label} authored no source body`).toBeGreaterThan(0);
        expect(declared.length, `${label} declares no invocation`).toBeGreaterThan(0);

        const eventById = eventsByEventId(environment, variant);
        const callEventIdByCallId = new Map<string, string>();

        for (const { carrier, evidence } of parsed) {
          const at = `${label} ${carrier.surface}:${carrier.eventId}`;
          expect(evidence.version, at).toBe(COMPUTATION_IR_VERSION);
          expect(evidence.analysisOnly, at).toBe(true);
          expect(evidence.origin.sourceEventId, at).toMatch(/^evt_/);
          expect(evidence.programDigest, at).toMatch(/^[a-f0-9]{64}$/);
          expect(evidence.program.language, at).toBe(variant.language);
          // The body must fit the approved serialized envelope, not a truncated prefix of it.
          expect(
            Buffer.byteLength(JSON.stringify(evidence), "utf8"),
            `${at} exceeds the pinned envelope`,
          ).toBeLessThanOrEqual(WIRE_EVIDENCE_BYTES_LIMIT);

          const serialized = JSON.stringify(evidence);
          for (const canary of canaries) {
            expect(serialized, `${at} leaked a canary`).not.toContain(canary);
          }
          for (const body of bodies) {
            expect(serialized, `${at} leaked raw fixture source`).not.toContain(body);
          }

          const { observation } = evidence;
          const successfulInvocation =
            observation.kind === "invocation" && observation.status === "success";

          if (observation.callId !== undefined) {
            const observed = callEventIdByCallId.get(observation.callId);
            expect(observation.callEventId, `${at} missing call event id`).toBeDefined();
            if (observed === undefined) {
              callEventIdByCallId.set(observation.callId, observation.callEventId);
            } else {
              expect(observed, `${at} reused a consumed call id on a fresh event`).toBe(
                observation.callEventId,
              );
            }
          }

          const callEvent = eventById.get(observation.callEventId);
          expect(callEvent, `${at} missing the emitted call row`).toBeDefined();
          expect(observation.callEventId, at).toMatch(/^evt_/);
          // Call and result IDs must be distinct unless a terminal single-row atomic command path is used.
          const resultEventId = observation.resultEventId;
          if (resultEventId !== undefined) {
            expect(resultEventId, `${at} missing a result id`).toBeDefined();
            expect(resultEventId, at).toMatch(/^evt_/);
            if (resultEventId !== observation.callEventId) {
              const resultEvent = eventById.get(resultEventId);
              expect(resultEvent, `${at} missing result row`).toBeDefined();
              if (callEvent !== undefined && resultEvent !== undefined) {
                expect(
                  resultEvent.causalRef.causalSequence,
                  `${at} result before call`,
                ).toBeGreaterThan(callEvent.causalRef.causalSequence);
              }
            }
          }

          // A definition-only cell, pending call and failed call are never business computation.
          expect(isSubstantiveComputationEvidence(carrier.evidence), at).toBe(successfulInvocation);

          carriersSeen += 1;
          if (successfulInvocation) substantiveSeen += 1;
          if (observation.status === "pending") pendingSeen += 1;
          if (observation.kind === "definition") definitionOnlySeen += 1;

          if (!successfulInvocation) continue;

          expect(evidence.program.complete, at).toBe(true);
          expect(evidence.program.unsupportedReasons, at).toEqual([]);
          // Substantive evidence carries a structural output and a real result linkage.
          expect(evidence.program.outputs.length, at).toBeGreaterThan(0);
          expect(observation.resultEventId, at).toBeDefined();
          expect(observation.callId, at).toBeDefined();
          expect(declared, `${at} counted an undeclared call as business computation`).toContain(
            observation.callId,
          );
          expect(
            eventById.has(observation.callEventId),
            `${at} links to a call row that was never observed`,
          ).toBe(true);
          if (observation.resultEventId !== undefined) {
            const resultEvent = eventById.get(observation.resultEventId);
            expect(
              resultEvent,
              `${at} links to a result row that was never observed`,
            ).toBeDefined();
          }

          // A helper resolved from earlier observed state keeps its real provenance.
          if (requiresObservedHelperClosure(variant)) {
            expect(
              evidence.dependencies.length,
              `${at} resolved no observed helper closure`,
            ).toBeGreaterThan(0);
          }
          for (const dependency of evidence.dependencies) {
            expect(dependency.sourceEventId, at).toMatch(/^evt_/);
            expect(dependency.programDigest, at).toMatch(/^[a-f0-9]{64}$/);
            const source = eventById.get(dependency.sourceEventId);
            expect(source, `${at} missing dependency source row`).toBeDefined();
            const sourceEvidence = evidenceFromEvent(source!, `${at} dependency source`);
            expect(sourceEvidence.observation.kind, `${at} dependency source not definition`).toBe(
              "definition",
            );
            expect(
              sourceEvidence.observation.status,
              `${at} dependency source not successful`,
            ).toBe("success");
          }
        }

        // Every declared dataset invocation is a successful substantive carrier on both surfaces.
        for (const dataset of variant.datasets) {
          const callIds = [
            dataset.invocationCallId,
            ...(dataset.superseded === undefined ? [] : [dataset.superseded.invocationCallId]),
          ];
          for (const callId of callIds) {
            const matches = successfulInvocationCarriers(parsed, callId);
            expect(matches.length, `${label} ${dataset.datasetId} ${callId}`).toBeGreaterThan(0);
            const surfaces = new Set(matches.map((entry) => entry.carrier.surface));
            expect(
              surfaces.has("local") && surfaces.has("cloud"),
              `${label} ${callId} missing a capture surface`,
            ).toBe(true);
            const callEventIds = new Set(
              matches.map((entry) => entry.evidence.observation.callEventId),
            );
            expect(
              callEventIds.size,
              `${label} ${callId} reused a consumed call id across dataset surfaces`,
            ).toBe(1);
            for (const entry of matches) {
              expect(entry.evidence.program.complete, callId).toBe(true);
              expect(
                isSubstantiveComputationEvidence(entry.carrier.evidence),
                `${label} ${callId}`,
              ).toBe(true);
            }
          }
        }

        // The cloud batch carries the byte-identical carrier the local sink observed.
        const localByEventId = new Map(
          environment.localEvents.map((event) => [event.eventId, event]),
        );
        let compared = 0;
        for (const row of environment.cloudRows) {
          if (row.sessionId !== variant.sessionId) continue;
          const evidence = row.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
          if (evidence === undefined) continue;
          const local = localByEventId.get(row.eventId);
          expect(
            projectEventToMetadataOnly(row).metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
            `${label} ${row.eventId}`,
          ).toEqual(evidence);
          if (local !== undefined) {
            expect(local.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]).toEqual(evidence);
            compared += 1;
          }
        }
        expect(compared, `${label} compared no dual-surface carrier`).toBeGreaterThan(0);

        // No carrier or projected metadata row leaks a planted fixture canary.
        for (const event of [...environment.localEvents, ...environment.cloudRows]) {
          if (event.sessionId !== variant.sessionId) continue;
          const serializedMetadata = JSON.stringify(event.metadata ?? {});
          const serializedRow = JSON.stringify(event);
          for (const canary of canaries) {
            expect(serializedMetadata, `${label} metadata leaked a canary`).not.toContain(canary);
            expect(serializedRow, `${label} row leaked a canary`).not.toContain(canary);
          }
        }
      }
    }

    expect(carriersSeen).toBeGreaterThan(0);
    expect(substantiveSeen).toBeGreaterThan(0);
    // Definition-only and unresolved pending captures are observed across the corpus and hold no
    // business computation of their own: the per-carrier accounting above already rejects them.
    expect(definitionOnlySeen).toBeGreaterThan(0);
    expect(pendingSeen).toBeGreaterThan(0);
    expect(pendingSeen).toBeLessThan(carriersSeen);
  });

  it("keeps only the corrected helper version and reports the superseded digest", async () => {
    const family = families.find((entry) => entry.familyId === "record-join-lineage")!;
    const variant = family.variants[0]!;
    expect(variant.kind).toBe("corrected-helper");

    const environment = await capture(family, variant);
    const parsed = carriersFor(environment, variant).map((carrier) => ({
      carrier,
      evidence: strictEvidence(
        carrier,
        `${variant.variantId} ${carrier.surface}:${carrier.eventId}`,
      ),
    }));

    for (const dataset of variant.datasets) {
      const superseded = dataset.superseded;
      expect(superseded, dataset.datasetId).toBeDefined();
      const before = successfulInvocationCarriers(parsed, superseded!.invocationCallId);
      const after = successfulInvocationCarriers(parsed, dataset.invocationCallId);
      expect(before.length, `${dataset.datasetId} pre-correction`).toBeGreaterThan(0);
      expect(after.length, `${dataset.datasetId} post-correction`).toBeGreaterThan(0);

      // Both successful runs resolved an observed helper version; pending snapshots with the same
      // call id remain covered by the corpus-wide non-substantive assertion above.
      for (const entry of [...before, ...after]) {
        expect(entry.evidence.observation.kind).toBe("invocation");
        expect(entry.evidence.observation.status).toBe("success");
        expect(entry.evidence.program.complete).toBe(true);
        expect(entry.evidence.dependencies.length).toBeGreaterThan(0);
        expect(isSubstantiveComputationEvidence(entry.carrier.evidence)).toBe(true);
      }

      const beforeEvidence = before[0]!.evidence;
      const afterEvidence = after[0]!.evidence;
      // The corrected helper is a different algorithm and says what it replaced.
      expect(afterEvidence.programDigest).not.toBe(beforeEvidence.programDigest);
      expect(afterEvidence.corrections.length).toBeGreaterThan(0);

      const beforeDigests = new Set(
        beforeEvidence.dependencies.map((dependency) => dependency.programDigest),
      );
      const afterDigests = new Set(
        afterEvidence.dependencies.map((dependency) => dependency.programDigest),
      );
      const beforeSources = new Set(
        beforeEvidence.dependencies.map((dependency) => dependency.sourceEventId),
      );
      const afterSources = afterEvidence.dependencies.map((dependency) => dependency.sourceEventId);
      const afterIds = afterEvidence.dependencies.map((dependency) => dependency.definitionId);
      expect(new Set(afterIds).size).toBe(afterIds.length);
      // Final invocation references at least one corrected definition source.
      expect(afterSources.some((sourceEventId) => !beforeSources.has(sourceEventId))).toBe(true);

      for (const correction of afterEvidence.corrections) {
        expect(correction.supersededProgramDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(correction.supersededProgramDigest).not.toBe(afterEvidence.programDigest);
        // The reported version is exactly the one the pre-correction cell resolved...
        expect(beforeDigests.has(correction.supersededProgramDigest)).toBe(true);
        // ...and the corrected closure no longer resolves that superseded version.
        expect(afterDigests.has(correction.supersededProgramDigest)).toBe(false);
        // The correction names a definition materialized in this carrier's own closure.
        expect(
          afterEvidence.program.definitions.some(
            (definition) => definition.id === correction.supersedesDefinitionId,
          ) ||
            afterEvidence.dependencies.some(
              (dependency) => dependency.definitionId === correction.supersedesDefinitionId,
            ),
        ).toBe(true);
      }
    }
  });
});
