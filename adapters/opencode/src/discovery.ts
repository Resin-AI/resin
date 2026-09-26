import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { nowIso } from "@resin/contracts";
import {
  type HarnessInstallation,
  type HarnessMcpServerDescriptor,
  UNKNOWN_HARNESS_VERSION,
  classifyHarnessVersion,
} from "@resin/harness-contracts";
import {
  OPENCODE_GLOBAL_CONFIG_FILES,
  resolveOpencodeConfigDir,
  resolveOpencodeDbPath,
  resolveOpencodeLegacyStorageDir,
  resolveOpencodeMcpConfigPath,
} from "./paths.js";

const execFileAsync = promisify(execFile);

/** Exact OpenCode versions qualified with recorded fixtures (`tests/fixtures/recorded/`). */
export const OPENCODE_TESTED_VERSIONS: readonly string[] = ["1.18.32", "1.1.65"];

export type OpencodeExecFunction = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: OpencodeExecFunction = async (file, args) =>
  await execFileAsync(file, args, { timeout: 15_000, encoding: "utf8" });

/** Extracts `1.18.32` from `opencode --version` output. */
export function parseOpencodeVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

export interface ProbeOpencodeOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  /** MCP config path the installation is registered through. */
  configPath?: string;
  executablePath?: string;
  exec?: OpencodeExecFunction;
}

/**
 * Detects an OpenCode install by running `opencode --version` and looking for its data and
 * config directories. Returns `null` when neither the binary nor any OpenCode state exists.
 */
export async function probeOpencodeInstallation(
  options: ProbeOpencodeOptions,
): Promise<HarnessInstallation | null> {
  const exec = options.exec ?? defaultExec;
  const executable = options.executablePath ?? "opencode";
  let version: string | null = null;
  let executableFound = false;
  try {
    const { stdout, stderr } = await exec(executable, ["--version"]);
    executableFound = true;
    version = parseOpencodeVersion(`${stdout}\n${stderr}`);
  } catch (err) {
    executableFound = !(err instanceof Error && "code" in err && err.code === "ENOENT");
  }
  const dbPath = resolveOpencodeDbPath(options.home, options.env);
  const legacyDir = resolveOpencodeLegacyStorageDir(options.home, options.env);
  const configDir = resolveOpencodeConfigDir(options.home, options.env);
  const hasState = fs.existsSync(dbPath) || fs.existsSync(legacyDir) || fs.existsSync(configDir);
  if (!executableFound && !hasState) return null;
  const resolvedVersion = version ?? UNKNOWN_HARNESS_VERSION;
  return {
    harnessId: "opencode",
    displayName: "OpenCode",
    version: resolvedVersion,
    executablePath: executableFound ? executable : undefined,
    configPath: options.configPath ?? resolveOpencodeMcpConfigPath(options.home, options.env),
    homePath: path.dirname(dbPath),
    isInstalled: executableFound,
    status: executableFound ? "ready" : "missing_executable",
    detectedAt: nowIso(),
    metadata: {
      dbPath,
      store: fs.existsSync(dbPath) ? "sqlite" : fs.existsSync(legacyDir) ? "legacy-json" : "none",
      versionClassification: classifyHarnessVersion(resolvedVersion, OPENCODE_TESTED_VERSIONS),
    },
  };
}

type Obj = Record<string, unknown>;

function readJsonObject(file: string): Obj | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Obj)
      : null;
  } catch {
    return null;
  }
}

/**
 * MCP servers OpenCode declares for a workspace, merged in OpenCode's precedence: global
 * config files, then project `opencode.json(c)` files from the workspace root, then
 * `OPENCODE_CONFIG`. Files with comments (JSONC) are skipped.
 */
export function readOpencodeMcpServers(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  workspaceRoot?: string;
}): Record<string, Obj> {
  const files = OPENCODE_GLOBAL_CONFIG_FILES.map((name) =>
    path.join(resolveOpencodeConfigDir(options.home, options.env), name),
  );
  if (options.workspaceRoot) {
    files.push(
      path.join(options.workspaceRoot, "opencode.json"),
      path.join(options.workspaceRoot, "opencode.jsonc"),
      path.join(options.workspaceRoot, ".opencode", "opencode.json"),
      path.join(options.workspaceRoot, ".opencode", "opencode.jsonc"),
    );
  }
  if (options.env.OPENCODE_CONFIG) files.push(options.env.OPENCODE_CONFIG);
  const servers: Record<string, Obj> = {};
  for (const file of files) {
    const mcp = readJsonObject(file)?.mcp;
    if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) continue;
    for (const [name, entry] of Object.entries(mcp as Obj)) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        servers[name] = { ...servers[name], ...(entry as Obj) };
      }
    }
  }
  return servers;
}

/** The connection OpenCode itself opens for a declared MCP server. */
export function resolveOpencodeMcpServer(
  name: string,
  workspaceRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
): HarnessMcpServerDescriptor | undefined {
  const entry = readOpencodeMcpServers({ home, env, workspaceRoot })[name];
  if (!entry || entry.enabled === false) return undefined;
  if (entry.type === "local" && Array.isArray(entry.command) && entry.command.length > 0) {
    const [command, ...args] = entry.command.map(String);
    const environment = entry.environment;
    return {
      name,
      transport: {
        kind: "stdio",
        command: command!,
        ...(args.length > 0 ? { args } : {}),
        ...(environment && typeof environment === "object"
          ? { env: environment as Record<string, string> }
          : {}),
      },
    };
  }
  if (entry.type === "remote" && typeof entry.url === "string") {
    return { name, transport: { kind: "http", url: entry.url } };
  }
  return undefined;
}
