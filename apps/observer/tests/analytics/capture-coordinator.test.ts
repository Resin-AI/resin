import { randomUUID } from "node:crypto";
import type { NormalizedSessionEvent, ProviderReportedUsage } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { ProtocolError } from "@resin/protocol";
import {
  CloudObservationClient,
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

function createMockObservationClient(
  mock: Partial<CloudObservationClient> & {
    sendTrajectoryObservationBatch?: unknown;
    submitTrajectoryObservation?: unknown;
    sendObservationBatch?: unknown;
  },
): CloudObservationClient {
  // SAFETY: Test mock conforms to CloudObservationClient contract required by TrajectoryCaptureCoordinator.
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  return Object.assign(client, mock);
}

describe("TrajectoryCaptureCoordinator", () => {
  it("end-to-end: raw records -> normalized -> emitter -> cloud submission -> ack -> cleanup", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedObservations: TrajectoryObservation[] = [];

    const mockObservationClient = createMockObservationClient({
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
    });

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

    const mockObservationClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(
        async (input: { observations: TrajectoryObservation[] }) => {
          submittedObservations.push(...input.observations);
          return { batchId: "batch_test_2", accepted: 1, rejected: 0, errors: [] };
        },
      ),
    });

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
      const mockObservationClient = createMockObservationClient({
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
      });

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
      const mockObservationClient = createMockObservationClient({
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
      });

      const session = createMockHarnessSession("sess_invalid_attr_1");
      const attributionResolver = vi.fn(async () => {
        const baseContext: TrajectoryAttributionContextInput = {
          accountId: "acc_1",
          workspaceId: "ws_1",
          ownerUserId: "usr_1",
          projectId: "proj_1",
          candidateId: "cand_1",
          toolId: "tool_1",
          toolVersion: "1.0.0",
          workloadId: "wl_1",
          trajectoryId: "traj_1",
          runtimeVersion: "1.0.0",
          role: "primary",
        };
        return Object.assign({}, baseContext, {
          invalidField: "not-a-valid-attribution-context",
        });
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
      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      });

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

      const mockObservationClient = createMockObservationClient({
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
      });

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
      expect(submittedObservations.length).toBe(3);
      expect(submittedObservations[2]).toMatchObject({
        type: "session_lifecycle",
        lifecycleType: "end",
        exitReason: "completed",
      });
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
      expect(coordinator.getActiveSessionCount()).toBe(0);
    });

    it("projects generic events to metadata-only with isRedacted true, drop strategy, and zero content/secret leaks before calling sendObservationBatch", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: unknown[] = [];
      const mockObservationClient = createMockObservationClient({
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
      });

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

      for (const obs of submittedObservations) {
        expect(obs.redaction.isRedacted).toBe(true);
        expect(obs.redaction.redactionStrategy).toBe("drop");
      }
    });

    it("generic session: does NOT ack and does not mark finalized when sendObservationBatch fails, enabling retry", async () => {
      const pipeline = new NormalizationPipeline();
      let shouldFail = true;
      const mockObservationClient = createMockObservationClient({
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
      });

      const session = createMockHarnessSession("sess_generic_retry_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        coalesceDwellMs: 0,
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
      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      });

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
      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(),
      });

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

    it("generic completed session without terminal record: synthesizes exactly one metadata-only terminal lifecycle event and sequences it after existing events", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: NormalizedSessionEvent[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_synth_1",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_synth_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const compRec = createCompletionRecord(session.sessionId, 2);

      const ack1 = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec, compRec], ack1);

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(3);

      expect(submittedObservations[0].type).toBe("message");
      expect(submittedObservations[0].causalRef.causalSequence).toBe(1);

      expect(submittedObservations[1].type).toBe("message");
      expect(submittedObservations[1].causalRef.causalSequence).toBe(2);

      const syntheticTerminalEvent = submittedObservations[2];
      expect(syntheticTerminalEvent.type).toBe("session_lifecycle");
      if (syntheticTerminalEvent.type === "session_lifecycle") {
        expect(syntheticTerminalEvent.lifecycleType).toBe("end");
        expect(syntheticTerminalEvent.exitReason).toBe("completed");
      }
      expect(syntheticTerminalEvent.causalRef.causalSequence).toBe(3);
      expect(syntheticTerminalEvent.causalRef.parentId).toBe(submittedObservations[1].eventId);
      expect(syntheticTerminalEvent.redaction.isRedacted).toBe(true);
      expect(syntheticTerminalEvent.redaction.redactionStrategy).toBe("drop");
      expect(syntheticTerminalEvent.sessionId).toBe(session.sessionId);

      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);

      // Idempotency / repeat guard: subsequent handleRecords call does not re-emit
      const ack2 = vi.fn(async () => {});
      await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 3)], ack2);
      expect(ack2).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    });

    it("generic completed session with explicit terminal end record: does NOT synthesize duplicate terminal lifecycle event", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: NormalizedSessionEvent[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_explicit_end_1",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_explicit_end_1", "completed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const endRec = createLifecycleRecord(session.sessionId, 2, "end", "completed");

      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec, endRec], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(2);

      const lifecycleEvents = submittedObservations.filter((e) => e.type === "session_lifecycle");
      expect(lifecycleEvents.length).toBe(1);
      if (lifecycleEvents[0].type === "session_lifecycle") {
        expect(lifecycleEvents[0].lifecycleType).toBe("end");
        expect(lifecycleEvents[0].exitReason).toBe("completed");
      }
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
    });

    it("generic failed session without terminal record: synthesizes crash terminal event", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: NormalizedSessionEvent[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_synth_crash_1",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_synth_crash_1", "failed");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(2);

      const terminalEvent = submittedObservations[1];
      expect(terminalEvent.type).toBe("session_lifecycle");
      if (terminalEvent.type === "session_lifecycle") {
        expect(terminalEvent.lifecycleType).toBe("crash");
        expect(terminalEvent.exitReason).toBe("failed");
      }
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
    });

    it("generic active session without terminal record: does NOT synthesize terminal lifecycle event and remains active", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: NormalizedSessionEvent[] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedObservations.push(...input.observations);
          return {
            batchId: "batch_live_1",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_live_1", "active");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
        coalesceDwellMs: 0,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const ack = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec], ack);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedObservations.length).toBe(1);
      expect(submittedObservations[0].type).toBe("message");
      expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);
      expect(coordinator.getActiveSessionCount()).toBe(1);
    });

    it("generic session incremental delivery: derives synthetic causal tail from prior batches, never seq 1 / null parent", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedBatches: NormalizedSessionEvent[][] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedBatches.push([...input.observations]);
          return {
            batchId: `batch_${submittedBatches.length}`,
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const activeSession = createMockHarnessSession("sess_generic_incremental_1", "active");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const promptRec = createPromptRecord(activeSession.sessionId, 1);
      const compRec = createCompletionRecord(activeSession.sessionId, 2);

      // Batch 1: session is active, receives initial records
      const ack1 = vi.fn(async () => {});
      await coordinator.handleRecords(activeSession, [promptRec, compRec], ack1);

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedBatches[0].length).toBe(2);
      expect(submittedBatches[0][0].causalRef.causalSequence).toBe(1);
      expect(submittedBatches[0][1].causalRef.causalSequence).toBe(2);
      const lastEventIdBatch1 = submittedBatches[0][1].eventId;
      expect(coordinator.isSessionFinalized(activeSession.sessionId)).toBe(false);

      // Batch 2: session is now completed, receives empty record update
      const completedSession = {
        ...activeSession,
        status: "completed" as const,
      };
      const ack2 = vi.fn(async () => {});
      await coordinator.handleRecords(completedSession, [], ack2);

      expect(ack2).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(2);
      expect(submittedBatches[1].length).toBe(1);

      const syntheticEvent = submittedBatches[1][0];
      expect(syntheticEvent.type).toBe("session_lifecycle");
      if (syntheticEvent.type === "session_lifecycle") {
        expect(syntheticEvent.lifecycleType).toBe("end");
        expect(syntheticEvent.exitReason).toBe("completed");
      }
      // Sequences accurately after batch 1's tail
      expect(syntheticEvent.causalRef.causalSequence).toBe(3);
      expect(syntheticEvent.causalRef.parentId).toBe(lastEventIdBatch1);
      expect(coordinator.isSessionFinalized(completedSession.sessionId)).toBe(true);
    });

    it("generic session duplicate explicit end: suppresses synthesis when duplicate results contain explicit end", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedBatches: NormalizedSessionEvent[][] = [];
      const mockObservationClient = {
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
          submittedBatches.push([...input.observations]);
          return {
            batchId: `batch_${submittedBatches.length}`,
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        }),
      } as unknown as CloudObservationClient;

      const session = createMockHarnessSession("sess_generic_dup_explicit_1", "active");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const promptRec = createPromptRecord(session.sessionId, 1);
      const endRec = createLifecycleRecord(session.sessionId, 2, "end", "completed");

      // Batch 1: delivered initial records including explicit end
      const ack1 = vi.fn(async () => {});
      await coordinator.handleRecords(session, [promptRec, endRec], ack1);

      expect(ack1).toHaveBeenCalledTimes(1);
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(submittedBatches[0].length).toBe(2);
      expect(submittedBatches[0][1].type).toBe("session_lifecycle");

      // Reset finalized session to simulate receiving duplicate replay while session status is completed
      const completedSession = {
        ...session,
        status: "completed" as const,
      };

      // Test another coordinator instance where pipeline already has the events (duplicates)
      const coordinator2 = new TrajectoryCaptureCoordinator({
        pipeline, // shares same deduplicator/pipeline
        observationClient: mockObservationClient,
        attributionResolver: async () => null,
      });

      const ack2 = vi.fn(async () => {});
      await coordinator2.handleRecords(completedSession, [promptRec, endRec], ack2);

      expect(ack2).toHaveBeenCalledTimes(1);
      // No new batch sent because all records were duplicates and duplicate had explicit end
      expect(mockObservationClient.sendObservationBatch).toHaveBeenCalledTimes(1);
      expect(coordinator2.isSessionFinalized(completedSession.sessionId)).toBe(true);
    });
  });

  describe("duplicate events & idempotency", () => {
    it("ignores duplicate events and avoids double counting tokens or cost", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: TrajectoryObservation[] = [];

      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            submittedObservations.push(...input.observations);
            return { batchId: "batch_dup", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      });

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

      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(async () => {
          if (shouldFail) {
            throw new Error("Cloud service 503 Service Unavailable");
          }
          return { batchId: "batch_retry_ok", accepted: 1, rejected: 0, errors: [] };
        }),
      });

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

    it("generic session: treats HTTP 400 as terminal for batch: logs at error level with session id + status, saves dead letter, advances cursor via ack, and does not re-queue", async () => {
      const pipeline = new NormalizationPipeline();
      const deadLetterSpy = vi.spyOn(pipeline, "createAndSaveDeadLetter");
      const errorLogs: Array<{ message: string; context?: unknown }> = [];
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn((msg: string, ctx?: unknown) => {
          errorLogs.push({ message: msg, context: ctx });
        }),
      };

      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(),
        sendObservationBatch: vi.fn(async () => {
          throw new ProtocolError("validation", "Observation batch request failed with HTTP 400", {
            status: 400,
          });
        }),
      });

      const session = createMockHarnessSession("sess_terminal_400_test", "active");
      const coordinator = new TrajectoryCaptureCoordinator({
        pipeline,
        observationClient: mockObservationClient,
        coalesceDwellMs: 0,
        logger: mockLogger,
      });

      const ack = vi.fn(async () => {});
      const records = [createPromptRecord(session.sessionId, 1)];

      // handleRecords should NOT throw because 400 is terminal and handled
      await coordinator.handleRecords(session, records, ack);

      // (a) Cursor is advanced past those records
      expect(ack).toHaveBeenCalledTimes(1);

      // (b) Logged once at error level with session id and status
      expect(errorLogs.length).toBeGreaterThanOrEqual(1);
      const matchingLog = errorLogs.find(
        (l) => l.message.includes("sess_terminal_400_test") && l.message.includes("400"),
      );
      expect(matchingLog).toBeDefined();

      // (c) Moved batch to dead-letter store
      expect(deadLetterSpy).toHaveBeenCalledWith(
        "observation_batch",
        expect.objectContaining({
          observations: expect.any(Array),
        }),
        expect.stringContaining("400"),
      );

      // (d) Not re-queued: subsequent flush has nothing pending
      mockObservationClient.sendObservationBatch = vi.fn(async () => ({
        batchId: "batch_next_ok",
        status: "accepted",
        acceptedCount: 1,
        rejectedCount: 0,
        errors: [],
      }));

      // A subsequent batch for the same session succeeds normally without stuck retries
      const ack2 = vi.fn(async () => {});
      const records2 = [createPromptRecord(session.sessionId, 2)];
      await coordinator.handleRecords(session, records2, ack2);
      expect(ack2).toHaveBeenCalledTimes(1);
    });

    it("generic session: applies exponential backoff with jitter (1 s -> 60 s cap) to retryable 5xx failures per session", async () => {
      vi.useFakeTimers();
      try {
        const pipeline = new NormalizationPipeline();
        let attempts = 0;
        const capturedDelays: number[] = [];

        // Spy on setTimeout to capture the scheduled retry delays
        const originalSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
          if (typeof ms === "number" && ms > 0) {
            capturedDelays.push(ms);
          }
          return originalSetTimeout(fn, ms);
        }) as typeof setTimeout);

        const mockObservationClient = createMockObservationClient({
          sendTrajectoryObservationBatch: vi.fn(),
          sendObservationBatch: vi.fn(async () => {
            attempts++;
            throw new ProtocolError("retryable", "Cloud service 503", { status: 503 });
          }),
        });

        const session = createMockHarnessSession("sess_backoff_test", "active");
        const coordinator = new TrajectoryCaptureCoordinator({
          pipeline,
          observationClient: mockObservationClient,
          coalesceDwellMs: 1000,
        });

        const ack = vi.fn(async () => {});
        const records = [createPromptRecord(session.sessionId, 1)];

        // Enqueue records
        await coordinator.handleRecords(session, records, ack);

        // Run the first scheduled flush
        await vi.advanceTimersByTimeAsync(1000);
        expect(attempts).toBe(1);

        // First retry was scheduled with backoff attempt 1 (~1s +/- jitter)
        expect(capturedDelays.length).toBeGreaterThanOrEqual(2);
        const retryDelay1 = capturedDelays[capturedDelays.length - 1];
        expect(retryDelay1).toBeGreaterThanOrEqual(800);
        expect(retryDelay1).toBeLessThanOrEqual(1500);

        // Trigger retry 1
        await vi.advanceTimersByTimeAsync(retryDelay1);
        expect(attempts).toBe(2);

        // Second retry scheduled with backoff attempt 2 (~2s +/- jitter)
        const retryDelay2 = capturedDelays[capturedDelays.length - 1];
        expect(retryDelay2).toBeGreaterThanOrEqual(1600);
        expect(retryDelay2).toBeLessThanOrEqual(3000);

        // Trigger retry 2
        await vi.advanceTimersByTimeAsync(retryDelay2);
        expect(attempts).toBe(3);

        // Third retry scheduled with backoff attempt 3 (~4s +/- jitter)
        const retryDelay3 = capturedDelays[capturedDelays.length - 1];
        expect(retryDelay3).toBeGreaterThanOrEqual(3200);
        expect(retryDelay3).toBeLessThanOrEqual(6000);

        // Ensure cap does not exceed 60s
        for (let i = 0; i < 8; i++) {
          const nextDelay = capturedDelays[capturedDelays.length - 1];
          await vi.advanceTimersByTimeAsync(nextDelay);
        }
        for (const delay of capturedDelays) {
          expect(delay).toBeLessThanOrEqual(60_000);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("concurrent sessions & isolation", () => {
    it("processes independent sessions concurrently in parallel without cross-talk", async () => {
      const pipeline = new NormalizationPipeline();
      const submittedObservations: TrajectoryObservation[] = [];

      const mockObservationClient = createMockObservationClient({
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
      });

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

      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            submittedObservations.push(...input.observations);
            return { batchId: "batch_same_sess", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      });

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
      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(async () => ({
          batchId: "batch_term_repeat",
          accepted: 1,
          rejected: 0,
          errors: [],
        })),
      });

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

      const mockObservationClient = createMockObservationClient({
        sendTrajectoryObservationBatch: vi.fn(
          async (input: { observations: TrajectoryObservation[] }) => {
            sentObservation = input.observations[0];
            return { batchId: "batch_privacy", accepted: 1, rejected: 0, errors: [] };
          },
        ),
      });

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
