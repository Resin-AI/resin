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

function calls(program: ComputationProgramV1, api: string) {
  return program.nodes.filter((node) => node.kind === "call" && node.api === api);
}

function news(program: ComputationProgramV1, api: string) {
  return program.nodes.filter((node) => node.kind === "new" && node.api === api);
}

function expectCompletePathRead(source: string): ComputationProgramV1 {
  const program = parse(source);
  expect(program.complete).toBe(true);
  expect(news(program, "construct.path")).toHaveLength(1);
  expect(calls(program, "fs.read_text")).toHaveLength(1);
  return program;
}

function expectNoPathRead(source: string): ComputationProgramV1 {
  const program = parse(source);
  expect(program.complete).toBe(false);
  expect(calls(program, "fs.read_text")).toHaveLength(0);
  return program;
}

describe("Python pathlib.Path read_text capture", () => {
  it("captures direct and stable assigned Path receivers", () => {
    const direct = expectCompletePathRead(
      ["from pathlib import Path", "data = Path('records.json').read_text()"].join("\n"),
    );
    const assigned = expectCompletePathRead(
      ["from pathlib import Path", "p = Path('records.json')", "data = p.read_text()"].join("\n"),
    );
    const aliased = expectCompletePathRead(
      [
        "from pathlib import Path",
        "p = Path('records.json')",
        "q = p",
        "data = q.read_text()",
      ].join("\n"),
    );

    const assignedRead = calls(assigned, "fs.read_text")[0];
    const assignedPath = news(assigned, "construct.path")[0];
    expect(assignedRead?.receiver).toBeDefined();
    expect(assignedRead?.receiver).not.toBe(assignedPath?.id);
    expect(direct.complete).toBe(true);
    expect(aliased.complete).toBe(true);
  });

  it("resolves exact pathlib imports and aliases without accepting similar constructors", () => {
    expectCompletePathRead(
      ["from pathlib import Path as P", "data = P('records.json').read_text()"].join("\n"),
    );
    expectCompletePathRead(
      ["import pathlib", "data = pathlib.Path('records.json').read_text()"].join("\n"),
    );
    expectCompletePathRead(
      ["import pathlib as pl", "data = pl.Path('records.json').read_text()"].join("\n"),
    );

    expectNoPathRead("data = Path('records.json').read_text()");
    expectNoPathRead(
      ["from pathlib import PurePath", "data = PurePath('records.json').read_text()"].join("\n"),
    );
    expectNoPathRead(
      ["class Path:", "    pass", "data = Path('records.json').read_text()"].join("\n"),
    );
  });

  it("keeps path values anonymous, role-marked, and digest-stable for shape-equivalent paths", () => {
    const first = expectCompletePathRead(
      ["from pathlib import Path", "data = Path('/private/alpha.json').read_text()"].join("\n"),
    );
    const second = expectCompletePathRead(
      ["from pathlib import Path", "data = Path('/private/beta.json').read_text()"].join("\n"),
    );

    expect(first.slots.some((slot) => slot.role === "path")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("/private/alpha.json");
    expect(JSON.stringify(second)).not.toContain("/private/beta.json");
    expect(computeComputationProgramDigest(first)).toBe(computeComputationProgramDigest(second));
  });

  it("fails closed for reassigned, ambiguous, non-Path, and mutating receivers", () => {
    expectNoPathRead(
      [
        "from pathlib import Path",
        "p = Path('records.json')",
        "p = 'records.json'",
        "data = p.read_text()",
      ].join("\n"),
    );
    expectNoPathRead(
      [
        "from pathlib import Path",
        "if flag:",
        "    p = Path('records.json')",
        "data = p.read_text()",
      ].join("\n"),
    );
    expectNoPathRead(["with open(_PATH) as handle:", "    data = handle.read_text()"].join("\n"));
    const mutating = expectNoPathRead(
      [
        "from pathlib import Path",
        "p = Path('records.json')",
        "data = p.rename('other.json')",
      ].join("\n"),
    );
    expect(mutating.complete).toBe(false);

    expectNoPathRead(
      [
        "from pathlib import Path",
        "p = 'records.json'",
        "if flag:",
        "    p = Path('records.json')",
        "else:",
        "    q = p",
        "data = q.read_text()",
      ].join("\n"),
    );
    expectNoPathRead(
      [
        "from pathlib import Path",
        "p = Path('records.json')",
        "for p in records:",
        "    pass",
        "data = p.read_text()",
      ].join("\n"),
    );
    expectNoPathRead(
      [
        "from pathlib import Path",
        "p = Path('records.json')",
        "if (q := p):",
        "    pass",
        "data = q.read_text()",
      ].join("\n"),
    );
    expectNoPathRead(
      [
        "from pathlib import Path",
        "def read(Path):",
        "    return Path('records.json').read_text()",
        "data = read(Path)",
      ].join("\n"),
    );
  });

  it("keeps read_text linked to its Path-produced receiver under json.loads", () => {
    const program = expectCompletePathRead(
      [
        "import json",
        "from pathlib import Path",
        "p = Path('records.json')",
        "data = json.loads(p.read_text())",
      ].join("\n"),
    );
    const read = calls(program, "fs.read_text")[0];
    const parseCall = calls(program, "json.parse")[0];
    expect(read?.receiver).toBeDefined();
    expect(parseCall?.children).toEqual([read?.id]);
  });
});
