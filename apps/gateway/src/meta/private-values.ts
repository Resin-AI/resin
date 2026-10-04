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

/**
 * The text with every occurrence of each value replaced by {@link SCRUBBED_PRIVATE_VALUE}. `values`
 * must be longest first, so a value containing another is replaced whole.
 */
export function scrubPrivateValues(text: string, values: readonly string[]): string {
  let scrubbed = text;
  for (const value of values) {
    if (scrubbed.includes(value)) scrubbed = scrubbed.split(value).join(SCRUBBED_PRIVATE_VALUE);
  }
  return scrubbed;
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
