/**
 * Native Windows install surface: the launchers Resin publishes in `<RESIN_HOME>\bin`, the
 * `current`/`previous` directory junctions, and the per-user PATH entry.
 *
 * Launchers are relative to their own location (`%~dp0` in batch files, relative module
 * specifiers in the `.mjs` entries), so no absolute path, backslash escape or `%` in a user name
 * ever reaches a batch or import string.
 */

import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** Entry points every release ships as extensionless ESM files under `bin/`. */
export const WINDOWS_LAUNCHER_NAMES = Object.freeze(["resin", "resin-daemon", "resin-gateway"]);

const LAUNCHER_NAME_PATTERN = /^resin(?:-[a-z0-9]+)*$/;
const RELEASE_DIRECTORY_PATTERN = /^v[0-9A-Za-z.+-]+$/;
const WINDOWS_LAUNCHER_FILE_PATTERN = /^resin(?:-[a-z0-9]+)*\.(?:cmd|mjs)$/;

function assertLauncherName(name: string): void {
  if (!LAUNCHER_NAME_PATTERN.test(name)) {
    throw new Error(`Refusing to publish a Windows launcher for unexpected entry '${name}'.`);
  }
}

function releaseDirectoryName(version: string): string {
  const directory = version.startsWith("v") ? version : `v${version}`;
  if (!RELEASE_DIRECTORY_PATTERN.test(directory) || directory.includes("..")) {
    throw new Error(`Refusing to publish Windows launchers for invalid release '${version}'.`);
  }
  return directory;
}

/**
 * Batch launcher in `<RESIN_HOME>\bin` for one entry of the given release. One line that ends
 * the batch itself (`call exit /b` keeps node's exit code), so cmd.exe never reads on from a
 * launcher an update replaced while it ran.
 */
export function windowsGlobalCmdLauncher(version: string, name: string): string {
  assertLauncherName(name);
  const release = releaseDirectoryName(version);
  return `@node "%~dp0..\\versions\\${release}\\bin\\${name}" %* & call exit /b %%errorlevel%%\r\n`;
}

/**
 * Stable node-runnable entry in `<RESIN_HOME>\bin` (`node.exe <RESIN_HOME>\bin\resin.mjs`), for
 * callers that must not go through cmd.exe (scheduled task, MCP registrations).
 */
export function windowsGlobalModuleLauncher(version: string, name: string): string {
  assertLauncherName(name);
  return `import "../versions/${releaseDirectoryName(version)}/bin/${name}";\n`;
}

export function windowsLauncherFileNames(
  names: readonly string[] = WINDOWS_LAUNCHER_NAMES,
): string[] {
  return names.flatMap((name) => [`${name}.cmd`, `${name}.mjs`]);
}

/** Every `<RESIN_HOME>\bin` path Resin may create on Windows (for rollback and uninstall). */
export function windowsLauncherPaths(resinHome: string): string[] {
  const binDir = path.join(resinHome, "bin");
  return windowsLauncherFileNames().map((fileName) => path.join(binDir, fileName));
}

/** Names of the release entries that get a launcher: extensionless files in `<release>/bin`. */
export function windowsLauncherNamesForRelease(releaseDir: string): string[] {
  const names = new Set<string>(["resin", "resin-daemon"]);
  const binDir = path.join(releaseDir, "bin");
  if (fs.existsSync(binDir)) {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.includes(".") || entry.name === "resin-mcp") continue;
      if (LAUNCHER_NAME_PATTERN.test(entry.name) && !/-(?:linux|darwin|win32)-/.test(entry.name)) {
        names.add(entry.name);
      }
    }
  }
  return [...names].filter((name) => fs.existsSync(path.join(binDir, name)));
}

function tempSibling(target: string, label: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${label}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
  );
}

