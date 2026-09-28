/**
 * Reading a recorded PowerShell program as tokens, for Windows PowerShell 5.1 (`powershell`) and
 * PowerShell 7+ (`pwsh`) alike, so a value inside it can be bound without rewriting the program.
 *
 * Like the POSIX shell lexer this is an allowlist, not a parser. It models only commands in argument
 * mode — a command name (or `&` and a name), its arguments, redirections, and the pipelines and
 * statements joining them — plus the one expression it needs for scripts agents write, a variable
 * assigned one string (`$region = 'emea'`). Every token keeps its exact span.
 *
 * - Bindable: a plain bare argument word (no `$`, backtick, quote, wildcard, `~` start, or number
 *   form other than a plain decimal), a redirection target, a single-quoted string (`''` escapes a
 *   quote), a double-quoted string with backtick escapes and no expansion, and the string an
 *   assigned variable receives.
 * - Never bindable: command names, parameters (`-Path`, `-Path:x`), a word or string with a
 *   variable, a subexpression or an escape it cannot decode exactly, and a code runner's code string
 *   (`python -c …`). A program that calls an evaluator binds nothing at all: `Invoke-Expression`,
 *   `Invoke-Command`, `Start-Process`, `Start-Job`, `Add-Type`, the Windows shells (`cmd`,
 *   `powershell`, `pwsh`, whose whole remaining command line is code), a batch file, a command named
 *   by a variable, or an alias or function definition (see `code-evaluation.ts`).
 * - Opaque from where it starts to the end of the program, as one `unsupported` token: script
 *   blocks, groups and subexpressions (`{`, `(`, `$(`, `@(`, `@{`), here-strings, splatting, `--%`,
 *   `<`, a statement that is not a command or the modeled assignment (a keyword such as `if`,
 *   `foreach`, `exit`, a string, a number, a type literal, dot-sourcing), a background `&`, and in
 *   Windows PowerShell 5.1 the `&&`/`||` chain operators (PowerShell 7+ only).
 * - Refused outright (a {@link ProgramTokenizationError}): smart quotes, Unicode dashes and Unicode
 *   spaces (PowerShell reads them as quotes, dashes and blanks), control characters, and a lone
 *   carriage return. Such a program is captured but not learnable.
 *
 * Comments (`#` at a token's start, `<# … #>`) carry no value and are skipped, as is a backtick
 * line continuation between tokens.
 */

import {
  isCodeFlagWord,
  isCodeRunnerWord,
  isDefiningPowerShellPath,
  isEvaluatorWord,
} from "./code-evaluation.js";
import { type ProgramToken, ProgramTokenizationError } from "./program-tokens.js";

export type PowerShellEdition = "powershell" | "pwsh";

/** Characters PowerShell reads as quotes, dashes or blanks that an ASCII lexer would not. */
const UNMODELED_CHARACTERS =
  /[\u2013\u2014\u2015\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

/** Characters that end a bare word in argument mode. */
const WORD_END = new Set([" ", "\t", "\n", "\r", ";", ",", "|", "&", "(", ")", "{", "}"]);

/** Language keywords: a statement starting with one is not a command. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "begin",
  "break",
  "catch",
  "class",
  "clean",
  "configuration",
  "continue",
  "data",
  "define",
  "do",
  "dynamicparam",
  "else",
  "elseif",
  "end",
  "enum",
  "exit",
  "filter",
  "finally",
  "for",
  "foreach",
  "from",
  "function",
  "hidden",
  "if",
  "in",
  "inlinescript",
  "interface",
  "module",
  "namespace",
  "parallel",
  "param",
  "private",
  "process",
  "public",
  "return",
  "sequence",
  "static",
  "switch",
  "throw",
  "trap",
  "try",
  "type",
  "until",
  "using",
  "var",
  "while",
  "workflow",
]);

/** Preference and automatic variables: assigning one configures the session, it is not data. */
const CONFIGURATION_VARIABLE = /(?:preference|^psdefaultparametervalues|^psnativecommand)/iu;

/** A token PowerShell reads as a number in argument mode (`10`, `0x1F`, `1kb`, `2.5e3`, `5d`). */
const NUMBER_FORM =
  /^[+-]?(?:0x[0-9a-f]+|0b[01]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:[dl]|u?l|u|y|uy|s|us|n)?(?:kb|mb|gb|tb|pb)?$/iu;
/** A number form that is its own text, so its value is the recorded word. */
const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/u;

/** Operators after which the next word names a command. */
const STATEMENT_SEPARATORS: ReadonlySet<string> = new Set([";", "\n", "&&", "||", "|"]);

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";

/** A variable name after `$` in argument mode: `$x`, `$env:PATH`, `$script:x`, `$_`. */
const VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*:)?[A-Za-z_][A-Za-z0-9_]*|^\$[_?^$]/u;

