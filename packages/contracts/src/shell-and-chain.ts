/**
 * Splitting a recorded POSIX shell program at its top-level `&&` operators, so each command of a
 * chain can be compared, held out and replayed as a step of its own.
 *
 * The splitter is an allowlist, not a parser: a program splits only when all of it is written in a
 * tiny grammar in which every shell it covers (bash, sh, dash) reads it the same way and running its segments
 * one after another, each aborting the rest on a non-zero exit, is exactly what the chain did.
 *
 * - Printable ASCII only; the only blanks are space and tab.
 * - Outside quotes, none of `$ \ `` # ! ( ) { } < > * ? [ ] ~ ; | % ^` (from version 3, a `~`
 *   inside a word after neither `=` nor `:`, and a `|` joining two commands of one segment into a
 *   pipeline, are allowed — never `||` or `|&`), no `&` but the `&&`
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
 * - Every segment's first word (every pipeline command's, from version 3), quotes removed, is an
 *   external command: never a builtin, keyword or
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
 *
 * From version 4 a top-level `;` or line break also separates segments: a batch the agent wrote as
 * one command per line (`tool a` ⏎ `tool b`) splits into one segment per line. Such a separator does
 * not abort the rest on a failure, so a recording's exit status is the last command's alone; a
 * segment answers with the chain's recorded output like any other, and a replay that fails a
 * segment misses it. Blank lines between commands and a trailing line break are separators too.
 * A line break inside quotes, or anywhere under an older version, never splits.
 */

import type { WorkflowRecordedProgram, WorkflowStep } from "./recorded-workflow.js";
import { type ShellDialect, isPosixShellDialect, isShellDialect } from "./shell-dialects.js";

/** The version of these splitting rules; bump it whenever a program would split differently. */
export const SHELL_AND_CHAIN_SPLITTER_VERSION = 4 as const;

/**
 * Every splitter version this device still re-splits under: version 1 is the grammar without
 * redirections, version 2 the grammar without a `~` inside a word, version 3 the grammar without
 * `;` or line-break separators, so plans and tools split by an older device keep verifying and
 * running.
 */
export type ShellAndChainSplitterVersion = 1 | 2 | 3 | typeof SHELL_AND_CHAIN_SPLITTER_VERSION;
const SPLITTER_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3, SHELL_AND_CHAIN_SPLITTER_VERSION]);

/**
 * A `~` no shell expands: inside a word, after neither `=` nor `:` (`HEAD~2..HEAD`). Tilde
 * expansion happens only at a word's start and after `=` or `:` in an assignment. From version 3.
 */
function literalTilde(
  text: string,
  index: number,
  wordStart: boolean,
  version: ShellAndChainSplitterVersion,
  zsh: boolean,
): boolean {
  return (
    version >= 3 &&
    !zsh &&
    text[index] === "~" &&
    !wordStart &&
    text[index - 1] !== "=" &&
    text[index - 1] !== ":"
  );
}

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
/**
 * A shell that may be zsh (Cursor runs its `Shell` tool in the user's login shell): split only in
 * the grammar zsh reads as sh does, without a mid-word `~` (EXTENDED_GLOB makes it a glob).
 */
const ZSH_OR_SH = "sh-or-zsh";

