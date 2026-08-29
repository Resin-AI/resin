import path from "node:path";
import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMutationPlan,
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
  serverType?: "stdio" | "sse" | "http";
  type?: "stdio" | "sse" | "http" | string;
  url?: string;
}

export interface VerifyOmpMcpConfigOptions {
  workspace?: HarnessWorkspace;
  gatewayUrl?: string;
  command?: string;
  fsBridge?: ConfigFsBridge;
  customConfigPath?: string;
  ompHome?: string;
  serverName?: string;
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

  let currentConfig: Record<string, unknown> = {};
  if (currentContent !== null && currentContent.trim().length > 0) {
    try {
      currentConfig = JSON.parse(currentContent) as Record<string, unknown>;
    } catch {
      currentConfig = {};
    }
  }

  // Preserve existing mcpServers, $schema, extensions, tools, settings, etc.
  const existingMcpServers =
    typeof currentConfig.mcpServers === "object" && currentConfig.mcpServers !== null
      ? { ...(currentConfig.mcpServers as Record<string, unknown>) }
      : {};

  const explicitType = options.serverType ?? options.type;
  let serverEntry: Record<string, unknown>;

  if (options.command !== undefined) {
    serverEntry = {
      type: explicitType ?? "stdio",
      command: options.command,
      args: options.args ?? [],
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.gatewayUrl !== undefined ? { url: options.gatewayUrl } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
    };
  } else if (options.gatewayUrl !== undefined || options.url !== undefined) {
    serverEntry = {
      type: explicitType ?? "sse",
      url: options.gatewayUrl ?? options.url,
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    };
  } else {
    serverEntry = {
      type: explicitType ?? "stdio",
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    };
  }

  const updatedMcpServers = migrateJsonMcpServers(
    existingMcpServers,
    serverEntry,
    options.gatewayUrl ?? options.url,
    serverName,
  );

  const updatedConfig: Record<string, unknown> = {
    ...(currentConfig.$schema !== undefined ? { $schema: currentConfig.$schema } : {}),
    ...currentConfig,
    mcpServers: updatedMcpServers,
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
  const mergedOptions: VerifyOmpMcpConfigOptions =
    "workspaceId" in optionsOrWorkspace
      ? { workspace: optionsOrWorkspace as HarnessWorkspace, ...options }
      : optionsOrWorkspace;

  const bridge = mergedOptions.fsBridge ?? new NodeConfigFsBridge();
  const targetPath = resolveOmpConfigPath(mergedOptions.workspace, {
    customConfigPath: mergedOptions.customConfigPath,
    ompHome: mergedOptions.ompHome,
  });

  const content = await bridge.readFile(targetPath);
  if (content === null) {
    return false;
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || typeof mcpServers !== "object") {
      return false;
    }

    const serverName = mergedOptions.serverName ?? DEFAULT_GATEWAY_SERVER_NAME;
    const serverEntry = mcpServers[serverName] as Record<string, unknown> | undefined;
    if (!serverEntry || typeof serverEntry !== "object") {
      return false;
    }

    if (mergedOptions.gatewayUrl) {
      const entryUrl = serverEntry.url ?? serverEntry.endpoint;
      return entryUrl === mergedOptions.gatewayUrl;
    }

    if (mergedOptions.command) {
      return serverEntry.command === mergedOptions.command;
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
