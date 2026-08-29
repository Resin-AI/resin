import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { V1ProjectMetadata, V1ToolLock } from "@resin/contracts";
import {
  type ProjectBootstrapOptions,
  type ProjectBootstrapResult,
  bootstrapProject,
} from "./project/project-bootstrap.js";
import type { InitializeParams, McpClientInfo, McpRoot } from "./protocol/types.js";

export type WorkspaceResolutionSource = "roots" | "init_param" | "harness_session" | "cwd_fallback";

export interface ResolvedWorkspaceRoot {
  uri: string;
  path: string;
  name?: string;
}

export interface WorkspaceContext {
  /**
   * Backward-compatible workspace identifier (matches projectId UUID when bootstrapped).
   */
  workspaceId: string;
  /**
   * Stable project UUID.
   */
  projectId: string;
  /**
   * Canonical filesystem path to project root (Git root if present).
   */
  projectRoot: string;
  /**
   * Canonical root path (same as projectRoot, kept for backward compatibility).
   */
  canonicalRoot: string;
  /**
   * Original startup/candidate path that initiated workspace resolution.
   */
  startupPath: string;
  /**
   * Whether the project root or metadata is read-only.
   */
  isReadOnly: boolean;
  /**
   * Display or folder name of the workspace.
   */
  name: string;
  /**
   * Resolution source tier.
   */
  source: WorkspaceResolutionSource;
  /**
   * Resolved workspace roots.
   */
  roots: ResolvedWorkspaceRoot[];
  /**
   * Enclosing Git root path if present.
   */
  gitRoot?: string;
  /**
   * Client implementation info.
   */
  clientInfo?: McpClientInfo;
  /**
   * Detected harness ID.
   */
  harnessId?: string;
  /**
   * Session ID.
   */
  sessionId?: string;
  /**
   * Path to `.resin` directory.
   */
  resinDir?: string;
  /**
   * Path to `.resin/project.json`.
   */
  projectJsonPath?: string;
  /**
   * Path to `.resin/resin.lock`.
   */
  lockPath?: string;
  /**
   * Validated project metadata.
   */
  project?: V1ProjectMetadata;
  /**
   * Validated tool lock.
   */
  lock?: V1ToolLock;
  /**
   * Recovery state if one metadata file was synthesized from the other.
   */
  recoveredPartialState?: "project_recreated_lock" | "lock_recreated_project";
}

export interface WorkspaceResolutionOptions {
  initParams?: InitializeParams;
  harnessId?: string;
  sessionId?: string;
  clientInfo?: McpClientInfo;
  cwd?: string;
  customRoots?: McpRoot[];
  env?: Record<string, string | undefined>;
  disableBootstrap?: boolean;
  bootstrapOptions?: ProjectBootstrapOptions;
}

/**
 * Converts a URI or filesystem path to an absolute, normalized filesystem path.
 */
export function uriOrPathToFsPath(raw: string): string {
  if (raw.startsWith("file://")) {
    try {
      return path.normalize(fileURLToPath(raw));
    } catch {
      // Fallback manual parse if malformed URI
      const stripped = raw.replace(/^file:\/\//, "");
      return path.normalize(stripped);
    }
  }
  return path.normalize(path.resolve(raw));
}

/**
 * Normalizes and resolves symlinks in a filesystem path if it exists on disk.
 */
export function canonicalizePath(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // If realpath fails (e.g. permission or nonexistent in tests), use resolved
  }
  return path.normalize(resolved);
}

/**
 * Finds the enclosing git root (.git folder or worktree file) if it exists.
 */
export function findGitRoot(startDir: string): string | undefined {
  let current = canonicalizePath(startDir);
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    // Skip permission errors
  }
  const root = path.parse(current).root;

  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      if (fs.existsSync(gitPath)) {
        return current;
      }
    } catch {
      // Skip permission errors
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (current === root) break;
    current = parent;
  }
  return undefined;
}

/**
 * Generates a stable deterministic workspace identifier from canonical path for fallback unbootstrapped mode.
 */
