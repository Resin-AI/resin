import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowStep, WorkflowValueSource } from "@resin/contracts";
import { expect, it } from "vitest";
import { validateAndConfirmCandidates } from "../../src/workflow/binding-validation.js";
import {
  applyAcceptedBindings,
  applyConfirmedWorkflowBinding,
} from "../../src/workflow/candidate-promotion.js";
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

it("promotes confirmed scalar and nested literal inputs without changing neighboring values", () => {
  const plain = (id: string, value: WorkflowValueSource): WorkflowStep => ({
    ...step(id, value),
    callable: { name: "ordinary_tool", runtime: "resin-tool-protocol" },
    arguments: [{ name: "payload", source: value }],
  });
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "literal-bindings",
    inputs: [],
    steps: [
      plain("zero", { kind: "literal", value: 0 }),
      plain("false", { kind: "literal", value: false }),
      plain("nested", { kind: "literal", value: { selected: false, unchanged: "keep" } }),
    ],
  };
  const candidates = [
    {
      stepId: "zero",
      argument: "payload",
      path: [],
      proposed: { kind: "input", name: "amount", type: "number" },
      reason: "confirmed",
      missing: "replay",
    },
    {
      stepId: "false",
      argument: "payload",
      path: [],
      proposed: { kind: "input", name: "enabled", type: "boolean" },
      reason: "confirmed",
      missing: "replay",
    },
    {
      stepId: "nested",
      argument: "payload",
      path: ["selected"],
      proposed: { kind: "input", name: "selected", type: "boolean" },
      reason: "confirmed",
      missing: "replay",
    },
  ] as const;
  const promoted = applyAcceptedBindings(plan, candidates);
  expect(promoted.inputs.map((input) => input.name)).toEqual(["amount", "enabled", "selected"]);
  expect(promoted.steps.map((entry) => entry.arguments[0]?.source)).toEqual([
    { kind: "template", template: { type: "input", name: "amount" } },
    { kind: "template", template: { type: "input", name: "enabled" } },
    {
      kind: "template",
      template: {
        type: "object",
        entries: {
          selected: { type: "input", name: "selected" },
          unchanged: { type: "literal", value: "keep" },
        },
      },
    },
  ]);
  expect(plan.steps[0]?.arguments[0]?.source).toEqual({ kind: "literal", value: 0 });
  expect(
    applyConfirmedWorkflowBinding(promoted, {
      ...candidates[0],
      stepId: "absent",
    }),
  ).toBeUndefined();
  expect(
    applyConfirmedWorkflowBinding(promoted, {
      ...candidates[0],
      proposed: { kind: "input", name: "amount", type: "string" },
    }),
  ).toBeUndefined();
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
