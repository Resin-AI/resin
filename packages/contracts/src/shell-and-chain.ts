/**
 * Splitting a recorded POSIX shell program at its top-level `&&` operators, so each command of a
 * chain can be compared, held out and replayed as a step of its own.
 *
 * A chain is split only where running its segments one after another, each aborting the rest on a
 * non-zero exit, is exactly what the shell did: no segment may change shell state a later segment
 * sees (`cd`, `export`, a bare assignment, ...), read the status of an earlier one (`$?`, `$!`,
 * `$_`, `PIPESTATUS`), or sit in any construct other than a plain `&&` list (`;`, `||`, `|`, `&`,
 * a newline, a comment, a heredoc, a continuation, a subshell, a substitution or a brace group).
 * Anything else stays one program. A chain whose recorded exit status is zero ran every segment.
 *
 * Segments are exact byte ranges of the recorded source. The splitter carries a version: a device
 * whose splitter version differs from the one a plan was split with admits none of its segments.
 */

import type { WorkflowStep } from "./recorded-workflow.js";

/** The version of these splitting rules; bump it whenever a program would split differently. */
export const SHELL_AND_CHAIN_SPLITTER_VERSION = 1 as const;

/** Shells whose `&&` lists these rules describe. PowerShell and any other language never split. */
const POSIX_SHELLS: Readonly<Record<string, true>> = {
  bash: true,
  sh: true,
  zsh: true,
  dash: true,
};

/** Builtins that change state a later segment of the same shell would see. */
const STATE_CHANGING_COMMANDS: Readonly<Record<string, true>> = {
  export: true,
  unset: true,
  set: true,
  shopt: true,
  alias: true,
  unalias: true,
  source: true,
  ".": true,
  exec: true,
  trap: true,
  umask: true,
  ulimit: true,
  cd: true,
  pushd: true,
  popd: true,
  declare: true,
  typeset: true,
  local: true,
  readonly: true,
  eval: true,
  hash: true,
  enable: true,
};

/**
 * Reserved words: a segment that starts a compound command is not a plain command. A Set, since
 * `then` cannot be an object key here.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "!",
  "[[",
  "{",
  "}",
]);

/** Parameters holding the status of an earlier command. */
const STATUS_PARAMETER = /\$(?:\?|!|_(?![A-Za-z0-9_])|\{[?!_]\})|PIPESTATUS/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/;

export interface ShellAndChainSegment {
  /** Half-open [start, end) offsets of the segment's text in the recorded source. */
  start: number;
  end: number;
  /** The segment exactly as recorded, without the whitespace around it. */
  text: string;
}

export interface ShellAndChain {
  version: typeof SHELL_AND_CHAIN_SPLITTER_VERSION;
  segments: ShellAndChainSegment[];
}

/**
 * The words of one segment, as a shell would split it (quotes removed only for comparison), or
 * `undefined` when the segment is not a plain command.
 */
function segmentWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1);
      if (close === -1) return undefined;
      word += text.slice(index + 1, close);
      index = close;
      continue;
    }
    if (char === "\\") {
      word += text[index + 1] ?? "";
      index += 1;
      continue;
    }
    word += char;
  }
  if (inWord) words.push(word);
  return words;
}

/** Whether a segment is a plain command that changes no state a later segment could see. */
function isPlainCommand(text: string): boolean {
  const words = segmentWords(text);
  if (words === undefined) return false;
  let position = 0;
  // `VAR=x cmd` sets VAR for cmd alone; a segment of assignments only sets it for the shell.
  while (position < words.length && ASSIGNMENT.test(words[position]!)) position += 1;
  let command = words[position];
  if (command === undefined) return false;
  if (RESERVED_WORDS.has(command)) return false;
  // `builtin cd` and `command cd` still run the builtin.
  while ((command === "builtin" || command === "command") && position + 1 < words.length) {
    position += 1;
    command = words[position]!;
  }
  return STATE_CHANGING_COMMANDS[command] !== true;
}

