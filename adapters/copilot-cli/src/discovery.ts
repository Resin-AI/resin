import { createHash } from "node:crypto";
import { type Stats, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type SessionStatus,
  UNKNOWN_HARNESS_VERSION,
} from "@resin/harness-contracts";

export const COPILOT_HARNESS_ID = "copilot-cli";
export const COPILOT_DISPLAY_NAME = "GitHub Copilot CLI";

/**
 * Copilot CLI versions whose session-state format was qualified with recorded fixtures
 * (tests/fixtures/recorded/<version>). Other versions are reported as untested.
 */
export const COPILOT_TESTED_VERSIONS = ["1.0.88"] as const;

export const COPILOT_MCP_CONFIG_FILENAME = "mcp-config.json";
export const COPILOT_INSTRUCTIONS_FILENAME = "copilot-instructions.md";
export const COPILOT_SESSION_STATE_DIRNAME = "session-state";
export const COPILOT_EVENTS_FILENAME = "events.jsonl";
export const COPILOT_WORKSPACE_FILENAME = "workspace.yaml";

/** A session whose log changed this recently and has not shut down counts as running. */
export const COPILOT_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Copilot's data root: `$COPILOT_HOME` when set (it names the directory itself, not its parent),
 * otherwise `~/.copilot`. Verified against `copilot mcp add` on 1.0.88, which writes
 * `$COPILOT_HOME/mcp-config.json`.
 */
export function resolveCopilotHome(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.COPILOT_HOME?.trim();
  if (override) {
    return override === "~" || override.startsWith("~/")
      ? path.join(home, override.slice(1))
      : path.resolve(override);
  }
  return path.join(home, ".copilot");
}

export function resolveCopilotMcpConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveCopilotHome(home, env), COPILOT_MCP_CONFIG_FILENAME);
}

export function resolveCopilotInstructionsPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveCopilotHome(home, env), COPILOT_INSTRUCTIONS_FILENAME);
}

const COPILOT_PACKAGE_NAME = "@github/copilot";

/** Finds `copilot` on PATH; an explicit path is used as-is when it is executable. */
async function findCopilotExecutable(
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const candidates =
    executable && executable.includes(path.sep)
      ? [executable]
      : (env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, executable ?? "copilot"));
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Reads the version of the `@github/copilot` npm package owning the (symlink-resolved)
 * executable. The CLI is never run: `copilot --version` unpacks its runtime into the user's
 * cache directory, which a probe must not do.
 */
export async function readCopilotVersion(executablePath: string): Promise<string | null> {
  let dir = path.dirname(await fs.realpath(executablePath).catch(() => executablePath));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === COPILOT_PACKAGE_NAME && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // Not the package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ProbeCopilotOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  executable?: string;
}

/**
 * Detects Copilot CLI by the `copilot` executable on PATH (version read from its npm package
 * metadata) and by the presence of its data root. Returns null when neither is found.
 */
export async function probeCopilotInstallation(
  options: ProbeCopilotOptions,
): Promise<HarnessInstallation | null> {
  const copilotHome = resolveCopilotHome(options.home, options.env);
  const executable = await findCopilotExecutable(options.executable, options.env);
  const version = executable ? await readCopilotVersion(executable) : null;

  const homeExists = await isDirectory(copilotHome);
  if (!executable && !homeExists) {
    return null;
  }

  return {
    harnessId: COPILOT_HARNESS_ID,
    displayName: COPILOT_DISPLAY_NAME,
    version: version ?? UNKNOWN_HARNESS_VERSION,
    executablePath: executable ?? undefined,
    configPath: path.join(copilotHome, COPILOT_MCP_CONFIG_FILENAME),
    homePath: copilotHome,
    isInstalled: executable !== null,
    status: executable ? "ready" : "missing_executable",
    detectedAt: new Date().toISOString(),
    metadata: { copilotHome },
  };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Fields of `session-state/<id>/workspace.yaml` the adapter reads (flat `key: value` YAML). */
export interface CopilotWorkspaceFile {
  id?: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Parses Copilot's flat workspace.yaml. Values are plain scalars or single-quoted strings
 * (`''` escapes a quote); nested YAML is not written by 1.0.88.
 */
export function parseCopilotWorkspaceYaml(text: string): CopilotWorkspaceFile {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-z_]+):\s?(.*)$/);
    if (!match) continue;
    values.set(match[1]!, unquoteYamlScalar(match[2]!.trim()));
  }
  return {
    id: values.get("id"),
    cwd: values.get("cwd"),
    gitRoot: values.get("git_root"),
    branch: values.get("branch"),
    name: values.get("name"),
    createdAt: values.get("created_at"),
    updatedAt: values.get("updated_at"),
  };
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function copilotWorkspaceId(rootPath: string): string {
  return `copilot-ws-${createHash("sha256").update(rootPath).digest("hex").slice(0, 16)}`;
}

