import { OmpRecordDecoder } from "@resin/adapter-omp";
import {
  type NormalizedSessionEvent,
  RESIN_COMPUTATION_EVIDENCE_KEY,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
} from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import {
  type ComputationFixtureFamily,
  type ComputationFixtureVariant,
  type OmpFixtureRecord,
  type OmpFixtureToolName,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
  collectOmpFixtureToolResults,
} from "@resin/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { projectEventToMetadataOnly } from "../../../src/analytics/metadata-projection.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../../src/index.js";

/**
 * Integration coverage for the computation-evidence pipeline through the REAL capture path:
 * native OMP-shaped fixture records -> actual OmpRecordDecoder -> actual NormalizationPipeline ->
 * coordinator hook -> both the local metadata sink and the cloud observation batch.
 *
 * Nothing here fabricates normalized events or IR. Every carrier asserted on is produced by the
 * shipped recorder from the shipped parser over the shipped fixture sources, so a regression in any
 * of those stages fails this suite rather than passing on a hand-built stand-in.
 */

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

/** One assistant toolCall turn with its start/end envelopes, in causal order. */
function fixtureTurn(
  sessionId: string,
  callId: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
  result: string,
): OmpFixtureRecord[] {
  const timestamp = new Date().toISOString();
  return [
    {
      type: "message",
      role: "assistant",
      sessionId,
      timestamp,
      model: "synthetic-capture-fixture",
      content: [
        { type: "text", text: "capture fixture turn" },
        {
          type: "toolCall",
          id: callId,
          name: toolName as OmpFixtureToolName,
          arguments: toolArguments as never,
        },
      ],
    },
    {
      type: "custom",
      customType: "tool_execution_start",
      sessionId,
      timestamp,
      data: { toolCallId: callId, toolName: toolName as OmpFixtureToolName },
    },
    {
      type: "custom",
      customType: "tool_execution_end",
      sessionId,
      timestamp,
      data: {
        toolCallId: callId,
        toolName: toolName as OmpFixtureToolName,
        result,
        isError: false,
      },
    },
  ];
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

function createFakeCloudClient() {
  const submitted: TrajectoryObservation[] = [];
  const batches: unknown[] = [];
  // SAFETY: Fake implements the two submission methods the coordinator calls.
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

interface CaptureEnvironment {
  coordinator: TrajectoryCaptureCoordinator;
  pipeline: NormalizationPipeline;
  cloud: ReturnType<typeof createFakeCloudClient>;
  localEvents: NormalizedSessionEvent[];
  /** Rows observed by the local sink, paired with the cloud row for the same event id. */
  localByEventId: () => Map<string, NormalizedSessionEvent>;
}

function createCaptureEnvironment(options?: { attributed?: boolean }): CaptureEnvironment {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(new OmpRecordDecoder());
  const cloud = createFakeCloudClient();
  const localEvents: NormalizedSessionEvent[] = [];
  const attributed = options?.attributed ?? false;
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: cloud.client,
    attributionResolver: attributed
      ? async (session: HarnessSession) => ({
          accountId: "acc_fixture",
          workspaceId: session.workspaceId,
          ownerUserId: "usr_fixture",
          projectId: "prj_fixture",
          candidateId: "cnd_fixture",
          toolId: session.harnessId,
          toolVersion: "1.0.0",
          workloadId: "wl_fixture",
          trajectoryId: `traj_${session.sessionId}`,
          parentTrajectoryId: null,
          runtimeVersion: "1.0.0",
          role: "candidate",
          status: "success",
          isEquivalent: false,
          catalogExposureTokens: 0,
        })
      : async () => null,
    // Coalescing off so one batch equals one handled batch, which keeps the assertion boundaries
    // explicit instead of depending on a dwell timer.
    coalesceDwellMs: 0,
  });
  coordinator.setSessionEventSink((_session, events) => {
    localEvents.push(...events);
  });
  return {
    coordinator,
    pipeline,
    cloud,
    localEvents,
    localByEventId: () => {
      const map = new Map<string, NormalizedSessionEvent>();
      for (const event of localEvents) {
        map.set(event.eventId, event);
      }
      return map;
    },
  };
}

/**
 * Feeds one fixture variant's records through the real decoder + pipeline + coordinator in batches
 * that split each tool turn, so call and result are exercised across capture batches.
 */
