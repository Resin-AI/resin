import { type ProgramLanguage, type ProgramToken, tokenizeProgram } from "./program-tokens.js";

export class ProgramSourceProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramSourceProjectionError";
  }
}

function sameTokenShape(original: ProgramToken, redacted: ProgramToken): boolean {
  return (
    original.kind === redacted.kind &&
    original.bindable === redacted.bindable &&
    original.quote === redacted.quote
  );
}

/**
 * Align a redacted program projection against its local original by canonical token order.
 * Offsets are intentionally ignored: redaction may change token lengths and shift later spans.
 */
export function analyzeProgramSourceProjection(
  language: ProgramLanguage,
  originalSource: string,
  redactedSource: string,
  expectedProtectedTokens?: readonly number[],
): { tokens: ProgramToken[]; protectedTokens: number[] } {
  if (language === "shell") {
    throw new ProgramSourceProjectionError("shell program source projections are not supported");
  }
  const tokens = tokenizeProgram(language, originalSource);
  const redactedTokens = tokenizeProgram(language, redactedSource);
  if (tokens.length !== redactedTokens.length) {
    throw new ProgramSourceProjectionError(
      "redacted program projection changed the canonical token count",
    );
  }

  const protectedTokens: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const original = tokens[index]!;
    const redacted = redactedTokens[index]!;
    if (!sameTokenShape(original, redacted)) {
      throw new ProgramSourceProjectionError(
        `redacted program projection changed token ${index} shape`,
      );
    }
    if (original.raw !== redacted.raw) protectedTokens.push(index);
  }

  const expectedMatches =
    expectedProtectedTokens === undefined ||
    (Array.isArray(expectedProtectedTokens) &&
      expectedProtectedTokens.length === protectedTokens.length &&
      expectedProtectedTokens.every((token, index) => token === protectedTokens[index]));
  if (!expectedMatches) {
    throw new ProgramSourceProjectionError(
      "redacted program projection protected-token indexes do not match",
    );
  }
  return { tokens, protectedTokens };
}
