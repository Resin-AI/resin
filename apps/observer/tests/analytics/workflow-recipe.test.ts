import type { RecordedWorkflow } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type RecordedCallObservation,
  promoteVariationToInputs,
  recordWorkflowRecipe,
} from "../../src/analytics/workflow-recipe.js";

function leaf(value: RecordedWorkflow["steps"][number]["arguments"][number]["source"]) {
  if (value.kind !== "template") throw new Error(`expected a template, got ${value.kind}`);
  return value.template;
}

/** Four calls that exist nowhere in the repository, with the origins the record establishes. */
function session(): RecordedCallObservation[] {
  return [
    {
      callId: "call_fetch",
      causalSequence: 1,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.fetch", connection: "srv_9" },
      arguments: { source: "alpha", page: 2 },
      argumentOrigins: {
        source: { type: "input", name: "source" },
        page: { type: "literal", value: 2 },
      },
      argumentTypes: { source: "string", page: "number" },
      result: { body: { rows: [{ id: "row-7" }] } },
      observed: "succeeded",
      recordedFailureControl: "abort",
    },
    {
      callId: "call_transform",
      causalSequence: 2,
      callable: { runtime: "unfamiliar-program", name: "local-transform" },
      arguments: { request: { id: "row-7", options: { mode: "full" } } },
      argumentOrigins: {
        request: {
          type: "object",
          entries: {
            id: { type: "result", stepId: "step0", path: ["body", "rows", 0, "id"] },
            options: { type: "object", entries: { mode: { type: "literal", value: "full" } } },
          },
        },
      },
      result: { stdout: "ROW-7" },
      observed: "succeeded",
    },
    {
      callId: "call_write",
      causalSequence: 3,
      callable: { runtime: "unfamiliar-program", name: "local-write" },
      arguments: { content: "ROW-7", directory: "/tmp/out" },
      argumentOrigins: {
        content: { type: "result", stepId: "step1", path: ["stdout"] },
        directory: { type: "input", name: "target" },
      },
      argumentTypes: { directory: "string" },
      result: { path: "/tmp/out/report.txt" },
      observed: "succeeded",
    },
    {
      callId: "call_upload",
      causalSequence: 4,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.upload", connection: "srv_9" },
      arguments: {
        envelope: { file: "/tmp/out/report.txt", auth: "Bearer ghp_secret_value" },
        note: "plain",
      },
      argumentOrigins: {
        envelope: {
          type: "object",
          entries: {
            file: { type: "result", stepId: "step2", path: ["path"] },
            auth: { type: "literal", value: "Bearer ghp_secret_value" },
          },
        },
        note: { type: "literal", value: "plain" },
      },
      isPrivateValue: (value) => value.includes("ghp_secret_value"),
      result: { uploaded: true },
      observed: "succeeded",
    },
  ];
}

