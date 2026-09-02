import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ServiceCommandResult,
  type ServiceCommandRunner,
  createUserServiceManager,
  healthCheckDaemonService,
  restartDaemonService,
  setupAndStartDaemonService,
  stopDaemonService,
  uninstallDaemonService,
} from "../../src/installer/user-service.js";
import {
  LaunchdUserServiceManager,
  SystemdUserServiceManager,
  WslUserServiceManager,
} from "../../src/service/manager.js";

/**
 * Mock Service Command Runner that records executed commands and returns configured responses.
 */
class MockServiceCommandRunner implements ServiceCommandRunner {
  readonly commands: Array<{ cmd: string; args: string[] }> = [];
  statusOutput = "active (running)";
  statusExitCode = 0;
  statusPid = 4242;

  async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
    this.commands.push({ cmd, args });

    const cmdStr = `${cmd} ${args.join(" ")}`;

    // Systemctl is-active
    if (args.includes("is-active")) {
      return {
        stdout: this.statusExitCode === 0 ? "active\n" : "inactive\n",
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Systemctl is-enabled
    if (args.includes("is-enabled")) {
      return {
        stdout: "enabled\n",
        stderr: "",
        exitCode: 0,
      };
    }

    // Systemctl status
    if (args.includes("status")) {
      return {
        stdout: `● resin.service - Resin Background Daemon\n   Loaded: loaded\n   Active: ${this.statusOutput}\n   Main PID: ${this.statusPid}\n`,
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Systemctl show PID
    if (cmdStr.includes("show") && cmdStr.includes("MainPID")) {
      return {
        stdout: `MainPID=${this.statusPid}\nActiveState=active\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // Launchctl print mock
    if (cmdStr.includes("launchctl print")) {
      return {
        stdout: `state = running\npid = ${this.statusPid}\n`,
        stderr: "",
        exitCode: this.statusExitCode,
      };
    }

    // Default success for start, stop, daemon-reload, bootstrap, bootout
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    };
  }
}

describe("user-service-manager: Non-root user-level service supervisors", () => {
  let tempDir: string;
  let fakeHome: string;
  let resinHome: string;
  let mockRunner: MockServiceCommandRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-service-test-"));
    fakeHome = path.join(tempDir, "home");
    resinHome = path.join(fakeHome, ".resin");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(resinHome, { recursive: true });
    mockRunner = new MockServiceCommandRunner();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("SystemdUserServiceManager", () => {
    it("generates user-level systemd unit file in ~/.config/systemd/user/ without root", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("systemd");
      const unitPath = manager.getUnitPath();
      expect(unitPath).toBe(path.join(fakeHome, ".config", "systemd", "user", "resin.service"));

      const unitDef = manager.getUnitDefinition();
      expect(unitDef).toContain("[Unit]");
      expect(unitDef).toContain("Description=Resin Daemon");
      expect(unitDef).toContain("[Service]");
      expect(unitDef).toContain("ExecStart=");
      expect(unitDef).toContain(`Environment=RESIN_HOME=${resinHome}`);
      expect(unitDef).toContain("Restart=on-failure");
      expect(unitDef).toContain("[Install]");
      expect(unitDef).toContain("WantedBy=default.target");
    });

    it("installs, starts, and queries status through systemctl --user", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      // Install
      const installResult = await manager.install({
        daemonPath: path.join(resinHome, "bin", "resin-daemon"),
      });

      expect(installResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(true);

      // Verify systemctl --user commands were executed
      const daemonReloadCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("daemon-reload"),
      );
      expect(daemonReloadCmd).toBeDefined();

      // Start
      await manager.start();
      const startCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("start"),
      );
      expect(startCmd).toBeDefined();

      // Status
      const status = await manager.status();
      expect(status.installed).toBe(true);
      expect(status.active).toBe(true);

      // Stop
      await manager.stop();
      const stopCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("stop"),
      );
      expect(stopCmd).toBeDefined();

      // Uninstall
      const uninstallResult = await manager.uninstall();
      expect(uninstallResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(false);
    });
    it("supports enable and disable methods on SystemdUserServiceManager", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      await manager.enable();
      const lastEnable = mockRunner.commands.at(-1);
      expect(lastEnable?.args).toEqual(["--user", "enable", "resin.service"]);

      await manager.disable();
      const lastDisable = mockRunner.commands.at(-1);
      expect(lastDisable?.args).toEqual(["--user", "disable", "resin.service"]);
    });

    it("rejects supervisor commands with default runner when home is not login user home", async () => {
      const manager = new SystemdUserServiceManager({
        homeDir: "/non/matching/custom/home/path",
        resinHome: "/non/matching/custom/home/path/.resin",
      });

      await expect(manager.start()).rejects.toThrow(
        /Cannot issue login-session supervisor commands/,
      );
      await expect(manager.stop()).rejects.toThrow(
        /Cannot issue login-session supervisor commands/,
      );
      await expect(manager.enable()).rejects.toThrow(
        /Cannot issue login-session supervisor commands/,
      );
      await expect(manager.disable()).rejects.toThrow(
        /Cannot issue login-session supervisor commands/,
      );
    });
  });

  describe("LaunchdUserServiceManager", () => {
    it("generates user-level launchd plist in ~/Library/LaunchAgents/ without root", async () => {
      const manager = new LaunchdUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("launchd");
      const plistPath = manager.getUnitPath();
      expect(plistPath).toBe(
        path.join(fakeHome, "Library", "LaunchAgents", "com.resin.daemon.plist"),
      );

      const plistContent = manager.getUnitDefinition();
      expect(plistContent).toContain("<key>Label</key>");
      expect(plistContent).toContain("<string>com.resin.daemon</string>");
      expect(plistContent).toContain("<key>ProgramArguments</key>");
      expect(plistContent).toContain("<key>KeepAlive</key>");
      expect(plistContent).toContain("<key>StandardOutPath</key>");
      expect(plistContent).toContain("<key>StandardErrorPath</key>");
    });

    it("installs, starts, and manages launchd service", async () => {
      const manager = new LaunchdUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      const installResult = await manager.install({
        daemonPath: path.join(resinHome, "bin", "resin-daemon"),
      });

      expect(installResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(true);

      // Start
      await manager.start();

      // Status
      const status = await manager.status();
      expect(status.installed).toBe(true);
      expect(status.active).toBe(true);

      // Uninstall
      const uninstallResult = await manager.uninstall();
      expect(uninstallResult.success).toBe(true);
      expect(fs.existsSync(installResult.unitPath)).toBe(false);
    });
  });

  describe("WslUserServiceManager", () => {
    it("configures WSL supervisor service correctly", async () => {
      const manager = new WslUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      expect(manager.name).toBe("wsl");
      const unitPath = manager.getUnitPath();
      expect(unitPath).toBeDefined();

      const unitDef = manager.getUnitDefinition();
      expect(unitDef).toBeDefined();
    });
  });

  describe("setupAndStartDaemonService & healthCheckDaemonService orchestration", () => {
    it("orchestrates user service installation and health verification end-to-end", async () => {
      const setupResult = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });

      expect(setupResult.success).toBe(true);
      expect(setupResult.installed).toBe(true);
      expect(setupResult.started).toBe(true);
      expect(setupResult.healthy).toBe(true);
      expect(setupResult.serviceType).toBeDefined();

      // Perform separate health check
      const health = await healthCheckDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      expect(health.healthy).toBe(true);
      expect(health.running).toBe(true);

      // Stop service
      await stopDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      // Restart service
      await restartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      // Uninstall service
      const uninstalled = await uninstallDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      expect(uninstalled.success).toBe(true);
    });
    it("restores prior non-installed state on startup or installation failure", async () => {
      // A runner that fails on start
      const failingRunner: ServiceCommandRunner = {
        run: async (cmd, args) => {
          if (args.includes("start")) {
            return { stdout: "", stderr: "Failed to start service unit", exitCode: 1 };
          }
          if (args.includes("status")) {
            return { stdout: "Active: inactive (dead)", stderr: "", exitCode: 3 };
          }
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      };

      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: failingRunner,
        autoStart: true,
      });

      expect(result.success).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.error).toBeDefined();

      // Service unit file should have been cleaned up / uninstalled by rollback
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: failingRunner,
      });
      const isInstalled = await manager.isInstalled();
      expect(isInstalled).toBe(false);
    });

    it("restores prior unit file and state when updating an existing service fails", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      // Pre-install a previous service version
      await manager.isInstalled();
      const unitPath = manager.getUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      const priorContent = "# Prior version of resin service\nDescription=Old Resin Daemon\n";
      fs.writeFileSync(unitPath, priorContent);

      let restartAttempts = 0;
      let startAttempts = 0;
      const recordedCommands: Array<{ cmd: string; args: string[] }> = [];

      // Deterministic state machine:
      // 1. Prior state: active (running), PID 4242.
      // 2. Updated unit installation occurs (daemon-reload / enable / start).
      // 3. Post-update restart attempt fails -> triggers rollback.
      // 4. Rollback restores prior unit file and starts/restarts prior service.
      // 5. Final state: active (running), PID 4242.
      let state: "prior_active" | "updating" | "update_failed" | "rolled_back_active" =
        "prior_active";
      const failingUpdateRunner: ServiceCommandRunner = {
        run: async (cmd, args) => {
          recordedCommands.push({ cmd, args });

          if (args.includes("daemon-reload") || args.includes("enable")) {
            if (state === "prior_active") {
              state = "updating";
            }
          }

          if (args.includes("restart")) {
            restartAttempts++;
            state = "update_failed";
            return { stdout: "", stderr: "Update restart failed", exitCode: 1 };
          }

          if (args.includes("start")) {
            startAttempts++;
            if (state === "update_failed") {
              state = "rolled_back_active";
            }
            return { stdout: "ok", stderr: "", exitCode: 0 };
          }

          if (args.includes("is-active")) {
            if (state === "prior_active" || state === "rolled_back_active") {
              return { stdout: "active\n", stderr: "", exitCode: 0 };
            }
            return { stdout: "inactive\n", stderr: "", exitCode: 3 };
          }

          if (args.includes("is-enabled")) {
            return { stdout: "enabled\n", stderr: "", exitCode: 0 };
          }

          if (args.includes("status")) {
            if (state === "prior_active" || state === "rolled_back_active") {
              return {
                stdout:
                  "● resin.service - Resin Background Daemon\n   Loaded: loaded\n   Active: active (running)\n   Main PID: 4242\n",
                stderr: "",
                exitCode: 0,
              };
            }
            return {
              stdout:
                "● resin.service - Resin Background Daemon\n   Loaded: loaded\n   Active: inactive (dead)\n",
              stderr: "",
              exitCode: 3,
            };
          }

          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      };

      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: failingUpdateRunner,
        autoStart: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to restart daemon service");

      // Verify prior unit file was restored
      expect(fs.readFileSync(unitPath, "utf-8")).toBe(priorContent);

      // Verify restart failure and rollback restoration were executed
      expect(restartAttempts).toBe(2);
      const restartCommands = recordedCommands.filter((c) => c.args.includes("restart"));
      expect(restartCommands).toHaveLength(2);

      expect(startAttempts).toBe(2);
      const startCommands = recordedCommands.filter((c) => c.args.includes("start"));
      expect(startCommands).toHaveLength(2);

      // Verify final process state and active status after rollback
      const rollbackManager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: failingUpdateRunner,
      });
      const finalStatus = await rollbackManager.status();
      expect(finalStatus.installed).toBe(true);
      expect(finalStatus.active).toBe(true);
      expect(finalStatus.pid).toBe(4242);
    });
    it("restores prior-disabled and inactive state in correct order on failure", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      // Pre-install a previous service version that was disabled and inactive
      await manager.isInstalled();
      const unitPath = manager.getUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      const priorContent =
        "# Prior disabled resin service\nDescription=Old Disabled Resin Daemon\n";
      fs.writeFileSync(unitPath, priorContent);

      const commandLog: string[] = [];
      const failingUpdateRunner: ServiceCommandRunner = {
        run: async (cmd, args) => {
          const action = args.join(" ");
          commandLog.push(`${cmd} ${action}`);

          if (args.includes("is-active")) {
            return { stdout: "inactive\n", stderr: "", exitCode: 3 };
          }
          if (args.includes("is-enabled")) {
            return { stdout: "disabled\n", stderr: "", exitCode: 1 };
          }
          if (args.includes("status")) {
            return {
              stdout: "● resin.service\n   Loaded: loaded\n   Active: inactive (dead)\n",
              stderr: "",
              exitCode: 3,
            };
          }
          if (args.includes("start")) {
            return { stdout: "", stderr: "Simulated start failure", exitCode: 1 };
          }
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      };

      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: failingUpdateRunner,
        autoStart: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to start daemon service");

      // Verify prior unit content is restored
      expect(fs.readFileSync(unitPath, "utf-8")).toBe(priorContent);

      // Verify rollback sequence after the failed start:
      // 1. restore prior unit content (fsBridge.writeFile)
      // 2. reload supervisor (daemon-reload)
      // 3. restore disabled state (disable)
      // 4. restore inactive state (stop)
      const startIdx = commandLog.indexOf("systemctl --user start resin.service");
      const reloadIndex = commandLog.findIndex(
        (c, idx) => idx > startIdx && c.includes("daemon-reload"),
      );
      const disableIndex = commandLog.findIndex(
        (c, idx) => idx > startIdx && c.includes("disable"),
      );
      const stopIndex = commandLog.findIndex((c, idx) => idx > startIdx && c.includes("stop"));

      expect(reloadIndex).toBeGreaterThan(-1);
      expect(disableIndex).toBeGreaterThan(reloadIndex);
      expect(stopIndex).toBeGreaterThan(disableIndex);

      // Verify final status
      const rollbackManager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: failingUpdateRunner,
      });
      const finalStatus = await rollbackManager.status();
      expect(finalStatus.installed).toBe(true);
      expect(finalStatus.active).toBe(false);
      expect(finalStatus.enabled).toBe(false);
    });

    it("reuses existing healthy service idempotently without recreation", async () => {
      // First run: installs and starts service
      const firstRun = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });
      expect(firstRun.success).toBe(true);
      expect(firstRun.healthy).toBe(true);

      const commandCountAfterFirst = mockRunner.commands.length;

      // Second run with same parameters: should detect matching unit and active service
      const secondRun = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });
      expect(secondRun.success).toBe(true);
      expect(secondRun.healthy).toBe(true);
      expect(secondRun.installed).toBe(true);
      expect(secondRun.started).toBe(true);

      // Verify recorded commands after the first run: no install/enable/bootstrap/start mutation, only status/health probes
      const secondRunCommands = mockRunner.commands.slice(commandCountAfterFirst);
      expect(secondRunCommands.length).toBeGreaterThan(0);

      const forbiddenMutations = [
        "install",
        "enable",
        "disable",
        "bootstrap",
        "bootout",
        "start",
        "stop",
        "restart",
        "daemon-reload",
      ];

      for (const { cmd, args } of secondRunCommands) {
        for (const mutation of forbiddenMutations) {
          expect(args).not.toContain(mutation);
        }
        // Only status / health check probes should be invoked
        const isStatusProbe = args.some((arg) =>
          [
            "is-active",
            "is-enabled",
            "is-system-running",
            "status",
            "show",
            "list",
            "print",
          ].includes(arg),
        );
        expect(isStatusProbe).toBe(true);
      }
    });
    it("immediately rolls back when service starts but fails health check probes", async () => {
      const probeFailingRunner: ServiceCommandRunner = {
        run: async (_cmd, args) => {
          if (args.includes("is-active")) {
            return { stdout: "inactive", stderr: "", exitCode: 3 };
          }
          if (args.includes("status")) {
            return { stdout: "Active: inactive (dead)", stderr: "", exitCode: 3 };
          }
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      };

      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: probeFailingRunner,
        autoStart: true,
        maxHealthRetries: 2,
        healthRetryIntervalMs: 10,
      });

      expect(result.success).toBe(false);
      expect(result.healthy).toBe(false);
      expect(result.error).toContain("failed health check");

      // Cleaned up by rollback
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: probeFailingRunner,
      });
      expect(await manager.isInstalled()).toBe(false);
    });

    it("recognizes stale v1.0.20 supervisor unit and updates to unversioned stable launcher on v1.0.22 install", async () => {
      // Create versioned structure simulating v1.0.22 active install
      const v20Dir = path.join(resinHome, "versions", "v1.0.20");
      const v22Dir = path.join(resinHome, "versions", "v1.0.22");
      const currentLink = path.join(resinHome, "current");
      fs.mkdirSync(path.join(v20Dir, "apps", "cli", "dist"), { recursive: true });
      fs.mkdirSync(path.join(v22Dir, "apps", "cli", "dist"), { recursive: true });
      fs.writeFileSync(path.join(v20Dir, "apps", "cli", "dist", "index.js"), "// v1.0.20");
      fs.writeFileSync(path.join(v22Dir, "apps", "cli", "dist", "index.js"), "// v1.0.22");
      fs.symlinkSync(v22Dir, currentLink, "dir");

      // Write stale v1.0.20 unit file to disk
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });
      await manager.isInstalled();
      const unitPath = manager.getUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });

      const staleUnitContent = `[Unit]
Description=Resin Daemon
Documentation=https://github.com/Resin-AI/resin
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${v20Dir}/apps/cli/dist/index.js __service-supervisor --resin-home ${resinHome} -- ${resinHome}/bin/resin-daemon --foreground
Restart=on-failure
RestartSec=3s
Environment="RESIN_HOME=${resinHome}"
Environment="NODE_ENV=production"
Environment="PATH=/usr/bin:/bin"
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
      fs.writeFileSync(unitPath, staleUnitContent);

      // Verify initial unit content is stale
      expect(fs.readFileSync(unitPath, "utf8")).toContain("v1.0.20");

      mockRunner.commands = [];

      // Run setupAndStartDaemonService
      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.healthy).toBe(true);

      // Unit file must now contain unversioned stable launcher under current/
      const updatedUnitContent = fs.readFileSync(unitPath, "utf8");
      expect(updatedUnitContent).not.toContain("v1.0.20");
      expect(updatedUnitContent).toContain(
        path.join(resinHome, "current", "apps", "cli", "dist", "index.js"),
      );

      // Systemctl daemon-reload and restart must have been called
      const daemonReloadCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("daemon-reload"),
      );
      const restartCmd = mockRunner.commands.find(
        (c) => c.cmd === "systemctl" && c.args.includes("restart"),
      );
      expect(daemonReloadCmd).toBeDefined();
      expect(restartCmd).toBeDefined();

      // Subsequent run on the updated unit is idempotent (no daemon-reload, no restart)
      mockRunner.commands = [];
      const secondRun = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });
      expect(secondRun.success).toBe(true);
      expect(secondRun.reused).toBe(true);

      const secondMutations = mockRunner.commands.filter(
        (c) =>
          c.cmd === "systemctl" && (c.args.includes("daemon-reload") || c.args.includes("restart")),
      );
      expect(secondMutations.length).toBe(0);
    });
    it("reuses existing healthy service idempotently when ExecStart matches despite differing PATH environment variable", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });
      await manager.isInstalled();
      const canonicalUnit = manager.getUnitDefinition();
      const unitWithCustomPath = canonicalUnit.replace(
        /Environment="PATH=.*"/,
        'Environment="PATH=/custom/bin:/usr/bin:/bin"',
      );

      const unitPath = manager.getUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, unitWithCustomPath);

      mockRunner.commands = [];
      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.reused).toBe(true);

      const mutations = mockRunner.commands.filter(
        (c) =>
          c.cmd === "systemctl" &&
          (c.args.includes("daemon-reload") ||
            c.args.includes("restart") ||
            c.args.includes("enable")),
      );
      expect(mutations.length).toBe(0);
    });

    it("ensures zero root execution: all file paths remain strictly within user home directory", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });

      const unitPath = manager.getUnitPath();
      expect(unitPath.startsWith(fakeHome)).toBe(true);
      expect(unitPath.startsWith("/etc")).toBe(false);
      expect(unitPath.startsWith("/Library")).toBe(false);

      for (const cmd of mockRunner.commands) {
        expect(cmd.cmd).not.toBe("sudo");
      }
    });
  });
});
