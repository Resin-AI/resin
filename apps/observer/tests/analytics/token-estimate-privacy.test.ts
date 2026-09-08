import {
  type NormalizedSessionEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolResultEvent,
  TOOL_IO_UTF8_METHOD,
  annotateEventWithTokenEstimate,
  createEventTokenEstimate,
} from "@resin/contracts";
import type { AuditRepository } from "@resin/db";
import { describe, expect, it, vi } from "vitest";
import { InvocationTelemetryUploader } from "../../src/analytics/invocation-telemetry-uploader.js";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import type { CloudObservationClient, SendTelemetryBatchInput } from "../../src/cloud-runtime.js";

function makeBaseHeaders(causalSequence = 1) {
  return {
    eventId: `evt_01j7db4n00000000000000000${causalSequence}`,
    schemaVersion: "1.0.0",
    sessionId: "ses_privacy_001",
    timestamp: "2026-08-17T14:00:00.000Z",
    causalRef: {
      causalSequence,
    },
    redaction: {
      isRedacted: false,
      redactedFields: [],
      scrubbedPatterns: [],
      redactionStrategy: "none" as const,
    },
    metadata: {
      scenarioId: "scenario_privacy_1",
      sessionKind: "agent" as const,
    },
  };
}

describe("Event Token Estimation and Privacy Projection", () => {
  describe("createEventTokenEstimate & annotateEventWithTokenEstimate", () => {
    it("estimates inputTokens for tool_call with other components zero", () => {
      const estimate = createEventTokenEstimate("tool_call", { query: "search database" });
      expect(estimate).toBeDefined();
      expect(estimate?.method).toBe(TOOL_IO_UTF8_METHOD);
      expect(estimate?.inputTokens).toBeGreaterThan(0);
      expect(estimate?.outputTokens).toBe(0);
      expect(estimate?.discoveryTokens).toBe(0);
      expect(estimate?.totalTokens).toBe(estimate?.inputTokens);
    });

    it("estimates outputTokens for tool_result with other components zero", () => {
      const estimate = createEventTokenEstimate(
        "tool_result",
        "Found 42 matching records in table",
      );
      expect(estimate).toBeDefined();
      expect(estimate?.method).toBe(TOOL_IO_UTF8_METHOD);
      expect(estimate?.inputTokens).toBe(0);
      expect(estimate?.outputTokens).toBeGreaterThan(0);
      expect(estimate?.discoveryTokens).toBe(0);
      expect(estimate?.totalTokens).toBe(estimate?.outputTokens);
    });

    it("returns undefined when payload is missing (undefined), but estimates 1 token for JSON null", () => {
      expect(createEventTokenEstimate("tool_call", undefined)).toBeUndefined();
      expect(createEventTokenEstimate("tool_result", undefined)).toBeUndefined();

      // JSON null is valid serializable value (4 bytes => 1 token)
      const callNull = createEventTokenEstimate("tool_call", null);
      expect(callNull).toBeDefined();
      expect(callNull?.inputTokens).toBe(1);
      expect(callNull?.outputTokens).toBe(0);
      expect(callNull?.totalTokens).toBe(1);

      const resultNull = createEventTokenEstimate("tool_result", null);
      expect(resultNull).toBeDefined();
      expect(resultNull?.inputTokens).toBe(0);
      expect(resultNull?.outputTokens).toBe(1);
      expect(resultNull?.totalTokens).toBe(1);
    });
    it("counts complete empty input {} serialized bytes (2 bytes => 1 token), not missing", () => {
      const estimate = createEventTokenEstimate("tool_call", {});
      expect(estimate).toBeDefined();
      expect(estimate?.inputTokens).toBe(1);
      expect(estimate?.totalTokens).toBe(1);
    });

    it("annotates normalized tool_call event with metadata.resinTokenEstimateV1", () => {
      const event: NormalizedToolCallEvent = {
        ...makeBaseHeaders(1),
        type: "tool_call",
        callId: "call_001",
        toolName: "sql_runner",
        parameters: { query: "SELECT * FROM users;" },
        isShadow: false,
      };

      const annotated = annotateEventWithTokenEstimate(event);
      expect(annotated.metadata?.resinTokenEstimateV1).toBeDefined();
      expect(annotated.metadata?.resinTokenEstimateV1?.method).toBe(TOOL_IO_UTF8_METHOD);
      expect(annotated.metadata?.resinTokenEstimateV1?.inputTokens).toBeGreaterThan(0);
      expect(annotated.metadata?.resinTokenEstimateV1?.outputTokens).toBe(0);
    });
  });

  describe("projectEventToMetadataOnly privacy preservation", () => {
    it("captures original tool-call parameter size before masking and preserves numeric metadata", () => {
      const original: NormalizedToolCallEvent = {
        ...makeBaseHeaders(2),
        type: "tool_call",
        callId: "call_secret_1",
        toolName: "api_fetcher",
        parameters: {
          apiKey: "sk-secret-token-1234567890abcdef",
          endpoint: "/admin/sensitive",
        },
        isShadow: false,
      };

      const projected = projectEventToMetadataOnly(original);

      expect(projected.type).toBe("tool_call");
      expect(projected.metadata?.resinTokenEstimateV1).toBeDefined();
      expect(projected.metadata?.resinTokenEstimateV1?.method).toBe(TOOL_IO_UTF8_METHOD);
      expect(projected.metadata?.resinTokenEstimateV1?.inputTokens).toBeGreaterThan(0);
      expect(projected.metadata?.resinTokenEstimateV1?.outputTokens).toBe(0);
      expect(projected.metadata?.resinTokenEstimateV1?.discoveryTokens).toBe(0);

      // Verify no raw payload leaked into metadata or anywhere else
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain("sk-secret-token-1234567890abcdef");
      expect(serialized).not.toContain("/admin/sensitive");
    });

    it("captures original tool_result size before dropping result and preserves numeric metadata", () => {
      const original: NormalizedToolResultEvent = {
        ...makeBaseHeaders(3),
        type: "tool_result",
        callId: "call_secret_1",
        toolName: "api_fetcher",
        result: {
          secretUserRecord: "Alice Smith, SSN: 000-00-0000",
        },
        isError: false,
        executionDurationMs: 150,
        isShadow: false,
      };

      const projected = projectEventToMetadataOnly(original);

      expect(projected.type).toBe("tool_result");
      if (projected.type === "tool_result") {
        expect(projected.result).toBeUndefined(); // Dropped for privacy
      }
      expect(projected.metadata?.resinTokenEstimateV1).toBeDefined();
      expect(projected.metadata?.resinTokenEstimateV1?.method).toBe(TOOL_IO_UTF8_METHOD);
      expect(projected.metadata?.resinTokenEstimateV1?.outputTokens).toBeGreaterThan(0);
      expect(projected.metadata?.resinTokenEstimateV1?.inputTokens).toBe(0);

      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain("Alice Smith");
      expect(serialized).not.toContain("SSN");
    });

    it("is idempotent: re-projecting an already projected event preserves resinTokenEstimateV1 intact", () => {
      const original: NormalizedToolResultEvent = {
        ...makeBaseHeaders(4),
        type: "tool_result",
        callId: "call_reproject",
        toolName: "db_query",
        result: "Important non-empty payload result",
        isError: false,
        executionDurationMs: 40,
        isShadow: false,
      };

      const firstPass = projectEventToMetadataOnly(original);
      const estimatePass1 = firstPass.metadata?.resinTokenEstimateV1;
      expect(estimatePass1).toBeDefined();

      const secondPass = projectEventToMetadataOnly(firstPass);
      const estimatePass2 = secondPass.metadata?.resinTokenEstimateV1;

      expect(estimatePass2).toEqual(estimatePass1);
      expect(secondPass.metadata?.scenarioId).toBe("scenario_privacy_1");
    });
    it("leaves estimate absent when event has no payload (backward compatibility)", () => {
      const nonToolEvent = {
        ...makeBaseHeaders(5),
        type: "message" as const,
        role: "user" as const,
        content: "Hello",
      };

      const projected = projectEventToMetadataOnly(nonToolEvent);
      expect(projected.metadata?.resinTokenEstimateV1).toBeUndefined();
    });

    it("estimates 1 token for explicit null result and preserves explicit null without fallback", () => {
      const nullResultEvent: NormalizedToolResultEvent = {
        ...makeBaseHeaders(6),
        type: "tool_result",
        callId: "call_null_1",
        toolName: "void_command",
        result: null,
        isError: false,
        executionDurationMs: 50,
        isShadow: false,
      };

      const projected = projectEventToMetadataOnly(nullResultEvent);
      expect(projected.metadata?.resinTokenEstimateV1).toEqual({
        method: TOOL_IO_UTF8_METHOD,
        inputTokens: 0,
        outputTokens: 1,
        discoveryTokens: 0,
        totalTokens: 1,
      });
    });

    it("preserves pre-existing resinTokenEstimateV1 from raw-before-redaction pipeline", () => {
      const preEstimatedEvent: NormalizedToolResultEvent = {
        ...makeBaseHeaders(7),
        type: "tool_result",
        callId: "call_raw_1",
        toolName: "secret_tool",
        result: "[REDACTED]",
        isError: false,
        executionDurationMs: 120,
        isShadow: false,
        metadata: {
          scenarioId: "scenario_raw_1",
          resinTokenEstimateV1: {
            method: TOOL_IO_UTF8_METHOD,
            inputTokens: 0,
            outputTokens: 500, // Computed from raw 2000-byte unredacted secret
            discoveryTokens: 0,
            totalTokens: 500,
          },
        },
      };

      const projected = projectEventToMetadataOnly(preEstimatedEvent);
      expect(projected.metadata?.resinTokenEstimateV1).toEqual({
        method: TOOL_IO_UTF8_METHOD,
        inputTokens: 0,
        outputTokens: 500,
        discoveryTokens: 0,
        totalTokens: 500,
      });
    });
  });

  describe("InvocationTelemetryUploader carries usageEstimate unchanged", () => {
    it("dispatches invocations with usageEstimate to cloudClient.sendTelemetryBatch", async () => {
      const mockAuditRepo = {
        listPendingInvocationUploads: vi.fn().mockReturnValue([
          {
            invocationId: "inv_tele_001",
            sessionId: "ses_tele_001",
            workspaceId: "ws_tele_001",
            toolId: "tool_generated_1",
            toolVersion: "1.0.0",
            startedAt: "2026-08-17T14:00:00.000Z",
            completedAt: "2026-08-17T14:00:01.000Z",
            durationMs: 1000,
            status: "success",
            inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            outputDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            usageEstimate: {
              method: "tool_io_utf8_v1",
              inputTokens: 30,
              outputTokens: 70,
              discoveryTokens: 10,
              totalTokens: 110,
            },
          },
        ]),
        markInvocationsUploaded: vi.fn(),
      } as unknown as AuditRepository;

      let capturedPayload: SendTelemetryBatchInput | undefined;
      const mockCloudClient = {
        sendTelemetryBatch: vi.fn().mockImplementation(async (payload: SendTelemetryBatchInput) => {
          capturedPayload = payload;
          return { batchId: "tb_001", status: "accepted", processedCount: 1 };
        }),
      } as unknown as CloudObservationClient;

      const uploader = new InvocationTelemetryUploader({
        auditRepository: mockAuditRepo,
        cloudClient: mockCloudClient,
      });

      const result = await uploader.flushOnce();
      expect(result.uploaded).toBe(1);
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.invocations).toHaveLength(1);
      expect(capturedPayload.invocations[0].usageEstimate).toEqual({
        method: "tool_io_utf8_v1",
        inputTokens: 30,
        outputTokens: 70,
        discoveryTokens: 10,
        totalTokens: 110,
      });
    });
  });
});
