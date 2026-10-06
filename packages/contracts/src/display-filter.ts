/**
 * The display filters a recorded shell program piped its output through: `pnpm vitest run 2>&1 |
 * tail -30`, `cd web && npx vitest run 2>&1 | grep -E "×|FAIL" | head -40`. The agent wanted the
 * command; the trailing `tail`, `head` or `grep` only trimmed what its terminal showed, and as the
 * pipeline's last stage it also decided the exit status the recording saw. A step marked
 * `displayFilter` (see `WorkflowStep.displayFilter`) runs the program without those stages, so its
 * caller gets the whole output and the command's own exit status; a recording check pipes that
 * output through the dropped stages to compare it with what the recording printed.
 *
 * Version 1 (`splitDisplayFilter`) splits only the program's last pipeline, and only a program
 * written entirely in an allowlist grammar of its own (the program is never run apart, so unlike
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
 *
 * Version 2 (`splitDisplayFilters`) drops the trailing display-filter stages of EVERY top-level
 * pipeline and keeps everything else verbatim, whatever it holds, as long as a conservative lexer
 * delimits the program's top-level list (rules on `splitDisplayFilters`): `A 2>&1 | grep -E 'x|y' ;
 * B >/dev/null && echo ok` runs `A 2>&1 ; B >/dev/null && echo ok`. A display-filter stage is
 * version 1's, written in version 1's word grammar. Since a cut pipeline's kept stages may now run
 * in the shell itself, they must be ordinary commands: no builtin, keyword or bare assignment.
 */

import type { WorkflowRecordedProgram } from "./recorded-workflow.js";
import { recordedPosixShell } from "./shell-and-chain.js";
import { recordedProgramLanguage } from "./shell-dialects.js";

/**
 * The newest version of these splitting rules; bump it whenever a program would split differently.
 * Older versions stay readable: a step names the version it was split under and splits under
 * exactly those rules (see `DISPLAY_FILTER_VERSIONS`).
 */
export const DISPLAY_FILTER_VERSION = 2 as const;

/** The versions this device splits and runs: 1 (`splitDisplayFilter`) and 2 (`splitDisplayFilters`). */
export const DISPLAY_FILTER_VERSIONS: readonly number[] = [1, 2];

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
 * A recorded shell program split under version 1 before the trailing display filter it piped its
 * output through: `command` is the text before the first dropped `|` (trailing whitespace removed)
 * and `filter` the text after it (whitespace around it removed), both exact slices of `text`.
 * Undefined unless `version` is 1, `shell` is a POSIX shell, `text` is in the grammar above, and
 * the trailing run of display-filter stages of its last pipeline leaves at least one stage before
 * it, none of them a `tail` that follows its input (run alone it never ends: `tail -f log | grep x`).
 */
export function splitDisplayFilter(
  shell: string,
  text: string,
  version = 1,
): { command: string; filter: string } | undefined {
  if (version !== 1 || !Object.hasOwn(POSIX_SHELLS, shell)) return undefined;
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
 * Words that open, close or modify a compound command or a pipeline; never in command position.
 * A Set, not a Record: a `then` key would make the object look like a promise.
 */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "!",
  "{",
  "}",
  "[[",
  "]]",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "time",
  "coproc",
  "repeat",
  "foreach",
]);

/**
 * Builtins of the POSIX shells (sh, dash, bash, zsh). One left alone in a cut pipeline would run in
 * the shell itself instead of a pipeline's subshell (`cd x | head` would change directory, `exit 1
 * | tail` would end the program), so its pipeline is never cut.
 */
