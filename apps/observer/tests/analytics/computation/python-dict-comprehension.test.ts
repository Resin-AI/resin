import { type ComputationProgramV1, ComputationProgramV1Schema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parsePythonComputation } from "../../../src/analytics/computation/python.js";
import type { ComputationParseResult } from "../../../src/analytics/computation/types.js";

function expectStrictProgram(result: ComputationParseResult): ComputationProgramV1 {
  const parsed = ComputationProgramV1Schema.safeParse(result.program);
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

function serialized(program: ComputationProgramV1): string {
  return JSON.stringify(program);
}

function nodesById(
  program: ComputationProgramV1,
): Map<string, ComputationProgramV1["nodes"][number]> {
  return new Map(program.nodes.map((node) => [node.id, node]));
}

function nodeDescendants(
  program: ComputationProgramV1,
  nodeId: string,
): ComputationProgramV1["nodes"][number][] {
  const byId = nodesById(program);
  const root = byId.get(nodeId);
  const descendants: ComputationProgramV1["nodes"][number][] = [];
  const visit = (node: ComputationProgramV1["nodes"][number] | undefined): void => {
    if (node === undefined) {
      return;
    }
    descendants.push(node);
    const linkedIds = [
      ...node.children,
      ...("receiver" in node && typeof node.receiver === "string" ? [node.receiver] : []),
      ...("keywordArgs" in node && Array.isArray(node.keywordArgs)
        ? node.keywordArgs.map((entry) => entry.value)
        : []),
    ];
    for (const childId of linkedIds) {
      visit(byId.get(childId));
    }
  };
  visit(root);
  return descendants;
}

function firstComprehension(
  program: ComputationProgramV1,
  compKind: "dict" | "generator" | "list" | "set",
): ComputationProgramV1["nodes"][number] {
  const node = program.nodes.find(
    (entry) => entry.kind === "comprehension" && "compKind" in entry && entry.compKind === compKind,
  );
  if (node === undefined) {
    throw new Error(`missing ${compKind} comprehension`);
  }
  return node;
}

function firstDictComprehension(
  program: ComputationProgramV1,
): ComputationProgramV1["nodes"][number] {
  return firstComprehension(program, "dict");
}

function childNode(
  program: ComputationProgramV1,
  parent: ComputationProgramV1["nodes"][number],
  index: number,
): ComputationProgramV1["nodes"][number] {
  const id = parent.children[index];
  const node = id === undefined ? undefined : nodesById(program).get(id);
  if (node === undefined) {
    throw new Error(`missing child ${index} for ${parent.id}`);
  }
  return node;
}

function requiredSymbol(node: ComputationProgramV1["nodes"][number]): string {
  if (!("symbol" in node) || typeof node.symbol !== "string") {
    throw new Error(`${node.kind} node ${node.id} has no symbol`);
  }
  return node.symbol;
}

function descendantSymbols(program: ComputationProgramV1, nodeId: string): string[] {
  return nodeDescendants(program, nodeId)
    .filter((node) => node.kind === "identifier")
    .map((node) => node.symbol);
}

describe("Python dict comprehension capture", () => {
  it("captures an owner-keyed computed dict comprehension as strict key/value dataflow", () => {
    const source = [
      "def by_owner(owners):",
      '    return {owner.get("ownerId"): owner.get("teamId") for owner in owners}',
      "",
      "print(by_owner(_OWNERS))",
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const comprehension = firstDictComprehension(program);
    const element = childNode(program, comprehension, 0);
    const key = childNode(program, element, 0);
    const value = childNode(program, element, 1);
    const forClause = childNode(program, comprehension, 1);
    const target = childNode(program, forClause, 0);
    const targetSymbol = requiredSymbol(target);

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(element.kind).toBe("tuple");
    expect(key.kind).toBe("call");
    expect(value.kind).toBe("call");
    expect(nodeDescendants(program, key.id)).toContainEqual(
      expect.objectContaining({ kind: "identifier", symbol: targetSymbol }),
    );
    expect(nodeDescendants(program, value.id)).toContainEqual(
      expect.objectContaining({ kind: "identifier", symbol: targetSymbol }),
    );
    expect(serialized(program)).not.toContain("unsupported_dynamic_key");
    expect(serialized(program)).not.toContain(JSON.stringify("owner"));
    expect(serialized(program)).not.toContain("ownerId");
    expect(serialized(program)).not.toContain("teamId");
  });

  it("captures a team-keyed computed dict comprehension without promoting keys to fields", () => {
    const source = [
      "def by_team(teams):",
      '    return {team.get("teamId"): team.get("score") for team in teams}',
      "",
      "print(by_team(_TEAMS))",
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const element = childNode(program, firstDictComprehension(program), 0);

    expect(program.complete).toBe(true);
    expect(element.kind).toBe("tuple");
    expect("field" in element).toBe(false);
    expect("fieldSlot" in element).toBe(false);
    expect(program.nodes.filter((node) => node.kind === "pair")).toHaveLength(0);
    expect(serialized(program)).not.toContain("teamId");
  });

  it("keeps static string dict-comprehension keys on the existing pair representation", () => {
    const source = [
      "def keyed(rows):",
      '    return {"kind": row.get("kind") for row in rows}',
      "",
      "print(keyed(_ROWS))",
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const element = childNode(program, firstDictComprehension(program), 0);

    expect(program.complete).toBe(true);
    expect(element).toMatchObject({ kind: "pair", field: "kind" });
  });

  it("predeclares comprehension targets so computed keys use the shadowing target", () => {
    const source = [
      'row = "outer"',
      'print({row.get("id"): row.get("value") for row in _ROWS})',
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const comprehension = firstDictComprehension(program);
    const element = childNode(program, comprehension, 0);
    const key = childNode(program, element, 0);
    const forClause = childNode(program, comprehension, 1);
    const target = childNode(program, forClause, 0);
    const targetSymbol = requiredSymbol(target);

    expect(program.complete).toBe(true);
    expect(nodeDescendants(program, key.id)).toContainEqual(
      expect.objectContaining({ kind: "identifier", symbol: targetSymbol }),
    );
    expect(program.symbols.filter((symbol) => symbol.kind === "local")).toHaveLength(2);
    expect(serialized(program)).not.toContain("outer");
  });

  it("keeps the leftmost iterable in enclosing scope when the target name shadows it", () => {
    const source = ["row = _ROWS", 'print({row.get("id"): row for row in row})'].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const comprehension = firstDictComprehension(program);
    const element = childNode(program, comprehension, 0);
    const key = childNode(program, element, 0);
    const forClause = childNode(program, comprehension, 1);
    const target = childNode(program, forClause, 0);
    const iterable = childNode(program, forClause, 1);
    const outer = program.nodes.find((node) => node.kind === "assign");
    if (outer === undefined) {
      throw new Error("missing outer assignment");
    }
    const outerSymbol = requiredSymbol(childNode(program, outer, 0));
    const targetSymbol = requiredSymbol(target);

    expect(program.complete).toBe(true);
    expect(targetSymbol).toBeDefined();
    expect(outerSymbol).toBeDefined();
    expect(targetSymbol).not.toBe(outerSymbol);
    expect(descendantSymbols(program, iterable.id)).toContain(outerSymbol);
    expect(descendantSymbols(program, key.id)).toContain(targetSymbol);
    expect(descendantSymbols(program, key.id)).not.toContain(outerSymbol);
  });

  it("applies the same shadow policy to generator arguments with ordered nested clauses", () => {
    const source = [
      "def values(rows):",
      '    return sum(pair.get("value") for row in rows for pair in row.get("pairs") if pair.get("ok"))',
      "",
      "print(values(_ROWS))",
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const comprehension = firstComprehension(program, "generator");
    const element = childNode(program, comprehension, 0);
    const rowClause = childNode(program, comprehension, 1);
    const pairClause = childNode(program, comprehension, 2);
    const ifClause = childNode(program, comprehension, 3);
    const rowTarget = childNode(program, rowClause, 0);
    const pairTarget = childNode(program, pairClause, 0);
    const rowIterable = childNode(program, rowClause, 1);
    const pairIterable = childNode(program, pairClause, 1);
    const ifTest = childNode(program, ifClause, 0);
    const rowSymbol = requiredSymbol(rowTarget);
    const pairSymbol = requiredSymbol(pairTarget);

    expect(program.complete).toBe(true);
    expect(comprehension.children.map((id) => nodesById(program).get(id)?.kind)).toEqual([
      "call",
      "for_clause",
      "for_clause",
      "if_clause",
    ]);
    expect(descendantSymbols(program, rowIterable.id)).not.toContain(rowSymbol);
    expect(descendantSymbols(program, pairIterable.id)).toContain(rowSymbol);
    expect(descendantSymbols(program, pairIterable.id)).not.toContain(pairSymbol);
    expect(descendantSymbols(program, ifTest.id)).toContain(pairSymbol);
    expect(descendantSymbols(program, element.id)).toContain(pairSymbol);
  });

  it("keeps future clause targets in comprehension scope instead of capturing outers", () => {
    const source = [
      "pair = _OUTER_PAIR",
      'print(sum(pair.get("value") for row in _ROWS for pair in pair.get("items")))',
    ].join("\n");
    const program = expectStrictProgram(parsePythonComputation(source));
    const comprehension = firstComprehension(program, "generator");
    const element = childNode(program, comprehension, 0);
    const pairClause = childNode(program, comprehension, 2);
    const pairTarget = childNode(program, pairClause, 0);
    const pairIterable = childNode(program, pairClause, 1);
    const outer = program.nodes.find((node) => node.kind === "assign");
    if (outer === undefined) {
      throw new Error("missing outer assignment");
    }
    const outerSymbol = requiredSymbol(childNode(program, outer, 0));
    const pairSymbol = requiredSymbol(pairTarget);

    expect(program.complete).toBe(true);
    expect(pairSymbol).not.toBe(outerSymbol);
    expect(descendantSymbols(program, pairIterable.id)).toContain(pairSymbol);
    expect(descendantSymbols(program, pairIterable.id)).not.toContain(outerSymbol);
    expect(descendantSymbols(program, element.id)).toContain(pairSymbol);
  });

  it("still rejects plain dynamic-key object literals and unresolved key functions", () => {
    const literalProgram = expectStrictProgram(
      parsePythonComputation('print({record.get("id"): 1})'),
    );
    const unresolvedProgram = expectStrictProgram(
      parsePythonComputation("print({compute_key(row): row for row in _ROWS})"),
    );

    expect(literalProgram.complete).toBe(false);
    expect(literalProgram.unsupportedReasons).toContain("unsupported_dynamic_key");
    expect(unresolvedProgram.complete).toBe(false);
    expect(unresolvedProgram.unsupportedReasons).toContain("unsupported_hidden_state");
    expect(serialized(unresolvedProgram)).not.toContain("compute_key");
  });
  it("binds a parenthesized tuple comprehension target in the element scope", () => {
    const program = expectStrictProgram(
      parsePythonComputation(
        "def pair_sums(pairs):\n    return [left + right for (left, right) in pairs]\n\nprint(pair_sums(_PAIRS))",
      ),
    );
    const comprehension = firstComprehension(program, "list");
    const element = childNode(program, comprehension, 0);
    const clause = childNode(program, comprehension, 1);
    const target = childNode(program, clause, 0);
    const iterable = childNode(program, clause, 1);
    const targetSymbols = descendantSymbols(program, target.id);
    const elementSymbols = descendantSymbols(program, element.id);
    const iterableSymbols = descendantSymbols(program, iterable.id);

    expect(program.complete).toBe(true);
    expect(targetSymbols).toHaveLength(2);
    expect(elementSymbols).toEqual(expect.arrayContaining(targetSymbols));
    expect(iterableSymbols).toContain(requiredSymbol(iterable));
    expect(iterableSymbols).not.toEqual(expect.arrayContaining(targetSymbols));
  });
});
