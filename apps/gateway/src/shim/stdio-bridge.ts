import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { SecretManager } from "@resin/crypto";
import { type CloudCredentialStore, getDaemonPaths } from "@resin/observer";
import { LocalMcpGateway } from "../gateway.js";
import { createSystemMetaTools } from "../meta/index.js";
import { type ProductionProxyRuntime, createProductionProxyRuntime } from "../proxy/runtime.js";
import { ToolRegistry } from "../registry/registry.js";
import { type GatewayRouter, createRegistryGatewayRouter } from "../router.js";
import { withResolvers } from "../utils/deferred.js";
export interface McpStdioShimOptions {
  socketPath?: string;
  standaloneFallback?: boolean;
  cwd?: string;
  harnessId?: string;
  maxStartupAttempts?: number;
  startupTimeoutMs?: number;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  db?: unknown;
  stateStore?: unknown;
  toolRepo?: unknown;
  registry?: ToolRegistry;
  router?: GatewayRouter;
  secretManager?: SecretManager;
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
  credentialStore?: CloudCredentialStore;
}
export type ShimMode = "daemon_ipc" | "standalone_inprocess" | "failed";

export interface ShimStatus {
  mode: ShimMode;
  socketPath: string;
  daemonReachable: boolean;
  error?: string;
}

/**
 * Checks if the daemon IPC socket is active and accepting connections.
 */
export async function checkDaemonReachable(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  const { promise, resolve } = withResolvers<boolean>();

  try {
    const socket = net.createConnection(socketPath);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    }, timeoutMs);

    socket.once("connect", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.end();
        socket.destroy();
        resolve(true);
      }
    });

    socket.once("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      }
    });
  } catch {
    resolve(false);
  }

  return promise;
}

/**
 * Attempts a bounded daemon startup if the binary is present.
 */
