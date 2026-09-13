import {
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parseJavaScriptComputation } from "../../../src/analytics/computation/javascript.js";

type ProgramNode = ComputationProgramV1["nodes"][number];
type CallNode = Extract<ProgramNode, { kind: "call" }>;

function strictProgram(source: string): ComputationProgramV1 {
  const program = parseJavaScriptComputation(source).program;
  const parsed = ComputationProgramV1Schema.safeParse(program);
  if (!parsed.success) {
    throw new Error(
      `program did not validate: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | ")}`,
    );
  }
  return parsed.data;
}

function timestampNaNProgram(value: string): ComputationProgramV1 {
  return strictProgram(
    [
      "function hasInvalidTimestamp(input) {",
      "  return Number.isNaN(Date.parse(input));",
      "}",
      `console.log(hasInvalidTimestamp(${JSON.stringify(value)}));`,
    ].join("\n"),
  );
}

function timestampFiniteProgram(value: string): ComputationProgramV1 {
  return strictProgram(
    [
      "function hasFiniteTimestamp(input) {",
      "  return Number.isFinite(Date.parse(input));",
      "}",
      `console.log(hasFiniteTimestamp(${JSON.stringify(value)}));`,
    ].join("\n"),
  );
}

function calls(program: ComputationProgramV1): CallNode[] {
  return program.nodes.filter((node): node is CallNode => node.kind === "call");
}

function apiCalls(program: ComputationProgramV1): string[] {
  return calls(program)
    .map((node) => node.api)
    .filter((api): api is string => api !== undefined);
}

describe("native JavaScript Number.isNaN capture", () => {
  it("represents direct Number.isNaN(Date.parse(input)) as a complete finite static call", () => {
    const program = timestampNaNProgram("not-a-timestamp");

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(apiCalls(program)).toEqual(
      expect.arrayContaining(["clock.parse", "number.is_nan", "core.print"]),
    );
    const predicate = calls(program).find((node) => node.api === "number.is_nan");
    expect(predicate).toMatchObject({ kind: "call", api: "number.is_nan" });
    expect(predicate?.children).toHaveLength(1);
  });

  it("keeps Number.isNaN distinct from Number.isFinite", () => {
    const nan = timestampNaNProgram("not-a-timestamp");
    const finite = timestampFiniteProgram("not-a-timestamp");

    expect(apiCalls(nan)).toContain("number.is_nan");
    expect(apiCalls(nan)).not.toContain("number.is_finite");
    expect(apiCalls(finite)).toContain("number.is_finite");
    expect(apiCalls(finite)).not.toContain("number.is_nan");
    expect(computeComputationProgramDigest(nan)).not.toBe(computeComputationProgramDigest(finite));
  });

  it("keeps timestamp values private and canonicalizes value-only changes", () => {
    const first = timestampNaNProgram("first-private-value");
    const second = timestampNaNProgram("second-private-value");

    expect(JSON.stringify(first)).not.toContain("first-private-value");
    expect(JSON.stringify(second)).not.toContain("second-private-value");
    expect(computeComputationProgramDigest(first)).toBe(computeComputationProgramDigest(second));
  });

  it("fails closed for the global coercing isNaN function", () => {
    const program = strictProgram(
      [
        "function hasInvalidTimestamp(input) {",
        "  return isNaN(Date.parse(input));",
        "}",
        'console.log(hasInvalidTimestamp("not-a-timestamp"));',
      ].join("\n"),
    );

    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_hidden_state");
    expect(apiCalls(program)).not.toContain("number.is_nan");
  });

  it.each([
    {
      name: "shadowed Number",
      source: [
        "const Number = { isNaN(value) { return value; } };",
        'console.log(Number.isNaN(Date.parse("not-a-timestamp")));',
      ].join("\n"),
    },
    {
      name: "imported Number",
      source: [
        'import Number from "opaque-number";',
        'console.log(Number.isNaN(Date.parse("not-a-timestamp")));',
      ].join("\n"),
    },
    {
      name: "opaque Number",
      source: ["class Number {}", 'console.log(Number.isNaN(Date.parse("not-a-timestamp")));'].join(
        "\n",
      ),
    },
    {
      name: "similarly named receiver",
      source: 'console.log(Numbers.isNaN(Date.parse("not-a-timestamp")));',
    },
    {
      name: "similarly named static API",
      source: 'console.log(Number.isNan(Date.parse("not-a-timestamp")));',
    },
    {
      name: "arbitrary instance method",
      source: [
        "const checker = { isNaN(value) { return value; } };",
        'console.log(checker.isNaN(Date.parse("not-a-timestamp")));',
      ].join("\n"),
    },
  ])("does not treat $name as intrinsic Number.isNaN", ({ source }) => {
    const program = strictProgram(source);

    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons.length).toBeGreaterThan(0);
    expect(apiCalls(program)).not.toContain("number.is_nan");
  });
});
