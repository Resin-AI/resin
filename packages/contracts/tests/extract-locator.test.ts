import { describe, expect, it } from "vitest";
import { extractPrintedValue, parseExtractLocator } from "../src/extract-locator.js";
import {
  type RecordedWorkflow,
  collectWorkflowPrivateReferences,
  validateRecordedWorkflow,
  workflowSinkStepIds,
} from "../src/recorded-workflow.js";

const ID = ["lower", "digit", "-"];

describe("extractPrintedValue", () => {
  it("returns the maximal run after the first occurrence of before that a run follows", () => {
    const output = "deployment: pending\ndeployment: dep-9e983a ready\ndeployment: dep-111111\n";
    expect(extractPrintedValue(output, { before: "deployment: ", charset: ID })).toBe("pending");
    expect(extractPrintedValue("id: \nid: dep-1\n", { before: "id: ", charset: ID })).toBe("dep-1");
    expect(extractPrintedValue("id=dep-9e983a.\n", { before: "id=", charset: ID })).toBe(
      "dep-9e983a",
    );
  });

  it("with an empty before, starts at the output start or after a non-charset character", () => {
    expect(extractPrintedValue("dep-9e983a\n", { before: "", charset: ID })).toBe("dep-9e983a");
    expect(extractPrintedValue("  ABC dep-1", { before: "", charset: ID })).toBe("dep-1");
  });

  it("returns undefined when no charset run follows before", () => {
    expect(
      extractPrintedValue("created deployment \n", { before: "deployment ", charset: ID }),
    ).toBe(undefined);
    expect(extractPrintedValue("nothing here", { before: "id ", charset: ID })).toBe(undefined);
    expect(extractPrintedValue("!!!", { before: "", charset: ["digit"] })).toBe(undefined);
  });

  it("parses only well-shaped locators", () => {
    expect(parseExtractLocator('{"before":"a ","charset":["lower","-"]}')).toEqual({
      before: "a ",
      charset: ["lower", "-"],
    });
    expect(parseExtractLocator('{"before":"a","charset":["space"]}')).toBe(undefined);
    expect(parseExtractLocator('{"before":"a","charset":[]}')).toBe(undefined);
    expect(parseExtractLocator("not json")).toBe(undefined);
  });
});

function deployWorkflow(binding: unknown, privateReferences: string[]): unknown {
  const shellStep = (id: string, callId: string, dependsOn: string[], template: unknown) => ({
    id,
    callId,
    callable: {
      runtime: "shell",
      name: "codex.exec_command",
      program: { kind: "shell", source: "", argument: "cmd" },
    },
    arguments: [{ name: "cmd", source: { kind: "template", template } }],
    dependsOn,
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  });
  return {
    schemaVersion: 1,
    workflowId: "wf_deploy",
    inputs: [],
    privateReferences,
    steps: [
      shellStep("create", "c1", [], { type: "literal", value: "./deployctl create" }),
      shellStep("wait", "c2", [], {
        type: "program",
        language: "shell",
        source: { type: "literal", value: "./deployctl wait dep-9e983a" },
        holes: [{ token: 2, binding }],
      }),
    ],
  };
}

describe("extract templates in recorded workflows", () => {
  it("accepts a declared locator from an earlier step and counts the producer as consumed", () => {
    const binding = { type: "extract", stepId: "create", locator: "private:loc" };
    const workflow = deployWorkflow(binding, ["private:loc"]);
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
    expect(collectWorkflowPrivateReferences(workflow as RecordedWorkflow)).toContain("private:loc");
    expect(workflowSinkStepIds(workflow as RecordedWorkflow)).toEqual(["wait"]);
  });

  it("rejects an undeclared locator, an unknown producer and a producer that is not earlier", () => {
    const undeclared = validateRecordedWorkflow(
      deployWorkflow({ type: "extract", stepId: "create", locator: "private:loc" }, []),
    );
    expect(undeclared.valid).toBe(false);
    const unknown = validateRecordedWorkflow(
      deployWorkflow({ type: "extract", stepId: "nope", locator: "private:loc" }, ["private:loc"]),
    );
    expect(unknown.valid).toBe(false);
    const later = validateRecordedWorkflow(
      deployWorkflow({ type: "extract", stepId: "wait", locator: "private:loc" }, ["private:loc"]),
    );
    expect(later.valid).toBe(false);
  });

  it("validates extract candidates like bindings", () => {
    const base = deployWorkflow({ type: "literal", value: "dep-9e983a" }, [
      "private:loc",
    ]) as Record<string, unknown>;
    const candidate = (stepId: string, locator: string) => ({
      ...base,
      candidates: [
        {
          stepId: "wait",
          argument: "cmd",
          path: ["tokens", 2],
          proposed: { kind: "extract", stepId, locator },
          reason: "printed-by-earlier-step",
          missing: "whether the id is the one the producer printed",
        },
      ],
    });
    expect(validateRecordedWorkflow(candidate("create", "private:loc")).valid).toBe(true);
    expect(validateRecordedWorkflow(candidate("create", "private:other")).valid).toBe(false);
    expect(validateRecordedWorkflow(candidate("wait", "private:loc")).valid).toBe(false);
  });
});
