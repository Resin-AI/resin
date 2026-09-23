import {
  COMPUTATION_APIS,
  COMPUTATION_TRANSFORM_APIS,
  COMPUTATION_TRANSFORM_NODE_KINDS,
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
} from "@resin/contracts";
import {
  type ComputationFixtureFamily,
  type ComputationFixtureVariant,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
} from "@resin/test-fixtures";
import { describe, expect, it } from "vitest";
import { parsePythonComputation } from "../../../src/analytics/computation/python.js";
import type {
  ComputationParseResult,
  LocalComputationDefinition,
} from "../../../src/analytics/computation/types.js";

/**
 * The Python visitor is exercised against the REAL synthetic fixture sources: the `record-join-lineage`
 * definition/use/corrected-cells and the `process-snapshot-ownership` helper cell and authored script.
 * Nothing here re-derives expected output from the fixtures' own labels: every expectation is a
 * structural property of the emitted program (strict schema validity, materialized closure,
 * privacy, fail-closed reductions) checked against the actual parsed source text.
 */

// ============================================================================
// Fixture source extraction
// ============================================================================

function familyById(familyId: string): ComputationFixtureFamily {
  const family = buildComputationFixtureFamilies().find((entry) => entry.familyId === familyId);
  if (family === undefined) {
    throw new Error(`fixture family '${familyId}' is missing`);
  }
  if (family.language !== "python") {
    throw new Error(`fixture family '${familyId}' is not a Python family`);
  }
  return family;
}

function primaryVariant(family: ComputationFixtureFamily): ComputationFixtureVariant {
  const variant = family.variants[0];
  if (variant === undefined) {
    throw new Error(`fixture family '${family.familyId}' has no variant`);
  }
  return variant;
}

/** Every Python code cell the fixture session actually ran, in transcript order. */
function pythonCodeCells(variant: ComputationFixtureVariant): { callId: string; code: string }[] {
  const cells: { callId: string; code: string }[] = [];
  for (const call of collectOmpFixtureToolCalls(variant.records)) {
    const args = call.toolArguments;
    if (call.toolName === "eval" && "code" in args && args.language === "python") {
      cells.push({ callId: call.callId, code: args.code });
    }
  }
  return cells;
}

function cellContaining(
  cells: { callId: string; code: string }[],
  needle: string,
): { callId: string; code: string } {
  const cell = cells.find((entry) => entry.code.includes(needle));
  if (cell === undefined) {
    throw new Error(`no fixture cell contains '${needle}'`);
  }
  return cell;
}

/**
 * The authored script body of the file-write-then-execute variant.
 *
 * The fixture names the file after the script it writes, so the script is located by its own module
 * guard rather than by a hardcoded path.
 */
function authoredScript(family: ComputationFixtureFamily): string {
  for (const variant of family.variants) {
    for (const dataset of variant.datasets) {
      for (const file of Object.values(dataset.expected.runnable.files)) {
        if (file.includes('if __name__ == "__main__":')) {
          return file;
        }
      }
    }
  }
  throw new Error(`family '${family.familyId}' has no authored script`);
}

// ============================================================================
// Parse and assertion helpers
// ============================================================================

function parse(source: string, context?: Parameters<typeof parsePythonComputation>[1]) {
  return parsePythonComputation(source, context);
}

/** Every program this visitor emits must pass the strict wire contract, cross-references included. */
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

function definitionNames(result: ComputationParseResult): string[] {
  return (result.local.definitionBindings ?? []).map((binding) => binding.name);
}

function unsupportedCodes(program: ComputationProgramV1): string[] {
  return [...program.unsupportedReasons];
}

function countNodes(
  program: ComputationProgramV1,
  predicate: (node: ComputationProgramV1["nodes"][number]) => boolean,
): number {
  return program.nodes.filter(predicate).length;
}

/** Minimum structural condition for review: a complete program with a real transform and an output. */
function hasTransform(program: ComputationProgramV1): boolean {
  return program.nodes.some(
    (node) =>
      (COMPUTATION_TRANSFORM_NODE_KINDS as readonly string[]).includes(node.kind) ||
      (node.kind === "call" &&
        node.api !== undefined &&
        (COMPUTATION_TRANSFORM_APIS as readonly string[]).includes(node.api)),
  );
}

function contextDefinitionsOf(result: ComputationParseResult): LocalComputationDefinition[] {
  return result.local.definitions;
}