/**
 * The top-level `&&` segments of a recorded shell program, or `undefined` when the program is not
 * a chain of two or more plain commands under the rules above, or `shell` is not a POSIX shell.
 */
export function splitShellAndChain(shell: string, source: string): ShellAndChain | undefined {
  if (POSIX_SHELLS[shell] !== true) return undefined;
  if (STATUS_PARAMETER.test(source)) return undefined;
  const cuts: Array<[number, number]> = [];
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        // `\` then a newline continues the line even inside double quotes.
        if (source[index + 1] === "\n" || source[index + 1] === "\r") return undefined;
        index += 1;
      } else if (char === '"') quote = undefined;
      else if (char === "`" || (char === "$" && source[index + 1] === "(")) return undefined;
      continue;
    }
    switch (char) {
      case "'":
      case '"':
        quote = char;
        break;
      case "\\":
        if (index + 1 >= source.length || source[index + 1] === "\n" || source[index + 1] === "\r")
          return undefined;
        index += 1;
        break;
      case "&":
        if (source[index + 1] === "&") {
          cuts.push([index, index + 2]);
          index += 1;
        } else if (source[index - 1] !== ">" && source[index - 1] !== "<") {
          // A lone `&` backgrounds a command; `>&` and `<&` duplicate a descriptor.
          return undefined;
        }
        break;
      case "\n":
      case "\r":
      case ";":
      case "|":
      case "`":
      case "(":
      case ")":
      case "{":
      case "}":
      case "#":
        return undefined;
      case "<":
        // A heredoc or herestring is text a later line feeds in; never split around it.
        if (source[index + 1] === "<") return undefined;
        break;
      case "$":
        if (source[index + 1] === "(" || source[index + 1] === "{") return undefined;
        break;
      default:
        break;
    }
  }
  if (quote !== undefined || cuts.length === 0) return undefined;
  const segments: ShellAndChainSegment[] = [];
  let from = 0;
  for (const [cutStart, cutEnd] of [...cuts, [source.length, source.length] as [number, number]]) {
    let start = from;
    let end = cutStart;
    while (start < end && /\s/.test(source[start]!)) start += 1;
    while (end > start && /\s/.test(source[end - 1]!)) end -= 1;
    if (start === end) return undefined;
    const text = source.slice(start, end);
    if (!isPlainCommand(text)) return undefined;
    segments.push({ start, end, text });
    from = cutEnd;
  }
  return { version: SHELL_AND_CHAIN_SPLITTER_VERSION, segments };
}

/**
 * The text of one segment of a recorded POSIX shell chain, re-split under this splitter: undefined
 * when the recorded source is not text, does not split, or was split by another splitter version or
 * into another number of segments. The caller establishes that the recorded shell is POSIX.
 */
export function shellAndChainSegmentText(
  source: unknown,
  segment: { index: number; count: number; version: number },
): string | undefined {
  if (typeof source !== "string" || segment.version !== SHELL_AND_CHAIN_SPLITTER_VERSION)
    return undefined;
  const chain = splitShellAndChain("sh", source);
  if (chain === undefined || chain.segments.length !== segment.count) return undefined;
  return chain.segments[segment.index]?.text;
}

/**
 * The POSIX shell a recorded shell-program call ran in, or undefined: an OMP `bash` call, or a
 * Codex command run under a bash shell profile. Any other shell never splits.
 */
export function recordedPosixShell(
  callableName: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const profile = args.resinCodexShellProfile;
  if (typeof profile === "string") return profile.startsWith("bash-") ? "bash" : undefined;
  return POSIX_SHELLS[callableName] === true ? callableName : undefined;
}

/**
 * What one argument of a step ran, given the original text its recording holds: for a segment
 * step's program argument, that segment of the recorded chain (undefined when the original does not
 * split as the step was split); otherwise the original itself.
 */
export function segmentOriginal(
  step: Pick<WorkflowStep, "segment" | "callable">,
  argument: string,
  original: unknown,
): unknown {
  if (step.segment === undefined || step.callable.program?.argument !== argument) return original;
  return shellAndChainSegmentText(original, step.segment);
}
