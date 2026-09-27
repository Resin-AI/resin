/**
 * Derivation steps run as Python in Pyodide inside Deno and see only their inputs: their result is
 * the JSON object of the final expression, their inputs are always required, and a binding to their
 * output is accepted only when the derivation reproduces the recorded token on every demonstration —
 * held-out included.
 */
import type {
  RecordedWorkflow,
  WorkflowBindingCandidate,
  WorkflowJsonValue,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { executeRecordedWorkflow } from "../../src/workflow/recorded-workflow.js";
import { LOOKUP, TABLE, derivation, removeDirectories, workspace } from "./derivation-fixtures.js";

afterEach(removeDirectories);

describe("running a derivation step", { timeout: 60_000 }, () => {
  it("returns the final expression as a JSON object computed from the supplied input", async () => {
    const { adapters } = workspace();
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
      // A header literal that would run fine: only the required-input rule stops it.
      steps: [derivation(LOOKUP, "Crossfit_Hanna")],
    };
    const run = await executeRecordedWorkflow(plan, {
      inputs: { merchant: "Golfclub_Baron_Friso" },
      adapters,
    });
    expect(run.steps[0]).toMatchObject({
      status: "completed",
      result: { account_type: "F", mcc: 7993 },
    });
    // Omitting even an optional recorded-default input never runs the model's placeholder header.
    const omitted = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(omitted.steps[0]?.status).toBe("failed");
  });

  it("fails when the final expression is not a JSON object", async () => {
    const { adapters } = workspace();
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string" }],
      steps: [derivation('print("R")\ninputs["merchant"]\n')],
    };
    const run = await executeRecordedWorkflow(plan, { inputs: { merchant: "x" }, adapters });
    expect(run.steps[0]?.status).toBe("failed");
  });
});

describe("deciding derivation bindings on a held-out demonstration", { timeout: 60_000 }, () => {
  const values: Record<string, WorkflowJsonValue> = {
    "private:base-cmd": "printf '%s %s %s\\n' Crossfit_Hanna R 5942",
    "private:base-out": "Crossfit_Hanna R 5942\n",
    "private:held-cmd": "printf '%s %s %s\\n' Golfclub_Baron_Friso F 7993",
    "private:held-out": "Golfclub_Baron_Friso F 7993\n",
  };

  function plan(body: string): RecordedWorkflow {
    const candidate = (
      token: number,
      proposed: WorkflowBindingCandidate["proposed"],
      reason: WorkflowBindingCandidate["reason"],
    ): WorkflowBindingCandidate => ({
      stepId: "report",
      argument: "command",
      path: ["tokens", token],
      proposed,
      reason,
      missing: "whether the token follows the merchant",
    });
    return {
      schemaVersion: 1,
      workflowId: "wf_report",
      inputs: [{ name: "merchant", type: "string" }],
      privateReferences: Object.keys(values),
      steps: [
        derivation(body),
        {
          id: "report",
          callId: "call_report",
          callable: {
            runtime: "resin-process",
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            { name: "command", source: { kind: "private", reference: "private:base-cmd" } },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
      candidates: [
        candidate(
          2,
          { kind: "input", name: "merchant", type: "string" },
          "varies-across-executions",
        ),
        candidate(
          3,
          { kind: "result", stepId: "derive", path: ["account_type"] },
          "derived-from-inputs",
        ),
        candidate(4, { kind: "result", stepId: "derive", path: ["mcc"] }, "derived-from-inputs"),
      ],
      baseline: {
        inputs: [{ stepId: "report", argument: "command", reference: "private:base-cmd" }],
        observed: [{ stepId: "report", reference: "private:base-out" }],
      },
      heldOut: {
        inputs: [{ stepId: "report", argument: "command", reference: "private:held-cmd" }],
        observed: [{ stepId: "report", reference: "private:held-out" }],
      },
    };
  }

  async function decide(body: string) {
    const { dir, adapters } = workspace();
    const recorded = plan(body);
    const environment = await demonstrationEnvironment({
      plan: recorded,
      candidates: recorded.candidates ?? [],
      adapters: () => adapters,
      resolvePrivate: (reference) => values[reference]!,
    });
    const decided = await validateAndConfirmCandidates({
      plan: recorded,
      candidates: recorded.candidates ?? [],
      environment: environment!,
    });
    return {
      accepted: Object.fromEntries(
        decided.outcomes.map((outcome) => [String(outcome.candidate.path[1]), outcome.accepted]),
      ),
      status: decided.verification?.status,
    };
  }

  it("accepts a derivation that reproduces both demonstrations", async () => {
    expect(await decide(LOOKUP)).toEqual({
      accepted: { "2": true, "3": true, "4": true },
      status: "verified",
    });
  });

  it("refutes a derivation that reproduces only the baseline", async () => {
    // Right for the recorded merchant, wrong for the held-out one, with no recorded literal in it.
    const baselineOnly = `${TABLE}m = merchants[inputs["merchant"]]\n{"account_type": m["account_type"] if inputs["merchant"].startswith("C") else "Q", "mcc": m["mcc"]}\n`;
    const decided = await decide(baselineOnly);
    // The plan without the refuted token cannot reproduce the held-out run, so nothing is carried.
    expect(decided.accepted).toMatchObject({ "3": false });
    expect(decided.status).not.toBe("verified");
  });

  it("refutes a correct derivation that also reaches for a refused module", async () => {
    const escaping = `try:\n    import os\nexcept BaseException:\n    pass\n${LOOKUP}`;
    const decided = await decide(escaping);
    expect(decided.accepted).toMatchObject({ "3": false, "4": false });
  });
});
