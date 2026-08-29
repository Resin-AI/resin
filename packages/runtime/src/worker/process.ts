import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityManifest, ToolManifest } from "@resin/contracts";
import { DENO_WORKER_BOOTSTRAP_SOURCE } from "./bootstrap.js";
import {
  type BrokerRequestMessage,
  type BrokerResponseMessage,
  type ErrorMessage,
  type InitializeMessage,
  type InvokeMessage,
  type LogMessage,
  type ProgressMessage,
  type ResultMessage,
  WorkerFrameDecoder,
  WorkerFrameEncoder,
  type WorkerMessage,
  createCancelMessage,
  createInitializeMessage,
  createInvokeMessage,
  createShutdownMessage,
  withResolvers,
} from "./protocol.js";
import type { BrokerRequestHandlerFn } from "./sdk.js";

/**
 * Options for launching and executing a tool inside a WorkerProcess.
 */
export interface WorkerProcessOptions {
  manifest: ToolManifest | Record<string, unknown>;
  bundleEntrypoint: string;
  workspaceRoot?: string;
  capabilities?: CapabilityManifest | Record<string, unknown>;
  environment?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxOutputSizeBytes?: number;
  denoExecutable?: string;
  brokerHandler?: BrokerRequestHandlerFn;
  onProgress?: (progress: ProgressMessage) => void;
  onLog?: (log: LogMessage) => void;
}

/**
 * Result of a tool execution through WorkerProcess.
 */
export interface WorkerExecutionResult {
  status: "success" | "error" | "timeout" | "cancelled" | "validation_error";
  output?: unknown;
  error?: {
    type: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
  durationMs: number;
  resourceUsage?: {
    cpuTimeMs?: number;
    memoryBytes?: number;
  };
  logs: LogMessage[];
  progress: ProgressMessage[];
}

/**
 * Manages an isolated Deno child process worker for executing tool bundles.
 */
export class WorkerProcess {
  private childProcess: ChildProcess | null = null;
  private scratchDir: string | null = null;
  private isDisposed = false;
  private readonly decoder = new WorkerFrameDecoder({ format: "ndjson" });
  private readonly logs: LogMessage[] = [];
  private readonly progress: ProgressMessage[] = [];
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerProcessOptions) {}

  /**
   * Returns the scratch directory created for this worker invocation.
   */
  getScratchDir(): string | null {
    return this.scratchDir;
  }

  /**
   * Executes an invocation in the Deno worker process.
   */
  async execute(
    invocationId: string,
    input: unknown,
    context?: { sessionId?: string; workspaceId?: string; toolId?: string; version?: string },
  ): Promise<WorkerExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = this.options.timeoutMs ?? 30000;
    const denoPath = this.options.denoExecutable ?? "deno";
    const memoryLimitMb = Math.max(16, this.options.memoryLimitMb ?? 128);
    const maxOutputBytes = Math.max(1024, this.options.maxOutputSizeBytes ?? 1024 * 1024);
    let observedOutputBytes = 0;

    // 1. Create unique temporary scratch workspace
    const tempPrefix = path.join(os.tmpdir(), "te-worker-");
    this.scratchDir = fs.mkdtempSync(tempPrefix);
    const bootstrapFilePath = path.join(this.scratchDir, "bootstrap.js");
    fs.writeFileSync(bootstrapFilePath, DENO_WORKER_BOOTSTRAP_SOURCE, "utf-8");

    // 2. Prepare permission flags
    // The worker is permissionless for network, env, run, ffi, write.
    // Read is allowed ONLY for bootstrap script, verified bundle entrypoint, and scratch workspace.
    // The workspace root is strictly excluded from Deno read/write permissions.
    const entrypointDir = path.dirname(path.resolve(this.options.bundleEntrypoint));
    const allowReadPaths = [
      this.scratchDir,
      entrypointDir,
      path.resolve(this.options.bundleEntrypoint),
    ];
    const args = [
      `--v8-flags=--max-old-space-size=${memoryLimitMb}`,
      "run",
      "--no-prompt",
      `--allow-read=${allowReadPaths.join(",")}`,
      `--allow-write=${this.scratchDir}`,
      "--deny-net",
      "--deny-env",
      "--deny-run",
      "--deny-ffi",
      bootstrapFilePath,
    ];

    const { promise, resolve } = withResolvers<WorkerExecutionResult>();

