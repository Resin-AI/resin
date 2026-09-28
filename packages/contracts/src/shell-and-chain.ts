/**
 * Splitting a recorded POSIX shell program at its top-level `&&` operators, so each command of a
 * chain can be compared, held out and replayed as a step of its own.
 *
 * The splitter is an allowlist, not a parser: a program splits only when all of it is written in a
 * tiny grammar in which every shell it covers (bash, sh, dash) reads it the same way and running its segments
 * one after another, each aborting the rest on a non-zero exit, is exactly what the chain did.
 *
 * - Printable ASCII only; the only blanks are space and tab.
 * - Outside quotes, none of `$ \ `` # ! ( ) { } < > * ? [ ] ~ ; | % ^`, no `&` but the `&&`
 *   separators, and no word starting with `=` — except these redirections, each starting a word
 *   after a segment's command word and staying inside that segment's text:
 *   - `>`, `>>`, `<`, `2>` and `2>>`, each followed (after optional blanks) by one non-empty
 *     target word in the same grammar;
 *   - `2>&1`, `1>&2` and `>&2`, followed by a blank or the end.
 *
 *   `<<`, `<<<`, `<(`, `>(`, `>|`, `&>`, `&>>`, `<>`, `<&`, any other descriptor, `>&` of a word,
 *   a redirection without a target and a redirection before the command word never split.
 * - Quotes are plain single-quoted strings (POSIX has no escapes inside them) and double-quoted
 *   strings drawn from the same safe set (no `$`, backtick, backslash or `!` inside).
 * - Every segment's first word, quotes removed, is an external command: never a builtin, keyword or
 *   special word of bash or dash, never an assignment, never an option.
 *
 * Anything else stays one program.
 *
 * What the grammar cannot see: a function or alias the shell defined before running the program —
 * from an rc or profile file a login shell (`bash -lc`) reads, or a harness's shell snapshot — may
 * shadow an external command name. Such a definition that keeps state across commands would make
 * segments run apart differ from the chain; the split is only as faithful as that environment. Segments are exact byte ranges of the recorded source, and the
 * segments re-joined with the recorded separators are the source byte for byte. The splitter carries
 * a version: a device whose splitter version differs from the one a plan was split with admits
 * none of its segments.
 */

import type { WorkflowStep } from "./recorded-workflow.js";

/** The version of these splitting rules; bump it whenever a program would split differently. */
export const SHELL_AND_CHAIN_SPLITTER_VERSION = 2 as const;

/**
 * Shells whose `&&` lists these rules describe. zsh, PowerShell and any other shell never split.
 */
const POSIX_SHELLS: Readonly<Record<string, true>> = {
  bash: true,
  sh: true,
  dash: true,
};

/**
 * Every builtin, reserved word and special word of bash 5 and dash (their manuals' builtin and
 * reserved-word lists). A segment starting with one never splits: a builtin may change state a
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

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";

/**
 * The redirection operator starting at `index`, at the start of a word outside quotes: undefined
 * when none starts there, null when one does but is not in the grammar, else the offset after the
 * operator and whether a target word must follow it.
 */
function redirectionAt(
  text: string,
  index: number,
): { end: number; target: boolean } | null | undefined {
  let at = index;
  let descriptor: string | undefined;
  if (/[0-9]/.test(text[at] ?? "")) {
    if (text[at + 1] !== ">" && text[at + 1] !== "<") return undefined;
    descriptor = text[at];
    at += 1;
  }
  const operator = text[at];
  const next = text[at + 1];
  if (operator === "<") {
    if (descriptor !== undefined || (next !== undefined && "<>&(|".includes(next))) return null;
    return { end: at + 1, target: true };
  }
  if (operator !== ">") return undefined;
  if (next === "&") {
    const duplicated = `${descriptor ?? ""}>&${text[at + 2] ?? ""}`;
    const after = text[at + 3];
    if (!["2>&1", "1>&2", ">&2"].includes(duplicated) || (after !== undefined && !isBlank(after)))
      return null;
    return { end: at + 3, target: false };
  }
  if (descriptor !== undefined && descriptor !== "2") return null;
  if (next === ">") {
    const third = text[at + 2];
    if (third !== undefined && ">&|(<".includes(third)) return null;
    return { end: at + 2, target: true };
  }
  if (next !== undefined && "|(<".includes(next)) return null;
  return { end: at + 1, target: true };
}

/**
 * A segment's command and argument words with their quotes removed, and whether it redirects, or
 * undefined when the segment is not in the grammar: an unquoted character outside it, a redirection
 * outside it, before the command word, or without a non-empty target word.
 */
function segmentWords(text: string): { words: string[]; redirects: boolean } | undefined {
  const words: string[] = [];
  let redirects = false;
  let index = 0;
  /** The word starting at `index`, quotes removed, advancing past it; undefined when not safe. */
  const word = (): string | undefined => {
    let value = "";
    if (text[index] === "=") return undefined;
    while (index < text.length && !isBlank(text[index])) {
      const char = text[index]!;
      if (char === "'" || char === '"') {
        const close = text.indexOf(char, index + 1);
        if (close === -1) return undefined;
        const quoted = text.slice(index + 1, close);
        if (char === '"' && [...quoted].some((inner) => UNSAFE_IN_DOUBLE_QUOTES.has(inner)))
          return undefined;
        value += quoted;
        index = close + 1;
        continue;
      }
      if (UNSAFE.has(char) || char === "&") return undefined;
      value += char;
      index += 1;
    }
    return value;
  };
  while (index < text.length) {
    if (isBlank(text[index])) {
      index += 1;
      continue;
    }
    const redirection = redirectionAt(text, index);
    if (redirection === null || (redirection !== undefined && words.length === 0)) return undefined;
    if (redirection !== undefined) {
      redirects = true;
      index = redirection.end;
      if (!redirection.target) continue;
      while (isBlank(text[index])) index += 1;
      if (index === text.length || redirectionAt(text, index) !== undefined) return undefined;
      const target = word();
      if (target === undefined || target.length === 0) return undefined;
      continue;
    }
    const next = word();
    if (next === undefined) return undefined;
    words.push(next);
  }
  return { words, redirects };
}

/** Whether a segment runs an external command, the only kind of segment a chain splits into. */
function runsExternalCommand(text: string): boolean {
  const first = segmentWords(text)?.words[0];
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
    if (wordStart) {
      // A redirection stays inside its segment; `segmentWords` checks its place and its target.
      const redirection = redirectionAt(source, index);
      if (redirection === null) return undefined;
      if (redirection !== undefined) {
        index = redirection.end - 1;
        continue;
      }
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
  const parsed = segmentWords(text);
  if (parsed === undefined || parsed.redirects) return false;
  const { words } = parsed;
  return (
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
 * What one argument of a step ran, given the original text its recording holds: for a step's
 * program argument at a segment `address` — by default the step's own segment — that segment of
 * the recorded chain (undefined when the original does not split so); otherwise the original
 * itself. The recording check admitted the segment only under the recorded POSIX shell; the grammar
 * reads the same in every POSIX shell.
 */
export function segmentOriginal(
  step: Pick<WorkflowStep, "segment" | "callable">,
  argument: string,
  original: unknown,
  address: { index: number; count: number; version: number } | null = step.segment ?? null,
): unknown {
  if (address === null || step.callable.program?.argument !== argument) return original;
  return shellAndChainSegmentText("sh", original, address);
}
