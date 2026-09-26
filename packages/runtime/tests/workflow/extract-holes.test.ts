import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { applyConfirmedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const LOCATOR = JSON.stringify({ before: "deployment ", charset: ["lower", "digit", "-"] });

function recorded(): RecordedWorkflow {
  const step = (id: string, command: string) => ({
    id,
    callId: `call-${id}`,
    callable: {
      runtime: "process",
      name: "command_exec",
      program: { kind: "shell" as const, source: command, argument: "cmd" },
    },
    arguments: [{ name: "cmd", source: { kind: "literal" as const, value: command } }],
    dependsOn: [],
    failurePolicy: { onError: "abort" as const, policy: "recorded" as const },
    observed: { outcome: "succeeded" as const },
  });
  return {
    schemaVersion: 1,
    workflowId: "wf-extract",
    inputs: [],
    privateReferences: ["private:locator"],
    steps: [step("create", "./deployctl create"), step("wait", "./deployctl wait dep-9e983a")],
  };
}

const candidate: WorkflowBindingCandidate = {
  stepId: "wait",
  argument: "cmd",
  path: ["tokens", 2],
  proposed: { kind: "extract", stepId: "create", locator: "private:locator" },
  reason: "printed-by-earlier-step",
  missing: "one recording does not establish the id was read from the output",
};

async function run(plan: RecordedWorkflow, printed: string) {
  const received: string[] = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    runtime: "process",
    async call(request) {
      received.push(String(request.arguments.cmd));
      return received.length === 1 ? printed : "ok";
    },
  });
  const execution = await executeRecordedWorkflow(plan, {
    inputs: {},
    adapters,
    resolvePrivate: (reference) => {
      if (reference !== "private:locator") throw new Error("unexpected reference");
      return LOCATOR;
    },
  });
  return { execution, received };
}

describe("extract holes", () => {
  it("feeds the value the producer printed in this run into the later command", async () => {
    const plan = applyConfirmedWorkflowBinding(recorded(), candidate);
    expect(plan).toBeDefined();
    const { execution, received } = await run(plan!, "created deployment dep-1a2b3c\n");
    expect(execution.status).toBe("completed");
    expect(received[1]).toBe("./deployctl wait dep-1a2b3c");
  });

  it("fails the consuming step without the output text when nothing matches", async () => {
    const plan = applyConfirmedWorkflowBinding(recorded(), candidate)!;
    const { execution, received } = await run(plan, "secret-output-without-marker\n");
    expect(execution.status).toBe("failed");
    expect(received).toHaveLength(1);
    const failed = execution.steps.find((entry) => entry.stepId === "wait");
    expect(failed?.status).toBe("failed");
    if (failed?.status === "failed") expect(failed.error).not.toContain("secret-output");
  });

  it("refuses to promote a locator the plan does not declare or a producer that is not earlier", () => {
    expect(
      applyConfirmedWorkflowBinding({ ...recorded(), privateReferences: [] }, candidate),
    ).toBeUndefined();
    expect(
      applyConfirmedWorkflowBinding(recorded(), {
        ...candidate,
        proposed: { kind: "extract", stepId: "wait", locator: "private:locator" },
      }),
    ).toBeUndefined();
  });
});
