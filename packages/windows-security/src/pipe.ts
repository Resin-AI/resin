import { createHash } from "node:crypto";
import path from "node:path";
import { Duplex } from "node:stream";
import { currentUserSid } from "./acl.js";
import { type NativeBinding, type NativeServerHandle, nativeBinding } from "./native.js";

export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export type PipeVerificationFailure =
  | "not-running"
  | "access-denied"
  | "open-failed"
  | "foreign-owner"
  | "foreign-server";

export interface PipeVerification {
  ok: boolean;
  reason?: PipeVerificationFailure;
  /** Server process id reported by the pipe, when it could be read. */
  serverPid?: number;
  /** Owner SID of the pipe object, when it could be read. */
  ownerSid?: string;
  /** User SID of the server process, when it could be read. */
  serverSid?: string;
  /** Win32 error code of a failed open. */
  win32Error?: number;
}

const VERIFICATION_FAILURES: ReadonlySet<string> = new Set<PipeVerificationFailure>([
  "not-running",
  "access-denied",
  "open-failed",
  "foreign-owner",
  "foreign-server",
]);

function isVerificationFailure(value: string | undefined): value is PipeVerificationFailure {
  return value !== undefined && VERIFICATION_FAILURES.has(value);
}

/** True for local named-pipe names (`\\.\pipe\...`). */
export function isLocalPipeName(name: string): boolean {
  return name.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX);
}

/**
 * `value` with a canonical `\\.\pipe\` prefix when it names a local pipe (the prefix is matched
 * case-insensitively), otherwise undefined. Remote (`\\host\pipe\`) and `\\?\` forms are not
 * local pipe names.
 */
export function canonicalLocalPipeName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!isLocalPipeName(trimmed) || trimmed.length === WINDOWS_PIPE_PREFIX.length) return undefined;
  return `${WINDOWS_PIPE_PREFIX}${trimmed.slice(WINDOWS_PIPE_PREFIX.length)}`;
}

