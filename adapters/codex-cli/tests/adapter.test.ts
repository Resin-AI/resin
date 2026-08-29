import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { CodexCliAdapter, CodexHarnessAdapter } from "../src/adapter.js";

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
    expect(activeSession).toBeDefined();
    expect(["sess_01", "sess_02"]).toContain(activeSession?.sessionId);

    // Create event source from session
    const source = await adapter.createEventSource(activeSession!);
    expect(source).toBeDefined();
    const records = await source.readNext();
    expect(records.length).toBeGreaterThanOrEqual(1);

    await source.close();
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
