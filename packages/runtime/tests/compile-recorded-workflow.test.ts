import {
  type RecordedWorkflow,
  type WorkflowValueTemplate,
  tokenizeProgram,
} from "@resin/contracts";
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

  it("executes defaults, preserves explicit falsy overrides, and rejects invalid inputs", async () => {
    const recording = workflow();
    recording.inputs = [
      { ...recording.inputs[0]!, default: "preset-source" },
      { ...recording.inputs[1]!, default: 4 },
      { name: "enabled", type: "boolean", default: true },
      { name: "empty", type: "string", default: "" },
      { name: "zero", type: "number", default: 0 },
      { name: "disabled", type: "boolean", default: false },
    ];
    recording.steps[0]!.arguments.push(
      { name: "enabled", source: template({ type: "input", name: "enabled" }) },
      { name: "empty", source: template({ type: "input", name: "empty" }) },
      { name: "zero", source: template({ type: "input", name: "zero" }) },
      { name: "disabled", source: template({ type: "input", name: "disabled" }) },
    );

    const artifact = compileRecordedWorkflow(recording);
    expect(artifact.inputSchema).toMatchObject({
      properties: {
        source: { type: "string", default: "preset-source" },
        retries: { type: "number", default: 4 },
        enabled: { type: "boolean", default: true },
        empty: { type: "string", default: "" },
        zero: { type: "number", default: 0 },
        disabled: { type: "boolean", default: false },
      },
      required: [],
    });
    expect(artifact.plan.inputs[0]?.default).toBe("preset-source");
    expect(
      compileRecordedWorkflow({
        ...workflow(),
        inputs: [
          { name: "source", type: "string", default: "other-source" },
          workflow().inputs[1]!,
        ],
      }).digest,
    ).not.toBe(artifact.digest);

    const calls: Array<{ stepId: string; arguments: Record<string, WorkflowJsonValue> }> = [];
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: "fam-alpha",
      call: async ({ step, arguments: args }) => {
        calls.push({ stepId: step.id, arguments: args });
        return step.id === "step0"
          ? { body: { text: `fetched-${String(args.source)}-${String(args.retries)}` } }
          : { uploaded: args.artifact };
      },
    });
    registry.register({
      runtime: "fam-beta",
      call: async ({ step }) =>
        step.id === "step1" ? { stdout: "transformed" } : { path: "/artifact" },
    });
    const tool = instantiateRecordedWorkflow(artifact, {
      adapters: registry,
      resolvePrivate: () => "resolved-locally",
    });

    const defaults = await tool.invoke({});
    expect(defaults.status).toBe("completed");
    expect(calls[0]?.arguments).toMatchObject({
      source: "preset-source",
      retries: 4,
      enabled: true,
      empty: "",
      zero: 0,
      disabled: false,
    });

    const overrides = await tool.invoke({ source: "", retries: 0, enabled: false });
    expect(overrides.status).toBe("completed");
    const sourceCalls = calls.filter((call) => call.stepId === "step0");
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[1]?.arguments).toMatchObject({
      source: "",
      retries: 0,
      enabled: false,
      empty: "",
      zero: 0,
      disabled: false,
    });
    await expect(tool.invoke({ source: null, retries: 0, enabled: false })).rejects.toThrow(
      /workflow input 'source' must be a string/,
    );
    await expect(
      tool.invoke({ source: "valid", retries: "wrong", enabled: false }),
    ).rejects.toThrow(/workflow input 'retries' must be a number/);

    const invalidDefault = workflow();
    invalidDefault.inputs[1] = { ...invalidDefault.inputs[1]!, default: false };
    expect(() => compileRecordedWorkflow(invalidDefault)).toThrow(
      /input retries default must match its recorded type 'number'/,
    );
    await expect(
      instantiateRecordedWorkflow(compileRecordedWorkflow(workflow()), {
        adapters: registry,
      }).invoke({
        source: "only-source",
      }),
    ).rejects.toThrow(/missing required workflow input 'retries'/);
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

  it("renders typed falsey and overridden literals inside compiled programs", async () => {
    const source = "const retries = 9; const enabled = true;";
    const tokens = tokenizeProgram("javascript", source);
    const retryToken = tokens.findIndex((token) => token.kind === "number");
    const enabledToken = tokens.findIndex((token) => token.kind === "boolean");
    const recorded: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf_typed_program_literals",
      inputs: [
        { name: "retries", type: "number", default: 0 },
        { name: "enabled", type: "boolean", default: false },
      ],
      steps: [
        {
          id: "run",
          callId: "call_run",
          callable: {
            runtime: "program-runtime",
            name: "script",
            program: { kind: "javascript", source, argument: "source" },
          },
          arguments: [
            {
              name: "source",
              source: template({
                type: "program",
                language: "javascript",
                source: { type: "literal", value: source },
                holes: [
                  { token: retryToken, binding: { type: "input", name: "retries" } },
                  { token: enabledToken, binding: { type: "input", name: "enabled" } },
                ],
              }),
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "recorded" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const scripts: string[] = [];
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      runtime: "program-runtime",
      call: async ({ arguments: args }) => {
        scripts.push(String(args.source));
        return { executed: true };
      },
    });
    const tool = instantiateRecordedWorkflow(compileRecordedWorkflow(recorded), {
      adapters: registry,
    });

    expect((await tool.invoke({})).status).toBe("completed");
    expect(scripts[0]).toBe("const retries = 0; const enabled = false;");
    expect((await tool.invoke({ retries: 2, enabled: true })).status).toBe("completed");
    expect(scripts[1]).toBe("const retries = 2; const enabled = true;");
  });
});
