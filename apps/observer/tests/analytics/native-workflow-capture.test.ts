/**
 * Native capture: an ordinary conversation with ordinary tools must produce the recording the
 * compiler consumes, without the caller changing anything about how it calls.
 */

import { OmpRecordDecoder } from "@resin/adapter-omp";
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
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

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
  sessionId = SESSION,
): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    sessionId,
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

/** The instruction that starts a new piece of work. */
function userTurn(sequence: number): NormalizedSessionEvent {
  return event({
    eventId: `evt_user_${sequence}`,
    type: "message",
    role: "user",
    content: "do the same thing again with a different name",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}

function discovery(
  tools: Array<{ name: string; provider?: string; inputSchema?: unknown }>,
  sessionId = SESSION,
) {
  return event({
    eventId: "evt_discovery",
    sessionId,
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

/** The events one execution of a session produced, by the index its carriers name. */
function executionOf(events: readonly NormalizedSessionEvent[], index: number) {
  return events.filter((event) => {
    const carrier = readWorkflowCallCarrier(event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    return carrier?.executionIndex === index;
  });
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
      call(2, "vendor.score", { dataset: "alpha-set" }),
      userTurn(3),
      call(4, "vendor.score", { dataset: "beta-set" }),
    ].map((entry) => recorder.observe(entry, { workspaceId: "ws_native" }));

    expect(carrierOf(observed[1]!)!.candidates).toBeUndefined();
    const carrier = carrierOf(observed[3]!);
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

describe("a value embedded in a program an ordinary session ran", () => {
  /** A shell command that writes a value an earlier call's result minted. */
  const command = "printf '%s\\n' 'alpha-7f3c' > f";

  function session() {
    return record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command: "printf '%s\\n' 'placeholder' > f" }),
      result(1, "bash", { stdout: "alpha-7f3c" }),
      call(2, "bash", { command }),
    ]);
  }

  it("offers the token an earlier result produced, at its position in the program", () => {
    const { events } = session();
    const carrier = carrierOf(events[3]!)!;
    // The record still says the call was a program, and which argument held its text.
    expect(carrier.program).toEqual({ kind: "shell", source: "", argument: "command" });

    expect(carrier.candidates).toHaveLength(1);
    const candidate = carrier.candidates![0]!;
    expect(candidate.argument).toBe("command");
    expect(candidate.path).toEqual(["tokens", 2]);
    expect(candidate.proposed).toEqual({ kind: "result", callId: "call_1", path: ["stdout"] });
    expect(candidate.reason).toBe("equal-to-earlier-result");
    expect(candidate.evidence).toEqual({ tokens: 5, token: 2, producers: 1 });

    // A candidate is a reason, never the value: nothing the record carries names the token's text.
    expect(JSON.stringify(projectEventToMetadataOnly(events[3]!).metadata ?? {})).not.toContain(
      "alpha-7f3c",
    );
  });

  it("carries the token candidate's path into the plan unchanged, and does not apply it", () => {
    const { events, store } = session();
    const recipe = recordCallsFromEvents("wf_program_token", events);
    expect(recipe).toBeDefined();
    const workflow = recipe!.workflow;
    expect(workflow.steps).toHaveLength(2);

    // The call the capture numbered `step1` keeps the position the capture gave the token: the
    // recording renumbers calls, and a token index is not a step identity.
    expect(workflow.candidates).toHaveLength(1);
    expect(workflow.candidates![0]).toMatchObject({
      stepId: "step1",
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "result", stepId: "step0", path: ["stdout"] },
      reason: "equal-to-earlier-result",
    });

    // The suggestion is reported and not executed: the step still carries the recorded program.
    const argument = workflow.steps[1]!.arguments.find((entry) => entry.name === "command")!;
    expect(argument.source.kind).toBe("template");
    const template = argument.source.kind === "template" ? argument.source.template : undefined;
    expect(template?.type).toBe("private");
    const reference = template?.type === "private" ? template.reference : undefined;
    expect(reference).toBeDefined();
    expect(resolvePrivateReference(store, reference!)).toBe(command);
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });
});

describe("a program an ordinary session ran twice with one token changed", () => {
  /** The recorded execution's program: what the first run of the work actually ran. */
  const recorded = "printf '%s\\n' 'alpha-7f3c' > f";
  /** The same work again, with the text of one quoted token changed. */
  const repeatedProgram = "printf '%s\\n' 'bravo-9k2m' > f";

  function session() {
    return record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command: recorded }),
      userTurn(2),
      call(3, "bash", { command: repeatedProgram }),
    ]);
  }

  it("keeps the changed token's candidate on the recorded step, and the program as it ran", () => {
    const { events, store } = session();
    const recipe = recordCallsFromEvents("wf_program_variation", events);
    expect(recipe).toBeDefined();
    const workflow = recipe!.workflow;

    // The repeat is a demonstration of the work, not a second step of it, so the candidate the
    // capture minted on its call is related to the step the same ordinal of this recording has.
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.candidates).toHaveLength(1);
    expect(workflow.candidates![0]).toMatchObject({
      stepId: "step0",
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "input", name: "bash_command_2", type: "string" },
      reason: "varies-across-executions",
      evidence: { tasks: 2, tokens: 5, token: 2 },
    });

    // The demonstration the repeat offered names the same step's program argument, which is the
    // value a replay reads the token's own value out of — the half that makes the candidate
    // decidable at all.
    expect(workflow.heldOut?.inputs).toContainEqual({
      stepId: "step0",
      argument: "command",
      reference: expect.stringContaining("private:"),
    });

    // The suggestion is reported and never applied — and the value it is about is not carried: the
    // step still holds the program that actually ran, which is the recorded execution's text.
    const argument = workflow.steps[0]!.arguments.find((entry) => entry.name === "command")!;
    expect(argument.source.kind).toBe("template");
    const template = argument.source.kind === "template" ? argument.source.template : undefined;
    expect(template?.type).toBe("private");
    const reference = template?.type === "private" ? template.reference : undefined;
    expect(resolvePrivateReference(store, reference!)).toBe(recorded);
    expect(JSON.stringify(workflow)).not.toContain("bravo-9k2m");
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("never re-targets a step when the repeat did something else", () => {
    // The repeat's first call is the same program on a different token, but the work it continued
    // with is not this recording's work — so its candidate has no step of this recording to belong
    // to, and is dropped as it always was. An ordinal is only a step identity when the callables
    // around it are the same callables.
    const { events } = record([
      discovery([{ name: "bash", provider: "omp" }]),
      call(1, "bash", { command: recorded }),
      call(2, "vendor.finish", { note: "alpha-done" }),
      userTurn(3),
      call(4, "bash", { command: repeatedProgram }),
      call(5, "vendor.other", { note: "bravo-done" }),
    ]);

    const recipe = recordCallsFromEvents("wf_program_other_work", events);
    expect(recipe!.workflow.steps).toHaveLength(2);
    expect(recipe!.workflow.candidates).toBeUndefined();
  });
});

