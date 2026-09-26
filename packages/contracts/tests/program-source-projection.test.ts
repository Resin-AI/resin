import { describe, expect, it } from "vitest";
import {
  ProgramSourceProjectionError,
  analyzeProgramSourceProjection,
} from "../src/program-source-projection.js";
import { ProgramTokenizationError, tokenizeProgram } from "../src/program-tokens.js";

describe("analyzeProgramSourceProjection", () => {
  it("aligns canonical tokens across offset shifts and returns original spans", () => {
    const original = 'const value = "secret-value"; call(value);';
    const redacted = 'const value = "[REDACTED]"; call(value);';
    const originalTokens = tokenizeProgram("javascript", original);
    const protectedIndex = originalTokens.findIndex((token) => token.raw === '"secret-value"');
    const projection = analyzeProgramSourceProjection("javascript", original, redacted, [
      protectedIndex,
    ]);

    expect(projection.protectedTokens).toEqual([protectedIndex]);
    expect(projection.tokens[protectedIndex]?.raw).toBe('"secret-value"');
    const callIndex = originalTokens.findIndex((token) => token.raw === "call");
    expect(projection.tokens[callIndex]?.start).toBe(original.indexOf("call"));
    expect(projection.tokens[callIndex]?.start).not.toBe(redacted.indexOf("call"));
  });

  it("projects a shell command whose secret flag value was redacted in place", () => {
    const original = "curl -H 'Authorization: Bearer sk-live-abc123' https://x/y --out data/a.json";
    const redacted =
      "curl -H 'Authorization: Bearer [REDACTED_KEY:ab12]' https://x/y --out data/a.json";
    const projection = analyzeProgramSourceProjection("shell", original, redacted);
    expect(projection.protectedTokens).toEqual([2]);
    expect(projection.tokens[2]?.raw).toBe("'Authorization: Bearer sk-live-abc123'");
    expect(projection.tokens[5]?.raw).toBe("data/a.json");
  });

  it("rejects a shell redaction that splits, merges, or reshapes words", () => {
    for (const redacted of [
      "deploy --token [REDACTED] now extra",
      "deploy --token now",
      "deploy --token 'REDACTED' now",
      "deploy --token $SECRET now",
    ]) {
      expect(() =>
        analyzeProgramSourceProjection("shell", "deploy --token abc123 now", redacted),
      ).toThrow(ProgramSourceProjectionError);
    }
    expect(() =>
      analyzeProgramSourceProjection(
        "shell",
        "cat <<EOF\nkey=abc123\nEOF",
        "cat <<EOF\nkey=[REDACTED KEY]\nEOF",
      ),
    ).toThrow(ProgramSourceProjectionError);
  });

  it("rejects token-count, token-kind, bindability, and quote-boundary changes", () => {
    expect(() =>
      analyzeProgramSourceProjection(
        "javascript",
        "const value = 1;",
        "const value = 1; const other = 2;",
      ),
    ).toThrow(ProgramSourceProjectionError);
    expect(() =>
      analyzeProgramSourceProjection("javascript", 'const value = "secret";', "const value = 42;"),
    ).toThrow(ProgramSourceProjectionError);
    expect(() =>
      analyzeProgramSourceProjection(
        "typescript",
        'let value: "secret";',
        'let value = "REDACTED";',
      ),
    ).toThrow(ProgramSourceProjectionError);
    expect(() =>
      analyzeProgramSourceProjection(
        "javascript",
        'const value = "secret";',
        "const value = 'REDACTED';",
      ),
    ).toThrow(ProgramSourceProjectionError);
  });

  it("rejects removed, added, and out-of-range expected protections", () => {
    const original = 'const value = "SECRET";';
    const redacted = 'const value = "REDACTED";';
    const protectedIndex = tokenizeProgram("javascript", original).findIndex(
      (token) => token.kind === "string",
    );
    expect(() => analyzeProgramSourceProjection("javascript", original, redacted, [])).toThrow(
      ProgramSourceProjectionError,
    );
    expect(() =>
      analyzeProgramSourceProjection("javascript", original, redacted, [
        protectedIndex,
        protectedIndex + 1,
      ]),
    ).toThrow(ProgramSourceProjectionError);
    expect(() => analyzeProgramSourceProjection("javascript", original, redacted, [99])).toThrow(
      ProgramSourceProjectionError,
    );
  });

  it("propagates canonical parse failures without converting them to projection mismatches", () => {
    expect(() =>
      analyzeProgramSourceProjection("javascript", "const value = 1;", "const = 1;"),
    ).toThrow(ProgramTokenizationError);
  });
});
