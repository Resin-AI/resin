import { describe, expect, it, vi } from "vitest";
import { CatalogRefreshCoordinator, type McpGatewayLike } from "../../src/refresh/index.js";
import { FakeRefreshAdapter, createMockConnection, createRefreshMatrix } from "./fake-matrix.js";

describe("CatalogRefreshCoordinator - Adapter-Specific Nudge Dispatch", () => {
  it("delivers context notice nudge for Claude Code harness", async () => {
    const connClaude = createMockConnection({
      connectionId: "conn-claude",
      harnessId: "claude-code",
      workspaceId: "ws-claude",
      supportsListChanged: false, // Claude Code does not support native MCP list_changed
    });

    const matrix = createRefreshMatrix();
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connClaude.connection],
      getConnection: () => connClaude.connection,
      sendNotificationToConnection: vi.fn(),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        "claude-code": matrix.claudeCode,
      },
    });

    const attempts = await coordinator.triggerRefresh("ws-claude", 1, {
      changedToolIds: ["fast_ast_grep"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.primaryOutcome).toBe("nudge_delivered");
    expect(attempts[0]?.adapterNudgeSent).toBe(true);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);
    expect(attempts[0]?.nudgePayload?.addedToolIds).toContain("fast_ast_grep");
    expect(matrix.claudeCode.refreshCalls.length).toBe(1);

    coordinator.destroy();
  });

  it("records next_session_required for Codex CLI harness without dispatching nudges", async () => {
    const connCodex = createMockConnection({
      connectionId: "conn-codex",
      harnessId: "codex-cli",
      workspaceId: "ws-codex",
      supportsListChanged: false,
    });

    const matrix = createRefreshMatrix();
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connCodex.connection],
      getConnection: () => connCodex.connection,
      sendNotificationToConnection: vi.fn(),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        "codex-cli": matrix.codexCli,
      },
    });

    const attempts = await coordinator.triggerRefresh("ws-codex", 1, {
      changedToolIds: ["tool_x"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.primaryOutcome).toBe("next_session_required");
    expect(attempts[0]?.adapterNudgeSent).toBe(false);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);

    coordinator.destroy();
  });

  it("delivers both native list_changed and adapter nudge for Oh My Pi harness", async () => {
    const connOmp = createMockConnection({
      connectionId: "conn-omp",
      harnessId: "omp",
      workspaceId: "ws-omp",
      supportsListChanged: true,
    });

    const matrix = createRefreshMatrix();
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connOmp.connection],
      getConnection: () => connOmp.connection,
      sendNotificationToConnection: vi.fn((_, notif) => connOmp.connection.sendMessage(notif)),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        omp: matrix.omp,
      },
    });

    const attempts = await coordinator.triggerRefresh("ws-omp", 1, {
      changedToolIds: ["omp_tool"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.mcpNotificationSent).toBe(true);
    expect(attempts[0]?.adapterNudgeSent).toBe(true);
    expect(attempts[0]?.outcomes).toContain("native_sent");
    expect(attempts[0]?.outcomes).toContain("nudge_delivered");
    expect(connOmp.notificationsReceived.length).toBe(1);
    expect(matrix.omp.refreshCalls.length).toBe(1);

    coordinator.destroy();
  });

  it("handles adapter execution failure gracefully without crashing coordinator", async () => {
    const connFaulty = createMockConnection({
      connectionId: "conn-faulty",
      harnessId: "faulty",
      workspaceId: "ws-faulty",
      supportsListChanged: false,
    });

    const matrix = createRefreshMatrix();
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connFaulty.connection],
      getConnection: () => connFaulty.connection,
      sendNotificationToConnection: vi.fn(),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        faulty: matrix.failing,
      },
    });

    const attempts = await coordinator.triggerRefresh("ws-faulty", 1);
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.primaryOutcome).toBe("failed");
    expect(attempts[0]?.error).toBeDefined();

    const stats = coordinator.getStats();
    expect(stats.totalFailed).toBe(1);

    coordinator.destroy();
  });

  it("reconnection exposes latest catalog without replaying stale notices", async () => {
    const matrix = createRefreshMatrix();

    // 1. Initial connection active during revision 1
    const conn1 = createMockConnection({
      connectionId: "conn-rev1",
      harnessId: "claude-code",
      workspaceId: "ws-recon",
      sessionId: "session-active",
      supportsListChanged: false,
    });

    let activeConns = [conn1.connection];
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => activeConns,
      getConnection: (id) => activeConns.find((c) => c.connectionId === id),
      sendNotificationToConnection: vi.fn(),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        "claude-code": matrix.claudeCode,
      },
    });

    // Revision 1 is dispatched
    await coordinator.triggerRefresh("ws-recon", 1, {
      sessionId: "session-active",
      changedToolIds: ["tool_v1"],
    });

    expect(matrix.claudeCode.refreshCalls.length).toBe(1);

    // 2. Repeat trigger of same revision 1 should be deduplicated
    await coordinator.triggerRefresh("ws-recon", 1, {
      sessionId: "session-active",
      changedToolIds: ["tool_v1"],
    });

    // Still only 1 call
    expect(matrix.claudeCode.refreshCalls.length).toBe(1);

    // 3. Client disconnects and reconnects for a new session
    conn1.connection.close();
    const conn2 = createMockConnection({
      connectionId: "conn-reconnected",
      harnessId: "claude-code",
      workspaceId: "ws-recon",
      sessionId: "session-new",
      supportsListChanged: false,
    });
    activeConns = [conn2.connection];

    // Revision 2 arrives: reconnected session receives fresh notice for revision 2
    await coordinator.triggerRefresh("ws-recon", 2, {
      sessionId: "session-new",
      changedToolIds: ["tool_v2"],
    });

    expect(matrix.claudeCode.refreshCalls.length).toBe(2);
    expect(matrix.claudeCode.refreshCalls[1]?.changeSummary.addedToolIds).toContain("tool_v2");

    coordinator.destroy();
  });
});
