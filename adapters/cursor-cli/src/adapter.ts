import {
  type AdapterCapabilities,
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  type CatalogChangeSummary,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
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
  createRefreshResult,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
} from "@resin/harness-contracts";
import { planCursorMcpConfig } from "./config-planner.js";
import {
  type CursorDiscoveryCatalog,
  type CursorDiscoveryOptions,
  type CursorUncapturedSession,
  buildCursorDiscoveryCatalog,
  probeCursorInstallation,
} from "./discovery.js";
import { isRecord } from "./guards.js";
import { CURSOR_HARNESS_ID, CURSOR_TESTED_VERSIONS, resolveCursorMcpConfigPath } from "./paths.js";
import { CursorSessionEventSource } from "./source.js";

export interface CursorHarnessAdapterOptions extends CursorDiscoveryOptions {
  fsBridge?: ConfigFsBridge;
}

/**
 * Cursor CLI adapter. Sessions are Resin's hook spool files (see `hooks.ts`), one per
 * conversation; `listUncapturedSessions` reports conversations cursor-agent persisted locally
 * without a hook capture.
 */
export class CursorHarnessAdapter implements StrictHarnessAdapter {
  readonly id = CURSOR_HARNESS_ID;
  readonly name = CURSOR_HARNESS_ID;
  readonly version = "0.1.0";
  readonly supportedHarnessVersions: readonly string[] = CURSOR_TESTED_VERSIONS;

  private readonly fsBridge: ConfigFsBridge;
  private catalog?: CursorDiscoveryCatalog;

  constructor(private readonly options: CursorHarnessAdapterOptions = {}) {
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
  }

  async probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null> {
    return probeCursorInstallation({
      ...this.options,
      env: options?.env ?? this.options.env,
      executablePath: options?.customExecutablePath ?? options?.executablePath,
      configPath: options?.customConfigPath,
    });
  }

  async listWorkspaces(): Promise<HarnessWorkspace[]> {
    this.catalog = await buildCursorDiscoveryCatalog(this.options);
    return this.catalog.workspaces;
  }

  async listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]> {
    this.catalog ??= await buildCursorDiscoveryCatalog(this.options);
    return [...(this.catalog.sessionsByWorkspace.get(workspace.workspaceId) ?? [])];
  }

  /** Conversations with a local Cursor transcript but no hook capture (e.g. before `resin init`). */
  async listUncapturedSessions(): Promise<CursorUncapturedSession[]> {
    this.catalog ??= await buildCursorDiscoveryCatalog(this.options);
    return [...this.catalog.uncaptured];
  }

  async resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null> {
    const sessions = await this.listSessions(workspace);
    return sessions.find((session) => session.status === "active") ?? sessions[0] ?? null;
  }

  async openEventSource(
    session: HarnessSession,
    cursor?: SourceCursor,
  ): Promise<SessionEventSource> {
    return new CursorSessionEventSource(session, cursor);
  }

  async planMcpConfig(
    workspace: HarnessWorkspace,
    _gatewayUrl: string,
  ): Promise<ConfigMutationPlan> {
    return planCursorMcpConfig({
      targetPath: workspace.mcpConfigPath ?? resolveCursorMcpConfigPath(this.options.home ?? ""),
      command: CANONICAL_RESIN_MCP_COMMAND,
      args: CANONICAL_RESIN_MCP_ARGS,
      fsBridge: this.fsBridge,
    });
  }

  async applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup> {
    return applyConfigMutation(plan, this.fsBridge);
  }

  async verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean> {
    const targetPath = workspace.mcpConfigPath ?? workspace.configPath;
    const content = await this.fsBridge.readFile(targetPath);
    if (content === null) return false;
    try {
      const doc: unknown = JSON.parse(content);
      const servers = isRecord(doc) ? doc.mcpServers : undefined;
      const entry = isRecord(servers) ? servers.resin : undefined;
      return isRecord(entry) && isRecognizedResinMcpEntry(entry as ConfigMetadataRecord);
    } catch {
      return false;
    }
  }

  async notifyCatalogRefresh(
    _workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    this.catalog = undefined;
    return createRefreshResult("next_session_required", {
      message:
        "cursor-agent loads MCP tools when a session starts; new Resin tools reach the next session (the gateway's meta-tools reach them immediately).",
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
        supportsNativeListChange: false,
        supportsContextNudge: false,
        requiresSessionRestart: true,
        description:
          "cursor-agent 2026.09.26 ignores MCP tools/list_changed mid-session; new tools reach the next session.",
      },
      fidelity: createObservationFidelity({
        transcriptAvailability: "file_tail",
        toolCallVisibility: "full",
        toolResultVisibility: "full",
        // Subagent conversations are captured as their own sessions; the parent link (and agent
        // kind) exists only when a subagentStart/subagentStop hook names it, and never links a
        // subagent to the parent's Task call.
        subagentVisibility: "shallow",
        mcpListChange: "requires_restart",
        contextNudge: "via_file",
        notes:
          "Captured from cursor-agent hooks: prompts, responses, per-generation usage, tool calls with ids/results, file edits, compaction, subagents, aborts.",
      }),
      supportedTransports: ["stdio", "http", "sse"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: {
        streaming: true,
        subagents: true,
        compaction: true,
        branching: false,
        commandExec: true,
        fileEdits: true,
      },
    };
  }
}
