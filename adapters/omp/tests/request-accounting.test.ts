/**
 * Model-request accounting for OMP sessions: each assistant response's native usage is one
 * request-scoped record, and every event it produced, its calls' results included, names that
 * request. Events also carry the task of the session's latest prompt, and only a Resin gateway
 * call's result carries the Resin invocations it reports.
 */

import {
  ProviderReportedUsageSchema,
  formatResinInvocationReceiptText,
  providerUsageNormalizedTotal,
  providerUsageRequestKey,
  resinInvocationReceiptMeta,
} from "@resin/contracts";
import type {
  IntermediateMessageEvent,
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  IntermediateToolResultEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";

const INVOCATION_A = "inv_0123456789abcdef0123456789abcdef";
const INVOCATION_B = "inv_fedcba9876543210fedcba9876543210";

function record(
  sessionId: string,
  sequence: number,
  payload: unknown,
  metadata: Record<string, unknown> = {},
): RawHarnessRecord {
  const timestamp = `2026-10-08T10:00:${String(sequence % 60).padStart(2, "0")}.000Z`;
  return {
    recordId: `${sessionId}-${sequence}`,
    sessionId,
    harnessId: "omp",
    sequenceNumber: sequence,
    timestamp,
    recordType: "transcript_line",
    rawPayload: payload,
    cursor: { offset: sequence * 100, line: sequence, sequence, timestamp },
    metadata,
  };
}

/** Decodes payloads in order as one session's records and flattens the events. */
function decodeAll(
  decoder: OmpRecordDecoder,
  sessionId: string,
  payloads: unknown[],
): IntermediateSessionEvent[] {
  return payloads.flatMap((payload, index) => {
    const decoded = decoder.decode(record(sessionId, index + 1, payload));
    return decoded === null ? [] : Array.isArray(decoded) ? decoded : [decoded];
  });
}

function messages(events: IntermediateSessionEvent[]): IntermediateMessageEvent[] {
  return events.filter((event): event is IntermediateMessageEvent => event.type === "message");
}

function calls(events: IntermediateSessionEvent[]): IntermediateToolCallEvent[] {
  return events.filter((event): event is IntermediateToolCallEvent => event.type === "tool_call");
}

function results(events: IntermediateSessionEvent[]): IntermediateToolResultEvent[] {
  return events.filter(
    (event): event is IntermediateToolResultEvent => event.type === "tool_result",
  );
}

/** An OMP session-file assistant record: record id outside, the message (and usage) inside. */
function assistant(
  id: string,
  message: { responseId?: string | null; usage?: unknown; content?: unknown[] } & Record<
    string,
    unknown
  >,
): unknown {
  return {
    type: "message",
    id,
    parentId: "parent",
    message: {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
      content: [{ type: "text", text: "Working." }],
      ...message,
    },
  };
}

function userPrompt(id: string, text: string): unknown {
  return {
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResult(
  callId: string,
  toolName: string,
  content: unknown[],
  details?: Record<string, unknown>,
): unknown {
  return {
    type: "message",
    id: `result-${callId}`,
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content,
      isError: false,
      ...(details === undefined ? {} : { details }),
    },
  };
}

const text = (value: string) => ({ type: "text", text: value });

describe("OMP request-scoped assistant usage", () => {
  it("records native usage as one request keyed by the provider response id", () => {
    const [message] = messages(
      decodeAll(new OmpRecordDecoder(), "s-native", [
        assistant("rec0003c", {
          responseId: "msg_01Ab3Cd5Ef7Gh9Jk2Lm4Np6Q",
          usage: {
            input: 2,
            output: 108,
            cacheRead: 11000,
            cacheWrite: 1142,
            totalTokens: 12252,
            cost: { output: 0.00108, cacheRead: 0.0022, cacheWrite: 0.0045, total: 0.007852 },
            cttl: { ephemeral1h: 1142 },
          },
        }),
      ]),
    );
    expect(message?.providerUsage).toEqual({
      provider: "anthropic",
      model: "claude-test",
      accountingVersion: "omp-v1",
      availability: "complete",
      usageScope: "request",
      requestId: "msg_01Ab3Cd5Ef7Gh9Jk2Lm4Np6Q",
      inputTokens: 2,
      cachedInputTokens: 11000,
      cacheWriteTokens: 1142,
      outputTokens: 108,
      totalTokens: 12252,
      costMicroUsd: 7852,
      costProvenance: "harness_estimate",
    });
    expect(ProviderReportedUsageSchema.safeParse(message?.providerUsage).success).toBe(true);
    expect(message?.metadata?.modelRequestId).toBe("msg_01Ab3Cd5Ef7Gh9Jk2Lm4Np6Q");
  });

  it("falls back to the session record id when OMP recorded no response id", () => {
    const [message] = messages(
      decodeAll(new OmpRecordDecoder(), "s-record-id", [
        assistant("a1b2c3d4", {
          responseId: null,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        }),
      ]),
    );
    expect(message?.providerUsage).toMatchObject({
      usageScope: "request",
      requestId: "a1b2c3d4",
      availability: "complete",
      totalTokens: 15,
    });
    expect(message?.metadata?.modelRequestId).toBe("a1b2c3d4");
  });

  it("keeps OMP's uncached input as reported and counts cache writes as their own category", () => {
    const [message] = messages(
      decodeAll(new OmpRecordDecoder(), "s-cache", [
        assistant("rec-cache", {
          responseId: "msg_cache",
          usage: { input: 7, output: 40, cacheRead: 30000, cacheWrite: 2500, totalTokens: 32547 },
        }),
      ]),
    );
    const usage = message?.providerUsage;
    // OMP's `input` is already uncached: cache reads are never subtracted from it.
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.cachedInputTokens).toBe(30000);
    expect(usage?.cacheWriteTokens).toBe(2500);
    expect(usage?.availability).toBe("complete");
    expect(usage && providerUsageNormalizedTotal(usage)).toBe(32547);
  });

  it("counts reasoning inside output and never adds it to the total", () => {
    const [message] = messages(
      decodeAll(new OmpRecordDecoder(), "s-reasoning", [
        assistant("rec-reasoning", {
          responseId: "resp_reasoning",
          usage: {
            input: 100,
            output: 300,
            reasoningTokens: 120,
            cacheRead: 50,
            cacheWrite: 0,
            totalTokens: 450,
          },
        }),
      ]),
    );
    expect(message?.providerUsage).toMatchObject({
      availability: "complete",
      outputTokens: 300,
      reasoningTokens: 120,
      totalTokens: 450,
    });
  });

  it.each([
    {
      name: "a missing cache-write count",
      usage: { input: 10, output: 5, cacheRead: 100, totalTokens: 115 },
      totalTokens: 115,
    },
    {
      name: "a source total that disagrees with the categories",
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 200 },
      totalTokens: 200,
    },
    {
      name: "orchestration tokens counted in the total",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 120,
        orchestration: { input: 3, cacheRead: 0, output: 2 },
      },
      totalTokens: 120,
    },
    {
      name: "orchestration tokens even when the total matches the categories",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 115,
        orchestration: { input: 0, cacheRead: 0, output: 4 },
      },
      totalTokens: 115,
    },
    {
      name: "more reasoning than output",
      usage: {
        input: 10,
        output: 5,
        reasoningTokens: 9,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 115,
      },
      totalTokens: 115,
    },
  ])("keeps every reported value as partial for $name", ({ usage, totalTokens }) => {
    const [message] = messages(
      decodeAll(new OmpRecordDecoder(), "s-partial", [
        assistant("rec-partial", {
          responseId: "msg_partial",
          usage: { ...usage, cost: { total: 0.001 } },
        }),
      ]),
    );
    const providerUsage = message?.providerUsage;
    expect(providerUsage).toMatchObject({
      availability: "partial",
      usageScope: "request",
      requestId: "msg_partial",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 100,
      totalTokens,
      costMicroUsd: 1000,
      costProvenance: "harness_estimate",
    });
    if (!("cacheWrite" in usage)) expect(providerUsage).not.toHaveProperty("cacheWriteTokens");
    expect(ProviderReportedUsageSchema.safeParse(providerUsage).success).toBe(true);
    expect(providerUsage && providerUsageNormalizedTotal(providerUsage)).toBeUndefined();
  });

  it("gives repeated snapshots of one request one identity and identical counts of two requests two", () => {
    const usage = { input: 4, output: 9, cacheRead: 200, cacheWrite: 0, totalTokens: 213 };
    const first = messages(
      decodeAll(new OmpRecordDecoder(), "s-identity", [
        assistant("rec-1", { responseId: "msg_one", usage }),
      ]),
    )[0]?.providerUsage;
    // Re-ingesting the same record in a fresh decoder is a snapshot of the same request.
    const replay = messages(
      decodeAll(new OmpRecordDecoder(), "s-identity", [
        assistant("rec-1", { responseId: "msg_one", usage }),
      ]),
    )[0]?.providerUsage;
    const other = messages(
      decodeAll(new OmpRecordDecoder(), "s-identity", [
        assistant("rec-2", { responseId: "msg_two", usage }),
      ]),
    )[0]?.providerUsage;
    if (!first || !replay || !other) throw new Error("expected request usage");
    expect(providerUsageRequestKey("s-identity", replay)).toBe(
      providerUsageRequestKey("s-identity", first),
    );
    expect(providerUsageRequestKey("s-identity", other)).not.toBe(
      providerUsageRequestKey("s-identity", first),
    );
    expect(other.totalTokens).toBe(first.totalTokens);
  });

  it("links a response that recorded no usage without inventing any", () => {
    const events = decodeAll(new OmpRecordDecoder(), "s-no-usage", [
      assistant("rec-no-usage", {
        content: [toolCall("call_no_usage", "read", { path: "a.txt" })],
      }),
    ]);
    const [message] = messages(events);
    expect(message?.providerUsage).toBeUndefined();
    expect(message?.metadata?.modelRequestId).toBe("rec-no-usage");
    expect(calls(events)[0]?.metadata?.modelRequestId).toBe("rec-no-usage");
  });

  it("keeps legacy usage for stream records without ids, other usage shapes, and non-assistant records", () => {
    const decoder = new OmpRecordDecoder();
    const events = decodeAll(decoder, "s-legacy", [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: "streamed",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        },
      },
      {
        type: "message",
        id: "rec-openai-shape",
        role: "assistant",
        content: "other shape",
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      {
        type: "tool_result",
        callId: "call_legacy",
        toolName: "bash",
        output: "ok",
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ]);
    const [streamed, otherShape] = messages(events);
    expect(streamed?.providerUsage).toMatchObject({ availability: "complete", totalTokens: 15 });
    expect(streamed?.providerUsage).not.toHaveProperty("usageScope");
    expect(streamed?.metadata).not.toHaveProperty("modelRequestId");
    // An id still links the response, but categories of an unstated meaning stay legacy.
    expect(otherShape?.providerUsage).not.toHaveProperty("usageScope");
    expect(otherShape?.providerUsage?.inputTokens).toBe(100);
    expect(otherShape?.metadata?.modelRequestId).toBe("rec-openai-shape");
    expect(results(events)[0]?.providerUsage).not.toHaveProperty("usageScope");
  });
});