export interface CopilotSessionEntry {
  sessionId: string;
  sessionDir: string;
  eventsPath: string;
  cwd: string;
  workspace: CopilotWorkspaceFile;
  lastEventType: string | null;
  modifiedAt: Date;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lists sessions under `<copilotHome>/session-state`. Directories without `events.jsonl` (Copilot
 * creates them for runs that fail before the first event, e.g. an unavailable `--model`) are
 * skipped, as are entries whose workspace.yaml has no cwd.
 */
export async function listCopilotSessionEntries(
  copilotHome: string,
): Promise<CopilotSessionEntry[]> {
  const root = path.join(copilotHome, COPILOT_SESSION_STATE_DIRNAME);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }

  const entries: CopilotSessionEntry[] = [];
  for (const name of names) {
    if (!SESSION_ID_PATTERN.test(name)) continue;
    const sessionDir = path.join(root, name);
    const eventsPath = path.join(sessionDir, COPILOT_EVENTS_FILENAME);
    let stat: Stats;
    try {
      stat = await fs.stat(eventsPath);
    } catch {
      continue;
    }
    const yaml = await fs
      .readFile(path.join(sessionDir, COPILOT_WORKSPACE_FILENAME), "utf8")
      .catch(() => null);
    const workspace = yaml === null ? {} : parseCopilotWorkspaceYaml(yaml);
    const cwd = workspace.cwd ?? (await readStartCwd(eventsPath));
    if (!cwd) continue;
    entries.push({
      sessionId: name,
      sessionDir,
      eventsPath,
      cwd,
      workspace,
      lastEventType: await readLastEventType(eventsPath, stat.size),
      modifiedAt: stat.mtime,
    });
  }
  return entries.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime());
}

async function readStartCwd(eventsPath: string): Promise<string | undefined> {
  const handle = await fs.open(eventsPath, "r").catch(() => null);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      data?: { context?: { cwd?: unknown } };
    };
    const cwd = parsed.type === "session.start" ? parsed.data?.context?.cwd : undefined;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Reads the `type` of the last complete line without loading the whole log. */
async function readLastEventType(eventsPath: string, size: number): Promise<string | null> {
  if (size === 0) return null;
  const handle = await fs.open(eventsPath, "r").catch(() => null);
  if (!handle) return null;
  try {
    let windowSize = Math.min(size, 64 * 1024);
    for (;;) {
      const buffer = Buffer.alloc(windowSize);
      await handle.read(buffer, 0, windowSize, size - windowSize);
      const lines = buffer.toString("utf8").split("\n");
      // The final element is either "" (trailing newline) or a line still being written.
      const complete = lines.slice(0, -1).filter((line) => line.trim().length > 0);
      const candidate = windowSize === size ? complete.at(-1) : complete.slice(1).at(-1);
      if (candidate !== undefined) {
        const match = candidate.match(/"type"\s*:\s*"([^"]+)"/);
        return match?.[1] ?? null;
      }
      if (windowSize === size) return null;
      windowSize = Math.min(size, windowSize * 4);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Status from the log tail: `session.shutdown` last means the process exited cleanly (a later
 * `--resume` appends `session.resume` and reopens it); otherwise recent writes mean running and
 * stale ones mean the process died or was interrupted (Ctrl+C writes no shutdown event).
 */
export function copilotSessionStatus(entry: CopilotSessionEntry, now = Date.now()): SessionStatus {
  if (entry.lastEventType === "session.shutdown") return "completed";
  return now - entry.modifiedAt.getTime() <= COPILOT_ACTIVE_WINDOW_MS ? "active" : "interrupted";
}

export function toCopilotWorkspace(rootPath: string, copilotHome: string): HarnessWorkspace {
  return {
    workspaceId: copilotWorkspaceId(rootPath),
    rootPath,
    name: path.basename(rootPath) || rootPath,
    harnessId: COPILOT_HARNESS_ID,
    configPath: path.join(copilotHome, COPILOT_MCP_CONFIG_FILENAME),
    mcpConfigPath: path.join(copilotHome, COPILOT_MCP_CONFIG_FILENAME),
    metadata: { copilotHome },
  };
}

export function toCopilotSession(entry: CopilotSessionEntry, now = Date.now()): HarnessSession {
  const createdAt = normalizeIso(entry.workspace.createdAt) ?? entry.modifiedAt.toISOString();
  return {
    sessionId: entry.sessionId,
    workspaceId: copilotWorkspaceId(entry.cwd),
    harnessId: COPILOT_HARNESS_ID,
    transcriptPath: entry.eventsPath,
    status: copilotSessionStatus(entry, now),
    createdAt,
    updatedAt: entry.modifiedAt.toISOString(),
    metadata: {
      cwd: entry.cwd,
      ...(entry.workspace.gitRoot ? { gitRoot: entry.workspace.gitRoot } : {}),
      ...(entry.workspace.branch ? { branch: entry.workspace.branch } : {}),
      ...(entry.workspace.name ? { title: entry.workspace.name } : {}),
    },
  };
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
