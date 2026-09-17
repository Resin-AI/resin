import type { RecordedWorkflow } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type RecordedCallRequest,
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../src/workflow/recorded-workflow.js";

/**
 * Four unfamiliar callables reached over two unknown runtime families. Nothing here is recognised:
 * the adapters implement communication and execution, and the registry is keyed by runtime family.
 */
function adapters(recorded: Array<RecordedCallRequest>) {
  const registry = new RuntimeAdapterRegistry();
  registry.register({
    runtime: "unknown-protocol",
    call: async (request) => {
      recorded.push(request);
      const name = request.step.callable.name;
      if (name === "vendor.fetch") {
        return { body: { rows: [`fresh-${request.arguments.source}`, "second"] } };
      }
      if (name === "vendor.upload") {
        return { uploaded: true, file: request.arguments.file, token: request.arguments.token };
      }
      throw new Error(`unknown callable ${name}`);
    },
  });
  registry.register({
    runtime: "unknown-program",
    call: async (request) => {
      recorded.push(request);
      const content = String(request.arguments.stdin ?? "");
      if (request.step.callable.name === "local-transform") {
        return { stdout: `${content.toUpperCase()}` };
      }
      return { path: String(request.arguments.path) };
    },
  });
  return registry;
}

function workflow(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_four_unfamiliar_calls",
    inputs: [{ name: "source" }, { name: "target" }],
    privateReferences: ["secret:upload-token"],
    steps: [
      {
        id: "fetch",
        callId: "call_1",
        callable: { runtime: "unknown-protocol", name: "vendor.fetch", connection: "srv_1" },
        arguments: [{ name: "source", source: { kind: "input", name: "source" } }],
        dependsOn: [],
        failure: "abort",
      },
      {
        id: "transform",
        callId: "call_2",
        callable: { runtime: "unknown-program", name: "local-transform" },
        arguments: [
          { name: "stdin", source: { kind: "result", stepId: "fetch", path: ["body", "rows", 0] } },
        ],
        dependsOn: ["fetch"],
        failure: "abort",
      },
      {
        id: "write",
        callId: "call_3",
        callable: { runtime: "unknown-program", name: "local-write" },
        arguments: [
          { name: "path", source: { kind: "input", name: "target" } },
          { name: "content", source: { kind: "result", stepId: "transform", path: ["stdout"] } },
        ],
        dependsOn: ["transform"],
        failure: "abort",
      },
      {
        id: "upload",
        callId: "call_4",
        callable: { runtime: "unknown-protocol", name: "vendor.upload", connection: "srv_1" },
        arguments: [
          { name: "file", source: { kind: "result", stepId: "write", path: ["path"] } },
          { name: "token", source: { kind: "private", reference: "secret:upload-token" } },
        ],
        dependsOn: ["write"],
        failure: "abort",
      },
    ],
  };
}

describe("recorded workflow execution", () => {
  it("runs a four-call workflow of unfamiliar callables and passes fresh results along", async () => {
    const calls: RecordedCallRequest[] = [];
    const first = await executeRecordedWorkflow(workflow(), {
      inputs: { source: "alpha", target: "/tmp/one.txt" },
      adapters: adapters(calls),
      resolvePrivate: () => "token-from-environment",
    });

    expect(first.status).toBe("completed");
    expect(first.steps.map((outcome) => outcome.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // The transform ran on the value this invocation fetched, not on a recorded one.
    expect(calls[1]?.arguments.stdin).toBe("fresh-alpha");
    expect(calls[2]?.arguments.content).toBe("FRESH-ALPHA");
    // The upload carried the file this invocation wrote and the locally resolved private value.
    expect(calls[3]?.arguments.file).toBe("/tmp/one.txt");
    expect(calls[3]?.arguments.token).toBe("token-from-environment");

    // A second invocation with different inputs produces different intermediate values.
    const secondCalls: RecordedCallRequest[] = [];
    await executeRecordedWorkflow(workflow(), {
      inputs: { source: "beta", target: "/tmp/two.txt" },
      adapters: adapters(secondCalls),
      resolvePrivate: () => "other-token",
    });
    expect(secondCalls[1]?.arguments.stdin).toBe("fresh-beta");
    expect(secondCalls[3]?.arguments.file).toBe("/tmp/two.txt");
  });

  it("keeps recorded failure behavior and reports a missing adapter explicitly", async () => {
    const calls: RecordedCallRequest[] = [];
    const partial = workflow();
    partial.steps[1]!.failure = "continue";
    partial.steps[1]!.callable = {
      runtime: "runtime-that-is-not-reachable",
      name: "vendor.transform",
    };

    const result = await executeRecordedWorkflow(partial, {
      inputs: { source: "alpha", target: "/tmp/one.txt" },
      adapters: adapters(calls),
      resolvePrivate: () => "token",
    });

    expect(result.steps[1]).toMatchObject({ status: "failed" });
    // The recorded control flow continued, and the step that read the failed step's result was not
    // called with a fabricated value.
    expect(result.steps[2]).toMatchObject({ status: "skipped" });
    expect(result.steps[3]).toMatchObject({ status: "skipped" });
    expect(calls).toHaveLength(1);
  });

  it("fails explicitly instead of inventing a value the recording never had", async () => {
    const calls: RecordedCallRequest[] = [];
    const missingTarget = workflow();
    missingTarget.steps[2]!.arguments = [
      { name: "path", source: { kind: "result", stepId: "fetch", path: ["body", "absent"] } },
    ];

    const result = await executeRecordedWorkflow(missingTarget, {
      inputs: { source: "alpha", target: "/tmp/one.txt" },
      adapters: adapters(calls),
      resolvePrivate: () => "token",
    });
    expect(result.status).toBe("failed");
    expect(result.steps[2]).toMatchObject({ status: "failed" });
    expect(String((result.steps[2] as { error: string }).error)).toContain("no value at path");
  });
});
