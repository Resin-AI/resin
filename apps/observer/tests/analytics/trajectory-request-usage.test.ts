import type {
  NormalizedSessionEvent,
  NormalizedToolCallEvent,
  ProviderReportedUsage,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  MixedTrajectoryIdentityError,
  type TrajectoryAttributionContextInput,
  TrajectoryObservationSchema,
  TrajectoryUsageSchema,
  createTrajectoryEmitter,
} from "../../src/index.js";

const SESSION_ID = "01J5REQUESTUSAGESESSION0001";
let sequence = 0;

function context(): TrajectoryAttributionContextInput {
  return {
    accountId: "acc_request_usage",
    workspaceId: "ws_request_usage",
    ownerUserId: "usr_request_usage",
    projectId: "prj_request_usage",
    candidateId: "cand_request_usage",
    toolId: "00000000-0000-0000-0000-000000000002",
    toolVersion: "1.0.0",
    workloadId: "wl_request_usage",
    trajectoryId: `traj_request_usage_${++sequence}`,
    runtimeVersion: "1.0.0",
    role: "candidate",
    provider: "anthropic",
    model: "claude-opus-5-5",
  };
}

/** A complete Anthropic-style request: input excludes cache reads and writes. */
function request(
  requestId: string,
  counts: { input: number; cacheRead: number; cacheWrite: number; output: number },
  overrides: Partial<ProviderReportedUsage> = {},
): ProviderReportedUsage {
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    accountingVersion: "omp-v1",
    availability: "complete",
    usageScope: "request",
    requestId,
    inputTokens: counts.input,
    cachedInputTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
    outputTokens: counts.output,
    totalTokens: counts.input + counts.cacheRead + counts.cacheWrite + counts.output,
    ...overrides,
  };
}

function assistantEvent(
  eventId: string,
  usage: ProviderReportedUsage | undefined,
  modelRequestId?: string,
): NormalizedSessionEvent {
  const event: Extract<NormalizedSessionEvent, { type: "message" }> = {
    eventId,
    sessionId: SESSION_ID,
    timestamp: "2026-10-08T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "assistant" }],
  };
  if (modelRequestId !== undefined) event.metadata = { modelRequestId };
  if (usage !== undefined) event.providerUsage = usage;
  return event;
}

function toolCallEvent(
  eventId: string,
  callId: string,
  modelRequestId: string,
): NormalizedSessionEvent {
  const event: NormalizedToolCallEvent = {
    eventId,
    sessionId: SESSION_ID,
    timestamp: "2026-10-08T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "tool_call",
    callId,
    toolName: "read",
    parameters: {},
    isShadow: false,
    metadata: { modelRequestId },
  };
  return event;
}

/** An auxiliary request recorded outside the conversation, as OMP's `model_usage` decodes. */
function auxiliaryEvent(
  eventId: string,
  usage: ProviderReportedUsage,
  purpose: string,
): NormalizedSessionEvent {
  return {
    eventId,
    sessionId: SESSION_ID,
    timestamp: "2026-10-08T12:00:00.000Z",
    schemaVersion: "1.0.0",
    type: "unknown_passthrough",
    rawEventType: "model_usage",
    rawPayload: {},
    metadata: { modelRequestId: usage.requestId, modelRequestPurpose: purpose },
    providerUsage: usage,
  };
}

