import {
  type RecordedWorkflow,
  type WorkflowValidationDecision,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { RESIN_TOOL_PROTOCOL_RUNTIME, type ToolProtocolDispatchRequest } from "@resin/runtime";
import { describe, expect, it, vi } from "vitest";
import { WorkflowValidationWorker } from "../../src/proxy/validation-worker.js";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

function recording(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "fixed-recording",
    inputs: [],
    steps: [
      {
        id: "step0",
        callId: "call-0",
        callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "echo" },
        arguments: [{ name: "value", source: { kind: "literal", value: "fixed-value" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}
const owner = "validation-owner";

describe("a missing replay is not a completed validation", () => {
  it("reports the missing demonstration without executing recorded work", async () => {
    const dispatch = vi.fn(async () => "fixed-value");
    const plan = recording();
    plan.candidates = [
      {
        stepId: "step0",
        argument: "value",
        path: [],
        proposed: { kind: "input", name: "value", type: "string" },
        reason: "varies-across-executions",
        missing: "requires another recorded execution",
      },
    ];
    const result = await createLocalWorkflowValidator({
      workspaceId: owner,
      dispatch,
    })(plan);
    expect(result.verification).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("verifies a whole demonstrated plan even when no parameters are being proposed", async () => {
    const plan = recording();
    const store = new InMemoryPrivateValueStore();
    store.set("private:observed", "fixed-value", { workspaceId: owner });
    plan.privateReferences = ["private:observed"];
    plan.heldOut = { inputs: [], observed: [{ stepId: "step0", reference: "private:observed" }] };
    const dispatch = vi.fn(async (request: ToolProtocolDispatchRequest) => request.arguments.value);
    const result = await createLocalWorkflowValidator({
      workspaceId: owner,
      privateValues: store,
      dispatch,
    })(plan);
    expect(result.verification).toMatchObject({
      status: "verified",
      reproduced: ["step0"],
      missed: [],
    });
    expect(result.verdicts).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("validates native baseline outputs without converting them into parameter evidence", async () => {
    const plan = recording();
    const store = new InMemoryPrivateValueStore();
    store.set("private:observed", "fixed-value", { workspaceId: owner });
    plan.privateReferences = ["private:observed"];
    plan.baseline = { inputs: [], observed: [{ stepId: "step0", reference: "private:observed" }] };
    plan.candidates = [
      {
        stepId: "step0",
        argument: "value",
        path: [],
        proposed: { kind: "input", name: "value", type: "string" },
        reason: "varies-across-executions",
        missing: "requires a held-out execution",
      },
    ];
    const dispatch = vi.fn(async (request: ToolProtocolDispatchRequest) => request.arguments.value);
    const validate = createLocalWorkflowValidator({
      workspaceId: owner,
      privateValues: store,
      dispatch,
    });
    const verified = await validate(plan);
    expect(verified.verification).toMatchObject({
      status: "verified",
      reproduced: ["step0"],
      missed: [],
      replay: { kind: "host-replay", planDigest: workflowValidationPlanDigest(plan) },
    });
    expect(verified.verdicts).toMatchObject([{ confirmed: false }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    dispatch.mockResolvedValueOnce("different");
    const failed = await validate(plan);
    expect(failed.verification).toMatchObject({
      status: "failed",
      reproduced: [],
      missed: [{ stepId: "step0" }],
    });
    expect(failed.verification?.replay).toBeUndefined();
  });

  it("records an explicit failed decision when the demonstration is unavailable", async () => {
    const plan = recording();
    plan.candidates = [
      {
        stepId: "step0",
        argument: "value",
        path: [],
        proposed: { kind: "input", name: "value", type: "string" },
        reason: "varies-across-executions",
        missing: "requires another recorded execution",
      },
    ];
    const submitted: WorkflowValidationDecision[] = [];
    const worker = new WorkflowValidationWorker({
      identity: { workspaceId: owner, deviceId: "device-one" },
      client: {
        listPending: async () => [
          {
            schemaVersion: 2,
            requestId: "missing-demo",
            workspaceId: owner,
            deviceId: "device-one",
            attempt: "attempt-one",
            planDigest: workflowValidationPlanDigest(plan),
            evidenceDigest: "evidence-one",
            createdAt: new Date().toISOString(),
            plan,
          },
        ],
        submitDecision: async (decision) => {
          submitted.push(decision);
          return { status: "recorded" };
        },
      },
    });
    expect(await worker.runOnce()).toMatchObject({ pending: 1, answered: 1, refused: 0 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      verdicts: [{ confirmed: false }],
      verification: { status: "failed" },
      accepted: [],
    });
  });
});
