import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  isStaleSupervisorUnitContent,
} from "../../src/service/manager.js";
import type * as ServiceManagerModule from "../../src/service/manager.js";

// The orchestration contract below is driven through the systemd manager and a systemctl mock
// runner. A Windows host would otherwise pick the scheduled-task manager, which that runner
// cannot drive (its own suite covers it), so there the default lane is pinned to systemd.
vi.mock("../../src/service/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceManagerModule>();
  return {
    ...actual,
    createUserServiceManager: (options: ServiceManagerModule.UserServiceManagerOptions = {}) =>
      actual.createUserServiceManager(
        process.platform === "win32" && options.platform === undefined
          ? { ...options, platform: "linux" }
          : options,
      ),
  };
});

/**
 * Mock Service Command Runner that records executed commands and returns configured responses.
 */
class MockServiceCommandRunner implements ServiceCommandRunner {
  readonly commands: Array<{ cmd: string; args: string[] }> = [];
  statusOutput = "active (running)";
  statusExitCode = 0;
  statusPid = 4242;
  enabledState = "enabled";

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
        stdout: `${this.enabledState}\n`,
        stderr: "",
        exitCode: this.enabledState === "enabled" ? 0 : 1,
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
    // POSIX-only: systemd unit generation (ExecStart/Environment escaping) targets Linux hosts.
    it.skipIf(process.platform === "win32")(
      "generates user-level systemd unit file in ~/.config/systemd/user/ without root",
      async () => {
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
      },
    );

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

    // POSIX-only: the alternate runtime is a symlink to the running Node.
    describe.skipIf(process.platform === "win32")("Node runtime independence", () => {
      let otherNode: string;

      beforeEach(() => {
        otherNode = path.join(tempDir, "other-node", "bin", "node");
        fs.mkdirSync(path.dirname(otherNode), { recursive: true });
        fs.symlinkSync(process.execPath, otherNode);
      });

      function execStartOf(unit: string): string {
        return /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
      }

      it("does not treat a unit as stale when only a usable Node runtime differs", async () => {
        const installer = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          nodePath: otherNode,
          runner: mockRunner,
        });
        await installer.install({ autoStart: false });
        const onDisk = fs.readFileSync(installer.getUnitPath(), "utf8");
        const caller = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          runner: mockRunner,
        });