export async function attemptDaemonStartup(socketPath: string, maxWaitMs = 3000): Promise<boolean> {
  try {
    // Attempt spawning daemon detached
    const child = spawn("resin-daemon", ["start"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Binary might not be on path or in test environment
  }

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const reachable = await checkDaemonReachable(socketPath, 300);
    if (reachable) return true;
    const { promise, resolve } = withResolvers<void>();
    setTimeout(resolve, 200);
    await promise;
  }

  return false;
}

/**
 * MCP Stdio Shim bridging stdio of AI coding harnesses (Claude Code, Codex, OMP)
 * to either the background Resin daemon or standalone in-process gateway.
 */
export class McpStdioShim {
  private readonly options: McpStdioShimOptions;
  private readonly socketPath: string;
  private readonly standaloneFallback: boolean;
  private readonly cwd: string;
  private readonly harnessId?: string;
  private readonly maxStartupAttempts: number;
  private readonly startupTimeoutMs: number;
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  private activeGateway?: LocalMcpGateway;
  private activeSocket?: net.Socket;
  private isRunning = false;

  constructor(options: McpStdioShimOptions = {}) {
    this.options = options;
    const defaultPaths = getDaemonPaths();
    this.socketPath = options.socketPath ?? defaultPaths.socketPath;
    this.standaloneFallback = options.standaloneFallback ?? true;
    this.cwd = options.cwd ?? process.cwd();
    this.harnessId = options.harnessId;
    this.maxStartupAttempts = options.maxStartupAttempts ?? 2;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 2000;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  /**
   * Starts the stdio shim.
   */
  async start(): Promise<ShimStatus> {
    if (this.isRunning) {
      throw new Error("Shim is already running");
    }
    // 1. Check if daemon is reachable
    let daemonReachable = this.socketPath
      ? await checkDaemonReachable(this.socketPath, 500)
      : false;

    // 2. If daemon not reachable, attempt bounded startup
    if (!daemonReachable && this.socketPath && this.maxStartupAttempts > 0) {
      daemonReachable = await attemptDaemonStartup(this.socketPath, this.startupTimeoutMs);
    }
    // 3. Connect to daemon or fallback to standalone in-process gateway
    if (daemonReachable) {
      try {
        await this.bridgeToDaemonSocket();
        return {
          mode: "daemon_ipc",
          socketPath: this.socketPath,
          daemonReachable: true,
        };
      } catch (err) {
        if (!this.standaloneFallback) {
          const errMsg = `Failed to bridge to daemon at ${this.socketPath}: ${(err as Error).message}`;
          this.writeStderr(`${errMsg}\n`);
          return {
            mode: "failed",
            socketPath: this.socketPath,
            daemonReachable: false,
            error: errMsg,
          };
        }
      }
    }

    // 4. Standalone fallback mode
    if (this.standaloneFallback) {
      await this.startStandaloneGateway();
      return {
        mode: "standalone_inprocess",
        socketPath: this.socketPath,
        daemonReachable: false,
      };
    }

    const actionMsg = `Resin Daemon is not running at '${this.socketPath}'.\nTo start the daemon, run: 'resin daemon start'\nOr launch MCP in standalone mode with: 'resin-mcp --standalone'\n`;
    this.writeStderr(actionMsg);

    return {
      mode: "failed",
      socketPath: this.socketPath,
      daemonReachable: false,
      error: "Daemon not running and standalone fallback disabled",
    };
  }

  private async bridgeToDaemonSocket(): Promise<void> {
    const { promise, resolve, reject } = withResolvers<void>();

    const socket = net.createConnection(this.socketPath);
    this.activeSocket = socket;

    socket.once("connect", () => {
      this.stdin.pipe(socket);
      socket.pipe(this.stdout);
      resolve();
    });

    socket.once("error", (err) => {
      reject(err);
    });

    socket.once("close", () => {
      this.stop();
    });

    return promise;
  }

  private async startStandaloneGateway(): Promise<void> {
    let router: GatewayRouter;
    let registry: ToolRegistry | undefined;

    if (this.options.router) {
      router = this.options.router;
      if (this.options.registry) {
        registry = this.options.registry;
      }
    } else if (this.options.registry) {
      registry = this.options.registry;
      router = createRegistryGatewayRouter(this.options.registry);
    } else {
      const db = this.options.db ?? this.options.stateStore ?? this.options.toolRepo;
      registry = new ToolRegistry({ db });
      const systemMetaTools = createSystemMetaTools(registry);
      for (const tool of systemMetaTools) {
        registry.registerToolSync(tool);
      }
      router = createRegistryGatewayRouter(registry);
    }

    if (registry) {
      try {
        await registry.hydrateFromStore();
      } catch {
        // Hydration failure is non-fatal
      }
    }

    let cloudRuntime: ProductionProxyRuntime | undefined;
    try {
      cloudRuntime = await createProductionProxyRuntime({
        registry,
        credentialStore: this.options.credentialStore,
        secretManager: this.options.secretManager,
        home: this.options.home,
        resinHome: this.options.resinHome,
        tokenFilePath: this.options.tokenFilePath,
      });

      if (cloudRuntime.isCloudEnabled && registry && cloudRuntime.router) {
        router = createRegistryGatewayRouter(registry, cloudRuntime.router);
      }
    } catch {
      cloudRuntime = undefined;
    }

    const gateway = new LocalMcpGateway({
      router,
      registry,
      cloudRuntime,
      serverInfo: {
        name: "resin-mcp-standalone",
        version: "0.1.0",
      },
    });

    this.activeGateway = gateway;
    await gateway.processStream(this.stdin, this.stdout, {
      cwd: this.cwd,
      harnessId: this.harnessId,
    });
  }

  private writeStderr(text: string): void {
    try {
      this.stderr.write(text);
    } catch {
      // Ignore errors writing to closed stderr
    }
  }

  /**
   * Stops the shim and releases resources.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.activeSocket) {
      this.activeSocket.destroy();
      this.activeSocket = undefined;
    }

    if (this.activeGateway) {
      this.activeGateway.close();
      this.activeGateway = undefined;
    }
  }
}
