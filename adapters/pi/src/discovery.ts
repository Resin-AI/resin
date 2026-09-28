import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import {
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  UNKNOWN_HARNESS_VERSION,
} from "@resin/harness-contracts";
import { PI_DISPLAY_NAME, PI_HARNESS_ID, type PiSessionRoot } from "./paths.js";

/** Pi versions qualified with recorded fixtures under `tests/fixtures/recorded/`. */
export const PI_TESTED_VERSIONS = ["0.87.1"] as const;

/** A transcript untouched for this long is idle rather than active. */
export const PI_ACTIVE_WINDOW_MS = 60_000;

const HEADER_SCAN_BYTES = 64 * 1024;

export interface PiSessionHeader {
  /** Session format version: 1 (linear), 2 (tree), 3 (hookMessage renamed to custom). */
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** Source transcript path when the session was created by `/fork`, `/clone`, or `--fork`. */
  parentSession?: string;
}

export interface PiTranscriptInfo {
  transcriptPath: string;
  header: PiSessionHeader;
  sessionId: string;
  updatedAt: Date;
  sizeBytes: number;
}

/** Parses a Pi session header line; null when the line is not a `type: "session"` header. */
export function parsePiSessionHeader(line: string): PiSessionHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "session") {
    return null;
  }
  const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : undefined;
  const cwd = "cwd" in parsed && typeof parsed.cwd === "string" ? parsed.cwd : undefined;
  if (!id || !cwd) return null;
  const version = "version" in parsed && typeof parsed.version === "number" ? parsed.version : 1;
  const timestamp =
    "timestamp" in parsed && typeof parsed.timestamp === "string" ? parsed.timestamp : "";
  const parentSession =
    "parentSession" in parsed && typeof parsed.parentSession === "string"
      ? parsed.parentSession
      : undefined;
  return { version, id, timestamp, cwd, ...(parentSession ? { parentSession } : {}) };
}

/** Reads the header of a Pi session file, or null when it has none (not a Pi transcript). */
export async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_SCAN_BYTES, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    return parsePiSessionHeader(buffer.toString("utf8", 0, newline === -1 ? bytesRead : newline));
  } finally {
    await handle.close();
  }
}

/**
 * Resin identifier for a Pi session id. Pi ids are UUIDs by default, but `--session-id` accepts
 * caller-chosen ids; characters outside Resin's identifier alphabet become `_`.
 */
export function toPiSessionId(headerId: string): string {
  const sanitized = headerId.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);
  return /^[a-zA-Z0-9_-]/.test(sanitized) ? sanitized : `_${sanitized.slice(0, 127)}`;
}

/** Session id encoded in a Pi transcript file name `<timestamp>_<session-id>.jsonl`. */
export function piSessionIdFromPath(transcriptPath: string): string | undefined {
  const base = path.basename(transcriptPath, ".jsonl");
  const separator = base.indexOf("_");
  return separator === -1 ? undefined : base.slice(separator + 1) || undefined;
}

async function listJsonlFiles(dir: string, depth: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    else if (entry.isDirectory() && depth > 0)
      files.push(...(await listJsonlFiles(full, depth - 1)));
  }
  return files;
}

/**
 * Session headers from earlier scans, keyed by transcript path. A header is the file's first line
 * and never changes, so it is re-read only when the path now names a different file (inode).
 * Entries are small and track files on disk, so the cache lives as long as its adapter.
 */
export type PiHeaderCache = Map<string, { ino: number; header: PiSessionHeader | null }>;

/**
 * Finds Pi transcripts under the given session roots. Default roots group files in one
 * `--<cwd>--` directory level; custom session directories hold files directly. Files are bound to
 * workspaces by the header's `cwd`, never by directory name. With a `headerCache`, unchanged
 * files cost one stat per scan instead of an open and read.
 */
export async function scanPiTranscripts(
  roots: readonly PiSessionRoot[],
  headerCache?: PiHeaderCache,
): Promise<PiTranscriptInfo[]> {
  const seen = new Set<string>();
  const transcripts: PiTranscriptInfo[] = [];
  for (const root of roots) {
    for (const file of await listJsonlFiles(root.dir, 1)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let stat: Stats;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      const cached = headerCache?.get(file);
      // An empty file has no header yet; look again once it has content.
      const header =
        cached && cached.ino === stat.ino && (cached.header || stat.size === 0)
          ? cached.header
          : await readPiSessionHeader(file);
      headerCache?.set(file, { ino: stat.ino, header });
      if (!header) continue;
      transcripts.push({
        transcriptPath: file,
        header,
        sessionId: toPiSessionId(header.id),
        updatedAt: stat.mtime,
        sizeBytes: stat.size,
      });
    }
  }
  return transcripts.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
}