const SHELL_BUILTINS: Readonly<Record<string, true>> = {
  ".": true,
  ":": true,
  "[": true,
  "-": true,
  alias: true,
  autoload: true,
  bg: true,
  bind: true,
  bindkey: true,
  break: true,
  builtin: true,
  caller: true,
  cd: true,
  chdir: true,
  command: true,
  compgen: true,
  complete: true,
  compopt: true,
  continue: true,
  declare: true,
  dirs: true,
  disable: true,
  disown: true,
  echo: true,
  emulate: true,
  enable: true,
  eval: true,
  exec: true,
  exit: true,
  export: true,
  false: true,
  fc: true,
  fg: true,
  float: true,
  functions: true,
  getopts: true,
  hash: true,
  help: true,
  history: true,
  integer: true,
  jobs: true,
  kill: true,
  let: true,
  local: true,
  logout: true,
  mapfile: true,
  nocorrect: true,
  noglob: true,
  popd: true,
  print: true,
  printf: true,
  pushd: true,
  pushln: true,
  pwd: true,
  read: true,
  readarray: true,
  readonly: true,
  rehash: true,
  return: true,
  set: true,
  setopt: true,
  shift: true,
  shopt: true,
  source: true,
  suspend: true,
  test: true,
  times: true,
  trap: true,
  true: true,
  type: true,
  typeset: true,
  ulimit: true,
  umask: true,
  unalias: true,
  unfunction: true,
  unset: true,
  unsetopt: true,
  wait: true,
  whence: true,
  zle: true,
  zmodload: true,
  zstyle: true,
};

/** How deep `$(...)` may nest before the lexer gives up. */
const MAX_SUBSTITUTION_DEPTH = 8;
/** Characters that end an unquoted word. */
const WORD_END = " \t\n;&|<>()";
const NAME_START = /^[A-Za-z_]$/;
const NAME_CHAR = /^[A-Za-z0-9_]$/;
/** `$?`, `$#`, `$1`, ...: a one-character parameter. */
const SPECIAL_PARAMETER = /^[0-9?#@*$!-]$/;
/** Characters `${...}` may hold: a name, an index, and plain operators; no quote or expansion. */
const BRACED_PARAMETER = /^[A-Za-z0-9_#%:/*@?!+=.,^~[\] -]$/;
/** A word assigning a variable: `NAME=`, `NAME+=`, `NAME[i]=`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
/** References that read the exit status of every stage of a pipeline, which a cut changes. */
const PIPE_STATUS = /PIPESTATUS|pipestatus/;

/** One word of a version-2 program. */
interface ShellWord {
  start: number;
  /** Offset after the word's last character. */
  end: number;
  /** Offset where lexing resumes (after any line continuation that ended the word). */
  next: number;
  raw: string;
  /** The word's value, quotes and escapes removed; undefined when it holds an expansion. */
  value?: string;
  /** Whether the word is in version 1's word grammar (plain characters, literal quotes). */
  plain: boolean;
}

/** One stage of a top-level pipeline of a version-2 program. */
interface ListStage {
  /** Offset of the stage's first word or redirection. */
  start: number;
  /** Offset after the stage's last word. */
  end: number;
  /** Offset of the `|` before this stage; undefined for the first stage. */
  pipe?: number;
  /** The stage's words, redirection operators and their targets left out. */
  words: ShellWord[];
  redirects: boolean;
}

/**
 * A lexed list: its pipelines, where lexing ended, where its last token or heredoc body ended, and
 * the heredoc bodies it holds (from the line after their operator through their delimiter line).
 */
interface LexedList {
  pipelines: ListStage[][];
  end: number;
  contentEnd: number;
  bodies: { start: number; end: number }[];
}

/** What every level of one program's lexing shares. */
interface Lexer {
  /** Whether the shell reads `<<<` as a here-string (bash), not as a heredoc of `<word`. */
  hereStrings: boolean;
  /** Heredocs whose operator was read and whose body is not yet, at any level. */
  pending: number;
}

/** A heredoc whose operator was read: its delimiter, `<<-`, and whether the delimiter is quoted. */
interface Heredoc {
  delimiter: string;
  strip: boolean;
  quoted: boolean;
}

/**
 * The offset after the bodies of `heredocs`, read in order from `from` (the line after their
 * operators): each runs through the first line that is its delimiter (leading tabs removed for
 * `<<-`). The bodies are opaque: nothing in them is lexed, whatever they hold. Undefined when a
 * delimiter line is missing; when an unquoted body has a line ending in `\`, which would join the
 * next line to it; or when a body inside `$(...)` has a line that is the delimiter followed by a
 * `)` (`EOF)`, `EOF )`), which bash ends the body at and dash does not.
 */
function readHeredocBodies(
  text: string,
  from: number,
  heredocs: readonly Heredoc[],
  nested: boolean,
): number | undefined {
  let position = from;
  for (const heredoc of heredocs) {
    for (;;) {
      if (position >= text.length) return undefined;
      const newline = text.indexOf("\n", position);
      const line = text.slice(position, newline === -1 ? text.length : newline);
      const compared = heredoc.strip ? line.replace(/^\t+/, "") : line;
      position = newline === -1 ? text.length : newline + 1;
      if (compared === heredoc.delimiter) break;
      if (!heredoc.quoted && line.endsWith("\\")) return undefined;
      if (
        nested &&
        compared.startsWith(heredoc.delimiter) &&
        /^[ \t]*\)/.test(compared.slice(heredoc.delimiter.length))
      ) {
        return undefined;
      }
    }
  }
  return position;
}

/**
 * The offset after a `$` expansion starting at `index`, `index + 1` when the `$` is a literal
 * character, or undefined when the lexer cannot delimit it: `$((...))`, `$[...]`, `$'...'`, `$"..."`, or a
 * `${...}` holding anything beyond a name and plain operators.
 */
function lexDollar(
  text: string,
  index: number,
  depth: number,
  quoted: boolean,
  lexer: Lexer,
): number | undefined {
  const next = text[index + 1];
  if (next === undefined) return index + 1;
  if (next === "{") {
    let close = index + 2;
    while (close < text.length && text[close] !== "}") {
      if (!BRACED_PARAMETER.test(text[close]!)) return undefined;
      close += 1;
    }
    return close >= text.length || close === index + 2 ? undefined : close + 1;
  }
  // bash's old arithmetic `$[...]` may hold blanks and `|`.
  if (next === "[") return undefined;
  if (next === "(") {
    // Where a heredoc's body would start inside a `$(...)` opened on its operator's line is unclear.
    if (text[index + 2] === "(" || lexer.pending > 0) return undefined;
    return lexList(text, index + 2, depth + 1, lexer)?.end;
  }
  if (next === "'" || next === '"') return quoted ? index + 1 : undefined;
  if (NAME_START.test(next)) {
    let end = index + 2;
    while (end < text.length && NAME_CHAR.test(text[end]!)) end += 1;
    return end;
  }
  return SPECIAL_PARAMETER.test(next) ? index + 2 : index + 1;
}

/** The `"..."` string opening at `open`: the offset after its closing quote, and its value. */
function lexDoubleQuoted(
  text: string,
  open: number,
  depth: number,
  lexer: Lexer,
): { end: number; value?: string } | undefined {
  let value: string | undefined = "";
  let index = open + 1;
  for (;;) {
    const char = text[index];
    if (char === undefined || char === "`") return undefined;
    if (char === '"') return { end: index + 1, ...(value === undefined ? {} : { value }) };
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      if ('$`"\\\n'.includes(next)) {
        if (value !== undefined && next !== "\n") value += next;
        index += 2;
      } else {
        if (value !== undefined) value += char;
        index += 1;
      }
      continue;
    }
    if (char === "$") {
      const after = lexDollar(text, index, depth, true, lexer);
      if (after === undefined) return undefined;
      if (after > index + 1) value = undefined;
      else if (value !== undefined) value += char;
      index = after;
      continue;
    }
    if (value !== undefined) value += char;
    index += 1;
  }
}

