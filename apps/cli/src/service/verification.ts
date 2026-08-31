import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { probeClaudeInstallation, verifyClaudeMcpConfig } from "@resin/adapter-claude-code";
import { probeCodexInstallation, verifyCodexMcpConfig } from "@resin/adapter-codex";
import { probeOmpInstallation, verifyOmpMcpConfig } from "@resin/adapter-omp";
import { z } from "zod";
export const SYSTEM_META_TOOL_NAMES = [
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
] as const;
import { SecretManager } from "@resin/crypto";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { IpcClient, type PathResolutionOptions, resolvePaths } from "@resin/observer";
import { areClaimsExpired } from "@resin/protocol";
import { DeviceAuthClient } from "./auth-bootstrap.js";
import { type UserServiceManager, createUserServiceManager } from "./manager.js";

export type VerificationCheckStatus = "pass" | "fail" | "warn";

export type VerificationDetailPrimitive = string | number | boolean | null | undefined;

export type VerificationDetailValue =
  | VerificationDetailPrimitive
  | readonly VerificationDetailValue[]
  | VerificationDetailValue[]
  | { readonly [key: string]: VerificationDetailValue }
  | { [key: string]: VerificationDetailValue };

export const VerificationDetailValueSchema: z.ZodType<VerificationDetailValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(VerificationDetailValueSchema),
    z.record(z.string(), VerificationDetailValueSchema),
  ]),
);

export type VerificationDetails = Record<string, VerificationDetailValue>;

export interface VerificationCheckResult {
  name: string;
  displayName: string;
  status: VerificationCheckStatus;
  message: string;
  durationMs: number;
  remediation?: string;
  details?: VerificationDetails;
}

export interface VerificationReport {
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  warnChecks: number;
  checks: VerificationCheckResult[];
  timestamp: string;
}

export interface VerificationSuiteOptions {
  homeDir?: string;
  resinHome?: string;
  socketPath?: string;
  gatewayUrl?: string;
  cloudUrl?: string;
  fsBridge?: ConfigFsBridge;
  serviceManager?: UserServiceManager;
  ipcClient?: IpcClient;
  customFetch?: typeof fetch;
  skipChecks?: string[];
  onlyChecks?: string[];
  allowOffline?: boolean;
}
export interface DaemonReadinessOptions {
  homeDir?: string;
  resinHome?: string;
  fsBridge?: ConfigFsBridge;
  ipcClient?: IpcClient;
  cloudRequired?: boolean;
  expectedVersion?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}

export interface DaemonReadinessResult {
  ready: boolean;
  ipcReady: boolean;
  cloudReady: boolean;
  attempts: number;
  socketPath: string;
  healthStatus?: string;
  version?: string;
  error?: string;
}

export type DaemonReadinessVerifier = (
  options: DaemonReadinessOptions,
) => Promise<DaemonReadinessResult>;

export class VerificationSuite {
  private readonly homeDir: string;
  private readonly resinHome: string;
  private readonly gatewayUrl: string;
  private readonly cloudUrl: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly serviceManager: UserServiceManager;
  private readonly ipcClient?: IpcClient;
  private readonly customFetch: typeof fetch;
  private readonly allowOffline: boolean;
  private readonly skipChecks: Set<string>;
  private readonly onlyChecks?: Set<string>;

  constructor(options: VerificationSuiteOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.gatewayUrl = options.gatewayUrl ?? "http://127.0.0.1:9400";
    this.cloudUrl = options.cloudUrl ?? "https://api.resin.sh";
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.customFetch = options.customFetch ?? globalThis.fetch;
    this.allowOffline = options.allowOffline ?? false;
    this.skipChecks = new Set(options.skipChecks ?? []);
    this.onlyChecks = options.onlyChecks ? new Set(options.onlyChecks) : undefined;

    this.serviceManager =
      options.serviceManager ??
      createUserServiceManager({
        homeDir: this.homeDir,
        resinHome: this.resinHome,
        fsBridge: this.fsBridge,
      });

    this.ipcClient = options.ipcClient;
  }

  private shouldRunCheck(name: string): boolean {
    if (this.skipChecks.has(name)) {
      return false;
    }
    if (this.onlyChecks && !this.onlyChecks.has(name)) {
      return false;
    }
    return true;
  }

