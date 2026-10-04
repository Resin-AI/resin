import type {
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  OMP_HARNESS_INTERNAL_URI_SCHEMES,
  OmpRecordDecoder,
  isOmpHarnessInternalUri,
} from "../src/decoder.js";

/** One persisted OMP session line, as `OmpSessionEventSource` hands it to the decoder. */
function record(sessionId: string, seq: number, payload: unknown): RawHarnessRecord {
  const timestamp = `2026-10-04T15:57:${String(seq).padStart(2, "0")}.000Z`;
  return {
    recordId: `rec-${sessionId}-${seq}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: seq,
    recordType: "transcript_line",
    timestamp,
    cursor: { offset: seq * 100, line: seq, sequence: seq, timestamp },
    rawPayload: JSON.stringify(payload),
    metadata: {},
  };
}

/** The three lines OMP 18.6 persists for one call: assistant request, execution start, result. */
function callLines(
  id: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
): unknown[] {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: { i: "intent", ...args } }],
        usage: { input: 10, output: 2, totalTokens: 12 },
      },
    },
    {
      type: "custom",
      customType: "tool_execution_start",
      data: { toolCallId: id, toolName: name, args, intent: "intent" },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: output }],
        details: { timeoutSeconds: 360, wallTimeMs: 5 },
        isError: false,
      },
    },
  ];
}

function decodeAll(
  sessionId: string,
  lines: readonly unknown[],
  decoder = new OmpRecordDecoder(),
): IntermediateSessionEvent[] {
  return lines.flatMap((line, index) => {
    const decoded = decoder.decode(record(sessionId, index + 1, line));
    return decoded === null ? [] : Array.isArray(decoded) ? decoded : [decoded];
  });
}

const calls = (events: readonly IntermediateSessionEvent[]) =>
  events.filter((event): event is IntermediateToolCallEvent => event.type === "tool_call");
const results = (events: readonly IntermediateSessionEvent[]) =>
  events.filter((event): event is IntermediateToolResultEvent => event.type === "tool_result");

const FIRST = "call_bash_1|fc_one";
const SPILL = "call_read_artifact|fc_two";
const SECOND = "call_bash_2|fc_three";

describe("OMP reads of harness-internal URIs", () => {
  it("records only the work around a read of a spilled artifact, with results intact", () => {
    const events = decodeAll("session-artifact-spill", [
      ...callLines(FIRST, "bash", { command: "aws ce get-cost" }, "[raw output: artifact://1]"),
      ...callLines(SPILL, "read", { path: "artifact://1" }, '{"ResultsByTime": []}'),
      ...callLines(SECOND, "bash", { command: "aws ce get-cost --daily" }, "daily"),
    ]);

    expect(calls(events).map((call) => [call.toolName, call.callId, call.parameters])).toEqual([
      ["bash", "call_bash_1_fc_one", { command: "aws ce get-cost" }],
      ["bash", "call_bash_2_fc_three", { command: "aws ce get-cost --daily" }],
    ]);
    expect(
      results(events).map((result) => [result.toolName, result.callId, result.result]),
    ).toEqual([
      ["bash", "call_bash_1_fc_one", "[raw output: artifact://1]"],
      ["bash", "call_bash_2_fc_three", "daily"],
    ]);
    // The read's assistant turn is still a message (its provider usage is still accounted for).
    expect(events.filter((event) => event.type === "message")).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('"artifact://1"');
  });

  it("drops the read whichever record announces it first, and a repeated result record", () => {
    const [assistant, start, result] = callLines(
      SPILL,
      "read",
      { path: "ARTIFACT://4:50-100" },
      "page",
    );
    const argumentless = {
      type: "custom",
      customType: "tool_execution_start",
      data: { toolCallId: SPILL, toolName: "read" },
    };
    const executionEnd = {
      type: "custom",
      customType: "tool_execution_end",
      data: { toolCallId: SPILL, toolName: "read", result: "page" },
    };
    for (const lines of [
      [argumentless, assistant, result],
      [start, assistant, result, executionEnd],
      [start, result],
    ]) {
      const events = decodeAll("session-ordering", lines);
      expect(calls(events)).toEqual([]);
      expect(results(events)).toEqual([]);
    }
  });

  it("keeps ordinary file reads, device-surface reads and writes to internal URIs as they were", () => {
    const decoder = new OmpRecordDecoder({ deviceSurfaceServers: () => ["fixture"] });
    const events = decodeAll(
      "session-unchanged",
      [
        ...callLines("call_file", "read", { path: "src/artifact.ts" }, "file"),
        ...callLines("call_device", "read", { path: "xd://mcp__fixture_status" }, "ok"),
        ...callLines("call_vault", "read", { path: "vault://notes.md" }, "note"),
        ...callLines("call_write", "write", { path: "local://plan.md", content: "x" }, "ok"),
      ],
      decoder,
    );
    expect(calls(events).map((call) => [call.toolName, call.connection])).toEqual([
      ["read", undefined],
      ["status", "fixture"],
      ["read", undefined],
      ["write", undefined],
    ]);
    expect(results(events).map((result) => result.callId)).toEqual([
      "call_file",
      "call_device",
      "call_vault",
      "call_write",
    ]);
  });

  it("names every harness-internal scheme in one list, and only those", () => {
    for (const scheme of OMP_HARNESS_INTERNAL_URI_SCHEMES) {
      expect(isOmpHarnessInternalUri(`${scheme}://x`)).toBe(true);
    }
    for (const other of [
      "xd://mcp__resin_search_tools",
      "https://example.com",
      "pr://1",
      "src/artifact://x",
      "artifact:1",
      "",
      undefined,
      7,
    ]) {
      expect(isOmpHarnessInternalUri(other)).toBe(false);
    }
    expect(isOmpHarnessInternalUri("  history://3 ")).toBe(true);
  });
});