describe("the demonstration an ordinary session offers", () => {
  /** Two executions of the same work: the same callables in the same order, on different values. */
  function repeated(): NormalizedSessionEvent[] {
    return [
      discovery([
        {
          name: "vendor.score",
          provider: "vendor-srv",
          inputSchema: { type: "object", properties: { dataset: { type: "string" } } },
        },
      ]),
      call(1, "vendor.score", { dataset: "alpha-set", tag: "ops-run" }),
      result(1, "vendor.score", { scored: { label: "alpha-set:42" } }),
      userTurn(2),
      call(3, "vendor.score", { dataset: "bravo-set", tag: "ops-run" }),
      result(3, "vendor.score", { scored: { label: "bravo-set:84" } }),
    ];
  }

  it("records a repeat of earlier work as a demonstration, kept by reference", () => {
    const { events, store } = record(repeated());
    const repeat = carrierOf(events[4]!)!;
    expect(repeat.executionIndex).toBe(1);
    // The demonstration is the repeat's own values: the inputs the earlier recording never used,
    // and what those inputs actually produced.
    expect(repeat.heldOut?.repeats).toBe(0);
    expect(repeat.heldOut?.inputs.map((entry) => entry.argument).sort()).toEqual([
      "dataset",
      "tag",
    ]);
    expect(repeat.heldOut?.observed.map((entry) => entry.position)).toEqual([0]);
    for (const entry of repeat.heldOut?.inputs ?? []) {
      expect(entry.reference.startsWith("private:")).toBe(true);
    }
    const dataset = (repeat.heldOut?.inputs ?? []).find((entry) => entry.argument === "dataset")!;
    expect(resolvePrivateReference(store, dataset.reference)).toBe("bravo-set");
    const produced = repeat.heldOut!.observed[0]!;
    expect(resolvePrivateReference(store, produced.reference)).toEqual({
      scored: { label: "bravo-set:84" },
    });
  });

  it("compiles the work once, with the demonstration declared and resolvable", () => {
    const observed = record(repeated()).events;
    const recipe = recordCallsFromEvents("wf_repeat", observed);
    // One execution is the plan; performing it twice is not two tools' worth of steps.
    expect(recipe!.workflow.steps).toHaveLength(1);
    expect(recipe!.workflow.steps[0]!.callable.name).toBe("vendor.score");
    const heldOut = recipe!.workflow.heldOut;
    expect(heldOut?.inputs).toHaveLength(2);
    expect(heldOut?.observed).toHaveLength(1);
    expect(heldOut?.inputs.every((entry) => entry.stepId === "step0")).toBe(true);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("offers a value the callable declares as an input wherever else it was used", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.intake",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { feed: "alpha-feed" },
        inputSchema: { type: "object", properties: { feed: { type: "string" } } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.commit",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { meta: { note: "alpha-feed" } },
      },
    ]);

    const shared = derivation.candidates.find(
      (candidate) => candidate.reason === "shares-value-with-declared-input",
    );
    expect(shared).toBeDefined();
    // The same input, not a second one: a caller supplies the value once and both calls get it.
    expect(shared!.proposed).toEqual({
      kind: "input",
      name: "vendor_intake_feed",
      type: "string",
    });
    expect(shared!.argument).toBe("meta");
    expect(shared!.path).toEqual(["note"]);
  });

  it("keeps a declared input whose own result echoes it, once that result has arrived", () => {
    // A callable that echoes what it was given must not disqualify its own input: the value is in
    // the result because it was passed in, and whether the result has arrived yet cannot decide
    // what the recording proposes.
    const withResult = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "pluto_intake",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { feed: "alpha-feed" },
        result: { record: { handle: "hdl-alpha-feed", feed: "alpha-feed", note: "alpha-feed" } },
        inputSchema: { type: "object", properties: { feed: { type: "string" } } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vesta_commit",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { meta: { note: "alpha-feed" } },
        result: { stored: { artifactId: "art-1" } },
      },
    ]);
    const withoutResult = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "pluto_intake",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { feed: "alpha-feed" },
        inputSchema: { type: "object", properties: { feed: { type: "string" } } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vesta_commit",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { meta: { note: "alpha-feed" } },
      },
    ]);

    const identity = (derivation: typeof withResult) =>
      derivation.candidates
        .map((candidate) => `${candidate.stepId}.${candidate.argument}@${candidate.reason}`)
        .sort();
    // The same proposals before and after the result arrives: the call is the same work either way.
    expect(identity(withResult)).toEqual(identity(withoutResult));
    expect(identity(withResult)).toEqual([
      "step0.feed@declared-by-the-callable",
      "step1.meta@shares-value-with-declared-input",
    ]);
    // The later argument is offered as the SAME caller's value, not a second input.
    const shared = withResult.candidates.find(
      (candidate) => candidate.reason === "shares-value-with-declared-input",
    )!;
    expect(shared.proposed).toEqual({ kind: "input", name: "pluto_intake_feed", type: "string" });
    // And it is a proposal: nothing about it is executable.
    expect(withResult.candidates.some((candidate) => candidate.proposed.kind === "result")).toBe(
      false,
    );
  });

  it("leaves a value two arguments share, with nothing declaring it, exactly where it is", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "vendor.intake",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { meta: { tag: "ops-run" } },
        inputSchema: { type: "object", properties: { feed: { type: "string" } } },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "vendor.commit",
        runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
        arguments: { meta: { tag: "ops-run" } },
      },
    ]);

    expect(
      derivation.candidates.filter(
        (candidate) => candidate.reason === "shares-value-with-declared-input",
      ),
    ).toEqual([]);
  });
});

