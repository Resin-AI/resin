import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvocationRecord } from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { ProtocolError, type TelemetryBatchResponse } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvocationTelemetryUploader,
  type InvocationUploadIdentity,
} from "../../src/analytics/invocation-telemetry-uploader.js";
import { ResourceForbiddenError } from "../../src/auth-recovery.js";
import type { CloudObservationClient, SendTelemetryBatchInput } from "../../src/cloud-runtime.js";
import type { Logger } from "../../src/lifecycle.js";
import {
  SIGN_OUT_BOUNDARY_FILE_NAME,
  readSignOutBoundary,
  writeSignOutBoundary,
} from "../../src/sign-out-boundary.js";

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
      usageEstimate: {
        method: "tool_io_utf8_v1",
        inputTokens: 11,
        outputTokens: 22,
        discoveryTokens: 33,
        totalTokens: 66,
      },
      executionDurationMs: 640,
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
    expect(alphaBatch?.invocations[0].usageEstimate).toEqual(inv1.usageEstimate);
    expect(alphaBatch?.invocations[1].usageEstimate).toBeUndefined();
    expect(alphaBatch?.invocations[0].executionDurationMs).toBe(640);
    expect(alphaBatch?.invocations[1].executionDurationMs).toBeUndefined();
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
  it("backs off a workspace the cloud forbids: rows stay pending, no dead letter, no warning, healthy workspaces still upload", async () => {
    for (let i = 1; i <= 3; i++) {
      await store.audit.recordInvocation(
        makeInvocation({
          invocationId: `inv_forbidden_${i}`,
          workspaceId: "ws_forbidden",
          startedAt: `2026-08-27T10:00:0${i}.000Z`,
        }),
      );
    }
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_healthy_1",
        workspaceId: "ws_healthy",
        startedAt: "2026-08-27T10:00:09.000Z",
      }),
    );

    const sentWorkspaces: string[] = [];
    const mockCloudClient = {
      sendTelemetryBatch: vi
        .fn()
        .mockImplementation(
          async (input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> => {
            const localWorkspace = input.invocations[0]?.workspaceId ?? "";
            sentWorkspaces.push(localWorkspace);
            if (localWorkspace === "ws_forbidden") {
              throw new ResourceForbiddenError(
                `Cloud request forbidden for workspace ${localWorkspace}`,
                { workspaceId: localWorkspace },
              );
            }
            return {
              batchId: `tb_${localWorkspace}`,
              status: "accepted",
              processedCount: input.invocations.length,
            };
          },
        ),
    } as unknown as CloudObservationClient;
    let nowMs = Date.parse("2026-08-27T12:00:00.000Z");
    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
      now: () => nowMs,
    });

    expect(await uploader.flushOnce()).toEqual({ uploaded: 1 });
    // Within the backoff the refused workspace is not sent again and nothing is logged as a warning.
    expect(await uploader.flushOnce()).toEqual({ uploaded: 0 });
    expect(sentWorkspaces).toEqual(["ws_forbidden", "ws_healthy"]);
    expect(store.audit.listPendingInvocationUploads(10).map((r) => r.invocationId)).toEqual([
      "inv_forbidden_1",
      "inv_forbidden_2",
      "inv_forbidden_3",
    ]);
    expect((await store.audit.getInvocation("inv_forbidden_2"))?.status).toBe("success");
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(
      store.conn.all(
        "SELECT 1 FROM dead_letters WHERE original_event_type = 'invocation_telemetry_batch';",
      ),
    ).toEqual([]);

    // A later healthy record is not starved by the refused backlog.
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_healthy_2",
        workspaceId: "ws_healthy",
        startedAt: "2026-08-27T10:00:10.000Z",
      }),
    );
    expect(await uploader.flushOnce()).toEqual({ uploaded: 1 });

    // After the backoff elapses the workspace is tried once more, and a second refusal backs off longer.
    nowMs += 15 * 60_000;
    await uploader.flushOnce();
    expect(sentWorkspaces.filter((w) => w === "ws_forbidden")).toHaveLength(2);
    nowMs += 15 * 60_000;
    await uploader.flushOnce();
    expect(sentWorkspaces.filter((w) => w === "ws_forbidden")).toHaveLength(2);
    nowMs += 15 * 60_000;
    await uploader.flushOnce();
    expect(sentWorkspaces.filter((w) => w === "ws_forbidden")).toHaveLength(3);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it("uploads a workspace's backlog once the cloud starts accepting it", async () => {
    await store.audit.recordInvocation(
      makeInvocation({ invocationId: "inv_later_1", workspaceId: "ws_later" }),
    );
    let accepting = false;
    const sendTelemetryBatch = vi
      .fn()
      .mockImplementation(async (input: SendTelemetryBatchInput) => {
        if (!accepting) {
          throw new ResourceForbiddenError("Cloud request forbidden for workspace ws_later", {
            workspaceId: "ws_later",
          });
        }
        return {
          batchId: "tb_later",
          status: "accepted",
          processedCount: input.invocations.length,
        };
      });
    let nowMs = Date.parse("2026-08-27T12:00:00.000Z");
    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: { sendTelemetryBatch } as unknown as CloudObservationClient,
      logger: mockLogger,
      now: () => nowMs,
    });

    expect(await uploader.flushOnce()).toEqual({ uploaded: 0 });
    accepting = true;
    nowMs += 15 * 60_000;
    expect(await uploader.flushOnce()).toEqual({ uploaded: 1 });
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
  });

  it("sends error details within the cloud's limits and dead-letters a batch the cloud permanently rejects", async () => {
    const longMessage =
      "Missing required parameter 'cwd'; Missing required parameter 'arg0'; Unrecognized parameter 'executable' (additional properties not allowed)";
    await store.audit.recordInvocation(
      makeInvocation({
        invocationId: "inv_long_error",
        workspaceId: "ws_alpha",
        status: "error",
        errorDetails: {
          errorType: "E".repeat(80),
          message: longMessage,
          stack: "at x (y.ts:1)",
          reason: "validation_error",
        },
      }),
    );

    const sent: SendTelemetryBatchInput[] = [];
    const mockCloudClient = {
      sendTelemetryBatch: vi.fn().mockImplementation(async (input: SendTelemetryBatchInput) => {
        sent.push(input);
        throw new ProtocolError("validation", "Telemetry batch request failed with HTTP 400", {
          status: 400,
        });
      }),
    } as unknown as CloudObservationClient;
    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: mockCloudClient,
      logger: mockLogger,
    });

    await uploader.flushOnce();
    const details = sent[0]?.invocations[0]?.errorDetails;
    expect(details?.errorType.length).toBe(64);
    expect(details?.message.length).toBeLessThanOrEqual(128);
    expect(details?.message.startsWith("Missing required parameter 'cwd'")).toBe(true);
    expect(details?.stack).toBeUndefined();
    // The failure reason survives the local store and the wire trimming.
    expect(details?.reason).toBe("validation_error");

    // One attempt, then dead-lettered: the next cycle sends nothing.
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(0);
    await uploader.flushOnce();
    expect(mockCloudClient.sendTelemetryBatch).toHaveBeenCalledTimes(1);
    const deadLetters = store.conn.all<{ status: string }>(
      "SELECT status FROM dead_letters WHERE original_event_type = 'invocation_telemetry_batch';",
    );
    expect(deadLetters).toEqual([{ status: "exhausted" }]);
  });

  it("keeps retrying a batch rate limited with HTTP 429", async () => {
    await store.audit.recordInvocation(
      makeInvocation({ invocationId: "inv_limited_1", workspaceId: "ws_limited" }),
    );
    const sendTelemetryBatch = vi.fn().mockRejectedValue(
      new ProtocolError("validation", "Telemetry batch request failed with HTTP 429", {
        status: 429,
      }),
    );
    const uploader = new InvocationTelemetryUploader({
      auditRepository: store.audit,
      cloudClient: { sendTelemetryBatch } as unknown as CloudObservationClient,
      logger: mockLogger,
    });

    for (let cycle = 0; cycle < 4; cycle++) {
      await uploader.flushOnce();
    }
    expect(store.audit.listPendingInvocationUploads(10)).toHaveLength(1);
  });

  describe("identity boundary", () => {
    const LOGOUT_AT = "2026-08-27T12:00:00.000Z";
    const LOGIN_AT = "2026-08-27T13:00:00.000Z";
    const marker = JSON.stringify({ version: 1, id: "logout-1", signedOutAt: LOGOUT_AT });
    let stateDir: string;
    let identity: InvocationUploadIdentity | null;
    let sent: string[];

    const cloudClient = () =>
      ({
        sendTelemetryBatch: vi.fn(async (input: SendTelemetryBatchInput) => {
          sent.push(...input.invocations.map((invocation) => invocation.invocationId));
          return { batchId: "tb", status: "accepted", processedCount: input.invocations.length };
        }),
      }) as unknown as CloudObservationClient;

    const uploader = () =>
      new InvocationTelemetryUploader({
        auditRepository: store.audit,
        cloudClient: cloudClient(),
        logger: mockLogger,
        currentIdentity: async () => identity,
        identityStatePath: path.join(stateDir, "invocation-upload-identity.json"),
        signOutBoundaryPath: path.join(stateDir, SIGN_OUT_BOUNDARY_FILE_NAME),
      });

    const record = (invocationId: string, startedAt: string) =>
      store.audit.recordInvocation(
        makeInvocation({ invocationId, workspaceId: "ws_local", startedAt }),
      );

    beforeEach(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-invocation-identity-"));
      identity = { workspaceId: "ws_cloud_a", storedAt: "2026-08-27T09:00:00.000Z" };
      sent = [];
    });

    afterEach(() => {
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("never uploads rows recorded before a logout or while signed out, to any workspace", async () => {
      const first = uploader();
      await first.flushOnce();
      await record("inv_before_logout", "2026-08-27T11:00:00.000Z");

      // `resin logout`: the credentials are purged and the daemon is signalled.
      identity = null;
      expect(first.applySignOutBoundary(marker)).toBe(true);
      expect(store.audit.listPendingInvocationUploads(10)).toEqual([]);
      await record("inv_signed_out", "2026-08-27T12:30:00.000Z");
      expect(await first.flushOnce()).toEqual({ uploaded: 0 });

      // Credentials that predate the logout (a stale read) never carry the backlog.
      identity = { workspaceId: "ws_cloud_a", storedAt: "2026-08-27T09:00:00.000Z" };
      expect(await first.flushOnce()).toEqual({ uploaded: 0 });
      expect(sent).toEqual([]);

      // A later login, to another workspace, after a daemon restart.
      await record("inv_after_login", "2026-08-27T13:30:00.000Z");
      identity = { workspaceId: "ws_cloud_b", storedAt: LOGIN_AT };
      const restarted = uploader();
      expect(await restarted.flushOnce()).toEqual({ uploaded: 1 });
      expect(sent).toEqual(["inv_after_login"]);
      expect(store.audit.listPendingInvocationUploads(10)).toEqual([]);
    });

    it("applies a logout the daemon missed from the marker, once", async () => {
      await uploader().flushOnce();
      await record("inv_before_logout", "2026-08-27T11:00:00.000Z");
      await record("inv_signed_out", "2026-08-27T12:30:00.000Z");
      writeSignOutBoundary(stateDir);
      const written = readSignOutBoundary(path.join(stateDir, SIGN_OUT_BOUNDARY_FILE_NAME));
      expect(written).not.toBeNull();
      const loginAt = new Date(Date.now() + 60_000).toISOString();
      identity = { workspaceId: "ws_cloud_a", storedAt: loginAt };
      const later = new Date(Date.now() + 120_000).toISOString();

      const running = uploader();
      expect(await running.flushOnce()).toEqual({ uploaded: 0 });
      // The marker stays until the capture module consumes it; rows recorded after the login
      // are not withheld again by the same logout.
      await record("inv_after_login", later);
      expect(await running.flushOnce()).toEqual({ uploaded: 1 });
      expect(sent).toEqual(["inv_after_login"]);
    });

    it("withholds the backlog from a different workspace but keeps it across credential loss", async () => {
      const running = uploader();
      await running.flushOnce();

      // Credentials lost without a logout, then restored for the same workspace.
      identity = null;
      await record("inv_during_loss", "2026-08-27T11:00:00.000Z");
      expect(await running.flushOnce()).toEqual({ uploaded: 0 });
      identity = { workspaceId: "ws_cloud_a", storedAt: LOGIN_AT };
      expect(await running.flushOnce()).toEqual({ uploaded: 1 });
      expect(sent).toEqual(["inv_during_loss"]);

      // Lost again, then signed in to another workspace: the old backlog stays local.
      identity = null;
      await record("inv_workspace_a", "2026-08-27T14:00:00.000Z");
      identity = { workspaceId: "ws_cloud_b", storedAt: "2026-08-27T15:00:00.000Z" };
      await record("inv_workspace_b", "2026-08-27T15:30:00.000Z");
      expect(await running.flushOnce()).toEqual({ uploaded: 1 });
      expect(sent).toEqual(["inv_during_loss", "inv_workspace_b"]);
      expect(store.audit.listPendingInvocationUploads(10)).toEqual([]);
    });
  });
});