/** The unquoted-or-quoted word starting at `start` (not at a blank or operator). */
function lexWord(text: string, start: number, depth: number, lexer: Lexer): ShellWord | undefined {
  let value: string | undefined = "";
  let plain = true;
  let index = start;
  let end = start;
  while (index < text.length) {
    const char = text[index]!;
    if (WORD_END.includes(char)) break;
    if (char === "`") return undefined;
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      plain = false;
      index += 2;
      // A line continuation joins the word to what follows; it is no character of it.
      if (next === "\n") continue;
      if (value !== undefined) value += next;
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close === -1) return undefined;
      const quoted = text.slice(index + 1, close);
      if (CONTROL.test(quoted)) plain = false;
      if (value !== undefined) value += quoted;
      index = close + 1;
    } else if (char === '"') {
      const quoted = lexDoubleQuoted(text, index, depth, lexer);
      if (quoted === undefined) return undefined;
      const body = text.slice(index + 1, quoted.end - 1);
      if (CONTROL.test(body) || !isLiteralDoubleQuoted(body)) plain = false;
      value = value === undefined || quoted.value === undefined ? undefined : value + quoted.value;
      index = quoted.end;
    } else if (char === "$") {
      const after = lexDollar(text, index, depth, false, lexer);
      if (after === undefined) return undefined;
      plain = false;
      if (after > index + 1) value = undefined;
      else if (value !== undefined) value += char;
      index = after;
    } else {
      if (!PLAIN.test(char)) plain = false;
      if (value !== undefined) value += char;
      index += 1;
    }
    end = index;
  }
  return {
    start,
    end,
    next: index,
    raw: text.slice(start, end),
    ...(value === undefined ? {} : { value }),
    plain,
  };
}

