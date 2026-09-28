import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getActiveVersion,
  pruneInstalledVersions,
  rollbackActiveVersion,
  switchActiveVersion,
} from "../../src/installer/asset-downloader.js";
import {
  WINDOWS_USER_PATH_SCRIPT,
  type WindowsPathRunner,
  addWindowsUserPath,
  defaultWindowsPathRunner,
  removeWindowsLaunchers,
  removeWindowsUserPath,
  resolveLauncherInvocation,
  windowsGlobalCmdLauncher,
  windowsGlobalModuleLauncher,
} from "../../src/installer/windows-install.js";

const isWindows = process.platform === "win32";

let resinHome: string;

function makeRelease(version: string, extraBin: readonly string[] = []): string {
  const releaseDir = path.join(resinHome, "versions", `v${version}`);
  const binDir = path.join(releaseDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "package.json"), '{"type":"module"}\n');
  for (const name of ["resin", "resin-daemon", "resin-gateway", ...extraBin]) {
    fs.writeFileSync(
      path.join(binDir, name),
      `process.stdout.write(JSON.stringify({ entry: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, args: process.argv.slice(2) }));\nprocess.exitCode = process.argv.includes("--fail") ? 7 : 0;\n`,
    );
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), "@rem release-local launcher\r\n");
  }
  fs.writeFileSync(path.join(releaseDir, "version.json"), JSON.stringify({ version }));
  return releaseDir;
}

function binFiles(): string[] {
  return fs.readdirSync(path.join(resinHome, "bin")).sort();
}

beforeEach(() => {
  resinHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-win-activation-"));
});

afterEach(() => {
  fs.rmSync(resinHome, { recursive: true, force: true });
});

describe("Windows launchers", () => {
  it("are relative, single-line batch files that keep node's exit code", () => {
    expect(windowsGlobalCmdLauncher("1.2.3", "resin")).toBe(
      '@node "%~dp0..\\versions\\v1.2.3\\bin\\resin" %* & call exit /b %%errorlevel%%\r\n',
    );
    expect(windowsGlobalModuleLauncher("v1.2.3", "resin-daemon")).toBe(
      'import "../versions/v1.2.3/bin/resin-daemon";\n',
    );
  });

  it("refuse names or versions that could inject batch or module syntax", () => {
    expect(() => windowsGlobalCmdLauncher("1.0.0", "resin & calc")).toThrow(/unexpected entry/);
    expect(() => windowsGlobalCmdLauncher("1.0.0%PATH%", "resin")).toThrow(/invalid release/);
    expect(() => windowsGlobalModuleLauncher("../../x", "resin")).toThrow(/invalid release/);
  });

  it("run JS entries through node on Windows only", () => {
    expect(
      resolveLauncherInvocation("C:\\r\\bin\\resin.mjs", ["version"], "win32", "node.exe"),
    ).toEqual({ command: "node.exe", args: ["C:\\r\\bin\\resin.mjs", "version"] });
    expect(resolveLauncherInvocation("/r/bin/resin", ["version"], "linux", "node")).toEqual({
      command: "/r/bin/resin",
      args: ["version"],
    });
  });
});

