/**
 * @resin/observer - Bounded Native Computation Source Analysis
 *
 * Public entry for the computation-evidence pipeline: strict, analysis-only source understanding.
 * Language visitors parse Python/JavaScript/TypeScript into private recursive drafts, `builder`
 * assigns every canonical wire id and drops every unsafe string, `source-frames` frames observed
 * source without executing it, and the observer-only recorder commits evidence only for observed
 * successful calls. Nothing in this module reads disk, spawns a process, executes captured code or
 * grants runtime authority; every captured program is untrusted data.
 */

import { parseJavaScriptComputation } from "./javascript.js";
import { parsePythonComputation } from "./python.js";
import type { ComputationParseResult, ComputationParseSourceInput } from "./types.js";

// Private draft model, parser-local records and source framing
export * from "./types.js";

// Canonical-id assignment, draft factories and bounded program construction
export * from "./builder.js";

// Source framing from normalized events (no execution, no traversal)
export * from "./source-frames.js";

// Language visitors and their finite API vocabularies
export * from "./python.js";
export * from "./python-api.js";
export * from "./javascript.js";
export * from "./javascript-api.js";

// Observer-only recorder: causal call/result matching and bounded kernel state
export * from "./recorder.js";

/**
 * Pinned public parser entry: `parseComputationSource({language, source, context?})`.
 *
 * Python goes to the Python visitor; JavaScript and TypeScript share the JS/TS visitor, which also
 * uses the language tag for its TypeScript-only lowering. Callers never branch on language
 * themselves, and an unknown dialect is rejected by the visitors rather than guessed.
 */
export function parseComputationSource(input: ComputationParseSourceInput): ComputationParseResult {
  const { language, source, context } = input;
  if (language === "python") {
    return parsePythonComputation(source, context);
  }
  return parseJavaScriptComputation(source, context, language);
}
