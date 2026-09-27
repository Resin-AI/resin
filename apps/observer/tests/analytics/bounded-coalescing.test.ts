import { randomUUID } from "node:crypto";
import type { NormalizedSessionEvent, ProviderReportedUsage } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OBSERVATION_UPLOAD_POLICY,
  chunkObservationsForUpload,
} from "../../src/analytics/capture-coordinator.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  type TrajectoryAttributionContextInput,
  TrajectoryCaptureCoordinator,
  type TrajectoryObservation,
} from "../../src/index.js";
import { TelemetryAggregator } from "../../src/observability/telemetry-aggregator.js";

function createMockHarnessSession(
  sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  status: "active" | "idle" | "completed" | "interrupted" | "failed" | "unknown" = "active",
) {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_coalesce_01",
    harnessId: "open-code",
    transcriptPath: `/var/log/transcripts/${sessionId}.jsonl`,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      environment: "production",
      runner: "test-pool",
    },
  };
}

function createValidAttributionContext(
  sessionId: string,
  overrides: Partial<TrajectoryAttributionContextInput> = {},
): TrajectoryAttributionContextInput {
  return {
    accountId: "acc_coalesce_01",
    workspaceId: "ws_coalesce_01",
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
    metadata: { testCase: "bounded-coalescing-flow" },
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

function createToolCallRecord(
  sessionId: string,
  sequenceNumber: number,
  tool = "grep",
): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: `rec_tool_${sequenceNumber}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber,
    timestamp,
    recordType: "tool_call",
    rawPayload: {
      tool,
      arguments: { pattern: "coalesce" },
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
      content: "Analysis complete.",
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

function createMockObservationClient(
  mock: Partial<CloudObservationClient> & {
    sendTrajectoryObservationBatch?: unknown;
    sendObservationBatch?: unknown;
  },
): CloudObservationClient {
  const client = Object.create(CloudObservationClient.prototype) as CloudObservationClient;
  return Object.assign(client, mock);
}

describe("Bounded Coalescing for Generic Streaming Observation Sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces adjacent generic fragments into a single cloud batch after dwell window", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: NormalizedSessionEvent[][] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submittedBatches.push([...input.observations]);
        return {
          batchId: `batch_${submittedBatches.length}`,
          acceptedCount: input.observations.length,
          rejectedCount: 0,
        };
      }),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 2000,
    });

    const session = createMockHarnessSession("sess_adjacent_1", "active");

    // Fragment 1: prompt (20ms append fragment)
    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);

    // Fragment 2: tool call 20ms later
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createToolCallRecord(session.sessionId, 2)], ack2);

    // Neither has been flushed yet (still in dwell window)
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();
    expect(ack1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();

    // Advance timer past the 2-second dwell window
    await vi.advanceTimersByTimeAsync(2000);

    // Both fragments are combined into exactly ONE cloud batch
    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedBatches).toHaveLength(1);
    expect(submittedBatches[0]).toHaveLength(2);

    // Source records are acknowledged after cloud submission succeeds
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it("turn-aware window: assistant completion shortens the window instead of flushing immediately", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: NormalizedSessionEvent[][] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submittedBatches.push([...input.observations]);
        return {
          batchId: `batch_${submittedBatches.length}`,
          acceptedCount: input.observations.length,
          rejectedCount: 0,
        };
      }),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
    });

    const session = createMockHarnessSession("sess_turn_aware_1", "active");

    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    await vi.advanceTimersByTimeAsync(1_000);

    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createToolCallRecord(session.sessionId, 2)], ack2);

    // Assistant completion is a turn hint: nothing is sent yet.
    const ack3 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 3)], ack3);
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // The remaining 14 s window shrinks to the 5 s turn-hint bound.
    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.turnHintWindowMs - 1);
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedBatches[0]).toHaveLength(3);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
    expect(ack3).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately when maxBatchSize is reached without waiting for dwell timer", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: NormalizedSessionEvent[][] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submittedBatches.push([...input.observations]);
        return {
          batchId: `batch_${submittedBatches.length}`,
          acceptedCount: input.observations.length,
          rejectedCount: 0,
        };
      }),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 5000,
      maxBatchSize: 3,
    });

    const session = createMockHarnessSession("sess_max_size_1", "active");

    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 1, "toolA")],
      ack1,
    );
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 2, "toolB")],
      ack2,
    );
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // Reaches maxBatchSize of 3
    const ack3 = vi.fn(async () => {});
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 3, "toolC")],
      ack3,
    );

    // Flushes immediately at max batch size
    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedBatches[0]).toHaveLength(3);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
    expect(ack3).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately upon explicit terminal notification", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: NormalizedSessionEvent[][] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submittedBatches.push([...input.observations]);
        return {
          batchId: `batch_${submittedBatches.length}`,
          acceptedCount: input.observations.length,
          rejectedCount: 0,
        };
      }),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 5000,
    });

    const activeSession = createMockHarnessSession("sess_terminal_flush_1", "active");

    // Fragment 1 in active state
    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(
      activeSession,
      [createToolCallRecord(activeSession.sessionId, 1)],
      ack1,
    );
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // Fragment 2 with terminal completed status
    const completedSession = { ...activeSession, status: "completed" as const };
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(completedSession, [], ack2);

    // Flushes immediately upon terminal state
    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(coordinator.isSessionFinalized(activeSession.sessionId)).toBe(true);
    expect(coordinator.getActiveSessionCount()).toBe(0);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately upon close / waitForIdle", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: NormalizedSessionEvent[][] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        submittedBatches.push([...input.observations]);
        return {
          batchId: `batch_${submittedBatches.length}`,
          acceptedCount: input.observations.length,
          rejectedCount: 0,
        };
      }),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 10000,
    });

    const session = createMockHarnessSession("sess_wait_idle_1", "active");

    const ack = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack);
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // Shutdown / close calls waitForIdle()
    await coordinator.waitForIdle();

    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("failed upload leaves records retryable and does NOT acknowledge source records", async () => {
    const pipeline = new NormalizationPipeline();
    let shouldFail = true;
    const attemptedBatchIds: string[] = [];
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(
        async (input: { batchId: string; observations: NormalizedSessionEvent[] }) => {
          attemptedBatchIds.push(input.batchId);
          if (shouldFail) {
            throw new Error("HTTP 503 Cloud Service Unavailable");
          }
          return {
            batchId: "batch_recovered",
            acceptedCount: input.observations.length,
            rejectedCount: 0,
          };
        },
      ),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
    });

    const session = createMockHarnessSession("sess_fail_retry_1", "active");

    const ack1 = vi.fn(async () => {});
    const ack2 = vi.fn(async () => {});

    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 2)], ack2);

    // The turn-hinted send fails; the coordinator keeps ownership and backs off.
    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.turnHintWindowMs);
    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(ack1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);

    // The backoff retry resends the identical batch and acknowledges on success.
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(2);
    expect(attemptedBatchIds[1]).toBe(attemptedBatchIds[0]);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it("preserves strictly ordered acknowledgements across coalesced fragments", async () => {
    const pipeline = new NormalizationPipeline();
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => ({
        batchId: "batch_ordered",
        acceptedCount: input.observations.length,
        rejectedCount: 0,
      })),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 2000,
    });

    const session = createMockHarnessSession("sess_ordered_ack_1", "active");
    const ackOrder: number[] = [];

    const ack1 = vi.fn(async () => {
      ackOrder.push(1);
    });
    const ack2 = vi.fn(async () => {
      ackOrder.push(2);
    });
    const ack3 = vi.fn(async () => {
      ackOrder.push(3);
    });

    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    await coordinator.handleRecords(session, [createToolCallRecord(session.sessionId, 2)], ack2);
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 3)], ack3);
    await vi.advanceTimersByTimeAsync(2000);

    // Acks were invoked strictly in order
    expect(ackOrder).toEqual([1, 2, 3]);
  });

  it("does not coalesce attributed trajectory sessions that submit once at finalization", async () => {
    const pipeline = new NormalizationPipeline();
    const submittedBatches: TrajectoryObservation[] = [];
    const mockClient = createMockObservationClient({
      sendObservationBatch: vi.fn(),
      sendTrajectoryObservationBatch: vi.fn(
        async (input: { observations: TrajectoryObservation[] }) => {
          submittedBatches.push(...input.observations);
          return {
            batchId: "batch_attr_1",
            accepted: input.observations.length,
            rejected: 0,
            errors: [],
          };
        },
      ),
    });

    const session = createMockHarnessSession("sess_attributed_coalesce_1", "active");
    const attributionContext = createValidAttributionContext(session.sessionId);

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => attributionContext,
      coalesceDwellMs: 5000,
    });

    // Batch 1: prompt record for attributed session
    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);

    // Attributed session records are acknowledged immediately without dwell delay!
    expect(ack1).toHaveBeenCalledTimes(1);
    // Generic observation batch is NEVER called
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();
    // Trajectory observation batch is not called yet (session not finalized)
    expect(mockClient.sendTrajectoryObservationBatch).not.toHaveBeenCalled();

    // Batch 2: completion record with terminal completed status
    const completedSession = { ...session, status: "completed" as const };
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(
      completedSession,
      [createCompletionRecord(session.sessionId, 2)],
      ack2,
    );
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);
    await coordinator.handleRecords(completedSession, [], async () => {});

    expect(ack2).toHaveBeenCalledTimes(1);
    // Submits ONCE at finalization
    expect(mockClient.sendTrajectoryObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedBatches).toHaveLength(1);
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
  });

  it("records batch size and count telemetry using local TelemetryAggregator", async () => {
    const pipeline = new NormalizationPipeline();
    const telemetry = new TelemetryAggregator();
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => ({
        batchId: "batch_telemetry",
        acceptedCount: input.observations.length,
        rejectedCount: 0,
      })),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 2000,
      telemetry,
    });

    const session = createMockHarnessSession("sess_telemetry_1", "active");

    const ack1 = vi.fn(async () => {});
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 2)], ack2);
    await vi.advanceTimersByTimeAsync(2000);

    const metrics = coordinator.getBatchMetrics();
    expect(metrics.totalBatchesUploaded).toBe(1);
    expect(metrics.totalObservationsUploaded).toBe(2);
    expect(metrics.lastBatchSize).toBe(2);

    const summary = telemetry.getSummary();
    expect(summary.counters["observer.batches.generic.uploaded"]).toBe(1);
    expect(summary.counters["observer.batches.generic.observations_uploaded"]).toBe(2);
    expect(summary.gauges["observer.batches.generic.last_size"]).toBe(2);
  });

  it("handles auth-recovery and consent withdrawal boundaries cleanly", async () => {
    const pipeline = new NormalizationPipeline();
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(),
    });

    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: mockClient,
      attributionResolver: async () => null,
      coalesceDwellMs: 10000,
    });

    const session = createMockHarnessSession("sess_consent_boundary_1", "active");

    const ack = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack);

    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // Telemetry consent withdrawn synchronously
    coordinator.setTelemetryEnabled(false);

    // Buffered records acknowledged locally without transmission to cloud
    expect(ack).toHaveBeenCalledTimes(1);
    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();
  });
});

function createLifecycleRecord(
  sessionId: string,
  sequenceNumber: number,
  lifecycleType: "start" | "end" | "crash",
): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: `rec_life_${sequenceNumber}_${randomUUID().slice(0, 8)}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber,
    timestamp,
    recordType: "transcript_line",
    rawPayload: { type: "session_lifecycle", lifecycleType, exitReason: "completed" },
    cursor: {
      offset: sequenceNumber * 100,
      line: sequenceNumber,
      sequence: sequenceNumber,
      timestamp,
    },
    metadata: {},
  };
}