function writeFileAtomic(target: string, content: string | Buffer): void {
  const temp = tempSibling(target, "tmp");
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readFileIfExists(filePath: string): Buffer | null {
  try {
    return fs.lstatSync(filePath).isFile() ? fs.readFileSync(filePath) : null;
  } catch {
    return null;
  }
}

export interface WindowsLauncherTransaction {
  readonly published: readonly string[];
  /** Restores the launcher set that existed before `publishWindowsLaunchers`. */
  rollback(): void;
}

/**
 * Publishes `<name>.cmd` + `<name>.mjs` launchers for `version` into `<RESIN_HOME>\bin`, one
 * atomic file replacement at a time. The directory itself is never swapped: cmd.exe keeps a
 * running launcher's directory busy, so a directory rename fails while any `resin` command
 * (including the one running an update) is executing. Stale Resin launchers are removed.
 */
export function publishWindowsLaunchers(options: {
  readonly resinHome: string;
  readonly version: string;
  readonly names: readonly string[];
}): WindowsLauncherTransaction {
  const binDir = path.join(options.resinHome, "bin");
  const stats = fs.lstatSync(binDir, { throwIfNoEntry: false });
  if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
    throw new Error(`Security violation: Resin bin path must be a real directory: '${binDir}'.`);
  }
  const createdBinDir = !stats;
  if (createdBinDir) fs.mkdirSync(binDir, { recursive: true });

  const desired = new Map<string, string>();
  for (const name of options.names) {
    desired.set(`${name}.cmd`, windowsGlobalCmdLauncher(options.version, name));
    desired.set(`${name}.mjs`, windowsGlobalModuleLauncher(options.version, name));
  }
  const stale = fs
    .readdirSync(binDir)
    .filter((fileName) => WINDOWS_LAUNCHER_FILE_PATTERN.test(fileName) && !desired.has(fileName));

  const prior = new Map<string, Buffer | null>();
  const published: string[] = [];
  const rollback = () => {
    for (const [fileName, content] of prior) {
      const target = path.join(binDir, fileName);
      try {
        if (content === null) fs.rmSync(target, { force: true });
        else writeFileAtomic(target, content);
      } catch {
        // Best effort: keep restoring the remaining launchers.
      }
    }
    if (createdBinDir) {
      try {
        fs.rmdirSync(binDir);
      } catch {}
    }
  };

  try {
    for (const [fileName, content] of desired) {
      const target = path.join(binDir, fileName);
      prior.set(fileName, readFileIfExists(target));
      writeFileAtomic(target, content);
      published.push(target);
    }
    for (const fileName of stale) {
      const target = path.join(binDir, fileName);
      prior.set(fileName, readFileIfExists(target));
      fs.rmSync(target, { force: true });
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return { published, rollback };
}

/** Removes every launcher Resin publishes in `<RESIN_HOME>\bin`; returns the removed paths. */
export async function removeWindowsLaunchers(options: {
  readonly resinHome: string;
}): Promise<string[]> {
  const binDir = path.join(options.resinHome, "bin");
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(binDir);
  } catch {
    return removed;
  }
  for (const fileName of entries) {
    if (!WINDOWS_LAUNCHER_FILE_PATTERN.test(fileName)) continue;
    const target = path.join(binDir, fileName);
    try {
      await fs.promises.rm(target, { force: true });
      removed.push(target);
    } catch {
      // A launcher that cannot be removed now is left for the resin home purge.
    }
  }
  return removed;
}

export type WindowsPointerSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "file"; readonly content: Buffer }
  | { readonly kind: "other" };

export function snapshotWindowsPointer(pointerPath: string): WindowsPointerSnapshot {
  const stats = fs.lstatSync(pointerPath, { throwIfNoEntry: false });
  if (!stats) return { kind: "absent" };
  if (stats.isSymbolicLink()) return { kind: "link", target: fs.readlinkSync(pointerPath) };
  if (stats.isFile()) return { kind: "file", content: fs.readFileSync(pointerPath) };
  return { kind: "other" };
}

/** Removes a junction/symlink or pointer file without ever following it into its target. */
export function removeWindowsPointer(pointerPath: string): void {
  const stats = fs.lstatSync(pointerPath, { throwIfNoEntry: false });
  if (!stats) return;
  if (stats.isSymbolicLink() || stats.isFile()) {
    fs.unlinkSync(pointerPath);
    return;
  }
  throw new Error(
    `Refusing to replace '${pointerPath}': it is a real directory, not a Resin junction.`,
  );
}

