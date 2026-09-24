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
 * Nothing here decides what a value means or which applications are supported. Shell words and
 * operators, plus script identifiers and parsed literals, keep their original spans. A value that
 * is actually bound is rendered as data rather than pasted as syntax.
 */

import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";
import type { WorkflowRecordedProgram, WorkflowValueTemplate } from "./recorded-workflow.js";

export type ProgramLanguage = WorkflowRecordedProgram["kind"];

export type ProgramTokenKind =
  | "word"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "operator"
  | "unsupported";
export type ProgramTokenValue = string | number | boolean | null;

/** One lexical token of a recorded program, with the span it occupies verbatim. */
export interface ProgramToken {
  kind: ProgramTokenKind;
  /** Half-open [start, end) offsets of the token's verbatim text in the program source. */
  start: number;
  end: number;
  /** The token exactly as it appeared in the program. */
  raw: string;
  /** The statically known value, when the source represents one. */
  value?: ProgramTokenValue;
  /** Whether the token can safely be substituted as a value in its recorded program. */
  bindable: boolean;
  /** Original string delimiter; used for syntax-aware rendering of a replacement. */
  quote?: string;
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

function readShellQuoted(
  source: string,
  start: number,
): { value: string; end: number; bindable: boolean } {
  const quote = source[start]!;
  let index = start + 1;
  let value = "";
  let bindable = true;
  while (index < source.length) {
    const char = source[index]!;
    if (char === quote) return { value, end: index + 1, bindable };
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
    if (quote === '"' && (char === "$" || char === "`")) bindable = false;
    value += char;
    index += 1;
  }
  // Unterminated quote: the rest of the program is the token's content, exactly as recorded.
  return { value, end: source.length, bindable: false };
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
  let commandSubstitutionDepth = 0;
  let expectsCommandParenthesis = false;
  let insideBacktickSubstitution = false;
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
        bindable: false,
      });
      index += descriptor.length;
      continue;
    }
    const operator = matchShellOperator(source, index);
    if (operator !== undefined) {
      if (operator === "(") {
        if (expectsCommandParenthesis) {
          commandSubstitutionDepth += 1;
          expectsCommandParenthesis = false;
        } else if (commandSubstitutionDepth > 0) {
          commandSubstitutionDepth += 1;
        }
      } else if (operator === ")" && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth -= 1;
      } else if ((operator === "<" || operator === ">") && source[index + 1] === "(") {
        expectsCommandParenthesis = true;
      }
      tokens.push({
        kind: "operator",
        start: index,
        end: index + operator.length,
        raw: operator,
        bindable: false,
      });
      index += operator.length;
      continue;
    }
    const start = index;
    let value = "";
    let quotedFully = false;
    let bindable = commandSubstitutionDepth === 0 && !insideBacktickSubstitution;
    if (char === "'" || char === '"') {
      const quoted = readShellQuoted(source, index);
      value += quoted.value;
      bindable &&= quoted.bindable;
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
        bindable &&= quoted.bindable;
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
      if ("$*?[]{}~".includes(current)) bindable = false;
      if (current === "$" && source[index + 1] === "(") {
        expectsCommandParenthesis = true;
        bindable = false;
      }
      if (current === "`") {
        bindable = false;
        insideBacktickSubstitution = !insideBacktickSubstitution;
      }
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
      ...(bindable ? { value } : {}),
      bindable,
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
interface ProgramSyntaxNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: ProgramSyntaxNode | null;
  readonly nextSibling: ProgramSyntaxNode | null;
  readonly type: { readonly isError: boolean };
}

interface ProgramSyntaxTree {
  readonly topNode: ProgramSyntaxNode;
}

export class ProgramTokenizationError extends Error {
  constructor(
    public readonly language: ProgramLanguage,
    public readonly offset: number,
  ) {
    super(`cannot tokenize invalid ${language} source at offset ${offset}`);
    this.name = "ProgramTokenizationError";
  }
}

