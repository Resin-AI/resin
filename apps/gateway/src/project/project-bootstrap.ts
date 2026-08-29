import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type V1ProjectMetadata,
  type V1ToolLock,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  validateV1ProjectMetadata,
  validateV1ToolLock,
} from "@resin/contracts";
import { canonicalizePath, findGitRoot } from "../workspace-resolver.js";
import type {
  ProjectBootstrapOptions,
  ProjectBootstrapResult,
  ProjectMetadataRecoveryState,
} from "./types.js";

export type { ProjectBootstrapOptions, ProjectBootstrapResult, ProjectMetadataRecoveryState };

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = err.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Synchronous sleep helper using Atomics.wait or busy-wait fallback.
 */
function synchronousSleep(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Busy-wait fallback
    }
  }
}

/**
 * Validates that directory or file does not suffer from casing collisions
 * or symlink security violations.
 */
function checkCaseCollision(parentDir: string, expectedName: string): void {
  try {
    const entries = fs.readdirSync(parentDir);
    const collisions = entries.filter(
      (e) => e.toLowerCase() === expectedName.toLowerCase() && e !== expectedName,
    );
    if (collisions.length > 0) {
      throw new Error(
        `Security violation: case collision detected for '${expectedName}' in '${parentDir}': found '${collisions.join(", ")}'`,
      );
    }
  } catch (err: unknown) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Validates that a file or directory path is not a symbolic link.
 */
function assertNotSymlink(targetPath: string, label: string): void {
  try {
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Security violation: ${label} cannot be a symbolic link at '${targetPath}'`);
    }
  } catch (err: unknown) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Checks whether a directory is read-only (EACCES, EROFS, EPERM).
 */
export function isDirectoryReadOnly(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return false;
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Cleans up lingering temporary files created during interrupted bootstrap runs.
 */
function cleanupStaleTempFiles(resinDir: string, maxAgeMs = 60_000): void {
  try {
    const entries = fs.readdirSync(resinDir);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.startsWith(".tmp-")) {
        const fullPath = path.join(resinDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // Ignore removal errors on temp files
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Acquires exclusive bootstrap concurrency lock on .resin/.bootstrap.lock
 * with bounded stale-lock recovery.
 */
function acquireBootstrapLock(
  resinDir: string,
  lockTimeoutMs = 5000,
  staleLockThresholdMs = 10000,
): () => void {
  const lockPath = path.join(resinDir, ".bootstrap.lock");
  const startTime = Date.now();

  assertNotSymlink(lockPath, "Bootstrap lockfile");
  checkCaseCollision(resinDir, ".bootstrap.lock");

  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
        0o600,
      );
      try {
        const payload = JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
        });
        fs.writeSync(fd, payload, 0, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Lock acquired successfully
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore lock release failure
        }
      };
    } catch (err: unknown) {
      if (getErrorCode(err) === "EEXIST") {
        let isStale = false;
        try {
          const stat = fs.statSync(lockPath);
          const age = Date.now() - stat.mtimeMs;

          let lockPid: number | undefined;
          try {
            const raw = fs.readFileSync(lockPath, "utf8");
            const parsed = JSON.parse(raw);
            if (typeof parsed.pid === "number") {
              lockPid = parsed.pid;
            }
            if (
              typeof parsed.createdAt === "number" &&
              Date.now() - parsed.createdAt > staleLockThresholdMs
            ) {
              isStale = true;
            }
          } catch {
            // Unparseable lock file payload
          }

          if (age > staleLockThresholdMs) {
            isStale = true;
          }

          if (lockPid !== undefined && lockPid !== process.pid) {
            try {
              // Signal 0 tests if PID is alive
              process.kill(lockPid, 0);
            } catch (killErr: unknown) {
              if (getErrorCode(killErr) === "ESRCH") {
                // Process no longer exists -> lock is dead
                isStale = true;
              }
            }
          }

          if (isStale) {
            try {
              fs.unlinkSync(lockPath);
              continue; // Retry immediately
            } catch {
              // Another process might have cleaned up or acquired
            }
          }
        } catch {
          // Stat failed, lock may have been released
        }

        if (Date.now() - startTime > lockTimeoutMs) {
          throw new Error(
            `Bootstrap lock acquisition timeout after ${lockTimeoutMs}ms for '${lockPath}'`,
          );
        }

        synchronousSleep(25);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Atomically writes JSON to target file using same-directory temp file, fsync,
 * atomic rename, directory fsync where supported, and immediate cleanup on failure.
 */
export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const randomSuffix = crypto.randomBytes(6).toString("hex");
  const tempPath = path.join(dir, `.tmp-${base}-${process.pid}-${Date.now()}-${randomSuffix}`);

  const serialized = `${JSON.stringify(data, null, 2)}\n`;

  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY,
      0o644,
    );
    fs.writeSync(fd, serialized, 0, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, targetPath);

    // Fsync containing directory where supported
    try {
      const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unsupported on certain platforms (e.g. Windows)
    }
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore temp file cleanup error
    }
    throw err;
  }
}

/**
 * Validates and reads project metadata from .resin/project.json.
 */
export function readProjectMetadata(projectRootOrResinDir: string): V1ProjectMetadata {
  const resinDir = projectRootOrResinDir.endsWith(".resin")
    ? projectRootOrResinDir
    : path.join(projectRootOrResinDir, ".resin");

  const projectJsonPath = path.join(resinDir, "project.json");
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`Project metadata not found at '${projectJsonPath}'`);
  }

  assertNotSymlink(projectJsonPath, "'project.json'");
  checkCaseCollision(resinDir, "project.json");

  let raw: string;
  try {
    raw = fs.readFileSync(projectJsonPath, "utf8");
  } catch (err: unknown) {
    throw new Error(`Failed to read project.json at '${projectJsonPath}': ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Corrupt project.json: Invalid JSON at '${projectJsonPath}': ${String(err)}`);
  }

  return validateV1ProjectMetadata(parsed);
}

/**
 * Validates and reads tool lockfile from .resin/resin.lock.
 */
export function readToolLock(projectRootOrResinDir: string): V1ToolLock {
  const resinDir = projectRootOrResinDir.endsWith(".resin")
    ? projectRootOrResinDir
    : path.join(projectRootOrResinDir, ".resin");

  const lockPath = path.join(resinDir, "resin.lock");
  if (!fs.existsSync(lockPath)) {
    throw new Error(`Tool lockfile not found at '${lockPath}'`);
  }

  assertNotSymlink(lockPath, "'resin.lock'");
  checkCaseCollision(resinDir, "resin.lock");

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (err: unknown) {
    throw new Error(`Failed to read resin.lock at '${lockPath}': ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Corrupt resin.lock: Invalid JSON at '${lockPath}': ${String(err)}`);
  }

  return validateV1ToolLock(parsed);
}

/**
 * Writes project metadata atomically to .resin/project.json.
 */
export function writeProjectMetadata(
  projectRootOrResinDir: string,
  metadata: V1ProjectMetadata,
): void {
  const resinDir = projectRootOrResinDir.endsWith(".resin")
    ? projectRootOrResinDir
    : path.join(projectRootOrResinDir, ".resin");

  const validated = validateV1ProjectMetadata(metadata);
  const target = path.join(resinDir, "project.json");
  atomicWriteJsonSync(target, validated);
}

/**
 * Writes tool lockfile atomically to .resin/resin.lock.
 */
export function writeToolLock(projectRootOrResinDir: string, lock: V1ToolLock): void {
  const resinDir = projectRootOrResinDir.endsWith(".resin")
    ? projectRootOrResinDir
    : path.join(projectRootOrResinDir, ".resin");

  const validated = validateV1ToolLock(lock);
  const target = path.join(resinDir, "resin.lock");
  atomicWriteJsonSync(target, validated);
}

/**
 * Helper to load and validate existing metadata in read-only mode without file mutations or locks.
 */
function loadExistingReadOnlyMetadata(
  projectRoot: string,
  resinDir: string,
): ProjectBootstrapResult {
  if (!fs.existsSync(resinDir)) {
    throw new Error(
      `Cannot bootstrap read-only project: '.resin' directory does not exist at '${projectRoot}'`,
    );
  }

  const lstat = fs.lstatSync(resinDir);
  if (lstat.isSymbolicLink()) {
    throw new Error(
      `Security violation: '.resin' directory cannot be a symbolic link at '${resinDir}'`,
    );
  }
  if (!lstat.isDirectory()) {
    throw new Error(`Invalid '.resin' path: expected directory at '${resinDir}'`);
  }

  const projectJsonPath = path.join(resinDir, "project.json");
  const lockPath = path.join(resinDir, "resin.lock");

  assertNotSymlink(projectJsonPath, "'project.json'");
  assertNotSymlink(lockPath, "'resin.lock'");
  checkCaseCollision(resinDir, "project.json");
  checkCaseCollision(resinDir, "resin.lock");

  if (!fs.existsSync(projectJsonPath) || !fs.existsSync(lockPath)) {
    throw new Error(
      `Cannot bootstrap read-only project: missing required metadata files at '${resinDir}'`,
    );
  }

  const project = readProjectMetadata(resinDir);
  const lock = readToolLock(resinDir);

  if (project.projectId !== lock.projectId) {
    throw new Error(
      `Project ID mismatch: project.json has '${project.projectId}', but resin.lock has '${lock.projectId}' at '${resinDir}'`,
    );
  }

  return {
    projectId: project.projectId,
    projectRoot,
    isReadOnly: true,
    resinDir,
    projectJsonPath,
    lockPath,
    project,
    lock,
  };
}

/**
 * Synchronously bootstraps a Resin project at startupPath.
 * - Prioritizes Git root if present, otherwise uses startupPath.
 * - Serializes initialization with exclusive .bootstrap.lock and stale recovery.
 * - Creates/validates .resin/project.json and .resin/resin.lock atomically.
 * - Recovers deterministic partial states (project-only or lock-only).
 * - Handles read-only project directories explicitly without mutation.
 * - Fails closed on symlinks, case collisions, corrupt schemas, or mismatched UUIDs.
 */
export function bootstrapProject(
  startupPath: string,
  options: ProjectBootstrapOptions = {},
): ProjectBootstrapResult {
  const canonicalCandidate = canonicalizePath(startupPath);
  const gitRoot = findGitRoot(canonicalCandidate);
  const projectRoot = gitRoot ? canonicalizePath(gitRoot) : canonicalCandidate;

  // Validate projectRoot exists and is a directory
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root directory does not exist: '${projectRoot}'`);
  }
  const rootStat = fs.statSync(projectRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Project root is not a directory: '${projectRoot}'`);
  }

  // Check case collision for .resin in projectRoot
  checkCaseCollision(projectRoot, ".resin");

  const resinDir = path.join(projectRoot, ".resin");
  const isExplicitReadOnly = options.readOnly === true;
  const isFsReadOnly = isDirectoryReadOnly(projectRoot);

  if (isExplicitReadOnly || isFsReadOnly) {
    return loadExistingReadOnlyMetadata(projectRoot, resinDir);
  }

  // Validate .resin directory if it exists or create it
  if (fs.existsSync(resinDir)) {
    const lstat = fs.lstatSync(resinDir);
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `Security violation: '.resin' directory cannot be a symbolic link at '${resinDir}'`,
      );
    }
    if (!lstat.isDirectory()) {
      throw new Error(`Invalid '.resin' path: expected directory at '${resinDir}'`);
    }
  } else {
    try {
      fs.mkdirSync(resinDir, { recursive: true, mode: 0o755 });
    } catch (mkdirErr: unknown) {
      const code = getErrorCode(mkdirErr);
      if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
        return loadExistingReadOnlyMetadata(projectRoot, resinDir);
      }
      throw mkdirErr;
    }
    const lstat = fs.lstatSync(resinDir);
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `Security violation: '.resin' directory cannot be a symbolic link at '${resinDir}'`,
      );
    }
  }

  // Acquire exclusive concurrency lock
  let releaseLock: () => void;
  try {
    releaseLock = acquireBootstrapLock(
      resinDir,
      options.lockTimeoutMs,
      options.staleLockThresholdMs,
    );
  } catch (lockErr: unknown) {
    const code = getErrorCode(lockErr);
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      return loadExistingReadOnlyMetadata(projectRoot, resinDir);
    }
    throw lockErr;
  }

  try {
    // Clean up any lingering temp files
    cleanupStaleTempFiles(resinDir);

    const projectJsonPath = path.join(resinDir, "project.json");
    const lockPath = path.join(resinDir, "resin.lock");

    assertNotSymlink(projectJsonPath, "'project.json'");
    assertNotSymlink(lockPath, "'resin.lock'");
    checkCaseCollision(resinDir, "project.json");
    checkCaseCollision(resinDir, "resin.lock");

    const hasProject = fs.existsSync(projectJsonPath);
    const hasLock = fs.existsSync(lockPath);

    let project: V1ProjectMetadata;
    let lock: V1ToolLock;
    let recoveredPartialState: ProjectMetadataRecoveryState | undefined;

    if (hasProject && hasLock) {
      // Steady state: read and validate both
      project = readProjectMetadata(resinDir);
      lock = readToolLock(resinDir);

      if (project.projectId !== lock.projectId) {
        throw new Error(
          `Project ID mismatch: project.json has '${project.projectId}', but resin.lock has '${lock.projectId}' at '${resinDir}'`,
        );
      }
    } else if (!hasProject && !hasLock) {
      // Fresh start: generate new UUID and write both atomically
      const projectId = crypto.randomUUID();
      const rawName = options.projectName || path.basename(projectRoot) || "workspace";
      const sanitizedName = rawName.slice(0, 128);
      const now = new Date().toISOString();

      project = validateV1ProjectMetadata({
        schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId,
        name: sanitizedName,
        createdAt: now,
      });

      lock = validateV1ToolLock({
        schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId,
        updatedAt: now,
        tools: {},
      });

      atomicWriteJsonSync(projectJsonPath, project);
      atomicWriteJsonSync(lockPath, lock);
    } else if (hasProject && !hasLock) {
      // Partial state: project-only exists -> adopt project UUID into resin.lock
      project = readProjectMetadata(resinDir);

      const now = new Date().toISOString();
      lock = validateV1ToolLock({
        schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId: project.projectId,
        updatedAt: now,
        tools: {},
      });

      atomicWriteJsonSync(lockPath, lock);
      recoveredPartialState = "project_recreated_lock";
    } else {
      // Partial state: lock-only exists -> adopt lock UUID into project.json
      lock = readToolLock(resinDir);

      const rawName = options.projectName || path.basename(projectRoot) || "workspace";
      const sanitizedName = rawName.slice(0, 128);
      const now = new Date().toISOString();

      project = validateV1ProjectMetadata({
        schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId: lock.projectId,
        name: sanitizedName,
        createdAt: now,
      });

      atomicWriteJsonSync(projectJsonPath, project);
      recoveredPartialState = "lock_recreated_project";
    }

    return {
      projectId: project.projectId,
      projectRoot,
      isReadOnly: false,
      resinDir,
      projectJsonPath,
      lockPath,
      project,
      lock,
      recoveredPartialState,
    };
  } finally {
    releaseLock();
  }
}
