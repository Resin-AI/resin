import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const UPDATE_LOCK_METADATA_VERSION = 2 as const;
export const DEFAULT_UPDATE_LOCK_LEASE_MS = 30 * 60_000;
export const DEFAULT_UPDATE_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_UPDATE_LOCK_RETRY_MS = 100;
export const DEFAULT_MALFORMED_LOCK_STALE_MS = 5 * 60_000;
export const MAX_UPDATE_LOCK_TIMEOUT_MS = 5 * 60_000;
export const MAX_UPDATE_LOCK_METADATA_BYTES = 16 * 1024;

export interface UpdateLockProcessIdentity {
  readonly bootId: string;
  readonly processStartId: string;
}

export interface UpdateLockMetadata {
  readonly version: typeof UPDATE_LOCK_METADATA_VERSION;
  readonly ownerId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly bootId: string;
  readonly processStartId: string;
  readonly acquiredAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly label?: string;
}

export interface AcquireUpdateLockOptions {
  readonly lockPath?: string;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly leaseDurationMs?: number;
  /** Age after which an unreadable, securely-owned lock can be reclaimed. */
  readonly malformedLockStaleMs?: number;
  readonly label?: string;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly processIdentity?: UpdateLockProcessIdentity;
  readonly getProcessIdentity?: (
    pid: number,
  ) => UpdateLockProcessIdentity | null | Promise<UpdateLockProcessIdentity | null>;
  /** Platform seam for exercising native lock behavior without that host. */
  readonly platform?: NodeJS.Platform;
  /** Process runner seam used only for native process-incarnation discovery. */
  readonly runProcessIdentityCommand?: (
    executable: string,
    args: readonly string[],
  ) => Promise<string>;
  readonly pid?: number;
  readonly hostname?: string;
  readonly createOwnerId?: () => string;
}

interface ResolvedUpdateLockOptions {
  readonly lockPath: string;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly leaseDurationMs: number;
  readonly malformedLockStaleMs: number;
  readonly label?: string;
  readonly clock: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly isProcessAlive: (pid: number) => boolean | Promise<boolean>;
  readonly processIdentity: UpdateLockProcessIdentity;
  readonly getProcessIdentity: (
    pid: number,
  ) => UpdateLockProcessIdentity | null | Promise<UpdateLockProcessIdentity | null>;
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly hostname: string;
  readonly createOwnerId: () => string;
}

interface LockSnapshot {
  readonly stats: Stats;
  readonly metadata: UpdateLockMetadata | null;
}

interface AcquiredMutationFence {
  readonly metadata: UpdateLockMetadata;
  readonly remainingWaitMs: number;
}

export class UpdateLockUnavailableError extends Error {
  readonly lockPath: string;
  readonly owner: UpdateLockMetadata | null;
  readonly timeoutMs: number;

  constructor(lockPath: string, owner: UpdateLockMetadata | null, timeoutMs: number) {
    const ownerDescription = owner
      ? `pid ${owner.pid} on ${owner.hostname}`
      : "an unreadable owner";
    super(`Update lock ${lockPath} is held by ${ownerDescription} after ${timeoutMs}ms`);
    this.name = "UpdateLockUnavailableError";
    this.lockPath = lockPath;
    this.owner = owner;
    this.timeoutMs = timeoutMs;
  }
}

export class UnsafeUpdateLockError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, message: string) {
    super(`Refusing unsafe update lock ${lockPath}: ${message}`);
    this.name = "UnsafeUpdateLockError";
    this.lockPath = lockPath;
  }
}