/**
 * Points `<RESIN_HOME>\<name>` at `targetDir` with a directory junction (no administrator
 * rights or Developer Mode needed) and always records `version` in the pointer file too, so the
 * active version stays readable where junctions are unavailable (FAT/exFAT, some shares).
 * Windows cannot rename a junction over another, so the pointer file is committed first and the
 * junction is replaced right after; a failed junction never leaves a stale one behind.
 */
export function setWindowsReleasePointer(options: {
  readonly resinHome: string;
  readonly name: "current" | "previous";
  readonly targetDir: string;
  readonly version: string;
}): { readonly junction: boolean } {
  const pointerPath = path.join(options.resinHome, options.name);
  writeFileAtomic(path.join(options.resinHome, `${options.name}-version`), options.version);

  const temp = tempSibling(pointerPath, "tmp");
  try {
    fs.symlinkSync(options.targetDir, temp, "junction");
  } catch {
    removeWindowsPointer(pointerPath);
    return { junction: false };
  }
  try {
    try {
      fs.renameSync(temp, pointerPath);
    } catch {
      removeWindowsPointer(pointerPath);
      fs.renameSync(temp, pointerPath);
    }
    return { junction: true };
  } catch (error) {
    try {
      removeWindowsPointer(temp);
    } catch {}
    throw error;
  }
}

export function restoreWindowsPointer(pointerPath: string, snapshot: WindowsPointerSnapshot): void {
  if (snapshot.kind === "other") return;
  removeWindowsPointer(pointerPath);
  if (snapshot.kind === "link") {
    fs.symlinkSync(snapshot.target, pointerPath, "junction");
  } else if (snapshot.kind === "file") {
    writeFileAtomic(pointerPath, snapshot.content);
  }
}

/**
 * Moves a release directory out of `versions` before deleting it, so a directory that cannot be
 * deleted completely (a file held open by a running daemon) is never left half-deleted under its
 * version name. Returns false when the directory is busy and was left untouched.
 */
