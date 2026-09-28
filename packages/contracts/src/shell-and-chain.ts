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
 *   - `>`, `>>`, `<`, `2>` and `2>>`, each followed (after optional blanks) by one target word in
 *     the same grammar that is a plain file path: no `..` component, never under `/dev`, `/proc`
 *     or `/sys`;
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
 * Every splitter version this device still re-splits under: version 1 is the grammar without
 * redirections, so plans and tools split by an older device keep verifying and running.
 */
export type ShellAndChainSplitterVersion = 1 | typeof SHELL_AND_CHAIN_SPLITTER_VERSION;
const SPLITTER_VERSIONS: ReadonlySet<number> = new Set([1, SHELL_AND_CHAIN_SPLITTER_VERSION]);

/**
 * Where a redirection may never point, after quote removal: the kernel's and bash's special files
 * (`/dev/tcp`, `/dev/udp`, `/dev/fd`, `/dev/std*`, `/proc/self/fd`, ...), which open sockets or
 * alias descriptors instead of writing or reading a file.
 */
const SPECIAL_FILE_ROOTS = ["dev", "proc", "sys"];

/**
 * Whether a redirection target is a plain file path: relative or absolute, no `..` component, and
 * not under a special-file root however its slashes and `.` components are spelled.
 */
function isPlainFileTarget(target: string): boolean {
  const parts = target.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return false;
  return !(target.startsWith("/") && SPECIAL_FILE_ROOTS.includes(parts[0]!));
}

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
  version: ShellAndChainSplitterVersion;
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
function segmentWords(
  text: string,
  version: ShellAndChainSplitterVersion = SHELL_AND_CHAIN_SPLITTER_VERSION,
): { words: string[]; redirects: boolean } | undefined {
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
    // Version 1 has no redirections: their operators are unsafe characters of a word.
    const redirection = version === 1 ? undefined : redirectionAt(text, index);
    if (redirection === null || (redirection !== undefined && words.length === 0)) return undefined;
    if (redirection !== undefined) {
      redirects = true;
      index = redirection.end;
      if (!redirection.target) continue;
      while (isBlank(text[index])) index += 1;
      if (index === text.length || redirectionAt(text, index) !== undefined) return undefined;
      const target = word();
      if (target === undefined || !isPlainFileTarget(target)) return undefined;
      continue;
    }
    const next = word();
    if (next === undefined) return undefined;
    words.push(next);
  }
  return { words, redirects };
}

/** Whether a segment runs an external command, the only kind of segment a chain splits into. */
function runsExternalCommand(text: string, version: ShellAndChainSplitterVersion): boolean {
  const first = segmentWords(text, version)?.words[0];
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
export function splitShellAndChain(
  shell: string,
  source: string,
  version: ShellAndChainSplitterVersion = SHELL_AND_CHAIN_SPLITTER_VERSION,
): ShellAndChain | undefined {
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
    if (wordStart && version !== 1) {
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
    if (!runsExternalCommand(text, version)) return undefined;
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
  return { version, segments };
}

/**
 * The text of one segment of a recorded chain, re-split for the recorded `shell` under the
 * segment's own splitter version: undefined when the recorded source is not text, the version is
 * one this device does not have, or the source does not split under it into that many segments.
 */
export function shellAndChainSegmentText(
  shell: string,
  source: unknown,
  segment: { index: number; count: number; version: number },
): string | undefined {
  if (typeof source !== "string" || !SPLITTER_VERSIONS.has(segment.version)) return undefined;
  const chain = splitShellAndChain(shell, source, segment.version as ShellAndChainSplitterVersion);
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
 * Commands that only read files and print: none can write a file or run another program. A chain's
 * trailing `cat` of what it wrote is the harness's `read` in another run.
 */
const READ_ONLY_INSPECTIONS: ReadonlySet<string> = new Set([
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
  "stat",
  "grep",
  "cmp",
  "diff",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "b2sum",
]);

/**
 * Whether a segment only inspects named files: no redirection, no assignment prefix, a first word
 * (quotes removed, no `/`) in the closed read-only list, and at least one file operand — never `-`
 * and never a special file — so it reads no stdin. `grep`'s first operand is its pattern.
 */
export function isReadOnlyInspectionSegment(text: string): boolean {
  const parsed = segmentWords(text);
  const first = parsed?.words[0];
  if (
    parsed === undefined ||
    parsed.redirects ||
    first === undefined ||
    first.includes("/") ||
    first.includes("=") ||
    !READ_ONLY_INSPECTIONS.has(first)
  )
    return false;
  const operands = parsed.words.slice(1).filter((word) => word === "-" || !word.startsWith("-"));
  const files = first === "grep" ? operands.slice(1) : operands;
  return files.length > 0 && files.every((file) => file !== "-" && isPlainFileTarget(file));
}

/**
 * Whether a chain's segment, as this device re-split it, may go unnamed by a plan's steps: its
 * `mkdir -p` setup anywhere under any splitter version, and from version 2 also a read-only
 * inspection `trailing` every named segment of the chain — a check before a named segment decided
 * whether that segment ran, so leaving it out would change what the chain did. The cloud mirrors
 * this rule for plans it addresses under `and-chain-segments-v2`.
 */
export function isSkippableSegment(
  text: string,
  version: number,
  position: { trailing: boolean },
): boolean {
  return (
    isOptionalSetupSegment(text) ||
    (position.trailing &&
      version >= SHELL_AND_CHAIN_SPLITTER_VERSION &&
      isReadOnlyInspectionSegment(text))
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
