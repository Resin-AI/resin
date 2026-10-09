import { NormalizedSessionEventSchema } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { NormalizationPipeline } from "../../src/normalization/index.js";

const sessionId = "01J5REQUESTLINKCAPTURE00001";
const timestamp = "2026-10-08T12:00:00.000Z";
// A fictitious id with a real provider id's shape: random-looking enough for the entropy scanner.
const providerRequestId = "msg_01Hq7ZtR2vKx9LmPw4NcYs8D";
const invocationId = "inv_0123456789abcdef0123456789abcdef";

function record(rawPayload: RawHarnessRecord["rawPayload"], sequence: number): RawHarnessRecord {
  return {
    recordId: `rec_request_link_${sequence}`,
    sessionId,
    harnessId: "test_harness",
    sequenceNumber: sequence,
    timestamp,
    recordType: "custom",
    rawPayload,
    cursor: { offset: sequence, line: sequence, sequence, timestamp },
    metadata: {},
  };
}

describe("request link capture through normalization and upload projection", () => {
  it("keeps a high-entropy provider request id and the request links intact", async () => {
    const pipeline = new NormalizationPipeline();
    const results = await pipeline.processRecord(
      record(
        {
          type: "message",
          role: "assistant",
          content: "done",
          providerUsage: {
            provider: "anthropic",
            accountingVersion: "omp-v1",
            availability: "complete",
            usageScope: "request",
            requestId: providerRequestId,
            inputTokens: 2,
            cachedInputTokens: 5_000,
            cacheWriteTokens: 300,
            outputTokens: 100,
            totalTokens: 5_402,
          },
          metadata: { modelRequestId: providerRequestId, taskId: "rec0002b" },
        },
        1,
      ),
    );
    const result = results[0];
    expect(result?.status).toBe("success");
    if (result?.status !== "success") return;
    expect(result.event.providerUsage?.requestId).toBe(providerRequestId);
    expect(result.event.providerUsage?.cacheWriteTokens).toBe(300);

    const projected = projectEventToMetadataOnly(result.event, { validate: true });
    expect(NormalizedSessionEventSchema.safeParse(projected).success).toBe(true);
    expect(projected.providerUsage?.requestId).toBe(providerRequestId);
    expect(projected.providerUsage?.usageScope).toBe("request");
    expect(projected.metadata).toMatchObject({
      modelRequestId: providerRequestId,
      taskId: "rec0002b",
    });
  });

  it("uploads validated invocation receipts and drops malformed link metadata", async () => {
    const pipeline = new NormalizationPipeline();
    const results = await pipeline.processRecord(
      record(
        {
          type: "tool_result",
          callId: "call_resin_1",
          toolName: "mcp__resin__invoke_tool",
          result: "ok",
          isError: false,
          metadata: {
            modelRequestId: providerRequestId,
            taskId: "task 1 with spaces",
            resinInvocationId: invocationId,
            benchmarkId: "bench-1",
          },
        },
        2,
      ),
    );
    const result = results[0];
    expect(result?.status).toBe("success");
    if (result?.status !== "success") return;

    const projected = projectEventToMetadataOnly(result.event);
    expect(projected.metadata).toMatchObject({
      modelRequestId: providerRequestId,
      resinInvocationId: invocationId,
      benchmarkId: "bench-1",
    });
    expect(projected.metadata).not.toHaveProperty("taskId");
  });

  it("still scrubs explicit credentials smuggled into request ids and link metadata", async () => {
    const anthropicKey = `sk-ant-${"a1B2c3D4e5".repeat(3)}`;
    const githubToken = `ghp_${"A1b2C3d4E5f6".repeat(3)}`;
    const pipeline = new NormalizationPipeline();
    const results = await pipeline.processRecord(
      record(
        {
          type: "message",
          role: "assistant",
          content: "done",
          providerUsage: {
            provider: "anthropic",
            accountingVersion: "omp-v1",
            availability: "partial",
            usageScope: "request",
            requestId: anthropicKey,
            outputTokens: 1,
          },
          metadata: { modelRequestId: githubToken, taskId: anthropicKey },
        },
        3,
      ),
    );
    const result = results[0];
    expect(result?.status).toBe("success");
    if (result?.status !== "success") return;
    const serialized = JSON.stringify(result.event);
    expect(serialized).not.toContain(anthropicKey);
    expect(serialized).not.toContain(githubToken);
    expect(result.event.providerUsage?.requestId).toMatch(/^\[REDACTED_/);
    expect(result.event.redaction?.redactedFields).toEqual(
      expect.arrayContaining([
        "providerUsage.requestId",
        "metadata.modelRequestId",
        "metadata.taskId",
      ]),
    );

    const projected = projectEventToMetadataOnly(result.event);
    expect(JSON.stringify(projected)).not.toContain(anthropicKey);
    expect(JSON.stringify(projected)).not.toContain(githubToken);
  });
});
