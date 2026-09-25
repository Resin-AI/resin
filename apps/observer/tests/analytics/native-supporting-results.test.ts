import type { NormalizedSessionEvent } from "@resin/contracts";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: "supporting-native",
    timestamp: "2026-09-18T10:00:00.000Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}
function call(
  sequence: number,
  toolName: string,
  parameters: Record<string, unknown>,
  connection = "native-test",
) {
  return event({
    type: "tool_call",
    eventId: `call-event-${sequence}`,
    callId: `call-${sequence}`,
    toolName,
    parameters,
    connection,
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function result(sequence: number, toolName: string, value: unknown) {
  return event({
    type: "tool_result",
    eventId: `result-event-${sequence}`,
    callId: `call-${sequence}`,
    toolName,
    result: value,
    isError: false,
    executionDurationMs: 1,
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function instruction(sequence: number) {
  return event({
    type: "message",
    eventId: `instruction-${sequence}`,
    role: "user",
    content: "Repeat the task with the next input",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function captured(events: NormalizedSessionEvent[]) {
  const store = new InMemoryPrivateValueStore();
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const projected = events.map((entry) =>
    projectEventToMetadataOnly(recorder.observe(entry, { workspaceId: "ws_supporting" })),
  );
  return { store, projected };
}
function execution(events: readonly NormalizedSessionEvent[], index: number) {
  const callIds = new Set(
    events
      .filter(
        (entry) =>
          readWorkflowCallCarrier(entry.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY])
            ?.executionIndex === index,
      )
      .map((entry) => (entry.type === "tool_call" ? entry.callId : undefined)),
  );
  return events.filter(
    (entry) =>
      (entry.type === "tool_call" || entry.type === "tool_result") && callIds.has(entry.callId),
  );
}

describe("supporting executions survive native capture and projection", () => {
  it("keeps the final observed result of a repeated single-call task", () => {
    const { store, projected } = captured([
      call(1, "foreign.calculate", { path: "data/first.csv" }),
      result(1, "foreign.calculate", { total: 10 }),
      instruction(2),
      call(3, "foreign.calculate", { path: "data/second.csv" }),
      result(3, "foreign.calculate", { total: 42 }),
    ]);
    const recipe = recordCallsFromEvents("recording-first", execution(projected, 0), {
      supportingEvents: projected,
    });
    expect(recipe?.workflow.steps.map((step) => step.callId)).toEqual(["call-1"]);
    const observation = recipe?.workflow.heldOut?.observed.find(
      (entry) => entry.stepId === "step0",
    );
    expect(observation).toBeDefined();
    expect(resolvePrivateReference(store, observation!.reference)).toEqual({ total: 42 });
    expect(JSON.stringify(recipe?.workflow)).not.toContain("data/second.csv");
    const repeated = recordCallsFromEvents("recording-first", execution(projected, 0), {
      supportingEvents: [...projected, ...projected],
    });
    expect(repeated?.workflow).toEqual(recipe?.workflow);
  });

  it("retains structured demonstration arguments by local reference", () => {
    const { store, projected } = captured([
      call(1, "foreign.configure", { options: { limits: [2], enabled: false } }),
      result(1, "foreign.configure", "first"),
      instruction(2),
      call(3, "foreign.configure", { options: { limits: [9], enabled: true } }),
      result(3, "foreign.configure", "second"),
    ]);
    const recipe = recordCallsFromEvents("structured", execution(projected, 0), {
      supportingEvents: projected,
    });
    const supplied = recipe?.workflow.heldOut?.inputs.find(
      (entry) => entry.stepId === "step0" && entry.argument === "options",
    );
    expect(supplied).toBeDefined();
    expect(resolvePrivateReference(store, supplied!.reference)).toEqual({
      limits: [9],
      enabled: true,
    });
  });

  it("finds a repeated task after an unrelated first instruction", () => {
    const { store, projected } = captured([
      call(1, "foreign.prepare", { mode: "unrelated" }),
      result(1, "foreign.prepare", "done"),
      instruction(2),
      call(3, "foreign.calculate", { path: "data/first.csv" }),
      result(3, "foreign.calculate", 4),
      instruction(4),
      call(5, "foreign.calculate", { path: "data/second.csv" }),
      result(5, "foreign.calculate", 19),
    ]);
    const recipe = recordCallsFromEvents("task-one", execution(projected, 1), {
      supportingEvents: projected,
    });
    expect(recipe?.workflow.steps.map((step) => step.callId)).toEqual(["call-3"]);
    const observation = recipe?.workflow.heldOut?.observed.find(
      (entry) => entry.stepId === "step0",
    );
    expect(observation).toBeDefined();
    expect(resolvePrivateReference(store, observation!.reference)).toBe(19);
  });

  it("does not use the same tool name on another connection as a demonstration", () => {
    const { projected } = captured([
      call(1, "run", { path: "data/first.csv" }, "server-a"),
      result(1, "run", "a"),
      instruction(2),
      call(3, "run", { path: "data/second.csv" }, "server-b"),
      result(3, "run", "b"),
    ]);
    const recipe = recordCallsFromEvents("connection-a", execution(projected, 0), {
      supportingEvents: projected,
    });
    expect(recipe?.workflow.heldOut).toBeUndefined();
    expect(recipe?.workflow.steps).toHaveLength(1);
  });
});
