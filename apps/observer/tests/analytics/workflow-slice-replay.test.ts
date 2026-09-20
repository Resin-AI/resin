import { type NormalizedSessionEvent, NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import {
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import {
  type RecordableEvent,
  recordCallsFromEvents,
} from "../../src/analytics/workflow-recipe.js";

function capture() {
  const store = new InMemoryPrivateValueStore();
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  let sequence = 0;
  const events: NormalizedSessionEvent[] = [];
  const emit = (fields: Record<string, unknown>) => {
    const event = NormalizedSessionEventSchema.parse({
      schemaVersion: "1.0.0",
      sessionId: "slice-session",
      timestamp: "2026-09-19T10:00:00.000Z",
      eventId: `event-${sequence}`,
      causalRef: { causalSequence: sequence++ },
      redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
      ...fields,
    });
    events.push(
      projectEventToMetadataOnly(recorder.observe(event, { workspaceId: "slice-owner" })),
    );
  };
  const pair = (id: string, name: string, parameters: unknown, result: unknown) => {
    emit({ type: "tool_call", callId: id, toolName: name, parameters });
    emit({
      type: "tool_result",
      callId: id,
      toolName: name,
      result,
      isError: false,
      executionDurationMs: 1,
    });
  };
  emit({
    type: "tool_discovery",
    source: "mcp",
    tools: [
      { name: "inspect", provider: "tool-server" },
      { name: "produce", provider: "tool-server" },
      { name: "consume", provider: "tool-server" },
    ],
  });
  for (const [round, project] of ["alpha-project", "beta-project"].entries()) {
    emit({ type: "message", role: "user", content: "Run this job again" });
    pair(`inspect-${round}`, "inspect", { root: "unchanged-root" }, "inspection-complete");
    pair(`produce-${round}`, "produce", { project }, { release: `release-for-${project}` });
    pair(
      `consume-${round}`,
      "consume",
      { release: `release-for-${project}` },
      { sealed: `release-for-${project}` },
    );
  }
  return { store, events };
}

describe("a selected workflow keeps its own slice of a recorded repetition", () => {
  it("keeps matching input and result evidence without adding the surrounding calls", () => {
    const { store, events } = capture();
    const selected = events.filter(
      (event) => "callId" in event && ["produce-0", "consume-0"].includes(event.callId),
    );
    const recipe = recordCallsFromEvents("slice-workflow", selected as RecordableEvent[], {
      supportingEvents: events as RecordableEvent[],
    })!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["produce-0", "consume-0"]);
    expect(recipe.workflow.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "step0",
          argument: "project",
          proposed: { kind: "input", name: "produce_project", type: "string" },
        }),
        expect.objectContaining({
          stepId: "step1",
          argument: "release",
          proposed: { kind: "result", stepId: "step0", path: ["release"] },
        }),
      ]),
    );
    expect(recipe.workflow.heldOut?.observed.map((entry) => entry.stepId)).toEqual([
      "step0",
      "step1",
    ]);
    const input = recipe.workflow.heldOut!.inputs.find(
      (entry) => entry.stepId === "step0" && entry.argument === "project",
    )!;
    expect(resolvePrivateReference(store, input.reference)).toBe("beta-project");
    const produced = recipe.workflow.heldOut!.observed.find((entry) => entry.stepId === "step0")!;
    expect(resolvePrivateReference(store, produced.reference)).toEqual({
      release: "release-for-beta-project",
    });
  });

  it("honors a call's source-block order rather than a reversed delivery or lexical id", () => {
    const { events } = capture();
    const selected = events.filter(
      (event) => "callId" in event && ["produce-0", "consume-0"].includes(event.callId),
    );
    const oneSourceRecord = selected.map((event) => ({
      ...event,
      eventId:
        "callId" in event && event.callId === "produce-0"
          ? `z-${event.eventId}`
          : `a-${event.eventId}`,
      causalRef: {
        ...event.causalRef,
        causalSequence: 42,
        stepIndex: "callId" in event && event.callId === "produce-0" ? 0 : 1,
      },
    }));
    const recipe = recordCallsFromEvents(
      "ordered",
      [...oneSourceRecord].reverse() as RecordableEvent[],
    )!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["produce-0", "consume-0"]);
    expect(recipe.workflow.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "step1",
          argument: "release",
          proposed: { kind: "result", stepId: "step0", path: ["release"] },
        }),
      ]),
    );
  });
});