function syntaxChildren(node: ProgramSyntaxNode): ProgramSyntaxNode[] {
  const children: ProgramSyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

function findParseError(root: ProgramSyntaxNode): ProgramSyntaxNode | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type.isError) return node;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      pending.push(child);
    }
  }
  return undefined;
}

function containsNodeNamed(root: ProgramSyntaxNode, name: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.name === name) return true;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      pending.push(child);
    }
  }
  return false;
}

function decodeJavaScriptString(raw: string): string | undefined {
  const quote = raw[0]!;
  if (raw.length < 2 || raw.at(-1) !== quote) return undefined;
  const body = raw.slice(1, -1);
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== "\\") {
      value += char;
      continue;
    }
    if (index + 1 >= body.length) return undefined;
    const next = body[++index]!;
    if (next === "b") value += "\b";
    else if (next === "f") value += "\f";
    else if (next === "n") value += "\n";
    else if (next === "r") value += "\r";
    else if (next === "t") value += "\t";
    else if (next === "v") value += "\v";
    else if (next === "\n") continue;
    else if (next === "\r") {
      if (body[index + 1] === "\n") index += 1;
    } else if (next === "0") {
      if (/\d/u.test(body[index + 1] ?? "")) return undefined;
      value += "\0";
    } else if (next === "x") {
      const digits = body.slice(index + 1, index + 3);
      if (!/^[\da-fA-F]{2}$/u.test(digits)) return undefined;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 2;
    } else if (next === "u") {
      if (body[index + 1] === "{") {
        const close = body.indexOf("}", index + 2);
        if (close < 0) return undefined;
        const digits = body.slice(index + 2, close);
        if (!/^[\da-fA-F]+$/u.test(digits)) return undefined;
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) return undefined;
        value += String.fromCodePoint(codePoint);
        index = close;
      } else {
        const digits = body.slice(index + 1, index + 5);
        if (!/^[\da-fA-F]{4}$/u.test(digits)) return undefined;
        value += String.fromCharCode(Number.parseInt(digits, 16));
        index += 4;
      }
    } else if (/[1-9]/u.test(next)) {
      return undefined;
    } else {
      // ECMAScript non-escape characters denote the character without the backslash.
      value += next;
    }
  }
  return value;
}

function pythonStringParts(
  raw: string,
): { prefix: string; quote: string; body: string } | undefined {
  let quoteStart = 0;
  while (/[rRuUbBfF]/u.test(raw[quoteStart] ?? "")) quoteStart += 1;
  const quoteChar = raw[quoteStart];
  if (quoteChar !== "'" && quoteChar !== '"') return undefined;
  const quoteLength = raw.slice(quoteStart, quoteStart + 3) === quoteChar.repeat(3) ? 3 : 1;
  const quote = quoteChar.repeat(quoteLength);
  if (!raw.endsWith(quote)) return undefined;
  return {
    prefix: raw.slice(0, quoteStart).toLowerCase(),
    quote,
    body: raw.slice(quoteStart + quoteLength, raw.length - quoteLength),
  };
}

