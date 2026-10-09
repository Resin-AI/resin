/**
 * Locating a value an earlier step printed.
 *
 * An `ExtractLocator` names where a value sits in a step's printed output and the characters the
 * value is made of. It takes one of two forms:
 *
 *   - `{ before, charset }` reads the first run of charset characters that `before` immediately
 *     precedes;
 *   - `{ only: { before, after, line? }, charset }` reads the one whole run of charset characters
 *     that `before` immediately precedes and `after` immediately follows — on the line `offset`
 *     lines below the only line holding the word `marker` when `line` is given, anywhere in the
 *     output otherwise. No such run, or several, reads no value: the locator never picks one.
 *
 * The second form carries no top-level `before`, so a runtime that only knows the first form
 * refuses it as malformed rather than reading it as the first form. The locator text comes from
 * tool output, so it is always stored as a private resource and never uploaded.
 */

export type ExtractLocator =
  | { before: string; charset: string[] }
  | { only: ExtractOnlyPlace; charset: string[] };

export interface ExtractOnlyPlace {
  /** Text immediately before the run; empty when any whole run qualifies. */
  before: string;
  /** Text immediately after the run; empty when any whole run qualifies. */
  after: string;
  /** Read only on the line `offset` lines below the only line holding `marker` as a word. */
  line?: { marker: string; offset: number };
}

/** What a locator found in one output: the one value, nothing, or several candidate values. */
export type PrintedValueSearch =
  | { found: "one"; value: string }
  | { found: "none" }
  | { found: "several" };

const PUNCTUATION = "-_.:/@+";

/** A marker is a word of letters; it is found where no letter, digit or `_` adjoins it. */
const MARKER = /^[A-Za-z]{3,64}$/;
const MAX_MARKER_OFFSET = 64;

function charsetAccepts(charset: readonly string[], char: string): boolean {
  for (const entry of charset) {
    if (entry === "lower" && char >= "a" && char <= "z") return true;
    if (entry === "upper" && char >= "A" && char <= "Z") return true;
    if (entry === "digit" && char >= "0" && char <= "9") return true;
    if (entry.length === 1 && entry === char) return true;
  }
  return false;
}

function parseCharset(charset: unknown): string[] | undefined {
  if (!Array.isArray(charset) || charset.length === 0) return undefined;
  const entries: string[] = [];
  for (const entry of charset) {
    if (
      typeof entry !== "string" ||
      !(
        entry === "lower" ||
        entry === "upper" ||
        entry === "digit" ||
        (entry.length === 1 && PUNCTUATION.includes(entry))
      )
    ) {
      return undefined;
    }
    entries.push(entry);
  }
  return entries;
}

function parseOnlyPlace(value: unknown): ExtractOnlyPlace | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { before, after, line } = value as Record<string, unknown>;
  if (typeof before !== "string" || typeof after !== "string") return undefined;
  if (line === undefined) return { before, after };
  if (typeof line !== "object" || line === null || Array.isArray(line)) return undefined;
  const { marker, offset } = line as Record<string, unknown>;
  if (typeof marker !== "string" || !MARKER.test(marker)) return undefined;
  if (typeof offset !== "number" || !Number.isInteger(offset)) return undefined;
  if (offset < 1 || offset > MAX_MARKER_OFFSET) return undefined;
  // A line-scoped locator reads inside one line, so its texts never cross a line break.
  if (before.includes("\n") || after.includes("\n")) return undefined;
  return { before, after, line: { marker, offset } };
}

/** Parses and shape-checks a locator's JSON text; undefined when it is not a valid locator. */
export function parseExtractLocator(text: string): ExtractLocator | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const charset = parseCharset(record.charset);
  if (charset === undefined) return undefined;
  if ("only" in record) {
    if ("before" in record) return undefined;
    const only = parseOnlyPlace(record.only);
    return only === undefined ? undefined : { only, charset };
  }
  if (typeof record.before !== "string") return undefined;
  return { before: record.before, charset };
}

