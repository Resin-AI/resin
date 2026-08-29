import { randomUUID } from "node:crypto";
import type { ProviderReportedUsage } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import {
  type CloudObservationClient,
  NormalizationPipeline,
  type TrajectoryAttributionContextInput,
  type TrajectoryAttributionResolver,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../src/index.js";

function createMockHarnessSession(
  sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  status: "active" | "idle" | "completed" | "interrupted" | "failed" | "unknown" = "active",
) {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_alpha_01",
    harnessId: "open-code",
    transcriptPath: `/var/log/transcripts/${sessionId}.jsonl`,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      environment: "production",
      runner: "k8s-pool-4",
    },
  };
}

function createValidAttributionContext(
  sessionId: string,
  overrides: Partial<TrajectoryAttributionContextInput> = {},
): TrajectoryAttributionContextInput {
  return {
    accountId: "acc_alpha_01",
    workspaceId: "ws_alpha_01",
    ownerUserId: "usr_dev_01",
    projectId: "prj_core_01",
    candidateId: "cnd_model_v1",
    toolId: "tool_claude_bridge",
    toolVersion: "2.4.0",
    workloadId: "wrk_eval_suite",
    trajectoryId: sessionId,
    parentTrajectoryId: null,
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    accountingVersion: "2026-v1",
    runtimeVersion: "1.0.0",
    role: "candidate",
    status: "success",
    isEquivalent: false,
    catalogExposureTokens: 0,
    metadata: { testCase: "capture-coordinator-flow" },
    ...overrides,
  };
}

function createPromptRecord(
  sessionId: string,
  sequenceNumber: number,
  content = "Analyze codebase architecture",
): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: `rec_prompt_${sequenceNumber}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber,
    timestamp,
    recordType: "prompt",
    rawPayload: {
      role: "user",
      content,
    },
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

function createCompletionRecord(
  sessionId: string,
  sequenceNumber: number,
  usage: Partial<ProviderReportedUsage> = {},
): RawHarnessRecord {
  const fullUsage: ProviderReportedUsage = {
    provider: usage.provider ?? "anthropic",
    model: usage.model ?? "claude-3-5-sonnet-20241022",
    accountingVersion: usage.accountingVersion ?? "2026-v1",
    availability: usage.availability ?? "complete",
    inputTokens: usage.inputTokens ?? 120,
    outputTokens: usage.outputTokens ?? 60,
    reasoningTokens: usage.reasoningTokens ?? 10,
    cachedInputTokens: usage.cachedInputTokens ?? 30,
    totalTokens: usage.totalTokens ?? 180,
    costMicroUsd: usage.costMicroUsd ?? 1500,
    durationMs: usage.durationMs ?? 400,
  };
  const timestamp = new Date().toISOString();
  return {
    recordId: `rec_comp_${sequenceNumber}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber,
    timestamp,
    recordType: "completion",
    rawPayload: {
      role: "assistant",
      content: "I have analyzed the repository structure and modules.",
      model: fullUsage.model,
      providerUsage: fullUsage,
      usage: fullUsage,
    },
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