interface QuotedRead {
  /** Offset just past the closing quote; undefined when it never closes or cannot be delimited. */
  end?: number;
  value: string;
  /** Whether the decoded value is exactly what PowerShell reads (no expansion, no unknown escape). */
  exact: boolean;
}

/** A single-quoted string: verbatim, with `''` for one quote. */
function readSingleQuoted(source: string, start: number): QuotedRead {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "'") {
      if (source[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { end: index + 1, value, exact: true };
    }
    value += char;
    index += 1;
  }
  return { value, exact: false };
}

const BACKTICK_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * A double-quoted string: backtick escapes and `""` decoded; a `$` that expands a variable makes it
 * inexact, and a `$(` subexpression (which may hold quotes of its own) cannot be delimited at all.
 */
function readDoubleQuoted(source: string, start: number): QuotedRead {
  let value = "";
  let exact = true;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "`") {
      const next = source[index + 1];
      if (next === undefined) return { value, exact: false };
      // `u{…}` is an escape only in PowerShell 7; its value differs between editions.
      if (next === "u") exact = false;
      value += BACKTICK_ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') {
      if (source[index + 1] === '"') {
        value += '"';
        index += 2;
        continue;
      }
      return { end: index + 1, value, exact };
    }
    if (char === "$") {
      const next = source[index + 1];
      if (next === "(") return { value, exact: false };
      if (next === "{") {
        const close = source.indexOf("}", index + 2);
        if (close === -1) return { value, exact: false };
        exact = false;
        value += source.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      if (next !== undefined && /[A-Za-z0-9_?^$:]/u.test(next)) exact = false;
    }
    value += char;
    index += 1;
  }
  return { value, exact: false };
}

/** Whether the command a token belongs to runs code, so its `-c`-style argument is code. */
function commandRunsCode(tokens: readonly ProgramToken[]): boolean {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.kind === "operator") {
      if (STATEMENT_SEPARATORS.has(token.raw) || token.raw === "&") return false;
      continue;
    }
    if (isCodeRunnerWord(typeof token.value === "string" ? token.value : token.raw)) return true;
  }
  return false;
}

/**
 * Tokenizes a recorded PowerShell program for the given edition. See the module comment for the
 * grammar; anything outside it ends in one opaque `unsupported` token.
 */
export function powershellTokens(source: string, edition: PowerShellEdition): ProgramToken[] {
  const tokens = scanPowerShell(source, edition);
  applyPowerShellCodeEvaluation(tokens);
  return tokens;
}

/**
 * Applies the shared code-evaluation policy (see `code-evaluation.ts`): a program that calls an
 * evaluator (`Invoke-Expression`, `Start-Process`, `cmd /c`, `pwsh -Command`, a batch file, a command
 * named by a variable, an alias or function definition, …) binds nothing; one that runs a code
 * runner's code string binds no assigned string, which that code can read.
 */
