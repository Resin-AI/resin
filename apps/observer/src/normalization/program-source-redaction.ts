import { type ProgramLanguage, type ProgramToken, tokenizeProgram } from "@resin/contracts";
import type { RedactionSpan } from "./redaction-spans.js";

/**
 * Placeholders of the entropy heuristics. Their match is a run of text the scanner judged random,
 * bounded by text rules (whitespace, quotes, brackets), not by the program's grammar, so it can take
 * in a neighbouring `;` or `|`. Every other replacement is an exact value (a named credential, an
 * environment or custom secret, a home path) and is redacted whole or not projected.
 */
const HEURISTIC_PLACEHOLDER = "[REDACTED_HIGH_ENTROPY_SECRET:";

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

function sameShape(original: readonly ProgramToken[], text: string, language: ProgramLanguage) {
  let tokens: ProgramToken[];
  try {
    tokens = tokenizeProgram(language, text);
  } catch {
    return false;
  }
  return (
    tokens.length === original.length &&
    tokens.every(
      (token, index) =>
        token.kind === original[index]!.kind &&
        token.bindable === original[index]!.bindable &&
        token.quote === original[index]!.quote,
    )
  );
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  let text = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return text;
}

/** The delimiter a token's text is enclosed in, when the whole token is one quoted string. */
function enclosingQuote(token: ProgramToken): string | undefined {
  if (token.quote !== undefined) return token.quote;
  return token.kind === "string" && /^['"`]/.test(token.raw) ? token.raw[0] : undefined;
}

/** Offsets in a token's text of what its quote delimiters enclose (all of it for a bare word). */
function contentRange(token: ProgramToken): [number, number] {
  const quote = enclosingQuote(token);
  if (quote !== undefined) {
    const open = token.raw.indexOf(quote);
    const close = token.raw.lastIndexOf(quote);
    if (open >= 0 && close >= open + quote.length) return [open + quote.length, close];
  }
  return [0, token.raw.length];
}

/** A replacement spelled so it stays literal text where it stands in this token. */
function spelledReplacement(
  replacement: string,
  token: ProgramToken,
  quote: string | undefined,
  language: ProgramLanguage,
): string {
  if (language === "shell") {
    if (quote === "'") return replacement;
    if (quote === '"' && token.bindable) {
      return replacement.replace(/[\\"$`]/g, (char) => `\\${char}`);
    }
    // A bare word a value could be bound to: escape what a shell would expand (`[...]`, `$HOME`),
    // so it stays one. A word that already expands keeps the placeholder as written.
    if (token.kind === "word" && token.bindable) {
      return replacement.replace(/[^A-Za-z0-9_./:=@%+,-]/g, (char) => `\\${char}`);
    }
    return replacement;
  }
  if ((language === "powershell" || language === "pwsh") && quote !== "'") {
    return replacement.replace(/[$`]/g, (char) => `\`${char}`);
  }
  return replacement;
}

/** Number of consecutive escape characters ending just before `index`. */
function escapesBefore(raw: string, index: number, escapeChar: string): number {
  let count = 0;
  while (index - count - 1 >= 0 && raw[index - count - 1] === escapeChar) count += 1;
  return count;
}

/**
 * The token's text with each value span replaced inside it, or undefined when nothing of the
 * token's value is covered. `whole` replaces the token's entire value instead. Quote delimiters stay;
 * a span never splits an escape sequence (it grows to take in the escaped character).
 */
function redactedToken(
  token: ProgramToken,
  pieces: readonly Edit[],
  language: ProgramLanguage,
  whole: boolean,
): string | undefined {
  const raw = token.raw;
  const quote = enclosingQuote(token);
  const [contentStart, contentEnd] = contentRange(token);
  const escapeChar = language === "powershell" || language === "pwsh" ? "`" : "\\";
  const local: Edit[] = [];
  for (const piece of pieces) {
    let start = Math.max(piece.start - token.start, contentStart);
    let end = Math.min(piece.end - token.start, contentEnd);
    if (end <= start) continue;
    if (escapesBefore(raw, start, escapeChar) % 2 === 1) start -= 1;
    while (end < contentEnd && escapesBefore(raw, end, escapeChar) % 2 === 1) end += 1;
    const previous = local.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    local.push({ start, end, replacement: piece.replacement });
  }
  if (local.length === 0) return undefined;
  if (whole) {
    const replacement = [...new Set(local.map((edit) => edit.replacement))].join("");
    local.splice(0, local.length, { start: contentStart, end: contentEnd, replacement });
  }
  return applyEdits(
    raw,
    local.map((edit) => ({
      ...edit,
      replacement: spelledReplacement(edit.replacement, token, quote, language),
    })),
  );
}

/**
 * A program's source with every redacted value replaced where it stands, keeping every token's
 * shape (kind, quoting, bindability), or undefined when that cannot be done.
 *
 * A whole-text redaction can change a program's token structure: a placeholder's `[...]` makes a
 * bare word a glob, `$HOME` makes it an expansion, and an entropy match can take in a `;` or the
 * backslash of a `\"`. Here each replacement is applied inside the tokens it covers instead. An
 * exact value must lie within one token's value, inside its quotes (or within text that is no
 * token, such as a comment).
 * An entropy match is cut to the tokens it covers: operators and whitespace are the program's
 * grammar, not part of a value, and stay; every covered character of a value is replaced. Each
 * covered token is first redacted where its values are; failing that, its entire value is replaced;
 * failing that, nothing is projected.
 */
export function redactProgramSourceInPlace(
  language: ProgramLanguage,
  source: string,
  spans: readonly RedactionSpan[],
): string | undefined {
  let tokens: ProgramToken[];
  try {
    tokens = tokenizeProgram(language, source);
  } catch {
    return undefined;
  }
  const pieces = new Map<number, Edit[]>();
  const gaps: Edit[] = [];
  const addPiece = (index: number, edit: Edit) => {
    const list = pieces.get(index) ?? [];
    list.push(edit);
    pieces.set(index, list);
  };
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.end <= span.start) return undefined;
    const covered = tokens.flatMap((token, index) =>
      token.start < span.end && token.end > span.start ? [index] : [],
    );
    if (!span.replacement.startsWith(HEURISTIC_PLACEHOLDER)) {
      if (covered.length === 0) {
        gaps.push({ ...span });
        continue;
      }
      const token = tokens[covered[0]!]!;
      const [contentStart, contentEnd] = contentRange(token);
      if (
        covered.length !== 1 ||
        token.kind === "operator" ||
        span.start < token.start + contentStart ||
        span.end > token.start + contentEnd
      ) {
        return undefined;
      }
      addPiece(covered[0]!, { ...span });
      continue;
    }
    let cursor = span.start;
    for (const index of covered) {
      const token = tokens[index]!;
      if (token.start > cursor && /\S/.test(source.slice(cursor, token.start))) {
        gaps.push({ start: cursor, end: token.start, replacement: span.replacement });
      }
      cursor = Math.max(cursor, token.end);
      if (token.kind === "operator") continue;
      addPiece(index, {
        start: Math.max(span.start, token.start),
        end: Math.min(span.end, token.end),
        replacement: span.replacement,
      });
    }
    if (cursor < span.end && /\S/.test(source.slice(cursor, span.end))) {
      gaps.push({ start: cursor, end: span.end, replacement: span.replacement });
    }
  }

  const decided: Edit[] = [...gaps];
  if (!sameShape(tokens, applyEdits(source, decided), language)) return undefined;
  for (const index of [...pieces.keys()].sort((a, b) => a - b)) {
    const token = tokens[index]!;
    let accepted = false;
    for (const whole of [false, true]) {
      const raw = redactedToken(token, pieces.get(index)!, language, whole);
      if (raw === undefined) {
        accepted = true;
        break;
      }
      const edit = { start: token.start, end: token.end, replacement: raw };
      if (sameShape(tokens, applyEdits(source, [...decided, edit]), language)) {
        decided.push(edit);
        accepted = true;
        break;
      }
    }
    if (!accepted) return undefined;
  }
  return applyEdits(source, decided);
}
