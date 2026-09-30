import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nowIso } from "@resin/contracts/common";
import type { ProbeInstallationOptions } from "@resin/harness-contracts";
import {
  type ConfigFsBridge,
  InMemoryConfigFsBridge,
  defaultFsBridge,
  findHostExecutable,
  readHostEnv,
  readHostPathEnv,
  resolveHarnessUserHome,
  runHarnessCommand,
} from "@resin/harness-contracts";
import type {
  HarnessInstallation,
  HarnessWorkspace,
  InstallationStatus,
} from "@resin/harness-contracts";
import { z } from "zod";

export type ExecFunction = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Claude Code versions qualified with the recorded fixtures under `tests/fixtures/recorded`. */
export const CLAUDE_TESTED_VERSIONS: readonly string[] = ["2.1.283"];

/**
 * Minimal semver comparator for Claude Code versions (e.g. "0.2.14", "1.0.0").
 */
export function isSupportedClaudeVersion(versionStr: string, minMajor = 0, minMinor = 1): boolean {
  const match = versionStr.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (major > minMajor) return true;
  if (major === minMajor) return minor >= minMinor;
  return false;
}

/**
 * Detect host platform details including WSL.
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeHostPlatform {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  if (platform === "linux") {
    if (env.WSL_DISTRO_NAME || env.WSLENV || (env.IS_WSL && env.IS_WSL !== "0")) {
      return "wsl";
    }
    return "linux";
  }
  return "other";
}

export type ClaudeHostPlatform = "darwin" | "linux" | "wsl" | "win32" | "other";

function configuredClaudeConfigDir(env: NodeJS.ProcessEnv, platform: ClaudeHostPlatform) {
  return readHostPathEnv(env, "CLAUDE_CONFIG_DIR", platform === "win32" ? "win32" : "linux");
}

/**
 * Resolve candidate Claude configuration directories based on platform. `$CLAUDE_CONFIG_DIR`
 * comes first: Claude Code keeps settings and session history (`projects/`) under it when set.
 * Native Windows uses `%USERPROFILE%\.claude` (`homeDir` is the profile folder there).
 */
export function resolveClaudeHomeCandidates(
  platform: ClaudeHostPlatform = detectPlatform(),
  homeDir = resolveHarnessUserHome(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const configured = configuredClaudeConfigDir(env, platform);
  if (configured) candidates.push(configured);

  switch (platform) {
    case "darwin":
      candidates.push(path.join(homeDir, "Library", "Application Support", "Claude"));
      candidates.push(path.join(homeDir, ".claude"));
      candidates.push(path.join(homeDir, ".config", "claude"));
      break;
    case "win32":
      candidates.push(path.join(homeDir, ".claude"));
      break;
    case "wsl":
      candidates.push(path.join(homeDir, ".claude"));
      candidates.push(path.join(homeDir, ".config", "claude"));
      // Also probe standard WSL Windows user profile path if available
      if (env.USERPROFILE) {
        candidates.push(path.join(env.USERPROFILE, ".claude"));
      }
      break;
    default:
      candidates.push(path.join(homeDir, ".claude"));
      if (env.XDG_CONFIG_HOME) {
        candidates.push(path.join(env.XDG_CONFIG_HOME, "claude"));
      }
      candidates.push(path.join(homeDir, ".config", "claude"));
      break;
  }

  return [...new Set(candidates)];
}

/**
 * Resolve candidate Claude global config file paths.
 */
export function resolveClaudeConfigFileCandidates(
  homeDir = resolveHarnessUserHome(),
  platform: ClaudeHostPlatform = detectPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const homes = resolveClaudeHomeCandidates(platform, homeDir, env);
  const candidates: string[] = [];

  // Claude's global state file: `$CLAUDE_CONFIG_DIR/.claude.json` when set, else `~/.claude.json`.
  const configured = configuredClaudeConfigDir(env, platform);
  if (configured) candidates.push(path.join(configured, ".claude.json"));
  candidates.push(path.join(homeDir, ".claude.json"));

  for (const home of homes) {
    candidates.push(path.join(home, "claude.json"));
    candidates.push(path.join(home, "mcp_settings.json"));
    candidates.push(path.join(home, "settings.json"));
  }

  return candidates;
}

/**
 * Resolve candidate Claude executable paths (POSIX). A bare `claude` entry means "run it from
 * `PATH`". Native Windows uses {@link resolveClaudeWindowsExecutableSearch} instead.
 */
export function resolveClaudeExecutableCandidates(
  homeDir = resolveHarnessUserHome(),
  platform: ClaudeHostPlatform = detectPlatform(),
): string[] {
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/opt/homebrew/bin/claude");
  } else {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/usr/bin/claude");
  }

  candidates.push(path.join(homeDir, ".npm-global", "bin", "claude"));
  candidates.push(path.join(homeDir, ".local", "bin", "claude"));
  candidates.push("claude");

  return candidates;
}

