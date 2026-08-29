import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigFsBridge,
  ConfigMutationPlan,
  HarnessAdapter,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  ObservationFidelity,
  ProbeInstallationOptions,
  RefreshCapability,
  RefreshResult,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { createObservationFidelity, defaultFsBridge } from "@resin/harness-contracts";
import { z } from "zod";
import {
  DEFAULT_GATEWAY_SERVER_NAME,
  applyCodexMcpConfig,
  planCodexMcpConfig,
  rollbackCodexMcpConfig,
  verifyCodexMcpConfig,
} from "./config-planner.js";
import {
  CODEX_DISPLAY_NAME,
  CODEX_HARNESS_ID,
  type CommandExecutor,
  type PathLookupFn,
  probeCodexInstallation,
  resolveCodexPaths,
} from "./discovery.js";
import { CODEX_DEFAULT_REFRESH_CAPABILITY, handleCodexCatalogRefresh } from "./refresh.js";
import { CodexSessionEventSource } from "./source.js";

/**
 * Standard observation fidelity profile for Codex CLI.
 * Features file-tailing transcript availability and full tool call/result inspection.
 */
export const CODEX_OBSERVATION_FIDELITY: ObservationFidelity = Object.freeze(
  createObservationFidelity({
    transcriptAvailability: "file_tail",
    toolCallVisibility: "full",
    toolResultVisibility: "full",
    subagentVisibility: "shallow",
    mcpListChange: "requires_restart",
    contextNudge: "unsupported",
    notes:
      "File-tailing of JSONL rollouts with full tool call and result visibility; session restart required for MCP catalog updates.",
  }),
);

/**
 * Full capabilities descriptor for the Codex CLI harness adapter.
 */
export const CODEX_ADAPTER_CAPABILITIES: AdapterCapabilities = Object.freeze({
  fidelity: CODEX_OBSERVATION_FIDELITY,
  refresh: CODEX_DEFAULT_REFRESH_CAPABILITY,
  supportedTransports: ["stdio", "sse"] satisfies AdapterCapabilities["supportedTransports"],
  supportsMultiWorkspace: true,
  supportsConcurrentSessions: true,
  features: {
    atomicConfig: true,
    fileTailing: true,
    subagents: true,
  },
});

/**
 * Options for configuring CodexHarnessAdapter.
 */
export interface CodexHarnessAdapterOptions {
  fsBridge?: ConfigFsBridge;
  customExecutablePath?: string;
  customConfigPath?: string;
  customSessionRoot?: string;
  executor?: CommandExecutor;
  pathLookup?: PathLookupFn;
  capabilities?: Partial<AdapterCapabilities>;
}