export class UpdateLockOwnershipError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Update lock ${lockPath} is no longer owned by this handle`);
    this.name = "UpdateLockOwnershipError";
    this.lockPath = lockPath;
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return Boolean(cause) && cause instanceof Object && "code" in cause && cause.code === code;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasErrorCode(error, "ESRCH");
  }
}

const fallbackProcessIdentity: UpdateLockProcessIdentity = {
  bootId: `${os.hostname()}-${Math.max(0, Math.trunc(Date.now() - os.uptime() * 1_000))}`,
  processStartId: `${Math.max(0, Math.trunc(Date.now() - process.uptime() * 1_000))}-${randomUUID()}`,
};

const DARWIN_PS_PATH = "/bin/ps";
const DARWIN_BOOT_ID_PREFIX = "darwin-pid1:";
const DARWIN_PROCESS_START_ID_PREFIX = "darwin-lstart:";
const DARWIN_PROCESS_START_PATTERN =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;

async function defaultRunProcessIdentityCommand(
  executable: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 4_096,
    timeout: 5_000,
  });
  return stdout;
}

function normalizeDarwinProcessStart(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    return null;
  }

  const normalized = lines[0]!.replace(/\s+/g, " ");
  return DARWIN_PROCESS_START_PATTERN.test(normalized) ? normalized : null;
}

async function readDarwinProcessStart(
  pid: number,
  runCommand: (executable: string, args: readonly string[]) => Promise<string>,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return null;
  }
  return normalizeDarwinProcessStart(
    await runCommand(DARWIN_PS_PATH, ["-p", String(pid), "-o", "lstart="]),
  );
}

async function getLinuxProcessIdentity(pid: number): Promise<UpdateLockProcessIdentity | null> {
  const [bootIdRaw, processStat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
  ]);
  const closingName = processStat.lastIndexOf(")");
  if (closingName < 0) {
    return null;
  }
  const fieldsAfterName = processStat
    .slice(closingName + 1)
    .trim()
    .split(/\s+/);
  const processStartId = fieldsAfterName[19];
  const bootId = bootIdRaw.trim();
  if (!processStartId || !/^\d+$/.test(processStartId) || bootId.length === 0) {
    return null;
  }
  return { bootId, processStartId };
}

function createDefaultProcessIdentityLookup(
  platform: NodeJS.Platform,
  runCommand: (executable: string, args: readonly string[]) => Promise<string>,
): (pid: number) => Promise<UpdateLockProcessIdentity | null> {
  let darwinBootId: string | undefined;

  return async (pid) => {
    try {
      if (platform === "linux") {
        return await getLinuxProcessIdentity(pid);
      }
      if (platform === "darwin") {
        const processStart = await readDarwinProcessStart(pid, runCommand);
        if (processStart === null) {
          return null;
        }

        if (darwinBootId === undefined) {
          const bootProcessStart =
            pid === 1 ? processStart : await readDarwinProcessStart(1, runCommand);
          if (bootProcessStart === null) {
            return null;
          }
          darwinBootId = `${DARWIN_BOOT_ID_PREFIX}${bootProcessStart}`;
        }

        return {
          bootId: darwinBootId,
          processStartId: `${DARWIN_PROCESS_START_ID_PREFIX}${processStart}`,
        };
      }
      return pid === process.pid ? fallbackProcessIdentity : null;
    } catch {
      return null;
    }
  };
}

function requireNonNegativeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a whole number from 0 through ${maximum}`);
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number`);
  }
  return value;
}

function getCurrentTime(clock: () => number): number {
  const now = clock();
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError("Update lock clock must return a non-negative finite timestamp");
  }
  return Math.trunc(now);
}

function parseOptionalLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new TypeError("Update lock label must be 1..128 non-whitespace-padded characters");
  }
  return value;
}

function parseOwnerId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(
      "Update lock owner id must contain only letters, numbers, underscores, or dashes",
    );
  }
  return value;
}

function parseIdentityPart(value: string, name: string): string {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${name} must be 1..256 non-whitespace-padded characters`);
  }
  return value;
}

function normalizeProcessIdentity(identity: UpdateLockProcessIdentity): UpdateLockProcessIdentity {
  return {
    bootId: parseIdentityPart(identity.bootId, "Update lock boot id"),
    processStartId: parseIdentityPart(identity.processStartId, "Update lock process start id"),
  };
}