    try {
      this.childProcess = spawn(denoPath, args, {
        cwd: this.scratchDir,
        env: {
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (spawnErr) {
      this.cleanup();
      return {
        status: "error",
        error: {
          type: "spawn_error",
          message: `Failed to spawn Deno worker process: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        },
        durationMs: Date.now() - startTime,
        logs: [],
        progress: [],
      };
    }

    let isSettled = false;

    const finalize = (result: WorkerExecutionResult) => {
      if (isSettled) return;
      isSettled = true;
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }
      this.cleanup();
      resolve(result);
    };

    // 3. Set up timeout timer
    this.timeoutTimer = setTimeout(() => {
      if (isSettled) return;
      try {
        this.sendCancel(invocationId, "Execution timeout exceeded");
        setTimeout(() => {
          this.forceKill();
        }, 200).unref();
      } catch {
        this.forceKill();
      }

      finalize({
        status: "timeout",
        error: {
          type: "timeout",
          message: `Execution timed out after ${timeoutMs}ms`,
        },
        durationMs: Date.now() - startTime,
        logs: this.logs,
        progress: this.progress,
      });
    }, timeoutMs);

    // 4. Stdio Handling
    this.childProcess.stdout?.on("data", async (chunk: Buffer) => {
      observedOutputBytes += chunk.length;
      if (observedOutputBytes > maxOutputBytes) {
        this.terminateProcessTree("SIGKILL");
        finalize({
          status: "error",
          error: {
            type: "resource_limit",
            message: `OUTPUT_LIMIT_EXCEEDED: worker output exceeded ${maxOutputBytes} bytes`,
          },
          durationMs: Date.now() - startTime,
          logs: this.logs,
          progress: this.progress,
        });
        return;
      }
      try {
        const messages = this.decoder.push(chunk);
        for (const msg of messages) {
          await this.handleIncomingMessage(msg, invocationId, startTime, finalize);
        }
      } catch (decodeErr) {
        this.logs.push({
          id: `log_decode_${Date.now()}`,
          type: "log",
          timestamp: Date.now(),
          version: "1.0.0",
          invocationId,
          level: "error",
          message: `Decode error: ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`,
        });
      }
    });

    let stderrBuffer = "";
    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      observedOutputBytes += chunk.length;
      if (observedOutputBytes > maxOutputBytes) {
        this.terminateProcessTree("SIGKILL");
        finalize({
          status: "error",
          error: {
            type: "resource_limit",
            message: `OUTPUT_LIMIT_EXCEEDED: worker output exceeded ${maxOutputBytes} bytes`,
          },
          durationMs: Date.now() - startTime,
          logs: this.logs,
          progress: this.progress,
        });
        return;
      }
      stderrBuffer += chunk.toString("utf-8");
    });

    this.childProcess.on("error", (err) => {
      if (isSettled) return;
      finalize({
        status: "error",
        error: {
          type: "process_error",
          message: `Worker process error: ${err.message}`,
          stack: err.stack,
        },
        durationMs: Date.now() - startTime,
        logs: this.logs,
        progress: this.progress,
      });
    });

    this.childProcess.on("close", (code, signal) => {
      if (isSettled) return;
      const isCrash = code !== 0 && code !== null;
      finalize({
        status: "error",
        error: {
          type: isCrash ? "process_crash" : "process_terminated",
          message: isCrash
            ? `Worker process exited with code ${code}${stderrBuffer ? `: ${stderrBuffer.trim()}` : ""}`
            : `Worker process terminated with signal ${signal}`,
          details: { code, signal, stderr: stderrBuffer },
        },
        durationMs: Date.now() - startTime,
        logs: this.logs,
        progress: this.progress,
      });
    });

    // 5. Send initialize and invoke frames
    try {
      const initMsg = createInitializeMessage({
        manifest: this.options.manifest,
        bundleEntrypoint: this.options.bundleEntrypoint,
        workspaceRoot: this.options.workspaceRoot,
        scratchDir: this.scratchDir,
        capabilities: this.options.capabilities,
        environment: this.options.environment,
        limits: {
          timeoutMs,
          memoryLimitMb: this.options.memoryLimitMb,
          maxOutputSizeBytes: this.options.maxOutputSizeBytes,
        },
      });
      this.writeMessage(initMsg);

      const invokeMsg = createInvokeMessage({
        invocationId,
        input,
        context,
      });
      this.writeMessage(invokeMsg);
    } catch (writeErr) {
      finalize({
        status: "error",
        error: {
          type: "write_error",
          message: `Failed to write initial RPC frames to worker: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        },
        durationMs: Date.now() - startTime,
        logs: this.logs,
        progress: this.progress,
      });
    }

    return promise;
  }

  private async handleIncomingMessage(
    msg: WorkerMessage,
    invocationId: string,
    startTime: number,
    finalize: (res: WorkerExecutionResult) => void,
  ): Promise<void> {
    switch (msg.type) {
      case "progress": {
        this.progress.push(msg);
        this.options.onProgress?.(msg);
        break;
      }
      case "log": {
        this.logs.push(msg);
        this.options.onLog?.(msg);
        break;
      }
      case "broker_request": {
        await this.handleBrokerRequest(msg);
        break;
      }
      case "result": {
        finalize({
          status: "success",
          output: msg.output,
          durationMs: msg.durationMs || Date.now() - startTime,
          resourceUsage: msg.resourceUsage,
          logs: this.logs,
          progress: this.progress,
        });
        break;
      }
      case "error": {
        const isValidation = msg.errorType === "validation_error";
        const isTimeout = msg.errorType === "timeout";
        const isCancelled = msg.errorType === "cancelled";
        finalize({
          status: isValidation
            ? "validation_error"
            : isTimeout
              ? "timeout"
              : isCancelled
                ? "cancelled"
                : "error",
          error: {
            type: msg.errorType,
            message: msg.message,
            stack: msg.stack,
            details: msg.details,
          },
          durationMs: Date.now() - startTime,
          logs: this.logs,
          progress: this.progress,
        });
        break;
      }
      default:
        break;
    }
  }

  private async handleBrokerRequest(msg: BrokerRequestMessage): Promise<void> {
    if (!this.options.brokerHandler) {
      const response: BrokerResponseMessage = {
        id: `brsp_${Date.now()}`,
        type: "broker_response",
        timestamp: Date.now(),
        version: "1.0.0",
        requestId: msg.requestId,
        success: false,
        error: {
          code: "NO_BROKER_HANDLER",
          message: "No broker request handler registered on host",
        },
      };
      this.writeMessage(response);
      return;
    }

    try {
      const result = await this.options.brokerHandler(msg.service, msg.action, msg.payload);
      const response: BrokerResponseMessage = {
        id: `brsp_${Date.now()}`,
        type: "broker_response",
        timestamp: Date.now(),
        version: "1.0.0",
        requestId: msg.requestId,
        success: true,
        payload: result,
      };
      this.writeMessage(response);
    } catch (err: unknown) {
      const response: BrokerResponseMessage = {
        id: `brsp_${Date.now()}`,
        type: "broker_response",
        timestamp: Date.now(),
        version: "1.0.0",
        requestId: msg.requestId,
        success: false,
        error: {
          code: "BROKER_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      this.writeMessage(response);
    }
  }

  private writeMessage(msg: WorkerMessage): void {
    if (!this.childProcess || !this.childProcess.stdin || this.childProcess.stdin.destroyed) {
      return;
    }
    const line = WorkerFrameEncoder.encodeNDJSON(msg);
    this.childProcess.stdin.write(line);
  }

  /**
   * Sends a cancellation message to the running invocation.
   */
  sendCancel(invocationId: string, reason?: string): void {
    this.writeMessage(createCancelMessage({ invocationId, reason }));
  }

  /**
   * Forces termination of the child process.
   */
  private terminateProcessTree(signal: NodeJS.Signals): void {
    if (!this.childProcess || this.childProcess.killed) return;
    try {
      if (process.platform !== "win32" && this.childProcess.pid) {
        process.kill(-this.childProcess.pid, signal);
      } else {
        this.childProcess.kill(signal);
      }
    } catch {
      try {
        this.childProcess.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  }

  forceKill(): void {
    this.terminateProcessTree("SIGKILL");
  }

  /**
   * Cleans up child process and deletes scratch directory.
   */
  cleanup(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.writeMessage(createShutdownMessage({ graceful: true }));
        this.terminateProcessTree("SIGTERM");
      } catch {
        // ignore
      }
    }

    if (this.scratchDir && fs.existsSync(this.scratchDir)) {
      try {
        fs.rmSync(this.scratchDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}
