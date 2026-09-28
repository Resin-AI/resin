import * as fs from "node:fs";
import * as path from "node:path";
import { nowIso } from "@resin/contracts/common";
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

/** Exact OpenCode versions qualified with recorded fixtures (`tests/fixtures/recorded/`). */
export const OPENCODE_TESTED_VERSIONS: readonly string[] = ["1.18.32", "1.1.65"];

/** Extracts `1.18.32` from `opencode --version` output. */
export function parseOpencodeVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

const OPENCODE_PACKAGE_NAME = "opencode-ai";

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds `opencode` on PATH; an explicit path is used as-is when it is executable. */
function findOpencodeExecutable(
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const candidates =
    executable && executable.includes(path.sep)
      ? [executable]
      : (env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, executable ?? "opencode"));
  return candidates.find(isExecutableFile) ?? null;
}

/**
 * Reads the version of the `opencode-ai` npm package owning the (symlink-resolved) executable.
 * The binary is never run: probing must stay cheap and side-effect free.
 */
export function readOpencodeVersion(executablePath: string): string | null {
  return readOwningPackageVersion(executablePath) ?? readShimPackageVersion(executablePath);
}

/**
 * Windows npm keeps its command shims (`opencode.cmd`, `.ps1` and an extensionless script) in the
 * global prefix beside `node_modules/opencode-ai`; no symlink leads from the shim to the package.
 */
function readShimPackageVersion(executablePath: string): string | null {
  const pkg = readJsonObject(
    path.join(path.dirname(executablePath), "node_modules", OPENCODE_PACKAGE_NAME, "package.json"),
  );
  return pkg?.name === OPENCODE_PACKAGE_NAME && typeof pkg.version === "string"
    ? parseOpencodeVersion(pkg.version)
    : null;
}

function readOwningPackageVersion(executablePath: string): string | null {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(executablePath));
  } catch {
    dir = path.dirname(executablePath);
  }
  for (let depth = 0; depth < 6; depth++) {
    const pkg = readJsonObject(path.join(dir, "package.json"));
    if (pkg?.name === OPENCODE_PACKAGE_NAME && typeof pkg.version === "string") {
      return parseOpencodeVersion(pkg.version);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ProbeOpencodeOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  /** MCP config path the installation is registered through. */
  configPath?: string;
  executablePath?: string;
}

/**
 * Detects an OpenCode install by the `opencode` executable on PATH (version read from its npm
 * package metadata) and by its data and config directories. Returns `null` when neither the
 * binary nor any OpenCode state exists.
 */
export async function probeOpencodeInstallation(
  options: ProbeOpencodeOptions,
): Promise<HarnessInstallation | null> {
  const executable = findOpencodeExecutable(options.executablePath, options.env);
  const executableFound = executable !== null;
  const version = executable ? readOpencodeVersion(executable) : null;
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
    executablePath: executable ?? undefined,
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
