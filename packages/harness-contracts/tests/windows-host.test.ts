import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executableFileNames,
  findHostExecutable,
  harnessCommandInvocation,
  hostPathsEqual,
  hostSearchPath,
  readHostEnv,
  readHostPathEnv,
  resolveHarnessUserHome,
  runHarnessCommand,
  windowsExecutableExtensions,
} from "../src/host.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resin host test "));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("harness host facts on native Windows", () => {
  it("reads environment names case-insensitively only on win32", () => {
    const env = { Path: "C:\\bin", userprofile: "C:\\Users\\Dev" };
    expect(readHostEnv(env, "PATH", "win32")).toBe("C:\\bin");
    expect(readHostEnv(env, "USERPROFILE", "win32")).toBe("C:\\Users\\Dev");
    expect(readHostEnv(env, "PATH", "linux")).toBeUndefined();
  });

  it("resolves the harness home from USERPROFILE on win32 and never from HOME", () => {
    const homedir = () => "C:\\Fallback";
    expect(
      resolveHarnessUserHome({
        platform: "win32",
        env: { HOME: "/c/Users/dev", USERPROFILE: "C:\\Users\\Dev User" },
        homedir,
      }),
    ).toBe("C:\\Users\\Dev User");
    expect(
      resolveHarnessUserHome({
        platform: "win32",
        env: { HOME: "/c/Users/dev", HOMEDRIVE: "D:", HOMEPATH: "\\Profiles\\dev" },
        homedir,
      }),
    ).toBe("D:\\Profiles\\dev");
    expect(resolveHarnessUserHome({ platform: "win32", env: { HOME: "/c/x" }, homedir })).toBe(
      "C:\\Fallback",
    );
    expect(
      resolveHarnessUserHome({
        platform: "linux",
        env: { HOME: "/home/dev", USERPROFILE: "C:\\x" },
        homedir,
      }),
    ).toBe("/home/dev");
  });

  it("resolves harness path variables to absolute host paths", () => {
    expect(readHostPathEnv({ codex_home: "  rel/codex " }, "CODEX_HOME", "win32")).toBe(
      path.resolve("rel/codex"),
    );
    expect(readHostPathEnv({ CODEX_HOME: " " }, "CODEX_HOME", "linux")).toBeUndefined();
    expect(readHostPathEnv({ CODEX_HOME: "/home/dev/.codex" }, "CODEX_HOME", "linux")).toBe(
      path.resolve("/home/dev/.codex"),
    );
  });

  // WSL interop forwards Linux values such as CODEX_HOME=/home/dev/.codex into Windows processes;
  // on Windows that would resolve to C:\home\dev\.codex, a directory no harness uses.
  it.runIf(process.platform === "win32")(
    "ignores a drive-less POSIX path leaked from WSL on a Windows host",
    () => {
      expect(readHostPathEnv({ CODEX_HOME: "/home/dev/.codex" }, "CODEX_HOME")).toBeUndefined();
      expect(readHostPathEnv({ CODEX_HOME: "D:\\codex" }, "CODEX_HOME")).toBe("D:\\codex");
      expect(readHostPathEnv({ CODEX_HOME: "\\\\srv\\share\\codex" }, "CODEX_HOME")).toBe(
        "\\\\srv\\share\\codex",
      );
    },
  );

  it("orders launchers by PATHEXT and skips extensions that need another interpreter", () => {
    expect(windowsExecutableExtensions({ PATHEXT: ".CMD;.VBS;.EXE;.PS1;.cmd" })).toEqual([
      ".cmd",
      ".exe",
    ]);
    expect(windowsExecutableExtensions({})).toEqual([".com", ".exe", ".bat", ".cmd"]);
    expect(executableFileNames("codex", { platform: "win32", env: {} })).toEqual([
      "codex.com",
      "codex.exe",
      "codex.bat",
      "codex.cmd",
    ]);
    expect(executableFileNames("claude.EXE", { platform: "win32", env: {} })).toEqual([
      "claude.EXE",
    ]);
    expect(executableFileNames("codex", { platform: "linux", env: {} })).toEqual(["codex"]);
  });

  it("splits a quoted, semicolon-separated Windows PATH", () => {
    expect(
      hostSearchPath({
        platform: "win32",
        env: { Path: 'C:\\Windows;;"C:\\Program Files\\nodejs";\\\\server\\share\\bin' },
      }),
    ).toEqual(["C:\\Windows", "C:\\Program Files\\nodejs", "\\\\server\\share\\bin"]);
    expect(hostSearchPath({ platform: "linux", env: { PATH: "/usr/bin:/bin" } })).toEqual([
      "/usr/bin",
      "/bin",
    ]);
  });

  it("compares drive-letter and UNC paths case-insensitively", () => {
    expect(hostPathsEqual("c:\\Users\\Dev\\", "C:\\users\\dev", "win32")).toBe(true);
    expect(
      hostPathsEqual("\\\\WSL.localhost\\Ubuntu\\x", "\\\\wsl.localhost\\ubuntu\\X", "win32"),
    ).toBe(true);
    expect(hostPathsEqual("/home/Dev", "/home/dev", "linux")).toBe(false);
  });

  it("finds the .cmd launcher npm installs, not its extensionless POSIX script", async () => {
    const npmDir = await tempDir();
    const excludedDir = await tempDir();
    await fs.writeFile(path.join(npmDir, "codex"), "#!/bin/sh\n");
    await fs.writeFile(path.join(npmDir, "codex.cmd"), "@echo off\r\n");
    await fs.writeFile(path.join(excludedDir, "codex.exe"), "");
    const found = await findHostExecutable(["codex"], {
      platform: "win32",
      env: { Path: `${excludedDir};${npmDir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      excludeDirs: [excludedDir.toUpperCase()],
    });
    expect(found).toBe(path.join(npmDir, "codex.cmd"));
  });

  it("prefers harness install directories over PATH", async () => {
    const installDir = await tempDir();
    const pathDir = await tempDir();
    await fs.writeFile(path.join(installDir, "claude.exe"), "");
    await fs.writeFile(path.join(pathDir, "claude.cmd"), "");
    expect(
      await findHostExecutable(["claude"], {
        platform: "win32",
        env: { PATH: pathDir },
        preferredDirs: [installDir],
      }),
    ).toBe(path.join(installDir, "claude.exe"));
  });

  it("returns an absolute path for a relative PATH entry on win32", async () => {
    const pathDir = await tempDir();
    await fs.writeFile(path.join(pathDir, "bun.cmd"), "@echo off\r\n");
    // `.\node_modules\.bin`-style entries: the caller spawns under another cwd, so a relative
    // result would name a different file there.
    const found = await findHostExecutable(["bun"], {
      platform: "win32",
      env: { PATH: path.relative(process.cwd(), pathDir), PATHEXT: ".EXE;.CMD" },
    });
    expect(found).toBe(path.join(pathDir, "bun.cmd"));
    expect(found !== null && path.isAbsolute(found)).toBe(true);
  });

  it("runs batch launchers through cmd.exe with a verbatim, quoted command line", () => {
    expect(
      harnessCommandInvocation(
        "C:\\Users\\Dev User\\AppData\\Roaming\\npm\\codex.cmd",
        ["--version"],
        {
          platform: "win32",
          env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
        },
      ),
    ).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\Dev User\\AppData\\Roaming\\npm\\codex.cmd" --version"',
      ],
      windowsVerbatimArguments: true,
    });
    expect(
      harnessCommandInvocation("C:\\bin\\omp.exe", ["--version"], { platform: "win32" }),
    ).toEqual({
      file: "C:\\bin\\omp.exe",
      args: ["--version"],
      windowsVerbatimArguments: false,
    });
    expect(() =>
      harnessCommandInvocation("C:\\bin\\x.cmd", ["%PATH%"], { platform: "win32", env: {} }),
    ).toThrow(/non-literal/);
    expect(() =>
      harnessCommandInvocation("C:\\a&b\\x.cmd", ["--version"], { platform: "win32", env: {} }),
    ).toThrow(/reinterpret/);
  });

  it.runIf(process.platform === "win32")(
    "runs a real .cmd launcher in a directory with spaces",
    async () => {
      const dir = await tempDir();
      const launcher = path.join(dir, "fake harness.cmd");
      await fs.writeFile(launcher, "@echo off\r\necho fake-harness 1.2.3 %1\r\n");
      const { stdout } = await runHarnessCommand(launcher, ["--version"]);
      expect(stdout.trim()).toBe("fake-harness 1.2.3 --version");
    },
  );
});
