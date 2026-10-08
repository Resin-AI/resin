import type { HarnessId } from "@resin/contracts";
import type { HarnessAdapter } from "./adapter.js";
import type { ConfigFsBridge } from "./config.js";
import type { HarnessRecordDecoder } from "./decoder.js";
import type { ManagedBlockMarkers, ManagedBlockResult } from "./managed-block.js";
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
  /** `["mcp"]`, or `[<resin.mjs>, "mcp"]` when `command` is `node.exe` on native Windows. */
  readonly args: readonly string[];
  readonly fsBridge: ConfigFsBridge;
}

/** Context for checking or removing Resin's registration outside the planning path. */
export interface HarnessRegistrationCheckContext {
  readonly targetPath: string;
  /** Absolute Resin shim command the harness should spawn. */
  readonly command: string;
  /**
   * Arguments the harness passes to `command`; `["mcp"]` when omitted. On native Windows the
   * command is `node.exe` and the arguments are `[<resin.mjs>, "mcp"]` (see `resolveResinMcpLaunch`).
   */
  readonly args?: readonly string[];
  readonly fsBridge: ConfigFsBridge;
}

export interface HarnessInstallContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fsBridge: ConfigFsBridge;
  readonly dryRun?: boolean;
}

/**
 * How the harness stores its MCP registration:
 * - `json`: a JSON object whose server map lives under one of `jsonContainerKeys`.
 * - `codex-toml`: Codex-style TOML (`[mcp_servers.<key>]`); a path ending in `.json` is `json`.
 * - `owned-file`: a file wholly owned by Resin (e.g. an extension bridging `resin mcp`); the CLI
 *   never parses it, so `verifyRegistration` and `removeRegistration` are required.
 */
export type HarnessMcpConfigFormat = "json" | "codex-toml" | "owned-file";

/**
 * Where and how a harness stores MCP servers, so the CLI can plan, verify, and remove
 * Resin's stdio entry without per-harness branches.
 */
export interface HarnessMcpConfigSurface {
  /** Active global MCP config path, honoring the harness's own env overrides. */
  resolvePath(home: string, env: NodeJS.ProcessEnv): string;
  /** Every path `resin uninstall` cleans: the active path plus legacy locations. */
  uninstallPaths(home: string, env: NodeJS.ProcessEnv): readonly string[];
  readonly format: HarnessMcpConfigFormat;
  /** Server key Resin registers under. */
  readonly serverKey: string;
  /** JSON object keys that may hold the server map, in lookup order (`json` format). */
  readonly jsonContainerKeys: readonly string[];
  /** MCP transports the harness can use to reach Resin (support matrix). */
  readonly transports: readonly string[];
  planRegistration(context: HarnessRegistrationContext): Promise<ConfigMutationPlan>;
  /**
   * Whether `targetPath` holds Resin's expected registration for `command`. Omit to use the
   * generic check: the entry under `serverKey` is `{ command, args: ["mcp"] }` with no `url`
   * and `type` absent or "stdio". Required for `owned-file` or any other entry shape.
   */
  verifyRegistration?(context: HarnessRegistrationCheckContext): Promise<boolean>;
  /**
   * Removes Resin's registration for `resin uninstall`; resolves true when anything changed.
   * Omit to use the generic removal of recognized Resin entries under `jsonContainerKeys` (and
   * Codex TOML sections) in every `uninstallPaths` file. Required for `owned-file`.
   */
  removeRegistration?(context: HarnessInstallContext): Promise<boolean>;
}

/**
 * An additional Resin-owned install artifact (e.g. capture hooks) managed next to the MCP
 * registration: installed by `resin init`/reconcile after registration, removed by uninstall.
 */
export interface HarnessInstallExtension {
  /** Short label used in diagnostics, e.g. "capture hooks". */
  readonly name: string;
  install(context: HarnessInstallContext): Promise<readonly ManagedBlockResult[]>;
  uninstall(context: HarnessInstallContext): Promise<readonly ManagedBlockResult[]>;
  verify(context: Omit<HarnessInstallContext, "dryRun">): Promise<boolean>;
  /**
   * Files this extension writes. The daemon fingerprints them (presence and mtime) next to the
   * MCP config, so a foreign rewrite triggers a repair within seconds instead of at the next
   * hourly check. Omit when the extension only writes files already fingerprinted.
   */
  watchPaths?(home: string, env: NodeJS.ProcessEnv): readonly string[];
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
 * The install-side half of a harness: what the CLI installer, status, uninstall, and reconciler
 * need. Adapter packages export it from their `./install` subpath, which must not load session
 * discovery or decoding, so the standalone install helper stays small.
 */
export interface HarnessInstallDefinition {
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
  /** Extra Resin-owned artifacts installed after registration and removed on uninstall. */
  readonly installExtensions?: readonly HarnessInstallExtension[];
}

/**
 * Everything the CLI and observer need to support one harness. Each adapter package exports
 * one definition; app registries are plain arrays of them.
 */
export interface HarnessDefinition extends HarnessInstallDefinition {
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
