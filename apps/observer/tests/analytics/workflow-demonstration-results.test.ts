import { NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { selectDemonstration } from "../../src/analytics/demonstration-evidence.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { recordCarriedCallsFromEvents } from "../../src/recording.js";

function recording(
  sessionId = "session-result-evidence",
  secondConnection = "files",
  store = new InMemoryPrivateValueStore(),
  secondResult = "second contents",
) {
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const event = (sequence: number, fields: Record<string, unknown>) =>
    NormalizedSessionEventSchema.parse({
      schemaVersion: "1.0.0",
      sessionId,
      timestamp: "2026-09-18T10:00:00.000Z",
      eventId: `${sessionId}-${sequence}`,
      causalRef: { causalSequence: sequence, parentId: null },
      redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
      ...fields,
    });
  const raw = [
    event(1, {
      type: "tool_call",
      callId: "first",
      toolName: "load",
      connection: "files",
      parameters: { path: "first.csv" },
    }),
    event(2, {
      type: "tool_result",
      callId: "first",
      toolName: "load",
      result: "first contents",
      isError: false,
      executionDurationMs: 1,
    }),
    event(3, { type: "message", role: "user", content: "Repeat for the other file" }),
    event(4, {
      type: "tool_call",
      callId: "second",
      toolName: "load",
      connection: secondConnection,
      parameters: { path: "second.csv" },
    }),
    event(5, {
      type: "tool_result",
      callId: "second",
      toolName: "load",
      result: secondResult,
      isError: false,
      executionDurationMs: 1,
    }),
  ];
  const events = raw.map((entry) =>
    projectEventToMetadataOnly(recorder.observe(entry, { workspaceId: "ws_results" })),
  );
  return { store, events };
}

describe("demonstrations reconstructed from stored call and result events", () => {
  it("uses the final result of a one-call repetition, not the earlier observation-free call", () => {
    const { events, store } = recording();
    const recipe = recordCallsFromEvents("wf-results", events.slice(0, 2), {
      supportingEvents: events.slice(2),
    })!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["first"]);
    expect(recipe.workflow.heldOut?.observed.map((entry) => entry.stepId)).toEqual(["step0"]);
    const observed = recipe.workflow.heldOut!.observed[0]!;
    expect(resolvePrivateReference(store, observed.reference)).toBe("second contents");
    expect(JSON.stringify(recipe.workflow)).not.toContain("second contents");
  });

  it("keeps demonstrations from separate recorder instances distinct in one store", () => {
    const store = new InMemoryPrivateValueStore();
    const first = recording("session-alpha", "files", store, "alpha contents");
    const second = recording("session-beta", "files", store, "beta contents");
    const firstRecipe = recordCallsFromEvents("wf-alpha", first.events.slice(0, 2), {
      supportingEvents: first.events.slice(2),
    })!;
    const secondRecipe = recordCallsFromEvents("wf-beta", second.events.slice(0, 2), {
      supportingEvents: second.events.slice(2),
    })!;
    const firstRef = firstRecipe.workflow.heldOut!.observed[0]!.reference;
    const secondRef = secondRecipe.workflow.heldOut!.observed[0]!.reference;
    expect(firstRef).not.toBe(secondRef);
    expect(resolvePrivateReference(store, firstRef)).toBe("alpha contents");
    expect(resolvePrivateReference(store, secondRef)).toBe("beta contents");
  });

  it("refuses to let an existing private reference change value or owner", () => {
    const store = new InMemoryPrivateValueStore();
    store.set("private:test:stable", "first", { workspaceId: "ws_one" });
    store.set("private:test:stable", "first", { workspaceId: "ws_one" });
    expect(() => store.set("private:test:stable", "second", { workspaceId: "ws_one" })).toThrow(
      /already exists/,
    );
    expect(() => store.set("private:test:stable", "first", { workspaceId: "ws_two" })).toThrow(
      /already exists/,
    );
    expect(store.get("private:test:stable")).toBe("first");
  });

  it("does not borrow execution zero's demonstration from a different session", () => {
    const own = recording("session-own");
    const foreign = recording("session-foreign");
    const recipe = recordCallsFromEvents("wf-scoped", own.events.slice(0, 2), {
      supportingEvents: foreign.events,
    })!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["first"]);
    expect(recipe.workflow.heldOut).toBeUndefined();
  });

  it("does not use an identically named callable reached through another connection", () => {
    const { events } = recording("session-connections", "other-files");
    const recipe = recordCallsFromEvents("wf-connections", events.slice(0, 2), {
      supportingEvents: events.slice(2),
    })!;
    expect(recipe.workflow.heldOut).toBeUndefined();
  });

  it("keeps the same final observations under result-boundary delivery and redelivery", () => {
    const { events } = recording();
    const selected = events.slice(0, 2);
    const once = recordCallsFromEvents("wf-parity", selected, {
      supportingEvents: events.slice(2),
    })!;
    const repeated = recordCallsFromEvents("wf-parity", selected, {
      supportingEvents: [...events, ...events],
    })!;
    expect(repeated.workflow).toEqual(once.workflow);
  });
});

