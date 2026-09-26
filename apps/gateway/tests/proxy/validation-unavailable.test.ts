import {
  type RecordedWorkflow,
  type WorkflowValidationDecision,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { describe, expect, it } from "vitest";
import { WorkflowValidationWorker } from "../../src/proxy/validation-worker.js";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor, recordSession } from "./recorded-sessions.js";

const owner = "validation-owner";
const SESSION = "validation-unavailable-session";

/** One recorded `echo` tool call, with the recording's own baseline demonstration. */
function recording(store: InMemoryPrivateValueStore): RecordedWorkflow {
  return recordSession(store, { workspaceId: owner, sessionId: SESSION, workflowId: "echo" }, [
    { user: "Echo the fixed value" },
    {
      callId: "call-0",
      toolName: "echo",
      connection: "echo-server",
      parameters: { value: "fixed-value" },
      result: "fixed-value",
    },
  ]);
}

/** The same plan without any demonstration to check against. */
function undemonstrated(plan: RecordedWorkflow): RecordedWorkflow {
  const { baseline: _baseline, heldOut: _heldOut, ...rest } = plan;
  return {
    ...rest,
    candidates: [
      {
        stepId: plan.steps[0]!.id,
        argument: "value",
        path: [],
        proposed: { kind: "input", name: "value", type: "string" },
        reason: "varies-across-executions",
        missing: "requires another recorded execution",
      },
    ],
  };
}

function validator(store: InMemoryPrivateValueStore) {
  return createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, [SESSION]),
  });
}

describe("a missing demonstration is not a completed validation", () => {
  it("reports the missing demonstration", async () => {
    const store = new InMemoryPrivateValueStore();
    const result = await validator(store)(undemonstrated(recording(store)));
    expect(result.verification).toBeUndefined();
    expect(result.verdicts.every((verdict) => !verdict.confirmed)).toBe(true);
  });

  it("verifies a whole recorded plan even when no parameters are being proposed", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = { ...recording(store), candidates: [] };
    const result = await validator(store)(plan);
    expect(result.verification).toMatchObject({
      status: "verified",
      reproduced: [plan.steps[0]!.id],
      missed: [],
      replay: { kind: "recording", planDigest: workflowValidationPlanDigest(plan) },
    });
    expect(result.verdicts).toEqual([]);
  });

  it("verifies the baseline without converting it into parameter evidence", async () => {
    const store = new InMemoryPrivateValueStore();
    const recorded = recording(store);
    const plan = { ...recorded, candidates: undemonstrated(recorded).candidates };
    const verified = await validator(store)(plan);
    expect(verified.verification).toMatchObject({
      status: "verified",
      reproduced: [plan.steps[0]!.id],
      missed: [],
      replay: { kind: "recording", planDigest: workflowValidationPlanDigest(plan) },
    });
    expect(verified.verdicts).toMatchObject([{ confirmed: false }]);

    const changed: RecordedWorkflow = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        arguments: step.arguments.map((argument) => ({
          ...argument,
          source: { kind: "literal" as const, value: "different" },
        })),
      })),
    };
    const failed = await validator(store)(changed);
    expect(failed.verification).toMatchObject({
      status: "failed",
      reproduced: [],
      missed: [{ stepId: plan.steps[0]!.id }],
    });
    expect(failed.verification?.replay).toBeUndefined();
  });

  it("records an explicit failed decision when the demonstration is unavailable", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = undemonstrated(recording(store));
    const submitted: WorkflowValidationDecision[] = [];
    const worker = new WorkflowValidationWorker({
      identity: { workspaceId: owner, deviceId: "device-one" },
      privateValues: store,
      localCalls: localCallsFor(store, owner, [SESSION]),
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