const joinFamily = familyById("record-join-lineage");
const joinVariant = primaryVariant(joinFamily);
const joinCells = pythonCodeCells(joinVariant);
const joinV1 = joinVariant.supersededDefinitionSource ?? "";
const joinV2 = cellContaining(joinCells, "missingParents").code;
const joinUseA = cellContaining(joinCells, '"records"').code;
const joinUseB =
  [...joinCells].reverse().find((cell) => cell.code.includes('"owners"'))?.code ?? "";

const ownershipFamily = familyById("process-snapshot-ownership");

// ============================================================================
// Real fixture frames
// ============================================================================

describe("Python visitor over the record-join fixture frames", () => {
  it("parses the first-pass definition frame into a strict program with one definition", () => {
    expect(joinV1.length).toBeGreaterThan(0);
    const result = parse(joinV1);
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(program.definitions).toHaveLength(1);
    expect(definitionNames(result)).toEqual(["join_records"]);
    expect(result.local.hasInvocation).toBe(false);
    expect(result.local.definitions).toHaveLength(1);
    expect(result.local.definitions[0]?.name).toBe("join_records");
    expect(hasTransform(program)).toBe(true);
  });

  it("turns the use cell into a substantive program by inlining the observed helper closure", () => {
    const definitionFrame = parse(joinV1);
    const result = parse(joinUseA, { definitions: contextDefinitionsOf(definitionFrame) });
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(result.local.hasInvocation).toBe(true);
    expect(program.outputs.length).toBeGreaterThan(0);
    expect(hasTransform(program)).toBe(true);

    // The use cell authors `_emit` and reaches the observed `join_records` helper; both materialize.
    expect(definitionNames(result).sort()).toEqual(["_emit", "join_records"]);
    const bindings = result.local.definitionBindings ?? [];
    for (const binding of bindings) {
      expect(binding.definitionId).toMatch(/^def[0-9]+$/);
      // A helper inlined out of the parse context carries no current-frame provenance.
      expect(binding.sourceEventId).toBeUndefined();
      expect(binding.programDigest).toBeUndefined();
    }
    // The use cell's own definitions are reported separately, without the context helper.
    expect(result.local.definitions.map((definition) => definition.name)).toEqual(["_emit"]);
  });

  it("keeps the inlined closure structurally distinguishable from the corrected helper", () => {
    const v1 = parse(joinV1);
    const v2 = parse(joinV2);
    const firstPass = parse(joinUseA, { definitions: contextDefinitionsOf(v1) });
    const corrected = parse(joinUseA, { definitions: contextDefinitionsOf(v2) });

    expectStrictProgram(firstPass);
    expectStrictProgram(corrected);
    expect(computeComputationProgramDigest(firstPass.program)).not.toBe(
      computeComputationProgramDigest(corrected.program),
    );

    // Only the corrected helper reports the three missing links and the two exclusion lists, and the
    // safe structural field names survive as fields rather than as retained string values.
    expect(serialized(corrected.program)).toContain("missingTeams");
    expect(serialized(corrected.program)).not.toContain("missingTeams".replace("Teams", "OwnersX"));
    expect(serialized(firstPass.program)).not.toContain("missingTeams");

    // Both use cells parse the same way, so the corrected helper alone changes the identity.
    const useBFirst = parse(joinUseB, { definitions: contextDefinitionsOf(v1) });
    const useBCorrected = parse(joinUseB, { definitions: contextDefinitionsOf(v2) });
    expect(computeComputationProgramDigest(useBFirst.program)).not.toBe(
      computeComputationProgramDigest(useBCorrected.program),
    );
  });

  it("reports a known helper correction as an explicit write, not unknown kernel mutation", () => {
    const firstPass = parse(joinV1);
    expect(parse(joinV1).local.invalidatesState).toBe(false);

    const rebinding = parse(joinV2, { definitions: contextDefinitionsOf(firstPass) });
    expect(rebinding.local.invalidatesState).toBe(false);
    expect(rebinding.local.writtenNames).toContain("join_records");
    expectStrictProgram(rebinding);

    const fresh = parse(joinV2);
    expect(fresh.local.invalidatesState).toBe(false);
    expect(fresh.local.writtenNames).toEqual(
      expect.arrayContaining(["CHILD_KINDS", "REVISION_KINDS", "join_records"]),
    );
  });

  it("never puts a raw name, payload or canary from the fixture into the wire program", () => {
    const definitionFrame = parse(joinV1);
    const result = parse(joinUseA, { definitions: contextDefinitionsOf(definitionFrame) });
    const text = serialized(expectStrictProgram(result));

    for (const canary of joinFamily.canaries) {
      expect(text).not.toContain(canary);
    }
    // The dataset payload is embedded in the use-cell source; its value must not survive.
    expect(text).not.toContain("r-1001");
    expect(text).not.toContain("own-404");
    // Authored identifiers, including the helper and the accumulator locals, stay local.
    for (const name of ["join_records", "_emit", "_DATA", "by_owner", "missing_owners", "_json"]) {
      expect(text).not.toContain(name);
    }
    // Raw import spellings never reach the wire; only the canonical API vocabulary may.
    expect(text).not.toContain("_json");
    expect(text).not.toContain("loads");
    expect(text).not.toContain("dumps");
  });

  it("selects only the dependency-reachable closure and never an unused cached helper", () => {
    const usedSource = ["def used(row):", '    return row["usedField"] + 1', ""].join("\n");
    const unusedSource = ["def unused(row):", '    return row["unusedField"] - 1', ""].join("\n");
    const cell = 'print(used(_DATA["rows"]))';
    const result = parse(cell, {
      definitions: [
        { name: "used", references: ["row"], source: usedSource, writtenNames: [] },
        { name: "unused", references: ["row"], source: unusedSource, writtenNames: [] },
      ],
    });
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(definitionNames(result)).toEqual(["used"]);
    expect(serialized(program)).toContain("usedField");
    expect(serialized(program)).not.toContain("unusedField");
  });

  it("reports the originating provenance of a helper materialized from the private caches", () => {
    const source = ["def scale(row, factor):", '    return row["weight"] * factor', ""].join("\n");
    const digest = "a".repeat(64);
    const result = parse('print(scale(_DATA["rows"], 3))', {
      definitions: [
        {
          name: "scale",
          programDigest: digest,
          references: ["row", "factor"],
          source,
          sourceEventId: "evt-helper-def",
          writtenNames: [],
        },
      ],
    });
    expectStrictProgram(result);
    const bindings = result.local.definitionBindings ?? [];
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      name: "scale",
      programDigest: digest,
      sourceEventId: "evt-helper-def",
    });
  });

  it("resolves an observed from-import callable with private module provenance", () => {
    const digest = "b".repeat(64);
    const result = parse("from imported_helper import imported_helper\nprint(imported_helper(2))", {
      modules: [
        {
          language: "python",
          path: "imported_helper.py",
          programDigest: digest,
          source: "def imported_helper(value):\n    return value + 1\n",
          sourceEventId: "evt-imported-helper",
        },
      ],
    });
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(result.local.hasInvocation).toBe(true);
    expect(result.local.imports).toEqual([
      {
        names: ["imported_helper"],
        source: "from imported_helper import imported_helper",
      },
    ]);
    expect(result.local.definitionBindings).toEqual([
      {
        definitionId: "def0",
        name: "imported_helper",
        programDigest: digest,
        sourceEventId: "evt-imported-helper",
      },
    ]);
  });

  it("resolves an observed module-member callable but fails closed for unobserved imports", () => {
    const observed = parse("import imported_helper\nprint(imported_helper.imported_helper(2))", {
      modules: [
        {
          language: "python",
          path: "imported_helper.py",
          source: "def imported_helper(value):\n    return value + 1\n",
          sourceEventId: "evt-module-member",
        },
      ],
    });
    expect(expectStrictProgram(observed).complete).toBe(true);
    expect(definitionNames(observed)).toEqual(["imported_helper"]);
    expect(observed.local.definitionBindings?.[0]).toMatchObject({
      sourceEventId: "evt-module-member",
    });

    const unknown = parse("from missing_helper import imported_helper\nprint(imported_helper(2))");
    const program = expectStrictProgram(unknown);
    expect(program.complete).toBe(false);
    expect(unsupportedCodes(program)).toContain("unsupported_api");
    expect(unknown.local.definitionBindings).toEqual([]);
  });

  it("reuses persistent from-import observations with aliases when later resolving helpers", () => {
    const importOnly = parse("from imported_helper import imported_helper as ih");
    expect(importOnly.local.imports).toEqual([
      {
        names: ["ih"],
        source: "from imported_helper import imported_helper as ih",
      },
    ]);

    const result = parse("print(run(2))", {
      definitions: [
        {
          name: "run",
          references: ["ih", "value"],
          source: "def run(value):\n    return ih(value)\n",
          writtenNames: [],
        },
      ],
      imports: importOnly.local.imports,
      modules: [
        {
          language: "python",
          path: "imported_helper.py",
          source: "def imported_helper(value):\n    return value + 1\n",
        },
      ],
    });
    const program = expectStrictProgram(result);
    expect(program.complete).toBe(true);
    expect(definitionNames(result).sort()).toEqual(["imported_helper", "run"]);
  });

  it("lets a local binding shadow an observed imported callable", () => {
    const result = parse(
      [
        "from imported_helper import imported_helper",
        "imported_helper = 1",
        "print(imported_helper(2))",
      ].join("\n"),
      {
        modules: [
          {
            language: "python",
            path: "imported_helper.py",
            source: "def imported_helper(value):\n    return value + 1\n",
          },
        ],
      },
    );
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(false);
    expect(unsupportedCodes(program)).toContain("unsupported_api");
    expect(result.local.definitionBindings).toEqual([]);
  });

  it("marks top-level assignment calls as invocations without inventing an output", () => {
    const result = parse("value = int(2)");
    const program = expectStrictProgram(result);

    expect(result.local.hasInvocation).toBe(true);
    expect(program.complete).toBe(true);
    expect(program.outputs).toEqual([]);
  });
});

