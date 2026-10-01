import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { applyComposedWorkflowBinding } from "../../src/workflow/candidate-promotion.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const COMPOSED = {
  parts: [{ literal: "sources/" }, { input: "text" }, { literal: ".json" }],
};

/** A harness write of `sources/alpha.json`, and a token input `text` its validation already reads. */
function recorded(inputs: RecordedWorkflow["inputs"] = [{ name: "text", type: "string" }]) {
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf-composed",
    inputs,
    steps: [
      {
        id: "write",
        callId: "call-write",
        callable: { runtime: "resin-harness-tool", name: "write" },
        arguments: [
          { name: "path", source: { kind: "literal", value: "sources/alpha.json" } },
          { name: "content", source: { kind: "literal", value: "{}" } },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
  const candidate: WorkflowBindingCandidate = {
    stepId: "write",
    argument: "path",
    path: [],
    proposed: { kind: "input", name: "path", type: "string" },
    reason: "native-data-argument",
  };
  return { plan: { ...plan, candidates: [candidate] }, candidate };
}

async function writtenPath(plan: RecordedWorkflow, inputs: Record<string, WorkflowJsonValue>) {
  const received: unknown[] = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    runtime: "resin-harness-tool",
    async call(request) {
      received.push(request.arguments.path);
      return "ok";
    },
  });
  const execution = await executeRecordedWorkflow(plan, { inputs, adapters });
  return { execution, path: received[0] };
}

describe("composed text arguments", () => {
  it("apply as literal text around the declared input and render with its value", async () => {
    const { plan, candidate } = recorded();
    const composed = applyComposedWorkflowBinding(plan, candidate, COMPOSED);
    expect(composed).toBeDefined();
    expect(composed!.inputs).toEqual([{ name: "text", type: "string" }]);
    expect(composed!.candidates).toEqual([]);
    expect(composed!.steps[0]!.arguments[0]).toEqual({
      name: "path",
      source: {
        kind: "template",
        template: {
          type: "text",
          parts: [
            { type: "literal", value: "sources/" },
            { type: "input", name: "text" },
            { type: "literal", value: ".json" },
          ],
        },
      },
      provenance: { standing: "derived", rule: "replay-confirmed" },
    });
    expect(validateRecordedWorkflow(composed!)).toEqual({ valid: true, errors: [] });

    const { execution, path } = await writtenPath(composed!, { text: "beta" });
    expect(execution.status).toBe("completed");
    expect(path).toBe("sources/beta.json");
  });

  it("refuse a part naming an input the plan does not declare as a plain string", () => {
    const { plan, candidate } = recorded([]);
    expect(applyComposedWorkflowBinding(plan, candidate, COMPOSED)).toBeUndefined();
    const kept = recorded([{ name: "text", type: "string", recordedDefault: true }]);
    expect(applyComposedWorkflowBinding(kept.plan, kept.candidate, COMPOSED)).toBeUndefined();
  });
});
