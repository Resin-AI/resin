import type { RecordedWorkflow, WorkflowValueTemplate } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type RecordedCallRequest,
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const SECRET = "sk-live-abc123XYZ";
const ORIGINAL = `curl -H 'Authorization: Bearer ${SECRET}' https://x/y --out data/a.json`;
const SCRUBBED =
  "curl -H 'Authorization: Bearer [REDACTED_SECRET:adaeb600]' https://x/y --out data/a.json";
const REFERENCE = "private:v2:value:original-command";

function shellWorkflow(holes: Array<{ token: number; binding: WorkflowValueTemplate }>) {
  const template: WorkflowValueTemplate = {
    type: "program",
    language: "shell",
    source: { type: "literal", value: SCRUBBED },
    sourceReference: REFERENCE,
    protectedTokens: [2],
    holes,
  };
  const workflow: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf_shell_projection",
    inputs: [{ name: "out", type: "string" }],
    privateReferences: [REFERENCE],
    steps: [
      {
        id: "fetch",
        callId: "exec-shell-projection",
        callable: {
          runtime: "resin-process",
          name: "command_exec",
          program: { kind: "shell", source: SCRUBBED, argument: "cmd" },
        },
        arguments: [{ name: "cmd", source: { kind: "template", template } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
  return workflow;
}

function processAdapter(calls: RecordedCallRequest[]) {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: "resin-process",
    async call(request) {
      calls.push(request);
      return { stdout: "ok\n", exitCode: 0 };
    },
  });
  return registry;
}

describe("projected shell command execution", () => {
  it("renders a bound token into the original command, keeping the redacted credential", async () => {
    const calls: RecordedCallRequest[] = [];
    const result = await executeRecordedWorkflow(
      shellWorkflow([{ token: 5, binding: { type: "input", name: "out" } }]),
      {
        inputs: { out: "data/b.json" },
        adapters: processAdapter(calls),
        resolvePrivate: (reference) => (reference === REFERENCE ? ORIGINAL : undefined),
      },
    );
    expect(result.status).toBe("completed");
    expect(calls[0]?.arguments.cmd).toBe(
      `curl -H 'Authorization: Bearer ${SECRET}' https://x/y --out data/b.json`,
    );
  });

  it("refuses to run when the original no longer matches the projection's shape", async () => {
    const calls: RecordedCallRequest[] = [];
    const result = await executeRecordedWorkflow(
      shellWorkflow([{ token: 5, binding: { type: "input", name: "out" } }]),
      {
        inputs: { out: "data/b.json" },
        adapters: processAdapter(calls),
        resolvePrivate: () => `curl -H 'Authorization: Bearer ${SECRET}' https://x/y`,
      },
    );
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});
