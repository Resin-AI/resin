import { NormalizedSessionEventSchema } from "@resin/contracts";
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
});
