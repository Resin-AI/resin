/** One replacement the redaction engine made, located in the text it redacted. */
export interface RedactionSpan {
  /** Half-open [start, end) offsets of the replaced text in the input. */
  start: number;
  end: number;
  /** The text standing in for it: a `[REDACTED_<TYPE>:<tag>]` placeholder, `$HOME` or a path alias. */
  replacement: string;
}

/** Deepest chain of replacements inside replacements (`$HOME` inside a scanned token) followed. */
const MAX_REPLACEMENT_NESTING = 8;

/**
 * Where each replacement in `redacted` sits in `original`. `replaced` maps every replacement text
 * the engine wrote to the texts it replaced; a replaced text may itself hold an earlier step's
 * replacement (a scanned token holding `$HOME`). Reading `redacted` from the start, each
 * replacement must expand to exactly the original text at that point and every other character
 * must equal the original's, through to its end. Anything else (an ambiguous or unexplained
 * difference) returns undefined, and the caller locates nothing.
 */
export function locateReplacements(
  original: string,
  redacted: string,
  replaced: ReadonlyMap<string, ReadonlySet<string>>,
): RedactionSpan[] | undefined {
  // Longest first, so a replacement that starts with another is tried whole.
  const replacements = [...replaced.keys()]
    .filter((replacement) => replacement.length > 0)
    .sort((a, b) => b.length - a.length);
  const spans: RedactionSpan[] = [];

  /** Reads `text` against `original` from `at`: where it ends there, or -1 when it does not fit. */
  const read = (text: string, at: number, depth: number): number => {
    let cursor = at;
    let index = 0;
    reading: while (index < text.length) {
      if (depth < MAX_REPLACEMENT_NESTING) {
        for (const replacement of replacements) {
          if (!text.startsWith(replacement, index)) continue;
          for (const value of replaced.get(replacement) ?? []) {
            const end = read(value, cursor, depth + 1);
            if (end < 0) continue;
            if (depth === 0) spans.push({ start: cursor, end, replacement });
            cursor = end;
            index += replacement.length;
            continue reading;
          }
        }
      }
      if (cursor >= original.length || original[cursor] !== text[index]) return -1;
      cursor += 1;
      index += 1;
    }
    return cursor;
  };

  return read(redacted, 0, 0) === original.length ? spans : undefined;
}
