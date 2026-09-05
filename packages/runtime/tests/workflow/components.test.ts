import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  ComponentCompositionSchema,
  ComponentContractSchema,
  componentContractDigest,
} from "@resin/contracts";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { COMPONENT_RUNTIME_TYPESCRIPT } from "../../src/workflow/component-runtime-source.js";
import {
  assertComponentValue,
  compileComponentComposition,
  executeComponentComposition,
} from "../../src/workflow/components.js";

const object = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
};
const contract = ComponentContractSchema.parse({
  schemaVersion: "1.0.0",
  name: "number.increment",
  version: "1.0.0",
  description: "Increment a number",
  inputSchema: object,
  outputSchema: object,
  runtime: "deno",
  effects: [],
  capabilities: {},
  tests: [{ name: "increments", input: { value: 1 }, expectedOutput: { value: 2 } }],
});
const source =
  'import { defineTool, type ToolContext } from "@resin/runtime"; export default defineTool(async (context: ToolContext<{value: number}>) => ({ value: context.input.value + 1 }));';
const reference = {
  contractDigest: componentContractDigest(contract),
  sourceDigest: createHash("sha256").update(source).digest("hex"),
};
const composition = ComponentCompositionSchema.parse({
  schemaVersion: "1.0.0",
  inputSchema: object,
  outputSchema: object,
  steps: [
    { id: "first", component: reference, inputs: { value: { from: "input", path: ["value"] } } },
    {
      id: "second",
      component: reference,
      inputs: { value: { from: "step", step: "first", path: ["value"] } },
    },
  ],
  outputs: { value: { from: "step", step: "second", path: ["value"] } },
});

// The VM is test-only. Production code is compiled as data, never executed by the compiler.
async function executeCompiled(text: string, input: unknown) {
  const script = ts
    .transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace('import { defineTool } from "@resin/runtime";', "")
    .replace("export default ", "globalThis.handler = ");
  const sandbox = {
    structuredClone,
    defineTool: (handler: unknown) => handler,
    handler: undefined as unknown,
  };
  vm.runInNewContext(script, sandbox, { timeout: 1000 });
  if (typeof sandbox.handler !== "function") throw new Error("Missing compiled handler");
  return sandbox.handler({ input });
}

describe("immutable component compositions", () => {
  it("keeps the typed sandbox helper snapshot identical to its verified implementation", () => {
    const implementation = readFileSync(
      new URL("../../src/workflow/components.ts", import.meta.url),
      "utf8",
    );
    const typed = implementation
      .slice(
        implementation.indexOf("export function assertComponentValue"),
        implementation.indexOf("/** Reject impossible bindings"),
      )
      .replaceAll("export function ", "function ")
      .replaceAll("export async function ", "async function ")
      .trim();
    expect(COMPONENT_RUNTIME_TYPESCRIPT).toBe(typed);
  });
  it("compiles and executes a pinned multi-step graph using the existing tool ABI", async () => {
    const compiled = compileComponentComposition(composition, [
      { contract, source },
      { contract, source },
    ]);
    expect(JSON.parse(JSON.stringify(await executeCompiled(compiled, { value: 1 })))).toEqual({
      value: 3,
    });
    await expect(executeCompiled(compiled, { value: "1" })).rejects.toThrow("number");
  });
  it("preserves omitted optional inputs so component defaults can run", async () => {
    const optional = { ...object, required: [] };
    const unit = { ...contract, inputSchema: optional };
    const code =
      'import { defineTool, type ToolContext } from "@resin/runtime"; export default defineTool((context: ToolContext<{value?: number}>) => ({value: context.input.value ?? 7}));';
    const graph = ComponentCompositionSchema.parse({
      ...composition,
      inputSchema: optional,
      steps: [
        {
          id: "optional",
          component: {
            contractDigest: componentContractDigest(unit),
            sourceDigest: createHash("sha256").update(code).digest("hex"),
          },
          inputs: { value: { from: "input", path: ["value"] } },
        },
      ],
      outputs: { value: { from: "step", step: "optional", path: ["value"] } },
    });
    const compiled = compileComponentComposition(graph, [{ contract: unit, source: code }]);
    expect(await executeCompiled(compiled, {})).toEqual({ value: 7 });
    expect(await executeCompiled(compiled, { value: 0 })).toEqual({ value: 0 });
    const seen = vi.fn(async (_index, input) => ({ value: input.value ?? 7 }));
    expect(await executeComponentComposition(graph, {}, seen)).toEqual({ value: 7 });
    expect(seen).toHaveBeenCalledWith(0, {});
    const requiredGraph = structuredClone(graph);
    requiredGraph.steps[0].component = reference;
    const requiredCompiled = compileComponentComposition(requiredGraph, [{ contract, source }]);
    await expect(executeCompiled(requiredCompiled, {})).rejects.toThrow();
    const unboundOutput = {
      ...graph,
      outputs: { value: { from: "input" as const, path: ["value"] } },
    };
    await expect(executeComponentComposition(unboundOutput, {}, seen)).rejects.toThrow(
      "Unresolved",
    );
  });
  it("rejects changed source and contracts instead of silently replacing versions", () => {
    expect(() =>
      compileComponentComposition(composition, [
        { contract, source: `${source}\n` },
        { contract, source },
      ]),
    ).toThrow("digest");
    expect(() =>
      compileComponentComposition(composition, [
        { contract: { ...contract, version: "2.0.0" }, source },
        { contract, source },
      ]),
    ).toThrow("digest");
  });
  it("rejects cycles, missing predecessors, duplicate IDs and inherited bindings", () => {
    const invalid = structuredClone(composition);
    invalid.steps[0].inputs.value = { from: "step", step: "second", path: ["value"] };
    expect(() => ComponentCompositionSchema.parse(invalid)).toThrow("preceding");
    invalid.steps[0].inputs.value = { from: "input", path: ["constructor"] };
    expect(() => ComponentCompositionSchema.parse(invalid)).toThrow();
    invalid.steps[0].inputs.value = { from: "input", path: ["value"] };
    invalid.steps[1].id = "first";
    expect(() => ComponentCompositionSchema.parse(invalid)).toThrow("Duplicate");
  });
  it("aborts at the failing component without automatically retrying effects", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("write precondition failed"));
    await expect(executeComponentComposition(composition, { value: 1 }, invoke)).rejects.toThrow(
      "precondition",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("fails closed on unsupported schemas and oversized intermediates", () => {
    expect(() => assertComponentValue({ type: "string", pattern: ".*" }, "x")).toThrow(
      "Unsupported",
    );
    expect(() => assertComponentValue({ type: "number" }, Number.NaN)).toThrow();
    expect(() => assertComponentValue({ type: "string" }, "x".repeat(1048577))).toThrow("size");
  });
  it("does not execute source or resolve arbitrary imports at compile time", () => {
    const malicious =
      'import fs from "node:fs"; export default () => fs.readFileSync("/etc/passwd");';
    const changed = structuredClone(composition);
    changed.steps[0].component.sourceDigest = createHash("sha256").update(malicious).digest("hex");
    expect(() =>
      compileComponentComposition(changed, [
        { contract, source: malicious },
        { contract, source },
      ]),
    ).toThrow("SDK");
  });
});