/**
 * Lexes the list starting at `from`: at depth 0 the whole program, deeper the body of a `$(...)`
 * ending at its `)`. Undefined for anything the lexer cannot delimit (see `splitDisplayFilters`).
 */
function lexList(text: string, from: number, depth: number, lexer: Lexer): LexedList | undefined {
  if (depth > MAX_SUBSTITUTION_DEPTH) return undefined;
  const pipelines: ListStage[][] = [];
  /** Heredocs of this list whose bodies start after its next line break. */
  const heredocs: Heredoc[] = [];
  const bodies: { start: number; end: number }[] = [];
  let stages: ListStage[] = [];
  let stage: ListStage | undefined;
  /** Offset of the `|` the next stage follows. */
  let pipe: number | undefined;
  /** Whether a command must follow (after `|`, `&&`, `||`). */
  let continues = false;
  /** Whether a redirection operator awaits its target word. */
  let target = false;
  let contentEnd = from;
  const endStage = (): boolean => {
    if (stage === undefined || target) return false;
    stages.push(stage);
    stage = undefined;
    return true;
  };
  const endPipeline = (): void => {
    pipelines.push(stages);
    stages = [];
  };
  const begin = (start: number): ListStage => {
    if (stage === undefined) {
      stage = {
        start,
        end: start,
        words: [],
        redirects: false,
        ...(pipe === undefined ? {} : { pipe }),
      };
      pipe = undefined;
    }
    return stage;
  };
  let index = from;
  for (;;) {
    const char = text[index];
    if (char === undefined || (char === ")" && depth > 0)) {
      if ((char === undefined) !== (depth === 0) || heredocs.length > 0) return undefined;
      if (stage !== undefined) {
        if (!endStage()) return undefined;
        endPipeline();
      } else if (continues) {
        return undefined;
      }
      return { pipelines, end: char === undefined ? index : index + 1, contentEnd, bodies };
    }
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (char === "\\" && text[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (char === "\n") {
      // A line break ends a command; a blank line or one after `|`, `&&`, `||` is nothing.
      if (stage !== undefined) {
        if (!endStage()) return undefined;
        endPipeline();
      }
      index += 1;
      // The bodies of the heredocs this line opened follow it.
      if (heredocs.length > 0) {
        const after = readHeredocBodies(text, index, heredocs, depth > 0);
        if (after === undefined) return undefined;
        bodies.push({ start: index, end: after });
        lexer.pending -= heredocs.length;
        heredocs.length = 0;
        index = after;
        contentEnd = after;
      }
      continue;
    }
    if (char === ";") {
      if (text[index + 1] === ";" || text[index + 1] === "&" || !endStage()) return undefined;
      endPipeline();
      index += 1;
      contentEnd = index;
      continue;
    }
    if (char === "&") {
      // `&&` only: a lone `&` runs in the background, `&>` is one in sh.
      if (text[index + 1] !== "&" || !endStage()) return undefined;
      endPipeline();
      continues = true;
      index += 2;
      contentEnd = index;
      continue;
    }
    if (char === "|") {
      const next = text[index + 1];
      if (next === "&" || !endStage()) return undefined;
      if (next === "|") {
        endPipeline();
        index += 2;
      } else {
        pipe = index;
        index += 1;
      }
      continues = true;
      contentEnd = index;
      continue;
    }
    if (char === "<" || char === ">") {
      const next = text[index + 1];
      // Never `<>`, `>|`, or a process substitution; a here-string only where the shell has them.
      const hereString = char === "<" && next === "<" && text[index + 2] === "<";
      if (
        target ||
        next === "(" ||
        (char === "<" ? next === ">" : next === "|") ||
        (hereString && !lexer.hereStrings)
      ) {
        return undefined;
      }
      const current = begin(index);
      // A descriptor number written against the operator (`2>`) belongs to it, not to the words;
      // a named descriptor (`{fd}>`) assigns a variable.
      const previous = current.words.at(-1);
      if (previous !== undefined && previous.end === index && previous.next === index) {
        if (/^\d+$/.test(previous.raw)) current.words.pop();
        else if (previous.raw.startsWith("{")) return undefined;
      }
      current.redirects = true;
      continues = false;
      if (char === "<" && next === "<" && !hereString) {
        // A heredoc: its delimiter is the next word, quotes removed; no expansion in it.
        const strip = text[index + 2] === "-";
        let at = index + (strip ? 3 : 2);
        while (text[at] === " " || text[at] === "\t") at += 1;
        const opener = text[at];
        if (
          opener === undefined ||
          WORD_END.includes(opener) ||
          opener === "#" ||
          (opener === "\\" && text[at + 1] === "\n")
        ) {
          return undefined;
        }
        const delimiter = lexWord(text, at, depth, lexer);
        if (
          delimiter === undefined ||
          delimiter.end === at ||
          delimiter.value === undefined ||
          delimiter.value.length === 0 ||
          delimiter.value.includes("\n")
        ) {
          return undefined;
        }
        heredocs.push({
          delimiter: delimiter.value,
          strip,
          quoted: /['"\\]/.test(delimiter.raw),
        });
        lexer.pending += 1;
        current.end = delimiter.end;
        contentEnd = delimiter.end;
        index = delimiter.next;
        continue;
      }
      target = true;
      index += hereString ? 3 : next === "&" || (char === ">" && next === ">") ? 2 : 1;
      contentEnd = index;
      continue;
    }
    if (char === "(" || char === ")" || char === "`") return undefined;
    if (char === "#") {
      // A comment, at the top level only (one inside `$(...)` may hide its `)`).
      if (depth > 0) return undefined;
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    const word = lexWord(text, index, depth, lexer);
    if (word === undefined) return undefined;
    const current = begin(index);
    if (target) {
      target = false;
    } else {
      const commandPosition = current.words.every((entry) => ASSIGNMENT.test(entry.raw));
      if (commandPosition && word.value !== undefined && SHELL_KEYWORDS.has(word.value)) {
        return undefined;
      }
      current.words.push(word);
    }
    current.end = word.end;
    contentEnd = word.end;
    continues = false;
    index = word.next;
  }
}

/** Whether a version-2 stage is a display filter: version 1's, in version 1's word grammar. */
function isDisplayFilterListStage(stage: ListStage): boolean {
  if (stage.redirects || !stage.words.every((word) => word.plain && word.value !== undefined)) {
    return false;
  }
  return isDisplayFilterStage({ words: stage.words.map((word) => word.value!), redirects: false });
}

/**
 * Whether a kept stage of a cut pipeline may run without the stages dropped after it: an ordinary
 * command whose name is a literal word, neither a builtin nor a keyword (it may now run in the
 * shell itself), nor a bare assignment, nor a `tail` that follows its input (alone it never ends).
 */
function isKeepableStage(stage: ListStage): boolean {
  const at = stage.words.findIndex((word) => !ASSIGNMENT.test(word.raw));
  const command = at === -1 ? undefined : stage.words[at]!.value;
  if (
    command === undefined ||
    Object.hasOwn(SHELL_BUILTINS, command) ||
    SHELL_KEYWORDS.has(command)
  ) {
    return false;
  }
  if (command !== "tail") return true;
  const words = stage.words.slice(at).map((word) => word.value);
  if (words.some((word) => word === undefined)) return false;
  return !isFollowingTail({ words: words as string[], redirects: false });
}

/** One display filter dropped from a version-2 program, as exact offsets into its text. */
export interface DisplayFilterCut {
  /** Offset of the first stage of the pipeline the filter is cut from. */
  pipelineStart: number;
  /** Offset after the pipeline's last kept stage: the cut `text.slice(start, end)` begins here. */
  start: number;
  /** Offset after the filter's last stage. */
  end: number;
  /** The dropped stages: the text after the first dropped `|` up to `end`, whitespace trimmed. */
  filter: string;
}

/** A version-2 program split before its display filters. */
export interface DisplayFilterSplit {
  /** The program with every cut removed, and nothing after its last token (blanks, a comment). */
  command: string;
  /** The cuts, in program order; never empty. */
  cuts: DisplayFilterCut[];
}

/**
 * A recorded shell program split under version 2 before the display filters its top-level
 * pipelines piped their output through. Undefined unless `version` is 2, `shell` is a POSIX shell,
 * the lexer below delimits the whole program, and at least one top-level pipeline has a trailing
 * run of display-filter stages leaving at least one stage before it; every such run is cut.
 *
 * The lexer reads the program's top-level list: pipelines separated by `;`, line breaks, `&&` and
 * `||` (a line break may follow `|`, `&&`, `||`; blank lines, line continuations and top-level `#`
 * comments are allowed). Words may hold `'...'`, `"..."` (escapes and expansions included), `\`
 * escapes, `$NAME`, `$?` and the other one-character parameters, `${...}` holding only a name and
 * plain operators, and `$(...)` whose body the same lexer delimits; redirections `<`, `>`, `>>`,
 * `<&`, `>&`, with a descriptor number (`2>&1`, `>/dev/null`); under bash, here-strings `<<<`.
 * Heredocs `<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` and `<<-WORD`, at the top level and inside
 * `$(...)` (`--body "$(cat <<'EOF' ... EOF
)"`), have opaque bodies (see `readHeredocBodies`)
 * starting after the line break that ends their operator's line; a cut never holds one.
 *
 * It refuses the whole program on anything it cannot delimit safely: a heredoc whose body it
 * cannot read so, or with a `$(...)` opened between its operator and its body; a here-string
 * outside bash; a backtick; an unbalanced quote or parenthesis; a `(`/`)` outside `$(...)`
 * (subshells, process substitution, `$((...))`); `$[...]`; `$'...'`; `<>`, `>|`, `|&`, a lone
 * `&`, `;;`; an empty command; a keyword in command position (`if`, `for`, `while`, `case`, `{`,
 * `!`, `[[`, `function`, ...); and any `PIPESTATUS`/`pipestatus` reference. It also refuses a cut
 * pipeline whose kept stages are not all `isKeepableStage`, or whose `tail` follows its input.
 *
 * Cuts are exact slices: `text.slice(start, end)` is the blanks before the first dropped `|`, the
 * dropped stages, and nothing after them; `command` is `text` without them, up to its last token
 * or heredoc body.
 */
export function splitDisplayFilters(
  shell: string,
  text: string,
  version: number = DISPLAY_FILTER_VERSION,
): DisplayFilterSplit | undefined {
  if (version !== 2 || !Object.hasOwn(POSIX_SHELLS, shell) || PIPE_STATUS.test(text)) {
    return undefined;
  }
  const list = lexList(text, 0, 0, { hereStrings: shell === "bash", pending: 0 });
  if (list === undefined) return undefined;
  const cuts: DisplayFilterCut[] = [];
  for (const stages of list.pipelines) {
    let first = stages.length;
    while (first > 0 && isDisplayFilterListStage(stages[first - 1]!)) first -= 1;
    if (first === stages.length || first === 0) continue;
    if (!stages.slice(0, first).every(isKeepableStage)) return undefined;
    const end = stages.at(-1)!.end;
    cuts.push({
      pipelineStart: stages[0]!.start,
      start: stages[first - 1]!.end,
      end,
      filter: text.slice(stages[first]!.pipe! + 1, end).trim(),
    });
  }
  // A cut never holds a heredoc body (`cat <<EOF |`, the body, then `grep x`).
  if (
    cuts.length === 0 ||
    list.bodies.some((body) => cuts.some((cut) => body.start < cut.end && body.end > cut.start))
  ) {
    return undefined;
  }
  let command = "";
  let from = 0;
  for (const cut of cuts) {
    command += text.slice(from, cut.start);
    from = cut.end;
  }
  return { command: command + text.slice(from, Math.max(from, list.contentEnd)), cuts };
}

/**
 * The text a display-filter step of `version` drops, as `[start, end)` ranges of `text`: everything
 * after the command under version 1, each cut under version 2. Undefined when `text` does not split.
 */
export function displayFilterDroppedRanges(
  shell: string,
  text: string,
  version: number,
): { start: number; end: number }[] | undefined {
  if (version === 1) {
    const split = splitDisplayFilter(shell, text, version);
    return split === undefined ? undefined : [{ start: split.command.length, end: text.length }];
  }
  return splitDisplayFilters(shell, text, version)?.cuts.map(({ start, end }) => ({ start, end }));
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