const POSIX_SHELLS: Readonly<Record<string, true>> = {
  [ZSH_OR_SH]: true,
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
 * outside it, before the command word, or without a non-empty target word. With
 * `stderrIntoPipe`, a `2>&1` on a stage before the last is in the grammar too: it only joins that
 * stage's stderr to the pipe, which every POSIX shell and zsh read the same way.
 */
function segmentWords(
  text: string,
  version: ShellAndChainSplitterVersion = SHELL_AND_CHAIN_SPLITTER_VERSION,
  zsh = false,
  stderrIntoPipe = false,
): { words: string[]; redirects: boolean; pipeline: string[][] } | undefined {
  // From version 3 a segment may be a pipeline: each `|`-separated command's words, in order.
  const pipeline: string[][] = [[]];
  let words = pipeline[0]!;
  let redirects = false;
  let index = 0;
  const pipes = version >= 3;
  /** Pipeline stages that redirect output: only the last may, as zsh's MULTIOS would tee it. */
  const outputStages: number[] = [];
  /** The word starting at `index`, quotes removed, advancing past it; undefined when not safe. */
  const word = (): string | undefined => {
    let value = "";
    if (text[index] === "=") return undefined;
    while (index < text.length && !isBlank(text[index]) && !(pipes && text[index] === "|")) {
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
      if (
        (UNSAFE.has(char) && !literalTilde(text, index, value.length === 0, version, zsh)) ||
        char === "&"
      )
        return undefined;
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
    if (pipes && text[index] === "|") {
      // `||` and `|&` are never in the grammar; a pipe joins two commands, neither empty.
      if (text[index + 1] === "|" || text[index + 1] === "&" || words.length === 0) {
        return undefined;
      }
      words = [];
      pipeline.push(words);
      index += 1;
      continue;
    }
    // Version 1 has no redirections: their operators are unsafe characters of a word.
    const redirection = version === 1 ? undefined : redirectionAt(text, index);
    if (redirection === null || (redirection !== undefined && words.length === 0)) return undefined;
    if (redirection !== undefined) {
      redirects = true;
      const stage = pipeline.length - 1;
      const input = text[/[0-9]/.test(text[index] ?? "") ? index + 1 : index] === "<";
      // Only the first stage of a pipeline reads a file and only the last writes one: zsh would
      // otherwise join the redirection and the pipe (MULTIOS), which no other shell does.
      if (input && stage > 0) return undefined;
      if (!input && !(stderrIntoPipe && text.startsWith("2>&1", index))) outputStages.push(stage);
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
  if (words.length === 0) return undefined;
  if (outputStages.some((stage) => stage < pipeline.length - 1)) return undefined;
  return { words: pipeline[0]!, redirects, pipeline };
}

/**
 * Whether a segment runs external commands only — one, or from version 3 a pipeline of them — the
 * only kind of segment a chain splits into.
 */
function runsExternalCommand(
  text: string,
  version: ShellAndChainSplitterVersion,
  zsh: boolean,
  stderrIntoPipe: boolean,
): boolean {
  const pipeline = segmentWords(text, version, zsh, stderrIntoPipe)?.pipeline;
  return (
    pipeline !== undefined &&
    pipeline.every((command) => {
      const first = command[0];
      return (
        first !== undefined &&
        first.length > 0 &&
        !SHELL_WORDS.has(first) &&
        !first.startsWith("-") &&
        !first.includes("=")
      );
    })
  );
}

/**
 * The top-level segments of a recorded program — at `&&`, and from version 4 also at `;` and line
 * breaks — or `undefined` when `shell` is not a POSIX shell, or the program is not a chain of two
 * or more external commands in the grammar above.
 */
export function splitShellAndChain(
  shell: string,
  source: string,
  version: ShellAndChainSplitterVersion = SHELL_AND_CHAIN_SPLITTER_VERSION,
): ShellAndChain | undefined {
  const scanned = scanShellSegments(shell, source, version, false);
  if (scanned === undefined || scanned.segments.length < 2) return undefined;
  return { version, segments: scanned.segments };
}

/**
 * The segments of a program in the grammar above, one or more, and how many separators the scan
 * cut it at; undefined when `shell` is not a POSIX shell or any of it is outside the grammar.
 */
function scanShellSegments(
  shell: string,
  source: string,
  version: ShellAndChainSplitterVersion,
  stderrIntoPipe: boolean,
): { segments: ShellAndChainSegment[]; separators: number } | undefined {
  if (POSIX_SHELLS[shell] !== true) return undefined;
  const zsh = shell === ZSH_OR_SH;
  const cuts: Array<[number, number]> = [];
  let quote: "'" | '"' | undefined;
  let wordStart = true;
  const lines = version >= 4;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const code = char.charCodeAt(0);
    // From version 4 a top-level `;` or line break ends a command as `&&` does.
    if (lines && quote === undefined && (char === "\n" || char === ";")) {
      cuts.push([index, index + 1]);
      wordStart = true;
      continue;
    }
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
    // From version 3 a pipe stays inside its segment: `a | b && c` runs `a | b`, then `c`.
    if (char === "|" && version >= 3) {
      if (source[index + 1] === "|" || source[index + 1] === "&") return undefined;
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
    if (
      (UNSAFE.has(char) && !literalTilde(source, index, wordStart, version, zsh)) ||
      (wordStart && char === "=")
    )
      return undefined;
    wordStart = false;
    if (char === "'" || char === '"') quote = char;
  }
  if (quote !== undefined) return undefined;
  const segments: ShellAndChainSegment[] = [];
  let from = 0;
  for (const [cutStart, cutEnd] of [...cuts, [source.length, source.length] as [number, number]]) {
    let start = from;
    let end = cutStart;
    while (start < end && isBlank(source[start]!)) start += 1;
    while (end > start && isBlank(source[end - 1]!)) end -= 1;
    from = cutEnd;
    // A blank line, the blanks after `&& ` before a line break, or a trailing line break: the
    // separator check below decides whether the separators around it are ones a shell reads.
    if (start === end && lines && segments.length > 0) continue;
    if (start === end) return undefined;
    const text = source.slice(start, end);
    if (!runsExternalCommand(text, version, zsh, stderrIntoPipe)) return undefined;
    segments.push({ start, end, text });
  }
  if (segments.length === 0) return undefined;
  // Defence in depth: the segments and the recorded separators between them are the source.
  let rejoined = source.slice(0, segments[0]!.start);
  for (const [index, segment] of segments.entries()) {
    rejoined += segment.text;
    const next = segments[index + 1];
    const separator = source.slice(segment.end, next?.start ?? source.length);
    // One `&&` or `;` at most, then any line breaks; or line breaks alone. A trailing `;` or line
    // break ends the program; a trailing `&&` never does.
    const between = lines ? /^[ \t]*(?:(?:&&|;)[ \t]*)?(?:\n[ \t]*)*$/ : /^[ \t]*&&[ \t]*$/;
    if (next !== undefined && (!between.test(separator) || /^[ \t]*$/.test(separator)))
      return undefined;
    if (
      next === undefined &&
      !/^[ \t]*$/.test(separator) &&
      !(lines && /^[ \t]*(?:;[ \t]*)?(?:\n[ \t]*)*$/.test(separator))
    )
      return undefined;
    rejoined += separator;
  }
  if (!/^[ \t]*$/.test(source.slice(0, segments[0]!.start)) || rejoined !== source)
    return undefined;
  return { segments, separators: cuts.length };
}

/** One command of a single-pipeline program, with its offsets in the recorded source. */
export interface ShellPipelineStage {
  /** Half-open [start, end) offsets of the stage's text in the source, without blanks around it. */
  start: number;
  end: number;
  /** Offset of the `|` before this stage; undefined for the first stage. */
  pipe?: number;
  /** The command word and its arguments, quotes removed; redirections and their targets omitted. */
  words: string[];
  /** Whether the stage carries any redirection. */
  redirects: boolean;
}

/**
 * The commands of a program that is exactly one pipeline of external commands in the current
 * splitter grammar — one segment, no `&&`, `;` or line-break separator — or undefined. Beyond the
 * chain grammar, a stage before the last may carry `2>&1`, joining its stderr to the pipe.
 */
export function shellPipelineStages(
  shell: string,
  source: string,
): ShellPipelineStage[] | undefined {
  const version = SHELL_AND_CHAIN_SPLITTER_VERSION;
  const scanned = scanShellSegments(shell, source, version, true);
  if (scanned === undefined || scanned.separators !== 0 || scanned.segments.length !== 1) {
    return undefined;
  }
  const segment = scanned.segments[0]!;
  // The grammar quotes only plain single- and double-quoted strings: an unquoted `|` is a pipe.
  const pipes: number[] = [];
  let quote: string | undefined;
  for (let index = segment.start; index < segment.end; index += 1) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "|") {
      pipes.push(index);
    }
  }
  const stages: ShellPipelineStage[] = [];
  const bounds = [segment.start - 1, ...pipes, segment.end];
  for (let position = 0; position + 1 < bounds.length; position += 1) {
    let start = bounds[position]! + 1;
    let end = bounds[position + 1]!;
    while (start < end && isBlank(source[start])) start += 1;
    while (end > start && isBlank(source[end - 1])) end -= 1;
    const parsed = segmentWords(source.slice(start, end), version, shell === ZSH_OR_SH);
    if (parsed === undefined || parsed.pipeline.length !== 1) return undefined;
    stages.push({
      start,
      end,
      ...(position === 0 ? {} : { pipe: bounds[position]! }),
      words: parsed.words,
      redirects: parsed.redirects,
    });
  }
  return stages;
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
  if (parsed === undefined || parsed.redirects || parsed.pipeline.length > 1) return false;
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
    parsed.pipeline.length > 1 ||
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
    (position.trailing && version >= 2 && isReadOnlyInspectionSegment(text))
  );
}

/**
 * The shell each harness's built-in shell callable runs a command in: OMP, Copilot and OpenCode
 * `bash`, Claude Code `Bash`, and Cursor `Shell` and Grok `run_terminal_command` (whose login shell
 * may be zsh, so only the grammar every POSIX shell reads the same is split). A step reaches
 * splitting only when its decoder proved the callable is that built-in and shared its command as a
 * program view.
 */
const HARNESS_SHELL_CALLABLES: Readonly<Record<string, ShellDialect>> = {
  bash: "bash",
  sh: "sh",
  dash: "dash",
  Bash: "bash",
  Shell: ZSH_OR_SH,
  run_terminal_cmd: ZSH_OR_SH,
  run_terminal_command: ZSH_OR_SH,
};

/** What a call's recorded program says about the shell it ran in, when it says anything. */
type RecordedShellProgram = Partial<Pick<WorkflowRecordedProgram, "dialect" | "unprovenDialect">>;

/**
 * The shell dialect a recorded shell-program call ran in, or undefined when the record does not
 * prove one: the dialect its recorded program names, or — for a record made before dialects were
 * recorded — the POSIX shell its callable proves (a harness's built-in shell callable, or a Codex
 * command run under a bash shell profile). A program recorded with an unproven dialect has none.
 */
export function recordedShellDialect(
  callableName: string,
  args: Readonly<Record<string, unknown>>,
  program?: RecordedShellProgram,
): ShellDialect | undefined {
  if (program?.unprovenDialect === true) return undefined;
  if (program?.dialect !== undefined) {
    return isShellDialect(program.dialect) ? program.dialect : undefined;
  }
  const profile = args.resinCodexShellProfile;
  if (typeof profile === "string") return profile.startsWith("bash-") ? "bash" : undefined;
  return Object.hasOwn(HARNESS_SHELL_CALLABLES, callableName)
    ? HARNESS_SHELL_CALLABLES[callableName]
    : undefined;
}

/**
 * The POSIX shell a recorded shell-program call ran in, or undefined: its recorded dialect when
 * that is a POSIX one (see {@link recordedShellDialect}). PowerShell, cmd and any other shell never
 * split.
 */
export function recordedPosixShell(
  callableName: string,
  args: Readonly<Record<string, unknown>>,
  program?: RecordedShellProgram,
): string | undefined {
  const dialect = recordedShellDialect(callableName, args, program);
  return dialect !== undefined && isPosixShellDialect(dialect) ? dialect : undefined;
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