describe("Windows activation (platform: win32)", () => {
  it("points current at the release, records current-version and publishes launchers", async () => {
    const releaseDir = makeRelease("1.0.0");
    const result = await switchActiveVersion({
      resinHome,
      targetVersion: "1.0.0",
      platform: "win32",
    });

    expect(result).toMatchObject({ activeVersion: "1.0.0", previousVersion: null });
    const current = path.join(resinHome, "current");
    expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(current), fs.readlinkSync(current))).toBe(releaseDir);
    expect(fs.readFileSync(path.join(resinHome, "current-version"), "utf8")).toBe("1.0.0");
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
    expect(binFiles()).toEqual([
      "resin-daemon.cmd",
      "resin-daemon.mjs",
      "resin-gateway.cmd",
      "resin-gateway.mjs",
      "resin.cmd",
      "resin.mjs",
    ]);
    expect(fs.readFileSync(path.join(resinHome, "bin", "resin.cmd"), "utf8")).toBe(
      windowsGlobalCmdLauncher("1.0.0", "resin"),
    );
  });

  it("keeps previous for rollback and removes launchers the new release no longer ships", async () => {
    makeRelease("1.0.0", ["resin-extra"]);
    const next = makeRelease("1.0.1");
    await switchActiveVersion({ resinHome, targetVersion: "1.0.0", platform: "win32" });
    expect(binFiles()).toContain("resin-extra.cmd");

    await switchActiveVersion({ resinHome, targetVersion: "1.0.1", platform: "win32" });
    expect(getActiveVersion(resinHome)).toBe("1.0.1");
    expect(fs.readFileSync(path.join(resinHome, "previous-version"), "utf8")).toBe("1.0.0");
    expect(fs.lstatSync(path.join(resinHome, "previous")).isSymbolicLink()).toBe(true);
    expect(binFiles()).not.toContain("resin-extra.cmd");
    expect(fs.readFileSync(path.join(resinHome, "bin", "resin.mjs"), "utf8")).toBe(
      windowsGlobalModuleLauncher("1.0.1", "resin"),
    );
    expect(path.resolve(resinHome, fs.readlinkSync(path.join(resinHome, "current")))).toBe(next);

    const rollback = await rollbackActiveVersion({ resinHome, platform: "win32" });
    expect(rollback.restoredVersion).toBe("1.0.0");
    expect(getActiveVersion(resinHome)).toBe("1.0.0");
    expect(binFiles()).toContain("resin-extra.cmd");
  });

  it("restores pointers, pointer files, launchers and state when publication fails", async () => {
    makeRelease("1.0.0");
    makeRelease("1.0.1");
    await switchActiveVersion({ resinHome, targetVersion: "1.0.0", platform: "win32" });
    const before = new Map(
      binFiles().map((name) => [name, fs.readFileSync(path.join(resinHome, "bin", name), "utf8")]),
    );
    const stateBefore = fs.readFileSync(path.join(resinHome, "version-state.json"), "utf8");

    // A directory where a launcher must go makes the per-file replacement fail midway.
    fs.rmSync(path.join(resinHome, "bin", "resin-gateway.mjs"));
    fs.mkdirSync(path.join(resinHome, "bin", "resin-gateway.mjs"));
    before.delete("resin-gateway.mjs");

    await expect(
      switchActiveVersion({ resinHome, targetVersion: "1.0.1", platform: "win32" }),
    ).rejects.toThrow();

    expect(getActiveVersion(resinHome)).toBe("1.0.0");
    expect(fs.readFileSync(path.join(resinHome, "current-version"), "utf8")).toBe("1.0.0");
    expect(fs.existsSync(path.join(resinHome, "previous"))).toBe(false);
    expect(fs.existsSync(path.join(resinHome, "previous-version"))).toBe(false);
    expect(fs.readFileSync(path.join(resinHome, "version-state.json"), "utf8")).toBe(stateBefore);
    for (const [name, content] of before) {
      expect(fs.readFileSync(path.join(resinHome, "bin", name), "utf8")).toBe(content);
    }
    expect(fs.readdirSync(resinHome).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses to replace a real directory named current", async () => {
    makeRelease("1.0.0");
    fs.mkdirSync(path.join(resinHome, "current"));
    fs.writeFileSync(path.join(resinHome, "current", "keep"), "user data");
    await expect(
      switchActiveVersion({ resinHome, targetVersion: "1.0.0", platform: "win32" }),
    ).rejects.toThrow(/real directory/);
    expect(fs.readFileSync(path.join(resinHome, "current", "keep"), "utf8")).toBe("user data");
  });

  it("prunes old releases by moving them out of versions before deleting", async () => {
    for (const version of ["1.0.0", "1.0.1", "1.0.2"]) makeRelease(version);
    await switchActiveVersion({ resinHome, targetVersion: "1.0.1", platform: "win32" });
    await switchActiveVersion({ resinHome, targetVersion: "1.0.2", platform: "win32" });
    fs.mkdirSync(path.join(resinHome, "versions", ".trash-v0.9.0-1-abcd"), { recursive: true });

    const pruned = await pruneInstalledVersions({
      resinHome,
      retainVersions: [],
      platform: "win32",
    });
    expect(pruned).toEqual({ removed: ["v1.0.0"], failed: [] });
    expect(fs.readdirSync(path.join(resinHome, "versions")).sort()).toEqual(["v1.0.1", "v1.0.2"]);
  });

  it("removes only Resin launchers on uninstall", async () => {
    makeRelease("1.0.0");
    await switchActiveVersion({ resinHome, targetVersion: "1.0.0", platform: "win32" });
    fs.writeFileSync(path.join(resinHome, "bin", "user-tool.cmd"), "@echo mine\r\n");
    const removed = await removeWindowsLaunchers({ resinHome });
    expect(removed).toHaveLength(6);
    expect(binFiles()).toEqual(["user-tool.cmd"]);
  });
});

