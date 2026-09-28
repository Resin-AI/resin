import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type HarnessInstallation,
  type ProbeInstallationOptions,
  type SessionStatus,
  classifyHarnessVersion,
  executableFileNames,
  findHostExecutable,
  readHostEnv,
  readHostPathEnv,
  resolveHarnessUserHome,
  runHarnessCommand,
} from "@resin/harness-contracts";

export const CODEX_HARNESS_ID = "codex-cli";
export const CODEX_DISPLAY_NAME = "Codex CLI";
/** Exact Codex CLI versions qualified with recorded rollout fixtures (tests/fixtures/recorded). */
export const CODEX_TESTED_VERSIONS: readonly string[] = ["0.156.1", "0.157.1"];

/**
 * Resolved paths for Codex CLI configuration and session directories.
 */
export interface CodexResolvedPaths {
  homeDir: string;
  configPath: string;
  sessionRoot: string;
  configFormat: "toml" | "json";
}

/**
 * Platform execution helper type for testability.
 */
export type CommandExecutor = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Path lookup helper type for testability.
 */
export type PathLookupFn = (binName: string) => Promise<string | null>;

const CODEX_COMMAND_NAMES = ["codex", "codex-cli"] as const;

/**
 * Candidate binary names for Codex CLI depending on OS. On Windows each name takes the `PATHEXT`
 * extensions (`codex.exe` from the standalone release, `codex.cmd` from npm); the extensionless
 * `codex` npm also writes is a POSIX shell script Windows cannot run.
 */
export function getCandidateBinaryNames(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return CODEX_COMMAND_NAMES.flatMap((name) => executableFileNames(name, { platform, env }));
}

/**
 * Install locations searched besides `PATH`: `~/.codex/bin`, `~/.cargo/bin` (cargo install),
 * `~/.local/bin`, `~/bin`; on Windows also npm's global bin (`%APPDATA%\npm`) and WinGet's links.
 */
function codexInstallDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { preferredDirs: string[]; fallbackDirs: string[] } {
  const userHome = resolveHarnessUserHome({ platform, env });
  const fallbackDirs = [
    path.join(userHome, ".codex", "bin"),
    path.join(userHome, ".cargo", "bin"),
    path.join(userHome, ".local", "bin"),
    path.join(userHome, "bin"),
  ];
  if (platform !== "win32") return { preferredDirs: [], fallbackDirs };
  const appData =
    readHostEnv(env, "APPDATA", platform) ?? path.join(userHome, "AppData", "Roaming");
  const localAppData =
    readHostEnv(env, "LOCALAPPDATA", platform) ?? path.join(userHome, "AppData", "Local");
  return {
    preferredDirs: [],
    fallbackDirs: [
      ...fallbackDirs,
      path.join(appData, "npm"),
      path.join(localAppData, "Microsoft", "WinGet", "Links"),
    ],
  };
}

/**
 * Checks if a file exists and is accessible.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Standard PATH lookup for a binary name.
 */
export async function defaultPathLookup(
  binName: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return await findHostExecutable([binName], {
    platform,
    env,
    ...codexInstallDirs(env, platform),
  });
}

/**
 * Finds the Codex CLI executable on the host system.
 */
export async function findCodexExecutable(options?: {
  customExecutablePath?: string;
  executablePath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathLookup?: PathLookupFn;
}): Promise<string | null> {
  const explicitPath = options?.executablePath ?? options?.customExecutablePath;
  if (explicitPath) {
    if (await fileExists(explicitPath)) {
      return path.resolve(explicitPath);
    }
    return null;
  }

  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (!options?.pathLookup) {
    // Windows semantics: per directory, every name and PATHEXT extension before the next one.
    const found = await findHostExecutable(CODEX_COMMAND_NAMES, {
      platform,
      env,
      ...codexInstallDirs(env, platform),
    });
    return found ? path.resolve(found) : null;
  }
  for (const candidate of getCandidateBinaryNames(platform, env)) {
    const resolved = await options.pathLookup(candidate);
    if (resolved) {
      return path.resolve(resolved);
    }
  }

  return null;
}

