import * as fs from "node:fs/promises";
import * as os from "node:os";
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
  TIER3_LOW_FIDELITY,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  MULTI_TURN_TOOLS_ROLLOUT_PATH,
  STANDARD_SESSION_ROLLOUT_PATH,
  SUBAGENTS_AND_FORKS_ROLLOUT_PATH,
  readFixture,
} from "../fixtures/index.js";
import { CodexHarnessAdapter } from "../src/adapter.js";
import {
  DEFAULT_GATEWAY_SERVER_NAME,
  DEFAULT_RESIN_MCP_COMMAND,
  applyCodexMcpConfig,
  planCodexMcpConfig,
  rollbackCodexMcpConfig,
  updateJsonMcpConfig,
  updateTomlMcpConfig,
  verifyCodexMcpConfig,
} from "../src/config-planner.js";
import { CodexSessionDecoder, decodeCodexRecord, decodeCodexTranscript } from "../src/decoder.js";
import {
  CODEX_DISPLAY_NAME,
  CODEX_HARNESS_ID,
  CODEX_MIN_SUPPORTED_VERSION,
  compareSemver,
  probeCodexInstallation,
  resolveCodexPaths,
} from "../src/discovery.js";
import { CODEX_DEFAULT_REFRESH_CAPABILITY, handleCodexCatalogRefresh } from "../src/refresh.js";
import { CodexSessionEventSource } from "../src/source.js";

