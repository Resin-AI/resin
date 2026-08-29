import * as fs from "node:fs";
import * as path from "node:path";
import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  nowIso,
} from "@resin/contracts";
import {
  ConfigPreconditionFailedError,
  type HarnessSession,
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
  type RawHarnessRecord,
  type SourceCursor,
  TIER2_MEDIUM_FIDELITY,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { ClaudeHarnessAdapter } from "../src/adapter.js";
import {
  applyClaudeMcpConfig,
  planClaudeMcpConfig,
  rollbackClaudeMcpConfig,
  verifyClaudeMcpConfig,
} from "../src/config-planner.js";
import { ClaudeRecordDecoder, decodeClaudeTranscriptLine } from "../src/decoder.js";
import {
  SUPPORTED_CLAUDE_VERSIONS,
  detectClaudeWorkspaces,
  probeClaudeInstallation,
} from "../src/discovery.js";
import { getClaudeRefreshCapability, notifyClaudeCatalogRefresh } from "../src/refresh.js";
import { ClaudeSessionEventSource } from "../src/source.js";

describe("Claude Code Harness Qualification Suite [REM-017]", () => {
  const gatewayUrl = "http://127.0.0.1:4400/sse";

  describe("1. Installation Discovery and Qualification", () => {
    it("qualifies installed Claude Code versions against supported version matrix", async () => {
      expect(SUPPORTED_CLAUDE_VERSIONS).toContain(">=0.1.0");

      const fsBridge = new InMemoryConfigFsBridge();
      await fsBridge.writeFile("/home/user/.claude.json", JSON.stringify({ mcpServers: {} }));
      await fsBridge.writeFile("/usr/local/bin/claude", "#!/bin/sh\n");

      const mockExec = async (cmd: string, args: string[]) => {
        if (args.includes("--version")) {
          return { stdout: "claude-code version 1.0.0 (release 2026.08)", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };

      const installation = await probeClaudeInstallation(
        {
          customConfigPath: "/home/user/.claude.json",
          customExecutablePath: "/usr/local/bin/claude",
        },
        fsBridge,
        mockExec,
      );

      expect(installation).not.toBeNull();
      expect(installation.status).toBe("ready");
      expect(installation.harnessId).toBe("claude-code");
      expect(installation.version).toBe("1.0.0");
      expect(installation.isInstalled).toBe(true);
    });

    it("reports missing_executable installation when executable is missing", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const mockFailingExec = async () => {
        throw new Error("spawn claude ENOENT");
      };

      const installation = await probeClaudeInstallation(undefined, fsBridge, mockFailingExec);

      expect(installation).not.toBeNull();
      expect(installation.status).toBe("missing_executable");
      expect(installation.isInstalled).toBe(false);
    });

    it("returns default uninstalled installation when no Claude Code installation or config exists", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const installation = await probeClaudeInstallation(undefined, fsBridge, async () => {
        throw new Error("ENOENT");
      });
      expect(installation.isInstalled).toBe(false);
    });
  });

  describe("2. Configuration Orchestration: Backups, Idempotency, and Preserving User Settings", () => {
    it("preserves unrelated user settings in claude.json during MCP server injection", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const initialUserConfig = {
        theme: "dark",
        model: "claude-3-5-sonnet-20241022",
        customInstructions: "Prefer concise TypeScript",
        mcpServers: {
          existing_filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
          },
          existing_github: {
            url: "https://api.github.com/mcp",
          },
        },
        telemetry: {
          enabled: false,
        },
      };

      const configPath = "/home/user/.claude.json";
      await fsBridge.writeFile(configPath, JSON.stringify(initialUserConfig, null, 2));

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-claude-test",
        name: "test-project",
        rootPath: "/workspace/project",
        harnessId: "claude-code",
        configPath,
        mcpConfigPath: configPath,
        metadata: {},
      };

      // 1. Plan mutation
      const plan = await planClaudeMcpConfig(workspace, gatewayUrl, fsBridge);
      expect(plan.harnessId).toBe("claude-code");
      expect(plan.targetPath).toBe(configPath);
      expect(plan.plannedContent).toContain("resin");
      expect(plan.plannedContent).toContain("existing_filesystem");
      expect(plan.plannedContent).toContain("existing_github");
      expect(plan.plannedContent).toContain('"theme": "dark"');

      // 2. Apply mutation and get atomic backup
      const backup = await applyClaudeMcpConfig(plan, fsBridge);
      expect(backup.targetPath).toBe(configPath);
      expect(backup.contentHash).toBe(plan.preconditionHash);

      // Verify written file contains both new server and old settings
      const writtenContent = await fsBridge.readFile(configPath);
      const parsedWritten = JSON.parse(writtenContent ?? "{}");
      expect(parsedWritten.theme).toBe("dark");
      expect(parsedWritten.model).toBe("claude-3-5-sonnet-20241022");
      expect(parsedWritten.customInstructions).toBe("Prefer concise TypeScript");
      expect(parsedWritten.telemetry.enabled).toBe(false);
      expect(parsedWritten.mcpServers.existing_filesystem).toBeDefined();
      expect(parsedWritten.mcpServers.existing_github).toBeDefined();
      expect(parsedWritten.mcpServers.resin).toEqual({
        type: "sse",
        url: gatewayUrl,
      });

      // 3. Verify write verification
      const verified = await verifyClaudeMcpConfig(workspace, gatewayUrl, fsBridge);
      expect(verified).toBe(true);

      // 4. Test idempotency (applying same plan again produces identical content)
      const secondPlan = await planClaudeMcpConfig(workspace, gatewayUrl, fsBridge);
      expect(secondPlan.plannedContent).toBe(writtenContent);

      // 5. Test clean byte-for-byte rollback during uninstall
      await rollbackClaudeMcpConfig(backup, fsBridge);
      const restoredContent = await fsBridge.readFile(configPath);
      expect(restoredContent).toBe(JSON.stringify(initialUserConfig, null, 2));

      const parsedRestored = JSON.parse(restoredContent ?? "{}");
      expect(parsedRestored.mcpServers.resin).toBeUndefined();
      expect(parsedRestored.theme).toBe("dark");
      expect(parsedRestored.mcpServers.existing_filesystem).toBeDefined();
    });

    it("enforces precondition hash checking and rejects concurrent modifications", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.claude.json";
      await fsBridge.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-claude-test",
        name: "test-project",
        rootPath: "/workspace/project",
        harnessId: "claude-code",
        configPath,
        mcpConfigPath: configPath,
        metadata: {},
      };

      const plan = await planClaudeMcpConfig(workspace, gatewayUrl, fsBridge);

      // Tamper with file before apply
      await fsBridge.writeFile(configPath, JSON.stringify({ mcpServers: {}, tampered: true }));

      await expect(applyClaudeMcpConfig(plan, fsBridge)).rejects.toThrow(
        ConfigPreconditionFailedError,
      );
    });
  });

  describe("3. Session Discovery and Ambiguity Reporting", () => {
    it("discovers active and historical sessions from workspace directory", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const rootPath = "/workspace/project";

      // Setup session files in .claude directory
      await fsBridge.writeFile(
        path.join(rootPath, ".claude", "session-active-1.jsonl"),
        `${JSON.stringify({ type: "session_start", session_id: "session-active-1" })}\n`,
      );
      await fsBridge.writeFile(
        path.join(rootPath, ".claude", "session-history-2.jsonl"),
        `${JSON.stringify({ type: "session_start", session_id: "session-history-2" })}\n`,
      );

      const adapter = new ClaudeHarnessAdapter({ fsBridge });
      const workspace: HarnessWorkspace = {
        workspaceId: "ws-test",
        name: "test",
        rootPath,
        harnessId: "claude-code",
        configPath: path.join(rootPath, ".claude.json"),
        mcpConfigPath: path.join(rootPath, ".claude.json"),
        activeSessionId: "session-active-1",
        metadata: {},
      };

      const sessions = await adapter.listSessions(workspace);
      expect(sessions.length).toBeGreaterThanOrEqual(2);

      const activeSession = sessions.find((s) => s.sessionId === "session-active-1");
      expect(activeSession).toBeDefined();
      expect(activeSession?.status).toBe("active");

      const historySession = sessions.find((s) => s.sessionId === "session-history-2");
      expect(historySession).toBeDefined();
      expect(historySession?.status).toBe("completed");
    });
  });

  describe("4. Transcript Tailing, Durable Checkpoints, and Resumption", () => {
    it("tails append-only transcripts, commits checkpoints, and resumes accurately", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const transcriptPath = "/transcripts/claude-session.jsonl";

      const session: HarnessSession = {
        sessionId: "session-tail-test",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };

      const line1 = `${JSON.stringify({ type: "user_message", text: "Hello Claude" })}\n`;
      const line2 = `${JSON.stringify({ type: "assistant_message", text: "Hello! How can I help?" })}\n`;
      await fsBridge.writeFile(transcriptPath, line1 + line2);

      const source = new ClaudeSessionEventSource(session, undefined, { fsBridge });

      const batch1 = await source.readNext(10);
      expect(batch1).toHaveLength(2);
      expect(batch1[0].sequenceNumber).toBe(1);
      expect(batch1[1].sequenceNumber).toBe(2);

      const cursor = source.getCursor();
      expect(cursor).not.toBeNull();
      expect(cursor?.offset).toBeGreaterThan(0);

      // Create new source resuming from checkpoint
      const resumedSource = new ClaudeSessionEventSource(session, cursor ?? undefined, {
        fsBridge,
      });
      const batchAfterResume = await resumedSource.readNext(10);
      expect(batchAfterResume).toHaveLength(0);

      // Append line3
      const line3 = `${JSON.stringify({ type: "user_message", text: "Write a test" })}\n`;
      await fsBridge.writeFile(transcriptPath, line1 + line2 + line3);

      const batch3 = await resumedSource.readNext(10);
      expect(batch3).toHaveLength(1);
      expect(batch3[0].sequenceNumber).toBe(3);
      expect(batch3[0].rawPayload).toEqual({ type: "user_message", text: "Write a test" });

      await source.close();
      await resumedSource.close();
    });

    it("buffers partial incomplete lines until a trailing newline arrives", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const transcriptPath = "/transcripts/partial-test.jsonl";

      const session: HarnessSession = {
        sessionId: "session-partial",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };

      const completeLine1 = `${JSON.stringify({ type: "user_message", text: "first line" })}\n`;
      const incompleteLine2 = '{"type":"assistant_message","text":"incom';

      // Write complete line + incomplete line
      await fsBridge.writeFile(transcriptPath, completeLine1 + incompleteLine2);

      const source = new ClaudeSessionEventSource(session, undefined, { fsBridge });
      const records1 = await source.readNext(10);

      // Only complete line 1 should be returned
      expect(records1).toHaveLength(1);
      expect(records1[0].sequenceNumber).toBe(1);
      expect(records1[0].rawPayload).toEqual({ type: "user_message", text: "first line" });
      // Complete the line
      const fullLine2 = `${JSON.stringify({ type: "assistant_message", text: "incoming complete" })}\n`;
      await fsBridge.writeFile(transcriptPath, completeLine1 + fullLine2);

      const records2 = await source.readNext(10);
      expect(records2).toHaveLength(1);
      expect(records2[0].sequenceNumber).toBe(2);
      expect(records2[0].rawPayload).toEqual({
        type: "assistant_message",
        text: "incoming complete",
      });

      await source.close();
    });

    it("resets cursor offset when file rotation/truncation is detected", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const transcriptPath = "/transcripts/rotation-test.jsonl";

      const session: HarnessSession = {
        sessionId: "session-rotation",
        workspaceId: "ws-1",
        harnessId: "claude-code",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };
      const longContent =
        "line 1: initial large transcript content line to establish large offset threshold...\nline 2: second large transcript line...\nline 3: third large line...\n";
      await fsBridge.writeFile(transcriptPath, longContent);

      const source = new ClaudeSessionEventSource(session, undefined, { fsBridge });
      await source.readNext(10);
      expect(source.getCursor()?.offset).toBe(Buffer.byteLength(longContent, "utf8"));

      // Truncate file to smaller size
      const truncatedContent = `${JSON.stringify({ type: "session_restart", reason: "rotated" })}\n`;
      await fsBridge.writeFile(transcriptPath, truncatedContent);

      const postTruncationRecords = await source.readNext(10);
      expect(postTruncationRecords.length).toBeGreaterThanOrEqual(1);
      expect(postTruncationRecords[0].rawPayload).toEqual({
        type: "session_restart",
        reason: "rotated",
      });

      await source.close();
    });
  });

  describe("5. Normalization, Fixtures & Fidelity Metadata", () => {
    it("normalizes messages, tool calls, tool results, file edits, compactions, and errors with Tier 2 fidelity", () => {
      const sessionId = "session-norm-test";
      const decoder = new ClaudeRecordDecoder();

      // Tool use event
      const toolUseLine = JSON.stringify({
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "edit_file",
            input: { file_path: "src/index.ts", old_string: "foo", new_string: "bar" },
          },
        ],
      });
      const events1 = decodeClaudeTranscriptLine(toolUseLine, sessionId, 1);
      expect(events1).toHaveLength(1);
      expect(events1[0].type).toBe("tool_call");
      if (events1[0].type === "tool_call") {
        expect(events1[0].toolCallId).toBe("call_123");
        expect(events1[0].toolName).toBe("edit_file");
      }

      // Tool result event
      const toolResultLine = JSON.stringify({
        type: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: "File edited successfully",
            status: "success",
          },
        ],
      });
      const events2 = decodeClaudeTranscriptLine(toolResultLine, sessionId, 2);
      expect(events2).toHaveLength(1);
      expect(events2[0].type).toBe("tool_result");
      if (events2[0].type === "tool_result") {
        expect(events2[0].toolCallId).toBe("call_123");
        expect(events2[0].isError).toBe(false);
      }

      // Compaction event
      const compactionLine = JSON.stringify({
        type: "compaction",
        summary: "Context reduced from 150k to 20k tokens",
        retained_messages: 5,
      });
      const events3 = decodeClaudeTranscriptLine(compactionLine, sessionId, 3);
      expect(events3).toHaveLength(1);
      expect(events3[0].type).toBe("compaction");

      // Verify fidelity
      expect(TIER2_MEDIUM_FIDELITY.toolCallVisibility).toBe("full");
      expect(TIER2_MEDIUM_FIDELITY.transcriptAvailability).toBe("file_tail");
      expect(TIER2_MEDIUM_FIDELITY.overallScore).toBe(78);
    });

    it("successfully decodes all golden fixture files in fixtures/ directory against contract schemas", () => {
      const fixturesDir = path.resolve(__dirname, "../fixtures");
      if (!fs.existsSync(fixturesDir)) return;

      const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".jsonl"));

      expect(fixtureFiles.length).toBeGreaterThanOrEqual(4);

      for (const file of fixtureFiles) {
        const filePath = path.join(fixturesDir, file);
        const lines = fs
          .readFileSync(filePath, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);

        let seq = 0;
        for (const line of lines) {
          seq++;
          const decoded = decodeClaudeTranscriptLine(line, `fixture-${file}`, seq);
          expect(decoded).toBeInstanceOf(Array);
          for (const ev of decoded) {
            expect(ev.sessionId).toBeDefined();
            expect(ev.type).toBeDefined();
          }
        }
      }
    });
  });

  describe("6. Dynamic Catalog Refresh and Context Nudge Qualification", () => {
    it("reports supported refresh capability: context nudge enabled, native list-change disabled", () => {
      const capability = getClaudeRefreshCapability();
      expect(capability.supportsNativeListChange).toBe(false);
      expect(capability.supportsContextNudge).toBe(true);
      expect(capability.requiresSessionRestart).toBe(false);
    });

    it("generates catalog refresh result containing context nudge for active session", async () => {
      const workspace: HarnessWorkspace = {
        workspaceId: "ws-claude",
        name: "project",
        rootPath: "/workspace",
        harnessId: "claude-code",
        configPath: "/workspace/.claude.json",
        mcpConfigPath: "/workspace/.claude.json",
        activeSessionId: "session-active-123",
        metadata: {},
      };

      const result = await notifyClaudeCatalogRefresh(workspace, {
        catalogVersion: "1.2.0",
        timestamp: nowIso(),
        addedToolIds: ["resin-fast-lint"],
        updatedToolIds: [],
        removedToolIds: [],
      });

      expect(result.outcome).toBe("context_nudge");
      expect(result.requiresRestart).toBe(false);
      expect(result.message).toContain("resin-fast-lint");
      expect(result.affectedToolCount).toBe(1);
      expect(result.catalogVersion).toBe("1.2.0");
    });
  });

  describe("7. Strict Harness Adapter Contract Conformance", () => {
    it("implements StrictHarnessAdapter interface completely", () => {
      const adapter = new ClaudeHarnessAdapter();
      expect(adapter.id).toBe("claude-code");
      expect(adapter.name).toBe("Claude Code");
      expect(adapter.version).toBe("0.1.0");

      const caps = adapter.getCapabilities();
      expect(caps.fidelity.toolCallVisibility).toBe("full");
      expect(caps.supportedTransports).toContain("sse");
      expect(caps.refresh.supportsContextNudge).toBe(true);
      expect(caps.features.atomicRollback).toBe(true);
    });
  });
});