function applyPowerShellCodeEvaluation(tokens: ProgramToken[]): void {
  let evaluates = false;
  let runsCode = false;
  let atStart = true;
  let called = false;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "operator") {
      if (STATEMENT_SEPARATORS.has(token.raw)) {
        atStart = true;
        called = false;
      } else if (token.raw === "&" && atStart) {
        called = true;
      }
      continue;
    }
    if (token.kind === "unsupported") continue;
    const text = typeof token.value === "string" ? token.value : undefined;
    if (atStart) {
      atStart = false;
      if (!called && tokens[index + 1]?.raw === "=") continue;
      // A command named by an expression is unknown: it may be any evaluator.
      if (text === undefined || isEvaluatorWord(text, "powershell")) evaluates = true;
      continue;
    }
    if (text !== undefined && isDefiningPowerShellPath(text)) evaluates = true;
    const previous = tokens[index - 1];
    if (
      previous?.kind === "word" &&
      isCodeFlagWord(previous.raw) &&
      commandRunsCode(tokens.slice(0, index))
    ) {
      runsCode = true;
    }
  }
  if (!evaluates && !runsCode) return;
  for (const [index, token] of tokens.entries()) {
    if (evaluates || tokens[index - 1]?.raw === "=") token.bindable = false;
  }
}

