/**
 * The display filter a recorded shell program piped its output through: `pnpm vitest run 2>&1 |
 * tail -30`, `gh pr checks 12 | grep fail`. The agent wanted the command; the trailing `tail`,
 * `head` or `grep` only trimmed what its terminal showed, and as the pipeline's last stage it also
 * decided the exit status the recording saw. A step marked `displayFilter` (see
 * `WorkflowStep.displayFilter`) runs the command without those stages, so its caller gets the whole
 * output and the command's own exit status; a recording check pipes that output through the
 * dropped stages to compare it with what the recording printed.
 *
 * Only a program the strict `&&`-chain grammar (`shell-and-chain.ts`) admits as one pipeline splits,
 * and only stages that print a subset of their input's lines in order and stop: never one that
 * follows a file, counts, lists file names, prints nothing, prints parts of lines, or redirects.
 */

import type { WorkflowRecordedProgram } from "./recorded-workflow.js";
import {
  type ShellPipelineStage,
  recordedPosixShell,
  shellPipelineStages,
} from "./shell-and-chain.js";
import { recordedProgramLanguage } from "./shell-dialects.js";

/** The version of these splitting rules; bump it whenever a program would split differently. */
export const DISPLAY_FILTER_VERSION = 1 as const;

const FILTER_COMMANDS: Readonly<Record<string, true>> = {
  tail: true,
  head: true,
  grep: true,
  egrep: true,
  fgrep: true,
};

/** grep long options that print counts, file names, nothing, or parts of lines instead of lines. */
const GREP_NON_DISPLAY_LONG_OPTIONS: Readonly<Record<string, true>> = {
  "--count": true,
  "--files-with-matches": true,
  "--files-without-match": true,
  "--quiet": true,
  "--silent": true,
  "--only-matching": true,
  "--null": true,
  "--null-data": true,
  "--no-messages": true,
};

/** Whether a `tail` stage follows its input (`-f`, `-F`, `--follow*`, `--retry`, `--pid*`). */
function isFollowingTail(stage: ShellPipelineStage): boolean {
  const [command, ...args] = stage.words;
  return (
    command === "tail" &&
    args.some(
      (arg) =>
        (!arg.startsWith("--") && arg.startsWith("-") && /[fF]/.test(arg.slice(1))) ||
        arg.startsWith("--follow") ||
        arg === "--retry" ||
        arg.startsWith("--pid"),
    )
  );
}

/** Whether one pipeline stage only trims the lines it is given (see the module comment). */
function isDisplayFilterStage(stage: ShellPipelineStage): boolean {
  const [command, ...args] = stage.words;
  if (stage.redirects || command === undefined || !Object.hasOwn(FILTER_COMMANDS, command)) {
    return false;
  }
  if (command === "tail") return !isFollowingTail(stage);
  if (command === "head") return true;
  return args.every((arg) => {
    const cluster = !arg.startsWith("--") && arg.startsWith("-") ? arg.slice(1) : "";
    return !(/[clLqosZz]/.test(cluster) || Object.hasOwn(GREP_NON_DISPLAY_LONG_OPTIONS, arg));
  });
}

/**
 * A recorded shell program split before the trailing display filter it piped its output through:
 * `command` is the text before the first dropped `|` (trailing blanks removed) and `filter` the text
 * after it (blanks around it removed), both exact slices of `text`. Undefined unless `version` is
 * one this device has, `shell` is a POSIX shell the `&&`-chain splitter accepts, `text` is one
 * pipeline of two or more commands in its grammar, and its trailing run of display-filter stages
 * leaves at least one stage before it, none of them a `tail` that follows its input (run alone it
 * never ends: `tail -f log | grep x`).
 */
export function splitDisplayFilter(
  shell: string,
  text: string,
  version: number = DISPLAY_FILTER_VERSION,
): { command: string; filter: string } | undefined {
  if (version !== DISPLAY_FILTER_VERSION) return undefined;
  const stages = shellPipelineStages(shell, text);
  if (stages === undefined || stages.length < 2) return undefined;
  let first = stages.length;
  while (first > 0 && isDisplayFilterStage(stages[first - 1]!)) first -= 1;
  if (first === stages.length || first === 0) return undefined;
  if (stages.slice(0, first).some(isFollowingTail)) return undefined;
  const pipe = stages[first]!.pipe!;
  return {
    command: text.slice(0, pipe).replace(/[ \t]+$/, ""),
    filter: text.slice(pipe + 1).replace(/^[ \t]+|[ \t]+$/g, ""),
  };
}

/**
 * The POSIX shell a recorded program's display filter is split under: its recorded POSIX dialect
 * (see `recordedPosixShell`), or `sh` for a POSIX program recorded before dialects were, whose
 * grammar every POSIX shell reads alike. Undefined for any other program.
 */
export function displayFilterShell(
  callableName: string,
  args: Readonly<Record<string, unknown>>,
  program: WorkflowRecordedProgram | undefined,
): string | undefined {
  if (program?.kind !== "shell" || recordedProgramLanguage(program) !== "shell") return undefined;
  return recordedPosixShell(callableName, args, program) ?? "sh";
}
