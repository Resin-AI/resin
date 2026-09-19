import { NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore, resolvePrivateReference } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";

function recording(sessionId = "session-result-evidence", secondConnection = "files") {
  const store = new InMemoryPrivateValueStore();
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
    event(1, { type: "tool_call", callId: "first", toolName: "load", connection: "files", parameters: { path: "first.csv" } }),
    event(2, { type: "tool_result", callId: "first", toolName: "load", result: "first contents", isError: false, executionDurationMs: 1 }),
    event(3, { type: "message", role: "user", content: "Repeat for the other file" }),
    event(4, { type: "tool_call", callId: "second", toolName: "load", connection: secondConnection, parameters: { path: "second.csv" } }),
    event(5, { type: "tool_result", callId: "second", toolName: "load", result: "second contents", isError: false, executionDurationMs: 1 }),
  ];
  const events = raw.map((entry) => projectEventToMetadataOnly(recorder.observe(entry, { workspaceId: "ws_results" })));
  return { store, events };
}

describe("demonstrations reconstructed from stored call and result events", () => {
  it("uses the final result of a one-call repetition, not the earlier observation-free call", () => {
    const { events, store } = recording();
    const recipe = recordCallsFromEvents("wf-results", events.slice(0, 2), { supportingEvents: events.slice(2) })!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["first"]);
    expect(recipe.workflow.heldOut?.observed.map((entry) => entry.stepId)).toEqual(["step0"]);
    const observed = recipe.workflow.heldOut!.observed[0]!;
    expect(resolvePrivateReference(store, observed.reference)).toBe("second contents");
    expect(recipe.workflow.candidates?.some((candidate) => candidate.argument === "path")).toBe(true);
    expect(JSON.stringify(recipe.workflow)).not.toContain("second contents");
  });

  it("does not borrow execution zero's demonstration from a different session", () => {
    const own = recording("session-own");
    const foreign = recording("session-foreign");
    const recipe = recordCallsFromEvents("wf-scoped", own.events.slice(0, 2), { supportingEvents: foreign.events })!;
    expect(recipe.workflow.steps.map((step) => step.callId)).toEqual(["first"]);
    expect(recipe.workflow.heldOut).toBeUndefined();
  });

  it("does not use an identically named callable reached through another connection", () => {
    const { events } = recording("session-connections", "other-files");
    const recipe = recordCallsFromEvents("wf-connections", events.slice(0, 2), { supportingEvents: events.slice(2) })!;
    expect(recipe.workflow.heldOut).toBeUndefined();
  });

  it("keeps the same final observations under result-boundary delivery and redelivery", () => {
    const { events } = recording();
    const selected = events.slice(0, 2);
    const once = recordCallsFromEvents("wf-parity", selected, { supportingEvents: events.slice(2) })!;
    const repeated = recordCallsFromEvents("wf-parity", selected, { supportingEvents: [...events, ...events] })!;
    expect(repeated.workflow).toEqual(once.workflow);
  });
});
