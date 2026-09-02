import { describe, expect, it, vi } from "vitest";
import { CatalogRefreshCoordinator, type McpGatewayLike } from "../../src/refresh/index.js";
import { createMockConnection } from "./fake-matrix.js";

describe("CatalogRefreshCoordinator - MCP List Changed Notifications", () => {
  it("dispatches notifications/tools/list_changed to capability-negotiated connections", async () => {
    const conn = createMockConnection({
      connectionId: "conn-negotiated",
      workspaceId: "ws-test",
      supportsListChanged: true,
      isInitialized: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-test", 1, {
      changedToolIds: ["new_tool"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.mcpNotificationSent).toBe(true);
    expect(attempts[0]?.primaryOutcome).toBe("native_sent");
    expect(attempts[0]?.outcomes).toContain("native_sent");

    expect(conn.notificationsReceived.length).toBe(1);
    expect(conn.notificationsReceived[0]?.jsonrpc).toBe("2.0");
    expect(conn.notificationsReceived[0]?.method).toBe("notifications/tools/list_changed");

    coordinator.destroy();
  });

  it("does not send MCP notification if client did not negotiate tools.listChanged capability", async () => {
    const conn = createMockConnection({
      connectionId: "conn-unnegotiated",
      workspaceId: "ws-test",
      supportsListChanged: false,
      isInitialized: true,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-test", 1, {
      changedToolIds: ["tool_x"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);
    expect(conn.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });

  it("does not send MCP notification if connection is not yet initialized", async () => {
    const conn = createMockConnection({
      connectionId: "conn-uninit",
      workspaceId: "ws-test",
      supportsListChanged: true,
      isInitialized: false,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-test", 1);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);
    expect(conn.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });

  it("does not send MCP notification before the initialized notification", async () => {
    const conn = createMockConnection({
      connectionId: "conn-awaiting-initialized-notification",
      workspaceId: "ws-test",
      supportsListChanged: true,
      isInitialized: true,
      hasReceivedInitializedNotification: false,
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn.connection],
      getConnection: () => conn.connection,
      sendNotificationToConnection: vi.fn((_, notif) => conn.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("ws-test", 1);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);
    expect(conn.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });

  it("dispatches notifications to multiple concurrent negotiated clients in the same workspace", async () => {
    const conn1 = createMockConnection({
      connectionId: "c1",
      workspaceId: "shared-ws",
      supportsListChanged: true,
    });
    const conn2 = createMockConnection({
      connectionId: "c2",
      workspaceId: "shared-ws",
      supportsListChanged: true,
    });
    const conn3 = createMockConnection({
      connectionId: "c3",
      workspaceId: "shared-ws",
      supportsListChanged: false, // does not support
    });

    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [conn1.connection, conn2.connection, conn3.connection],
      getConnection: (id) =>
        id === "c1" ? conn1.connection : id === "c2" ? conn2.connection : conn3.connection,
      sendNotificationToConnection: vi.fn((id, notif) => {
        if (id === "c1") conn1.connection.sendMessage(notif);
        if (id === "c2") conn2.connection.sendMessage(notif);
        if (id === "c3") conn3.connection.sendMessage(notif);
      }),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
    });

    const attempts = await coordinator.triggerRefresh("shared-ws", 10);
    expect(attempts.length).toBe(3);

    expect(conn1.notificationsReceived.length).toBe(1);
    expect(conn2.notificationsReceived.length).toBe(1);
    expect(conn3.notificationsReceived.length).toBe(0);

    coordinator.destroy();
  });
});
