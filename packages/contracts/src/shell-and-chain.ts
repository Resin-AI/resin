/**
 * Splitting a recorded POSIX shell program at its top-level `&&` operators, so each command of a
 * chain can be compared, held out and replayed as a step of its own.
 *
 * The splitter is an allowlist, not a parser: a program splits only when all of it is written in a
 * tiny grammar in which every shell (bash, zsh, dash) reads it the same way and running its segments
 * one after another, each aborting the rest on a non-zero exit, is exactly what the chain did.
 *
 * - Printable ASCII only; the only blanks are space and tab.
 * - Outside quotes, none of `$ \ `` # ! ( ) { } < > * ? [ ] ~ ; | % ^`, no `&` but the `&&`
 *   separators, and no word starting with `=`.
 * - Quotes are plain single-quoted strings (POSIX has no escapes inside them) and double-quoted
 *   strings drawn from the same safe set (no `$`, backtick, backslash or `!` inside).
 * - Every segment's first word, quotes removed, is an external command: never a builtin, keyword or
 *   special word of bash, zsh or dash, never an assignment, never an option.
 *
 * Anything else stays one program. Segments are exact byte ranges of the recorded source, and the
 * segments re-joined with the recorded separators are the source byte for byte. The splitter carries
 * a version: a device whose splitter version differs from the one a plan was split with admits
 * none of its segments.
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

/**
 * Every builtin, reserved word and special word of bash 5, zsh 5 and dash (their manuals' builtin
 * and reserved-word lists). A segment starting with one never splits: a builtin may change state a
 * later segment sees, or read state an earlier one set.
 */
const SHELL_WORDS: ReadonlySet<string> = new Set([
  // Reserved words and special words.
  "!",
  "[[",
  "]]",
  "{",
  "}",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "end",
  "esac",
  "fi",
  "for",
  "foreach",
  "function",
  "if",
  "in",
  "nocorrect",
  "noglob",
  "repeat",
  "select",
  "then",
  "time",
  "until",
  "while",
  "-",
  // bash builtins.
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
  // zsh builtins beyond bash's.
  "autoload",
  "bindkey",
  "bye",
  "cap",
  "chdir",
  "clone",
  "comparguments",
  "compcall",
  "compctl",
  "compdescribe",
  "compfiles",
  "compgroups",
  "compquote",
  "comptags",
  "comptry",
  "compvalues",
  "disable",
  "echotc",
  "echoti",
  "emulate",
  "float",
  "functions",
  "getcap",
  "getln",
  "integer",
  "limit",
  "log",
  "print",
  "private",
  "pushln",
  "r",
  "rehash",
  "sched",
  "setcap",
  "setopt",
  "stat",
  "unfunction",
  "unhash",
  "unlimit",
  "unsetopt",
  "vared",
  "whence",
  "where",
  "which",
  "zcompile",
  "zformat",
  "zftp",
  "zle",
  "zmodload",
  "zparseopts",
  "zprof",
  "zpty",
  "zregexparse",
  "zsocket",
  "zstyle",
  "ztcp",
]);

/** Characters never allowed outside single quotes. */
const UNSAFE = new Set("$\\`#!(){}<>*?[]~;|%^");
/** Characters never allowed inside double quotes. */
const UNSAFE_IN_DOUBLE_QUOTES = new Set("$\\`!");

export interface ShellAndChainSegment {
  /** Half-open [start, end) offsets of the segment's text in the recorded source. */
  start: number;
  end: number;
  /** The segment exactly as recorded, without the blanks around it. */
  text: string;
}

export interface ShellAndChain {
  version: typeof SHELL_AND_CHAIN_SPLITTER_VERSION;
  segments: ShellAndChainSegment[];
}

const isBlank = (char: string): boolean => char === " " || char === "\t";

/**
 * A segment's words with their quotes removed, or undefined when the segment is not in the grammar.
 * Offsets outside quotes were already checked by the chain scan.
 */
function segmentWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (isBlank(char)) {
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
    word += char;
  }
  if (inWord) words.push(word);
  return words;
}

/** Whether a segment runs an external command, the only kind of segment a chain splits into. */
function runsExternalCommand(text: string): boolean {
  const first = segmentWords(text)?.[0];
  return (
    first !== undefined &&
    first.length > 0 &&
    !SHELL_WORDS.has(first) &&
    !first.startsWith("-") &&
    !first.includes("=")
  );
}

