import {
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parseJavaScriptComputation } from "../../../src/analytics/computation/javascript.js";
import { parsePythonComputation } from "../../../src/analytics/computation/python.js";

function strictProgram(program: ComputationProgramV1): ComputationProgramV1 {
  expect(ComputationProgramV1Schema.safeParse(program).success).toBe(true);
  expect(program.complete).toBe(true);
  expect(program.unsupportedReasons).toEqual([]);
  return program;
}

const PYTHON_TYPES = ["str", "int", "float", "bool", "list", "tuple", "dict", "set", "object"];
const JS_TYPES = [
  "string",
  "number",
  "boolean",
  "object",
  "undefined",
  "function",
  "symbol",
  "bigint",
];

describe("intrinsic type semantics", () => {
  it.each(PYTHON_TYPES)(
    "represents the unshadowed Python %s type without an external class input",
    (name) => {
      const program = strictProgram(
        parsePythonComputation(
          `def matches(value):\n    return isinstance(value, ${name})\nprint(matches(None))\n`,
        ).program,
      );
      expect(program.nodes.some((node) => node.constant === `python_type_${name}`)).toBe(true);
      expect(program.slots.some((slot) => slot.role === "free_variable")).toBe(false);
    },
  );

  it("keeps Python type references distinct in algorithm identity", () => {
    const digests = PYTHON_TYPES.map((name) =>
      computeComputationProgramDigest(
        strictProgram(
          parsePythonComputation(
            `def check(value):\n    return isinstance(value, ${name})\nprint(check(None))\n`,
          ).program,
        ),
      ),
    );
    expect(new Set(digests).size).toBe(PYTHON_TYPES.length);
  });

  it.each(JS_TYPES)(
    "preserves the contextual typeof %s keyword in either operand order",
    (name) => {
      for (const comparison of [`(typeof value) === "${name}"`, `"${name}" !== (typeof value)`]) {
        const program = strictProgram(
          parseJavaScriptComputation(
            `function check(value) { return ${comparison}; } console.log(check(null));`,
          ).program,
        );
        expect(program.nodes.some((node) => node.constant === `type_name_${name}`)).toBe(true);
        expect(program.slots.some((slot) => slot.role === "free_variable")).toBe(false);
      }
    },
  );

  it("distinguishes type tests while masking ordinary string data", () => {
    const typed = JS_TYPES.map((name) =>
      computeComputationProgramDigest(
        strictProgram(
          parseJavaScriptComputation(
            `function check(value) { return typeof value === "${name}"; } console.log(check(null));`,
          ).program,
        ),
      ),
    );
    expect(new Set(typed).size).toBe(JS_TYPES.length);
    const ordinary = ["string", "number", "TYPE_PRIVACY_CANARY_732"].map((value) => {
      const program = strictProgram(
        parseJavaScriptComputation(`function read() { return "${value}"; } console.log(read());`)
          .program,
      );
      expect(program.nodes.some((node) => node.constant?.startsWith("type_name_"))).toBe(false);
      expect(JSON.stringify(program)).not.toContain("TYPE_PRIVACY_CANARY_732");
      return computeComputationProgramDigest(program);
    });
    expect(new Set(ordinary).size).toBe(1);
  });

  it("does not promote unknown type words or leak their values", () => {
    const program = strictProgram(
      parseJavaScriptComputation(
        'function check(value) { return typeof value === "TYPE_PRIVACY_CANARY_732"; } console.log(check(null));',
      ).program,
    );
    expect(program.nodes.some((node) => node.constant?.startsWith("type_name_"))).toBe(false);
    expect(JSON.stringify(program)).not.toContain("TYPE_PRIVACY_CANARY_732");
  });

  it("respects local shadows of Python type names and JavaScript undefined", () => {
    const python = strictProgram(
      parsePythonComputation("def read(str):\n    return str + 1\nprint(read(2))\n").program,
    );
    expect(python.nodes.some((node) => node.constant === "python_type_str")).toBe(false);
    const javascript = strictProgram(
      parseJavaScriptComputation(
        "function read(undefined) { return undefined + 1; } console.log(read(2));",
      ).program,
    );
    expect(javascript.nodes.some((node) => node.constant === "intrinsic_undefined")).toBe(false);
  });

  it("lets an observed JavaScript helper named undefined shadow intrinsic undefined", () => {
    const helper = parseJavaScriptComputation("function undefined(value) { return value + 1; }");
    const result = parseJavaScriptComputation("console.log(undefined(2));", {
      definitions: helper.local.definitions,
    });
    const program = strictProgram(result.program);

    expect(program.complete).toBe(true);
    expect(program.unsupportedReasons).toEqual([]);
    expect(program.nodes.some((node) => node.constant === "intrinsic_undefined")).toBe(false);
    expect(result.local.definitionBindings?.map((binding) => binding.name)).toEqual(["undefined"]);
  });

  it("lets an observed JavaScript import named undefined shadow the intrinsic and keeps unknown imports fail-closed", () => {
    const source = 'import { undefined } from "./helper.mjs";\nconsole.log(undefined(2));';
    const observed = parseJavaScriptComputation(source, {
      modules: [
        {
          path: "tools/helper.mjs",
          source: "export function undefined(value) { return value + 1; }",
          language: "javascript",
          sourceEventId: "evt_helper_undefined",
          programDigest: "0123456789abcdef".repeat(4),
        },
      ],
      sourcePath: "tools/run.mjs",
    });
    const observedProgram = strictProgram(observed.program);

    expect(observedProgram.complete).toBe(true);
    expect(observedProgram.unsupportedReasons).toEqual([]);
    expect(observedProgram.nodes.some((node) => node.constant === "intrinsic_undefined")).toBe(
      false,
    );
    expect(observed.local.definitionBindings?.map((binding) => binding.name)).toEqual([
      "undefined",
    ]);

    const unknown = parseJavaScriptComputation(source, { sourcePath: "tools/run.mjs" });
    const unknownProgram = unknown.program;
    expect(ComputationProgramV1Schema.safeParse(unknownProgram).success).toBe(true);
    expect(unknownProgram.complete).toBe(false);
    expect(unknownProgram.unsupportedReasons).toContain("unsupported_api");
    expect(unknownProgram.nodes.some((node) => node.constant === "intrinsic_undefined")).toBe(
      false,
    );
  });

  it("represents intrinsic undefined without inventing an external data slot", () => {
    const program = strictProgram(
      parseJavaScriptComputation(
        "function missing(value) { return value === undefined; } console.log(missing(null));",
      ).program,
    );
    expect(program.nodes.some((node) => node.constant === "intrinsic_undefined")).toBe(true);
    expect(program.slots.some((slot) => slot.role === "free_variable")).toBe(false);
  });

  it("preserves JavaScript left-associated binary comparison behavior", () => {
    const program = strictProgram(
      parseJavaScriptComputation(
        "function check(a, b, c) { return a < b < c; } console.log(check(0, 1, 2));",
      ).program,
    );
    const comparisons = program.nodes.filter((node) => node.kind === "compare");
    expect(comparisons).toHaveLength(2);
    expect(
      comparisons.every((node) => node.children.length === 2 && node.operators?.length === 1),
    ).toBe(true);
    expect(comparisons[0].children).toContain(comparisons[1].id);
  });
});