function createUploadRecorder(options: { maxBatchSize?: number; maxBatchBytes?: number } = {}) {
  const batches: NormalizedSessionEvent[][] = [];
  const sendObservationBatch = vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
    batches.push([...input.observations]);
    return {
      batchId: `batch_${batches.length}`,
      acceptedCount: input.observations.length,
      rejectedCount: 0,
    };
  });
  const coordinator = new TrajectoryCaptureCoordinator({
    pipeline: new NormalizationPipeline(),
    observationClient: createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch,
    }),
    attributionResolver: async () => null,
    ...options,
  });
  return { batches, sendObservationBatch, coordinator };
}

function causalSequences(batch: readonly NormalizedSessionEvent[]): number[] {
  return batch.map((event) => event.causalRef.causalSequence);
}

describe("Observation upload policy (default window, caps and immediate triggers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays under cloud ingestion's per-request limits with margin", () => {
    // Cloud ingestion: 1,000 events and 10 MiB wire bytes (50 MiB decompressed) per request.
    const serverMaxEvents = 1_000;
    const serverMaxBytes = 10 * 1024 * 1024;
    expect(OBSERVATION_UPLOAD_POLICY.maxEvents * 4).toBeLessThanOrEqual(serverMaxEvents);
    expect(OBSERVATION_UPLOAD_POLICY.maxBytes * 4).toBeLessThanOrEqual(serverMaxBytes);
    expect(OBSERVATION_UPLOAD_POLICY.requestMaxEvents).toBeLessThanOrEqual(serverMaxEvents);
    expect(OBSERVATION_UPLOAD_POLICY.requestMaxBytes * 2).toBeLessThanOrEqual(serverMaxBytes);
    expect(OBSERVATION_UPLOAD_POLICY.turnHintWindowMs).toBeLessThan(
      OBSERVATION_UPLOAD_POLICY.windowMs,
    );
  });

  it("holds a batch for 15 s from its first event, not from its latest", async () => {
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_window", "active");

    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    await vi.advanceTimersByTimeAsync(10_000);
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createToolCallRecord(session.sessionId, 2)], ack2);

    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.windowMs - 10_000 - 1);
    expect(sendObservationBatch).not.toHaveBeenCalled();
    expect(ack1).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(causalSequences(batches[0])).toEqual([1, 2]);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it("a turn hint never lengthens a window that ends sooner than the hint bound", async () => {
    const { sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_hint_late", "active");

    await coordinator.handleRecords(
      session,
      [createPromptRecord(session.sessionId, 1)],
      async () => {},
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await coordinator.handleRecords(
      session,
      [createCompletionRecord(session.sessionId, 2)],
      async () => {},
    );

    // 3 s of the original window remain; the 5 s hint bound must not push it out.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sendObservationBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
  });

  it("sends as soon as a batch reaches 250 events", async () => {
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_event_cap", "active");
    const maxEvents = OBSERVATION_UPLOAD_POLICY.maxEvents;

    const firstRecords = Array.from({ length: maxEvents - 1 }, (_, index) =>
      createToolCallRecord(session.sessionId, index + 1, `tool_${index}`),
    );
    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, firstRecords, ack1);
    expect(sendObservationBatch).not.toHaveBeenCalled();

    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, maxEvents, "tool_last")],
      ack2,
    );

    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(maxEvents);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it("sends before unacknowledged deliveries reach the tailer's in-flight limit", async () => {
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_delivery_cap", "active");
    const limit = OBSERVATION_UPLOAD_POLICY.maxPendingDeliveries;

    for (let sequence = 1; sequence < limit; sequence++) {
      await coordinator.handleRecords(
        session,
        [createToolCallRecord(session.sessionId, sequence, `tool_${sequence}`)],
        async () => {},
      );
    }
    expect(sendObservationBatch).not.toHaveBeenCalled();

    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, limit, "tool_last")],
      async () => {},
    );
    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(limit);
  });

  it("sends as soon as the serialized batch reaches the byte cap", async () => {
    const maxBatchBytes = 1_500;
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder({ maxBatchBytes });
    const session = createMockHarnessSession("sess_policy_byte_cap", "active");

    let sequence = 0;
    while (sendObservationBatch.mock.calls.length === 0 && sequence < 50) {
      sequence++;
      await coordinator.handleRecords(
        session,
        [createPromptRecord(session.sessionId, sequence)],
        async () => {},
      );
    }

    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    const eventBytes = batches[0].map((event) => Buffer.byteLength(JSON.stringify(event)));
    const total = eventBytes.reduce((sum, bytes) => sum + bytes, 0);
    expect(batches[0].length).toBeGreaterThan(1);
    expect(total).toBeGreaterThanOrEqual(maxBatchBytes);
    expect(total - (eventBytes.at(-1) ?? 0)).toBeLessThan(maxBatchBytes);
  });

  it("an explicit session end lifecycle event sends immediately", async () => {
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_lifecycle_end", "active");

    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    expect(sendObservationBatch).not.toHaveBeenCalled();

    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(
      session,
      [createLifecycleRecord(session.sessionId, 2, "end")],
      ack2,
    );

    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(causalSequences(batches[0])).toEqual([1, 2]);
    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(true);
  });

  it("shutdown sends everything buffered, once, without waiting for the window", async () => {
    const { batches, sendObservationBatch, coordinator } = createUploadRecorder();
    const first = createMockHarnessSession("sess_policy_shutdown_a", "active");
    const second = createMockHarnessSession("sess_policy_shutdown_b", "active");

    const acks = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];
    await coordinator.handleRecords(first, [createPromptRecord(first.sessionId, 1)], acks[0]);
    await coordinator.handleRecords(first, [createToolCallRecord(first.sessionId, 2)], acks[1]);
    await coordinator.handleRecords(second, [createPromptRecord(second.sessionId, 1)], acks[2]);
    expect(sendObservationBatch).not.toHaveBeenCalled();

    await coordinator.waitForIdle();

    expect(sendObservationBatch).toHaveBeenCalledTimes(2);
    expect(batches.map((batch) => batch.length).sort()).toEqual([1, 2]);
    for (const ack of acks) expect(ack).toHaveBeenCalledTimes(1);

    // The cancelled window timers never send a second, empty or duplicate batch.
    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.windowMs * 2);
    expect(sendObservationBatch).toHaveBeenCalledTimes(2);
  });

  it("expediteFlush sends a draining session's batch on the next tick", async () => {
    const { sendObservationBatch, coordinator } = createUploadRecorder();
    const session = createMockHarnessSession("sess_policy_expedite", "active");

    const ack = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack);
    coordinator.expediteFlush(session.sessionId);
    coordinator.expediteFlush("sess_unknown");
    expect(sendObservationBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("preserves event and acknowledgement order across cap, hint and window sends", async () => {
    const { batches, coordinator } = createUploadRecorder({ maxBatchSize: 3 });
    const session = createMockHarnessSession("sess_policy_order", "active");
    const ackOrder: number[] = [];
    const ackFor = (sequence: number) => async () => {
      ackOrder.push(sequence);
    };

    // Cap send: [1, 2, 3].
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ackFor(1));
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 2)],
      ackFor(2),
    );
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 3)],
      ackFor(3),
    );
    // Turn-hinted send: [4, 5].
    await coordinator.handleRecords(
      session,
      [createToolCallRecord(session.sessionId, 4)],
      ackFor(4),
    );
    await coordinator.handleRecords(
      session,
      [createCompletionRecord(session.sessionId, 5)],
      ackFor(5),
    );
    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.turnHintWindowMs);
    // Window send: [6].
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 6)], ackFor(6));
    await vi.advanceTimersByTimeAsync(OBSERVATION_UPLOAD_POLICY.windowMs);

    expect(batches.map(causalSequences)).toEqual([[1, 2, 3], [4, 5], [6]]);
    expect(ackOrder).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("splits an oversized buffer into ordered requests under the per-request byte ceiling", () => {
    const { requestMaxBytes, requestMaxEvents } = OBSERVATION_UPLOAD_POLICY;
    const padding = "x".repeat(1024 * 1024);
    const large = Array.from({ length: 12 }, (_, index) => ({ index, padding }));
    const largeBytes = large.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );

    const largeChunks = chunkObservationsForUpload(large, largeBytes);
    expect(largeChunks.length).toBeGreaterThan(1);
    for (const chunk of largeChunks) {
      const bytes = chunk.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
      expect(bytes).toBeLessThanOrEqual(requestMaxBytes);
    }
    expect(largeChunks.flat().map((event) => event.index)).toEqual(large.map((e) => e.index));

    // Buffers within the byte ceiling keep the event-count split.
    const small = Array.from({ length: requestMaxEvents * 2 + 5 }, (_, index) => ({ index }));
    const smallChunks = chunkObservationsForUpload(small, 1_000);
    expect(smallChunks.map((chunk) => chunk.length)).toEqual([
      requestMaxEvents,
      requestMaxEvents,
      5,
    ]);
  });
});