describe.runIf(isWindows)("native Windows launchers and junctions", () => {
  it("runs the published launchers from cmd.exe and node with arguments and exit codes", async () => {
    makeRelease("1.0.0");
    await switchActiveVersion({ resinHome, targetVersion: "1.0.0" });
    const current = path.join(resinHome, "current");
    expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);

    const cmd = child_process.spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", path.join(resinHome, "bin", "resin.cmd"), "status", "--json"],
      { encoding: "utf8" },
    );
    expect(cmd.status).toBe(0);
    expect(JSON.parse(cmd.stdout)).toEqual({
      entry: "resin",
      version: "1.0.0",
      args: ["status", "--json"],
    });

    const failing = child_process.spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", path.join(resinHome, "bin", "resin-daemon.cmd"), "--fail"],
      { encoding: "utf8" },
    );
    expect(failing.status).toBe(7);

    const viaNode = child_process.spawnSync(
      process.execPath,
      [path.join(resinHome, "bin", "resin-gateway.mjs"), "mcp"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(viaNode.stdout)).toMatchObject({ entry: "resin-gateway", args: ["mcp"] });
  });

  it("switches while a launcher is running from the bin directory", async () => {
    makeRelease("1.0.0");
    makeRelease("1.0.1");
    await switchActiveVersion({ resinHome, targetVersion: "1.0.0" });
    // cmd.exe with its working directory in bin keeps the directory busy (no rename possible).
    const busy = child_process.spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", "echo ready& ping -n 30 127.0.0.1 >nul"],
      { cwd: path.join(resinHome, "bin"), stdio: ["ignore", "pipe", "ignore"] },
    );
    const ready = Promise.withResolvers<void>();
    busy.stdout.once("data", () => ready.resolve());
    busy.once("error", (error) => ready.reject(error));
    await ready.promise;
    try {
      expect(() => fs.renameSync(path.join(resinHome, "bin"), `${resinHome}-bin`)).toThrow();
      await switchActiveVersion({ resinHome, targetVersion: "1.0.1" });
      expect(getActiveVersion(resinHome)).toBe("1.0.1");
      expect(fs.readFileSync(path.join(resinHome, "bin", "resin.cmd"), "utf8")).toBe(
        windowsGlobalCmdLauncher("1.0.1", "resin"),
      );
    } finally {
      // ping inherits the busy working directory; end the whole tree.
      child_process.spawnSync("taskkill", ["/pid", String(busy.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    }
  });
});

describe("per-user PATH", () => {
  it("is a no-op off Windows", async () => {
    const result = await addWindowsUserPath({ resinHome, platform: "linux" });
    expect(result).toMatchObject({ attempted: false, changed: false, reason: "not-windows" });
  });

  it("passes the bin directory and mode to the PowerShell runner and parses its result", async () => {
    const calls: Array<Readonly<Record<string, string>>> = [];
    const runner: WindowsPathRunner = async (script, env) => {
      expect(script).toBe(WINDOWS_USER_PATH_SCRIPT);
      calls.push(env);
      return { exitCode: 0, stdout: 'noise\r\n{"changed":true,"present":true}\r\n', stderr: "" };
    };
    const added = await addWindowsUserPath({ resinHome, runner, platform: "win32" });
    expect(added).toMatchObject({
      attempted: true,
      changed: true,
      present: true,
      binDir: path.join(resinHome, "bin"),
    });
    expect(calls[0]).toEqual({
      RESIN_PATH_ENTRY: path.join(resinHome, "bin"),
      RESIN_PATH_MODE: "add",
      RESIN_PATH_REGISTRY_KEY: "Environment",
    });

    const failing: WindowsPathRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Access denied",
    });
    const removed = await removeWindowsUserPath({ resinHome, runner: failing, platform: "win32" });
    expect(removed).toMatchObject({ attempted: true, changed: false, error: "Access denied" });
  });

  it("preserves REG_EXPAND_SZ and broadcasts only for the real Environment key", () => {
    expect(WINDOWS_USER_PATH_SCRIPT).toContain("DoNotExpandEnvironmentNames");
    expect(WINDOWS_USER_PATH_SCRIPT).toContain("$key.GetValueKind('Path')");
    expect(WINDOWS_USER_PATH_SCRIPT).toContain("if ($changed -and $subKey -eq 'Environment')");
  });

  it.runIf(isWindows)(
    "adds once, keeps other entries and %VARS% unexpanded, and removes the entry (scratch key)",
    async () => {
      const registryKey = `Software\\ResinTest-PathScope-${crypto.randomBytes(4).toString("hex")}`;
      const seed = `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:RESIN_TEST_KEY)
$k.SetValue('Path', '%USERPROFILE%\\tools;C:\\Other', [Microsoft.Win32.RegistryValueKind]::ExpandString)
$k.Close()`;
      const read = `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:RESIN_TEST_KEY)
Write-Output ($k.GetValueKind('Path').ToString() + '|' + $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
$k.Close()`;
      const cleanup =
        "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:RESIN_TEST_KEY, $false)";
      const env = { RESIN_TEST_KEY: registryKey };
      try {
        expect((await defaultWindowsPathRunner(seed, env)).exitCode).toBe(0);
        const first = await addWindowsUserPath({ resinHome, registryKey });
        expect(first).toMatchObject({ changed: true, present: true });
        const second = await addWindowsUserPath({ resinHome: `${resinHome}\\`, registryKey });
        expect(second).toMatchObject({ changed: false, present: true });
        const afterAdd = (await defaultWindowsPathRunner(read, env)).stdout.trim();
        expect(afterAdd).toBe(
          `ExpandString|%USERPROFILE%\\tools;C:\\Other;${path.join(resinHome, "bin")}`,
        );
        const removed = await removeWindowsUserPath({ resinHome, registryKey });
        expect(removed).toMatchObject({ changed: true, present: false });
        expect((await defaultWindowsPathRunner(read, env)).stdout.trim()).toBe(
          "ExpandString|%USERPROFILE%\\tools;C:\\Other",
        );
      } finally {
        await defaultWindowsPathRunner(cleanup, env);
      }
    },
    60_000,
  );
});
