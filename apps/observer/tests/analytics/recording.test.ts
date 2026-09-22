import { describe, expect, it } from "vitest";
import type { RecordableEvent } from "../../src/analytics/workflow-carrier.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import type { WorkflowCallCarrier, WorkflowCallHeldOut } from "../../src/recording.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  recordCarriedCallsFromEvents,
} from "../../src/recording.js";

const SESSION = "carried-recording-session";
const SCOPE = "carried-recording-scope";

function call(
  id: string,
  sequence: number,
  carrier: WorkflowCallCarrier,
  toolName = carrier.name,
): RecordableEvent {
  return {
    type: "tool_call",
    eventId: `event-${id}`,
    sessionId: SESSION,
    callId: id,
    toolName,
    causalRef: { causalSequence: sequence },
    metadata: { [RESIN_WORKFLOW_CALL_METADATA_KEY]: carrier },
  };
}

function result(
  id: string,
  sequence: number,
  isError: boolean,
  metadata: Record<string, unknown> = {},
): RecordableEvent {
  return {
    type: "tool_result",
    eventId: `result-${id}`,
    sessionId: SESSION,
    callId: id,
    toolName: id.includes("store") ? "store" : "run",
    isError,
    causalRef: { causalSequence: sequence },
    metadata,
  };
}

function heldOut(overrides: Partial<WorkflowCallHeldOut> = {}): WorkflowCallHeldOut {
  return {
    repeats: 0,
    inputs: [{ position: 0, argument: "command", reference: "private:demo:command" }],
    observed: [],
    ...overrides,
  };
}

function recordingEvents(): {
  selected: RecordableEvent[];
  supporting: RecordableEvent[];
} {
  const run: WorkflowCallCarrier = {
    runtime: "resin-program",
    name: "run",
    connection: "local-shell",
    program: { kind: "shell", source: "", argument: "command" },
    origins: { command: { type: "private", reference: "private:value:command" } },
    inputs: [],
    executionIndex: 0,
  };
  const store: WorkflowCallCarrier = {
    runtime: "resin-tool-protocol",
    name: "store",
    connection: "mcp-files",
    origins: {
      payload: { type: "reference", reference: `ref:${SCOPE}:run`, path: ["value"] },
      mode: { type: "input", name: "store_mode" },
    },
    inputs: [{ name: "store_mode", argument: "mode", path: [], type: "string" }],
    provenance: {
      payload: { standing: "recorded", rule: "caller-stated" },
      mode: { standing: "recorded", rule: "caller-stated" },
    },
    dependsOnCallIds: ["run"],
    candidates: [
      {
        argument: "mode",
        path: [],
        proposed: { kind: "input", name: "store_mode", type: "string" },
        reason: "declared-by-the-callable",
        evidence: { declaredProperties: 1 },
        missing: "the recording has not replay-confirmed this input",
      },
    ],
    executionIndex: 0,
  };
  const repeatRun: WorkflowCallCarrier = {
    ...run,
    executionIndex: 1,
    heldOut: heldOut(),
  };
  const repeatStore: WorkflowCallCarrier = {
    ...store,
    executionIndex: 1,
    heldOut: heldOut({
      inputs: [{ position: 1, argument: "mode", reference: "private:demo:mode" }],
      observed: [{ position: 1, reference: "private:demo:result" }],
    }),
  };
  const selected = [
    call("run", 1, run),
    result("run", 2, false, {
      [RESIN_WORKFLOW_RESULT_METADATA_KEY]: { handle: `ref:${SCOPE}:run` },
    }),
    call("store", 3, store),
    result("store", 4, true),
  ];
  const supporting = [
    ...selected,
    call("repeat-run", 6, repeatRun),
    result("repeat-run", 7, false),
    call("repeat-store", 8, repeatStore),
    result("repeat-store", 9, false, {
      [RESIN_WORKFLOW_RESULT_METADATA_KEY]: {
        heldOut: repeatStore.heldOut,
      },
    }),
  ];
  return { selected, supporting };
}

