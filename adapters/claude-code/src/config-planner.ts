import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigBackup,
  type ConfigFsBridge,
  type ConfigMetadataValue,
  type ConfigMutationPlan,
  type HarnessWorkspace,
  applyConfigMutation,
  defaultFsBridge,
  migrateJsonMcpServers,
  planConfigMutation,
  rollbackConfigMutation,
} from "@resin/harness-contracts";

/**
 * Standard server definition for Resin Gateway in Claude Code.
 */
export interface ClaudeMcpServerConfig {
  type?: "sse" | "stdio" | "http" | "websocket";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: ConfigMetadataValue;
}

/**
 * Standard shape of Claude Code config JSON (claude.json, mcp_settings.json, etc.).
 */
export interface ClaudeConfigDoc {
  mcpServers?: Record<string, ClaudeMcpServerConfig>;
}

/**
 * Generates planned JSON configuration content adding or updating the resin MCP server.
 */
export function generatePlannedClaudeConfig(
  currentContent: string | null,
  gatewayUrl?: string,
  serverKey = CANONICAL_RESIN_MCP_SERVER_KEY,
  command = CANONICAL_RESIN_MCP_COMMAND,
): string {
  let doc: ClaudeConfigDoc = {};

  if (currentContent && currentContent.trim().length > 0) {
    try {
      const parsed = JSON.parse(currentContent);
      if (parsed instanceof Object && !Array.isArray(parsed)) {
        // SAFETY: The JSON document is an object container preserved across configuration planning.
        doc = parsed as ClaudeConfigDoc;
      }
    } catch {
      // If parsing fails, preserve content under fallback or start fresh
      doc = {};
    }
  }

  const existingServers: Record<string, ClaudeMcpServerConfig> =
    doc.mcpServers && doc.mcpServers instanceof Object && !Array.isArray(doc.mcpServers)
      ? { ...doc.mcpServers }
      : {};

  // Configure resin gateway MCP endpoint
  const serverConfig: ClaudeMcpServerConfig = {
    command,
    args: [...CANONICAL_RESIN_MCP_ARGS],
  };
  doc.mcpServers = migrateJsonMcpServers(existingServers, serverConfig, gatewayUrl, serverKey);
  // Format with consistent 2-space indentation and trailing newline
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Plans an atomic mutation to register the Resin Gateway in Claude Code's MCP config.
 */
export async function planClaudeMcpConfig(
  workspace: HarnessWorkspace,
  gatewayUrl?: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
  command = CANONICAL_RESIN_MCP_COMMAND,
): Promise<ConfigMutationPlan> {
  const targetPath = workspace.mcpConfigPath || workspace.configPath;
  const currentContent = await fsBridge.readFile(targetPath);
  const plannedContent = generatePlannedClaudeConfig(
    currentContent,
    gatewayUrl,
    CANONICAL_RESIN_MCP_SERVER_KEY,
    command,
  );

  return planConfigMutation({
    harnessId: "claude-code",
    targetPath,
    currentContent,
    plannedContent,
    description: "Register Resin Gateway in Claude Code MCP settings",
  });
}
/**
 * Applies a planned MCP configuration mutation atomically and returns a backup descriptor.
 */
export async function applyClaudeMcpConfig(
  plan: ConfigMutationPlan,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ConfigBackup> {
  return await applyConfigMutation(plan, fsBridge);
}

/**
 * Restores a configuration file byte-for-byte from a backup.
 */
export async function rollbackClaudeMcpConfig(
  backup: ConfigBackup,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<void> {
  await rollbackConfigMutation(backup, fsBridge);
}

/**
 * Verifies whether the workspace's MCP configuration contains the expected Resin MCP registration.
 */
export async function verifyClaudeMcpConfig(
  workspace: HarnessWorkspace,
  _expectedGatewayUrl?: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
  expectedCommand = CANONICAL_RESIN_MCP_COMMAND,
): Promise<boolean> {
  const targetPath = workspace.mcpConfigPath || workspace.configPath;
  const exists = await fsBridge.exists(targetPath);
  if (!exists) return false;

  try {
    const content = await fsBridge.readFile(targetPath);
    if (content === null) return false;
    const parsed = JSON.parse(content);
    if (!(parsed instanceof Object) || Array.isArray(parsed)) {
      return false;
    }
    // SAFETY: The parsed configuration file is verified as an object before reading mcpServers.
    const doc = parsed as ClaudeConfigDoc;
    if (!doc.mcpServers || !(doc.mcpServers instanceof Object) || Array.isArray(doc.mcpServers)) {
      return false;
    }
    const entry = doc.mcpServers[CANONICAL_RESIN_MCP_SERVER_KEY] || doc.mcpServers.resin;
    if (!entry || !(entry instanceof Object) || Array.isArray(entry)) {
      return false;
    }

    if (entry.url !== undefined || (entry.type !== undefined && entry.type !== "stdio")) {
      return false;
    }

    if (entry.command !== expectedCommand) {
      return false;
    }

    if (
      !Array.isArray(entry.args) ||
      entry.args.length === 0 ||
      entry.args[0] !== CANONICAL_RESIN_MCP_ARGS[0]
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
