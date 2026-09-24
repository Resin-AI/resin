import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { CodexCliAdapter, CodexHarnessAdapter } from "../src/adapter.js";

function rolloutRecord(
  type: string,
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp = "2026-09-23T12:00:00.000Z",
): string {
  return `${JSON.stringify({ timestamp, ordinal, type, payload })}\n`;
}

describe("CodexHarnessAdapter", () => {
  it("initializes with correct id, name, and version", () => {
    const adapter = new CodexHarnessAdapter();
    expect(adapter.id).toBe("codex-cli");
    expect(adapter.name).toBe("Codex CLI");
    expect(adapter.version).toBe("0.1.0");

    // Check alias
    const aliasAdapter = new CodexCliAdapter();
    expect(aliasAdapter.id).toBe("codex-cli");
  });

  it("reports full adapter capabilities with observation fidelity and refresh", () => {
    const adapter = new CodexHarnessAdapter();
    const caps = adapter.getCapabilities();

    expect(caps.supportsMultiWorkspace).toBe(true);
    expect(caps.supportsConcurrentSessions).toBe(true);
    expect(caps.features.atomicConfig).toBe(true);
    expect(caps.features.fileTailing).toBe(true);
    expect(caps.features.subagents).toBe(true);
    expect(caps.fidelity.transcriptAvailability).toBe("file_tail");
    expect(caps.fidelity.toolCallVisibility).toBe("full");
    expect(caps.fidelity.toolResultVisibility).toBe("full");
    expect(caps.refresh.requiresSessionRestart).toBe(true);
  });

  it("probes installation via discovery module", async () => {
    const adapter = new CodexHarnessAdapter({
      pathLookup: async () => "/usr/local/bin/codex",
      executor: async () => ({ stdout: "codex 0.45.0", stderr: "", exitCode: 0 }),
    });

    const install = await adapter.probeInstallation();
    expect(install.status).toBe("ready");
    expect(install.version).toBe("0.45.0");
  });

  it("discovers workspaces and lists/finds sessions in session root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Create mock session files
    const sess1Path = path.join(sessionsDir, "sess_01.jsonl");
    const sess2Path = path.join(sessionsDir, "sess_02.jsonl");
    await fs.writeFile(sess1Path, '{"type":"user_message","content":"Hi"}\n', "utf8");
    await fs.writeFile(sess2Path, '{"type":"user_message","content":"Hello"}\n', "utf8");

    const adapter = new CodexHarnessAdapter({
      customSessionRoot: sessionsDir,
    });

    const workspaces = await adapter.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    const ws = workspaces[0]!;
    expect(ws.metadata?.sessionRoot).toBe(sessionsDir);

    const sessions = await adapter.listSessions(ws);
    expect(sessions).toHaveLength(2);

    const activeSession = await adapter.getActiveSession(ws);
    expect(["sess_01", "sess_02"]).toContain(activeSession?.sessionId);

    // Create event source from session
    const source = await adapter.openEventSource(activeSession!);
    const records = await source.readNext();
    expect(records.map((record) => record.rawPayload)).toEqual([
      {
        type: "user_message",
        content: activeSession?.sessionId === "sess_01" ? "Hi" : "Hello",
      },
    ]);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("groups sessions by recorded cwd and isolates sessions without a usable cwd", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-project-attribution-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "project-a.jsonl"),
      rolloutRecord(
        "session_meta",
        {
          session_id: "native-session-a",
          id: "native-thread-a",
          root_thread_id: "native-root-a",
          cwd: "/recorded/project-a",
        },
        0,
        "2020-01-02T03:04:05.000Z",
      ) + rolloutRecord("event_msg", { type: "task_complete" }, 1),
    );
    await fs.utimes(path.join(sessionsDir, "project-a.jsonl"), new Date(), new Date());
    await fs.writeFile(
      path.join(sessionsDir, "project-b.jsonl"),
      rolloutRecord(
        "session_meta",
        { session_id: "native-session-b", id: "native-thread-b", cwd: "/recorded/project-b" },
        0,
      ) + rolloutRecord("event_msg", { type: "task_started" }, 1),
    );
    await fs.writeFile(
      path.join(sessionsDir, "unknown.jsonl"),
      rolloutRecord(
        "session_meta",
        {
          session_id: "native-session-unknown",
          id: "native-thread-unknown",
        },
        0,
      ),
    );

    const adapter = new CodexHarnessAdapter({ customSessionRoot: sessionsDir });
    const workspaces = await adapter.listWorkspaces();
    const workspaceA = workspaces.find((workspace) => workspace.rootPath === "/recorded/project-a");
    const workspaceB = workspaces.find((workspace) => workspace.rootPath === "/recorded/project-b");
    const unboundWorkspace = workspaces.find((workspace) => workspace.metadata?.unbound === true);

    expect(workspaceA).toBeDefined();
    expect(workspaceB).toBeDefined();
    expect(unboundWorkspace?.rootPath).toBe("codex-unbound");
    expect(path.isAbsolute(unboundWorkspace!.rootPath)).toBe(false);
    expect(
      workspaces.some((workspace) => workspace.rootPath === path.join(os.homedir(), ".codex")),
    ).toBe(false);

    const sessionsA = await adapter.listSessions(workspaceA!);
    const sessionsB = await adapter.listSessions(workspaceB!);
    const unboundSessions = await adapter.listSessions(unboundWorkspace!);
    expect(sessionsA.map((session) => session.sessionId)).toEqual(["sess_project-a"]);
    expect(sessionsB.map((session) => session.sessionId)).toEqual(["sess_project-b"]);
    expect(unboundSessions.map((session) => session.sessionId)).toEqual(["sess_unknown"]);
    expect(sessionsA[0]?.status).toBe("completed");
    expect(sessionsB[0]?.status).toBe("active");
    expect(await adapter.getActiveSession(workspaceA!)).toBeNull();
    expect((await adapter.getActiveSession(workspaceB!))?.sessionId).toBe("sess_project-b");
    expect(sessionsA[0]?.metadata).toMatchObject({
      cwd: "/recorded/project-a",
      nativeSessionId: "native-session-a",
      threadId: "native-thread-a",
      rootId: "native-root-a",
    });
    expect(sessionsA[0]?.createdAt).toBe("2020-01-02T03:04:05.000Z");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("derives completed, resumed, interrupted, and failed states from native events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-lifecycle-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const projectCwd = "/recorded/lifecycle-project";
    const sessionMeta = rolloutRecord(
      "session_meta",
      {
        session_id: "native-id",
        id: "native-thread",
        cwd: projectCwd,
        base_instructions: "Preserve the project's recorded execution context.\n".repeat(900),
      },
      0,
    );
    const writeSession = (name: string, events: string) =>
      fs.writeFile(path.join(sessionsDir, name), sessionMeta + events);

    await writeSession("completed.jsonl", rolloutRecord("event_msg", { type: "task_complete" }, 1));
    await writeSession(
      "reopened.jsonl",
      rolloutRecord("event_msg", { type: "task_complete" }, 1) +
        rolloutRecord("event_msg", { type: "task_started" }, 2),
    );
    await writeSession(
      "interrupted.jsonl",
      rolloutRecord("event_msg", { type: "task_complete" }, 1) +
        rolloutRecord("event_msg", { type: "turn_aborted" }, 2),
    );
    await writeSession(
      "failed.jsonl",
      rolloutRecord("event_msg", { type: "task_complete", error: "command failed" }, 1),
    );
    const largeEvents =
      Array.from({ length: 40 }, (_, index) =>
        rolloutRecord("response_item", { type: "message", text: "x".repeat(1024) }, index + 1),
      ).join("") + rolloutRecord("event_msg", { type: "task_complete" }, 41);
    await writeSession("bounded.jsonl", largeEvents);

    const adapter = new CodexHarnessAdapter({ customSessionRoot: sessionsDir });
    const workspace = (await adapter.listWorkspaces()).find(
      (candidate) => candidate.rootPath === projectCwd,
    )!;
    const sessions = await adapter.listSessions(workspace);
    const statuses = Object.fromEntries(
      sessions.map((session) => [session.sessionId, session.status]),
    );
    expect(statuses).toEqual({
      sess_completed: "completed",
      sess_reopened: "active",
      sess_interrupted: "interrupted",
      sess_failed: "failed",
      sess_bounded: "completed",
    });
    const boundedSession = sessions.find((session) => session.sessionId === "sess_bounded");
    expect(boundedSession?.metadata.cwd).toBe(projectCwd);
    expect(Number(boundedSession?.metadata.inspectedBytes)).toBeLessThanOrEqual(
      1024 * 1024 + 16 * 1024 + 1,
    );
    expect(Number(boundedSession?.metadata.fileSizeBytes)).toBeGreaterThan(
      Number(boundedSession?.metadata.inspectedBytes),
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps incomplete and invalid headers unbound, then discovers a completed growing header", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-growing-header-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const partialPath = path.join(sessionsDir, "partial-header.jsonl");
    const header = JSON.stringify({
      timestamp: "2026-09-23T12:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: "native-partial", id: "thread-partial", cwd: "/recorded/growing" },
    });
    await fs.writeFile(partialPath, header.slice(0, -1));
    await fs.writeFile(
      path.join(sessionsDir, "invalid-header.jsonl"),
      '{"type":"session_meta","payload":{"cwd":42}}\n',
    );

    const overCapTranscript =
      rolloutRecord(
        "session_meta",
        {
          session_id: "over-cap-session",
          id: "over-cap-thread",
          cwd: "/recorded/over-cap",
          base_instructions: "x".repeat(1024 * 1024 + 20 * 1024),
        },
        0,
      ) + rolloutRecord("event_msg", { type: "task_complete" }, 1);
    await fs.writeFile(path.join(sessionsDir, "over-cap.jsonl"), overCapTranscript);

    const adapter = new CodexHarnessAdapter({ customSessionRoot: sessionsDir });
    const beforeAppend = await adapter.listWorkspaces();
    const unbound = beforeAppend.find((workspace) => workspace.metadata?.unbound === true)!;
    const sessionsBeforeAppend = await adapter.listSessions(unbound);
    expect(sessionsBeforeAppend.map((session) => session.sessionId).sort()).toEqual([
      "sess_invalid-header",
      "sess_over-cap",
      "sess_partial-header",
    ]);
    expect(
      sessionsBeforeAppend.find((session) => session.sessionId === "sess_partial-header")?.status,
    ).toBe("unknown");
    expect(
      sessionsBeforeAppend.find((session) => session.sessionId === "sess_over-cap")?.status,
    ).toBe("unknown");

    await fs.appendFile(partialPath, "}\n");
    const afterAppend = await adapter.listWorkspaces();
    const bound = afterAppend.find((workspace) => workspace.rootPath === "/recorded/growing")!;
    expect((await adapter.listSessions(bound)).map((session) => session.sessionId)).toEqual([
      "sess_partial-header",
    ]);
    expect((await adapter.listSessions(unbound)).map((session) => session.sessionId)).toEqual([
      "sess_invalid-header",
      "sess_over-cap",
    ]);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("recursively discovers dated sessions, ignores non-transcripts and symlinks, and preserves flat files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dated-sessions-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const datedDir = path.join(sessionsDir, "2026", "08", "27");
    await fs.mkdir(datedDir, { recursive: true });

    // Nested dated transcripts
    const nested1 = path.join(datedDir, "rollout.jsonl");
    await fs.writeFile(nested1, '{"type":"session_meta","id":"rollout"}\n', "utf8");

    const nested2 = path.join(sessionsDir, "2026", "08", "26", "yesterday.json");
    await fs.mkdir(path.dirname(nested2), { recursive: true });
    await fs.writeFile(nested2, '{"type":"session_meta","id":"yesterday"}\n', "utf8");

    // Flat legacy transcript
    const flatFile = path.join(sessionsDir, "legacy.jsonl");
    await fs.writeFile(flatFile, '{"type":"session_meta","id":"legacy"}\n', "utf8");

    // Non-transcript files to ignore
    const ignoredTxt = path.join(datedDir, "notes.txt");
    await fs.writeFile(ignoredTxt, "some notes", "utf8");
    const ignoredDir = path.join(datedDir, "subfolder");
    await fs.mkdir(ignoredDir, { recursive: true });

    // Symlink file to ignore
    const symlinkTarget = path.join(tempDir, "external.jsonl");
    await fs.writeFile(symlinkTarget, '{"type":"session_meta","id":"external"}\n', "utf8");
    const symlinkPath = path.join(datedDir, "symlink.jsonl");
    try {
      await fs.symlink(symlinkTarget, symlinkPath);
    } catch {
      // If symlinks not supported, ignore
    }

    const adapter = new CodexHarnessAdapter({
      customSessionRoot: sessionsDir,
    });
    const workspaces = await adapter.listWorkspaces();
    const ws = workspaces[0]!;

    const sessions = await adapter.listSessions(ws);
    const transcriptPaths = sessions.map((s) => s.transcriptPath);

    expect(transcriptPaths).toContain(nested1);
    expect(transcriptPaths).toContain(nested2);
    expect(transcriptPaths).toContain(flatFile);
    expect(transcriptPaths).not.toContain(ignoredTxt);
    expect(transcriptPaths).not.toContain(symlinkPath);

    const rolloutSession = sessions.find((s) => s.transcriptPath === nested1);
    expect(rolloutSession).toBeDefined();
    expect(rolloutSession?.sessionId).toBe("sess_rollout");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("executes config mutation planning, application, and verification", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const adapter = new CodexHarnessAdapter({ fsBridge });

    const workspaces = await adapter.listWorkspaces();
    const ws = workspaces[0]!;

    const plan = await adapter.planMcpConfig(ws, "http://127.0.0.1:4000/sse");
    expect(plan.plannedContent).toContain("[mcp_servers.resin]");

    const backup = await adapter.applyMcpConfig(plan);
    expect(backup.targetPath).toBe(ws.configPath);

    const verified = await adapter.verifyMcpConfig(ws);
    expect(verified).toBe(true);
  });

  it("notifies catalog refresh", async () => {
    const adapter = new CodexHarnessAdapter();
    const workspaces = await adapter.listWorkspaces();
    const ws = workspaces[0]!;

    const result = await adapter.notifyCatalogRefresh(ws, {
      addedToolIds: ["tool_new_01"],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "2.0.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    });

    expect(result.outcome).toBe("next_session_required");
    expect(result.requiresRestart).toBe(true);
  });
});
