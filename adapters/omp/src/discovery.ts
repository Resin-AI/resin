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
  searchPaths?: string[];
  customExecutablePath?: string;
  customConfigPath?: string;
  checkPermissions?: boolean;
}

/**
 * Resolves the OMP home directory (~/.omp or $OMP_HOME).
 */
export function resolveOmpHome(options?: {
  customHome?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  if (options?.customHome) {
    return path.resolve(options.customHome);
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
      rootPath: undefined,
      workspaceId: undefined,
      name: undefined,
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
        rootPath: obj.rootPath,
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

/**
 * Discovers OMP workspaces from ~/.omp, session directories, breadcrumbs, and current directory.
 */
export async function discoverOmpWorkspaces(
  options?: OmpDiscoveryOptions,
): Promise<HarnessWorkspace[]> {
  const ompHome = resolveOmpHome(options);
  const workspacesMap = new Map<string, HarnessWorkspace>();

  const cwd = path.resolve(options?.cwd ?? process.cwd());

  // 1. Check if cwd has .omp directory
  try {
    const cwdOmpStat = await fsp.stat(path.join(cwd, ".omp"));
    if (cwdOmpStat.isDirectory()) {
      const workspaceId = createWorkspaceIdFromPath(cwd);
      workspacesMap.set(cwd, {
        workspaceId,
        rootPath: cwd,
        name: path.basename(cwd),
        harnessId: "omp",
        configPath: path.join(cwd, ".omp", "agent", "mcp.json"),
        mcpConfigPath: path.join(cwd, ".omp", "agent", "mcp.json"),
        metadata: { source: "cwd" },
      });
    }
  } catch {
    // cwd does not have .omp
  }

  // 2. Check searchPaths if provided
  if (options?.searchPaths) {
    for (const searchPath of options.searchPaths) {
      const absPath = path.resolve(searchPath);
      try {
        const ompDirStat = await fsp.stat(path.join(absPath, ".omp"));
        if (ompDirStat.isDirectory()) {
          const workspaceId = createWorkspaceIdFromPath(absPath);
          workspacesMap.set(absPath, {
            workspaceId,
            rootPath: absPath,
            name: path.basename(absPath),
            harnessId: "omp",
            configPath: path.join(absPath, ".omp", "agent", "mcp.json"),
            mcpConfigPath: path.join(absPath, ".omp", "agent", "mcp.json"),
            metadata: { source: "searchPath" },
          });
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
      const data = parsedRegistry.data;
      const list = Array.isArray(data) ? data : (data.workspaces ?? []);
      for (const ws of list) {
        const wsPath = ws.path ?? ws.rootPath;
        if (wsPath) {
          const absWsPath = path.resolve(wsPath);
          const workspaceId = ws.workspaceId ?? createWorkspaceIdFromPath(absWsPath);
          workspacesMap.set(absWsPath, {
            workspaceId,
            rootPath: absWsPath,
            name: ws.name ?? path.basename(absWsPath),
            harnessId: "omp",
            configPath: path.join(absWsPath, ".omp", "agent", "mcp.json"),
            mcpConfigPath: path.join(absWsPath, ".omp", "agent", "mcp.json"),
            metadata: ws.metadata,
          });
        }
      }
    }
  } catch {
    // registry does not exist
  }

  // 4. Inspect session roots to infer workspaces
  const sessionRoots = [path.join(ompHome, "agent", "sessions"), path.join(ompHome, "sessions")];
  for (const sessionsDir of sessionRoots) {
    try {
      const entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const wsMarkerFile = path.join(sessionsDir, entry.name, "workspace.json");
          try {
            const wsContent = await fsp.readFile(wsMarkerFile, "utf8");
            const parsedObj = JSON.parse(wsContent);
            if (parsedObj instanceof Object && !Array.isArray(parsedObj)) {
              // SAFETY: Workspace marker JSON contains workspace identity properties.
              const parsed = parsedObj as {
                path?: string;
                rootPath?: string;
                name?: string;
                workspaceId?: string;
              };
              const wsPath = parsed.path ?? parsed.rootPath;
              if (wsPath && String(wsPath) === wsPath) {
                const absWsPath = path.resolve(wsPath);
                if (!workspacesMap.has(absWsPath)) {
                  workspacesMap.set(absWsPath, {
                    workspaceId:
                      parsed.workspaceId && String(parsed.workspaceId) === parsed.workspaceId
                        ? parsed.workspaceId
                        : createWorkspaceIdFromPath(absWsPath),
                    rootPath: absWsPath,
                    name:
                      parsed.name && String(parsed.name) === parsed.name
                        ? parsed.name
                        : path.basename(absWsPath),
                    harnessId: "omp",
                    configPath: path.join(absWsPath, ".omp", "agent", "mcp.json"),
                    mcpConfigPath: path.join(absWsPath, ".omp", "agent", "mcp.json"),
                    metadata: parsed,
                  });
                }
              }
            }
          } catch {
            // ignore unparseable workspace marker
          }
        }
      }
    } catch {
      // sessionsDir does not exist
    }
  }
  // 5. Breadcrumbs
  const breadcrumbs = await inspectBreadcrumbs(ompHome);
  for (const bc of breadcrumbs) {
    if (bc.workspacePath && !workspacesMap.has(bc.workspacePath)) {
      const absPath = path.resolve(bc.workspacePath);
      const workspaceId = createWorkspaceIdFromPath(absPath);
      workspacesMap.set(absPath, {
        workspaceId,
        rootPath: absPath,
        name: path.basename(absPath),
        harnessId: "omp",
        activeSessionId: bc.sessionId,
        configPath: path.join(absPath, ".omp", "agent", "mcp.json"),
        mcpConfigPath: path.join(absPath, ".omp", "agent", "mcp.json"),
        metadata: { source: "breadcrumb", ...bc.metadata },
      });
    }
  }

  return Array.from(workspacesMap.values());
}

/**
 * Discovers OMP sessions for a given workspace.
 */
export async function discoverOmpSessions(
  workspace: HarnessWorkspace,
  options?: { ompHome?: string },
): Promise<HarnessSession[]> {
  const ompHome = resolveOmpHome({ customHome: options?.ompHome });
  const sessionsMap = new Map<string, HarnessSession>();
  const visitedFiles = new Set<string>();

  const candidateDirs: string[] = [
    path.join(workspace.rootPath, ".omp", "sessions"),
    path.join(workspace.rootPath, ".omp"),
    path.join(ompHome, "agent", "sessions", workspace.workspaceId),
    path.join(ompHome, "sessions", workspace.workspaceId),
    path.join(ompHome, "sessions"),
  ];

  if (options?.ompHome) {
    candidateDirs.push(path.join(ompHome, "agent", "sessions"));
  }
  // Bounded scan of workspace subdirectories under current and legacy session roots
  const sessionRoots = [path.join(ompHome, "agent", "sessions"), path.join(ompHome, "sessions")];

  const searchDirs = new Set<string>(candidateDirs);

  for (const root of sessionRoots) {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // In custom test homes or when directory matches workspace, include subdirectory
          if (Boolean(options?.ompHome) || matchesWorkspace(entry.name, workspace)) {
            searchDirs.add(path.join(root, entry.name));
          }
        }
      }
    } catch {
      // directory does not exist
    }
  }

  for (const dir of searchDirs) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const filePath = path.join(dir, entry.name);
          if (visitedFiles.has(filePath)) {
            continue;
          }
          visitedFiles.add(filePath);
          const session = await inspectSessionFile(filePath, workspace);
          if (session && !sessionsMap.has(session.sessionId)) {
            sessionsMap.set(session.sessionId, session);
          }
        }
      }
    } catch {
      // directory does not exist
    }
  }

  return Array.from(sessionsMap.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * Inspects a single .jsonl session transcript file.
 */
async function inspectSessionFile(
  filePath: string,
  workspace: HarnessWorkspace,
): Promise<HarnessSession | null> {
  try {
    const stat = await fsp.stat(filePath);
    const fileName = path.basename(filePath, ".jsonl");
    const sessionId = fileName.startsWith("session-")
      ? fileName.slice(8)
      : fileName === "transcript" || fileName === "session"
        ? `${workspace.workspaceId}-main`
        : fileName;

    let createdAt = stat.birthtime.toISOString();
    let updatedAt = stat.mtime.toISOString();
    let status: SessionStatus = "active";
    let totalLines = 0;

    // Read lines to parse header, timestamps, and lifecycle transitions
    const content = await fsp.readFile(filePath, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    totalLines = lines.length;
    if (lines.length > 0) {
      try {
        const firstObj = JSON.parse(lines[0]);
        if (firstObj instanceof Object && !Array.isArray(firstObj)) {
          // SAFETY: First transcript line is parsed as an object containing timestamp metadata.
          const first = firstObj as { timestamp?: string; time?: string; ts?: string };
          if (first.timestamp || first.time || first.ts) {
            createdAt = String(first.timestamp ?? first.time ?? first.ts);
          }
        }
      } catch {
        // ignore first line parse error
      }

      for (const line of lines) {
        try {
          const parsedObj = JSON.parse(line);
          if (parsedObj instanceof Object && !Array.isArray(parsedObj)) {
            // SAFETY: Transcript record lines are objects containing timestamp and event action types.
            const parsed = parsedObj as {
              timestamp?: string;
              time?: string;
              ts?: string;
              action?: string;
              event?: string;
              type?: string;
              lifecycleType?: string;
            };
            if (parsed.timestamp || parsed.time || parsed.ts) {
              updatedAt = String(parsed.timestamp ?? parsed.time ?? parsed.ts);
            }
            const eventType = String(parsed.type ?? parsed.event ?? "");
            if (eventType === "session_lifecycle" || eventType === "lifecycle") {
              const action = String(parsed.lifecycleType ?? parsed.action ?? "");
              if (action === "end" || action === "complete" || action === "finish") {
                status = "completed";
              } else if (action === "crash" || action === "error" || action === "fatal") {
                status = "failed";
              } else if (action === "pause" || action === "suspend") {
                status = "idle";
              } else if (action === "start" || action === "resume") {
                status = "active";
              }
            }
          }
        } catch {
          // ignore unparseable line
        }
      }
    }

    return {
      sessionId,
      workspaceId: workspace.workspaceId,
      harnessId: "omp",
      transcriptPath: filePath,
      status,
      createdAt,
      updatedAt,
      metadata: {
        fileSize: stat.size,
        totalLines,
        fileMtime: stat.mtime.toISOString(),
      },
    };
  } catch {
    return null;
  }
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