async function resolveOptions(
  options: AcquireUpdateLockOptions,
): Promise<ResolvedUpdateLockOptions> {
  const timeoutMs = requireNonNegativeInteger(
    options.timeoutMs ?? DEFAULT_UPDATE_LOCK_TIMEOUT_MS,
    "Update lock timeout",
    MAX_UPDATE_LOCK_TIMEOUT_MS,
  );
  const retryDelayMs = requirePositiveInteger(
    options.retryDelayMs ?? DEFAULT_UPDATE_LOCK_RETRY_MS,
    "Update lock retry delay",
  );
  const leaseDurationMs = requirePositiveInteger(
    options.leaseDurationMs ?? DEFAULT_UPDATE_LOCK_LEASE_MS,
    "Update lock lease duration",
  );
  const malformedLockStaleMs = requireNonNegativeInteger(
    options.malformedLockStaleMs ?? DEFAULT_MALFORMED_LOCK_STALE_MS,
    "Malformed update lock stale age",
    Number.MAX_SAFE_INTEGER,
  );
  const pid = requirePositiveInteger(options.pid ?? process.pid, "Update lock pid");
  const hostname = options.hostname ?? os.hostname();
  if (hostname.length === 0 || hostname.length > 255 || hostname.trim() !== hostname) {
    throw new TypeError("Update lock hostname must be 1..255 non-whitespace-padded characters");
  }

  const configuredPath = options.lockPath ?? resolveUpdateLockPath();
  if (configuredPath.length === 0) {
    throw new TypeError("Update lock path must not be empty");
  }

  const platform = options.platform ?? process.platform;
  const runProcessIdentityCommand =
    options.runProcessIdentityCommand ?? defaultRunProcessIdentityCommand;
  const identityLookup =
    options.getProcessIdentity ??
    createDefaultProcessIdentityLookup(platform, runProcessIdentityCommand);
  let processIdentity = options.processIdentity;
  if (processIdentity === undefined) {
    try {
      processIdentity = (await identityLookup(pid)) ?? undefined;
    } catch {
      processIdentity = undefined;
    }
  }
  processIdentity = normalizeProcessIdentity(
    processIdentity ??
      (pid === process.pid
        ? fallbackProcessIdentity
        : {
            bootId: `unverified-${hostname}`,
            processStartId: `pid-${pid}-${randomUUID()}`,
          }),
  );

  const currentProcessIdentity = processIdentity;
  return {
    lockPath: path.resolve(configuredPath),
    timeoutMs,
    retryDelayMs,
    leaseDurationMs,
    malformedLockStaleMs,
    label: parseOptionalLabel(options.label),
    clock: options.clock ?? Date.now,
    sleep: options.sleep ?? sleepTimer,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    processIdentity: currentProcessIdentity,
    getProcessIdentity: (targetPid) =>
      targetPid === pid ? currentProcessIdentity : identityLookup(targetPid),
    platform,
    pid,
    hostname,
    createOwnerId: options.createOwnerId ?? randomUUID,
  };
}

export function resolveUpdateLockPath(
  resinHome: string = process.env.RESIN_HOME?.trim() || path.join(os.homedir(), ".resin"),
): string {
  return path.join(resinHome, "locks", "update.lock");
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateSecureFile(stats: Stats, lockPath: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new UnsafeUpdateLockError(lockPath, "path is not a regular file");
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new UnsafeUpdateLockError(lockPath, "group or other users have permissions");
  }

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new UnsafeUpdateLockError(lockPath, "file is owned by another user");
  }
}

