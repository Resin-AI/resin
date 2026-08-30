import path from "node:path";
import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
  DEFAULT_RESIN_GATEWAY_URL,
  type HarnessWorkspace,
  NodeConfigFsBridge,
  applyConfigMutation,
  computeConfigHash,
  migrateJsonMcpServers,
  planConfigMutation,
  rollbackConfigMutation,
  verifyConfigIntegrity,
} from "@resin/harness-contracts";
import { resolveOmpHome } from "./discovery.js";

export const DEFAULT_OMP_CONFIG_FILENAME = path.join("agent", "mcp.json");
export const DEFAULT_OMP_MCP_CONFIG_PATH = path.join("agent", "mcp.json");
export const DEFAULT_GATEWAY_SERVER_NAME = CANONICAL_RESIN_MCP_SERVER_KEY;

export interface PlanOmpMcpConfigOptions {
  workspace?: HarnessWorkspace;
  gatewayUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  ompHome?: string;
  customConfigPath?: string;
  fsBridge?: ConfigFsBridge;
  serverName?: string;
  serverType?: "stdio" | "sse" | "http" | "websocket";
  type?: "stdio" | "sse" | "http" | "websocket";
  url?: string;
}

export interface VerifyOmpMcpConfigOptions {
  workspace?: HarnessWorkspace;
  gatewayUrl?: string;
  expectedUrl?: string;
  command?: string;
  expectedCommand?: string;
  fsBridge?: ConfigFsBridge;
  customConfigPath?: string;
  ompHome?: string;
  serverName?: string;
}

export interface OmpMcpServerConfig {
  type?: "sse" | "stdio" | "websocket" | "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: string;
  [key: string]: string | number | boolean | null | undefined | string[] | Record<string, string>;
}

export interface OmpConfigDoc {
  $schema?: string;
  mcpServers?: Record<string, OmpMcpServerConfig>;
  [key: string]:
    | string
    | number
    | boolean
    | null
    | undefined
    | string[]
    | Record<string, OmpMcpServerConfig>
    | Record<string, string>;
}

/**
 * Resolves the target configuration path for an OMP workspace or global install.
 * Prefers ~/.omp/agent/mcp.json (OMP v17.3.8+ format).
 */
export function resolveOmpConfigPath(
  workspace?: HarnessWorkspace,
  options?: { customConfigPath?: string; ompHome?: string },
): string {
  if (options?.customConfigPath) {
    return path.resolve(options.customConfigPath);
  }
  if (workspace?.mcpConfigPath) {
    return path.resolve(workspace.mcpConfigPath);
  }
  if (workspace?.rootPath) {
    return path.resolve(workspace.rootPath, ".omp", "agent", "mcp.json");
  }
  if (workspace?.configPath) {
    return path.resolve(workspace.configPath);
  }
  const ompHome = resolveOmpHome({ customHome: options?.ompHome });
  return path.resolve(ompHome, "agent", "mcp.json");
}

export const resolveOmpMcpConfigPath = resolveOmpConfigPath;

/**
 * Plans a configuration mutation that registers the Resin Gateway in OMP's MCP configuration.
 * Preserves all existing extensions, user settings, $schema, and other MCP servers.
 */
export async function planOmpMcpConfig(
  options: PlanOmpMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? new NodeConfigFsBridge();
  const targetPath = resolveOmpConfigPath(options.workspace, {
    customConfigPath: options.customConfigPath,
    ompHome: options.ompHome,
  });

  const serverName = options.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
  const currentContent = await fsBridge.readFile(targetPath);

  let currentConfig: OmpConfigDoc = {};
  if (currentContent && currentContent.trim().length > 0) {
    try {
      const parsed = JSON.parse(currentContent);
      if (parsed instanceof Object && !Array.isArray(parsed)) {
        // SAFETY: Parsed JSON represents an OMP configuration document preserving existing fields.
        currentConfig = parsed as OmpConfigDoc;
      }
    } catch {
      currentConfig = {};
    }
  }

  const existingServers: Record<string, OmpMcpServerConfig> =
    currentConfig.mcpServers &&
    currentConfig.mcpServers instanceof Object &&
    !Array.isArray(currentConfig.mcpServers)
      ? { ...currentConfig.mcpServers }
      : {};

  const explicitType = options.serverType ?? options.type;
  let serverEntry: OmpMcpServerConfig;

  if (options.command !== undefined) {
    serverEntry = {
      type: explicitType ?? "stdio",
      command: options.command,
      args: options.args ?? [],
    };
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
    if (options.gatewayUrl !== undefined) {
      serverEntry.url = options.gatewayUrl;
    }
    if (options.url !== undefined) {
      serverEntry.url = options.url;
    }
  } else if (options.gatewayUrl !== undefined || options.url !== undefined) {
    serverEntry = {
      type: explicitType ?? "sse",
      url: options.gatewayUrl ?? options.url,
    };
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
  } else {
    serverEntry = {
      type: explicitType ?? "sse",
      url: DEFAULT_RESIN_GATEWAY_URL,
    };
    if (options.env !== undefined) {
      serverEntry.env = options.env;
    }
  }
  const updatedServers = migrateJsonMcpServers(
    existingServers,
    serverEntry,
    options.gatewayUrl,
    serverName,
  );

  const updatedConfig: OmpConfigDoc = {
    ...currentConfig,
    mcpServers: updatedServers,
  };

  const plannedContent = `${JSON.stringify(updatedConfig, null, 2)}\n`;

  return planConfigMutation({
    harnessId: "omp",
    targetPath,
    currentContent,
    plannedContent,
    description: `Register Resin Gateway MCP server "${serverName}" in OMP configuration`,
    metadata: {
      changesSummary: `Add/update mcpServers.${serverName}`,
    },
  });
}

