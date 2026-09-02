import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LaunchdUserServiceManager,
  SERVICE_SUPERVISOR_COMMAND,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  SystemdUserServiceManager,
  UserServiceManager,
  WslUserServiceManager,
  createUserServiceManager,
} from "../src/service/manager.js";

// In-memory FsBridge mock for isolated testing
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

function createMockRunner(
  handler: (cmd: string, args: string[]) => ServiceCommandResult = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
): ServiceCommandRunner & { executed: Array<{ cmd: string; args: string[] }> } {
  const executed: Array<{ cmd: string; args: string[] }> = [];
  return {
    executed,
    async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
      executed.push({ cmd, args });
      return handler(cmd, args);
    },
  };
}

describe("SystemdUserServiceManager", () => {
  const homeDir = "/home/testuser";
  const resinHome = "/home/testuser/.resin";

  it("generates correct systemd service definition for native binary", () => {
    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      nodePath: "/home/testuser/.local/bin/node",
    });
    const def = manager.getUnitDefinition({
      daemonPath: "/home/testuser/.resin/bin/resin-daemon",
    });
    const execStart = def.match(/^ExecStart=(.*)$/m)?.[1]?.split(" ");

    expect(def).toContain("[Unit]");
    expect(def).toContain("Description=Resin Daemon");
    expect(execStart).toEqual([
      "/home/testuser/.local/bin/node",
      expect.stringMatching(/\/index\.js$/),
      SERVICE_SUPERVISOR_COMMAND,
      "--resin-home",
      resinHome,
      "--",
      "/home/testuser/.resin/bin/resin-daemon",
      "--foreground",
    ]);
    expect(def).toContain("Environment=RESIN_HOME=/home/testuser/.resin");
    expect(def).toContain("Environment=NODE_ENV=production");
    expect(def).toMatch(/Environment="?PATH=\/home\/testuser\/\.local\/bin/);
    expect(def).toContain("Restart=on-failure");
    expect(def).toContain("WantedBy=default.target");
  });

  it("generates correct systemd service definition for Node.js JS script", () => {
    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      nodePath: "/usr/bin/node",
    });
    const def = manager.getUnitDefinition({
      daemonPath: "/home/testuser/.resin/dist/daemon.js",
    });
    const execStart = def.match(/^ExecStart=(.*)$/m)?.[1]?.split(" ");

    expect(execStart).toEqual([
      "/usr/bin/node",
      expect.stringMatching(/\/index\.js$/),
      SERVICE_SUPERVISOR_COMMAND,
      "--resin-home",
      resinHome,
      "--",
      "/usr/bin/node",
      "/home/testuser/.resin/dist/daemon.js",
      "--foreground",
    ]);
  });

  it("installs systemd service, reloads daemon, enables and starts service", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((cmd, args) => {
      if (cmd === "systemctl") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const result = await manager.install({ autoStart: true });
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.started).toBe(true);
    expect(result.unitPath).toBe(path.join(homeDir, ".config", "systemd", "user", "resin.service"));

    // Verify unit file written to fsBridge
    expect(await fsBridge.exists(result.unitPath)).toBe(true);
    const content = await fsBridge.readFile(result.unitPath);
    expect(content).toContain("Description=Resin Daemon");

    // Verify systemctl commands called
    expect(runner.executed).toEqual([
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
      { cmd: "systemctl", args: ["--user", "enable", "resin.service"] },
      { cmd: "systemctl", args: ["--user", "start", "resin.service"] },
    ]);
  });

  it("uninstalls systemd service cleanly", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner();

    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const result = await manager.uninstall();
    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.disabled).toBe(true);
    expect(result.removed).toBe(true);
    expect(await fsBridge.exists(unitPath)).toBe(false);

    expect(runner.executed).toEqual([
      { cmd: "systemctl", args: ["--user", "stop", "resin.service"] },
      { cmd: "systemctl", args: ["--user", "disable", "resin.service"] },
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  it("inspects status of systemd service including PID", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-active") return { stdout: "active\n", stderr: "", exitCode: 0 };
      if (args[1] === "is-enabled") return { stdout: "enabled\n", stderr: "", exitCode: 0 };
      if (args[1] === "status") {
        return {
          stdout:
            "● resin.service - Resin Daemon\n   Main PID: 12345 (node)\n   Active: active (running)\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it("throws when systemctl is-active returns unexpected exit code or unknown state (bus failure)", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-active")
        return {
          stdout: "\n",
          stderr: "Failed to connect to bus: Connection refused\n",
          exitCode: 1,
        };
      if (args[1] === "is-enabled") return { stdout: "enabled\n", stderr: "", exitCode: 0 };
      if (args[1] === "status")
        return { stdout: "", stderr: "Failed to connect to bus\n", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    await expect(manager.status()).rejects.toThrow(
      "Failed to determine systemd service state for resin",
    );
  });

  it("returns inactive for legitimate inactive/failed systemd states (exit code 3 or inactive stdout)", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const fsBridge = createMockFsBridge({ [unitPath]: "unit content" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-active") return { stdout: "inactive\n", stderr: "", exitCode: 3 };
      if (args[1] === "is-enabled") return { stdout: "enabled\n", stderr: "", exitCode: 0 };
      if (args[1] === "status")
        return { stdout: "Loaded: loaded\nActive: inactive (dead)\n", stderr: "", exitCode: 3 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new SystemdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(false);
    expect(status.state).toBe("inactive");
  });
});

describe("LaunchdUserServiceManager", () => {
  const homeDir = "/Users/testuser";
  const resinHome = "/Users/testuser/.resin";

  it("generates correct launchd plist definition with XML escaping", () => {
    const manager = new LaunchdUserServiceManager({ homeDir, resinHome });
    const def = manager.getUnitDefinition({
      daemonPath: "/Users/testuser/.resin/bin/resin-daemon",
      env: { CUSTOM_VAR: "foo & bar <baz>" },
    });

    expect(def).toContain("<key>Label</key>");
    expect(def).toContain("<string>com.resin.daemon</string>");
    expect(def).toContain("<string>/Users/testuser/.resin/bin/resin-daemon</string>");
    expect(def).toContain("<string>--foreground</string>");
    expect(def).toContain("<key>RunAtLoad</key>");
    expect(def).toContain("<true/>");
    expect(def).toContain("<string>foo &amp; bar &lt;baz&gt;</string>");
  });

  it("installs launchd plist and loads agent", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner();

    const manager = new LaunchdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const result = await manager.install({ autoStart: true });
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.started).toBe(true);

    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.resin.daemon.plist");
    expect(result.unitPath).toBe(plistPath);
    expect(await fsBridge.exists(plistPath)).toBe(true);

    expect(runner.executed).toEqual([
      { cmd: "launchctl", args: ["unload", "-w", plistPath] },
      { cmd: "launchctl", args: ["load", "-w", plistPath] },
    ]);
  });

  it("uninstalls launchd agent cleanly", async () => {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.resin.daemon.plist");
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner();

    const manager = new LaunchdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const result = await manager.uninstall();
    expect(result.success).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.removed).toBe(true);
    expect(await fsBridge.exists(plistPath)).toBe(false);

    expect(runner.executed).toEqual([{ cmd: "launchctl", args: ["unload", "-w", plistPath] }]);
  });

  it("inspects launchd status and parses PID", async () => {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.resin.daemon.plist");
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[0] === "list") {
        return {
          stdout:
            '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.resin.daemon";\n\t"PID" = 54321;\n};\n',
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new LaunchdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.pid).toBe(54321);
  });

  it("returns inactive when launchctl list reports Could not find service", async () => {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.resin.daemon.plist");
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[0] === "list") {
        return {
          stdout: "",
          stderr: 'Could not find service "com.resin.daemon" in domain for port\n',
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new LaunchdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const status = await manager.status();
    expect(status.installed).toBe(true);
    expect(status.active).toBe(false);
    expect(status.state).toBe("inactive");
  });

  it("throws when launchctl list encounters an ambiguous failure", async () => {
    const plistPath = path.join(homeDir, "Library", "LaunchAgents", "com.resin.daemon.plist");
    const fsBridge = createMockFsBridge({ [plistPath]: "<plist></plist>" });
    const runner = createMockRunner((_cmd, args) => {
      if (args[0] === "list") {
        return {
          stdout: "",
          stderr: "Internal launchd IPC communication error: connection broken\n",
          exitCode: 92,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new LaunchdUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    await expect(manager.status()).rejects.toThrow(
      "Failed to determine launchd service state for com.resin.daemon",
    );
  });
});

describe("WslUserServiceManager", () => {
  const homeDir = "/home/wsluser";
  const resinHome = "/home/wsluser/.resin";

  it("delegates to systemd when systemd is available in WSL", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-system-running") {
        return { stdout: "running\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new WslUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const hasSystemd = await manager.checkSystemdAvailable();
    expect(hasSystemd).toBe(true);

    const installRes = await manager.install();
    expect(installRes.success).toBe(true);
    // Should have written systemd unit file
    const systemdPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    expect(await fsBridge.exists(systemdPath)).toBe(true);
    expect(manager.getUnitPath()).toBe(systemdPath);
    expect(manager.getUnitDefinition()).toContain("[Service]");
    expect(manager.getUnitDefinition()).toContain("ExecStart=");
    expect(manager.getUnitDefinition()).not.toContain("WSL Service Fallback");
    await manager.restart();
    expect(runner.executed).toContainEqual({
      cmd: "systemctl",
      args: ["--user", "restart", "resin.service"],
    });
  });

  it("uses script fallback when systemd is unavailable in WSL", async () => {
    const fsBridge = createMockFsBridge();
    const runner = createMockRunner((_cmd, args) => {
      if (args[1] === "is-system-running") {
        return {
          stdout: "",
          stderr: "System has not been booted with systemd as init system",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const manager = new WslUserServiceManager({
      homeDir,
      resinHome,
      fsBridge,
      runner,
    });

    const hasSystemd = await manager.checkSystemdAvailable();
    expect(hasSystemd).toBe(false);

    const installRes = await manager.install({ autoStart: true });
    expect(installRes.success).toBe(true);

    const scriptPath = path.join(resinHome, "bin", "resin-service.sh");
    expect(await fsBridge.exists(scriptPath)).toBe(true);
    const content = await fsBridge.readFile(scriptPath);
    expect(content).toContain("RESIN_HOME");
    expect(content).toContain("daemon.pid");
    expect(content).toContain("--foreground");
    expect(manager.getUnitPath()).toBe(path.join(resinHome, "services", "wsl-service.json"));
    expect(manager.getUnitDefinition()).toContain("WSL Service Fallback");
  });
});

describe("createUserServiceManager factory", () => {
  it("creates systemd manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "systemd" });
    expect(mgr.name).toBe("systemd");
  });

  it("creates launchd manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "launchd" });
    expect(mgr.name).toBe("launchd");
  });

  it("creates wsl manager when platform explicitly specified", () => {
    const mgr = createUserServiceManager({ platform: "wsl" });
    expect(mgr.name).toBe("wsl");
  });
});
