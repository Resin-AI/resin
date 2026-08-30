import { randomUUID } from "node:crypto";
import { ClaudeRecordDecoder } from "@resin/adapter-claude-code";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import { OmpRecordDecoder } from "@resin/adapter-omp";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { type Mock, describe, expect, it, vi } from "vitest";
import {
  CloudObservationClient,
  NormalizationPipeline,
  type TrajectoryAttributionContextInput,
  type TrajectoryAttributionResolver,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
  TrajectoryObservationSchema,
} from "../../src/index.js";
import type { JsonObject } from "../../src/normalization/redaction.js";

// ============================================================================
// Test Helpers & Boundary Fakes
// ============================================================================

function createFakeCloudObservationClient(opts?: { failFirstCount?: number }) {
  let failRemaining = opts?.failFirstCount ?? 0;
  const submittedBatches: Array<{ observations: TrajectoryObservation[] }> = [];

  // SAFETY: Fake cloud observation client implements sendTrajectoryObservationBatch for integration tests.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  client.sendTrajectoryObservationBatch = vi.fn(
    async (input: { observations: TrajectoryObservation[] }) => {
      if (failRemaining > 0) {
        failRemaining--;
        throw new Error("Simulated transient upstream 503 Service Unavailable");
      }
      submittedBatches.push(input);
      return {
        batchId: `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        accepted: input.observations.length,
        rejected: 0,
        errors: [],
      };
    },
  );

  return {
    client,
    submittedBatches,
    get submittedObservations(): TrajectoryObservation[] {
      return submittedBatches.flatMap((b) => b.observations);
    },
  };
}

function createHarnessSession(
  sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  harnessId = "claude-code",
  status: "active" | "idle" | "completed" | "interrupted" | "failed" | "unknown" = "completed",
): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_test_01",
    harnessId,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      tool: harnessId,
      workspaceName: "resin-workspace",
    },
  };
}

function createAttributionContext(
  session: HarnessSession,
  overrides: Partial<TrajectoryAttributionContextInput> = {},
): TrajectoryAttributionContextInput {
  return {
    accountId: "acc_test_enterprise",
    workspaceId: session.workspaceId,
    ownerUserId: "usr_lead_engineer",
    projectId: "proj_resin_observer",
    candidateId: "cand_model_v1",
    toolId: session.harnessId,
    toolVersion: "1.0.0",
    workloadId: "wl_audit_eval",
    trajectoryId: `traj_${session.sessionId}`,
    parentTrajectoryId: null,
    runtimeVersion: "1.0.0",
    role: "candidate",
    status: "success",
    isEquivalent: true,
    catalogExposureTokens: 0,
    ...overrides,
  };
}

function createTestEnvironment(opts?: {
  attributionOverrides?: Partial<TrajectoryAttributionContextInput>;
  failFirstCount?: number;
}) {
  const pipeline = new NormalizationPipeline();
  // Register all authoritative real provider decoders
  pipeline.registerDecoder(new ClaudeRecordDecoder());
  pipeline.registerDecoder(new CodexRecordDecoder());
  pipeline.registerDecoder(new OmpRecordDecoder());

  const fakeCloud = createFakeCloudObservationClient({ failFirstCount: opts?.failFirstCount });

  const attributionResolver: TrajectoryAttributionResolver = vi.fn(
    async (session: HarnessSession) =>
      createAttributionContext(session, opts?.attributionOverrides),
  );

  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline,
    observationClient: fakeCloud.client,
    attributionResolver,
  });

  return {
    pipeline,
    coordinator,
    fakeCloud,
    attributionResolver,
  };
}

// ============================================================================
// Integration Test Suites
// ============================================================================

describe("Provider Capture Integration", () => {
  describe("Table-Driven Provider Usage Decoding & Trajectory Observation", () => {
    interface ProviderTestCase {
      providerName: string;
      harnessId: string;
      description: string;
      rawPayload: JsonObject;
      expectedProvider: string;
      expectedModel: string;
      expectedAccountingVersion: string;
      expectedAvailability: "complete" | "partial" | "unavailable";
      expectedUsage: {
        inputTokens: number | null;
        outputTokens: number | null;
        reasoningTokens: number | null;
        cachedInputTokens: number | null;
        totalTokens: number | null;
        costMicroUsd: number | null;
        durationMs: number | null;
      };
    }

    const testCases: ProviderTestCase[] = [
      // ----------------------------------------------------------------------
      // Claude Code - Complete Case
      // ----------------------------------------------------------------------
      {
        providerName: "Claude Code",
        harnessId: "claude-code",
        description: "complete usage with all token components, cache read, cost, and duration",
        rawPayload: {
          type: "assistant",
          model: "claude-3-7-sonnet-20250219",
          message: {
            id: "msg_claude_full_01",
            role: "assistant",
            content: [{ type: "text", text: "Refactoring completed successfully." }],
            usage: {
              input_tokens: 2500,
              output_tokens: 800,
              reasoning_tokens: 350,
              cache_read_input_tokens: 1200,
              total_tokens: 3650,
              cost_micros: 15400,
              duration_ms: 1250,
            },
          },
        },
        expectedProvider: "anthropic",
        expectedModel: "claude-3-7-sonnet-20250219",
        expectedAccountingVersion: "claude-code-transcript-v1",
        expectedAvailability: "complete",
        expectedUsage: {
          inputTokens: 2500,
          outputTokens: 800,
          reasoningTokens: 350,
          cachedInputTokens: 1200,
          totalTokens: 3650,
          costMicroUsd: 15400,
          durationMs: 1250,
        },
      },
      // ----------------------------------------------------------------------
      // Claude Code - Unsupported / Partial Case
      // ----------------------------------------------------------------------
      {
        providerName: "Claude Code",
        harnessId: "claude-code",
        description:
          "partial usage without totalTokens or optional metrics; unsupported fields remain null",
        rawPayload: {
          type: "assistant",
          model: "claude-3-5-sonnet-20241022",
          message: {
            id: "msg_claude_partial_02",
            role: "assistant",
            content: [{ type: "text", text: "Partial turn without total." }],
            usage: {
              input_tokens: 1200,
              output_tokens: 400,
              // total_tokens is omitted, reasoning and cache are omitted
            },
          },
        },
        expectedProvider: "anthropic",
        expectedModel: "claude-3-5-sonnet-20241022",
        expectedAccountingVersion: "claude-code-transcript-v1",
        expectedAvailability: "partial",
        expectedUsage: {
          inputTokens: 1200,
          outputTokens: 400,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
      // ----------------------------------------------------------------------
      // Claude Code - Explicit Unavailable Case
      // ----------------------------------------------------------------------
      {
        providerName: "Claude Code",
        harnessId: "claude-code",
        description: "explicit unavailable usage record",
        rawPayload: {
          type: "assistant",
          model: "claude-3-5-haiku-20241022",
          message: {
            id: "msg_claude_unavail_03",
            role: "assistant",
            content: [{ type: "text", text: "Usage reporting disabled." }],
            usage: {
              availability: "unavailable",
            },
          },
        },
        expectedProvider: "anthropic",
        expectedModel: "claude-3-5-haiku-20241022",
        expectedAccountingVersion: "claude-code-transcript-v1",
        expectedAvailability: "unavailable",
        expectedUsage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
      // ----------------------------------------------------------------------
      // Codex CLI - Complete Case
      // ----------------------------------------------------------------------
      {
        providerName: "Codex CLI",
        harnessId: "codex-cli",
        description:
          "complete per-turn usage with prompt, completion, reasoning, cache, total, and cost",
        rawPayload: {
          type: "assistant_message",
          model: "o3-mini",
          provider: "openai",
          usage: {
            prompt_tokens: 1800,
            completion_tokens: 600,
            reasoning_tokens: 400,
            cached_tokens: 900,
            total_tokens: 2800,
            cost_micro_usd: 8500,
            duration_ms: 920,
          },
        },
        expectedProvider: "openai",
        expectedModel: "o3-mini",
        expectedAccountingVersion: "codex-cli-transcript-v1",
        expectedAvailability: "complete",
        expectedUsage: {
          inputTokens: 1800,
          outputTokens: 600,
          reasoningTokens: 400,
          cachedInputTokens: 900,
          totalTokens: 2800,
          costMicroUsd: 8500,
          durationMs: 920,
        },
      },
      // ----------------------------------------------------------------------
      // Codex CLI - Unsupported / Partial Case
      // ----------------------------------------------------------------------
      {
        providerName: "Codex CLI",
        harnessId: "codex-cli",
        description:
          "partial per-turn usage with missing totalTokens; unsupported fields remain null",
        rawPayload: {
          type: "assistant_message",
          model: "gpt-4o",
          provider: "openai",
          usage: {
            prompt_tokens: 950,
            completion_tokens: 300,
            // total_tokens, reasoning, cache, cost, duration omitted
          },
        },
        expectedProvider: "openai",
        expectedModel: "gpt-4o",
        expectedAccountingVersion: "codex-cli-transcript-v1",
        expectedAvailability: "partial",
        expectedUsage: {
          inputTokens: 950,
          outputTokens: 300,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
      // ----------------------------------------------------------------------
      // Codex CLI - Explicit Unavailable Case
      // ----------------------------------------------------------------------
      {
        providerName: "Codex CLI",
        harnessId: "codex-cli",
        description: "explicit unavailable usage payload",
        rawPayload: {
          type: "assistant_message",
          model: "gpt-4o-mini",
          provider: "openai",
          usage: {
            availability: "unavailable",
          },
        },
        expectedProvider: "openai",
        expectedModel: "gpt-4o-mini",
        expectedAccountingVersion: "codex-cli-transcript-v1",
        expectedAvailability: "unavailable",
        expectedUsage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
      // ----------------------------------------------------------------------
      // OMP - Complete Case
      // ----------------------------------------------------------------------
      {
        providerName: "OMP",
        harnessId: "omp",
        description:
          "complete usage with all metrics, reasoning tokens, cache tokens, and duration",
        rawPayload: {
          type: "message",
          role: "assistant",
          model: "gpt-4o-2024-08-06",
          provider: "openai",
          usage: {
            prompt_tokens: 2100,
            completion_tokens: 750,
            completion_tokens_details: {
              reasoning_tokens: 250,
            },
            cached_tokens: 1100,
            total_tokens: 3100,
            cost_micros: 12000,
            duration_ms: 1100,
          },
        },
        expectedProvider: "openai",
        expectedModel: "gpt-4o-2024-08-06",
        expectedAccountingVersion: "omp-v1",
        expectedAvailability: "complete",
        expectedUsage: {
          inputTokens: 2100,
          outputTokens: 750,
          reasoningTokens: 250,
          cachedInputTokens: 1100,
          totalTokens: 3100,
          costMicroUsd: 12000,
          durationMs: 1100,
        },
      },
      // ----------------------------------------------------------------------
      // OMP - Unsupported / Partial Case
      // ----------------------------------------------------------------------
      {
        providerName: "OMP",
        harnessId: "omp",
        description: "partial usage missing totalTokens; unsupported fields remain null",
        rawPayload: {
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          usage: {
            prompt_tokens: 1400,
            completion_tokens: 500,
            // total_tokens, reasoning, cache, cost, duration omitted
          },
        },
        expectedProvider: "anthropic",
        expectedModel: "claude-3-5-sonnet",
        expectedAccountingVersion: "omp-v1",
        expectedAvailability: "partial",
        expectedUsage: {
          inputTokens: 1400,
          outputTokens: 500,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
      // ----------------------------------------------------------------------
      // OMP - Explicit Unavailable Case
      // ----------------------------------------------------------------------
      {
        providerName: "OMP",
        harnessId: "omp",
        description: "explicit unavailable usage via unavailable flag",
        rawPayload: {
          type: "message",
          role: "assistant",
          model: "custom-local-model",
          provider: "vllm",
          unavailable: true,
        },
        expectedProvider: "vllm",
        expectedModel: "custom-local-model",
        expectedAccountingVersion: "omp-v1",
        expectedAvailability: "unavailable",
        expectedUsage: {
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cachedInputTokens: null,
          totalTokens: null,
          costMicroUsd: null,
          durationMs: null,
        },
      },
    ];

    for (const tc of testCases) {
      it(`[${tc.providerName}] captures ${tc.description}`, async () => {
        const { coordinator, fakeCloud } = createTestEnvironment();
        const session = createHarnessSession(
          `sess_${tc.harnessId}_${randomUUID().slice(0, 8)}`,
          tc.harnessId,
          "completed",
        );

        const rawRecord: RawHarnessRecord = {
          recordId: `rec_${randomUUID().slice(0, 8)}`,
          sessionId: session.sessionId,
          harnessId: tc.harnessId,
          sequenceNumber: 1,
          recordType: "transcript_line",
          rawPayload: tc.rawPayload,
          timestamp: new Date().toISOString(),
        };

        const ack = vi.fn(async () => {});
        await coordinator.handleRecords(session, [rawRecord], ack);

        expect(ack).toHaveBeenCalledTimes(1);
        expect(fakeCloud.submittedObservations.length).toBe(1);

        const observation = fakeCloud.submittedObservations[0];

        // 1. Schema conformance
        const validation = TrajectoryObservationSchema.safeParse(observation);
        expect(validation.success).toBe(true);

        // 2. Identity preservation
        expect(observation.provider).toBe(tc.expectedProvider);
        expect(observation.model).toBe(tc.expectedModel);
        expect(observation.metadata?.accountingVersion).toBe(tc.expectedAccountingVersion);
        expect(observation.canonicalPayload?.accountingVersion).toBe(tc.expectedAccountingVersion);

        // 3. Exact usage component preservation
        expect(observation.usage.availability).toBe(tc.expectedAvailability);
        expect(observation.usage.inputTokens).toBe(tc.expectedUsage.inputTokens);
        expect(observation.usage.outputTokens).toBe(tc.expectedUsage.outputTokens);
        expect(observation.usage.reasoningTokens).toBe(tc.expectedUsage.reasoningTokens);
        expect(observation.usage.cachedInputTokens).toBe(tc.expectedUsage.cachedInputTokens);
        expect(observation.usage.totalTokens).toBe(tc.expectedUsage.totalTokens);
        expect(observation.usage.costMicroUsd).toBe(tc.expectedUsage.costMicroUsd);
        expect(observation.usage.durationMs).toBe(tc.expectedUsage.durationMs);

        // 4. SHA-256 Digest format check
        expect(observation.digest).toMatch(/^[a-f0-9]{64}$/);

        // 5. Finalized coordinator state
        expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
        expect(coordinator.getActiveSessionCount()).toBe(0);
      });
    }
  });

  describe("No-Invocation Sessions & Catalog Exposure", () => {
    it("preserves catalogExposureTokens and reports unavailable usage when zero model invocations occur", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment({
        attributionOverrides: {
          catalogExposureTokens: 350,
          provider: "anthropic",
          model: "claude-3-7-sonnet",
        },
      });

      const session = createHarnessSession("sess_no_invocations", "claude-code", "completed");

      // Non-LLM session events only (e.g. session start lifecycle without any assistant usage)
      const rawRecord: RawHarnessRecord = {
        recordId: "rec_session_start_01",
        sessionId: session.sessionId,
        harnessId: "claude-code",
        sequenceNumber: 1,
        recordType: "transcript_line",
        rawPayload: {
          type: "session_start",
          harness: "claude-code",
          workspaceId: session.workspaceId,
        },
        timestamp: new Date().toISOString(),
      };

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [rawRecord], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(fakeCloud.submittedObservations.length).toBe(1);

      const obs = fakeCloud.submittedObservations[0];
      expect(TrajectoryObservationSchema.safeParse(obs).success).toBe(true);

      expect(obs.catalogExposureTokens).toBe(350);
      expect(obs.usage.availability).toBe("unavailable");
      expect(obs.usage.inputTokens).toBeNull();
      expect(obs.usage.outputTokens).toBeNull();
      expect(obs.usage.reasoningTokens).toBeNull();
      expect(obs.usage.cachedInputTokens).toBeNull();
      expect(obs.usage.totalTokens).toBeNull();
      expect(obs.usage.costMicroUsd).toBeNull();
      expect(obs.usage.durationMs).toBeNull();
    });
  });

  describe("Duplicate & Cumulative Non-Double-Counting", () => {
    it("does not inflate usage when Codex cumulative records are streamed sequentially", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment({
        attributionOverrides: {
          provider: "openai",
          model: "gpt-4o",
        },
      });
      const session = createHarnessSession(
        "sess_codex_cumulative_stream",
        "codex-cli",
        "completed",
      );

      // Stream of 3 cumulative updates in the same session
      const records: RawHarnessRecord[] = [
        {
          recordId: "rec_cum_1",
          sessionId: session.sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 1,
          recordType: "transcript_line",
          rawPayload: {
            type: "assistant_message",
            content: "Turn 1",
            model: "gpt-4o",
            provider: "openai",
            cumulative_usage: {
              prompt_tokens: 500,
              completion_tokens: 150,
              total_tokens: 650,
            },
          },
          timestamp: new Date().toISOString(),
        },
        {
          recordId: "rec_cum_2",
          sessionId: session.sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 2,
          recordType: "transcript_line",
          rawPayload: {
            type: "assistant_message",
            content: "Turn 2",
            model: "gpt-4o",
            provider: "openai",
            cumulative_usage: {
              prompt_tokens: 1200,
              completion_tokens: 400,
              total_tokens: 1600,
            },
          },
          timestamp: new Date().toISOString(),
        },
        {
          recordId: "rec_cum_3",
          sessionId: session.sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 3,
          recordType: "transcript_line",
          rawPayload: {
            type: "assistant_message",
            content: "Turn 3",
            model: "gpt-4o",
            provider: "openai",
            cumulative_usage: {
              prompt_tokens: 2000,
              completion_tokens: 700,
              total_tokens: 2700,
            },
          },
          timestamp: new Date().toISOString(),
        },
        // Terminal lifecycle end record
        {
          recordId: "rec_cum_end",
          sessionId: session.sessionId,
          harnessId: "codex-cli",
          sequenceNumber: 4,
          recordType: "transcript_line",
          rawPayload: {
            type: "session_lifecycle",
            lifecycleType: "end",
            sessionId: session.sessionId,
            model: "gpt-4o",
            provider: "openai",
          },
          timestamp: new Date().toISOString(),
        },
      ];
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, records, ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(fakeCloud.submittedObservations.length).toBe(1);

      const obs = fakeCloud.submittedObservations[0];
      expect(TrajectoryObservationSchema.safeParse(obs).success).toBe(true);

      // Usage MUST reflect the latest cumulative snapshot (2700 total), NOT the sum (650 + 1600 + 2700 = 4950)
      expect(obs.usage.inputTokens).toBe(2000);
      expect(obs.usage.outputTokens).toBe(700);
      expect(obs.usage.totalTokens).toBe(2700);
      expect(obs.metadata?.accountingVersion).toBe("codex-cli-cumulative-v1");
    });

    it("deduplicates identical raw records without double-counting tokens", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment();
      const session = createHarnessSession("sess_dedup_test", "claude-code", "completed");

      const record: RawHarnessRecord = {
        recordId: "rec_identical_01",
        sessionId: session.sessionId,
        harnessId: "claude-code",
        sequenceNumber: 1,
        recordType: "transcript_line",
        rawPayload: {
          type: "assistant",
          model: "claude-3-7-sonnet",
          message: {
            id: "msg_dup_1",
            content: "Response",
            usage: {
              input_tokens: 1000,
              output_tokens: 250,
              total_tokens: 1250,
            },
          },
        },
        timestamp: new Date().toISOString(),
      };

      // Ingest the exact same record twice in the batch
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [record, record], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(fakeCloud.submittedObservations.length).toBe(1);

      const obs = fakeCloud.submittedObservations[0];
      // Tokens must NOT be doubled
      expect(obs.usage.inputTokens).toBe(1000);
      expect(obs.usage.outputTokens).toBe(250);
      expect(obs.usage.totalTokens).toBe(1250);
    });
  });

  describe("Submission Retry Resilience", () => {
    it("resends the exact same digest, observationId, and totals on retry after transient failure", async () => {
      // First attempt will fail with 503, second will succeed
      const { coordinator, fakeCloud } = createTestEnvironment({ failFirstCount: 1 });
      const session = createHarnessSession("sess_retry_resilience", "omp", "completed");

      const record: RawHarnessRecord = {
        recordId: "rec_omp_retry_01",
        sessionId: session.sessionId,
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        rawPayload: {
          type: "message",
          role: "assistant",
          model: "gpt-4o",
          provider: "openai",
          usage: {
            prompt_tokens: 1500,
            completion_tokens: 500,
            total_tokens: 2000,
            cost_micros: 6000,
          },
        },
        timestamp: new Date().toISOString(),
      };

      // 1. First attempt fails due to cloud error
      const ackFirst = vi.fn(async () => {});
      await expect(coordinator.handleRecords(session, [record], ackFirst)).rejects.toThrow(
        "Simulated transient upstream 503 Service Unavailable",
      );

      expect(ackFirst).not.toHaveBeenCalled();
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);

      // Inspect the observation passed to the first failed call
      // SAFETY: sendTrajectoryObservationBatch is a Vitest Mock in tests.
      const clientMock = fakeCloud.client.sendTrajectoryObservationBatch as Mock;
      expect(clientMock).toHaveBeenCalledTimes(1);
      const firstCallObservation: TrajectoryObservation =
        clientMock.mock.calls[0][0].observations[0];

      // 2. Retry attempt succeeds
      const ackRetry = vi.fn(async () => {});
      await coordinator.handleRecords(session, [record], ackRetry);

      expect(ackRetry).toHaveBeenCalledTimes(1);
      expect(clientMock).toHaveBeenCalledTimes(2);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);

      const secondCallObservation: TrajectoryObservation =
        clientMock.mock.calls[1][0].observations[0];

      // 3. Exact match of observationId, digest, and usage totals across retry
      expect(secondCallObservation.observationId).toBe(firstCallObservation.observationId);
      expect(secondCallObservation.digest).toBe(firstCallObservation.digest);
      expect(secondCallObservation.usage).toEqual(firstCallObservation.usage);
      expect(secondCallObservation.usage.totalTokens).toBe(2000);
      expect(secondCallObservation.usage.inputTokens).toBe(1500);
      expect(secondCallObservation.usage.outputTokens).toBe(500);
      expect(secondCallObservation.usage.costMicroUsd).toBe(6000);
    });
  });

  describe("Nested Parent Attribution", () => {
    it("correctly sets null parentTrajectoryId for root trajectories", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment({
        attributionOverrides: {
          parentTrajectoryId: null,
          trajectoryId: "traj_root_100",
        },
      });

      const session = createHarnessSession("sess_root", "claude-code", "completed");
      const record: RawHarnessRecord = {
        recordId: "rec_root_01",
        sessionId: session.sessionId,
        harnessId: "claude-code",
        sequenceNumber: 1,
        recordType: "transcript_line",
        rawPayload: {
          type: "assistant",
          model: "claude-3-7-sonnet",
          message: {
            content: "Root response",
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          },
        },
        timestamp: new Date().toISOString(),
      };

      await coordinator.handleRecords(
        session,
        [record],
        vi.fn(async () => {}),
      );

      const obs = fakeCloud.submittedObservations[0];
      expect(obs.parentTrajectoryId).toBeNull();
      expect(obs.trajectoryId).toBe("traj_root_100");
    });

    it("correctly attributes nested subagent trajectory to parentTrajectoryId", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment({
        attributionOverrides: {
          trajectoryId: "traj_subagent_200",
          parentTrajectoryId: "traj_root_100",
        },
      });

      const session = createHarnessSession("sess_subagent", "omp", "completed");
      const record: RawHarnessRecord = {
        recordId: "rec_sub_01",
        sessionId: session.sessionId,
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        rawPayload: {
          type: "message",
          role: "assistant",
          model: "gpt-4o",
          provider: "openai",
          usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 },
        },
        timestamp: new Date().toISOString(),
      };

      await coordinator.handleRecords(
        session,
        [record],
        vi.fn(async () => {}),
      );

      const obs = fakeCloud.submittedObservations[0];
      expect(obs.trajectoryId).toBe("traj_subagent_200");
      expect(obs.parentTrajectoryId).toBe("traj_root_100");
    });
  });

  describe("Privacy & Redaction - Absence of Raw Prompt, Command, and Path Text", () => {
    it("ensures submitted TrajectoryObservation contains strictly metadata and metrics, with zero prompt/command/path leakage", async () => {
      const { coordinator, fakeCloud } = createTestEnvironment();
      const session = createHarnessSession("sess_privacy_test", "claude-code", "completed");

      const sensitivePrompt =
        "SECRET: Please read /etc/shadow and database passwords at /var/data/keys.txt";
      const sensitiveCommand = "bash -c 'cat /var/data/keys.txt | grep token'";
      const sensitivePath = "/home/developer/secret_project/credentials.json";

      const records: RawHarnessRecord[] = [
        {
          recordId: "rec_sensitive_msg",
          sessionId: session.sessionId,
          harnessId: "claude-code",
          sequenceNumber: 1,
          recordType: "transcript_line",
          rawPayload: {
            type: "assistant",
            model: "claude-3-7-sonnet",
            message: {
              id: "msg_sens_1",
              role: "assistant",
              content: [
                { type: "text", text: sensitivePrompt },
                { type: "tool_use", name: "bash", input: { command: sensitiveCommand } },
              ],
              usage: {
                input_tokens: 2200,
                output_tokens: 700,
                total_tokens: 2900,
              },
            },
          },
          timestamp: new Date().toISOString(),
        },
        {
          recordId: "rec_sensitive_tool_result",
          sessionId: session.sessionId,
          harnessId: "claude-code",
          sequenceNumber: 2,
          recordType: "transcript_line",
          rawPayload: {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: `Error accessing file: ${sensitivePath}`,
          },
          timestamp: new Date().toISOString(),
        },
      ];

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, records, ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(fakeCloud.submittedObservations.length).toBe(1);

      const observation = fakeCloud.submittedObservations[0];
      const serialized = JSON.stringify(observation);

      // Deep inspection: raw prompt, bash command, tool output, and secret paths MUST NOT appear anywhere in the observation
      expect(serialized).not.toContain(sensitivePrompt);
      expect(serialized).not.toContain(sensitiveCommand);
      expect(serialized).not.toContain(sensitivePath);
      expect(serialized).not.toContain("/etc/shadow");
      expect(serialized).not.toContain("/var/data/keys.txt");
      expect(serialized).not.toContain("credentials.json");

      // Verify that canonicalPayload and metadata only contain allowed identifiers and aggregated counters
      expect(observation.usage.totalTokens).toBe(2900);
      expect(observation.usage.inputTokens).toBe(2200);
      expect(observation.usage.outputTokens).toBe(700);
      expect(observation.provider).toBe("anthropic");
      expect(observation.model).toBe("claude-3-7-sonnet");
    });
  });
});
