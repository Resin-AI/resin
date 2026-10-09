import { describe, expect, it } from "vitest";
import {
  extractPrintedValue,
  parseExtractLocator,
  searchPrintedValue,
} from "../src/extract-locator.js";
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

describe("exactly-one locators", () => {
  const CHECK =
    "FAIL migration-compat\n" +
    "  0058_orders_created_at_index: ok\n" +
    "  0059_accounts_contact_email: NOT backward compatible (2.13.4 pods keep running)\n" +
    "  0060_accounts_marketing_opt_in: ok\n";
  const MIGRATION = ["lower", "digit", "_"];

  it("reads the one whole run a label after it names, on any line", () => {
    const locator = { only: { before: "", after: ": NOT" }, charset: MIGRATION };
    expect(extractPrintedValue(CHECK, locator)).toBe("0059_accounts_contact_email");
    const several = CHECK.replace("orders_created_at_index: ok", "orders_created_at_index: NOT ok");
    expect(searchPrintedValue(several, locator)).toEqual({ found: "several" });
    expect(searchPrintedValue(CHECK.replace(": NOT", ": ok"), locator)).toEqual({ found: "none" });
  });

  it("reads the one run at an indented line start", () => {
    const locator = { only: { before: "\n  ", after: "" }, charset: ["lower", "-", "_"] };
    const policy = "FAIL license-policy\n  Scanned 14 deps.\n  pdfweave 0.12.0: not allowed\n";
    expect(extractPrintedValue(policy, locator)).toBe("pdfweave");
    expect(
      searchPrintedValue(policy.replace("\n  Scanned", "\n  geohashx 2.2.0\n  Scanned"), locator),
    ).toEqual({ found: "several" });
  });

  it("reads the line a marker names, refusing a marker on several lines or a missing line", () => {
    const locator = {
      only: { before: "", after: "", line: { marker: "warnings", offset: 1 } },
      charset: ["lower", "-"],
    };
    const table =
      "service  errors  warnings\nbilling      46         6\nauth          6         8\n";
    expect(extractPrintedValue(table, locator)).toBe("billing");
    // `warnings` inside `warnings_total` is not the marker word.
    expect(extractPrintedValue(`${table}warnings_total 14\n`, locator)).toBe("billing");
    expect(searchPrintedValue(`${table}no warnings\n`, locator)).toEqual({ found: "several" });
    expect(searchPrintedValue("service  errors  warnings", locator)).toEqual({ found: "none" });
  });

  it("parses only well-shaped exactly-one locators", () => {
    const parse = (value: unknown) => parseExtractLocator(JSON.stringify(value));
    const only = { before: "", after: ": NOT", line: { marker: "warnings", offset: 1 } };
    const at = (line: unknown) => parse({ only: { ...only, line }, charset: ["lower"] });
    expect(parse({ only, charset: ["lower"] })).toEqual({ only, charset: ["lower"] });
    // A locator is one form or the other, never both.
    expect(parse({ only, before: "", charset: ["lower"] })).toBe(undefined);
    expect(parse({ only: { before: "" }, charset: ["lower"] })).toBe(undefined);
    expect(at({ marker: "w4", offset: 1 })).toBe(undefined);
    expect(at({ marker: "warnings", offset: 0 })).toBe(undefined);
    expect(parse({ only: { ...only, before: "a\nb" }, charset: ["lower"] })).toBe(undefined);
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
