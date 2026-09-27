import { describe, expect, it } from "vitest";
import { RECORDED_WORKFLOW_SCHEMA_VERSION, validateRecordedWorkflow } from "../src/index.js";

/** One segment of the recorded `mkdir -p out && ./reportctl render out` chain, as a plan step. */
const segment = (index: number, text: string, extra: Record<string, unknown> = {}) => ({
  id: `s${index}`,
  callId: "chain",
  callable: {
    runtime: "resin-process",
    name: "bash",
    program: { kind: "shell", source: text, argument: "command" },
  },
  arguments: [
    {
      name: "command",
      source: {
        kind: "template",
        template: {
          type: "program",
          language: "shell",
          source: { type: "literal", value: text },
          sourceReference: "private:chain",
          protectedTokens: [],
          holes: [],
        },
      },
    },
  ],
  dependsOn: [],
  failurePolicy: { onError: "abort", policy: "default" },
  observed: { outcome: "succeeded" },
  segment: { index, count: 2, version: 1 },
  ...extra,
});
const reader = (stepId: string) => ({
  id: "read",
  callId: "reader",
  callable: { runtime: "resin-harness-tool", name: "read" },
  arguments: [{ name: "path", source: { kind: "result", stepId, path: [] } }],
  dependsOn: [stepId],
  failurePolicy: { onError: "abort", policy: "default" },
  observed: { outcome: "succeeded" },
});
const plan = (steps: unknown[]) => ({
  schemaVersion: RECORDED_WORKFLOW_SCHEMA_VERSION,
  workflowId: "wf",
  inputs: [],
  steps,
  privateReferences: ["private:chain"],
});
const chain = [segment(0, "mkdir -p out"), segment(1, "./reportctl render out")];

describe("segment steps of a recorded chain", () => {
  it("accepts every segment of one call, in order, whose last result is read", () => {
    expect(validateRecordedWorkflow(plan([...chain, reader("s1")])).errors).toEqual([]);
  });

  it("refuses a read of an earlier segment's result, which the recording never observed alone", () => {
    expect(validateRecordedWorkflow(plan([...chain, reader("s0")])).valid).toBe(false);
  });

  it("refuses a chain missing a segment, out of order, or mixing splitter versions", () => {
    for (const steps of [
      [chain[0]],
      [chain[1], chain[0]],
      [
        chain[0],
        segment(1, "./reportctl render out", { segment: { index: 1, count: 2, version: 2 } }),
      ],
      [chain[0], { ...reader("s0"), id: "x", callId: "chain" }, chain[1]],
    ])
      expect(validateRecordedWorkflow(plan(steps)).valid).toBe(false);
  });

  it("refuses two unsegmented steps sharing a call", () => {
    const { segment: _a, ...first } = chain[0]!;
    const { segment: _b, ...second } = { ...chain[1]!, id: "s1" };
    expect(validateRecordedWorkflow(plan([first, second])).valid).toBe(false);
  });
});
