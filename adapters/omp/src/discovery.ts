import { execFile } from "node:child_process";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  HarnessInstallation,
  HarnessSession,
  HarnessWorkspace,
  InstallationStatus,
  ProbeInstallationOptions,
  SessionStatus,
} from "@resin/harness-contracts";
import { z } from "zod";

const execFileAsync = promisify(execFile);

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
  homeDir?: string;
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

/**
 * Resolves the OMP home directory (~/.omp or $OMP_HOME).
 */
export function resolveOmpHome(options?: {
  customHome?: string;
  ompHome?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  if (options?.customHome) {
    return path.resolve(options.customHome);
  }
  if (options?.ompHome) {
    return path.resolve(options.ompHome);
  }
  if (env.OMP_HOME) {
    return path.resolve(env.OMP_HOME);
  }
  if (env.RESIN_OMP_HOME) {
    return path.resolve(env.RESIN_OMP_HOME);
  }
  const userHome = options?.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.resolve(userHome, ".omp");
}

/**
 * Probes for the OMP executable in custom paths, PATH, and standard directories.
 */
export async function findOmpExecutable(options?: {
  customExecutablePath?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  searchPaths?: string[];
}): Promise<string | null> {
  const env = options?.env ?? process.env;

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
  if (env.OMP_BIN) {
    const binPath = path.resolve(env.OMP_BIN);
    try {
      const stat = await fsp.stat(binPath);
      if (stat.isFile()) {
        return binPath;
      }
    } catch {
      // continue searching
    }
  }

  const ompHome = resolveOmpHome({ env, homeDir: options?.homeDir });
  const userHome = options?.homeDir ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const isWindows = process.platform === "win32";
  const binaryNames = isWindows ? ["omp.exe", "omp.cmd", "omp.bat", "omp"] : ["omp"];

  // 3. Search paths list in priority order
  const searchDirs: string[] = [];

  // A. Explicit searchPaths passed in options
  if (options?.searchPaths && options.searchPaths.length > 0) {
    searchDirs.push(...options.searchPaths);
  }

  // B. PATH environment variable
  if (env.PATH) {
    const pathDirs = env.PATH.split(path.delimiter).filter(Boolean);
    searchDirs.push(...pathDirs);
  }

  // C. OMP home and user bin directories
  searchDirs.push(
    path.join(ompHome, "bin"),
    path.join(ompHome, "dist", "bin"),
    path.join(userHome, ".local", "bin"),
    path.join(userHome, ".cargo", "bin"),
    path.join(userHome, ".npm-global", "bin"),
  );

  // D. System directories (only if homeDir was not explicitly overridden)
  if (!options?.homeDir && !options?.searchPaths?.length) {
    searchDirs.push("/usr/local/bin", "/usr/bin", "/opt/homebrew/bin");
  }

  for (const dir of searchDirs) {
    for (const binName of binaryNames) {
      const candidate = path.join(dir, binName);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) {
          return path.resolve(candidate);
        }
      } catch {
        // continue
      }
    }
  }

  return null;
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
    const { stdout } = await execFileAsync(executablePath, ["--version"], {
      timeout: timeoutMs,
    });
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

    if (options?.activeOnly && ageMs > 60_000) {
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
    let updatedAt = stat.mtime.toISOString();
    let headerSessionId: string | null = null;
    let headerCwd: string | null = null;
    let explicitStatus: SessionStatus | null = null;
    let totalLinesCount = 0;
    let validJsonObjectCount = 0;

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
                headerCwd = path.resolve(parsed.cwd);
              }
              if (parsed.timestamp) {
                createdAt = String(parsed.timestamp);
              }
            }
            if (parsed.timestamp || parsed.time || parsed.ts) {
              updatedAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
            const eventType = String(parsed.type ?? parsed.event ?? "");
            if (eventType === "session_lifecycle" || eventType === "lifecycle") {
              const action = String(parsed.lifecycleType ?? parsed.action ?? "");
              if (
                action === "end" ||
                action === "complete" ||
                action === "finish" ||
                action === "settle"
              ) {
                explicitStatus = "completed";
              } else if (action === "crash" || action === "error" || action === "fatal") {
                explicitStatus = "failed";
              } else if (action === "pause" || action === "suspend") {
                explicitStatus = "idle";
              } else if (action === "start" || action === "resume") {
                explicitStatus = "active";
              }
            }
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
                headerCwd = path.resolve(parsed.cwd);
              }
              if (parsed.timestamp) {
                createdAt = String(parsed.timestamp);
              }
            }
            if (parsed.timestamp || parsed.time || parsed.ts) {
              updatedAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
          }
        } catch {
          // ignore unparseable line
        }
      }

      const rawTailLines = tailText.split("\n");
      const tailLines = rawTailLines.slice(1);
      for (const rawLine of tailLines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            validJsonObjectCount++;
            if (parsed.timestamp || parsed.time || parsed.ts) {
              updatedAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
            const eventType = String(parsed.type ?? parsed.event ?? "");
            if (eventType === "session_lifecycle" || eventType === "lifecycle") {
              const action = String(parsed.lifecycleType ?? parsed.action ?? "");
              if (
                action === "end" ||
                action === "complete" ||
                action === "finish" ||
                action === "settle"
              ) {
                explicitStatus = "completed";
              } else if (action === "crash" || action === "error" || action === "fatal") {
                explicitStatus = "failed";
              } else if (action === "pause" || action === "suspend") {
                explicitStatus = "idle";
              } else if (action === "start" || action === "resume") {
                explicitStatus = "active";
              }
            }
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

    const hasExplicitLifecycle = explicitStatus !== null;
    let status: SessionStatus;
    if (explicitStatus !== null) {
      status = explicitStatus;
    } else {
      const now =
        options?.now instanceof Date
          ? options.now.getTime()
          : typeof options?.now === "number"
            ? options.now
            : Date.now();
      const mtimeMs = stat.mtimeMs || stat.mtime.getTime();
      const ageMs = now - mtimeMs;
      if (ageMs <= 60_000) {
        status = "active";
      } else {
        status = "completed";
      }
    }

    let canonicalCwd: string | null = null;
    if (headerCwd) {
      try {
        canonicalCwd = await fsp.realpath(headerCwd);
      } catch {
        canonicalCwd = path.resolve(headerCwd);
      }
    }

    const fileName = path.basename(filePath, ".jsonl");
    const fallbackSessionId = fileName.startsWith("session-")
      ? fileName.slice(8)
      : fileName === "transcript" || fileName === "session"
        ? "session-main"
        : fileName;

    const sessionId = headerSessionId || fallbackSessionId;

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
 * Traverses directory roots with bounded concurrency (breadth-first in waves) up to depth 4
 * to collect .jsonl transcript files without cyclic loops.
 */
export async function collectTranscriptFiles(roots: string[], concurrency = 32): Promise<string[]> {
  const discoveredFiles: string[] = [];
  const discoveredFileSet = new Set<string>();
  const visitedDirs = new Set<string>();

  let currentLevel: TraversalTask[] = roots.map((dir) => ({ dir, depth: 0 }));

  while (currentLevel.length > 0) {
    const nextLevel: TraversalTask[] = [];
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < currentLevel.length) {
        const item = currentLevel[nextIndex++];
        if (item.depth > 4) continue;

        try {
          const realDir = await fsp.realpath(item.dir).catch(() => null);
          if (!realDir) continue;
          if (visitedDirs.has(realDir)) continue;
          visitedDirs.add(realDir);

          const entries = await fsp.readdir(item.dir, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));

          for (const entry of entries) {
            const fullPath = path.join(item.dir, entry.name);
            if (entry.isDirectory()) {
              if (item.depth + 1 <= 4) {
                nextLevel.push({ dir: fullPath, depth: item.depth + 1 });
              }
            } else if (entry.isFile()) {
              if (entry.name.endsWith(".jsonl")) {
                if (!discoveredFileSet.has(fullPath)) {
                  discoveredFileSet.add(fullPath);
                  discoveredFiles.push(fullPath);
                }
              }
            } else if (entry.isSymbolicLink()) {
              if (entry.name.endsWith(".jsonl")) {
                if (!discoveredFileSet.has(fullPath)) {
                  discoveredFileSet.add(fullPath);
                  discoveredFiles.push(fullPath);
                }
              } else if (item.depth + 1 <= 4) {
                try {
                  const st = await fsp.stat(fullPath);
                  if (st.isDirectory()) {
                    nextLevel.push({ dir: fullPath, depth: item.depth + 1 });
                  }
                } catch {
                  // ignore broken symlink or inaccessible target
                }
              }
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

  discoveredFiles.sort((a, b) => a.localeCompare(b));
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
          const realRoot = await fsp.realpath(rootPath).catch(() => rootPath);
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

  const transcriptFiles = await collectTranscriptFiles(candidateRoots);

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
      inspected.canonicalCwd ?? (inspected.headerCwd ? path.resolve(inspected.headerCwd) : null);
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
  const sessionsByWorkspaceKey = new Map<string, HarnessSession[]>();
  const globalSeenSessionIds = new Set<string>();
  const allDeduplicatedSessions: HarnessSession[] = [];

  for (const workspace of allWorkspaces) {
    const realWsRoot = await fsp
      .realpath(workspace.rootPath)
      .catch(() => path.resolve(workspace.rootPath));
    const matchingTranscripts = inspectedTranscripts.filter((t) => {
      if (t.canonicalCwd || t.headerCwd) {
        const tCwd = t.canonicalCwd ?? (t.headerCwd ? path.resolve(t.headerCwd) : null);
        return (
          tCwd === realWsRoot ||
          tCwd === path.resolve(workspace.rootPath) ||
          t.headerCwd === realWsRoot ||
          t.headerCwd === path.resolve(workspace.rootPath)
        );
      }
      if (
        t.canonicalPath.startsWith(path.join(realWsRoot, ".omp")) ||
        t.canonicalPath.startsWith(path.join(workspace.rootPath, ".omp")) ||
        t.filePath.startsWith(path.join(realWsRoot, ".omp")) ||
        t.filePath.startsWith(path.join(workspace.rootPath, ".omp"))
      ) {
        return true;
      }
      const dirName = path.basename(path.dirname(t.filePath));
      const parentDirName = path.basename(path.dirname(path.dirname(t.filePath)));
      return matchesWorkspace(dirName, workspace) || matchesWorkspace(parentDirName, workspace);
    });

    const sessionMap = new Map<string, HarnessSession>();
    for (const t of matchingTranscripts) {
      const effectiveSessionId =
        !t.headerSessionId && (t.sessionId === "session-main" || t.sessionId === "transcript-main")
          ? `${workspace.workspaceId}-main`
          : t.sessionId;
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
          totalLines: t.totalLines,
          hasExplicitLifecycle: t.hasExplicitLifecycle,
          inspectedBytes: t.inspectedBytes,
          source: "omp-discovery",
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

    sessionsByWorkspaceKey.set(workspace.workspaceId, sortedSessions);
    sessionsByWorkspaceKey.set(realWsRoot, sortedSessions);
    sessionsByWorkspaceKey.set(path.resolve(workspace.rootPath), sortedSessions);
    sessionsByWorkspaceKey.set(workspace.rootPath, sortedSessions);

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
      const realRoot = path.resolve(workspace.rootPath);
      const cached =
        sessionsByWorkspaceKey.get(workspace.workspaceId) ??
        sessionsByWorkspaceKey.get(realRoot) ??
        sessionsByWorkspaceKey.get(workspace.rootPath);
      if (cached !== undefined) {
        return cached;
      }

      // Dynamic fallback matching for workspaces not pre-registered in workspacesMap
      const realWsRoot = realRoot;
      const matchingTranscripts = inspectedTranscripts.filter((t) => {
        if (t.canonicalCwd || t.headerCwd) {
          const tCwd = t.canonicalCwd ?? (t.headerCwd ? path.resolve(t.headerCwd) : null);
          return (
            tCwd === realWsRoot ||
            tCwd === path.resolve(workspace.rootPath) ||
            t.headerCwd === realWsRoot ||
            t.headerCwd === path.resolve(workspace.rootPath)
          );
        }
        if (
          t.canonicalPath.startsWith(path.join(realWsRoot, ".omp")) ||
          t.canonicalPath.startsWith(path.join(workspace.rootPath, ".omp")) ||
          t.filePath.startsWith(path.join(realWsRoot, ".omp")) ||
          t.filePath.startsWith(path.join(workspace.rootPath, ".omp"))
        ) {
          return true;
        }
        const dirName = path.basename(path.dirname(t.filePath));
        const parentDirName = path.basename(path.dirname(path.dirname(t.filePath)));
        return matchesWorkspace(dirName, workspace) || matchesWorkspace(parentDirName, workspace);
      });

      const sessionMap = new Map<string, HarnessSession>();
      for (const t of matchingTranscripts) {
        const effectiveSessionId =
          !t.headerSessionId &&
          (t.sessionId === "session-main" || t.sessionId === "transcript-main")
            ? `${workspace.workspaceId}-main`
            : t.sessionId;
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
            totalLines: t.totalLines,
            hasExplicitLifecycle: t.hasExplicitLifecycle,
            inspectedBytes: t.inspectedBytes,
            source: "omp-discovery",
          },
        };
        sessionMap.set(effectiveSessionId, session);
      }

      const sortedSessions = Array.from(sessionMap.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      sessionsByWorkspaceKey.set(workspace.workspaceId, sortedSessions);
      sessionsByWorkspaceKey.set(realWsRoot, sortedSessions);
      sessionsByWorkspaceKey.set(path.resolve(workspace.rootPath), sortedSessions);
      sessionsByWorkspaceKey.set(workspace.rootPath, sortedSessions);

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
      const home = os.homedir();
      if (raw.startsWith(home)) {
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
 * Matches a session directory name against a workspace descriptor.
 */
function matchesWorkspace(dirName: string, workspace: HarnessWorkspace): boolean {
  if (!dirName || !workspace) return false;
  const candidateKeys = getWorkspaceKeys(workspace);
  const normDir = dirName.toLowerCase();
  const strippedDir = normDir.replace(/^[-_]+|[-_]+$/g, "");

  return candidateKeys.has(normDir) || candidateKeys.has(strippedDir);
}
/**
 * Creates a normalized workspace ID from an absolute workspace path.
 */
export function createWorkspaceIdFromPath(workspacePath: string): string {
  const clean = workspacePath
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clean || "workspace-root";
}
