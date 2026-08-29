import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { encodeFrame } from "./ipc/framing.js";
import type { JsonObject } from "./normalization/redaction.js";
export interface LockPayload {
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
  version: string;
  socketPath: string;
  metadata?: JsonObject;
}

export type LockAcquisitionStatus = "acquired" | "already_running" | "stale_recovered";

export interface LockAcquisitionResult {
  status: LockAcquisitionStatus;
  lock?: DaemonLock;
  pid?: number;
  lockData?: LockPayload;
  previousLockData?: LockPayload;
  recoveredSocketPaths?: string[];
  quarantinedLockPath?: string;
}

export interface LockInspectionResult {
  exists: boolean;
  isStale: boolean;
  isProcessAlive: boolean;
  isLeaseExpired?: boolean;
  pid?: number;
  lockData?: LockPayload;
  error?: string;
}

export interface DaemonLockOptions {
  lockPath: string;
  socketPath?: string;
  version?: string;
  staleThresholdMs?: number;
  heartbeatIntervalMs?: number;
  ipcProbeTimeoutMs?: number;
  metadata?: JsonObject;
}

/**
 * Checks whether a process with the given PID is currently active.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // SAFETY: Node.js filesystem error carries standard ErrnoException code.
    const error = err as NodeJS.ErrnoException;
    // EPERM means the process exists but is owned by another user -> definitely alive
    if (error.code === "EPERM") {
      return true;
    }
    // ESRCH means no such process exists
    if (error.code === "ESRCH") {
      return false;
    }
    // Any other error: defensively assume alive
    return true;
  }
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const DEFAULT_IPC_PROBE_TIMEOUT_MS = 750;
const MAX_IPC_PROBE_TIMEOUT_MS = 5_000;
const IPC_PROBE_RETRY_INTERVAL_MS = 50;
const IPC_PROBE_ATTEMPT_TIMEOUT_MS = 250;
const MAX_IPC_PROBE_RESPONSE_BYTES = 64 * 1024;

interface VerifiedSocket {
  path: string;
  device: number;
  inode: number;
}

function isWindowsPipe(socketPath: string): boolean {
  return socketPath.startsWith(WINDOWS_PIPE_PREFIX);
}

function normalizeSocketPath<T>(socketPath: T): string | undefined {
  if (!socketPath || !z.string().min(1).safeParse(socketPath).success) {
    return undefined;
  }
  const p = String(socketPath);
  return isWindowsPipe(p) ? p : path.resolve(p);
}

async function socketEntryExists(socketPath: string): Promise<boolean> {
  if (isWindowsPipe(socketPath)) {
    return true;
  }

  try {
    return (await fs.promises.lstat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

function probeIpcOnce(socketPath: string, timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const requestId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  let socket: net.Socket | undefined;
  let responseBuffer = Buffer.alloc(0);
  let outcome: boolean | undefined;

  const finish = (responsive: boolean): void => {
    if (outcome !== undefined) return;
    outcome = responsive;
    clearTimeout(timer);
    if (!socket) {
      resolve(responsive);
      return;
    }
    socket.destroy();
  };

  const timer = setTimeout(() => finish(false), timeoutMs);
  timer.unref?.();

  try {
    socket = net.createConnection(socketPath);
  } catch {
    finish(false);
    return promise;
  }

  socket.once("connect", () => {
    socket?.write(
      encodeFrame({
        id: requestId,
        method: "ping",
        params: { nonce },
      }),
      (error) => {
        if (error) finish(false);
      },
    );
  });
  socket.on("data", (chunk) => {
    if (responseBuffer.length + chunk.length > MAX_IPC_PROBE_RESPONSE_BYTES + 4) {
      finish(false);
      return;
    }

    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    if (responseBuffer.length < 4) return;

    const payloadLength = responseBuffer.readUInt32BE(0);
    if (payloadLength > MAX_IPC_PROBE_RESPONSE_BYTES) {
      finish(false);
      return;
    }
    if (responseBuffer.length < payloadLength + 4) return;

    try {
      // SAFETY: IPC probe response body conforms to expected JSON envelope.
      const response = JSON.parse(
        responseBuffer.subarray(4, payloadLength + 4).toString("utf-8"),
      ) as {
        id?: unknown;
        result?: { pong?: unknown; nonce?: unknown };
        error?: { code?: unknown };
      };
      if (response.id !== requestId) {
        finish(false);
        return;
      }
      const authenticatedPong = response.result?.pong === true && response.result.nonce === nonce;
      const resinAuthenticationChallenge = response.error?.code === "UNAUTHORIZED";
      finish(authenticatedPong || resinAuthenticationChallenge);
    } catch {
      finish(false);
    }
  });
  socket.once("error", () => finish(false));
  socket.once("close", () => {
    if (outcome === undefined) {
      outcome = false;
      clearTimeout(timer);
    }
    resolve(outcome);
  });
  return promise;
}

async function probeIpcEndpoint(
  socketPath: string,
  timeoutMs: number,
  waitForEndpoint: boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  do {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await socketEntryExists(socketPath)) {
      const attemptTimeoutMs = waitForEndpoint
        ? Math.min(IPC_PROBE_ATTEMPT_TIMEOUT_MS, remainingMs)
        : remainingMs;
      if (await probeIpcOnce(socketPath, attemptTimeoutMs)) {
        return true;
      }
    }

    if (!waitForEndpoint) {
      return false;
    }
    const delayMs = Math.min(IPC_PROBE_RETRY_INTERVAL_MS, deadline - Date.now());
    if (delayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delayMs);
      await promise;
    }
  } while (Date.now() < deadline);

  return false;
}

/**
 * Manages an atomic single-instance daemon lock file with PID inspection,
 * periodic heartbeat renewals, and stale lock recovery.
 */