/**
 * Extracts a SemVer version string from raw command output.
 */
export function extractSemver(output: string): string | null {
  const semverRegex =
    /(?:(?:codex(?:-cli)?|version|v)?\s*)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
  const match = output.match(semverRegex);
  return match?.[1] ? match[1] : null;
}

/**
 * Compares two semver strings (returns >0 if v1 > v2, <0 if v1 < v2, 0 if equal).
 */
export function compareSemver(v1: string, v2: string): number {
  const clean1 = v1.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const clean2 = v2.replace(/^v/, "").split("-")[0]!.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const n1 = clean1[i] ?? 0;
    const n2 = clean2[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/**
 * Default command execution function: `execFile` without a shell, through `cmd.exe` only for the
 * Windows `codex.cmd` launcher (Windows refuses to spawn batch files directly).
 */
export const defaultCommandExecutor: CommandExecutor = async (file: string, args: string[]) => {
  try {
    const { stdout, stderr } = await runHarnessCommand(file, args, { timeoutMs: 5000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    // SAFETY: Node child_process execFile error objects contain stdout, stderr, code, and message properties.
    const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(err),
      exitCode: error.code ?? 1,
    };
  }
};

/**
 * Probes the Codex CLI binary to discover its version.
 */
export async function probeCodexVersion(
  executablePath: string,
  executor: CommandExecutor = defaultCommandExecutor,
): Promise<{ version: string | null; rawOutput: string }> {
  for (const flag of ["--version", "-V", "version"]) {
    const result = await executor(executablePath, [flag]);
    if (result.exitCode === 0 && (result.stdout.trim() || result.stderr.trim())) {
      const combined = `${result.stdout} ${result.stderr}`.trim();
      const version = extractSemver(combined);
      if (version) {
        return { version, rawOutput: combined };
      }
    }
  }

  return { version: null, rawOutput: "" };
}

/**
 * Resolves configuration and session root directories for Codex CLI.
 */
export async function resolveCodexPaths(options?: {
  customConfigPath?: string;
  customSessionRoot?: string;
  /** Codex home itself (what `$CODEX_HOME` would name). */
  homeDir?: string;
  /** The user's home; Codex home defaults to `<userHome>/.codex`. */
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<CodexResolvedPaths> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  // Codex reads `$CODEX_HOME`, else `dirs::home_dir()/.codex`: `$HOME` on POSIX, the profile
  // folder (`%USERPROFILE%`) on Windows, where `HOME` is ignored.
  const home =
    readHostPathEnv(env, "CODEX_HOME", platform) ??
    options?.homeDir ??
    path.join(options?.userHome ?? resolveHarnessUserHome({ platform, env }), ".codex");

  let configPath: string;
  let configFormat: "toml" | "json" = "toml";

  if (options?.customConfigPath) {
    configPath = path.resolve(options.customConfigPath);
    configFormat = configPath.endsWith(".json") ? "json" : "toml";
  } else if (readHostPathEnv(env, "CODEX_CONFIG_PATH", platform)) {
    configPath = readHostPathEnv(env, "CODEX_CONFIG_PATH", platform)!;
    configFormat = configPath.endsWith(".json") ? "json" : "toml";
  } else {
    const tomlPath = path.join(home, "config.toml");
    const jsonPath = path.join(home, "config.json");
    const mcpJsonPath = path.join(home, "mcp.json");

    if (await fileExists(tomlPath)) {
      configPath = tomlPath;
      configFormat = "toml";
    } else if (await fileExists(jsonPath)) {
      configPath = jsonPath;
      configFormat = "json";
    } else if (await fileExists(mcpJsonPath)) {
      configPath = mcpJsonPath;
      configFormat = "json";
    } else {
      configPath = tomlPath;
      configFormat = "toml";
    }
  }

  let sessionRoot: string;
  if (options?.customSessionRoot) {
    sessionRoot = path.resolve(options.customSessionRoot);
  } else if (readHostPathEnv(env, "CODEX_SESSIONS_DIR", platform)) {
    sessionRoot = readHostPathEnv(env, "CODEX_SESSIONS_DIR", platform)!;
  } else {
    const defaultSessions = path.join(home, "sessions");
    const rollouts = path.join(home, "rollouts");
    const history = path.join(home, "history");

    if (await fileExists(defaultSessions)) {
      sessionRoot = defaultSessions;
    } else if (await fileExists(rollouts)) {
      sessionRoot = rollouts;
    } else if (await fileExists(history)) {
      sessionRoot = history;
    } else {
      sessionRoot = defaultSessions;
    }
  }

  return {
    homeDir: home,
    configPath,
    sessionRoot,
    configFormat,
  };
}

export interface CodexTranscriptInspection {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  createdAt: string;
  updatedAt: string;
  cwd: string | null;
  canonicalCwd: string | null;
  nativeSessionId?: string;
  threadId?: string;
  rootId?: string;
  /** Spawning thread of a multi-agent child rollout. */
  parentThreadId?: string;
  status: SessionStatus;
  inspectedBytes: number;
}

const CODEX_MAX_TRANSCRIPTS = 512;
const CODEX_MAX_DEPTH = 6;
const CODEX_HEADER_MAX_BYTES = 1024 * 1024;
const CODEX_TAIL_BYTES = 16 * 1024;
const CODEX_READ_CHUNK_BYTES = 64 * 1024;
const CODEX_ACTIVE_GRACE_MS = 5 * 60 * 1000;
const CODEX_INSPECT_CONCURRENCY = 8;

type JsonObject = Record<string, unknown>;

interface ParsedCodexLine {
  value: JsonObject;
  offset: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function codexRecordType(record: JsonObject): string {
  return nonEmptyString(record.type) ?? nonEmptyString(record.event) ?? "";
}

function codexRecordPayload(record: JsonObject): JsonObject {
  return isJsonObject(record.payload) ? record.payload : record;
}

function codexEventName(record: JsonObject): string {
  const type = codexRecordType(record);
  const payload = codexRecordPayload(record);
  return (
    type === "event_msg"
      ? (nonEmptyString(payload.type) ?? nonEmptyString(payload.event) ?? type)
      : type
  ).toLowerCase();
}

function codexRecordTimestamp(record: JsonObject): string | null {
  const payload = codexRecordPayload(record);
  return (
    parseIsoTimestamp(record.timestamp) ??
    parseIsoTimestamp(record.created_at) ??
    parseIsoTimestamp(payload.timestamp) ??
    parseIsoTimestamp(payload.completed_at) ??
    parseIsoTimestamp(payload.started_at)
  );
}

function readCodexLines(
  buffer: Buffer,
  baseOffset: number,
  discardLeadingPartial: boolean,
): ParsedCodexLine[] {
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const parsed: ParsedCodexLine[] = [];
  let offset = baseOffset;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const lineOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;

    if (
      (index === 0 && discardLeadingPartial) ||
      (index === lines.length - 1 && !hasTrailingNewline)
    ) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isJsonObject(value)) parsed.push({ value, offset: lineOffset });
    } catch {
      // Incomplete and invalid rollout rows do not establish attribution or lifecycle state.
    }
  }
  return parsed;
}

interface CodexHeaderSample {
  buffer: Buffer;
  bytesRead: number;
  lines: ParsedCodexLine[];
  hasSessionMeta: boolean;
  firstLineComplete: boolean;
  overLimit: boolean;
}

async function readCodexHeader(
  handle: fs.FileHandle,
  fileSize: number,
): Promise<CodexHeaderSample> {
  // Zero-filled: line scanning below must never see bytes from memory the file did not supply.
  const buffer = Buffer.alloc(Math.min(fileSize, CODEX_HEADER_MAX_BYTES));
  const lines: ParsedCodexLine[] = [];
  let bytesRead = 0;
  let lineStart = 0;
  let searchOffset = 0;
  let hasSessionMeta = false;

  while (bytesRead < buffer.length) {
    const chunkLength = Math.min(CODEX_READ_CHUNK_BYTES, buffer.length - bytesRead);
    const read = await handle.read(buffer, bytesRead, chunkLength, bytesRead);
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;

    // Only the bytes read so far are transcript; the rest of the buffer is not yet filled.
    const filled = buffer.subarray(0, bytesRead);
    let newlineOffset = filled.indexOf(0x0a, searchOffset);
    while (newlineOffset >= 0) {
      const text = buffer.subarray(lineStart, newlineOffset).toString("utf8").trim();
      if (text) {
        try {
          const value: unknown = JSON.parse(text);
          if (isJsonObject(value)) {
            lines.push({ value, offset: lineStart });
            if (codexRecordType(value) === "session_meta") hasSessionMeta = true;
          }
        } catch {
          // Ignore malformed rows while continuing to the first complete metadata record.
        }
      }
      lineStart = newlineOffset + 1;
      searchOffset = lineStart;
      newlineOffset = filled.indexOf(0x0a, searchOffset);
    }
    if (hasSessionMeta) break;
    searchOffset = bytesRead;
  }

  const firstLineComplete = buffer.subarray(0, bytesRead).indexOf(0x0a) >= 0;
  return {
    buffer,
    bytesRead,
    lines,
    hasSessionMeta,
    firstLineComplete,
    overLimit: !hasSessionMeta && fileSize > CODEX_HEADER_MAX_BYTES,
  };
}

async function canonicalCodexCwd(cwd: string | undefined): Promise<string | null> {
  if (!cwd) return null;
  const windowsShaped = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  if (!windowsShaped && process.platform === "win32") {
    // A POSIX cwd in a Windows Codex home comes from Codex under Linux/WSL sharing this
    // CODEX_HOME. Keep its POSIX identity instead of resolving it onto the current drive.
    return cwd.startsWith("/") ? path.posix.resolve(cwd) : null;
  }
  const pathApi = windowsShaped ? path.win32 : path;
  if (!pathApi.isAbsolute(cwd)) return null;
  // Windows tools disagree on drive-letter case (`c:\` from VS Code, `C:\` elsewhere); one
  // directory is one workspace.
  const resolved =
    pathApi === path.win32
      ? pathApi.resolve(cwd).replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase())
      : pathApi.resolve(cwd);
  if (pathApi === path.win32 && process.platform !== "win32") return resolved;
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function lifecycleStatus(
  record: JsonObject,
  previous: SessionStatus | null,
  turnHasError: boolean,
): { status: SessionStatus | null; turnHasError: boolean } {
  const eventName = codexEventName(record);
  const payload = codexRecordPayload(record);
  if (eventName === "task_started") return { status: "active", turnHasError: false };
  if (eventName === "turn_aborted") return { status: "interrupted", turnHasError };
  if (
    eventName === "error" ||
    eventName === "task_failed" ||
    eventName === "turn_failed" ||
    eventName === "fatal_error"
  ) {
    return { status: "failed", turnHasError: true };
  }
  if (eventName === "task_complete") {
    const hasError =
      (payload.error !== undefined &&
        payload.error !== null &&
        payload.error !== false &&
        payload.error !== "") ||
      payload.is_error === true ||
      payload.isError === true ||
      ["error", "failed", "failure"].includes(String(payload.status ?? "").toLowerCase());
    return {
      status: hasError || turnHasError ? "failed" : "completed",
      turnHasError: hasError || turnHasError,
    };
  }
  return { status: previous, turnHasError };
}

async function inspectCodexTranscript(
  filePath: string,
  nowMs: number,
): Promise<CodexTranscriptInspection | null> {
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    handle = await fs.open(filePath, "r");
    const fileStat = await handle.stat();
    const size = fileStat.size;
    const header = await readCodexHeader(handle, size);
    const parsedLines: ParsedCodexLine[] = [...header.lines];
    let inspectedBytes = header.bytesRead;
    let trailingIncomplete = false;

    const tailOffset = Math.max(0, size - CODEX_TAIL_BYTES);
    const tailStartOffset = Math.max(tailOffset, header.bytesRead);
    if (tailStartOffset < size) {
      let discardLeadingPartial = false;
      if (tailStartOffset === header.bytesRead && header.bytesRead > 0) {
        discardLeadingPartial = header.buffer[header.bytesRead - 1] !== 0x0a;
      } else if (tailStartOffset > 0) {
        const precedingByte = Buffer.alloc(1);
        const precedingRead = await handle.read(precedingByte, 0, 1, tailStartOffset - 1);
        inspectedBytes += precedingRead.bytesRead;
        discardLeadingPartial = precedingRead.bytesRead !== 1 || precedingByte[0] !== 0x0a;
      }
      const tail = Buffer.allocUnsafe(size - tailStartOffset);
      const tailRead = await handle.read(tail, 0, tail.length, tailStartOffset);
      inspectedBytes += tailRead.bytesRead;
      trailingIncomplete = tailRead.bytesRead > 0 && tail[tailRead.bytesRead - 1] !== 0x0a;
      parsedLines.push(
        ...readCodexLines(
          tail.subarray(0, tailRead.bytesRead),
          tailStartOffset,
          discardLeadingPartial,
        ),
      );
    }
    const headerIncomplete =
      !header.hasSessionMeta && (!header.firstLineComplete || header.overLimit);

    let cwd: string | null = null;
    let canonicalCwd: string | null = null;
    let nativeSessionId: string | undefined;
    let threadId: string | undefined;
    let rootId: string | undefined;
    let parentThreadId: string | undefined;
    let createdAt = fileStat.birthtime.getTime()
      ? fileStat.birthtime.toISOString()
      : fileStat.mtime.toISOString();

    for (const { value } of parsedLines) {
      if (codexRecordType(value) !== "session_meta") continue;
      const payload = codexRecordPayload(value);
      const recordedCwd =
        typeof payload.cwd === "string" && payload.cwd.trim().length > 0 ? payload.cwd : undefined;
      if (recordedCwd) {
        cwd = recordedCwd;
        canonicalCwd = await canonicalCodexCwd(recordedCwd);
      }
      nativeSessionId = nonEmptyString(payload.session_id) ?? nonEmptyString(payload.sessionId);
      threadId =
        nonEmptyString(payload.thread_id) ??
        nonEmptyString(payload.threadId) ??
        nonEmptyString(payload.id);
      rootId =
        nonEmptyString(payload.root_thread_id) ??
        nonEmptyString(payload.rootThreadId) ??
        nonEmptyString(payload.root_id) ??
        nonEmptyString(payload.rootId);
      // Multi-agent children (0.156+) name the spawning thread; they share its cwd and project.
      const source = isJsonObject(payload.source) ? payload.source : undefined;
      const subagent = isJsonObject(source?.subagent) ? source.subagent : undefined;
      const spawn = isJsonObject(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
      parentThreadId =
        nonEmptyString(payload.parent_thread_id) ?? nonEmptyString(spawn?.parent_thread_id);
      createdAt = codexRecordTimestamp(value) ?? createdAt;
      break;
    }

    const orderedLines = parsedLines.map((line, index) => ({
      ...line,
      index,
      ordinal:
        typeof line.value.ordinal === "number" && Number.isFinite(line.value.ordinal)
          ? line.value.ordinal
          : null,
    }));
    if (orderedLines.length > 1 && orderedLines.every((line) => line.ordinal !== null)) {
      orderedLines.sort(
        (left, right) =>
          (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
          left.offset - right.offset ||
          left.index - right.index,
      );
    }

    let explicitStatus: SessionStatus | null = null;
    let turnHasError = false;
    let latestTimestamp: string | null = null;
    for (const { value } of orderedLines) {
      const timestamp = codexRecordTimestamp(value);
      if (timestamp) latestTimestamp = timestamp;
      const lifecycle = lifecycleStatus(value, explicitStatus, turnHasError);
      explicitStatus = lifecycle.status;
      turnHasError = lifecycle.turnHasError;
    }

    const ageMs = nowMs - fileStat.mtimeMs;
    const incomplete = trailingIncomplete || headerIncomplete;
    const fallbackStatus = incomplete
      ? "unknown"
      : ageMs < CODEX_ACTIVE_GRACE_MS
        ? "active"
        : "idle";
    const status =
      incomplete && explicitStatus !== "active" ? "unknown" : (explicitStatus ?? fallbackStatus);
    return {
      filePath,
      fileName: path.basename(filePath),
      fileSizeBytes: size,
      createdAt,
      updatedAt: latestTimestamp ?? fileStat.mtime.toISOString(),
      cwd,
      canonicalCwd,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(rootId ? { rootId } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      status,
      inspectedBytes,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function collectCodexTranscriptFiles(sessionRoot: string): Promise<string[]> {
  const files: string[] = [];
  const collect = async (directory: string, depth: number): Promise<void> => {
    if (depth > CODEX_MAX_DEPTH || files.length >= CODEX_MAX_TRANSCRIPTS) return;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of dirents) {
      if (files.length >= CODEX_MAX_TRANSCRIPTS) break;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))
      ) {
        files.push(fullPath);
      }
    }
  };
  await collect(sessionRoot, 0);
  return files;
}

/**
 * Inspects bounded rollout prefixes and tails once per discovery cycle.
 * Callers own only the returned, capped snapshot; transcripts are never read whole.
 */
/**
 * Inspections of settled transcripts from earlier scans, keyed by path. An entry is reused only
 * while the file's identity (inode, size, mtime, ctime) is unchanged and the file was already past
 * the active grace window when inspected, so neither its content nor its derived status can differ.
 */
export type CodexInspectionCache = Map<
  string,
  { identity: string; inspection: CodexTranscriptInspection }
>;

export async function discoverCodexTranscripts(
  sessionRoot: string,
  options?: { now?: number | Date; cache?: CodexInspectionCache },
): Promise<CodexTranscriptInspection[]> {
  const nowMs =
    options?.now instanceof Date
      ? options.now.getTime()
      : typeof options?.now === "number"
        ? options.now
        : Date.now();
  const filePaths = await collectCodexTranscriptFiles(sessionRoot);
  const results: CodexTranscriptInspection[] = [];
  const cache = options?.cache;
  const previous = cache ? new Map(cache) : undefined;
  cache?.clear();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < filePaths.length) {
      const index = nextIndex++;
      const filePath = filePaths[index];
      if (!filePath) continue;
      let identity: string | undefined;
      if (cache) {
        const stat = await fs.lstat(filePath).catch(() => null);
        if (stat?.isFile()) {
          identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const cached = previous?.get(filePath);
          if (cached && cached.identity === identity) {
            cache.set(filePath, cached);
            results.push(cached.inspection);
            continue;
          }
          // Only files already past the active grace window keep a stable status.
          if (nowMs - stat.mtimeMs <= CODEX_ACTIVE_GRACE_MS) identity = undefined;
        }
      }
      const inspected = await inspectCodexTranscript(filePath, nowMs);
      if (inspected) {
        results.push(inspected);
        if (cache && identity) cache.set(filePath, { identity, inspection: inspected });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CODEX_INSPECT_CONCURRENCY, filePaths.length) }, () => worker()),
  );
  return results.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.filePath.localeCompare(right.filePath),
  );
}