        expect(execStartOf(onDisk).startsWith(`${otherNode} `)).toBe(true);
        expect(execStartOf(caller.getUnitDefinition()).startsWith(`${process.execPath} `)).toBe(
          true,
        );
        expect(isStaleSupervisorUnitContent(onDisk, caller.getUnitDefinition())).toBe(false);
        // The rest of the command still decides staleness.
        expect(
          isStaleSupervisorUnitContent(
            onDisk.replace("__service-supervisor", "__other-command"),
            caller.getUnitDefinition(),
          ),
        ).toBe(true);
        // A runtime that no longer exists is stale.
        const missingNode = path.join(tempDir, "removed-node", "bin", "node");
        expect(
          isStaleSupervisorUnitContent(
            onDisk.replaceAll(otherNode, missingNode),
            caller.getUnitDefinition(),
          ),
        ).toBe(true);
      });

      it("ignores the runtime in a Node-run daemon child command too", () => {
        const daemonPath = path.join(fakeHome, "src", "daemon.js");
        const onDisk = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          daemonPath,
          nodePath: otherNode,
          runner: mockRunner,
        }).getUnitDefinition();
        const expected = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          daemonPath,
          runner: mockRunner,
        }).getUnitDefinition();

        expect(execStartOf(onDisk)).toContain(`-- ${otherNode} ${daemonPath}`);
        expect(isStaleSupervisorUnitContent(onDisk, expected)).toBe(false);
      });

      it("keeps the installed unit's usable runtime when reinstalled from another shell", async () => {
        const installer = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          nodePath: otherNode,
          runner: mockRunner,
        });
        await installer.install({ autoStart: false });
        const caller = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          runner: mockRunner,
        });

        const result = await caller.install({ autoStart: false });

        expect(execStartOf(result.unitContent).startsWith(`${otherNode} `)).toBe(true);
        expect(fs.readFileSync(caller.getUnitPath(), "utf8")).toBe(result.unitContent);
      });

      it("replaces an installed runtime that no longer exists with the caller's", async () => {
        const missingNode = path.join(tempDir, "removed-node", "bin", "node");
        await new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          nodePath: missingNode,
          runner: mockRunner,
        }).install({ autoStart: false });
        const caller = new SystemdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          runner: mockRunner,
        });

        const result = await caller.install({ autoStart: false });

        expect(execStartOf(result.unitContent).startsWith(`${process.execPath} `)).toBe(true);
      });

      it("compares launchd ProgramArguments without the runtime", () => {
        const onDisk = new LaunchdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          nodePath: otherNode,
          runner: mockRunner,
        }).getUnitDefinition();
        const expected = new LaunchdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          runner: mockRunner,
        }).getUnitDefinition();

        expect(isStaleSupervisorUnitContent(onDisk, expected)).toBe(false);
        expect(
          isStaleSupervisorUnitContent(onDisk.replace("--resin-home", "--other-flag"), expected),
        ).toBe(true);
      });
    });

    it.skipIf(process.platform === "win32")(
      "leaves temporary directories out of the service PATH",
      () => {
        const temporaryEntries = [
          "/tmp/resin-skip-test-1/bin",
          "/tmp/resin-bootstrap-home-x/bin",
          path.join(os.tmpdir(), "resin-fixture", "bin"),
        ];
        vi.stubEnv("PATH", [...temporaryEntries, "/usr/local/bin", "/usr/bin"].join(":"));
        try {
          const unit = new SystemdUserServiceManager({
            homeDir: fakeHome,
            resinHome,
            nodePath: "/opt/node/bin/node",
            runner: mockRunner,
          }).getUnitDefinition();

          expect(unit).toContain("Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin\n");
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "rewrites an installed unit whose PATH still carries temporary directories",
      () => {
        vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
        try {
          const manager = (nodePath: string) =>
            new SystemdUserServiceManager({
              homeDir: fakeHome,
              resinHome,
              nodePath,
              runner: mockRunner,
            });
          const expected = manager("/opt/node/bin/node").getUnitDefinition();
          const onDisk = expected.replace(
            "Environment=PATH=/opt/node/bin:",
            "Environment=PATH=/opt/node/bin:/tmp/resin-skip-test-1/bin:/tmp/resin-bootstrap-home-x/bin:",
          );
          expect(onDisk).not.toBe(expected);
          expect(isStaleSupervisorUnitContent(onDisk, expected)).toBe(true);
          expect(isStaleSupervisorUnitContent(expected, expected)).toBe(false);
          // A Node that itself lives in a temporary directory is the expected PATH, not staging.
          const temporaryNode = manager("/tmp/resin-node/bin/node").getUnitDefinition();
          expect(isStaleSupervisorUnitContent(temporaryNode, temporaryNode)).toBe(false);

          const plist = new LaunchdUserServiceManager({
            homeDir: fakeHome,
            resinHome,
            nodePath: "/opt/node/bin/node",
            runner: mockRunner,
          }).getUnitDefinition();
          const stalePlist = plist.replace(
            "<string>/opt/node/bin:",
            "<string>/opt/node/bin:/tmp/resin-bootstrap-idempotent-y/bin:",
          );
          expect(stalePlist).not.toBe(plist);
          expect(isStaleSupervisorUnitContent(stalePlist, plist)).toBe(true);
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
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

    // POSIX-only: a launchd PATH is ':'-joined for macOS; a Windows host joins with ';'.
    it.skipIf(process.platform === "win32")(
      "gives the launch agent a PATH that reaches the installing Node, and treats older plists as stale",
      () => {
        const nodePath = "/opt/homebrew/bin/node";
        const manager = new LaunchdUserServiceManager({
          homeDir: fakeHome,
          resinHome,
          runner: mockRunner,
        });
        const plist = manager.getUnitDefinition({ nodePath });
        const pathValue = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
        expect(pathValue?.split(":")[0]).toBe("/opt/homebrew/bin");

        const plistWithoutPath = plist.replace(/\s*<key>PATH<\/key>\s*<string>[^<]*<\/string>/, "");
        expect(isStaleSupervisorUnitContent(plistWithoutPath, plist)).toBe(true);
        expect(isStaleSupervisorUnitContent(plist, plist)).toBe(false);
      },
    );

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
    it("registers explicit local-source daemon and supervisor paths", async () => {
      const daemonPath = "/work/resin/apps/gateway/dist/bin/daemon.js";
      const supervisorEntryPath = "/work/resin/apps/cli/dist/index.js";
      const setupResult = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        daemonPath,
        supervisorEntryPath,
        runner: mockRunner,
        autoStart: true,
      });

      expect(setupResult.success).toBe(true);
      expect(setupResult.unitPath).toBeDefined();
      const unitContent = fs.readFileSync(setupResult.unitPath!, "utf8");
      expect(unitContent).toContain(supervisorEntryPath);
      expect(unitContent).toContain(daemonPath);
      expect(unitContent).not.toContain(path.join(resinHome, "current"));
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
      fs.symlinkSync(v22Dir, currentLink, "junction");

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
      // Quoted unit values escape backslashes (a no-op for POSIX paths).
      const stableLauncher = path.join(resinHome, "current", "apps", "cli", "dist", "index.js");
      expect(updatedUnitContent).toContain(JSON.stringify(stableLauncher).slice(1, -1));

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
    it("enables an active matching service that was left disabled at login", async () => {
      const manager = createUserServiceManager({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
      });
      const unitPath = manager.getUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, manager.getUnitDefinition());
      mockRunner.enabledState = "disabled";
      mockRunner.commands = [];

      const result = await setupAndStartDaemonService({
        homeDir: fakeHome,
        resinHome,
        runner: mockRunner,
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.reused).toBe(true);
      expect(mockRunner.commands).toContainEqual({
        cmd: "systemctl",
        args: ["--user", "enable", "resin.service"],
      });
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
