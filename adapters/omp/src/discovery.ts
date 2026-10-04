import { createHash } from "node:crypto";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import {
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type InstallationStatus,
  type ProbeInstallationOptions,
  type SessionStatus,
  findHostExecutable,
  readHostEnv,
  readHostPathEnv,
  resolveHarnessUserHome,
  runHarnessCommand,
} from "@resin/harness-contracts";
import { z } from "zod";
import { getOmpSessionExitReason } from "./session-exit.js";

const ACTIVE_ONLY_TERMINAL_GRACE_MS = 5 * 60_000;

export interface OmpBreadcrumb {
  sessionId: string;
  sessionDir?: string;
  workspacePath: string;
  lastActiveAt: string;
  pid?: number;
  status?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface OmpDiscoveryOptions extends ProbeInstallationOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** User home OMP expands `~` against (`os.homedir()` in OMP: `%USERPROFILE%` on Windows). */
  homeDir?: string;
  /** Host platform (tests inject `win32`); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  cwd?: string;
  customHome?: string;
  ompHome?: string;
  searchPaths?: string[];
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
  now?: number | Date;
  catalog?: OmpDiscoveryCatalog;
  activeOnly?: boolean;
  inspectTranscript?: (
    filePath: string,
    options?: {
      now?: number | Date;
      activeOnly?: boolean;
      onInspectTranscript?: (filePath: string) => void;
    },
  ) => Promise<ParsedTranscript | null>;
  onInspectTranscript?: (filePath: string) => void;
  /** Directory listings carried between scans; see {@link collectTranscriptFiles}. */
  directoryCache?: TranscriptDirectoryCache;
}

/**
 * Parses an ISO-8601 timestamp from standard OMP transcript filenames or date-named directories.
 * Returns unix epoch milliseconds or null if no valid timestamp pattern matches.
 */