// ============================================================================
// Def/use analysis: recursion, callbacks, accumulators
// ============================================================================

describe("Python visitor def/use analysis", () => {
  it("materializes direct and mutual recursion with honest reachability", () => {
    const source = [
      "def is_even(n):",
      "    return True if n == 0 else is_odd(n - 1)",
      "",
      "def is_odd(n):",
      "    return False if n == 0 else is_even(n - 1)",
      "",
      "print(is_even(_DEPTH))",
    ].join("\n");
    const program = expectStrictProgram(parse(source));

    expect(program.complete).toBe(true);
    expect(program.definitions).toHaveLength(2);

    // Each helper reaches itself through the other one, which is what makes both recursive.
    const nameSymbols = program.definitions.map((definition) => definition.nameSymbol);
    expect(new Set(nameSymbols).size).toBe(2);
    for (const definition of program.definitions) {
      expect(definition.recursive).toBe(true);
      const other = nameSymbols.find((symbol) => symbol !== definition.nameSymbol);
      expect(definition.dependencies).toContain(other);
    }
    // Two recursive edges plus the module invocation are all resolved definition calls.
    expect(countNodes(program, (node) => node.kind === "call" && "symbol" in node)).toBe(3);
  });

  it("keeps an inline-lambda callback read inside the enclosing definition's closure", () => {
    const source = [
      "def apply_all(rows):",
      '    return sorted(rows, key=lambda row: normalize(row["weight"]))',
      "",
      "def normalize(value):",
      "    return round(value, 2)",
      "",
      "print(apply_all(_ROWS))",
    ].join("\n");
    const program = expectStrictProgram(parse(source));

    expect(program.complete).toBe(true);
    const apply = program.definitions[0];
    const normalize = program.definitions[1];
    expect(apply?.dependencies).toContain(normalize?.nameSymbol);
    // The call inside the lambda is a resolved definition call, not dynamic dispatch.
    expect(countNodes(program, (node) => node.kind === "call")).toBeGreaterThan(0);
    expect(countNodes(program, (node) => node.kind === "lambda")).toBe(1);
  });

  it("keeps one stable symbol across a lexical binding and its accumulator updates", () => {
    const source = [
      "def tally(rows):",
      "    counts = {}",
      "    for row in rows:",
      '        counts[row["kind"]] = counts.get(row["kind"], 0) + 1',
      "    return counts",
      "",
      "print(tally(_ROWS))",
    ].join("\n");
    const program = expectStrictProgram(parse(source));

    expect(program.complete).toBe(true);
    // `counts` and the loop variable `row` are the only locals; the update never invents a new one.
    expect(program.symbols.filter((symbol) => symbol.kind === "local")).toHaveLength(2);
    expect(program.symbols.filter((symbol) => symbol.kind === "parameter")).toHaveLength(1);

    const nodeById = new Map(program.nodes.map((node) => [node.id, node]));
    const symbolOf = (id: string | undefined): string | undefined => {
      const node = id === undefined ? undefined : nodeById.get(id);
      return node !== undefined && node.kind === "identifier"
        ? (node as { symbol: string }).symbol
        : undefined;
    };
    // The first binding declares the accumulator; the later store targets it through the same
    // symbol (the subscript's base identifier), so an update never invents a new variable.
    const directTargets = program.nodes
      .filter((node) => node.kind === "assign")
      .map((node) => symbolOf(node.children[0]))
      .filter((symbol): symbol is string => symbol !== undefined);
    const accumulated = program.nodes
      .filter((node) => node.kind === "assign")
      .map((node) => nodeById.get(node.children[0]))
      .filter((target): target is NonNullable<typeof target> => target?.kind === "index")
      .map((index) => symbolOf(index.children[0]))
      .filter((symbol): symbol is string => symbol !== undefined);
    expect(directTargets).toHaveLength(1);
    expect(accumulated).toHaveLength(1);
    expect(directTargets).toContain(accumulated[0]);
  });
});

