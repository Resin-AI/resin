/**
 * Reading a recorded program as tokens, so a value embedded in it can be bound without rewriting
 * the program.
 *
 * A recorded program is executed as the text it was recorded as — quoting, redirections, pipes and
 * control flow included — so a value inside it cannot be replaced by editing text by hand: the
 * replacement must land exactly where the recorded token was, and it must stay data. This module is
 * the one tokenizer both halves of that round-trip use: the capture finds the token an earlier
 * result produced, and the runtime renders a confirmed binding back into the same token position,
 * so the two can never disagree about where a token is.
 *
 * Nothing here decides what a value means, and nothing here is specific to an application: a token
 * is a word, a quoted string or an operator of the language the recording named, and a value that
 * carries spaces, quotes or shell metacharacters is rendered quoted rather than pasted as syntax.
 */

import type { WorkflowRecordedProgram } from "./recorded-workflow.js";

export type ProgramLanguage = WorkflowRecordedProgram["kind"];

export type ProgramTokenKind = "word" | "string" | "operator";

/** One lexical token of a recorded program, with the span it occupies verbatim. */
export interface ProgramToken {
  kind: ProgramTokenKind;
  /** Half-open [start, end) offsets of the token's verbatim text in the program source. */
  start: number;
  end: number;
  /** The token exactly as it appeared in the program. */
  raw: string;
  /** The value a word or string denotes once quoting is removed; operators denote none. */
  value?: string;
}

/**
 * The shortest bare word the shell renderer will emit without quoting. Anything outside
 * `[A-Za-z0-9_./:=@%+,-]`, or an empty value, is quoted, so a bound value is never reinterpreted as
 * syntax (a `;`, a `$`, a backtick or a space all force quoting).
 */
const SAFE_BARE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** The two-character shell operators, matched before their one-character prefixes. */
const SHELL_OPERATORS_LONG = ["&&", "||", ">>", "<<", ";;"] as const;
/** The one-character shell operators this tokenizer recognizes. Braces are NOT operators: they
 * appear inside `${…}` and in ordinary file names, and treating them as separators would split a
 * word a substitution would then be wrong about. */
const SHELL_OPERATORS_SHORT = ["|", "&", ";", ">", "<", "(", ")"] as const;

function readShellQuoted(source: string, start: number): { value: string; end: number } {
  const quote = source[start]!;
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index]!;
    if (char === quote) return { value, end: index + 1 };
    if (quote === '"' && char === "\\" && index + 1 < source.length) {
      const next = source[index + 1]!;
      // Inside double quotes a backslash only escapes these characters; before anything else it is
      // part of the value. The distinction is what keeps `\n` two characters, as the shell reads it.
      if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
        value += next;
        index += 2;
        continue;
      }
    }
    value += char;
    index += 1;
  }
  // Unterminated quote: the rest of the program is the token's content, exactly as recorded.
  return { value, end: source.length };
}

function matchShellOperator(source: string, index: number): string | undefined {
  const rest = source.slice(index, index + 2);
  for (const operator of SHELL_OPERATORS_LONG) {
    if (rest === operator) return operator;
  }
  const char = source[index]!;
  for (const operator of SHELL_OPERATORS_SHORT) {
    if (char === operator) return operator;
  }
  return undefined;
}

/** A redirection with a file descriptor: `2>`, `1>>`, `0<` — the descriptor is part of the operator. */
function matchFileDescriptorOperator(source: string, index: number): string | undefined {
  let cursor = index;
  while (cursor < source.length && source[cursor]! >= "0" && source[cursor]! <= "9") cursor += 1;
  if (cursor === index) return undefined;
  const target = source[cursor];
  if (target !== ">" && target !== "<") return undefined;
  let end = cursor + 1;
  if (source[end] === ">" || source[end] === "&") end += 1;
  return source.slice(index, end);
}

function shellTokens(source: string): ProgramToken[] {
  const tokens: ProgramToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    // A comment runs to the end of its line and carries no value.
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    const descriptor = matchFileDescriptorOperator(source, index);
    if (descriptor !== undefined) {
      tokens.push({
        kind: "operator",
        start: index,
        end: index + descriptor.length,
        raw: descriptor,
      });
      index += descriptor.length;
      continue;
    }
    const operator = matchShellOperator(source, index);
    if (operator !== undefined) {
      tokens.push({ kind: "operator", start: index, end: index + operator.length, raw: operator });
      index += operator.length;
      continue;
    }
    const start = index;
    let value = "";
    let quotedFully = false;
    if (char === "'" || char === '"') {
      const quoted = readShellQuoted(source, index);
      value += quoted.value;
      index = quoted.end;
      // A token that is exactly one quoted string keeps the string kind; a word with a quote inside
      // it stays a word.
      quotedFully = !isShellWordContinuation(source, index);
    }
    while (index < source.length) {
      const current = source[index]!;
      if (current === " " || current === "\t" || current === "\n" || current === "\r") break;
      if (current === "'" || current === '"') {
        const quoted = readShellQuoted(source, index);
        value += quoted.value;
        index = quoted.end;
        continue;
      }
      if (current === "\\" && index + 1 < source.length) {
        value += source[index + 1];
        index += 2;
        continue;
      }
      if (matchShellOperator(source, index) !== undefined) break;
      if (matchFileDescriptorOperator(source, index) !== undefined) break;
      value += current;
      index += 1;
    }
    if (index === start) {
      // Defensive: no token consumed, advance so the scan cannot stall.
      index += 1;
      continue;
    }
    tokens.push({
      kind: quotedFully ? "string" : "word",
      start,
      end: index,
      raw: source.slice(start, index),
      value,
    });
  }
  return tokens;
}