describe("Codex CLI Harness Qualification Suite [REM-017]", () => {
  const gatewayUrl = "http://127.0.0.1:4400/sse";

  describe("1. Installation Discovery and Qualification", () => {
    it("qualifies installed Codex CLI versions against supported version matrix", async () => {
      expect(compareSemver("0.1.0", CODEX_MIN_SUPPORTED_VERSION)).toBeGreaterThanOrEqual(0);
      expect(compareSemver("0.2.0", CODEX_MIN_SUPPORTED_VERSION)).toBeGreaterThanOrEqual(0);

      const mockExecutor = async (_cmd: string, args: string[]) => {
        if (args.includes("--version")) {
          return { stdout: "codex-cli version 0.2.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const installation = await probeCodexInstallation({
        pathLookup: async () => "/usr/local/bin/codex",
        executor: mockExecutor,
      });

      expect(installation.status).toBe("ready");
      expect(installation.harnessId).toBe(CODEX_HARNESS_ID);
      expect(installation.version).toBe("0.2.0");
      expect(installation.isInstalled).toBe(true);
    });

    it("reports missing_executable when executable is not found", async () => {
      const mockFailingExecutor = async () => {
        throw new Error("command not found: codex");
      };

      const installation = await probeCodexInstallation({
        pathLookup: async () => null,
        executor: mockFailingExecutor,
      });

      expect(installation.status).toBe("missing_executable");
      expect(installation.isInstalled).toBe(false);
    });

    it("resolves Codex configuration paths and session roots deterministically", async () => {
      const resolved = await resolveCodexPaths();
      expect(resolved.homeDir).toBeDefined();
      expect(resolved.configPath).toContain("config.toml");
      expect(resolved.sessionRoot).toContain("sessions");
    });
  });

  describe("2. Configuration Orchestration: Backups, Idempotency, and Preserving User Settings", () => {
    it("preserves unrelated user settings, comments, and other servers in config.toml", async () => {
      const initialToml = [
        "# User custom settings",
        'model = "code-davinci-002"',
        "temperature = 0.2",
        "",
        "[mcp_servers.existing_custom_server]",
        'url = "http://127.0.0.1:9999/sse"',
        'auth_token = "secret-token"',
        "",
        "[telemetry]",
        "enabled = false",
      ].join("\n");

      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.codex/config.toml";
      await fsBridge.writeFile(configPath, initialToml);

      // 1. Plan mutation
      const plan = await planCodexMcpConfig({
        targetPath: configPath,
        gatewayUrl,
        fsBridge,
      });

      expect(plan.harnessId).toBe(CODEX_HARNESS_ID);
      expect(plan.targetPath).toBe(configPath);
      expect(plan.plannedContent).toContain("resin");
      expect(plan.plannedContent).toContain("existing_custom_server");
      expect(plan.plannedContent).toContain('model = "code-davinci-002"');
      expect(plan.plannedContent).toContain("temperature = 0.2");
      expect(plan.plannedContent).toContain("[telemetry]");

      // 2. Apply mutation and get atomic backup
      const backup = await applyCodexMcpConfig(plan, fsBridge);
      expect(backup.targetPath).toBe(configPath);
      expect(backup.contentHash).toBe(plan.preconditionHash);

      // Verify written file contains both new server and old settings
      const writtenContent = await fsBridge.readFile(configPath);
      expect(writtenContent).toContain("[mcp_servers.resin]");
      expect(writtenContent).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(writtenContent).toContain('args = ["mcp"]');
      expect(writtenContent).toContain("[mcp_servers.existing_custom_server]");
      expect(writtenContent).toContain('model = "code-davinci-002"');

      // 3. Verify write integrity
      const isVerified = await verifyCodexMcpConfig(
        configPath,
        gatewayUrl,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(isVerified).toBe(true);

      // 4. Test idempotency (applying same plan again produces identical content)
      const secondPlan = await planCodexMcpConfig({
        targetPath: configPath,
        gatewayUrl,
        fsBridge,
      });
      expect(secondPlan.plannedContent).toBe(writtenContent);

      // 5. Test clean byte-for-byte rollback during uninstall
      await rollbackCodexMcpConfig(backup, fsBridge);
      const restoredContent = await fsBridge.readFile(configPath);
      expect(restoredContent).toBe(initialToml);
      expect(restoredContent).not.toContain("resin");
      expect(restoredContent).toContain("existing_custom_server");
    });

    it("preserves unrelated settings in JSON format (config.json) as well", async () => {
      const initialJson = JSON.stringify(
        {
          model: "gpt-4o",
          mcp_servers: {
            existing_lsp: {
              url: "http://127.0.0.1:8080/sse",
            },
          },
        },
        null,
        2,
      );

      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.codex/config.json";
      await fsBridge.writeFile(configPath, initialJson);

      const plan = await planCodexMcpConfig({
        targetPath: configPath,
        gatewayUrl,
        fsBridge,
      });

      const backup = await applyCodexMcpConfig(plan, fsBridge);
      const written = await fsBridge.readFile(configPath);
      const parsed = JSON.parse(written ?? "{}");

      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.mcp_servers.existing_lsp).toBeDefined();
      expect(parsed.mcp_servers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });

      await rollbackCodexMcpConfig(backup, fsBridge);
      const restored = await fsBridge.readFile(configPath);
      expect(restored).toBe(initialJson);
    });

    it("enforces precondition hash checking and rejects concurrent modifications", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.codex/config.toml";
      await fsBridge.writeFile(configPath, 'model = "original"');

      const plan = await planCodexMcpConfig({
        targetPath: configPath,
        gatewayUrl,
        fsBridge,
      });

      // Tamper with file
      await fsBridge.writeFile(configPath, 'model = "tampered"');

      await expect(applyCodexMcpConfig(plan, fsBridge)).rejects.toThrow(
        ConfigPreconditionFailedError,
      );
    });
  });

  describe("3. Session Discovery and Ambiguity Reporting", () => {
    it("discovers active and historical sessions from workspace session roots", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disc-test-"));
      const sessionDir = path.join(tempDir, "sessions");
      await fs.mkdir(sessionDir, { recursive: true });

      const session1Path = path.join(sessionDir, "session-1.jsonl");
      const session2Path = path.join(sessionDir, "session-2.jsonl");

      await fs.writeFile(session1Path, '{"type":"session_start","sessionId":"s1"}\n');
      await fs.writeFile(session2Path, '{"type":"session_start","sessionId":"s2"}\n');

      const adapter = new CodexHarnessAdapter({
        customConfigPath: path.join(tempDir, "config.toml"),
        customSessionRoot: sessionDir,
      });

      const workspaces = await adapter.listWorkspaces();
      expect(workspaces.length).toBeGreaterThan(0);

      const sessions = await adapter.listSessions(workspaces[0]);
      expect(sessions.length).toBe(2);

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("4. Transcript Tailing, Durable Checkpoints, and Resumption", () => {
    it("tails append-only transcripts, commits checkpoints, and resumes accurately", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tail-test-"));
      const transcriptPath = path.join(tempDir, "transcript.jsonl");

      const line1 = `${JSON.stringify({ type: "user_message", content: "Hello Codex" })}\n`;
      const line2 = `${JSON.stringify({ type: "assistant_message", content: "Hello! How can I assist?" })}\n`;
      await fs.writeFile(transcriptPath, line1 + line2);

      const source = new CodexSessionEventSource({
        sessionId: "codex-session-1",
        filePath: transcriptPath,
      });

      const batch1 = await source.readNext(10);
      expect(batch1).toHaveLength(2);
      expect(batch1[0].sequenceNumber).toBe(1);
      expect(batch1[1].sequenceNumber).toBe(2);

      const cursor = source.getCursor();
      expect(cursor.offset).toBeGreaterThan(0);

      // Create new source resuming from checkpoint
      const resumedSource = new CodexSessionEventSource({
        sessionId: "codex-session-1",
        filePath: transcriptPath,
        initialCursor: cursor,
      });

      const batchAfterResume = await resumedSource.readNext(10);
      expect(batchAfterResume).toHaveLength(0);

      // Append line3
      const line3 = `${JSON.stringify({ type: "user_message", content: "Optimize this loop" })}\n`;
      await fs.writeFile(transcriptPath, line1 + line2 + line3);

      const batch3 = await resumedSource.readNext(10);
      expect(batch3).toHaveLength(1);
      expect(batch3[0].sequenceNumber).toBe(3);
      expect(batch3[0].rawPayload).toEqual({ type: "user_message", content: "Optimize this loop" });

      await source.close();
      await resumedSource.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("buffers partial incomplete lines until a trailing newline arrives", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-partial-test-"));
      const transcriptPath = path.join(tempDir, "partial.jsonl");

      const completeLine1 = `${JSON.stringify({ type: "user_message", content: "first complete line" })}\n`;
      const incompleteLine2 = '{"type":"assistant_message","content":"incom';

      // Write complete line + incomplete line
      await fs.writeFile(transcriptPath, completeLine1 + incompleteLine2);

      const source = new CodexSessionEventSource({
        sessionId: "codex-partial",
        filePath: transcriptPath,
      });

      const records1 = await source.readNext(10);
      expect(records1).toHaveLength(1);
      expect(records1[0].sequenceNumber).toBe(1);
      expect(records1[0].rawPayload).toEqual({
        type: "user_message",
        content: "first complete line",
      });

      // Complete line2
      const fullLine2 = `${JSON.stringify({ type: "assistant_message", content: "incoming complete" })}\n`;
      await fs.writeFile(transcriptPath, completeLine1 + fullLine2);

      const records2 = await source.readNext(10);
      expect(records2).toHaveLength(1);
      expect(records2[0].sequenceNumber).toBe(2);
      expect(records2[0].rawPayload).toEqual({
        type: "assistant_message",
        content: "incoming complete",
      });

      await source.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("resets cursor offset when file rotation/truncation is detected", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rotation-test-"));
      const transcriptPath = path.join(tempDir, "rotation.jsonl");

      const longContent =
        "line 1: large initial content line to establish offset...\nline 2: second large line...\nline 3: third large line...\n";
      await fs.writeFile(transcriptPath, longContent);

      const source = new CodexSessionEventSource({
        sessionId: "codex-rotation",
        filePath: transcriptPath,
      });

      await source.readNext(10);
      expect(source.getCursor().offset).toBe(Buffer.byteLength(longContent, "utf8"));

      // Truncate file to smaller size
      const truncatedContent = `${JSON.stringify({ type: "session_restart", reason: "rotated" })}\n`;
      await fs.writeFile(transcriptPath, truncatedContent);

      const postTruncationRecords = await source.readNext(10);
      expect(postTruncationRecords.length).toBeGreaterThanOrEqual(1);
      expect(postTruncationRecords[0].rawPayload).toEqual({
        type: "session_restart",
        reason: "rotated",
      });

      await source.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("5. Normalization, Fixtures & Fidelity Metadata", () => {
    it("normalizes standard session fixture with strict contract schema validation", async () => {
      const rawContent = await readFixture(STANDARD_SESSION_ROLLOUT_PATH);
      const events = decodeCodexTranscript(rawContent, "std-session-test");

      expect(events.length).toBeGreaterThanOrEqual(5);
      for (const ev of events) {
        expect(() => NormalizedSessionEventSchema.parse(ev)).not.toThrow();
        expect(ev.sessionId).toBeDefined();
      }

      const types = new Set(events.map((e) => e.type));
      expect(types.has("session_lifecycle")).toBe(true);
      expect(types.has("message")).toBe(true);
      expect(types.has("tool_call")).toBe(true);
      expect(types.has("tool_result")).toBe(true);
    });

    it("normalizes subagents, forks, and multi-turn tool fixtures", async () => {
      const subagentContent = await readFixture(SUBAGENTS_AND_FORKS_ROLLOUT_PATH);
      const subagentEvents = decodeCodexTranscript(subagentContent, "subagent-test");
      expect(subagentEvents.length).toBeGreaterThan(0);
      for (const ev of subagentEvents) {
        expect(() => NormalizedSessionEventSchema.parse(ev)).not.toThrow();
      }

      const multiToolContent = await readFixture(MULTI_TURN_TOOLS_ROLLOUT_PATH);
      const multiToolEvents = decodeCodexTranscript(multiToolContent, "multitool-test");
      expect(multiToolEvents.length).toBeGreaterThan(0);
      for (const ev of multiToolEvents) {
        expect(() => NormalizedSessionEventSchema.parse(ev)).not.toThrow();
      }
    });

    it("assigns Tier-3 Low Fidelity preset for Codex CLI", () => {
      expect(TIER3_LOW_FIDELITY.transcriptAvailability).toBe("polling");
      expect(TIER3_LOW_FIDELITY.mcpListChange).toBe("requires_restart");
      expect(TIER3_LOW_FIDELITY.overallScore).toBe(35);
    });
  });

  describe("6. Dynamic Catalog Refresh Qualification", () => {
    it("reports supported refresh capability: requires session restart, no native list change", () => {
      expect(CODEX_DEFAULT_REFRESH_CAPABILITY.requiresSessionRestart).toBe(true);
      expect(CODEX_DEFAULT_REFRESH_CAPABILITY.supportsNativeListChange).toBe(false);
      expect(CODEX_DEFAULT_REFRESH_CAPABILITY.supportsContextNudge).toBe(false);
    });

    it("handles catalog refresh by returning next_session_required outcome", async () => {
      const workspace: HarnessWorkspace = {
        workspaceId: "ws-codex-test",
        name: "test-workspace",
        rootPath: "/workspace",
        harnessId: CODEX_HARNESS_ID,
        configPath: "/workspace/.codex/config.toml",
        mcpConfigPath: "/workspace/.codex/config.toml",
        metadata: {},
      };

      const result = await handleCodexCatalogRefresh(workspace, {
        catalogVersion: "1.5.0",
        timestamp: nowIso(),
        addedToolIds: ["resin-formatter"],
        updatedToolIds: [],
        removedToolIds: [],
      });

      expect(result.outcome).toBe("next_session_required");
      expect(result.requiresRestart).toBe(true);
      expect(result.catalogVersion).toBe("1.5.0");
      expect(result.affectedToolCount).toBe(1);
    });
  });

  describe("7. Strict Harness Adapter Contract Conformance", () => {
    it("implements HarnessAdapter interface completely", () => {
      const adapter = new CodexHarnessAdapter();
      expect(adapter.id).toBe(CODEX_HARNESS_ID);
      expect(adapter.name).toBe(CODEX_DISPLAY_NAME);
      expect(adapter.version).toBe("0.1.0");

      const caps = adapter.getCapabilities();
      expect(caps.refresh.requiresSessionRestart).toBe(true);
      expect(caps.supportedTransports).toContain("sse");
    });
  });
});
