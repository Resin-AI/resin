import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { type CodexTranscriptPayload, decodeCodexTranscript } from "../src/decoder.js";

/**
 * Codex CLI 0.135–0.140 records a direct (non-code-mode) MCP call three times under one call id:
 * the model's `function_call` (namespaced `mcp__<server>__`), the `mcp_tool_call_end` event with
 * the server's structured result, and the `function_call_output` handed back to the model (a
 * `Wall time` header plus the JSON-escaped content, which differs on every call).
 */
function directMcpCall(
  callId: string,
  options: {
    tool?: string;
    ok?: string;
    err?: string;
    wallTime?: string;
    order?: "end-first" | "output-first";
  } = {},
): CodexTranscriptPayload[] {
  const tool = options.tool ?? "get_status";
  const text = options.err ?? options.ok ?? '{"ok":true}';
  const call: CodexTranscriptPayload = {
    timestamp: "2026-06-01T12:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: tool,
      namespace: "mcp__studio",
      arguments: "{}",
      call_id: callId,
    },
  };
  const end: CodexTranscriptPayload = {
    timestamp: "2026-06-01T12:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      call_id: callId,
      invocation: { server: "studio", tool, arguments: {} },
      duration: { secs: 0, nanos: 4_930_994 },
      result:
        options.err !== undefined
          ? { Err: options.err }
          : { Ok: { content: [{ type: "text", text: options.ok ?? '{"ok":true}' }] } },
    },
  };
  const output: CodexTranscriptPayload = {
    timestamp: "2026-06-01T12:00:01.005Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output: `Wall time: ${options.wallTime ?? "0.0049"} seconds\nOutput:\n${JSON.stringify([
        { type: "text", text },
      ])}`,
    },
  };
  return options.order === "output-first" ? [call, output, end] : [call, end, output];
}

const header: CodexTranscriptPayload[] = [
  {
    timestamp: "2026-06-01T11:59:59.000Z",
    type: "session_meta",
    payload: {
      id: "019e8313-0609-7f12-8c82-000000000001",
      cwd: "/repo",
      originator: "codex_cli_rs",
      cli_version: "0.137.0-alpha.4",
    },
  },
  {
    timestamp: "2026-06-01T11:59:59.500Z",
    type: "turn_context",
    payload: { cwd: "/repo", model: "gpt-5.5" },
  },
];

type ToolResult = Extract<NormalizedSessionEvent, { type: "tool_result" }>;

function results(events: NormalizedSessionEvent[], callId: string): ToolResult[] {
  return events.filter(
    (event): event is ToolResult => event.type === "tool_result" && event.callId === callId,
  );
}

describe("Codex 0.135–0.140 direct MCP calls", () => {
  it("emits one authoritative result per call: the MCP end, not the model-facing output", () => {
    const events = decodeCodexTranscript([...header, ...directMcpCall("call_A")], {
      sessionId: "sess_direct_mcp",
    });
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    const all = results(events, "call_A");
    const authoritative = all.filter((event) => !event.isShadow);
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]).toMatchObject({
      toolName: "get_status",
      result: '{"ok":true}',
      isError: false,
    });
    // The model-facing copy, if kept at all, is a shadow of the same call.
    for (const shadow of all.filter((event) => event.isShadow)) {
      expect(String(shadow.result)).toMatch(/^Wall time: /);
    }
  });

  it("keeps the MCP end's error status authoritative", () => {
    const events = decodeCodexTranscript(
      [...header, ...directMcpCall("call_E", { err: "tool call error: tool call failed" })],
      { sessionId: "sess_direct_mcp_error" },
    );
    const authoritative = results(events, "call_E").filter((event) => !event.isShadow);
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]).toMatchObject({
      result: "tool call error: tool call failed",
      isError: true,
    });
  });

  it("emits one authoritative result when the output precedes the MCP end", () => {
    const events = decodeCodexTranscript(
      [...header, ...directMcpCall("call_R", { order: "output-first" })],
      { sessionId: "sess_direct_mcp_reverse" },
    );
    expect(results(events, "call_R").filter((event) => !event.isShadow)).toHaveLength(1);
  });

  it("keeps each call's own result when several calls interleave", () => {
    const first = directMcpCall("call_1", { ok: "one", wallTime: "0.0016" });
    const second = directMcpCall("call_2", { ok: "two", wallTime: "0.1956" });
    // call, call, end, end, output, output — as Codex records parallel calls.
    const events = decodeCodexTranscript(
      [...header, first[0]!, second[0]!, first[1]!, second[1]!, first[2]!, second[2]!],
      { sessionId: "sess_direct_mcp_parallel" },
    );
    const one = results(events, "call_1").filter((event) => !event.isShadow);
    const two = results(events, "call_2").filter((event) => !event.isShadow);
    expect(one.map((event) => event.result)).toEqual(["one"]);
    expect(two.map((event) => event.result)).toEqual(["two"]);
  });

  it("still records an MCP function call whose only result is its output", () => {
    const [call, , output] = directMcpCall("call_O");
    const events = decodeCodexTranscript([...header, call!, output!], {
      sessionId: "sess_direct_mcp_output_only",
    });
    const authoritative = results(events, "call_O").filter((event) => !event.isShadow);
    expect(authoritative).toHaveLength(1);
    expect(String(authoritative[0]!.result)).toMatch(/^Wall time: /);
  });

  it("still records an MCP end whose call has no output", () => {
    const [call, end] = directMcpCall("call_N");
    const events = decodeCodexTranscript([...header, call!, end!], {
      sessionId: "sess_direct_mcp_end_only",
    });
    const authoritative = results(events, "call_N").filter((event) => !event.isShadow);
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]!.result).toBe('{"ok":true}');
  });

  it("does not shadow a later, unrelated result that reuses no MCP call id", () => {
    const events = decodeCodexTranscript(
      [
        ...header,
        ...directMcpCall("call_M"),
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_S",
            arguments: '{"cmd":"true","workdir":"/repo"}',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_S",
            output: "Process exited with code 0\nOutput:\n",
          },
        },
      ],
      { sessionId: "sess_direct_mcp_then_shell" },
    );
    expect(results(events, "call_S").filter((event) => !event.isShadow)).toHaveLength(1);
  });
});