/**
 * The top-level `&&` segments of a recorded program, or `undefined` when `shell` is not a POSIX
 * shell, or the program is not a chain of two or more external commands in the grammar above.
 */
export function splitShellAndChain(shell: string, source: string): ShellAndChain | undefined {
  if (POSIX_SHELLS[shell] !== true) return undefined;
  const cuts: Array<[number, number]> = [];
  let quote: "'" | '"' | undefined;
  let wordStart = true;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const code = char.charCodeAt(0);
    if (char !== "\t" && (code < 0x20 || code > 0x7e)) return undefined;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (UNSAFE_IN_DOUBLE_QUOTES.has(char)) return undefined;
      continue;
    }
    if (isBlank(char)) {
      wordStart = true;
      continue;
    }
    if (char === "&") {
      if (source[index + 1] !== "&") return undefined;
      cuts.push([index, index + 2]);
      index += 1;
      wordStart = true;
      continue;
    }
    if (UNSAFE.has(char) || (wordStart && char === "=")) return undefined;
    wordStart = false;
    if (char === "'" || char === '"') quote = char;
  }
  if (quote !== undefined || cuts.length === 0) return undefined;
  const segments: ShellAndChainSegment[] = [];
  let from = 0;
  for (const [cutStart, cutEnd] of [...cuts, [source.length, source.length] as [number, number]]) {
    let start = from;
    let end = cutStart;
    while (start < end && isBlank(source[start]!)) start += 1;
    while (end > start && isBlank(source[end - 1]!)) end -= 1;
    if (start === end) return undefined;
    const text = source.slice(start, end);
    if (!runsExternalCommand(text)) return undefined;
    segments.push({ start, end, text });
    from = cutEnd;
  }
  // Defence in depth: the segments and the recorded separators between them are the source.
  let rejoined = source.slice(0, segments[0]!.start);
  for (const [index, segment] of segments.entries()) {
    rejoined += segment.text;
    const next = segments[index + 1];
    const separator = source.slice(segment.end, next?.start ?? source.length);
    if (next !== undefined && !/^[ \t]*&&[ \t]*$/.test(separator)) return undefined;
    if (next === undefined && !/^[ \t]*$/.test(separator)) return undefined;
    rejoined += separator;
  }
  if (!/^[ \t]*$/.test(source.slice(0, segments[0]!.start)) || rejoined !== source)
    return undefined;
  return { version: SHELL_AND_CHAIN_SPLITTER_VERSION, segments };
}

/**
 * The text of one segment of a recorded chain, re-split under this splitter for the recorded
 * `shell`: undefined when the recorded source is not text, does not split, or was split by another
 * splitter version or into another number of segments.
 */
export function shellAndChainSegmentText(
  shell: string,
  source: unknown,
  segment: { index: number; count: number; version: number },
): string | undefined {
  if (typeof source !== "string" || segment.version !== SHELL_AND_CHAIN_SPLITTER_VERSION)
    return undefined;
  const chain = splitShellAndChain(shell, source);
  if (chain === undefined || chain.segments.length !== segment.count) return undefined;
  return chain.segments[segment.index]?.text;
}

/**
 * Whether a segment only creates directories — `mkdir -p` and plain path words — the one setup a
 * chain may run or omit without changing what its other segments do.
 */
export function isOptionalSetupSegment(text: string): boolean {
  const words = segmentWords(text);
  return (
    words !== undefined &&
    words.length >= 3 &&
    words[0] === "mkdir" &&
    words[1] === "-p" &&
    words.slice(2).every((word) => word.length > 0 && !word.startsWith("-"))
  );
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
 * split as the step was split); otherwise the original itself. The recording check admitted the
 * segment only under the recorded POSIX shell; the grammar reads the same in every POSIX shell.
 */
export function segmentOriginal(
  step: Pick<WorkflowStep, "segment" | "callable">,
  argument: string,
  original: unknown,
): unknown {
  if (step.segment === undefined || step.callable.program?.argument !== argument) return original;
  return shellAndChainSegmentText("sh", original, step.segment);
}
