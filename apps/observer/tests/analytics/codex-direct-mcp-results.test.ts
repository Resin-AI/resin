/**
 * Codex CLI 0.135–0.140 records a direct (non-code-mode) MCP call's result twice under one call
 * id: the `mcp_tool_call_end` event and the model-facing `function_call_output`. Capture keeps one
 * result per call, the MCP end's, and a second, different result for a call never throws out of
 * capture nor replaces the first one's private value: the call's result is marked conflicted.
 */
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { HarnessAdapter } from "@resin/adapter-sdk";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createLocalCallIdentity } from "../../src/analytics/local-call-identity.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import { WorkflowCallRecorder } from "../../src/analytics/workflow-call-recorder.js";
import {
  RESIN_WORKFLOW_RESULT_METADATA_KEY,
  readWorkflowResultCarrier,
} from "../../src/analytics/workflow-carrier.js";
import {
  WORKFLOW_CALL_RESULT_CONFLICT_SLOT,
  workflowPrivateReference,
} from "../../src/analytics/workflow-private-reference.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-codex-direct-mcp";
const SESSION = "019e8313-0609-7f12-8c82-000000000002";
const BASE = Date.parse("2026-06-01T12:06:14.000Z");
const at = (ms: number) => new Date(ms).toISOString();

type Line = { timestamp: string; type: string; payload: Record<string, unknown> };

/** One direct MCP call as Codex 0.137 records it: call, MCP end, model-facing output. */
function directMcpCall(callId: string, text: string, time: number, wallTime: string): Line[] {
  return [
    {
      timestamp: at(time),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "get_connected_instances",
        namespace: "mcp__studio",
        arguments: "{}",
        call_id: callId,
      },
    },
    {
      timestamp: at(time + 1_000),
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: callId,
        invocation: { server: "studio", tool: "get_connected_instances", arguments: {} },
        duration: { secs: 0, nanos: 4_930_994 },
        result: { Ok: { content: [{ type: "text", text }] } },
      },
    },
    {
      timestamp: at(time + 1_005),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output: `Wall time: ${wallTime} seconds\nOutput:\n${JSON.stringify([{ type: "text", text }])}`,
      },
    },
  ];
}

const SESSION_LINES: Line[] = [
  {
    timestamp: at(BASE - 5_000),
    type: "session_meta",
    payload: { id: SESSION, cwd: "/repo", cli_version: "0.137.0-alpha.4" },
  },
  {
    timestamp: at(BASE - 5_000),
    type: "turn_context",
    payload: { turn_id: "turn", cwd: "/repo", model: "gpt-5.5" },
  },
  {
    timestamp: at(BASE - 4_000),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Which Studio places are connected?" }],
    },
  },
];

const INSTANCES = '{"instances":[{"instanceId":"place:1","role":"edit"}]}';