export function parseIsoTimestampFromFilename(name: string): number | null {
  const baseName = name.replace(/\.jsonl$/i, "");

  // 1. Standard ISO timestamp: YYYY-MM-DDTHH-MM-SS(.sss)(Z) or YYYY-MM-DDTHH:MM:SS
  const isoMatch = baseName.match(
    /(\d{4}-\d{2}-\d{2})[T_\s](\d{2})[-:_](\d{2})[-:_](\d{2})(?:[\._-](\d{1,3}))?(?:Z|[+-]\d{2}(?::?\d{2})?)?/i,
  );
  if (isoMatch) {
    const [, datePart, hh, mm, ss, msPart] = isoMatch;
    const ms = msPart ? msPart.padEnd(3, "0").slice(0, 3) : "000";
    const isoString = `${datePart}T${hh}:${mm}:${ss}.${ms}Z`;
    const parsed = Date.parse(isoString);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  // 2. Date only: YYYY-MM-DD (e.g. daily session or date directory)
  const dateOnlyMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyMatch) {
    const parsed = Date.parse(`${dateOnlyMatch[1]}T23:59:59.999Z`);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  // 3. Compact ISO: YYYYMMDDTHHMMSS...
  const compactMatch = baseName.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/i);
  if (compactMatch) {
    const [, yyyy, mm, dd, hh, min, ss] = compactMatch;
    const isoString = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.000Z`;
    const parsed = Date.parse(isoString);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}
const SESSION_DIR_NAME_REGEX =
  /^(\d{4}[0-9a-zA-Z.:T_-]*)_[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checks whether a directory name matches the OMP session directory pattern:
 * `^<timestamp>_<uuid>$` where `<timestamp>` is a valid ISO timestamp
 * (parsed via parseIsoTimestampFromFilename on the full name) and `<uuid>` is a full RFC UUID v4 or v7.
 */
export function isSessionDirectoryName(name: string): boolean {
  if (!name) {
    return false;
  }
  if (!SESSION_DIR_NAME_REGEX.test(name)) {
    return false;
  }
  return parseIsoTimestampFromFilename(name) !== null;
}

/**
 * Classifies an OMP transcript file as a user session or subagent session.
 * User sessions live at `<workspace-slug>/<timestamp>_<uuid>.jsonl` or `.omp/sessions/<timestamp>_<uuid>.jsonl`.
 * Subagent transcripts live at `<workspace-slug>/<timestamp>_<uuid>/<agent-name>.jsonl` (nested under the parent session's directory).
 */
export function classifyTranscriptSessionKind(
  filePath: string,
  workspace?: HarnessWorkspace,
): "user" | "agent" {
  return classifyTranscriptSessionKindWithKeys(
    filePath,
    workspace,
    workspace ? getWorkspaceKeys(workspace) : undefined,
  );
}

function classifyTranscriptSessionKindWithKeys(
  filePath: string,
  workspace: HarnessWorkspace | undefined,
  workspaceKeys?: ReadonlySet<string>,
): "user" | "agent" {
  const normPath = path.resolve(filePath);
  const dir = path.dirname(normPath);
  const dirName = path.basename(dir);
  const parentDir = path.dirname(dir);
  const parentDirName = path.basename(parentDir);
  const grandparentDir = path.dirname(parentDir);
  const grandparentDirName = path.basename(grandparentDir);

  // If workspace is available, check if the file is nested inside a session directory under the workspace
  if (workspace && workspaceKeys) {
    if (
      matchesWorkspaceWithKeys(parentDirName, workspaceKeys) &&
      !matchesWorkspaceWithKeys(dirName, workspaceKeys)
    ) {
      return "agent";
    }
    if (matchesWorkspaceWithKeys(dirName, workspaceKeys)) {
      return "user";
    }
  }

  // Any enclosing session directory (`<timestamp>_<uuid>`) makes this a subagent transcript,
  // including children of subagents that sit one directory deeper.
  for (let ancestor = dir; path.dirname(ancestor) !== ancestor; ancestor = path.dirname(ancestor)) {
    if (isSessionDirectoryName(path.basename(ancestor))) {
      return "agent";
    }
  }

  // Check structure relative to standard sessions directories:
  // e.g. <ompHome>/agent/sessions/<workspace-slug>/<session-dir>/<agent-name>.jsonl -> agent
  // e.g. <ompHome>/agent/sessions/<workspace-slug>/<session-file>.jsonl -> user
  if (grandparentDirName === "sessions") {
    return "agent";
  }
  if (parentDirName === "sessions") {
    // If dirName matches timestamp/uuid pattern, it's .omp/sessions/<session-dir>/<agent-name>.jsonl
    if (isSessionDirectoryName(dirName)) {
      return "agent";
    }
    return "user";
  }
  if (dirName === "sessions") {
    return "user";
  }

  // Check if immediate parent directory matches session directory pattern (<timestamp>_<uuid>)
  if (isSessionDirectoryName(dirName)) {
    return "agent";
  }

  return "user";
}

/**
 * Resolves a working directory OMP recorded. A Windows path (`C:\…`, `\\server\share\…`) resolves
 * with Windows semantics on any host and its drive letter is upper-cased, so `c:\app` and
 * `C:\app` name one workspace. On a Windows host a POSIX path keeps POSIX semantics; everything
 * else resolves against the host.
 */
export function resolveRecordedPath(value: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)) {
    return path.win32.resolve(value).replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
  }
  // On Windows a POSIX cwd was recorded by OMP under Linux/WSL; keep it off the current drive.
  if (process.platform === "win32" && value.startsWith("/")) return path.posix.resolve(value);
  return path.resolve(value);
}

const SESSION_DIR_UUID_REGEX =
  /_([0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_LINK_TEXT_LENGTH = 128;

function sessionIdFromSessionDirName(name: string): string | undefined {
  return isSessionDirectoryName(name) ? SESSION_DIR_UUID_REGEX.exec(name)?.[1] : undefined;
}

/**
 * Links a subagent transcript to the session that spawned it. OMP nests subagent transcripts under
 * the parent's session directory: `<session>/<Agent>.jsonl` for a child of the top-level session and
 * `<session>/<Parent>/<Parent>.<Child>.jsonl` for a child of a subagent. Newer transcripts also name
 * the parent file in the session header (`parentSession`); older ones are linked by layout.
 * Returns `parentSessionId` (the parent's sessionId as this adapter reports it) and `agentName`.
 */
export function ompSubagentLinkMetadata(
  transcript: Pick<ParsedTranscript, "filePath" | "headerParentSession">,
  sessionIdByPath: ReadonlyMap<string, string>,
): { parentSessionId?: string; agentName?: string } {
  const filePath = path.resolve(transcript.filePath);
  const dir = path.dirname(filePath);
  const dirName = path.basename(dir);
  const stem = path.basename(filePath, ".jsonl");

  const parentFromFile = (parentFile: string): string | undefined => {
    const resolved = path.resolve(parentFile);
    const known = sessionIdByPath.get(resolved);
    if (known) return known;
    return sessionIdFromSessionDirName(path.basename(resolved, ".jsonl"));
  };

  let parentSessionId: string | undefined;
  if (transcript.headerParentSession) {
    parentSessionId = parentFromFile(transcript.headerParentSession);
  }
  if (!parentSessionId) {
    // `<session dir>/<Agent>.jsonl` -> parent is `<session dir>.jsonl`; `<Parent>/<Parent>.<Child>.jsonl`
    // -> parent is `<Parent>.jsonl` beside its directory.
    parentSessionId = parentFromFile(path.join(path.dirname(dir), `${dirName}.jsonl`));
  }
  if (!parentSessionId) {
    // Deepest enclosing session directory is the nearest identifiable ancestor.
    for (
      let ancestor = dir;
      path.dirname(ancestor) !== ancestor;
      ancestor = path.dirname(ancestor)
    ) {
      parentSessionId = sessionIdFromSessionDirName(path.basename(ancestor));
      if (parentSessionId) break;
    }
  }

  const nestedPrefix = `${dirName}.`;
  const agentName = (stem.startsWith(nestedPrefix) ? stem.slice(nestedPrefix.length) : stem).slice(
    0,
    MAX_LINK_TEXT_LENGTH,
  );
  return {
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

/** Exact OMP versions qualified with recorded fixtures. */
export const OMP_TESTED_VERSIONS: readonly string[] = ["18.3.2", "18.6.0", "18.6.1"];

/**
 * Resolves the OMP home directory (~/.omp or $OMP_HOME).
 */
export function resolveOmpHome(options?: {
  customHome?: string;
  ompHome?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  if (options?.customHome) {
    return path.resolve(options.customHome);
  }
  if (options?.ompHome) {
    return path.resolve(options.ompHome);
  }
  const configured =
    readHostPathEnv(env, "OMP_HOME", platform) ?? readHostPathEnv(env, "RESIN_OMP_HOME", platform);
  if (configured) {
    return configured;
  }
  return path.resolve(resolveOmpUserHome(options), ".omp");
}

/**
 * The home OMP resolves `~/.omp` against: its `os.homedir()` is `$HOME` on POSIX and
 * `%USERPROFILE%` on Windows (Bun, like Node, never reads `HOME` there).
 */
function resolveOmpUserHome(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  return (
    options?.homeDir ??
    resolveHarnessUserHome({ platform: options?.platform, env: options?.env ?? process.env })
  );
}

/**
 * Probes for the OMP executable in custom paths, PATH, and standard directories.
 */
export async function findOmpExecutable(options?: {
  customExecutablePath?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  searchPaths?: string[];
  platform?: NodeJS.Platform;
}): Promise<string | null> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;

  // 1. Direct custom path
  if (options?.customExecutablePath) {
    const customPath = path.resolve(options.customExecutablePath);
    try {
      await fsp.access(customPath, fs.constants.X_OK);
      return customPath;
    } catch {
      try {
        const stat = await fsp.stat(customPath);
        if (stat.isFile()) {
          return customPath;
        }
      } catch {
        return null;
      }
    }
  }

  // 2. Explicit environment variable
  const ompBin = readHostEnv(env, "OMP_BIN", platform);
  if (ompBin) {
    const binPath = path.resolve(ompBin);
    try {
      const stat = await fsp.stat(binPath);
      if (stat.isFile()) {
        return binPath;
      }
    } catch {
      // continue searching
    }
  }

  const ompHome = resolveOmpHome({ env, homeDir: options?.homeDir, platform });
  const userHome = resolveOmpUserHome({ env, homeDir: options?.homeDir, platform });

  // 3. Search paths list in priority order: explicit searchPaths, PATH, then OMP's install dirs.
  // On Windows, OMP's installer (`irm https://omp.sh/install.ps1 | iex`) writes
  // `%LOCALAPPDATA%\omp\omp.exe` (`%PI_INSTALL_DIR%` when set) and `bun install -g` writes
  // `%USERPROFILE%\.bun\bin\omp.exe`; npm installs `%APPDATA%\npm\omp.cmd`.
  const fallbackDirs = [
    path.join(ompHome, "bin"),
    path.join(ompHome, "dist", "bin"),
    path.join(userHome, ".local", "bin"),
    path.join(userHome, ".bun", "bin"),
    path.join(userHome, ".cargo", "bin"),
    path.join(userHome, ".npm-global", "bin"),
  ];
  if (platform === "win32") {
    const localAppData =
      readHostEnv(env, "LOCALAPPDATA", platform) ?? path.join(userHome, "AppData", "Local");
    const appData =
      readHostEnv(env, "APPDATA", platform) ?? path.join(userHome, "AppData", "Roaming");
    const installDir = readHostEnv(env, "PI_INSTALL_DIR", platform);
    fallbackDirs.push(
      ...(installDir ? [installDir] : []),
      path.join(localAppData, "omp"),
      path.join(appData, "npm"),
    );
  } else if (!options?.homeDir && !options?.searchPaths?.length) {
    // System directories (only if homeDir was not explicitly overridden)
    fallbackDirs.push("/usr/local/bin", "/usr/bin", "/opt/homebrew/bin");
  }

  const found = await findHostExecutable(["omp"], {
    platform,
    env,
    preferredDirs: options?.searchPaths ?? [],
    fallbackDirs,
  });
  return found ? path.resolve(found) : null;
}

function parseOmpSemver(value: string): string | null {
  const match = value.trim().match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

/**
 * Detects the version of an OMP executable by running --version or inspecting package metadata.
 * Returns null when the executable cannot be verified; callers must fail closed.
 */
export async function detectOmpVersion(
  executablePath: string,
  options?: { timeoutMs?: number },
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 3000;

  try {
    const { stdout } = await runHarnessCommand(executablePath, ["--version"], { timeoutMs });
    const detected = parseOmpSemver(stdout);
    if (detected) {
      return detected;
    }
  } catch {
    // Fall through to package metadata. The executable itself is not trusted
    // until a real version can be established.
  }

  let currentDir = path.dirname(executablePath);
  for (let i = 0; i < 3; i++) {
    const pkgJsonPath = path.join(currentDir, "package.json");
    try {
      const content = await fsp.readFile(pkgJsonPath, "utf8");
      // SAFETY: package.json is parsed as a JSON manifest with an optional version field.
      const parsed = JSON.parse(content) as { version?: string };
      if (parsed.version && String(parsed.version) === parsed.version) {
        const detected = parseOmpSemver(parsed.version);
        if (detected) return detected;
      }
    } catch {}
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Probes for an OMP installation on the system.
 */
export async function probeOmpInstallation(
  options?: OmpDiscoveryOptions,
): Promise<HarnessInstallation | null> {
  const ompHome = resolveOmpHome(options);
  const now = new Date().toISOString();

  let ompHomeExists = false;
  try {
    const stat = await fsp.stat(ompHome);
    ompHomeExists = stat.isDirectory();
  } catch {
    ompHomeExists = false;
  }

  const execPath = await findOmpExecutable(options);

  if (options?.customExecutablePath && !execPath) {
    return {
      harnessId: "omp",
      displayName: "Oh My Pi",
      version: "0.0.0",
      executablePath: options.customExecutablePath,
      configPath: path.join(ompHome, "agent", "mcp.json"),
      homePath: ompHome,
      isInstalled: false,
      status: "missing_executable",
      detectedAt: now,
      metadata: {
        error: `Specified OMP executable was not found at "${options.customExecutablePath}"`,
      },
    };
  }

  if (!execPath && !ompHomeExists && !options?.customConfigPath) {
    return null;
  }

  const globalConfigPath = options?.customConfigPath
    ? path.resolve(options.customConfigPath)
    : path.join(ompHome, "agent", "mcp.json");

  let status: InstallationStatus = "missing_executable";
  let version = "0.0.0";
  let isInstalled = false;

  if (execPath) {
    const detectedVersion = await detectOmpVersion(execPath);
    if (detectedVersion) {
      version = detectedVersion;
      status = "ready";
      isInstalled = true;
    } else {
      status = "corrupt";
    }
  }

  if (options?.checkPermissions && execPath) {
    try {
      await fsp.access(execPath, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      status = "corrupt";
      isInstalled = false;
    }
  }

  return {
    harnessId: "omp",
    displayName: "Oh My Pi",
    version,
    executablePath: execPath ?? undefined,
    configPath: globalConfigPath,
    homePath: ompHome,
    isInstalled,
    status,
    detectedAt: now,
    metadata: {
      streaming: true,
      subagents: true,
      mcp: true,
      jsonlSessions: true,
      compaction: true,
      contextNudge: true,
    },
  };
}

/**
 * Inspects OMP session breadcrumbs and active session markers.
 */
export async function inspectBreadcrumbs(
  ompHome: string,
  workspacePath?: string,
): Promise<OmpBreadcrumb[]> {
  const breadcrumbs: OmpBreadcrumb[] = [];
  const breadcrumbDirs: string[] = [
    path.join(ompHome, "breadcrumbs"),
    path.join(ompHome, "state", "breadcrumbs"),
  ];

  if (workspacePath) {
    breadcrumbDirs.push(
      path.join(workspacePath, ".omp", "breadcrumbs"),
      path.join(workspacePath, ".omp"),
    );
  }

  for (const dir of breadcrumbDirs) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isFile() &&
          (entry.name.endsWith(".json") || entry.name.startsWith("active_session"))
        ) {
          try {
            const filePath = path.join(dir, entry.name);
            const content = await fsp.readFile(filePath, "utf8");
            const parsedObj = JSON.parse(content);
            if (parsedObj instanceof Object && !Array.isArray(parsedObj)) {
              // SAFETY: Breadcrumb file contains a parsed JSON session breadcrumb record.
              const parsed = parsedObj as Record<
                string,
                string | number | boolean | null | undefined
              > & {
                sessionId?: string;
                session_id?: string;
                workspacePath?: string;
                workspace_path?: string;
                lastActiveAt?: string;
                timestamp?: string;
                pid?: number;
                status?: string;
              };
              if (parsed.sessionId || parsed.session_id) {
                breadcrumbs.push({
                  sessionId: String(parsed.sessionId ?? parsed.session_id),
                  sessionDir: dir,
                  workspacePath: String(
                    parsed.workspacePath ?? parsed.workspace_path ?? workspacePath ?? "",
                  ),
                  lastActiveAt: String(
                    parsed.lastActiveAt ?? parsed.timestamp ?? new Date().toISOString(),
                  ),
                  pid: Number.isInteger(parsed.pid) ? parsed.pid : undefined,
                  status:
                    parsed.status && String(parsed.status) === parsed.status
                      ? parsed.status
                      : undefined,
                  metadata: parsed,
                });
              }
            }
          } catch {
            // ignore unparseable breadcrumb file
          }
        }
      }
    } catch {
      // directory does not exist
    }
  }

  // Also check active_session pointer files in ~/.omp or workspace/.omp
  const pointerLocations = [
    path.join(ompHome, "active_session.json"),
    path.join(ompHome, "agent", "sessions", "active.json"),
    path.join(ompHome, "sessions", "active.json"),
  ];
  if (workspacePath) {
    pointerLocations.push(
      path.join(workspacePath, ".omp", "active_session.json"),
      path.join(workspacePath, ".omp", "active.json"),
    );
  }

  for (const ptrPath of pointerLocations) {
    try {
      const content = await fsp.readFile(ptrPath, "utf8");
      const parsedObj = JSON.parse(content);
      if (parsedObj instanceof Object && !Array.isArray(parsedObj)) {
        // SAFETY: Pointer file contains a parsed JSON session pointer record.
        const parsed = parsedObj as Record<string, string | number | boolean | null | undefined> & {
          sessionId?: string;
          session_id?: string;
          workspacePath?: string;
          workspace_path?: string;
          lastActiveAt?: string;
          timestamp?: string;
          pid?: number;
          status?: string;
        };
        if (parsed.sessionId || parsed.session_id) {
          breadcrumbs.push({
            sessionId: String(parsed.sessionId ?? parsed.session_id),
            sessionDir: path.dirname(ptrPath),
            workspacePath: String(
              parsed.workspacePath ?? parsed.workspace_path ?? workspacePath ?? "",
            ),
            lastActiveAt: String(
              parsed.lastActiveAt ?? parsed.timestamp ?? new Date().toISOString(),
            ),
            pid: Number.isInteger(parsed.pid) ? parsed.pid : undefined,
            status:
              parsed.status && String(parsed.status) === parsed.status ? parsed.status : undefined,
            metadata: parsed,
          });
        }
      }
    } catch {
      // ignore missing pointer
    }
  }

  return breadcrumbs;
}

const OmpWorkspaceEntrySchema = z.union([
  z.string().transform((entryPath) => {
    const metadata: Record<string, string | number | boolean | null | undefined> = {};
    return {
      path: entryPath,
      rootPath: entryPath,
      workspaceId: undefined as string | undefined,
      name: undefined as string | undefined,
      metadata,
    };
  }),
  z
    .object({
      path: z.string().optional(),
      rootPath: z.string().optional(),
      workspaceId: z.string().optional(),
      name: z.string().optional(),
    })
    .passthrough()
    .transform((obj) => {
      // SAFETY: Object structure represents parsed workspace JSON dictionary metadata.
      const metadata = obj as Record<string, string | number | boolean | null | undefined>;
      return {
        path: obj.path,
        rootPath: obj.rootPath ?? obj.path,
        workspaceId: obj.workspaceId,
        name: obj.name,
        metadata,
      };
    }),
]);

const OmpWorkspacesRegistrySchema = z.union([
  z.array(OmpWorkspaceEntrySchema),
  z
    .object({
      workspaces: z.array(OmpWorkspaceEntrySchema).optional(),
    })
    .passthrough(),
]);

const MAX_CHUNK_BYTES = 64 * 1024; // 64 KiB

const OmpActivityMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "toolResult", "tool_result", "tool"]),
  content: z.union([z.string(), z.array(z.record(z.unknown()))]),
});

