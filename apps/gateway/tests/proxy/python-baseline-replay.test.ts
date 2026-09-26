import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  workflowValidationPlanDigest,
} from "@resin/contracts";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "@resin/observer";
import {
  RuntimeAdapterRegistry,
  applyConfirmedWorkflowBinding,
  createProcessAdapter,
  executeRecordedWorkflow,
  recordedWorkflowInputSchema,
} from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { localCallsFor, recordSession } from "./recorded-sessions.js";

const workspaceId = "python-baseline-owner";
const SESSION = "python-baseline-session";

/** One recorded shell command and what it printed, with a single proposal on one of its tokens. */
function recording(command: string, printed: string, candidate: WorkflowBindingCandidate) {
  const privateValues = new InMemoryPrivateValueStore();
  const recorded = recordSession(
    privateValues,
    { workspaceId, sessionId: SESSION, workflowId: "baseline" },
    [
      { user: "Run the command" },
      { callId: "target-call", toolName: "bash", parameters: { command }, result: printed },
    ],
  );
  const plan: RecordedWorkflow = { ...recorded, candidates: [candidate] };
  return {
    plan,
    privateValues,
    validate: createRecordingCheckValidator({
      workspaceId,
      privateValues,
      localCalls: localCallsFor(privateValues, workspaceId, [SESSION]),
    }),
  };
}

describe("a single baseline recording", () => {
  it("confirms a program value as an optional input that keeps the recorded value when omitted", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shell-default-"));
    try {
      fs.writeFileSync(path.join(sourceRoot, "alpha.txt"), "alpha\n");
      fs.writeFileSync(path.join(sourceRoot, "bravo.txt"), "bravo\n");
      const candidate: WorkflowBindingCandidate = {
        stepId: "step0",
        argument: "command",
        path: ["tokens", 1],
        proposed: { kind: "input", name: "path", type: "string", recordedDefault: true },
        reason: "native-data-argument",
        missing: "one recording does not establish that this value varies",
      };
      const { plan, privateValues, validate } = recording("cat alpha.txt", "alpha\n", candidate);

      const result = await validate(plan);
      expect(result.verdicts.map(({ confirmed }) => confirmed)).toEqual([true]);

      // The check attests exactly the plan the cloud gets by applying the confirmed proposal.
      const promoted = applyConfirmedWorkflowBinding(plan, candidate)!;
      expect(result.verification?.replay?.planDigest).toBe(workflowValidationPlanDigest(promoted));
      expect(recordedWorkflowInputSchema(promoted)).toMatchObject({
        properties: { path: { type: "string" } },
        required: [],
      });

      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: sourceRoot }));
      const run = (inputs: Record<string, WorkflowJsonValue>) =>
        executeRecordedWorkflow(promoted, {
          inputs,
          adapters,
          access: { workspaceId },
          resolvePrivate: (reference) =>
            resolvePrivateReference(privateValues, reference) as WorkflowJsonValue,
        });
      expect((await run({})).result).toBe("alpha\n");
      expect((await run({ path: "bravo.txt" })).result).toBe("bravo\n");
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("does not use the original baseline to promote a proposed input", async () => {
    const { plan, validate } = recording("printf '%s\\n' 42", "42\n", {
      stepId: "step0",
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "input", name: "factor", type: "number" },
      reason: "varies-across-executions",
      missing: "another input must establish the binding",
    });
    const result = await validate(plan);
    expect(result.verification?.status).toBe("verified");
    expect(result.verdicts.map(({ confirmed }) => confirmed)).toEqual([false]);
    expect(plan.inputs).toEqual([]);
  });
});