function validateDirectoryComponent(
  stats: Stats,
  lockPath: string,
  directory: string,
  isLockDirectory: boolean,
): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new UnsafeUpdateLockError(lockPath, `${directory} is not a regular directory`);
  }

  const uid = process.getuid?.();
  if (uid !== undefined) {
    if (isLockDirectory && stats.uid !== uid) {
      throw new UnsafeUpdateLockError(lockPath, "lock directory is owned by another user");
    }
    if (!isLockDirectory && stats.uid !== uid && stats.uid !== 0) {
      throw new UnsafeUpdateLockError(lockPath, `${directory} is owned by another user`);
    }
  }

  const writableByOthers = (stats.mode & 0o022) !== 0;
  const protectedByStickyBit =
    (stats.mode & 0o1000) !== 0 && (uid === undefined || stats.uid === 0 || stats.uid === uid);
  if (writableByOthers && !protectedByStickyBit) {
    throw new UnsafeUpdateLockError(lockPath, `${directory} is writable by group or other users`);
  }
}

class SecureLockDirectory {
  readonly logicalPath: string;
  private readonly operationPath: string;
  private readonly usesLogicalPath: boolean;
  private readonly handle: FileHandle;
  private readonly identity: Stats;
  private closed = false;

  constructor(
    logicalPath: string,
    operationPath: string,
    usesLogicalPath: boolean,
    handle: FileHandle,
    identity: Stats,
  ) {
    this.logicalPath = logicalPath;
    this.operationPath = operationPath;
    this.usesLogicalPath = usesLogicalPath;
    this.handle = handle;
    this.identity = identity;
  }

  async resolve(logicalFilePath: string): Promise<string> {
    if (path.dirname(logicalFilePath) !== this.logicalPath) {
      throw new UnsafeUpdateLockError(logicalFilePath, "lock files must share one directory");
    }
    if (this.usesLogicalPath) {
      await this.assertCurrent(logicalFilePath);
    }
    return path.join(this.operationPath, path.basename(logicalFilePath));
  }

  async assertCurrent(lockPath: string): Promise<void> {
    let current: Stats;
    try {
      current = await lstat(this.logicalPath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        throw new UnsafeUpdateLockError(lockPath, "lock directory was removed");
      }
      throw error;
    }
    validateDirectoryComponent(current, lockPath, this.logicalPath, true);
    if (!sameFile(this.identity, current)) {
      throw new UnsafeUpdateLockError(lockPath, "lock directory identity changed");
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.handle.close();
  }
}

async function ensureDirectoryPathIsSecure(lockPath: string): Promise<Stats> {
  const directory = path.dirname(lockPath);
  const parsed = path.parse(directory);
  const components = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsed.root;
  let currentStats = await lstat(currentPath);
  validateDirectoryComponent(currentStats, lockPath, currentPath, components.length === 0);

  for (let index = 0; index < components.length; index += 1) {
    currentPath = path.join(currentPath, components[index]!);
    try {
      currentStats = await lstat(currentPath);
    } catch (error: unknown) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
      await mkdir(currentPath, { mode: 0o700 }).catch((mkdirError: Error | { code?: string }) => {
        if (!hasErrorCode(mkdirError, "EEXIST")) {
          throw mkdirError;
        }
      });
      currentStats = await lstat(currentPath);
    }
    validateDirectoryComponent(
      currentStats,
      lockPath,
      currentPath,
      index === components.length - 1,
    );
  }

  return currentStats;
}

