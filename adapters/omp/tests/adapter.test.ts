import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StrictHarnessAdapter } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import * as discoveryModule from "../src/discovery.js";
import { OmpAdapter, OmpHarnessAdapter } from "../src/index.js";

describe("OmpHarnessAdapter (End-to-End Contract & Lifecycle)", () => {
  it("satisfies StrictHarnessAdapter interface contract and metadata", () => {
    const adapter: StrictHarnessAdapter = new OmpHarnessAdapter();
    expect(adapter.id).toBe("omp");
    expect(adapter.name).toBe("omp");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.supportedHarnessVersions).toContain("^0.1.0");

    expect(OmpAdapter).toBe(OmpHarnessAdapter);
  });

  it("reports Tier 1 High Fidelity observation capabilities", () => {
    const adapter = new OmpHarnessAdapter();
    const capabilities = adapter.getCapabilities();

    expect(capabilities.fidelity.overallScore).toBe(100);
    expect(capabilities.fidelity.transcriptAvailability).toBe("stream");
    expect(capabilities.fidelity.subagentVisibility).toBe("full");
    expect(capabilities.fidelity.toolCallVisibility).toBe("full");
    expect(capabilities.fidelity.toolResultVisibility).toBe("full");

    expect(capabilities.refresh.supportsNativeListChange).toBe(true);
    expect(capabilities.refresh.requiresSessionRestart).toBe(false);
    expect(capabilities.supportsMultiWorkspace).toBe(true);
    expect(capabilities.supportsConcurrentSessions).toBe(true);
    expect(capabilities.features.streaming).toBe(true);
    expect(capabilities.features.subagents).toBe(true);
    expect(capabilities.features.compaction).toBe(true);
    expect(capabilities.features.branching).toBe(true);
  });

  it("executes full workflow: probe -> workspace -> session -> stream -> config -> refresh", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-e2e-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "my-repo");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");

      await fsp.mkdir(path.join(ompHome, "bin"), { recursive: true });
      await fsp.mkdir(sessionsDir, { recursive: true });

      const mockBin = path.join(ompHome, "bin", "omp");
      await fsp.writeFile(mockBin, "#!/bin/sh\necho omp 1.0.0\n", { mode: 0o755 });

      const transcriptPath = path.join(sessionsDir, "session-e2e.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session_lifecycle", lifecycleType: "start", timestamp: "2026-08-17T10:00:00.000Z" })}\n` +
          `${JSON.stringify({ type: "message", role: "user", content: "hello e2e" })}\n`,
      );

      const adapter = new OmpHarnessAdapter({
        customHome: ompHome,
        customExecutablePath: mockBin,
        searchPaths: [wsPath],
      });

      // 1. Probe
      const probe = await adapter.probeInstallation({
        customHome: ompHome,
        customExecutablePath: mockBin,
      });
      expect(probe?.status).toBe("ready");

      // 2. Discover Workspaces
      const workspaces = await adapter.discoverWorkspaces();
      expect(workspaces).toBeDefined();

      const workspace = {
        workspaceId: "ws-my-repo",
        rootPath: wsPath,
        name: "my-repo",
        harnessId: "omp",
        configPath: path.join(wsPath, ".omp", "agent", "mcp.json"),
        metadata: {},
      };

      // 3. Discover Sessions
      const sessions = await adapter.discoverSessions(workspace);
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("e2e");

      // 4. Create Event Source & Read
      const source = await adapter.createEventSource(sessions[0]);
      const records = await source.readBatch();
      expect(records.length).toBe(2);
      await source.close();

      // 5. Plan & Apply MCP Config
      const gatewayUrl = "http://127.0.0.1:4000/mcp/sse";
      const plan = await adapter.planMcpConfig(workspace, gatewayUrl);
      expect(plan.harnessId).toBe("omp");
      const parsedPlan = JSON.parse(plan.plannedContent) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; url?: string; type?: string }
        >;
      };
      expect(parsedPlan.mcpServers?.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsedPlan.mcpServers?.resin?.url).toBeUndefined();
      expect(parsedPlan.mcpServers?.resin?.type).toBeUndefined();
      const backup = await adapter.applyMcpConfig(plan);
      expect(backup.targetPath).toContain("mcp.json");

      // 6. Verify MCP Config
      const verified = await adapter.verifyMcpConfig(workspace);
      expect(verified).toBe(true);

      // 7. Rollback MCP Config
      await adapter.rollbackMcpConfig(backup);
      const verifiedAfterRollback = await adapter.verifyMcpConfig(workspace);
      expect(verifiedAfterRollback).toBe(false);

      // 8. Notify Catalog Refresh
      const refreshResult = await adapter.notifyCatalogRefresh(workspace, {
        addedToolIds: ["new-tool-1"],
        updatedToolIds: [],
        removedToolIds: [],
        catalogVersion: "1.0.1",
        timestamp: new Date().toISOString(),
      });
      expect(refreshResult.outcome).toBe("native_list_change");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("refreshes the discovery catalog on each workspace poll", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-rediscovery-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "repo");
      const sessionsDir = path.join(wsPath, ".omp", "sessions");
      await fsp.mkdir(ompHome, { recursive: true });
      await fsp.mkdir(sessionsDir, { recursive: true });

      const writeSession = async (sessionId: string) => {
        await fsp.writeFile(
          path.join(sessionsDir, `session-${sessionId}.jsonl`),
          `${JSON.stringify({
            type: "session_lifecycle",
            lifecycleType: "start",
            timestamp: new Date().toISOString(),
          })}\n`,
        );
      };

      await writeSession("first");
      const adapter = new OmpHarnessAdapter({
        customHome: ompHome,
        searchPaths: [wsPath],
      });
      const initialWorkspace = (await adapter.listWorkspaces()).find(
        (workspace) => workspace.rootPath === wsPath,
      );
      expect(initialWorkspace).toBeDefined();
      expect(
        (await adapter.listSessions(initialWorkspace!)).map((session) => session.sessionId),
      ).toEqual(["first"]);

      await writeSession("second");
      const refreshedWorkspace = (await adapter.listWorkspaces()).find(
        (workspace) => workspace.rootPath === wsPath,
      );
      expect(refreshedWorkspace).toBeDefined();
      expect(
        (await adapter.listSessions(refreshedWorkspace!))
          .map((session) => session.sessionId)
          .sort(),
      ).toEqual(["first", "second"]);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("plans canonical stdio and migrates legacy SSE entry using gatewayUrl as migration context", async () => {
    const adapter = new OmpHarnessAdapter();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-migration-"));
    try {
      const wsPath = path.join(tmpDir, "repo");
      const configDir = path.join(wsPath, ".omp", "agent");
      const configPath = path.join(configDir, "mcp.json");
      await fsp.mkdir(configDir, { recursive: true });

      const initialConfig = {
        mcpServers: {
          "resin-gateway": {
            type: "sse",
            url: "http://127.0.0.1:4000/mcp/sse",
          },
          "custom-tool": {
            command: "custom-binary",
            args: ["--flag"],
          },
        },
      };
      await fsp.writeFile(configPath, JSON.stringify(initialConfig, null, 2));

      const workspace = {
        workspaceId: "ws-migration",
        rootPath: wsPath,
        name: "repo",
        harnessId: "omp",
        configPath,
        metadata: {},
      };

      const plan = await adapter.planMcpConfig(workspace, "http://127.0.0.1:4000/mcp/sse");
      expect(plan.harnessId).toBe("omp");

      const parsedPlan = JSON.parse(plan.plannedContent) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; url?: string; type?: string }
        >;
      };
      expect(parsedPlan.mcpServers?.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsedPlan.mcpServers?.resin?.url).toBeUndefined();
      expect(parsedPlan.mcpServers?.resin?.type).toBeUndefined();
      expect(parsedPlan.mcpServers?.["resin-gateway"]).toBeUndefined();
      expect(parsedPlan.mcpServers?.["custom-tool"]).toEqual({
        command: "custom-binary",
        args: ["--flag"],
      });

      const backup = await adapter.applyMcpConfig(plan);
      expect(backup.targetPath).toBe(configPath);

      const verified = await adapter.verifyMcpConfig(workspace);
      expect(verified).toBe(true);

      const appliedContent = await fsp.readFile(configPath, "utf8");
      const parsedApplied = JSON.parse(appliedContent) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; url?: string; type?: string }
        >;
      };
      expect(parsedApplied.mcpServers?.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsedApplied.mcpServers?.["resin-gateway"]).toBeUndefined();
      expect(parsedApplied.mcpServers?.["custom-tool"]).toEqual({
        command: "custom-binary",
        args: ["--flag"],
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("scans OMP home once per refresh cycle and reuses discovery catalog for listSessions", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-catalog-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "adapter-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-adapter-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "session.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "adapter-sess-1",
            cwd: wsPath,
            timestamp: new Date().toISOString(),
          }),
        ].join("\n")}\n`,
      );

      const adapter = new OmpHarnessAdapter({ customHome: ompHome });
      const buildCatalogSpy = vi.spyOn(discoveryModule, "buildOmpDiscoveryCatalog");

      // 1. First call: listWorkspaces scans OMP home and caches catalog
      const workspaces = await adapter.listWorkspaces();
      expect(workspaces.length).toBeGreaterThanOrEqual(1);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);

      const workspace = workspaces.find((w) => w.rootPath === wsPath)!;

      // 2. Second call: listSessions reuses cached catalog without re-scanning
      const sessions1 = await adapter.listSessions(workspace);
      expect(sessions1.length).toBe(1);
      expect(sessions1[0].sessionId).toBe("adapter-sess-1");
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);

      // 3. Third call: another listSessions still reuses cached catalog
      const sessions2 = await adapter.listSessions(workspace);
      expect(sessions2.length).toBe(1);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);
      // 4. Catalog refresh notification invalidates cache
      await adapter.notifyCatalogRefresh(workspace, {
        addedToolIds: [],
        updatedToolIds: [],
        removedToolIds: [],
        catalogVersion: "1.0.1",
        timestamp: new Date().toISOString(),
      });

      // 5. Next listWorkspaces triggers a new scan
      const workspacesAfterRefresh = await adapter.listWorkspaces();
      expect(workspacesAfterRefresh.length).toBeGreaterThanOrEqual(1);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(2);

      buildCatalogSpy.mockRestore();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves active sessions with 60s mtime grace and explicit lifecycle override", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-active-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "active-app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-active-app");
      await fsp.mkdir(sessionsDir, { recursive: true });

      // Active session (written now)
      const activeTranscript = path.join(sessionsDir, "recent.jsonl");
      await fsp.writeFile(
        activeTranscript,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sess-active",
            cwd: wsPath,
            timestamp: new Date().toISOString(),
          }),
        ].join("\n")}\n`,
      );

      // Stale session (>60s old)
      const staleTranscript = path.join(sessionsDir, "stale.jsonl");
      const staleTime = new Date(Date.now() - 300_000); // 5 mins ago
      await fsp.writeFile(
        staleTranscript,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "sess-stale",
            cwd: wsPath,
            timestamp: staleTime.toISOString(),
          }),
        ].join("\n")}\n`,
      );
      await fsp.utimes(staleTranscript, staleTime, staleTime);

      const adapter = new OmpHarnessAdapter({ customHome: ompHome });
      const workspace = {
        workspaceId: "ws-active-app",
        rootPath: wsPath,
        name: "active-app",
        harnessId: "omp",
      };

      const activeSession = await adapter.resolveActiveSession(workspace);
      expect(activeSession).not.toBeNull();
      expect(activeSession?.sessionId).toBe("sess-active");
      expect(activeSession?.status).toBe("active");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not build a second catalog or launch extra scans when listSessions is called for an empty workspace", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-empty-ws-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsActivePath = path.join(tmpDir, "active-project");
      const wsEmptyPath = path.join(tmpDir, "empty-project");
      await fsp.mkdir(wsActivePath, { recursive: true });
      await fsp.mkdir(wsEmptyPath, { recursive: true });

      const sessionsDir = path.join(ompHome, "agent", "sessions", "-active-project");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const transcriptPath = path.join(sessionsDir, "session.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "session",
            version: 3,
            id: "active-session-1",
            cwd: wsActivePath,
            timestamp: new Date().toISOString(),
          }),
        ].join("\n")}\n`,
      );

      const adapter = new OmpHarnessAdapter({
        customHome: ompHome,
        searchPaths: [wsActivePath, wsEmptyPath],
      });
      const buildCatalogSpy = vi.spyOn(discoveryModule, "buildOmpDiscoveryCatalog");

      const workspaces = await adapter.listWorkspaces();
      expect(workspaces.length).toBeGreaterThanOrEqual(2);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);
      const emptyWs: HarnessWorkspace = {
        workspaceId: "empty-project",
        rootPath: wsEmptyPath,
        name: "empty-project",
        harnessId: "omp",
      };
      const activeWs = workspaces.find((w) => w.rootPath === wsActivePath)!;

      // Calling listSessions on empty workspace must return [] and NOT call buildOmpDiscoveryCatalog again
      const emptySessions = await adapter.listSessions(emptyWs);
      expect(emptySessions).toEqual([]);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);

      // Calling listSessions on active workspace must return the session and NOT call buildOmpDiscoveryCatalog again
      const activeSessions = await adapter.listSessions(activeWs);
      expect(activeSessions.length).toBe(1);
      expect(activeSessions[0].sessionId).toBe("active-session-1");
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);

      // Subsequent call on empty workspace still reuses catalog
      const emptySessionsAgain = await adapter.listSessions(emptyWs);
      expect(emptySessionsAgain).toEqual([]);
      expect(buildCatalogSpy).toHaveBeenCalledTimes(1);

      buildCatalogSpy.mockRestore();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips opening stale candidate files in default active-only adapter mode against large historical transcripts", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-active-only-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "active-only-project");
      await fsp.mkdir(wsPath, { recursive: true });

      const sessionsDir = path.join(ompHome, "agent", "sessions", "-active-only-project");
      await fsp.mkdir(sessionsDir, { recursive: true });

      // Create 2,006 stale ISO-timestamped session files
      const baseStaleTime = Date.now() - 300_000;
      const filePromises: Promise<void>[] = [];
      for (let i = 0; i < 2006; i++) {
        const fileTime = new Date(baseStaleTime - i * 1000);
        const timeSlug = fileTime.toISOString().replace(/:/g, "-");
        const staleFile = path.join(sessionsDir, `${timeSlug}.jsonl`);
        filePromises.push(
          (async () => {
            await fsp.writeFile(
              staleFile,
              `${JSON.stringify({
                type: "session",
                version: 3,
                id: `stale-sess-${i}`,
                cwd: wsPath,
                timestamp: fileTime.toISOString(),
              })}\n`,
            );
            await fsp.utimes(staleFile, fileTime, fileTime);
          })(),
        );
      }
      await Promise.all(filePromises);
      const activeTime = new Date();
      const activeSlug = activeTime.toISOString().replace(/:/g, "-");
      const activeFile = path.join(sessionsDir, `${activeSlug}.jsonl`);
      await fsp.writeFile(
        activeFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "active-sess-main",
          cwd: wsPath,
          timestamp: activeTime.toISOString(),
        })}\n`,
      );

      const adapter = new OmpHarnessAdapter({ customHome: ompHome });
      const workspaces = await adapter.listWorkspaces();
      const ws = workspaces.find((w) => w.rootPath === wsPath)!;
      const sessions = await adapter.listSessions(ws);

      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe("active-sess-main");

      const openedFiles = adapter.inspectedFilePaths;
      expect(openedFiles).toContain(activeFile);
      expect(openedFiles.length).toBe(1);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovers nested sessions and handles directory cycles safely via OmpHarnessAdapter", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adapter-nested-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "nested-adapter-project");
      await fsp.mkdir(wsPath, { recursive: true });

      const sessionsDir = path.join(ompHome, "agent", "sessions", "-nested-adapter-project");
      const subDirA = path.join(sessionsDir, "groupA");
      const subDirB = path.join(sessionsDir, "groupB");
      await fsp.mkdir(subDirA, { recursive: true });
      await fsp.mkdir(subDirB, { recursive: true });

      const activeTime = new Date();
      const sessA = path.join(subDirA, "sessA.jsonl");
      const sessB = path.join(subDirB, "sessB.jsonl");

      await fsp.writeFile(
        sessA,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "active-nested-a",
          cwd: wsPath,
          timestamp: activeTime.toISOString(),
        })}\n`,
      );
      await fsp.writeFile(
        sessB,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "active-nested-b",
          cwd: wsPath,
          timestamp: activeTime.toISOString(),
        })}\n`,
      );

      // Symlink cycle between subDirA and subDirB
      await fsp.symlink(subDirA, path.join(subDirB, "loopToA"));
      // Symlink alias to sessA
      await fsp.symlink(sessA, path.join(subDirB, "aliasA.jsonl"));

      const adapter = new OmpHarnessAdapter({ customHome: ompHome });
      const workspaces = await adapter.listWorkspaces();
      const ws = workspaces.find((w) => w.rootPath === wsPath)!;
      expect(ws).toBeDefined();

      const sessions = await adapter.listSessions(ws);
      const sessionIds = sessions.map((s) => s.sessionId).sort();
      expect(sessionIds).toEqual(["active-nested-a", "active-nested-b"]);
      expect(sessions.length).toBe(2);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
