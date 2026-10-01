import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OmpHarnessAdapter } from "@resin/adapter-omp";
import { describe, expect, it, vi } from "vitest";
import { CatalogRefreshCoordinator, type McpGatewayLike } from "../../src/refresh/index.js";
import { FakeRefreshAdapter, createMockConnection, createRefreshMatrix } from "./fake-matrix.js";

describe("CatalogRefreshCoordinator - Adapter-Specific Nudge Dispatch", () => {
  it("delivers a context notice nudge to a nudge-only harness", async () => {
    const connNudge = createMockConnection({
      connectionId: "conn-nudge",
      harnessId: "nudge-only",
      workspaceId: "ws-nudge",
      supportsListChanged: false,
    });

    const matrix = createRefreshMatrix();
    const mockGateway: McpGatewayLike = {
      getAllConnections: () => [connNudge.connection],
      getConnection: () => connNudge.connection,
      sendNotificationToConnection: vi.fn(),
    };

    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: mockGateway,
      adapters: {
        "nudge-only": matrix.nudgeOnly,
      },
    });

    const attempts = await coordinator.triggerRefresh("ws-nudge", 1, {
      changedToolIds: ["fast_ast_grep"],
    });

    expect(attempts.length).toBe(1);
    expect(attempts[0]?.primaryOutcome).toBe("nudge_delivered");
    expect(attempts[0]?.adapterNudgeSent).toBe(true);
    expect(attempts[0]?.mcpNotificationSent).toBe(false);
    expect(attempts[0]?.nudgePayload?.addedToolIds).toContain("fast_ast_grep");
    expect(matrix.nudgeOnly.refreshCalls.length).toBe(1);

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
      harnessId: "nudge-only",
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
        "nudge-only": matrix.nudgeOnly,
      },
    });

    // Revision 1 is dispatched
    await coordinator.triggerRefresh("ws-recon", 1, {
      sessionId: "session-active",
      changedToolIds: ["tool_v1"],
    });

    expect(matrix.nudgeOnly.refreshCalls.length).toBe(1);

    // 2. Repeat trigger of same revision 1 should be deduplicated
    await coordinator.triggerRefresh("ws-recon", 1, {
      sessionId: "session-active",
      changedToolIds: ["tool_v1"],
    });

    // Still only 1 call
    expect(matrix.nudgeOnly.refreshCalls.length).toBe(1);

    // 3. Client disconnects and reconnects for a new session
    conn1.connection.close();
    const conn2 = createMockConnection({
      connectionId: "conn-reconnected",
      harnessId: "nudge-only",
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

    expect(matrix.nudgeOnly.refreshCalls.length).toBe(2);
    expect(matrix.nudgeOnly.refreshCalls[1]?.changeSummary.addedToolIds).toContain("tool_v2");

    coordinator.destroy();
  });
});

describe("OMP learned-tool guidance", () => {
  async function refreshWith(
    ompHome: string,
    learned: Array<{ name: string; description?: string }>,
    revision: number,
    searchListing = false,
  ) {
    const conn = createMockConnection({
      connectionId: "conn-omp-guidance",
      harnessId: "omp",
      workspaceId: "ws-omp-guidance",
      supportsListChanged: true,
      searchListing,
    });
    const coordinator = new CatalogRefreshCoordinator({
      debounceMs: 0,
      gateway: {
        getAllConnections: () => [conn.connection],
        getConnection: () => conn.connection,
        sendNotificationToConnection: vi.fn(),
        listLearnedTools: async () => learned,
      },
      adapters: {
        omp: {
          harnessId: "omp",
          getCapabilities: () => ({
            supportsNativeListChange: true,
            supportsContextNudge: true,
            requiresSessionRestart: false,
            description: "omp",
          }),
          notifyCatalogRefresh: (workspace, summary) =>
            new OmpHarnessAdapter({ customHome: ompHome }).notifyCatalogRefresh(workspace, summary),
        },
      },
    });
    await coordinator.triggerRefresh("ws-omp-guidance", revision, { changedToolIds: ["t"] });
    coordinator.destroy();
    return fs.readFile(path.join(ompHome, "agent", "APPEND_SYSTEM.md"), "utf8").catch(() => "");
  }

  it("writes each learned tool's name, description and xd:// path, then removes the block when none remain", async () => {
    const ompHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guidance-"));
    try {
      await fs.mkdir(path.join(ompHome, "agent"), { recursive: true });
      await fs.writeFile(path.join(ompHome, "agent", "APPEND_SYSTEM.md"), "User notes\n");
      const tools = [
        { name: "release_notes", description: "Drafts release notes.\nSecond line" },
        { name: "sync_fixtures" },
      ];
      const written = await refreshWith(ompHome, tools, 1);
      expect(written.startsWith("User notes\n")).toBe(true);
      expect(written).toContain("### `release_notes`\n\nDrafts release notes.");
      expect(written).not.toContain("Second line");
      expect(written).toContain("### `sync_fixtures`");
      expect(written).toContain("xd://mcp__resin_release_notes");
      expect(written).toContain("xd://mcp__resin_sync_fixtures");
      expect(await refreshWith(ompHome, tools, 2)).toBe(written);

      const cleared = await refreshWith(ompHome, [], 3);
      expect(cleared).toBe("User notes\n");
    } finally {
      await fs.rm(ompHome, { recursive: true, force: true });
    }
  });

  it("removes the per-tool block for a search-listing connection and restores it for a listing one", async () => {
    const ompHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guidance-"));
    try {
      await fs.mkdir(path.join(ompHome, "agent"), { recursive: true });
      await fs.writeFile(path.join(ompHome, "agent", "APPEND_SYSTEM.md"), "User notes\n");
      const tools = [{ name: "release_notes", description: "Drafts release notes." }];
      expect(await refreshWith(ompHome, tools, 1)).toContain("### `release_notes`");

      // The learned tools still exist; a search-listing client finds them with search_tools.
      expect(await refreshWith(ompHome, tools, 2, true)).toBe("User notes\n");

      expect(await refreshWith(ompHome, tools, 3)).toContain("### `release_notes`");
    } finally {
      await fs.rm(ompHome, { recursive: true, force: true });
    }
  });
});
