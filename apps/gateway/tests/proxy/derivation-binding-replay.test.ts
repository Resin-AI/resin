/**
 * A recorded report command hard-codes values an agent looked up for one merchant (its account type
 * and category code). A model-written derivation computes them from the merchant; one baseline
 * recording must be enough to confirm it by a real Python replay, and anything that merely repeats
 * the recording (hard-coded values), computes something else, or ignores the inputs is refuted.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
  validateRecordedWorkflow,
} from "@resin/contracts";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "@resin/observer";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RuntimeAdapterRegistry,
  applyAcceptedBindings,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  instantiateRecordedWorkflow,
} from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkflowValidator } from "../../src/proxy/workflow-validation.js";

const owner = "derivation-binding-owner";

const MERCHANTS = {
  Crossfit_Hanna: { account_type: "R", mcc: 5942 },
  Golfclub_Baron_Friso: { account_type: "F", mcc: 7993 },
};

const RECORDED_COMMAND = "printf '%s %s %s\\n' Crossfit_Hanna R 5942";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  writeFileSync(path.join(directory, "merchants.json"), JSON.stringify(MERCHANTS));
  return directory;
}

/** The body a model writes after the header; the header's merchant literal is a caller-input hole. */
const LOOKUP =
  'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n';

function derivation(body: string, bindInput = true): WorkflowStep {
  // The cloud does not know the recorded merchant, so the header carries a placeholder.
  const source = derivationHeader([{ name: "merchant", value: "" }]) + body;
  const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
  return {
    id: "derive",
    callId: "derivation:derive",
    origin: "derivation",
    callable: {
      runtime: RESIN_PROGRAM_RUNTIME,
      name: "python",
      program: { kind: "python", sourceInterface: "python-eval", source, argument: "code" },
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
            holes: bindInput
              ? [{ token: merchant!, binding: { type: "input", name: "merchant" } }]
              : [],
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "unknown" },
  };
}

function tokenCandidate(
  token: number,
  proposed: WorkflowBindingCandidate["proposed"],
  reason: WorkflowBindingCandidate["reason"],
): WorkflowBindingCandidate {
  return {
    stepId: "report",
    argument: "command",
    path: ["tokens", token],
    proposed,
    reason,
    missing: "whether the token follows the caller's merchant",
  };
}

/** The recorded report plus one derivation, as the cloud proposes it; recorded values stay local. */
function recording(store: InMemoryPrivateValueStore, body: string, bindInput = true) {
  const printed = "Crossfit_Hanna R 5942\n";
  store.set("private:report-command", RECORDED_COMMAND, { workspaceId: owner });
  store.set("private:report-output", printed, { workspaceId: owner });
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf_merchant_report",
    inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
    privateReferences: ["private:report-command", "private:report-output"],
    steps: [
      derivation(body, bindInput),
      {
        id: "report",
        callId: "call_report",
        callable: {
          runtime: RESIN_PROCESS_RUNTIME,
          name: "bash",
          program: { kind: "shell", source: "", argument: "command" },
        },
        arguments: [
          { name: "command", source: { kind: "private", reference: "private:report-command" } },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded", output: { type: "string", hasContent: true } },
      },
    ],
    candidates: [
      tokenCandidate(
        2,
        { kind: "input", name: "merchant", type: "string", recordedDefault: true },
        "classified-source-value",
      ),
      tokenCandidate(
        3,
        { kind: "result", stepId: "derive", path: ["account_type"] },
        "derived-from-inputs",
      ),
      tokenCandidate(4, { kind: "result", stepId: "derive", path: ["mcc"] }, "derived-from-inputs"),
    ],
    baseline: {
      inputs: [{ stepId: "report", argument: "command", reference: "private:report-command" }],
      observed: [{ stepId: "report", reference: "private:report-output" }],
    },
  };
  return plan;
}

async function validate(plan: RecordedWorkflow, store: InMemoryPrivateValueStore) {
  return await createLocalWorkflowValidator({
    workspaceId: owner,
    privateValues: store,
    workspaceDir: workspace("resin-derive-replay-"),
    timeoutMs: 20_000,
  })(plan);
}

function verdictsByPath(answer: Awaited<ReturnType<typeof validate>>): Record<string, boolean> {
  return Object.fromEntries(
    answer.verdicts.map((verdict) => [String(verdict.candidate.path[1]), verdict.confirmed]),
  );
}

describe("derivation bindings confirmed by a baseline replay", () => {
  it("confirms a lookup derivation, and the promoted tool computes another merchant's values", async () => {
    const store = new InMemoryPrivateValueStore();
    const plan = recording(store, LOOKUP);
    expect(validateRecordedWorkflow(plan).errors).toEqual([]);
    // No recorded value is carried by the plan the cloud sees.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("Crossfit_Hanna");
    expect(serialized).not.toContain("5942");

    const answer = await validate(plan, store);
    expect(answer.verification?.status).toBe("verified");
    expect(verdictsByPath(answer)).toEqual({ "2": true, "3": true, "4": true });

    const accepted = (plan.candidates ?? []).filter((candidate) =>
      answer.verdicts.some(
        (verdict) =>
          verdict.confirmed &&
          verdict.candidate.path[1] === candidate.path[1] &&
          verdict.candidate.stepId === candidate.stepId,
      ),
    );
    const promoted = applyAcceptedBindings(plan, accepted);
    expect(validateRecordedWorkflow(promoted).errors).toEqual([]);
    const consumerDir = workspace("resin-derive-consumer-");
    const adapters = new RuntimeAdapterRegistry();
    adapters.register(createProcessAdapter({ cwd: consumerDir }));
    adapters.register(createProgramAdapter({ cwd: consumerDir }));
    const tool = instantiateRecordedWorkflow(compileRecordedWorkflow(promoted), {
      adapters,
      access: { workspaceId: owner },
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
    });
    const other = await tool.invoke({ merchant: "Golfclub_Baron_Friso" });
    expect(other.status, other.error).toBe("completed");
    expect(JSON.stringify(other.result)).toContain("Golfclub_Baron_Friso F 7993");
    const recorded = await tool.invoke({ merchant: "Crossfit_Hanna" });
    expect(JSON.stringify(recorded.result)).toContain("Crossfit_Hanna R 5942");
  });

  it("refutes a derivation that hard-codes a recorded value", async () => {
    const store = new InMemoryPrivateValueStore();
    const hardCoded =
      'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": "R", "mcc": m["mcc"]}\n';
    const answer = await validate(recording(store, hardCoded), store);
    // The whole derivation is refuted, including the binding it computes honestly.
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });

  it("refutes a derived value that does not reproduce the recorded token", async () => {
    const store = new InMemoryPrivateValueStore();
    const wrong =
      'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"].lower(), "mcc": m["mcc"] + 1}\n';
    const answer = await validate(recording(store, wrong), store);
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });

  it("accepts only the derived values that reproduce, from a step that ran", async () => {
    const store = new InMemoryPrivateValueStore();
    const partly =
      'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"] + 1}\n';
    const answer = await validate(recording(store, partly), store);
    expect(verdictsByPath(answer)).toEqual({ "2": true, "3": true, "4": false });
    expect(answer.verification?.status).toBe("verified");
  });

  it("refutes a derivation that reads no caller input", async () => {
    const store = new InMemoryPrivateValueStore();
    const answer = await validate(recording(store, LOOKUP, false), store);
    expect(verdictsByPath(answer)).toMatchObject({ "3": false, "4": false });
  });
});
