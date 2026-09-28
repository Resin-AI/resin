/**
 * Removing Resin's home on native Windows.
 *
 * The uninstalling `resin` process runs from the tree it deletes: it has the
 * `@resin/windows-security` addon (`.node`) mapped from `versions\`, and the
 * `resin.cmd` launcher's cmd.exe still has `bin\` in use. Windows refuses to
 * delete a mapped image but allows renaming it, so locked files are moved out
 * of the Resin home into a staging directory on the same volume, and a detached
 * cleanup removes the staging directory (and anything else still in use) once
 * this process has exited. `bin\` is left to that cleanup: cmd.exe re-reads the
 * running `resin.cmd` after node exits, and fails the command (exit 1, "The
 * system cannot find the path specified") if the launcher is already gone.
 *
 * Never pass `maxRetries` to the asynchronous `fs.rm`: on Windows (Node 24) it
 * never settles when the tree holds a mapped DLL, which hung `resin uninstall`.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_ERROR_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isLockError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && LOCK_ERROR_CODES.has(code);
}

/** The filesystem calls the purge needs; tests inject failures through this. */
export interface PurgeFs {
  rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  readdir(target: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  unlink(target: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir(target: string): Promise<void>;
  mkdir(target: string, options: { recursive: boolean }): Promise<unknown>;
}

const nodePurgeFs: PurgeFs = {
  rm: (target, options) => fs.rm(target, options),
  readdir: (target) => fs.readdir(target, { withFileTypes: true }),
  unlink: (target) => fs.unlink(target),
  chmod: (target, mode) => fs.chmod(target, mode),
  rename: (from, to) => fs.rename(from, to),
  rmdir: (target) => fs.rmdir(target),
  mkdir: (target, options) => fs.mkdir(target, options),
};

/**
 * `fs.rm` with a bounded retry for transient Windows locks (a process that just
 * exited releasing its files). Rejects with the last error when it cannot.
 */
export async function removeTreeWithRetries(
  target: string,
  options: { attempts?: number; delayMs?: number; fsOps?: PurgeFs } = {},
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const fsOps = options.fsOps ?? nodePurgeFs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsOps.rm(target, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      if (!isLockError(error) || attempt >= attempts) throw error;
      await sleep(options.delayMs ?? 250);
    }
  }
}

export interface WindowsPurgeResult {
  /** The target no longer exists. */
  readonly removed: boolean;
  /** Locked files moved out of the target, awaiting deferred removal. */
  readonly stagedFiles: readonly string[];
  /** The staging directory holding `stagedFiles`, if one was created. */
  readonly stagingDir?: string;
  /** Paths still inside the target (in use and not movable). */
  readonly remaining: readonly string[];
}

/** A staging directory on the same volume as `target`, so renames never cross devices. */
export function defaultStagingDir(target: string, tmpDir: string = os.tmpdir()): string {
  const id = `resin-uninstall-${process.pid}-${randomUUID().slice(0, 8)}`;
  const sameVolume =
    path.win32.parse(path.win32.resolve(tmpDir)).root.toLowerCase() ===
    path.win32.parse(path.win32.resolve(target)).root.toLowerCase();
  return sameVolume
    ? path.join(tmpDir, id)
    : path.join(path.dirname(path.resolve(target)), `.${id}`);
}

/**
 * Deletes `target`; files Windows keeps in use are moved to a staging directory
 * so the target itself disappears. Never throws for locked files; reports them.
 */
export async function purgeWindowsTree(
  target: string,
  options: {
    stagingDir?: string;
    fsOps?: PurgeFs;
    retryDelayMs?: number;
    /** Paths inside `target` to leave for the deferred cleanup (reported as remaining). */
    keep?: readonly string[];
  } = {},
): Promise<WindowsPurgeResult> {
  const fsOps = options.fsOps ?? nodePurgeFs;
  const keep = new Set((options.keep ?? []).map((entry) => path.resolve(entry).toLowerCase()));
  if (keep.size === 0) {
    try {
      await removeTreeWithRetries(target, { fsOps, delayMs: options.retryDelayMs });
      return { removed: true, stagedFiles: [], remaining: [] };
    } catch (error: unknown) {
      if (!isLockError(error)) throw error;
    }
  }

  const stagingDir = options.stagingDir ?? defaultStagingDir(target);
  const stagedFiles: string[] = [];
  const remaining: string[] = [];
  let stagingReady = false;

  const stage = async (file: string): Promise<boolean> => {
    try {
      if (!stagingReady) {
        await fsOps.mkdir(stagingDir, { recursive: true });
        stagingReady = true;
      }
      const destination = path.join(stagingDir, `${stagedFiles.length}-${path.basename(file)}`);
      await fsOps.rename(file, destination);
      stagedFiles.push(destination);
      return true;
    } catch {
      return false;
    }
  };

  const removeFile = async (file: string): Promise<void> => {
    try {
      await fsOps.unlink(file);
      return;
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
    }
    try {
      // A read-only attribute also surfaces as EPERM.
      await fsOps.chmod(file, 0o666);
      await fsOps.unlink(file);
      return;
    } catch {
      // Still in use (a mapped image or an open handle).
    }
    if (!(await stage(file))) remaining.push(file);
  };

  const drain = async (directory: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fsOps.readdir(directory);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") remaining.push(directory);
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (keep.has(path.resolve(child).toLowerCase())) {
        remaining.push(child);
        continue;
      }
      if (entry.isDirectory()) {
        await drain(child);
      } else {
        // Files, symlinks and junctions (reported as links) are removed, never followed.
        try {
          await fsOps.rm(child, { recursive: false, force: true });
        } catch {
          await removeFile(child);
        }
      }
    }
    try {
      await fsOps.rmdir(directory);
    } catch (error: unknown) {
      const code = errorCode(error);
      // A directory still holding an unmovable file is covered by that file's entry;
      // otherwise it is some process's working directory.
      if (code !== "ENOENT" && !remaining.some((entry) => entry.startsWith(directory + path.sep))) {
        remaining.push(directory);
      }
    }
  };

