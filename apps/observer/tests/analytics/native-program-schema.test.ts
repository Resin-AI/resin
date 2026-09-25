import type { NormalizedSessionEvent } from "@resin/contracts";
import { NormalizedSessionEventSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";

const RECORDED_PROGRAM = "printf '%s\\n' 'alpha-7f3c' > f";
const REPEAT_PROGRAM = "printf '%s\\n' 'bravo-9k2m' > f";

function event(fields: Record<string, unknown>): NormalizedSessionEvent {
  return NormalizedSessionEventSchema.parse({
    schemaVersion: "1.0.0",
    sessionId: "schema-session",
    timestamp: "2026-09-19T10:00:00Z",
    redaction: { isRedacted: false, redactedFields: [], redactionStrategy: "mask" },
    ...fields,
  });
}
function call(sequence: number, parameters: Record<string, unknown>) {
  return event({
    eventId: `call-${sequence}`,
    type: "tool_call",
    callId: `call_${sequence}`,
    toolName: "execute_any",
    parameters,
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function result(sequence: number, value: unknown) {
  return event({
    eventId: `result-${sequence}`,
    type: "tool_result",
    callId: `call_${sequence}`,
    toolName: "execute_any",
    result: value,
    isError: false,
    executionDurationMs: 1,
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function userTurn(sequence: number) {
  return event({
    eventId: `turn-${sequence}`,
    type: "message",
    role: "user",
    content: "repeat the task",
    causalRef: { causalSequence: sequence, parentId: null },
  });
}
function record(events: NormalizedSessionEvent[]) {
  const recorder = new WorkflowCallRecorder({ privateValues: new InMemoryPrivateValueStore() });
  return {
    events: events.map((entry) => recorder.observe(entry, { workspaceId: "schema-workspace" })),
  };
}

describe("discovery describes the executor, not the generated workflow's inputs", () => {
  function executorDiscovery() {
    return event({
      eventId: "executor-discovery",
      type: "tool_discovery",
      source: "mcp",
      tools: [
        {
          name: "execute_any",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      causalRef: { causalSequence: 0, parentId: null },
    });
  }

  it("retains a schema-bearing repeat without suggesting a changing program token as input", () => {
    const { events } = record([
      executorDiscovery(),
      call(1, { command: RECORDED_PROGRAM }),
      result(1, ""),
      userTurn(2),
      call(3, { command: REPEAT_PROGRAM }),
      result(3, ""),
    ]);
    const workflow = recordCallsFromEvents("schema-repeat", events.slice(1, 3), {
      supportingEvents: events,
    })!.workflow;
    expect(workflow.steps.map((step) => step.callId)).toEqual(["call_1"]);
    expect(workflow.candidates).toBeUndefined();
  });

  it("does not turn incompatible implementations into a full-command input fallback", () => {
    const { events } = record([
      executorDiscovery(),
      call(1, { command: RECORDED_PROGRAM }),
      result(1, ""),
      userTurn(2),
      call(3, { command: "mkdir -p another && printf '%s' 'different' > another/result" }),
      result(3, ""),
    ]);
    const workflow = recordCallsFromEvents("different-programs", events.slice(1, 3), {
      supportingEvents: events,
    })!.workflow;
    expect(workflow.candidates ?? []).toEqual([]);
    expect(workflow.inputs).toEqual([]);
  });
});
