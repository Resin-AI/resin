import {
  type AdapterCapabilities,
  CANONICAL_RESIN_MCP_ARGS,
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
  TIER1_HIGH_FIDELITY,
} from "@resin/harness-contracts";
import {
  applyOmpMcpConfig,
  planOmpMcpConfig,
  rollbackOmpMcpConfig,
  verifyOmpMcpConfig,
} from "./config-planner.js";
import { discoverOmpSessions, discoverOmpWorkspaces, probeOmpInstallation } from "./discovery.js";
import { getOmpRefreshCapability, handleOmpCatalogRefresh } from "./refresh.js";
import { OmpSessionEventSource } from "./source.js";

/**
 * Harness adapter for Oh My Pi (OMP) agent harness.
 * Implements high-fidelity observation, session tailing, MCP configuration, and catalog refresh.
 */
export interface OmpHarnessAdapterOptions {
  fsBridge?: ConfigFsBridge;
}

export class OmpHarnessAdapter implements StrictHarnessAdapter {
  readonly id = "omp";
  readonly name = "omp";
  readonly version = "0.1.0";
  readonly supportedHarnessVersions: readonly string[] = ["^0.1.0", ">=0.1.0", ">=0.0.1", "*"];

  private readonly fsBridge?: ConfigFsBridge;

  constructor(options?: OmpHarnessAdapterOptions) {
    this.fsBridge = options?.fsBridge;
  }
  /**
   * Probes the system for an OMP installation and checks its readiness.
   */
  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return probeOmpInstallation(options);
  }

  /**
   * Discovers registered and active OMP workspaces.
   */
  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    return discoverOmpWorkspaces();
  }

  /**
   * Convenience alias for listWorkspaces.
   */
  async discoverWorkspaces(): Promise<HarnessWorkspace[]> {
    return this.listWorkspaces();
  }

  /**
   * Discovers sessions and JSONL transcripts within a given OMP workspace.
   */
  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    return discoverOmpSessions(workspace);
  }

  /**
   * Convenience alias for listSessions.
   */
  async discoverSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    return this.listSessions(workspace);
  }

  /**
   * Resolves the currently active session for a workspace, if any.
   */
  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    const active = sessions.find((s) => s.status === "active");
    return active ?? (sessions.length > 0 ? sessions[0] : null);
  }

  /**
   * Creates an event source that tails the append-only JSONL session file.
   */
  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new OmpSessionEventSource(session, cursor);
  }

  /**
   * Convenience alias for openEventSource.
   */
  async createEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return this.openEventSource(session, cursor);
  }

  /**
   * Proposes an atomic MCP configuration mutation to wire the Resin Gateway.
   */
  async planMcpConfig(
    workspace: HarnessWorkspace,
    gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return planOmpMcpConfig({
      workspace,
      gatewayUrl,
      fsBridge: this.fsBridge,
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: [...CANONICAL_RESIN_MCP_ARGS],
    });
  }

  /**
   * Atomically applies the MCP mutation plan with backup preservation.
   */
  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyOmpMcpConfig(plan, this.fsBridge);
  }

  /**
   * Verifies that the workspace or global OMP config is properly connected to Gateway.
   */
  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    return verifyOmpMcpConfig({ workspace, fsBridge: this.fsBridge });
  }

  /**
   * Reverts a previously applied configuration mutation.
   */
  async rollbackMcpConfig(backup: ConfigBackup): Promise<void> {
    return rollbackOmpMcpConfig(backup, this.fsBridge);
  }

  /**
   * Notifies OMP of tool catalog updates via native list change or context nudge.
   */
  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    return handleOmpCatalogRefresh(workspace, changeSummary);
  }

  /**
   * Returns complete capability profile for Oh My Pi adapter.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      refresh: getOmpRefreshCapability(),
      fidelity: TIER1_HIGH_FIDELITY,
      supportedTransports: ["stdio", "sse", "websocket", "http"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: {
        streaming: true,
        subagents: true,
        compaction: true,
        branching: true,
        commandExec: true,
        fileEdits: true,
      },
    };
  }
}

/**
 * Backward compatibility alias.
 */
export const OmpAdapter = OmpHarnessAdapter;