/**
 * Where Claude Code's launcher lives on native Windows, searched before `PATH`:
 * - native installer: `%USERPROFILE%\.local\bin\claude.exe`
 * - WinGet (`Anthropic.ClaudeCode`): `%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`
 * - npm global: `%APPDATA%\npm\claude.cmd`
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` is excluded: older Claude Desktop builds register a
 * `claude.exe` app alias there that would open the desktop app instead of the CLI.
 */
export function resolveClaudeWindowsExecutableSearch(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): { preferredDirs: string[]; excludeDirs: string[] } {
  const localAppData =
    readHostEnv(env, "LOCALAPPDATA", "win32") ?? path.join(homeDir, "AppData", "Local");
  const appData = readHostEnv(env, "APPDATA", "win32") ?? path.join(homeDir, "AppData", "Roaming");
  return {
    preferredDirs: [
      path.join(homeDir, ".local", "bin"),
      path.join(localAppData, "Microsoft", "WinGet", "Links"),
      path.join(appData, "npm"),
    ],
    excludeDirs: [path.join(localAppData, "Microsoft", "WindowsApps")],
  };
}

/**
 * Options for probing Claude Code installation.
 */
export interface ClaudeProbeInstallationOptions extends ProbeInstallationOptions {
  customExecutablePath?: string;
  customConfigPath?: string;
  configPath?: string;
  checkPermissions?: boolean;
  /** User home Claude expands `~` against; defaults to {@link resolveHarnessUserHome}. */
  homeDir?: string;
  /** Host platform (tests inject `win32`); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Probes the local environment for an active Claude Code installation.
 */
export async function probeClaudeInstallation(
  options?: ClaudeProbeInstallationOptions,
  fsBridge: ConfigFsBridge = defaultFsBridge,
  execFn?: ExecFunction,
): Promise<HarnessInstallation> {
  const env = options?.env ?? process.env;
  const hostPlatform = options?.platform ?? process.platform;
  const platform = detectPlatform(hostPlatform, env);
  const homeDir = options?.homeDir ?? resolveHarnessUserHome({ platform: hostPlatform, env });
  const detectedAt = nowIso();

  // 1. Resolve Executable Path
  let executablePath = options?.customExecutablePath ?? options?.executablePath;
  let rawVersionString: string | null = null;
  let status: InstallationStatus = "unknown";
  let isInstalled = false;

  const runner: ExecFunction =
    execFn ??
    (async (file: string, args: string[]) =>
      await runHarnessCommand(file, args, { platform: hostPlatform, env }));

  if (!executablePath && platform === "win32") {
    const search = resolveClaudeWindowsExecutableSearch(homeDir, env);
    executablePath =
      (await findHostExecutable(["claude"], {
        platform: "win32",
        env,
        ...search,
        isFile: (candidate) => fsBridge.exists(candidate),
      })) ?? undefined;
  } else if (!executablePath) {
    const candidates = resolveClaudeExecutableCandidates(homeDir, platform);
    for (const candidate of candidates) {
      if (candidate === "claude") {
        try {
          const { stdout } = await runner(candidate, ["--version"]);
          executablePath = candidate;
          rawVersionString = stdout.trim();
          break;
        } catch {
          // not found in PATH
        }
      } else {
        const exists = await fsBridge.exists(candidate);
        if (exists) {
          executablePath = candidate;
          break;
        }
      }
    }
  }

  // 2. Resolve Config & Home Paths
  let configPath = options?.customConfigPath ?? options?.configPath;
  let homePath: string | undefined;

  const homeCandidates = resolveClaudeHomeCandidates(platform, homeDir, env);
  for (const candidate of homeCandidates) {
    if (await fsBridge.exists(candidate)) {
      homePath = candidate;
      break;
    }
  }
  if (!homePath && homeCandidates.length > 0) {
    homePath = homeCandidates[0];
  }

  if (!configPath) {
    const configCandidates = resolveClaudeConfigFileCandidates(homeDir, platform, env);
    for (const candidate of configCandidates) {
      if (await fsBridge.exists(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) {
      configPath = path.join(homePath ?? homeDir, "claude.json");
    }
  }

  // 3. Attempt Version Detection if Executable is Found
  if (executablePath && !rawVersionString) {
    try {
      const { stdout } = await runner(executablePath, ["--version"]);
      rawVersionString = stdout.trim();
    } catch {
      // Execution failed
    }
  }

  // Parse Version
  let parsedVersion: string | undefined;
  if (rawVersionString) {
    const match = rawVersionString.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    if (match) {
      parsedVersion = match[1];
    }
  }

  // 4. Validate Installation Status
  if (executablePath && parsedVersion) {
    if (isSupportedClaudeVersion(parsedVersion)) {
      status = "ready";
      isInstalled = true;
    } else {
      status = "unsupported_version";
      isInstalled = true;
    }
  } else if (executablePath && !parsedVersion) {
    status = "corrupt";
    isInstalled = false;
  } else {
    status = "missing_executable";
    isInstalled = false;
  }

  // 5. Optional Permissions & Config Check
  if (options?.checkPermissions && configPath && isInstalled) {
    try {
      const configExists = await fsBridge.exists(configPath);
      if (configExists) {
        const content = await fsBridge.readFile(configPath);
        if (content !== null && content.trim().length > 0) {
          try {
            JSON.parse(content);
          } catch {
            status = "config_error";
          }
        }
      }
    } catch {
      status = "config_error";
    }
  }

  return {
    harnessId: "claude-code",
    displayName: "Claude Code",
    version: parsedVersion ?? "0.0.0",
    executablePath,
    configPath,
    homePath: homePath ?? homeDir,
    isInstalled,
    status,
    detectedAt,
    metadata: {
      platform,
      rawVersionString,
      checkedPermissions: Boolean(options?.checkPermissions),
    },
  };
}

const PROJECT_METADATA_BYTES = 64 * 1024;
const projectIndexSchema = z.object({
  originalPath: z.string().optional(),
  entries: z.array(z.object({ projectPath: z.string().optional() })).optional(),
});
const transcriptMetadataSchema = z.object({
  type: z.enum(["user", "assistant", "system", "session_start"]),
  sessionId: z.string(),
  cwd: z.string(),
  isSidechain: z.boolean().optional(),
});

function projectPathApi(rootPath: string): typeof path {
  return /^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.startsWith("\\\\") ? path.win32 : path.posix;
}

async function readProjectMetadata(
  filePath: string,
  fsBridge: ConfigFsBridge,
): Promise<string | null> {
  if (fsBridge instanceof InMemoryConfigFsBridge) {
    const content = await fsBridge.readFile(filePath);
    return content === null ? null : content.slice(0, PROJECT_METADATA_BYTES);
  }
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(PROJECT_METADATA_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function resolveClaudeProjectRoot(
  projectDir: string,
  fsBridge: ConfigFsBridge,
  dump: Record<string, string> | null,
): Promise<string | null> {
  const encodedName = path.basename(projectDir);
  const roots = new Set<string>();
  const addRoot = (candidate: string | undefined) => {
    if (!candidate || /[\0\r\n]/.test(candidate)) return;
    const pathApi = projectPathApi(candidate);
    if (!pathApi.isAbsolute(candidate)) return;
    // Claude's encoding is lossy. Verify metadata belongs to this directory,
    // but never attempt to reverse the encoding into a filesystem path.
    if (candidate.replace(/[^a-zA-Z0-9]/g, "-") !== encodedName) return;
    const normalized = pathApi.normalize(candidate);
    if (normalized !== candidate) return;
    roots.add(candidate);
  };

  const index = await readProjectMetadata(path.join(projectDir, "sessions-index.json"), fsBridge);
  if (index) {
    try {
      const parsed = projectIndexSchema.safeParse(JSON.parse(index));
      if (parsed.success) {
        addRoot(parsed.data.originalPath);
        for (const entry of parsed.data.entries ?? []) addRoot(entry.projectPath);
      }
    } catch {
      // A missing, partial, or corrupt index can be recovered from transcript metadata.
    }
  }

  let transcriptPaths: string[] = [];
  if (dump) {
    transcriptPaths = Object.keys(dump).filter(
      (filePath) => path.dirname(filePath) === projectDir && filePath.endsWith(".jsonl"),
    );
  } else {
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      transcriptPaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => path.join(projectDir, entry.name));
    } catch {
      // An unreadable project without exact metadata cannot be discovered safely.
    }
  }
  for (const transcriptPath of transcriptPaths) {
    const content = await readProjectMetadata(transcriptPath, fsBridge);
    if (!content) continue;
    const sessionId = path.basename(transcriptPath, ".jsonl");
    for (const line of content.slice(0, content.lastIndexOf("\n") + 1).split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = transcriptMetadataSchema.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.sessionId === sessionId && !parsed.data.isSidechain) {
          addRoot(parsed.data.cwd);
        }
      } catch {
        // Transcript records can be partially written or non-JSON.
      }
    }
    if (roots.size > 1) return null;
  }
  return roots.size === 1 ? (roots.values().next().value ?? null) : null;
}

/** Host facts for workspace discovery; each defaults to the running process. */
export interface ClaudeDiscoveryHost {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/**
 * Detect workspaces / projects managed by Claude Code: every `projects/<encoded cwd>` directory
 * under each Claude config home (`$CLAUDE_CONFIG_DIR`, then `~/.claude`). On Windows the encoded
 * cwd is a drive-letter (`C--Users-dev-app`) or UNC (`--wsl-localhost-Ubuntu-home-dev`) path.
 */
export async function detectClaudeWorkspaces(
  customHome?: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
  host: ClaudeDiscoveryHost = {},
): Promise<HarnessWorkspace[]> {
  const env = host.env ?? process.env;
  const hostPlatform = host.platform ?? process.platform;
  const homeDir = customHome || resolveHarnessUserHome({ platform: hostPlatform, env });
  const workspaces: HarnessWorkspace[] = [];
  const seenRootPaths = new Set<string>();

  // Add current working directory workspace if .claude or claude.json exists
  const cwd = host.cwd ?? process.cwd();
  const cwdClaudeJson = path.join(cwd, ".claude.json");
  const cwdClaudeDir = path.join(cwd, ".claude");

  if ((await fsBridge.exists(cwdClaudeJson)) || (await fsBridge.exists(cwdClaudeDir))) {
    const rootPath = path.resolve(cwd);
    seenRootPaths.add(rootPath);
    workspaces.push({
      workspaceId: `claude-ws-${path.basename(rootPath)}`,
      name: path.basename(rootPath),
      rootPath,
      harnessId: "claude-code",
      configPath: (await fsBridge.exists(cwdClaudeJson))
        ? cwdClaudeJson
        : path.join(cwdClaudeDir, "mcp_settings.json"),
      mcpConfigPath: (await fsBridge.exists(cwdClaudeJson))
        ? cwdClaudeJson
        : path.join(cwdClaudeDir, "mcp_settings.json"),
      metadata: { discoveredFrom: "cwd" },
    });
  }

  const homeCandidates = resolveClaudeHomeCandidates(
    detectPlatform(hostPlatform, env),
    homeDir,
    env,
  );
  const projectsDirs: string[] = [];
  const dump: Record<string, string> | null =
    "dump" in fsBridge && fsBridge.dump instanceof Function
      ? // SAFETY: In-memory test filesystem bridges provide a dump method returning a path-to-content map.
        (fsBridge.dump as () => Record<string, string>)()
      : null;

  for (const home of homeCandidates) {
    const projectsDir = path.join(home, "projects");
    if (await fsBridge.exists(projectsDir)) {
      projectsDirs.push(projectsDir);
    } else if (dump) {
      const normalizedProjectsDir = path.normalize(projectsDir);
      const prefix = normalizedProjectsDir.endsWith(path.sep)
        ? normalizedProjectsDir
        : `${normalizedProjectsDir}${path.sep}`;
      const hasFilesInProjectsDir = Object.keys(dump).some((p) =>
        path.normalize(p).startsWith(prefix),
      );
      if (hasFilesInProjectsDir) {
        projectsDirs.push(projectsDir);
      }
    }
  }

  const discoveredProjectDirs = new Set<string>();

  // 1. Scan in-memory fs bridge if applicable
  if (dump) {
    for (const filePath of Object.keys(dump)) {
      const normalized = path.normalize(filePath);
      for (const projectsDir of projectsDirs) {
        const normalizedProjectsDir = path.normalize(projectsDir);
        if (normalized.startsWith(`${normalizedProjectsDir}${path.sep}`)) {
          const rel = path.relative(normalizedProjectsDir, normalized);
          const parts = rel.split(path.sep).filter(Boolean);
          if (parts.length >= 1) {
            const projectDirName = parts[0];
            const projectDirPath = path.join(normalizedProjectsDir, projectDirName);
            discoveredProjectDirs.add(projectDirPath);
          }
        }
      }
    }
  }

  // 2. Scan real filesystem
  for (const projectsDir of projectsDirs) {
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          discoveredProjectDirs.add(path.join(projectsDir, entry.name));
        }
      }
    } catch {
      // directory might not be readable on real fs
    }
  }

  // 3. Process each discovered project directory
  for (const projectDirPath of discoveredProjectDirs) {
    const projectDirName = path.basename(projectDirPath);
    const normalizedRoot = await resolveClaudeProjectRoot(projectDirPath, fsBridge, dump);
    if (!normalizedRoot) continue;
    const rootPathApi = projectPathApi(normalizedRoot);

    if (seenRootPaths.has(normalizedRoot)) {
      const existing = workspaces.find((workspace) => workspace.rootPath === normalizedRoot);
      if (existing) {
        existing.metadata = {
          ...existing.metadata,
          projectDir: projectDirPath,
          encodedProjectName: projectDirName,
        };
      }
      continue;
    }
    seenRootPaths.add(normalizedRoot);

    const baseName = rootPathApi.basename(normalizedRoot) || projectDirName;
    workspaces.push({
      workspaceId: `claude-ws-${projectDirName}`,
      name: baseName,
      rootPath: normalizedRoot,
      harnessId: "claude-code",
      configPath: rootPathApi.join(normalizedRoot, ".claude.json"),
      mcpConfigPath: rootPathApi.join(normalizedRoot, ".claude.json"),
      metadata: {
        discoveredFrom: "projectsDir",
        projectDir: projectDirPath,
        encodedProjectName: projectDirName,
      },
    });
  }

  return workspaces;
}

