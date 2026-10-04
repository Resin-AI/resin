import { describe, expect, it } from "vitest";
import {
  DISPLAY_FILTER_VERSION,
  RECORDED_WORKFLOW_SCHEMA_VERSION,
  splitDisplayFilter,
  splitShellAndChain,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "../src/index.js";

describe("splitDisplayFilter", () => {
  it("drops the trailing display-filter stages, keeping exact slices of the program", () => {
    expect(DISPLAY_FILTER_VERSION).toBe(1);
    expect(splitDisplayFilter("bash", "pnpm vitest run 2>&1 | tail -30")).toEqual({
      command: "pnpm vitest run 2>&1",
      filter: "tail -30",
    });
    expect(splitDisplayFilter("bash", "gh pr checks 12 | grep -E 'fail|pass' | head -5")).toEqual({
      command: "gh pr checks 12",
      filter: "grep -E 'fail|pass' | head -5",
    });
    expect(splitDisplayFilter("sh", "git log --oneline  |  egrep fix\t| fgrep -v wip")).toEqual({
      command: "git log --oneline",
      filter: "egrep fix\t| fgrep -v wip",
    });
    // Only the trailing run: a grep before a non-filter stage stays in the command.
    expect(splitDisplayFilter("dash", "cat notes | grep x | sort | head -3")).toEqual({
      command: "cat notes | grep x | sort",
      filter: "head -3",
    });
    expect(splitDisplayFilter("sh-or-zsh", "make test | tail -n 20")).toEqual({
      command: "make test",
      filter: "tail -n 20",
    });
    expect(splitDisplayFilter("bash", "pytest -q | grep -v 'passed' | tail -2", 1)).toEqual({
      command: "pytest -q",
      filter: "grep -v 'passed' | tail -2",
    });
  });

  it("splits nothing that is not a display filter", () => {
    for (const text of [
      "ls | wc -l",
      "tail -f log | grep x",
      "make | tail -F log",
      "make | tail -nf 5",
      "make | tail --follow=name log",
      "make | tail --retry",
      "make | tail --pid=4 log",
      "make | grep -c x",
      "make | grep -vl x",
      "make | grep -o x",
      "make | grep -q x",
      "make | grep --count x",
      "make | grep --only-matching x",
      "make | grep --null-data x",
      "make | grep x > out",
      "make | grep x 2> err",
      "make | head -5 < in",
      "make | tail 2>&1",
    ])
      expect(splitDisplayFilter("bash", text), text).toBeUndefined();
  });

  it("splits only one pipeline in the chain grammar under a POSIX shell and a known version", () => {
    for (const text of [
      "a && b | tail",
      "make; ls | tail",
      "make | tail\n",
      "make\nls | tail",
      "tail -5",
      "grep x notes | head -5",
      "echo $HOME | tail",
      "make | tail -$N",
      "cd out | tail",
      "make || ls | tail",
      "make |& tail",
      "make >&2 | tail",
      "make > out | tail",
    ])
      expect(splitDisplayFilter("bash", text), text).toBeUndefined();
    expect(splitDisplayFilter("pwsh", "make | tail -5")).toBeUndefined();
    expect(splitDisplayFilter("zsh", "make | tail -5")).toBeUndefined();
    expect(splitDisplayFilter("bash", "make | tail -5", 2)).toBeUndefined();
  });

  it("leaves the && chain grammar unchanged", () => {
    expect(splitShellAndChain("bash", "pnpm vitest run 2>&1 | tail -30 && ls")).toBeUndefined();
    expect(splitShellAndChain("bash", "pnpm vitest run | tail -30 && ls")?.segments).toHaveLength(
      2,
    );
  });
});

const PROGRAM = "gh pr checks 12 | tail -5";

/** A recorded OMP bash step running `source`, whose program argument is its projected template. */
const step = (
  extra: Record<string, unknown> = {},
  source = PROGRAM,
  holes: unknown[] = [],
  templateSource = source,
) => ({
  id: "checks",
  callId: "call-1",
  callable: {
    runtime: "resin-process",
    name: "bash",
    program: { kind: "shell", source, argument: "command" },
  },
  arguments: [
    {
      name: "command",
      source: {
        kind: "template",
        template: {
          type: "program",
          language: "shell",
          source: { type: "literal", value: templateSource },
          sourceReference: "private:checks",
          protectedTokens: [],
          holes,
        },
      },
    },
  ],
  dependsOn: [],
  failurePolicy: { onError: "abort", policy: "default" },
  observed: { outcome: "succeeded" },
  displayFilter: { version: 1 },
  ...extra,
});
const plan = (steps: unknown[]) => ({
  schemaVersion: RECORDED_WORKFLOW_SCHEMA_VERSION,
  workflowId: "wf",
  inputs: [{ name: "n", type: "string", required: true }],
  steps,
  privateReferences: ["private:checks"],
});
/** A hole binding input `n` at the token whose text is `raw`. */
const holeAt = (source: string, raw: string) => {
  const token = tokenizeProgram("shell", source).findIndex((entry) => entry.raw === raw);
  expect(token).toBeGreaterThanOrEqual(0);
  return [{ token, binding: { type: "input", name: "n" } }];
};

describe("displayFilter steps", () => {
  it("accepts a recorded POSIX shell step ending in a display filter, with a hole in its command", () => {
    expect(validateRecordedWorkflow(plan([step()])).errors).toEqual([]);
    expect(
      validateRecordedWorkflow(plan([step({}, PROGRAM, holeAt(PROGRAM, "12"))])).errors,
    ).toEqual([]);
    expect(
      validateRecordedWorkflow(
        plan([
          step({
            callable: {
              runtime: "resin-process",
              name: "bash",
              program: { kind: "shell", source: PROGRAM, argument: "command", dialect: "dash" },
            },
          }),
        ]),
      ).errors,
    ).toEqual([]);
  });

  it("refuses a malformed or unsupported displayFilter", () => {
    for (const displayFilter of [
      { version: 2 },
      { version: "1" },
      { version: 1, extra: true },
      { version: 1.5 },
      [],
      null,
      true,
    ])
      expect(validateRecordedWorkflow(plan([step({ displayFilter })])).valid).toBe(false);
  });

  it("refuses a program without a display filter, a non-POSIX shell, a derivation, or no program", () => {
    expect(validateRecordedWorkflow(plan([step({}, "ls | wc -l")])).valid).toBe(false);
    expect(validateRecordedWorkflow(plan([step({}, "gh pr checks 12")])).valid).toBe(false);
    expect(
      validateRecordedWorkflow(
        plan([
          step({
            callable: {
              runtime: "resin-process",
              name: "bash",
              program: { kind: "shell", source: PROGRAM, argument: "command", dialect: "pwsh" },
            },
          }),
        ]),
      ).valid,
    ).toBe(false);
    expect(
      validateRecordedWorkflow(
        plan([step({ callable: { runtime: "resin-tool-protocol", name: "checks" } })]),
      ).valid,
    ).toBe(false);
    expect(validateRecordedWorkflow(plan([step({ origin: "derivation" })])).valid).toBe(false);
  });

  it("refuses a template whose text is not the recorded program", () => {
    const other = "gh pr checks 13 | tail -5";
    expect(validateRecordedWorkflow(plan([step({}, PROGRAM, [], other)])).valid).toBe(false);
  });

  it("refuses a hole inside the dropped filter", () => {
    expect(
      validateRecordedWorkflow(plan([step({}, PROGRAM, holeAt(PROGRAM, "-5"))])).errors,
    ).toContain("step checks binds a value inside the display filter it drops");
  });

  it("lets a hole inside the filter stand when a boolean input switches the filter", () => {
    const toggle = { name: "filter_output", type: "boolean", default: false };
    const switched = (steps: unknown[], inputs: unknown[] = [toggle]) =>
      validateRecordedWorkflow({ ...plan(steps), inputs: [...plan([]).inputs, ...inputs] });
    const switchedStep = (extra: Record<string, unknown> = {}, holes = holeAt(PROGRAM, "-5")) =>
      step({ displayFilter: { version: 1, input: "filter_output" }, ...extra }, PROGRAM, holes);
    expect(switched([switchedStep()]).errors).toEqual([]);
    // The input must exist, be a boolean defaulting to false, and switch only this filter.
    expect(switched([switchedStep()], []).valid).toBe(false);
    expect(switched([switchedStep()], [{ ...toggle, default: true }]).valid).toBe(false);
    expect(switched([switchedStep()], [{ ...toggle, type: "string", default: "" }]).valid).toBe(
      false,
    );
    expect(switched([switchedStep(), switchedStep({ id: "again", callId: "call-2" })]).valid).toBe(
      false,
    );
    const readsSwitch = [{ token: 0, binding: { type: "input", name: "filter_output" } }];
    expect(switched([switchedStep({}, readsSwitch)]).valid).toBe(false);
    expect(switched([switchedStep({ optional: { input: "filter_output" } })]).valid).toBe(false);
    expect(switched([step({ displayFilter: { version: 1, input: "" } })]).valid).toBe(false);
  });
});
