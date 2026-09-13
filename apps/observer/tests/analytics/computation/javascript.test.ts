import {
  COMPUTATION_IR_LIMITS,
  COMPUTATION_UNSAFE_FIELD_KEYS,
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationEvidenceDigest,
  computeComputationProgramDigest,
  readComputationEvidence,
} from "@resin/contracts";
import {
  type ComputationFixtureFamily,
  type ComputationFixtureVariant,
  SHARED_RECORD_IO_HELPER_SOURCE,
  buildComputationFixtureFamilies,
  collectOmpFixtureToolCalls,
} from "@resin/test-fixtures";
import { describe, expect, it } from "vitest";
import { parseComputationSource } from "../../../src/analytics/computation/index.js";
import type {
  ComputationParseContext,
  ComputationParseResult,
} from "../../../src/analytics/computation/types.js";

/**
 * The JavaScript/TypeScript visitor is exercised against the REAL synthetic fixture sources: the
 * record-schema-order validator plus the shared record-I/O helper module it imports, and the
 * cpu-pss definition/use eval cells. Nothing here re-derives expectations from the fixtures' own
 * labels: every expectation is a structural property of the emitted program (strict schema validity,
 * the materialized def/use closure, privacy, fail-closed reductions) read back from the actual
 * parsed source text.
 */

// ============================================================================
// Fixture source extraction
// ============================================================================