/**
 * Options for probing Codex CLI installation.
 */
export interface CodexProbeOptions extends ProbeInstallationOptions {
  platform?: NodeJS.Platform;
  /** The user's home (`resin init --home`); Codex home defaults to `<userHome>/.codex`. */
  userHome?: string;
  executor?: CommandExecutor;
  pathLookup?: PathLookupFn;
  testedVersions?: readonly string[];
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
}

/**
 * Probes the workstation environment for an installed Codex CLI harness.
 */
export async function probeCodexInstallation(
  options?: CodexProbeOptions,
): Promise<HarnessInstallation> {
  const detectedAt = new Date().toISOString();
  const testedVersions = options?.testedVersions ?? CODEX_TESTED_VERSIONS;

  const resolvedPaths = await resolveCodexPaths({
    customConfigPath: options?.customConfigPath,
    env: options?.env,
    platform: options?.platform,
    userHome: options?.userHome,
  });

  const executablePath = await findCodexExecutable({
    executablePath: options?.executablePath,
    customExecutablePath: options?.customExecutablePath,
    platform: options?.platform,
    env: options?.env,
    pathLookup: options?.pathLookup,
  });

  if (!executablePath) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version: "0.0.0",
      isInstalled: false,
      status: "missing_executable",
      executablePath: undefined,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        searchedCustomPath: options?.customExecutablePath,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "MISSING_EXECUTABLE",
            severity: "error",
            message: "Codex CLI executable ('codex' or 'codex-cli') not found on system PATH.",
            path: options?.customExecutablePath,
            timestamp: detectedAt,
          },
        ],
      },
    };
  }

  const { version, rawOutput } = await probeCodexVersion(
    executablePath,
    options?.executor ?? defaultCommandExecutor,
  );

  if (!version) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version: "0.0.0",
      isInstalled: true,
      status: "corrupt",
      executablePath,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        rawOutput,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "VERSION_PROBE_FAILED",
            severity: "error",
            message: `Failed to detect version from Codex CLI executable at ${executablePath}. Output: ${rawOutput}`,
            path: executablePath,
            timestamp: detectedAt,
          },
        ],
      },
    };
  }

  if (options?.checkPermissions) {
    try {
      const configDir = path.dirname(resolvedPaths.configPath);
      await fs.mkdir(configDir, { recursive: true });
      await fs.access(configDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        harnessId: CODEX_HARNESS_ID,
        displayName: CODEX_DISPLAY_NAME,
        version,
        isInstalled: true,
        status: "config_error",
        executablePath,
        configPath: resolvedPaths.configPath,
        homePath: resolvedPaths.homeDir,
        detectedAt,
        metadata: {
          permissionError: errorMsg,
          homeDir: resolvedPaths.homeDir,
          sessionRoot: resolvedPaths.sessionRoot,
          configFormat: resolvedPaths.configFormat,
          diagnostics: [
            {
              code: "CONFIG_PERMISSION_DENIED",
              severity: "error",
              message: `Cannot read/write Codex configuration directory: ${errorMsg}`,
              path: resolvedPaths.configPath,
              timestamp: detectedAt,
            },
          ],
        },
      };
    }
  }

  const versionClassification = classifyHarnessVersion(version, testedVersions);
  return {
    harnessId: CODEX_HARNESS_ID,
    displayName: CODEX_DISPLAY_NAME,
    version,
    isInstalled: true,
    status: "ready",
    executablePath,
    configPath: resolvedPaths.configPath,
    homePath: resolvedPaths.homeDir,
    detectedAt,
    metadata: {
      homeDir: resolvedPaths.homeDir,
      sessionRoot: resolvedPaths.sessionRoot,
      configFormat: resolvedPaths.configFormat,
      versionClassification,
      testedVersions: [...testedVersions],
      diagnostics:
        versionClassification === "tested"
          ? []
          : [
              {
                code: "UNTESTED_VERSION",
                severity: "warning",
                message: `Codex CLI ${version} has not been qualified by Resin; tested versions: ${testedVersions.join(", ")}. Capture may miss records whose shape changed.`,
                path: executablePath,
                timestamp: detectedAt,
              },
            ],
    },
  };
}
