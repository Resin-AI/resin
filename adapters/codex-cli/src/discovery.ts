import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  HarnessInstallation,
  ProbeInstallationOptions,
  SessionStatus,
} from "@resin/harness-contracts";

const execFileAsync = promisify(execFile);

export const CODEX_HARNESS_ID = "codex-cli";
export const CODEX_DISPLAY_NAME = "Codex CLI";
export const CODEX_MIN_SUPPORTED_VERSION = "0.1.0";

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

/**
 * Candidate binary names for Codex CLI depending on OS.
 */
export function getCandidateBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      "codex.exe",
      "codex.cmd",
      "codex.bat",
      "codex-cli.exe",
      "codex-cli.cmd",
      "codex-cli.bat",
      "codex",
    ];
  }
  return ["codex", "codex-cli"];
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
  const pathEnv = env.PATH || env.Path || "";
  const delimiter = platform === "win32" ? ";" : ":";
  const searchDirs = pathEnv.split(delimiter).filter(Boolean);

  // Also check standard user bin locations
  const home = env.CODEX_HOME || env.HOME || env.USERPROFILE || os.homedir();
  if (home) {
    searchDirs.push(
      path.join(home, ".codex", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, "bin"),
    );
  }

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, binName);
    if (await fileExists(fullPath)) {
      return fullPath;
    }
  }

  return null;
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
  const lookup = options?.pathLookup ?? ((bin) => defaultPathLookup(bin, env, platform));
  const candidateNames = getCandidateBinaryNames(platform);

  for (const candidate of candidateNames) {
    const resolved = await lookup(candidate);
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
 * Default command execution function using child_process.execFile.
 */
export const defaultCommandExecutor: CommandExecutor = async (file: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 5000,
      encoding: "utf8",
    });
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
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexResolvedPaths> {
  const env = options?.env ?? process.env;
  const home =
    env.CODEX_HOME ||
    options?.homeDir ||
    (env.HOME || env.USERPROFILE
      ? path.join(env.HOME || env.USERPROFILE!, ".codex")
      : os.homedir());

  let configPath: string;
  let configFormat: "toml" | "json" = "toml";

  if (options?.customConfigPath) {
    configPath = path.resolve(options.customConfigPath);
    configFormat = configPath.endsWith(".json") ? "json" : "toml";
  } else if (env.CODEX_CONFIG_PATH) {
    configPath = path.resolve(env.CODEX_CONFIG_PATH);
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
  } else if (env.CODEX_SESSIONS_DIR) {
    sessionRoot = path.resolve(env.CODEX_SESSIONS_DIR);
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
  const buffer = Buffer.allocUnsafe(Math.min(fileSize, CODEX_HEADER_MAX_BYTES));
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

    let newlineOffset = buffer.indexOf(0x0a, searchOffset);
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
      newlineOffset = buffer.indexOf(0x0a, searchOffset);
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
  const pathApi = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") ? path.win32 : path;
  if (!pathApi.isAbsolute(cwd)) return null;
  const resolved = pathApi.resolve(cwd);
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
export async function discoverCodexTranscripts(
  sessionRoot: string,
  options?: { now?: number | Date },
): Promise<CodexTranscriptInspection[]> {
  const nowMs =
    options?.now instanceof Date
      ? options.now.getTime()
      : typeof options?.now === "number"
        ? options.now
        : Date.now();
  const filePaths = await collectCodexTranscriptFiles(sessionRoot);
  const results: CodexTranscriptInspection[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < filePaths.length) {
      const index = nextIndex++;
      const filePath = filePaths[index];
      if (!filePath) continue;
      const inspected = await inspectCodexTranscript(filePath, nowMs);
      if (inspected) results.push(inspected);
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
  executor?: CommandExecutor;
  pathLookup?: PathLookupFn;
  minSupportedVersion?: string;
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
  const minVersion = options?.minSupportedVersion ?? CODEX_MIN_SUPPORTED_VERSION;

  const resolvedPaths = await resolveCodexPaths({
    customConfigPath: options?.customConfigPath,
    env: options?.env,
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

  if (compareSemver(version, minVersion) < 0) {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: CODEX_DISPLAY_NAME,
      version,
      isInstalled: true,
      status: "unsupported_version",
      executablePath,
      configPath: resolvedPaths.configPath,
      homePath: resolvedPaths.homeDir,
      detectedAt,
      metadata: {
        detectedVersion: version,
        minSupportedVersion: minVersion,
        homeDir: resolvedPaths.homeDir,
        sessionRoot: resolvedPaths.sessionRoot,
        configFormat: resolvedPaths.configFormat,
        diagnostics: [
          {
            code: "UNSUPPORTED_VERSION",
            severity: "error",
            message: `Detected Codex CLI version ${version} is lower than minimum supported version ${minVersion}.`,
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
      diagnostics: [],
    },
  };
}
