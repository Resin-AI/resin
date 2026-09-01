import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { FrameDecoder, encodeFrame, resolvePaths } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import {
  doctorCommand,
  formatDoctorForTerminal,
  parseDoctorFlags,
  repairCommand,
  repairState,
  runDiagnostics,
} from "../src/commands/doctor.js";
import type { UserServiceManager } from "../src/service/manager.js";

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
    async mkdirp(dirPath: string): Promise<void> {
      files.set(dirPath, "dir");
    },
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

function createMockServiceManager(customUnitPath?: string): UserServiceManager {
  const unitPath = customUnitPath ?? "/mock/resin.service";
  return {
    name: "mock",
    platform: "systemd",
    install: vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      unitContent: "",
      serviceName: "resin.service",
      enabled: true,
      started: false,
    }),
    uninstall: vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      stopped: true,
      disabled: true,
      removed: true,
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({
      installed: false,
      active: false,
      enabled: false,
      serviceName: "resin.service",
      unitPath,
      state: "not_installed",
    }),
    isInstalled: vi.fn().mockResolvedValue(false),
    getUnitDefinition: vi.fn().mockReturnValue(""),
    getUnitPath: vi.fn().mockReturnValue(unitPath),
  };
}

describe("doctor & repair commands", () => {
  const homeDir = "/home/testuser";
  const resinHome = path.join(homeDir, ".resin");
  const daemonPaths = resolvePaths({ home: homeDir });
  const lockFilePath = daemonPaths.lockFilePath;

  it("parses doctor and repair flags", () => {
    const flags1 = parseDoctorFlags(["--fix", "--strict", "--json"]);
    expect(flags1.fix).toBe(true);
    expect(flags1.strict).toBe(true);
    expect(flags1.json).toBe(true);

    const flags2 = parseDoctorFlags(["--home", "/custom/path", "-h"]);
    expect(flags2.home).toBe("/custom/path");
    expect(flags2.help).toBe(true);
  });

  it("diagnoses missing directories and stale lockfiles", async () => {
    const fsBridge = createMockFsBridge({
      [lockFilePath]: "12345", // stale lockfile while daemon is inactive
    });

    const items = await runDiagnostics({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
    });

    const dirItem = items.find((i) => i.id === "fs_directories");
    expect(dirItem).toBeDefined();
    expect(dirItem?.status).toBe("fail");
    expect(dirItem?.fixable).toBe(true);

    const lockItem = items.find((i) => i.id === "stale_lockfile");
    expect(lockItem).toBeDefined();
    expect(lockItem?.status).toBe("warn");
    expect(lockItem?.fixable).toBe(true);
  });

  it("diagnoses responsive IPC socket through local socket without requiring auth token", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "resin-doctor-home-"));
    const paths = resolvePaths({ home: tempHome });
    await fs.mkdir(paths.stateDir, { recursive: true });

    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk)) {
          const req = message as { id?: string; method?: string; params?: { nonce?: string } };
          if (req.method === "ping") {
            socket.write(
              encodeFrame({
                id: req.id,
                result: {
                  pong: true,
                  nonce: req.params?.nonce ?? "test-nonce",
                  timestamp: Date.now(),
                },
              }),
            );
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(paths.socketPath, resolve));

    try {
      const items = await runDiagnostics({
        home: tempHome,
        fsBridge: createMockFsBridge({
          [paths.socketPath]: "socket",
        }),
        serviceManager: createMockServiceManager(),
      });

      const ipcItem = items.find((i) => i.id === "ipc_ping");
      expect(ipcItem).toBeDefined();
      expect(ipcItem?.status).toBe("pass");
      expect(ipcItem?.message).toContain("Daemon responded to IPC ping");
      expect(ipcItem?.fixable).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("repairs state by creating directories and removing stale lockfile", async () => {
    const fsBridge = createMockFsBridge({
      [lockFilePath]: "12345",
    });

    const actions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(actions.some((a) => a.includes("Created directory"))).toBe(true);
    expect(actions.some((a) => a.includes("Removed stale lockfile"))).toBe(true);

    // Verify lockfile was removed from fsBridge
    expect(await fsBridge.exists(lockFilePath)).toBe(false);

    // Verify directories were created
    expect(await fsBridge.exists(resinHome)).toBe(true);

    // Confirm no legacy IPC token files were created or expected
    expect(await fsBridge.readFile(path.join(resinHome, "daemon.token"))).toBeNull();
    expect(await fsBridge.readFile(path.join(resinHome, "auth.token"))).toBeNull();
    expect(await fsBridge.readFile(path.join(daemonPaths.stateDir, "daemon.token"))).toBeNull();
  });

  it("safely cleans only stale IPC files without removing device-token.json or credentials", async () => {
    const deviceTokenContent = JSON.stringify({
      token: "cloud-device-cred-123",
      deviceId: "dev-abc",
    });
    const fsBridge = createMockFsBridge({
      [path.join(resinHome, "auth.token")]: "stale-ipc-auth",
      [path.join(resinHome, "daemon.token")]: "stale-ipc-daemon",
      [path.join(daemonPaths.stateDir, "auth.token")]: "stale-ipc-state-auth",
      [path.join(daemonPaths.stateDir, "daemon.token")]: "stale-ipc-state-daemon",
      [path.join(daemonPaths.configDir, "auth.token")]: "stale-ipc-config-auth",
      [path.join(daemonPaths.configDir, "daemon.token")]: "stale-ipc-config-daemon",
      [path.join(daemonPaths.stateDir, "device-token.json")]: deviceTokenContent,
    });

    const actions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(actions.some((a) => a.includes("Removed stale IPC token"))).toBe(true);

    // Stale tokens removed
    expect(await fsBridge.exists(path.join(resinHome, "auth.token"))).toBe(false);
    expect(await fsBridge.exists(path.join(resinHome, "daemon.token"))).toBe(false);
    expect(await fsBridge.exists(path.join(daemonPaths.stateDir, "auth.token"))).toBe(false);
    expect(await fsBridge.exists(path.join(daemonPaths.stateDir, "daemon.token"))).toBe(false);
    expect(await fsBridge.exists(path.join(daemonPaths.configDir, "auth.token"))).toBe(false);
    expect(await fsBridge.exists(path.join(daemonPaths.configDir, "daemon.token"))).toBe(false);

    // device-token.json strictly preserved!
    expect(await fsBridge.exists(path.join(daemonPaths.stateDir, "device-token.json"))).toBe(true);
    expect(await fsBridge.readFile(path.join(daemonPaths.stateDir, "device-token.json"))).toBe(
      deviceTokenContent,
    );
  });

  it("heals missing and invalid telemetryEnabled to true while preserving explicit false", async () => {
    // 1. Missing telemetryEnabled in config.json
    const missingBridge = createMockFsBridge({
      [daemonPaths.configFile]: JSON.stringify({ version: "0.1.0", logLevel: "info" }),
    });
    await repairState({
      home: homeDir,
      fsBridge: missingBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });
    const missingParsed = JSON.parse(
      (await missingBridge.readFile(daemonPaths.configFile)) ?? "{}",
    );
    expect(missingParsed.telemetryEnabled).toBe(true);

    // 2. Invalid telemetryEnabled in config.json
    const invalidBridge = createMockFsBridge({
      [daemonPaths.configFile]: JSON.stringify({
        version: "0.1.0",
        telemetryEnabled: "invalid-value",
      }),
    });
    await repairState({
      home: homeDir,
      fsBridge: invalidBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });
    const invalidParsed = JSON.parse(
      (await invalidBridge.readFile(daemonPaths.configFile)) ?? "{}",
    );
    expect(invalidParsed.telemetryEnabled).toBe(true);

    // 3. Explicit false preserved
    const explicitFalseBridge = createMockFsBridge({
      [daemonPaths.configFile]: JSON.stringify({ version: "0.1.0", telemetryEnabled: false }),
    });
    await repairState({
      home: homeDir,
      fsBridge: explicitFalseBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });
    const explicitFalseParsed = JSON.parse(
      (await explicitFalseBridge.readFile(daemonPaths.configFile)) ?? "{}",
    );
    expect(explicitFalseParsed.telemetryEnabled).toBe(false);
  });

  it("repairs and converges legacy localhost SSE entries to canonical stdio", async () => {
    const ompConfigPath = path.join(homeDir, ".omp", "agent", "mcp.json");
    const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
    const claudeConfigPath = path.join(homeDir, ".claude", "claude.json");
    const fsBridge = createMockFsBridge({
      [ompConfigPath]: JSON.stringify({
        mcpServers: {
          resin: { type: "sse", url: "http://localhost:9400/mcp/sse" },
          custom: { command: "custom-cmd" },
        },
      }),
      [codexConfigPath]: [
        "[mcp_servers.resin]",
        'url = "http://127.0.0.1:9400/mcp/sse"',
        "",
        "[mcp_servers.other]",
        'command = "other-tool"',
      ].join("\n"),
      [claudeConfigPath]: JSON.stringify({
        mcpServers: {
          resin: { type: "sse", url: "http://localhost:9400/mcp/sse" },
          other: { command: "other-tool" },
        },
      }),
    });

    await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: createMockServiceManager(),
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    const omp = JSON.parse((await fsBridge.readFile(ompConfigPath)) ?? "{}");
    expect(omp.mcpServers.resin).toEqual({ command: "resin", args: ["mcp"] });
    expect(omp.mcpServers.custom).toEqual({ command: "custom-cmd" });

    const codex = await fsBridge.readFile(codexConfigPath);
    expect(codex).toContain("[mcp_servers.resin]");
    expect(codex).toContain('command = "resin"');
    expect(codex).toContain('args = ["mcp"]');
    expect(codex).not.toContain("9400/mcp/sse");
    expect(codex).toContain("[mcp_servers.other]");

    const claude = JSON.parse((await fsBridge.readFile(claudeConfigPath)) ?? "{}");
    expect(claude.mcpServers.resin).toEqual({ command: "resin", args: ["mcp"] });
    expect(claude.mcpServers.other).toEqual({ command: "other-tool" });
  });

  it("formats terminal doctor report with proper icons and summary", () => {
    const report = {
      passed: true,
      healthy: true,
      totalChecks: 3,
      passedCount: 3,
      warnCount: 0,
      failCount: 0,
      fixedCount: 1,
      items: [
        {
          id: "platform_supported",
          name: "Supported Operating System",
          category: "platform" as const,
          status: "pass" as const,
          message: "linux (arm64) on Node v22.0.0",
          fixable: false,
        },
      ],
      actionsTaken: ["Created directory: /home/testuser/.resin"],
      timestamp: new Date().toISOString(),
    };

    const formatted = formatDoctorForTerminal(report);
    expect(formatted).toContain("RESIN DOCTOR REPORT");
    expect(formatted).toContain("[✓] Supported Operating System");
    expect(formatted).toContain("[Remediations Applied]");
    expect(formatted).toContain("Overall Health: HEALTHY");
  });

  it("keeps repair successful when notification persistence is unavailable", async () => {
    const fsBridge = createMockFsBridge();
    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await repairCommand(["--json", "--home", homeDir], {
        fsBridge,
        serviceManager: createMockServiceManager(),
        notificationConsumer: vi.fn().mockRejectedValue(new Error("inbox unavailable")),
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      });

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutChunks.join(""));
      expect(output.passed).toBe(true);
      expect(output.fixedCount).toBeGreaterThan(0);
      expect(output.notifications).toEqual([]);
    } finally {
      process.stdout.write = originalStdout;
    }
  });
  it("detects and repairs stale v1.0.20 unit definition to current valid command and remains idempotent", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const staleUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/versions/v1.0.20/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;
    const targetUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;

    const fsBridge = createMockFsBridge({
      [unitPath]: staleUnitContent,
      [path.join(resinHome, "current", "apps", "cli", "dist", "index.js")]: "launcher",
    });

    const mockServiceManager = createMockServiceManager(unitPath);
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);

    // 1. Diagnostics detect stale unit
    const diagnostics = await runDiagnostics({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
    });
    const svcDiag = diagnostics.find((d) => d.id === "service_installed");
    expect(svcDiag).toBeDefined();
    expect(svcDiag?.status).toBe("warn");
    expect(svcDiag?.fixable).toBe(true);
    expect(svcDiag?.message).toContain("outdated");

    // 2. Repair rewrites the unit file and restarts the active service
    const actions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(mockServiceManager.install).toHaveBeenCalled();
    expect(mockServiceManager.restart).toHaveBeenCalled();
    expect(actions.some((a) => a.includes("Repaired outdated daemon user service"))).toBe(true);

    // Simulate install rewriting the file
    await fsBridge.writeFile(unitPath, targetUnitContent);

    // 3. Subsequent diagnosis on updated unit is healthy (pass)
    const postRepairDiag = await runDiagnostics({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
    });
    const postSvcDiag = postRepairDiag.find((d) => d.id === "service_installed");
    expect(postSvcDiag?.status).toBe("pass");
    expect(postSvcDiag?.message).toContain("active");

    // 4. Subsequent repair is completely idempotent (no restart, no rewrite)
    vi.clearAllMocks();
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);

    const idempotentActions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(mockServiceManager.install).not.toHaveBeenCalled();
    expect(mockServiceManager.restart).not.toHaveBeenCalled();
    expect(idempotentActions.some((a) => a.includes("daemon user service"))).toBe(false);
  });
  it("handles install failure truthfully during stale unit repair without claiming false success", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const staleUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/versions/v1.0.20/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;
    const targetUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;

    const fsBridge = createMockFsBridge({
      [unitPath]: staleUnitContent,
    });

    const mockServiceManager = createMockServiceManager(unitPath);
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);
    mockServiceManager.install = vi.fn().mockResolvedValue({
      success: false,
      unitPath,
      unitContent: "",
      serviceName: "resin.service",
      enabled: false,
      started: false,
      error: "permission denied writing unit file",
    });
    await expect(
      repairState({
        home: homeDir,
        fsBridge,
        serviceManager: mockServiceManager,
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      }),
    ).rejects.toThrow(/Failed to repair daemon user service/);

    expect(mockServiceManager.install).toHaveBeenCalled();
    expect(mockServiceManager.restart).not.toHaveBeenCalled();
  });

  it("handles restart failure truthfully during stale unit repair without claiming false success", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const staleUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/versions/v1.0.20/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;
    const targetUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;

    const fsBridge = createMockFsBridge({
      [unitPath]: staleUnitContent,
    });

    const mockServiceManager = createMockServiceManager(unitPath);
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);
    mockServiceManager.install = vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      unitContent: targetUnitContent,
      serviceName: "resin.service",
      enabled: true,
      started: false,
    });
    mockServiceManager.restart = vi.fn().mockRejectedValue(new Error("systemctl restart timed out"));

    await expect(
      repairState({
        home: homeDir,
        fsBridge,
        serviceManager: mockServiceManager,
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      }),
    ).rejects.toThrow(/Failed to restart daemon user service/);

    expect(mockServiceManager.install).toHaveBeenCalled();
    expect(mockServiceManager.restart).toHaveBeenCalled();
  });

  it("command-level doctor --fix returns non-zero and reports passed: false when stale unit restart fails", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const staleUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/versions/v1.0.20/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;
    const targetUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\n`;

    const fsBridge = createMockFsBridge({
      [unitPath]: staleUnitContent,
    });

    const mockServiceManager = createMockServiceManager(unitPath);
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);
    mockServiceManager.install = vi.fn().mockResolvedValue({
      success: true,
      unitPath,
      unitContent: targetUnitContent,
      serviceName: "resin.service",
      enabled: true,
      started: false,
    });
    mockServiceManager.restart = vi.fn().mockRejectedValue(new Error("systemctl restart timed out"));

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await doctorCommand(["--fix", "--json", "--home", homeDir], {
        fsBridge,
        serviceManager: mockServiceManager,
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      });

      expect(exitCode).toBe(1);
      const output = JSON.parse(stdoutChunks.join(""));
      expect(output.passed).toBe(false);
      expect(output.error).toContain("Failed to restart daemon user service");
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("treats unit with matching ExecStart and differing PATH as healthy and idempotent", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const targetUnitContent = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\nEnvironment="PATH=/usr/bin:/bin"\n`;
    const unitWithCustomPath = `[Unit]\nDescription=Resin Daemon\nExecStart=/usr/bin/node ${resinHome}/current/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- /bin/resin-daemon --foreground\nEnvironment="PATH=/custom/bin:/usr/bin:/bin"\n`;

    const fsBridge = createMockFsBridge({
      [unitPath]: unitWithCustomPath,
    });

    const mockServiceManager = createMockServiceManager(unitPath);
    mockServiceManager.status = vi.fn().mockResolvedValue({
      installed: true,
      active: true,
      enabled: true,
      serviceName: "resin.service",
      unitPath,
      pid: 1234,
      state: "active",
    });
    mockServiceManager.getUnitDefinition = vi.fn().mockReturnValue(targetUnitContent);

    const diagnostics = await runDiagnostics({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
    });
    const svcDiag = diagnostics.find((d) => d.id === "service_installed");
    expect(svcDiag?.status).toBe("pass");

    const actions = await repairState({
      home: homeDir,
      fsBridge,
      serviceManager: mockServiceManager,
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });
    expect(mockServiceManager.install).not.toHaveBeenCalled();
    expect(mockServiceManager.restart).not.toHaveBeenCalled();
    expect(actions.some((a) => a.includes("daemon user service"))).toBe(false);
  });
});
