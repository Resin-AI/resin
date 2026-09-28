import * as path from "node:path";
import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  type ConfigFsBridge,
  type ConfigMetadataRecord,
  type ConfigMutationPlan,
  HarnessError,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  defaultFsBridge,
  isRecognizedResinMcpEntry,
  planConfigMutation,
} from "@resin/harness-contracts";
import { OPENCODE_GLOBAL_CONFIG_FILES, resolveOpencodeConfigDir } from "./paths.js";

export const OPENCODE_CONFIG_SCHEMA_URL = "https://opencode.ai/config.json";

/**
 * An entry of OpenCode's `mcp` map (OpenCode 1.x). Local servers take the whole argv in
 * `command`; remote servers take `url`.
 */
export type OpencodeMcpEntry =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    };

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parses an OpenCode JSON config; an empty file is an empty config. */
function parseConfig(content: string | null, filePath: string): Obj {
  if (content === null || content.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new HarnessError("INTERNAL_ERROR", `Cannot parse OpenCode config ${filePath} as JSON`, {
      harnessId: "opencode",
      cause,
      details: { targetPath: filePath },
    });
  }
  if (!isObject(parsed)) {
    throw new HarnessError("INTERNAL_ERROR", `OpenCode config ${filePath} is not a JSON object`, {
      harnessId: "opencode",
      details: { targetPath: filePath },
    });
  }
  return parsed;
}

/** Whether an `mcp` entry is one Resin installed (current or legacy command/url forms). */
export function isResinOpencodeEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const argv = Array.isArray(entry.command) ? entry.command.map(String) : [];
  return isRecognizedResinMcpEntry({
    command: argv[0],
    args: argv.slice(1),
    url: typeof entry.url === "string" ? entry.url : undefined,
  } as ConfigMetadataRecord);
}

export interface PlanOpencodeMcpConfigOptions {
  targetPath: string;
  /** Local stdio registration (default): `[command, ...args]`. */
  command?: string;
  args?: readonly string[];
  /** Remote registration instead of a local command. */
  url?: string;
  serverKey?: string;
  fsBridge?: ConfigFsBridge;
}

/**
 * Plans Resin's entry under `mcp.<serverKey>` in an OpenCode config, preserving every other key.
 * Legacy Resin aliases are dropped. Planning an already-registered config yields identical
 * content, so applying it is a no-op.
 */
export async function planOpencodeMcpConfig(
  options: PlanOpencodeMcpConfigOptions,
): Promise<ConfigMutationPlan> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const serverKey = options.serverKey ?? CANONICAL_RESIN_MCP_SERVER_KEY;
  const current = await fsBridge.readFile(options.targetPath);
  const config = parseConfig(current, options.targetPath);
  const mcp: Obj = isObject(config.mcp) ? { ...config.mcp } : {};
  for (const alias of LEGACY_RESIN_MCP_SERVER_ALIASES) {
    if (alias !== serverKey && isResinOpencodeEntry(mcp[alias])) delete mcp[alias];
  }
  const entry: OpencodeMcpEntry = options.url
    ? { type: "remote", url: options.url, enabled: true }
    : {
        type: "local",
        command: [
          options.command ?? CANONICAL_RESIN_MCP_COMMAND,
          ...(options.args ?? CANONICAL_RESIN_MCP_ARGS),
        ],
        enabled: true,
      };
  const existing = mcp[serverKey];
  // Keep user-added fields (environment, timeout) on an existing Resin entry.
  mcp[serverKey] =
    isObject(existing) && existing.type === entry.type ? { ...existing, ...entry } : entry;
  const next: Obj = current === null ? { $schema: OPENCODE_CONFIG_SCHEMA_URL } : {};
  Object.assign(next, config, { mcp });
  const plannedContent = `${JSON.stringify(next, null, 2)}\n`;
  return planConfigMutation({
    harnessId: "opencode",
    targetPath: options.targetPath,
    currentContent: current,
    plannedContent: current !== null && plannedContent === current ? current : plannedContent,
    description: `Register Resin MCP server "${serverKey}" in OpenCode config`,
    metadata: { serverKey, transport: entry.type },
  });
}

/**
 * Whether `targetPath` registers Resin as an enabled local server spawning `[command, "mcp"]`
 * (any Resin command when `command` is omitted).
 */
export async function verifyOpencodeMcpConfig(options: {
  targetPath: string;
  command?: string;
  /** Expected arguments after `command`; `["mcp"]` by default. */
  args?: readonly string[];
  serverKey?: string;
  fsBridge?: ConfigFsBridge;
}): Promise<boolean> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  let config: Obj;
  try {
    config = parseConfig(await fsBridge.readFile(options.targetPath), options.targetPath);
  } catch {
    return false;
  }
  const entry = isObject(config.mcp)
    ? config.mcp[options.serverKey ?? CANONICAL_RESIN_MCP_SERVER_KEY]
    : undefined;
  if (!isObject(entry) || entry.enabled === false || entry.type !== "local") return false;
  const argv = Array.isArray(entry.command) ? entry.command : [];
  const expectedArgs = options.args ?? CANONICAL_RESIN_MCP_ARGS;
  if (argv.length !== 1 + expectedArgs.length) return false;
  if (!expectedArgs.every((arg, index) => argv[index + 1] === arg)) return false;
  return options.command === undefined ? isResinOpencodeEntry(entry) : argv[0] === options.command;
}

/** Every global OpenCode config file Resin may have written to. */
export function opencodeUninstallPaths(home: string, env: NodeJS.ProcessEnv): string[] {
  const dir = resolveOpencodeConfigDir(home, env);
  return OPENCODE_GLOBAL_CONFIG_FILES.map((name) => path.join(dir, name));
}

/**
 * Removes Resin entries (canonical key and legacy aliases, only when they are Resin's) from
 * every global OpenCode config. Files that are not plain JSON (JSONC with comments) are left
 * untouched rather than rewritten without their comments. Returns whether anything changed.
 */
export async function removeOpencodeMcpConfig(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  fsBridge?: ConfigFsBridge;
  dryRun?: boolean;
  serverKey?: string;
}): Promise<boolean> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const keys = [
    options.serverKey ?? CANONICAL_RESIN_MCP_SERVER_KEY,
    ...LEGACY_RESIN_MCP_SERVER_ALIASES,
  ];
  let changed = false;
  for (const filePath of opencodeUninstallPaths(options.home, options.env)) {
    const current = await fsBridge.readFile(filePath);
    if (current === null) continue;
    let config: Obj;
    try {
      config = parseConfig(current, filePath);
    } catch {
      continue;
    }
    if (!isObject(config.mcp)) continue;
    const mcp = { ...config.mcp };
    let fileChanged = false;
    for (const key of keys) {
      if (isResinOpencodeEntry(mcp[key])) {
        delete mcp[key];
        fileChanged = true;
      }
    }
    if (!fileChanged) continue;
    changed = true;
    if (options.dryRun) continue;
    const next: Obj = { ...config, mcp };
    if (Object.keys(mcp).length === 0) delete next.mcp;
    await fsBridge.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return changed;
}