function decodePythonString(raw: string): { value?: string; quote: string; bindable: boolean } {
  const parts = pythonStringParts(raw);
  if (parts === undefined || parts.prefix.includes("b")) {
    return { quote: parts?.quote ?? "'", bindable: false };
  }
  let value = "";
  if (parts.prefix.includes("r")) {
    value = parts.body;
  } else {
    const { body } = parts;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!;
      if (char !== "\\") {
        value += char;
        continue;
      }
      if (index + 1 >= body.length) return { quote: parts.quote, bindable: false };
      const next = body[++index]!;
      if (next === "a") value += "\x07";
      else if (next === "b") value += "\b";
      else if (next === "f") value += "\f";
      else if (next === "n") value += "\n";
      else if (next === "r") value += "\r";
      else if (next === "t") value += "\t";
      else if (next === "v") value += "\v";
      else if (next === "\\") value += "\\";
      else if (next === "'" || next === '"') value += next;
      else if (next === "\n") continue;
      else if (next === "\r") {
        if (body[index + 1] === "\n") index += 1;
      } else if (/[0-7]/u.test(next)) {
        let digits = next;
        while (digits.length < 3 && /[0-7]/u.test(body[index + 1] ?? "")) {
          digits += body[++index]!;
        }
        value += String.fromCharCode(Number.parseInt(digits, 8));
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        const digits = body.slice(index + 1, index + 1 + length);
        if (digits.length !== length || !/^[\da-fA-F]+$/u.test(digits)) {
          return { quote: parts.quote, bindable: false };
        }
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) return { quote: parts.quote, bindable: false };
        value += String.fromCodePoint(codePoint);
        index += length;
      } else if (next === "N") {
        // Named Unicode escapes require the Unicode name database and are not guessed.
        return { quote: parts.quote, bindable: false };
      } else {
        // Python preserves an unrecognized escape and its backslash.
        value += `\\${next}`;
      }
    }
  }
  if (parts.prefix.includes("f")) value = value.replaceAll("{{", "{").replaceAll("}}", "}");
  return { value, quote: parts.quote, bindable: true };
}