describe("a recording and the demonstrations read beside it", () => {
  /** Two unrelated tasks, then a repeat of the first one only. */
  function session(): NormalizedSessionEvent[] {
    return record([
      discovery([
        {
          name: "alpha_step",
          provider: "srv",
          inputSchema: { type: "object", properties: { seed: { type: "string" } } },
        },
        { name: "alpha_finish", provider: "srv" },
      ]),
      call(1, "alpha_step", { seed: "alpha-seed" }),
      result(1, "alpha_step", { minted: { id: "alpha-1" } }),
      call(2, "alpha_finish", { token: "alpha-1" }),
      result(2, "alpha_finish", { done: true }),
      userTurn(3),
      call(4, "beta_sweep", { scope: "everything" }),
      result(4, "beta_sweep", { swept: 12 }),
      call(5, "beta_report", { rows: 12 }),
      result(5, "beta_report", { reported: true }),
      userTurn(6),
      call(7, "alpha_step", { seed: "bravo-seed" }),
      result(7, "alpha_step", { minted: { id: "alpha-2" } }),
      call(8, "alpha_finish", { token: "alpha-2" }),
      result(8, "alpha_finish", { done: true }),
    ]).events;
  }

  it("keeps the selected work's own calls and never adds the session's other tasks", () => {
    const events = session();
    const recipe = recordCallsFromEvents("wf_selected", executionOf(events, 0), {
      supportingEvents: executionOf(events, 2),
    });

    // The compiled workflow is the task's two calls — not the unrelated task, and not the repeat.
    expect(recipe!.workflow.steps).toHaveLength(2);
    expect(recipe!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "alpha_step",
      "alpha_finish",
    ]);
    // The repeat is present as evidence for a replay, addressed by the steps it repeats: the values
    // it used sit beside the steps they were used at, and a candidate is only decided by the one
    // that lands on its own position.
    expect(recipe!.workflow.heldOut?.inputs.map((entry) => entry.stepId)).toEqual([
      "step0",
      "step1",
    ]);
    expect(recipe!.workflow.heldOut?.inputs.map((entry) => entry.argument).sort()).toEqual([
      "seed",
      "token",
    ]);
    expect(recipe!.workflow.heldOut?.observed.map((entry) => entry.stepId).sort()).toEqual([
      "step0",
      "step1",
    ]);
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
  });

  it("compiles each task to its own calls, and a repeat supports it without joining it", () => {
    const events = session();
    const second = recordCallsFromEvents("wf_selected_beta", executionOf(events, 1));
    // The unrelated task stands on its own, with no demonstration borrowed from anywhere.
    expect(second!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "beta_sweep",
      "beta_report",
    ]);
    expect(second!.workflow.heldOut).toBeUndefined();
  });
});

