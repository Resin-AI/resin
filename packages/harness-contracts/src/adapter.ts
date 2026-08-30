import type { RefreshResult } from "./refresh.js";
import type { SessionEventSource } from "./source.js";
import type {
  AdapterCapabilities,
  CatalogChangeSummary,
  ConfigBackup,
  ConfigMutationPlan,
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  SourceCursor,
} from "./types.js";

/**
 * Options passed when probing for a harness installation.
 */
export interface ProbeInstallationOptions {
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
}

export type ToolExecutionInputValue =
  | string
  | boolean
  | null
  | undefined
  | ToolExecutionInputRecord
  | ToolExecutionInputValue[];

export interface ToolExecutionInputRecord {
  [key: string]: ToolExecutionInputValue;
}

export type ToolExecutionResult = ToolExecutionInputValue;

/**
 * Core contract that every AI harness adapter must implement.
 */
export interface HarnessAdapter {
  /**
   * Unique identifier for this adapter (e.g. "omp", "claude-code", "codex-cli", "fake").
   */
  readonly id?: string;

  /**
   * Display name or legacy adapter name.
   */
  readonly name?: string;

  /**
   * Version of the adapter package itself.
   */
  readonly version: string;

  /**
   * Semantic version range or list of harness versions supported by this adapter.
   */
  readonly supportedHarnessVersions?: readonly string[];

  /**
   * Probes the local workstation to detect whether the target AI harness is installed,
   * checking executables, config paths, and versions.
   */
  probeInstallation?(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null>;

  /**
   * Discovers and enumerates all workspaces / repositories associated with this harness.
   */
  listWorkspaces?(): Promise<HarnessWorkspace[]>;

  /**
   * Enumerates active and historical sessions within a specific workspace.
   */
  listSessions?(workspace: HarnessWorkspace): Promise<HarnessSession[]>;

  /**
   * Resolves the currently active / running session for a workspace, if one exists.
   * Throws AmbiguousActiveSessionError if multiple conflicting sessions appear active.
   */
  resolveActiveSession?(workspace: HarnessWorkspace): Promise<HarnessSession | null>;

  /**
   * Opens an event source to stream and read raw transcript records from a session.
   *
   * @param session Target session to observe.
   * @param cursor Optional cursor checkpoint to resume from.
   */
  openEventSource?(session: HarnessSession, cursor?: SourceCursor): Promise<SessionEventSource>;

  /**
   * Generates a planned mutation to wire the Resin Gateway MCP server
   * into the harness's workspace or global configuration.
   */
  planMcpConfig?(workspace: HarnessWorkspace, gatewayUrl: string): Promise<ConfigMutationPlan>;

  /**
   * Applies a planned configuration mutation atomically with backup creation.
   */
  applyMcpConfig?(plan: ConfigMutationPlan): Promise<ConfigBackup>;

  /**
   * Verifies that the harness configuration is correctly wired to Resin Gateway.
   */
  verifyMcpConfig?(workspace: HarnessWorkspace): Promise<boolean>;

  /**
   * Notifies the harness that the tool catalog has evolved (tools added, updated, or removed).
   */
  notifyCatalogRefresh?(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult>;

  /**
   * Returns the capability profile, fidelity rating, and supported refresh mechanisms of this adapter.
   */
  getCapabilities?(): AdapterCapabilities;

  // Legacy compatibility methods
  initialize?(): Promise<void>;
  execute?(
    tool: { id: string; name: string; version: string; description: string },
    input: ToolExecutionInputRecord,
  ): Promise<ToolExecutionResult>;
}

/**
 * Strict contract interface where all adapter capabilities and lifecycle methods are required.
 */
export interface StrictHarnessAdapter extends HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly supportedHarnessVersions: readonly string[];
  probeInstallation(options?: ProbeInstallationOptions): Promise<HarnessInstallation | null>;
  listWorkspaces(): Promise<HarnessWorkspace[]>;
  listSessions(workspace: HarnessWorkspace): Promise<HarnessSession[]>;
  resolveActiveSession(workspace: HarnessWorkspace): Promise<HarnessSession | null>;
  openEventSource(session: HarnessSession, cursor?: SourceCursor): Promise<SessionEventSource>;
  planMcpConfig(workspace: HarnessWorkspace, gatewayUrl: string): Promise<ConfigMutationPlan>;
  applyMcpConfig(plan: ConfigMutationPlan): Promise<ConfigBackup>;
  verifyMcpConfig(workspace: HarnessWorkspace): Promise<boolean>;
  notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult>;
  getCapabilities(): AdapterCapabilities;
}