describe("OMP model-request links", () => {
  it("names one request on every parallel call of a response, its reasoning, and their results", () => {
    const events = decodeAll(new OmpRecordDecoder(), "s-parallel", [
      assistant("rec-reason", { responseId: "msg_parallel", thinking: "Plan the reads." }),
      assistant("rec-parallel", {
        responseId: "msg_parallel",
        usage: { input: 3, output: 30, cacheRead: 500, cacheWrite: 10, totalTokens: 543 },
        content: [
          text("Reading both."),
          toolCall("call_read", "read", { path: "a.txt" }),
          toolCall("call_bash", "bash", { command: "ls" }),
        ],
      }),
      // Results arrive in the opposite order of the calls.
      toolResult("call_bash", "bash", [text("a.txt")]),
      toolResult("call_read", "read", [text("contents")]),
      assistant("rec-next", {
        responseId: "msg_next",
        usage: { input: 3, output: 30, cacheRead: 500, cacheWrite: 10, totalTokens: 543 },
        content: [toolCall("call_next", "read", { path: "b.txt" })],
      }),
      toolResult("call_next", "read", [text("more")]),
    ]);
    const reasoning = events.find((event) => event.type === "model_reasoning");
    expect(reasoning?.metadata?.modelRequestId).toBe("msg_parallel");
    expect(
      calls(events).map((call) => [call.callId, call.metadata?.modelRequestId, call.providerUsage]),
    ).toEqual([
      ["call_read", "msg_parallel", undefined],
      ["call_bash", "msg_parallel", undefined],
      ["call_next", "msg_next", undefined],
    ]);
    expect(
      results(events).map((result) => [result.callId, result.metadata?.modelRequestId]),
    ).toEqual([
      ["call_bash", "msg_parallel"],
      ["call_read", "msg_parallel"],
      ["call_next", "msg_next"],
    ]);
    // The response's usage is recorded once, on its message.
    expect(messages(events).filter((message) => message.providerUsage)).toHaveLength(2);
  });

  it("names the latest prompt's task on every later event until the next prompt", () => {
    const decoder = new OmpRecordDecoder();
    const events = decodeAll(decoder, "s-task", [
      { type: "session", id: "session-header", version: 3 },
      userPrompt("prompt-1", "Fix the bug."),
      assistant("rec-a", {
        responseId: "msg_a",
        content: [toolCall("call_a", "bash", { command: "ls" })],
      }),
      toolResult("call_a", "bash", [text("ok")]),
      // A user-role record that only carries tool results is not a prompt.
      {
        type: "message",
        id: "tool-results-only",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }],
        },
      },
      userPrompt("prompt-2", "Now the tests."),
      assistant("rec-b", { responseId: "msg_b" }),
    ]);
    expect(events.map((event) => [event.type, event.metadata?.taskId])).toEqual([
      ["session_lifecycle", undefined],
      ["message", "prompt-1"],
      ["message", "prompt-1"],
      ["tool_call", "prompt-1"],
      ["tool_result", "prompt-1"],
      ["message", "prompt-1"],
      ["message", "prompt-2"],
      ["message", "prompt-2"],
    ]);

    // Another session of the same decoder has no task of its own yet.
    const [otherSession] = decodeAll(decoder, "s-task-other", [
      assistant("rec-c", { responseId: "msg_c" }),
    ]);
    expect(otherSession?.metadata).not.toHaveProperty("taskId");

    // A restarted decoder does not know the task until the next prompt, and a prompt without an id
    // leaves the task unknown rather than keeping the previous one.
    const restarted = decodeAll(new OmpRecordDecoder(), "s-task", [
      assistant("rec-d", { responseId: "msg_d" }),
      userPrompt("prompt-3", "Continue."),
      assistant("rec-e", { responseId: "msg_e" }),
      { type: "message", role: "user", content: "no id" },
      assistant("rec-f", { responseId: "msg_f" }),
    ]);
    expect(restarted.map((event) => event.metadata?.taskId)).toEqual([
      undefined,
      "prompt-3",
      "prompt-3",
      undefined,
      undefined,
    ]);
  });

  it("drops link metadata a record carried instead of the decoder", () => {
    const decoder = new OmpRecordDecoder();
    const decoded = decoder.decode(
      record("s-forged", 1, toolResult("call_forged", "bash", [text("ok")]), {
        modelRequestId: "forged",
        taskId: "forged",
        resinInvocationId: INVOCATION_A,
      }),
    ) as IntermediateToolResultEvent;
    expect(decoded.metadata).not.toHaveProperty("modelRequestId");
    expect(decoded.metadata).not.toHaveProperty("taskId");
    expect(decoded.metadata).not.toHaveProperty("resinInvocationId");
  });
});

