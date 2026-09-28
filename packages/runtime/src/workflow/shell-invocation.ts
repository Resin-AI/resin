/**
 * The process a recorded shell program runs in, chosen by the dialect its recording proved.
 *
 * A shell program is text one particular shell read, so a replay hands it to that same shell and
 * never to another that happens to be at hand:
 *
 * - `powershell` (Windows PowerShell 5.1) → `powershell.exe -NoLogo -NoProfile -NonInteractive
 *   -ExecutionPolicy Bypass -EncodedCommand …`, on Windows only;
 * - `pwsh` (PowerShell 7+) → `pwsh` the same way, wherever it is installed;
 * - a POSIX dialect, or a record made before dialects were recorded → `/bin/sh -c` (`/bin/bash -c`
 *   for a proven bash program) on POSIX hosts, and Git for Windows' `bash.exe` on Windows — never
 *   cmd.exe, which would read POSIX text as its own;
 * - `cmd`, or a dialect the recording did not prove → refused: such a program is never replayed.
 *
 * A needed shell that is not installed is refused with the reason, never substituted.
 *
 * The PowerShell source travels as `-EncodedCommand` (UTF-16LE Base64), so it reaches the shell
 * byte for byte with no quoting layer and keeps `-Command` semantics: `exit N` exits N, a
 * terminating error exits 1, and a failed last statement exits non-zero — with the native exit code
 * in `$LASTEXITCODE` when that statement ran a program. Output is UTF-8.
 */

import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import path from "node:path";
import {
  CMD_NOT_LEARNABLE_REASON,
  UNPROVEN_SHELL_DIALECT_REASON,
  type WorkflowRecordedProgram,
  isPosixShellDialect,
} from "@resin/contracts";

export interface ShellInvocation {
  command: string;
  args: string[];
  /** Environment variables the shell must not inherit (`PSModulePath` for Windows PowerShell). */
  unsetEnv?: string[];
  /** Environment variables the shell runs with, replacing any inherited spelling of each name. */
  setEnv?: Record<string, string>;
}

export interface ShellInvocationContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** A Codex-recorded bash login profile: `bash -lc` with Codex's stderr merge. */
  bashLogin?: boolean;
  /** POSIX prelude a Codex bash login profile runs before the program. */
  bashLoginPrelude?: string;
  /** Whether an executable exists at a path; overridable for tests. */
  executableExists?: (candidate: string) => boolean;
  /** The canonical path a path names (links and short names resolved); overridable for tests. */
  realpath?: (candidate: string) => string;
}

/** Flags every PowerShell replay runs with: no profile, no prompts, no execution-policy prompt. */
export const POWERSHELL_REPLAY_FLAGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
] as const;

/** A Windows command line holds 32,767 characters; the encoded program stays well inside it. */
const MAX_ENCODED_COMMAND_LENGTH = 30_000;
/** Room a Windows replay's whole command line may take, below CreateProcess's 32,767 characters. */
const MAX_WINDOWS_COMMAND_LINE = 32_000;

/**
 * The length of one element of the command line Node (libuv) builds on Windows: as is when it needs
 * no quoting, else quoted, with backslashes doubled before a quote and each quote escaped.
 */
