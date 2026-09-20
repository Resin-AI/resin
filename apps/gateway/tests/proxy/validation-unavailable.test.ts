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
const authorization = () => ({ workspaceId: owner, envelopeId: "envelope-one" });

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
      authorization,
      workspaceId: owner,
      dispatch,
    })(plan);
    expect(result.unavailable).toContain("no matching recorded demonstration");
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
      authorization,
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

  it("leaves an unsubstantiated ask pending instead of uploading an empty decision", async () => {
    const plan = recording();
    const submitted: WorkflowValidationDecision[] = [];
    const log: string[] = [];
    const worker = new WorkflowValidationWorker({
      identity: { workspaceId: owner, deviceId: "device-one" },
      client: {
        listPending: async () => [
          {
            schemaVersion: 1,
            requestId: "missing-demo",
            workspaceId: owner,
            deviceId: "device-one",
            attempt: "attempt-one",
            planDigest: workflowValidationPlanDigest(plan),
            evidenceDigest: "evidence-one",
            authorization: authorization(),
            createdAt: new Date().toISOString(),
            plan,
          },
        ],
        submitDecision: async (decision) => {
          submitted.push(decision);
          return { status: "recorded" };
        },
      },
      log: (message) => log.push(message),
    });
    expect(await worker.runOnce()).toMatchObject({ pending: 1, answered: 0, refused: 1 });
    expect(submitted).toEqual([]);
    expect(log.join("\n")).toContain("no matching recorded demonstration");
  });
});
