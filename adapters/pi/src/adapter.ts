import os from "node:os";
import path from "node:path";
import {
  type AdapterCapabilities,
  AmbiguousActiveSessionError,
  applyConfigMutation,
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  type CatalogChangeSummary,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  createRefreshResult,
  defaultFsBridge,
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type ProbeInstallationOptions,
  type RefreshResult,
  type SessionEventSource,
  type SourceCursor,
  type StrictHarnessAdapter,
} from "@resin/harness-contracts";
import {
  PI_TESTED_VERSIONS,
  piWorkspaceId,
  probePiInstallation,
  scanPiTranscripts,
  toPiSession,
  toPiWorkspace,
} from "./discovery.js";
import { resolvePiAgentDir, resolvePiExtensionPath, resolvePiSessionRoots } from "./paths.js";
import { planPiRegistration, verifyPiRegistration } from "./registration.js";
import { PiSessionEventSource } from "./source.js";

export interface PiHarnessAdapterOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Directories the user passes to Pi with `--session-dir`. Pi records that flag nowhere Resin
   * can read, so such sessions are only discovered when their directory is listed here.
   */
  extraSessionDirs?: readonly string[];
  fsBridge?: ConfigFsBridge;
  now?: () => number;
}

export class PiHarnessAdapter implements StrictHarnessAdapter {
  readonly id = "pi";
  readonly name = "Pi";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions: readonly string[] = PI_TESTED_VERSIONS;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly extraSessionDirs: readonly string[];
  private readonly fsBridge: ConfigFsBridge;
  private readonly now: () => number;

  constructor(options: PiHarnessAdapterOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.extraSessionDirs = options.extraSessionDirs ?? [];
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.now = options.now ?? Date.now;
  }

  private workspacePaths() {
    return {
      configPath: path.join(resolvePiAgentDir(this.home, this.env), "settings.json"),
      mcpConfigPath: resolvePiExtensionPath(this.home, this.env),
    };
  }

  private async transcripts(workspaceRoots: readonly string[] = []) {
    return scanPiTranscripts(
      resolvePiSessionRoots({
        home: this.home,
        env: this.env,
        extraSessionDirs: this.extraSessionDirs,
        workspaceRoots,
      }),
    );
  }

  probeInstallation(options: ProbeInstallationOptions = {}): Promise<HarnessInstallation | null> {
    return probePiInstallation({
      env: options.env ?? this.env,
      configPath: options.customConfigPath ?? resolvePiExtensionPath(this.home, this.env),
      homePath: resolvePiAgentDir(this.home, this.env),
      executablePath: options.customExecutablePath ?? options.executablePath,
    });
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    const byId = new Map<string, HarnessWorkspace>();
    for (const transcript of await this.transcripts()) {
      const workspace = toPiWorkspace(transcript.header.cwd, this.workspacePaths());
      byId.set(workspace.workspaceId, workspace);
    }
    return [...byId.values()];
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    const now = this.now();
    return (await this.transcripts([workspace.rootPath]))
      .filter((transcript) => piWorkspaceId(transcript.header.cwd) === workspace.workspaceId)
      .map((transcript) => toPiSession(transcript, workspace.workspaceId, now));
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const active = (await this.listSessions(workspace)).filter(
      (session) => session.status === "active",
    );
    if (active.length > 1) {
      throw new AmbiguousActiveSessionError(
        `Multiple Pi sessions are active in ${workspace.rootPath}`,
        { harnessId: this.id, candidateSessionIds: active.map((session) => session.sessionId) },
      );
    }
    return active[0] ?? null;
  }

  async openEventSource(session: HarnessSession, cursor?: SourceCursor): Promise<SessionEventSource> {
    return new PiSessionEventSource(session, cursor);
  }

  planMcpConfig(_workspace: HarnessWorkspace, _gatewayUrl: string): Promise<ConfigMutationPlan> {
    return planPiRegistration({
      targetPath: resolvePiExtensionPath(this.home, this.env),
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: CANONICAL_RESIN_MCP_ARGS,
      fsBridge: this.fsBridge,
    });
  }

  applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyConfigMutation(plan, this.fsBridge);
  }

  verifyMcpConfig(_workspace: HarnessWorkspace): Promise<boolean> {
    return verifyPiRegistration({
      targetPath: resolvePiExtensionPath(this.home, this.env),
      command: CANONICAL_RESIN_MCP_COMMAND,
      fsBridge: this.fsBridge,
    });
  }

  async notifyCatalogRefresh(
    _workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return createRefreshResult("native_list_change", {
      message:
        "The Resin Pi extension follows notifications/tools/list_changed and registers new tools in running sessions.",
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount:
        changeSummary.addedToolIds.length +
        changeSummary.updatedToolIds.length +
        changeSummary.removedToolIds.length,
    });
  }

  getCapabilities(): AdapterCapabilities {
    return {
      refresh: {
        supportsNativeListChange: true,
        supportsContextNudge: false,
        requiresSessionRestart: false,
        description:
          "Pi has no MCP client; Resin's extension bridges `resin mcp` and follows list_changed.",
      },
      fidelity: {
        transcriptAvailability: "file_tail",
        toolCallVisibility: "full",
        toolResultVisibility: "full",
        subagentVisibility: "none",
        mcpListChange: "supported",
        contextNudge: "unsupported",
        overallScore: 85,
        notes:
          "Append-only JSONL session tree; forks are separate files; `--no-session` runs write nothing.",
      },
      supportedTransports: ["stdio"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { treeBranches: true, sessionForks: true, noSessionCapture: false },
    };
  }
}