/**
 * Parsed transcript metadata extracted via bounded inspection.
 */
export interface ParsedTranscript {
  sessionId: string;
  headerSessionId: string | null;
  headerCwd: string | null;
  canonicalCwd: string | null;
  filePath: string;
  canonicalPath: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  fileSize: number;
  fileMtime: string;
  totalLines: number;
  hasExplicitLifecycle: boolean;
  inspectedBytes: number;
  sessionKind?: "user" | "agent";
  /** Path of the transcript this one was spawned or forked from (session header `parentSession`). */
  headerParentSession?: string | null;
}

/**
 * Inspects a single .jsonl session transcript using bounded prefix/tail chunk reads (max 64 KiB).
 * Never performs whole-file readFile.
 */
export async function inspectTranscriptFile(
  filePath: string,
  options?: {
    now?: number | Date;
    activeOnly?: boolean;
    onInspectTranscript?: (filePath: string) => void;
    // Internal cache signal; this does not change parsed transcript output.
    onFutureTerminalMessage?: (filePath: string) => void;
  },
): Promise<ParsedTranscript | null> {
  let fileHandle: fsp.FileHandle | null = null;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }

    const mtimeMs = stat.mtimeMs || stat.mtime.getTime();
    const now =
      options?.now instanceof Date
        ? options.now.getTime()
        : typeof options?.now === "number"
          ? options.now
          : Date.now();
    const ageMs = now - mtimeMs;

    if (options?.activeOnly && ageMs > ACTIVE_ONLY_TERMINAL_GRACE_MS) {
      return null;
    }

    options?.onInspectTranscript?.(filePath);
    let canonicalPath: string;
    try {
      canonicalPath = await fsp.realpath(filePath);
    } catch {
      canonicalPath = path.resolve(filePath);
    }

    fileHandle = await fsp.open(filePath, "r");

    const prefixBytesToRead = Math.min(stat.size, MAX_CHUNK_BYTES);
    const prefixBuffer = Buffer.alloc(prefixBytesToRead);
    const { bytesRead: prefixBytesRead } = await fileHandle.read(
      prefixBuffer,
      0,
      prefixBytesToRead,
      0,
    );
    let totalBytesInspected = prefixBytesRead;
    const prefixText = prefixBuffer.subarray(0, prefixBytesRead).toString("utf8");

    let tailText = "";
    if (stat.size > MAX_CHUNK_BYTES) {
      const tailOffset = Math.max(0, stat.size - MAX_CHUNK_BYTES);
      const tailBytesToRead = Math.min(stat.size - tailOffset, MAX_CHUNK_BYTES);
      const tailBuffer = Buffer.alloc(tailBytesToRead);
      const { bytesRead: tailBytesRead } = await fileHandle.read(
        tailBuffer,
        0,
        tailBytesToRead,
        tailOffset,
      );
      totalBytesInspected += tailBytesRead;
      tailText = tailBuffer.subarray(0, tailBytesRead).toString("utf8");
    }

    let createdAt = stat.birthtime?.getTime()
      ? stat.birthtime.toISOString()
      : stat.mtime.toISOString();
    // Unknown activity sorts before every capture run; file touches cannot authorize catchup.
    let updatedAt = new Date(0).toISOString();
    let headerSessionId: string | null = null;
    let headerCwd: string | null = null;
    let headerParentSession: string | null = null;
    let explicitStatus: SessionStatus | null = null;
    let totalLinesCount = 0;
    let validJsonObjectCount = 0;
    let hasExplicitLifecycle = false;

    const foldActivity = (parsed: Record<string, unknown>): void => {
      const eventType = String(parsed.type ?? parsed.event ?? "");
      const customExitReason = getOmpSessionExitReason(parsed);
      const isMessage =
        (eventType === "message" || eventType === "message_end") &&
        OmpActivityMessageSchema.safeParse(parsed.message ?? parsed).success;
      const timestamp = parsed.timestamp ?? parsed.time ?? parsed.ts;
      if (isMessage && (explicitStatus === "completed" || explicitStatus === "failed")) {
        const messageTimestampMs =
          typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
        if (Number.isFinite(messageTimestampMs) && messageTimestampMs > now) {
          options?.onFutureTerminalMessage?.(filePath);
        }
        if (!(typeof timestamp === "string" && messageTimestampMs <= now)) {
          // A malformed/future message must not turn historical completion into active capture.
          return;
        }
      }
      let lifecycleStatus: SessionStatus | null = null;
      if (
        eventType === "session_lifecycle" ||
        eventType === "lifecycle" ||
        eventType === "session" ||
        eventType === "agent_end" ||
        eventType === "agent_start" ||
        customExitReason !== undefined
      ) {
        const defaultAction =
          customExitReason !== undefined || eventType === "agent_end"
            ? "end"
            : eventType === "agent_start"
              ? "start"
              : "";
        const action = String(
          parsed.lifecycleType ?? parsed.action ?? parsed.status ?? defaultAction,
        ).toLowerCase();
        const exitReason = String(
          parsed.exitReason ?? parsed.reason ?? parsed.error ?? "",
        ).toLowerCase();
        const isFailure =
          action === "crash" ||
          action === "error" ||
          action === "fatal" ||
          action === "failed" ||
          exitReason === "error" ||
          exitReason === "crash" ||
          exitReason === "fatal" ||
          parsed.error !== undefined ||
          parsed.isError === true;
        if (isFailure) {
          lifecycleStatus = "failed";
        } else if (
          action === "end" ||
          action === "complete" ||
          action === "completed" ||
          action === "finish" ||
          action === "finished" ||
          action === "closed" ||
          action === "settle" ||
          eventType === "agent_end"
        ) {
          lifecycleStatus = "completed";
        } else if (action === "pause" || action === "suspend") {
          lifecycleStatus = "idle";
        } else if (action === "start" || action === "resume" || eventType === "agent_start") {
          lifecycleStatus = "active";
        }
      }

      if (lifecycleStatus !== null) {
        explicitStatus = lifecycleStatus;
        hasExplicitLifecycle = true;
      } else if (isMessage) {
        // Native messages after a real exit resume this same transcript identity.
        explicitStatus = "active";
      }
      if (lifecycleStatus !== null || isMessage || eventType === "session") {
        if (timestamp !== undefined) {
          updatedAt = String(timestamp);
        }
      }
    };

    if (stat.size <= MAX_CHUNK_BYTES) {
      const lines = prefixText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      totalLinesCount = lines.length;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            validJsonObjectCount++;
            if (i === 0 && (parsed.timestamp || parsed.time || parsed.ts)) {
              createdAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
            if (parsed.type === "session") {
              if (typeof parsed.id === "string" && parsed.id) {
                headerSessionId = parsed.id;
              }
              if (typeof parsed.cwd === "string" && parsed.cwd) {
                headerCwd = resolveRecordedPath(parsed.cwd);
              }
              if (parsed.timestamp) {
                createdAt = String(parsed.timestamp);
              }
              if (typeof parsed.parentSession === "string" && parsed.parentSession) {
                headerParentSession = parsed.parentSession;
              }
            }
            foldActivity(parsed);
          }
        } catch {
          // ignore unparseable line
        }
      }
    } else {
      const rawPrefixLines = prefixText.split("\n");
      const prefixLines = prefixText.endsWith("\n") ? rawPrefixLines : rawPrefixLines.slice(0, -1);

      for (let i = 0; i < prefixLines.length; i++) {
        const line = prefixLines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            validJsonObjectCount++;
            if (i === 0 && (parsed.timestamp || parsed.time || parsed.ts)) {
              createdAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
            if (parsed.type === "session") {
              if (typeof parsed.id === "string" && parsed.id) {
                headerSessionId = parsed.id;
              }
              if (typeof parsed.cwd === "string" && parsed.cwd) {
                headerCwd = resolveRecordedPath(parsed.cwd);
              }
              if (parsed.timestamp) {
                createdAt = String(parsed.timestamp);
              }
              if (typeof parsed.parentSession === "string" && parsed.parentSession) {
                headerParentSession = parsed.parentSession;
              }
            }
            foldActivity(parsed);
          }
        } catch {
          // ignore unparseable line
        }
      }

      // Only the tail can establish current lifecycle state. Even overlapping byte
      // windows can omit a whole record that is partial in both samples.
      explicitStatus = null;
      hasExplicitLifecycle = false;

      const rawTailLines = tailText.split("\n");
      const tailLines = rawTailLines.slice(1);
      for (const rawLine of tailLines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            validJsonObjectCount++;
            foldActivity(parsed);
          }
        } catch {
          // ignore unparseable line
        }
      }
      totalLinesCount = Math.max(prefixLines.length + tailLines.length, 1);
    }

    if (validJsonObjectCount === 0) {
      return null;
    }

    const isStale = ageMs > 60_000;

    let status: SessionStatus;
    if (explicitStatus === "completed" || explicitStatus === "failed") {
      status = explicitStatus;
    } else if (explicitStatus === "active" || explicitStatus === "idle") {
      status = isStale ? "idle" : explicitStatus;
    } else {
      status = isStale ? "idle" : "active";
    }

    let canonicalCwd: string | null = null;
    if (headerCwd) {
      try {
        canonicalCwd = await fsp.realpath(headerCwd);
      } catch {
        canonicalCwd = resolveRecordedPath(headerCwd);
      }
    }

    const fileName = path.basename(filePath, ".jsonl");
    const fallbackSessionId = fileName.startsWith("session-")
      ? fileName.slice(8)
      : fileName === "transcript" || fileName === "session"
        ? "session-main"
        : fileName;

    const sessionId = headerSessionId || fallbackSessionId;
    const sessionKind = classifyTranscriptSessionKind(filePath);

    return {
      sessionId,
      headerSessionId,
      headerCwd,
      canonicalCwd,
      filePath,
      canonicalPath,
      status,
      createdAt,
      updatedAt,
      fileSize: stat.size,
      fileMtime: stat.mtime.toISOString(),
      totalLines: totalLinesCount,
      hasExplicitLifecycle,
      inspectedBytes: totalBytesInspected,
      sessionKind,
      headerParentSession,
    };
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

