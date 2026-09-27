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
 * The tool the surface reads through to invoke a callable that takes no arguments.
 *
 * A device path is reached either by writing the invocation's JSON arguments to it or, for a tool
 * that takes none, by reading it. Both spell the same path, so both resolve the same way.
 */
export const OMP_DEVICE_SURFACE_READ_TOOL = "read";

/** OMP's cap on an MCP tool name; a longer name is cut and suffixed with a hash of itself. */
const OMP_TOOL_NAME_MAX_LENGTH = 64;
const OMP_TOOL_NAME_HASH_LENGTH = 8;

function ompNamePart(value: string, fallback: string): string {
  const part = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return part.length > 0 ? part : fallback;
}

const WYHASH_MASK = (1n << 64n) - 1n;
const WYHASH_SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
] as const;

function wyhashMum(a: bigint, b: bigint): [bigint, bigint] {
  const product = a * b;
  return [product & WYHASH_MASK, product >> 64n];
}

function wyhashMix(a: bigint, b: bigint): bigint {
  const [low, high] = wyhashMum(a, b);
  return low ^ high;
}

/** Zig's `std.hash.Wyhash.hash(0, …)`, which is what `Bun.hash` computes for OMP. */
function wyhash(text: string): bigint {
  const bytes = new TextEncoder().encode(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read64 = (at: number) => view.getBigUint64(at, true);
  const read32 = (at: number) => BigInt(view.getUint32(at, true));
  const length = bytes.length;
  const seedState = wyhashMix(WYHASH_SECRET[0], WYHASH_SECRET[1]);
  const state = [seedState, seedState, seedState];
  let a: bigint;
  let b: bigint;
  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      a = (read32(0) << 32n) | read32(quarter);
      b = (read32(end) << 32n) | read32(end - quarter);
    } else if (length > 0) {
      a =
        (BigInt(bytes[0]!) << 16n) | (BigInt(bytes[length >> 1]!) << 8n) | BigInt(bytes[length - 1]!);
      b = 0n;
    } else {
      a = 0n;
      b = 0n;
    }
  } else {
    let offset = 0;
    if (length >= 48) {
      for (; offset + 48 < length; offset += 48) {
        for (let lane = 0; lane < 3; lane++) {
          state[lane] = wyhashMix(
            read64(offset + 16 * lane) ^ WYHASH_SECRET[lane + 1]!,
            read64(offset + 16 * lane + 8) ^ state[lane]!,
          );
        }
      }
      state[0] = state[0]! ^ state[1]! ^ state[2]!;
    }
    for (; offset + 16 < length; offset += 16) {
      state[0] = wyhashMix(read64(offset) ^ WYHASH_SECRET[1], read64(offset + 8) ^ state[0]!);
    }
    a = read64(length - 16);
    b = read64(length - 8);
  }
  [a, b] = wyhashMum(a ^ WYHASH_SECRET[1], b ^ state[0]!);
  return wyhashMix(a ^ WYHASH_SECRET[0] ^ BigInt(length), b ^ WYHASH_SECRET[1]);
}

/**
 * The name OMP registers an MCP tool under, spelled exactly as OMP spells it: both parts
 * lowercased with every other run of characters as one `_`, a tool name that already starts
 * with `<server>_` not prefixed twice, and a name over 64 characters cut to 55 and suffixed with
 * `_` and the first 8 base-36 digits of its hash. Its device path is `xd://` followed by it.
 */
export function ompMcpToolName(serverName: string, toolName: string): string {
  const server = ompNamePart(serverName, "server");
  const tool = ompNamePart(toolName, "tool");
  const name = `mcp__${server}_${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`;
  if (name.length <= OMP_TOOL_NAME_MAX_LENGTH) return name;
  const digest = wyhash(name).toString(36).slice(0, OMP_TOOL_NAME_HASH_LENGTH);
  return `${name.slice(0, OMP_TOOL_NAME_MAX_LENGTH - digest.length - 1)}_${digest}`;
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