describe("parser-free carried recording", () => {
  it("matches full reconstruction for native/private/held-out/candidate carriers", () => {
    const { selected, supporting } = recordingEvents();
    const full = recordCallsFromEvents("carried-parity", selected, {
      supportingEvents: supporting,
    });
    const carried = recordCarriedCallsFromEvents("carried-parity", selected, {
      supportingEvents: supporting,
    });

    expect(carried?.workflow).toEqual(full?.workflow);
    expect(carried?.skipped).toEqual([]);
    expect(carried?.workflow.steps[0]?.callable.program).toEqual({
      kind: "shell",
      source: "",
      argument: "command",
    });
    expect(carried?.workflow.steps[0]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "private", reference: "private:value:command" },
    });
    expect(carried?.workflow.heldOut?.observed).toEqual([
      { stepId: "step1", reference: "private:demo:result" },
    ]);
    expect(carried?.workflow.steps[1]?.arguments[1]?.provenance).toEqual({
      standing: "recorded",
      rule: "caller-stated",
    });
  });

  it("reports an uncarried call without guessing its executable fields", () => {
    const { selected } = recordingEvents();
    const valid = selected[0]!;
    const malformed = {
      ...selected[2]!,
      eventId: "event-malformed",
      callId: "malformed",
      causalRef: { causalSequence: 3 },
      metadata: {},
    };
    const carried = recordCarriedCallsFromEvents("carried-skipped", [valid, malformed]);
    expect(carried?.workflow.steps).toHaveLength(1);
    expect(carried?.skipped).toMatchObject([{ callId: "malformed" }]);
  });
  it("keeps an unmatched reference unresolved until its scope is explicitly accepted", () => {
    const producer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "produce",
      origins: {},
      inputs: [],
    };
    const consumer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "consume",
      origins: {
        payload: { type: "reference", reference: "ref:foreign:producer", path: [] },
      },
      inputs: [],
    };
    const events = [call("producer", 1, producer), call("consumer", 2, consumer)];
    const unmatched = recordCarriedCallsFromEvents("scope-unmatched", events);
    const matched = recordCarriedCallsFromEvents("scope-matched", events, {
      referenceScopeId: "foreign",
    });

    expect(unmatched?.workflow.steps[1]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "unresolved" },
    });
    expect(matched?.workflow.steps[1]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "result", stepId: "step0", path: [] },
    });
  });

  it("does not bind references when scope and call id only collide by concatenation", () => {
    const producer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "produce",
      origins: {},
      inputs: [],
    };
    const consumer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "consume",
      origins: {
        payload: { type: "reference", reference: "ref:ab:c", path: [] },
      },
      inputs: [],
    };
    const events = [
      call("c", 1, producer),
      result("c", 2, false, {
        [RESIN_WORKFLOW_RESULT_METADATA_KEY]: { handle: "ref:a:bc" },
      }),
      call("consumer", 3, consumer),
    ];
    const carried = recordCarriedCallsFromEvents("scope-collision", events);

    expect(carried?.workflow.steps[1]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "unresolved" },
    });
  });

  it("skips a malformed leading call without shifting later reference step ids", () => {
    const producer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "produce",
      origins: {},
      inputs: [],
      executionIndex: 0,
    };
    const consumer: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "consume",
      origins: {
        payload: { type: "reference", reference: `ref:${SCOPE}:producer`, path: [] },
      },
      inputs: [],
      executionIndex: 0,
    };
    const malformed: RecordableEvent = {
      type: "tool_call",
      eventId: "event-malformed-leading",
      sessionId: SESSION,
      callId: "malformed-leading",
      toolName: "malformed",
      causalRef: { causalSequence: 1 },
      metadata: {},
    };
    const carried = recordCarriedCallsFromEvents("malformed-leading", [
      malformed,
      call("producer", 2, producer),
      result("producer", 3, false, {
        [RESIN_WORKFLOW_RESULT_METADATA_KEY]: { handle: `ref:${SCOPE}:producer` },
      }),
      call("consumer", 4, consumer),
    ]);

    expect(carried?.workflow.steps.map((step) => step.callId)).toEqual(["producer", "consumer"]);
    expect(carried?.workflow.steps[1]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "result", stepId: "step0", path: [] },
    });
    expect(carried?.skipped).toMatchObject([{ callId: "malformed-leading" }]);
  });

  it("distinguishes missing recorded dependencies from optional out-of-scope proposals", () => {
    const incomplete: WorkflowCallCarrier = {
      runtime: "resin-tool-protocol",
      name: "incomplete",
      origins: { payload: { type: "literal", value: "kept" } },
      inputs: [],
      dependsOnCallIds: ["outside-call"],
      candidates: [
        {
          argument: "payload",
          path: [],
          proposed: { kind: "result", callId: "outside-call", path: [] },
          reason: "equal-to-earlier-result",
          missing: "the producer is outside this recording",
        },
      ],
    };
    const carried = recordCarriedCallsFromEvents("outside-graph", [
      call("incomplete", 1, incomplete),
    ]);

    expect(carried?.workflow.steps).toHaveLength(1);
    expect(carried?.workflow.steps[0]?.dependsOn).toEqual([]);
    expect(carried?.workflow.candidates).toBeUndefined();
    expect(carried?.skipped).toMatchObject([{ callId: "incomplete" }]);
    const proposalOnly = recordCarriedCallsFromEvents("proposal-only", [
      call("incomplete", 1, { ...incomplete, dependsOnCallIds: [] }),
    ]);
    expect(proposalOnly?.skipped).toEqual([]);
    expect(proposalOnly?.workflow.steps[0]?.arguments[0]?.source).toMatchObject({
      kind: "template",
      template: { type: "literal", value: "kept" },
    });
  });
  it("preserves nested declared input paths and types in full/carried parity", () => {
    const nested: WorkflowCallCarrier = {
      runtime: "resin-invoke-tool",
      name: "nested",
      origins: {
        meta: {
          type: "object",
          entries: {
            tags: {
              type: "array",
              items: [
                { type: "literal", value: "stable" },
                { type: "input", name: "meta.tags.1" },
              ],
            },
            count: { type: "input", name: "meta.count" },
          },
        },
        ops: {
          type: "array",
          items: [
            {
              type: "object",
              entries: { source: { type: "input", name: "ops.0.source" } },
            },
          ],
        },
      },
      inputs: [
        { name: "meta.tags.1", argument: "meta", path: ["tags", 1], type: "string" },
        { name: "meta.count", argument: "meta", path: ["count"], type: "number" },
        { name: "ops.0.source", argument: "ops", path: [0, "source"], type: "string" },
      ],
      executionIndex: 0,
    };
    const events = [call("nested", 1, nested)];
    const full = recordCallsFromEvents("nested-parity", events);
    const carried = recordCarriedCallsFromEvents("nested-parity", events);

    expect(carried?.workflow).toEqual(full?.workflow);
    expect(carried?.workflow.inputs).toEqual([
      { name: "meta.tags.1", type: "string" },
      { name: "meta.count", type: "number" },
      { name: "ops.0.source", type: "string" },
    ]);
    const argumentsByName = new Map(
      carried?.workflow.steps[0]?.arguments.map((argument) => [argument.name, argument]),
    );
    expect(argumentsByName.get("meta")?.source).toMatchObject({
      kind: "template",
      template: {
        type: "object",
        entries: {
          tags: {
            type: "array",
            items: [
              { type: "literal", value: "stable" },
              { type: "input", name: "meta.tags.1" },
            ],
          },
          count: { type: "input", name: "meta.count" },
        },
      },
    });
    expect(argumentsByName.get("ops")?.source).toMatchObject({
      kind: "template",
      template: {
        type: "array",
        items: [
          {
            type: "object",
            entries: { source: { type: "input", name: "ops.0.source" } },
          },
        ],
      },
    });
  });

  it("retargets proposals that exist only on a repeated supporting execution", () => {
    const { selected, supporting } = recordingEvents();
    const selectedWithoutProposal = selected.map((event) => {
      if (event.eventId !== "event-store") return event;
      const carrier = event.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY] as WorkflowCallCarrier;
      return {
        ...event,
        metadata: {
          ...event.metadata,
          [RESIN_WORKFLOW_CALL_METADATA_KEY]: { ...carrier, candidates: undefined },
        },
      };
    });
    const carried = recordCarriedCallsFromEvents("repeat-proposal", selectedWithoutProposal, {
      supportingEvents: supporting,
    });

    expect(carried?.workflow.candidates).toEqual([
      {
        stepId: "step1",
        argument: "mode",
        path: [],
        proposed: { kind: "input", name: "store_mode", type: "string" },
        reason: "declared-by-the-callable",
        evidence: { declaredProperties: 1 },
        missing: "the recording has not replay-confirmed this input",
      },
    ]);
    expect(carried?.skipped).toEqual([]);
  });

  it("does not let supporting results rewrite selected outcomes or result aliases", () => {
    const { selected } = recordingEvents();
    const original = recordCarriedCallsFromEvents("evidence-only", selected);
    const withSupport = recordCarriedCallsFromEvents("evidence-only", selected, {
      supportingEvents: [
        result("store", 99, false, {
          [RESIN_WORKFLOW_RESULT_METADATA_KEY]: { handle: `ref:${SCOPE}:run` },
        }),
      ],
    });
    expect(withSupport?.workflow.steps[1]?.observed.outcome).toBe("failed");
    expect(withSupport?.workflow).toEqual(original?.workflow);
  });
});
