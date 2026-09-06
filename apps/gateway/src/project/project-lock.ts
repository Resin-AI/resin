import fs from "node:fs";
import path from "node:path";
import {
  type V1LockedToolEntry,
  V1LockedToolEntrySchema,
  type V1MetadataPayloadValue,
  type V1ToolLock,
  V1ToolLockSchema,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  assertSafeCommittedMetadata,
  validateV1ToolLock,
} from "@resin/contracts";
import { atomicWriteJsonSync } from "./project-bootstrap.js";
import type { ProjectLockManagerOptions, ReconcileOutcome, ReconcileResult } from "./types.js";

export type { ProjectLockManagerOptions, ReconcileOutcome, ReconcileResult };

function getErrorCode(err: { code?: unknown } | Error | unknown): string | undefined {
  if (err && err instanceof Object && "code" in err) {
    // SAFETY: Verified err is an object containing 'code'.
    const code = (err as { code?: unknown }).code;
    return Object.prototype.toString.call(code) === "[object String]" ? String(code) : undefined;
  }
  return undefined;
}

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
 * Validates that candidate string is an RFC4122 v4-like UUID.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a file path is not a symbolic link.
 */
function assertNotSymlink(targetPath: string, label: string): void {
  try {
    const lstat = fs.lstatSync(targetPath);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Security violation: ${label} cannot be a symbolic link at '${targetPath}'`);
    }
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Compares two SemVer strings (MAJOR.MINOR.PATCH) for precedence.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const parseParts = (v: string) => {
    const clean = v.split("-")[0].split("+")[0];
    const parts = clean.split(".").map((n) => Number.parseInt(n, 10));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };

  const [majA, minA, patA] = parseParts(a);
  const [majB, minB, patB] = parseParts(b);

  if (majA !== majB) return majA - majB;
  if (minA !== minB) return minA - minB;
  return patA - patB;
}

/**
 * Manager for `.resin/resin.lock` reading, writing, and atomic reconciliation.
 * Enforces version locking, qualification parity, anti-rollback invariant,
 * and concurrency serialization across concurrent subagents and processes.
 */
export class ProjectLockManager {
  readonly lockPath: string;
  readonly resinDir: string;
  readonly projectId: string;
  readonly lockTimeoutMs: number;
  readonly staleLockThresholdMs: number;
  readonly readOnly: boolean;

  constructor(options: ProjectLockManagerOptions);
  constructor(lockPath: string, projectId?: string);
  constructor(optionsOrPath: ProjectLockManagerOptions | string, projectId?: string) {
    let resolvedLockPath: string;
    let resolvedProjectId: string | undefined;
    let lockTimeoutMs: number | undefined;
    let staleLockThresholdMs: number | undefined;
    let readOnly = false;

    if (optionsOrPath instanceof Object) {
      resolvedLockPath = optionsOrPath.lockPath;
      resolvedProjectId = optionsOrPath.projectId ?? projectId;
      lockTimeoutMs = optionsOrPath.lockTimeoutMs;
      staleLockThresholdMs = optionsOrPath.staleLockThresholdMs;
      readOnly = optionsOrPath.readOnly ?? false;
    } else {
      resolvedLockPath = optionsOrPath;
      resolvedProjectId = projectId;
    }

    if (!resolvedProjectId) {
      // Attempt to inspect lockPath or project.json if exists
      const directPath = path.resolve(resolvedLockPath);
      const resinDir = directPath.endsWith("resin.lock")
        ? path.dirname(directPath)
        : path.basename(directPath) === ".resin"
          ? directPath
          : path.join(directPath, ".resin");

      const projectJsonPath = path.join(resinDir, "project.json");
      const lockJsonPath = path.join(resinDir, "resin.lock");

      if (fs.existsSync(projectJsonPath)) {
        try {
          const raw = fs.readFileSync(projectJsonPath, "utf8");
          const parsed = JSON.parse(raw);
          resolvedProjectId = parsed.projectId;
        } catch {
          // Ignore read error
        }
      } else if (fs.existsSync(lockJsonPath)) {
        try {
          const raw = fs.readFileSync(lockJsonPath, "utf8");
          const parsed = JSON.parse(raw);
          resolvedProjectId = parsed.projectId;
        } catch {
          // Ignore read error
        }
      }
    }
    if (resolvedProjectId && !UUID_REGEX.test(resolvedProjectId)) {
      throw new Error(`Invalid projectId: expected valid UUID, received '${resolvedProjectId}'`);
    }
    this.projectId = resolvedProjectId ?? "";
    this.lockTimeoutMs = lockTimeoutMs ?? 5000;
    this.staleLockThresholdMs = staleLockThresholdMs ?? 10000;
    this.readOnly = readOnly;

    const normalizedPath = path.resolve(resolvedLockPath);
    if (normalizedPath.endsWith("resin.lock")) {
      this.lockPath = normalizedPath;
      this.resinDir = path.dirname(normalizedPath);
    } else if (path.basename(normalizedPath) === ".resin") {
      this.resinDir = normalizedPath;
      this.lockPath = path.join(this.resinDir, "resin.lock");
    } else {
      this.resinDir = path.join(normalizedPath, ".resin");
      this.lockPath = path.join(this.resinDir, "resin.lock");
    }
  }
  static resolveLockPath(lockPathOrOptions: ProjectLockManagerOptions | string): string {
    if (lockPathOrOptions instanceof Object) {
      return lockPathOrOptions.lockPath;
    }
    return lockPathOrOptions;
  }

  /**
   * Acquires exclusive concurrency lock on `.resin/.resin.lock.lock`
   * with bounded stale lock recovery and timeout.
   */
  private acquireLock(): () => void {
    if (this.readOnly) {
      throw new Error(`Cannot acquire lock on read-only lockfile at '${this.lockPath}'`);
    }

    if (!fs.existsSync(this.resinDir)) {
      try {
        fs.mkdirSync(this.resinDir, { recursive: true, mode: 0o755 });
      } catch {
        // Ignore directory creation failure
      }
    }

    const concurrencyLockPath = path.join(this.resinDir, ".resin.lock.lock");
    const startTime = Date.now();

    while (true) {
      try {
        const fd = fs.openSync(
          concurrencyLockPath,
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

        return () => {
          try {
            fs.unlinkSync(concurrencyLockPath);
          } catch {
            // Ignore unlock failure
          }
        };
      } catch (err) {
        if (getErrorCode(err) !== "EEXIST") {
          throw err;
        }
        // Lock file exists -> check staleness
        try {
          const stat = fs.statSync(concurrencyLockPath);
          const age = Date.now() - stat.mtimeMs;
          let isStale = false;

          let lockPid: number | undefined;
          try {
            const raw = fs.readFileSync(concurrencyLockPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed instanceof Object) {
              if (Number.isFinite(parsed.pid)) {
                lockPid = parsed.pid;
              }
              if (
                Number.isFinite(parsed.createdAt) &&
                Date.now() - parsed.createdAt > this.staleLockThresholdMs
              ) {
                isStale = true;
              }
            }
          } catch {
            // Parse error on lock payload
          }

          if (age > this.staleLockThresholdMs) {
            isStale = true;
          }

          if (lockPid !== undefined && lockPid !== process.pid) {
            try {
              process.kill(lockPid, 0);
            } catch (killErr) {
              if (getErrorCode(killErr) === "ESRCH") {
                isStale = true;
              }
            }
          }

          if (isStale) {
            try {
              fs.unlinkSync(concurrencyLockPath);
              continue;
            } catch {
              // Ignore unlink collision
            }
          }
        } catch {
          // Lock may have been released concurrently
        }

        if (Date.now() - startTime > this.lockTimeoutMs) {
          throw new Error(
            `Lock acquisition timeout after ${this.lockTimeoutMs}ms for lockfile '${concurrencyLockPath}'`,
          );
        }

        synchronousSleep(25);
      }
    }
  }

  /**
   * Reads and validates the current lockfile state from disk.
   * If lockfile does not exist on disk, synthesizes an empty lock structure.
   */
  readLock(): V1ToolLock {
    if (!fs.existsSync(this.lockPath)) {
      return {
        schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId: this.projectId,
        updatedAt: new Date().toISOString(),
        tools: {},
      };
    }

    assertNotSymlink(this.lockPath, "'resin.lock'");

    let raw: string;
    try {
      raw = fs.readFileSync(this.lockPath, "utf8");
    } catch (err) {
      throw new Error(`Failed to read lockfile at '${this.lockPath}': ${String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupt lockfile: Invalid JSON at '${this.lockPath}': ${String(err)}`);
    }

    // SAFETY: Parsed JSON payload is validated for safe committed metadata before schema parsing.
    assertSafeCommittedMetadata(parsed as V1MetadataPayloadValue, "resin.lock");
    const parsedLock = V1ToolLockSchema.parse(parsed);
    const lock = validateV1ToolLock(parsedLock);
    if (lock.projectId !== this.projectId) {
      throw new Error(
        `Project ID mismatch: expected '${this.projectId}', but lockfile has '${lock.projectId}' at '${this.lockPath}'`,
      );
    }

    return lock;
  }

  /**
   * Alias for readLock().
   */
  read(): V1ToolLock {
    return this.readLock();
  }

  /**
   * Reconciles a candidate tool entry during sync/qualification.
   * - If tool is not present in lockfile, commits it immediately as active.
   * - If candidate matches existing locked entry exactly, returns unchanged.
   * - If candidate is a newer version and follow/advance is requested (and not pinned), updates lock.
   * - Otherwise, returns newer_available without mutating.
   */
  reconcileQualified(
    candidateEntry: V1LockedToolEntry,
    options?: { follow?: boolean; advance?: boolean },
  ): ReconcileResult {
    const validatedEntry = V1LockedToolEntrySchema.parse(candidateEntry);

    return this.withLock(() => {
      const currentLock = this.readLock();
      const existing = currentLock.tools[validatedEntry.name];

      if (!existing) {
        // Tool not locked -> Add it
        const updatedTools = {
          ...currentLock.tools,
          [validatedEntry.name]: validatedEntry,
        };

        const updatedLock: V1ToolLock = {
          schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
          schemaVersion: V1_SCHEMA_VERSION,
          projectId: this.projectId,
          updatedAt: new Date().toISOString(),
          tools: updatedTools,
        };

        const validatedLock = validateV1ToolLock(updatedLock);
        atomicWriteJsonSync(this.lockPath, validatedLock);

        return {
          outcome: "added",
          lock: validatedLock,
        };
      }

      // Check exact match (idempotent no-op)
      const isExactMatch =
        existing.version === validatedEntry.version &&
        existing.manifestDigest === validatedEntry.manifestDigest &&
        existing.artifactDigest === validatedEntry.artifactDigest &&
        existing.envelopeDigest === validatedEntry.envelopeDigest;

      if (isExactMatch) {
        return {
          outcome: "unchanged",
          lock: currentLock,
        };
      }

      if ((options?.follow || options?.advance) && existing.status !== "pinned") {
        const updatedTools = {
          ...currentLock.tools,
          [validatedEntry.name]: validatedEntry,
        };

        const updatedLock: V1ToolLock = {
          ...currentLock,
          updatedAt: new Date().toISOString(),
          tools: updatedTools,
        };

        const validatedLock = validateV1ToolLock(updatedLock);
        atomicWriteJsonSync(this.lockPath, validatedLock);

        return {
          outcome: "updated",
          lock: validatedLock,
        };
      }

      return {
        outcome: "newer_available",
        lock: currentLock,
      };
    });
  }

  /**
   * Advances an existing locked tool to a candidate entry (e.g. newer active version).
   */
  advance(candidateEntry: V1LockedToolEntry): ReconcileResult {
    const validatedEntry = V1LockedToolEntrySchema.parse(candidateEntry);

    return this.withLock(() => {
      const currentLock = this.readLock();
      const updatedTools = {
        ...currentLock.tools,
        [validatedEntry.name]: validatedEntry,
      };

      const updatedLock: V1ToolLock = {
        ...currentLock,
        updatedAt: new Date().toISOString(),
        tools: updatedTools,
      };

      const validatedLock = validateV1ToolLock(updatedLock);
      atomicWriteJsonSync(this.lockPath, validatedLock);

      return {
        outcome: "updated",
        lock: validatedLock,
      };
    });
  }

  /**
   * Follows the catalog's active version for a locked tool. Alias for advance.
   */
  follow(candidateEntry: V1LockedToolEntry): ReconcileResult {
    return this.advance(candidateEntry);
  }

  /**
   * Explicitly updates a tool to an exact V1 locked entry.
   * Enforces optimistic concurrency verification against expectedArtifactDigest when provided.
   */
  updateExact(name: string, next: V1LockedToolEntry, expectedArtifactDigest?: string): V1ToolLock {
    const validatedNext = V1LockedToolEntrySchema.parse(next);
    if (validatedNext.name !== name) {
      throw new Error(`Tool name mismatch: '${name}' vs entry name '${validatedNext.name}'`);
    }

    return this.withLock(() => {
      const currentLock = this.readLock();
      const existing = currentLock.tools[name];

      if (expectedArtifactDigest !== undefined) {
        if (!existing) {
          throw new Error(
            `Optimistic lock conflict: tool '${name}' does not exist in lockfile, expected digest '${expectedArtifactDigest}'`,
          );
        }
        if (existing.artifactDigest !== expectedArtifactDigest) {
          throw new Error(
            `Optimistic lock conflict: tool '${name}' has artifact digest '${existing.artifactDigest}', expected '${expectedArtifactDigest}'`,
          );
        }
      }

      const updatedTools = {
        ...currentLock.tools,
        [name]: validatedNext,
      };

      const updatedLock: V1ToolLock = {
        ...currentLock,
        updatedAt: new Date().toISOString(),
        tools: updatedTools,
      };

      const validatedLock = validateV1ToolLock(updatedLock);
      atomicWriteJsonSync(this.lockPath, validatedLock);
      return validatedLock;
    });
  }

  /**
   * Sets the status of a locked tool (active, pinned, disabled).
   */
  setStatus(name: string, status: "active" | "pinned" | "disabled"): V1ToolLock {
    return this.withLock(() => {
      const currentLock = this.readLock();
      const existing = currentLock.tools[name];
      if (!existing) {
        throw new Error(`Tool '${name}' not found in lockfile`);
      }

      if (existing.status === status) {
        return currentLock;
      }

      const updatedTools = {
        ...currentLock.tools,
        [name]: {
          ...existing,
          status,
        },
      };

      const updatedLock: V1ToolLock = {
        ...currentLock,
        updatedAt: new Date().toISOString(),
        tools: updatedTools,
      };

      const validatedLock = validateV1ToolLock(updatedLock);
      atomicWriteJsonSync(this.lockPath, validatedLock);
      return validatedLock;
    });
  }

  /**
   * Removes a tool completely from the committed lockfile.
   */
  remove(name: string, expected?: V1LockedToolEntry): V1ToolLock {
    return this.withLock(() => {
      const currentLock = this.readLock();
      if (!currentLock.tools[name]) {
        return currentLock;
      }
      const existing = currentLock.tools[name];
      if (
        expected &&
        (existing.toolId !== expected.toolId ||
          existing.version !== expected.version ||
          existing.manifestDigest !== expected.manifestDigest ||
          existing.artifactDigest !== expected.artifactDigest)
      )
        return currentLock;

      const updatedTools = { ...currentLock.tools };
      delete updatedTools[name];
      const updatedLock: V1ToolLock = {
        ...currentLock,
        updatedAt: new Date().toISOString(),
        tools: updatedTools,
      };

      const validatedLock = validateV1ToolLock(updatedLock);
      atomicWriteJsonSync(this.lockPath, validatedLock);
      return validatedLock;
    });
  }

  /**
   * Helper that executes a mutation callback under the concurrency lock.
   */
  private withLock<T>(fn: () => T): T {
    const release = this.acquireLock();
    try {
      return fn();
    } finally {
      release();
    }
  }

  /**
   * Resolves a locked tool entry by name or toolId.
   */
  getLockedTool(nameOrId: string): V1LockedToolEntry | undefined {
    const lock = this.readLock();
    return (
      lock.tools[nameOrId] ??
      Object.values(lock.tools).find((t) => t.toolId === nameOrId || t.name === nameOrId)
    );
  }

  /**
   * Lists all currently locked tool entries.
   */
  listLockedTools(): V1LockedToolEntry[] {
    const lock = this.readLock();
    return Object.values(lock.tools);
  }

  /**
   * Checks whether a specific tool (and optionally exact version/digests) is locked and active.
   */
  isToolLocked(
    nameOrId: string,
    version?: string,
    manifestDigest?: string,
    artifactDigest?: string,
  ): boolean {
    const entry = this.getLockedTool(nameOrId);
    if (!entry || entry.status === "disabled") {
      return false;
    }
    if (version !== undefined && entry.version !== version) {
      return false;
    }
    if (manifestDigest !== undefined && entry.manifestDigest !== manifestDigest) {
      return false;
    }
    if (artifactDigest !== undefined && entry.artifactDigest !== artifactDigest) {
      return false;
    }
    return true;
  }

  /**
   * Explicitly marks a tool as disabled in the lockfile.
   */
  revokeTool(toolIdOrName: string): boolean {
    const entry = this.getLockedTool(toolIdOrName);
    if (!entry) {
      return false;
    }
    this.setStatus(entry.name, "disabled");
    return true;
  }

  /**
   * Repairs a corrupt or missing lockfile by synthesizing a fresh lockfile
   * from salvaged tool entries under the validated projectId.
   */
  repair(salvagedTools: Record<string, V1LockedToolEntry> = {}): V1ToolLock {
    return this.withLock(() => {
      if (!fs.existsSync(this.resinDir)) {
        fs.mkdirSync(this.resinDir, { recursive: true, mode: 0o755 });
      }

      if (fs.existsSync(this.lockPath)) {
        try {
          assertNotSymlink(this.lockPath, "'resin.lock'");
        } catch {
          // If symlink, safely remove it during repair
          try {
            fs.unlinkSync(this.lockPath);
          } catch {}
        }

        if (fs.existsSync(this.lockPath)) {
          try {
            const raw = fs.readFileSync(this.lockPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed instanceof Object && !Array.isArray(parsed)) {
              if (
                "projectId" in parsed &&
                Object.prototype.toString.call(parsed.projectId) === "[object String]" &&
                UUID_REGEX.test(String(parsed.projectId)) &&
                parsed.projectId !== this.projectId
              ) {
                throw new Error(
                  `Project ID mismatch: cannot repair lockfile belonging to '${String(parsed.projectId)}' for project '${this.projectId}'`,
                );
              }

              if (
                "tools" in parsed &&
                parsed.tools &&
                parsed.tools instanceof Object &&
                !Array.isArray(parsed.tools)
              ) {
                for (const [key, val] of Object.entries(parsed.tools)) {
                  if (!(key in salvagedTools)) {
                    try {
                      const entry = V1LockedToolEntrySchema.parse(val);
                      salvagedTools[key] = entry;
                    } catch {}
                  }
                }
              }
            }
          } catch (err) {
            if (String(err).includes("Project ID mismatch")) {
              throw err;
            }
            // Invalid JSON or schema corruption is salvaged
          }
        }
      }

      const repairedLock: V1ToolLock = {
        schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
        schemaVersion: V1_SCHEMA_VERSION,
        projectId: this.projectId,
        updatedAt: new Date().toISOString(),
        tools: salvagedTools,
      };

      const validatedLock = validateV1ToolLock(repairedLock);
      atomicWriteJsonSync(this.lockPath, validatedLock);
      return validatedLock;
    });
  }

  /**
   * Alias for repair().
   */
  repairCorruptLockfile(salvagedTools: Record<string, V1LockedToolEntry> = {}): V1ToolLock {
    return this.repair(salvagedTools);
  }
}