interface TraversalTask {
  dir: string;
  depth: number;
}
/**
 * Checks whether a directory or path belongs to a known internal OMP cache subtree
 * (e.g. ~/.omp/agent/cache or .omp/cache) that must be excluded when traversing
 * OMP roots during session discovery.
 */
export function isKnownInternalCacheSubtree(
  name: string,
  parentDir: string,
  fullPath: string,
): boolean {
  const lowerName = name.toLowerCase();
  const parentBase = path.basename(parentDir).toLowerCase();

  // Direct entry into "cache" directory under "agent", ".omp", or "omp"
  if (
    lowerName === "cache" &&
    (parentBase === "agent" || parentBase === ".omp" || parentBase === "omp")
  ) {
    return true;
  }

  // Path contains /agent/cache/ or /.omp/cache/
  const normalized = path.resolve(fullPath);
  const cacheRegex = /(?:^|[\\/])(?:[.]?omp[\\/])?agent[\\/]cache(?:[\\/]|$)/i;
  if (cacheRegex.test(normalized)) {
    return true;
  }

  const ompCacheRegex = /(?:^|[\\/])[.]?omp[\\/]cache(?:[\\/]|$)/i;
  if (ompCacheRegex.test(normalized)) {
    return true;
  }

  return false;
}

/** One directory's traversal result, reused while the directory itself is unchanged. */
interface CachedDirectoryListing {
  readonly mtimeMs: number;
  readonly ino: number;
  readonly realDir: string;
  /** Transcript files and child directories, in traversal order. */
  readonly children: ReadonlyArray<{ readonly path: string; readonly isDirectory: boolean }>;
}

