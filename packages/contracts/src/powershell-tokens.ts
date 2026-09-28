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
 * - Script blocks: a `{ … }` argument of an in-process filter, projection or key command from the
 *   allowlist in `code-evaluation.ts` (`Where-Object`/`where`/`?`, `ForEach-Object`/`foreach`/`%`,
 *   `Sort-Object`/`sort`, `Group-Object`/`group`) is read in expression mode (see
 *   {@link readScriptBlock}) as `{`, its tokens and `}`, and the program continues after it. Inside
 *   one only a single-quoted string, a double-quoted string without `$` or backtick, and a plain
 *   decimal standing apart are bindable, and only as an operand of a comparison, membership,
 *   logical or arithmetic operator: an operand of `-like`, `-match`, `-replace`, `-split` (patterns),
 *   `-f` (a format), `-as`/`-is` (types) or a bitwise operator is not. A block holding anything
 *   else — a command, a nested block, `$()`, `@()`, `@{}`, a `[type]`, a method call or index, an
 *   assignment, a redirection, a here-string — is opaque, as is a block passed to any other command
 *   (`Invoke-Command`, `Start-Job`, `Register-*Event -Action`, `& { }`, `. { }`).
 * - Opaque from where it starts to the end of the program, as one `unsupported` token: any other
 *   script block, groups and subexpressions (`(`, `$(`, `@(`, `@{`), here-strings, splatting, `--%`,
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
  isPowerShellBlockFilterWord,
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

/**
 * Comparison, membership and logical operators (with their case-sensitive `c` and explicit `i`
 * variants) whose literal operands are plain data.
 */
const DATA_OPERATOR =
  /^-(?:[ci]?(?:eq|ne|gt|ge|lt|le|contains|notcontains|in|notin)|and|or|xor|not|join)$/iu;
/**
 * Operators whose literal operand is not plain data: a wildcard or regular-expression pattern
 * (`-like`, `-match`, `-replace`, `-split`), a format string (`-f`), a type name (`-as`, `-is`), or
 * a bit pattern. A literal next to one is never bound.
 */
const PATTERN_OPERATOR =
  /^-(?:[ci]?(?:like|notlike|match|notmatch|replace|split)|f|as|is|isnot|band|bor|bxor|bnot|shl|shr)$/iu;