/** Whether the character at `index` continues a shell word (so a quote was not the whole token). */
function isShellWordContinuation(source: string, index: number): boolean {
  const char = source[index];
  if (char === undefined) return false;
  if (char === " " || char === "\t" || char === "\n" || char === "\r") return false;
  if (matchShellOperator(source, index) !== undefined) return false;
  if (matchFileDescriptorOperator(source, index) !== undefined) return false;
  return true;
}

function unescapeScript(raw: string, language: ProgramLanguage): string {
  let value = "";
  const quote = raw[0]!;
  const triple = language === "python" && raw.length >= 6 && raw.slice(0, 3) === quote.repeat(3);
  const body = triple ? raw.slice(3, -3) : raw.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== "\\" || index + 1 >= body.length) {
      value += char;
      continue;
    }
    const next = body[index + 1]!;
    if (next === "n") value += "\n";
    else if (next === "t") value += "\t";
    else if (next === "r") value += "\r";
    else if (next === "0") value += "\0";
    else if (next === "\\") value += "\\";
    else if (next === "'" || next === '"' || next === "`") value += next;
    else if (next === "\n") value += "";
    else value += `\\${next}`;
    index += 1;
  }
  return value;
}

function scriptTokens(source: string, language: ProgramLanguage): ProgramToken[] {
  const tokens: ProgramToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (language === "python" && char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (language !== "python" && char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (language !== "python" && char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const start = index;
      const triple =
        language === "python" && source.slice(index, index + 3) === char.repeat(3);
      const quoteLength = triple ? 3 : 1;
      index += quoteLength;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) {
          index += 2;
          continue;
        }
        if (triple) {
          if (source.slice(index, index + 3) === char.repeat(3)) {
            index += 3;
            closed = true;
            break;
          }
          index += 1;
          continue;
        }
        if (source[index] === char) {
          index += 1;
          closed = true;
          break;
        }
        if (source[index] === "\n" && !triple) break;
        index += 1;
      }
      if (!closed) continue;
      const raw = source.slice(start, index);
      tokens.push({ kind: "string", start, end: index, raw, value: unescapeScript(raw, language) });
      continue;
    }
    if (char === "`" && language !== "python") {
      const start = index;
      index += 1;
      let interpolated = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") interpolated = true;
        if (source[index] === "`") {
          index += 1;
          break;
        }
        index += 1;
      }
      // A template literal that interpolates is code, not a value: substitute inside it and the
      // program would mean something else, so it is left alone.
      if (!interpolated) {
        const raw = source.slice(start, index);
        tokens.push({
          kind: "string",
          start,
          end: index,
          raw,
          value: unescapeScript(raw, language),
        });
      }
      continue;
    }
    index += 1;
  }
  return tokens;
}

/**
 * Tokenizes a recorded program in the language its record named.
 *
 * The tokenizer is total: an unterminated quote, an unknown construct or an unbalanced script
 * yields the tokens it could read rather than failing, because a recording that cannot be read
 * exactly still must not make the capture crash.
 */
export function tokenizeProgram(language: ProgramLanguage, source: string): ProgramToken[] {
  return language === "shell" ? shellTokens(source) : scriptTokens(source, language);
}

/** Escapes a value for a single-quoted shell string: `'` becomes `'\''`. */
function quoteShellSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Escapes a value for a double-quoted shell string. */
function quoteShellDouble(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

/**
 * Renders a bound value as the token it replaces: quoted like the recorded token when that token
 * was quoted, and quoted anyway when a bare word would not survive intact.
 */
export function renderProgramTokenValue(token: ProgramToken, value: string): string {
  if (token.kind === "operator") {
    throw new Error("a program operator cannot carry a bound value");
  }
  const quote = token.raw[0];
  if (token.kind === "string" && quote === "'") return quoteShellSingle(value);
  if (token.kind === "string" && quote === '"') return quoteShellDouble(value);
  if (token.kind === "string" && quote === "`") {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$")}"`;
  }
  if (SAFE_BARE_WORD.test(value)) return value;
  return quoteShellSingle(value);
}

/**
 * Rewrites a program by replacing the tokens named in `values`, leaving every other byte — quoting,
 * spacing, redirections, control flow and comments — exactly as it was recorded.
 *
 * A token index outside the tokenized program is refused rather than approximated: a plan that does
 * not describe the program it is run against must fail, never run something else.
 */
export function applyProgramTokenValues(
  source: string,
  tokens: readonly ProgramToken[],
  values: ReadonlyMap<number, string>,
): string {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const [tokenIndex, value] of values) {
    const token = tokens[tokenIndex];
    if (token === undefined) {
      throw new Error(
        `the recorded program has no token ${tokenIndex}; its shape does not match the plan`,
      );
    }
    replacements.push({
      start: token.start,
      end: token.end,
      text: renderProgramTokenValue(token, value),
    });
  }
  replacements.sort((left, right) => right.start - left.start);
  let rewritten = source;
  for (const replacement of replacements) {
    rewritten =
      rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }
  return rewritten;
}