describe("TrajectoryEmitter request-scoped usage", () => {
  it("sums disjoint categories including cache writes once per request", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_req_a",
        request("msg_a", { input: 10, cacheRead: 0, cacheWrite: 1_000, output: 100 }),
      ),
    );
    emitter.ingest(
      assistantEvent(
        "evt_req_b",
        request("msg_b", { input: 20, cacheRead: 1_000, cacheWrite: 200, output: 50 }),
      ),
    );

    const usage = emitter.computeUsage();
    expect(usage).toEqual({
      availability: "complete",
      usageSemantics: "request",
      requestCount: 2,
      inputTokens: 30,
      outputTokens: 150,
      reasoningTokens: null,
      cachedInputTokens: 1_000,
      cacheWriteTokens: 1_200,
      totalTokens: 30 + 1_000 + 1_200 + 150,
      costMicroUsd: null,
      durationMs: null,
      costProvenances: [],
      models: [
        {
          provider: "anthropic",
          model: "claude-opus-5-5",
          requestCount: 2,
          availability: "complete",
          inputTokens: 30,
          cachedInputTokens: 1_000,
          cacheWriteTokens: 1_200,
          outputTokens: 150,
          reasoningTokens: null,
          totalTokens: 30 + 1_000 + 1_200 + 150,
          costMicroUsd: null,
          durationMs: null,
          costProvenances: [],
          purposes: [],
        },
      ],
    });
  });

  it("keeps reasoning inside output instead of adding it to the total", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_reasoning",
        request(
          "resp_reasoning",
          { input: 3_000, cacheRead: 100, cacheWrite: 0, output: 200 },
          { reasoningTokens: 150 },
        ),
      ),
    );

    const usage = emitter.computeUsage();
    expect(usage.reasoningTokens).toBe(150);
    expect(usage.outputTokens).toBe(200);
    expect(usage.totalTokens).toBe(3_000 + 100 + 200);
  });

  it("counts a repeated event once but repeated equal requests separately", () => {
    const counts = { input: 2, cacheRead: 5_000, cacheWrite: 0, output: 200 };
    const repeatedEvent = createTrajectoryEmitter(context());
    const event = assistantEvent("evt_same", request("msg_same", counts));
    repeatedEvent.ingest(event);
    repeatedEvent.ingest(event);
    // The same request reported again under a new event (one message split across lines).
    repeatedEvent.ingest(assistantEvent("evt_same_line_2", request("msg_same", counts)));
    expect(repeatedEvent.computeUsage()).toMatchObject({
      requestCount: 1,
      cachedInputTokens: 5_000,
      outputTokens: 200,
    });

    const repeatedRequests = createTrajectoryEmitter(context());
    repeatedRequests.ingest(assistantEvent("evt_first", request("msg_first", counts)));
    repeatedRequests.ingest(assistantEvent("evt_second", request("msg_second", counts)));
    expect(repeatedRequests.computeUsage()).toMatchObject({
      requestCount: 2,
      cachedInputTokens: 10_000,
      outputTokens: 400,
    });
  });

  it("replaces an earlier partial snapshot with a later complete one and never sums them", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent("evt_stream_1", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        accountingVersion: "omp-v1",
        availability: "partial",
        usageScope: "request",
        requestId: "msg_stream",
        inputTokens: 2,
        cachedInputTokens: 5_000,
        outputTokens: 1,
      }),
    );
    emitter.ingest(
      assistantEvent(
        "evt_stream_2",
        request("msg_stream", { input: 2, cacheRead: 5_000, cacheWrite: 40, output: 200 }),
      ),
    );
    // A stale, less complete snapshot arriving later does not displace the complete one.
    emitter.ingest(
      assistantEvent("evt_stream_3", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        accountingVersion: "omp-v1",
        availability: "partial",
        usageScope: "request",
        requestId: "msg_stream",
        outputTokens: 8,
      }),
    );

    expect(emitter.computeUsage()).toMatchObject({
      availability: "complete",
      requestCount: 1,
      outputTokens: 200,
      cacheWriteTokens: 40,
      totalTokens: 2 + 5_000 + 40 + 200,
    });
  });

  it("keeps a trajectory incomplete when a linked request never reports usage", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_with_usage",
        request("msg_known", { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }),
      ),
    );
    emitter.ingest(assistantEvent("evt_without_usage", undefined, "msg_missing"));

    const usage = emitter.computeUsage();
    expect(usage.availability).toBe("partial");
    expect(usage.requestCount).toBe(2);
    // The missing request may hold any amount, so no category or total is claimed; the known
    // request's usage stays visible in its model entry.
    expect(usage.totalTokens).toBeNull();
    expect(usage.inputTokens).toBeNull();
    expect(usage.models).toMatchObject([{ requestCount: 1, totalTokens: 10 }]);
  });

  it("does not multiply usage across parallel tool calls issued by one request", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_parallel_usage",
        request("msg_parallel", { input: 5, cacheRead: 100, cacheWrite: 0, output: 30 }),
        "msg_parallel",
      ),
    );
    emitter.ingest(toolCallEvent("evt_parallel_call_1", "call_1", "msg_parallel"));
    emitter.ingest(toolCallEvent("evt_parallel_call_2", "call_2", "msg_parallel"));
    emitter.ingest(toolCallEvent("evt_parallel_call_3", "call_3", "msg_parallel"));

    expect(emitter.computeUsage()).toMatchObject({
      availability: "complete",
      requestCount: 1,
      cachedInputTokens: 100,
      totalTokens: 135,
    });
  });

  it("keeps an inconsistent request partial with its reported counts", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent("evt_orchestration", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        accountingVersion: "omp-v1",
        availability: "partial",
        usageScope: "request",
        requestId: "resp_orchestration",
        inputTokens: 10,
        cachedInputTokens: 20,
        cacheWriteTokens: 0,
        outputTokens: 5,
        totalTokens: 50,
        costMicroUsd: 900,
        costProvenance: "harness_estimate",
      }),
    );

    expect(emitter.computeUsage()).toMatchObject({
      availability: "partial",
      usageSemantics: "request",
      inputTokens: 10,
      totalTokens: null,
      costMicroUsd: 900,
      costProvenances: ["harness_estimate"],
    });
  });

  it("leaves legacy trajectories on the legacy shape without inventing request categories", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent("evt_legacy", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        accountingVersion: "omp-v1",
        availability: "complete",
        inputTokens: 100,
        cachedInputTokens: 60,
        outputTokens: 10,
        totalTokens: 110,
      }),
    );
    emitter.ingest(
      assistantEvent(
        "evt_mixed_request",
        request("msg_mixed", { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 }),
      ),
    );

    const usage = emitter.computeUsage();
    expect(usage).not.toHaveProperty("usageSemantics");
    expect(usage).not.toHaveProperty("requestCount");
    expect(usage.totalTokens).toBe(114);
    expect(usage.cacheWriteTokens).toBe(1);

    const legacyOnly = createTrajectoryEmitter(context());
    legacyOnly.ingest(
      assistantEvent("evt_legacy_only", {
        provider: "anthropic",
        model: "claude-opus-5-5",
        accountingVersion: "omp-v1",
        availability: "complete",
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      }),
    );
    expect(Object.keys(legacyOnly.computeUsage()).sort()).toEqual([
      "availability",
      "cachedInputTokens",
      "costMicroUsd",
      "durationMs",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
    ]);
  });

  it("finalizes request-semantics observations that the wire schema accepts", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_final",
        request("msg_final", { input: 7, cacheRead: 8, cacheWrite: 9, output: 10 }),
      ),
    );
    const observation = emitter.finalize();
    expect(() => TrajectoryObservationSchema.parse(observation)).not.toThrow();
    expect(observation.usage.usageSemantics).toBe("request");
  });

  it("rejects complete request-semantics usage whose total is not the category sum", () => {
    expect(
      TrajectoryUsageSchema.safeParse({
        availability: "complete",
        usageSemantics: "request",
        inputTokens: 1,
        cachedInputTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 1,
        reasoningTokens: 1,
        totalTokens: 5,
      }).success,
    ).toBe(false);
  });

  it("counts auxiliary and fallback requests of other models without letting them name the session", () => {
    const emitter = createTrajectoryEmitter({
      ...context(),
      provider: undefined,
      model: undefined,
    });
    // OMP's auto-thinking judge runs before the conversation's first response.
    emitter.ingest(
      auxiliaryEvent(
        "evt_judge",
        request(
          "aux0001a",
          { input: 200, cacheRead: 0, cacheWrite: 0, output: 50 },
          {
            provider: "example-judge",
            model: "judge-mini",
            reasoningTokens: 40,
            costMicroUsd: 400,
            costProvenance: "harness_estimate",
          },
        ),
        "auto-thinking",
      ),
    );
    emitter.ingest(
      assistantEvent(
        "evt_primary",
        request(
          "msg_primary",
          { input: 10, cacheRead: 5_000, cacheWrite: 100, output: 90 },
          { costMicroUsd: 20_000, costProvenance: "harness_estimate" },
        ),
      ),
    );
    // A fallback response on another model and accounting version is still this session's request.
    emitter.ingest(
      assistantEvent(
        "evt_fallback",
        request(
          "resp_fallback",
          { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
          {
            provider: "openai",
            model: "gpt-5.6",
            accountingVersion: "omp-v2",
            costMicroUsd: 20,
            costProvenance: "harness_estimate",
          },
        ),
      ),
    );

    const observation = emitter.finalize();
    expect(() => TrajectoryObservationSchema.parse(observation)).not.toThrow();
    expect(observation.provider).toBe("anthropic");
    expect(observation.model).toBe("claude-opus-5-5");
    expect(observation.usage).toMatchObject({
      availability: "complete",
      requestCount: 3,
      totalTokens: 250 + 5_200 + 15,
      costMicroUsd: 400 + 20_000 + 20,
      costProvenances: ["harness_estimate"],
      reasoningTokens: null,
    });
    expect(
      observation.usage.models?.map((model) => [model.provider, model.model, model.purposes]),
    ).toEqual([
      ["anthropic", "claude-opus-5-5", []],
      ["example-judge", "judge-mini", ["auto-thinking"]],
      ["openai", "gpt-5.6", []],
    ]);
    expect(observation.usage.models?.[1]).toMatchObject({
      requestCount: 1,
      totalTokens: 250,
      reasoningTokens: 40,
      costMicroUsd: 400,
    });
  });

  it("never adds source-reported and harness-estimated cost together", () => {
    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_billed",
        request(
          "msg_billed",
          { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          { costMicroUsd: 100, costProvenance: "source_reported" },
        ),
      ),
    );
    emitter.ingest(
      auxiliaryEvent(
        "evt_estimated",
        request(
          "aux_estimated",
          { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          { model: "claude-haiku", costMicroUsd: 7, costProvenance: "harness_estimate" },
        ),
        "title",
      ),
    );

    const usage = emitter.computeUsage();
    expect(usage.totalTokens).toBe(4);
    expect(usage.costMicroUsd).toBeNull();
    expect(usage.costProvenances).toEqual(["harness_estimate", "source_reported"]);
    expect(usage.models?.map((model) => [model.costMicroUsd, model.costProvenances])).toEqual([
      [7, ["harness_estimate"]],
      [100, ["source_reported"]],
    ]);
  });

  it("names a session that made only auxiliary requests after its first one", () => {
    const emitter = createTrajectoryEmitter({
      ...context(),
      provider: undefined,
      model: undefined,
    });
    emitter.ingest(
      auxiliaryEvent(
        "evt_only_aux",
        request(
          "aux_only",
          { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          {
            provider: "example-judge",
            model: "judge-mini",
          },
        ),
        "auto-thinking",
      ),
    );
    const observation = emitter.finalize();
    expect([observation.provider, observation.model]).toEqual(["example-judge", "judge-mini"]);
  });

  it("keeps legacy records strict and rejects events from another session", () => {
    const legacy = createTrajectoryEmitter(context());
    legacy.ingest(
      assistantEvent(
        "evt_primary_req",
        request("msg_req", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }),
      ),
    );
    expect(() =>
      legacy.ingest(
        assistantEvent("evt_legacy_other_model", {
          provider: "anthropic",
          model: "claude-haiku",
          accountingVersion: "omp-v1",
          availability: "complete",
          totalTokens: 5,
        }),
      ),
    ).toThrow(MixedTrajectoryIdentityError);

    const emitter = createTrajectoryEmitter(context());
    emitter.ingest(
      assistantEvent(
        "evt_this_session",
        request("msg_this", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }),
      ),
    );
    const foreign = assistantEvent(
      "evt_other_session",
      request("msg_other", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }),
    );
    expect(() => emitter.ingest({ ...foreign, sessionId: "01J5ANOTHERSESSION000000001" })).toThrow(
      MixedTrajectoryIdentityError,
    );
  });

  it("rejects a per-model breakdown that disagrees with the totals", () => {
    const model = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      requestCount: 1,
      availability: "complete",
      inputTokens: 1,
      cachedInputTokens: 1,
      cacheWriteTokens: 1,
      outputTokens: 1,
      reasoningTokens: null,
      totalTokens: 4,
      costMicroUsd: 10,
      durationMs: null,
      costProvenances: ["harness_estimate"],
      purposes: [],
    };
    const usage = {
      availability: "complete",
      usageSemantics: "request",
      requestCount: 1,
      inputTokens: 1,
      cachedInputTokens: 1,
      cacheWriteTokens: 1,
      outputTokens: 1,
      reasoningTokens: null,
      totalTokens: 4,
      costMicroUsd: 10,
      durationMs: null,
      costProvenances: ["harness_estimate"],
      models: [model],
    };
    expect(TrajectoryUsageSchema.safeParse(usage).success).toBe(true);
    expect(TrajectoryUsageSchema.safeParse({ ...usage, requestCount: 0 }).success).toBe(false);
    expect(
      TrajectoryUsageSchema.safeParse({ ...usage, models: [{ ...model, inputTokens: 2 }] }).success,
    ).toBe(false);
    expect(
      TrajectoryUsageSchema.safeParse({
        ...usage,
        costProvenances: ["harness_estimate", "source_reported"],
      }).success,
    ).toBe(false);
    expect(TrajectoryUsageSchema.safeParse({ ...usage, usageSemantics: undefined }).success).toBe(
      false,
    );
  });
});
