import path from "node:path";
import type { IpcClient } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import { createUserServiceManager } from "../src/service/manager.js";
import {
  VerificationSuite,
  runVerificationSuite,
  verifyDaemonReadiness,
} from "../src/service/verification.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(_dirPath: string): Promise<void> {},
    async copyFile(src: string, dest: string): Promise<void> {
      const c = files.get(src);
      if (c !== undefined) files.set(dest, c);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async chmod(_filePath: string, _mode: number): Promise<void> {},
  };
}

interface MockIpcPingResult {
  pong: boolean;
  timestamp: number;
}

interface MockIpcHealthResult {
  status: string;
  modules?: Record<string, { status: string }>;
}
class MockIpcClient {
  constructor(
    private readonly overrides: {
      ping?: () => Promise<MockIpcPingResult>;
      getHealth?: () => Promise<MockIpcHealthResult>;
      close?: () => Promise<void>;
    } = {},
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    if (this.overrides.close) {
      await this.overrides.close();
    }
  }
  async ping(): Promise<MockIpcPingResult> {
    if (this.overrides.ping) {
      return await this.overrides.ping();
    }
    return { pong: true, timestamp: Date.now() };
  }
  async getHealth(): Promise<MockIpcHealthResult> {
    if (this.overrides.getHealth) {
      return await this.overrides.getHealth();
    }
    return {
      status: "healthy",
      modules: {
        "trajectory-capture": { status: "running" },
        "cloud-runtime": { status: "ready" },
      },
    };
  }
}

describe("VerificationSuite", () => {
  const homeDir = "/home/testuser";
  const resinHome = path.join(homeDir, ".resin");
  const stateDbPath = path.join(resinHome, "data", "state.db");
  const socketPath = path.join(resinHome, "run", "daemon.sock");
  const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");

  it("passes all checks when all local and cloud components are valid", async () => {
    const serviceManager = createUserServiceManager({
      platform: "systemd",
      homeDir,
      resinHome,
      runner: {
        async run(_cmd, args) {
          if (args.includes("is-active")) {
            return { stdout: "active\n", stderr: "", exitCode: 0 };
          }
          if (args.includes("is-enabled")) {
            return { stdout: "enabled\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "Main PID: 123\n", stderr: "", exitCode: 0 };
        },
      },
    });
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
      [path.join(resinHome, "config")]: "dir",
      [stateDbPath]: "sqlite header",
      [socketPath]: "socket",
      [unitPath]: serviceManager.getUnitDefinition(),
    });
    const mockIpcClient = new MockIpcClient({
      ping: vi.fn().mockResolvedValue({ pong: true, timestamp: Date.now() }),
      getHealth: vi.fn().mockResolvedValue({
        status: "fully-ready",
        uptimeSeconds: 120,
        startedAt: Date.now() - 120000,
        version: "0.1.0",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const mockFetch: typeof fetch = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));

    const suite = new VerificationSuite({
      homeDir,
      resinHome,
      socketPath,
      fsBridge,
      serviceManager,
      // SAFETY: Mock ipcClient implements IpcClient subset required for verification suite tests.
      ipcClient: mockIpcClient as IpcClient,
      customFetch: mockFetch,
      allowOffline: true,
    });
    const report = await suite.runAll();
    expect(report.passed).toBe(true);
    expect(report.failedChecks).toBe(0);
    expect(report.checks.length).toBe(9);

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).toContain("release_integrity");
    expect(checkNames).toContain("service_state");
    expect(checkNames).toContain("ipc_ping");
    expect(checkNames).toContain("database");
    expect(checkNames).toContain("gateway");
    expect(checkNames).toContain("meta_tools");
    expect(checkNames).toContain("worker_isolation");
    expect(checkNames).toContain("adapter_discovery");
    expect(checkNames).toContain("cloud_auth");
  });

  it("warns when daemon service unit definition is outdated or stale", async () => {
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
      [path.join(resinHome, "config")]: "dir",
      [stateDbPath]: "sqlite header",
      [socketPath]: "socket",
      // Simulate stale unit from prior v1.0.20
      [unitPath]: `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/versions/v1.0.20/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/daemon --foreground\n`,
    });
    const serviceManager = createUserServiceManager({
      platform: "systemd",
      homeDir,
      resinHome,
      fsBridge,
      runner: {
        async run(_cmd, args) {
          if (args.includes("is-active")) {
            return { stdout: "active\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "Main PID: 123\n", stderr: "", exitCode: 0 };
        },
      },
    });

    const suite = new VerificationSuite({
      homeDir,
      resinHome,
      socketPath,
      fsBridge,
      serviceManager,
      allowOffline: true,
    });

    const report = await suite.runAll();
    const serviceCheck = report.checks.find((c) => c.name === "service_state");
    expect(serviceCheck).toBeDefined();
    expect(serviceCheck?.status).toBe("warn");
    expect(serviceCheck?.message).toContain("outdated");
  });
  it("passes when unit definition has matching ExecStart despite differing PATH environment variable", async () => {
    const defaultManager = createUserServiceManager({
      platform: "systemd",
      homeDir,
      resinHome,
    });
    const canonicalUnit = defaultManager.getUnitDefinition();
    // Modify PATH in canonical unit to simulate user environment divergence
    const unitWithCustomPath = canonicalUnit.replace(
      /Environment="PATH=.*"/,
      'Environment="PATH=/custom/toolchain/bin:/usr/local/bin:/usr/bin:/bin"',
    );

    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
      [path.join(resinHome, "config")]: "dir",
      [stateDbPath]: "sqlite header",
      [socketPath]: "socket",
      [unitPath]: unitWithCustomPath,
    });

    const serviceManager = createUserServiceManager({
      platform: "systemd",
      homeDir,
      resinHome,
      fsBridge,
      runner: {
        async run(_cmd, args) {
          if (args.includes("is-active")) {
            return { stdout: "active\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "Main PID: 123\n", stderr: "", exitCode: 0 };
        },
      },
    });

    const suite = new VerificationSuite({
      homeDir,
      resinHome,
      socketPath,
      fsBridge,
      serviceManager,
      allowOffline: true,
    });

    const report = await suite.runAll();
    const serviceCheck = report.checks.find((c) => c.name === "service_state");
    expect(serviceCheck).toBeDefined();
    expect(serviceCheck?.status).toBe("pass");
  });
  it("reports warning/failure when daemon socket is offline", async () => {
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
    });

    const suite = new VerificationSuite({
      homeDir,
      resinHome,
      fsBridge,
      allowOffline: true,
      onlyChecks: ["ipc_ping", "release_integrity"],
    });

    const report = await suite.runAll();
    expect(report.totalChecks).toBe(2);

    const pingCheck = report.checks.find((c) => c.name === "ipc_ping");
    expect(pingCheck).toBeDefined();
    expect(pingCheck?.status).toBe("warn");
    expect(pingCheck?.message).toContain("IPC socket does not exist");
  });

  it("supports selective check execution via onlyChecks and skipChecks", async () => {
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
    });

    const report = await runVerificationSuite({
      homeDir,
      resinHome,
      fsBridge,
      allowOffline: true,
      skipChecks: ["cloud_auth", "adapter_discovery"],
    });

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).not.toContain("cloud_auth");
    expect(checkNames).not.toContain("adapter_discovery");
    expect(checkNames).toContain("meta_tools");
  });
});

