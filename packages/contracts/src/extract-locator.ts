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
 *     output otherwise. On that line, a `before` starting with a line break reads from the line's
 *     start. No such run, or several, reads no value: the locator never picks one.
 *
 * A run is a value only where it holds a letter or digit (a dashed rule is no value) and the text
 * does not continue it past the locator's own texts: `pdf` in `pdf2text`, `contact_email` in
 * `accounts-contact_email` or `lodash` in `lodash.merge` is part of a value the charset cannot
 * hold. Such a cut run reads no value, and beside another run it makes the read ambiguous.
 *
 * The second form carries no top-level `before`, so a runtime that only knows the first form
 * refuses it as malformed rather than reading it as the first form. The locator text comes from
 * tool output, so it is always stored as a private resource and never uploaded.
 */

export type ExtractLocator =
  | { before: string; charset: string[] }
  | { only: ExtractOnlyPlace; charset: string[] };

export interface ExtractOnlyPlace {
  /**
   * Text immediately before the run; empty when any whole run qualifies. On a `line`, a leading
   * line break stands for the line's start.
   */
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
  // A line-scoped locator reads inside one line: only a leading line break, standing for the
  // line's start, may appear in its texts. Runtimes before that reading refuse it as malformed.
  if (before.indexOf("\n", 1) >= 0 || after.includes("\n")) return undefined;
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

/**
 * Whether the character at `index` carries a value on past a run's edge, reading away from the
 * run in `direction`: a letter, digit or `_`, or a punctuation mark with a letter or digit beyond
 * it (`-` in `accounts-contact_email`, `.` in `lodash.merge`). A sentence's closing `.` or a
 * label's `:` before a space does not.
 */
function continuesValue(text: string, index: number, direction: 1 | -1): boolean {
  const char = text[index];
  if (char === undefined) return false;
  if (/[A-Za-z0-9_]/.test(char)) return true;
  return PUNCTUATION.includes(char) && /[A-Za-z0-9]/.test(text[index + direction] ?? "");
}

/** A run with no letter or digit (`----`) is no value. */
const HOLDS_VALUE = /[A-Za-z0-9]/;

/**
 * The first-form read: the first charset run `before` immediately precedes. An occurrence of
 * `before` followed by no run, or by a run that is no value, is passed over; a run the text
 * continues past is a value the charset cannot hold, so the read stops there with none.
 */
function firstRun(output: string, before: string, charset: readonly string[]): string | undefined {
  const runAt = (start: number): { value: string } | "skip" | "cut" => {
    let end = start;
    while (end < output.length && charsetAccepts(charset, output[end] ?? "")) end += 1;
    const run = output.slice(start, end);
    if (!HOLDS_VALUE.test(run)) return "skip";
    if (continuesValue(output, end, 1)) return "cut";
    if (before.length === 0 && continuesValue(output, start - 1, -1)) return "cut";
    return { value: run };
  };
  if (before.length === 0) {
    for (let position = 0; position < output.length; position += 1) {
      if (position > 0 && charsetAccepts(charset, output[position - 1] ?? "")) continue;
      const run = runAt(position);
      if (run === "cut") return undefined;
      if (run !== "skip") return run.value;
    }
    return undefined;
  }
  let from = 0;
  for (;;) {
    const index = output.indexOf(before, from);
    if (index < 0) return undefined;
    const run = runAt(index + before.length);
    if (run === "cut") return undefined;
    if (run !== "skip") return run.value;
    from = index + 1;
  }
}

/**
 * Charset runs in `scope` that `before` precedes and `after` follows, as their text or `null` for
 * a run the text continues past (see `continuesValue`); stops at two.
 */
function wholeRuns(
  scope: string,
  before: string,
  after: string,
  charset: readonly string[],
): Array<string | null> {
  const accepts = (index: number) =>
    index >= 0 && index < scope.length && charsetAccepts(charset, scope[index] ?? "");
  const runs: Array<string | null> = [];
  const consider = (start: number, end: number) => {
    if (end <= start || accepts(start - 1) || accepts(end)) return;
    if (!scope.startsWith(before, start - before.length) || start < before.length) return;
    if (!scope.startsWith(after, end)) return;
    const run = scope.slice(start, end);
    if (!HOLDS_VALUE.test(run)) return;
    const cut =
      (before.length === 0 && continuesValue(scope, start - 1, -1)) ||
      (after.length === 0 && continuesValue(scope, end, 1));
    runs.push(cut ? null : run);
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
    // The line break before the line lets a `before` starting with one read from its start.
    scope = `\n${target}`;
  }
  const runs = wholeRuns(scope, before, after, locator.charset);
  if (runs.length > 1) return { found: "several" };
  const value = runs[0];
  return value === undefined || value === null ? { found: "none" } : { found: "one", value };
}

/** The value `locator` reads from `output`, or undefined when it reads none or several. */
export function extractPrintedValue(output: string, locator: ExtractLocator): string | undefined {
  const search = searchPrintedValue(output, locator);
  return search.found === "one" ? search.value : undefined;
}
