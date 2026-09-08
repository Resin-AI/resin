import { NormalizedSessionEventSchema, TOOL_IO_UTF8_METHOD } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { NormalizationPipeline } from "../../src/normalization/index.js";

describe("NormalizationPipeline Scenario ID & Metadata", () => {
  const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
  const timestamp = "2026-08-17T12:00:00.000Z";

  it("assigns metadata.scenarioId equal to sessionId when normalized event has no incoming metadata", async () => {
    const pipeline = new NormalizationPipeline();
    const rawRecord: RawHarnessRecord = {
      recordId: "rec_no_meta_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "custom",
      rawPayload: {
        type: "message",
        role: "user",
        content: "Hello world",
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const results = await pipeline.processRecord(rawRecord);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("success");
    if (results[0].status === "success") {
      expect(results[0].event.metadata?.scenarioId).toBe(sessionId);
      expect(NormalizedSessionEventSchema.safeParse(results[0].event).success).toBe(true);
    }
  });

  it("preserves incoming non-empty string metadata.scenarioId unchanged", async () => {
    const pipeline = new NormalizationPipeline();
    const rawRecord: RawHarnessRecord = {
      recordId: "rec_with_scn_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "custom",
      rawPayload: {
        type: "message",
        role: "user",
        content: "Hello world with custom scenario",
        metadata: {
          scenarioId: "scn-custom-scenario-42",
          extraField: "value123",
        },
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const results = await pipeline.processRecord(rawRecord);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("success");
    if (results[0].status === "success") {
      expect(results[0].event.metadata?.scenarioId).toBe("scn-custom-scenario-42");
      expect(results[0].event.metadata?.extraField).toBe("value123");
      expect(NormalizedSessionEventSchema.safeParse(results[0].event).success).toBe(true);
    }
  });

  it("merges context.customMetadata keys into event metadata", async () => {
    const pipeline = new NormalizationPipeline();
    const rawRecord: RawHarnessRecord = {
      recordId: "rec_context_meta_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "custom",
      rawPayload: {
        type: "message",
        role: "user",
        content: "Hello world with context metadata",
        metadata: {
          originalTag: "initial",
        },
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const results = await pipeline.processRecord(rawRecord, {
      customMetadata: {
        customKey1: "customValue1",
        customKey2: 999,
      },
    });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("success");
    if (results[0].status === "success") {
      expect(results[0].event.metadata?.scenarioId).toBe(sessionId);
      expect(results[0].event.metadata?.originalTag).toBe("initial");
      expect(results[0].event.metadata?.customKey1).toBe("customValue1");
      expect(results[0].event.metadata?.customKey2).toBe(999);
      expect(NormalizedSessionEventSchema.safeParse(results[0].event).success).toBe(true);
    }
  });

  it("stamps metadata.sessionKind defaulting to user and preserves agent from context.customMetadata", async () => {
    const pipeline = new NormalizationPipeline();
    // Default case: no customMetadata.sessionKind -> "user"
    const rawRecord1: RawHarnessRecord = {
      recordId: "rec_kind_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "custom",
      rawPayload: {
        type: "message",
        role: "user",
        content: "Test sessionKind default",
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };
    const resUser = await pipeline.processRecord(rawRecord1);
    expect(resUser[0].status).toBe("success");
    if (resUser[0].status === "success") {
      expect(resUser[0].event.metadata?.sessionKind).toBe("user");
    }

    // Explicit agent case in context.customMetadata -> "agent"
    const rawRecord2: RawHarnessRecord = {
      ...rawRecord1,
      recordId: "rec_kind_2",
      sequenceNumber: 2,
      rawPayload: {
        type: "message",
        role: "user",
        content: "Test sessionKind agent",
      },
    };
    const resAgent = await pipeline.processRecord(rawRecord2, {
      customMetadata: { sessionKind: "agent" },
    });
    expect(resAgent[0].status).toBe("success");
    if (resAgent[0].status === "success") {
      expect(resAgent[0].event.metadata?.sessionKind).toBe("agent");
    }

    // Invalid sessionKind in customMetadata -> falls back to "user"
    const rawRecord3: RawHarnessRecord = {
      ...rawRecord1,
      recordId: "rec_kind_3",
      sequenceNumber: 3,
      rawPayload: {
        type: "message",
        role: "user",
        content: "Test sessionKind invalid",
      },
    };
    const resInvalid = await pipeline.processRecord(rawRecord3, {
      customMetadata: { sessionKind: "invalid_kind" },
    });
    expect(resInvalid[0].status).toBe("success");
    if (resInvalid[0].status === "success") {
      expect(resInvalid[0].event.metadata?.sessionKind).toBe("user");
    }
  });

  describe("Tool-I/O Token Estimation & Redaction Pipeline", () => {
    it("estimates 1 token for explicit result: null in tool_result without falling back to output", async () => {
      const pipeline = new NormalizationPipeline();
      const rawRecord: RawHarnessRecord = {
        recordId: "rec_null_result_1",
        sessionId,
        harnessId: "test_harness",
        sequenceNumber: 10,
        timestamp,
        recordType: "custom",
        rawPayload: {
          type: "tool_result",
          callId: "call_null_result_1",
          toolName: "void_fn",
          result: null,
          output: "Should be ignored because result property is present and null",
          isError: false,
          executionDurationMs: 10,
        },
        cursor: { offset: 0, line: 10, sequence: 10, timestamp },
        metadata: {},
      };

      const results = await pipeline.processRecord(rawRecord);
      expect(results[0].status).toBe("success");
      if (results[0].status === "success") {
        const estimate = results[0].event.metadata?.resinTokenEstimateV1;
        expect(estimate).toEqual({
          method: TOOL_IO_UTF8_METHOD,
          inputTokens: 0,
          outputTokens: 1, // "null" is 4 UTF-8 bytes => 1 token
          discoveryTokens: 0,
          totalTokens: 1,
        });
      }
    });

    it("estimates 1 token for explicit parameters: null in tool_call", async () => {
      const pipeline = new NormalizationPipeline();
      const rawRecord: RawHarnessRecord = {
        recordId: "rec_null_params_1",
        sessionId,
        harnessId: "test_harness",
        sequenceNumber: 11,
        timestamp,
        recordType: "custom",
        rawPayload: {
          type: "tool_call",
          callId: "call_null_params_1",
          toolName: "null_param_tool",
          parameters: null,
          isShadow: false,
        },
        cursor: { offset: 0, line: 11, sequence: 11, timestamp },
        metadata: {},
      };

      const results = await pipeline.processRecord(rawRecord);
      expect(results[0].status).toBe("success");
      if (results[0].status === "success") {
        const estimate = results[0].event.metadata?.resinTokenEstimateV1;
        expect(estimate).toEqual({
          method: TOOL_IO_UTF8_METHOD,
          inputTokens: 1, // "null" is 4 UTF-8 bytes => 1 token
          outputTokens: 0,
          discoveryTokens: 0,
          totalTokens: 1,
        });
      }
    });

    it("estimates tokens from raw payload before privacy redaction runs", async () => {
      const pipeline = new NormalizationPipeline();
      // Long sensitive string that will be redacted
      const sensitiveOutput = "SECRET_KEY_1234567890_VERY_LONG_VALUE_ABCD_EFGH_IJKL_MNOP";
      const rawRecord: RawHarnessRecord = {
        recordId: "rec_raw_estimator_1",
        sessionId,
        harnessId: "test_harness",
        sequenceNumber: 12,
        timestamp,
        recordType: "custom",
        rawPayload: {
          type: "tool_result",
          callId: "call_raw_estimator_1",
          toolName: "credential_fetcher",
          result: { token: sensitiveOutput },
          isError: false,
          executionDurationMs: 45,
        },
        cursor: { offset: 0, line: 12, sequence: 12, timestamp },
        metadata: {},
      };

      const results = await pipeline.processRecord(rawRecord);
      expect(results[0].status).toBe("success");
      if (results[0].status === "success") {
        const estimate = results[0].event.metadata?.resinTokenEstimateV1;
        expect(estimate).toBeDefined();
        expect(estimate?.method).toBe(TOOL_IO_UTF8_METHOD);
        expect(estimate?.outputTokens).toBeGreaterThan(0);
        expect(estimate?.totalTokens).toBe(estimate?.outputTokens);
      }
    });
  });
});
