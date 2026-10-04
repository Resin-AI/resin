/**
 * The display filter a recorded shell program piped its output through: `pnpm vitest run 2>&1 |
 * tail -30`, `cd web && npx vitest run 2>&1 | grep -E "×|FAIL" | head -40`. The agent wanted the
 * command; the trailing `tail`, `head` or `grep` only trimmed what its terminal showed, and as the
 * pipeline's last stage it also decided the exit status the recording saw. A step marked
 * `displayFilter` (see `WorkflowStep.displayFilter`) runs the program without those stages, so its
 * caller gets the whole output and the command's own exit status; a recording check pipes that
 * output through the dropped stages to compare it with what the recording printed.
 *
 * The split is an allowlist with a grammar of its own (the program is never run apart, so unlike
 * `shell-and-chain.ts` a builtin such as `cd` is harmless):
 *
 * - Outside quotes: space, tab, `A-Z a-z 0-9 _ - . / , : = + @`; a single `|` joining two pipeline
 *   stages; the separators `&&`, `;` and line break; and the word `2>&1`, followed by the end, a
 *   blank, `|`, `;`, `&` or a line break. Anything else — `$ \` \ # ! ( ) { } < > * ? [ ] ~ % ^`,
 *   `||`, `|&`, a lone `&`, any other redirection — never splits.
 * - Quotes: `'...'`, and `"..."` without backtick or `!`, with `$` only as its last character
 *   (`"^$"`) and a backslash only before a character it does not escape (`"\s+at "`), never last;
 *   inside either, any character but a control character (`×`, `✓` included).
 * - Trailing whitespace is ignored; every other command and pipeline stage is non-empty (no
 *   `a ;; b`, `a | | b`, leading `;` or blank line).
 *
 * The program's last segment is a pipeline; its trailing run of display-filter stages is dropped,
 * leaving at least one stage of that segment. A display filter prints a subset of its input's lines
 * in order and stops: never a stage that follows a file, counts, lists file names, prints nothing,
 * prints parts of lines, or redirects. Earlier segments are kept verbatim.
 */

import type { WorkflowRecordedProgram } from "./recorded-workflow.js";
import { recordedPosixShell } from "./shell-and-chain.js";
import { recordedProgramLanguage } from "./shell-dialects.js";

/** The version of these splitting rules; bump it whenever a program would split differently. */
export const DISPLAY_FILTER_VERSION = 1 as const;

const POSIX_SHELLS: Readonly<Record<string, true>> = {
  bash: true,
  sh: true,
  dash: true,
  "sh-or-zsh": true,
};

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

/** Characters a word may carry outside quotes. */
const PLAIN = /^[A-Za-z0-9_\-./,:=+@]$/;
const CONTROL = /\p{Cc}/u;
const STDERR_TO_STDOUT = "2>&1";

/** One command of the program's last pipeline. */
interface Stage {
  /** Offset of the `|` before this stage; undefined for the first stage. */
  pipe?: number;
  /** The command word and its arguments, quotes removed. */
  words: string[];
  /** Whether the stage carries `2>&1`. */
  redirects: boolean;
}

/**
 * Whether a double-quoted body reads literally in every POSIX shell: no backtick or `!`; a `$` only
 * as its last character (`"^$"`); a backslash only before a character it does not escape there
 * (`"\s+at "`), never last.
 */
function isLiteralDoubleQuoted(body: string): boolean {
  if (/[`!]/.test(body) || body.endsWith("\\")) return false;
  const dollar = body.indexOf("$");
  if (dollar !== -1 && dollar !== body.length - 1) return false;
  return !/\\[$`"\\\n]/.test(body);
}

/** The stages of the pipeline `text` ends in, or undefined when any of `text` is outside the grammar. */
function lastPipeline(text: string): Stage[] | undefined {
  let stages: Stage[] = [{ words: [], redirects: false }];
  let word: string | undefined;
  /** Ends the word being read; whether the current stage has a command word. */
  const commandEnded = (): boolean => {
    if (word !== undefined) stages.at(-1)!.words.push(word);
    word = undefined;
    return stages.at(-1)!.words.length > 0;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === " " || char === "\t") {
      commandEnded();
      continue;
    }
    if (char === "\n" || char === ";" || char === "&") {
      if ((char === "&" && text[index + 1] !== "&") || !commandEnded()) return undefined;
      if (char === "&") index += 1;
      stages = [{ words: [], redirects: false }];
      continue;
    }
    if (char === "|") {
      if (text[index + 1] === "|" || text[index + 1] === "&" || !commandEnded()) return undefined;
      stages.push({ pipe: index, words: [], redirects: false });
      continue;
    }
    if (word === undefined && text.startsWith(STDERR_TO_STDOUT, index)) {
      const next = text[index + STDERR_TO_STDOUT.length];
      if (next === undefined || " \t|;&\n".includes(next)) {
        stages.at(-1)!.redirects = true;
        index += STDERR_TO_STDOUT.length - 1;
        continue;
      }
    }
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1);
      if (close === -1) return undefined;
      const quoted = text.slice(index + 1, close);
      if (CONTROL.test(quoted) || (char === '"' && !isLiteralDoubleQuoted(quoted)))
        return undefined;
      word = (word ?? "") + quoted;
      index = close;
      continue;
    }
    if (!PLAIN.test(char)) return undefined;
    word = (word ?? "") + char;
  }
  return commandEnded() ? stages : undefined;
}

/** Whether a `tail` stage follows its input (`-f`, `-F`, `--follow*`, `--retry`, `--pid*`). */
function isFollowingTail(stage: Stage): boolean {
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
function isDisplayFilterStage(stage: Stage): boolean {
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
 * `command` is the text before the first dropped `|` (trailing whitespace removed) and `filter` the
 * text after it (whitespace around it removed), both exact slices of `text`. Undefined unless
 * `version` is one this device has, `shell` is a POSIX shell, `text` is in the grammar above, and
 * the trailing run of display-filter stages of its last pipeline leaves at least one stage before
 * it, none of them a `tail` that follows its input (run alone it never ends: `tail -f log | grep x`).
 */
export function splitDisplayFilter(
  shell: string,
  text: string,
  version: number = DISPLAY_FILTER_VERSION,
): { command: string; filter: string } | undefined {
  if (version !== DISPLAY_FILTER_VERSION || !Object.hasOwn(POSIX_SHELLS, shell)) return undefined;
  const stages = lastPipeline(text.trimEnd());
  if (stages === undefined || stages.length < 2) return undefined;
  let first = stages.length;
  while (first > 0 && isDisplayFilterStage(stages[first - 1]!)) first -= 1;
  if (first === stages.length || first === 0) return undefined;
  if (stages.slice(0, first).some(isFollowingTail)) return undefined;
  const pipe = stages[first]!.pipe!;
  return { command: text.slice(0, pipe).trimEnd(), filter: text.slice(pipe + 1).trim() };
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
