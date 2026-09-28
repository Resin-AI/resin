import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type SecurePipeServer,
  WINDOWS_PIPE_PREFIX,
  createSecurePipeServer,
  verifyPipeServer,
} from "@resin/windows-security";
import type { DaemonConfig } from "../config.js";
import type { Logger } from "../lifecycle.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { ConfigReloadResult, DaemonSupervisor } from "../supervisor.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import {
  type GetModuleStatusParams,
  type GracefulShutdownParams,
  type GracefulShutdownResult,
  IPC_ERROR_CODES,
  type IpcMethodParams,
  type IpcRequest,
  type IpcResponse,
  type PingParams,
  type PingResult,
  type ReloadConfigParams,
} from "./protocol.js";
import type { IpcTransport } from "./transport.js";

/** Upper bound on waiting for a client to take the replies already written to its pipe. */
const PIPE_REPLY_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Ends `socket` once its pending writes complete: a graceful pipe close keeps what was written
 * readable by the client. Resolves when it has, or after {@link PIPE_REPLY_FLUSH_TIMEOUT_MS} for a
 * client that stopped reading (the caller then forces the close).
 */
function closeAfterPendingWrites(socket: Duplex): Promise<void> {
  if (socket.destroyed || socket.writableFinished) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, PIPE_REPLY_FLUSH_TIMEOUT_MS);
  timer.unref();
  const done = (): void => {
    clearTimeout(timer);
    resolve();
  };
  socket.once("finish", done);
  socket.once("close", done);
  socket.once("error", done);
  socket.end();
  return promise;
}

export interface IpcServerOptions {
  supervisor: DaemonSupervisor;
  socketPath?: string;
  logger?: Logger;
  /**
   * Daemon-owned reload hook for applying runtime lifecycle changes after config validation.
   */
  reloadConfig?: (
    config?: ReloadConfigParams["config"],
  ) => Promise<ConfigReloadResult | undefined | boolean | JsonObject>;
}

/**
 * Local IPC server supporting Unix Domain Sockets,
 * Windows Named Pipes, and in-memory transports for testing.
 */
/**
 * Longest Unix domain socket path, in bytes, the platform's `sun_path` holds (without its NUL).
 * macOS and the BSDs allow 104 bytes including the terminator; Linux allows 108.
 */
export function unixSocketPathLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === "linux" || platform === "android" ? 107 : 103;
}

/**
 * Refuses a socket path the kernel cannot bind. On macOS an over-long path does not fail
 * `listen()`: the socket is never created where clients look, so the daemon reports a running IPC
 * server that nothing can reach. Fail at start with the fix instead.
 */
export function assertUnixSocketPathFits(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" || socketPath.startsWith("\\\\.\\pipe\\")) return;
  const bytes = Buffer.byteLength(socketPath);
  const limit = unixSocketPathLimit(platform);
  if (bytes > limit) {
    throw new Error(
      `Daemon socket path is ${bytes} bytes, over this platform's ${limit}-byte Unix socket limit: ${socketPath}. Use a shorter RESIN_HOME, or set RESIN_SOCKET_PATH to a shorter path.`,
    );
  }
}

export class IpcServer {
  readonly supervisor: DaemonSupervisor;
  readonly socketPath?: string;
  private logger?: Logger;
  private netServer: net.Server | null = null;
  private pipeServer: SecurePipeServer | null = null;
  private activeSockets = new Set<Duplex>();
  private readonly reloadConfigHandler?: IpcServerOptions["reloadConfig"];
  private reloadQueue: Promise<void> = Promise.resolve();
  private activeTransports = new Set<IpcTransport>();
  private isRunning = false;

  constructor(options: IpcServerOptions) {
    this.supervisor = options.supervisor;
    this.socketPath = options.socketPath ?? options.supervisor.getPaths().socketPath;
    this.logger = options.logger;
    this.reloadConfigHandler = options.reloadConfig;
  }

  get listening(): boolean {
    return this.isRunning;
  }