describe("workflow recipe recording", () => {
  it("keeps recorded origins, nested leaves included, and declares typed inputs", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const [fetch, transform, write] = recipe.workflow.steps;

    expect(leaf(fetch!.arguments[0]!.source)).toEqual({ type: "input", name: "source" });
    expect(leaf(fetch!.arguments[1]!.source)).toEqual({ type: "literal", value: 2 });

    // A recursively constructed argument keeps each leaf's own origin.
    expect(leaf(transform!.arguments[0]!.source)).toEqual({
      type: "object",
      entries: {
        id: { type: "result", stepId: "step0", path: ["body", "rows", 0, "id"] },
        options: { type: "object", entries: { mode: { type: "literal", value: "full" } } },
      },
    });
    expect(transform!.dependsOn).toEqual(["step0"]);
    expect(leaf(write!.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step1",
      path: ["stdout"],
    });

    // Inputs are captured, with the types the record shows rather than "string" for everything.
    expect(recipe.workflow.inputs).toEqual([
      { name: "source", type: "string" },
      { name: "target", type: "string" },
    ]);
  });

  it("keeps a secret inside a larger string or a nested object as a private leaf", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const upload = recipe.workflow.steps[3]!;
    const envelope = leaf(upload.arguments[0]!.source);
    expect(envelope).toMatchObject({
      type: "object",
      entries: { file: { type: "result", stepId: "step2", path: ["path"] } },
    });
    const auth = (envelope as { entries: Record<string, { type: string; reference?: string }> })
      .entries.auth!;
    expect(auth.type).toBe("private");
    expect(recipe.privateValues.get(auth.reference!)).toBe("Bearer ghp_secret_value");
    // The call is recorded, not discarded, and no private text reaches the workflow.
    expect(recipe.skipped).toEqual([]);
    expect(JSON.stringify(recipe.workflow)).not.toContain("ghp_secret_value");
  });

  it("preserves an argument whose origin the record does not establish as unresolved", () => {
    const unknownOrigin = session();
    unknownOrigin[1]!.argumentOrigins = {};
    const recipe = recordWorkflowRecipe("wf_unknown", unknownOrigin)!;
    const transform = recipe.workflow.steps[1]!;
    // Not a guessed dependency, and not a frozen value either.
    expect(leaf(transform.arguments[0]!.source)).toMatchObject({ type: "object" });
    expect(JSON.stringify(leaf(transform.arguments[0]!.source))).toContain("unresolved");
    expect(transform.dependsOn).toEqual([]);
  });

  it("separates recorded control flow from the observed outcome", () => {
    const failed = session();
    failed[1]!.observed = "failed";
    const recipe = recordWorkflowRecipe("wf_failure", failed)!;
    const transform = recipe.workflow.steps[1]!;
    expect(transform.observed).toEqual({ outcome: "failed" });
    // The record did not say how failure was handled, so the choice is labelled as policy.
    expect(transform.failurePolicy).toEqual({ onError: "abort", policy: "default" });

    const recorded = session();
    recorded[1]!.observed = "failed";
    recorded[1]!.recordedFailureControl = "continue";
    const recordedRecipe = recordWorkflowRecipe("wf_failure_recorded", recorded)!;
    expect(recordedRecipe.workflow.steps[1]!.failurePolicy).toEqual({
      onError: "continue",
      policy: "recorded",
    });
  });

  it("applies a later privacy classification to values captured earlier", () => {
    const late: RecordedCallObservation[] = [
      {
        callId: "call_early",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-echo" },
        // Recorded as a plain literal: nothing marked it private at this point.
        arguments: { text: "tok_late_999" },
        argumentOrigins: { text: { type: "literal", value: "tok_late_999" } },
        result: { ok: true },
        observed: "succeeded",
      },
      {
        callId: "call_later",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-program", name: "local-check" },
        arguments: { probe: "tok_late_999" },
        argumentOrigins: { probe: { type: "literal", value: "tok_late_999" } },
        // Only this later call's processing classifies the value as private.
        isPrivateValue: (value) => value.includes("tok_late_999"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];

    const recipe = recordWorkflowRecipe("wf_late_private", late)!;
    // The earlier step no longer carries it as a literal.
    const early = recipe.workflow.steps[0]!;
    const earlyTemplate = leaf(early.arguments[0]!.source);
    expect(earlyTemplate.type).toBe("private");
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_late_999");
    expect([...recipe.privateValues.values()]).toContain("tok_late_999");
  });

  it("keeps a binding even when the value it names is private", () => {
    const bound: RecordedCallObservation[] = [
      {
        callId: "call_source",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-read" },
        arguments: { path: "in.txt" },
        argumentOrigins: { path: { type: "literal", value: "in.txt" } },
        result: { secret: "tok_bound_1" },
        observed: "succeeded",
      },
      {
        callId: "call_uses",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-program", name: "local-send" },
        arguments: { token: "tok_bound_1" },
        // The record establishes where it came from, and it is private.
        argumentOrigins: { token: { type: "result", stepId: "step0", path: ["secret"] } },
        isPrivateValue: (value) => value.includes("tok_bound_1"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_bound_private", bound)!;
    const send = recipe.workflow.steps[1]!;
    // The connection survives privacy: still the earlier result, resolved fresh at execution time.
    expect(leaf(send.arguments[0]!.source)).toEqual({
      type: "result",
      stepId: "step0",
      path: ["secret"],
    });
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_bound_1");
  });

  it("applies privacy inside a literal object and array, recursively", () => {
    const nestedLiteral: RecordedCallObservation[] = [
      {
        callId: "call_literal_composite",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-program", name: "local-call" },
        arguments: { payload: { auth: { tokens: ["plain", "tok_inner_7"] } } },
        argumentOrigins: {
          payload: { type: "literal", value: { auth: { tokens: ["plain", "tok_inner_7"] } } },
        },
        isPrivateValue: (value) => value.includes("tok_inner_7"),
        result: { ok: true },
        observed: "succeeded",
      },
    ];
    const recipe = recordWorkflowRecipe("wf_literal_composite", nestedLiteral)!;
    const payload = leaf(recipe.workflow.steps[0]!.arguments[0]!.source) as {
      type: string;
      entries: { auth: { entries: { tokens: { type: string; items: Array<{ type: string }> } } } };
    };
    expect(payload.type).toBe("object");
    expect(payload.entries.auth.entries.tokens.type).toBe("array");
    expect(payload.entries.auth.entries.tokens.items).toEqual([
      { type: "literal", value: "plain" },
      { type: "private", reference: expect.any(String) },
    ]);
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_inner_7");
    expect([...recipe.privateValues.values()]).toContain("tok_inner_7");
  });

  it("promotes values that varied between demonstrations to typed inputs", () => {
    const demonstration = (source: string, retries: number): RecordedCallObservation[] => [
      {
        callId: `call_${source}`,
        causalSequence: 1,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.fetch" },
        arguments: { source, retries },
        argumentOrigins: {
          source: { type: "literal", value: source },
          retries: { type: "literal", value: retries },
        },
        result: { body: { text: `text-${source}` } },
        observed: "succeeded",
      },
    ];

    const first = recordWorkflowRecipe("wf_variation", demonstration("alpha", 1))!;
    const second = recordWorkflowRecipe("wf_variation", demonstration("beta", 5))!;
    const promoted = promoteVariationToInputs([first, second])!;

    const step = promoted.workflow.steps[0]!;
    // Both values differed across demonstrations, so neither is a constant; their types are recorded.
    expect(leaf(step.arguments[0]!.source)).toEqual({ type: "input", name: "step0_source" });
    expect(leaf(step.arguments[1]!.source)).toEqual({ type: "input", name: "step0_retries" });
    expect(promoted.workflow.inputs).toEqual([
      { name: "step0_source", type: "string" },
      { name: "step0_retries", type: "number" },
    ]);

    // A value identical in every demonstration stays a constant.
    const stable: RecordedCallObservation[] = demonstration("alpha", 1).map((observation) => ({
      ...observation,
      arguments: { ...observation.arguments, mode: "full" },
      argumentOrigins: { ...observation.argumentOrigins, mode: { type: "literal", value: "full" } },
    }));
    const stableSecond: RecordedCallObservation[] = demonstration("beta", 5).map((observation) => ({
      ...observation,
      arguments: { ...observation.arguments, mode: "full" },
      argumentOrigins: { ...observation.argumentOrigins, mode: { type: "literal", value: "full" } },
    }));
    const stablePromoted = promoteVariationToInputs([
      recordWorkflowRecipe("wf_stable", stable)!,
      recordWorkflowRecipe("wf_stable", stableSecond)!,
    ])!;
    expect(leaf(stablePromoted.workflow.steps[0]!.arguments[2]!.source)).toEqual({
      type: "literal",
      value: "full",
    });
  });
});