/** Symbols a data literal in a script block may stand next to. */
const DATA_SYMBOLS: ReadonlySet<string> = new Set([
  "{",
  "}",
  "(",
  ")",
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
]);
/** A comparison operator, whose other operand names the compared value. */
const COMPARISON_OPERATOR =
  /^-[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin)$/iu;

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
  /** The current command's name token when it is an in-process block filter (`Where-Object`). */
  let blockFilter: ProgramToken | undefined;
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
      blockFilter = undefined;
      continue;
    }
    if (char === "|" || char === "&") {
      const doubled = source[index + 1] === char;
      if (doubled) {
        // Pipeline chain operators exist from PowerShell 7 on; 5.1 fails to parse them.
        if (edition !== "pwsh" || commandStart) return opaque(index);
        operator(char + char);
        commandStart = true;
        blockFilter = undefined;
        continue;
      }
      if (char === "|") {
        if (commandStart) return opaque(index);
        operator("|");
        commandStart = true;
        blockFilter = undefined;
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
    if (
      char === "{" &&
      !commandStart &&
      blockFilter !== undefined &&
      (isBlank(source[index - 1]) || tokens.at(-1) === blockFilter)
    ) {
      // A filter's script block, read in expression mode; anything it cannot model is opaque.
      const block = readScriptBlock(source, index);
      if (block === undefined) return opaque(index);
      tokens.push(...block.tokens);
      index = block.end;
      continue;
    }
    if ("(){}<@[".includes(char)) {
      // Groups, other script blocks, subexpressions, arrays, hashtables, here-strings, splatting and
      // a type literal at a statement's start are expressions this grammar does not model; `<` is
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
      // is an expression, not a command; `?` (Where-Object) is a name, and so is `foreach`
      // (ForEach-Object) in a pipeline.
      if (!calledCommand) {
        if (raw === "?") exact = true;
        const pipedForEach = raw.toLowerCase() === "foreach" && tokens.at(-1)?.raw === "|";
        if (isString || quotedParts > 0 || !exact) return opaque(start);
        if (
          (KEYWORDS.has(raw.toLowerCase()) && !pipedForEach) ||
          raw === "." ||
          NUMBER_FORM.test(raw) ||
          /^[+-]/u.test(raw)
        )
          return opaque(start);
      }
      const name: ProgramToken = {
        kind: isString ? "string" : "word",
        start,
        end: index,
        raw,
        ...(exact ? { value } : {}),
        bindable: false,
      };
      tokens.push(name);
      blockFilter = !calledCommand && isPowerShellBlockFilterWord(raw) ? name : undefined;
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
 * Reads a filter's script block starting at its `{`, in expression mode, returning its tokens (`{`,
 * the operands and operators inside, `}`) and the offset after its `}`; undefined when the block
 * holds anything this grammar does not model, which leaves the rest of the program opaque.
 *
 * The grammar is expressions only: variables with property access (`$_.region`, one `word` token),
 * string and number literals, parentheses, `,`, the arithmetic operators, `!` and the named
 * comparison, membership, logical and pattern operators, separated into statements by newlines or
 * `;`. A bare word — which would be a command or a keyword — is not in it, nor are nested blocks,
 * `$()`, `@`, `[`, method calls, indexes, `::`, assignments, `++`/`--`, `..`, redirections, `|`,
 * `&` and `.` dot-sourcing, so a block that reads can run no command. Statement separators emit no
 * token: the block stays one command's argument to every later reader.
 *
 * A literal is bindable (a single-quoted string, a double-quoted one without `$` or backtick, or a
 * decimal whose text is its own number and does not touch an operator before it) only when every
 * token beside it is a data operator or symbol, a paren or the block's edge; an operand of a
 * pattern, format or type operator stays unbound.
 */
function readScriptBlock(
  source: string,
  open: number,
): { tokens: ProgramToken[]; end: number } | undefined {
  const tokens: ProgramToken[] = [
    { kind: "operator", start: open, end: open + 1, raw: "{", bindable: false },
  ];
  /** Indices of tokens that end a statement, so the next one starts another. */
  const statementEnds = new Set<number>([0]);
  /** Indices of literal tokens that may be bindable, depending on their neighbours. */
  const literals = new Set<number>();
  /** Whether the grammar expects an operand next (else an operator, a close or a separator). */
  let operand = true;
  let depth = 0;
  let index = open + 1;
  const atStatementStart = (): boolean => operand && statementEnds.has(tokens.length - 1);
  const symbol = (raw: string): void => {
    tokens.push({ kind: "operator", start: index, end: index + raw.length, raw, bindable: false });
    index += raw.length;
  };
  /** A literal, variable or `)` may not be followed by `.`, `[`, `(` or another word character. */
  const endsCleanly = (at: number): boolean => !/^[.[(:{$'"`@A-Za-z0-9_]/u.test(source[at] ?? "");

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (isBlank(char) || (char === "\r" && next === "\n")) {
      index += 1;
      continue;
    }
    if (char === "`") {
      if (next === "\n") index += 2;
      else if (next === "\r" && source[index + 2] === "\n") index += 3;
      else return undefined;
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "<" && next === "#") {
      const close = source.indexOf("#>", index + 2);
      if (close === -1) return undefined;
      index = close + 2;
      continue;
    }
    if (char === "\n" || char === ";") {
      // After an operand a newline or `;` ends the statement; after an operator a newline continues
      // it. Inside parentheses neither is modeled.
      if (!operand) {
        if (depth > 0) return undefined;
        statementEnds.add(tokens.length - 1);
        operand = true;
      } else if (char === ";" && !atStatementStart()) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0 || (operand && !atStatementStart())) return undefined;
      symbol("}");
      // The block must end the argument: `{ … }.Invoke()` would be an expression on the block.
      const after = source[index];
      if (
        after !== undefined &&
        !isBlank(after) &&
        after !== "\n" &&
        after !== "\r" &&
        !WORD_END.has(after)
      )
        return undefined;
      const patterns = patternOperands(tokens, statementEnds);
      for (const [at, token] of tokens.entries()) {
        if (!literals.has(at)) continue;
        token.bindable =
          !patterns.has(at) &&
          isDataNeighbour(tokens[at - 1]!, statementEnds.has(at - 1)) &&
          isDataNeighbour(tokens[at + 1]!, statementEnds.has(at));
      }
      return { tokens, end: index };
    }
    if (char === "'" || char === '"') {
      if (!operand) return undefined;
      const quoted =
        char === "'" ? readSingleQuoted(source, index) : readDoubleQuoted(source, index);
      if (quoted.end === undefined || !endsCleanly(quoted.end)) return undefined;
      const raw = source.slice(index, quoted.end);
      if (quoted.exact && (char === "'" || !/[$`]/u.test(raw))) literals.add(tokens.length);
      tokens.push({
        kind: "string",
        start: index,
        end: quoted.end,
        raw,
        ...(quoted.exact ? { value: quoted.value } : {}),
        bindable: false,
      });
      index = quoted.end;
      operand = false;
      continue;
    }
    if (char === "$") {
      if (!operand) return undefined;
      const variable = VARIABLE.exec(source.slice(index))?.[0];
      if (variable === undefined) return undefined;
      const members = /^(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u.exec(
        source.slice(index + variable.length),
      )![0];
      const end = index + variable.length + members.length;
      if (!endsCleanly(end)) return undefined;
      tokens.push({
        kind: "word",
        start: index,
        end,
        raw: source.slice(index, end),
        bindable: false,
      });
      index = end;
      operand = false;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      if (!operand) return undefined;
      const raw = /^[0-9][A-Za-z0-9_.]*/u.exec(source.slice(index))![0];
      const end = index + raw.length;
      if (!endsCleanly(end)) return undefined;
      const plain = PLAIN_DECIMAL.test(raw) && String(Number(raw)) === raw;
      if (!plain && !NUMBER_FORM.test(raw)) return undefined;
      // A bound negative number must not run into an operator before it (`$x-5` → `$x--3`).
      const before = source[index - 1];
      if (plain && (isBlank(before) || "\n{(,".includes(before!))) literals.add(tokens.length);
      tokens.push({
        kind: "number",
        start: index,
        end,
        raw,
        ...(plain ? { value: Number(raw) } : {}),
        bindable: false,
      });
      index = end;
      operand = false;
      continue;
    }
    if (char === "-" && next !== undefined && /[A-Za-z]/u.test(next)) {
      const raw = /^-[A-Za-z]+/u.exec(source.slice(index))![0];
      if (raw.toLowerCase() === "-not") {
        if (!operand) return undefined;
      } else if (DATA_OPERATOR.test(raw) || PATTERN_OPERATOR.test(raw)) {
        if (operand) return undefined;
        operand = true;
      } else {
        return undefined;
      }
      symbol(raw);
      continue;
    }
    if (char === "-" || char === "+") {
      if (next === char || next === "=") return undefined;
      // Unary before an operand, binary after one; an operand follows either way.
      operand = true;
      symbol(char);
      continue;
    }
    if (char === "*" || char === "/" || char === "%" || char === ",") {
      if (operand || next === "=" || next === ">") return undefined;
      operand = true;
      symbol(char);
      continue;
    }
    if (char === "!") {
      if (!operand || next === "=") return undefined;
      symbol(char);
      continue;
    }
    if (char === "(") {
      if (!operand) return undefined;
      depth += 1;
      symbol(char);
      continue;
    }
    if (char === ")") {
      if (operand || depth === 0 || !endsCleanly(index + 1)) return undefined;
      depth -= 1;
      symbol(char);
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Whether a token beside a script-block literal leaves it plain data: a statement boundary, a
 * paren, a block edge, `,`, an arithmetic or negation symbol, or a comparison, membership or logical
 * operator.
 */
function isDataNeighbour(token: ProgramToken, statementBoundary: boolean): boolean {
  if (statementBoundary) return true;
  return (
    token.kind === "operator" && (DATA_SYMBOLS.has(token.raw) || DATA_OPERATOR.test(token.raw))
  );
}

/** Operators at or below comparison precedence, which end a pattern operator's operand. */
const OPERAND_END =
  /^-(?:[ci]?(?:eq|ne|gt|ge|lt|le|contains|notcontains|in|notin|like|notlike|match|notmatch|replace|split)|and|or|xor|join|is|isnot|as)$/iu;

/**
 * The indices of every token in an operand of a pattern, format, type or bitwise operator in a
 * script block's tokens. Such an operand reaches, at its own paren depth, to the nearest operator at
 * comparison precedence or below, the statement's end or an unmatched paren — a superset of what
 * PowerShell reads as the operand (`$x -replace 'e','a'` and `$x -like 'a' + 'b'` both taint `'a'`).
 */
function patternOperands(
  tokens: readonly ProgramToken[],
  statementEnds: ReadonlySet<number>,
): Set<number> {
  const tainted = new Set<number>();
  const ends = (token: ProgramToken): boolean =>
    token.kind === "operator" && OPERAND_END.test(token.raw);
  for (const [at, token] of tokens.entries()) {
    if (token.kind !== "operator" || !PATTERN_OPERATOR.test(token.raw)) continue;
    let depth = 0;
    for (let left = at - 1; left >= 1; left -= 1) {
      const each = tokens[left]!;
      if (depth === 0 && (statementEnds.has(left) || ends(each))) break;
      if (each.raw === ")" && each.kind === "operator") depth += 1;
      else if (each.raw === "(" && each.kind === "operator") {
        if (depth === 0) break;
        depth -= 1;
      }
      tainted.add(left);
    }
    depth = 0;
    for (let right = at + 1; right < tokens.length - 1; right += 1) {
      const each = tokens[right]!;
      if (depth === 0 && ends(each)) break;
      if (each.raw === "(" && each.kind === "operator") depth += 1;
      else if (each.raw === ")" && each.kind === "operator") {
        if (depth === 0) break;
        depth -= 1;
      }
      tainted.add(right);
      if (depth === 0 && statementEnds.has(right)) break;
    }
  }
  return tainted;
}

/**
 * The name a PowerShell token's value is given: the property or variable it is compared with
 * (`$_.region -eq 'emea'`, `'emea' -eq $PSItem.region` and Where-Object's `region -eq emea` →
 * `region`), the parameter it follows (`-OutFile x` → `OutFile`), or the variable it is assigned to
 * (`$region = 'emea'` → `region`). Undefined for anything else; never a comparison operator.
 */
export function powershellValueName(
  tokens: readonly ProgramToken[],
  index: number,
): string | undefined {
  const previous = tokens[index - 1];
  if (previous !== undefined && COMPARISON_OPERATOR.test(previous.raw)) {
    // Where-Object's simplified syntax (`Where-Object region -eq emea`): `-eq` is a switch.
    const where = /^(?:(?:microsoft\.powershell\.core\\)?where-object|where|\?)$/iu.test(
      tokens[index - 3]?.raw ?? "",
    );
    const name = comparedName(tokens[index - 2], where);
    if (name !== undefined || where || previous.kind === "operator") return name;
  }
  const following = tokens[index + 1];
  if (following !== undefined && COMPARISON_OPERATOR.test(following.raw)) {
    const name = comparedName(tokens[index + 2], false);
    if (name !== undefined) return name;
  }
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
 * The name of the other operand of a comparison: the last property of a variable's member access
 * (`$_.region`), a named variable (`$region`), or — for Where-Object's simplified syntax, where the
 * property comes first — a bare property name.
 */
function comparedName(token: ProgramToken | undefined, bareAllowed: boolean): string | undefined {
  if (token === undefined || token.kind !== "word") return undefined;
  const variable =
    /^\$(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/u.exec(
      token.raw,
    );
  if (variable !== null) {
    const [, name, members] = variable;
    const last = members!.split(".").at(-1);
    const chosen = last !== undefined && last.length > 0 ? last : name!;
    if (/^(?:_|psitem)$/iu.test(chosen) || chosen.length > 41) return undefined;
    return chosen;
  }
  if (!bareAllowed) return undefined;
  return /^[A-Za-z_][A-Za-z0-9_]{0,40}$/u.exec(token.raw)?.[0];
}

/**
 * A value PowerShell reads back as the same text as a bare argument word: no parameter (`-`), home
 * (`~`), variable, quote, escape or operator character. A number form other than a plain decimal
 * (`0x10`, `1kb`, `1e3`) is quoted too.
 */
const SAFE_BARE_WORD = /^[A-Za-z0-9_./\\][A-Za-z0-9_./\\:+=-]*$/u;

/** A number a script block reads back as the same number: a plain, possibly negative, decimal. */
const EXPRESSION_NUMBER = /^-?\d+(?:\.\d+)?$/u;

/**
 * Renders a bound value in place of a recorded PowerShell token, as data: bare when the recorded
 * token was a bare word and the value reads back as the same text, otherwise single-quoted (`'`
 * doubled). A number in a script block stays a bare number when the value is a plain decimal, and
 * is otherwise a single-quoted string; a string in a script block is always single-quoted. A value
 * PowerShell cannot pass through to a native program intact — empty, containing a double quote, a
 * line break or another control character but tab, a cmd.exe metacharacter (`& | < > ^ % !`, which
 * a command resolving to a batch file would parse again), or blanks with a trailing backslash — is
 * refused rather than approximated, in both editions and inside script blocks too.
 */
export function renderPowerShellTokenValue(token: ProgramToken, text: string): string {
  if (!token.bindable) throw new Error("the recorded program token is not safely bindable");
  if (token.kind !== "word" && token.kind !== "string" && token.kind !== "number") {
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
  if (token.kind === "number" && EXPRESSION_NUMBER.test(text)) return text;
  if (
    token.kind === "word" &&
    SAFE_BARE_WORD.test(text) &&
    (!NUMBER_FORM.test(text) || PLAIN_DECIMAL.test(text))
  ) {
    return text;
  }
  return `'${text.replaceAll("'", "''")}'`;
}