  /**
   * Starts the IPC server.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    if (this.socketPath) {
      await this.startNetServer(this.socketPath);
    }

    this.isRunning = true;
    this.logger?.info("IPC server started", { socketPath: this.socketPath });
  }

  /**
   * Attaches an in-memory transport to the IPC server (primarily used for unit testing).
   */
  attachTransport(transport: IpcTransport): void {
    this.activeTransports.add(transport);
    const decoder = new FrameDecoder();

    transport.onData((data) => {
      try {
        const frames = decoder.push(data);
        for (const frame of frames) {
          // SAFETY: Decoded transport frame matches IpcRequest envelope.
          void this.handleRequest(frame as IpcRequest, (response) => {
            if (!transport.isClosed) {
              void transport.send(encodeFrame(response));
            }
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`Error decoding transport frame: ${errorMsg}`);
      }
    });

    transport.onClose(() => {
      this.activeTransports.delete(transport);
    });
  }

  /**
   * Stops the IPC server and cleans up active connections and socket files.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    // Close all connected sockets. A forced named-pipe close disconnects the client and discards
    // what it has not read yet (a Unix socket keeps written bytes readable), so on Windows the
    // replies already sent, such as the answer to `gracefulShutdown`, are delivered first.
    const sockets = [...this.activeSockets];
    if (process.platform === "win32") {
      await Promise.all(sockets.map((socket) => closeAfterPendingWrites(socket)));
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    // Close all connected transports
    for (const transport of this.activeTransports) {
      void transport.close();
    }
    this.activeTransports.clear();

    const pipeServer = this.pipeServer;
    if (pipeServer) {
      this.pipeServer = null;
      await pipeServer.close();
    }

    // Close net server
    const server = this.netServer;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.netServer = null;
    }

    // Unlink socket file if it exists and is a filesystem path
    if (this.socketPath && !this.socketPath.startsWith(WINDOWS_PIPE_PREFIX)) {
      try {
        await fs.promises.unlink(this.socketPath);
      } catch {
        // Ignore error if socket file is already gone
      }
    }

    this.logger?.info("IPC server stopped");
  }

  private async startNetServer(socketPath: string): Promise<void> {
    if (process.platform === "win32") {
      this.startWindowsPipeServer(socketPath);
      return;
    }

    assertUnixSocketPathFits(socketPath);
    // If socket file exists on filesystem, check if stale and unlink
    if (!socketPath.startsWith(WINDOWS_PIPE_PREFIX)) {
      const socketDir = path.dirname(socketPath);
      await fs.promises.mkdir(socketDir, { recursive: true, mode: 0o700 });

      if (fs.existsSync(socketPath)) {
        try {
          await fs.promises.unlink(socketPath);
        } catch {
          // Ignore
        }
      }
    }

    this.netServer = net.createServer((socket) => this.serveConnection(socket));

    const serverInstance = this.netServer;
    if (!serverInstance) return;

    await new Promise<void>((resolve, reject) => {
      serverInstance.once("error", reject);
      serverInstance.listen(socketPath, () => {
        serverInstance.removeListener("error", reject);
        // Fix permissions on POSIX socket
        if (!socketPath.startsWith(WINDOWS_PIPE_PREFIX)) {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch {
            // Ignore chmod error
          }
        }
        resolve();
      });
    });
  }

  /**
   * Windows: Node's `net` pipes get a default DACL that lets other users connect, so the daemon
   * serves through an owner-only pipe that it claims exclusively. A name that is already taken is
   * never shared: the daemon refuses to start instead of listening beside a squatter.
   */
  private startWindowsPipeServer(pipeName: string): void {
    if (!pipeName.startsWith(WINDOWS_PIPE_PREFIX)) {
      throw new Error(
        `Refusing to serve IPC on '${pipeName}': on Windows the daemon socket must be a local named pipe (${WINDOWS_PIPE_PREFIX}...).`,
      );
    }
    try {
      this.pipeServer = createSecurePipeServer(pipeName, (socket) => this.serveConnection(socket), {
        onError: (error) => this.logger?.error(`Named pipe server error: ${error.message}`),
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EADDRINUSE") throw error;
      const holder = verifyPipeServer(pipeName);
      const message = holder.ok
        ? `Another Resin daemon for this user is already serving ${pipeName}.`
        : `Named pipe ${pipeName} is held by another principal (${holder.reason ?? "unverifiable"}); refusing to start the daemon IPC server. Stop the process that owns the pipe or choose a different RESIN_HOME.`;
      throw Object.assign(new Error(message), { code: "EADDRINUSE", cause: error });
    }
  }

  private serveConnection(socket: Duplex): void {
    this.activeSockets.add(socket);
    const decoder = new FrameDecoder();

    socket.on("data", (data: Buffer) => {
      try {
        const frames = decoder.push(data);
        for (const frame of frames) {
          // SAFETY: Decoded socket frame matches IpcRequest envelope.
          void this.handleRequest(frame as IpcRequest, (response) => {
            if (!socket.destroyed && !socket.writableEnded) {
              socket.write(encodeFrame(response));
            }
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`Error handling socket frame: ${errorMsg}`);
      }
    });

    socket.on("error", (err: Error) => {
      this.logger?.debug(`Client socket error: ${err.message}`);
      this.activeSockets.delete(socket);
    });

    socket.on("close", () => {
      this.activeSockets.delete(socket);
    });
  }

  private async handleRequest(
    request: IpcRequest,
    sendResponse: (response: IpcResponse) => void,
  ): Promise<void> {
    if (!request || !request.id || !request.method) {
      sendResponse({
        id: request?.id ?? "unknown",
        error: {
          code: IPC_ERROR_CODES.INVALID_REQUEST,
          message: "Invalid request envelope: missing id or method",
        },
      });
      return;
    }

    try {
      const result = await this.dispatchMethod(request.method, request.params);
      sendResponse({
        id: request.id,
        result,
      });
    } catch (err: unknown) {
      // SAFETY: Caught dispatch error carries optional code property.
      const error = err as Error & { code?: string };
      const code =
        error.code === IPC_ERROR_CODES.METHOD_NOT_FOUND
          ? IPC_ERROR_CODES.METHOD_NOT_FOUND
          : IPC_ERROR_CODES.INTERNAL_ERROR;
      this.logger?.error("IPC request failed", {
        method: request.method,
        code,
        error: error.message,
      });
      sendResponse({
        id: request.id,
        error: {
          code,
          message: code === IPC_ERROR_CODES.METHOD_NOT_FOUND ? error.message : "IPC request failed",
        },
      });
    }
  }

  private async dispatchMethod(
    method: string,
    params?: IpcMethodParams,
  ): Promise<IpcResponse["result"]> {
    switch (method) {
      case "ping": {
        // SAFETY: IPC ping params are optional and conform to PingParams.
        const pingParams = (params ?? {}) as PingParams;
        const result: PingResult = {
          pong: true,
          nonce: pingParams.nonce,
          timestamp: Date.now(),
        };
        return result;
      }

      case "getHealth": {
        return this.supervisor.getHealth();
      }

      case "getModuleStatus": {
        // SAFETY: IPC getModuleStatus params conform to GetModuleStatusParams.
        const p = (params ?? {}) as GetModuleStatusParams;
        return this.supervisor.getModuleStatus(p.moduleId);
      }

      case "reloadConfig": {
        // SAFETY: IPC reloadConfig params conform to ReloadConfigParams.
        const p = (params ?? {}) as ReloadConfigParams;
        const operation = this.reloadQueue.then(() =>
          this.reloadConfigHandler
            ? this.reloadConfigHandler(p.config)
            : this.supervisor.reloadConfig(p.config),
        );
        this.reloadQueue = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      }

      case "getDiagnostics": {
        return this.supervisor.getDiagnostics();
      }

      case "gracefulShutdown": {
        // SAFETY: IPC gracefulShutdown params conform to GracefulShutdownParams.
        const p = (params ?? {}) as GracefulShutdownParams;
        // Schedule shutdown on next tick to allow responding first
        queueMicrotask(() => {
          void this.supervisor.stop({
            timeoutMs: p.timeoutMs,
            reason: p.reason ?? "IPC gracefulShutdown",
          });
        });
        const result: GracefulShutdownResult = {
          accepted: true,
          message: "Graceful shutdown initiated",
        };
        return result;
      }

      default: {
        const error = Object.assign(new Error(`Method '${method}' not found`), {
          code: IPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
        throw error;
      }
    }
  }
}
