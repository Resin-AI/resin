import { describe, expect, it } from "vitest";
import {
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
  providerUsageNormalizedTotal,
  providerUsageRequestKey,
  selectProviderUsageSnapshot,
} from "../src/events.js";

const completeRequest: ProviderReportedUsage = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  accountingVersion: "omp-v1",
  availability: "complete",
  usageScope: "request",
  requestId: "msg_011CfprvQwejVWuABwxsQfun",
  inputTokens: 4,
  cachedInputTokens: 0,
  cacheWriteTokens: 26_788,
  outputTokens: 181,
  totalTokens: 26_973,
  costMicroUsd: 217_940,
  costProvenance: "harness_estimate",
};

describe("request-scoped provider usage", () => {
  it("accepts a complete request whose total is the four disjoint categories", () => {
    expect(ProviderReportedUsageSchema.parse(completeRequest)).toEqual(completeRequest);
    expect(providerUsageNormalizedTotal(completeRequest)).toBe(26_973);
  });

  it("keeps reasoning inside output: it is never added to the total", () => {
    const usage = {
      ...completeRequest,
      requestId: "resp_6a9b290fe8e192ab75734005",
      inputTokens: 3_956,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 205,
      reasoningTokens: 141,
      totalTokens: 4_161,
    };
    expect(ProviderReportedUsageSchema.safeParse(usage).success).toBe(true);
    expect(providerUsageNormalizedTotal(usage)).toBe(4_161);
    expect(
      ProviderReportedUsageSchema.safeParse({ ...usage, totalTokens: 4_161 + 141 }).success,
    ).toBe(false);
  });

  it("rejects complete request usage that lacks a category or overstates reasoning", () => {
    const { cacheWriteTokens: _omitted, ...withoutCacheWrites } = completeRequest;
    expect(ProviderReportedUsageSchema.safeParse(withoutCacheWrites).success).toBe(false);
    expect(
      ProviderReportedUsageSchema.safeParse({ ...completeRequest, reasoningTokens: 182 }).success,
    ).toBe(false);
  });

  it("keeps inconsistent counts as partial evidence instead of clamping them", () => {
    const orchestrated = {
      ...completeRequest,
      availability: "partial" as const,
      totalTokens: 27_100,
    };
    expect(ProviderReportedUsageSchema.parse(orchestrated)).toEqual(orchestrated);
    expect(providerUsageNormalizedTotal(orchestrated)).toBeUndefined();
  });

  it("requires request identity exactly on request-scoped records", () => {
    const { requestId: _omitted, ...withoutId } = completeRequest;
    expect(ProviderReportedUsageSchema.safeParse(withoutId).success).toBe(false);
    expect(
      ProviderReportedUsageSchema.safeParse({
        ...completeRequest,
        usageScope: "cumulative",
        availability: "partial",
      }).success,
    ).toBe(false);
    expect(
      ProviderReportedUsageSchema.safeParse({ ...completeRequest, requestId: "has space" }).success,
    ).toBe(false);
  });

  it("forbids cache writes on unavailable usage", () => {
    expect(
      ProviderReportedUsageSchema.safeParse({
        provider: "anthropic",
        accountingVersion: "omp-v1",
        availability: "unavailable",
        cacheWriteTokens: 1,
      }).success,
    ).toBe(false);
  });

  it("leaves legacy records valid and without a normalized total", () => {
    const legacy = {
      provider: "openai",
      accountingVersion: "codex-cli-transcript-v1",
      availability: "complete" as const,
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 50,
      totalTokens: 1_050,
    };
    expect(ProviderReportedUsageSchema.parse(legacy)).toEqual(legacy);
    expect(providerUsageNormalizedTotal(legacy)).toBeUndefined();
    expect(providerUsageRequestKey("session-1", legacy)).toBeUndefined();
  });

  it("keys identity by provider, session and request id, never by counts", () => {
    const key = providerUsageRequestKey("session-1", completeRequest);
    expect(key).toBe(JSON.stringify(["anthropic", "session-1", completeRequest.requestId]));
    expect(providerUsageRequestKey("session-2", completeRequest)).not.toBe(key);
    expect(
      providerUsageRequestKey("session-1", { ...completeRequest, requestId: "msg_other" }),
    ).not.toBe(key);
    expect(
      providerUsageRequestKey("session-1", { ...completeRequest, provider: "other" }),
    ).not.toBe(key);
  });

  it("lets a later snapshot replace an earlier one unless it is strictly less complete", () => {
    const streaming: ProviderReportedUsage = {
      ...completeRequest,
      availability: "partial",
      outputTokens: 1,
      totalTokens: undefined,
    };
    expect(selectProviderUsageSnapshot(streaming, completeRequest)).toBe(completeRequest);
    expect(selectProviderUsageSnapshot(completeRequest, streaming)).toBe(completeRequest);
    const restated = { ...completeRequest };
    expect(selectProviderUsageSnapshot(completeRequest, restated)).toBe(restated);
    const sparse: ProviderReportedUsage = {
      provider: "anthropic",
      accountingVersion: "omp-v1",
      availability: "partial",
      usageScope: "request",
      requestId: completeRequest.requestId,
      outputTokens: 2,
    };
    expect(selectProviderUsageSnapshot(streaming, sparse)).toBe(streaming);
  });
});
