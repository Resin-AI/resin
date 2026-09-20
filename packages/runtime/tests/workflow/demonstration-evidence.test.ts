import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RecordedWorkflow,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmPromotedPlan,
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { RuntimeAdapterRegistry } from "../../src/workflow/recorded-workflow.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "resin-demonstration-"));
  directories.push(path);
  return path;
}
function plan(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "evidence-paths",
    inputs: [],
    steps: [
      {
        id: "step0",
        callId: "call-0",
        callable: { name: "configure", runtime: "test-evidence" },
        arguments: [
          {
            name: "options",
            source: {
              kind: "template",
              template: {
                type: "object",
                entries: {
                  values: { type: "array", items: [{ type: "literal", value: 2 }] },
                  enabled: { type: "literal", value: false },
                },
              },
            },
          },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
    heldOut: {
      inputs: [{ stepId: "step0", argument: "options", reference: "private:options" }],
      observed: [{ stepId: "step0", reference: "private:observed" }],
    },
    privateReferences: ["private:options", "private:observed"],
  };
}
function candidate(
  name: string,
  path: Array<string | number>,
  type: "number" | "boolean",
): WorkflowBindingCandidate {
  return {
    stepId: "step0",
    argument: "options",
    path,
    proposed: { kind: "input", name, type },
    reason: "varies-across-executions",
    missing: "a repeat must confirm this input",
  };
}
function adapters() {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: "test-evidence",
    async call(request) {
      return request.arguments.options ?? null;
    },
  });
  return registry;
}

describe("demonstration evidence is interpreted at the actual argument position", () => {
  it("validates nested numeric and boolean inputs rather than passing their parent object", async () => {
    const recording = plan();
    const candidates = [
      candidate("limit", ["values", 0], "number"),
      candidate("enabled", ["enabled"], "boolean"),
    ];
    const expected = { values: [9], enabled: true };
    const environment = await demonstrationEnvironment({
      plan: recording,
      candidates,
      adapters: adapters(),
      workspaceDir: await directory(),
      resolvePrivate: (reference) => {
        if (reference !== "private:options" && reference !== "private:observed")
          throw new Error("unknown reference");
        return expected;
      },
    });
    expect(environment?.inputs).toEqual({ limit: 9, enabled: true });
    const decision = await validateAndConfirmCandidates({
      plan: recording,
      candidates,
      environment: environment!,
    });
    expect(decision.outcomes.every((outcome) => outcome.accepted)).toBe(true);
    expect(decision.verification).toMatchObject({
      status: "verified",
      reproduced: ["step0"],
      missed: [],
    });
  });

  it("does not silently choose one of two conflicting values assigned the same input name", async () => {
    const recording = plan();
    const candidates = [
      candidate("shared", ["values", 0], "number"),
      candidate("shared", ["values", 1], "number"),
    ];
    const environment = await demonstrationEnvironment({
      plan: recording,
      candidates,
      adapters: adapters(),
      workspaceDir: await directory(),
      resolvePrivate: () => ({ values: [9, 12], enabled: true }),
    });
    expect(Object.hasOwn(environment!.inputs, "shared")).toBe(false);
  });

  it("does not coerce an incompatible demonstrated type or use the whole value for a missing path", async () => {
    const recording = plan();
    const candidates = [
      candidate("limit", ["values", 0], "number"),
      candidate("missing", ["absent"], "number"),
    ];
    const environment = await demonstrationEnvironment({
      plan: recording,
      candidates,
      adapters: adapters(),
      workspaceDir: await directory(),
      resolvePrivate: () => ({ values: ["9"], enabled: true }),
    });
    expect(Object.keys(environment!.inputs)).toEqual([]);
  });

  it("cannot verify a whole plan when its final step was never observed", async () => {
    const recording = plan();
    recording.steps.push({
      ...structuredClone(recording.steps[0]!),
      id: "step1",
      callId: "call-1",
      dependsOn: ["step0"],
    });
    const decision = await confirmPromotedPlan({
      plan: recording,
      accepted: [],
      environment: {
        adapters: adapters(),
        workspaceDir: await directory(),
        inputs: {},
        observed: { step0: { values: [2], enabled: false } as WorkflowJsonValue },
      },
    });
    expect(decision.verification.status).toBe("incomplete");
    expect(decision.verification.reproduced).toEqual(["step0"]);
    expect(decision.verification.missed.map((entry) => entry.stepId)).toEqual(["step1"]);
  });
});