function quotedWindowsArgumentLength(element: string): number {
  if (element.length === 0) return 2;
  if (!/[ \t"]/u.test(element)) return element.length;
  if (!/["\\]/u.test(element)) return element.length + 2;
  let length = 2;
  let backslashes = 0;
  for (const char of element) {
    if (char === "\\") {
      backslashes += 1;
    } else if (char === '"') {
      length += backslashes * 2 + 2;
      backslashes = 0;
    } else {
      length += backslashes + char.length;
      backslashes = 0;
    }
  }
  return length + backslashes * 2;
}

/** The length of the command line Node builds on Windows for `command` and `args`. */
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  return [command, ...args].reduce(
    (total, element, index) => total + quotedWindowsArgumentLength(element) + (index > 0 ? 1 : 0),
    0,
  );
}

/** Refuses a Windows invocation whose command line CreateProcess could not take. */
function withinWindowsCommandLine(invocation: ShellInvocation): ShellInvocation {
  if (windowsCommandLineLength(invocation.command, invocation.args) > MAX_WINDOWS_COMMAND_LINE) {
    throw new Error(
      "the recorded shell program is too long to pass to its shell on one Windows command line",
    );
  }
  return invocation;
}

/**
 * Runs before the program: output leaves the shell as UTF-8, whatever the console code page. Kept
 * on its own line so the program's own statements, and so its `$?`, are unchanged.
 */
const POWERSHELL_PRELUDE =
  "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }";

/**
 * Runs after the program when its last statement failed: the native exit code it left, else 1.
 * `-Command` alone would report every failure as 1.
 */
const POWERSHELL_EPILOGUE =
  "if (-not $?) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } exit 1 }";

/**
 * A Codex bash login profile run in Git Bash: stderr merged into stdout as Codex recorded it, and
 * the inherited (Windows-form) PATH put back in front in the POSIX form Git Bash reads.
 */
const GIT_BASH_LOGIN_PRELUDE =
  'exec 2>&1; if [ -n "${RESIN_INHERITED_PATH-}" ]; then PATH="$(cygpath -u -p "$RESIN_INHERITED_PATH"):$PATH"; export PATH; fi; unset RESIN_INHERITED_PATH; ';

function defaultExecutableExists(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Environment variables read case-insensitively, as Windows does. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered && value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** A program on PATH, for the platform's PATH syntax and executable extensions. */
function onPath(
  names: readonly string[],
  context: ShellInvocationContext,
  exists: (candidate: string) => boolean,
): string | undefined {
  const windows = context.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const searchPath = envValue(context.env, "PATH") ?? "";
  const directories = searchPath
    .split(windows ? ";" : ":")
    .filter((entry) => entry.length > 0)
    .slice(0, 256);
  for (const name of names) {
    for (const extension of windows ? [".exe", ""] : [""]) {
      for (const directory of directories) {
        const candidate = paths.join(directory, `${name}${extension}`);
        if (exists(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** Windows PowerShell 5.1: the system's own copy, else `powershell.exe` on PATH. */
export function resolveWindowsPowerShell(context: ShellInvocationContext): string | undefined {
  const exists = context.executableExists ?? defaultExecutableExists;
  const root = envValue(context.env, "SystemRoot") ?? envValue(context.env, "windir");
  const system =
    root === undefined
      ? undefined
      : path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (system !== undefined && exists(system)) return system;
  return onPath(["powershell"], context, exists);
}

/** PowerShell 7+: `pwsh` on PATH, else its default Windows install location. */
export function resolvePwsh(context: ShellInvocationContext): string | undefined {
  const exists = context.executableExists ?? defaultExecutableExists;
  const found = onPath(["pwsh"], context, exists);
  if (found !== undefined || context.platform !== "win32") return found;
  const programFiles = envValue(context.env, "ProgramFiles");
  const installed =
    programFiles === undefined
      ? undefined
      : path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
  return installed !== undefined && exists(installed) ? installed : undefined;
}

function defaultRealpath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

/**
 * Whether a path is Git for Windows' bash: `<root>\bin\bash.exe` or `<root>\usr\bin\bash.exe` of an
 * installation that carries its MSYS runtime (`usr\bin\msys-2.0.dll`), once links and short names
 * are resolved — never anything under the Windows directory (`System32\bash.exe` is WSL's launcher,
 * which would run the program in another operating system) or an app-execution alias.
 */
function isGitBash(candidate: string, context: ShellInvocationContext): boolean {
  const exists = context.executableExists ?? defaultExecutableExists;
  const resolved = path.win32.resolve((context.realpath ?? defaultRealpath)(candidate));
  const lower = resolved.toLowerCase();
  const windowsDirectory = path.win32
    .resolve(
      envValue(context.env, "SystemRoot") ?? envValue(context.env, "windir") ?? "C:\\Windows",
    )
    .toLowerCase();
  if (lower.startsWith(`${windowsDirectory}\\`) || /\\windowsapps\\/u.test(lower)) return false;
  const root = /^(.*)\\(?:usr\\)?bin\\bash\.exe$/iu.exec(resolved)?.[1];
  return root !== undefined && exists(path.win32.join(root, "usr", "bin", "msys-2.0.dll"));
}

/**
 * Git for Windows' bash: `CLAUDE_CODE_GIT_BASH_PATH` when set (the same override Claude Code
 * honours), then Git's machine-wide and per-user install locations, then the `bash.exe` of the Git
 * installation whose `git.exe` is on PATH. Every candidate, the override included, must be a Git for
 * Windows bash (see `isGitBash`); an override that is not is refused rather than replaced.
 */
export function resolveGitBash(context: ShellInvocationContext): string | undefined {
  const exists = context.executableExists ?? defaultExecutableExists;
  const override = envValue(context.env, "CLAUDE_CODE_GIT_BASH_PATH");
  if (override !== undefined) {
    return exists(override) && isGitBash(override, context) ? override : undefined;
  }
  const roots = [
    envValue(context.env, "ProgramFiles"),
    envValue(context.env, "ProgramFiles(x86)"),
    envValue(context.env, "ProgramW6432"),
  ].flatMap((root) => (root === undefined ? [] : [path.win32.join(root, "Git")]));
  const localAppData = envValue(context.env, "LOCALAPPDATA");
  if (localAppData !== undefined) roots.push(path.win32.join(localAppData, "Programs", "Git"));
  const git = onPath(["git"], context, exists);
  if (git !== undefined) {
    // `…\Git\cmd\git.exe`, `…\Git\bin\git.exe` or `…\Git\mingw64\bin\git.exe`.
    const directory = path.win32.dirname(git);
    roots.push(path.win32.dirname(directory), path.win32.dirname(path.win32.dirname(directory)));
  }
  for (const root of roots) {
    const candidate = path.win32.join(root, "bin", "bash.exe");
    if (exists(candidate) && isGitBash(candidate, context)) return candidate;
  }
  return undefined;
}

/**
 * The MSYS bash behind a Git for Windows bash, run directly with the environment Git's `bin\bash.exe`
 * launcher would give it (its MinGW and MSYS directories first on PATH, and `MSYSTEM`). Without the
 * launcher in between, every process the program starts records the replay's own child as its
 * ancestor, so a timeout can find and stop them all.
 */
function gitBashShell(
  bash: string,
  context: ShellInvocationContext,
): { command: string; env: Record<string, string> } {
  const exists = context.executableExists ?? defaultExecutableExists;
  const root = /^(.*)\\(?:usr\\)?bin\\bash\.exe$/iu.exec(bash)?.[1] ?? path.win32.dirname(bash);
  const msysBin = path.win32.join(root, "usr", "bin");
  const command = path.win32.join(msysBin, "bash.exe");
  const mingw = ["mingw64", "clangarm64", "mingw32"].find((directory) =>
    exists(path.win32.join(root, directory, "bin")),
  );
  const inherited = envValue(context.env, "PATH");
  return {
    command: exists(command) ? command : bash,
    env: {
      MSYSTEM:
        envValue(context.env, "MSYSTEM") ?? (mingw === undefined ? "MSYS" : mingw.toUpperCase()),
      PATH: [
        ...(mingw === undefined ? [] : [path.win32.join(root, mingw, "bin")]),
        msysBin,
        ...(inherited === undefined ? [] : [inherited]),
      ].join(";"),
    },
  };
}

/**
 * The PowerShell source a replay encodes: the UTF-8 prelude, the recorded program unchanged, and
 * the epilogue that keeps a failed last statement's native exit code. A program ending in a line
 * continuation would join the epilogue, so it runs without one.
 */
export function powershellReplaySource(source: string): string {
  const continues = /`\r?\n?$/u.test(source);
  return `${POWERSHELL_PRELUDE}\n${source}${continues ? "" : `\n${POWERSHELL_EPILOGUE}`}`;
}

function encodedPowerShellCommand(source: string): string {
  const encoded = Buffer.from(powershellReplaySource(source), "utf16le").toString("base64");
  if (encoded.length > MAX_ENCODED_COMMAND_LENGTH) {
    throw new Error(
      "the recorded PowerShell program is too long to pass to PowerShell on one command line",
    );
  }
  return encoded;
}

/** The process that runs a recorded shell program's `source`, by the program's recorded dialect. */
export function shellProgramInvocation(
  program: Pick<WorkflowRecordedProgram, "dialect" | "unprovenDialect">,
  source: string,
  context: ShellInvocationContext,
): ShellInvocation {
  if (program.unprovenDialect === true) {
    throw new Error(
      `the recorded shell program cannot be replayed: ${UNPROVEN_SHELL_DIALECT_REASON}`,
    );
  }
  const dialect = program.dialect;
  const windows = context.platform === "win32";
  const exists = context.executableExists ?? defaultExecutableExists;
  switch (dialect) {
    case "cmd":
      throw new Error(`the recorded shell program cannot be replayed: ${CMD_NOT_LEARNABLE_REASON}`);
    case "powershell": {
      if (!windows) {
        throw new Error(
          "the recorded program ran in Windows PowerShell 5.1, which runs only on Windows; it is never replayed in another shell",
        );
      }
      const command = resolveWindowsPowerShell(context);
      if (command === undefined) {
        throw new Error(
          "the recorded program ran in Windows PowerShell 5.1, but powershell.exe was not found on this device",
        );
      }
      return withinWindowsCommandLine({
        command,
        args: [...POWERSHELL_REPLAY_FLAGS, "-EncodedCommand", encodedPowerShellCommand(source)],
        // PowerShell 7 exports its own module path; Windows PowerShell must compute its own.
        unsetEnv: ["PSModulePath"],
      });
    }
    case "pwsh": {
      const command = resolvePwsh(context);
      if (command === undefined) {
        throw new Error(
          "the recorded program ran in PowerShell 7 (pwsh), which was not found on this device; it is never replayed in Windows PowerShell 5.1",
        );
      }
      const invocation = {
        command,
        args: [
          ...(windows ? POWERSHELL_REPLAY_FLAGS : POWERSHELL_REPLAY_FLAGS.slice(0, 3)),
          "-EncodedCommand",
          encodedPowerShellCommand(source),
        ],
      };
      return windows ? withinWindowsCommandLine(invocation) : invocation;
    }
    default:
      break;
  }
  if (dialect !== undefined && !isPosixShellDialect(dialect)) {
    throw new Error(`the recorded shell dialect '${String(dialect)}' cannot be replayed`);
  }
  // A POSIX program: never cmd.exe, which would read it as cmd syntax.
  if (windows) {
    const bash = resolveGitBash(context);
    if (bash === undefined) {
      throw new Error(
        "the recorded program is a POSIX shell program, and Git for Windows' bash.exe was not found on this device (install Git for Windows, or point CLAUDE_CODE_GIT_BASH_PATH at its bin\\bash.exe); it is never replayed in cmd.exe, PowerShell or WSL",
      );
    }
    const shell = gitBashShell(bash, context);
    return withinWindowsCommandLine({
      command: shell.command,
      args:
        context.bashLogin === true ? ["-lc", `${GIT_BASH_LOGIN_PRELUDE}${source}`] : ["-c", source],
      setEnv: shell.env,
    });
  }
  if (context.bashLogin === true) {
    return { command: "/bin/bash", args: ["-lc", `${context.bashLoginPrelude ?? ""}${source}`] };
  }
  if (dialect === "bash") {
    const bash = exists("/bin/bash") ? "/bin/bash" : onPath(["bash"], context, exists);
    if (bash === undefined) {
      throw new Error("the recorded program ran in bash, which was not found on this device");
    }
    return { command: bash, args: ["-c", source] };
  }
  return { command: "/bin/sh", args: ["-c", source] };
}
