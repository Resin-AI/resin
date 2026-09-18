/**
 * Native capture: an ordinary conversation with ordinary tools must produce the recording the
 * compiler consumes, without the caller changing anything about how it calls.
 */

import type { NormalizedSessionEvent } from "@resin/contracts";
import { NormalizedSessionEventSchema, validateRecordedWorkflow } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { deriveNativeCalls } from "../../src/analytics/native-argument-derivation.js";
import {
  FilePrivateValueStore,
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";

const SESSION = "session-native-capture";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

function call(
  sequence: number,
  toolName: string,
  parameters: Record<string, unknown>,
  turnIndex = 0,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName,
    parameters,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex, stepIndex: 0 },
  });
}

function result(
  sequence: number,
  toolName: string,
  value: unknown,
  turnIndex = 0,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_result_${sequence}`,
    type: "tool_result",
    callId: `call_${sequence}`,
    toolName,
    result: value,
    isError: false,
    executionDurationMs: 12,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex, stepIndex: 0 },
  });
}

function discovery(tools: Array<{ name: string; provider?: string; inputSchema?: unknown }>) {
  return event({
    eventId: "evt_discovery",
    type: "tool_discovery",
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.provider === undefined ? {} : { provider: tool.provider }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    })),
    source: "mcp",
    causalRef: { causalSequence: 0, parentId: null },
  });
}

function carrierOf(observed: NormalizedSessionEvent) {
  return readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
}

/** Drives the recorder exactly as the capture coordinator does, in recorded order. */
function record(events: NormalizedSessionEvent[], store = new InMemoryPrivateValueStore()) {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  return {
    store,
    events: events.map((entry) => recorder.observe(entry, { workspaceId: "ws_native" })),
  };
}

describe("native capture of ordinary calls", () => {
  it("records a tool call the caller made normally, keeping its values local", () => {
    const { events, store } = record([
      discovery([
        { name: "vendor.fetch", provider: "vendor-srv", inputSchema: { type: "object" } },
      ]),
      call(1, "vendor.fetch", { source: "alpha-feed", page: 2 }),
      result(1, "vendor.fetch", { rows: [{ id: "row-7" }] }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier).toBeDefined();
    expect(carrier!.runtime).toBe(RESIN_TOOL_PROTOCOL_RUNTIME);
    expect(carrier!.name).toBe("vendor.fetch");
    expect(carrier!.connection).toBe("vendor-srv");
    expect(carrier!.inputSchema).toEqual({ type: "object" });
    expect(carrier!.provenance).toEqual({
      source: { standing: "derived", rule: "single-observation" },
      page: { standing: "derived", rule: "single-observation" },
    });

    // The values stay on the machine: every leaf is a local reference the executor resolves.
    expect(carrier!.origins.source).toEqual({ type: "private", reference: expect.any(String) });
    expect(
      resolvePrivateReference(store, (carrier!.origins.source as { reference: string }).reference),
    ).toBe("alpha-feed");

    // Nothing about the ordinary call's own values reaches the caller's record.
    expect(JSON.stringify(events[1]!.parameters)).toBe(
      JSON.stringify({ source: "alpha-feed", page: 2 }),
    );
  });

  it("never puts a recorded value into the projected metadata of an ordinary call", () => {
    const { events } = record([
      discovery([{ name: "vendor.fetch", provider: "vendor-srv" }]),
      call(1, "vendor.fetch", {
        token: "SENSITIVE_VALUE_9f21",
        nested: { deep: "SENSITIVE_DEEP_4a11" },
      }),
    ]);

    const projected = projectEventToMetadataOnly(events[1]!);
    const serialized = JSON.stringify(projected.metadata ?? {});
    expect(serialized).not.toContain("SENSITIVE_VALUE_9f21");
    expect(serialized).not.toContain("SENSITIVE_DEEP_4a11");
  });

  it("records a multi-operation shell program whole, and the argument that holds it", () => {
    const command = "printf 'a\\n' | sort > /tmp/native-out.txt && wc -l < /tmp/native-out.txt";
    const { events, store } = record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command, cwd: "/tmp/project" }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.runtime).toBe(RESIN_PROCESS_RUNTIME);
    expect(carrier!.program).toEqual({ kind: "shell", source: "", argument: "command" });
    expect(resolvePrivateReference(store, referenceOf(carrier!.origins.command!))).toBe(command);
  });

  it("records a program call through its interpreter family", () => {
    const source = "import json\nprint(json.dumps({'rows': [1, 2, 3]}))\n";
    const { events } = record([
      discovery([{ name: "eval", provider: "omp" }]),
      call(1, "eval", { language: "python", code: source }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.runtime).toBe(RESIN_PROGRAM_RUNTIME);
    expect(carrier!.program).toEqual({ kind: "python", source: "", argument: "code" });
  });
});

describe("what the derivation offers, and what it refuses to offer", () => {
  it("offers a value that first appeared in an earlier result, and only as a candidate", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { source: "alpha-feed" },
        result: { entry: { handle: "entry-alpha-feed-001" } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { entry: "entry-alpha-feed-001" },
      },
    ]);

    expect(derivation.candidates).toHaveLength(1);
    const candidate = derivation.candidates[0]!;
    expect(candidate.stepId).toBe("step1");
    expect(candidate.argument).toBe("entry");
    expect(candidate.proposed).toEqual({
      kind: "result",
      stepId: "step0",
      path: ["entry", "handle"],
    });
    expect(candidate.missing).toContain("does not show this call read its result");
  });

  it("refuses an incidental equal value that the record already contained", () => {
    // The producer returns a value the record had already seen before it ran. Equality here is a
    // coincidence: the later call may have taken it from anywhere, so nothing is offered.
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.list",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { filter: "shared-token-42" },
        result: { echoes: ["shared-token-42"] },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { token: "shared-token-42" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });

  it("refuses a short token that collides with unrelated arguments", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: {},
        result: { status: "ok" },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.use",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { status: "ok" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });

  it("proves a producer-to-consumer edge from the calls' own declared resource use", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "write_file",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { path: "/tmp/a.json" },
        flow: { reads: [], writes: ["file:/tmp/a.json"] },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "read_file",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { path: "/tmp/a.json" },
        flow: { reads: ["file:/tmp/a.json"], writes: [] },
      },
    ]);

    expect(derivation.calls[1]!.dependsOn).toEqual(["step0"]);
    // The shared path is a resource identity, not a value: equality alone never created this edge.
    expect(derivation.calls[0]!.dependsOn).toEqual([]);
  });

  it("offers a declared argument nothing produced as a caller-input candidate", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.score",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { dataset: "alpha-set", page: 2 },
        inputSchema: {
          type: "object",
          properties: { dataset: { type: "string" }, page: { type: "number" } },
        },
      },
    ]);

    expect(derivation.candidates).toHaveLength(1);
    expect(derivation.candidates[0]!.proposed).toEqual({
      kind: "input",
      name: "vendor_score_dataset",
      type: "string",
    });
    expect(derivation.candidates[0]!.reason).toBe("declared-by-the-callable");
    expect(derivation.candidates[0]!.missing).toContain(
      "only running the work with a different value establishes that",
    );
  });

  it("refuses to call an argument an input when the recording produced its value", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.fetch",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { source: "alpha-feed" },
        result: { entry: { handle: "entry-alpha-feed-001" } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.score",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { handle: "entry-alpha-feed-001" },
        inputSchema: { type: "object", properties: { handle: { type: "string" } } },
      },
    ]);

    const inputCandidates = derivation.candidates.filter(
      (candidate) => candidate.proposed.kind === "input",
    );
    expect(inputCandidates).toEqual([]);
    // It is offered as a result binding instead, which is what the record actually supports.
    expect(derivation.candidates).toHaveLength(1);
    expect(derivation.candidates[0]!.reason).toBe("equal-to-earlier-result");
  });

  it("offers an argument that took a different value in another task as a caller input", () => {
    // Two tasks of one session, compared by callable and argument position.
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const observed = [
      discovery([{ name: "vendor.score", provider: "vendor-srv" }]),
      call(2, "vendor.score", { dataset: "alpha-set" }, 0),
      call(3, "vendor.score", { dataset: "beta-set" }, 1),
    ].map((entry) => recorder.observe(entry, { workspaceId: "ws_native" }));

    expect(carrierOf(observed[1]!)!.candidates).toBeUndefined();
    const carrier = carrierOf(observed[2]!);
    expect(carrier!.candidates).toHaveLength(1);
    expect(carrier!.candidates![0]!.proposed).toEqual({
      kind: "input",
      name: "vendor_score_dataset",
      type: "string",
    });
    expect(carrier!.candidates![0]!.missing).toContain(
      "does not establish that a caller supplies it",
    );
  });
});

describe("the recording an ordinary session produces", () => {
  it("compiles into a plan whose values resolve locally, with candidates kept out of it", () => {
    const store = new InMemoryPrivateValueStore();
    const observed = record(
      [
        discovery([
          { name: "vendor.fetch", provider: "vendor-srv", inputSchema: { type: "object" } },
          { name: "vendor.store", provider: "vendor-srv" },
        ]),
        call(1, "vendor.fetch", { source: "alpha-feed" }),
        result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
        call(2, "vendor.store", { token: "entry-alpha-feed-001" }),
        result(2, "vendor.store", { stored: { artifactId: "art-1" } }),
      ],
      store,
    ).events;

    const recipe = recordCallsFromEvents("wf_native", observed);
    expect(recipe).toBeDefined();
    const workflow = recipe!.workflow;
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps.map((step) => step.callable.runtime)).toEqual([
      RESIN_TOOL_PROTOCOL_RUNTIME,
      RESIN_TOOL_PROTOCOL_RUNTIME,
    ]);

    // The suggestion is reported and not executed: the step still carries the recorded value.
    expect(workflow.candidates).toHaveLength(1);
    expect(workflow.candidates![0]!.stepId).toBe("step1");
    expect(workflow.candidates![0]!.proposed).toEqual({
      kind: "result",
      stepId: "step0",
      path: ["entry", "handle"],
    });
    const storedArgument = workflow.steps[1]!.arguments.find((entry) => entry.name === "token")!;
    expect(storedArgument.source.kind).toBe("template");

    // Every local reference the plan resolves is declared, so the plan is structurally sound.
    expect(workflow.privateReferences?.length).toBeGreaterThanOrEqual(2);
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("survives redelivery of the same execution as one step, not two", () => {
    const events = record([
      discovery([{ name: "vendor.fetch", provider: "vendor-srv" }]),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
      result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
      result(1, "vendor.fetch", { entry: { handle: "entry-alpha-feed-001" } }),
    ]).events;

    const recipe = recordCallsFromEvents("wf_native_redelivery", events);
    expect(recipe!.workflow.steps).toHaveLength(1);
  });
});

describe("the private value store the recorder writes to", () => {
  it("refuses a foreign workspace the way every other local reference does", () => {
    const store = new FilePrivateValueStore(
      `${process.env.HOME ?? "/tmp"}/.resin-test-native/private-values.json`,
    );
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    const observed = recorder.observe(call(1, "vendor.fetch", { source: "alpha-feed" }), {
      workspaceId: "ws_native",
    });
    const carrier = carrierOf(observed)!;
    const reference = referenceOf(carrier.origins.source!);
    expect(store.origin?.(reference)?.workspaceId).toBe("ws_native");
  });
});

function referenceOf(origin: { type: string; reference?: string }): string {
  if (origin.type !== "private" || origin.reference === undefined) {
    throw new Error(`expected a local reference, got ${origin.type}`);
  }
  return origin.reference;
}