describe("what a repeat's own calls proposed", () => {
  /**
   * The same work performed twice on different values, with nothing declaring the argument: the
   * only thing that can propose a caller input is the variation between the two executions, and
   * the capture mints that proposal on the second one's call — the execution a recording compiled
   * from the first does not number.
   */
  function repeatedOnDifferentDatasets() {
    return record([
      discovery([{ name: "vendor.score", provider: "vendor-srv" }]),
      call(1, "vendor.score", { dataset: "alpha-set", tag: "ops-run" }),
      result(1, "vendor.score", { scored: { label: "alpha-set:42" } }),
      userTurn(2),
      call(3, "vendor.score", { dataset: "bravo-set", tag: "ops-run" }),
      result(3, "vendor.score", { scored: { label: "bravo-set:84" } }),
    ]);
  }

  it("offers the input the repeat varied, against the step it is the same call of", () => {
    const { events } = repeatedOnDifferentDatasets();
    const recipe = recordCallsFromEvents("wf_repeat_input", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    const workflow = recipe!.workflow;

    // One execution is the plan: the repeat is evidence, never a second step.
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]!.callable.name).toBe("vendor.score");

    // The variation the repeat's call showed is offered at the argument the two executions
    // disagreed about, named for the callable and the argument rather than for a value.
    expect(workflow.candidates).toContainEqual({
      stepId: "step0",
      argument: "dataset",
      path: [],
      proposed: { kind: "input", name: "vendor_score_dataset", type: "string" },
      reason: "varies-across-executions",
      evidence: { tasks: 2 },
      missing: expect.any(String),
    });
    // A proposal is not a binding: the step still holds what the recorded execution ran.
    expect(JSON.stringify(workflow)).not.toContain("bravo-set");
    expect(validateRecordedWorkflow(workflow)).toEqual({ valid: true, errors: [] });
  });

  it("carries the demonstration that decides it, by reference, at the same step", () => {
    const { events, store } = repeatedOnDifferentDatasets();
    const recipe = recordCallsFromEvents("wf_repeat_demo", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    const heldOut = recipe!.workflow.heldOut;
    expect(heldOut?.inputs.map((entry) => [entry.stepId, entry.argument]).sort()).toEqual([
      ["step0", "dataset"],
      ["step0", "tag"],
    ]);
    expect(heldOut?.observed.map((entry) => entry.stepId)).toEqual(["step0"]);
    const dataset = heldOut!.inputs.find((entry) => entry.argument === "dataset")!;
    // The demonstration is the user's own second run, kept where it was performed.
    expect(dataset.reference.startsWith("private:")).toBe(true);
    expect(resolvePrivateReference(store, dataset.reference)).toBe("bravo-set");
    expect(resolvePrivateReference(store, heldOut!.observed[0]!.reference)).toEqual({
      scored: { label: "bravo-set:84" },
    });
  });

  it("maps a nested proposal onto the step the repeat's producing call is", () => {
    // The earlier execution's first step reported no result, so the recording's own calls propose
    // nothing about the second step's nested argument. The repeat establishes it: its second call
    // passed the value its first call returned, at a path inside that argument.
    const { events } = record([
      discovery([
        { name: "alpha_step", provider: "srv" },
        { name: "alpha_finish", provider: "srv" },
      ]),
      call(1, "alpha_step", { seed: "alpha-seed" }),
      call(2, "alpha_finish", { meta: { note: "alpha-1" } }),
      result(2, "alpha_finish", { done: true }),
      userTurn(3),
      call(4, "alpha_step", { seed: "bravo-seed" }),
      result(4, "alpha_step", { minted: { id: "alpha-2" } }),
      call(5, "alpha_finish", { meta: { note: "alpha-2" } }),
      result(5, "alpha_finish", { done: true }),
    ]);

    const recipe = recordCallsFromEvents("wf_repeat_nested", executionOf(events, 0), {
      supportingEvents: executionOf(events, 1),
    });
    expect(recipe!.workflow.steps.map((step) => step.callable.name)).toEqual([
      "alpha_step",
      "alpha_finish",
    ]);
    expect(recipe!.workflow.candidates).toContainEqual({
      stepId: "step1",
      argument: "meta",
      path: ["note"],
      proposed: { kind: "result", stepId: "step0", path: ["minted", "id"] },
      reason: "equal-to-earlier-result",
      evidence: { producers: 1 },
      missing: expect.any(String),
    });
    expect(validateRecordedWorkflow(recipe!.workflow)).toEqual({ valid: true, errors: [] });
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

/**
 * Drives one session of OMP transcript records through the real pipeline: each invocation is the
 * transport `write` plus a device path, with the invocation's own arguments in the assistant record
 * that follows it. The server names are the harness's own registry, which is what the paths are
 * resolved against.
 */
async function captureDeviceSurface(
  invocations: Array<[string, string]>,
  servers: readonly string[],
  recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() }),
): Promise<NormalizedSessionEvent[]> {
  const pipeline = new NormalizationPipeline();
  pipeline.registerDecoder(new OmpRecordDecoder({ deviceSurfaceServers: () => servers }));
  const sessionId = "session_device_surface_capture";
  const observed: NormalizedSessionEvent[] = [];
  let sequence = 0;
  for (const [callId, path] of invocations) {
    const payloads = [
      {
        type: "custom",
        customType: "tool_execution_start",
        data: { toolCallId: callId, toolName: "write", args: { path } },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: "write",
              arguments: { path, content: '{"query":"rows"}' },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "write",
          content: [{ type: "text", text: "{}" }],
        },
      },
    ];
    for (const payload of payloads) {
      sequence += 1;
      const results = await pipeline.processRecord(
        {
          recordId: `rec_${sequence}`,
          sessionId,
          harnessId: "omp",
          sequenceNumber: sequence,
          timestamp: "2026-09-18T10:00:00.000Z",
          recordType: "transcript_line",
          rawPayload: payload,
          cursor: {
            offset: sequence * 10,
            line: sequence,
            sequence,
            timestamp: "2026-09-18T10:00:00.000Z",
          },
          metadata: {},
        },
        { sessionId, harnessId: "omp", workspaceId: "ws_native" },
      );
      for (const result of results) {
        if (result.status !== "success" || result.isDuplicate) continue;
        observed.push(recorder.observe(result.event, { workspaceId: "ws_native" }));
      }
    }
  }
  return observed;
}

/** The carrier recorded for each call of an observed session, in order. */
function carriersOf(events: NormalizedSessionEvent[]) {
  return events.filter((entry) => entry.type === "tool_call").map((entry) => carrierOf(entry)!);
}

describe("the connection a callable was reached over", () => {
  it("records the tool and the connection behind each device path, never a split of the path", async () => {
    // `alpha` and `alpha_beta` both expose `run`, and `alpha` also exposes a name containing
    // underscores. A naive split of the paths would record the middle call as `beta_run`.
    const observed = await captureDeviceSurface(
      [
        ["call_alpha", "xd://mcp__alpha_run"],
        ["call_alpha_beta", "xd://mcp__alpha_beta_run"],
        ["call_deep", "xd://mcp__alpha_deep_tool_name"],
      ],
      ["alpha", "alpha_beta"],
    );

    const carriers = carriersOf(observed);
    expect(carriers.map((carrier) => [carrier.name, carrier.connection])).toEqual([
      ["run", "alpha"],
      ["run", "alpha_beta"],
      ["deep_tool_name", "alpha"],
    ]);
    // The invocation's own arguments are what was recorded — not the transport's device path.
    expect(carriers[0]!.origins).toHaveProperty("query");
    expect(carriers[0]!.origins).not.toHaveProperty("path");
  });

  it("keeps the harness-exposed name opaque when no configured server owns the path", async () => {
    const observed = await captureDeviceSurface(
      [["call_unknown", "xd://mcp__unconfigured_run"]],
      ["alpha", "alpha_beta"],
    );

    const carriers = carriersOf(observed);
    expect(carriers).toHaveLength(1);
    // The call is still captured, exactly as the harness spelled it, and with no connection: an
    // unidentified path is not turned into a guess.
    expect(carriers[0]!.name).toBe("write");
    expect(carriers[0]!.connection).toBeUndefined();
    expect(observed.some((entry) => entry.type === "tool_discovery")).toBe(false);
  });

  it("leaves the connection absent when discovery reported none, and still records the call", () => {
    const { events } = record([
      discovery([{ name: "vendor.fetch", inputSchema: { type: "object" } }]),
      call(1, "vendor.fetch", { source: "alpha-feed" }),
    ]);

    const carrier = carrierOf(events[1]!);
    expect(carrier!.name).toBe("vendor.fetch");
    expect(carrier!.runtime).toBe(RESIN_TOOL_PROTOCOL_RUNTIME);
    expect(carrier!.connection).toBeUndefined();
    expect(carrier!.inputSchema).toEqual({ type: "object" });
  });

  it("keeps the connection a call itself records when no discovery reported one", () => {
    // A device-surface invocation whose start marker never arrived still resolved its path: the
    // call carries the connection, and the carrier keeps it.
    const recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
    const observed = recorder.observe(
      event({
        eventId: "evt_call_connection",
        type: "tool_call",
        callId: "call_connection",
        toolName: "run",
        connection: "alpha",
        parameters: { query: "rows" },
        causalRef: { causalSequence: 1, parentId: null },
      }),
      { workspaceId: "ws_native" },
    );

    const carrier = carrierOf(observed)!;
    expect(carrier.name).toBe("run");
    expect(carrier.connection).toBe("alpha");
  });

  it("never lets one session's discovery supply another session's connection", () => {
    const { events } = record([
      discovery([{ name: "run", provider: "alpha" }], "session_a"),
      call(1, "run", { query: "rows" }, 0, "session_a"),
      discovery([{ name: "run", provider: "alpha_beta" }], "session_b"),
      call(2, "run", { query: "rows" }, 0, "session_b"),
      // A session that saw no discovery at all keeps no connection, even though another did.
      call(3, "run", { query: "rows" }, 0, "session_c"),
    ]);

    expect(carrierOf(events[1]!)!.connection).toBe("alpha");
    expect(carrierOf(events[3]!)!.connection).toBe("alpha_beta");
    expect(carrierOf(events[4]!)!.connection).toBeUndefined();
  });
});

function referenceOf(origin: { type: string; reference?: string }): string {
  if (origin.type !== "private" || origin.reference === undefined) {
    throw new Error(`expected a local reference, got ${origin.type}`);
  }
  return origin.reference;
}
