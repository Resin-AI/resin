import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowStep, WorkflowValueSource } from "@resin/contracts";
import { expect, it } from "vitest";
import { validateAndConfirmCandidates } from "../../src/workflow/binding-validation.js";
import { applyAcceptedBindings } from "../../src/workflow/candidate-promotion.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

function step(id: string, source: WorkflowValueSource, dependsOn: string[] = []): WorkflowStep {
  return {
    id,
    callId: `call-${id}`,
    callable: {
      name: "unfamiliar_executor",
      runtime: "resin-process",
      program: { kind: "shell", source: "", argument: "body" },
    },
    arguments: [{ name: "body", source }],
    dependsOn,
    failurePolicy: { onError: "abort", policy: "recorded" },
    observed: { outcome: "succeeded" },
  };
}

function literal(value: string): WorkflowValueSource {
  return { kind: "template", template: { type: "literal", value } };
}

it("does not let a supplied whole-source verdict replace the recorded implementation", () => {
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "immutable-program",
    inputs: [],
    steps: [step("step0", literal("printf recorded"))],
  };
  const promoted = applyAcceptedBindings(plan, [
    {
      stepId: "step0",
      argument: "body",
      path: [],
      proposed: { kind: "input", name: "replace_implementation", type: "string" },
      reason: "declared-by-the-callable",
      missing: "the executor accepts source",
    },
  ]);
  expect(promoted.inputs).toEqual([]);
  expect(promoted.steps).toEqual(plan.steps);
});

it("still verifies and executes source supplied by an earlier result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resin-produced-source-"));
  try {
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: directory }));
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "produced-program",
      inputs: [],
      steps: [
        step("step0", literal("printf '%s' 'printf fresh-result'")),
        step("step1", literal("printf old-result"), ["step0"]),
      ],
    };
    const decided = await validateAndConfirmCandidates({
      plan,
      candidates: [
        {
          stepId: "step1",
          argument: "body",
          path: [],
          proposed: { kind: "result", stepId: "step0", path: [] },
          reason: "equal-to-earlier-result",
          missing: "validate the recorded producer",
        },
      ],
      environment: {
        adapters,
        workspaceDir: directory,
        inputs: {},
        observed: { step0: "printf fresh-result", step1: "fresh-result" },
      },
    });
    expect(decided.outcomes[0]?.accepted).toBe(true);
    expect(decided.verification?.status).toBe("verified");
    expect(decided.plan.inputs).toEqual([]);
    const executed = await executeRecordedWorkflow(decided.plan, { adapters, inputs: {} });
    expect(executed.steps[1]).toMatchObject({ status: "completed", result: "fresh-result" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves an explicitly authored program input rather than banning code as data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resin-explicit-source-"));
  try {
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: directory }));
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "explicit-program",
      inputs: [{ name: "program", type: "string" }],
      steps: [step("step0", { kind: "input", name: "program" })],
    };
    const executed = await executeRecordedWorkflow(applyAcceptedBindings(plan, []), {
      adapters,
      inputs: { program: "printf intentionally-supplied" },
    });
    expect(executed.steps[0]).toMatchObject({
      status: "completed",
      result: "intentionally-supplied",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