describe("OMP auxiliary requests and delegated usage", () => {
  /** The shape of OMP 18.6+'s session-file `model_usage` record (pi-coding-agent ModelUsageEntry). */
  const judgeRecord = {
    type: "model_usage",
    id: "aux0001a",
    parentId: "rec0001a",
    timestamp: "2026-01-01T00:00:01.000Z",
    purpose: "auto-thinking",
    role: "judge",
    api: "example-api",
    provider: "example-judge",
    model: "judge-mini",
    usage: {
      input: 200,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 250,
      reasoningTokens: 40,
      cost: { input: 0.0003, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0004 },
    },
    stopReason: "stop",
  };

  it("records a model_usage side call as its own request with its provider, model and purpose", () => {
    const events = decodeAll(new OmpRecordDecoder(), "s-judge", [
      userPrompt("prompt-1", "Fix the bug."),
      judgeRecord,
    ]);
    const side = events.find((event) => event.type === "unknown_passthrough");
    expect(side).toMatchObject({ type: "unknown_passthrough", rawEventType: "model_usage" });
    expect(side?.metadata).toMatchObject({
      modelRequestId: "aux0001a",
      modelRequestPurpose: "auto-thinking",
      taskId: "prompt-1",
    });
    expect(side?.metadata).not.toHaveProperty("stopReason");
    expect(side?.providerUsage).toEqual({
      provider: "example-judge",
      model: "judge-mini",
      accountingVersion: "omp-v1",
      availability: "complete",
      usageScope: "request",
      requestId: "aux0001a",
      inputTokens: 200,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningTokens: 40,
      totalTokens: 250,
      costMicroUsd: 400,
      costProvenance: "harness_estimate",
    });
    expect(ProviderReportedUsageSchema.safeParse(side?.providerUsage).success).toBe(true);
  });

  it("keeps a side call without a usable purpose auxiliary and one without usage linked only", () => {
    const events = decodeAll(new OmpRecordDecoder(), "s-judge-bare", [
      { ...judgeRecord, id: "aux-1", purpose: "bad purpose" },
      { ...judgeRecord, id: "aux-2", usage: undefined },
    ]);
    expect(events.map((event) => event.metadata?.modelRequestPurpose)).toEqual([
      "auxiliary",
      "auto-thinking",
    ]);
    expect(events[1]?.metadata?.modelRequestId).toBe("aux-2");
    expect(events[1]?.providerUsage).toBeUndefined();
  });

  it("keeps a task result's reported subagent usage as evidence, never as a request", () => {
    const events = decodeAll(new OmpRecordDecoder(), "s-task-usage", [
      assistant("rec-task", {
        responseId: "msg_task",
        content: [
          toolCall("call_task", "task", { tasks: [] }),
          toolCall("call_bash", "bash", { command: "ls" }),
        ],
      }),
      toolResult("call_task", "task", [text("done")], {
        results: [],
        usage: {
          input: 12,
          output: 900,
          cacheRead: 30_000,
          cacheWrite: 4_000,
          totalTokens: 34_912,
          cost: { total: 0.081 },
        },
      }),
      toolResult("call_bash", "bash", [text("ok")], { usage: { input: 1, output: 1 } }),
    ]);
    const [taskResult, bashResult] = results(events);
    expect(taskResult?.providerUsage).toBeUndefined();
    expect(taskResult?.metadata?.delegatedModelUsage).toEqual({
      version: 1,
      inputTokens: 12,
      cachedInputTokens: 30_000,
      cacheWriteTokens: 4_000,
      outputTokens: 900,
      totalTokens: 34_912,
      costMicroUsd: 81_000,
      costProvenance: "harness_estimate",
    });
    expect(taskResult?.metadata?.modelRequestId).toBe("msg_task");
    expect(bashResult?.metadata).not.toHaveProperty("delegatedModelUsage");
  });
});

