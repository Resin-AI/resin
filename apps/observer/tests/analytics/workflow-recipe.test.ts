import { describe, expect, it } from "vitest";
import {
  type RecordedCallObservation,
  recordWorkflowRecipe,
} from "../../src/analytics/workflow-recipe.js";

/**
 * A session of four calls that exist nowhere in the repository, passing fresh values between them:
 * fetch -> transform -> write -> upload.
 */
function session(): RecordedCallObservation[] {
  return [
    {
      callId: "call_fetch",
      causalSequence: 1,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.fetch", connection: "srv_9" },
      arguments: { source: "alpha", mode: "full" },
      result: { body: { rows: [{ id: "row-7", size: 12 }] } },
    },
    {
      callId: "call_transform",
      causalSequence: 2,
      callable: { runtime: "unfamiliar-program", name: "local-transform" },
      arguments: { id: "row-7", mode: "full" },
      result: { stdout: "ROW-7", exitCode: 0 },
    },
    {
      callId: "call_write",
      causalSequence: 3,
      callable: { runtime: "unfamiliar-program", name: "local-write" },
      arguments: { content: "ROW-7", directory: "/tmp/out" },
      result: { path: "/tmp/out/report.txt" },
    },
    {
      callId: "call_upload",
      causalSequence: 4,
      callable: { runtime: "unfamiliar-protocol", name: "vendor.upload", connection: "srv_9" },
      arguments: { file: "/tmp/out/report.txt", token: "ghp_secret_value" },
      maskedValues: ["ghp_secret_value"],
      result: { uploaded: true },
    },
  ];
}

describe("workflow recipe recording", () => {
  it("binds a value to the single earlier call that produced it, by nested path", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const [fetch, transform, write, upload] = recipe.workflow.steps;

    expect(fetch!.callable).toMatchObject({ runtime: "unfamiliar-protocol", name: "vendor.fetch" });
    // A value only one call produced is that call's result, addressed by path.
    expect(transform!.arguments[0]).toEqual({
      name: "id",
      source: { kind: "result", stepId: "step0", path: ["body", "rows", 0, "id"] },
    });
    expect(transform!.dependsOn).toEqual(["step0"]);
    // `mode` was a constant in every call and no call produced it: it stays a constant.
    expect(transform!.arguments[1]).toEqual({
      name: "mode",
      source: { kind: "literal", value: "full" },
    });
    expect(write!.arguments[0]?.source).toEqual({
      kind: "result",
      stepId: "step1",
      path: ["stdout"],
    });
    expect(upload!.arguments[0]?.source).toEqual({
      kind: "result",
      stepId: "step2",
      path: ["path"],
    });
  });

  it("keeps a masked value private: a local reference, never a literal in the workflow", () => {
    const recipe = recordWorkflowRecipe("wf_unfamiliar", session())!;
    const upload = recipe.workflow.steps[3]!;
    expect(upload.arguments[1]?.source).toEqual({
      kind: "private",
      reference: "private:call_upload:0",
    });
    expect(recipe.privateValues.get("private:call_upload:0")).toBe("ghp_secret_value");
    // The workflow itself carries no private value.
    expect(JSON.stringify(recipe.workflow)).not.toContain("ghp_secret_value");
    expect(recipe.workflow.privateReferences).toEqual(["private:call_upload:0"]);
  });

  it("does not bind when several steps produced the same value", () => {
    const ambiguous: RecordedCallObservation[] = [
      {
        callId: "call_earlier",
        causalSequence: 0,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.list" },
        arguments: {},
        result: { ids: ["row-7"] },
      },
      ...session(),
    ];
    const recipe = recordWorkflowRecipe("wf_ambiguous", ambiguous)!;
    // Two steps produced "row-7", so the transform's argument stays the constant it was recorded as.
    const transform = recipe.workflow.steps.find((step) => step.callId === "call_transform")!;
    expect(transform.arguments[0]?.source).toEqual({ kind: "literal", value: "row-7" });
    expect(transform.dependsOn).toEqual([]);
  });

  it("counts one execution once and preserves a recorded failure as failure behavior", () => {
    const withFailure = session();
    withFailure[1]!.failed = true;
    // A redelivery of the same execution must not become a second step.
    const recipe = recordWorkflowRecipe("wf_redelivery", [...withFailure, { ...withFailure[2]! }])!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual([
      "call_fetch",
      "call_transform",
      "call_write",
      "call_upload",
    ]);
    expect(recipe.workflow.steps[1]!.failure).toBe("continue");
  });

  it("never emits a masked value nested inside a composite argument", () => {
    const nested: RecordedCallObservation[] = [
      {
        callId: "call_nested_secret",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.call" },
        arguments: { headers: { auth: "tok_live_123" }, body: { id: "row-7" } },
        maskedValues: ["tok_live_123"],
        result: { ok: true },
      },
      {
        callId: "call_after",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.follow" },
        arguments: { ok: "true" },
        result: { ok: true },
      },
    ];
    const recipe = recordWorkflowRecipe("wf_nested_secret", nested)!;

    // The call carrying the nested private value is reported as unrepresentable, not recorded.
    expect(recipe.skipped).toEqual([
      {
        callId: "call_nested_secret",
        reason: "argument 'headers' contains a masked value the workflow cannot carry",
      },
    ]);
    const carried = JSON.stringify(recipe.workflow);
    expect(carried).not.toContain("tok_live_123");
    expect(carried).not.toContain("headers");
    // The representable call is still recorded.
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["call_after"]);
  });

  it("does not let a value masked in one call reappear as a literal in another", () => {
    const crossCall: RecordedCallObservation[] = [
      {
        callId: "call_masks",
        causalSequence: 1,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.login" },
        arguments: { user: "dev" },
        maskedValues: ["tok_from_login"],
        result: { token: "tok_from_login" },
      },
      {
        callId: "call_reuses",
        causalSequence: 2,
        callable: { runtime: "unfamiliar-protocol", name: "vendor.echo" },
        arguments: { headers: { auth: "tok_from_login" } },
        result: { ok: true },
      },
    ];
    const recipe = recordWorkflowRecipe("wf_cross_call", crossCall)!;
    expect(recipe.skipped.map((entry) => entry.callId)).toEqual(["call_reuses"]);
    expect(JSON.stringify(recipe.workflow)).not.toContain("tok_from_login");
  });
});