function scanPowerShell(source: string, edition: PowerShellEdition): ProgramToken[] {
  const unmodeled = UNMODELED_CHARACTERS.exec(source);
  if (unmodeled !== null) throw new ProgramTokenizationError(edition, unmodeled.index);
  const loneReturn = /\r(?!\n)/u.exec(source);
  if (loneReturn !== null) throw new ProgramTokenizationError(edition, loneReturn.index);

  const tokens: ProgramToken[] = [];
  /** The next word starts a statement or a pipeline element (its command name, or an assignment). */
  let commandStart = true;
  /** The previous token was `&` at a command's start, so this word is the command it calls. */
  let calledCommand = false;
  /** The previous token redirected output, so this word is the file it writes. */
  let redirectTarget = false;
  let index = 0;

  const opaque = (start: number): ProgramToken[] => {
    tokens.push({
      kind: "unsupported",
      start,
      end: source.length,
      raw: source.slice(start),
      bindable: false,
    });
    return tokens;
  };
  const operator = (raw: string): void => {
    tokens.push({ kind: "operator", start: index, end: index + raw.length, raw, bindable: false });
    index += raw.length;
  };

  while (index < source.length) {
    const char = source[index]!;
    if (isBlank(char) || (char === "\r" && source[index + 1] === "\n")) {
      index += 1;
      continue;
    }
    // A backtick at the end of a line continues the statement on the next one.
    if (char === "`" && (source[index + 1] === "\n" || source.startsWith("\r\n", index + 1))) {
      index += source[index + 1] === "\n" ? 2 : 3;
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "<" && source[index + 1] === "#") {
      const close = source.indexOf("#>", index + 2);
      if (close === -1) return opaque(index);
      index = close + 2;
      continue;
    }
    if (redirectTarget && (char === "\n" || WORD_END.has(char))) return opaque(index);
    if (char === "\n" || char === ";") {
      operator(char);
      commandStart = true;
      calledCommand = false;
      continue;
    }
    if (char === "|" || char === "&") {
      const doubled = source[index + 1] === char;
      if (doubled) {
        // Pipeline chain operators exist from PowerShell 7 on; 5.1 fails to parse them.
        if (edition !== "pwsh" || commandStart) return opaque(index);
        operator(char + char);
        commandStart = true;
        continue;
      }
      if (char === "|") {
        if (commandStart) return opaque(index);
        operator("|");
        commandStart = true;
        continue;
      }
      // `&` calls the command after it; anywhere else it backgrounds a pipeline (7+) or is an error.
      if (!commandStart || calledCommand) return opaque(index);
      operator("&");
      calledCommand = true;
      continue;
    }
    if (char === ",") {
      if (commandStart) return opaque(index);
      operator(",");
      continue;
    }
    if ("(){}<@[".includes(char)) {
      // Groups, script blocks, subexpressions, arrays, hashtables, here-strings, splatting and a
      // type literal at a statement's start are expressions this grammar does not model; `<` is
      // reserved. A `[` inside an argument is an ordinary character, read as part of a word below.
      if (char !== "[" || commandStart) return opaque(index);
    }
    if (commandStart && !calledCommand && char === "$") {
      const assigned = readAssignment(source, index, tokens);
      if (assigned === undefined) return opaque(index);
      index = assigned;
      commandStart = false;
      continue;
    }
    const redirect = /^(?:[1-6*]>&[12]|[1-6*]?>>?)/u.exec(source.slice(index, index + 4))?.[0];
    if (redirect !== undefined) {
      if (commandStart) return opaque(index);
      operator(redirect);
      redirectTarget = !redirect.includes("&");
      continue;
    }
    if (source.startsWith("--%", index)) return opaque(index);

    // A word: bare text, a quoted string, or both run together.
    const start = index;
    let value = "";
    let exact = true;
    let quotedParts = 0;
    let bareParts = false;
    while (index < source.length && !WORD_END.has(source[index]!)) {
      const current = source[index]!;
      if (current === "'" || current === '"') {
        const quoted =
          current === "'" ? readSingleQuoted(source, index) : readDoubleQuoted(source, index);
        if (quoted.end === undefined) return opaque(start);
        value += quoted.value;
        exact &&= quoted.exact;
        quotedParts += 1;
        index = quoted.end;
        continue;
      }
      if (current === "`") {
        // An escape inside a bare word; its reading is not modeled.
        if (index + 1 >= source.length || source[index + 1] === "\n" || source[index + 1] === "\r")
          return opaque(start);
        exact = false;
        value += source[index + 1];
        index += 2;
        bareParts = true;
        continue;
      }
      if (current === "$") {
        if (source[index + 1] === "(" || source[index + 1] === "{") return opaque(start);
        exact = false;
      }
      // PowerShell may read `>` inside a word as a redirection; `<` is reserved.
      if (current === ">" || current === "<") return opaque(start);
      if ("*?[]".includes(current)) exact = false;
      value += current;
      index += 1;
      bareParts = true;
    }
    if (index === start) return opaque(start);
    const raw = source.slice(start, index);
    const isString = quotedParts === 1 && !bareParts;
    if (commandStart) {
      // A command's name: a plain word, or anything `&` calls. A quoted or keyword statement start
      // is an expression, not a command.
      if (!calledCommand) {
        if (isString || quotedParts > 0 || !exact) return opaque(start);
        if (
          KEYWORDS.has(raw.toLowerCase()) ||
          raw === "." ||
          NUMBER_FORM.test(raw) ||
          /^[+-]/u.test(raw)
        )
          return opaque(start);
      }
      tokens.push({
        kind: isString ? "string" : "word",
        start,
        end: index,
        raw,
        ...(exact ? { value } : {}),
        bindable: false,
      });
      commandStart = false;
      calledCommand = false;
      continue;
    }
    const previous = tokens.at(-1);
    const parameter = !isString && quotedParts === 0 && /^-./u.test(raw);
    const numberForm = !isString && quotedParts === 0 && NUMBER_FORM.test(raw);
    const code =
      previous?.kind === "word" && isCodeFlagWord(previous.raw) && commandRunsCode(tokens);
    const bindable =
      exact &&
      !parameter &&
      !code &&
      !(numberForm && !PLAIN_DECIMAL.test(raw)) &&
      !(quotedParts === 0 && raw.startsWith("~")) &&
      (isString || quotedParts === 0);
    tokens.push({
      kind: isString ? "string" : "word",
      start,
      end: index,
      raw,
      ...(exact ? { value } : {}),
      bindable,
    });
    redirectTarget = false;
  }
  if (redirectTarget) return opaque(source.length);
  return tokens;
}

/**
 * Reads `$name = <one string>` at a statement's start, pushing its tokens and returning the offset
 * after the string; undefined when the statement is anything else. The string is bindable unless it
 * expands or configures the session (`$ErrorActionPreference = 'Stop'`).
 */
