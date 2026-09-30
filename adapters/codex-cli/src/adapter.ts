import { createHash } from "node:crypto";
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
  CODEX_TESTED_VERSIONS,
  type CodexInspectionCache,
  type CodexTranscriptInspection,
  type CommandExecutor,
  type PathLookupFn,
  discoverCodexTranscripts,
  probeCodexInstallation,
  resolveCodexPaths,
} from "./discovery.js";
import { CODEX_DEFAULT_REFRESH_CAPABILITY, handleCodexCatalogRefresh } from "./refresh.js";
import { CodexSessionEventSource } from "./source.js";

interface CodexSessionCatalog {
  sessionRoot: string;
  workspaces: HarnessWorkspace[];
  sessionsByWorkspaceId: Map<string, HarnessSession[]>;
  sessionsByRoot: Map<string, HarnessSession[]>;
  unboundRoot: string;
}

function workspaceIdForCodexRoot(rootPath: string): string {
  const slug = rootPath
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-72);
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 12);
  return `ws_codex_${slug || "root"}_${digest}`;
}

function codexSessionId(inspection: CodexTranscriptInspection): string {
  const baseName = path.basename(inspection.fileName, path.extname(inspection.fileName));
  return baseName.startsWith("sess_") ? baseName : `sess_${baseName}`;
}

function sessionForCodexTranscript(
  inspection: CodexTranscriptInspection,
  workspaceId: string,
  sessionIdsByThreadId: ReadonlyMap<string, string>,
): HarnessSession {
  const metadata: Record<string, unknown> = {
    fileSizeBytes: inspection.fileSizeBytes,
    fileName: inspection.fileName,
    inspectedBytes: inspection.inspectedBytes,
  };
  if (inspection.cwd !== null) metadata.cwd = inspection.cwd;
  if (inspection.nativeSessionId) metadata.nativeSessionId = inspection.nativeSessionId;
  if (inspection.threadId) metadata.threadId = inspection.threadId;
  if (inspection.rootId) metadata.rootId = inspection.rootId;
  if (inspection.parentThreadId) metadata.parentThreadId = inspection.parentThreadId;
  if (inspection.forkedFromId) metadata.forkedFromId = inspection.forkedFromId;

  // A multi-agent child is its own rollout: its tool calls belong to it, and it links to the
  // rollout of the thread that spawned it (the immediate parent, so nested children chain).
  if (inspection.parentThreadId || inspection.threadSource === "subagent") {
    metadata.sessionKind = "agent";
    if (inspection.parentThreadId) {
      // A parent rollout outside the discovered set (older than the transcript cap) cannot be
      // named by its file; its thread id keeps the child captured and linkable.
      metadata.parentSessionId =
        sessionIdsByThreadId.get(inspection.parentThreadId) ?? `sess_${inspection.parentThreadId}`;
    }
    const agentName =
      inspection.agentNickname ??
      (inspection.agentPath ? path.posix.basename(inspection.agentPath) : undefined) ??
      inspection.agentRole;
    if (agentName) metadata.agentName = agentName;
    if (inspection.agentRole) metadata.agentKind = inspection.agentRole;
    if (inspection.threadId) metadata.agentId = inspection.threadId;
    if (inspection.agentPath) metadata.agentPath = inspection.agentPath;
    if (inspection.agentDepth !== undefined) metadata.agentDepth = inspection.agentDepth;
  }

  return {
    sessionId: codexSessionId(inspection),
    workspaceId,
    harnessId: CODEX_HARNESS_ID,
    transcriptPath: inspection.filePath,
    status: inspection.status,
    createdAt: inspection.createdAt,
    updatedAt: inspection.updatedAt,
    metadata,
  };
}

function createCodexWorkspace(
  rootPath: string,
  configPath: string,
  configFormat: "toml" | "json",
  sessionRoot: string,
  unbound: boolean,
): HarnessWorkspace {
  return {
    workspaceId: unbound ? "ws_codex_unbound" : workspaceIdForCodexRoot(rootPath),
    harnessId: CODEX_HARNESS_ID,
    name: unbound ? "Unbound Codex Sessions" : path.basename(rootPath) || rootPath,
    rootPath,
    configPath,
    mcpConfigPath: configPath,
    metadata: {
      sessionRoot,
      configFormat,
      ...(unbound ? { unbound: true, source: "unbound" } : { source: "session_meta.cwd" }),
    },
  };
}

/**
 * Standard observation fidelity profile for Codex CLI.
 * Features file-tailing transcript availability and full tool call/result inspection.
 */
