import { type RecordedWorkflow, workflowValidationPlanDigest } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { RESIN_PROGRAM_RUNTIME } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

const workspaceId = "python-baseline-owner";

function recording(source: string, observed: string, setup?: string) {
  const privateValues = new InMemoryPrivateValueStore();
  privateValues.set("private:source", source, { workspaceId });
  privateValues.set("private:observed", observed, { workspaceId });
  if (setup !== undefined) privateValues.set("private:setup", setup, { workspaceId });
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "python-baseline",
    inputs: [],
    steps: [
      {
        id: "target",
        callId: "target-call",
        callable: {
          runtime: RESIN_PROGRAM_RUNTIME,
          name: "eval",
          program: {
            kind: "python",
            source: "",
            argument: "code",
            pythonState: {
              schemaVersion: 1,
              status: "closed",
              unresolvedReadCount: 0,
              setup:
                setup === undefined
                  ? []
                  : [
                      {
                        callId: "setup-call",
                        sourceEventId: "setup-event",
                        resultEventId: "setup-result",
                        reference: "private:setup",
                      },
                    ],
            },
          },
        },
        arguments: [{ name: "code", source: { kind: "private", reference: "private:source" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    baseline: { inputs: [], observed: [{ stepId: "target", reference: "private:observed" }] },
  };
  return {
    plan,
    validate: createLocalWorkflowValidator({ workspaceId, privateValues, timeoutMs: 5_000 }),
  };
}

describe("fresh-process baseline replay", () => {
  it("reproduces a zero-candidate cell with setup, without retaining mutations between replays", async () => {
    const { plan, validate } = recording(
      "values.append(4)\nprint(sum(values))",
      "10\n",
      "values = [1, 2, 3]\nprint('setup output is not the target output')",
    );
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const result = await validate(plan);
      expect(result.verification).toMatchObject({
        status: "verified",
        reproduced: ["target"],
        missed: [],
        replay: { kind: "fresh-process", planDigest: workflowValidationPlanDigest(plan) },
      });
    }
  });

  it("does not attest a cell whose recorded success depended on missing session globals", async () => {
    const { plan, validate } = recording("print(lock_data['packages'])", "{'resin': '1.0.78'}\n");
    const result = await validate(plan);
    expect(result.verification?.status).not.toBe("verified");
    expect(result.verification?.missed.map(({ stepId }) => stepId)).toEqual(["target"]);
    expect(result.verification?.replay).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("lock_data");
  });

  it("does not replace recorded expectations with a successful process exit", async () => {
    const { plan, validate } = recording("print(sum([1, 2, 3]))", "999\n");
    const result = await validate(plan);
    expect(result.verification?.status).not.toBe("verified");
    expect(result.verification?.reproduced).toEqual([]);
    expect(result.verification?.replay).toBeUndefined();
  });

  it("does not use the original baseline to promote a proposed input", async () => {
    const { plan, validate } = recording("print(6 * 7)", "42\n");
    plan.candidates = [
      {
        stepId: "target",
        argument: "code",
        path: ["tokens", 2],
        proposed: { kind: "input", name: "factor", type: "number" },
        reason: "varies-across-executions",
        missing: "another input must establish the binding",
      },
    ];
    const result = await validate(plan);
    expect(result.verification?.status).toBe("verified");
    expect(result.verdicts.map(({ confirmed }) => confirmed)).toEqual([false]);
    expect(plan.inputs).toEqual([]);
  });
});