export function generateWorkspaceId(canonicalRoot: string): string {
  const hash = crypto.createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
  const baseName = path.basename(canonicalRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `ws_${baseName || "root"}_${hash}`;
}

/**
 * Resolves workspace context using the 3-tier priority hierarchy:
 * 1. MCP roots capability / Initialize params (rootUri, rootPath, workspaceFolders, customRoots)
 * 2. Harness session association / Environment variables / Client metadata
 * 3. Current working directory fallback
 *
 * Bootstraps `.resin/project.json` and `.resin/resin.lock` at the canonical Git root
 * (or workspace directory) unless `disableBootstrap` is explicitly requested.
 */
export function resolveWorkspaceContext(
  options: WorkspaceResolutionOptions = {},
): WorkspaceContext {
  const env = options.env ?? process.env;
  const initParams = options.initParams;
  const customRoots = options.customRoots;

  let candidatePath: string | undefined;
  const collectedRoots: ResolvedWorkspaceRoot[] = [];
  let source: WorkspaceResolutionSource = "cwd_fallback";

  // Tier 1: MCP roots capability / custom roots
  if (customRoots && customRoots.length > 0) {
    for (const root of customRoots) {
      const fsPath = canonicalizePath(uriOrPathToFsPath(root.uri));
      collectedRoots.push({
        uri: root.uri,
        path: fsPath,
        name: root.name,
      });
    }
    candidatePath = collectedRoots[0].path;
    source = "roots";
  } else if (initParams?.workspaceFolders && initParams.workspaceFolders.length > 0) {
    for (const folder of initParams.workspaceFolders) {
      const fsPath = canonicalizePath(uriOrPathToFsPath(folder.uri));
      collectedRoots.push({
        uri: folder.uri,
        path: fsPath,
        name: folder.name,
      });
    }
    candidatePath = collectedRoots[0].path;
    source = "roots";
  } else if (initParams?.rootUri) {
    const fsPath = canonicalizePath(uriOrPathToFsPath(initParams.rootUri));
    collectedRoots.push({
      uri: initParams.rootUri,
      path: fsPath,
      name: path.basename(fsPath),
    });
    candidatePath = fsPath;
    source = "init_param";
  } else if (initParams?.rootPath) {
    const fsPath = canonicalizePath(uriOrPathToFsPath(initParams.rootPath));
    collectedRoots.push({
      uri: `file://${fsPath}`,
      path: fsPath,
      name: path.basename(fsPath),
    });
    candidatePath = fsPath;
    source = "init_param";
  }

  // Tier 2: Harness session association / Environment variables
  if (!candidatePath) {
    let envWorkspace: string | undefined;
    const harness = options.harnessId?.toLowerCase();

    if (harness === "claude" || harness === "claude-code") {
      envWorkspace = env.CLAUDE_WORKSPACE || env.RESIN_WORKSPACE;
    } else if (harness === "codex" || harness === "openai-codex") {
      envWorkspace = env.CODEX_WORKSPACE || env.RESIN_WORKSPACE;
    } else if (harness === "omp" || harness === "oh-my-pi") {
      envWorkspace = env.OMP_WORKSPACE || env.RESIN_WORKSPACE;
    } else if (!harness) {
      envWorkspace =
        env.RESIN_WORKSPACE || env.CLAUDE_WORKSPACE || env.CODEX_WORKSPACE || env.OMP_WORKSPACE;
    } else {
      envWorkspace = env.RESIN_WORKSPACE;
    }

    if (envWorkspace && envWorkspace.trim().length > 0) {
      const fsPath = canonicalizePath(uriOrPathToFsPath(envWorkspace.trim()));
      collectedRoots.push({
        uri: `file://${fsPath}`,
        path: fsPath,
        name: path.basename(fsPath),
      });
      candidatePath = fsPath;
      source = "harness_session";
    }
  }

  // Tier 3: Current working directory fallback
  if (!candidatePath) {
    const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    const fsPath = canonicalizePath(cwd);
    collectedRoots.push({
      uri: `file://${fsPath}`,
      path: fsPath,
      name: path.basename(fsPath),
    });
    candidatePath = fsPath;
    source = "cwd_fallback";
  }

  const canonicalCandidate = candidatePath;
  const gitRoot = findGitRoot(canonicalCandidate);
  const projectRoot = gitRoot ? canonicalizePath(gitRoot) : canonicalCandidate;
  const initialName = collectedRoots[0]?.name || path.basename(projectRoot) || "workspace";

  if (collectedRoots.length === 0) {
    collectedRoots.push({
      uri: `file://${projectRoot}`,
      path: projectRoot,
      name: initialName,
    });
  }

  let isRealDirectory = false;
  try {
    isRealDirectory = fs.existsSync(projectRoot) && fs.statSync(projectRoot).isDirectory();
  } catch {
    isRealDirectory = false;
  }

  if (options.disableBootstrap || !isRealDirectory) {
    const workspaceId = generateWorkspaceId(projectRoot);
    return {
      workspaceId,
      projectId: workspaceId,
      projectRoot,
      canonicalRoot: projectRoot,
      startupPath: canonicalCandidate,
      isReadOnly: false,
      name: initialName,
      source,
      roots: collectedRoots,
      gitRoot: gitRoot ? canonicalizePath(gitRoot) : undefined,
      clientInfo: options.clientInfo,
      harnessId: options.harnessId,
      sessionId: options.sessionId,
    };
  }

  const bootstrapResult = bootstrapProject(projectRoot, {
    ...options.bootstrapOptions,
    projectName: initialName,
  });

  return {
    workspaceId: bootstrapResult.projectId,
    projectId: bootstrapResult.projectId,
    projectRoot: bootstrapResult.projectRoot,
    canonicalRoot: bootstrapResult.projectRoot,
    startupPath: canonicalCandidate,
    isReadOnly: bootstrapResult.isReadOnly,
    name: initialName,
    source,
    roots: collectedRoots,
    gitRoot: gitRoot ? canonicalizePath(gitRoot) : undefined,
    clientInfo: options.clientInfo,
    harnessId: options.harnessId,
    sessionId: options.sessionId,
    resinDir: bootstrapResult.resinDir,
    projectJsonPath: bootstrapResult.projectJsonPath,
    lockPath: bootstrapResult.lockPath,
    project: bootstrapResult.project,
    lock: bootstrapResult.lock,
    recoveredPartialState: bootstrapResult.recoveredPartialState,
  };
}
