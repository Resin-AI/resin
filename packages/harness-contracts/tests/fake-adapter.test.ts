import { describe, expect, it } from "vitest";
import type { StrictHarnessAdapter } from "../src/adapter.js";
import {
  AmbiguousActiveSessionError,
  CatalogRefreshError,
  HarnessPermissionError,
  MissingHarnessError,
} from "../src/errors.js";
import type { HarnessSession, HarnessWorkspace } from "../src/types.js";
import { FakeHarnessAdapter } from "./fake.js";

describe("FakeHarnessAdapter", () => {
  it("satisfies StrictHarnessAdapter contract", () => {
    const adapter: StrictHarnessAdapter = new FakeHarnessAdapter({
      id: "fake-test",
      version: "0.1.0",
      supportedHarnessVersions: ["1.0.0", "2.0.0"],
    });

    expect(adapter.id).toBe("fake-test");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.supportedHarnessVersions).toEqual(["1.0.0", "2.0.0"]);
  });

  it("probes installation successfully and supports error simulations", async () => {
    const adapter = new FakeHarnessAdapter({ id: "omp" });

    // Normal probe
    const install = await adapter.probeInstallation();
    expect(install).not.toBeNull();
    expect(install?.status).toBe("ready");
    expect(install?.harnessId).toBe("omp");

    // Simulated missing harness
    adapter.simulatedErrors.missingHarness = true;
    expect(await adapter.probeInstallation()).toBeNull();

    // Simulated permission error
    adapter.simulatedErrors.missingHarness = false;
    adapter.simulatedErrors.permissionError = true;
    await expect(adapter.probeInstallation()).rejects.toThrow(HarnessPermissionError);

    // Simulated unsupported version
    adapter.simulatedErrors.permissionError = false;
    adapter.simulatedErrors.unsupportedVersion = true;
    const unsupp = await adapter.probeInstallation();
    expect(unsupp?.status).toBe("unsupported_version");
  });

  it("discovers workspaces and enumerates sessions", async () => {
    const adapter = new FakeHarnessAdapter();

    const workspace1: HarnessWorkspace = {
      workspaceId: "ws-1",
      name: "frontend",
      rootPath: "/repo/frontend",
      harnessId: "fake",
      configPath: "/repo/frontend/.fake/config.json",
      metadata: {},
    };

    const workspace2: HarnessWorkspace = {
      workspaceId: "ws-2",
      name: "backend",
      rootPath: "/repo/backend",
      harnessId: "fake",
      configPath: "/repo/backend/.fake/config.json",
      metadata: {},
    };

    adapter.addWorkspace(workspace1);
    adapter.addWorkspace(workspace2);

    const workspaces = await adapter.listWorkspaces();
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((w) => w.workspaceId)).toEqual(["ws-1", "ws-2"]);

    // If harness is missing, listWorkspaces should throw
    adapter.simulatedErrors.missingHarness = true;
    await expect(adapter.listWorkspaces()).rejects.toThrow(MissingHarnessError);
    adapter.simulatedErrors.missingHarness = false;

    // Sessions enumeration
    const session1: HarnessSession = {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath: "/repo/frontend/.fake/sess-1.json",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    const session2: HarnessSession = {
      sessionId: "sess-2",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath: "/repo/frontend/.fake/sess-2.json",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    adapter.addSession(session1);
    adapter.addSession(session2);

    const ws1Sessions = await adapter.listSessions(workspace1);
    expect(ws1Sessions).toHaveLength(2);

    const ws2Sessions = await adapter.listSessions(workspace2);
    expect(ws2Sessions).toHaveLength(0);
  });

  it("resolves active session and handles ambiguous session conflicts", async () => {
    const adapter = new FakeHarnessAdapter();
    const ws: HarnessWorkspace = {
      workspaceId: "ws-main",
      name: "main-workspace",
      rootPath: "/workspaces/main",
      harnessId: "fake",
      configPath: "/workspaces/main/config.json",
      metadata: {},
    };

    const activeSession: HarnessSession = {
      sessionId: "sess-active",
      workspaceId: "ws-main",
      harnessId: "fake",
      transcriptPath: "/workspaces/main/sess-active.log",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    adapter.addWorkspace(ws);
    adapter.addSession(activeSession);

    // No active session configured yet
    expect(await adapter.resolveActiveSession(ws)).toBeNull();

    // Set active session
    adapter.setActiveSession("ws-main", "sess-active");
    const resolved = await adapter.resolveActiveSession(ws);
    expect(resolved?.sessionId).toBe("sess-active");

    // Ambiguous active session simulation
    adapter.simulatedErrors.ambiguousSession = true;
    await expect(adapter.resolveActiveSession(ws)).rejects.toThrow(AmbiguousActiveSessionError);
  });

  it("plans, applies, and verifies MCP config mutations", async () => {
    const adapter = new FakeHarnessAdapter();
    const ws: HarnessWorkspace = {
      workspaceId: "ws-app",
      name: "app",
      rootPath: "/app",
      harnessId: "fake",
      configPath: "/app/config.json",
      metadata: {},
    };

    // Initially not verified
    expect(await adapter.verifyMcpConfig(ws)).toBe(false);

    // Plan mutation
    const plan = await adapter.planMcpConfig(ws, "http://127.0.0.1:4000/sse");
    expect(plan.targetPath).toBe("/app/config.json");
    expect(plan.plannedContent).toContain("resin");
    expect(plan.plannedContent).toContain("http://127.0.0.1:4000/sse");

    // Apply mutation
    const backup = await adapter.applyMcpConfig(plan);
    expect(backup.targetPath).toBe("/app/config.json");
    expect(backup.originalContent).toBe("");

    // Verify config is now valid
    expect(await adapter.verifyMcpConfig(ws)).toBe(true);
  });

  it("notifies catalog refresh and reports outcomes", async () => {
    const adapter = new FakeHarnessAdapter({ refreshOutcome: "native_list_change" });
    const ws: HarnessWorkspace = {
      workspaceId: "ws-1",
      name: "test",
      rootPath: "/test",
      harnessId: "fake",
      configPath: "/test/config.json",
      metadata: {},
    };

    const changeSummary = {
      addedToolIds: ["git-blame", "file-search"],
      updatedToolIds: ["code-exec"],
      removedToolIds: [],
      catalogVersion: "2.1.0",
      timestamp: new Date().toISOString(),
    };

    const result = await adapter.notifyCatalogRefresh(ws, changeSummary);
    expect(result.outcome).toBe("native_list_change");
    expect(result.affectedToolCount).toBe(3);
    expect(result.catalogVersion).toBe("2.1.0");

    // Simulated refresh error
    adapter.simulatedErrors.refreshError = true;
    await expect(adapter.notifyCatalogRefresh(ws, changeSummary)).rejects.toThrow(
      CatalogRefreshError,
    );
  });

  it("opens event source for session streaming", async () => {
    const adapter = new FakeHarnessAdapter();
    const session: HarnessSession = {
      sessionId: "sess-stream-1",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath: "/transcripts/1.jsonl",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    const source = await adapter.openEventSource(session);
    expect(source).toBeDefined();

    // Opening again returns the same event source
    const sourceAgain = await adapter.openEventSource(session);
    expect(sourceAgain).toBe(source);
  });
});
