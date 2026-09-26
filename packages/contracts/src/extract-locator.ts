/**
 * Locating a value an earlier step printed.
 *
 * An `ExtractLocator` names where a value sits in a step's printed output: the text immediately
 * before it and the characters the value is made of. The locator text comes from tool output, so it
 * is always stored as a private resource and never uploaded.
 */

export type ExtractLocator = { before: string; charset: string[] };

const PUNCTUATION = "-_.:/@+";

function charsetAccepts(charset: readonly string[], char: string): boolean {
  for (const entry of charset) {
    if (entry === "lower" && char >= "a" && char <= "z") return true;
    if (entry === "upper" && char >= "A" && char <= "Z") return true;
    if (entry === "digit" && char >= "0" && char <= "9") return true;
    if (entry.length === 1 && entry === char) return true;
  }
  return false;
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
  if (!("before" in value) || !("charset" in value)) return undefined;
  const { before, charset } = value;
  if (typeof before !== "string" || !Array.isArray(charset) || charset.length === 0) {
    return undefined;
  }
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
  return { before, charset: entries };
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

/**
 * The first maximal run of charset characters that `before` immediately precedes in `output`.
 * With an empty `before`, candidate positions are the output start and every position after a
 * character outside the charset.
 */
export function extractPrintedValue(output: string, locator: ExtractLocator): string | undefined {
  const runAt = (start: number): string | undefined => {
    let end = start;
    while (end < output.length && charsetAccepts(locator.charset, output[end] ?? "")) end += 1;
    return end > start ? output.slice(start, end) : undefined;
  };
  if (locator.before.length === 0) {
    for (let position = 0; position < output.length; position += 1) {
      if (position > 0 && charsetAccepts(locator.charset, output[position - 1] ?? "")) continue;
      const run = runAt(position);
      if (run !== undefined) return run;
    }
    return undefined;
  }
  let from = 0;
  for (;;) {
    const index = output.indexOf(locator.before, from);
    if (index < 0) return undefined;
    const run = runAt(index + locator.before.length);
    if (run !== undefined) return run;
    from = index + 1;
  }
}
