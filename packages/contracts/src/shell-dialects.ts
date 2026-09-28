/**
 * The shell dialect a recorded shell program ran in, and what each dialect admits.
 *
 * A shell program is text one particular shell read, and the same text means different things in
 * different shells: bash, sh and dash share a POSIX grammar Resin models; Windows PowerShell 5.1
 * (`powershell.exe`) and PowerShell 7+ (`pwsh`) share most of a grammar Resin models separately, but
 * disagree on `&&`/`||`, native argument passing and output encodings, so they are two dialects and
 * never mixed; cmd.exe has quoting, `%VAR%` and delayed expansion rules Resin never models.
 *
 * The dialect a program is recorded under must be proven by the recording itself: the harness's own
 * built-in shell tool, or the executable a harness recorded it ran. It is never inferred from the
 * operating system the recording or the replay happens on. A recording that shows a shell program
 * without proving its dialect keeps `unprovenDialect`, and is captured but never learned.
 *
 * A program recorded before dialects were recorded carries neither field and keeps its original
 * reading: the POSIX grammar.
 */

import type { ProgramLanguage } from "./program-tokens.js";
import type { WorkflowRecordedProgram } from "./recorded-workflow.js";

/**
 * Every shell dialect a recording can prove. `sh-or-zsh` is a login shell that may be zsh (Cursor's
 * `Shell`); `powershell` is Windows PowerShell 5.1 (`powershell.exe`); `pwsh` is PowerShell 7+.
 */
export type ShellDialect = "bash" | "sh" | "dash" | "sh-or-zsh" | "powershell" | "pwsh" | "cmd";

/** The grammar family a dialect belongs to. */
export type ShellDialectFamily = "posix" | "powershell" | "cmd";

/** The tokenizer grammar a learnable dialect's programs are read with. */
export type ShellProgramGrammar = Extract<ProgramLanguage, "shell" | "powershell" | "pwsh">;

export interface ShellDialectDescriptor {
  dialect: ShellDialect;
  family: ShellDialectFamily;
  /** Grammar a program in this dialect is tokenized with; absent when it is never tokenized. */
  grammar?: ShellProgramGrammar;
  /** Why a program in this dialect is captured but never learned; absent when it is learnable. */
  notLearnable?: string;
  /** Whether a top-level `&&` chain may be split into steps (the POSIX splitter's grammar). */
  splitsAndChains: boolean;
}

/** Why a cmd.exe program is captured but never learned, tokenized, split or replayed. */
export const CMD_NOT_LEARNABLE_REASON =
  "cmd.exe programs are captured but not learnable: cmd's quoting, %VAR% and delayed expansion cannot be modeled precisely, so Resin never tokenizes, splits, parameterizes or replays them";

/** Why a shell program whose dialect the recording does not prove is never learned. */
export const UNPROVEN_SHELL_DIALECT_REASON =
  "the recording does not prove which shell ran this program (for example PowerShell 5.1 versus PowerShell 7), so it is captured but not learnable";

export const SHELL_DIALECTS: Readonly<Record<ShellDialect, ShellDialectDescriptor>> = {
  bash: { dialect: "bash", family: "posix", grammar: "shell", splitsAndChains: true },
  sh: { dialect: "sh", family: "posix", grammar: "shell", splitsAndChains: true },
  dash: { dialect: "dash", family: "posix", grammar: "shell", splitsAndChains: true },
  "sh-or-zsh": { dialect: "sh-or-zsh", family: "posix", grammar: "shell", splitsAndChains: true },
  powershell: {
    dialect: "powershell",
    family: "powershell",
    grammar: "powershell",
    splitsAndChains: false,
  },
  pwsh: { dialect: "pwsh", family: "powershell", grammar: "pwsh", splitsAndChains: false },
  cmd: {
    dialect: "cmd",
    family: "cmd",
    notLearnable: CMD_NOT_LEARNABLE_REASON,
    splitsAndChains: false,
  },
};

export function isShellDialect(value: unknown): value is ShellDialect {
  return typeof value === "string" && Object.hasOwn(SHELL_DIALECTS, value);
}

