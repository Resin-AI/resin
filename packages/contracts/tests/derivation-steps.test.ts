import { describe, expect, it } from "vitest";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
  tokenizeProgram,
  validateRecordedWorkflow,
} from "../src/index.js";

const BODY =
  'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n';

function derivationStep(source: string, holes: number[]): WorkflowStep {
  return {
    id: "derive",
    callId: "derivation:derive",
    origin: "derivation",
    callable: {
      runtime: "resin-program",
      name: "python",
      program: { kind: "python", sourceInterface: "python-eval", source, argument: "code" },
    },
    arguments: [
      {
        name: "code",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "python",
            source: { type: "literal", value: source },
            holes: holes.map((token) => ({ token, binding: { type: "input", name: "merchant" } })),
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "unknown" },
  };
}

const CONSUMER = "printf '%s %s %s\\n' Crossfit_Hanna R 5942";

function plan(
  overrides: Partial<RecordedWorkflow> = {},
  derivation?: WorkflowStep,
): RecordedWorkflow {
  const source = derivationHeader([{ name: "merchant", value: "Crossfit_Hanna" }]) + BODY;
  const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
  const candidate: WorkflowBindingCandidate = {
    stepId: "report",
    argument: "command",
    path: ["tokens", 3],
    proposed: { kind: "result", stepId: "derive", path: ["account_type"] },
    reason: "derived-from-inputs",
    missing: "whether the account type follows from the merchant",
  };
  return {
    schemaVersion: 1,
    workflowId: "wf_derive",
    inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
    steps: [
      derivation ?? derivationStep(source, [merchant!]),
      {
        id: "report",
        callId: "call_report",
        callable: {
          runtime: "resin-process",
          name: "bash",
          program: { kind: "shell", source: CONSUMER, argument: "command" },
        },
        arguments: [{ name: "command", source: { kind: "literal", value: CONSUMER } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded" },
      },
    ],
    candidates: [candidate],
    ...overrides,
  };
}

function errorsOf(workflow: unknown): string[] {
  return validateRecordedWorkflow(workflow).errors;
}

describe("derivation header helpers", () => {
  it("renders one bindable Python literal per input that decodes to the value", () => {
    const inputs = [
      { name: "merchant", value: 'Crossfit "Hanna" — ünïcode\n' },
      { name: "year", value: 2023 },
      { name: "rate", value: -0.25 },
      { name: "active", value: true },
      { name: "note", value: null },
    ];
    const source = `${derivationHeader(inputs)}inputs\n`;
    const indexes = derivationInputTokenIndexes(
      source,
      inputs.map((input) => input.name),
    );
    const tokens = tokenizeProgram("python", source);
    expect(indexes.map((index) => tokens[index]!.value)).toEqual(
      inputs.map((input) => input.value),
    );
    expect(indexes.every((index) => tokens[index]!.bindable)).toBe(true);
  });

  it("refuses values that are not one token and sources without the header", () => {
    expect(() => derivationHeader([{ name: "shape", value: { a: 1 } }])).toThrow();
    expect(() => derivationHeader([{ name: "n", value: Number.NaN }])).toThrow();
    expect(() => derivationInputTokenIndexes("x = 1\n", ["merchant"])).toThrow();
    const source = derivationHeader([{ name: "merchant", value: "a" }]);
    expect(() => derivationInputTokenIndexes(source, ["other"])).toThrow();
  });
});

describe("derivation steps in the recorded workflow contract", () => {
  it("accepts a derivation that reads a caller input and a candidate bound to its output", () => {
    expect(errorsOf(plan())).toEqual([]);
  });

  it("refuses a derivation that reads no caller input", () => {
    const source = derivationHeader([{ name: "merchant", value: "Crossfit_Hanna" }]) + BODY;
    expect(errorsOf(plan({}, derivationStep(source, [])))).toContain(
      "derivation step derive must read at least one caller input",
    );
  });

  it("refuses holes that bind anything but caller inputs", () => {
    const step = derivationStep(derivationHeader([{ name: "merchant", value: "x" }]) + BODY, [4]);
    const argument = step.arguments[0]!;
    if (argument.source.kind !== "template" || argument.source.template.type !== "program") {
      throw new Error("fixture");
    }
    argument.source.template.holes[0]!.binding = { type: "literal", value: "R" };
    expect(errorsOf(plan({}, step)).some((error) => error.includes("only whole tokens"))).toBe(
      true,
    );
  });

  it("refuses private references, observations, dependencies and mismatched source", () => {
    const source = derivationHeader([{ name: "merchant", value: "x" }]) + BODY;
    const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
    const variants: Array<(step: WorkflowStep) => void> = [
      (step) => {
        const argument = step.arguments[0]!;
        if (argument.source.kind === "template" && argument.source.template.type === "program") {
          argument.source.template.sourceReference = "private:src";
        }
      },
      (step) => {
        step.arguments.push({
          name: "secret",
          source: { kind: "private", reference: "private:src" },
        });
      },
      (step) => {
        step.observed = { outcome: "succeeded" };
      },
      (step) => {
        step.dependsOn = ["report"];
      },
      (step) => {
        step.callable.program!.source = `${source}# edited\n`;
      },
      (step) => {
        step.callable.runtime = "resin-process";
      },
      (step) => {
        step.callable.program!.sourceInterface = undefined;
      },
    ];
    for (const change of variants) {
      const step = derivationStep(source, [merchant!]);
      change(step);
      expect(
        validateRecordedWorkflow(plan({ privateReferences: ["private:src"] }, step)).valid,
      ).toBe(false);
    }
  });

  it("refuses a demonstration that references a derivation", () => {
    expect(
      errorsOf(
        plan({
          privateReferences: ["private:obs"],
          baseline: { inputs: [], observed: [{ stepId: "derive", reference: "private:obs" }] },
        }),
      ),
    ).toContain("baseline references derivation step derive");
  });

  it("ties the derived-from-inputs reason to candidates that read a derivation", () => {
    const base = plan();
    const candidate = base.candidates![0]!;
    const wrongReason = { ...candidate, reason: "equal-to-earlier-result" as const };
    const notDerivation = {
      ...candidate,
      proposed: { kind: "result" as const, stepId: "report", path: ["x"] },
    };
    const nested = {
      ...candidate,
      proposed: { kind: "result" as const, stepId: "derive", path: ["a", "b"] },
    };
    const wholeArgument = { ...candidate, path: [] };
    const intoDerivation = { ...candidate, stepId: "derive", argument: "code" };
    for (const bad of [wrongReason, notDerivation, nested, wholeArgument, intoDerivation]) {
      expect(validateRecordedWorkflow({ ...base, candidates: [bad] }).valid).toBe(false);
    }
  });

  it("rejects an unknown origin and, for recorded steps, only the source mismatch it can see", () => {
    const base = plan();
    const unknown = { ...base, steps: [base.steps[0], { ...base.steps[1], origin: "model" }] };
    expect(validateRecordedWorkflow(unknown).valid).toBe(false);
    // A projected recorded program whose literal differs from its recorded source is rejected; a
    // recorded step's unprojected source cannot be proven recorded structurally.
    const report = base.steps[1]!;
    const projected: WorkflowStep = {
      ...report,
      origin: "recorded",
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: {
              type: "program",
              language: "shell",
              source: { type: "literal", value: "printf 'unrecorded'" },
              holes: [],
              sourceReference: "private:orig",
              protectedTokens: [],
            },
          },
        },
      ],
    };
    const projectedPlan = {
      ...base,
      candidates: [],
      privateReferences: ["private:orig"],
      steps: [base.steps[0]!, projected],
    };
    expect(errorsOf(projectedPlan)).toContain(
      "step report recorded program source differs from projected argument command",
    );
  });
});