async function captureVariant(
  environment: CaptureEnvironment,
  variant: ComputationFixtureVariant,
): Promise<void> {
  const session = sessionFor(variant.sessionId);
  const records = variant.records.map((record, index) => rawRecord(record, index));
  // One raw record per batch: the strongest cross-batch coverage, and it matches how a tailer
  // delivers an appended transcript line at a time.
  for (const record of records) {
    await environment.coordinator.handleRecords(session, [record], async () => {});
  }
  // A terminal status flushes a generic coalescing buffer immediately.
  await environment.coordinator.handleRecords(
    { ...session, status: "completed" },
    [],
    async () => {},
  );
  await environment.coordinator.waitForIdle();
}

/** Every carrier the pipeline produced for a variant, from both local and cloud surfaces. */
function carriersFor(
  environment: CaptureEnvironment,
  variant: ComputationFixtureVariant,
): Array<{ surface: "local" | "cloud"; eventId: string; evidence: unknown }> {
  const carriers: Array<{ surface: "local" | "cloud"; eventId: string; evidence: unknown }> = [];
  for (const event of environment.localEvents) {
    if (event.sessionId !== variant.sessionId) continue;
    const evidence = event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
    if (evidence !== undefined) {
      carriers.push({ surface: "local", eventId: event.eventId, evidence });
    }
  }
  for (const batchRow of environment.cloud.batches) {
    const row = batchRow as NormalizedSessionEvent;
    if (row.sessionId !== variant.sessionId) continue;
    const evidence = row.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
    if (evidence !== undefined) {
      carriers.push({ surface: "cloud", eventId: row.eventId, evidence });
    }
  }
  return carriers;
}

function substantiveCarriers(
  environment: CaptureEnvironment,
  variant: ComputationFixtureVariant,
): Array<{ surface: "local" | "cloud"; eventId: string; evidence: unknown }> {
  return carriersFor(environment, variant).filter((carrier) =>
    isSubstantiveComputationEvidence(carrier.evidence),
  );
}

