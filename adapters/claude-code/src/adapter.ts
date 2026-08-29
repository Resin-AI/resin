import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nowIso } from "@resin/contracts";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigFsBridge,
  ConfigMutationPlan,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  ProbeInstallationOptions,
  RefreshResult,
  SessionEventSource,
  SourceCursor,
  StrictHarnessAdapter,
} from "@resin/harness-contracts";
import { TIER2_MEDIUM_FIDELITY, defaultFsBridge } from "@resin/harness-contracts";
import {
  applyClaudeMcpConfig,
  planClaudeMcpConfig,
  rollbackClaudeMcpConfig,
  verifyClaudeMcpConfig,
} from "./config-planner.js";
import {
  type ExecFunction,
  SUPPORTED_CLAUDE_VERSIONS,
  detectClaudeWorkspaces,
  probeClaudeInstallation,
} from "./discovery.js";
import { getClaudeRefreshCapability, notifyClaudeCatalogRefresh } from "./refresh.js";
import { ClaudeSessionEventSource } from "./source.js";

/**
 * Options for configuring ClaudeHarnessAdapter.
 */
export interface ClaudeHarnessAdapterOptions {
  fsBridge?: ConfigFsBridge;
  execFn?: ExecFunction;
}

/**
 * First-class Harness Adapter for Anthropic Claude Code CLI.
 */
export class ClaudeHarnessAdapter implements StrictHarnessAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = [...SUPPORTED_CLAUDE_VERSIONS];

  private readonly fsBridge: ConfigFsBridge;
  private readonly execFn?: ExecFunction;

  constructor(options?: ClaudeHarnessAdapterOptions) {
    this.fsBridge = options?.fsBridge ?? defaultFsBridge;
    this.execFn = options?.execFn;
  }

  async initialize(): Promise<void> {}

  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return await probeClaudeInstallation(options, this.fsBridge, this.execFn);
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    return await detectClaudeWorkspaces(undefined, this.fsBridge);
  }

  async detectWorkspaces(): Promise<HarnessWorkspace[]> {
    return await this.listWorkspaces();
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const sessions: HarnessSession[] = [];
    const seenSessionIds = new Set<string>();
    const claudeDir = path.normalize(path.join(workspace.rootPath, ".claude"));
    const projectDir =
      typeof workspace.metadata?.projectDir === "string"
        ? path.normalize(workspace.metadata.projectDir)
        : null;

    // 1. If active session is specified
    if (workspace.activeSessionId) {
      const defaultTranscriptPath = projectDir
        ? path.join(projectDir, `${workspace.activeSessionId}.jsonl`)
        : path.join(claudeDir, `${workspace.activeSessionId}.jsonl`);
      seenSessionIds.add(workspace.activeSessionId);
      sessions.push({
        sessionId: workspace.activeSessionId,
        workspaceId: workspace.workspaceId,
        harnessId: this.id,
        transcriptPath: defaultTranscriptPath,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata: { ...workspace.metadata },
      });
    }

    const targetDirs = [claudeDir];
    if (projectDir && projectDir !== claudeDir) {
      targetDirs.push(projectDir);
    }

    // 2. Check in-memory fs bridge if applicable
    if (
      "dump" in this.fsBridge &&
      typeof (this.fsBridge as { dump: unknown }).dump === "function"
    ) {
      const dump = (this.fsBridge as { dump: () => Record<string, string> }).dump();
      for (const filePath of Object.keys(dump)) {
        const normalized = path.normalize(filePath);
        for (const dir of targetDirs) {
          const normalizedDir = path.normalize(dir);
          const dirWithSep = normalizedDir.endsWith(path.sep)
            ? normalizedDir
            : `${normalizedDir}${path.sep}`;
          if (normalized.startsWith(dirWithSep) && normalized.endsWith(".jsonl")) {
            const fileName = path.basename(normalized);
            const sessionId = path.basename(normalized, ".jsonl");
            if (!seenSessionIds.has(sessionId)) {
              seenSessionIds.add(sessionId);
              sessions.push({
                sessionId,
                workspaceId: workspace.workspaceId,
                harnessId: this.id,
                transcriptPath: normalized,
                status: sessionId === workspace.activeSessionId ? "active" : "completed",
                createdAt: nowIso(),
                updatedAt: nowIso(),
                metadata: { transcriptFile: fileName },
              });
            }
          }
        }
      }
    }

    // 3. Scan directories on local filesystem
    for (const dir of targetDirs) {
      try {
        const exists = await this.fsBridge.exists(dir);
        if (exists) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              const sessionId = path.basename(entry.name, ".jsonl");
              if (!seenSessionIds.has(sessionId)) {
                seenSessionIds.add(sessionId);
                sessions.push({
                  sessionId,
                  workspaceId: workspace.workspaceId,
                  harnessId: this.id,
                  transcriptPath: path.join(dir, entry.name),
                  status: sessionId === workspace.activeSessionId ? "active" : "completed",
                  createdAt: nowIso(),
                  updatedAt: nowIso(),
                  metadata: { transcriptFile: entry.name },
                });
              }
            }
          }
        }
      } catch {
        // In-memory or restricted filesystem
      }
    }

    return sessions;
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    return sessions.length > 0 ? sessions[0] : null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new ClaudeSessionEventSource(session, cursor, {
      fsBridge: this.fsBridge,
    });
  }

  async openSessionSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return await this.openEventSource(session, cursor);
  }

  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return await planClaudeMcpConfig(workspace, gatewayUrl, this.fsBridge);
  }

  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return await applyClaudeMcpConfig(plan, this.fsBridge);
  }
  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return await verifyClaudeMcpConfig(workspace, undefined, this.fsBridge);
  }

  async rollbackMcpConfig(backup: ConfigBackup): Promise<void> {
    return await rollbackClaudeMcpConfig(backup, this.fsBridge);
  }

  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return await notifyClaudeCatalogRefresh(workspace, changeSummary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      refresh: getClaudeRefreshCapability(),
      fidelity: TIER2_MEDIUM_FIDELITY,
      supportedTransports: ["stdio", "sse"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: {
        transcriptTailing: true,
        contextNudge: true,
        mcpConfigPlanning: true,
        atomicRollback: true,
      },
    };
  }

  /**
   * Backward compatibility mock execution helper.
   */
  async execute(
    tool: { id: string; name: string; version: string; description: string },
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return {
      adapter: this.id,
      toolId: tool.id,
      input,
      output: "claude-code-response",
    };
  }
}

/**
 * Backward compatibility alias.
 */
export const ClaudeCodeAdapter = ClaudeHarnessAdapter;