/** Whether a dialect reads the POSIX grammar (bash, sh, dash, or a login shell that may be zsh). */
export function isPosixShellDialect(dialect: ShellDialect): boolean {
  return SHELL_DIALECTS[dialect].family === "posix";
}

type DialectBearing = Pick<WorkflowRecordedProgram, "kind"> &
  Partial<Pick<WorkflowRecordedProgram, "dialect" | "unprovenDialect">>;

/**
 * The grammar a recorded program's text is tokenized with: its own language, or for a shell program
 * the grammar of its recorded dialect (the POSIX grammar when it records none). Undefined when the
 * program is never tokenized: a cmd.exe program, or one whose dialect the recording did not prove.
 */
export function recordedProgramLanguage(program: DialectBearing): ProgramLanguage | undefined {
  if (program.kind !== "shell") return program.kind;
  if (program.unprovenDialect === true) return undefined;
  if (program.dialect === undefined) return "shell";
  if (!isShellDialect(program.dialect)) return undefined;
  return SHELL_DIALECTS[program.dialect].grammar;
}

/** Why a recorded program is captured but never learned; undefined when it may be learned. */
export function programNotLearnableReason(program: DialectBearing): string | undefined {
  if (program.kind !== "shell") return undefined;
  if (program.unprovenDialect === true) return UNPROVEN_SHELL_DIALECT_REASON;
  if (program.dialect === undefined) return undefined;
  if (!isShellDialect(program.dialect)) return UNPROVEN_SHELL_DIALECT_REASON;
  return SHELL_DIALECTS[program.dialect].notLearnable;
}

/** Whether a program language is one of the shell grammars (POSIX or PowerShell). */
export function isShellGrammar(language: ProgramLanguage): language is ShellProgramGrammar {
  return language === "shell" || language === "powershell" || language === "pwsh";
}

/**
 * The dialect an executable path or name runs, from its basename alone (`C:\Windows\System32\
 * WindowsPowerShell\v1.0\powershell.exe` → `powershell`, `/usr/bin/pwsh` → `pwsh`). Only the
 * executable's own name decides it; anything else is undefined.
 */
export function shellDialectOfExecutable(executable: string): ShellDialect | undefined {
  const base = executable
    .slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  switch (base) {
    case "powershell":
      return "powershell";
    case "pwsh":
      return "pwsh";
    case "cmd":
      return "cmd";
    case "bash":
      return "bash";
    case "sh":
      return "sh";
    case "dash":
      return "dash";
    default:
      return undefined;
  }
}

/** PowerShell switches a recorded invocation may carry before `-Command` without changing it. */
const POWERSHELL_SWITCHES: Readonly<Record<string, true>> = {
  "-noprofile": true,
  "-nologo": true,
  "-noninteractive": true,
};

/**
 * The program an argv ran a PowerShell or cmd.exe program with, and the dialect its executable
 * proves: `powershell.exe [-NoProfile|-NoLogo|-NonInteractive]… -Command <program>` (likewise
 * `pwsh`), or `cmd.exe [/d] [/s] /c <program>`. Any other shape — more arguments, an execution
 * policy, `-File`, `-EncodedCommand` — proves nothing and yields undefined.
 */
export function windowsShellInvocation(
  executable: string,
  args: readonly unknown[],
): { dialect: "powershell" | "pwsh" | "cmd"; program: string } | undefined {
  const dialect = shellDialectOfExecutable(executable);
  const program = args.at(-1);
  if (typeof program !== "string" || args.length < 2) return undefined;
  const flags = args.slice(0, -1);
  if (!flags.every((flag): flag is string => typeof flag === "string")) return undefined;
  const lowered = flags.map((flag) => flag.toLowerCase());
  if (dialect === "powershell" || dialect === "pwsh") {
    const command = lowered.at(-1);
    if (command !== "-command" && command !== "-c") return undefined;
    if (!lowered.slice(0, -1).every((flag) => Object.hasOwn(POWERSHELL_SWITCHES, flag)))
      return undefined;
    return { dialect, program };
  }
  if (dialect === "cmd") {
    if (lowered.at(-1) !== "/c") return undefined;
    if (!lowered.slice(0, -1).every((flag) => flag === "/d" || flag === "/s")) return undefined;
    return { dialect, program };
  }
  return undefined;
}
