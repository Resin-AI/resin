import {
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parsePythonComputation } from "../../../src/analytics/computation/python.js";

function parse(source: string): ComputationProgramV1 {
  const result = parsePythonComputation(source);
  const parsed = ComputationProgramV1Schema.safeParse(result.program);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return parsed.data;
}

function digest(source: string): string {
  const program = parse(source);
  expect(program.complete).toBe(true);
  return computeComputationProgramDigest(program);
}

function calls(program: ComputationProgramV1) {
  return program.nodes.filter((node) => node.kind === "call");
}

describe("Python implicit tuple assignment capture", () => {
  it("treats bare multi-target and multi-RHS assignment like explicit tuple syntax", () => {
    expect(digest("a, b = [], []")).toBe(digest("(a, b) = ([], [])"));
    expect(digest("(a, b) = [], []")).toBe(digest("(a, b) = ([], [])"));
  });

  it("captures one-target implicit RHS tuples, including singleton trailing commas", () => {
    expect(digest("value = [], []")).toBe(digest("value = ([], [])"));
    expect(digest("value = [],")).toBe(digest("value = ([],)"));
  });

  it("preserves singleton target tuple syntax instead of scalar assignment", () => {
    expect(digest("a, = value")).toBe(digest("(a,) = value"));
  });

  it("ignores comments without introducing tuple grouping", () => {
    expect(digest("value = 1 # comment")).toBe(digest("value = 1"));
    expect(digest("value = [], # comment")).toBe(digest("value = ([],)"));
  });

  it("preserves nested tuple boundaries instead of flattening nested groups", () => {
    expect(digest("value = ([], []), []")).toBe(digest("value = (([], []), [])"));
    expect(digest("left, right = ([], []), []")).toBe(digest("(left, right) = (([], []), [])"));
  });

  it("records declarations and reads for implicit destructuring targets", () => {
    const program = parse(["a, b = [], []", "print(a)", "print(b)"].join("\n"));
    expect(program.complete).toBe(true);
    expect(program.symbols.filter((symbol) => symbol.kind === "local")).toHaveLength(2);

    const locals = new Set(
      program.symbols.filter((symbol) => symbol.kind === "local").map((symbol) => symbol.id),
    );
    const localReads = program.nodes.filter((node) => {
      if (node.kind !== "identifier" || !("symbol" in node)) {
        return false;
      }
      return locals.has(node.symbol);
    });
    expect(localReads).toHaveLength(2);
  });

  it("evaluates an implicit tuple RHS call once", () => {
    const program = parse(["def pair():", "    return [], []", "", "a, b = pair()"].join("\n"));
    expect(program.complete).toBe(true);
    expect(calls(program).filter((node) => "symbol" in node)).toHaveLength(1);
  });

  it("keeps starred and ambiguous destructuring fail-closed", () => {
    const starred = parse("a, *b = [], []");
    expect(starred.complete).toBe(false);
    expect(starred.unsupportedReasons).toContain("unsupported_construct");

    const doubleComma = parse("a,, b = [], []");
    expect(doubleComma.complete).toBe(false);
  });

  it("preserves chain-assignment grouping while allowing implicit tuple values", () => {
    const implicit = parse("a = b = [], []");
    const explicit = parse("a = b = ([], [])");
    expect(implicit.complete).toBe(true);
    expect(explicit.complete).toBe(true);
    expect(computeComputationProgramDigest(implicit)).toBe(
      computeComputationProgramDigest(explicit),
    );
    expect(implicit.nodes.filter((node) => node.kind === "assign")).toHaveLength(2);
  });
});