// ============================================================================
// Fail-closed reductions
// ============================================================================

describe("Python visitor fail-closed reductions", () => {
  const cases: { code: string; expected: string; name: string }[] = [
    {
      code: 'print(helper(_DATA["rows"]))',
      expected: "unsupported_hidden_state",
      name: "an unresolved callable is hidden state",
    },
    {
      code: "print(record.mystery())",
      expected: "unsupported_api",
      name: "an unknown method is not guessed",
    },
    {
      code: 'print(getattr(record, "weight"))',
      expected: "unsupported_reflection",
      name: "reflection is never a finite API",
    },
    {
      code: "print({compute_key(record): 1})",
      expected: "unsupported_dynamic_key",
      name: "a dynamic mapping key cannot be structural",
    },
  ];

  for (const entry of cases) {
    it(`${entry.name} (${entry.expected})`, () => {
      const result = parse(entry.code);
      const program = expectStrictProgram(result);
      expect(program.complete).toBe(false);
      expect(unsupportedCodes(program)).toContain(entry.expected);
    });
  }

  it("merges a mapping spread as data without retaining any entry", () => {
    // `{**record}` is a data-level merge, not a call: the spread keeps its finite shape while every
    // unresolved entry stays an anonymous slot.
    const spread = expectStrictProgram(parse('print({**record, "kind": 1})'));
    expect(spread.complete).toBe(true);
    expect(countNodes(spread, (node) => node.kind === "spread")).toBe(1);
    expect(spread.slots.some((slot) => slot.role === "free_variable")).toBe(true);
    expect(serialized(spread)).not.toContain("record");
  });

  it("fails closed on a deleted binding, an unrepresentable global and a class body", () => {
    const deleted = expectStrictProgram(parse("del _CACHE"));
    expect(deleted.complete).toBe(false);
    expect(unsupportedCodes(deleted)).toContain("unsupported_hidden_state");

    const globalWrite = expectStrictProgram(
      parse(["def bump():", "    global _TOTAL", "    _TOTAL = _TOTAL + 1", ""].join("\n")),
    );
    expect(globalWrite.complete).toBe(false);
    expect(unsupportedCodes(globalWrite)).toContain("unsupported_mutable_capture");

    const classBody = expectStrictProgram(parse(["class Record:", "    pass", ""].join("\n")));
    expect(classBody.complete).toBe(false);
    expect(unsupportedCodes(classBody)).toContain("unsupported_construct");
  });

  it("fails closed when an indirect lambda alias is called as a helper", () => {
    const result = parse(["scale = lambda value: value * 2", "print(scale(_VALUE))"].join("\n"));
    const program = expectStrictProgram(result);
    // Indirect callables are dynamic dispatch: the callee is never resolved to a guessed definition.
    expect(program.complete).toBe(false);
    expect(unsupportedCodes(program)).toContain("unsupported_api");
    expect(serialized(program)).not.toContain("scale");
  });

  it("fails closed on a malformed, oversized or over-nested frame", () => {
    const malformed = parse("def (:\n  return\n");
    expectStrictProgram(malformed);
    expect(malformed.program.complete).toBe(false);
    expect(unsupportedCodes(malformed.program)).toContain("incomplete_parse");
    expect(malformed.local.invalidatesState).toBe(true);
    expect(malformed.local.definitions).toEqual([]);

    const oversized = `${"value = 1\n".repeat(40000)}`;
    expect(oversized.length).toBeGreaterThan(262144);
    const oversizeResult = parse(oversized);
    expectStrictProgram(oversizeResult);
    expect(oversizeResult.program.complete).toBe(false);
    expect(unsupportedCodes(oversizeResult.program)).toContain("limit_serialized_bytes");

    const nested = `${"(".repeat(200)}1${")".repeat(200)}`;
    const nestedResult = parse(`print${nested}`);
    expectStrictProgram(nestedResult);
    expect(nestedResult.program.complete).toBe(false);
    expect(unsupportedCodes(nestedResult.program)).toContain("limit_depth");
  });

  it("keeps a cross-cell datum an explicit typed free-variable slot", () => {
    const result = parse('print(_DATA["records"])');
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(program.slots).toHaveLength(1);
    expect(program.slots[0]).toMatchObject({ kind: "unknown", role: "free_variable" });
    expect(result.local.referencedNames).toContain("_DATA");
  });
});