export function piWorkspaceId(cwd: string): string {
  return `pi-${createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16)}`;
}

export function toPiWorkspace(
  cwd: string,
  paths: { configPath: string; mcpConfigPath: string },
): HarnessWorkspace {
  const rootPath = path.resolve(cwd);
  return {
    workspaceId: piWorkspaceId(rootPath),
    rootPath,
    name: path.basename(rootPath) || rootPath,
    harnessId: PI_HARNESS_ID,
    configPath: paths.configPath,
    mcpConfigPath: paths.mcpConfigPath,
    metadata: {},
  };
}

export function toPiSession(
  transcript: PiTranscriptInfo,
  workspaceId: string,
  now: number,
): HarnessSession {
  const createdAt = Number.isFinite(Date.parse(transcript.header.timestamp))
    ? new Date(transcript.header.timestamp).toISOString()
    : transcript.updatedAt.toISOString();
  const parentSessionId = transcript.header.parentSession
    ? piSessionIdFromPath(transcript.header.parentSession)
    : undefined;
  return {
    sessionId: transcript.sessionId,
    workspaceId,
    harnessId: PI_HARNESS_ID,
    transcriptPath: transcript.transcriptPath,
    status: now - transcript.updatedAt.getTime() <= PI_ACTIVE_WINDOW_MS ? "active" : "idle",
    createdAt,
    updatedAt: transcript.updatedAt.toISOString(),
    metadata: {
      cwd: transcript.header.cwd,
      sessionFormatVersion: transcript.header.version,
      ...(transcript.header.parentSession
        ? { parentSessionPath: transcript.header.parentSession }
        : {}),
      ...(parentSessionId ? { parentSessionId: toPiSessionId(parentSessionId) } : {}),
    },
  };
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await fsp.access(candidate, 1);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** npm package names Pi has shipped under; the executable belongs to one of them. */
const PI_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
]);

/**
 * Reads the version of the Pi npm package that owns the (symlink-resolved) executable. The
 * binary is never run: probing must stay cheap and side-effect free.
 */
export async function readPiVersion(executablePath: string): Promise<string | undefined> {
  let dir = path.dirname(await fsp.realpath(executablePath).catch(() => executablePath));
  for (let depth = 0; depth < 6; depth++) {
    const version = await readPiPackageVersion(dir);
    if (version !== undefined) return version;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Windows npm keeps its command shims (`pi.cmd`, `.ps1` and an extensionless script) in the
  // global prefix beside `node_modules/<package>`; no symlink leads from the shim to the package.
  for (const name of PI_PACKAGE_NAMES) {
    const version = await readPiPackageVersion(
      path.join(path.dirname(executablePath), "node_modules", name),
    );
    if (version !== undefined) return version;
  }
  return undefined;
}

async function readPiPackageVersion(dir: string): Promise<string | undefined> {
  try {
    const pkg: unknown = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
    if (
      pkg &&
      typeof pkg === "object" &&
      "name" in pkg &&
      typeof pkg.name === "string" &&
      PI_PACKAGE_NAMES.has(pkg.name) &&
      "version" in pkg &&
      typeof pkg.version === "string"
    ) {
      return pkg.version;
    }
  } catch {
    // not the package root
  }
  return undefined;
}

export interface ProbePiInstallationOptions {
  env: NodeJS.ProcessEnv;
  /** Resin's registration path (the bridge extension file). */
  configPath: string;
  homePath: string;
  executablePath?: string;
}

export async function probePiInstallation(
  options: ProbePiInstallationOptions,
): Promise<HarnessInstallation | null> {
  const detectedAt = new Date().toISOString();
  const executablePath = options.executablePath ?? (await findOnPath("pi", options.env));
  if (!executablePath) return null;
  const version = await readPiVersion(executablePath);
  return {
    harnessId: PI_HARNESS_ID,
    displayName: PI_DISPLAY_NAME,
    version: version ?? UNKNOWN_HARNESS_VERSION,
    executablePath,
    configPath: options.configPath,
    homePath: options.homePath,
    isInstalled: true,
    status: version ? "ready" : "unknown",
    detectedAt,
    metadata: {},
  };
}