function readAssignment(source: string, start: number, tokens: ProgramToken[]): number | undefined {
  const name = VARIABLE.exec(source.slice(start))?.[0];
  if (name === undefined || name.includes(":") || /^\$[_?^$]$/u.test(name)) return undefined;
  let index = start + name.length;
  while (isBlank(source[index])) index += 1;
  if (source[index] !== "=" || source[index + 1] === "=") return undefined;
  const equals = index;
  index += 1;
  while (isBlank(source[index])) index += 1;
  const quote = source[index];
  if (quote !== "'" && quote !== '"') return undefined;
  const quoted = quote === "'" ? readSingleQuoted(source, index) : readDoubleQuoted(source, index);
  if (quoted.end === undefined) return undefined;
  const after = source[quoted.end];
  if (after !== undefined && !isBlank(after) && after !== "\n" && after !== "\r" && after !== ";")
    return undefined;
  const configures = CONFIGURATION_VARIABLE.test(name.slice(1));
  tokens.push(
    { kind: "word", start, end: start + name.length, raw: name, bindable: false },
    { kind: "operator", start: equals, end: equals + 1, raw: "=", bindable: false },
    {
      kind: "string",
      start: index,
      end: quoted.end,
      raw: source.slice(index, quoted.end),
      ...(quoted.exact ? { value: quoted.value } : {}),
      bindable: quoted.exact && !configures,
    },
  );
  return quoted.end;
}

/**
 * The name a PowerShell token's value is given: the parameter it follows (`-OutFile x` →
 * `OutFile`), or the variable it is assigned to (`$region = 'emea'` → `region`). Undefined for
 * anything else.
 */
export function powershellValueName(
  tokens: readonly ProgramToken[],
  index: number,
): string | undefined {
  const previous = tokens[index - 1];
  if (previous?.kind === "word") {
    const parameter = /^-([A-Za-z][A-Za-z0-9_]{0,40})$/u.exec(previous.raw)?.[1];
    if (parameter !== undefined) return parameter;
  }
  if (previous?.kind === "operator" && previous.raw === "=") {
    const variable = /^\$([A-Za-z_][A-Za-z0-9_]{0,40})$/u.exec(tokens[index - 2]?.raw ?? "")?.[1];
    if (variable !== undefined) return variable;
  }
  return undefined;
}

/**
 * A value PowerShell reads back as the same text as a bare argument word: no parameter (`-`), home
 * (`~`), variable, quote, escape or operator character. A number form other than a plain decimal
 * (`0x10`, `1kb`, `1e3`) is quoted too.
 */
const SAFE_BARE_WORD = /^[A-Za-z0-9_./\\][A-Za-z0-9_./\\:+=-]*$/u;

/**
 * Renders a bound value in place of a recorded PowerShell token, as data: bare when the recorded
 * token was a bare word and the value reads back as the same text, otherwise single-quoted (`'`
 * doubled). A value PowerShell cannot pass through to a native program intact — empty, containing a
 * double quote, a line break or another control character but tab, a cmd.exe metacharacter
 * (`& | < > ^ % !`, which a command resolving to a batch file would parse again), or blanks with a
 * trailing backslash — is refused rather than approximated, in both editions.
 */
export function renderPowerShellTokenValue(token: ProgramToken, text: string): string {
  if (!token.bindable) throw new Error("the recorded program token is not safely bindable");
  if (token.kind !== "word" && token.kind !== "string") {
    throw new Error("this program token cannot carry a bound value");
  }
  if (text.length === 0) throw new Error("a PowerShell argument value cannot be empty");
  if (text.includes('"')) {
    throw new Error("a PowerShell argument value cannot contain a double quote");
  }
  // The command may resolve to a batch file (an npm shim, `*.cmd`), which cmd.exe parses again.
  if (/[&|<>^%!]/u.test(text)) {
    throw new Error("a PowerShell argument value cannot contain a cmd.exe metacharacter");
  }
  if (/[\x00-\x08\x0a-\x1f\x7f]/u.test(text) || UNMODELED_CHARACTERS.test(text)) {
    throw new Error("a PowerShell argument value cannot contain this character");
  }
  if (/[\s]/u.test(text) && text.endsWith("\\")) {
    throw new Error("a PowerShell argument value with blanks cannot end in a backslash");
  }
  if (
    token.kind === "word" &&
    SAFE_BARE_WORD.test(text) &&
    (!NUMBER_FORM.test(text) || PLAIN_DECIMAL.test(text))
  ) {
    return text;
  }
  return `'${text.replaceAll("'", "''")}'`;
}
