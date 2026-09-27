/**
 * How derivation steps are orchestrated around the sandbox: which inputs reach it, how its result or
 * failure becomes the step's outcome, and how binding decisions use it. The sandbox is faked here so
 * these stay fast; `pnpm test:sandbox` runs the real Deno + Pyodide sandbox.
 */
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
} from "@resin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock is hoisted above these imports, so they see the faked sandbox.
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { createProgramAdapter } from "../../src/workflow/program-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const MERCHANTS: Record<string, { account_type: string; mcc: number }> = {
  Crossfit_Hanna: { account_type: "R", mcc: 5942 },
  Golfclub_Baron_Friso: { account_type: "F", mcc: 7993 },
};

/**
 * Stands in for the sandbox. A derivation body is a tag naming what the real Python would do; the
 * merchant is read from the header the orchestration wrote, so the fake sees exactly its inputs.
 */
const sandbox = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../src/workflow/derivation-sandbox.js", () => ({
  runDerivation: async (source: string): Promise<WorkflowJsonValue> => {
    sandbox.calls.push(source);
    const merchant = /"merchant": "([^"]*)"/.exec(source.split("\n", 1)[0] ?? "")?.[1] ?? "";
    const row = MERCHANTS[merchant];
    if (source.includes("#refused-import")) throw new Error("derivation failed: ImportError: os");
    if (source.includes("#not-object"))
      throw new Error("the derivation's final expression is not a JSON object");
    if (row === undefined) throw new Error(`derivation failed: KeyError: '${merchant}'`);
    if (source.includes("#baseline-only"))
      return { account_type: merchant.startsWith("C") ? row.account_type : "Q", mcc: row.mcc };
    return { ...row };
  },
}));

beforeEach(() => {
  sandbox.calls.length = 0;
});

function adapters() {
  const registry = new RuntimeAdapterRegistry();
  registry.register(createProcessAdapter({ cwd: process.cwd() }));
  registry.register(createProgramAdapter({ cwd: process.cwd() }));
  return registry;
}

function derivation(body: string, placeholder = "", sourceInterface = "python-eval"): WorkflowStep {
  const source = derivationHeader([{ name: "merchant", value: placeholder }]) + body;
  const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
  return {
    id: "derive",
    callId: "derivation:derive",
    origin: "derivation",
    callable: {
      runtime: "resin-program",
      name: "python",
      program: {
        kind: "python",
        sourceInterface: sourceInterface as "python-eval",
        source,
        argument: "code",
      },
    },
    arguments: [
      {
        name: "code",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "python",
            source: { type: "literal", value: source },
            holes: [{ token: merchant!, binding: { type: "input", name: "merchant" } }],
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "unknown" },
  };
}

describe("running a derivation step", () => {
  it("returns the sandbox's object for the supplied input, never the recorded placeholder", async () => {
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
      steps: [derivation("#lookup\n", "Crossfit_Hanna")],
    };
    const run = await executeRecordedWorkflow(plan, {
      inputs: { merchant: "Golfclub_Baron_Friso" },
      adapters: adapters(),
    });
    expect(run.steps[0]).toMatchObject({
      status: "completed",
      result: { account_type: "F", mcc: 7993 },
    });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]).toContain('"merchant": "Golfclub_Baron_Friso"');

    // Omitting even an optional recorded-default input never runs the placeholder header.
    const omitted = await executeRecordedWorkflow(plan, { inputs: {}, adapters: adapters() });
    expect(omitted.steps[0]?.status).toBe("failed");
    expect(sandbox.calls).toHaveLength(1);
  });

  it("fails the step with the sandbox's reason", async () => {
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string" }],
      steps: [derivation("#not-object\n")],
    };
    const run = await executeRecordedWorkflow(plan, {
      inputs: { merchant: "Crossfit_Hanna" },
      adapters: adapters(),
    });
    expect(run.steps[0]?.status).toBe("failed");
    expect(run.steps[0]?.error).toMatch(/step 'derive' failed: .*not a JSON object/);
  });

  it("refuses a derivation that is not a Python Eval program without starting the sandbox", async () => {
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string" }],
      steps: [derivation("#lookup\n", "", "python-script")],
    };
    const run = await executeRecordedWorkflow(plan, {
      inputs: { merchant: "Crossfit_Hanna" },
      adapters: adapters(),
    });
    expect(run.steps[0]?.status).toBe("failed");
    expect(sandbox.calls).toHaveLength(0);
  });
});

describe("deciding derivation bindings on a held-out demonstration", () => {
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
    const registry = adapters();
    const recorded = plan(body);
    const environment = await demonstrationEnvironment({
      plan: recorded,
      candidates: recorded.candidates ?? [],
      adapters: () => registry,
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
    expect(await decide("#lookup\n")).toEqual({
      accepted: { "2": true, "3": true, "4": true },
      status: "verified",
    });
  });

  it("refutes a derivation that reproduces only the baseline", async () => {
    const decided = await decide("#baseline-only\n");
    expect(decided.accepted).toMatchObject({ "3": false });
    expect(decided.status).not.toBe("verified");
  });

  it("refutes derived values when the sandbox refuses the derivation", async () => {
    const decided = await decide("#refused-import\n");
    expect(decided.accepted).toMatchObject({ "3": false, "4": false });
  });
});
