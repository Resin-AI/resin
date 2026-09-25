/**
 * A value embedded in the text of a program a call ran.
 *
 * `deriveNativeCalls` compares string leaves, and a program arrives as one argument whose value is
 * its whole text: a value inside that text is not a leaf of anything, so it is never seen as the
 * earlier result's value. The tokenizer both halves of the round-trip share — the capture that finds
 * the token and the runtime that renders a bound value back into it — says where each token sits, so
 * the value can be offered at that position under exactly the rule that governs every other result
 * binding.
 */
import type { NormalizedSessionEvent } from "@resin/contracts";
import { NormalizedSessionEventSchema, tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { deriveNativeCalls } from "../../src/analytics/native-argument-derivation.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";

const SESSION = "session-embedded-value";

/** The recorded execution's program: what the first run of the work actually ran. */
const RECORDED_PROGRAM = "printf '%s\\n' 'alpha-7f3c' > f";
/** A second execution of the work, with a different result-derived token. */
const REPEAT_PROGRAM = "printf '%s\\n' 'bravo-9k2m' > f";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: SESSION,
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}

function call(sequence: number, parameters: Record<string, unknown>): NormalizedSessionEvent {
  return event({
    eventId: `evt_call_${sequence}`,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName: "bash",
    parameters,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex: 0, stepIndex: 0 },
  });
}

function result(sequence: number, value: unknown): NormalizedSessionEvent {
  return event({
    eventId: `evt_result_${sequence}`,
    type: "tool_result",
    callId: `call_${sequence}`,
    toolName: "bash",
    result: value,
    isError: false,
    executionDurationMs: 12,
    causalRef: { causalSequence: sequence, parentId: null, turnIndex: 0, stepIndex: 0 },
  });
}

