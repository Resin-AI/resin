/**
 * OMP's tool-device surface: the harness reaches an MCP tool by writing its JSON arguments to a
 * device path.
 *
 * A path is `xd://mcp__<server>_<tool>`, with the server's dashes rendered as underscores. That
 * spelling cannot be split back into its parts: the tool's own name may contain underscores too,
 * so `xd://mcp__alpha_beta_run` is server `alpha` with tool `beta_run` or server `alpha_beta`
 * with tool `run` depending on what the harness is actually configured with. The mapping is
 * therefore resolved against OMP's own registered server names — the `mcpServers` keys of the
 * harness's config — and nothing else. A path no configured server owns, or one two configured
 * names own equally, stays unresolved rather than guessed at.
 */

import fs from "node:fs";
import path from "node:path";
import { type OmpMcpServerConfig, resolveOmpConfigPath } from "./config-planner.js";
import { resolveOmpHome } from "./discovery.js";

/** The scheme OMP's device surface uses for MCP tools. */
export const OMP_DEVICE_SURFACE_PREFIX = "xd://mcp__";

/** The tool the surface writes through to invoke a tool behind a device path. */
export const OMP_DEVICE_SURFACE_WRITE_TOOL = "write";

/**
 * The tool the surface reads a device path through. A read never invokes the tool behind the
 * path, however few arguments it takes: OMP answers it with that tool's documentation and input
 * schema (`# mcp__resin_x — resin/x … ## Schema`), and the tool runs only when written to.
 */
export const OMP_DEVICE_SURFACE_READ_TOOL = "read";

/**
 * The Resin gateway tool a read of one of Resin's own device paths is recorded as: the same
 * documentation lookup `get_tool_schema` is, so it counts as schema overhead rather than as an
 * invocation of the tool it describes. A read of another server's path is documentation the
 * harness pages for itself and is not recorded at all.
 */
export const OMP_DEVICE_SURFACE_DOCUMENTATION_TOOL = "get_tool_schema";

function ompNamePart(value: string, fallback: string): string {
  const part = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return part.length > 0 ? part : fallback;
}

/**
 * The name OMP registers an MCP tool under: both parts lowercased with every other run of
 * characters as one `_`, and a tool name that already starts with `<server>_` not prefixed twice.
 * Its device path is `xd://` followed by it. Resin keeps published names short enough that OMP
 * never cuts one at its 64-character limit.
 */
export function ompMcpToolName(serverName: string, toolName: string): string {
  const server = ompNamePart(serverName, "server");
  const tool = ompNamePart(toolName, "tool");
  return `mcp__${server}_${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`;
}

export interface OmpDeviceSurfaceCall {
  /** The configured server the path names, as the harness itself spells it. */
  connection: string;
  /** The tool's own name on that server — never the product of splitting the path. */
  tool: string;
}

/** A server the harness is configured with, as its own config spells it. */
export interface OmpConfiguredServer {
  name: string;
  entry: OmpMcpServerConfig;
}

/**
 * Resolves a device path against the server names the harness is configured with.
 *
 * The longest configured name wins, so a server whose name is a prefix of another's (`alpha` and
 * `alpha_beta`) claims its own tools: `xd://mcp__alpha_beta_run` is `alpha_beta`/`run`, while
 * `xd://mcp__alpha_run` is `alpha`/`run`. A tie between two configured names of the same length,
 * and a path no configured name owns, are both unresolved. A server's name is spelled with
 * underscores in the path, exactly as `renderOmpInvocationSnippet` spells it.
 */
export function resolveOmpDeviceSurfaceCall(
  devicePath: string,
  serverNames: readonly string[],
): OmpDeviceSurfaceCall | undefined {
  if (!devicePath.startsWith(OMP_DEVICE_SURFACE_PREFIX)) return undefined;
  const remainder = devicePath.slice(OMP_DEVICE_SURFACE_PREFIX.length);
  let matched: { connection: string; spelling: string } | undefined;
  let tied = false;
  for (const name of serverNames) {
    const spelling = name.replace(/-/g, "_");
    if (spelling.length === 0 || !remainder.startsWith(`${spelling}_`)) continue;
    if (matched === undefined || spelling.length > matched.spelling.length) {
      matched = { connection: name, spelling };
      tied = false;
    } else if (spelling.length === matched.spelling.length) {
      tied = true;
    }
  }
  if (matched === undefined || tied) return undefined;
  const tool = remainder.slice(matched.spelling.length + 1);
  return tool.length === 0 ? undefined : { connection: matched.connection, tool };
}

/** Parses one `mcpServers` document, tolerating anything that is not one. */
function readServerEntries(configPath: string): OmpConfiguredServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  const configured: OmpConfiguredServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    configured.push({ name, entry: entry as OmpMcpServerConfig });
  }
  return configured;
}

/**
 * The MCP servers the harness itself is configured with.
 *
 * The OMP home config is the harness's own registry; a workspace config, when the workspace has
 * one, is read after it so a server the workspace declares is the one taken. A config that cannot
 * be read, or is not one, contributes no servers — never a guess.
 */
export function readConfiguredOmpServers(options?: {
  workspaceRoot?: string;
  ompHome?: string;
}): OmpConfiguredServer[] {
  const home = resolveOmpHome(options?.ompHome ? { ompHome: options.ompHome } : {});
  const documents: OmpConfiguredServer[][] = [
    readServerEntries(resolveOmpConfigPath(undefined, { ompHome: home })),
  ];
  if (options?.workspaceRoot !== undefined) {
    documents.push(
      readServerEntries(path.join(path.resolve(options.workspaceRoot), ".omp", "mcp.json")),
    );
  }
  const byName: Record<string, OmpConfiguredServer> = {};
  for (const servers of documents) {
    for (const server of servers) byName[server.name] = server;
  }
  return Object.values(byName);
}
