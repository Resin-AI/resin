import path from "node:path";
import process from "node:process";
import type { IpcClient } from "@resin/observer";
import { describe, expect, it, vi } from "vitest";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  generateWslFallbackScript,
  validateServiceDefinition,
} from "../../src/platform/service-generator.js";
import {
  LaunchdUserServiceManager,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  SystemdUserServiceManager,
  WslUserServiceManager,
  createUserServiceManager,
} from "../../src/service/manager.js";
import { verifyDaemonReadiness } from "../../src/service/verification.js";

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
    async mkdirp(_dirPath: string): Promise<void> {
      // In-memory directory creation
    },
    async copyFile(srcPath: string, destPath: string): Promise<void> {
      const content = files.get(srcPath);
      if (content !== undefined) {
        files.set(destPath, content);
      }
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
  };
}

function createMockRunner(
  handlers: Record<string, (args: string[]) => ServiceCommandResult> = {},
): ServiceCommandRunner & { commands: { cmd: string; args: string[] }[] } {
  const commands: { cmd: string; args: string[] }[] = [];
  return {
    commands,
    async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
      commands.push({ cmd, args });
      const fullCmd = `${cmd} ${args.join(" ")}`;
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (fullCmd.includes(pattern) || cmd === pattern || args.includes(pattern)) {
          return handler(args);
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("Cross-Platform Service Lifecycle Suite", () => {
  describe("Service Generators & Syntax Validation", () => {
    it("generates and validates a complete Linux systemd user unit file", () => {
      const unitContent = generateSystemdUnit({
        serviceName: "resin-test",
        description: "Resin Unit Test Daemon",
        daemonPath: "/home/user/.resin/bin/daemon",
        nodePath: "/usr/bin/node",
        homeDir: "/home/user",
        resinHome: "/home/user/.resin",
        restartSec: 5,
        enableHardening: true,
        env: {
          RESIN_ENV: "staging",
        },
      });

      expect(unitContent).toContain("[Unit]");
      expect(unitContent).toContain("[Service]");
      expect(unitContent).toContain("[Install]");
      expect(unitContent).toContain("ExecStart=/usr/bin/node /home/user/.resin/bin/daemon");
      expect(unitContent).toContain("RestartSec=5");
      expect(unitContent).toContain("NoNewPrivileges=yes");
      expect(unitContent).toContain('Environment="RESIN_ENV=staging"');
      expect(unitContent).toContain("WantedBy=default.target");
      expect(unitContent).not.toContain("daemon.token");
      expect(unitContent).not.toContain("auth.token");
      expect(unitContent).not.toContain("RESIN_AUTH_TOKEN");

      const validation = validateServiceDefinition("systemd", unitContent);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("generates and validates a valid macOS launchd plist file", () => {
      const plistContent = generateLaunchdPlist({
        serviceName: "com.resin.daemon",
        daemonPath: "/Users/test/.resin/bin/daemon",
        nodePath: "/usr/local/bin/node",
        homeDir: "/Users/test",
        resinHome: "/Users/test/.resin",
        logDir: "/Users/test/Library/Logs/resin",
        env: {
          RESIN_STAGE: "release",
        },
      });

      expect(plistContent).toContain("<!DOCTYPE plist PUBLIC");
      expect(plistContent).toContain("<key>Label</key>");
      expect(plistContent).toContain("<string>com.resin.daemon</string>");
      expect(plistContent).toContain("<key>RunAtLoad</key>");
      expect(plistContent).toContain("<true/>");
      expect(plistContent).toContain("<key>StandardOutPath</key>");
      expect(plistContent).toContain("/Users/test/Library/Logs/resin/daemon.log");
      expect(plistContent).toContain("<key>RESIN_STAGE</key>");

      expect(plistContent).not.toContain("daemon.token");
      expect(plistContent).not.toContain("auth.token");
      expect(plistContent).not.toContain("RESIN_AUTH_TOKEN");
      const validation = validateServiceDefinition("launchd", plistContent);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("generates and validates a WSL supervisor fallback runner script", () => {
      const scriptContent = generateWslFallbackScript({
        daemonPath: "/home/wsluser/.resin/bin/daemon",
        nodePath: "/usr/bin/node",
        homeDir: "/home/wsluser",
        resinHome: "/home/wsluser/.resin",
        env: {
          WSL_ENV_VAR: "fallback",
        },
      });

      expect(scriptContent).toContain("#!/usr/bin/env bash");
      expect(scriptContent).toContain("start_daemon()");
      expect(scriptContent).toContain("stop_daemon()");
      expect(scriptContent).toContain("status_daemon()");
      expect(scriptContent).toContain('nohup "$NODE_PATH" "$DAEMON_PATH"');
      expect(scriptContent).toContain('export WSL_ENV_VAR="fallback"');

      expect(scriptContent).not.toContain("daemon.token");
      expect(scriptContent).not.toContain("auth.token");
      expect(scriptContent).not.toContain("RESIN_AUTH_TOKEN");
      const validation = validateServiceDefinition("wsl-fallback", scriptContent);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  describe("Linux systemd Service Manager Lifecycle", () => {
    it("performs full install, enable, start, status, stop, and uninstall cycle", async () => {
      const fsBridge = createMockFsBridge();
      const runner = createMockRunner({
        "systemctl --user is-active": () => ({ stdout: "active\n", stderr: "", exitCode: 0 }),
        "systemctl --user is-enabled": () => ({ stdout: "enabled\n", stderr: "", exitCode: 0 }),
        "systemctl --user status": () => ({
          stdout: "● resin.service\n   Main PID: 12345 (node)\n",
          stderr: "",
          exitCode: 0,
        }),
      });

      const manager = new SystemdUserServiceManager({
        homeDir: "/home/testuser",
        resinHome: "/home/testuser/.resin",
        fsBridge,
        runner,
      });

      // 1. Install
      const installRes = await manager.install();
      expect(installRes.success).toBe(true);
      expect(await fsBridge.exists(manager.getUnitPath())).toBe(true);

      // 2. Start
      await expect(manager.start()).resolves.toBeUndefined();

      // 3. Status
      const statusRes = await manager.status();
      expect(statusRes.installed).toBe(true);
      expect(statusRes.active).toBe(true);
      expect(statusRes.pid).toBe(12345);

      // 4. Restart
      await expect(manager.restart()).resolves.toBeUndefined();

      // 5. Stop
      await expect(manager.stop()).resolves.toBeUndefined();

      // 6. Uninstall
      const uninstallRes = await manager.uninstall();
      expect(uninstallRes.success).toBe(true);
      expect(await fsBridge.exists(manager.getUnitPath())).toBe(false);
    });
  });

  describe("macOS launchd Service Manager Lifecycle", () => {
    it("performs full launchd plist creation, load, status, unload, and cleanup", async () => {
      const fsBridge = createMockFsBridge();
      const runner = createMockRunner({
        "launchctl list com.resin.daemon": () => ({
          stdout: '{\n\t"PID" = 54321;\n\t"Label" = "com.resin.daemon";\n}',
          stderr: "",
          exitCode: 0,
        }),
      });

      const manager = new LaunchdUserServiceManager({
        homeDir: "/Users/testuser",
        resinHome: "/Users/testuser/.resin",
        fsBridge,
        runner,
      });

      // 1. Install
      const installRes = await manager.install();
      expect(installRes.success).toBe(true);
      expect(await fsBridge.exists(manager.getUnitPath())).toBe(true);

      // 2. Status
      const statusRes = await manager.status();
      expect(statusRes.installed).toBe(true);
      expect(statusRes.active).toBe(true);
      expect(statusRes.pid).toBe(54321);

      // 3. Stop / Unload
      await expect(manager.stop()).resolves.toBeUndefined();

      // 4. Uninstall
      const uninstallRes = await manager.uninstall();
      expect(uninstallRes.success).toBe(true);
      expect(await fsBridge.exists(manager.getUnitPath())).toBe(false);
    });
  });

  describe("WSL Service Manager & Supervisor Fallback Mode", () => {
    it("routes to systemd delegate when systemd is available", async () => {
      const fsBridge = createMockFsBridge();
      const runner = createMockRunner({
        "is-system-running": () => ({ stdout: "running", stderr: "", exitCode: 0 }),
        "is-active": () => ({ stdout: "active", stderr: "", exitCode: 0 }),
      });

      const manager = new WslUserServiceManager({
        homeDir: "/home/wsluser",
        resinHome: "/home/wsluser/.resin",
        fsBridge,
        runner,
      });

      expect(await manager.checkSystemdAvailable()).toBe(true);
      const installRes = await manager.install();
      expect(installRes.success).toBe(true);
      expect(await fsBridge.exists(installRes.unitPath)).toBe(true);
    });

    it("falls back to supervisor script mode when systemd is unavailable", async () => {
      const fsBridge = createMockFsBridge();
      const runner = createMockRunner({
        "is-system-running": () => ({
          stdout: "",
          stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.",
          exitCode: 1,
        }),
      });

      const manager = new WslUserServiceManager({
        homeDir: "/home/wsluser",
        resinHome: "/home/wsluser/.resin",
        fsBridge,
        runner,
      });

      expect(await manager.checkSystemdAvailable()).toBe(false);
      const installRes = await manager.install();
      expect(installRes.success).toBe(true);
      expect(await fsBridge.exists(manager.getFallbackScriptPath())).toBe(true);
    });
  });

  describe("Factory Resolver Integrity", () => {
    it("instantiates appropriate service manager based on platform detection", () => {
      const linuxManager = createUserServiceManager({
        homeDir: "/home/linux",
        platform: "linux",
      });
      expect(linuxManager.name).toBe("systemd");

      const macManager = createUserServiceManager({
        homeDir: "/Users/mac",
        platform: "darwin",
      });
      expect(macManager.name).toBe("launchd");

      const wslManager = createUserServiceManager({
        homeDir: "/home/wsl",
        platform: "wsl",
      });
      expect(wslManager.name).toBe("wsl");
    });
  });

  describe("Service Readiness and Verification Tokenless Behavior", () => {
    it("verifies daemon service readiness via direct local socket ping without requiring or supplying auth.token/daemon.token", async () => {
      const mockIpcClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        ping: vi.fn().mockResolvedValue({ pong: true, timestamp: Date.now() }),
        getHealth: vi.fn().mockResolvedValue({
          status: "healthy",
          modules: {},
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await verifyDaemonReadiness({
        homeDir: "/home/testuser",
        ipcClient: mockIpcClient as unknown as IpcClient,
        cloudRequired: false,
        timeoutMs: 1000,
      });
      expect(result.cloudReady).toBe(true);
      expect(mockIpcClient.connect).not.toHaveBeenCalled();
      expect(mockIpcClient.ping).toHaveBeenCalled();
    });

    it("verifies offline socket produces expected readiness failure without attempting token auth", async () => {
      const offlineIpcClient = {
        connect: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED /mock/socket")),
        ping: vi.fn().mockRejectedValue(new Error("not connected")),
        getHealth: vi.fn().mockRejectedValue(new Error("not connected")),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await verifyDaemonReadiness({
        homeDir: "/home/testuser",
        ipcClient: offlineIpcClient as unknown as IpcClient,
        cloudRequired: false,
        timeoutMs: 0,
      });

      expect(result.ready).toBe(false);
      expect(result.ipcReady).toBe(false);
      expect(result.error).toContain("not connected");
    });
  });
});
