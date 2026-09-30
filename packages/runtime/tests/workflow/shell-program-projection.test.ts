import {
  type RecordedWorkflow,
  type WorkflowValueTemplate,
  analyzeProgramSourceProjection,
  embeddedPrograms,
} from "@resin/contracts";
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

describe("projected program embedding a secret", () => {
  // nextjs-performance: one endpoint of the list is a secret; the others are the job's inputs.
  const secretValue = "/internal/7ffcc398bd861a0cQzL";
  const shape = (value: string) =>
    `node - <<'NODE'\nconst endpoints=['/dispatch/summary?site=RNO1','${value}','/shipments/dock-windows?site=RNO1'];\nconsole.log(endpoints)\nNODE`;
  const original = shape(secretValue);
  const sanitized = shape("[REDACTED_HIGH_ENTROPY_SECRET:7ffcc398bd861a0c]");
  const { protectedTokens } = analyzeProgramSourceProjection("shell", original, sanitized);
  const program = embeddedPrograms(sanitized)[0]!;
  const at = (raw: string) => program.tokens.findIndex((token) => token.raw === raw);

  function workflow(embedded: number): RecordedWorkflow {
    const template: WorkflowValueTemplate = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: sanitized },
      sourceReference: REFERENCE,
      protectedTokens,
      holes: [{ token: program.anchor, embedded, binding: { type: "input", name: "path" } }],
    };
    return {
      ...shellWorkflow([]),
      inputs: [{ name: "path", type: "string" }],
      steps: [
        {
          ...shellWorkflow([]).steps[0]!,
          callable: {
            runtime: "resin-process",
            name: "command_exec",
            program: { kind: "shell", source: sanitized, argument: "cmd" },
          },
          arguments: [{ name: "cmd", source: { kind: "template", template } }],
        },
      ],
    };
  }

  const run = async (embedded: number) => {
    const calls: RecordedCallRequest[] = [];
    const result = await executeRecordedWorkflow(workflow(embedded), {
      inputs: { path: "/shipments/carriers?site=RNO2" },
      adapters: processAdapter(calls),
      resolvePrivate: (reference) => (reference === REFERENCE ? original : undefined),
    });
    return { result, calls };
  };

  it("binds a path beside the secret and runs the original with the secret intact", async () => {
    const { result, calls } = await run(at("'/shipments/dock-windows?site=RNO1'"));
    expect(result.status).toBe("completed");
    expect(calls[0]?.arguments.cmd).toBe(
      original.replace("/shipments/dock-windows?site=RNO1", "/shipments/carriers?site=RNO2"),
    );
  });

  it("refuses a hole on the secret's own token", async () => {
    const { result, calls } = await run(at("'[REDACTED_HIGH_ENTROPY_SECRET:7ffcc398bd861a0c]'"));
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});