/**
 * Directory traversal results carried between scans. Transcript files themselves are still
 * inspected by the caller: appends change a file's mtime but never its directory's.
 */
export interface TranscriptDirectoryCache {
  readonly listings: Map<string, CachedDirectoryListing>;
  /** Candidate roots that did not exist (most workspaces have no project-local `.omp`). */
  readonly missing: Set<string>;
  /** Resolved workspace roots, cleared on each full sweep. */
  readonly realpaths: Map<string, string>;
  /** Explicit roots the listings were computed for; cache-subtree exclusion depends on them. */
  rootsKey?: string;
  /**
   * When false, a directory unmodified for {@link QUIET_DIRECTORY_MS} reuses its listing without
   * even a stat; the caller sets it on a periodic full sweep so quiet directories still refresh.
   */
  revalidateQuiet: boolean;
}

/** A listing is reused only once its directory has been quiet this long (mtime tick safety). */
const DIRECTORY_CACHE_SETTLE_MS = 2_000;
/** Directories untouched this long are only re-checked on a full sweep. */
const QUIET_DIRECTORY_MS = 10 * 60_000;
const transcriptPathCollator = new Intl.Collator();

/**
 * Traverses directory roots with bounded concurrency (breadth-first in waves) up to depth 4
 * to collect .jsonl transcript files without cyclic loops. With a `cache`, a directory whose
 * inode and mtime are unchanged since the previous scan is not resolved or listed again; the
 * cache is rewritten to hold exactly the directories this scan visited.
 */
export async function collectTranscriptFiles(
  roots: string[],
  concurrency = 32,
  cache?: TranscriptDirectoryCache,
): Promise<string[]> {
  const discoveredFiles: string[] = [];
  const discoveredFileSet = new Set<string>();
  const visitedDirs = new Set<string>();
  const explicitRootPaths = roots.map((r) => path.resolve(r));
  const rootsKey = JSON.stringify(explicitRootPaths);
  const previousListings =
    cache && cache.rootsKey === rootsKey ? new Map(cache.listings) : undefined;
  const previousMissing = cache ? new Set(cache.missing) : undefined;
  const now = Date.now();
  if (cache) {
    cache.listings.clear();
    cache.missing.clear();
    cache.rootsKey = rootsKey;
  }

  const listDirectory = async (
    dir: string,
    depth: number,
  ): Promise<CachedDirectoryListing | null> => {
    const dirStat = await fsp.stat(dir).catch(() => null);
    if (!dirStat?.isDirectory()) {
      cache?.missing.add(dir);
      return null;
    }
    const cached = previousListings?.get(dir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs && cached.ino === dirStat.ino) return cached;
    const realDir = await fsp.realpath(dir).catch(() => null);
    if (!realDir) return null;
    // Session directories also hold every tool artifact (hundreds of thousands of files on a
    // busy machine); drop those before any per-entry path work or sorting.
    const entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith(".jsonl"),
      )
      .sort((a, b) => transcriptPathCollator.compare(a.name, b.name));
    const children: Array<{ path: string; isDirectory: boolean }> = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const resolvedPath = path.resolve(fullPath);

      // Exclude known internal cache subtrees (e.g. agent/cache) when traversing OMP roots,
      // unless the caller explicitly passed a custom transcript root targeting that cache path.
      if (isKnownInternalCacheSubtree(entry.name, dir, fullPath)) {
        const isExplicitCacheTarget = explicitRootPaths.some(
          (root) =>
            isKnownInternalCacheSubtree(path.basename(root), path.dirname(root), root) &&
            (resolvedPath === root ||
              resolvedPath.startsWith(root + path.sep) ||
              root.startsWith(resolvedPath + path.sep)),
        );
        if (!isExplicitCacheTarget) {
          continue;
        }
      }

      if (entry.name.endsWith(".jsonl") && (entry.isFile() || entry.isSymbolicLink())) {
        children.push({ path: fullPath, isDirectory: false });
      } else if (entry.isDirectory()) {
        children.push({ path: fullPath, isDirectory: true });
      } else if (entry.isSymbolicLink() && depth + 1 <= 4) {
        const target = await fsp.stat(fullPath).catch(() => null);
        if (target?.isDirectory()) children.push({ path: fullPath, isDirectory: true });
      }
    }
    return { mtimeMs: dirStat.mtimeMs, ino: dirStat.ino, realDir, children };
  };

  let currentLevel: TraversalTask[] = roots.map((dir) => ({ dir, depth: 0 }));
  while (currentLevel.length > 0) {
    const nextLevel: TraversalTask[] = [];
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < currentLevel.length) {
        const item = currentLevel[nextIndex++];
        if (item.depth > 4) continue;

        try {
          if (!cache?.revalidateQuiet && previousMissing?.has(item.dir)) {
            cache?.missing.add(item.dir);
            continue;
          }
          const previous = previousListings?.get(item.dir);
          // Roots and workspace directories (where new sessions appear) are checked every scan;
          // only deeper quiet directories (per-session subagent folders) wait for a full sweep.
          const listing =
            previous &&
            item.depth >= 2 &&
            !cache?.revalidateQuiet &&
            now - previous.mtimeMs > QUIET_DIRECTORY_MS
              ? previous
              : await listDirectory(item.dir, item.depth);
          if (!listing) continue;
          if (now - listing.mtimeMs > DIRECTORY_CACHE_SETTLE_MS) {
            cache?.listings.set(item.dir, listing);
          }
          if (visitedDirs.has(listing.realDir)) continue;
          visitedDirs.add(listing.realDir);

          for (const child of listing.children) {
            if (child.isDirectory) {
              if (item.depth + 1 <= 4) {
                nextLevel.push({ dir: child.path, depth: item.depth + 1 });
              }
            } else if (!discoveredFileSet.has(child.path)) {
              discoveredFileSet.add(child.path);
              discoveredFiles.push(child.path);
            }
          }
        } catch {
          // ignore unreadable directory (fail-closed)
        }
      }
    }

    const workerCount = Math.min(concurrency, currentLevel.length);
    if (workerCount > 0) {
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);
    }

    currentLevel = nextLevel;
  }

  discoveredFiles.sort(transcriptPathCollator.compare);
  return discoveredFiles;
}

