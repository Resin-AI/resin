import type { HarnessId } from "@resin/contracts";
import type { HarnessAdapter } from "./adapter.js";
import type { ConfigFsBridge } from "./config.js";
import type { HarnessRecordDecoder } from "./decoder.js";
import type { ManagedBlockMarkers } from "./managed-block.js";
import type { ConfigMutationPlan, HarnessInstallation, HarnessWorkspace } from "./types.js";

/**
 * Version a probe reports when it found the harness but could not read its version.
 * Probes use it because `HarnessInstallation.version` is required.
 */
export const UNKNOWN_HARNESS_VERSION = "0.0.0";

/** Whether an installed harness version is one Resin qualified with recorded fixtures. */
export type HarnessVersionClassification = "tested" | "untested" | "unknown";

/**
 * Classifies an installed version against a definition's exact `testedVersions`.
 * A missing, empty, or {@link UNKNOWN_HARNESS_VERSION} version is `unknown`.
 */
export function classifyHarnessVersion(
  installed: string | null | undefined,
  testedVersions: readonly string[],
): HarnessVersionClassification {
  const version = installed?.trim();
  if (!version || version === UNKNOWN_HARNESS_VERSION) {
    return "unknown";
  }
  return testedVersions.includes(version) ? "tested" : "untested";
}

export interface HarnessProbeContext {
  /** The MCP config path resolved by {@link HarnessMcpConfigSurface.resolvePath}. */
  readonly targetPath: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fsBridge: ConfigFsBridge;
}

export interface HarnessRegistrationContext {
  readonly targetPath: string;
  readonly workspace: HarnessWorkspace;
  readonly gatewayUrl: string;
  /** Absolute Resin shim command the harness should spawn. */
  readonly command: string;
  /** Always `["mcp"]` today. */
  readonly args: readonly string[];
  readonly fsBridge: ConfigFsBridge;
}

/**
 * Where and how a harness stores MCP servers, so the CLI can plan, verify, and remove
 * Resin's stdio entry without per-harness branches.
 */
export interface HarnessMcpConfigSurface {
  /** Active global MCP config path, honoring the harness's own env overrides. */
  resolvePath(home: string, env: NodeJS.ProcessEnv): string;
  /** Every path `resin uninstall` cleans: the active path plus legacy locations. */
  uninstallPaths(home: string, env: NodeJS.ProcessEnv): readonly string[];
  /** Server key Resin registers under. */
  readonly serverKey: string;
  /** JSON object keys that may hold the server map, in lookup order. */
  readonly jsonContainerKeys: readonly string[];
  /** Paths not ending in `.json` hold Codex-style TOML (`[mcp_servers.<key>]`). */
  readonly toml: boolean;
  /** MCP transports the harness can use to reach Resin (support matrix). */
  readonly transports: readonly string[];
  planRegistration(context: HarnessRegistrationContext): Promise<ConfigMutationPlan>;
}

/** A static instruction block installed alongside the MCP registration. */
export interface HarnessGuidanceSurface {
  resolvePath(home: string, env: NodeJS.ProcessEnv): string;
  readonly markers: ManagedBlockMarkers;
  /** Block body placed between the markers (see `applyManagedBlock`). */
  readonly body: string;
}

/** Connection to one MCP server declared in the harness's own configuration. */
export interface HarnessMcpServerDescriptor {
  readonly name: string;
  readonly transport:
    | {
        readonly kind: "stdio";
        readonly command: string;
        readonly args?: string[];
        readonly env?: Record<string, string>;
      }
    | { readonly kind: "http"; readonly url: string };
}

export interface HarnessNativeToolRequest {
  name: string;
  parameters: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
}

export interface HarnessNativeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Re-executes a recorded harness built-in tool (not an MCP tool) on this device. */
export type HarnessNativeToolInvoker = (
  request: HarnessNativeToolRequest,
) => Promise<HarnessNativeToolResult>;

/**
 * Everything the CLI and observer need to support one harness. Each adapter package exports
 * one definition; app registries are plain arrays of them.
 */
export interface HarnessDefinition {
  readonly id: HarnessId;
  /** Installer/uninstall name, e.g. "Codex CLI". */
  readonly displayName: string;
  /** Compact name for `resin status` and the support matrix. */
  readonly shortName: string;
  readonly adapterPackage: string;
  /** Exact versions qualified with recorded fixtures. */
  readonly testedVersions: readonly string[];
  /** Known capture/registration limitations, surfaced to users as-is. */
  readonly knownLimits: readonly string[];
  probeInstallation(context: HarnessProbeContext): Promise<HarnessInstallation | null>;
  readonly mcpConfig: HarnessMcpConfigSurface;
  readonly guidance?: HarnessGuidanceSurface;
  /** Session discovery adapter used by the observer (historical sessions included). */
  createAdapter(): HarnessAdapter;
  createDecoder(): HarnessRecordDecoder;
  /**
   * `observation-window`: backfill only sessions started while Resin observed.
   * `file-activity`: backfill every session; capture inactive ones whose transcript changed
   * after observation started.
   */
  readonly sessionCapture: "observation-window" | "file-activity";
  /** Resolves an MCP server the harness itself declares, for replaying recorded MCP steps. */
  resolveMcpServer?(name: string, workspaceRoot: string): HarnessMcpServerDescriptor | undefined;
  readonly nativeToolInvoker?: HarnessNativeToolInvoker;
}
