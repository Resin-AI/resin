import type { RecordedWorkflow, WorkflowValueTemplate } from "@resin/contracts";

const asTemplate = (template: WorkflowValueTemplate) => ({ kind: "template" as const, template });
const literal = (value: string | number): WorkflowValueTemplate => ({ type: "literal", value });
const resultOf = (stepId: string, path: Array<string | number>): WorkflowValueTemplate => ({
  type: "result",
  stepId,
  path,
});
const input = (name: string): WorkflowValueTemplate => ({ type: "input", name });
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
        const text = String((request.arguments.stdin as { text?: unknown })?.text ?? "");
        return { stdout: text.toUpperCase() };
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
    inputs: [
      { name: "source", type: "string" },
      { name: "target", type: "string" },
    ],
    privateReferences: ["secret:upload-token"],
    steps: [
      {
        id: "fetch",
        callId: "call_1",
        callable: { runtime: "unknown-protocol", name: "vendor.fetch", connection: "srv_1" },
        arguments: [{ name: "source", source: asTemplate(input("source")) }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "transform",
        callId: "call_2",
        callable: { runtime: "unknown-program", name: "local-transform" },
        arguments: [
          {
            name: "stdin",
            source: asTemplate({
              type: "object",
              entries: {
                text: resultOf("fetch", ["body", "rows", 0]),
                depth: literal(1),
              },
            }),
          },
        ],
        dependsOn: ["fetch"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "write",
        callId: "call_3",
        callable: { runtime: "unknown-program", name: "local-write" },
        arguments: [
          { name: "path", source: asTemplate(input("target")) },
          { name: "content", source: asTemplate(resultOf("transform", ["stdout"])) },
        ],
        dependsOn: ["transform"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "upload",
        callId: "call_4",
        callable: { runtime: "unknown-protocol", name: "vendor.upload", connection: "srv_1" },
        arguments: [
          { name: "file", source: asTemplate(resultOf("write", ["path"])) },
          {
            name: "token",
            source: asTemplate({ type: "private", reference: "secret:upload-token" }),
          },
        ],
        dependsOn: ["write"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
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
    expect(calls[1]?.arguments.stdin).toEqual({ text: "fresh-alpha", depth: 1 });
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
    expect(secondCalls[1]?.arguments.stdin).toEqual({ text: "fresh-beta", depth: 1 });
    expect(secondCalls[3]?.arguments.file).toBe("/tmp/two.txt");
  });

  it("keeps recorded failure behavior and reports a missing adapter explicitly", async () => {
    const calls: RecordedCallRequest[] = [];
    const partial = workflow();
    partial.steps[1]!.failurePolicy = { onError: "continue", policy: "recorded" };
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
      { name: "path", source: asTemplate(resultOf("fetch", ["body", "absent"])) },
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

  it("refuses an argument whose origin the record does not establish", async () => {
    const calls: RecordedCallRequest[] = [];
    const unresolvedRun = workflow();
    unresolvedRun.steps[0]!.arguments = [
      {
        name: "source",
        source: asTemplate({
          type: "unresolved",
          reason: "the record does not establish this origin",
        }),
      },
    ];

    const result = await executeRecordedWorkflow(unresolvedRun, {
      inputs: { source: "alpha", target: "/tmp/one.txt" },
      adapters: adapters(calls),
      resolvePrivate: () => "token",
    });
    expect(result.status).toBe("failed");
    expect(String((result.steps[0] as { error: string }).error)).toContain(
      "origin of this value was not recorded",
    );
    // Nothing was invented to make it run.
    expect(calls).toHaveLength(0);
  });
  it("hands the workspace access context to the private resolver on every reference", async () => {
    const calls: RecordedCallRequest[] = [];
    const seen: Array<{ reference: string; workspaceId?: string }> = [];
    const result = await executeRecordedWorkflow(workflow(), {
      inputs: { source: "alpha", target: "/tmp/one.txt" },
      adapters: adapters(calls),
      access: { workspaceId: "ws_recording" },
      resolvePrivate: (reference, access) => {
        seen.push({
          reference,
          ...(access?.workspaceId ? { workspaceId: access.workspaceId } : {}),
        });
        return "token-from-environment";
      },
    });
    expect(result.status).toBe("completed");
    // The host receives the reference together with the workspace the invocation runs in, so it
    // can refuse a reference recorded elsewhere instead of resolving it from the string alone.
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) {
      expect(entry.reference.length).toBeGreaterThan(0);
      expect(entry.workspaceId).toBe("ws_recording");
    }
  });
});
