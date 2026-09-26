import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
  type ConfigMutationPlan,
  type HarnessRegistrationContext,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
  planConfigMutation,
} from "@resin/harness-contracts";
import { isRecord } from "./guards.js";
import { CURSOR_HARNESS_ID } from "./paths.js";

/**
 * Plans Resin's stdio entry in Cursor's user-level `~/.cursor/mcp.json`
 * (`{ "mcpServers": { "resin": { "command", "args" } } }`). cursor-agent loads this file for
 * every project without the per-project approval it applies to `<project>/.cursor/mcp.json`.
 * Other servers and top-level keys are preserved; legacy Resin aliases are dropped.
 */
export async function planCursorMcpConfig(
  context: Pick<HarnessRegistrationContext, "targetPath" | "command" | "args"> & {
    fsBridge?: ConfigFsBridge;
  },
): Promise<ConfigMutationPlan> {
  const fsBridge = context.fsBridge ?? defaultFsBridge;
  const current = await fsBridge.readFile(context.targetPath);
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim().length > 0) {
    const parsed: unknown = JSON.parse(current);
    if (!isRecord(parsed)) {
      throw new Error(`Cursor MCP config ${context.targetPath} is not a JSON object`);
    }
    doc = parsed;
  }
  if (doc.mcpServers !== undefined && !isRecord(doc.mcpServers)) {
    throw new Error(`Cursor MCP config ${context.targetPath} has a non-object mcpServers`);
  }
  const servers: Record<string, unknown> = { ...(doc.mcpServers ?? {}) };
  for (const alias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    const entry = servers[alias];
    if (isRecord(entry) && isRecognizedResinMcpEntry(entry as ConfigMetadataRecord))
      delete servers[alias];
  }
  servers[CANONICAL_RESIN_MCP_SERVER_KEY] = { command: context.command, args: [...context.args] };
  return planConfigMutation({
    harnessId: CURSOR_HARNESS_ID,
    targetPath: context.targetPath,
    currentContent: current,
    plannedContent: `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`,
    description: "Register the Resin MCP server in Cursor's user-level mcp.json",
  });
}