/**
 * Catalog of discovered OMP workspaces and sessions from a single scan.
 */
export interface OmpDiscoveryCatalog {
  readonly scannedAt: number;
  readonly ompHome: string;
  readonly workspaces: HarnessWorkspace[];
  readonly inspectedFilePaths: readonly string[];
  getSessionsForWorkspace(workspace: HarnessWorkspace): HarnessSession[];
  getAllSessions(): HarnessSession[];
}

/**
 * Builds a per-refresh OMP transcript catalog scanning the OMP home once.
 */
export async function buildOmpDiscoveryCatalog(
  options?: OmpDiscoveryOptions,
): Promise<OmpDiscoveryCatalog> {
  const ompHome = resolveOmpHome(options);
  const workspacesMap = new Map<string, HarnessWorkspace>();

  const cwd = path.resolve(options?.cwd ?? process.cwd());
  // Workspace roots are resolved on every scan, thousands of them on a long-lived OMP home;
  // between full sweeps the previous resolution stands.
  const scanCache = options?.directoryCache;
  if (scanCache?.revalidateQuiet) scanCache.realpaths.clear();
  const resolveWorkspaceRoot = async (rootPath: string, fallback: string): Promise<string> => {
    const known = scanCache?.realpaths.get(rootPath);
    if (known !== undefined) return known;
    const resolved = await fsp.realpath(rootPath).catch(() => fallback);
    scanCache?.realpaths.set(rootPath, resolved);
    return resolved;
  };

  // 1. Check if cwd has .omp directory
  try {
    const cwdOmpStat = await fsp.stat(path.join(cwd, ".omp"));
    if (cwdOmpStat.isDirectory()) {
      const realCwd = await fsp.realpath(cwd).catch(() => cwd);
      const workspaceId = createWorkspaceIdFromPath(realCwd);
      workspacesMap.set(realCwd, {
        workspaceId,
        rootPath: realCwd,
        name: path.basename(realCwd),
        harnessId: "omp",
        configPath: path.join(realCwd, ".omp", "agent", "mcp.json"),
        mcpConfigPath: path.join(realCwd, ".omp", "agent", "mcp.json"),
        metadata: { source: "cwd" },
      });
    }
  } catch {
    // cwd does not have .omp
  }

  // 2. Check searchPaths if provided
  if (options?.searchPaths && Array.isArray(options.searchPaths)) {
    for (const searchPath of options.searchPaths) {
      try {
        const absPath = path.resolve(searchPath);
        const stat = await fsp.stat(absPath);
        if (stat.isDirectory()) {
          const realPath = await fsp.realpath(absPath).catch(() => absPath);
          const workspaceId = createWorkspaceIdFromPath(realPath);
          if (!workspacesMap.has(realPath)) {
            workspacesMap.set(realPath, {
              workspaceId,
              rootPath: realPath,
              name: path.basename(realPath),
              harnessId: "omp",
              configPath: path.join(realPath, ".omp", "agent", "mcp.json"),
              mcpConfigPath: path.join(realPath, ".omp", "agent", "mcp.json"),
              metadata: { source: "searchPath" },
            });
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 3. Check ~/.omp/workspaces.json or ~/.omp/workspaces/
  const workspacesRegistryFile = path.join(ompHome, "workspaces.json");
  try {
    const content = await fsp.readFile(workspacesRegistryFile, "utf8");
    const parsed = JSON.parse(content);
    const parsedRegistry = OmpWorkspacesRegistrySchema.safeParse(parsed);
    if (parsedRegistry.success) {
      const entries = Array.isArray(parsedRegistry.data)
        ? parsedRegistry.data
        : (parsedRegistry.data.workspaces ?? []);
      for (const entry of entries) {
        const entryPath = entry.rootPath || entry.path;
        if (entryPath) {
          const realRoot = await fsp.realpath(entryPath).catch(() => entryPath);
          workspacesMap.set(realRoot, {
            workspaceId: entry.workspaceId || createWorkspaceIdFromPath(realRoot),
            rootPath: realRoot,
            name: entry.name || path.basename(realRoot),
            harnessId: "omp",
            configPath: path.join(realRoot, ".omp", "agent", "mcp.json"),
            mcpConfigPath: path.join(realRoot, ".omp", "agent", "mcp.json"),
            metadata: { source: "workspaces.json", ...(entry.metadata ?? {}) },
          });
        }
      }
    }
  } catch {
    // ignore missing registry
  }

  // 4. Breadcrumbs
  const breadcrumbs = await inspectBreadcrumbs(ompHome);
  for (const bc of breadcrumbs) {
    if (bc.workspacePath) {
      const realPath = await fsp.realpath(bc.workspacePath).catch(() => bc.workspacePath);
      const workspaceId = createWorkspaceIdFromPath(realPath);
      if (!workspacesMap.has(realPath)) {
        workspacesMap.set(realPath, {
          workspaceId,
          rootPath: realPath,
          name: path.basename(realPath),
          harnessId: "omp",
          configPath: path.join(realPath, ".omp", "agent", "mcp.json"),
          mcpConfigPath: path.join(realPath, ".omp", "agent", "mcp.json"),
          metadata: { source: "breadcrumb", ...bc.metadata },
        });
      }
    }
  }

  // 5. Scan session subdirectories for legacy workspace names
  for (const root of [path.join(ompHome, "agent", "sessions"), path.join(ompHome, "sessions")]) {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const workspaceKey = entry.name;
          let rootPath = workspaceKey;
          if (workspaceKey.startsWith("-")) {
            rootPath = `/${workspaceKey.slice(1).replace(/-/g, "/")}`;
          }
          const realRoot = await resolveWorkspaceRoot(rootPath, rootPath);
          if (!workspacesMap.has(realRoot)) {
            const workspaceId = createWorkspaceIdFromPath(realRoot);
            workspacesMap.set(realRoot, {
              workspaceId,
              rootPath: realRoot,
              name: path.basename(realRoot),
              harnessId: "omp",
              configPath: path.join(realRoot, ".omp", "agent", "mcp.json"),
              mcpConfigPath: path.join(realRoot, ".omp", "agent", "mcp.json"),
              metadata: { source: "session-directory" },
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 6. Collect candidate roots and transcripts
  const candidateRoots: string[] = [
    path.join(ompHome, "agent", "sessions"),
    path.join(ompHome, "sessions"),
  ];
  for (const ws of workspacesMap.values()) {
    candidateRoots.push(path.join(ws.rootPath, ".omp", "sessions"));
    candidateRoots.push(path.join(ws.rootPath, ".omp"));
  }

  const transcriptFiles = await collectTranscriptFiles(
    candidateRoots,
    undefined,
    options?.directoryCache,
  );

  const inspectedFilePaths: string[] = [];
  const inspectedTranscripts: ParsedTranscript[] = [];
  const seenCanonicalPaths = new Set<string>();

  const CONCURRENCY = 32;
  const inspectionResults = new Array<ParsedTranscript | null>(transcriptFiles.length).fill(null);

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < transcriptFiles.length) {
      const idx = nextIndex++;
      const filePath = transcriptFiles[idx];
      try {
        const inspected = options?.inspectTranscript
          ? await options.inspectTranscript(filePath, options)
          : await inspectTranscriptFile(filePath, options);
        inspectionResults[idx] = inspected;
      } catch {
        inspectionResults[idx] = null;
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, transcriptFiles.length);
  if (workerCount > 0) {
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
  }

  for (let i = 0; i < transcriptFiles.length; i++) {
    const inspected = inspectionResults[i];
    if (!inspected) continue;

    const filePath = transcriptFiles[i];
    inspectedFilePaths.push(filePath);

    if (seenCanonicalPaths.has(inspected.canonicalPath)) {
      continue;
    }
    seenCanonicalPaths.add(inspected.canonicalPath);
    inspectedTranscripts.push(inspected);

    // Add header-cwd workspaces
    const headerCwd =
      inspected.canonicalCwd ??
      (inspected.headerCwd ? resolveRecordedPath(inspected.headerCwd) : null);
    if (headerCwd) {
      const realHeaderCwd = headerCwd;
      if (!workspacesMap.has(realHeaderCwd)) {
        const workspaceId = createWorkspaceIdFromPath(realHeaderCwd);
        workspacesMap.set(realHeaderCwd, {
          workspaceId,
          rootPath: realHeaderCwd,
          name: path.basename(realHeaderCwd),
          harnessId: "omp",
          configPath: path.join(realHeaderCwd, ".omp", "agent", "mcp.json"),
          mcpConfigPath: path.join(realHeaderCwd, ".omp", "agent", "mcp.json"),
          metadata: { source: "header-cwd" },
        });
      }
    }
  }

  const allWorkspaces = Array.from(workspacesMap.values());
  // Labels are lossy (project-a and project/a collide), and normalized roots can
  // alias unknown relative roots. Cache only the exact root-and-identity pair.
  const sessionsByWorkspaceKey = new Map<string, HarnessSession[]>();
  const globalSeenSessionIds = new Set<string>();
  const allDeduplicatedSessions: HarnessSession[] = [];
  const transcriptMatchIndex = createTranscriptMatchIndex(inspectedTranscripts);
  const sessionIdByPath = new Map<string, string>();
  for (const t of inspectedTranscripts) {
    sessionIdByPath.set(path.resolve(t.filePath), t.sessionId);
    sessionIdByPath.set(t.canonicalPath, t.sessionId);
  }

  for (const workspace of allWorkspaces) {
    const realWsRoot = await resolveWorkspaceRoot(
      workspace.rootPath,
      resolveRecordedPath(workspace.rootPath),
    );
    const resolvedRoot = resolveRecordedPath(workspace.rootPath);
    const workspaceKeys = getWorkspaceKeys(workspace);
    const matchingTranscriptIndexes = findMatchingTranscriptIndexes(
      transcriptMatchIndex,
      [realWsRoot, resolvedRoot],
      [realWsRoot, workspace.rootPath],
      workspaceKeys,
    );

    const sessionMap = new Map<string, HarnessSession>();
    for (const transcriptIndex of matchingTranscriptIndexes) {
      const t = inspectedTranscripts[transcriptIndex];
      const effectiveSessionId =
        !t.headerSessionId && (t.sessionId === "session-main" || t.sessionId === "transcript-main")
          ? `${workspace.workspaceId}-main`
          : t.sessionId;
      const sessionKind = classifyTranscriptSessionKindWithKeys(
        t.filePath,
        workspace,
        workspaceKeys,
      );
      const session: HarnessSession = {
        sessionId: effectiveSessionId,
        workspaceId: workspace.workspaceId,
        harnessId: "omp",
        transcriptPath: t.filePath,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        metadata: {
          fileSize: t.fileSize,
          fileMtime: t.fileMtime,
          totalLines: t.totalLines,
          hasExplicitLifecycle: t.hasExplicitLifecycle,
          inspectedBytes: t.inspectedBytes,
          source: "omp-discovery",
          sessionKind,
          ...(sessionKind === "agent" ? ompSubagentLinkMetadata(t, sessionIdByPath) : {}),
        },
      };

      const existing = sessionMap.get(session.sessionId);
      if (!existing) {
        sessionMap.set(session.sessionId, session);
      } else {
        if (existing.status !== "active" && session.status === "active") {
          sessionMap.set(session.sessionId, session);
        } else if (new Date(session.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
          sessionMap.set(session.sessionId, session);
        }
      }
    }

    const sortedSessions = Array.from(sessionMap.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const workspaceKey = JSON.stringify([workspace.rootPath, workspace.workspaceId]);
    sessionsByWorkspaceKey.set(workspaceKey, sortedSessions);

    for (const s of sortedSessions) {
      if (!globalSeenSessionIds.has(s.sessionId)) {
        globalSeenSessionIds.add(s.sessionId);
        allDeduplicatedSessions.push(s);
      }
    }
  }

  const catalog: OmpDiscoveryCatalog = {
    scannedAt: Date.now(),
    ompHome,
    workspaces: allWorkspaces,
    inspectedFilePaths,
    getSessionsForWorkspace(workspace: HarnessWorkspace): HarnessSession[] {
      const workspaceKey = JSON.stringify([workspace.rootPath, workspace.workspaceId]);
      const cached = sessionsByWorkspaceKey.get(workspaceKey);
      if (cached !== undefined) {
        return cached;
      }

      // Dynamic fallback matching for workspaces not pre-registered in workspacesMap
      const resolvedRoot = resolveRecordedPath(workspace.rootPath);
      const workspaceKeys = getWorkspaceKeys(workspace);
      const matchingTranscriptIndexes = findMatchingTranscriptIndexes(
        transcriptMatchIndex,
        [resolvedRoot],
        [resolvedRoot, workspace.rootPath],
        workspaceKeys,
      );

      const sessionMap = new Map<string, HarnessSession>();
      for (const transcriptIndex of matchingTranscriptIndexes) {
        const t = inspectedTranscripts[transcriptIndex];
        const effectiveSessionId =
          !t.headerSessionId &&
          (t.sessionId === "session-main" || t.sessionId === "transcript-main")
            ? `${workspace.workspaceId}-main`
            : t.sessionId;
        const sessionKind = classifyTranscriptSessionKindWithKeys(
          t.filePath,
          workspace,
          workspaceKeys,
        );
        const session: HarnessSession = {
          sessionId: effectiveSessionId,
          workspaceId: workspace.workspaceId,
          harnessId: "omp",
          transcriptPath: t.filePath,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          metadata: {
            fileSize: t.fileSize,
            fileMtime: t.fileMtime,
            totalLines: t.totalLines,
            hasExplicitLifecycle: t.hasExplicitLifecycle,
            inspectedBytes: t.inspectedBytes,
            source: "omp-discovery",
            sessionKind,
            ...(sessionKind === "agent" ? ompSubagentLinkMetadata(t, sessionIdByPath) : {}),
          },
        };
        const existing = sessionMap.get(effectiveSessionId);
        if (
          !existing ||
          (existing.status !== "active" && session.status === "active") ||
          new Date(session.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
        ) {
          sessionMap.set(effectiveSessionId, session);
        }
      }

      const sortedSessions = Array.from(sessionMap.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      sessionsByWorkspaceKey.set(workspaceKey, sortedSessions);

      return sortedSessions;
    },
    getAllSessions(): HarnessSession[] {
      return allDeduplicatedSessions;
    },
  };

  return catalog;
}

/**
 * Discovers OMP workspaces from ~/.omp, session directories, breadcrumbs, and current directory.
 */
export async function discoverOmpWorkspaces(
  options?: OmpDiscoveryOptions,
): Promise<HarnessWorkspace[]> {
  const catalog = options?.catalog ?? (await buildOmpDiscoveryCatalog(options));
  return catalog.workspaces;
}

/**
 * Discovers OMP sessions for a given workspace.
 */
export async function discoverOmpSessions(
  workspace: HarnessWorkspace,
  options?: OmpDiscoveryOptions,
): Promise<HarnessSession[]> {
  const mergedOptions: OmpDiscoveryOptions = {
    ...options,
    searchPaths: Array.from(new Set([...(options?.searchPaths ?? []), workspace.rootPath])),
  };
  const catalog = options?.catalog ?? (await buildOmpDiscoveryCatalog(mergedOptions));
  return catalog.getSessionsForWorkspace(workspace);
}
/**
 * Computes normalized candidate directory keys for a workspace.
 */
function getWorkspaceKeys(workspace: HarnessWorkspace): Set<string> {
  const keys = new Set<string>();
  if (workspace.workspaceId) {
    keys.add(workspace.workspaceId.toLowerCase());
    keys.add(workspace.workspaceId.toLowerCase().replace(/^[-_]+|[-_]+$/g, ""));
  }
  if (workspace.name) {
    keys.add(workspace.name.toLowerCase());
    keys.add(workspace.name.toLowerCase().replace(/^[-_]+|[-_]+$/g, ""));
  }
  if (workspace.rootPath) {
    const raw = workspace.rootPath.replace(/\\/g, "/");
    const replaced = raw.replace(/[^a-zA-Z0-9_.-]/g, "-");
    keys.add(replaced.toLowerCase());
    keys.add(replaced.toLowerCase().replace(/^[-_]+|[-_]+$/g, ""));

    const wsPathId = createWorkspaceIdFromPath(workspace.rootPath).toLowerCase();
    keys.add(wsPathId);
    keys.add(wsPathId.replace(/^[-_]+|[-_]+$/g, ""));

    try {
      // Compare in the same `/`-separated form as `raw`; Windows paths ignore case.
      const home = resolveHarnessUserHome().replace(/\\/g, "/").replace(/\/+$/, "");
      const windowsPath = /^[a-zA-Z]:\//.test(raw) || raw.startsWith("//");
      const [rawKey, homeKey] = windowsPath ? [raw.toLowerCase(), home.toLowerCase()] : [raw, home];
      const underHome = rawKey === homeKey || rawKey.startsWith(`${homeKey}/`);
      if (home.length > 0 && underHome) {
        const rel = raw.slice(home.length).replace(/[^a-zA-Z0-9_.-]/g, "-");
        keys.add(rel.toLowerCase());
        keys.add(rel.toLowerCase().replace(/^[-_]+|[-_]+$/g, ""));
      }
    } catch {
      // ignore
    }
  }
  return keys;
}

/**
 * Matches a session directory name against normalized workspace keys.
 */
function matchesWorkspaceWithKeys(dirName: string, candidateKeys: ReadonlySet<string>): boolean {
  if (!dirName) return false;
  const normDir = dirName.toLowerCase();
  const strippedDir = normDir.replace(/^[-_]+|[-_]+$/g, "");
  return candidateKeys.has(normDir) || candidateKeys.has(strippedDir);
}

interface TranscriptMatchIndex {
  cwdByPath: Map<string, number[]>;
  paths: Array<{ value: string; transcriptIndex: number }>;
  directoriesByKey: Map<string, number[]>;
}

function createTranscriptMatchIndex(transcripts: ParsedTranscript[]): TranscriptMatchIndex {
  const cwdByPath = new Map<string, number[]>();
  const paths: TranscriptMatchIndex["paths"] = [];
  const directoriesByKey = new Map<string, number[]>();

  function addIndex(index: Map<string, number[]>, key: string, transcriptIndex: number) {
    const transcriptIndexes = index.get(key);
    if (transcriptIndexes) {
      transcriptIndexes.push(transcriptIndex);
    } else {
      index.set(key, [transcriptIndex]);
    }
  }

  function addDirectoryKeys(dirName: string, transcriptIndex: number) {
    if (!dirName) return;
    const normalized = dirName.toLowerCase();
    addIndex(directoriesByKey, normalized, transcriptIndex);
    const stripped = normalized.replace(/^[-_]+|[-_]+$/g, "");
    if (stripped !== normalized) {
      addIndex(directoriesByKey, stripped, transcriptIndex);
    }
  }

  for (let transcriptIndex = 0; transcriptIndex < transcripts.length; transcriptIndex++) {
    const transcript = transcripts[transcriptIndex];
    if (transcript.canonicalCwd || transcript.headerCwd) {
      const cwd =
        transcript.canonicalCwd ??
        (transcript.headerCwd ? resolveRecordedPath(transcript.headerCwd) : null);
      if (cwd !== null) {
        addIndex(cwdByPath, cwd, transcriptIndex);
      }
      if (transcript.headerCwd !== null) {
        addIndex(cwdByPath, transcript.headerCwd, transcriptIndex);
      }
      continue;
    }

    paths.push({ value: transcript.canonicalPath, transcriptIndex });
    paths.push({ value: transcript.filePath, transcriptIndex });
    addDirectoryKeys(path.basename(path.dirname(transcript.filePath)), transcriptIndex);
    addDirectoryKeys(
      path.basename(path.dirname(path.dirname(transcript.filePath))),
      transcriptIndex,
    );
  }

  paths.sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : a.transcriptIndex - b.transcriptIndex,
  );
  return { cwdByPath, paths, directoriesByKey };
}

function findMatchingTranscriptIndexes(
  index: TranscriptMatchIndex,
  cwdRoots: string[],
  pathRoots: string[],
  workspaceKeys: ReadonlySet<string>,
): number[] {
  const matchingIndexes = new Set<number>();
  const addIndexes = (indexes: number[] | undefined) => {
    if (indexes) {
      for (const transcriptIndex of indexes) {
        matchingIndexes.add(transcriptIndex);
      }
    }
  };

  // Header-cwd transcripts are indexed separately, so path/name fallback cannot claim them.
  for (const root of cwdRoots) {
    addIndexes(index.cwdByPath.get(root));
  }

  // The sorted path index makes .omp prefix lookups logarithmic plus their matching candidates.
  for (const root of pathRoots) {
    const prefix = path.join(root, ".omp");
    let low = 0;
    let high = index.paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index.paths[middle].value < prefix) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let i = low; i < index.paths.length && index.paths[i].value.startsWith(prefix); i++) {
      matchingIndexes.add(index.paths[i].transcriptIndex);
    }
  }

  for (const key of workspaceKeys) {
    addIndexes(index.directoriesByKey.get(key));
  }

  // Restore transcript input order after combining independent indexes.
  return Array.from(matchingIndexes).sort((a, b) => a - b);
}
/**
 * Creates a normalized workspace ID from an absolute workspace path.
 */
export function createWorkspaceIdFromPath(workspacePath: string): string {
  const clean = workspacePath
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (clean.length <= 128) return clean || "workspace-root";

  // Preserve the readable prefix while distinguishing paths that differ beyond the limit.
  const suffix = createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
  return `${clean.slice(0, 128 - suffix.length - 1)}-${suffix}`;
}