/** The instruction that starts a new piece of work, and with it a new execution of it. */
function userTurn(sequence: number): NormalizedSessionEvent {
  return event({
    eventId: `evt_user_${sequence}`,
    type: "message",
    role: "user",
    content: "do the same thing again with a different name",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}

/** Drives the recorder exactly as the capture coordinator does, in recorded order. */
function record(events: NormalizedSessionEvent[], store = new InMemoryPrivateValueStore()) {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  return {
    store,
    events: events.map((entry) => recorder.observe(entry, { workspaceId: "ws_embedded_value" })),
  };
}

/** The carrier one observed call was recorded with. */
function carrierOf(observed: NormalizedSessionEvent) {
  return readWorkflowCallCarrier(observed.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
}

/** The producer: a call whose result minted the value and whose own arguments did not carry it. */
const PRODUCER = {
  callId: "call_1",
  stepId: "step0",
  toolName: "bash",
  runtime: RESIN_PROCESS_RUNTIME,
  arguments: { command: "printf '%s\\n' 'placeholder' > f" },
  result: { stdout: "alpha-7f3c" },
};

describe("a value embedded in a recorded program", () => {
  it("offers the value at the token index it sits at, with structural evidence only", () => {
    const command = "printf '%s\\n' 'alpha-7f3c' > f";
    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command },
        program: { kind: "shell", argument: "command" },
      },
    ]);

    // The index means the token holding the value, in the numbering the tokenizer yields — the same
    // numbering a replay renders a confirmed binding back into.
    expect(tokenizeProgram("shell", command)[2]!.raw).toBe("'alpha-7f3c'");

    expect(derivation.candidates).toHaveLength(1);
    const candidate = derivation.candidates[0]!;
    expect(candidate.stepId).toBe("step1");
    expect(candidate.argument).toBe("command");
    expect(candidate.path).toEqual(["tokens", 2]);
    expect(candidate.proposed).toEqual({ kind: "result", stepId: "step0", path: ["stdout"] });
    expect(candidate.reason).toBe("equal-to-earlier-result");
    // Evidence is structural: how many tokens the program has, which one this is, and how many
    // calls returned the value. The token's text is never carried.
    expect(candidate.evidence).toEqual({ tokens: 5, token: 2, producers: 1 });
    expect(JSON.stringify(candidate)).not.toContain("alpha-7f3c");
    // The record still does not establish that the token came from that result.
    expect(candidate.missing).toContain("written into the program as a literal");
  });

  it("refuses a token whose text the record already contained before the producer ran", () => {
    // The producer returns a value the record had already shown in an earlier call's argument.
    // Equality there is a coincidence: the program's token may have come from anywhere, so nothing
    // is offered — exactly as for a whole argument.
    const derivation = deriveNativeCalls([
      {
        callId: "call_0",
        stepId: "step0",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { note: "alpha-7f3c" },
      },
      {
        callId: "call_1",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "printf '%s\\n' 'placeholder' > f" },
        result: { stdout: "alpha-7f3c" },
      },
      {
        callId: "call_2",
        stepId: "step2",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "printf '%s\\n' 'alpha-7f3c' > g" },
        program: { kind: "shell", argument: "command" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });

  it("refuses a token no result ever produced", () => {
    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "printf '%s\\n' 'gamma-9x2b' > f" },
        program: { kind: "shell", argument: "command" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });

  it("refuses a token shorter than the shortest candidate", () => {
    const derivation = deriveNativeCalls([
      {
        callId: "call_1",
        stepId: "step0",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "run placeholder" },
        result: { stdout: "abc" },
      },
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "run abc" },
        program: { kind: "shell", argument: "command" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });

  it("offers every position of a value the program repeats, and no operator", () => {
    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "cp 'alpha-7f3c' 'alpha-7f3c'" },
        program: { kind: "shell", argument: "command" },
      },
    ]);

    // Two occurrences are two positions in the program, so each is its own candidate: a replay
    // renders the confirmed value into the token it confirmed, not into every equal token.
    expect(derivation.candidates.map((candidate) => candidate.path)).toEqual([
      ["tokens", 1],
      ["tokens", 2],
    ]);
    // Both name the same producer: the program repeats one value, and the record shows one call
    // that returned it.
    expect(derivation.candidates.map((candidate) => candidate.proposed)).toEqual([
      { kind: "result", stepId: "step0", path: ["stdout"] },
      { kind: "result", stepId: "step0", path: ["stdout"] },
    ]);
  });

  it("offers only tokens of the argument the record named as the program", () => {
    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: {
          command: "printf '%s\\n' 'alpha-7f3c' > f",
          note: "echo 'alpha-7f3c'",
        },
        // The record says the program arrived in `command`; `note` is an ordinary argument, and a
        // token position there would address text no program ever ran.
        program: { kind: "shell", argument: "command" },
      },
    ]);

    expect(derivation.candidates).toHaveLength(1);
    expect(derivation.candidates[0]!.argument).toBe("command");
    expect(derivation.candidates[0]!.path).toEqual(["tokens", 2]);
  });

  it("reads the program in the language its record named", () => {
    // The same text read as shell puts the value behind two other words — it is one word of a shell
    // command there, not a token of its own — so a program read in the wrong language would offer a
    // position no interpreter of that program has.
    const code = "text = '''alpha-7f3c'''";
    const valueToken = tokenizeProgram("python", code).findIndex(
      (token) => token.value === "alpha-7f3c",
    );

    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "eval",
        runtime: RESIN_PROGRAM_RUNTIME,
        arguments: { language: "python", code },
        program: { kind: "python", argument: "code" },
      },
    ]);

    expect(derivation.candidates).toHaveLength(1);
    expect(derivation.candidates[0]!.argument).toBe("code");
    expect(derivation.candidates[0]!.path).toEqual(["tokens", valueToken]);
    expect(derivation.candidates[0]!.proposed).toEqual({
      kind: "result",
      stepId: "step0",
      path: ["stdout"],
    });
  });

  it("offers nothing when the record does not say which argument holds the program", () => {
    // A call recorded as a program without the argument it arrived in has no text to read: the
    // argument that happens to hold the value is not a program this call ran.
    const derivation = deriveNativeCalls([
      PRODUCER,
      {
        callId: "call_2",
        stepId: "step1",
        toolName: "bash",
        runtime: RESIN_PROCESS_RUNTIME,
        arguments: { command: "printf '%s\\n' 'alpha-7f3c' > f" },
      },
    ]);

    expect(derivation.candidates).toEqual([]);
  });
});

it("keeps a repeated program's result-derived token binding without inferring an input", () => {
  const { events } = record([
    call(1, { command: "make-token" }),
    result(1, { stdout: "alpha-7f3c" }),
    call(2, { command: RECORDED_PROGRAM }),
    userTurn(3),
    call(4, { command: "make-token" }),
    result(4, { stdout: "bravo-9k2m" }),
    call(5, { command: REPEAT_PROGRAM }),
  ]);

  const repeat = carrierOf(events[6]!)!;
  expect(repeat.candidates?.map((candidate) => candidate.reason)).toEqual([
    "equal-to-earlier-result",
  ]);
  expect(repeat.candidates?.[0]).toMatchObject({
    argument: "command",
    path: ["tokens", 2],
    proposed: { kind: "result", callId: "call_4", path: ["stdout"] },
  });

  const workflow = recordCallsFromEvents("wf_embedded_producer", events)!.workflow;
  expect(workflow.candidates?.map((candidate) => candidate.reason)).toEqual([
    "equal-to-earlier-result",
  ]);
  expect(workflow.candidates?.[0]).toMatchObject({
    stepId: "step1",
    path: ["tokens", 2],
    proposed: { kind: "result", stepId: "step0", path: ["stdout"] },
  });
});

it("reprojects Codex exec profiles through the frozen workflow carrier vocabulary", () => {
  const program = {
    kind: "javascript",
    source: "text('authored output')",
    sourceInterface: "codex-exec",
  };
  const carrier = readWorkflowCallCarrier({
    runtime: RESIN_PROGRAM_RUNTIME,
    name: "exec",
    origins: {},
    inputs: [],
    program,
  });

  expect(carrier?.program).toEqual(program);
});
