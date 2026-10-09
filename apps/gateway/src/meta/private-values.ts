/**
 * Defense in depth for text a meta tool returns to the model: no resolved private value of a learned
 * tool's plan may appear in it, whatever path produced the text.
 */

import type { RegistryTool } from "../registry/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/**
 * The resolved private values of a learned tool's plan on this machine (string leaves of
 * {@link MIN_SCRUBBED_PRIVATE_VALUE_CHARS}+ characters, longest first); none for any other tool.
 */
export type LocalToolPrivateValues = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => readonly string[];

/** What a resolved private value is replaced with wherever it would otherwise be shown. */
export const SCRUBBED_PRIVATE_VALUE = "<private>";
/** Shorter private values are not scrubbed: they would match ordinary words. */
export const MIN_SCRUBBED_PRIVATE_VALUE_CHARS = 4;
/** A word-like value this long or longer is treated as secret-like and scrubbed anywhere. */
export const SECRET_LIKE_PRIVATE_VALUE_CHARS = 16;

/** A placeholder already in the text: `<private>` or the describer's `<private:N>`. */
const PLACEHOLDER = /(<private(?::\d+)?>)/u;
const WORD_CHARACTERS = /^[\p{L}\p{N}_]+$/u;

/**
 * Whether a value reads as an ordinary word, so it is scrubbed only where it stands as a whole word:
 * made only of letters, digits and `_`, shorter than {@link SECRET_LIKE_PRIVATE_VALUE_CHARS}, and not
 * a mix of letters and digits of 8 or more characters (a password-like token).
 *
 * Such values are mostly a harness tool's recorded arguments (`"play"`, `"server"`), which also
 * occur inside public tool and input names (`solo_playtest`, `{server_code}`); scrubbing them there
 * would mangle the names an agent must call. Any other value, including every value containing
 * `/`, `-`, `.` or another separator, is scrubbed wherever it appears, even inside a longer word.
 */
function isWordLikeValue(value: string): boolean {
  if (value.length >= SECRET_LIKE_PRIVATE_VALUE_CHARS || !WORD_CHARACTERS.test(value)) {
    return false;
  }
  return !(value.length >= 8 && /\p{L}/u.test(value) && /\p{N}/u.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceValue(segment: string, value: string): string {
  if (!segment.includes(value)) return segment;
  if (!isWordLikeValue(value)) return segment.split(value).join(SCRUBBED_PRIVATE_VALUE);
  // Whole words only: not preceded or followed by a letter, digit or `_`.
  const wholeWord = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return segment.replace(wholeWord, SCRUBBED_PRIVATE_VALUE);
}

/**
 * The text with every occurrence of each value replaced by {@link SCRUBBED_PRIVATE_VALUE}: a
 * word-like value (see {@link isWordLikeValue}) where it stands as a whole word, any other value
 * wherever it appears. `values` must be longest first, so a value containing another is replaced
 * whole. Placeholders already in the text are never rewritten.
 */
export function scrubPrivateValues(text: string, values: readonly string[]): string {
  let scrubbed = text;
  for (const value of values) {
    if (!scrubbed.includes(value)) continue;
    scrubbed = scrubbed
      .split(PLACEHOLDER)
      .map((segment, index) => (index % 2 === 1 ? segment : replaceValue(segment, value)))
      .join("");
  }
  return scrubbed;
}

/**
 * Whether `text` contains `value` where {@link scrubPrivateValues} would scrub it: a word-like value
 * as a whole word, any other value anywhere.
 */
export function mentionsPrivateValue(text: string, value: string): boolean {
  return value.length > 0 && replaceValue(text, value) !== text;
}

/** The string leaves of resolved private values worth scrubbing, longest first, de-duplicated. */
export function scrubbablePrivateValues(values: Iterable<unknown>): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= MIN_SCRUBBED_PRIVATE_VALUE_CHARS) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  for (const value of values) visit(value);
  return [...found].sort((left, right) => right.length - left.length);
}