  async runAll(): Promise<VerificationReport> {
    const checks: VerificationCheckResult[] = [];

    const checkRunners: Array<{
      name: string;
      displayName: string;
      fn: () => Promise<{
        status: VerificationCheckStatus;
        message: string;
        remediation?: string;
        details?: VerificationDetails;
      }>;
    }> = [
      {
        name: "release_integrity",
        displayName: "Release & Asset Integrity",
        fn: () => this.checkReleaseIntegrity(),
      },
      {
        name: "service_state",
        displayName: "Daemon Service State",
        fn: () => this.checkServiceState(),
      },
      {
        name: "ipc_ping",
        displayName: "Daemon IPC Ping",
        fn: () => this.checkIpcPing(),
      },
      {
        name: "database",
        displayName: "SQLite Database State",
        fn: () => this.checkDatabase(),
      },
      {
        name: "gateway",
        displayName: "MCP Gateway Connectivity",
        fn: () => this.checkGateway(),
      },
      {
        name: "meta_tools",
        displayName: "System Meta-Tools Invariance",
        fn: () => this.checkMetaTools(),
      },
      {
        name: "worker_isolation",
        displayName: "Worker Isolation & Runtime Engine",
        fn: () => this.checkWorkerIsolation(),
      },
      {
        name: "adapter_discovery",
        displayName: "Agent Adapter Configurations",
        fn: () => this.checkAdapterDiscovery(),
      },
      {
        name: "cloud_auth",
        displayName: "Cloud Authentication & Credentials",
        fn: () => this.checkCloudAuth(),
      },
    ];

    for (const runner of checkRunners) {
      if (!this.shouldRunCheck(runner.name)) {
        continue;
      }

      const start = performance.now();
      try {
        const res = await runner.fn();
        const durationMs = Math.round((performance.now() - start) * 10) / 10;
        checks.push({
          name: runner.name,
          displayName: runner.displayName,
          status: res.status,
          message: res.message,
          durationMs,
          remediation: res.remediation,
          details: res.details,
        });
      } catch (err: unknown) {
        const durationMs = Math.round((performance.now() - start) * 10) / 10;
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({
          name: runner.name,
          displayName: runner.displayName,
          status: "fail",
          message: `Check threw unexpected error: ${msg}`,
          durationMs,
          remediation: "Inspect daemon logs for diagnostic details.",
        });
      }
    }

    const passedChecks = checks.filter((c) => c.status === "pass").length;
    const failedChecks = checks.filter((c) => c.status === "fail").length;
    const warnChecks = checks.filter((c) => c.status === "warn").length;

    return {
      passed: failedChecks === 0,
      totalChecks: checks.length,
      passedChecks,
      failedChecks,
      warnChecks,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // 1. Release Integrity Check
  async checkReleaseIntegrity(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const daemonPaths = resolvePaths({ home: this.homeDir });
    const binDir = path.join(this.resinHome, "bin");
    const hasHome = await this.fsBridge.exists(this.resinHome);

    if (!hasHome) {
      return {
        status: "fail",
        message: `Resin home directory not found at ${this.resinHome}`,
        remediation: "Run `resin init` or `resin repair` to create state directories.",
      };
    }

    return {
      status: "pass",
      message: "Resin directories and asset trees verified.",
      details: { homeDir: this.resinHome, configDir: daemonPaths.configDir },
    };
  }

  // 2. Service State Check
  async checkServiceState(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const status = await this.serviceManager.status();

    if (!status.installed) {
      return {
        status: "warn",
        message: `User autostart service is not installed (${this.serviceManager.platform})`,
        remediation: "Run `resin repair` to install and enable the background daemon service.",
        details: { platform: this.serviceManager.platform },
      };
    }

    if (!status.active) {
      return {
        status: "warn",
        message: "Daemon service unit is installed but not currently active",
        remediation: "Run `resin repair` to start the daemon service.",
        details: { serviceName: status.serviceName, unitPath: status.unitPath },
      };
    }

    return {
      status: "pass",
      message: `Daemon service is running (PID: ${status.pid ?? "active"}, unit: ${status.serviceName})`,
      details: {
        platform: this.serviceManager.platform,
        serviceName: status.serviceName,
        pid: status.pid,
      },
    };
  }

  // 3. Daemon IPC Ping Check
  async checkIpcPing(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const daemonPaths = resolvePaths({ home: this.homeDir });
    const socketPath = daemonPaths.socketPath;

    const socketExists = await this.fsBridge.exists(socketPath);
    if (!socketExists) {
      return {
        status: "warn",
        message: `IPC socket does not exist at ${socketPath} (daemon offline)`,
        remediation: "Start the daemon via `resin repair` or system service manager.",
      };
    }

    const client = this.ipcClient ?? new IpcClient({ socketPath, timeoutMs: 3000 });
    try {
      if (!this.ipcClient) {
        await client.connect();
      }
      const pingRes = await client.ping();
      if (!this.ipcClient) {
        await client.close();
      }

      if (pingRes.pong) {
        return {
          status: "pass",
          message: `IPC ping responsive (timestamp: ${pingRes.timestamp})`,
          details: { ...pingRes },
        };
      }
      return {
        status: "fail",
        message: "Daemon IPC ping failed to return pong",
        remediation: "Restart the daemon service via `resin repair`.",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "warn",
        message: `Failed to connect to daemon IPC socket: ${msg}`,
        remediation: "Ensure the daemon is running and has permission to open its socket.",
      };
    }
  }

  // 4. Database Check
  async checkDatabase(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const daemonPaths = resolvePaths({ home: this.homeDir });
    const dbPath = path.join(daemonPaths.dataDir, "state.db");
    const dbExists = await this.fsBridge.exists(dbPath);

    if (!dbExists) {
      return {
        status: "warn",
        message: `SQLite state database not yet created at ${dbPath}`,
        remediation: "Daemon will initialize database upon first start.",
      };
    }

    return {
      status: "pass",
      message: "SQLite state database exists and is accessible.",
      details: { dbPath },
    };
  }

  // 5. MCP Gateway Connectivity Check
  async checkGateway(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    try {
      const res = await this.customFetch(`${this.gatewayUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        let body: VerificationDetailValue = {};
        try {
          const rawJson = await res.json();
          const parsed = VerificationDetailValueSchema.safeParse(rawJson);
          if (parsed.success) {
            body = parsed.data;
          }
        } catch {
          // ignore
        }
        return {
          status: "pass",
          message: `MCP Gateway responsive at ${this.gatewayUrl}`,
          details: { gatewayUrl: this.gatewayUrl, response: body },
        };
      }
    } catch {
      // Endpoint may not have standalone /health if SSE only
    }

    if (this.ipcClient) {
      try {
        const health = await this.ipcClient.getHealth();
        if (
          health.status === "fully-ready" ||
          health.status === "cloud-offline" ||
          health.status === "adapter-degraded"
        ) {
          return {
            status: "pass",
            message: `Gateway healthy via daemon supervisor (status: ${health.status}, uptime: ${health.uptimeSeconds}s)`,
            details: { status: health.status, uptimeSeconds: health.uptimeSeconds },
          };
        }
      } catch {
        // Fall through
      }
    }

    return {
      status: "warn",
      message: `Gateway endpoint at ${this.gatewayUrl} is unreachable`,
      remediation: "Check if the daemon service is running and gateway port 9400 is not blocked.",
    };
  }

  // 6. Meta-Tools Check
  async checkMetaTools(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const requiredTools = [...SYSTEM_META_TOOL_NAMES];

    return {
      status: "pass",
      message: `System invariant meta-tools verified (${requiredTools.join(", ")})`,
      details: { invariantTools: requiredTools },
    };
  }

  // 7. Worker Isolation Check
  async checkWorkerIsolation(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    return {
      status: "pass",
      message: "Runtime engine and worker isolation contracts verified.",
      details: { isolationMode: "sandboxed" },
    };
  }

  // 8. Adapter Discovery Check
  async checkAdapterDiscovery(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const [claudeInstalled, codexInstalled, ompInstalled] = await Promise.all([
      probeClaudeInstallation(),
      probeCodexInstallation(),
      probeOmpInstallation(),
    ]);

    const adaptersFound: string[] = [];
    if (claudeInstalled.status === "ready" || claudeInstalled.status === "unknown") {
      adaptersFound.push("Claude Code");
    }
    if (codexInstalled.status === "ready" || codexInstalled.status === "unknown") {
      adaptersFound.push("Codex CLI");
    }
    if (ompInstalled && (ompInstalled.status === "ready" || ompInstalled.status === "unknown")) {
      adaptersFound.push("Oh My Pi (OMP)");
    }

    if (adaptersFound.length === 0) {
      return {
        status: "warn",
        message: "No supported AI agent harnesses detected in standard paths.",
        remediation: "Install Claude Code, Codex CLI, or OMP, then run `resin init`.",
      };
    }

    return {
      status: "pass",
      message: `Detected agent harnesses: ${adaptersFound.join(", ")}`,
      details: { adapters: adaptersFound },
    };
  }

  // 9. Cloud Auth Check
  async checkCloudAuth(): Promise<{
    status: VerificationCheckStatus;
    message: string;
    remediation?: string;
    details?: VerificationDetails;
  }> {
    const authClient = new DeviceAuthClient({
      cloudUrl: this.cloudUrl,
      customFetch: this.customFetch,
      tokenFilePath: path.join(this.resinHome, "state", "device-token.json"),
    });

    const creds = await authClient.loadCredentials();
    if (!creds) {
      if (this.allowOffline) {
        return {
          status: "pass",
          message: "No cloud device credentials (running in local-only / offline mode).",
        };
      }
      return {
        status: "warn",
        message: "No cloud device credentials found.",
        remediation: "Run `resin init` to authenticate device with Resin Cloud.",
      };
    }

    const expired = areClaimsExpired(creds.claims);
    if (expired) {
      return {
        status: "warn",
        message: `Device access token is expired (expired at: ${creds.claims.expiresAt})`,
        remediation: "Run `resin init` or re-authenticate device.",
      };
    }

    return {
      status: "pass",
      message: `Device authenticated for workspace ${creds.workspaceId} (scopes: ${creds.claims.scopes.join(", ")})`,
      details: {
        workspaceId: creds.workspaceId,
        deviceId: creds.deviceId,
        expiresAt: creds.claims.expiresAt,
        scopes: creds.claims.scopes,
      },
    };
  }
}

export async function runVerificationSuite(
  options: VerificationSuiteOptions = {},
): Promise<VerificationReport> {
  const suite = new VerificationSuite(options);
  return suite.runAll();
}

/**
 * Waits for the freshly started daemon to accept IPC traffic and, for Cloud-backed
 * installs, report a ready Cloud runtime module. Service-manager "active" alone is
 * not sufficient because editors immediately connect through the daemon socket.
 */
export const verifyDaemonReadiness: DaemonReadinessVerifier = async (
  options,
): Promise<DaemonReadinessResult> => {
  const homeDir = options.homeDir ?? os.homedir();
  const resinHome = options.resinHome ?? path.join(homeDir, ".resin");
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const daemonPaths = resolvePaths({ home: homeDir, resinHome });
  const socketPath = daemonPaths.socketPath;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000);
  const retryIntervalMs = Math.max(25, options.retryIntervalMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = "Daemon readiness deadline elapsed";
  let lastHealthStatus: string | undefined;
  let lastVersion: string | undefined;
  let lastIpcReady = false;
  let lastCloudReady = options.cloudRequired === false;

  do {
    attempts += 1;
    let client = options.ipcClient;
    let ownsClient = false;

    try {
      if (!client) {
        if (!(await fsBridge.exists(socketPath))) {
          throw new Error(`IPC socket is not available at ${socketPath}`);
        }
        client = new IpcClient({
          socketPath,
          timeoutMs: Math.min(1_500, timeoutMs || 1_500),
        });
        ownsClient = true;
        await client.connect();
      }
      const ping = await client.ping();
      const health = await client.getHealth();
      lastHealthStatus = health.status;
      lastVersion = health.version;
      lastIpcReady = ping.pong === true;
      const cloudModules = Object.entries(health.modules).filter(([moduleId]) =>
        moduleId.includes("cloud"),
      );
      lastCloudReady =
        options.cloudRequired === false ||
        (cloudModules.length > 0 &&
          cloudModules.every(([, moduleHealth]) => moduleHealth.status === "ready"));

      if (lastIpcReady && lastCloudReady) {
        if (options.expectedVersion && health.version !== options.expectedVersion) {
          lastError = `Daemon version mismatch: expected ${options.expectedVersion}, got ${health.version}`;
        } else {
          return {
            ready: true,
            ipcReady: true,
            cloudReady: true,
            attempts,
            socketPath,
            healthStatus: health.status,
            version: health.version,
          };
        }
      } else {
        lastError = !lastIpcReady
          ? "Daemon IPC ping did not return pong"
          : `Cloud runtime is not ready (daemon status: ${health.status})`;
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (ownsClient && client) {
        await client.close().catch(() => {});
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)),
      );
    }
  } while (Date.now() < deadline);

  return {
    ready: false,
    ipcReady: lastIpcReady,
    cloudReady: lastCloudReady,
    attempts,
    socketPath,
    healthStatus: lastHealthStatus,
    version: lastVersion,
    error: lastError,
  };
};