describe("demonstration slice selection", () => {
  it("maps an unambiguous shorter repeat onto a noisier baseline", () => {
    const calls = [
      { sessionId: "session", callId: "inspect", executionIndex: 0, identity: "inspect" },
      { sessionId: "session", callId: "load-original", executionIndex: 0, identity: "load" },
      { sessionId: "session", callId: "load-repeat", executionIndex: 1, identity: "load" },
    ];
    const demonstration = selectDemonstration([calls[1]!], calls, [
      {
        sessionId: "session",
        callId: "load-repeat",
        snapshot: {
          repeats: 0,
          inputs: [{ position: 0, argument: "path", reference: "private:input" }],
          observed: [{ position: 0, reference: "private:result" }],
        },
      },
    ]);

    expect(demonstration).toEqual({
      repeats: 0,
      inputs: [{ position: 0, argument: "path", reference: "private:input" }],
      observed: [{ position: 0, reference: "private:result" }],
      calls: [{ position: 0, callId: "load-repeat" }],
    });
  });
});

describe("a held-out demonstration covers the whole plan", () => {
  /** Loads then saves a file, then repeats the work for another file: whole, or only the load. */
  function repeat(sessionId: string, repeatSaves: boolean) {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    let sequence = 0;
    const events = [] as ReturnType<typeof projectEventToMetadataOnly>[];
    const emit = (fields: Record<string, unknown>) =>
      events.push(
        projectEventToMetadataOnly(
          recorder.observe(
            NormalizedSessionEventSchema.parse({
              schemaVersion: "1.0.0",
              sessionId,
              timestamp: "2026-09-18T10:00:00.000Z",
              eventId: `${sessionId}-${++sequence}`,
              causalRef: { causalSequence: sequence, parentId: null },
              redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
              ...fields,
            }),
            { workspaceId: "ws_results" },
          ),
        ),
      );
    const call = (callId: string, toolName: string, path: string, result: string) => {
      emit({ type: "tool_call", callId, toolName, connection: "files", parameters: { path } });
      emit({
        type: "tool_result",
        callId,
        toolName,
        result,
        isError: false,
        executionDurationMs: 1,
      });
    };
    emit({ type: "message", role: "user", content: "Load first.csv and save it" });
    call("load-1", "load", "first.csv", "first contents");
    call("save-1", "save", "first.csv", "saved first");
    const planEnd = events.length;
    emit({ type: "message", role: "user", content: "Repeat for second.csv" });
    call("load-2", "load", "second.csv", "second contents");
    if (repeatSaves) call("save-2", "save", "second.csv", "saved second");
    return recordCarriedCallsFromEvents(`wf-${sessionId}`, events.slice(0, planEnd), {
      supportingEvents: events.slice(planEnd),
    })!;
  }

  it("offers no held-out demonstration when the repeat ran only part of the plan", () => {
    const recipe = repeat("session-partial-repeat", false);
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["load-1", "save-1"]);
    expect(recipe.workflow.heldOut).toBeUndefined();
  });

  it("offers the repeat as held-out when it ran every step in order", () => {
    const recipe = repeat("session-whole-repeat", true);
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["load-1", "save-1"]);
    expect(recipe.workflow.heldOut?.calls).toEqual([
      { stepId: recipe.workflow.steps[0]!.id, callIds: ["load-2"] },
      { stepId: recipe.workflow.steps[1]!.id, callIds: ["save-2"] },
    ]);
  });
});
