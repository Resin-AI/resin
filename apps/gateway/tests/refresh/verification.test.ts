import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogRefreshCoordinator,
  type McpGatewayLike,
  RefreshVerifier,
} from "../../src/refresh/index.js";
import { createMockConnection } from "./fake-matrix.js";

describe("CatalogRefreshCoordinator - Verification Lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions pending verification to observed when tools/list is called", async () => {
    const conn = createMockConnection({
      connectionId: "conn-verif",
      workspaceId: "ws-verif",
      supportsListChanged: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      verificationTimeoutMs: 10_000,
      gateway: mockGateway,
    });

    let verifiedEventReceived: unknown = undefined;
    coordinator.onRefreshVerified((v) => {
      verifiedEventReceived = v;
    });

    const attempts = await coordinator.triggerRefresh("ws-verif", 1);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.verificationStatus).toBe("pending");

    const pending = coordinator.getVerifications({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]?.connectionId).toBe("conn-verif");

    // Client issues tools/list
    const observed = coordinator.recordToolsListObserved("conn-verif", "ws-verif");
    expect(observed.length).toBe(1);
    expect(observed[0]?.status).toBe("observed");
    expect(observed[0]?.observedVia).toBe("tools_list");
    expect(observed[0]?.verifiedAt).toBeDefined();

    // Check attempt updated
    const updatedAttempt = coordinator.getAttempts({ connectionId: "conn-verif" })[0];
    expect(updatedAttempt?.verificationStatus).toBe("observed");
    expect(updatedAttempt?.outcomes).toContain("native_observed");

    // Check listener received update
    expect(verifiedEventReceived).toBeDefined();

    // No more pending
    expect(coordinator.getVerifications({ status: "pending" }).length).toBe(0);

    coordinator.destroy();
  });

  it("transitions pending verification to timeout when verification deadline passes", async () => {
    const conn = createMockConnection({
      connectionId: "conn-timeout",
      workspaceId: "ws-timeout",
      supportsListChanged: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      verificationTimeoutMs: 5_000,
      gateway: mockGateway,
    });

    await coordinator.triggerRefresh("ws-timeout", 1);
    expect(coordinator.getVerifications({ status: "pending" }).length).toBe(1);

    // Advance time past deadline
    await vi.advanceTimersByTimeAsync(6_000);

    expect(coordinator.getVerifications({ status: "pending" }).length).toBe(0);
    const timedOut = coordinator.getVerifications({ status: "timeout" });
    expect(timedOut.length).toBe(1);
    expect(timedOut[0]?.status).toBe("timeout");

    coordinator.destroy();
  });

  it("supports standalone RefreshVerifier operations", () => {
    const verifier = new RefreshVerifier({ defaultTimeoutMs: 5000 });

    const verification = verifier.registerAttempt({
      attemptId: "att-test",
      connectionId: "conn-standalone",
      harnessId: "test-harness",
      workspaceId: "ws-test",
      revision: 1,
      primaryOutcome: "native_sent",
      outcomes: ["native_sent"],
      mcpNotificationSent: true,
      adapterNudgeSent: false,
      timestamp: new Date().toISOString(),
      verificationStatus: "pending",
    });

    expect(verification.status).toBe("pending");
    expect(verifier.getPendingVerifications().length).toBe(1);

    // Explicit ack
    const acked = verifier.recordExplicitAck(verification.verificationId, "explicit_ack");
    expect(acked?.status).toBe("observed");
    expect(acked?.observedVia).toBe("explicit_ack");
    expect(verifier.getPendingVerifications().length).toBe(0);

    verifier.destroy();
  });
});