describe("OMP Resin invocation receipts", () => {
  const receiptA = text(formatResinInvocationReceiptText({ invocationId: INVOCATION_A }));
  const receiptBenchA = text(
    formatResinInvocationReceiptText({ invocationId: INVOCATION_A, benchmarkId: "bench-1" }),
  );
  const receiptBenchB = text(
    formatResinInvocationReceiptText({ invocationId: INVOCATION_B, benchmarkId: "bench-1" }),
  );

  function resultOf(
    decoder: OmpRecordDecoder,
    sessionId: string,
    call: unknown,
    result: unknown,
  ): IntermediateToolResultEvent | undefined {
    const callRecord = assistant("rec-call", { responseId: "msg_call", content: [call] });
    return results(decodeAll(decoder, sessionId, [callRecord, result]))[0];
  }

  it("reads a direct Resin MCP call's receipt from the server's recorded content and _meta", () => {
    const result = resultOf(
      new OmpRecordDecoder(),
      "s-receipt-direct",
      toolCall("call_direct", "mcp__resin_invoke_tool", { name: "lint" }),
      toolResult("call_direct", "mcp__resin_invoke_tool", [text(`ran\n\n${receiptBenchA.text}`)], {
        serverName: "resin",
        mcpToolName: "invoke_tool",
        rawContent: [text("ran"), receiptBenchA],
        mcpMeta: {
          "resin/invocation": resinInvocationReceiptMeta({
            invocationId: INVOCATION_A,
            benchmarkId: "bench-1",
          }),
        },
      }),
    );
    expect(result?.metadata).toMatchObject({
      modelRequestId: "msg_call",
      resinInvocationId: INVOCATION_A,
      benchmarkId: "bench-1",
    });
  });

  it("reads several receipts of a Resin call made through the device surface", () => {
    const result = resultOf(
      new OmpRecordDecoder({ deviceSurfaceServers: () => ["resin"] }),
      "s-receipt-surface",
      toolCall("call_surface", "write", {
        path: "xd://mcp__resin_invoke_tool",
        content: '{"name":"lint"}',
      }),
      toolResult("call_surface", "write", [text("ran")], {
        xdev: {
          tool: "mcp__resin_invoke_tool",
          mode: "execute",
          inner: {
            serverName: "resin",
            mcpToolName: "invoke_tool",
            rawContent: [text("ran"), receiptBenchA, receiptBenchB],
          },
        },
      }),
    );
    expect(result?.toolName).toBe("invoke_tool");
    expect(result?.metadata).toMatchObject({
      resinInvocationIds: [INVOCATION_A, INVOCATION_B],
      benchmarkId: "bench-1",
    });
    expect(result?.metadata).not.toHaveProperty("resinInvocationId");
  });

  it("reads the recorded content of a Resin call whose result kept no MCP details", () => {
    const result = resultOf(
      new OmpRecordDecoder(),
      "s-receipt-content",
      toolCall("call_content", "mcp__resin_invoke_tool", { name: "lint" }),
      toolResult("call_content", "mcp__resin_invoke_tool", [text("ran"), receiptA]),
    );
    expect(result?.metadata?.resinInvocationId).toBe(INVOCATION_A);
  });

  it("reports nothing when the receipt disagrees with the result's _meta", () => {
    const result = resultOf(
      new OmpRecordDecoder(),
      "s-receipt-disagree",
      toolCall("call_disagree", "mcp__resin_invoke_tool", { name: "lint" }),
      toolResult("call_disagree", "mcp__resin_invoke_tool", [text("ran")], {
        rawContent: [text("ran"), receiptA],
        mcpMeta: { "resin/invocation": resinInvocationReceiptMeta({ invocationId: INVOCATION_B }) },
      }),
    );
    expect(result?.metadata).not.toHaveProperty("resinInvocationId");
    expect(result?.metadata).not.toHaveProperty("resinInvocationIds");
  });

  it.each([
    { name: "a built-in tool", toolName: "bash", details: undefined },
    {
      name: "another MCP server's tool",
      toolName: "mcp__github_search",
      details: { serverName: "github", rawContent: [text("found"), receiptA] },
    },
  ])("never reads receipts from $name's output", ({ toolName, details }) => {
    const result = resultOf(
      new OmpRecordDecoder({ deviceSurfaceServers: () => ["resin", "github"] }),
      `s-receipt-${toolName}`,
      toolCall("call_other", toolName, { command: "echo" }),
      toolResult("call_other", toolName, [text("found"), receiptA], details),
    );
    expect(result?.metadata?.modelRequestId).toBe("msg_call");
    expect(result?.metadata).not.toHaveProperty("resinInvocationId");
    expect(result?.metadata).not.toHaveProperty("benchmarkId");
  });

  describe("from OMP's recorded transport when the server is not configured", () => {
    // OMP's recorded shape for a learned tool invoked through `write xd://mcp__resin_invoke_tool`
    // whose error result carries the gateway's receipt: OMP keeps the MCP server's own content and
    // `_meta` under `details.xdev.inner`. Identifiers are fictitious.
    const recordedInvocation = "inv_00112233445566778899aabbccddeeff";
    const recordedBenchmark = "bench-recorded-1";
    const recordedReceipt = text(
      formatResinInvocationReceiptText({
        invocationId: recordedInvocation,
        benchmarkId: recordedBenchmark,
      }),
    );
    const recordedMeta = {
      resinFailureReason: "tool_error",
      "resin/invocation": resinInvocationReceiptMeta({
        invocationId: recordedInvocation,
        benchmarkId: recordedBenchmark,
      }),
    };
    const deviceCall = toolCall("call_device", "write", {
      path: "xd://mcp__resin_invoke_tool",
      content: JSON.stringify({ name: "lint_sources", parameters: {} }),
    });
    function deviceResult(xdev: Record<string, unknown>, recordedToolName = "write"): unknown {
      return {
        type: "message",
        id: "result-device",
        message: {
          role: "toolResult",
          toolCallId: "call_device",
          toolName: recordedToolName,
          content: [text(`Error: lint failed\n\n${recordedReceipt.text}`)],
          isError: true,
          details: { xdev },
        },
      };
    }
    const recordedXdev = {
      tool: "mcp__resin_invoke_tool",
      mode: "execute",
      tier: "write",
      args: { name: "lint_sources", parameters: {} },
      inner: {
        isError: true,
        mcpMeta: recordedMeta,
        mcpToolName: "invoke_tool",
        provider: "native",
        rawContent: [text("lint failed"), recordedReceipt],
        serverName: "resin",
      },
    };

    it("reads the receipt and keeps the result's request and task links", () => {
      const events = decodeAll(new OmpRecordDecoder(), "s-receipt-recorded", [
        userPrompt("prompt-lint", "Lint the sources."),
        assistant("rec-device", { responseId: "msg_device", content: [deviceCall] }),
        deviceResult(recordedXdev),
      ]);
      const [result] = results(events);
      expect(result?.metadata).toMatchObject({
        resinInvocationId: recordedInvocation,
        benchmarkId: recordedBenchmark,
        modelRequestId: "msg_device",
        taskId: "prompt-lint",
      });
    });

    it.each([
      {
        name: "a different recorded tool",
        xdev: recordedXdev,
        recordedToolName: "bash",
      },
      {
        name: "a device naming another tool than its inner server's",
        xdev: { ...recordedXdev, tool: "mcp__github_search" },
        recordedToolName: "write",
      },
      {
        name: "a help dispatch",
        xdev: { ...recordedXdev, mode: "help" },
        recordedToolName: "write",
      },
      {
        name: "another server's result carrying receipt text",
        xdev: {
          ...recordedXdev,
          tool: "mcp__other_run",
          inner: { ...recordedXdev.inner, serverName: "other", mcpToolName: "run" },
        },
        recordedToolName: "write",
      },
    ])("reads nothing for $name", ({ xdev, recordedToolName }) => {
      const events = decodeAll(new OmpRecordDecoder(), "s-receipt-forged", [
        assistant("rec-device", { responseId: "msg_device", content: [deviceCall] }),
        deviceResult(xdev, recordedToolName),
      ]);
      const [result] = results(events);
      expect(result?.metadata).not.toHaveProperty("resinInvocationId");
      expect(result?.metadata).not.toHaveProperty("benchmarkId");
    });

    it("reads nothing when a direct tool's recorded name is not the resin server's", () => {
      const result = resultOf(
        new OmpRecordDecoder(),
        "s-receipt-direct-forged",
        toolCall("call_bash", "bash", { command: "echo" }),
        toolResult("call_bash", "bash", [text("ok"), recordedReceipt], {
          serverName: "resin",
          mcpToolName: "invoke_tool",
          rawContent: [text("ok"), recordedReceipt],
          mcpMeta: recordedMeta,
        }),
      );
      expect(result?.metadata).not.toHaveProperty("resinInvocationId");
    });
  });
});
