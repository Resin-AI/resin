import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
  type StrictHarnessAdapter,
} from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, ClaudeHarnessAdapter } from "../src/adapter.js";
import { detectClaudeWorkspaces } from "../src/discovery.js";

describe("ClaudeHarnessAdapter", () => {
  const mockWorkspace: HarnessWorkspace = {
    workspaceId: "ws-adapter-test",
    name: "adapter-test",
    rootPath: "/workspace/app",
    harnessId: "claude-code",
    configPath: "/workspace/app/.claude.json",
    mcpConfigPath: "/workspace/app/.claude.json",
    activeSessionId: "session-active-1",
    metadata: {},
  };

  it("satisfies StrictHarnessAdapter contract interface", () => {
    const adapter: StrictHarnessAdapter = new ClaudeHarnessAdapter();

    expect(adapter.id).toBe("claude-code");
    expect(adapter.name).toBe("Claude Code");
    expect(adapter.version).toBe("0.1.0");
    expect(adapter.supportedHarnessVersions.length).toBeGreaterThan(0);
  });

  it("reports accurate capabilities and fidelity rating", () => {
    const adapter = new ClaudeHarnessAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.fidelity.transcriptAvailability).toBe("file_tail");
    expect(caps.fidelity.toolCallVisibility).toBe("full");
    expect(caps.fidelity.toolResultVisibility).toBe("full");
    expect(caps.fidelity.subagentVisibility).toBe("shallow");
    expect(caps.fidelity.mcpListChange).toBe("unsupported");
    expect(caps.fidelity.contextNudge).toBe("via_prompt");
    expect(caps.fidelity.overallScore).toBe(78);

    expect(caps.refresh.supportsNativeListChange).toBe(false);
    expect(caps.refresh.supportsContextNudge).toBe(true);
    expect(caps.refresh.requiresSessionRestart).toBe(false);
  });

  it("executes full adapter integration flow", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const mockExec = async () => ({ stdout: "claude 0.2.14\n", stderr: "" });

    const adapter = new ClaudeHarnessAdapter({
      fsBridge,
      execFn: mockExec,
    });

    // 1. Probe installation
    const installation = await adapter.probeInstallation({
      customExecutablePath: "/usr/bin/claude",
      customConfigPath: mockWorkspace.configPath,
    });
    expect(installation).not.toBeNull();
    expect(installation?.isInstalled).toBe(true);
    expect(installation?.version).toBe("0.2.14");

    // 2. Resolve sessions
    const activeSession = await adapter.resolveActiveSession(mockWorkspace);
    expect(activeSession).not.toBeNull();
    expect(activeSession?.sessionId).toBe("session-active-1");

    // 3. Plan & Apply MCP Config
    const plan = await adapter.planMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse");
    expect(plan.harnessId).toBe("claude-code");

    const backup = await adapter.applyMcpConfig(plan);
    expect(backup.targetPath).toBe(mockWorkspace.configPath);

    const verified = await adapter.verifyMcpConfig(mockWorkspace);
    expect(verified).toBe(true);

    // 4. Open Event Source
    expect(activeSession).not.toBeNull();
    if (!activeSession) throw new Error("Expected active session");
    const eventSource = await adapter.openEventSource(activeSession);
    expect(eventSource).toBeDefined();
    expect(eventSource.getCursor()).toBeDefined();
    await eventSource.close();

    // 5. Notify Catalog Refresh
    const refreshResult = await adapter.notifyCatalogRefresh(mockWorkspace, {
      addedToolIds: ["new_tool"],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "1.1.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    });
    expect(refreshResult.outcome).toBe("context_nudge");
    expect(refreshResult.catalogVersion).toBe("1.1.0");
  });

  it("supports backward-compatible alias and mock execution", async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.initialize();

    const res = await adapter.execute(
      { id: "tool-1", name: "test_tool", version: "1.0.0", description: "desc" },
      { key: "value" },
    );

    expect(res).toEqual({
      adapter: "claude-code",
      toolId: "tool-1",
      input: { key: "value" },
      output: "claude-code-response",
    });
  });

  it("discovers an ingestible session with its exact hyphenated workspace and resumes without replay", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const rootPath = "/workspace/team-tools/demo-app";
    const projectDir = path.join(
      os.homedir(),
      ".claude",
      "projects",
      "-workspace-team-tools-demo-app",
    );
    const transcriptPath = path.join(projectDir, "session-live.jsonl");
    const firstRecord = JSON.stringify({
      type: "user",
      sessionId: "session-live",
      cwd: rootPath,
      message: { role: "user", content: "Synthetic request" },
    });
    await fsBridge.writeFile(transcriptPath, `${firstRecord}\n`);
    const adapter = new ClaudeHarnessAdapter({ fsBridge });

    const workspaces = await adapter.detectWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.metadata?.projectDir === projectDir);
    expect(workspace?.rootPath).toBe(rootPath);
    if (!workspace) throw new Error("Expected discovered workspace");
    const sessions = await adapter.listSessions(workspace);
    expect(sessions.map((session) => session.status)).toEqual(["active"]);
    const source = await adapter.openSessionSource(sessions[0]);
    expect((await source.readNext()).map((record) => record.rawPayload)).toEqual([
      JSON.parse(firstRecord),
    ]);
    expect(await source.readNext()).toEqual([]);
    const cursor = source.getCursor();
    if (!cursor) throw new Error("Expected checkpoint");
    await source.close();

    const secondRecord = JSON.stringify({
      type: "assistant",
      sessionId: "session-live",
      cwd: rootPath,
      message: { role: "assistant", content: "Synthetic response" },
    });
    await fsBridge.writeFile(transcriptPath, `${firstRecord}\n${secondRecord}\n`);
    const resumed = await adapter.openSessionSource(sessions[0], cursor);
    expect((await resumed.readNext()).map((record) => record.rawPayload)).toEqual([
      JSON.parse(secondRecord),
    ]);
    expect(await resumed.readNext()).toEqual([]);
    await resumed.close();
  });

  it("makes discovered transcripts ingestible when no active session id is advertised", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const workspace = { ...mockWorkspace, activeSessionId: undefined };
    await fsBridge.writeFile("/workspace/app/.claude/session-new.jsonl", '{"type":"user"}\n');
    const adapter = new ClaudeHarnessAdapter({ fsBridge });

    const sessions = await adapter.listSessions(workspace);

    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([
      ["session-new", "active"],
    ]);
  });

  it("keeps quiet transcripts resumable through active, idle, and active transitions", async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "claude-session-"));
    const now = new Date("2026-08-17T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const projectDir = path.join(rootPath, ".claude");
      await fs.mkdir(path.join(projectDir, "session", "subagents"), { recursive: true });
      const transcriptPath = path.join(projectDir, "session.jsonl");
      await fs.writeFile(transcriptPath, '{"type":"user"}\n');
      await fs.writeFile(
        path.join(projectDir, "session", "subagents", "agent.jsonl"),
        '{"type":"assistant"}\n',
      );
      const workspace = { ...mockWorkspace, rootPath, activeSessionId: undefined };
      const adapter = new ClaudeHarnessAdapter();
      await fs.utimes(transcriptPath, now, now);
      expect((await adapter.resolveActiveSession(workspace))?.status).toBe("active");

      vi.setSystemTime(new Date(now.getTime() + 5 * 60 * 1000));

      expect((await adapter.listSessions(workspace)).map((session) => session.status)).toEqual([
        "idle",
      ]);
      expect(await adapter.resolveActiveSession(workspace)).toBeNull();

      await fs.appendFile(transcriptPath, '{"type":"assistant"}\n');
      const resumedAt = new Date();
      await fs.utimes(transcriptPath, resumedAt, resumedAt);

      expect((await adapter.listSessions(workspace)).map((session) => session.sessionId)).toEqual([
        "session",
      ]);
      expect((await adapter.resolveActiveSession(workspace))?.status).toBe("active");
    } finally {
      vi.useRealTimers();
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it("discovers workspace and session from ~/.claude/projects/-home-user-Projects-demo/session.jsonl", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const homeDir = "/home/testuser";
    const transcriptPath = `${homeDir}/.claude/projects/-home-user-Projects-demo/session.jsonl`;
    await fsBridge.writeFile(
      transcriptPath,
      '{"type":"user","sessionId":"session","cwd":"/home/user/Projects/demo"}\n',
    );
    const workspaces = await detectClaudeWorkspaces(homeDir, fsBridge);
    const demoWs = workspaces.find((w) => w.rootPath === "/home/user/Projects/demo");
    expect(demoWs).toBeDefined();

    const adapter = new ClaudeHarnessAdapter({ fsBridge });
    const sessions = await adapter.listSessions(demoWs!);
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("session");
    expect(sessions[0].transcriptPath).toBe(transcriptPath);
    expect(sessions[0].workspaceId).toBe(demoWs!.workspaceId);
  });
});