export const CODEX_OBSERVATION_FIDELITY: ObservationFidelity = Object.freeze(
  createObservationFidelity({
    transcriptAvailability: "file_tail",
    toolCallVisibility: "full",
    toolResultVisibility: "full",
    subagentVisibility: "full",
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
  /** Host environment (`CODEX_HOME`, `USERPROFILE`, `PATH`); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Host platform (tests inject `win32`); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** User home Codex resolves `~/.codex` against; defaults to the platform's user home. */
  userHome?: string;
}

/**
 * Primary HarnessAdapter implementation for the OpenAI Codex CLI agent harness.
 */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id: string = CODEX_HARNESS_ID;
  readonly name: string = CODEX_DISPLAY_NAME;
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = CODEX_TESTED_VERSIONS;

  private readonly fsBridge: ConfigFsBridge;
  private readonly customExecutablePath?: string;
  private readonly customConfigPath?: string;
  private readonly customSessionRoot?: string;
  private readonly executor?: CommandExecutor;
  private readonly pathLookup?: PathLookupFn;
  private readonly host: Pick<CodexHarnessAdapterOptions, "env" | "platform" | "userHome">;
  private readonly capabilities: AdapterCapabilities;
  private cachedCatalog?: CodexSessionCatalog;
  private readonly inspectionCache: CodexInspectionCache = new Map();

  constructor(options?: CodexHarnessAdapterOptions) {
    this.fsBridge = options?.fsBridge ?? defaultFsBridge;
    this.customExecutablePath = options?.customExecutablePath;
    this.customConfigPath = options?.customConfigPath;
    this.customSessionRoot = options?.customSessionRoot;
    this.executor = options?.executor;
    this.pathLookup = options?.pathLookup;
    this.host = { env: options?.env, platform: options?.platform, userHome: options?.userHome };

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
      env: options?.env ?? this.host.env,
      platform: this.host.platform,
      userHome: this.host.userHome,
    });
  }

  private async discoverSessionCatalog(sessionRootOverride?: string): Promise<CodexSessionCatalog> {
    const resolved = await resolveCodexPaths({
      customConfigPath: this.customConfigPath,
      customSessionRoot: this.customSessionRoot,
      env: this.host.env,
      platform: this.host.platform,
      userHome: this.host.userHome,
    });
    const sessionRoot = path.resolve(sessionRootOverride ?? resolved.sessionRoot);
    const inspections = await discoverCodexTranscripts(sessionRoot, {
      cache: this.inspectionCache,
    });
    const sessionIdsByThreadId = new Map<string, string>();
    for (const inspection of inspections) {
      if (inspection.threadId) {
        sessionIdsByThreadId.set(inspection.threadId, codexSessionId(inspection));
      }
    }
    const workspacesByRoot = new Map<string, HarnessWorkspace>();
    const sessionsByWorkspaceId = new Map<string, HarnessSession[]>();
    const sessionsByRoot = new Map<string, HarnessSession[]>();
    const unknownRoot = "codex-unbound";

    const getWorkspace = (rootPath: string, unbound: boolean): HarnessWorkspace => {
      let workspace = workspacesByRoot.get(rootPath);
      if (!workspace) {
        workspace = createCodexWorkspace(
          rootPath,
          resolved.configPath,
          resolved.configFormat,
          sessionRoot,
          unbound,
        );
        workspacesByRoot.set(rootPath, workspace);
      }
      return workspace;
    };

    for (const inspection of inspections) {
      const isUnbound = inspection.canonicalCwd === null;
      const rootPath = inspection.canonicalCwd ?? unknownRoot;
      const workspace = getWorkspace(rootPath, isUnbound);
      const session = sessionForCodexTranscript(
        inspection,
        workspace.workspaceId,
        sessionIdsByThreadId,
      );
      const workspaceSessions = sessionsByWorkspaceId.get(workspace.workspaceId) ?? [];
      workspaceSessions.push(session);
      sessionsByWorkspaceId.set(workspace.workspaceId, workspaceSessions);
      const rootSessions = sessionsByRoot.get(workspace.rootPath) ?? [];
      rootSessions.push(session);
      sessionsByRoot.set(workspace.rootPath, rootSessions);
    }

    if (workspacesByRoot.size === 0) getWorkspace(unknownRoot, true);
    const workspaces = [...workspacesByRoot.values()].sort((left, right) => {
      const leftUnbound = left.metadata?.unbound === true;
      const rightUnbound = right.metadata?.unbound === true;
      if (leftUnbound !== rightUnbound) return leftUnbound ? 1 : -1;
      return left.rootPath.localeCompare(right.rootPath);
    });
    const catalog = {
      sessionRoot,
      workspaces,
      sessionsByWorkspaceId,
      sessionsByRoot,
      unboundRoot: unknownRoot,
    };
    this.cachedCatalog = catalog;
    return catalog;
  }

  /**
   * Discovers available Codex workspaces.
   */
  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const catalog = await this.discoverSessionCatalog();
    return [...catalog.workspaces];
  }

  /**
   * Lists all sessions found in the workspace's session root directory.
   */
  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const metadataRoot = z.string().safeParse(workspace.metadata?.sessionRoot);
    const requestedSessionRoot = metadataRoot.success ? path.resolve(metadataRoot.data) : null;
    let catalog = this.cachedCatalog;
    if (!catalog || (requestedSessionRoot && requestedSessionRoot !== catalog.sessionRoot)) {
      catalog = await this.discoverSessionCatalog(requestedSessionRoot ?? undefined);
    }

    const byWorkspaceId = catalog.sessionsByWorkspaceId.get(workspace.workspaceId);
    if (byWorkspaceId) return [...byWorkspaceId];
    if (workspace.metadata?.unbound === true) {
      return [...(catalog.sessionsByRoot.get(catalog.unboundRoot) ?? [])];
    }

    const resolvedRoot = await fs
      .realpath(workspace.rootPath)
      .catch(() => path.resolve(workspace.rootPath));
    return [...(catalog.sessionsByRoot.get(resolvedRoot) ?? [])];
  }

  /**
   * Finds the active session in the workspace, or returns null if none is active.
   */
  async getActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    const active = sessions.find((s) => s.status === "active");
    return active ?? null;
  }

  /**
   * Creates an event source to tail and stream raw records from a Codex session.
   */
  async openEventSource(
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