  await drain(target);
  const result: {
    removed: boolean;
    stagedFiles: string[];
    remaining: string[];
    stagingDir?: string;
  } = { removed: remaining.length === 0, stagedFiles, remaining };
  if (stagingReady) result.stagingDir = stagingDir;
  return result;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** PowerShell run by the deferred cleanup: wait for `waitPid`, then retry removal. */
export function deferredRemovalScript(paths: readonly string[], waitPid: number): string {
  if (!Number.isSafeInteger(waitPid) || waitPid <= 0) {
    throw new Error(`Invalid process id for deferred removal: ${waitPid}`);
  }
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${waitPid} -Timeout 600`,
    // Let the launching cmd.exe finish reading resin.cmd before it disappears.
    "Start-Sleep -Seconds 1",
    `$paths = @(${paths.map(powershellLiteral).join(", ")})`,
    "for ($attempt = 0; $attempt -lt 150; $attempt++) {",
    "  $left = @($paths | Where-Object { Test-Path -LiteralPath $_ })",
    "  if ($left.Count -eq 0) { break }",
    "  foreach ($path in $left) { Remove-Item -LiteralPath $path -Recurse -Force }",
    "  Start-Sleep -Seconds 2",
    "}",
  ].join("\n");
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Removes still-locked Windows paths after this process exits. The cleanup is
 * created through WMI (Win32_Process.Create), so it inherits none of our handles
 * (a caller reading our stdout sees EOF as soon as we exit) and is outside any
 * job object that would kill it together with us.
 */
export function scheduleWindowsDeferredRemoval(
  paths: readonly string[],
  options: { waitPid?: number; env?: Record<string, string | undefined> } = {},
): void {
  if (paths.length === 0) return;
  const env = options.env ?? process.env;
  const powershell = path.win32.join(
    env.SystemRoot ?? env.windir ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const cleanup = deferredRemovalScript(paths, options.waitPid ?? process.pid);
  const commandLine = `"${powershell}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(cleanup)}`;
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellLiteral(commandLine)}; CurrentDirectory = ${powershellLiteral(os.tmpdir())} }`,
    "exit [int]$result.ReturnValue",
  ].join("\n");
  const launched = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(launcher)],
    { stdio: "ignore", windowsHide: true, timeout: 30_000 },
  );
  if (launched.error !== undefined) {
    throw launched.error;
  }
  if (launched.status !== 0) {
    throw new Error(`Could not start deferred cleanup (exit ${launched.status ?? "signal"})`);
  }
}
