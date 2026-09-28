import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PurgeFs,
  defaultStagingDir,
  deferredRemovalScript,
  purgeWindowsTree,
  scheduleWindowsDeferredRemoval,
} from "../../src/commands/windows-purge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; home: string; locked: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-purge-"));
  temporaryDirectories.push(root);
  const home = path.join(root, ".resin");
  const prebuilds = path.join(home, "versions", "v1.0.3", "prebuilds", "win32-x64");
  await fs.mkdir(prebuilds, { recursive: true });
  await fs.mkdir(path.join(home, "bin"), { recursive: true });
  await fs.writeFile(path.join(home, "bin", "resin.cmd"), "@echo off\r\n");
  await fs.writeFile(path.join(home, "versions", "v1.0.3", "cli.js"), "export {};\n");
  const locked = path.join(prebuilds, "resin_windows_security.node");
  await fs.writeFile(locked, "binary");
  return { root, home, locked };
}

function eperm(target: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, unlink '${target}'`), {
    code: "EPERM",
  });
}

/** Real fs, except `locked` behaves like a mapped image: undeletable, renamable. */
function mappedImageFs(locked: string): PurgeFs {
  return {
    rm: async (target, options) => {
      if (target === locked || (options.recursive && locked.startsWith(target + path.sep))) {
        throw eperm(locked);
      }
      await fs.rm(target, options);
    },
    readdir: (target) => fs.readdir(target, { withFileTypes: true }),
    unlink: async (target) => {
      if (target === locked) throw eperm(target);
      await fs.unlink(target);
    },
    chmod: (target, mode) => fs.chmod(target, mode),
    rename: (from, to) => fs.rename(from, to),
    rmdir: (target) => fs.rmdir(target),
    mkdir: (target, options) => fs.mkdir(target, options),
  };
}

describe("purging the Resin home on Windows", () => {
  it("removes an unlocked tree outright", async () => {
    const { home } = await fixture();
    expect(await purgeWindowsTree(home)).toEqual({ removed: true, stagedFiles: [], remaining: [] });
    expect(existsSync(home)).toBe(false);
  });

  it("moves a mapped file out of the tree so the Resin home disappears", async () => {
    const { root, home, locked } = await fixture();
    const stagingDir = path.join(root, "staging");
    const result = await purgeWindowsTree(home, {
      stagingDir,
      fsOps: mappedImageFs(locked),
      retryDelayMs: 0,
    });

    expect(result).toEqual({
      removed: true,
      stagedFiles: [path.join(stagingDir, "0-resin_windows_security.node")],
      stagingDir,
      remaining: [],
    });
    expect(existsSync(home)).toBe(false);
    expect(await fs.readFile(result.stagedFiles[0] ?? "", "utf8")).toBe("binary");
  });

  it("reports what can be neither deleted nor moved", async () => {
    const { root, home, locked } = await fixture();
    const fsOps = mappedImageFs(locked);
    const result = await purgeWindowsTree(home, {
      stagingDir: path.join(root, "staging"),
      fsOps: { ...fsOps, rename: async (from) => Promise.reject(eperm(from)) },
      retryDelayMs: 0,
    });

    expect(result.removed).toBe(false);
    expect(result.remaining).toEqual([locked]);
    expect(existsSync(path.join(home, "bin"))).toBe(false);
  });

  it("leaves kept paths (the running launcher's bin) for the deferred cleanup", async () => {
    const { home } = await fixture();
    const bin = path.join(home, "bin");
    const result = await purgeWindowsTree(home, { keep: [bin], retryDelayMs: 0 });

    expect(result).toEqual({ removed: false, stagedFiles: [], remaining: [bin] });
    expect(existsSync(path.join(bin, "resin.cmd"))).toBe(true);
    expect(existsSync(path.join(home, "versions"))).toBe(false);
  });

  it("stages on the Resin home's volume", () => {
    expect(defaultStagingDir("C:\\Users\\dev\\.resin", "C:\\Temp")).toMatch(
      /^C:\\Temp[\\/]resin-uninstall-\d+-[0-9a-f]{8}$/,
    );
    expect(
      path.basename(path.dirname(defaultStagingDir("D:\\profiles\\dev\\.resin", "C:\\Temp"))),
    ).toBe(path.basename(path.dirname(path.resolve("D:\\profiles\\dev\\.resin"))));
  });

  it("waits for the uninstalling process before removing, quoting paths literally", () => {
    const script = deferredRemovalScript(["C:\\Users\\O'Neil\\.resin", "C:\\Temp\\stage"], 4242);
    expect(script).toContain("Wait-Process -Id 4242 -Timeout 600\nStart-Sleep -Seconds 1");
    expect(script).toContain("$paths = @('C:\\Users\\O''Neil\\.resin', 'C:\\Temp\\stage')");
    expect(script).toContain("Remove-Item -LiteralPath $path -Recurse -Force");
    expect(() => deferredRemovalScript([], 0)).toThrow(/process id/);
  });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const addon = path.join(
  repoRoot,
  "packages",
  "windows-security",
  "prebuilds",
  `win32-${process.arch}`,
  "resin_windows_security.node",
);

describe.runIf(process.platform === "win32" && existsSync(addon))(
  "purging on native Windows",
  () => {
    it("removes a Resin home whose native addon this process has loaded", async () => {
      const { home, locked } = await fixture();
      await fs.copyFile(addon, locked);
      createRequire(import.meta.url)(locked);
      await expect(fs.unlink(locked)).rejects.toMatchObject({ code: "EPERM" });

      const result = await purgeWindowsTree(home, { retryDelayMs: 0 });

      expect(result.removed).toBe(true);
      expect(result.remaining).toEqual([]);
      expect(result.stagedFiles).toHaveLength(1);
      expect(existsSync(home)).toBe(false);
      // The addon stays mapped by this worker; the cleanup removes it once the worker exits.
      if (result.stagingDir !== undefined) scheduleWindowsDeferredRemoval([result.stagingDir]);
    });

    it("the deferred cleanup runs outside this process and removes paths after it exits", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "resin-deferred-"));
      temporaryDirectories.push(root);
      const target = path.join(root, "leftover");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "file.txt"), "x");
      // Wait on a short-lived stand-in for "this process".
      const standIn = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Start-Process -FilePath ping.exe -ArgumentList '-n','3','127.0.0.1' -WindowStyle Hidden -PassThru).Id",
        ],
        { encoding: "utf8", windowsHide: true },
      ).trim();

      scheduleWindowsDeferredRemoval([target], { waitPid: Number(standIn) });
      expect(existsSync(target)).toBe(true);
      // Blocks outside the event loop until the cleanup has had time to run.
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath '${target}'); $i++) { Start-Sleep -Milliseconds 500 }`,
        ],
        { windowsHide: true },
      );
      expect(existsSync(target)).toBe(false);
    }, 60_000);
  },
);
