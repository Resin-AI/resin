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
  requestId: "msg_01Hq7ZtR2vKx9LmPw4NcYs8D",
  inputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteTokens: 2_000,
  outputTokens: 100,
  totalTokens: 2_110,
  costMicroUsd: 50_000,
  costProvenance: "harness_estimate",
};

describe("request-scoped provider usage", () => {
  it("accepts a complete request whose total is the four disjoint categories", () => {
    expect(ProviderReportedUsageSchema.parse(completeRequest)).toEqual(completeRequest);
    expect(providerUsageNormalizedTotal(completeRequest)).toBe(2_110);
  });

  it("keeps reasoning inside output: it is never added to the total", () => {
    const usage = {
      ...completeRequest,
      requestId: "resp_0a1b2c3d4e5f60718293a4b5",
      inputTokens: 3_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 150,
      totalTokens: 3_200,
    };
    expect(ProviderReportedUsageSchema.safeParse(usage).success).toBe(true);
    expect(providerUsageNormalizedTotal(usage)).toBe(3_200);
    expect(
      ProviderReportedUsageSchema.safeParse({ ...usage, totalTokens: 3_200 + 150 }).success,
    ).toBe(false);
  });

  it("rejects complete request usage that lacks a category or overstates reasoning", () => {
    const { cacheWriteTokens: _omitted, ...withoutCacheWrites } = completeRequest;
    expect(ProviderReportedUsageSchema.safeParse(withoutCacheWrites).success).toBe(false);
    expect(
      ProviderReportedUsageSchema.safeParse({ ...completeRequest, reasoningTokens: 101 }).success,
    ).toBe(false);
  });

  it("keeps inconsistent counts as partial evidence instead of clamping them", () => {
    const orchestrated = {
      ...completeRequest,
      availability: "partial" as const,
      totalTokens: 2_200,
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