it("captures completed computation from nested OMP messages without explicit start markers", async () => {
  const sessionId = "omp-embedded-only-capture";
  const callId = "embedded-eval-call";
  const code = "items = [2, 4, 6]\nprint(sum(items))";
  const environment = createCaptureEnvironment();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const rows = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: callId, name: "eval", arguments: { language: "py", code } },
        ],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "eval",
        content: [{ type: "text", text: "12" }],
        isError: false,
      },
    },
  ];
  const records: RawHarnessRecord[] = rows.map((row, index) => ({
    recordId: `embedded-record-${index}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: index + 1,
    timestamp,
    recordType: "transcript_line",
    rawPayload: JSON.stringify(row),
    cursor: { offset: index * 100, line: index + 1, sequence: index + 1, timestamp },
    metadata: {},
  }));
  const session = sessionFor(sessionId);
  for (const record of records) {
    await environment.coordinator.handleRecords(session, [record], async () => {});
  }
  await environment.coordinator.handleRecords(
    { ...session, status: "completed" },
    [],
    async () => {},
  );
  await environment.coordinator.waitForIdle();
  const projected = environment.cloud.batches as NormalizedSessionEvent[];
  const calls = projected.filter((event) => event.type === "tool_call");
  const results = projected.filter((event) => event.type === "tool_result");
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(calls[0]?.type === "tool_call" && calls[0].callId).toBe(callId);
  const evidence = readComputationEvidence(results[0]?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]);
  expect(evidence?.observation).toMatchObject({
    callId,
    status: "success",
    callEventId: calls[0]?.eventId,
    resultEventId: results[0]?.eventId,
  });
  expect(evidence?.program.complete).toBe(true);
  expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain(code);
  expect(JSON.stringify(projected)).not.toContain("__resinLocalOmpNativeCallV1");
});

// ============================================================================
// Shared fixture families
// ============================================================================

describe("Computation capture integration (native fixtures through the real pipeline)", () => {
  const families = buildComputationFixtureFamilies();

  it("exposes all four ordinary-algorithm fixture families with both capture shapes", () => {
    expect(families.map((family) => family.familyId).sort()).toEqual([
      "cpu-pss-delta",
      "process-snapshot-ownership",
      "record-join-lineage",
      "record-schema-order",
    ]);
    for (const family of families) {
      expect(family.variants.length).toBeGreaterThan(0);
    }
  });

  it.each([false, true])(
    "captures marker-first native eval across batches without leaking source or changing results (attributed=%s)",
    async (attributed) => {
      const environment = createCaptureEnvironment({ attributed });
      const session = sessionFor(`session-marker-first-${attributed}`);
      const normalized: NormalizedSessionEvent[] = [];
      const processRecord = environment.pipeline.processRecord.bind(environment.pipeline);
      vi.spyOn(environment.pipeline, "processRecord").mockImplementation(async (...args) => {
        const outcomes = await processRecord(...args);
        for (const outcome of outcomes) {
          if (outcome.status === "success") normalized.push(outcome.event);
        }
        return outcomes;
      });
      const cells = [
        { code: "import json\nfrom pathlib import Path", output: "(no output)" },
        {
          code: [
            'values = json.loads(Path("values.json").read_text())',
            'doubled = [item["amount"] * 2 for item in values]',
            'print(json.dumps({"values": sorted(doubled)}))',
            "# OMP_ORDER_SOURCE_ONLY_SENTINEL",
          ].join("\n"),
          output: '{"values":[4,8]}',
        },
      ];
      let sequence = 0;
      let finalResultRecord: RawHarnessRecord | undefined;
      for (const [index, cell] of cells.entries()) {
        const callId = `call-marker-first-${index}|fc-public-${index}`;
        const payloads = [
          {
            type: "custom",
            customType: "tool_execution_start",
            data: { toolCallId: callId, toolName: "eval" },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-4o",
              usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
              content: [
                {
                  type: "toolCall",
                  id: callId,
                  name: "eval",
                  arguments: { language: "py", code: cell.code, reset: false },
                },
              ],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: callId,
              toolName: "eval",
              content: [{ type: "text", text: cell.output }],
              isError: false,
              details: { durationMs: 3 },
            },
          },
        ];
        for (const payload of payloads) {
          sequence += 1;
          const timestamp = `2026-09-13T12:00:0${sequence}.000Z`;
          const record: RawHarnessRecord = {
            recordId: `rec-marker-first-${attributed}-${sequence}`,
            sessionId: session.sessionId,
            harnessId: "omp",
            sequenceNumber: sequence,
            timestamp,
            recordType: "transcript_line",
            rawPayload: JSON.stringify(payload),
            cursor: { offset: sequence * 100, line: sequence, sequence, timestamp },
            metadata: {},
          };
          await environment.coordinator.handleRecords(session, [record], async () => {});
          finalResultRecord = record;
        }
      }
      await environment.coordinator.handleRecords(
        { ...session, status: "completed" },
        [],
        async () => {},
      );
      await environment.coordinator.waitForIdle();

      const result = normalized.find(
        (event) =>
          event.type === "tool_result" && event.callId === "call-marker-first-1_fc-public-1",
      );
      expect(result?.type).toBe("tool_result");
      if (result?.type !== "tool_result") throw new Error("missing native result");
      expect(result.result).toBe(cells[1]!.output);
      expect(result.executionDurationMs).toBe(3);
      expect(result.metadata?.__resinLocalOmpNativeCallV1).toMatchObject({
        callId: result.callId,
        toolName: "eval",
        parameters: { language: "py", code: cells[1]!.code },
      });
      const baseline = new NormalizationPipeline();
      baseline.registerDecoder(new OmpRecordDecoder());
      const baselineOutcomes = await baseline.processRecord(finalResultRecord!);
      expect(baselineOutcomes[0]?.status).toBe("success");
      const baselineOutcome = baselineOutcomes[0]!;
      if (baselineOutcome.status !== "success") throw new Error("missing baseline result");
      expect(result.metadata?.resinTokenEstimateV1).toEqual(
        baselineOutcome.event.metadata?.resinTokenEstimateV1,
      );

      for (const events of [
        environment.localEvents,
        ...(attributed ? [] : [environment.cloud.batches as NormalizedSessionEvent[]]),
      ]) {
        const captured = events.find(
          (event) =>
            event.type === "tool_result" && event.callId === "call-marker-first-1_fc-public-1",
        );
        const evidence = readComputationEvidence(
          captured?.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY],
        );
        expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
        expect(evidence?.observation.resultEventId).toBe(captured?.eventId);
        expect(evidence?.program.complete).toBe(true);
        expect(JSON.stringify(events)).not.toContain("__resinLocalOmpNativeCallV1");
        expect(JSON.stringify(events)).not.toContain("OMP_ORDER_SOURCE_ONLY_SENTINEL");
        expect(JSON.stringify(events)).not.toContain(cells[1]!.code);
      }
      if (attributed) {
        // Attributed runs upload calibration metrics, not session-event rows.
        expect(environment.cloud.submitted).toHaveLength(1);
        expect(environment.cloud.batches).toHaveLength(0);
        expect(JSON.stringify(environment.cloud.submitted)).not.toContain(
          "__resinLocalOmpNativeCallV1",
        );
        expect(JSON.stringify(environment.cloud.submitted)).not.toContain(
          "OMP_ORDER_SOURCE_ONLY_SENTINEL",
        );
      }
      expect(JSON.stringify(projectEventToMetadataOnly(result))).not.toContain(
        "__resinLocalOmpNativeCallV1",
      );
    },
  );

  it("produces only causally justified evidence for every fixture family", async () => {
    for (const family of families) {
      for (const variant of family.variants) {
        const environment = createCaptureEnvironment();
        await captureVariant(environment, variant);

        const calls = collectOmpFixtureToolCalls(variant.records);

        // Every carrier the pipeline produced is self-consistent: a pending call carries no result
        // identity, success evidence belongs to an observed call, and substantiveness exactly matches
        // a successful invocation.
        for (const carrier of carriersFor(environment, variant)) {
          const evidence = readComputationEvidence(carrier.evidence);
          expect(evidence, `${variant.variantId} ${carrier.surface}`).toBeDefined();
          const { observation } = evidence!;
          if (observation.status === "success") {
            expect(observation.resultEventId).toBeDefined();
          } else {
            expect(observation.resultEventId).toBeUndefined();
          }
          if (observation.kind === "invocation" && observation.status === "success") {
            expect(
              calls.some((call) => call.callId === observation.callId),
              `${variant.variantId} ${carrier.surface} paired an unknown call`,
            ).toBe(true);
          }
          expect(isSubstantiveComputationEvidence(carrier.evidence)).toBe(
            observation.kind === "invocation" && observation.status === "success",
          );
        }
      }
    }
  });

  it("produces substantive evidence on both surfaces for the python definition/use families", async () => {
    const family = families.find((entry) => entry.familyId === "record-join-lineage")!;
    for (const variant of family.variants) {
      const environment = createCaptureEnvironment();
      await captureVariant(environment, variant);

      const substantive = substantiveCarriers(environment, variant);
      const declared = variant.datasets.flatMap((dataset) => [
        dataset.invocationCallId,
        ...(dataset.superseded ? [dataset.superseded.invocationCallId] : []),
      ]);
      expect(declared.length).toBeGreaterThan(0);

      for (const callId of declared) {
        const matches = substantive.filter(
          (carrier) => readComputationEvidence(carrier.evidence)?.observation.callId === callId,
        );
        expect(matches.length, `${variant.variantId} ${callId}`).toBeGreaterThan(0);
        const surfaces = new Set(matches.map((carrier) => carrier.surface));
        expect(surfaces.has("local") && surfaces.has("cloud")).toBe(true);

        // The helper the use cell inlined is a materialized dependency with a real observed origin.
        const evidence = readComputationEvidence(matches[0]!.evidence)!;
        expect(evidence.dependencies.length).toBeGreaterThan(0);
        for (const dependency of evidence.dependencies) {
          expect(dependency.sourceEventId.length).toBeGreaterThan(0);
          expect(dependency.programDigest).toMatch(/^[a-f0-9]{64}$/);
        }
      }
    }
  });

  it("produces substantive evidence for both javascript fixture families on both surfaces", async () => {
    for (const familyId of ["record-schema-order", "cpu-pss-delta"]) {
      const family = families.find((entry) => entry.familyId === familyId)!;
      for (const variant of family.variants) {
        const environment = createCaptureEnvironment();
        await captureVariant(environment, variant);

        const substantive = substantiveCarriers(environment, variant);
        const declared = variant.datasets.map((dataset) => dataset.invocationCallId);
        expect(declared.length).toBeGreaterThan(0);

        for (const callId of declared) {
          const matches = substantive.filter(
            (carrier) => readComputationEvidence(carrier.evidence)?.observation.callId === callId,
          );
          expect(matches.length, `${variant.variantId} ${callId}`).toBeGreaterThan(0);
          const surfaces = new Set(matches.map((carrier) => carrier.surface));
          expect(surfaces.has("local") && surfaces.has("cloud")).toBe(true);

          const evidence = readComputationEvidence(matches[0]!.evidence)!;
          expect(evidence.program.language).toBe("javascript");
          expect(evidence.observation.kind).toBe("invocation");
          expect(evidence.observation.status).toBe("success");
          // The authored helper/module this cell resolved is a materialized dependency with a real
          // observed origin, so the closure is self-contained without private kernel state.
          expect(evidence.dependencies.length).toBeGreaterThan(0);
          for (const dependency of evidence.dependencies) {
            expect(dependency.sourceEventId.length).toBeGreaterThan(0);
            expect(dependency.programDigest).toMatch(/^[a-f0-9]{64}$/);
          }
          expect(isSubstantiveComputationEvidence(evidence)).toBe(true);
        }
      }
    }
  });

  it("resolves an imported observed helper module for an executed javascript script", async () => {
    // The schema-order script imports the shared `record-io.mjs` helper module authored earlier in
    // the same session: executing it statically resolves that observed module body.
    const family = families.find((entry) => entry.familyId === "record-schema-order")!;
    const variant = family.variants.find((entry) => entry.kind === "file-write-then-execute")!;
    const environment = createCaptureEnvironment();
    await captureVariant(environment, variant);

    const executed = carriersFor(environment, variant)
      .map((carrier) => readComputationEvidence(carrier.evidence))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined)
      .filter(
        (evidence) =>
          evidence.origin.kind === "referenced_file" && evidence.observation.kind === "invocation",
      );

    expect(executed.length).toBeGreaterThan(0);
    const withDependencies = executed.filter((evidence) => evidence.dependencies.length > 0);
    expect(withDependencies.length).toBeGreaterThan(0);
    // Only the dependency-reachable helper is inlined, and it names the event that observed it.
    for (const evidence of withDependencies) {
      expect(evidence.observation.kind).toBe("invocation");
      for (const dependency of evidence.dependencies) {
        expect(dependency.sourceEventId).toMatch(/^evt_/);
        expect(dependency.programDigest).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("captures the complete ownership script without dropping its closure", async () => {
    const ownership = families.find((entry) => entry.familyId === "process-snapshot-ownership")!;
    const variant = ownership.variants.find((entry) => entry.kind === "file-write-then-execute")!;
    const environment = createCaptureEnvironment();
    await captureVariant(environment, variant);

    for (const carrier of carriersFor(environment, variant)) {
      expect(readComputationEvidence(carrier.evidence)).toBeDefined();
    }
    for (const dataset of variant.datasets) {
      const matches = substantiveCarriers(environment, variant).filter(
        (carrier) =>
          readComputationEvidence(carrier.evidence)?.observation.callId ===
          dataset.invocationCallId,
      );
      expect(matches.length, dataset.invocationCallId).toBeGreaterThan(0);
      expect(matches.some((carrier) => carrier.surface === "local")).toBe(true);
      expect(matches.some((carrier) => carrier.surface === "cloud")).toBe(true);
    }
  });

  it("carries identical validated evidence on the local sink and the cloud batch for the same event", async () => {
    const joinFamily = families.find((family) => family.familyId === "record-join-lineage")!;
    const variant = joinFamily.variants[0]!;
    const environment = createCaptureEnvironment();
    await captureVariant(environment, variant);

    const localCarriers = new Map<string, unknown>();
    for (const event of environment.localEvents) {
      if (event.sessionId !== variant.sessionId) continue;
      const evidence = event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
      if (evidence !== undefined) {
        localCarriers.set(event.eventId, evidence);
      }
    }
    expect(localCarriers.size).toBeGreaterThan(0);

    let compared = 0;
    for (const row of environment.cloud.batches) {
      const event = row as NormalizedSessionEvent;
      if (event.sessionId !== variant.sessionId) continue;
      const evidence = event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY];
      if (evidence === undefined) continue;
      // The upload projection is the same metadata-only projection the local sink received, so the
      // carrier is byte-identical rather than re-derived per surface.
      expect(projectEventToMetadataOnly(event).metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]).toEqual(
        evidence,
      );
      if (localCarriers.has(event.eventId)) {
        expect(localCarriers.get(event.eventId)).toEqual(evidence);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("attributes the corrected helper version and reports its superseded digest", async () => {
    const joinFamily = families.find((family) => family.familyId === "record-join-lineage")!;
    const variant = joinFamily.variants[0]!;
    expect(variant.kind).toBe("corrected-helper");

    const environment = createCaptureEnvironment();
    await captureVariant(environment, variant);

    const superseded = variant.datasets[0]!.superseded;
    expect(superseded).toBeDefined();

    const all = carriersFor(environment, variant)
      .map((carrier) => readComputationEvidence(carrier.evidence))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);

    // The pre-correction observations exist and are distinct from the corrected ones.
    const corrected = all.filter((evidence) => evidence.corrections.length > 0);
    expect(corrected.length).toBeGreaterThan(0);
    for (const evidence of corrected) {
      expect(evidence.observation.status).toBe("success");
      expect(evidence.corrections[0]!.supersededProgramDigest).toMatch(/^[a-f0-9]{64}$/);
      // A superseded program digest is never the digest of the evidence carrying it.
      expect(evidence.corrections[0]!.supersededProgramDigest).not.toBe(evidence.programDigest);
      // The correction names either a helper materialized in this closure or a definition this very
      // cell authored; it never dangles.
      const knownIds = new Set([
        ...evidence.dependencies.map((entry) => entry.definitionId),
        ...evidence.program.definitions.map((definition) => definition.id),
      ]);
      expect(knownIds.has(evidence.corrections[0]!.supersedesDefinitionId)).toBe(true);
    }
    // The invocation that resolved the corrected helper is still a successful invocation.
    const correctedInvocations = corrected.filter(
      (evidence) => evidence.observation.kind === "invocation",
    );
    expect(correctedInvocations.length).toBeGreaterThan(0);
  });

  it("never treats an observed file body as a successful invocation of its own text", async () => {
    // The fixture's own helper source, authored to a file whose text also calls the helper at module
    // level: observing the body must stay definition-only however the text reads.
    const join = families.find((entry) => entry.familyId === "record-join-lineage")!;
    const helper = join.variants[0]!.supersededDefinitionSource!;
    const sessionId = "sess_capture_file_body";
    const environment = createCaptureEnvironment();
    const session = sessionFor(sessionId);
    const body = `${helper}\njoin_records([], {}, {})\n`;

    for (const [index, record] of fixtureTurn(
      sessionId,
      "call-write-body",
      "write",
      { path: "tools/join.py", content: body },
      "Wrote tools/join.py",
    ).entries()) {
      await environment.coordinator.handleRecords(
        session,
        [rawRecord(record, index)],
        async () => {},
      );
    }
    await environment.coordinator.waitForIdle();

    const carriers = environment.localEvents.filter(
      (event) =>
        event.sessionId === sessionId &&
        event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY] !== undefined,
    );
    expect(carriers.length).toBeGreaterThan(0);
    for (const event of carriers) {
      const evidence = readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY])!;
      expect(evidence.origin.kind).toBe("authored_file");
      expect(evidence.observation.kind).toBe("definition");
      expect(isSubstantiveComputationEvidence(evidence)).toBe(false);
    }
  });

  it("keeps every observed file body definition-only across all families", async () => {
    for (const family of families) {
      for (const variant of family.variants) {
        const environment = createCaptureEnvironment();
        await captureVariant(environment, variant);
        for (const carrier of carriersFor(environment, variant)) {
          const evidence = readComputationEvidence(carrier.evidence);
          expect(evidence).toBeDefined();
          if (evidence!.origin.kind === "authored_file") {
            expect(evidence!.observation.kind, variant.variantId).toBe("definition");
            expect(isSubstantiveComputationEvidence(evidence), variant.variantId).toBe(false);
          }
        }
      }
    }
  });

  it("resolves a referenced observed script body for the executing cell", async () => {
    // A helper script authored first, then executed: the executing cell resolves the freshly
    // observed file body as its origin rather than reviving anything from another process.
    const join = families.find((entry) => entry.familyId === "record-join-lineage")!;
    const helper = join.variants[0]!.supersededDefinitionSource!;
    const sessionId = "sess_capture_referenced";
    const environment = createCaptureEnvironment();
    const session = sessionFor(sessionId);
    const records = [
      ...fixtureTurn(
        sessionId,
        "call-mod-write",
        "write",
        {
          path: "tools/join.py",
          content: `${helper}\n`,
        },
        "Wrote tools/join.py",
      ),
    ];
    for (const [index, record] of records.entries()) {
      await environment.coordinator.handleRecords(
        session,
        [rawRecord(record, index)],
        async () => {},
      );
    }
    await environment.coordinator.waitForIdle();

    const authored = environment.localEvents
      .map((event) => readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined)
      .filter((evidence) => evidence.origin.kind === "authored_file");
    // The authored body is retained as an observed file, and never promoted to an invocation.
    expect(authored.length).toBeGreaterThan(0);
    for (const evidence of authored) {
      expect(evidence.observation.kind).toBe("definition");
      expect(isSubstantiveComputationEvidence(evidence)).toBe(false);
    }
  });

  it("drops every fixture canary from both carriers and projected metadata", async () => {
    for (const family of families) {
      for (const variant of family.variants) {
        const environment = createCaptureEnvironment();
        await captureVariant(environment, variant);

        const canaries = new Set<string>([
          ...family.canaries,
          ...variant.datasets.flatMap((dataset) => dataset.canaries),
        ]);
        // Fixture token values are the canaries to look for, not their identifiers.
        const canaryValues = [...canaries]
          .map((canary) => String(canary))
          .filter((value) => value.length > 8);
        if (canaryValues.length === 0) continue;

        for (const carrier of carriersFor(environment, variant)) {
          const serialized = JSON.stringify(carrier.evidence);
          for (const value of canaryValues) {
            expect(serialized, `${variant.variantId} leaked a canary`).not.toContain(value);
          }
        }
        for (const event of environment.localEvents) {
          if (event.sessionId !== variant.sessionId) continue;
          const serialized = JSON.stringify(event.metadata ?? {});
          for (const value of canaryValues) {
            expect(serialized, `${variant.variantId} metadata leaked a canary`).not.toContain(
              value,
            );
          }
        }
      }
    }
  });

  it("clears observed source state when telemetry is withdrawn at the privacy boundary", async () => {
    const joinFamily = families.find((family) => family.familyId === "record-join-lineage")!;
    const variant = joinFamily.variants[0]!;
    const sessionId = variant.sessionId;
    const environment = createCaptureEnvironment();
    const records = variant.records.map((record, index) => rawRecord(record, index));

    // The definition cell commits the helper into the recorder kernel.
    for (const record of records.slice(0, 4)) {
      await environment.coordinator.handleRecords(sessionFor(sessionId), [record], async () => {});
    }
    const beforeWithdrawal = environment.localEvents.filter(
      (event) =>
        event.sessionId === sessionId &&
        event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY] !== undefined,
    );
    expect(beforeWithdrawal.length).toBeGreaterThan(0);

    // Consent withdrawal and a privacy-cutoff advance both drop all observed source state, so a
    // pre-revocation helper can never be revived into later evidence.
    environment.coordinator.setTelemetryEnabled(false);
    environment.coordinator.setTelemetryEnabled(true);
    environment.localEvents.length = 0;

    // The first post-boundary cell is exactly the one that would inline the withdrawn helper.
    for (const record of records.slice(4, 7)) {
      await environment.coordinator.handleRecords(sessionFor(sessionId), [record], async () => {});
    }

    const revived = environment.localEvents
      .map((event) => readComputationEvidence(event.metadata?.[RESIN_COMPUTATION_EVIDENCE_KEY]))
      .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined)
      .filter((evidence) => evidence.dependencies.length > 0);
    expect(revived).toHaveLength(0);
  });
});
