import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Host facts a harness probe reads: injected in tests, `process.*` in production. On native
 * Windows (`win32`) environment names are case-insensitive, `PATH` is `;`-separated and
 * extensionless launchers (npm's POSIX `codex` script, say) are not runnable.
 */
export interface HarnessHost {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Reads one environment variable. Windows treats names case-insensitively (`Path`, `PATH`), so on
 * `win32` a plain injected object is searched the same way the real `process.env` behaves.
 */
export function readHostEnv(
  env: EnvLike,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined || platform !== "win32") return nonEmpty(exact);
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return nonEmpty(value);
  }
  return undefined;
}

/**
 * Reads an environment variable naming a directory or file (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
 * `OMP_HOME`, …) and resolves it to an absolute host path.
 *
 * On a native Windows host a value rooted at `/` without a drive (`/home/dev/.codex`) is ignored: it is
 * a Linux path leaked in through WSL interop (`WSLENV`), which the harness itself cannot use,
 * and resolving it would point Resin at `C:\home\dev\.codex` instead of the real home.
 */
export function readHostPathEnv(
  env: EnvLike,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const value = readHostEnv(env, name, platform)?.trim();
  if (value === undefined) return undefined;
  // Only a real Windows host receives WSL's variables; an injected `win32` platform on a POSIX
  // test host still names real POSIX directories.
  if (platform === "win32" && process.platform === "win32" && /^\/(?!\/)/.test(value)) {
    return undefined;
  }
  return path.resolve(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * The home directory a harness expands `~` against.
 *
 * - POSIX: `$HOME`, else `os.homedir()`.
 * - Windows: `%USERPROFILE%` (what Node/Bun `os.homedir()` returns, so what Claude Code and OMP
 *   use; Rust's `dirs::home_dir()` used by Codex reads the same profile folder), else
 *   `%HOMEDRIVE%%HOMEPATH%`, else `os.homedir()`. `HOME` is ignored on Windows: Git Bash/MSYS
 *   and some toolchains set it to a value none of these harnesses read.
 */
export function resolveHarnessUserHome(
  options: HarnessHost & { homedir?: () => string } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fallback = options.homedir ?? os.homedir;
  if (platform === "win32") {
    const profile = readHostEnv(env, "USERPROFILE", platform);
    if (profile) return profile;
    const drive = readHostEnv(env, "HOMEDRIVE", platform);
    const homePath = readHostEnv(env, "HOMEPATH", platform);
    if (drive && homePath) return `${drive}${homePath}`;
    return fallback();
  }
  return readHostEnv(env, "HOME", platform) ?? fallback();
}

/** Extensions Windows can launch directly or through `cmd.exe` (the rest need their own hosts). */
const RUNNABLE_WINDOWS_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const DEFAULT_PATHEXT = [".com", ".exe", ".bat", ".cmd"];

/**
 * Executable extensions to try on Windows, in `PATHEXT` order (lower-cased), limited to ones that
 * run without another interpreter. Unset or empty `PATHEXT` falls back to Windows' default order.
 */
export function windowsExecutableExtensions(env: EnvLike = process.env): string[] {
  const raw = readHostEnv(env, "PATHEXT", "win32");
  const listed = (raw ?? "")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => RUNNABLE_WINDOWS_EXTENSIONS.has(extension));
  return listed.length > 0 ? [...new Set(listed)] : [...DEFAULT_PATHEXT];
}

/**
 * The file names a command name can resolve to. On Windows a name that already carries a runnable
 * extension is kept as-is; otherwise each `PATHEXT` extension is appended. The bare name is never
 * tried on Windows: npm and Bun drop an extensionless POSIX script beside the `.cmd`/`.exe`.
 */
export function executableFileNames(name: string, host: HarnessHost = {}): string[] {
  const platform = host.platform ?? process.platform;
  if (platform !== "win32") return [name];
  const extension = path.win32.extname(name).toLowerCase();
  if (RUNNABLE_WINDOWS_EXTENSIONS.has(extension)) return [name];
  return windowsExecutableExtensions(host.env ?? process.env).map(
    (candidate) => `${name}${candidate}`,
  );
}

/**
 * Directories on the host `PATH`, in order. Windows entries may be quoted and are `;`-separated.
 */
export function hostSearchPath(host: HarnessHost = {}): string[] {
  const platform = host.platform ?? process.platform;
  const raw = readHostEnv(host.env ?? process.env, "PATH", platform) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  return raw
    .split(delimiter)
    .map((entry) => (platform === "win32" ? entry.trim().replace(/^"(.*)"$/, "$1") : entry))
    .filter((entry) => entry.length > 0);
}

/** Canonical form for comparing two host paths: Windows paths compare case-insensitively. */
export function hostPathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path.posix.normalize(value);
  return path.win32
    .normalize(value)
    .replace(/[\\]+$/, "")
    .toLowerCase();
}

/** Whether two host paths name the same location (case-insensitive on Windows). */
export function hostPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return hostPathKey(left, platform) === hostPathKey(right, platform);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export interface FindHostExecutableOptions extends HarnessHost {
  /** Directories searched before `PATH` (harness install locations). */
  readonly preferredDirs?: readonly string[];
  /** Directories searched after `PATH`. */
  readonly fallbackDirs?: readonly string[];
  /** Directories never searched (compared with {@link hostPathsEqual}). */
  readonly excludeDirs?: readonly string[];
  /** Whether a candidate file exists; defaults to a real `stat`. */
  readonly isFile?: (filePath: string) => Promise<boolean>;
}

/**
 * Finds the first runnable file for any of `names`, searching `preferredDirs`, then `PATH`, then
 * `fallbackDirs`. Paths are joined with the host's `path`, so an injected `win32` platform on a
 * POSIX test host still walks the real (POSIX) directories it is given.
 */
export async function findHostExecutable(
  names: readonly string[],
  options: FindHostExecutableOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? isRegularFile;
  const excluded = new Set((options.excludeDirs ?? []).map((dir) => hostPathKey(dir, platform)));
  const seen = new Set<string>();
  const dirs = [
    ...(options.preferredDirs ?? []),
    ...hostSearchPath(options),
    ...(options.fallbackDirs ?? []),
  ];
  for (const dir of dirs) {
    const key = hostPathKey(dir, platform);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    for (const name of names) {
      for (const fileName of executableFileNames(name, options)) {
        const candidate = path.join(dir, fileName);
        // Windows `PATH` may hold relative entries (`.\node_modules\.bin`); callers spawn under
        // other working directories, so hand back the file this lookup actually found.
        if (await isFile(candidate)) {
          return platform === "win32" && !path.isAbsolute(candidate)
            ? path.resolve(candidate)
            : candidate;
        }
      }
    }
  }
  return null;
}

/** Whether Windows can only run `file` through `cmd.exe` (a batch script). */
export function isWindowsBatchFile(file: string): boolean {
  return /\.(?:cmd|bat)$/i.test(file);
}

export interface HarnessCommandInvocation {
  readonly file: string;
  readonly args: string[];
  /** Pass through to `child_process` so cmd.exe receives the command line exactly as built. */
  readonly windowsVerbatimArguments: boolean;
}

const SAFE_BATCH_ARGUMENT = /^[A-Za-z0-9_.,:=+\\/-]+$/;

/**
 * How to spawn a harness executable without a shell. Windows refuses to spawn `.cmd`/`.bat`
 * files directly (Node's CVE-2024-27980 fix returns `EINVAL`), so those run as
 * `cmd.exe /d /s /c ""<file>" <args>"`. Only plain arguments (flags such as `--version`) may be
 * passed to a batch file: cmd.exe re-parses them and would expand `%`, `^`, `&` or quotes.
 */
export function harnessCommandInvocation(
  file: string,
  args: readonly string[],
  host: HarnessHost = {},
): HarnessCommandInvocation {
  const platform = host.platform ?? process.platform;
  if (platform !== "win32" || !isWindowsBatchFile(file)) {
    return { file, args: [...args], windowsVerbatimArguments: false };
  }
  if (/["%^&|<>\r\n]/.test(file)) {
    throw new Error(`Refusing to run a batch file whose path cmd.exe would reinterpret: ${file}`);
  }
  for (const arg of args) {
    if (!SAFE_BATCH_ARGUMENT.test(arg)) {
      throw new Error(`Refusing to pass a non-literal argument to a batch file: ${arg}`);
    }
  }
  const env = host.env ?? process.env;
  const comspec = readHostEnv(env, "ComSpec", platform) ?? "cmd.exe";
  const commandLine = [`"${file}"`, ...args].join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Runs a harness executable (typically `--version`) with a timeout and no shell, going through
 * `cmd.exe` only for Windows batch launchers. Rejects like `execFile` when it fails.
 */
export async function runHarnessCommand(
  file: string,
  args: readonly string[],
  options: HarnessHost & { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const invocation = harnessCommandInvocation(file, args, options);
  return await execFileAsync(invocation.file, invocation.args, {
    timeout: options.timeoutMs ?? 5000,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/** How a harness launches Resin's MCP server: the process to spawn and its arguments. */
export interface ResinMcpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The stdio launch a harness is registered with, from Resin's CLI entry `command`.
 *
 * On native Windows a harness spawns MCP servers without a shell, and Windows cannot run a
 * `.mjs` file or (since Node's CVE-2024-27980 fix) a `resin.cmd` batch file that way. So when the
 * entry is a Node script (`resin.mjs`) the harness runs `node.exe <entry> mcp`; `nodePath`
 * defaults to the Node running Resin, as the background service does. Elsewhere the entry itself
 * is spawned with `mcp`.
 */
export function resolveResinMcpLaunch(
  command: string,
  options: { platform?: NodeJS.Platform; nodePath?: string } = {},
): ResinMcpLaunch {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && /\.(?:mjs|cjs|js)$/i.test(command)) {
    return { command: options.nodePath ?? process.execPath, args: [command, "mcp"] };
  }
  return { command, args: ["mcp"] };
}