function numericLiteralValue(raw: string, language: ProgramLanguage): number | undefined {
  if (language === "javascript" || language === "typescript") {
    if (raw.endsWith("n")) return undefined;
  } else if (/[jJ]$/u.test(raw)) {
    return undefined;
  }
  const normalized = raw.replaceAll("_", "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  if (language === "python" && !/[.eEjJ]/u.test(raw)) {
    try {
      if (BigInt(normalized) !== BigInt(value)) return undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function isIdentifierNode(name: string): boolean {
  return name.endsWith("Name") || name.endsWith("Definition") || name === "Identifier";
}

function scriptTokens(source: string, language: ProgramLanguage): ProgramToken[] {
  const parser =
    language === "python"
      ? pythonParser
      : language === "typescript"
        ? javascriptParser.configure({ dialect: "ts" })
        : javascriptParser;
  const tree = parser.parse(source) as ProgramSyntaxTree;
  const parseError = findParseError(tree.topNode);
  if (parseError !== undefined) throw new ProgramTokenizationError(language, parseError.from);

  const tokens: ProgramToken[] = [];
  const pending: Array<{ node: ProgramSyntaxNode; parent: ProgramSyntaxNode | null }> = [
    { node: tree.topNode, parent: null },
  ];
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    const raw = source.slice(node.from, node.to);
    const typeContext =
      parent?.name === "LiteralType" ||
      parent?.name === "NullType" ||
      parent?.name === "LiteralPattern";

    if (node.name === "UnaryExpression") {
      const children = syntaxChildren(node);
      if (
        children.length === 2 &&
        children[0]!.name === "ArithOp" &&
        (source.slice(children[0]!.from, children[0]!.to) === "+" ||
          source.slice(children[0]!.from, children[0]!.to) === "-") &&
        children[1]!.name === "Number"
      ) {
        const numberRaw = source.slice(children[1]!.from, children[1]!.to);
        const number = numericLiteralValue(numberRaw, language);
        const sign = source[children[0]!.from] === "-" ? -1 : 1;
        tokens.push({
          kind: "number",
          start: node.from,
          end: node.to,
          raw,
          ...(number === undefined ? {} : { value: number * sign }),
          bindable: !typeContext && number !== undefined,
        });
        continue;
      }
    }

    if (language === "python" && node.name === "ContinuedString") {
      let staticValue = "";
      let quote = "'";
      let bindable = !typeContext;
      let hasQuote = false;
      const fragmentStack = syntaxChildren(node).reverse();
      while (fragmentStack.length > 0) {
        const fragment = fragmentStack.pop()!;
        if (fragment.name === "String" || fragment.name === "FormatString") {
          if (
            fragment.name === "FormatString" &&
            containsNodeNamed(fragment, "FormatReplacement")
          ) {
            bindable = false;
          } else {
            const decoded = decodePythonString(source.slice(fragment.from, fragment.to));
            if (!decoded.bindable || decoded.value === undefined) {
              bindable = false;
            } else {
              if (!hasQuote) quote = decoded.quote;
              hasQuote = true;
              staticValue += decoded.value;
            }
          }
        } else {
          for (const child of syntaxChildren(fragment).reverse()) fragmentStack.push(child);
        }
      }
      tokens.push({
        kind: "string",
        start: node.from,
        end: node.to,
        raw,
        ...(bindable ? { value: staticValue } : {}),
        bindable,
        quote,
      });
      continue;
    }

    if (node.name === "String") {
      if (language === "python") {
        const decoded = decodePythonString(raw);
        tokens.push({
          kind: "string",
          start: node.from,
          end: node.to,
          raw,
          ...(decoded.value === undefined ? {} : { value: decoded.value }),
          bindable: decoded.bindable && !typeContext,
          quote: decoded.quote,
        });
      } else {
        const value = decodeJavaScriptString(raw);
        tokens.push({
          kind: "string",
          start: node.from,
          end: node.to,
          raw,
          ...(value === undefined ? {} : { value }),
          bindable: value !== undefined && !typeContext,
          quote: raw[0]!,
        });
      }
      continue;
    }

    if (language === "python" && node.name === "FormatString") {
      const interpolated = containsNodeNamed(node, "FormatReplacement");
      const decoded = interpolated ? undefined : decodePythonString(raw);
      tokens.push({
        kind: "string",
        start: node.from,
        end: node.to,
        raw,
        ...(decoded?.value === undefined ? {} : { value: decoded.value }),
        bindable: decoded?.bindable === true && !typeContext,
        quote: decoded?.quote ?? pythonStringParts(raw)?.quote ?? "'",
      });
      if (interpolated) {
        for (const child of syntaxChildren(node).reverse()) {
          pending.push({ node: child, parent: node });
        }
      }
      continue;
    }

    if (
      (language === "javascript" || language === "typescript") &&
      node.name === "TemplateString"
    ) {
      const interpolated = containsNodeNamed(node, "Interpolation");
      const tagged = parent?.name === "TaggedTemplateExpression";
      const value = interpolated || tagged ? undefined : decodeJavaScriptString(raw);
      tokens.push({
        kind: "string",
        start: node.from,
        end: node.to,
        raw,
        ...(value === undefined ? {} : { value }),
        bindable: value !== undefined && !typeContext,
        quote: "`",
      });
      if (interpolated) {
        for (const child of syntaxChildren(node).reverse()) {
          pending.push({ node: child, parent: node });
        }
      }
      continue;
    }

    if ((language === "javascript" || language === "typescript") && node.name === "RegExp") {
      tokens.push({
        kind: "unsupported",
        start: node.from,
        end: node.to,
        raw,
        bindable: false,
      });
      continue;
    }
    if (language === "python" && raw === "..." && node.firstChild === null) {
      tokens.push({
        kind: "unsupported",
        start: node.from,
        end: node.to,
        raw,
        bindable: false,
      });
      continue;
    }
    if (node.name === "Number") {
      const value = numericLiteralValue(raw, language);
      tokens.push({
        kind: "number",
        start: node.from,
        end: node.to,
        raw,
        ...(value === undefined ? {} : { value }),
        bindable: value !== undefined && !typeContext,
      });
      continue;
    }

    if (
      (language === "python" && node.name === "Boolean") ||
      ((language === "javascript" || language === "typescript") && node.name === "BooleanLiteral")
    ) {
      tokens.push({
        kind: "boolean",
        start: node.from,
        end: node.to,
        raw,
        value: raw === "true" || raw === "True",
        bindable: !typeContext,
      });
      continue;
    }

    if ((language === "python" && node.name === "None") || node.name === "null") {
      tokens.push({
        kind: "null",
        start: node.from,
        end: node.to,
        raw,
        value: null,
        bindable: !typeContext,
      });
      continue;
    }

    if (node.firstChild === null && isIdentifierNode(node.name)) {
      tokens.push({
        kind: "word",
        start: node.from,
        end: node.to,
        raw,
        value: raw,
        bindable: false,
      });
      continue;
    }

    for (const child of syntaxChildren(node).reverse()) {
      pending.push({ node: child, parent: node });
    }
  }
  tokens.sort((left, right) => left.start - right.start || left.end - right.end);
  return tokens;
}

/**
 * Tokenizes a recorded program in the language its record named.
 *
 * Shell remains a conservative word/operator lexer. JavaScript, TypeScript and Python literal
 * boundaries come from their Lezer grammars; malformed syntax fails closed instead of yielding a
 * partial token list.
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

function escapeScriptString(value: string, quote: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\v", "\\v")
    .replaceAll("\0", "\\x00")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapePythonString(value: string, quote: string): string {
  return escapeScriptString(value, quote);
}

function renderScriptString(token: ProgramToken, value: string, language: ProgramLanguage): string {
  if (language === "python") {
    const quote = token.quote?.[0] === '"' ? '"' : "'";
    return `${quote}${escapePythonString(value, quote)}${quote}`;
  }
  const quote = token.quote ?? token.raw[0]!;
  if (quote === "`") {
    return `\`${value
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("${", "\\${")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029")}\``;
  }
  return `${quote}${escapeScriptString(value, quote)}${quote}`;
}

/**
 * Renders a bound value using the token's original language and literal kind.
 * Numeric and boolean tokens remain typed until this syntax boundary.
 */
export function renderProgramTokenValue(
  token: ProgramToken,
  value: ProgramTokenValue,
  language: ProgramLanguage = "shell",
): string {
  if (!token.bindable) throw new Error("the recorded program token is not safely bindable");
  if (token.kind === "operator" || token.kind === "unsupported") {
    throw new Error("this program token cannot carry a bound value");
  }
  if (token.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("a numeric program token requires a finite number");
    }
    return String(value);
  }
  if (token.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw new TypeError("a boolean program token requires a boolean");
    }
    return language === "python" ? (value ? "True" : "False") : String(value);
  }
  if (token.kind === "null") {
    if (value !== null) throw new TypeError("a null program token requires null");
    return language === "python" ? "None" : "null";
  }
  const text = typeof value === "string" ? value : value === null ? "null" : String(value);
  if (language !== "shell") return renderScriptString(token, text, language);
  const quote = token.raw[0];
  if (token.kind === "string" && quote === "'") return quoteShellSingle(text);
  if (token.kind === "string" && quote === '"') return quoteShellDouble(text);
  if (token.kind === "string" && quote === "`") {
    return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$")}"`;
  }
  if (SAFE_BARE_WORD.test(text)) return text;
  return quoteShellSingle(text);
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
  values: ReadonlyMap<number, ProgramTokenValue>,
  language: ProgramLanguage = "shell",
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
      text: renderProgramTokenValue(token, value, language),
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

/**
 * The program an argument resolves through, with one token bound to a value the replay confirmed.
 *
 * A program argument is recorded as the text it was — usually a private leaf — so the first bound
 * token has to lift that text into a program template; a later one adds a hole to the template that
 * is already there. Both the local replay and the compiler of the published artifact call this one
 * function, so a binding confirmed in a replay is written into the plan exactly as the artifact
 * will render it.
 */
export function bindProgramToken(
  source: WorkflowValueTemplate,
  language: ProgramLanguage,
  token: number,
  binding: WorkflowValueTemplate,
): WorkflowValueTemplate {
  if (source.type !== "program") {
    return { type: "program", language, source, holes: [{ token, binding }] };
  }
  // A program template already carries the language its record established; a caller that disagrees
  // would be describing another program, so the recorded one wins.
  const holes = source.holes.filter((hole) => hole.token !== token);
  holes.push({ token, binding });
  holes.sort((left, right) => left.token - right.token);
  return { ...source, holes };
}