/**
 * Primary HarnessAdapter implementation for the OpenAI Codex CLI agent harness.
 */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id: string = CODEX_HARNESS_ID;
  readonly name: string = CODEX_DISPLAY_NAME;
  readonly version = "0.1.0";

  private readonly fsBridge: ConfigFsBridge;
  private readonly customExecutablePath?: string;
  private readonly customConfigPath?: string;
  private readonly customSessionRoot?: string;
  private readonly executor?: CommandExecutor;
  private readonly pathLookup?: PathLookupFn;
  private readonly capabilities: AdapterCapabilities;

  constructor(options?: CodexHarnessAdapterOptions) {
    this.fsBridge = options?.fsBridge ?? defaultFsBridge;
    this.customExecutablePath = options?.customExecutablePath;
    this.customConfigPath = options?.customConfigPath;
    this.customSessionRoot = options?.customSessionRoot;
    this.executor = options?.executor;
    this.pathLookup = options?.pathLookup;

    this.capabilities = {
      ...CODEX_ADAPTER_CAPABILITIES,
      ...options?.capabilities,
      fidelity: {
        ...CODEX_OBSERVATION_FIDELITY,
        ...options?.capabilities?.fidelity,
      },
      refresh: {
        ...CODEX_DEFAULT_REFRESH_CAPABILITY,
        ...options?.capabilities?.refresh,
      },
    };
  }

  /**
   * Probes the local workstation environment for an installed Codex CLI harness.
   */
  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation> {
    return probeCodexInstallation({
      executablePath: options?.executablePath ?? this.customExecutablePath,
      customExecutablePath: options?.executablePath ?? this.customExecutablePath,
      customConfigPath: this.customConfigPath,
      executor: this.executor,
      pathLookup: this.pathLookup,
      env: options?.env,
    });
  }

  /**
   * Discovers available Codex workspaces.
   */
  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const resolved = await resolveCodexPaths({
      customConfigPath: this.customConfigPath,
      customSessionRoot: this.customSessionRoot,
    });

    const defaultWorkspace: HarnessWorkspace = {
      workspaceId: "ws_codex_default",
      harnessId: CODEX_HARNESS_ID,
      name: "Codex Default Workspace",
      rootPath: resolved.homeDir,
      configPath: resolved.configPath,
      mcpConfigPath: resolved.configPath,
      metadata: {
        sessionRoot: resolved.sessionRoot,
        configFormat: resolved.configFormat,
      },
    };

    return [defaultWorkspace];
  }

  /**
   * Lists all sessions found in the workspace's session root directory.
   */
  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const sessions: HarnessSession[] = [];
    const metadataRoot = z.string().safeParse(workspace.metadata?.sessionRoot);
    const sessionDir =
      (metadataRoot.success ? metadataRoot.data : null) ??
      path.join(workspace.rootPath, "sessions");
    try {
      const maxDepth = 6;
      const collectFiles = async (dir: string, depth: number): Promise<string[]> => {
        if (depth > maxDepth) return [];
        let dirents: Dirent[];
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const files: string[] = [];
        for (const dirent of dirents) {
          if (dirent.isSymbolicLink()) {
            continue;
          }
          const fullPath = path.join(dir, dirent.name);
          if (dirent.isDirectory()) {
            const nested = await collectFiles(fullPath, depth + 1);
            files.push(...nested);
          } else if (
            dirent.isFile() &&
            (dirent.name.endsWith(".jsonl") || dirent.name.endsWith(".json"))
          ) {
            files.push(fullPath);
          }
        }
        return files;
      };

      const transcriptFiles = await collectFiles(sessionDir, 0);

      for (const filePath of transcriptFiles) {
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) continue;

          const fileName = path.basename(filePath);
          const baseName = path.basename(fileName, path.extname(fileName));
          const sessionId = baseName.startsWith("sess_") ? baseName : `sess_${baseName}`;

          const now = Date.now();
          const isRecent = now - stat.mtimeMs < 5 * 60 * 1000; // 5 minutes

          sessions.push({
            sessionId,
            workspaceId: workspace.workspaceId,
            harnessId: CODEX_HARNESS_ID,
            transcriptPath: filePath,
            status: isRecent ? "active" : "completed",
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            metadata: {
              fileSizeBytes: stat.size,
              fileName,
            },
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // If root directory doesn't exist, return empty list
      return [];
    }

    return sessions.sort((a, b) => {
      const timeDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.transcriptPath.localeCompare(b.transcriptPath);
    });
  }

  /**
   * Finds the active session in the workspace, or returns null if none is active.
   */
  async getActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    const active = sessions.find((s) => s.status === "active");
    return active ?? (sessions.length > 0 ? (sessions[0] ?? null) : null);
  }

  /**
   * Creates an event source to tail and stream raw records from a Codex session.
   */
  async createEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new CodexSessionEventSource({
      filePath: session.transcriptPath,
      sessionId: session.sessionId,
      initialCursor: cursor,
    });
  }

  /**
   * Plans an atomic configuration modification to register the Resin Gateway.
   */
  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return planCodexMcpConfig({
      targetPath: workspace.configPath,
      gatewayUrl,
      serverName: DEFAULT_GATEWAY_SERVER_NAME,
      fsBridge: this.fsBridge,
    });
  }

  /**
   * Applies a planned configuration mutation with automatic backup.
   */
  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyCodexMcpConfig(plan, this.fsBridge);
  }

  /**
   * Verifies that the Gateway MCP server is registered in the workspace configuration.
   */
  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return verifyCodexMcpConfig(
      workspace.configPath,
      undefined,
      DEFAULT_GATEWAY_SERVER_NAME,
      this.fsBridge,
    );
  }
  /**
   * Reverts a previously applied configuration mutation.
   */
  async rollbackMcpConfig(backup: ConfigBackup): Promise<void> {
    return rollbackCodexMcpConfig(backup, this.fsBridge);
  }

  /**
   * Handles tool catalog change notifications for Codex CLI.
   */
  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return handleCodexCatalogRefresh(workspace, changeSummary, this.capabilities.refresh);
  }

  /**
   * Returns the capabilities descriptor for this adapter.
   */
  getCapabilities(): AdapterCapabilities {
    return this.capabilities;
  }
}

/**
 * Backward compatibility alias for CodexCliAdapter.
 */
export { CodexHarnessAdapter as CodexCliAdapter };
