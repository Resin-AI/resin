import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { expect, it } from "vitest";
import { validateAndConfirmCandidates } from "../../src/workflow/binding-validation.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

it.each([false, true])(
  "keeps a legacy whole-source proposal out of data-token validation (source first: %s)",
  async (sourceFirst) => {
    const directory = await mkdtemp(join(tmpdir(), "resin-source-vs-data-"));
    try {
      const adapters = new RuntimeAdapterRegistry();
      adapters.register(createProcessAdapter({ cwd: directory }));
      const plan: RecordedWorkflow = {
        schemaVersion: 1,
        workflowId: "source-is-implementation",
        inputs: [],
        steps: [
          {
            id: "step0",
            callId: "original-call",
            callable: {
              name: "unfamiliar_executor",
              runtime: "resin-process",
              program: { kind: "shell", source: "", argument: "payload" },
            },
            arguments: [
              {
                name: "payload",
                source: {
                  kind: "template",
                  template: { type: "literal", value: "printf '%s' 'alpha'" },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "recorded" },
            observed: { outcome: "succeeded" },
          },
        ],
      };
      const source: WorkflowBindingCandidate = {
        stepId: "step0",
        argument: "payload",
        path: [],
        proposed: { kind: "input", name: "whole_program", type: "string" },
        reason: "declared-by-the-callable",
        missing: "the executor accepts source text",
      };
      const data: WorkflowBindingCandidate = {
        stepId: "step0",
        argument: "payload",
        path: ["tokens", 2],
        proposed: { kind: "input", name: "value", type: "string" },
        reason: "varies-across-executions",
        missing: "the repeated task varied this value",
      };
      const decided = await validateAndConfirmCandidates({
        plan,
        candidates: sourceFirst ? [source, data] : [data, source],
        environment: {
          adapters,
          workspaceDir: directory,
          inputs: { whole_program: "printf '%s' 'bravo'", value: "bravo" },
          observed: { step0: "bravo" },
        },
      });
      expect(decided.outcomes.find((entry) => entry.candidate === source)?.accepted).toBe(false);
      expect(decided.outcomes.find((entry) => entry.candidate === data)?.accepted).toBe(true);
      expect(decided.plan.inputs).toEqual([{ name: "value", type: "string" }]);
      expect(decided.verification?.status).toBe("verified");
      const result = await executeRecordedWorkflow(decided.plan, {
        adapters,
        inputs: { value: "new path's data; $(literal)" },
      });
      expect(result.steps[0]).toMatchObject({
        status: "completed",
        result: "new path's data; $(literal)",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
