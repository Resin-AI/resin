import { describe, expect, it } from "vitest";
import { type RecordedWorkflow, validateRecordedWorkflow } from "../src/recorded-workflow.js";

/** fetch -> calculate -> write -> upload: four calls, values flowing through results. */
function fourCallWorkflow(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_fetch_calculate_write_upload",
    inputs: [{ name: "source" }, { name: "target" }],
    privateReferences: ["secret:storage_token"],
    steps: [
      {
        id: "fetch",
        callId: "call_1",
        callable: { runtime: "mcp", name: "unfamiliar.fetch", connection: "srv_local" },
        arguments: [{ name: "source", source: { kind: "input", name: "source" } }],
        dependsOn: [],
        failure: "abort",
      },
      {
        id: "calculate",
        callId: "call_2",
        callable: { runtime: "shell", name: "python3" },
        arguments: [
          { name: "stdin", source: { kind: "result", stepId: "fetch", path: ["body", "rows", 0] } },
        ],
        dependsOn: ["fetch"],
        failure: "abort",
      },
      {
        id: "write",
        callId: "call_3",
        callable: { runtime: "shell", name: "tee" },
        arguments: [
          { name: "path", source: { kind: "input", name: "target" } },
          { name: "content", source: { kind: "result", stepId: "calculate", path: ["stdout"] } },
        ],
        dependsOn: ["calculate"],
        failure: "abort",
      },
      {
        id: "upload",
        callId: "call_4",
        callable: { runtime: "mcp", name: "unfamiliar.upload", connection: "srv_local" },
        arguments: [
          { name: "file", source: { kind: "result", stepId: "write", path: ["path"] } },
          { name: "token", source: { kind: "private", reference: "secret:storage_token" } },
        ],
        dependsOn: ["write"],
        failure: "abort",
      },
    ],
  };
}

describe("recorded workflow validation", () => {
  it("accepts a workflow of unfamiliar callables bound through results, inputs and private references", () => {
    const result = validateRecordedWorkflow(fourCallWorkflow());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a binding to a step that does not come earlier", () => {
    const workflow = fourCallWorkflow();
    const result = validateRecordedWorkflow({
      ...workflow,
      steps: [workflow.steps[1]!, workflow.steps[0]!, workflow.steps[2]!, workflow.steps[3]!],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("does not come earlier");
  });

  it("rejects an input the workflow never declares", () => {
    const workflow = fourCallWorkflow();
    const result = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [{ name: "source", source: { kind: "input", name: "missing" } }],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unknown input");
  });

  it("says nothing about which tools are supported", () => {
    const workflow = fourCallWorkflow();
    const renamed = validateRecordedWorkflow({
      ...workflow,
      steps: workflow.steps.map((step) => ({
        ...step,
        callable: { runtime: `runtime-${step.id}`, name: `made-up-${step.id}` },
      })),
    });
    // The same shape validates: compilability is representability, not recognition.
    expect(renamed.valid).toBe(true);
  });
});