/** The charset a value is made of, or undefined when it holds a character no charset admits. */
export function extractCharsetOf(value: string): string[] | undefined {
  const entries = new Set<string>();
  for (const char of value) {
    if (char >= "a" && char <= "z") entries.add("lower");
    else if (char >= "A" && char <= "Z") entries.add("upper");
    else if (char >= "0" && char <= "9") entries.add("digit");
    else if (PUNCTUATION.includes(char)) entries.add(char);
    else return undefined;
  }
  const order = ["lower", "upper", "digit", ...PUNCTUATION];
  return order.filter((entry) => entries.has(entry));
}

/** Whether `text` holds `word` where no letter, digit or `_` adjoins it. */
export function holdsMarkerWord(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const edges = (text[at - 1] ?? " ") + (text[at + word.length] ?? " ");
    if (!/[A-Za-z0-9_]/.test(edges)) return true;
  }
  return false;
}

/** The first-form read: the first charset run `before` immediately precedes. */
function firstRun(output: string, before: string, charset: readonly string[]): string | undefined {
  const runAt = (start: number): string | undefined => {
    let end = start;
    while (end < output.length && charsetAccepts(charset, output[end] ?? "")) end += 1;
    return end > start ? output.slice(start, end) : undefined;
  };
  if (before.length === 0) {
    for (let position = 0; position < output.length; position += 1) {
      if (position > 0 && charsetAccepts(charset, output[position - 1] ?? "")) continue;
      const run = runAt(position);
      if (run !== undefined) return run;
    }
    return undefined;
  }
  let from = 0;
  for (;;) {
    const index = output.indexOf(before, from);
    if (index < 0) return undefined;
    const run = runAt(index + before.length);
    if (run !== undefined) return run;
    from = index + 1;
  }
}

/** Whole charset runs in `scope` that `before` precedes and `after` follows; stops at two. */
function wholeRuns(
  scope: string,
  before: string,
  after: string,
  charset: readonly string[],
): string[] {
  const accepts = (index: number) =>
    index >= 0 && index < scope.length && charsetAccepts(charset, scope[index] ?? "");
  const runs: string[] = [];
  const consider = (start: number, end: number) => {
    if (end <= start || accepts(start - 1) || accepts(end)) return;
    if (!scope.startsWith(before, start - before.length) || start < before.length) return;
    if (!scope.startsWith(after, end)) return;
    runs.push(scope.slice(start, end));
  };
  if (before.length > 0) {
    for (
      let at = scope.indexOf(before);
      at >= 0 && runs.length < 2;
      at = scope.indexOf(before, at + 1)
    ) {
      const start = at + before.length;
      let end = start;
      while (accepts(end)) end += 1;
      consider(start, end);
    }
  } else if (after.length > 0) {
    for (
      let at = scope.indexOf(after);
      at >= 0 && runs.length < 2;
      at = scope.indexOf(after, at + 1)
    ) {
      let start = at;
      while (accepts(start - 1)) start -= 1;
      consider(start, at);
    }
  } else {
    for (let start = 0; start < scope.length && runs.length < 2; start += 1) {
      if (!accepts(start) || accepts(start - 1)) continue;
      let end = start;
      while (accepts(end)) end += 1;
      consider(start, end);
      start = end;
    }
  }
  return runs;
}

/** What `locator` reads from `output`; a first-form locator never reads several values. */
export function searchPrintedValue(output: string, locator: ExtractLocator): PrintedValueSearch {
  if (!("only" in locator)) {
    const value = firstRun(output, locator.before, locator.charset);
    return value === undefined ? { found: "none" } : { found: "one", value };
  }
  const { before, after, line } = locator.only;
  let scope = output;
  if (line !== undefined) {
    const lines = output.split("\n");
    const marked = lines.flatMap((text, index) =>
      holdsMarkerWord(text, line.marker) ? [index] : [],
    );
    if (marked.length > 1) return { found: "several" };
    const target = marked.length === 1 ? lines[marked[0]! + line.offset] : undefined;
    if (target === undefined) return { found: "none" };
    scope = target;
  }
  const runs = wholeRuns(scope, before, after, locator.charset);
  if (runs.length === 0) return { found: "none" };
  if (runs.length > 1) return { found: "several" };
  return { found: "one", value: runs[0]! };
}

/** The value `locator` reads from `output`, or undefined when it reads none or several. */
export function extractPrintedValue(output: string, locator: ExtractLocator): string | undefined {
  const search = searchPrintedValue(output, locator);
  return search.found === "one" ? search.value : undefined;
}