export interface ClaudeSubagentTranscript {
  transcriptPath: string;
  parentSessionId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  /** Written within the last five minutes: attach as active. */
  recent: boolean;
  /** Identity the transcript and its `.meta.json` record: cwd, agent type/name/kind, description, spawning tool call. */
  head: Record<string, string>;
  /** Nesting level from the `.meta.json` (1 = spawned by the root session). */
  spawnDepth?: number;
  /** For a subagent spawned by another subagent: that subagent's id (its immediate parent). */
  parentAgentId?: string;
}

const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const subagentMetaSchema = z.object({
  agentType: z.string().optional(),
  description: z.string().optional(),
  toolUseId: z.string().optional(),
  spawnDepth: z.number().optional(),
});

/**
 * Lists the subagent transcripts of every session in one Claude project directory. A transcript
 * counts only when its first complete record says it is that parent session's sidechain for that
 * agent (`isSidechain`, `sessionId`, `agentId`), so a stray or foreign file is never attributed.
 */
export async function listClaudeSubagentTranscripts(
  projectDir: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<ClaudeSubagentTranscript[]> {
  const candidates: Array<{ transcriptPath: string; parentSessionId: string; agentId: string }> =
    [];
  const addCandidate = (transcriptPath: string) => {
    const parts = path.relative(projectDir, transcriptPath).split(path.sep);
    const match = SUBAGENT_FILE.exec(parts.at(-1) ?? "");
    if (parts.length < 3 || parts[0] === ".." || parts[1] !== "subagents" || match === null) return;
    candidates.push({ transcriptPath, parentSessionId: parts[0]!, agentId: match[1]! });
  };
  if (fsBridge instanceof InMemoryConfigFsBridge) {
    for (const filePath of Object.keys(fsBridge.dump())) addCandidate(path.normalize(filePath));
  } else {
    let sessionDirs: string[] = [];
    try {
      sessionDirs = (await fs.readdir(projectDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectDir, entry.name, "subagents"));
    } catch {
      return [];
    }
    for (const subagentsDir of sessionDirs) {
      try {
        for (const entry of await fs.readdir(subagentsDir, {
          recursive: true,
          withFileTypes: true,
        })) {
          if (entry.isFile()) addCandidate(path.join(entry.parentPath, entry.name));
        }
      } catch {
        // Sessions without subagents have no subagents directory.
      }
    }
  }

  const transcripts: ClaudeSubagentTranscript[] = [];
  for (const candidate of candidates) {
    const content = await readProjectMetadata(candidate.transcriptPath, fsBridge);
    if (!content) continue;
    const firstLine = content.slice(0, content.indexOf("\n") + 1).trim();
    let head: Record<string, string> | undefined;
    try {
      const record = transcriptMetadataSchema
        .extend({ agentId: z.string() })
        .safeParse(JSON.parse(firstLine));
      if (
        record.success &&
        record.data.isSidechain === true &&
        record.data.sessionId === candidate.parentSessionId &&
        record.data.agentId === candidate.agentId
      ) {
        head = { cwd: record.data.cwd };
      }
    } catch {
      // A first line still being written is read again on the next listing.
    }
    if (head === undefined) continue;
    let spawnDepth: number | undefined;
    const metaPath = candidate.transcriptPath.replace(/\.jsonl$/, ".meta.json");
    try {
      const meta = subagentMetaSchema.safeParse(
        JSON.parse((await fsBridge.readFile(metaPath)) ?? ""),
      );
      if (meta.success) {
        if (meta.data.agentType) {
          head.agentType = meta.data.agentType;
          head.agentKind = meta.data.agentType;
          head.agentName = meta.data.agentType;
        }
        if (meta.data.description) {
          head.agentDescription = meta.data.description;
          head.agentName ??= meta.data.description;
        }
        if (meta.data.toolUseId) head.parentToolCallId = meta.data.toolUseId;
        spawnDepth = meta.data.spawnDepth;
      }
    } catch {
      // The meta file is optional.
    }
    let createdAt = nowIso();
    let updatedAt = createdAt;
    let recent = true;
    if (!(fsBridge instanceof InMemoryConfigFsBridge)) {
      try {
        const stat = await fs.stat(candidate.transcriptPath);
        createdAt = stat.birthtime.toISOString();
        updatedAt = stat.mtime.toISOString();
        recent = Date.now() - stat.mtimeMs < 5 * 60 * 1000;
      } catch {
        continue;
      }
    }
    transcripts.push({
      ...candidate,
      createdAt,
      updatedAt,
      recent,
      head,
      ...(spawnDepth !== undefined ? { spawnDepth } : {}),
    });
  }
  // A subagent spawned by another subagent lives beside its siblings under the root session;
  // its own `spawnDepth` and spawning tool call id name the subagent transcript that made it.
  for (const transcript of transcripts) {
    const toolUseId = transcript.head.parentToolCallId;
    if (!toolUseId || (transcript.spawnDepth ?? 1) <= 1) continue;
    for (const sibling of transcripts) {
      if (sibling === transcript || sibling.parentSessionId !== transcript.parentSessionId) {
        continue;
      }
      const content = await fsBridge.readFile(sibling.transcriptPath);
      if (content?.includes(`"id":"${toolUseId}"`)) {
        transcript.parentAgentId = sibling.agentId;
        break;
      }
    }
  }
  return transcripts;
}
