/**
 * A harness write whose path is literal text around a value a later command also reads: the device
 * reports the composition when every recording shows it, so the plan can carry one input, not two.
 */
import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { type RecordedTurn, localCallsFor, recordSession } from "./recorded-sessions.js";

const owner = "composed-owner";

function turns(suffix: string, path: string, validated: string): RecordedTurn[] {
  return [
    { user: "Create and validate the source" },
    {
      callId: `write_${suffix}`,
      toolName: "write",
      parameters: { path, content: '{"orders":[]}' },
      result: "ok",
      metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-write" },
    },
    {
      callId: `bash_${suffix}`,
      toolName: "bash",
      parameters: { command: `python3 scripts/validate.py ${validated}`, timeout: 30 },
      result: "valid\n",
      metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-bash" },
    },
  ];
}

/** The plan recorded on `alpha`, asked about against a held-out run that wrote `heldOutPath`. */
function asked(heldOutPath: string, heldOutValidated: string) {
  const store = new InMemoryPrivateValueStore();
  const plan = recordSession(
    store,
    { workspaceId: owner, sessionId: "run-alpha", workflowId: "wf_alpha" },
    turns("alpha", "sources/alpha.json", "sources/alpha.json"),
  );
  recordSession(
    store,
    { workspaceId: owner, sessionId: "run-other", workflowId: "wf_other" },
    turns("other", heldOutPath, heldOutValidated),
  );
  const [write, validate] = plan.steps;
  const path: WorkflowBindingCandidate = {
    stepId: write!.id,
    argument: "path",
    path: [],
    proposed: { kind: "input", name: "path", type: "string" },
    reason: "native-data-argument",
  };
  const text: WorkflowBindingCandidate = {
    stepId: validate!.id,
    argument: "command",
    path: ["tokens", 2, "span", 8, 13],
    proposed: { kind: "input", name: "text", type: "string" },
    reason: "native-data-argument",
  };
  const workflow: RecordedWorkflow = {
    ...plan,
    candidates: [path, text],
    heldOut: {
      inputs: [],
      observed: [],
      calls: [
        { stepId: write!.id, callIds: ["write_other"] },
        { stepId: validate!.id, callIds: ["bash_other"] },
      ],
    },
  };
  return { store, workflow };
}

async function verdicts(heldOutPath: string, heldOutValidated: string) {
  const { store, workflow } = asked(heldOutPath, heldOutValidated);
  const answer = await createRecordingCheckValidator({
    workspaceId: owner,
    privateValues: store,
    localCalls: localCallsFor(store, owner, ["run-alpha", "run-other"]),
  })(workflow);
  expect(answer.unavailable).toBeUndefined();
  const byName = (name: string) =>
    answer.verdicts.find(
      (verdict) =>
        verdict.candidate.proposed.kind === "input" && verdict.candidate.proposed.name === name,
    );
  return { path: byName("path"), text: byName("text") };
}

describe("a harness argument composed from another input", () => {
  it("reports the literal text around the input every recording shows", async () => {
    const { path, text } = await verdicts("sources/beta.json", "sources/beta.json");
    expect(text?.confirmed).toBe(true);
    expect(path?.confirmed).toBe(true);
    expect(path?.composed).toEqual({
      parts: [{ literal: "sources/" }, { input: "text" }, { literal: ".json" }],
    });
    expect(text?.composed).toBeUndefined();
  });

  it("reports no composition when a recording's argument is other text around the value", async () => {
    const { path, text } = await verdicts("drafts/beta.json", "sources/beta.json");
    expect(text?.confirmed).toBe(true);
    expect(path?.confirmed).toBe(true);
    expect(path?.composed).toBeUndefined();
  });
});
