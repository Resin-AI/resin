import type { RecordedWorkflow, WorkflowValueTemplate } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  RecordedWorkflowCompilationError,
  compileRecordedWorkflow,
  instantiateRecordedWorkflow,
} from "../src/workflow/compile-recorded-workflow.js";
import { RuntimeAdapterRegistry } from "../src/workflow/recorded-workflow.js";

const template = (value: WorkflowValueTemplate) => ({ kind: "template" as const, template: value });

/** Four unfamiliar callables over two unfamiliar runtime families, one call carrying a secret. */
function workflow(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_compile_four_calls",
    inputs: [
      { name: "source", type: "string" },
      { name: "retries", type: "number" },
    ],
    privateReferences: ["private:wf_compile_four_calls:0"],
    steps: [
      {
        id: "step0",
        callId: "call_1",
        callable: { runtime: "fam-alpha", name: "vendor.fetch", connection: "srv" },
        arguments: [
          { name: "source", source: template({ type: "input", name: "source" }) },
          { name: "retries", source: template({ type: "input", name: "retries" }) },
        ],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "step1",
        callId: "call_2",
        callable: { runtime: "fam-beta", name: "local-transform" },
        arguments: [
          {
            name: "request",
            source: template({
              type: "object",
              entries: {
                text: { type: "result", stepId: "step0", path: ["body", "text"] },
                options: { type: "object", entries: { depth: { type: "literal", value: 2 } } },
              },
            }),
          },
        ],
        dependsOn: ["step0"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "step2",
        callId: "call_3",
        callable: { runtime: "fam-beta", name: "local-write" },
        arguments: [
          {
            name: "content",
            source: template({ type: "result", stepId: "step1", path: ["stdout"] }),
          },
          {
            name: "token",
            source: template({ type: "private", reference: "private:wf_compile_four_calls:0" }),
          },
        ],
        dependsOn: ["step1"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
      {
        id: "step3",
        callId: "call_4",
        callable: { runtime: "fam-alpha", name: "vendor.upload", connection: "srv" },
        arguments: [
          {
            name: "artifact",
            source: template({ type: "result", stepId: "step2", path: ["path"] }),
          },
        ],
        dependsOn: ["step2"],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
      },
    ],
  };
}

describe("recorded workflow compilation", () => {
  it("compiles an unfamiliar four-call workflow with typed inputs and required runtimes", () => {
    const artifact = compileRecordedWorkflow(workflow());
    expect(artifact.name).toContain("vendor_fetch");
    expect(artifact.requiredRuntimes).toEqual(["fam-alpha", "fam-beta"]);
    expect(artifact.inputSchema).toMatchObject({
      properties: { source: { type: "string" }, retries: { type: "number" } },
      required: ["source", "retries"],
    });
    expect(artifact.outputContract).toEqual({ fromStep: "step3", callable: "vendor.upload" });
    expect(artifact.requiredPrivateReferences).toEqual(["private:wf_compile_four_calls:0"]);

    // Deterministic: the same recording compiles to the same artifact.
    expect(compileRecordedWorkflow(workflow()).digest).toBe(artifact.digest);
  });

  it("refuses to compile behaviour the recording does not establish", () => {
    const unresolved = workflow();
    unresolved.steps[1]!.arguments = [
      {
        name: "request",
        source: template({
          type: "unresolved",
          reason: "the record does not establish this origin",
        }),
      },
    ];
    expect(() => compileRecordedWorkflow(unresolved)).toThrow(RecordedWorkflowCompilationError);
    try {
      compileRecordedWorkflow(unresolved);
    } catch (error) {
      expect((error as RecordedWorkflowCompilationError).code).toBe("unresolved_origin");
      expect((error as Error).message).toContain("step1.request");
    }
  });

  it("invokes the compiled artifact with changed typed inputs, nested values and a private reference", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: "fam-alpha",
      call: async (request) => {
        calls.push({ name: request.step.callable.name, arguments: request.arguments });
        if (request.step.callable.name === "vendor.fetch") {
          return {
            body: { text: `fetched-${request.arguments.source}-${request.arguments.retries}` },
          };
        }
        return { uploaded: request.arguments.artifact };
      },
    });
    registry.register({
      runtime: "fam-beta",
      call: async (request) => {
        calls.push({ name: request.step.callable.name, arguments: request.arguments });
        if (request.step.callable.name === "local-transform") {
          const nested = request.arguments.request as { text: string; options: { depth: number } };
          return { stdout: `${nested.text.toUpperCase()}#${nested.options.depth}` };
        }
        return {
          path: `/out/${String(request.arguments.content)}.txt`,
          token: request.arguments.token,
        };
      },
    });

    const artifact = compileRecordedWorkflow(workflow());
    const tool = instantiateRecordedWorkflow(artifact, {
      adapters: registry,
      resolvePrivate: () => "resolved-locally",
    });

    const first = await tool.invoke({ source: "alpha", retries: 2 });
    expect(first.status).toBe("completed");
    expect(calls[1]?.arguments.request).toEqual({ text: "fetched-alpha-2", options: { depth: 2 } });
    expect(calls[2]?.arguments.content).toBe("FETCHED-ALPHA-2#2");
    expect(calls[2]?.arguments.token).toBe("resolved-locally");
    expect(first.result).toEqual({ uploaded: "/out/FETCHED-ALPHA-2#2.txt" });

    // Different typed inputs change every intermediate value: the plan composes, it does not replay.
    calls.length = 0;
    const second = await tool.invoke({ source: "beta", retries: 5 });
    expect(calls[1]?.arguments.request).toEqual({ text: "fetched-beta-5", options: { depth: 2 } });
    expect(second.result).toEqual({ uploaded: "/out/FETCHED-BETA-5#2.txt" });
  });

  it("refuses to run on a host that lacks a required runtime", async () => {
    const emptyRegistry = new RuntimeAdapterRegistry();
    const tool = instantiateRecordedWorkflow(compileRecordedWorkflow(workflow()), {
      adapters: emptyRegistry,
    });
    await expect(tool.invoke({ source: "alpha", retries: 1 })).rejects.toThrow(
      /no adapter for fam-alpha/,
    );
  });

  it("rejects an unresolved origin expressed as a plain source", () => {
    const plain = workflow();
    plain.steps[1]!.arguments = [
      {
        name: "request",
        source: { kind: "unresolved", reason: "the record does not establish this origin" },
      },
    ] as (typeof plain.steps)[1]["arguments"];
    expect(() => compileRecordedWorkflow(plain)).toThrow(/step1\.request/);
  });

  it("compiles an isolated plan that later mutation of the recording cannot change", async () => {
    const recording = workflow();
    const artifact = compileRecordedWorkflow(recording);
    const digestBefore = artifact.digest;

    // Mutate the recording after compilation.
    recording.steps[0]!.arguments[0]!.source = {
      kind: "template",
      template: { type: "literal", value: "tampered" },
    };
    recording.steps.splice(1);
    recording.inputs.push({ name: "injected", type: "string" });

    expect(artifact.digest).toBe(digestBefore);
    expect(Object.isFrozen(artifact.plan)).toBe(true);
    expect(artifact.plan.steps).toHaveLength(4);

    const calls: Array<Record<string, unknown>> = [];
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: "fam-alpha",
      call: async (request) => {
        calls.push(request.arguments);
        return { body: { text: `fetched-${request.arguments.source}` } };
      },
    });
    registry.register({
      runtime: "fam-beta",
      call: async (request) => {
        calls.push(request.arguments);
        const nested = request.arguments.request as { text: string; options: { depth: number } };
        return request.step.callable.name === "local-transform"
          ? { stdout: `${nested.text}#${nested.options.depth}` }
          : { path: `/out/${String(request.arguments.content)}` };
      },
    });

    const tool = instantiateRecordedWorkflow(artifact, {
      adapters: registry,
      resolvePrivate: () => "tok",
    });
    const result = await tool.invoke({ source: "alpha", retries: 1 });
    // The artifact still runs what was compiled, not what the recording became.
    expect(result.status).toBe("completed");
    expect(calls[1]).toEqual({ request: { text: "fetched-alpha", options: { depth: 2 } } });
  });
});