function createLifecycleRecord(
  sessionId: string,
  sequenceNumber: number,
  action: "start" | "pause" | "resume" | "end" | "crash" = "end",
  exitReason = "completed",
): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: `rec_life_${sequenceNumber}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber,
    timestamp,
    recordType: "transcript_line",
    rawPayload: {
      type: "session_lifecycle",
      lifecycleType: action,
      exitReason,
    },
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

describe("TrajectoryCaptureCoordinator", () => {
  it("end-to-end: raw records -> normalized -> emitter -> cloud submission -> ack -> cleanup", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedObservations: TrajectoryObservation[] = [];

    const mockObservationClient = {
      sendTrajectoryObservationBatch: vi.fn(
        async (input: { observations: TrajectoryObservation[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_test_1",
            accepted: input.observations.length,
            rejected: 0,
            errors: [],
          };
        },
      ),
    } as unknown as CloudObservationClient;

    const session = createMockHarnessSession();
    const attributionResolver: TrajectoryAttributionResolver = vi.fn(async (sess) => {
      return createValidAttributionContext(sess.sessionId);
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockObservationClient,
      attributionResolver,
    });

    const ack1 = vi.fn(async () => {});
    const records1 = [
      createPromptRecord(session.sessionId, 1),
      createCompletionRecord(session.sessionId, 2),
    ];

    // Handle first batch (active session, no terminal event yet)
    await coordinator.handleRecords(session, records1, ack1);

    expect(ack1).toHaveBeenCalledTimes(1);
    expect(attributionResolver).toHaveBeenCalledTimes(1);
    expect(coordinator.getActiveSessionCount()).toBe(1);
    expect(coordinator.hasActiveSession(session.sessionId)).toBe(true);
    expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();

    // Handle second batch containing terminal lifecycle event
    const ack2 = vi.fn(async () => {});
    const records2 = [
      createCompletionRecord(session.sessionId, 3, {
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 0,
        cachedInputTokens: 10,
        totalTokens: 120,
        costMicroUsd: 900,
        durationMs: 250,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        accountingVersion: "2026-v1",
      }),
      createLifecycleRecord(session.sessionId, 4, "end", "completed"),
    ];

    await coordinator.handleRecords(session, records2, ack2);

    expect(ack2).toHaveBeenCalledTimes(1);
    expect(mockObservationClient.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedObservations.length).toBe(1);

    const obs = submittedObservations[0];
    expect(obs.trajectoryId).toBe(session.sessionId);
    expect(obs.provider).toBe("anthropic");
    expect(obs.model).toBe("claude-3-5-sonnet-20241022");
    expect(obs.status).toBe("success");
    expect(obs.candidateId).toBe("cnd_model_v1");
    expect(obs.toolId).toBe("tool_claude_bridge");
    expect(obs.workloadId).toBe("wrk_eval_suite");

    // Aggregated token checks (120+80 input, 60+40 output, 10+0 reasoning, 30+10 cached, 180+120 total)
    expect(obs.usage.inputTokens).toBe(200);
    expect(obs.usage.outputTokens).toBe(100);
    expect(obs.usage.reasoningTokens).toBe(10);
    expect(obs.usage.cachedInputTokens).toBe(40);
    expect(obs.usage.totalTokens).toBe(300);
    expect(obs.usage.costMicroUsd).toBe(2400);
    expect(obs.usage.durationMs).toBe(650);

    // State cleanup
    expect(coordinator.getActiveSessionCount()).toBe(0);
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
  });

  it("finalizes and submits when session status is terminal (completed / failed / interrupted)", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedObservations: TrajectoryObservation[] = [];

    const mockObservationClient = {
      sendTrajectoryObservationBatch: vi.fn(
        async (input: { observations: TrajectoryObservation[] }) => {
          submittedObservations.push(...input.observations);
          return { batchId: "batch_test_2", accepted: 1, rejected: 0, errors: [] };
        },
      ),
    } as unknown as CloudObservationClient;

    const session = createMockHarnessSession("sess_failed_test", "failed");
    const attributionResolver = vi.fn(async (sess: { sessionId: string }) =>
      createValidAttributionContext(sess.sessionId),
    );

    const coordinator = new TrajectoryCaptureCoordinator(
      pipeline,
      mockObservationClient,
      attributionResolver,
    );

    const ack = vi.fn(async () => {});
    const records = [
      createPromptRecord(session.sessionId, 1),
      createCompletionRecord(session.sessionId, 2),
    ];

    await coordinator.handleRecords(session, records, ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(mockObservationClient.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedObservations[0].status).toBe("failure");
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
    expect(coordinator.getActiveSessionCount()).toBe(0);
  });

  describe("missing attribution & generic observation upload", () => {
    it("normalizes and submits observation batch when resolver returns null (generic session)", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: unknown[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_obs_1",
            status: "accepted",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_unattributed_1");
      const attributionResolver = vi.fn(async () => null);

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ack1 = vi.fn(async () => {});
      const records1 = [
        createPromptRecord(session.sessionId, 1),
        createCompletionRecord(session.sessionId, 2),
      ];

      await coordinator.handleRecords(session, records1, ack1);

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(2);
      expect(coordinator.isSessionUnattributed(session.sessionId)).toBe(true);
      expect(coordinator.getActiveSessionCount()).toBe(1);

      // Subsequent batch for generic session does not invoke resolver again
      const ack2 = vi.fn(async () => {});
      const records2 = [createLifecycleRecord(session.sessionId, 3, "end")];
      await coordinator.handleRecords(session, records2, ack2);

      expect(ack2).toHaveBeenCalledTimes(1);
      expect(attributionResolver).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(2);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });

    it("falls back to generic observation submission when resolver returns invalid attribution schema", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: unknown[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_obs_2",
            status: "accepted",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_invalid_attr_1");
      const attributionResolver = vi.fn(async () => {
        return {
          invalidField: "not-a-valid-attribution-context",
        } as unknown as TrajectoryAttributionContextInput;
      });

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [createPromptRecord(session.sessionId, 1), createCompletionRecord(session.sessionId, 2)],
        ack,
      );

      expect(ack).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(2);
      expect(coordinator.isSessionUnattributed(session.sessionId)).toBe(true);
    });

    it("does NOT ack and rethrows when attribution resolver throws an unexpected error", async () => {
      const pipeline = new NormalizationPipeline();
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_resolver_error_1");
      const attributionResolver = vi.fn(async () => {
        throw new Error("Database connection failed");
      });

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ack = vi.fn(async () => {});
      await expect(
        coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack),
      ).rejects.toThrow("Database connection failed");

      expect(ack).not.toHaveBeenCalled();
      expect(mockObservationClient.sendObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(coordinator.isSessionUnattributed(session.sessionId)).toBe(false);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);
    });

    it("metadata-free completed harness session submits normalized events through sendObservationBatch and acknowledges only after success; no sendTrajectoryObservationBatch occurs", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: unknown[] = [];
      let sendObservationBatchCalled = false;
      let ackCalled = false;
      let sendObsResolvedBeforeAck = false;

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
          sendObservationBatchCalled = true;
          sendObsResolvedBeforeAck = !ackCalled;
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_obs_meta_free",
            status: "accepted",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_metadata_free_1", "completed");
      session.metadata = undefined;

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
      });

      const ack = vi.fn(async () => {
        ackCalled = true;
      });

      await coordinator.handleRecords(
        session,
        [createPromptRecord(session.sessionId, 1), createCompletionRecord(session.sessionId, 2)],
        ack,
      );

      expect(sendObservationBatchCalled).toBe(true);
      expect(sendObsResolvedBeforeAck).toBe(true);
      expect(ackCalled).toBe(true);
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(submittedObservations.length).toBe(2);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });

    it("projects generic events to metadata-only with isRedacted true, drop strategy, and zero content/secret leaks before calling sendObservationBatch", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: unknown[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_obs_privacy",
            status: "accepted",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_privacy_check_1", "active");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        // Resolver returns null -> generic session
        attributionResolver: async () => null,
      });

      const secretMarker = "SUPER_SECRET_PROMPT_PAYLOAD_12345";
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [
          createPromptRecord(session.sessionId, 1, secretMarker),
          createCompletionRecord(session.sessionId, 2, { inputTokens: 100, outputTokens: 50 }),
        ],
        ack,
      );

      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(2);

      const serialized = JSON.stringify(submittedObservations);
      expect(serialized).not.toContain(secretMarker);

      for (const obs of submittedObservations as Array<{
        redaction: { isRedacted: boolean; redactionStrategy: string };
      }>) {
        expect(obs.redaction.isRedacted).toBe(true);
        expect(obs.redaction.redactionStrategy).toBe("drop");
      }
    });

    it("generic session: does NOT ack and does not mark finalized when sendObservationBatch fails, enabling retry", async () => {
      const pipeline = new NormalizationPipeline();
      let shouldFail = true;
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: unknown[] }) => {
          if (shouldFail) {
            throw new Error("Cloud service 503");
          }
          return {
            batchId: "batch_obs_retry",
            status: "accepted",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
            errors: [],
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_retry_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
      });

      const ackFail = vi.fn(async () => {});
      const records = [createPromptRecord(session.sessionId, 1)];

      await expect(coordinator.handleRecords(session, records, ackFail)).rejects.toThrow(
        "Cloud service 503",
      );

      expect(ackFail).not.toHaveBeenCalled();
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);

      // Retry attempt succeeds
      shouldFail = false;
      const ackSuccess = vi.fn(async () => {});
      await coordinator.handleRecords(session, records, ackSuccess);

      expect(ackSuccess).toHaveBeenCalledTimes(1);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
    });

    it("generic terminal session: finalizes an empty normalized batch without consent or cloud calls", async () => {
      const pipeline = new NormalizationPipeline();
      const authorizeTelemetryEmission = vi.fn(async () => undefined);
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_empty_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        authorizeTelemetryEmission,
      });

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(authorizeTelemetryEmission).not.toHaveBeenCalled();
      expect(mockObservationClient.sendObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
    });

    it("generic session: fails closed for a nonempty normalized batch when consent is unknown", async () => {
      const pipeline = new NormalizationPipeline();
      const authorizeTelemetryEmission = vi.fn(async () => undefined);
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_unknown_consent_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        authorizeTelemetryEmission,
      });

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(authorizeTelemetryEmission).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).not.toHaveBeenCalled();
      expect(mockObservationClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);
    });
  });

  describe("duplicate events & idempotency", () => {
    it("ignores duplicate events and avoids double counting tokens or cost", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: TrajectoryObservation[] = [];

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            submittedObservations.push(...input.observations);
            return { batchId: "batch_dup", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_dedup_test");
      const attributionResolver = vi.fn(async (sess: { sessionId: string }) =>
        createValidAttributionContext(sess.sessionId),
      );

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const compRec = createCompletionRecord(session.sessionId, 2, {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 150,
        costMicroUsd: 1000,
        durationMs: 300,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        accountingVersion: "2026-v1",
      });

      // Batch 1: Ingest records
      const ack1 = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec, compRec], ack1);
      expect(ack1).toHaveBeenCalledTimes(1);

      // Batch 2: Exact duplicate records
      const ack2 = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec, compRec], ack2);
      expect(ack2).toHaveBeenCalledTimes(1);

      // Batch 3: Terminal record
      const ack3 = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [createLifecycleRecord(session.sessionId, 3, "end", "completed")],
        ack3,
      );
      expect(ack3).toHaveBeenCalledTimes(1);

      expect(submittedObservations.length).toBe(1);
      const obs = submittedObservations[0];
      // Must NOT be double counted (100 and 50, not 200 and 100)
      expect(obs.usage.inputTokens).toBe(100);
      expect(obs.usage.outputTokens).toBe(50);
      expect(obs.usage.totalTokens).toBe(150);
      expect(obs.usage.costMicroUsd).toBe(1000);
    });
  });

  describe("submission failure & retry resilience", () => {
    it("does NOT ack when CloudObservationClient fails, allowing subsequent retry", async () => {
      const pipeline = new NormalizationPipeline();
      let shouldFail = true;

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(async () => {
          if (shouldFail) {
            throw new Error("Cloud service 503 Service Unavailable");
          }
          return { batchId: "batch_retry_ok", accepted: 1, rejected: 0, errors: [] };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_retry_test", "completed");
      const attributionResolver = vi.fn(async (sess: { sessionId: string }) =>
        createValidAttributionContext(sess.sessionId),
      );

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ackFail = vi.fn(async () => {});
      const records = [
        createPromptRecord(session.sessionId, 1),
        createCompletionRecord(session.sessionId, 2),
      ];

      // First attempt fails
      await expect(coordinator.handleRecords(session, records, ackFail)).rejects.toThrow(
        "Cloud service 503",
      );

      expect(ackFail).not.toHaveBeenCalled();
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);

      // Second attempt (retry) succeeds
      shouldFail = false;
      const ackSuccess = vi.fn(async () => {});
      await coordinator.handleRecords(session, records, ackSuccess);

      expect(ackSuccess).toHaveBeenCalledTimes(1);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });
  });

  describe("concurrent sessions & isolation", () => {
    it("processes independent sessions concurrently in parallel without cross-talk", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: TrajectoryObservation[] = [];

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            submittedObservations.push(...input.observations);
            return {
              batchId: "batch_multi",
              accepted: input.observations.length,
              rejected: 0,
              errors: [],
            };
          },
        ),
      } as unknown as CloudObservationClient;

      const sessionA = createMockHarnessSession("sess_concurrent_A", "completed");
      const sessionB = createMockHarnessSession("sess_concurrent_B", "completed");
      const sessionC = createMockHarnessSession("sess_concurrent_C", "completed");

      const attributionResolver = vi.fn(async (sess: { sessionId: string }) => {
        return createValidAttributionContext(sess.sessionId, {
          candidateId: `cnd_${sess.sessionId}`,
        });
      });

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ackA = vi.fn(async () => {});
      const ackB = vi.fn(async () => {});
      const ackC = vi.fn(async () => {});

      await Promise.all([
        coordinator.handleRecords(
          sessionA,
          [
            createPromptRecord(sessionA.sessionId, 1),
            createCompletionRecord(sessionA.sessionId, 2),
          ],
          ackA,
        ),
        coordinator.handleRecords(
          sessionB,
          [
            createPromptRecord(sessionB.sessionId, 1),
            createCompletionRecord(sessionB.sessionId, 2),
          ],
          ackB,
        ),
        coordinator.handleRecords(
          sessionC,
          [
            createPromptRecord(sessionC.sessionId, 1),
            createCompletionRecord(sessionC.sessionId, 2),
          ],
          ackC,
        ),
      ]);

      expect(ackA).toHaveBeenCalledTimes(1);
      expect(ackB).toHaveBeenCalledTimes(1);
      expect(ackC).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(3);

      const trajectoryIds = submittedObservations.map((o) => o.trajectoryId).sort();
      expect(trajectoryIds).toEqual([
        "sess_concurrent_A",
        "sess_concurrent_B",
        "sess_concurrent_C",
      ]);

      expect(coordinator.getActiveSessionCount()).toBe(0);
      expect(coordinator.getFinalizedSessionCount()).toBe(3);
    });

    it("serializes concurrent batches for the same session without race conditions", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: TrajectoryObservation[] = [];

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            submittedObservations.push(...input.observations);
            return { batchId: "batch_same_sess", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_serial_lock");
      let resolverCallCount = 0;
      const { promise: resumeResolver, resolve: unlockResolver } = Promise.withResolvers<void>();

      const attributionResolver = vi.fn(async (sess: { sessionId: string }) => {
        resolverCallCount++;
        await resumeResolver;
        return createValidAttributionContext(sess.sessionId);
      });

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ack1 = vi.fn(async () => {});
      const ack2 = vi.fn(async () => {});

      // Send 2 batches concurrently for the same session
      const p1 = coordinator.handleRecords(
        session,
        [createPromptRecord(session.sessionId, 1), createCompletionRecord(session.sessionId, 2)],
        ack1,
      );
      const p2 = coordinator.handleRecords(
        session,
        [createPromptRecord(session.sessionId, 3), createCompletionRecord(session.sessionId, 4)],
        ack2,
      );

      unlockResolver();
      await Promise.all([p1, p2]);

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(ack2).toHaveBeenCalledTimes(1);
      // Attribution should only be resolved once per session
      expect(resolverCallCount).toBe(1);
      expect(coordinator.getActiveSessionCount()).toBe(1);
    });
  });

  describe("terminal cleanup & repeated terminal records", () => {
    it("removes finalized session state and does not resubmit on repeated terminal records", async () => {
      const pipeline = new NormalizationPipeline();
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(async () => ({
          batchId: "batch_term_repeat",
          accepted: 1,
          rejected: 0,
          errors: [],
        })),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_repeat_term", "completed");
      const attributionResolver = vi.fn(async (sess: { sessionId: string }) =>
        createValidAttributionContext(sess.sessionId),
      );

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const ack1 = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [
          createPromptRecord(session.sessionId, 1),
          createCompletionRecord(session.sessionId, 2),
          createLifecycleRecord(session.sessionId, 3, "end", "completed"),
        ],
        ack1,
      );

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
      expect(coordinator.getActiveSessionCount()).toBe(0);
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);

      // Repeated arrival of terminal records / trailing records
      const ack2 = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [createLifecycleRecord(session.sessionId, 4, "end", "completed")],
        ack2,
      );

      expect(ack2).toHaveBeenCalledTimes(1);
      // Should NOT submit again
      expect(mockObservationClient.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
      // Resolver should NOT be called again
      expect(attributionResolver).toHaveBeenCalledTimes(1);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });
  });

  describe("privacy-safe request body & accounting version", () => {
    it("ensures raw transcripts and prompts are omitted, while retaining accountingVersion in metadata & digest", async () => {
      const pipeline = new NormalizationPipeline();
      let sentObservation: TrajectoryObservation | null = null;

      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            sentObservation = input.observations[0];
            return { batchId: "batch_privacy", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_privacy_test", "completed");
      const attributionResolver = vi.fn(async (sess: { sessionId: string }) =>
        createValidAttributionContext(sess.sessionId, {
          accountingVersion: "2026-v2",
        }),
      );

      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver,
      });

      const sensitiveText = "TOP_SECRET_API_KEY_999";
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(
        session,
        [
          createPromptRecord(session.sessionId, 1, `My key is ${sensitiveText}`),
          createCompletionRecord(session.sessionId, 2, {
            accountingVersion: "2026-v2",
          }),
        ],
        ack,
      );

      expect(ack).toHaveBeenCalledTimes(1);
      expect(sentObservation).not.toBeNull();

      const obs = sentObservation!;
      const jsonString = JSON.stringify(obs);

      // Privacy check: sensitive content and raw transcripts must never enter the request body
      expect(jsonString).not.toContain(sensitiveText);
      expect(jsonString).not.toContain("TOP_SECRET");

      // Accounting version check: preserved in canonicalPayload and metadata
      expect(obs.canonicalPayload).toBeDefined();
      expect(obs.canonicalPayload?.accountingVersion).toBe("2026-v2");
      expect(obs.metadata?.accountingVersion).toBe("2026-v2");

      // Digest check: must be a 64-char sha256 hex string
      expect(obs.digest).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
