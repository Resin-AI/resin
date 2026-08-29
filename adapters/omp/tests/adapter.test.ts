import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StrictHarnessAdapter } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
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

      const adapter = new OmpHarnessAdapter();

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
});
