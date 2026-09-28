/**
 * Span holes: part of one recorded string token bound to a value, rendered through the token's own
 * quoting so the rewritten program runs exactly as a shell or python reads it.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  applyProgramTokenValues,
  bindProgramToken,
  demonstratedProgramTokenSpanValue,
  embeddedPrograms,
  programTokenPath,
  programTokenValueAt,
  tokenizeProgram,
} from "../src/program-tokens.js";
import { type RecordedWorkflow, validateRecordedWorkflow } from "../src/recorded-workflow.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const sh = (program: string) => spawnSync("sh", ["-c", program], { encoding: "utf8" });

function renderSpans(
  source: string,
  token: number,
  spans: Array<{ start: number; end: number; value: string | number }>,
): string {
  return applyProgramTokenValues(
    source,
    tokenizeProgram("shell", source),
    new Map(),
    "shell",
    undefined,
    spans.map(({ start, end, value }) => ({ token, span: { start, end }, value })),
  );
}

function plan(
  holes: unknown[],
  source = "printf %s out/emea-2025-03/summary.csv",
): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf-span",
    inputs: [
      { name: "region", type: "string", recordedDefault: true },
      { name: "month", type: "string", recordedDefault: true },
    ],
    privateReferences: [],
    steps: [
      {
        id: "run",
        callId: "call-run",
        callable: {
          runtime: "process",
          name: "command_exec",
          program: { kind: "shell", source, argument: "cmd" },
        },
        arguments: [
          {
            name: "cmd",
            source: {
              kind: "template",
              template: {
                type: "program",
                language: "shell",
                source: { type: "literal", value: source },
                holes,
              },
            },
          },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  } as RecordedWorkflow;
}

const region = { type: "input", name: "region" };
const month = { type: "input", name: "month" };

describe("span holes", () => {
  it("renders composite values that sh reads back exactly, in every shell quoting style", () => {
    const hostile = `it's "$HOME" \`x\` \\ ;`;
    for (const recorded of [
      "printf %s out/emea-2025-03/summary.csv",
      "printf %s 'out/emea-2025-03/summary.csv'",
      'printf %s "out/emea-2025-03/summary.csv"',
    ]) {
      // Offsets are into the decoded value `out/emea-2025-03/summary.csv`, whatever the quoting.
      const spans = [
        { start: 4, end: 8, value: "apac" },
        { start: 9, end: 16, value: "2026-11" },
      ];
      expect(sh(renderSpans(recorded, 2, spans)).stdout).toBe("out/apac-2026-11/summary.csv");
      // A value needing quotes turns a bare token into a quoted one; the shell still reads it back.
      const rendered = renderSpans(recorded, 2, [{ start: 4, end: 8, value: hostile }]);
      expect(sh(rendered).stdout).toBe(`out/${hostile}-2025-03/summary.csv`);
      // A finite number becomes its text.
      expect(sh(renderSpans(recorded, 2, [{ start: 9, end: 13, value: 2031 }])).stdout).toBe(
        "out/emea-2031-03/summary.csv",
      );
    }
  });

  it("renders a span inside an embedded python string that python runs", () => {
    const source = `python3 -c 'print("/data/2023/fees.json")'`;
    const program = embeddedPrograms(source)[0]!;
    const index = program.tokens.findIndex((token) => token.value === "/data/2023/fees.json");
    const rendered = applyProgramTokenValues(
      source,
      tokenizeProgram("shell", source),
      new Map(),
      "shell",
      undefined,
      [
        {
          token: program.anchor,
          embedded: index,
          span: { start: 6, end: 10 },
          value: 'it\'s "24"',
        },
      ],
    );
    expect(rendered).not.toBe(source);
    if (hasPython) {
      expect(sh(rendered).stdout).toBe(`/data/it's "24"/fees.json\n`);
    }
  });

  it("refuses overlapping, whole-value, out-of-range and non-text spans", () => {
    const source = "printf %s out/emea-2025-03/summary.csv";
    expect(() =>
      renderSpans(source, 2, [
        { start: 4, end: 8, value: "a" },
        { start: 6, end: 10, value: "b" },
      ]),
    ).toThrow();
    expect(() => renderSpans(source, 2, [{ start: 0, end: 28, value: "x" }])).toThrow();
    expect(() => renderSpans(source, 2, [{ start: 20, end: 40, value: "x" }])).toThrow();
    expect(() =>
      applyProgramTokenValues(
        source,
        tokenizeProgram("shell", source),
        new Map(),
        "shell",
        undefined,
        [{ token: 2, span: { start: 4, end: 8 }, value: true }],
      ),
    ).toThrow();
    // A token bound whole and by span at once describes two different programs.
    expect(() =>
      applyProgramTokenValues(
        source,
        tokenizeProgram("shell", source),
        new Map([[2, "whole"]]),
        "shell",
        undefined,
        [{ token: 2, span: { start: 4, end: 8 }, value: "x" }],
      ),
    ).toThrow();
    // A number token takes no span.
    const python = tokenizeProgram("python", "print(300)");
    const number = python.findIndex((token) => token.kind === "number");
    expect(number).toBeGreaterThanOrEqual(0);
    expect(() =>
      applyProgramTokenValues("print(300)", python, new Map(), "python", undefined, [
        { token: number, span: { start: 0, end: 1 }, value: "4" },
      ]),
    ).toThrow();
  });

  it("validates span holes in a plan: disjoint, never mixed with a whole hole, inside the value", () => {
    expect(
      validateRecordedWorkflow(
        plan([
          { token: 2, span: { start: 4, end: 8 }, binding: region },
          { token: 2, span: { start: 9, end: 16 }, binding: month },
        ]),
      ).errors,
    ).toEqual([]);
    for (const holes of [
      [
        { token: 2, span: { start: 4, end: 10 }, binding: region },
        { token: 2, span: { start: 9, end: 16 }, binding: month },
      ],
      [
        { token: 2, binding: region },
        { token: 2, span: { start: 9, end: 16 }, binding: month },
      ],
      [{ token: 2, span: { start: 20, end: 40 }, binding: region }],
      [{ token: 2, span: { start: 0, end: 28 }, binding: region }],
      [{ token: 2, span: { start: 5, end: 5 }, binding: region }],
      [{ token: 2, span: { start: 1.5, end: 4 }, binding: region }],
    ]) {
      expect(validateRecordedWorkflow(plan(holes)).errors.length).toBeGreaterThan(0);
    }
    // Existing hole shapes are untouched.
    expect(validateRecordedWorkflow(plan([{ token: 2, binding: region }])).errors).toEqual([]);
  });

  it("binds spans into a template, refusing overlap and mixing with a whole-token hole", () => {
    const source = { type: "literal" as const, value: "printf %s out/emea-2025-03/summary.csv" };
    let template = bindProgramToken(source, "shell", 2, region, undefined, { start: 4, end: 8 });
    template = bindProgramToken(template, "shell", 2, month, undefined, { start: 9, end: 16 });
    expect(template.type === "program" && template.holes.map((hole) => hole.span)).toEqual([
      { start: 4, end: 8 },
      { start: 9, end: 16 },
    ]);
    expect(() =>
      bindProgramToken(template, "shell", 2, region, undefined, { start: 6, end: 12 }),
    ).toThrow();
    expect(() => bindProgramToken(template, "shell", 2, region)).toThrow();
    expect(() =>
      bindProgramToken(source, "shell", 2, region, undefined, { start: 0, end: 28 }),
    ).toThrow();
    // Without a span the existing whole-token behavior is unchanged.
    expect(bindProgramToken(source, "shell", 2, region)).toEqual({
      type: "program",
      language: "shell",
      source,
      holes: [{ token: 2, binding: region }],
    });
  });

  it("addresses spans by path and reads the spanned text", () => {
    expect(programTokenPath(["tokens", 2])).toEqual({ token: 2 });
    expect(programTokenPath(["tokens", 1, "embedded", 3])).toEqual({ token: 1, embedded: 3 });
    expect(programTokenPath(["tokens", 2, "span", 4, 8])).toEqual({
      token: 2,
      span: { start: 4, end: 8 },
    });
    expect(programTokenPath(["tokens", 1, "embedded", 3, "span", 0, 2])).toEqual({
      token: 1,
      embedded: 3,
      span: { start: 0, end: 2 },
    });
    expect(programTokenPath(["tokens", 2, "span", 8, 4])).toBeUndefined();
    expect(programTokenPath(["tokens", 2, "span", 4])).toBeUndefined();
    const source = "printf %s 'out/emea-2025-03/summary.csv'";
    expect(programTokenValueAt("shell", source, { token: 2, span: { start: 4, end: 8 } })).toBe(
      "emea",
    );
  });

  it("reads a demonstrated span only when the held-out token keeps the recorded prefix and suffix", () => {
    const recorded = "report --out out/emea-2025-03/summary.csv";
    const address = { token: 2, span: { start: 4, end: 8 } };
    expect(
      demonstratedProgramTokenSpanValue(
        "shell",
        recorded,
        "report --out 'out/north-america-2025-03/summary.csv'",
        address,
      ),
    ).toBe("north-america");
    // Another suffix (the month moved too) does not decide the region span alone.
    expect(
      demonstratedProgramTokenSpanValue(
        "shell",
        recorded,
        "report --out out/apac-2026-01/summary.csv",
        address,
      ),
    ).toBeUndefined();
    expect(
      demonstratedProgramTokenSpanValue(
        "shell",
        recorded,
        "report --out other/apac-2025-03/summary.csv",
        address,
      ),
    ).toBeUndefined();
  });

  it("reads every span of a token jointly when the demonstration changed them all", () => {
    // The 03:43 demo pair: run A's separate `tar` step and the same segment of run B's chain.
    const recorded = "tar -czf backups/gamma/gamma-2026-03-02.tar.gz -C data gamma";
    const heldOut = "tar -czf backups/epsilon/epsilon-2026-03-09.tar.gz -C data epsilon";
    const spans = [
      { start: 0, end: 13 },
      { start: 14, end: 19 },
      { start: 20, end: 30 },
    ];
    const read = (span: { start: number; end: number }) =>
      demonstratedProgramTokenSpanValue("shell", recorded, heldOut, { token: 2, span }, spans);
    expect(spans.map(read)).toEqual(["backups/epsilon", "epsilon", "2026-03-09"]);
    // Alone, a span still needs the rest of the token unchanged.
    expect(
      demonstratedProgramTokenSpanValue("shell", recorded, heldOut, { token: 2, span: spans[2]! }),
    ).toBeUndefined();
    // Text that splits two ways decides no span.
    expect(
      demonstratedProgramTokenSpanValue(
        "shell",
        "cp a-b x",
        "cp c-d-e x",
        { token: 1, span: { start: 0, end: 1 } },
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
      ),
    ).toBeUndefined();
  });
});
