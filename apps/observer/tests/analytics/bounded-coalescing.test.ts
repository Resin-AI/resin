import { randomUUID } from "node:crypto";
import type { NormalizedSessionEvent, ProviderReportedUsage } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("turn-aware window: assistant completion triggers immediate flush of all preceding fragments", async () => {
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

    const session = createMockHarnessSession("sess_turn_aware_1", "active");

    // Fragment 1: prompt
    const ack1 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);

    // Fragment 2: tool call
    const ack2 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createToolCallRecord(session.sessionId, 2)], ack2);

    expect(mockClient.sendObservationBatch).not.toHaveBeenCalled();

    // Fragment 3: assistant completion -> turn boundary!
    const ack3 = vi.fn(async () => {});
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 3)], ack3);

    // Flushes immediately without waiting for the 2000ms dwell timer!
    expect(mockClient.sendObservationBatch).toHaveBeenCalledTimes(1);
    expect(submittedBatches).toHaveLength(1);
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
    const mockClient = createMockObservationClient({
      sendTrajectoryObservationBatch: vi.fn(),
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        if (shouldFail) {
          throw new Error("HTTP 503 Cloud Service Unavailable");
        }
        return {
          batchId: "batch_recovered",
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

    const session = createMockHarnessSession("sess_fail_retry_1", "active");

    const ack1 = vi.fn(async () => {});
    const ack2 = vi.fn(async () => {});

    await coordinator.handleRecords(session, [createPromptRecord(session.sessionId, 1)], ack1);
    // Fragment 2: completion triggers an attempted flush. The coordinator retains ownership
    // and schedules a retry rather than returning the records to the tailer.
    await coordinator.handleRecords(session, [createCompletionRecord(session.sessionId, 2)], ack2);

    // Neither ack was called! Records remain unacknowledged and retryable!
    expect(ack1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();
    expect(coordinator.isSessionFinalized(session.sessionId)).toBe(false);

    // Retry cloud upload
    shouldFail = false;
    await coordinator.flush(session.sessionId);

    // After retry succeeds, both acks are called
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