async function openSecureLockDirectory(
  lockPath: string,
  platform: NodeJS.Platform,
): Promise<SecureLockDirectory> {
  const directory = path.dirname(lockPath);
  const pathStats = await ensureDirectoryPathIsSecure(lockPath);
  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new UnsafeUpdateLockError(lockPath, "lock directory became a symbolic link");
    }
    throw error;
  }

  try {
    const openedStats = await handle.stat();
    validateDirectoryComponent(openedStats, lockPath, directory, true);
    if (!sameFile(pathStats, openedStats)) {
      throw new UnsafeUpdateLockError(lockPath, "lock directory changed while being opened");
    }
    await handle.chmod(0o700);
    let operationPath: string;
    let usesLogicalPath: boolean;
    if (platform === "linux") {
      operationPath = `/proc/self/fd/${handle.fd}`;
      usesLogicalPath = false;
    } else if (platform === "darwin") {
      // Darwin can duplicate /dev/fd/<fd>, but cannot traverse children beneath it.
      // The secure logical path is therefore fenced against the held directory identity.
      operationPath = directory;
      usesLogicalPath = true;
    } else {
      throw new UnsafeUpdateLockError(
        lockPath,
        "platform cannot anchor or safely fence lock directory operations",
      );
    }

    const context = new SecureLockDirectory(
      directory,
      operationPath,
      usesLogicalPath,
      handle,
      openedStats,
    );
    await context.assertCurrent(lockPath);
    return context;
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

const UpdateLockMetadataSchema = z
  .object({
    version: z.literal(UPDATE_LOCK_METADATA_VERSION),
    ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    pid: z.number().int().safe().positive(),
    hostname: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => value.trim() === value),
    bootId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value),
    processStartId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value),
    acquiredAtMs: z.number().int().safe().nonnegative(),
    leaseExpiresAtMs: z.number().int().safe().nonnegative(),
    label: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim() === value)
      .optional(),
  })
  .strict()
  .refine((metadata) => metadata.leaseExpiresAtMs > metadata.acquiredAtMs);