function normalizeResinHome(resinHome: string): string {
  let normalized = path.win32.resolve(resinHome);
  while (normalized.length > 3 && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

/**
 * Name of the daemon pipe for `resinHome` and the current user:
 * `\\.\pipe\resin-daemon-<first 16 hex of sha256(lowercase SID + "\0" + lowercased home)>`.
 * Distinct users and distinct Resin homes never share a pipe. `userSid` defaults to the current
 * user's SID (Windows only); pass it explicitly to compute names elsewhere (for example tests).
 */
export function windowsDaemonPipeName(resinHome: string, userSid?: string): string {
  const sid = (userSid ?? currentUserSid()).toLowerCase();
  const digest = createHash("sha256")
    .update(`${sid}\0${normalizeResinHome(resinHome)}`)
    .digest("hex");
  return `${WINDOWS_PIPE_PREFIX}resin-daemon-${digest.slice(0, 16)}`;
}

/**
 * Opens `name` with identification-only impersonation and checks that both the pipe object and
 * the server process belong to the current user. Call it before sending anything over a pipe:
 * a server cannot impersonate a client until it has read data from it.
 */
export function verifyPipeServer(name: string): PipeVerification {
  if (!isLocalPipeName(name)) return { ok: false, reason: "open-failed" };
  const result = nativeBinding().verifyPipeServer(name);
  const verification: PipeVerification = { ok: result.ok };
  if (!result.ok) {
    verification.reason = isVerificationFailure(result.reason) ? result.reason : "open-failed";
  }
  if (result.serverPid !== undefined) verification.serverPid = result.serverPid;
  if (result.ownerSid !== undefined) verification.ownerSid = result.ownerSid;
  if (result.serverSid !== undefined) verification.serverSid = result.serverSid;
  if (result.win32Error !== undefined) verification.win32Error = result.win32Error;
  return verification;
}

/** Byte stream over one native pipe connection (either end). */
abstract class NativePipeSocket extends Duplex {
  protected readonly endpoint: NativeServerHandle;
  protected readonly id: number;
  private released = false;

  constructor(endpoint: NativeServerHandle, id: number) {
    super({ allowHalfOpen: false });
    this.endpoint = endpoint;
    this.id = id;
  }

  /** Called for native events of this connection. */
  deliver(kind: "data" | "end" | "error", arg: number | Buffer | string | undefined): void {
    if (kind === "data" && Buffer.isBuffer(arg)) {
      this.push(arg);
    } else if (kind === "end") {
      this.push(null);
    } else if (kind === "error") {
      this.destroy(new Error(typeof arg === "string" ? arg : "named pipe error"));
    }
  }

  override _read(): void {
    // Data is pushed by the native reader thread as it arrives.
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.released) {
      callback(new Error("named pipe connection is closed"));
      return;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    nativeBinding().pipeWrite(this.endpoint, this.id, data, (error) => {
      callback(error === null ? null : new Error(error));
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.release(false);
    callback(error);
  }

  protected release(graceful: boolean): void {
    if (this.released) return;
    this.released = true;
    nativeBinding().pipeClose(this.endpoint, this.id, graceful);
    this.afterRelease();
  }

  protected afterRelease(): void {}
}

/** One client connection of a {@link SecurePipeServer}. */
export class SecurePipeSocket extends NativePipeSocket {
  readonly clientPid: number;

  constructor(server: NativeServerHandle, id: number, clientPid: number) {
    super(server, id);
    this.clientPid = clientPid;
  }

  override _final(callback: (error?: Error | null) => void): void {
    // Every write has completed; close without discarding what the client has not read yet.
    this.release(true);
    callback();
  }
}

/**
 * Client end of a pipe whose owner and server process were verified to be the current user on
 * this very connection, before anything was sent. Pipes cannot be half-closed, so `end()` only
 * finishes writing; the connection closes when the server closes it or on `destroy()`.
 */
export class VerifiedPipeSocket extends NativePipeSocket {
  readonly serverPid: number;

  constructor(endpoint: NativeServerHandle, serverPid: number) {
    super(endpoint, 1);
    this.serverPid = serverPid;
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  protected override afterRelease(): void {
    nativeBinding().pipeServerClose(this.endpoint);
  }
}

export interface ConnectVerifiedPipeOptions {
  /** How long to wait for a free pipe instance while the server is busy (default 2000 ms). */
  timeoutMs?: number;
}

/** Error of {@link connectVerifiedPipe}; `reason` says why no trusted connection exists. */
export interface PipeConnectError extends Error {
  code: "ENOENT" | "EACCES" | "ECONNREFUSED";
  reason: PipeVerificationFailure;
  win32Error?: number;
}

function connectError(
  name: string,
  reason: PipeVerificationFailure,
  win32Error: number,
): PipeConnectError {
  let code: PipeConnectError["code"] = "EACCES";
  let message = `Refusing ${name}: it is not served by the current user (${reason})`;
  if (reason === "not-running") {
    code = "ENOENT";
    message = `No server is listening on ${name}`;
  } else if (reason === "open-failed") {
    code = "ECONNREFUSED";
    message = `Could not open ${name} (win32 error ${win32Error})`;
  }
  return Object.assign(new Error(message), { code, reason, win32Error });
}

/**
 * Connects to a local pipe and, on that same connection and before anything is sent, verifies
 * that the pipe object and the server process belong to the current user (identification-level
 * impersonation only). Resolves the verified stream; rejects with a {@link PipeConnectError}.
 */
export function connectVerifiedPipe(
  name: string,
  options: ConnectVerifiedPipeOptions = {},
): Promise<VerifiedPipeSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<VerifiedPipeSocket>();
  const canonical = canonicalLocalPipeName(name);
  if (canonical === undefined) {
    reject(connectError(name, "open-failed", 0));
    return promise;
  }
  let binding: NativeBinding;
  try {
    binding = nativeBinding();
  } catch (error) {
    reject(error);
    return promise;
  }
  let socket: VerifiedPipeSocket | undefined;
  const onEvent = (
    kind: "connection" | "data" | "end" | "error",
    _id: number,
    arg: number | Buffer | string | undefined,
  ): void => {
    if (kind !== "connection") socket?.deliver(kind, arg);
  };
  binding.pipeConnect(canonical, options.timeoutMs ?? 2_000, onEvent, (error, result) => {
    if (error) {
      reject(error);
      return;
    }
    if (!result.ok) {
      const reason = isVerificationFailure(result.reason) ? result.reason : "open-failed";
      reject(connectError(canonical, reason, result.win32Error));
      return;
    }
    socket = new VerifiedPipeSocket(result.handle, result.serverPid);
    resolve(socket);
  });
  return promise;
}

export interface SecurePipeServer {
  readonly name: string;
  /** Stops accepting connections and disconnects every client. */
  close(): Promise<void>;
}

export interface SecurePipeServerOptions {
  /**
   * Server-level failures, for example a replacement pipe instance could not be created (the
   * connecting client is then turned away; the name stays claimed).
   */
  onError?: (error: Error) => void;
}

/**
 * Serves `name` through a named pipe whose every instance has an owner-only DACL (plus an explicit
 * deny for network logons), rejects remote clients, and claims the name with
 * FILE_FLAG_FIRST_PIPE_INSTANCE. Throws synchronously when the name is already in use, whether by
 * another Resin daemon or by a squatter.
 */
export function createSecurePipeServer(
  name: string,
  onConnection: (socket: SecurePipeSocket) => void,
  options: SecurePipeServerOptions = {},
): SecurePipeServer {
  if (!isLocalPipeName(name)) {
    throw new Error(`Named pipe name must start with ${WINDOWS_PIPE_PREFIX}: ${name}`);
  }
  const binding = nativeBinding();
  const sockets = new Map<number, SecurePipeSocket>();
  let handle: NativeServerHandle | undefined;
  let closed = false;

  const onEvent = (
    kind: "connection" | "data" | "end" | "error",
    id: number,
    arg: number | Buffer | string | undefined,
  ): void => {
    if (!handle) return;
    if (kind === "connection") {
      if (closed) {
        binding.pipeClose(handle, id, false);
        return;
      }
      const socket = new SecurePipeSocket(handle, id, typeof arg === "number" ? arg : 0);
      sockets.set(id, socket);
      socket.once("close", () => sockets.delete(id));
      onConnection(socket);
      return;
    }
    if (kind === "error" && id === 0) {
      options.onError?.(new Error(typeof arg === "string" ? arg : "named pipe server error"));
      return;
    }
    sockets.get(id)?.deliver(kind, arg);
  };

  try {
    handle = binding.createPipeServer(name, onEvent);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "WIN32_5" || code === "WIN32_231") {
      throw Object.assign(
        new Error(
          `Named pipe ${name} is already in use by another process; refusing to serve on it.`,
        ),
        { code: "EADDRINUSE", cause: error },
      );
    }
    throw error;
  }
  const serverHandle = handle;

  return {
    name,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
      binding.pipeServerClose(serverHandle);
    },
  };
}
