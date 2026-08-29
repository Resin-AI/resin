import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Logger } from "../lifecycle.js";
import type { DaemonSupervisor } from "../supervisor.js";
import { FrameDecoder, encodeFrame } from "./framing.js";
import {
  type GetModuleStatusParams,
  type GracefulShutdownParams,
  type GracefulShutdownResult,
  IPC_ERROR_CODES,
  type IpcRequest,
  type IpcResponse,
  type PingParams,
  type PingResult,
  type ReloadConfigParams,
} from "./protocol.js";
import type { IpcTransport } from "./transport.js";

export interface IpcServerOptions {
  supervisor: DaemonSupervisor;
  socketPath?: string;
  authToken?: string;
  tokenFilePath?: string;
  logger?: Logger;
  /**
   * Daemon-owned reload hook for applying runtime lifecycle changes after config validation.
   */
  reloadConfig?: (config?: ReloadConfigParams["config"]) => Promise<unknown>;
}

/**
 * Local authenticated IPC server supporting Unix Domain Sockets,
 * Windows Named Pipes, and in-memory transports for testing.
 */
export class IpcServer {
  readonly supervisor: DaemonSupervisor;
  readonly socketPath?: string;
  readonly tokenFilePath?: string;
  private authToken: string;
  private logger?: Logger;
  private netServer: net.Server | null = null;
  private activeSockets = new Set<net.Socket>();
  private readonly reloadConfigHandler?: IpcServerOptions["reloadConfig"];
  private reloadQueue: Promise<void> = Promise.resolve();
  private activeTransports = new Set<IpcTransport>();
  private isRunning = false;

  constructor(options: IpcServerOptions) {
    this.supervisor = options.supervisor;
    this.socketPath = options.socketPath ?? options.supervisor.getPaths().socketPath;
    this.tokenFilePath = options.tokenFilePath ?? options.supervisor.getPaths().tokenFilePath;
    this.logger = options.logger;
    this.reloadConfigHandler = options.reloadConfig;
    this.authToken = options.authToken ?? options.supervisor.getConfig().authToken ?? "";
  }

  get token(): string {
    return this.authToken;
  }

  get listening(): boolean {
    return this.isRunning;
  }

  /**
   * Starts the IPC server and prepares the authentication token.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Ensure authentication token exists
    if (!this.authToken) {
      if (this.tokenFilePath && fs.existsSync(this.tokenFilePath)) {
        try {
          this.authToken = (await fs.promises.readFile(this.tokenFilePath, "utf-8")).trim();
        } catch {
          this.authToken = crypto.randomBytes(32).toString("hex");
        }
      } else {
        this.authToken = crypto.randomBytes(32).toString("hex");
        if (this.tokenFilePath) {
          try {
            await fs.promises.mkdir(path.dirname(this.tokenFilePath), {
              recursive: true,
              mode: 0o700,
            });
            await fs.promises.writeFile(this.tokenFilePath, this.authToken, { mode: 0o600 });
          } catch {
            // Ignore error writing token file if directory is unwritable
          }
        }
      }
    }

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
          void this.handleRequest(frame as IpcRequest, (response) => {
            if (!transport.isClosed) {
              void transport.send(encodeFrame(response));
            }
          });
        }
      } catch (err) {
        this.logger?.error(`Error decoding transport frame: ${(err as Error).message}`);
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

    // Close all connected sockets
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    // Close all connected transports
    for (const transport of this.activeTransports) {
      void transport.close();
    }
    this.activeTransports.clear();

    // Close net server
    const server = this.netServer;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.netServer = null;
    }

    // Unlink socket file if it exists and is a filesystem path
    if (this.socketPath && !this.socketPath.startsWith("\\\\.\\pipe\\")) {
      try {
        await fs.promises.unlink(this.socketPath);
      } catch {
        // Ignore error if socket file is already gone
      }
    }

    this.logger?.info("IPC server stopped");
  }

  private async startNetServer(socketPath: string): Promise<void> {
    // If socket file exists on filesystem, check if stale and unlink
    if (!socketPath.startsWith("\\\\.\\pipe\\")) {
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

    this.netServer = net.createServer((socket) => {
      this.activeSockets.add(socket);
      const decoder = new FrameDecoder();

      socket.on("data", (data) => {
        try {
          const frames = decoder.push(data);
          for (const frame of frames) {
            void this.handleRequest(frame as IpcRequest, (response) => {
              if (!socket.destroyed) {
                socket.write(encodeFrame(response));
              }
            });
          }
        } catch (err) {
          this.logger?.error(`Error handling socket frame: ${(err as Error).message}`);
        }
      });

      socket.on("error", (err) => {
        this.logger?.debug(`Client socket error: ${err.message}`);
        this.activeSockets.delete(socket);
      });

      socket.on("close", () => {
        this.activeSockets.delete(socket);
      });
    });

    const serverInstance = this.netServer;
    if (!serverInstance) return;

    await new Promise<void>((resolve, reject) => {
      serverInstance.once("error", reject);
      serverInstance.listen(socketPath, () => {
        serverInstance.removeListener("error", reject);
        // Fix permissions on POSIX socket
        if (!socketPath.startsWith("\\\\.\\pipe\\") && process.platform !== "win32") {
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

  private async handleRequest(
    request: IpcRequest,
    sendResponse: (response: IpcResponse) => void,
  ): Promise<void> {
    if (
      !request ||
      typeof request !== "object" ||
      !request.id ||
      typeof request.method !== "string"
    ) {
      sendResponse({
        id: request?.id ?? "unknown",
        error: {
          code: IPC_ERROR_CODES.INVALID_REQUEST,
          message: "Invalid request envelope: missing id or method",
        },
      });
      return;
    }

    // Verify authentication token
    if (this.authToken && request.token !== this.authToken) {
      sendResponse({
        id: request.id,
        error: {
          code: IPC_ERROR_CODES.UNAUTHORIZED,
          message: "Unauthorized: missing or invalid authentication token",
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
      const error = err as Error & { code?: string };
      const code =
        error.code === IPC_ERROR_CODES.METHOD_NOT_FOUND
          ? IPC_ERROR_CODES.METHOD_NOT_FOUND
          : IPC_ERROR_CODES.INTERNAL_ERROR;
      this.logger?.error("Authenticated IPC request failed", {
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

  private async dispatchMethod(method: string, params?: unknown): Promise<unknown> {
    switch (method) {
      case "ping": {
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
        const p = (params ?? {}) as GetModuleStatusParams;
        return this.supervisor.getModuleStatus(p.moduleId);
      }

      case "reloadConfig": {
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
