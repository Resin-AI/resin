import type { ConfigFsBridge, ConfigMutationPlan } from "@resin/harness-contracts";
import {
  CANONICAL_RESIN_MCP_SERVER_KEY,
  defaultFsBridge,
  planConfigMutation,
} from "@resin/harness-contracts";
import { GROK_HARNESS_ID } from "./paths.js";

/**
 * Grok reads MCP servers from `[mcp_servers.<name>]` tables in `~/.grok/config.toml`
 * (`McpServerConfig` in grok-build `xai-grok-config-types`). It also loads servers from
 * `~/.claude.json`, `~/.cursor/mcp.json` and `.mcp.json`, merging by server name with
 * `config.toml` winning. Registering Resin under the same `resin` key the Claude Code installer
 * uses therefore makes Grok start exactly one Resin gateway, from this entry
 * (verified with `grok inspect --json` and `events.jsonl` `mcp_config_resolved`).
 */
export const GROK_RESIN_SERVER_KEY = CANONICAL_RESIN_MCP_SERVER_KEY;

const HEADER_PATTERN = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function headerPath(line: string): string | null {
  const match = HEADER_PATTERN.exec(line);
  return match?.[1] ? match[1].replace(/\s*\.\s*/g, ".").replace(/"/g, "") : null;
}

/** Whether a table header belongs to `mcp_servers.<key>` (including its sub-tables). */
function isServerTable(path: string, key: string): boolean {
  const table = `mcp_servers.${key}`;
  return path === table || path.startsWith(`${table}.`);
}

/**
 * Returns `content` with every `[mcp_servers.<key>]` table (and its sub-tables) removed and, when
 * `entry` is given, one fresh table appended. Other tables, comments and ordering are preserved.
 */
export function updateGrokTomlServer(
  content: string,
  key: string,
  entry: { command: string; args: readonly string[] } | null,
): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split("\n")) {
    const path = headerPath(line);
    if (path !== null) skipping = isServerTable(path, key);
    if (!skipping) kept.push(line);
  }
  const base = kept.join("\n").replace(/\s+$/, "");
  if (!entry) return base.length > 0 ? `${base}\n` : "";
  const table = [
    `[mcp_servers.${key}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
  ].join("\n");
  return base.length > 0 ? `${base}\n\n${table}\n` : `${table}\n`;
}

/** Reads `command`/`args` of `[mcp_servers.<key>]`; null when the table is absent. */
export function readGrokTomlServer(
  content: string,
  key: string,
): { command?: string; args?: string[]; url?: string } | null {
  let inTable = false;
  let found = false;
  const entry: { command?: string; args?: string[]; url?: string } = {};
  for (const line of content.split("\n")) {
    const path = headerPath(line);
    if (path !== null) {
      inTable = path === `mcp_servers.${key}`;
      found ||= inTable;
      continue;
    }
    if (!inTable) continue;
    const assignment = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!assignment?.[1] || !assignment[2]) continue;
    try {
      const value: unknown = JSON.parse(assignment[2].replace(/'([^']*)'/g, '"$1"'));
      if (assignment[1] === "command" && typeof value === "string") entry.command = value;
      if (assignment[1] === "url" && typeof value === "string") entry.url = value;
      if (assignment[1] === "args" && Array.isArray(value)) entry.args = value.map(String);
    } catch {
      // Not a JSON-compatible TOML literal; leave the field unset.
    }
  }
  return found ? entry : null;
}

export interface PlanGrokMcpConfigOptions {
  targetPath: string;
  command: string;
  args: readonly string[];
  fsBridge?: ConfigFsBridge;
}

export async function planGrokMcpConfig(
  options: PlanGrokMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const currentContent = await fsBridge.readFile(options.targetPath);
  return planConfigMutation({
    harnessId: GROK_HARNESS_ID,
    targetPath: options.targetPath,
    currentContent,
    plannedContent: updateGrokTomlServer(currentContent ?? "", GROK_RESIN_SERVER_KEY, {
      command: options.command,
      args: options.args,
    }),
    description: `Register Resin Gateway MCP server (${GROK_RESIN_SERVER_KEY} -> ${options.command}) in ${options.targetPath}`,
  });
}

export async function verifyGrokMcpConfig(options: {
  targetPath: string;
  command: string;
  fsBridge?: ConfigFsBridge;
}): Promise<boolean> {
  const content = await (options.fsBridge ?? defaultFsBridge).readFile(options.targetPath);
  const entry = content === null ? null : readGrokTomlServer(content, GROK_RESIN_SERVER_KEY);
  return (
    entry !== null &&
    entry.url === undefined &&
    entry.command === options.command &&
    entry.args?.length === 1 &&
    entry.args[0] === "mcp"
  );
}
