import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
  type ConfigMutationPlan,
  HarnessError,
  HarnessErrorCode,
  isRecognizedResinMcpEntry,
  migrateJsonMcpServers,
  planConfigMutation,
} from "@resin/harness-contracts";
import { COPILOT_HARNESS_ID } from "./discovery.js";

/**
 * Resin's entry in `mcp-config.json`. `type: "local"` is Copilot's name for stdio (what
 * `copilot mcp add resin -- <command> mcp` writes on 1.0.88). `tools` is left to the user:
 * Copilot exposes every tool when it is absent (`copilot mcp get` reports "Tools: * (all)").
 * Tool approval stays with Copilot's own permission settings.
 */
export function copilotResinServerEntry(
  command: string,
  args: readonly string[] = CANONICAL_RESIN_MCP_ARGS,
): ConfigMetadataRecord {
  return { type: "local", command, args: [...args] };
}

function parseConfigDocument(content: string | null, targetPath: string): ConfigMetadataRecord {
  if (content === null || content.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    // Never rewrite a file Copilot itself would fail to load; the user must fix it first.
    throw new HarnessError(
      HarnessErrorCode.MALFORMED_RECORD,
      `Copilot MCP config ${targetPath} is not valid JSON`,
      {
        harnessId: COPILOT_HARNESS_ID,
        cause,
      },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarnessError(
      HarnessErrorCode.MALFORMED_RECORD,
      `Copilot MCP config ${targetPath} is not a JSON object`,
      {
        harnessId: COPILOT_HARNESS_ID,
      },
    );
  }
  return parsed as ConfigMetadataRecord;
}

/**
 * Returns the next `mcp-config.json` content with Resin registered. Every other key and server
 * is preserved; legacy Resin aliases are folded into the canonical `resin` entry.
 */
export function renderCopilotMcpConfig(
  currentContent: string | null,
  targetPath: string,
  command: string,
  args: readonly string[] = CANONICAL_RESIN_MCP_ARGS,
  gatewayUrl?: string,
): string {
  const doc = parseConfigDocument(currentContent, targetPath);
  const servers =
    doc.mcpServers !== null && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
      ? (doc.mcpServers as Record<string, ConfigMetadataRecord>)
      : {};
  const next = {
    ...doc,
    mcpServers: migrateJsonMcpServers(
      servers,
      copilotResinServerEntry(command, args),
      gatewayUrl,
      CANONICAL_RESIN_MCP_SERVER_KEY,
    ),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export interface PlanCopilotMcpRegistrationOptions {
  targetPath: string;
  command: string;
  args?: readonly string[];
  gatewayUrl?: string;
  fsBridge: ConfigFsBridge;
}

export async function planCopilotMcpRegistration(
  options: PlanCopilotMcpRegistrationOptions,
): Promise<ConfigMutationPlan> {
  const currentContent = await options.fsBridge.readFile(options.targetPath);
  return planConfigMutation({
    harnessId: COPILOT_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent: renderCopilotMcpConfig(
      currentContent,
      options.targetPath,
      options.command,
      options.args,
      options.gatewayUrl,
    ),
    description: "Register Resin Gateway in GitHub Copilot CLI mcp-config.json",
  });
}

/**
 * True when `targetPath` registers Resin as a local stdio server running `<command> mcp`.
 * `type` may be "local" (what Copilot writes) or "stdio" (which Copilot also accepts).
 */
export async function verifyCopilotMcpRegistration(options: {
  targetPath: string;
  command: string;
  fsBridge: ConfigFsBridge;
}): Promise<boolean> {
  const content = await options.fsBridge.readFile(options.targetPath);
  if (content === null) return false;
  let doc: ConfigMetadataRecord;
  try {
    doc = parseConfigDocument(content, options.targetPath);
  } catch {
    return false;
  }
  const servers = doc.mcpServers as Record<string, ConfigMetadataRecord> | undefined;
  const entry = servers?.[CANONICAL_RESIN_MCP_SERVER_KEY];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const type = entry.type;
  const tools = entry.tools;
  return (
    (type === undefined || type === "local" || type === "stdio") &&
    entry.url === undefined &&
    entry.command === options.command &&
    Array.isArray(entry.args) &&
    entry.args.length === CANONICAL_RESIN_MCP_ARGS.length &&
    entry.args.every((arg, index) => arg === CANONICAL_RESIN_MCP_ARGS[index]) &&
    // Copilot treats a missing `tools` as all tools; an explicit list must include "*".
    (tools === undefined || (Array.isArray(tools) && tools.includes("*")))
  );
}

/**
 * Removes every recognized Resin server from `targetPath`, keeping all other content. Resolves
 * true when the file changed. The file is left in place (even with an empty server map) because
 * it belongs to the user.
 */
export async function removeCopilotMcpRegistration(options: {
  targetPath: string;
  fsBridge: ConfigFsBridge;
  dryRun?: boolean;
}): Promise<boolean> {
  const content = await options.fsBridge.readFile(options.targetPath);
  if (content === null) return false;
  let doc: ConfigMetadataRecord;
  try {
    doc = parseConfigDocument(content, options.targetPath);
  } catch {
    return false;
  }
  const servers = doc.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return false;
  const kept = Object.fromEntries(
    Object.entries(servers as Record<string, ConfigMetadataRecord>).filter(
      ([key, entry]) => key !== CANONICAL_RESIN_MCP_SERVER_KEY && !isRecognizedResinMcpEntry(entry),
    ),
  );
  if (Object.keys(kept).length === Object.keys(servers).length) return false;
  if (!options.dryRun) {
    await options.fsBridge.writeFile(
      options.targetPath,
      `${JSON.stringify({ ...doc, mcpServers: kept }, null, 2)}\n`,
    );
  }
  return true;
}
