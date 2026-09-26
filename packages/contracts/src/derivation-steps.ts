/**
 * Derivation steps: small model-written Python programs that compute, from a learned tool's caller
 * inputs, values a recorded program had hard-coded (an account type, a category code, a band).
 *
 * A derivation is the only place a plan may carry program source that no recording produced. It is
 * never trusted by construction: the local validator accepts a binding to its output only after the
 * derivation, run in the replay sandbox, reproduces every recorded value it claims to compute, and
 * refuses a derivation that merely hard-codes a recorded value or reads no input.
 *
 * The derivation receives its inputs through one header line, `inputs = {"<name>": <literal>, ...}`,
 * whose value literals are program-token holes bound to caller inputs. Its result is the JSON of its
 * final expression, which must be an object; bindings read it by `[<name>]`.
 */

import { tokenizeProgram } from "./program-tokens.js";
import type { WorkflowJsonValue } from "./recorded-workflow.js";

/** The runtime family a derivation step runs in: an ordinary program interpreter. */
export const WORKFLOW_DERIVATION_RUNTIME = "resin-program";

/** The name of the Python variable a derivation reads its inputs from. */
export const WORKFLOW_DERIVATION_INPUTS_VARIABLE = "inputs";

export interface DerivationHeaderInput {
  name: string;
  value: WorkflowJsonValue;
}

/** One Python literal token for a scalar value; structures cannot be a single bindable token. */
function pythonLiteral(name: string, value: WorkflowJsonValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`derivation input '${name}' must be a finite number`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  throw new Error(`derivation input '${name}' must be a string, number, boolean or null`);
}

/**
 * The first line of a derivation's source: `inputs = {"<name>": <python literal>, ...}\n`.
 *
 * Each value renders as exactly one bindable Python literal token, so a hole can bind it to the
 * caller input of the same name (see `derivationInputTokenIndexes`).
 */
export function derivationHeader(inputs: ReadonlyArray<DerivationHeaderInput>): string {
  const seen = new Set<string>();
  const entries = inputs.map(({ name, value }) => {
    if (name.length === 0) throw new Error("a derivation input needs a non-empty name");
    if (seen.has(name)) throw new Error(`duplicate derivation input '${name}'`);
    seen.add(name);
    return `${JSON.stringify(name)}: ${pythonLiteral(name, value)}`;
  });
  return `${WORKFLOW_DERIVATION_INPUTS_VARIABLE} = {${entries.join(", ")}}\n`;
}

/**
 * The top-level token index of each named input's value literal in a derivation's header line, in
 * the order of `names`. Throws when the source does not start with a well-formed header, or when a
 * name is missing or repeated, so a hole is never placed on a token that is not the input's value.
 */
export function derivationInputTokenIndexes(source: string, names: readonly string[]): number[] {
  const lineEnd = source.indexOf("\n");
  const headerEnd = lineEnd < 0 ? source.length : lineEnd;
  const tokens = tokenizeProgram("python", source);
  const header = tokens.filter((token) => token.end <= headerEnd);
  const first = header[0];
  if (
    first === undefined ||
    first.kind !== "word" ||
    first.raw !== WORKFLOW_DERIVATION_INPUTS_VARIABLE ||
    first.start !== 0 ||
    (header.length - 1) % 2 !== 0
  ) {
    throw new Error("the derivation source does not start with an inputs header");
  }
  const positions = new Map<string, number>();
  for (let index = 1; index < header.length; index += 2) {
    const key = header[index]!;
    const value = header[index + 1]!;
    if (key.kind !== "string" || typeof key.value !== "string" || !value.bindable) {
      throw new Error("the derivation inputs header is not a flat object of literal values");
    }
    if (positions.has(key.value)) {
      throw new Error(`the derivation inputs header repeats '${key.value}'`);
    }
    positions.set(key.value, index + 1);
  }
  return names.map((name) => {
    const position = positions.get(name);
    if (position === undefined) {
      throw new Error(`the derivation inputs header has no input '${name}'`);
    }
    return position;
  });
}
