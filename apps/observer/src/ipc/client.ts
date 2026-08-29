import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { DaemonConfig } from "../config.js";
import type {
  ConfigReloadResult,
  DaemonDiagnosticsReport,
  DaemonHealthReport,
  ModuleStatusReport,
} from "../supervisor.js";
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

export interface IpcClientOptions {
  socketPath?: string;
  authToken?: string;
  tokenFilePath?: string;
  transport?: IpcTransport;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: IpcResponse["result"]) => void;
  reject: (reason?: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for communicating with the Resin background daemon over authenticated IPC.
 */
export class IpcClient {
  readonly socketPath?: string;
  readonly tokenFilePath?: string;
  private authToken: string;
  private transport: IpcTransport | null = null;
  private socket: net.Socket | null = null;
  private defaultTimeoutMs: number;
  private pendingRequests = new Map<string, PendingRequest>();
  private decoder = new FrameDecoder();
  private isConnected = false;

  constructor(options: IpcClientOptions = {}) {
    this.socketPath = options.socketPath;
    this.tokenFilePath = options.tokenFilePath;
    this.authToken = options.authToken ?? "";
    this.defaultTimeoutMs = options.timeoutMs ?? 10000;

    if (options.transport) {
      this.transport = options.transport;
      this.setupTransportListeners(this.transport);
      this.isConnected = true;
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connects to the daemon via Unix socket or named pipe if not already connected.
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    // Load auth token from file if not provided
    if (!this.authToken && this.tokenFilePath && fs.existsSync(this.tokenFilePath)) {
      try {
        this.authToken = (await fs.promises.readFile(this.tokenFilePath, "utf-8")).trim();
      } catch {
        // Ignore read failure
      }
    }

    const targetSocket = this.socketPath;
    if (!targetSocket) {
      throw new Error("No socketPath or transport provided to IpcClient");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(targetSocket, () => {
        this.socket = socket;
        this.isConnected = true;
        this.setupSocketListeners(socket);
        resolve();
      });

      socket.once("error", (err) => {
        reject(
          new Error(`Failed to connect to daemon socket at ${this.socketPath}: ${err.message}`),
        );
      });
    });
  }

  private setupSocketListeners(socket: net.Socket): void {
    socket.on("data", (data) => {
      try {
        const frames = this.decoder.push(data);
        for (const frame of frames) {
          // SAFETY: Frame decoder produces valid JSON messages matching IpcResponse.
          this.handleIncomingResponse(frame as IpcResponse);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.rejectAllPending(new Error(`Error decoding socket frame: ${message}`));
      }
    });

    socket.on("error", (err) => {
      this.rejectAllPending(new Error(`Socket error: ${err.message}`));
    });

    socket.on("close", () => {
      this.isConnected = false;
      this.rejectAllPending(new Error("Connection to daemon closed"));
    });
  }

  private setupTransportListeners(transport: IpcTransport): void {
    transport.onData((data) => {
      try {
        const frames = this.decoder.push(data);
        for (const frame of frames) {
          // SAFETY: Transport messages conform to IpcResponse message structure.
          this.handleIncomingResponse(frame as IpcResponse);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.rejectAllPending(new Error(`Error decoding transport frame: ${message}`));
      }
    });

    transport.onError((err) => {
      this.rejectAllPending(new Error(`Transport error: ${err.message}`));
    });

    transport.onClose(() => {
      this.isConnected = false;
      this.rejectAllPending(new Error("Transport closed"));
    });
  }

  private handleIncomingResponse(response: IpcResponse): void {
    if (!response || !response.id) return;

    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      const error = Object.assign(new Error(response.error.message), {
        code: response.error.code,
        details: response.error.details,
      });
      pending.reject(error);
    } else {
      pending.resolve(response.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Invokes an arbitrary RPC method on the daemon.
   */
  async invoke<TParams = unknown, TResult = unknown>(
    method: string,
    params?: TParams,
    timeoutMs?: number,
  ): Promise<TResult> {
    if (!this.isConnected) {
      await this.connect();
    }

    const id = crypto.randomUUID();
    const request: IpcRequest<TParams> = {
      id,
      token: this.authToken,
      method,
      params,
    };

    const encoded = encodeFrame(request);
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = Object.assign(
          new Error(`IPC request '${method}' (${id}) timed out after ${timeout}ms`),
          {
            code: IPC_ERROR_CODES.TIMEOUT,
          },
        );
        reject(error);
      }, timeout);

      if (timer.unref) timer.unref();

      this.pendingRequests.set(id, {
        // SAFETY: Resolves caller promise with received result of type TResult.
        resolve: (val) => resolve(val as TResult),
        reject: (err) => reject(err),
        timer,
      });

      if (this.transport) {
        void this.transport.send(encoded).catch((err) => {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(err);
        });
      } else if (this.socket) {
        this.socket.write(encoded, (err) => {
          if (err) {
            this.pendingRequests.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } else {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error("No active connection available"));
      }
    });
  }

  async ping(nonce?: string): Promise<PingResult> {
    return this.invoke<PingParams, PingResult>("ping", { nonce });
  }

  async getHealth(): Promise<DaemonHealthReport> {
    return this.invoke<undefined, DaemonHealthReport>("getHealth");
  }

  async getModuleStatus(moduleId?: string): Promise<ModuleStatusReport[]> {
    return this.invoke<GetModuleStatusParams, ModuleStatusReport[]>("getModuleStatus", {
      moduleId,
    });
  }

  async reloadConfig(config?: Partial<DaemonConfig>): Promise<ConfigReloadResult> {
    return this.invoke<ReloadConfigParams, ConfigReloadResult>("reloadConfig", { config });
  }

  async getDiagnostics(): Promise<DaemonDiagnosticsReport> {
    return this.invoke<undefined, DaemonDiagnosticsReport>("getDiagnostics");
  }

  async gracefulShutdown(options?: GracefulShutdownParams): Promise<GracefulShutdownResult> {
    return this.invoke<GracefulShutdownParams, GracefulShutdownResult>("gracefulShutdown", options);
  }

  /**
   * Closes the client connection.
   */
  async close(): Promise<void> {
    this.isConnected = false;
    this.rejectAllPending(new Error("IpcClient closed"));

    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    const activeSocket = this.socket;
    if (activeSocket) {
      await new Promise<void>((resolve) => {
        activeSocket.end(() => {
          activeSocket.destroy();
          resolve();
        });
      });
      this.socket = null;
    }
  }
}