/**
 * Atomically applies a planned OMP MCP configuration mutation with automatic backup creation.
 */
export async function applyOmpMcpConfig(
  plan: ConfigMutationPlan,
  fsBridge?: ConfigFsBridge,
): Promise<ConfigBackup> {
  const bridge = fsBridge ?? new NodeConfigFsBridge();
  return applyConfigMutation(plan, bridge);
}

/**
 * Verifies that OMP configuration correctly contains the Resin Gateway MCP registration.
 */
export async function verifyOmpMcpConfig(
  optionsOrWorkspace: VerifyOmpMcpConfigOptions | HarnessWorkspace,
  options?: VerifyOmpMcpConfigOptions,
): Promise<boolean> {
  let mergedOptions: VerifyOmpMcpConfigOptions;
  if ("workspaceId" in optionsOrWorkspace || "harnessId" in optionsOrWorkspace) {
    mergedOptions = {
      // SAFETY: optionsOrWorkspace has workspaceId or harnessId confirming it is a HarnessWorkspace.
      workspace: optionsOrWorkspace as HarnessWorkspace,
      ...options,
    };
  } else {
    // SAFETY: optionsOrWorkspace without workspaceId/harnessId is already a VerifyOmpMcpConfigOptions.
    mergedOptions = optionsOrWorkspace as VerifyOmpMcpConfigOptions;
  }

  const bridge = mergedOptions.fsBridge ?? new NodeConfigFsBridge();
  const targetPath = resolveOmpConfigPath(mergedOptions.workspace, {
    customConfigPath: mergedOptions.customConfigPath,
    ompHome: mergedOptions.ompHome,
  });

  const content = await bridge.readFile(targetPath);
  if (!content) return false;

  try {
    const parsedObj = JSON.parse(content);
    if (
      !parsedObj ||
      Object.prototype.toString.call(parsedObj) !== "[object Object]" ||
      Array.isArray(parsedObj)
    ) {
      return false;
    }
    // SAFETY: Parsed JSON document represents an OMP config containing mcpServers.
    const parsed = parsedObj as OmpConfigDoc;
    const mcpServers = parsed.mcpServers;
    if (
      !mcpServers ||
      Object.prototype.toString.call(mcpServers) !== "[object Object]" ||
      Array.isArray(mcpServers)
    ) {
      return false;
    }

    const serverName = mergedOptions.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
    const entry = mcpServers[serverName];
    if (
      !entry ||
      Object.prototype.toString.call(entry) !== "[object Object]" ||
      Array.isArray(entry)
    ) {
      return false;
    }

    const expectedUrl = mergedOptions.expectedUrl ?? mergedOptions.gatewayUrl;
    const expectedCommand = mergedOptions.expectedCommand ?? mergedOptions.command;

    if (expectedUrl !== undefined && entry.url !== expectedUrl) {
      return false;
    }

    if (expectedCommand !== undefined && entry.command !== expectedCommand) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Rolls back a previous OMP configuration mutation from backup.
 */
export async function rollbackOmpMcpConfig(
  backup: ConfigBackup,
  fsBridge?: ConfigFsBridge,
): Promise<void> {
  const bridge = fsBridge ?? new NodeConfigFsBridge();
  await rollbackConfigMutation(backup, bridge);
}

export { computeConfigHash, verifyConfigIntegrity };