// ============================================================================
// Privacy posture: safe fields versus field slots
// ============================================================================

describe("Python visitor field-key privacy", () => {
  it("keeps a safe structural key and turns a secret-like key into a field slot", () => {
    const result = parse('print({"kind": 1, "startToken": 2, "apiKey": 3})');
    const program = expectStrictProgram(result);
    const text = serialized(program);

    expect(text).toContain("kind");
    expect(text).not.toContain("startToken");
    expect(text).not.toContain("apiKey");
    expect(program.slots.filter((slot) => slot.role === "field_key")).toHaveLength(2);
  });

  it("rejects a secret-like keyword-argument name without leaking it", () => {
    const result = parse("print(sorted(_ROWS, api_key=lambda row: row))");
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(false);
    expect(unsupportedCodes(program)).toContain("unsupported_dynamic_key");
    expect(serialized(program)).not.toContain("api_key");
  });
});

// ============================================================================
// The synthetic ownership family (helper cell and authored script)
// ============================================================================

describe("Python visitor over the ownership fixture frames", () => {
  const variant = primaryVariant(ownershipFamily);
  const helperCell = cellContaining(pythonCodeCells(variant), "def attribute_owners").code;
  const script = authoredScript(ownershipFamily);

  it("parses the definition-only ownership cell and keeps every authored helper", () => {
    expect(COMPUTATION_APIS).toContain("string.isalpha");
    const result = parse(helperCell);
    const program = expectStrictProgram(result);

    expect(result.local.hasInvocation).toBe(false);
    expect(result.local.definitions.map((definition) => definition.name).sort()).toEqual([
      "_argv0",
      "_executable_name",
      "_fold_case",
      "_normalize_path",
      "attribute_owners",
    ]);
    expect(program.definitions.length).toBe(5);
    expect(program.complete).toBe(true);
  });

  it("parses the authored script with a resolved read-only file resource", () => {
    const result = parse(script);
    const program = expectStrictProgram(result);

    expect(result.local.hasInvocation).toBe(true);
    expect(result.local.invalidatesState).toBe(false);
    expect(program.complete).toBe(true);

    const apis = program.nodes
      .filter((node) => node.kind === "call")
      .map((node) => (node as { api?: string }).api)
      .filter((api): api is string => typeof api === "string");
    // `open(sys.argv[1], "r", ...)` is a finite read-only open, and `json.load(handle)` reads it.
    expect(apis).toContain("fs.open_read");
    expect(apis).toContain("fs.read_json");
    expect(apis).toContain("core.print");

    const text = serialized(program);
    for (const canary of ownershipFamily.canaries) {
      expect(text).not.toContain(canary);
    }
    for (const name of ["attribute_owners", "sys", "argv", "json", "handle", "snapshot"]) {
      expect(text).not.toContain(JSON.stringify(name));
    }
  });

  it("never claims a write-mode open as a read-only resource", () => {
    const result = parse(
      ['with open(_PATH, "w") as handle:', "    handle.write(1)", ""].join("\n"),
    );
    const program = expectStrictProgram(result);
    expect(program.complete).toBe(false);
    expect(unsupportedCodes(program)).toContain("unsupported_api");
    expect(serialized(program)).not.toContain("fs.open_read");
  });
});

