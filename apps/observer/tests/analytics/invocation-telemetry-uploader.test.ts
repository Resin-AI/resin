import type { InvocationRecord } from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import type { TelemetryBatchResponse } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvocationTelemetryUploader } from "../../src/analytics/invocation-telemetry-uploader.js";
import { ResourceForbiddenError } from "../../src/auth-recovery.js";
import type { CloudObservationClient, SendTelemetryBatchInput } from "../../src/cloud-runtime.js";
import type { Logger } from "../../src/lifecycle.js";

function makeInvocation(
  overrides: Partial<InvocationRecord> & { invocationId: string; workspaceId: string },
): InvocationRecord {
  return {
    sessionId: "ses_test_001",
    toolId: "tool_test",
    toolVersion: "1.0.0",
    startedAt: "2026-08-27T10:00:00.000Z",
    completedAt: "2026-08-27T10:00:01.000Z",
    durationMs: 1000,
    status: "success",
    inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("InvocationTelemetryUploader", () => {
  let store: LocalStateStore;
  let mockLogger: Logger;

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    // Prepare session for foreign key constraint in invocation_records
    await store.sessions.saveSession({
      sessionId: "ses_test_001",
      harnessId: "claude-code",
      status: "active",
      startedAt: "2026-08-27T10:00:00.000Z",
    });

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it("returns { uploaded: 0 } when no pending invocations exist", async () => {
    const mockCloudClient = {
      sendTelemetryBatch: vi.fn(),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    const result = await uploader.flushOnce();
    expect(result).toEqual({ uploaded: 0 });
    expect(mockCloudClient.sendTelemetryBatch).not.toHaveBeenCalled();
  });

  it("uploads pending rows grouped by workspaceId and marks them uploaded on accepted status", async () => {
    const inv1 = makeInvocation({
      invocationId: "inv_ws1_1",
      workspaceId: "ws_alpha",
      startedAt: "2026-08-27T10:01:00.000Z",
    });
    const inv2 = makeInvocation({
      invocationId: "inv_ws1_2",
      workspaceId: "ws_alpha",
      startedAt: "2026-08-27T10:02:00.000Z",
    });
    const inv3 = makeInvocation({
      invocationId: "inv_ws2_1",
      workspaceId: "ws_beta",
      startedAt: "2026-08-27T10:03:00.000Z",
    });

    await store.audit.recordInvocation(inv1);
    await store.audit.recordInvocation(inv2);
    await store.audit.recordInvocation(inv3);

    const capturedBatches: SendTelemetryBatchInput[] = [];
    const mockCloudClient = {
      sendTelemetryBatch: vi
        .fn()
        .mockImplementation(
          async (input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> => {
            capturedBatches.push(input);
            return {
              batchId: `tb_${input.workspaceId}`,
              status: "accepted",
              processedCount: input.invocations.length,
            };
          },
        ),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    const result = await uploader.flushOnce();
    expect(result).toEqual({ uploaded: 3 });

    // Verify 2 batches sent (1 for ws_alpha with 2 records, 1 for ws_beta with 1 record).
    // Batches are grouped by the local workspace but addressed to the paired cloud
    // workspace: the client fills that in, so the input carries no workspaceId.
    expect(capturedBatches).toHaveLength(2);
    expect(capturedBatches.every((b) => b.workspaceId === undefined)).toBe(true);
    const alphaBatch = capturedBatches.find((b) =>
      b.invocations.every((i) => i.workspaceId === "ws_alpha"),
    );
    const betaBatch = capturedBatches.find((b) =>
      b.invocations.every((i) => i.workspaceId === "ws_beta"),
    );

    expect(alphaBatch?.invocations).toHaveLength(2);
    expect(alphaBatch?.invocations.map((i) => i.invocationId)).toEqual(["inv_ws1_1", "inv_ws1_2"]);
    expect(betaBatch?.invocations).toHaveLength(1);
    expect(betaBatch?.invocations[0].invocationId).toBe("inv_ws2_1");

    // Verify all rows are marked uploaded so subsequent flush returns 0
    const secondFlush = await uploader.flushOnce();
    expect(secondFlush).toEqual({ uploaded: 0 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });

  it("marks rows uploaded when status is partial", async () => {
    const inv = makeInvocation({
      invocationId: "inv_partial_1",
      workspaceId: "ws_alpha",
    });
    await store.audit.recordInvocation(inv);

    const mockCloudClient = {
      sendTelemetryBatch: vi.fn().mockResolvedValue({
        batchId: "tb_partial",
        status: "partial",
        processedCount: 1,
      }),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    const result = await uploader.flushOnce();
    expect(result).toEqual({ uploaded: 1 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });

  it("leaves rows pending on network failure and retries on next flush", async () => {
    const invFail = makeInvocation({
      invocationId: "inv_fail_1",
      workspaceId: "ws_failing",
      startedAt: "2026-08-27T10:01:00.000Z",
    });
    const invSuccess = makeInvocation({
      invocationId: "inv_succ_1",
      workspaceId: "ws_healthy",
      startedAt: "2026-08-27T10:02:00.000Z",
    });

    await store.audit.recordInvocation(invFail);
    await store.audit.recordInvocation(invSuccess);

    let shouldFail = true;
    const mockCloudClient = {
      sendTelemetryBatch: vi
        .fn()
        .mockImplementation(
          async (input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> => {
            if (input.invocations[0]?.workspaceId === "ws_failing" && shouldFail) {
              throw new Error("Network unreachable (ECONNREFUSED)");
            }
            return {
              batchId: `tb_${input.workspaceId}`,
              status: "accepted",
              processedCount: input.invocations.length,
            };
          },
        ),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    // First cycle: ws_failing fails, ws_healthy succeeds
    const firstResult = await uploader.flushOnce();
    expect(firstResult).toEqual({ uploaded: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to upload invocation telemetry batch for workspace",
      expect.objectContaining({ workspaceId: "ws_failing", count: 1 }),
    );

    // Failing row remains pending; healthy row is uploaded
    const pendingAfterFirst = store.audit.listPendingInvocationUploads(10);
    expect(pendingAfterFirst).toHaveLength(1);
    expect(pendingAfterFirst[0].invocationId).toBe("inv_fail_1");

    // Second cycle: network recovers, retry succeeds
    shouldFail = false;
    const secondResult = await uploader.flushOnce();
    expect(secondResult).toEqual({ uploaded: 1 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });

  it("leaves rows pending when cloud responds with rejected status", async () => {
    const inv = makeInvocation({
      invocationId: "inv_rejected_1",
      workspaceId: "ws_alpha",
    });
    await store.audit.recordInvocation(inv);

    const mockCloudClient = {
      sendTelemetryBatch: vi.fn().mockResolvedValue({
        batchId: "tb_rejected",
        status: "rejected",
        processedCount: 0,
      }),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    const result = await uploader.flushOnce();
    expect(result).toEqual({ uploaded: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Telemetry batch rejected by cloud",
      expect.objectContaining({ workspaceId: "ws_alpha", status: "rejected" }),
    );
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(1);
  });

  it("respects bounded batch size", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.audit.recordInvocation(
        makeInvocation({
          invocationId: `inv_batch_${i}`,
          workspaceId: "ws_batch",
          startedAt: `2026-08-27T10:0${i}:00.000Z`,
        }),
      );
    }

    const mockCloudClient = {
      sendTelemetryBatch: vi
        .fn()
        .mockImplementation(
          async (input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> => {
            return {
              batchId: "tb_batch",
              status: "accepted",
              processedCount: input.invocations.length,
            };
          },
        ),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      batchSize: 2,
      logger: mockLogger,
    });

    // First cycle flushes 2 rows
    const first = await uploader.flushOnce();
    expect(first).toEqual({ uploaded: 2 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(3);

    // Second cycle flushes next 2 rows
    const second = await uploader.flushOnce();
    expect(second).toEqual({ uploaded: 2 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(1);

    // Third cycle flushes final row
    const third = await uploader.flushOnce();
    expect(third).toEqual({ uploaded: 1 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });

  it("starts and stops periodic timer cleanly", () => {
    vi.useFakeTimers();

    const mockCloudClient = {
      sendTelemetryBatch: vi.fn().mockResolvedValue({
        batchId: "tb_timer",
        status: "accepted",
        processedCount: 0,
      }),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      intervalMs: 15_000,
      logger: mockLogger,
    });

    uploader.start();
    // Starting again is a no-op
    uploader.start();

    // Advance time by interval
    vi.advanceTimersByTime(15_000);

    uploader.stop();
    // Advance time again, no further calls
    vi.advanceTimersByTime(30_000);

    vi.useRealTimers();
  });
  it("dead-letters after bounded retries on ResourceForbiddenError and continues with the next batch", async () => {
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_forbidden_1",
        workspaceId: "ws_forbidden",
      }),
    );
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_healthy_1",
        workspaceId: "ws_healthy",
      }),
    );

    const mockCloudClient = {
      sendTelemetryBatch: vi
        .fn()
        .mockImplementation(
          async (input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> => {
            const localWorkspace = input.invocations[0]?.workspaceId;
            if (localWorkspace === "ws_forbidden") {
              throw new ResourceForbiddenError(
                `Cloud request forbidden for workspace ${localWorkspace}`,
                { workspaceId: localWorkspace },
              );
            }
            return {
              batchId: `tb_${input.workspaceId}`,
              status: "accepted",
              processedCount: input.invocations.length,
            };
          },
        ),
    } as unknown as CloudObservationClient;

    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    // Cycle 1: ws_forbidden fails (attempt 1/3); ws_healthy succeeds
    const first = await uploader.flushOnce();
    expect(first).toEqual({ uploaded: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to upload invocation telemetry batch for workspace",
      expect.objectContaining({ workspaceId: "ws_forbidden", retries: 1 }),
    );
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(1);

    // Cycle 2: ws_forbidden fails (attempt 2/3)
    const second = await uploader.flushOnce();
    expect(second).toEqual({ uploaded: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to upload invocation telemetry batch for workspace",
      expect.objectContaining({ workspaceId: "ws_forbidden", retries: 2 }),
    );
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(1);

    // Cycle 3: ws_forbidden fails (attempt 3/3) -> dead-lettered and marked failed
    const third = await uploader.flushOnce();
    expect(third).toEqual({ uploaded: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to upload invocation telemetry batch for workspace",
      expect.objectContaining({ workspaceId: "ws_forbidden", retries: 3, exhausted: true }),
    );

    // No rows remain pending!
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);

    // Verify row status in database was marked as error
    const invRow = await store.audit.getInvocation("inv_forbidden_1");
    expect(invRow?.status).toBe("error");

    // Verify dead letter was recorded
    const deadLetters = store.conn.all<{
      dead_letter_id: string;
      original_event_type: string;
      status: string;
      retry_count: number;
    }>("SELECT * FROM dead_letters WHERE original_event_type = 'invocation_telemetry_batch';");
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].original_event_type).toBe("invocation_telemetry_batch");
    expect(deadLetters[0].status).toBe("exhausted");
    expect(deadLetters[0].retry_count).toBe(3);

    // Cycle 4: a new batch for ws_next succeeds without being blocked by previous dead-letter
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_next_1",
        workspaceId: "ws_next",
      }),
    );
    const fourth = await uploader.flushOnce();
    expect(fourth).toEqual({ uploaded: 1 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });
});