export async function removeWindowsReleaseDirectory(versionDir: string): Promise<void> {
  const trash = path.join(
    path.dirname(versionDir),
    `.trash-${path.basename(versionDir)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await fs.promises.rename(versionDir, trash);
  await fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {});
}

/** Best-effort removal of release directories an earlier prune could not finish deleting. */
export async function removeWindowsReleaseTrash(versionsDir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".trash-v")) {
      await fs.promises
        .rm(path.join(versionsDir, entry.name), { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

/**
 * How to start a Resin JS entry: Windows cannot execute an extensionless shebang file or a
 * `.mjs`, so those run through the current node executable.
 */
export function resolveLauncherInvocation(
  cliPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): { readonly command: string; readonly args: string[] } {
  if (platform === "win32" && !/\.(?:exe|com)$/i.test(cliPath)) {
    return { command: nodePath, args: [cliPath, ...args] };
  }
  return { command: cliPath, args: [...args] };
}

// ---------------------------------------------------------------------------------------------
// Per-user PATH (HKCU\Environment\Path)
// ---------------------------------------------------------------------------------------------

export interface WindowsPathRunnerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a Windows PowerShell script with extra environment variables. */
export type WindowsPathRunner = (
  script: string,
  env: Readonly<Record<string, string>>,
) => Promise<WindowsPathRunnerResult>;

export interface WindowsUserPathResult {
  readonly attempted: boolean;
  /** The registry value was rewritten. */
  readonly changed: boolean;
  /** The entry is in the user PATH after the call. */
  readonly present: boolean;
  readonly binDir: string;
  readonly error?: string;
  readonly reason?: string;
}

export interface WindowsUserPathOptions {
  readonly resinHome: string;
  readonly runner?: WindowsPathRunner;
  readonly platform?: NodeJS.Platform;
  /**
   * HKCU subkey holding the Path value. Defaults to `Environment`; tests point it at a scratch
   * key so the real user PATH is never touched. Only `Environment` changes are broadcast.
   */
  readonly registryKey?: string;
}

/**
 * Reads the raw (unexpanded) user Path, adds or removes one entry comparing expanded,
 * case-insensitive, trailing-backslash-insensitive forms, preserves REG_EXPAND_SZ, and
 * broadcasts WM_SETTINGCHANGE through .NET's SetEnvironmentVariable so Explorer and new
 * terminals see the change without a logoff.
 */
export const WINDOWS_USER_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$entry = $env:RESIN_PATH_ENTRY
$mode = $env:RESIN_PATH_MODE
$subKey = $env:RESIN_PATH_REGISTRY_KEY
if ([string]::IsNullOrWhiteSpace($subKey)) { $subKey = 'Environment' }
function Normalize-ResinPathEntry([string]$value) {
  $expanded = [Environment]::ExpandEnvironmentVariables($value.Trim().Trim('"'))
  if ($expanded.Length -gt 3) { $expanded = $expanded.TrimEnd('\') }
  return $expanded.ToLowerInvariant()
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
try {
  $names = $key.GetValueNames()
  $hasPath = $names -contains 'Path'
  $raw = ''
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($hasPath) {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $key.GetValueKind('Path')
  }
  $target = Normalize-ResinPathEntry $entry
  $parts = @($raw -split ';' | Where-Object { $_.Trim().Length -gt 0 })
  $kept = @($parts | Where-Object { (Normalize-ResinPathEntry $_) -ne $target })
  $present = $kept.Count -ne $parts.Count
  $changed = $false
  if ($mode -eq 'add' -and -not $present) {
    $kept += $entry
    $key.SetValue('Path', ($kept -join ';'), $kind)
    $changed = $true
    $present = $true
  } elseif ($mode -eq 'remove' -and $present) {
    if ($kept.Count -eq 0) { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', ($kept -join ';'), $kind) }
    $changed = $true
    $present = $false
  }
} finally {
  $key.Close()
}
if ($changed -and $subKey -eq 'Environment') {
  [Environment]::SetEnvironmentVariable('RESIN_PATH_REFRESH', $null, [EnvironmentVariableTarget]::User)
}
Write-Output ('{"changed":' + $changed.ToString().ToLowerInvariant() + ',"present":' + $present.ToString().ToLowerInvariant() + '}')
`;

export const defaultWindowsPathRunner: WindowsPathRunner = (script, env) => {
  const { promise, resolve } = Promise.withResolvers<WindowsPathRunnerResult>();
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  child_process.execFile(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 },
    (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
    },
  );
  return promise;
};

async function updateWindowsUserPath(
  mode: "add" | "remove",
  options: WindowsUserPathOptions,
): Promise<WindowsUserPathResult> {
  const binDir = path.join(path.resolve(options.resinHome), "bin");
  if ((options.platform ?? process.platform) !== "win32") {
    return { attempted: false, changed: false, present: false, binDir, reason: "not-windows" };
  }
  const runner = options.runner ?? defaultWindowsPathRunner;
  try {
    const result = await runner(WINDOWS_USER_PATH_SCRIPT, {
      RESIN_PATH_ENTRY: binDir,
      RESIN_PATH_MODE: mode,
      RESIN_PATH_REGISTRY_KEY: options.registryKey ?? "Environment",
    });
    const line = result.stdout
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .reverse()
      .find((candidate) => candidate.startsWith("{"));
    if (result.exitCode !== 0 || !line) {
      return {
        attempted: true,
        changed: false,
        present: mode === "remove",
        binDir,
        error: (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim(),
      };
    }
    const parsed: unknown = JSON.parse(line);
    const changed = parsed instanceof Object && "changed" in parsed && parsed.changed === true;
    const present = parsed instanceof Object && "present" in parsed && parsed.present === true;
    return { attempted: true, changed, present, binDir };
  } catch (error) {
    return {
      attempted: true,
      changed: false,
      present: mode === "remove",
      binDir,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Adds `<RESIN_HOME>\bin` to the per-user PATH (idempotent). */
export function addWindowsUserPath(
  options: WindowsUserPathOptions,
): Promise<WindowsUserPathResult> {
  return updateWindowsUserPath("add", options);
}

/** Removes `<RESIN_HOME>\bin` from the per-user PATH; no-op off win32. Used by `resin uninstall`. */
export function removeWindowsUserPath(
  options: WindowsUserPathOptions,
): Promise<WindowsUserPathResult> {
  return updateWindowsUserPath("remove", options);
}