async function capture(lines: Line[]) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({ privateValueStore: store });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of [...SESSION_LINES, ...lines].entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${SESSION}_${ordinal}`,
        sessionId: SESSION,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp: entry.timestamp,
        rawPayload: JSON.stringify(entry),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp: entry.timestamp },
        metadata: {},
      },
      { sessionId: SESSION, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  return { store, observed };
}

function lookup(store: InMemoryPrivateValueStore, sessionId: string, callId: string) {
  return createLocalCallIdentity({
    workspaceId: WORKSPACE,
    privateValues: store,
    adapters: [
      {
        listWorkspaces: async () => [{ workspaceId: WORKSPACE, rootPath: "/repo" }],
        listSessions: async () => [{ sessionId, workspaceId: WORKSPACE }],
      } as unknown as HarnessAdapter,
    ],
  }).lookup(callId);
}

type ToolResult = Extract<NormalizedSessionEvent, { type: "tool_result" }>;

describe("Codex 0.137 direct MCP calls through capture", () => {
  it("records one result per call, the MCP end's content, without a collision", async () => {
    const { store, observed } = await capture([
      ...directMcpCall("call_A", INSTANCES, BASE, "14.1363"),
      ...directMcpCall("call_B", '{"success":true}', BASE + 10_000, "0.5852"),
    ]);
    for (const [callId, text] of [
      ["call_A", INSTANCES],
      ["call_B", '{"success":true}'],
    ] as const) {
      const results = observed.filter(
        (event): event is ToolResult =>
          event.type === "tool_result" && event.callId === callId && !event.isShadow,
      );
      expect(results).toHaveLength(1);
      const carrier = readWorkflowResultCarrier(
        results[0]!.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
      );
      expect(carrier?.baselineReference).toBeDefined();
      expect(store.get(carrier!.baselineReference!)).toBe(text);
      expect((await lookup(store, SESSION, callId))?.result?.value).toBe(text);
    }
  });
});

describe("WorkflowCallRecorder with two results for one call", () => {
  const sessionId = "sess-two-results";
  const base = {
    sessionId,
    workspaceId: WORKSPACE,
    harnessId: "codex-cli",
    timestamp: "2026-06-01T12:00:00.000Z",
    redaction: { redactionStrategy: "none", redactedFields: [] },
  };
  const call = {
    ...base,
    eventId: "evt-call",
    sequenceNumber: 1,
    type: "tool_call",
    callId: "call_twice",
    toolName: "get_status",
    connection: "studio",
    parameters: { target: "edit" },
    isShadow: false,
  } as unknown as NormalizedSessionEvent;
  const result = (eventId: string, value: string, isShadow = false) =>
    ({
      ...base,
      eventId,
      sequenceNumber: 2,
      type: "tool_result",
      callId: "call_twice",
      toolName: "get_status",
      result: value,
      isError: false,
      executionDurationMs: 1,
      isShadow,
    }) as unknown as NormalizedSessionEvent;
  const conflictReference = workflowPrivateReference("demonstration", WORKSPACE, "redacted", [
    sessionId,
    "call_twice",
    WORKFLOW_CALL_RESULT_CONFLICT_SLOT,
  ]);

  it("ignores a shadow result", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    recorder.observe(call, { workspaceId: WORKSPACE });
    const first = recorder.observe(result("evt-r1", "first"), { workspaceId: WORKSPACE });
    const shadow = result("evt-r2", "Wall time: 0.1 seconds\nOutput:\nfirst", true);
    expect(recorder.observe(shadow, { workspaceId: WORKSPACE })).toBe(shadow);
    const reference = readWorkflowResultCarrier(
      first.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
    )?.baselineReference;
    expect(store.get(reference!)).toBe("first");
    expect(store.get(conflictReference)).toBeUndefined();
  });

  it("keeps the first value, marks the result conflicted and never throws", async () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    recorder.observe(call, { workspaceId: WORKSPACE });
    const first = recorder.observe(result("evt-r1", "first"), { workspaceId: WORKSPACE });
    const reference = readWorkflowResultCarrier(
      first.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY],
    )?.baselineReference;
    expect(store.get(reference!)).toBe("first");

    let second: NormalizedSessionEvent | undefined;
    expect(() => {
      second = recorder.observe(result("evt-r2", "second"), { workspaceId: WORKSPACE });
    }).not.toThrow();
    expect(store.get(reference!)).toBe("first");
    expect(store.get(conflictReference)).toBe(true);
    // The conflicting result is no baseline, and the call's recorded result is not one either.
    expect(
      readWorkflowResultCarrier(second?.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])
        ?.baselineReference,
    ).toBeUndefined();
    const recorded = await lookup(store, sessionId, "call_twice");
    expect(recorded).toBeDefined();
    expect(recorded?.result).toBeUndefined();

    // A third result changes nothing and still does not throw.
    expect(() =>
      recorder.observe(result("evt-r3", "third"), { workspaceId: WORKSPACE }),
    ).not.toThrow();
    expect(store.get(reference!)).toBe("first");
  });

  it("accepts the same result delivered twice without a conflict", () => {
    const store = new InMemoryPrivateValueStore();
    const recorder = new WorkflowCallRecorder({ privateValues: store });
    recorder.observe(call, { workspaceId: WORKSPACE });
    recorder.observe(result("evt-r1", "same"), { workspaceId: WORKSPACE });
    const again = recorder.observe(result("evt-r2", "same"), { workspaceId: WORKSPACE });
    expect(
      readWorkflowResultCarrier(again.metadata?.[RESIN_WORKFLOW_RESULT_METADATA_KEY])
        ?.baselineReference,
    ).toBeDefined();
    expect(store.get(conflictReference)).toBeUndefined();
  });
});