describe("Python persistent closure bookkeeping", () => {
  it("records imported callable names without treating unsupported IR as state invalidation", () => {
    const result = parse(
      [
        "package_path = Path('fixtures/package.json')",
        "lock_data = yaml.safe_load(package_path.read_text())",
      ].join("\n"),
      {
        imports: [
          { names: ["Path"], source: "from pathlib import Path" },
          { names: ["yaml"], source: "import yaml" },
        ],
      },
    );
    expect(new Set(result.local.requiredNames)).toEqual(new Set(["Path", "yaml"]));
    expect(result.local.invalidatesState).toBe(false);
    expect(result.program.complete).toBe(false);
  });

  it("invalidates closure replay for mutable receiver calls", () => {
    const result = parse("rows.append(1)");
    expect(result.local.requiredNames).toEqual(["rows"]);
    expect(result.local.invalidatesState).toBe(true);
  });

  it("keeps read-before-write augmented assignments dependent on the prior binding", () => {
    const result = parse("rows += [1]");
    expect(result.local.requiredNames).toContain("rows");
    expect(result.local.writtenNames).toContain("rows");
  });

  it("keeps an import-and-file audit cell closed under local reads", () => {
    const setup = parse(
      [
        "import json",
        "from pathlib import Path",
        "import yaml",
        'package_path = Path("/tmp/audit-fixtures/package.json")',
        'lock_path = Path("/tmp/audit-fixtures/lock.yaml")',
        "with open(package_path) as f:",
        "    package_data = json.load(f)",
        "with open(lock_path) as f:",
        "    lock_data = yaml.safe_load(f)",
        'print("Lock keys:", list(lock_data.keys()))',
        'print("Lock overrides:", lock_data.get("overrides", {}))',
        "",
      ].join("\n"),
    );
    expect(setup.local.invalidatesState).toBe(false);
    expect(setup.local.requiredNames).toEqual([]);
    expect(setup.local.writtenNames).toEqual(
      expect.arrayContaining(["package_path", "lock_path", "package_data", "lock_data"]),
    );

    const target = parse(
      [
        "selected_packages = {}",
        "for package_key, package_info in lock_data.get('packages', {}).items():",
        "    if 'target' in package_key:",
        "        selected_packages[package_key] = package_info",
        'print("Selected packages:", len(selected_packages))',
        "for package_key in sorted(selected_packages.keys()):",
        '    print(package_key, "->", selected_packages[package_key].get("resolution", {}))',
        'print("\\nImporter dependencies:")',
        "for importer_name, importer_info in lock_data.get('importers', {}).items():",
        "    dependencies = importer_info.get('dependencies', {})",
        "    dev_dependencies = importer_info.get('devDependencies', {})",
        "    all_dependencies = {**dependencies, **dev_dependencies}",
        "    target_dependencies = {k: v for k, v in all_dependencies.items() if 'target' in k}",
        "    if target_dependencies:",
        '        print(f"Importer {importer_name}: {target_dependencies}")',
        "",
      ].join("\n"),
    );
    expect(target.local.requiredNames).toEqual(["lock_data"]);
    expect(target.local.invalidatesState).toBe(false);
  });
  it("keeps explicit stdout alongside only the final direct expression result", () => {
    const result = parse(
      "first = 1; second = 2; total = first + second; print(total); 42; 'final';",
    );
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(result.local.hasInvocation).toBe(true);
    expect(result.local.requiredNames).toEqual([]);
    expect(result.local.writtenNames).toEqual(expect.arrayContaining(["first", "second", "total"]));
    expect(program.outputs.map((output) => output.shape)).toEqual(["string", "string"]);
    expect(countNodes(program, (node) => node.kind === "call" && node.api === "core.print")).toBe(
      1,
    );
  });

  it("reports stdout rather than a prior implicit value for a final print", () => {
    const program = expectStrictProgram(parse("41; print('done')"));

    expect(program.complete).toBe(true);
    expect(program.outputs.map((output) => output.shape)).toEqual(["string"]);
    expect(countNodes(program, (node) => node.kind === "call" && node.api === "core.print")).toBe(
      1,
    );
  });

  it("retains every semicolon print across later assignment and None statements", () => {
    const program = expectStrictProgram(parse("print('first'); print(2); value = 3; None"));

    expect(program.complete).toBe(true);
    expect(program.outputs.map((output) => output.shape)).toEqual(["string", "string"]);
    expect(countNodes(program, (node) => node.kind === "call" && node.api === "core.print")).toBe(
      2,
    );
  });

  it("records loop, branch, and definition print sites with all explicit returns", () => {
    const program = expectStrictProgram(
      parse(
        [
          "for value in _VALUES:",
          "    print(value)",
          "if _FLAG:",
          "    print('branch')",
          "def announce(item):",
          "    print(item)",
          "    if item:",
          "        return",
          "    return item",
        ].join("\n"),
      ),
    );

    expect(program.complete).toBe(true);
    expect(program.outputs.map((output) => output.shape)).toEqual([
      "string",
      "string",
      "string",
      "null",
      "unknown",
    ]);
    expect(program.outputs.filter((output) => output.definitionId !== undefined)).toHaveLength(3);
    expect(countNodes(program, (node) => node.kind === "call" && node.api === "core.print")).toBe(
      3,
    );
  });

  it("does not report redirected print calls as stdout emissions", () => {
    const result = parse("print('redirected', file=_STREAM); print('visible', file=None)");
    const program = expectStrictProgram(result);

    expect(result.local.requiredNames).toEqual(["_STREAM"]);
    expect(program.outputs.map((output) => output.shape)).toEqual(["string"]);
    expect(countNodes(program, (node) => node.kind === "call" && node.api === "core.print")).toBe(
      2,
    );
  });

  it("keeps mutations of a locally constructed container within the frame", () => {
    const result = parse("rows = []; rows.append(1); print(rows)");

    expect(result.local.requiredNames).toEqual([]);
    expect(result.local.writtenNames).toContain("rows");
    expect(result.local.invalidatesState).toBe(false);
    expect(result.program.complete).toBe(true);
  });

  it("still invalidates a mutation of an externally sourced container", () => {
    const result = parse("rows = _ROWS; rows.append(1)");

    expect(result.local.requiredNames).toEqual(["_ROWS"]);
    expect(result.local.invalidatesState).toBe(true);
  });

  it("keeps imported Fraction aliases and builtin bytes out of false external slots", () => {
    const setup = parse("from fractions import Fraction as F");
    const target = parse("p = F(1, 2); print(bytes(p))", { imports: setup.local.imports });

    expect(target.local.requiredNames).toEqual(["F"]);
    expect(target.local.writtenNames).toContain("p");
    expect(target.local.invalidatesState).toBe(false);
    expect(target.program.complete).toBe(false);
    expect(unsupportedCodes(target.program)).toContain("unsupported_api");
  });

  it("distinguishes current-frame imports from inherited and not-yet-executed imports", () => {
    const authored = parse(
      "from fractions import Fraction as F\ndef make():\n    return F(1)\nprint(make())",
    );
    const setup = parse("from fractions import Fraction as F");
    const inherited = parse("def make():\n    return F(1)\nprint(make())", {
      imports: setup.local.imports,
    });
    const notYetExecuted = parse(
      "def make():\n    return F(1)\nprint(make())\nfrom fractions import Fraction as F",
    );

    expect(authored.local.requiredNames).toEqual([]);
    expect(inherited.local.requiredNames).toEqual(["F"]);
    expect(notYetExecuted.local.requiredNames).toContain("F");
    expect(authored.program.complete).toBe(false);
    expect(unsupportedCodes(authored.program)).toContain("unsupported_api");
  });
  it("captures bytes.fromhex as a finite builtin conversion without an external bytes name", () => {
    const result = parse("decoded = bytes.fromhex('00ff'); print(decoded)");
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(result.local.requiredNames).toEqual([]);
    expect(
      program.nodes
        .filter((node) => node.kind === "call")
        .map((node) => (node.kind === "call" ? node.api : undefined)),
    ).toContain("bytes.from_hex");
    expect(unsupportedCodes(program)).toEqual([]);
  });

  it("represents canonical Python builtins as values in higher-order calls", () => {
    const result = parse("print(sum(map(abs, _VALUES)))");
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(result.local.requiredNames).toEqual(["_VALUES"]);
    expect(
      program.nodes
        .filter((node) => node.kind === "api_reference")
        .map((node) => (node.kind === "api_reference" ? node.api : undefined)),
    ).toEqual(["number.abs"]);
    expect(unsupportedCodes(program)).toEqual([]);
  });

  it("binds unparenthesized tuple targets inside generator call arguments", () => {
    const result = parse(
      "total = sum(abs(left - right) for left, right in zip(_VALUES, _VALUES[1:]))",
    );
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(result.local.requiredNames).toEqual(["_VALUES"]);
    expect(unsupportedCodes(program)).toEqual([]);
    expect(
      countNodes(program, (node) => node.kind === "comprehension" && node.compKind === "generator"),
    ).toBe(1);
  });
  it("preserves builtin callable values through local aliases and respects lexical shadowing", () => {
    const aliasResult = parse("transform = abs; print(sum(map(transform, _VALUES)))");
    const aliasProgram = expectStrictProgram(aliasResult);
    const shadowResult = parse(
      "def summarize(abs, values):\n    return sum(map(abs, values))\nprint(summarize(_ABS, _VALUES))",
    );
    const shadowProgram = expectStrictProgram(shadowResult);

    expect(aliasProgram.complete).toBe(true);
    expect(
      aliasProgram.nodes.some((node) => node.kind === "api_reference" && node.api === "number.abs"),
    ).toBe(true);
    expect(aliasResult.local.requiredNames).toEqual(["_VALUES"]);
    expect(shadowProgram.complete).toBe(true);
    expect(
      shadowProgram.nodes.some(
        (node) => node.kind === "api_reference" && node.api === "number.abs",
      ),
    ).toBe(false);
    expect(shadowResult.local.requiredNames).toEqual(["_ABS", "_VALUES"]);
  });
});