function parseMetadata(raw: string): UpdateLockMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = UpdateLockMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function readLockSnapshot(
  directory: SecureLockDirectory,
  lockPath: string,
  retryCount = 0,
): Promise<LockSnapshot | null> {
  if (retryCount >= 8) {
    throw new UnsafeUpdateLockError(lockPath, "path changed repeatedly while being inspected");
  }
  const anchoredPath = await directory.resolve(lockPath);
  let pathStats: Stats;
  try {
    pathStats = await lstat(anchoredPath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  validateSecureFile(pathStats, lockPath);
  if (pathStats.size > MAX_UPDATE_LOCK_METADATA_BYTES) {
    return { stats: pathStats, metadata: null };
  }

  let handle: FileHandle;
  try {
    handle = await open(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw new UnsafeUpdateLockError(lockPath, "path became a symbolic link");
    }
    throw error;
  }

  try {
    const openedStats = await handle.stat();
    validateSecureFile(openedStats, lockPath);
    if (!sameFile(pathStats, openedStats)) {
      return readLockSnapshot(directory, lockPath, retryCount + 1);
    }

    const raw = await handle.readFile({ encoding: "utf8" });
    let currentStats: Stats;
    try {
      currentStats = await lstat(anchoredPath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    if (!sameFile(openedStats, currentStats)) {
      return readLockSnapshot(directory, lockPath, retryCount + 1);
    }

    return { stats: openedStats, metadata: parseMetadata(raw) };
  } finally {
    await handle.close();
  }
}

function serializeMetadata(metadata: UpdateLockMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

async function createExclusiveLock(
  directory: SecureLockDirectory,
  lockPath: string,
  metadata: UpdateLockMetadata,
): Promise<boolean> {
  const anchoredPath = await directory.resolve(lockPath);
  let handle: FileHandle;
  try {
    handle = await open(
      anchoredPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw new UnsafeUpdateLockError(lockPath, "path is a symbolic link");
    }
    throw error;
  }

  const createdStats = await handle.stat();
  let complete = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(serializeMetadata(metadata), { encoding: "utf8" });
    await handle.sync();
    await directory.assertCurrent(lockPath);
    complete = true;
    return true;
  } finally {
    await handle.close();
    if (!complete) {
      try {
        const current = await lstat(anchoredPath);
        if (sameFile(createdStats, current)) {
          await unlink(anchoredPath);
        }
      } catch {
        // Preserve the primary write/validation failure; cleanup is best effort.
      }
    }
  }
}

function sameProcessIdentity(
  metadata: UpdateLockMetadata,
  identity: UpdateLockProcessIdentity,
): boolean {
  return metadata.bootId === identity.bootId && metadata.processStartId === identity.processStartId;
}

function sameOwner(left: UpdateLockMetadata | null, right: UpdateLockMetadata): boolean {
  return (
    left !== null &&
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.hostname === right.hostname &&
    left.bootId === right.bootId &&
    left.processStartId === right.processStartId &&
    left.acquiredAtMs === right.acquiredAtMs
  );
}

async function snapshotIsStale(
  snapshot: LockSnapshot,
  options: ResolvedUpdateLockOptions,
  now: number,
  allowRemoteLeaseExpiry = true,
): Promise<boolean> {
  if (snapshot.metadata === null) {
    return now - snapshot.stats.mtimeMs >= options.malformedLockStaleMs;
  }

  if (snapshot.metadata.hostname !== options.hostname) {
    return allowRemoteLeaseExpiry && snapshot.metadata.leaseExpiresAtMs <= now;
  }

  let identity: UpdateLockProcessIdentity | null;
  try {
    identity = await options.getProcessIdentity(snapshot.metadata.pid);
  } catch {
    return false;
  }
  if (identity !== null) {
    return !sameProcessIdentity(snapshot.metadata, identity);
  }

  try {
    return !(await options.isProcessAlive(snapshot.metadata.pid));
  } catch {
    return false;
  }
}

function createMetadata(options: ResolvedUpdateLockOptions, now: number): UpdateLockMetadata {
  const ownerId = parseOwnerId(options.createOwnerId());
  const leaseExpiresAtMs = now + options.leaseDurationMs;
  if (!Number.isSafeInteger(leaseExpiresAtMs)) {
    throw new RangeError("Update lock lease expiration exceeds the safe timestamp range");
  }

  if (options.label !== undefined) {
    return {
      version: UPDATE_LOCK_METADATA_VERSION,
      ownerId,
      pid: options.pid,
      hostname: options.hostname,
      bootId: options.processIdentity.bootId,
      processStartId: options.processIdentity.processStartId,
      acquiredAtMs: now,
      leaseExpiresAtMs,
      label: options.label,
    };
  }

  return {
    version: UPDATE_LOCK_METADATA_VERSION,
    ownerId,
    pid: options.pid,
    hostname: options.hostname,
    bootId: options.processIdentity.bootId,
    processStartId: options.processIdentity.processStartId,
    acquiredAtMs: now,
    leaseExpiresAtMs,
  };
}

async function removeStaleFile(
  directory: SecureLockDirectory,
  lockPath: string,
  expected: LockSnapshot,
  options: ResolvedUpdateLockOptions,
  now: number,
): Promise<boolean> {
  if (!(await snapshotIsStale(expected, options, now, false))) {
    return false;
  }
  const current = await readLockSnapshot(directory, lockPath);
  if (
    current === null ||
    !sameFile(expected.stats, current.stats) ||
    expected.metadata?.ownerId !== current.metadata?.ownerId ||
    !(await snapshotIsStale(current, options, now, false))
  ) {
    return current === null;
  }

  await unlink(await directory.resolve(lockPath)).catch((error: Error | { code?: string }) => {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  });
  await directory.assertCurrent(lockPath);
  return true;
}

async function waitForUpdateLockRetry(
  options: ResolvedUpdateLockOptions,
  startedAtMs: number,
  remainingWaitMs: number,
  owner: UpdateLockMetadata | null,
): Promise<number> {
  const elapsedByClock = Math.max(0, getCurrentTime(options.clock) - startedAtMs);
  const availableWaitMs = Math.min(
    remainingWaitMs,
    Math.max(0, options.timeoutMs - elapsedByClock),
  );
  if (availableWaitMs === 0) {
    throw new UpdateLockUnavailableError(options.lockPath, owner, options.timeoutMs);
  }

  const delayMs = Math.min(options.retryDelayMs, availableWaitMs);
  await options.sleep(delayMs);
  return remainingWaitMs - delayMs;
}

async function acquireMutationFence(
  directory: SecureLockDirectory,
  options: ResolvedUpdateLockOptions,
  startedAtMs: number,
  initialRemainingWaitMs: number,
): Promise<AcquiredMutationFence> {
  const fencePath = `${options.lockPath}.reclaim`;
  let remainingWaitMs = initialRemainingWaitMs;

  while (true) {
    await directory.assertCurrent(options.lockPath);
    const now = getCurrentTime(options.clock);
    const metadata = createMetadata(options, now);
    if (await createExclusiveLock(directory, fencePath, metadata)) {
      await directory.assertCurrent(options.lockPath);
      return { metadata, remainingWaitMs };
    }

    const existing = await readLockSnapshot(directory, fencePath);
    if (existing === null) {
      continue;
    }
    if (await removeStaleFile(directory, fencePath, existing, options, now)) {
      continue;
    }
    remainingWaitMs = await waitForUpdateLockRetry(
      options,
      startedAtMs,
      remainingWaitMs,
      existing.metadata,
    );
  }
}

async function releaseMutationFence(
  directory: SecureLockDirectory,
  options: ResolvedUpdateLockOptions,
  metadata: UpdateLockMetadata,
): Promise<void> {
  const fencePath = `${options.lockPath}.reclaim`;
  const current = await readLockSnapshot(directory, fencePath);
  if (!sameOwner(current?.metadata ?? null, metadata)) {
    throw new UpdateLockOwnershipError(fencePath);
  }
  await unlink(await directory.resolve(fencePath));
  await directory.assertCurrent(options.lockPath);
}

async function withMutationFence<T>(
  directory: SecureLockDirectory,
  options: ResolvedUpdateLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAtMs = getCurrentTime(options.clock);
  const fence = await acquireMutationFence(directory, options, startedAtMs, options.timeoutMs);
  try {
    return await operation();
  } finally {
    await releaseMutationFence(directory, options, fence.metadata);
  }
}

export class UpdateLock {
  readonly lockPath: string;
  private readonly directory: SecureLockDirectory;
  private readonly options: ResolvedUpdateLockOptions;
  private currentMetadata: UpdateLockMetadata;
  private operationQueue: Promise<void> = Promise.resolve();
  private released = false;

  constructor(
    directory: SecureLockDirectory,
    options: ResolvedUpdateLockOptions,
    metadata: UpdateLockMetadata,
  ) {
    this.lockPath = options.lockPath;
    this.directory = directory;
    this.options = options;
    this.currentMetadata = metadata;
  }

  get metadata(): UpdateLockMetadata {
    return { ...this.currentMetadata };
  }

  get isReleased(): boolean {
    return this.released;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async abandon(): Promise<void> {
    this.released = true;
    await this.directory.close();
  }

  renew(leaseDurationMs: number = this.options.leaseDurationMs): Promise<UpdateLockMetadata> {
    return this.enqueue(async () => {
      if (this.released) {
        throw new UpdateLockOwnershipError(this.lockPath);
      }
      requirePositiveInteger(leaseDurationMs, "Update lock lease duration");

      try {
        return await withMutationFence(this.directory, this.options, async () => {
          await this.directory.assertCurrent(this.lockPath);
          const current = await readLockSnapshot(this.directory, this.lockPath);
          if (!sameOwner(current?.metadata ?? null, this.currentMetadata)) {
            throw new UpdateLockOwnershipError(this.lockPath);
          }

          const now = getCurrentTime(this.options.clock);
          const leaseExpiresAtMs =
            Math.max(now, this.currentMetadata.acquiredAtMs) + leaseDurationMs;
          if (!Number.isSafeInteger(leaseExpiresAtMs)) {
            throw new RangeError("Update lock lease expiration exceeds the safe timestamp range");
          }
          const renewed: UpdateLockMetadata = {
            ...this.currentMetadata,
            leaseExpiresAtMs,
          };
          const temporaryPath = `${this.lockPath}.${this.currentMetadata.ownerId}.${randomUUID()}.tmp`;

          try {
            const created = await createExclusiveLock(this.directory, temporaryPath, renewed);
            if (!created) {
              throw new Error(`Temporary update lock already exists: ${temporaryPath}`);
            }
            await this.directory.assertCurrent(this.lockPath);
            await rename(
              await this.directory.resolve(temporaryPath),
              await this.directory.resolve(this.lockPath),
            );
            await this.directory.assertCurrent(this.lockPath);
            this.currentMetadata = renewed;
            return { ...renewed };
          } finally {
            await unlink(await this.directory.resolve(temporaryPath)).catch(
              (error: Error | { code?: string }) => {
                if (!hasErrorCode(error, "ENOENT")) {
                  throw error;
                }
              },
            );
          }
        });
      } catch (error: unknown) {
        if (error instanceof UpdateLockOwnershipError || error instanceof UnsafeUpdateLockError) {
          await this.abandon();
        }
        throw error;
      }
    });
  }

  release(): Promise<void> {
    return this.enqueue(async () => {
      if (this.released) {
        return;
      }

      try {
        await withMutationFence(this.directory, this.options, async () => {
          await this.directory.assertCurrent(this.lockPath);
          const current = await readLockSnapshot(this.directory, this.lockPath);
          if (current === null) {
            throw new UpdateLockOwnershipError(this.lockPath);
          }
          if (!sameOwner(current.metadata, this.currentMetadata)) {
            throw new UpdateLockOwnershipError(this.lockPath);
          }

          await unlink(await this.directory.resolve(this.lockPath));
          await this.directory.assertCurrent(this.lockPath);
        });
        await this.abandon();
      } catch (error: unknown) {
        if (error instanceof UpdateLockOwnershipError || error instanceof UnsafeUpdateLockError) {
          await this.abandon();
        }
        throw error;
      }
    });
  }
}

export async function acquireUpdateLock(
  options: AcquireUpdateLockOptions = {},
): Promise<UpdateLock> {
  const resolved = await resolveOptions(options);
  const directory = await openSecureLockDirectory(resolved.lockPath, resolved.platform);
  let transferred = false;

  try {
    const startedAtMs = getCurrentTime(resolved.clock);
    let remainingWaitMs = resolved.timeoutMs;

    while (true) {
      const fence = await acquireMutationFence(directory, resolved, startedAtMs, remainingWaitMs);
      remainingWaitMs = fence.remainingWaitMs;
      let acquiredMetadata: UpdateLockMetadata | null = null;
      let blockingOwner: UpdateLockMetadata | null = null;

      try {
        const now = getCurrentTime(resolved.clock);
        const snapshot = await readLockSnapshot(directory, resolved.lockPath);
        if (snapshot === null || (await snapshotIsStale(snapshot, resolved, now))) {
          if (snapshot !== null) {
            const current = await readLockSnapshot(directory, resolved.lockPath);
            if (
              current === null ||
              !sameFile(snapshot.stats, current.stats) ||
              snapshot.metadata?.ownerId !== current.metadata?.ownerId ||
              !(await snapshotIsStale(current, resolved, now))
            ) {
              continue;
            }
            await unlink(await directory.resolve(resolved.lockPath));
            await directory.assertCurrent(resolved.lockPath);
          }

          const metadata = createMetadata(resolved, now);
          if (await createExclusiveLock(directory, resolved.lockPath, metadata)) {
            acquiredMetadata = metadata;
          }
        } else {
          blockingOwner = snapshot.metadata;
        }
      } finally {
        await releaseMutationFence(directory, resolved, fence.metadata);
      }

      if (acquiredMetadata !== null) {
        await directory.assertCurrent(resolved.lockPath);
        transferred = true;
        return new UpdateLock(directory, resolved, acquiredMetadata);
      }

      remainingWaitMs = await waitForUpdateLockRetry(
        resolved,
        startedAtMs,
        remainingWaitMs,
        blockingOwner,
      );
    }
  } finally {
    if (!transferred) {
      await directory.close();
    }
  }
}

export async function withUpdateLock<T>(
  options: AcquireUpdateLockOptions,
  operation: (lock: UpdateLock) => T | Promise<T>,
): Promise<T> {
  const lock = await acquireUpdateLock(options);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}
