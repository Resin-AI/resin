import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogRefreshCoordinator, type McpGatewayLike } from "../../src/refresh/index.js";
import { createMockConnection } from "./fake-matrix.js";

describe("CatalogRefreshCoordinator - Scope Targeting and Debouncing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("targets only connections in the affected workspace", async () => {
    const connWs1 = createMockConnection({
      connectionId: "conn-1",
      workspaceId: "ws-alpha",
      supportsListChanged: true,
    });
    const connWs2 = createMockConnection({
      connectionId: "conn-2",
      workspaceId: "ws-beta",
      supportsListChanged: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connWs1.connection, connWs2.connection],
      getConnection: (id) =>
        id === "conn-1" ? connWs1.connection : id === "conn-2" ? connWs2.connection : undefined,
      sendNotificationToConnection: vi.fn((id, notif) => {
        if (id === "conn-1") connWs1.connection.sendMessage(notif);
        if (id === "conn-2") connWs2.connection.sendMessage(notif);
      }),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-alpha", 1, {
      changedToolIds: ["tool_a"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.connectionId).toBe("conn-1");
    expect(attempts[0]?.workspaceId).toBe("ws-alpha");
    expect(connWs1.notificationsReceived.length).toBe(1);
    expect(connWs2.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });

  it("targets specific session when sessionId is provided in event", async () => {
    const connSessionA = createMockConnection({
      connectionId: "conn-s1",
      workspaceId: "ws-alpha",
      sessionId: "session-123",
      supportsListChanged: true,
    });
    const connSessionB = createMockConnection({
      connectionId: "conn-s2",
      workspaceId: "ws-alpha",
      sessionId: "session-456",
      supportsListChanged: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connSessionA.connection, connSessionB.connection],
      getConnection: (id) =>
        id === "conn-s1"
          ? connSessionA.connection
          : id === "conn-s2"
            ? connSessionB.connection
            : undefined,
      sendNotificationToConnection: vi.fn((id, notif) => {
        if (id === "conn-s1") connSessionA.connection.sendMessage(notif);
        if (id === "conn-s2") connSessionB.connection.sendMessage(notif);
      }),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-alpha", 2, {
      sessionId: "session-123",
      changedToolIds: ["tool_session"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.connectionId).toBe("conn-s1");
    expect(connSessionA.notificationsReceived.length).toBe(1);
    expect(connSessionB.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });

  it("targets all workspaces on global wildcard scope '*'", async () => {
    const conn1 = createMockConnection({
      connectionId: "c1",
      workspaceId: "ws-1",
      supportsListChanged: true,
    });
    const conn2 = createMockConnection({
      connectionId: "c2",
      workspaceId: "ws-2",
      supportsListChanged: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn1.connection, conn2.connection],
      getConnection: (id) => (id === "c1" ? conn1.connection : conn2.connection),
      sendNotificationToConnection: vi.fn((id, notif) => {
        if (id === "c1") conn1.connection.sendMessage(notif);
        if (id === "c2") conn2.connection.sendMessage(notif);
      }),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("*", 5, {
      changedToolIds: ["global_tool"],
    });

    expect(attempts.length).toBe(2);
    expect(conn1.notificationsReceived.length).toBe(1);
    expect(conn2.notificationsReceived.length).toBe(1);

    coordinator.destroy();
  });

  it("skips closed connections", async () => {
    const connOpen = createMockConnection({
      connectionId: "c-open",
      workspaceId: "ws-1",
      supportsListChanged: true,
    });
    const connClosed = createMockConnection({
      connectionId: "c-closed",
      workspaceId: "ws-1",
      supportsListChanged: true,
    });
    connClosed.connection.close();

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connOpen.connection, connClosed.connection],
      getConnection: (id) => (id === "c-open" ? connOpen.connection : connClosed.connection),
      sendNotificationToConnection: vi.fn((id, notif) => {
        if (id === "c-open") connOpen.connection.sendMessage(notif);
        if (id === "c-closed") connClosed.connection.sendMessage(notif);
      }),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-1", 1);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.connectionId).toBe("c-open");

    coordinator.destroy();
  });

  it("coalesces multiple rapid catalog mutations into a single debounced refresh", async () => {
    const conn = createMockConnection({
      connectionId: "conn-deb",
      workspaceId: "ws-deb",
      supportsListChanged: true,
    });

    const attemptsReceived: unknown[] = [];
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 50,
      gateway: mockGateway,
    });

    coordinator.onRefreshAttempt((att) => {
      attemptsReceived.push(att);
    });

    // Fire 3 events in rapid succession
    coordinator.enqueueCatalogChangeEvent({
      workspaceId: "ws-deb",
      revision: 1,
      changedToolIds: ["tool_1"],
      snapshot: {
        snapshotId: "snap-1",
        workspaceId: "ws-deb",
        timestamp: new Date().toISOString(),
        tools: {},
        digest: "dig-1",
      },
      timestamp: new Date().toISOString(),
    });

    coordinator.enqueueCatalogChangeEvent({
      workspaceId: "ws-deb",
      revision: 2,
      changedToolIds: ["tool_2"],
      snapshot: {
        snapshotId: "snap-2",
        workspaceId: "ws-deb",
        timestamp: new Date().toISOString(),
        tools: {},
        digest: "dig-2",
      },
      timestamp: new Date().toISOString(),
    });

    coordinator.enqueueCatalogChangeEvent({
      workspaceId: "ws-deb",
      revision: 3,
      changedToolIds: ["tool_3"],
      snapshot: {
        snapshotId: "snap-3",
        workspaceId: "ws-deb",
        timestamp: new Date().toISOString(),
        tools: {},
        digest: "dig-3",
      },
      timestamp: new Date().toISOString(),
    });

    // Before timer advances
    expect(attemptsReceived.length).toBe(0);
    expect(conn.notificationsReceived.length).toBe(0);

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(60);

    // Should have debounced into exactly 1 dispatch
    expect(attemptsReceived.length).toBe(1);
    expect(conn.notificationsReceived.length).toBe(1);

    const attempt = coordinator.getAttempts({ workspaceId: "ws-deb" })[0];
    expect(attempt?.revision).toBe(3);

    coordinator.destroy();
  });
});