function familyById(familyId: string): ComputationFixtureFamily {
  const family = buildComputationFixtureFamilies().find((entry) => entry.familyId === familyId);
  if (family === undefined) {
    throw new Error(`fixture family '${familyId}' is missing`);
  }
  if (family.language !== "javascript") {
    throw new Error(`fixture family '${familyId}' is not a JavaScript family`);
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

/** The exact content a fixture session wrote to `path`, located by its own recorded path suffix. */
function writtenFile(variant: ComputationFixtureVariant, pathSuffix: string): string {
  for (const call of collectOmpFixtureToolCalls(variant.records)) {
    const args = call.toolArguments;
    if (call.toolName === "write" && "path" in args && args.path.endsWith(pathSuffix)) {
      return args.content;
    }
  }
  throw new Error(`no fixture write of '${pathSuffix}'`);
}

/** One fixture eval cell, located by a fragment of its own code. */
function evalCell(variant: ComputationFixtureVariant, needle: string): string {
  for (const call of collectOmpFixtureToolCalls(variant.records)) {
    const args = call.toolArguments;
    if (call.toolName === "eval" && "code" in args && args.code.includes(needle)) {
      return args.code;
    }
  }
  throw new Error(`no fixture eval cell contains '${needle}'`);
}

const schemaOrderVariant = primaryVariant(familyById("record-schema-order"));
const VALIDATOR_SOURCE = writtenFile(schemaOrderVariant, "validate-records.mjs");
const HELPER_MODULE_SOURCE = writtenFile(schemaOrderVariant, "record-io.mjs");
const CANARY = familyById("record-schema-order").canaries[0] ?? "";

/** Observed provenance the recorder attaches to a helper it inlines out of its private caches. */
const HELPER_SOURCE_EVENT_ID = "evt_fixture_record_io";
const HELPER_DIGEST = "0123456789abcdef".repeat(4);

const cpuPssFamily = familyById("cpu-pss-delta");
/** The definition/use variant holds the eval cells; the file variant holds the authored script. */
const cpuPssCellVariant = primaryVariant(cpuPssFamily);
const CPU_PSS_DEFINITION_CELL = evalCell(cpuPssCellVariant, "computeSnapshotDelta");
const CPU_PSS_USE_CELL = evalCell(cpuPssCellVariant, "computeSnapshotDelta(DATASET)");

const cpuPssScriptVariant = (() => {
  const variant = cpuPssFamily.variants[1];
  if (variant === undefined) {
    throw new Error("cpu-pss-delta has no authored-file variant");
  }
  return variant;
})();
const CPU_PSS_SCRIPT_SOURCE = writtenFile(cpuPssScriptVariant, "snapshot-delta.mjs");
const CPU_PSS_HELPER_MODULE = {
  path: "tools/record-io.mjs",
  source: writtenFile(cpuPssScriptVariant, "record-io.mjs"),
  language: "javascript" as const,
  sourceEventId: HELPER_SOURCE_EVENT_ID,
  programDigest: HELPER_DIGEST,
};

// ============================================================================
// Parse and assertion helpers
// ============================================================================

function parseJs(
  source: string,
  context?: ComputationParseContext,
  language: "javascript" | "typescript" = "javascript",
): ComputationParseResult {
  return parseComputationSource({ language, source, context });
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

type ProgramNode = ComputationProgramV1["nodes"][number];
type NodeOfKind<K extends ProgramNode["kind"]> = Extract<ProgramNode, { kind: K }>;

function nodesOfKind<K extends ProgramNode["kind"]>(
  program: ComputationProgramV1,
  kind: K,
): NodeOfKind<K>[] {
  return program.nodes.filter((node): node is NodeOfKind<K> => node.kind === kind);
}

function nodesById(program: ComputationProgramV1): Map<string, ProgramNode> {
  return new Map(program.nodes.map((node) => [node.id, node]));
}

function bindingNames(result: ComputationParseResult): string[] {
  return (result.local.definitionBindings ?? []).map((binding) => binding.name);
}

function definitionNamed(result: ComputationParseResult, name: string) {
  const binding = (result.local.definitionBindings ?? []).find((entry) => entry.name === name);
  if (binding === undefined) {
    throw new Error(`definition '${name}' was not materialized`);
  }
  const definition = result.program.definitions.find((entry) => entry.id === binding.definitionId);
  if (definition === undefined) {
    throw new Error(`definition id '${binding.definitionId}' is not in the program`);
  }
  return definition;
}

function helperDefinitions(source: string) {
  return parseJs(source).local.definitions;
}

function apiCalls(program: ComputationProgramV1): string[] {
  return nodesOfKind(program, "call")
    .map((node) => node.api)
    .filter((api): api is string => api !== undefined);
}

/** The contract's own unsafe-field normalization, applied to an emitted structural field key. */
const UNSAFE_FIELD_KEY_LOOKUP: ReadonlySet<string> = new Set(COMPUTATION_UNSAFE_FIELD_KEYS);

function isUnsafeFieldKey(key: string): boolean {
  return UNSAFE_FIELD_KEY_LOOKUP.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// ============================================================================
// Real fixture frames
// ============================================================================

describe("JavaScript visitor over the record-schema-order fixture frames", () => {
  const context: ComputationParseContext = {
    modules: [
      {
        path: "tools/record-io.mjs",
        source: HELPER_MODULE_SOURCE,
        language: "javascript",
        sourceEventId: HELPER_SOURCE_EVENT_ID,
        programDigest: HELPER_DIGEST,
      },
    ],
    sourcePath: "tools/validate-records.mjs",
  };

  it("parses the authored validator and its imported helper module into one complete program", () => {
    expect(VALIDATOR_SOURCE.length).toBeGreaterThan(0);
    const result = parseJs(VALIDATOR_SOURCE, context);
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(nodesOfKind(program, "unsupported")).toEqual([]);
    expect(result.local.hasInvocation).toBe(true);

    // The authored frame reports only its own definitions and imports; the helpers arrive through the
    // module cache, so they can never be mistaken for authored work.
    expect(result.local.definitions.map((definition) => definition.name)).toEqual([
      "isValidIsoTimestamp",
      "validateRecords",
    ]);
    expect(result.local.imports).toEqual([
      { names: ["readFileSync"], source: "node:fs" },
      { names: ["parseRecordArray", "stableStringify"], source: "./record-io.mjs" },
    ]);
  });

  it("materializes the whole reachable helper closure with its observed provenance", () => {
    const result = parseJs(VALIDATOR_SOURCE, context);
    const program = expectStrictProgram(result);

    expect(bindingNames(result).sort()).toEqual([
      "isValidIsoTimestamp",
      "parseJsonText",
      "parseRecordArray",
      "stableStringify",
      "validateRecords",
    ]);
    for (const binding of result.local.definitionBindings ?? []) {
      if (binding.name === "isValidIsoTimestamp" || binding.name === "validateRecords") {
        // Authored in this frame: the recorder attributes these to the current observation itself.
        expect(binding.sourceEventId).toBeUndefined();
        expect(binding.programDigest).toBeUndefined();
      } else {
        expect(binding.sourceEventId).toBe(HELPER_SOURCE_EVENT_ID);
        expect(binding.programDigest).toBe(HELPER_DIGEST);
      }
    }

    // The regex literal stays a compiled pattern and its `.test` call a finite regex API.
    const apis = apiCalls(program);
    expect(apis).toContain("text.regex_compile");
    expect(apis).toContain("text.regex_test");
  });

  it("resolves the direct and mutually reachable helper dependencies of the inlined module", () => {
    const result = parseJs(VALIDATOR_SOURCE, context);
    const program = expectStrictProgram(result);

    // `stableStringify` recurses through the `map` callback it passes itself to, so it must reach
    // itself through its materialized dependencies rather than look like hidden state.
    const recursiveHelper = definitionNamed(result, "stableStringify");
    expect(recursiveHelper.recursive).toBe(true);
    expect(recursiveHelper.dependencies).toContain(recursiveHelper.nameSymbol);
    expect(recursiveHelper.complete).toBe(true);

    // `parseRecordArray` delegates to `parseJsonText`: a real def/use edge, not a guessed one.
    const caller = definitionNamed(result, "parseRecordArray");
    const callee = definitionNamed(result, "parseJsonText");
    expect(caller.dependencies).toContain(callee.nameSymbol);
    expect(caller.recursive).toBe(false);
    expect(callee.recursive).toBe(false);
  });

  it("fails closed when the imported helper module was never observed", () => {
    const result = parseJs(VALIDATOR_SOURCE, { sourcePath: "tools/validate-records.mjs" });
    const program = expectStrictProgram(result);

    // The import is known but its body is not: the call is an unsupported API, never an invented
    // helper body and never a data slot standing in for a function.
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_api");
    expect(nodesOfKind(program, "unsupported").length).toBeGreaterThan(0);
    expect(bindingNames(result)).toEqual(["isValidIsoTimestamp", "validateRecords"]);
  });

  it("inlines only the dependency-reachable helper closure of an observed module", () => {
    // The observed module holds a shared top-level constant, a reachable callable that reads it and
    // an unreachable callable that reads it too. Only the reached closure may enter the program, and
    // the reached callable needs its unit's own declaration to stay self-contained.
    const observedModule = {
      path: "tools/limits.mjs",
      source: [
        "const LIMIT = 5;",
        "export function keeper(value) {",
        "  return value < LIMIT;",
        "}",
        "export function unused(value) {",
        "  return value > LIMIT;",
        "}",
      ].join("\n"),
      language: "javascript" as const,
      sourceEventId: "evt_fixture_limits",
      programDigest: HELPER_DIGEST,
    };

    const reached = parseJs('import { keeper } from "./limits.mjs";\nconsole.log(keeper(1));', {
      modules: [observedModule],
      sourcePath: "tools/run.mjs",
    });
    const reachedProgram = expectStrictProgram(reached);
    expect(reachedProgram.complete).toBe(true);
    expect(reachedProgram.unsupportedReasons).toEqual([]);
    expect(bindingNames(reached)).toEqual(["keeper"]);

    // The unreachable callable contributes no node, no symbol and no slot at all.
    const unreached = parseJs('import { unused } from "./limits.mjs";\nconsole.log(1);', {
      modules: [observedModule],
      sourcePath: "tools/run.mjs",
    });
    const unreachedProgram = expectStrictProgram(unreached);
    expect(unreachedProgram.complete).toBe(true);
    expect(bindingNames(unreached)).toEqual([]);
    expect(unreachedProgram.definitions).toEqual([]);
    expect(unreachedProgram.nodes.length).toBeLessThan(reachedProgram.nodes.length);
  });
});

describe("JavaScript visitor fail-closed boundaries", () => {
  it("keeps an aliased helper materialized while refusing to guess the dispatch", () => {
    const definitions = helperDefinitions(SHARED_RECORD_IO_HELPER_SOURCE);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "parseJsonText",
      "parseRecordArray",
      "stableStringify",
    ]);

    const result = parseJs("const walk = stableStringify;\nconsole.log(walk({ a: 1 }));", {
      definitions,
    });
    const program = expectStrictProgram(result);

    // Reading the helper through the local alias still records the definition read, so the helper is
    // materialized instead of dangling as an orphaned symbol.
    expect(bindingNames(result)).toContain("stableStringify");
    // Calling through a mutable-dispatch local is dynamic and stays unsupported.
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_mutable_capture");
  });

  it("reduces an unresolved callable and an unresolved input to explicit, distinct shapes", () => {
    const called = parseJs("helper(DATASET);");
    const calledProgram = expectStrictProgram(called);
    expect(calledProgram.complete).toBe(false);
    expect(calledProgram.unsupportedReasons).toContain("unsupported_hidden_state");
    // `helper` is never a free-variable call: the callee is not guessed from an unresolved name.
    expect(nodesOfKind(calledProgram, "call").length).toBe(0);

    // A cross-frame data input stays a typed, valueless slot rather than a literal payload.
    const read = parseJs("const records = unknownRecords;");
    const readProgram = expectStrictProgram(read);
    const freeSlots = nodesOfKind(readProgram, "literal")
      .map((node) => node.slot)
      .filter((slot): slot is string => slot !== undefined)
      .map((slotId) => readProgram.slots.find((slot) => slot.id === slotId));
    expect(freeSlots.length).toBeGreaterThan(0);
    for (const slot of freeSlots) {
      expect(slot?.role).toBe("free_variable");
      expect(slot?.kind).toBe("unknown");
    }
    expect(nodesOfKind(readProgram, "unsupported")).toEqual([]);
  });

  it("lowers a C-style loop to an explicit while with the update last, and refuses continue", () => {
    const result = parseJs(
      [
        "let total = 0;",
        "for (let index = 1; index < 5; index += 1) {",
        "  total += index;",
        "}",
        "console.log(total);",
      ].join("\n"),
    );
    const program = expectStrictProgram(result);
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);

    const loop = nodesOfKind(program, "while")[0];
    expect(loop).toBeDefined();
    const byId = nodesById(program);
    const body = byId.get(loop?.children[1] ?? "");
    if (body === undefined || body.kind !== "block") {
      throw new Error("expected the lowered loop to own a block body");
    }
    const update = byId.get(body.children[body.children.length - 1] ?? "");
    if (update === undefined || update.kind !== "assign") {
      throw new Error("expected the loop body to end with its update assignment");
    }
    expect(update.operator).toBe("add");

    // `continue` would skip that trailing update, so the whole loop fails closed instead.
    const skipped = parseJs(
      [
        "let total = 0;",
        "for (let index = 1; index < 5; index += 1) {",
        "  if (index === 3) {",
        "    continue;",
        "  }",
        "  total += index;",
        "}",
      ].join("\n"),
    );
    const skippedProgram = expectStrictProgram(skipped);
    expect(skippedProgram.complete).toBe(false);
    expect(skippedProgram.unsupportedReasons).toContain("unsupported_construct");
    expect(nodesOfKind(skippedProgram, "while")).toEqual([]);
  });

  it("refuses dynamic module loading and mutable callable dispatch", () => {
    const result = parseJs(
      ["let handler = () => {};", 'import("./remote.mjs");', "handler();"].join("\n"),
    );
    const program = expectStrictProgram(result);

    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toContain("unsupported_api");
    expect(program.unsupportedReasons).toContain("unsupported_mutable_capture");
    // A dynamic load can rebind session state, which the recorder must see as an invalidation.
    expect(result.local.invalidatesState).toBe(true);
    expect(result.local.hasInvocation).toBe(true);
  });

  it("keeps one declaration site when a callable name is re-declared", () => {
    const result = parseJs(
      [
        "function f(a) { return a + 1; }",
        "function f(a) { return a + 2; }",
        "console.log(f(1));",
      ].join("\n"),
    );
    const program = expectStrictProgram(result);

    // The first binding stays authoritative and the redefinition is recorded as an invalidation; the
    // second body fails closed instead of appending a second parameter/body pair to the same node.
    expect(result.local.invalidatesState).toBe(true);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toEqual(["unsupported_construct"]);
    expect(program.definitions).toHaveLength(1);
    expect(program.definitions[0]?.parameters).toHaveLength(1);

    // The call still resolves to the surviving definition rather than becoming an orphaned symbol.
    const call = nodesOfKind(program, "call").find((node) => node.symbol !== undefined);
    expect(call?.symbol).toBe(program.definitions[0]?.nameSymbol);
    expect(program.roots.length).toBeGreaterThan(0);
  });

  it("fails a frame larger than the pinned source cap with a bounded incomplete program", () => {
    const oversized = "const value = 0;\n".repeat(17_000);
    expect(oversized.length).toBeGreaterThan(262_144);

    const result = parseJs(oversized);
    const program = expectStrictProgram(result);
    expect(program.complete).toBe(false);
    expect(program.unsupportedReasons).toEqual(["limit_serialized_bytes"]);
    // Bounded fallback: one unsupported root, never a truncated prefix presented as complete.
    expect(nodesOfKind(program, "unsupported").length).toBe(1);
    expect(program.nodes.length).toBeLessThanOrEqual(4);
    expect(program.definitions).toEqual([]);
  });

  it("keeps unsafe object keys and literal payloads off the wire", () => {
    const result = parseJs(
      [
        `const secret = "${CANARY}";`,
        "const payload = { authToken: secret, prompt: secret, apiKey: secret, safeCount: 3 };",
        "console.log(payload.safeCount);",
      ].join("\n"),
    );
    const program = expectStrictProgram(result);
    const serialized = JSON.stringify(program);

    expect(CANARY.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(CANARY);
    for (const unsafe of ["authToken", "auth_token", "prompt", "apiKey", "api_key"]) {
      expect(serialized).not.toContain(unsafe);
    }

    const pairs = nodesOfKind(program, "pair");
    expect(pairs.length).toBe(4);
    for (const pair of pairs) {
      expect(pair.field === undefined || !isUnsafeFieldKey(pair.field)).toBe(true);
    }
    // The three unsafe keys became structural slots; only the safe key stayed a field name.
    expect(
      pairs.filter((pair) => pair.fieldSlot !== undefined && pair.field === undefined),
    ).toHaveLength(3);
    expect(pairs.filter((pair) => pair.field === "safeCount")).toHaveLength(1);
  });
});

describe("TypeScript and real eval-cell frames", () => {
  it("accepts TypeScript annotations under the typescript language tag", () => {
    const result = parseJs(
      [
        "type Row = { readonly id: string };",
        "interface Summary { readonly count: number }",
        "function summarize(records: readonly Row[]): number {",
        "  const total: number = records.length;",
        "  return total;",
        "}",
        "const extra = 0;",
        "console.log(summarize([]) + extra);",
      ].join("\n"),
      undefined,
      "typescript",
    );
    const program = expectStrictProgram(result);

    expect(program.language).toBe("typescript");
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    // Type-only statements author no runtime computation and never become definitions.
    expect(result.local.definitions.map((definition) => definition.name)).toEqual(["summarize"]);
    const definition = definitionNamed(result, "summarize");
    expect(definition.kind).toBe("function");
    expect(definition.parameters).toHaveLength(1);
  });

  it("materializes the observed cpu-pss helper closure for a later use cell", () => {
    const definitions = helperDefinitions(CPU_PSS_DEFINITION_CELL);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "parseJsonText",
      "parseRecordArray",
      "stableStringify",
      "normalizeExecutable",
      "computeSnapshotDelta",
    ]);

    const result = parseJs(CPU_PSS_USE_CELL, { definitions });
    const program = expectStrictProgram(result);

    expect(result.local.hasInvocation).toBe(true);
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(program.outputs.length).toBeGreaterThan(0);
    expect(bindingNames(result)).toContain("computeSnapshotDelta");
    expect(bindingNames(result)).toContain("normalizeExecutable");
    // The use cell reports only its own authored definitions; the helpers came from the cache.
    expect(result.local.definitions).toEqual([]);
  });

  it("keeps the complete CPU/PSS closure inside the bounded evidence envelope", () => {
    // A complete real closure must fit without deleting computation or dependency structure.
    const result = parseJs(CPU_PSS_SCRIPT_SOURCE, {
      modules: [CPU_PSS_HELPER_MODULE],
      sourcePath: "tools/snapshot-delta.mjs",
    });
    const program = expectStrictProgram(result);
    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(bindingNames(result)).toContain("computeSnapshotDelta");

    const programBytes = Buffer.byteLength(JSON.stringify(program));
    const envelope = {
      version: "1.0.0" as const,
      program,
      programDigest: computeComputationProgramDigest(program),
      origin: {
        kind: "referenced_file" as const,
        sourceEventId: "evt_fixture_snapshot_delta",
        pathPattern: "tools/*.mjs",
      },
      observation: {
        callId: "call-cpu-pss-pair-c-run",
        callEventId: "evt_fixture_snapshot_delta",
        kind: "invocation" as const,
        status: "success" as const,
        resultEventId: "evt_fixture_snapshot_delta_result",
      },
      dependencies: [],
      corrections: [],
      metrics: {
        sourceLines: 120,
        sourceBytes: CPU_PSS_SCRIPT_SOURCE.length,
        nodeCount: program.nodes.length,
        symbolCount: program.symbols.length,
        slotCount: program.slots.length,
        definitionCount: program.definitions.length,
      },
      analysisOnly: true as const,
    };
    const carrier = { evidenceId: computeComputationEvidenceDigest(envelope), ...envelope };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(carrier));

    expect(envelopeBytes).toBeGreaterThan(programBytes);
    expect(envelopeBytes).toBeLessThanOrEqual(COMPUTATION_IR_LIMITS.serializedBytes);
    expect(readComputationEvidence(carrier)).toBeDefined();
  });
});