describe("onboarding daemon readiness", () => {
  it("requires a responsive IPC ping and ready Cloud runtime", async () => {
    // SAFETY: Mock ipcClient implements IpcClient ping and getHealth methods for readiness verification tests.
    const ipcClient = new MockIpcClient({
      ping: vi.fn().mockResolvedValue({ pong: true, timestamp: Date.now() }),
      getHealth: vi.fn().mockResolvedValue({
        status: "fully-ready",
        modules: {
          "cloud-runtime": { status: "ready" },
        },
      }),
    }) as IpcClient;

    const result = await verifyDaemonReadiness({
      homeDir: "/home/test",
      ipcClient,
      cloudRequired: true,
      timeoutMs: 0,
    });

    expect(result).toMatchObject({
      ready: true,
      ipcReady: true,
      cloudReady: true,
      healthStatus: "fully-ready",
      attempts: 1,
    });
  });

  it("fails closed when Cloud is offline but permits explicit local-only readiness", async () => {
    // SAFETY: Mock ipcClient implements IpcClient ping and getHealth methods for offline readiness verification tests.
    const offlineIpcClient = new MockIpcClient({
      ping: vi.fn().mockResolvedValue({ pong: true, timestamp: Date.now() }),
      getHealth: vi.fn().mockResolvedValue({
        status: "cloud-offline",
        modules: {
          "cloud-runtime": { status: "offline" },
        },
      }),
    }) as IpcClient;
    const cloudResult = await verifyDaemonReadiness({
      homeDir: "/home/test",
      ipcClient: offlineIpcClient,
      cloudRequired: true,
      timeoutMs: 0,
    });
    expect(cloudResult).toMatchObject({
      ready: false,
      ipcReady: true,
      cloudReady: false,
      attempts: 1,
    });

    const localResult = await verifyDaemonReadiness({
      homeDir: "/home/test",
      ipcClient: offlineIpcClient,
      cloudRequired: false,
      timeoutMs: 0,
    });
    expect(localResult).toMatchObject({
      ready: true,
      ipcReady: true,
      cloudReady: true,
    });
  });
});
