import type {
  NormalizedSessionEvent,
  NormalizedToolCallEvent,
  ProviderReportedUsage,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { summarizeEpisodeUsage } from "../../src/opportunity/episode.js";

const SESSION_ID = "episode-request-usage-session";

function request(
  requestId: string,
  counts: { input: number; cacheRead: number; cacheWrite: number; output: number },
  costMicroUsd?: number,
): ProviderReportedUsage {
  return {
    provider: "anthropic",
    accountingVersion: "omp-v1",
    availability: "complete",
    usageScope: "request",
    requestId,
    inputTokens: counts.input,
    cachedInputTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
    outputTokens: counts.output,
    totalTokens: counts.input + counts.cacheRead + counts.cacheWrite + counts.output,
    ...(costMicroUsd === undefined
      ? {}
      : { costMicroUsd, costProvenance: "harness_estimate" as const }),
  };
}

function assistant(
  eventId: string,
  usage?: ProviderReportedUsage,
  modelRequestId?: string,
): NormalizedSessionEvent {
  const event: Extract<NormalizedSessionEvent, { type: "message" }> = {
    eventId,
    sessionId: SESSION_ID,
    timestamp: "2026-10-08T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "message",
    role: "assistant",
    content: "assistant",
  };
  if (modelRequestId !== undefined) event.metadata = { modelRequestId };
  if (usage !== undefined) event.providerUsage = usage;
  return event;
}

function toolCall(eventId: string, modelRequestId: string): NormalizedSessionEvent {
  const event: NormalizedToolCallEvent = {
    eventId,
    sessionId: SESSION_ID,
    timestamp: "2026-10-08T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "tool_call",
    callId: eventId,
    toolName: "read",
    parameters: {},
    isShadow: false,
    metadata: { modelRequestId },
  };
  return event;
}

describe("summarizeEpisodeUsage request identity", () => {
  it("counts cache writes and each distinct request once, even with equal counts", () => {
    const counts = { input: 2, cacheRead: 5_000, cacheWrite: 300, output: 200 };
    const summary = summarizeEpisodeUsage([
      assistant("evt_a", request("msg_a", counts, 1_000), "msg_a"),
      // The same request restated on a later transcript line.
      assistant("evt_a_line_2", request("msg_a", counts, 1_000), "msg_a"),
      assistant("evt_b", request("msg_b", counts, 1_000), "msg_b"),
    ]);
    expect(summary).toEqual({
      totalTokens: 2 * 5_502,
      cachedInputTokens: 10_000,
      cacheWriteTokens: 600,
      requestCount: 2,
      tokensComplete: true,
      costUsd: 0.002,
      costSource: "estimated",
    });
  });

  it("does not multiply a request across the parallel tool calls it issued", () => {
    const summary = summarizeEpisodeUsage([
      assistant(
        "evt_issuer",
        request("msg_parallel", { input: 5, cacheRead: 100, cacheWrite: 0, output: 30 }, 50),
        "msg_parallel",
      ),
      toolCall("call_1", "msg_parallel"),
      toolCall("call_2", "msg_parallel"),
    ]);
    expect(summary).toMatchObject({
      totalTokens: 135,
      requestCount: 1,
      tokensComplete: true,
      costSource: "estimated",
    });
  });

  it("counts every model's requests but never adds reported and estimated cost", () => {
    const billed: ProviderReportedUsage = {
      ...request("msg_billed", { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }),
      costMicroUsd: 100,
      costProvenance: "source_reported",
    };
    const judge: ProviderReportedUsage = {
      ...request("judge_1", { input: 5, cacheRead: 0, cacheWrite: 0, output: 5 }, 20),
      provider: "example-judge",
      model: "judge-mini",
    };
    const summary = summarizeEpisodeUsage([
      assistant("evt_billed", billed, "msg_billed"),
      assistant("evt_judge", judge, "judge_1"),
    ]);
    expect(summary).toMatchObject({
      totalTokens: 20,
      requestCount: 2,
      tokensComplete: true,
      costUsd: null,
      costSource: "unknown",
    });
  });

  it("uses the later, more complete snapshot of one request", () => {
    const partial: ProviderReportedUsage = {
      provider: "anthropic",
      accountingVersion: "omp-v1",
      availability: "partial",
      usageScope: "request",
      requestId: "msg_stream",
      inputTokens: 2,
      outputTokens: 1,
    };
    const summary = summarizeEpisodeUsage([
      assistant("evt_stream_1", partial, "msg_stream"),
      assistant(
        "evt_stream_2",
        request("msg_stream", { input: 2, cacheRead: 50, cacheWrite: 10, output: 200 }),
        "msg_stream",
      ),
    ]);
    expect(summary).toMatchObject({ totalTokens: 262, requestCount: 1, tokensComplete: true });
  });

  it("keeps missing usage unknown instead of zero", () => {
    const linkedWithoutUsage = summarizeEpisodeUsage([
      assistant(
        "evt_known",
        request("msg_known", { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, 10),
        "msg_known",
      ),
      toolCall("call_missing", "msg_missing"),
    ]);
    expect(linkedWithoutUsage).toMatchObject({
      totalTokens: 10,
      requestCount: 2,
      tokensComplete: false,
      costUsd: null,
      costSource: "unknown",
    });

    const unlinkedAssistant = summarizeEpisodeUsage([assistant("evt_no_usage")]);
    expect(unlinkedAssistant).toMatchObject({
      totalTokens: 0,
      tokensComplete: false,
      costUsd: null,
    });

    const partialWithoutTotal = summarizeEpisodeUsage([
      assistant("evt_partial", {
        provider: "anthropic",
        accountingVersion: "omp-v1",
        availability: "partial",
        usageScope: "request",
        requestId: "msg_partial",
        inputTokens: 7,
        outputTokens: 3,
      }),
    ]);
    expect(partialWithoutTotal).toMatchObject({ totalTokens: 0, tokensComplete: false });
  });
});
