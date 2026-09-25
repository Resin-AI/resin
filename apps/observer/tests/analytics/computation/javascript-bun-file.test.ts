import {
  type ComputationProgramV1,
  ComputationProgramV1Schema,
  computeComputationProgramDigest,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { parseJavaScriptComputation } from "../../../src/analytics/computation/javascript.js";

/**
 * Focused coverage for standard global file and has-own readers. The source examples are synthetic
 * and keep concrete file/key text private: source values must be represented only through slots.
 */

type ProgramNode = ComputationProgramV1["nodes"][number];
type NodeOfKind<K extends ProgramNode["kind"]> = Extract<ProgramNode, { kind: K }>;

function strictProgram(source: string): ComputationProgramV1 {
  const result = parseJavaScriptComputation(source);
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

function nodesOfKind<K extends ProgramNode["kind"]>(
  program: ComputationProgramV1,
  kind: K,
): NodeOfKind<K>[] {
  return program.nodes.filter((node): node is NodeOfKind<K> => node.kind === kind);
}

function nodeById(program: ComputationProgramV1): Map<string, ProgramNode> {
  return new Map(program.nodes.map((node) => [node.id, node]));
}

function onlyCall(program: ComputationProgramV1, api: string): NodeOfKind<"call"> {
  const calls = nodesOfKind(program, "call").filter((node) => node.api === api);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function expectComplete(program: ComputationProgramV1): void {
  expect(program.complete).toBe(true);
  expect(program.unsupportedReasons).toEqual([]);
  expect(nodesOfKind(program, "unsupported")).toEqual([]);
}

function expectIncompleteWithoutApi(source: string, api: string): void {
  const program = strictProgram(source);
  expect(program.complete).toBe(false);
  expect(program.unsupportedReasons.length).toBeGreaterThan(0);
  expect(nodesOfKind(program, "unsupported").length).toBeGreaterThan(0);
  expect(nodesOfKind(program, "call").some((node) => node.api === api)).toBe(false);
}

function textReaderSource(path: string, field = "id"): string {
  return [
    "async function loadRecords() {",
    `  const records = JSON.parse(await Bun.file(${JSON.stringify(path)}).text());`,
    `  return records.map((row) => row.${field});`,
    "}",
    "console.log(await loadRecords());",
  ].join("\n");
}

function jsonReaderSource(path: string, field = "id"): string {
  return [
    "async function loadRecords() {",
    `  const records = await Bun.file(${JSON.stringify(path)}).json();`,
    `  return records.map((row) => row.${field});`,
    "}",
    "console.log(await loadRecords());",
  ].join("\n");
}

function hasOwnSource(field = "id"): string {
  return [
    "function includesField(record, field) {",
    "  return Object.prototype.hasOwnProperty.call(record, field);",
    "}",
    `console.log(includesField({ id: 1 }, ${JSON.stringify(field)}));`,
  ].join("\n");
}

describe("JavaScript Bun.file computation capture", () => {
  it("lowers Bun.file(path).text() under JSON.parse to canonical read and parse calls", () => {
    const source = textReaderSource("/private/source-a/records.json");
    const program = strictProgram(source);
    expectComplete(program);

    const calls = nodesOfKind(program, "call");
    expect(calls.filter((node) => node.api === "fs.read_text")).toHaveLength(1);
    expect(calls.filter((node) => node.api === "json.parse")).toHaveLength(1);
    expect(calls.filter((node) => node.api === "collection.map")).toHaveLength(1);
    expect(calls.filter((node) => node.api === "core.print")).toHaveLength(1);

    const byId = nodeById(program);
    const parse = onlyCall(program, "json.parse");
    const parseChild = byId.get(parse.children[0]!);
    expect(parseChild?.kind).toBe("await");
    const read = onlyCall(program, "fs.read_text");
    expect(parseChild?.children).toEqual([read.id]);
    const pathNode = byId.get(read.children[0]!);
    expect(pathNode?.kind).toBe("literal");
    expect(pathNode?.kind === "literal" ? pathNode.slot : undefined).toBeDefined();

    const serialized = JSON.stringify(program);
    expect(serialized).not.toContain("/private/source-a/records.json");
    expect(program.slots.some((slot) => slot.kind === "string")).toBe(true);
  });

  it("lowers Bun.file(path).json() to canonical read then parse calls", () => {
    const program = strictProgram(jsonReaderSource("/private/source-a/records.json"));
    expectComplete(program);

    const byId = nodeById(program);
    const parse = onlyCall(program, "json.parse");
    const read = onlyCall(program, "fs.read_text");
    expect(parse.children).toEqual([read.id]);
    const pathNode = byId.get(read.children[0]!);
    expect(pathNode?.kind).toBe("literal");
    expect(pathNode?.kind === "literal" ? pathNode.slot : undefined).toBeDefined();
    expect(JSON.stringify(program)).not.toContain("/private/source-a/records.json");
  });

  it("keeps digests stable under private path changes but sensitive to algorithm changes", () => {
    const first = strictProgram(textReaderSource("/private/source-a/records.json"));
    const moved = strictProgram(textReaderSource("/private/source-b/records.json"));
    const changedField = strictProgram(textReaderSource("/private/source-a/records.json", "score"));
    const directJson = strictProgram(jsonReaderSource("/private/source-a/records.json"));

    expect(computeComputationProgramDigest(moved)).toBe(computeComputationProgramDigest(first));
    expect(computeComputationProgramDigest(changedField)).not.toBe(
      computeComputationProgramDigest(first),
    );
    expect(computeComputationProgramDigest(directJson)).not.toBe(
      computeComputationProgramDigest(first),
    );
    expect(JSON.stringify(first)).not.toContain("/private/source-a/records.json");
    expect(JSON.stringify(moved)).not.toContain("/private/source-b/records.json");
  });

  it("does not lower shadowed, imported, aliased, optioned, spread, optional, or unknown Bun-shaped calls", () => {
    const negatives = [
      [
        "async function loadRecords(Bun) {",
        '  return await Bun.file("records.json").text();',
        "}",
        "console.log(await loadRecords({}));",
      ],
      [
        'import Bun from "bun";',
        "async function loadRecords() {",
        '  return await Bun.file("records.json").text();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        "  const reader = Bun.file;",
        '  return await reader("records.json").text();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file("records.json", { type: "json" }).text();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file(...["records.json"]).text();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file("records.json").arrayBuffer();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file("records.json")?.text();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file("records.json").text?.();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords() {",
        '  return await Bun.file("records.json").json?.();',
        "}",
        "console.log(await loadRecords());",
      ],
      [
        "async function loadRecords(response) {",
        "  return await response.text();",
        "}",
        "console.log(await loadRecords({}));",
      ],
    ];

    for (const lines of negatives) {
      expectIncompleteWithoutApi(lines.join("\n"), "fs.read_text");
    }
  });
});

describe("JavaScript Bun.write text computation capture", () => {
  function transformSource(input: string, output: string, field = "id"): string {
    return [
      `const source = await Bun.file(${JSON.stringify(input)}).json();`,
      `const records = source.map((row) => row.${field});`,
      `await Bun.write(${JSON.stringify(output)}, JSON.stringify(records) + '\\n');`,
    ].join("\n");
  }

  it("captures a complete native JSON transform with ordered canonical text-write children", () => {
    const input = "/synthetic/source.json";
    const output = "/synthetic/result.json";
    const program = strictProgram(transformSource(input, output));
    expectComplete(program);

    const byId = nodeById(program);
    const read = onlyCall(program, "fs.read_text");
    const parse = onlyCall(program, "json.parse");
    onlyCall(program, "collection.map");
    const serialize = onlyCall(program, "json.serialize");
    const write = onlyCall(program, "fs.write_text");
    expect(parse.children).toEqual([read.id]);
    expect(write.children).toHaveLength(2);
    const destination = byId.get(write.children[0]!);
    expect(destination?.kind).toBe("literal");
    expect(destination?.kind === "literal" ? destination.slot : undefined).toBeDefined();
    const text = byId.get(write.children[1]!);
    expect(text?.kind).toBe("binary");
    expect(text?.children[0]).toBe(serialize.id);
    const newline = byId.get(text?.children[1] ?? "");
    expect(newline?.kind).toBe("literal");
    expect(newline?.kind === "literal" ? newline.slot : undefined).toBeDefined();
    expect(JSON.stringify(program)).not.toContain(input);
    expect(JSON.stringify(program)).not.toContain(output);
  });

  it.each([
    ['"synthetic text payload"', "synthetic text payload"],
    ["`synthetic template payload`", "synthetic template payload"],
    ["`synthetic count: ${1}`", "synthetic count: "],
  ])("captures slotted literal or template text: %s", (payload, privateText) => {
    const program = strictProgram(`await Bun.write("/synthetic/result.txt", ${payload});`);
    expectComplete(program);
    const write = onlyCall(program, "fs.write_text");
    expect(write.children).toHaveLength(2);
    const byId = nodeById(program);
    expect(byId.get(write.children[0]!)?.kind).toBe("literal");
    expect(["literal", "template"]).toContain(byId.get(write.children[1]!)?.kind);
    expect(JSON.stringify(program)).not.toContain("/synthetic/result.txt");
    expect(JSON.stringify(program)).not.toContain(privateText);
  });

  it.each(["", ", null, 2"])("captures direct JSON serialization with arguments: %s", (options) => {
    const program = strictProgram(
      [
        'const records = await Bun.file("/synthetic/source.json").json();',
        `await Bun.write("/synthetic/result.json", JSON.stringify(records${options}));`,
      ].join("\n"),
    );
    expectComplete(program);
    const write = onlyCall(program, "fs.write_text");
    const serialize = onlyCall(program, "json.serialize");
    expect(write.children[1]).toBe(serialize.id);
  });

  it("keeps digests private-value invariant and transform-sensitive", () => {
    const first = strictProgram(
      transformSource("/synthetic/source.json", "/synthetic/result.json"),
    );
    const moved = strictProgram(
      transformSource("/synthetic/other.json", "/synthetic/other-result.json"),
    );
    const changed = strictProgram(
      transformSource("/synthetic/source.json", "/synthetic/result.json", "score"),
    );
    expectComplete(first);
    expectComplete(moved);
    expectComplete(changed);
    expect(computeComputationProgramDigest(moved)).toBe(computeComputationProgramDigest(first));
    expect(computeComputationProgramDigest(changed)).not.toBe(
      computeComputationProgramDigest(first),
    );

    const text = strictProgram('await Bun.write("/synthetic/a.txt", "synthetic payload A");');
    const renamed = strictProgram('await Bun.write("/synthetic/b.txt", "synthetic payload B");');
    expectComplete(text);
    expectComplete(renamed);
    expect(computeComputationProgramDigest(renamed)).toBe(computeComputationProgramDigest(text));
    expect(JSON.stringify(text)).not.toContain("synthetic payload A");
    expect(JSON.stringify(renamed)).not.toContain("synthetic payload B");
  });

  it.each([
    [
      "parameter shadow",
      'async function save(Bun) { await Bun.write("/synthetic/out", "text"); } save({});',
    ],
    ["local shadow", 'const Bun = {}; await Bun.write("/synthetic/out", "text");'],
    [
      "hoisted shadow",
      'async function save() { await Bun.write("/synthetic/out", "text"); var Bun; } save();',
    ],
    ["class shadow", 'class Bun {} await Bun.write("/synthetic/out", "text");'],
    ["default import", 'import Bun from "bun"; await Bun.write("/synthetic/out", "text");'],
    ["namespace import", 'import * as Bun from "bun"; await Bun.write("/synthetic/out", "text");'],
    ["named import", 'import { write } from "bun"; await write("/synthetic/out", "text");'],
    ["method alias", 'const write = Bun.write; await write("/synthetic/out", "text");'],
    ["namespace alias", 'const runtime = Bun; await runtime.write("/synthetic/out", "text");'],
    ["destructured alias", 'const { write } = Bun; await write("/synthetic/out", "text");'],
    ["replaced writer", 'Bun.write = async () => 0; await Bun.write("/synthetic/out", "text");'],
    ["deleted writer", 'delete Bun.write; await Bun.write("/synthetic/out", "text");'],
    [
      "replaced writer through globalThis",
      'globalThis.Bun.write = async () => 0; await Bun.write("/synthetic/out", "text");',
    ],
    ["computed member", 'await Bun["write"]("/synthetic/out", "text");'],
    ["optional receiver", 'await Bun?.write("/synthetic/out", "text");'],
    ["optional call", 'await Bun.write?.("/synthetic/out", "text");'],
    ["spread", 'await Bun.write(...["/synthetic/out", "text"]);'],
    ["options", 'await Bun.write("/synthetic/out", "text", { createPath: true });'],
    ["missing payload", 'await Bun.write("/synthetic/out");'],
    ["no arguments", "await Bun.write();"],
    ["file descriptor", 'await Bun.write(1, "text");'],
    ["BunFile destination", 'await Bun.write(Bun.file("/synthetic/out"), "text");'],
    [
      "unknown destination",
      'async function save(path) { await Bun.write(path, "text"); } save("/synthetic/out");',
    ],
    [
      "mixed destination",
      'const flag = true; await Bun.write(flag ? 1 : "/synthetic/out", "text");',
    ],
    [
      "JSON parameter shadow",
      'async function save(JSON) { await Bun.write("/synthetic/out", JSON.stringify({ id: 1 })); } save({});',
    ],
    [
      "JSON local shadow",
      'const JSON = { stringify: () => 1 }; await Bun.write("/synthetic/out", JSON.stringify({ id: 1 }));',
    ],
    [
      "JSON hoisted shadow",
      'async function save() { await Bun.write("/synthetic/out", JSON.stringify({ id: 1 })); var JSON; } save();',
    ],
    [
      "JSON import shadow",
      'import JSON from "synthetic-json"; await Bun.write("/synthetic/out", JSON.stringify({ id: 1 }));',
    ],
    [
      "JSON alias",
      'const json = JSON; await Bun.write("/synthetic/out", json.stringify({ id: 1 }));',
    ],
  ])("does not lower noncanonical calls: %s", (_label, source) => {
    expectIncompleteWithoutApi(source, "fs.write_text");
  });

  it.each([
    ["typed array", "new Uint8Array([1, 2])"],
    ["array buffer", "new ArrayBuffer(2)"],
    ["buffer", 'Buffer.from("text")'],
    ["blob", 'new Blob(["text"])'],
    ["response", 'new Response("text")'],
    ["fetch response", 'await fetch("https://synthetic.invalid")'],
    ["BunFile", 'Bun.file("/synthetic/input")'],
    ["binary file read", 'await Bun.file("/synthetic/input").arrayBuffer()'],
    ["array", "[1, 2]"],
    ["object", "{ id: 1 }"],
    ["number", "1"],
    ["null", "null"],
    ["undefined", "undefined"],
    ["function", "() => 1"],
    ["mixed number and text", 'true ? 1 : "text"'],
    ["mixed binary and text", 'true ? new Uint8Array([1]) : "text"'],
    ["numeric addition", "1 + 2"],
    ["JSON undefined", "JSON.stringify(undefined)"],
    ["JSON void", "JSON.stringify(void 0)"],
    ["JSON function", "JSON.stringify(() => 1)"],
    ["JSON no arguments", "JSON.stringify()"],
    ["JSON optional call", "JSON.stringify?.({ id: 1 })"],
    ["JSON spread", "JSON.stringify(...[{ id: 1 }])"],
    ["JSON replacer function", "JSON.stringify({ id: 1 }, () => undefined)"],
    ["JSON undefined plus newline", "JSON.stringify(undefined) + '\\n'"],
    ["JSON function plus newline", "JSON.stringify(() => 1) + '\\n'"],
  ])("does not lower unsupported payloads: %s", (_label, payload) => {
    expectIncompleteWithoutApi(`await Bun.write("/synthetic/out", ${payload});`, "fs.write_text");
  });

  it.each([
    [
      "unknown input",
      'async function save(value) { await Bun.write("/synthetic/out", value); } save({});',
    ],
    [
      "const binary",
      'const value = new Uint8Array([1]); await Bun.write("/synthetic/out", value);',
    ],
    ["const object", 'const value = { id: 1 }; await Bun.write("/synthetic/out", value);'],
    [
      "reassigned payload",
      'let value = "text"; value = new Uint8Array([1]); await Bun.write("/synthetic/out", value);',
    ],
    [
      "reassigned destination",
      'let path = "/synthetic/out"; path = 1; await Bun.write(path, "text");',
    ],
  ])("does not infer text from unsafe bindings: %s", (_label, source) => {
    expectIncompleteWithoutApi(source, "fs.write_text");
  });
});

describe("JavaScript Object.prototype.hasOwnProperty.call computation capture", () => {
  it("lowers the exact standard-global call chain to canonical object.has_own", () => {
    const program = strictProgram(hasOwnSource());
    expectComplete(program);

    const call = onlyCall(program, "object.has_own");
    expect(call.children).toHaveLength(2);
    expect(nodesOfKind(program, "call").filter((node) => node.api === "core.print")).toHaveLength(
      1,
    );
    expect(JSON.stringify(program)).not.toContain("hasOwnProperty.call");
  });

  it("keeps digests stable under private key changes but sensitive to algorithm changes", () => {
    const first = strictProgram(hasOwnSource("id"));
    const renamed = strictProgram(hasOwnSource("secretField"));
    const changed = strictProgram(
      [
        "function includesField(record, field) {",
        "  return Object.keys(record).includes(field);",
        "}",
        'console.log(includesField({ id: 1 }, "id"));',
      ].join("\n"),
    );

    expect(computeComputationProgramDigest(renamed)).toBe(computeComputationProgramDigest(first));
    expect(computeComputationProgramDigest(changed)).not.toBe(
      computeComputationProgramDigest(first),
    );
    expect(JSON.stringify(renamed)).not.toContain("secretField");
  });

  it("does not lower non-exact or shadowed hasOwnProperty.call chains", () => {
    const negatives = [
      [
        "function includesField(Object, record, field) {",
        "  return Object.prototype.hasOwnProperty.call(record, field);",
        "}",
        'console.log(includesField({}, {}, "id"));',
      ],
      [
        'import Object from "object-tools";',
        "function includesField(record, field) {",
        "  return Object.prototype.hasOwnProperty.call(record, field);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  const hasOwn = Object.prototype.hasOwnProperty;",
        "  return hasOwn.call(record, field);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  return Object.prototype.hasOwnProperty.call(record);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  return Object.prototype.hasOwnProperty.call(record, ...[field]);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  return Object.prototype.hasOwnProperty?.call(record, field);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  return record.hasOwnProperty.call(record, field);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
      [
        "function includesField(record, field) {",
        "  return Object.prototype.propertyIsEnumerable.call(record, field);",
        "}",
        'console.log(includesField({}, "id"));',
      ],
    ];

    for (const lines of negatives) {
      expectIncompleteWithoutApi(lines.join("\n"), "object.has_own");
    }
  });
});
