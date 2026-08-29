import * as fsp from "node:fs/promises";
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
  TIER1_HIGH_FIDELITY,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpHarnessAdapter } from "../src/adapter.js";
import {
  DEFAULT_GATEWAY_SERVER_NAME,
  applyOmpMcpConfig,
  planOmpMcpConfig,
  resolveOmpConfigPath,
  rollbackOmpMcpConfig,
  verifyOmpMcpConfig,
} from "../src/config-planner.js";
import { OmpRecordDecoder, decodeOmpTranscriptLine } from "../src/decoder.js";
import {
  createWorkspaceIdFromPath,
  discoverOmpSessions,
  discoverOmpWorkspaces,
  inspectBreadcrumbs,
  probeOmpInstallation,
  resolveOmpHome,
} from "../src/discovery.js";
import { getOmpRefreshCapability, handleOmpCatalogRefresh } from "../src/refresh.js";
import { OmpSessionEventSource } from "../src/source.js";

describe("Oh My Pi (OMP) Harness Qualification Suite [REM-017]", () => {
  const gatewayUrl = "http://127.0.0.1:4400/sse";

  describe("1. Installation Discovery and Qualification", () => {
    it("qualifies installed OMP harness with valid configuration and executable", async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-qual-probe-"));
      const configPath = path.join(tempDir, "config.json");
      const executablePath = path.join(tempDir, process.platform === "win32" ? "omp.cmd" : "omp");
      await fsp.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
      await fsp.writeFile(
        executablePath,
        process.platform === "win32" ? "@echo 0.1.0\r\n" : "#!/bin/sh\necho 0.1.0\n",
        { mode: 0o755 },
      );

      const installation = await probeOmpInstallation({
        customConfigPath: configPath,
        customExecutablePath: executablePath,
        ompHome: tempDir,
      });

      expect(installation).not.toBeNull();
      expect(installation?.harnessId).toBe("omp");
      expect(installation?.isInstalled).toBe(true);
      expect(installation?.status).toBe("ready");

      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it("resolves OMP home and workspace paths deterministically", () => {
      const customHome = resolveOmpHome({ customHome: "/custom/omp" });
      expect(customHome).toBe(path.resolve("/custom/omp"));

      const wsId = createWorkspaceIdFromPath("/workspace/my-project");
      expect(wsId).toContain("my-project");
    });
  });

  describe("2. Configuration Orchestration: Backups, Idempotency, and Preserving User Settings", () => {
    it("preserves unrelated user settings, models, keybindings, and other servers in config.json", async () => {
      const initialUserConfig = {
        model: "claude-3-5-sonnet-20241022",
        maxTokens: 8192,
        keybindings: {
          palette: "ctrl+p",
          abort: "ctrl+c",
        },
        mcpServers: {
          existing_tool_server: {
            url: "http://127.0.0.1:7777/sse",
          },
        },
        customEnv: {
          ENV_VAR: "true",
        },
      };

      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.omp/config.json";
      await fsBridge.writeFile(configPath, JSON.stringify(initialUserConfig, null, 2));

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-omp-qual",
        name: "omp-qual-project",
        rootPath: "/workspace/omp-project",
        harnessId: "omp",
        configPath,
        mcpConfigPath: configPath,
        metadata: {},
      };
      // 1. Plan mutation
      const plan = await planOmpMcpConfig({ workspace, gatewayUrl, fsBridge });
      expect(plan.harnessId).toBe("omp");
      expect(plan.targetPath).toBe(configPath);
      expect(plan.plannedContent).toContain('"resin":');
      expect(plan.plannedContent).toContain("existing_tool_server");
      expect(plan.plannedContent).toContain('"model": "claude-3-5-sonnet-20241022"');
      expect(plan.plannedContent).toContain('"palette": "ctrl+p"');

      // 2. Apply mutation and get atomic backup
      const backup = await applyOmpMcpConfig(plan, fsBridge);
      expect(backup.targetPath).toBe(configPath);
      expect(backup.contentHash).toBe(plan.preconditionHash);

      // Verify written file contains both new gateway and old user settings
      const writtenContent = await fsBridge.readFile(configPath);
      const parsedWritten = JSON.parse(writtenContent ?? "{}");
      expect(parsedWritten.model).toBe("claude-3-5-sonnet-20241022");
      expect(parsedWritten.maxTokens).toBe(8192);
      expect(parsedWritten.keybindings.palette).toBe("ctrl+p");
      expect(parsedWritten.mcpServers.existing_tool_server).toBeDefined();
      expect(parsedWritten.mcpServers.resin).toEqual({
        url: gatewayUrl,
        type: "sse",
      });

      // 3. Verify write verification
      const verified = await verifyOmpMcpConfig({ workspace, gatewayUrl, fsBridge });
      expect(verified).toBe(true);

      // 4. Test idempotency (applying same plan again produces identical content)
      const secondPlan = await planOmpMcpConfig({ workspace, gatewayUrl, fsBridge });
      expect(secondPlan.plannedContent).toBe(writtenContent);
      // 5. Test clean byte-for-byte rollback during uninstall
      await rollbackOmpMcpConfig(backup, fsBridge);
      const restoredContent = await fsBridge.readFile(configPath);
      expect(restoredContent).toBe(JSON.stringify(initialUserConfig, null, 2));

      const parsedRestored = JSON.parse(restoredContent ?? "{}");
      expect(parsedRestored.mcpServers.resin).toBeUndefined();
      expect(parsedRestored.model).toBe("claude-3-5-sonnet-20241022");
      expect(parsedRestored.mcpServers.existing_tool_server).toBeDefined();
    });

    it("enforces precondition hash checking and rejects concurrent modifications", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const configPath = "/home/user/.omp/config.json";
      await fsBridge.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-omp-test",
        name: "test-workspace",
        rootPath: "/workspace",
        harnessId: "omp",
        configPath,
        mcpConfigPath: configPath,
        metadata: {},
      };

      const plan = await planOmpMcpConfig({ workspace, gatewayUrl, fsBridge });

      // Tamper with file before apply
      await fsBridge.writeFile(configPath, JSON.stringify({ mcpServers: {}, tampered: true }));

      await expect(applyOmpMcpConfig(plan, fsBridge)).rejects.toThrow(
        ConfigPreconditionFailedError,
      );
    });
  });

  describe("3. Session Discovery and Ambiguity Reporting", () => {
    it("discovers active and historical sessions from workspace session directories", async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-qual-disc-"));
      const sessionsDir = path.join(tempDir, ".omp", "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });

      const s1Path = path.join(sessionsDir, "session-active.jsonl");
      const s2Path = path.join(sessionsDir, "session-hist.jsonl");

      await fsp.writeFile(
        s1Path,
        '{"type":"session_lifecycle","lifecycleType":"start","sessionId":"s1"}\n',
      );
      await fsp.writeFile(
        s2Path,
        '{"type":"session_lifecycle","lifecycleType":"start","sessionId":"s2"}\n',
      );

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-omp",
        name: "test",
        rootPath: tempDir,
        harnessId: "omp",
        configPath: path.join(tempDir, ".omp", "config.json"),
        mcpConfigPath: path.join(tempDir, ".omp", "config.json"),
        metadata: {},
      };

      const sessions = await discoverOmpSessions(workspace, { ompHome: tempDir });
      expect(sessions.length).toBeGreaterThanOrEqual(2);

      await fsp.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("4. Transcript Tailing, Durable Checkpoints, and Resumption", () => {
    it("tails append-only transcripts, commits checkpoints, and resumes accurately", async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-qual-tail-"));
      const transcriptPath = path.join(tempDir, "omp-session.jsonl");

      const session: HarnessSession = {
        sessionId: "omp-session-1",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };

      const line1 = `${JSON.stringify({ type: "message", role: "user", content: "Hello OMP" })}\n`;
      const line2 = `${JSON.stringify({ type: "message", role: "assistant", content: "Hi! Ready." })}\n`;
      await fsp.writeFile(transcriptPath, line1 + line2);

      const source = new OmpSessionEventSource(session);

      const batch1 = await source.readNext(10);
      expect(batch1).toHaveLength(2);
      expect(batch1[0].sequenceNumber).toBe(1);
      expect(batch1[1].sequenceNumber).toBe(2);

      const cursor = source.getCursor();
      expect(cursor.offset).toBeGreaterThan(0);

      // Create new source resuming from checkpoint
      const resumedSource = new OmpSessionEventSource(session, cursor);

      const batchAfterResume = await resumedSource.readNext(10);
      expect(batchAfterResume).toHaveLength(0);

      // Append line3
      const line3 = `${JSON.stringify({
        type: "tool_call",
        toolName: "bash",
        callId: "c1",
        parameters: { command: "ls" },
      })}\n`;
      await fsp.writeFile(transcriptPath, line1 + line2 + line3);

      const batch3 = await resumedSource.readNext(10);
      expect(batch3).toHaveLength(1);
      expect(batch3[0].sequenceNumber).toBe(3);

      await source.close();
      await resumedSource.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it("buffers partial incomplete lines until a trailing newline arrives", async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-qual-part-"));
      const transcriptPath = path.join(tempDir, "partial.jsonl");

      const session: HarnessSession = {
        sessionId: "omp-partial",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };

      const completeLine1 = `${JSON.stringify({ type: "message", role: "user", content: "complete line" })}\n`;
      const incompleteLine2 = '{"type":"message","role":"assistant","content":"incom';

      // Write complete line + incomplete line
      await fsp.writeFile(transcriptPath, completeLine1 + incompleteLine2);

      const source = new OmpSessionEventSource(session);
      const records1 = await source.readNext(10);

      // Only complete line 1 should be returned
      expect(records1).toHaveLength(1);
      expect(records1[0].sequenceNumber).toBe(1);

      // Complete line2
      const fullLine2 = `${JSON.stringify({ type: "message", role: "assistant", content: "incoming complete" })}\n`;
      await fsp.writeFile(transcriptPath, completeLine1 + fullLine2);

      const records2 = await source.readNext(10);
      expect(records2).toHaveLength(1);
      expect(records2[0].sequenceNumber).toBe(2);

      await source.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it("resets cursor offset when file rotation/truncation is detected", async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-qual-rot-"));
      const transcriptPath = path.join(tempDir, "rotation.jsonl");

      const session: HarnessSession = {
        sessionId: "omp-rot",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: {},
      };

      const longContent =
        "line 1: large initial content line to establish offset...\nline 2: second large line...\nline 3: third large line...\n";
      await fsp.writeFile(transcriptPath, longContent);

      const source = new OmpSessionEventSource(session);
      await source.readNext(10);
      expect(source.getCursor().offset).toBe(Buffer.byteLength(longContent, "utf8"));

      // Truncate file to smaller size
      const truncatedContent = `${JSON.stringify({
        type: "session_lifecycle",
        lifecycleType: "start",
        sessionId: "rotated",
      })}\n`;
      await fsp.writeFile(transcriptPath, truncatedContent);

      const postTruncationRecords = await source.readNext(10);
      expect(postTruncationRecords.length).toBeGreaterThanOrEqual(1);

      await source.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe("5. Normalization, Fixtures & High Fidelity Metadata", () => {
    it("normalizes events with Tier 1 High Fidelity preset", () => {
      const decoder = new OmpRecordDecoder();
      expect(decoder.harnessId).toBe("omp");
      const rawRecord: RawHarnessRecord = {
        recordId: "rec-1",
        sessionId: "session-qual",
        harnessId: "omp",
        sequenceNumber: 1,
        recordType: "transcript_line",
        timestamp: nowIso(),
        cursor: { offset: 0, line: 1, sequence: 1, timestamp: nowIso() },
        rawPayload: JSON.stringify({
          type: "tool_call",
          toolName: "read_file",
          toolCallId: "call-1",
          parameters: { path: "src/main.ts" },
        }),
        metadata: {},
      };

      const event = decoder.decode(rawRecord);
      expect(event).toBeDefined();
      expect(event.type).toBe("tool_call");
      expect(TIER1_HIGH_FIDELITY.transcriptAvailability).toBe("stream");
      expect(TIER1_HIGH_FIDELITY.toolCallVisibility).toBe("full");
      expect(TIER1_HIGH_FIDELITY.toolResultVisibility).toBe("full");
      expect(TIER1_HIGH_FIDELITY.subagentVisibility).toBe("full");
      expect(TIER1_HIGH_FIDELITY.overallScore).toBe(100);
    });
  });

  describe("6. Dynamic Catalog Refresh Qualification", () => {
    it("reports native list change and context nudge capability without restart", () => {
      const capability = getOmpRefreshCapability();
      expect(capability.supportsNativeListChange).toBe(true);
      expect(capability.supportsContextNudge).toBe(true);
      expect(capability.requiresSessionRestart).toBe(false);
    });

    it("handles catalog refresh with native_list_change outcome", async () => {
      const workspace: HarnessWorkspace = {
        workspaceId: "ws-omp-qual",
        name: "qual-ws",
        rootPath: "/workspace",
        harnessId: "omp",
        configPath: "/workspace/.omp/config.json",
        mcpConfigPath: "/workspace/.omp/config.json",
        metadata: {},
      };

      const result = await handleOmpCatalogRefresh(workspace, {
        catalogVersion: "2.0.0",
        timestamp: nowIso(),
        addedToolIds: ["resin-fast-search"],
        updatedToolIds: [],
        removedToolIds: [],
      });

      expect(result.outcome).toBe("native_list_change");
      expect(result.requiresRestart).toBe(false);
      expect(result.catalogVersion).toBe("2.0.0");
      expect(result.affectedToolCount).toBe(1);
    });
  });

  describe("7. Strict Harness Adapter Contract Conformance", () => {
    it("implements StrictHarnessAdapter interface completely", () => {
      const adapter = new OmpHarnessAdapter();
      expect(adapter.id).toBe("omp");
      expect(adapter.name).toBe("omp");
      expect(adapter.version).toBe("0.1.0");

      const caps = adapter.getCapabilities();
      expect(caps.fidelity.transcriptAvailability).toBe("stream");
      expect(caps.supportedTransports).toContain("sse");
      expect(caps.refresh.supportsNativeListChange).toBe(true);
    });
  });
});
