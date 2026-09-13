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