export class DaemonLock {
  readonly lockPath: string;
  readonly socketPath: string;
  readonly version: string;
  readonly staleThresholdMs: number;
  readonly heartbeatIntervalMs: number;
  readonly ipcProbeTimeoutMs: number;
  readonly metadata: JsonObject;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isHeld = false;
  private startedAt = 0;

  constructor(options: DaemonLockOptions) {
    this.lockPath = path.resolve(options.lockPath);
    this.socketPath = normalizeSocketPath(options.socketPath) ?? "";
    this.version = options.version ?? "0.1.0";
    this.staleThresholdMs = options.staleThresholdMs ?? 15000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000;
    const requestedProbeTimeoutMs = options.ipcProbeTimeoutMs ?? DEFAULT_IPC_PROBE_TIMEOUT_MS;
    this.ipcProbeTimeoutMs = Math.min(
      MAX_IPC_PROBE_TIMEOUT_MS,
      Math.max(1, Math.floor(requestedProbeTimeoutMs)),
    );
    this.metadata = options.metadata ?? {};
  }

  /**
   * Returns true if this lock instance is currently held by this process.
   */
  get isLocked(): boolean {
    return this.isHeld;
  }

  /**
   * Attempts to acquire the daemon lock atomically.
   */
  async acquire(): Promise<LockAcquisitionResult> {
    if (this.isHeld) {
      return {
        status: "acquired",
        lock: this,
        pid: process.pid,
      };
    }

    const lockDir = path.dirname(this.lockPath);
    await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });

    const inspectResult = await this.inspect();
    const socketCandidates = this.getSocketCandidates(inspectResult.lockData);
    const responsiveSocket = await this.findResponsiveSocket(
      socketCandidates,
      inspectResult.exists && inspectResult.isProcessAlive,
    );

    if (
      responsiveSocket ||
      (inspectResult.exists &&
        inspectResult.isProcessAlive &&
        inspectResult.isLeaseExpired === false)
    ) {
      return {
        status: "already_running",
        pid: inspectResult.pid,
        lockData: inspectResult.lockData,
      };
    }

    const isRecovery = inspectResult.exists;
    const previousLockData = inspectResult.lockData;

    let quarantinedLockPath: string | undefined;
    if (inspectResult.exists) {
      quarantinedLockPath = await this.quarantineInactiveLock();
    }

    this.startedAt = Date.now();
    const payload: LockPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastHeartbeat: Date.now(),
      version: this.version,
      socketPath: this.socketPath,
      metadata: this.metadata,
    };

    try {
      await fs.promises.writeFile(this.lockPath, JSON.stringify(payload, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (err: unknown) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        const freshInspect = await this.inspect();
        const freshSocketCandidates = this.getSocketCandidates(freshInspect.lockData);
        const freshResponsiveSocket = await this.findResponsiveSocket(
          freshSocketCandidates,
          freshInspect.exists && freshInspect.isProcessAlive,
        );
        if (
          freshResponsiveSocket ||
          (freshInspect.exists &&
            freshInspect.isProcessAlive &&
            freshInspect.isLeaseExpired === false)
        ) {
          return {
            status: "already_running",
            pid: freshInspect.pid,
            lockData: freshInspect.lockData,
          };
        }
      }
      throw err;
    }

    let recoveredSocketPaths: string[] | undefined;
    try {
      recoveredSocketPaths = await this.removeOrphanedSockets(previousLockData);
    } catch (err) {
      await this.removeLockOwnedByCurrentProcess();
      throw err;
    }

    this.isHeld = true;
    this.startHeartbeat();

    return {
      status: isRecovery ? "stale_recovered" : "acquired",
      lock: this,
      pid: process.pid,
      lockData: payload,
      previousLockData,
      quarantinedLockPath,
      recoveredSocketPaths: recoveredSocketPaths.length > 0 ? recoveredSocketPaths : undefined,
    };
  }

  /**
   * Updates the heartbeat timestamp in the lock file.
   */
  async heartbeat(): Promise<void> {
    if (!this.isHeld) return;

    const payload: LockPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastHeartbeat: Date.now(),
      version: this.version,
      socketPath: this.socketPath,
      metadata: this.metadata,
    };

    const tmpPath = `${this.lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let temporaryFileCreated = false;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      temporaryFileCreated = true;

      const currentContent = await fs.promises.readFile(this.lockPath, "utf-8");
      // SAFETY: Existing lock file is valid JSON conforming to LockPayload.
      const currentPayload = JSON.parse(currentContent) as LockPayload;
      if (currentPayload.pid !== process.pid || currentPayload.startedAt !== this.startedAt) {
        throw new Error("Daemon lock ownership changed before heartbeat renewal");
      }

      await fs.promises.rename(tmpPath, this.lockPath);
      temporaryFileCreated = false;
    } catch {
      if (temporaryFileCreated) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {
          // Only the private heartbeat file created above is eligible for cleanup.
        }
      }
    }
  }

  /**
   * Releases the lock file and stops the heartbeat timer.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.isHeld) return;

    this.isHeld = false;
    await this.removeLockOwnedByCurrentProcess();
  }

  /**
   * Inspects the current state of the lock file.
   */
  async inspect(): Promise<LockInspectionResult> {
    try {
      const content = await fs.promises.readFile(this.lockPath, "utf-8");
      let parsed: LockPayload;
      try {
        // SAFETY: Lock file content is valid JSON conforming to LockPayload.
        parsed = JSON.parse(content) as LockPayload;
      } catch {
        // Corrupted JSON -> consider stale
        return {
          exists: true,
          isStale: true,
          isProcessAlive: false,
          error: "Corrupted lock file content",
        };
      }

      if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
        return {
          exists: true,
          isStale: true,
          isProcessAlive: false,
          error: "Missing or invalid PID in lock file",
        };
      }

      const alive = isProcessAlive(parsed.pid);
      const lastHeartbeat =
        z.number().safeParse(parsed.lastHeartbeat).success && Number.isFinite(parsed.lastHeartbeat)
          ? parsed.lastHeartbeat
          : 0;
      const startedAt =
        z.number().safeParse(parsed.startedAt).success && Number.isFinite(parsed.startedAt)
          ? parsed.startedAt
          : 0;
      const latestLeaseTimestamp = Math.max(lastHeartbeat, startedAt);
      const leaseExpired =
        latestLeaseTimestamp <= 0 || Date.now() - latestLeaseTimestamp > this.staleThresholdMs;
      // Acquisition combines this lease signal with a failed bounded IPC probe.
      // `isStale` remains process-only for existing inspection consumers.
      const isStale = !alive;

      return {
        exists: true,
        isStale,
        isProcessAlive: alive,
        isLeaseExpired: leaseExpired,
        pid: parsed.pid,
        lockData: parsed,
      };
    } catch (err: unknown) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return {
          exists: false,
          isStale: false,
          isProcessAlive: false,
        };
      }
      return {
        exists: true,
        isStale: true,
        isProcessAlive: false,
        error: error.message,
      };
    }
  }

  private getSocketCandidates(previousLockData?: LockPayload): string[] {
    const candidates = new Set<string>();
    const previousSocketPath = normalizeSocketPath(previousLockData?.socketPath);
    if (previousSocketPath) candidates.add(previousSocketPath);

    if (this.socketPath) candidates.add(this.socketPath);
    return [...candidates];
  }
  private async quarantineInactiveLock(): Promise<string | undefined> {
    let lockStat: fs.Stats;
    try {
      lockStat = await fs.promises.lstat(this.lockPath);
    } catch (err) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw new Error(
        `Unable to inspect inactive daemon lock at ${this.lockPath}: ${error.message}`,
      );
    }

    if (!lockStat.isFile()) {
      throw new Error(
        `Refusing to replace unexpected non-file daemon lock path at ${this.lockPath}`,
      );
    }

    const quarantinedPath = `${this.lockPath}.stale.${Date.now()}.${process.pid}.${crypto.randomUUID()}`;
    try {
      await fs.promises.rename(this.lockPath, quarantinedPath);
      return quarantinedPath;
    } catch (err) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw new Error(
        `Unable to quarantine inactive daemon lock at ${this.lockPath}: ${error.message}`,
      );
    }
  }

  private async findResponsiveSocket(
    socketPaths: readonly string[],
    waitForEndpoint: boolean,
  ): Promise<string | undefined> {
    const results = await Promise.all(
      socketPaths.map(async (socketPath) => ({
        socketPath,
        responsive: await probeIpcEndpoint(socketPath, this.ipcProbeTimeoutMs, waitForEndpoint),
      })),
    );
    return results.find((result) => result.responsive)?.socketPath;
  }

  private async removeOrphanedSockets(previousLockData?: LockPayload): Promise<string[]> {
    const candidates = new Map<string, boolean>();
    const previousSocketPath = normalizeSocketPath(previousLockData?.socketPath);
    if (previousSocketPath) {
      candidates.set(previousSocketPath, false);
    }
    if (this.socketPath) {
      candidates.set(this.socketPath, true);
    }

    const verifiedSockets = (
      await Promise.all(
        [...candidates].map(([socketPath, requiredForBind]) =>
          this.verifyOrphanedSocket(socketPath, requiredForBind),
        ),
      )
    ).filter((candidate): candidate is VerifiedSocket => candidate !== undefined);

    const removedSocketPaths: string[] = [];
    for (const candidate of verifiedSockets) {
      try {
        const currentStat = await fs.promises.lstat(candidate.path);
        if (
          !currentStat.isSocket() ||
          currentStat.dev !== candidate.device ||
          currentStat.ino !== candidate.inode
        ) {
          throw new Error(
            `Refusing to remove daemon socket because its filesystem entry changed: ${candidate.path}`,
          );
        }
        await fs.promises.unlink(candidate.path);
        removedSocketPaths.push(candidate.path);
      } catch (err) {
        // SAFETY: Node.js filesystem error carries standard ErrnoException code.
        const error = err as NodeJS.ErrnoException;
        if (error.code !== "ENOENT") {
          throw err;
        }
      }
    }

    return removedSocketPaths;
  }

  private async verifyOrphanedSocket(
    socketPath: string,
    requiredForBind: boolean,
  ): Promise<VerifiedSocket | undefined> {
    if (isWindowsPipe(socketPath)) {
      return undefined;
    }

    if (socketPath === this.lockPath) {
      if (requiredForBind) {
        throw new Error("Daemon socket path must not be the daemon lock path");
      }
      return undefined;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(socketPath);
    } catch (err) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return undefined;
      }
      if (!requiredForBind) {
        return undefined;
      }
      throw new Error(
        `Unable to inspect configured daemon socket at ${socketPath}: ${error.message}`,
      );
    }

    if (!stat.isSocket()) {
      if (!requiredForBind) {
        return undefined;
      }
      throw new Error(
        `Refusing to remove non-socket path configured as daemon socket: ${socketPath}`,
      );
    }

    if (await probeIpcEndpoint(socketPath, this.ipcProbeTimeoutMs, false)) {
      throw new Error(`Refusing to remove responsive daemon socket at ${socketPath}`);
    }

    const verifiedStat = await fs.promises.lstat(socketPath);
    if (
      !verifiedStat.isSocket() ||
      verifiedStat.dev !== stat.dev ||
      verifiedStat.ino !== stat.ino
    ) {
      throw new Error(
        `Refusing to remove daemon socket because its filesystem entry changed: ${socketPath}`,
      );
    }

    return {
      path: socketPath,
      device: verifiedStat.dev,
      inode: verifiedStat.ino,
    };
  }

  private async removeLockOwnedByCurrentProcess(): Promise<void> {
    try {
      const initialStat = await fs.promises.lstat(this.lockPath);
      if (!initialStat.isFile()) return;

      const content = await fs.promises.readFile(this.lockPath, "utf-8");
      // SAFETY: Stored lock content is valid JSON conforming to LockPayload.
      const parsed = JSON.parse(content) as LockPayload;
      if (parsed.pid !== process.pid || parsed.startedAt !== this.startedAt) {
        return;
      }

      const finalStat = await fs.promises.lstat(this.lockPath);
      if (
        !finalStat.isFile() ||
        finalStat.dev !== initialStat.dev ||
        finalStat.ino !== initialStat.ino
      ) {
        return;
      }
      await fs.promises.unlink(this.lockPath);
    } catch {
      // Preserve the original startup failure; best-effort owned-lock cleanup only.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
    // Unref so heartbeat doesn't prevent Node process exit if remaining
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export async function acquireDaemonLock(
  options: DaemonLockOptions,
): Promise<LockAcquisitionResult> {
  const lock = new DaemonLock(options);
  return lock.acquire();
}

export async function inspectLockFile(
  lockPath: string,
  staleThresholdMs?: number,
): Promise<LockInspectionResult> {
  const lock = new DaemonLock({ lockPath, staleThresholdMs });
  return lock.inspect();
}
