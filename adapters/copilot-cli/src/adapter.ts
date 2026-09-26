import * as os from "node:os";
import {
  type AdapterCapabilities,
  AmbiguousActiveSessionError,
  CANONICAL_RESIN_MCP_COMMAND,
  type CatalogChangeSummary,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type ProbeInstallationOptions,
  type RefreshResult,
  type SessionEventSource,
  type SourceCursor,
  type StrictHarnessAdapter,
  applyConfigMutation,
  createObservationFidelity,
  defaultFsBridge,
} from "@resin/harness-contracts";
import { planCopilotMcpRegistration, verifyCopilotMcpRegistration } from "./config-planner.js";
import {
  COPILOT_DISPLAY_NAME,
  COPILOT_HARNESS_ID,
  COPILOT_TESTED_VERSIONS,
  listCopilotSessionEntries,
  probeCopilotInstallation,
  resolveCopilotHome,
  resolveCopilotMcpConfigPath,
  toCopilotSession,
  toCopilotWorkspace,
} from "./discovery.js";
import { getCopilotRefreshCapability, notifyCopilotCatalogRefresh } from "./refresh.js";
import { CopilotSessionEventSource } from "./source.js";

export interface CopilotHarnessAdapterOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fsBridge?: ConfigFsBridge;
  /** Resin command written into mcp-config.json (absolute shim path in production). */
  resinCommand?: string;
  pollingIntervalMs?: number;
  now?: () => number;
}

export class CopilotHarnessAdapter implements StrictHarnessAdapter {
  readonly id = COPILOT_HARNESS_ID;
  readonly name = COPILOT_DISPLAY_NAME;
  readonly version = "0.1.0";
  readonly supportedHarnessVersions = COPILOT_TESTED_VERSIONS;

  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fsBridge: ConfigFsBridge;
  private readonly options: CopilotHarnessAdapterOptions;

  constructor(options: CopilotHarnessAdapterOptions = {}) {
    this.options = options;
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
  }

  get copilotHome(): string {
    return resolveCopilotHome(this.home, this.env);
  }

  probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return probeCopilotInstallation({
      home: this.home,
      env: options?.env ?? this.env,
      executable: options?.customExecutablePath ?? options?.executablePath,
    });
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const roots = new Set(
      (await listCopilotSessionEntries(this.copilotHome)).map((entry) => entry.cwd),
    );
    return [...roots].map((root) => toCopilotWorkspace(root, this.copilotHome));
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const now = this.options.now?.() ?? Date.now();
    return (await listCopilotSessionEntries(this.copilotHome))
      .filter((entry) => entry.cwd === workspace.rootPath)
      .map((entry) => toCopilotSession(entry, now));
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const active = (await this.listSessions(workspace)).filter(
      (session) => session.status === "active",
    );
    if (active.length > 1) {
      throw new AmbiguousActiveSessionError(
        `Multiple active Copilot CLI sessions in ${workspace.rootPath}`,
        {
          harnessId: COPILOT_HARNESS_ID,
          candidateSessionIds: active.map((session) => session.sessionId),
        },
      );
    }
    return active[0] ?? null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new CopilotSessionEventSource(session, cursor, {
      pollingIntervalMs: this.options.pollingIntervalMs,
    });
  }

  planMcpConfig(workspace: HarnessWorkspace, gatewayUrl: string): Promise<ConfigMutationPlan> {
    return planCopilotMcpRegistration({
      targetPath: workspace.mcpConfigPath ?? resolveCopilotMcpConfigPath(this.home, this.env),
      command: this.options.resinCommand ?? CANONICAL_RESIN_MCP_COMMAND,
      gatewayUrl,
      fsBridge: this.fsBridge,
    });
  }

  applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyConfigMutation(plan, this.fsBridge);
  }

  verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return verifyCopilotMcpRegistration({
      targetPath: workspace.mcpConfigPath ?? resolveCopilotMcpConfigPath(this.home, this.env),
      command: this.options.resinCommand ?? CANONICAL_RESIN_MCP_COMMAND,
      fsBridge: this.fsBridge,
    });
  }

  async notifyCatalogRefresh(
    _workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return notifyCopilotCatalogRefresh(changeSummary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      refresh: getCopilotRefreshCapability(),
      fidelity: createObservationFidelity({
        transcriptAvailability: "file_tail",
        toolCallVisibility: "full",
        toolResultVisibility: "full",
        subagentVisibility: "full",
        mcpListChange: "supported",
        contextNudge: "unsupported",
        notes:
          "Tails session-state/<id>/events.jsonl: exact tool arguments and results, subagent events tagged with parentToolCallId, token usage per process run from session.shutdown.",
      }),
      supportedTransports: ["stdio", "http", "sse"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { compaction: true, subagents: true, perCallUsage: false },
    };
  }
}
