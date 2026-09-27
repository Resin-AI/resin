import * as os from "node:os";
import * as path from "node:path";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigFsBridge,
  ConfigMetadataRecord,
  ConfigMutationPlan,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  ObservationFidelity,
  ProbeInstallationOptions,
  RefreshCapability,
  RefreshResult,
  SessionEventSource,
  SourceCursor,
  StrictHarnessAdapter,
} from "@resin/harness-contracts";
import {
  applyConfigMutation,
  createObservationFidelity,
  createRefreshResult,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
} from "@resin/harness-contracts";
import { planMuseMcpConfig } from "./config-planner.js";
import {
  MUSE_DISPLAY_NAME,
  MUSE_HARNESS_ID,
  MUSE_TESTED_VERSIONS,
  type MuseSessionLog,
  type MuseVersionExecutor,
  discoverMuseSessionLogs,
  probeMuseInstallation,
  resolveMuseSessionRoot,
  resolveMuseSettingsPath,
  sessionForMuseLog,
  workspaceIdForMuseRoot,
} from "./discovery.js";
import { MuseSessionEventSource } from "./source.js";

const UNBOUND_ROOT = "muse-unbound";
const UNBOUND_WORKSPACE_ID = "ws_muse_unbound";

export const MUSE_OBSERVATION_FIDELITY: ObservationFidelity = Object.freeze(
  createObservationFidelity({
    transcriptAvailability: "file_tail",
    toolCallVisibility: "full",
    toolResultVisibility: "full",
    subagentVisibility: "full",
    mcpListChange: "requires_restart",
    contextNudge: "unsupported",
    notes:
      "Tails muse's append-only session.jsonl event logs, including nested subagent and observer logs.",
  }),
);

export const MUSE_REFRESH_CAPABILITY: RefreshCapability = {
  supportsNativeListChange: false,
  supportsContextNudge: false,
  requiresSessionRestart: true,
  description:
    "Muse lists MCP tools when a session starts; whether it honours tools/list_changed is unverified, so catalog changes apply to the next session.",
};

export interface MuseHarnessAdapterOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the session root (`$XDG_DATA_HOME/muse/sessions`). */
  sessionRoot?: string;
  fsBridge?: ConfigFsBridge;
  executor?: MuseVersionExecutor;
  now?: () => number;
}

export class MuseHarnessAdapter implements StrictHarnessAdapter {
  readonly id = MUSE_HARNESS_ID;
  readonly name = MUSE_DISPLAY_NAME;
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = [...MUSE_TESTED_VERSIONS];

  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionRoot: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly executor?: MuseVersionExecutor;
  private readonly now: () => number;

  constructor(options: MuseHarnessAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? os.homedir();
    this.sessionRoot = options.sessionRoot ?? resolveMuseSessionRoot(this.home, this.env);
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.executor = options.executor;
    this.now = options.now ?? Date.now;
  }

  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return await probeMuseInstallation({
      home: this.home,
      env: options?.env ?? this.env,
      executablePath: options?.executablePath ?? options?.customExecutablePath,
      executor: this.executor,
    });
  }

  private workspaceFor(rootPath: string | null): HarnessWorkspace {
    const configPath = resolveMuseSettingsPath(this.home, this.env);
    if (rootPath === null) {
      return {
        workspaceId: UNBOUND_WORKSPACE_ID,
        rootPath: UNBOUND_ROOT,
        name: "Unbound Muse Code Sessions",
        harnessId: MUSE_HARNESS_ID,
        configPath,
        mcpConfigPath: configPath,
        metadata: { sessionRoot: this.sessionRoot, unbound: true },
      };
    }
    return {
      workspaceId: workspaceIdForMuseRoot(rootPath),
      rootPath,
      name: path.basename(rootPath) || rootPath,
      harnessId: MUSE_HARNESS_ID,
      configPath,
      mcpConfigPath: configPath,
      metadata: { sessionRoot: this.sessionRoot },
    };
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const logs = await discoverMuseSessionLogs(this.sessionRoot);
    const roots = new Set(logs.map((log) => log.workspaceRoot));
    return [...roots]
      .map((root) => this.workspaceFor(root))
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const logs = await discoverMuseSessionLogs(this.sessionRoot);
    const unbound = workspace.metadata?.unbound === true;
    const belongs = (log: MuseSessionLog) =>
      unbound ? log.workspaceRoot === null : log.workspaceRoot === workspace.rootPath;
    const now = this.now();
    return logs.filter(belongs).map((log) => sessionForMuseLog(log, workspace.workspaceId, now));
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    return (
      sessions.find(
        (session) => session.status === "active" && !session.metadata.parentSessionId,
      ) ?? null
    );
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new MuseSessionEventSource({
      filePath: session.transcriptPath,
      sessionId: session.sessionId,
      initialCursor: cursor,
    });
  }

  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return await planMuseMcpConfig({
      targetPath: workspace.mcpConfigPath ?? workspace.configPath,
      gatewayUrl,
      fsBridge: this.fsBridge,
    });
  }

  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return await applyConfigMutation(plan, this.fsBridge);
  }

  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    const content = await this.fsBridge.readFile(workspace.mcpConfigPath ?? workspace.configPath);
    if (content === null) return false;
    try {
      // SAFETY: JSON-parsed settings only hold JSON values, a subset of ConfigMetadataValue.
      const doc = JSON.parse(content) as { schema_version?: unknown; mcp_servers?: unknown };
      const servers = doc.mcp_servers as Record<string, ConfigMetadataRecord> | undefined;
      return doc.schema_version === 1 && isRecognizedResinMcpEntry(servers?.resin);
    } catch {
      return false;
    }
  }

  async notifyCatalogRefresh(
    _workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return createRefreshResult("next_session_required", {
      message: "Muse Code picks up Resin catalog changes when the next session starts.",
      catalogVersion: changeSummary.catalogVersion,
      appliedAt: changeSummary.timestamp,
      affectedToolCount:
        changeSummary.addedToolIds.length +
        changeSummary.updatedToolIds.length +
        changeSummary.removedToolIds.length,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return {
      refresh: MUSE_REFRESH_CAPABILITY,
      fidelity: MUSE_OBSERVATION_FIDELITY,
      supportedTransports: ["stdio"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { fileTailing: true, subagents: true, atomicConfig: true },
    };
  }
}
