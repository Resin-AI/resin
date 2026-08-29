import { DeadLetterRecordSchema } from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  DecodeError,
  type HarnessRecordDecoder,
  NormalizationPipeline,
} from "../../src/normalization/index.js";

describe("Dead-Letter Handling & Content Integrity", () => {
  const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
  const timestamp = "2026-08-17T12:00:00.000Z";

  it("captures dead letters when raw records fail decoding", async () => {
    const store = await createInMemoryStateStore();
    const syncRepo = store.sync;

    const pipeline = new NormalizationPipeline({
      syncRepository: syncRepo,
      dbConnection: store.connection,
    });

    // Custom failing decoder
    const brokenDecoder: HarnessRecordDecoder = {
      harnessId: "failing_harness",
      decoderVersion: "1.0.0",
      canDecode: () => true,
      decode: () => {
        throw new DecodeError("Corrupt byte stream in harness transcript");
      },
    };
    pipeline.registerDecoder(brokenDecoder);

    const corruptRecord: RawHarnessRecord = {
      recordId: "rec_corrupt_1",
      sessionId,
      harnessId: "failing_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "transcript_line",
      rawPayload: "invalid \x00 binary \xFF garbage",
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const results = await pipeline.processRecord(corruptRecord);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("dead_letter");

    if (results[0].status === "dead_letter") {
      expect(results[0].errorReason).toContain("Corrupt byte stream");
      const deadLetter = results[0].deadLetterRecord;
      expect(deadLetter.deadLetterId.startsWith("dl_")).toBe(true);
      expect(deadLetter.status).toBe("pending");

      // Verify schema adherence
      const parsed = DeadLetterRecordSchema.parse(deadLetter);
      expect(parsed.deadLetterId).toBe(deadLetter.deadLetterId);

      // Verify persisted in DB
      const dbDeadLetter = await syncRepo.getDeadLetter(deadLetter.deadLetterId);
      expect(dbDeadLetter).not.toBeNull();
      expect(dbDeadLetter?.errorReason).toContain("Corrupt byte stream");
    }
  });

  it("rejects conflicting content under identical sequence as integrity error", async () => {
    const store = await createInMemoryStateStore();
    const sessionRepo = store.sessions;
    const syncRepo = store.sync;

    await sessionRepo.saveSession({
      sessionId,
      harnessId: "test_harness",
      status: "running",
      startedAt: timestamp,
    });

    const pipeline = new NormalizationPipeline({
      sessionRepository: sessionRepo,
      syncRepository: syncRepo,
      dbConnection: store.connection,
    });

    const record1: RawHarnessRecord = {
      recordId: "rec_seq_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "transcript_line",
      rawPayload: {
        type: "message",
        role: "user",
        content: "Original first message",
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    // First record processes successfully
    const res1 = await pipeline.processRecord(record1);
    expect(res1[0].status).toBe("success");

    // Conflicting record with same sequence number but different content
    const conflictingRecord: RawHarnessRecord = {
      recordId: "rec_seq_1_conflict",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "transcript_line",
      rawPayload: {
        type: "message",
        role: "user",
        content: "MUTATED conflicting first message",
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const resConflict = await pipeline.processRecord(conflictingRecord);
    expect(resConflict.length).toBe(1);
    expect(resConflict[0].status).toBe("dead_letter");

    if (resConflict[0].status === "dead_letter") {
      expect(resConflict[0].errorReason).toContain("conflict");
      const deadLetter = resConflict[0].deadLetterRecord;
      expect(deadLetter.deadLetterId.startsWith("dl_")).toBe(true);

      // Verify dead letter in DB
      const dbDeadLetters = await syncRepo.listDeadLetters();
      expect(dbDeadLetters.length).toBe(1);
      expect(dbDeadLetters[0].errorReason).toContain("conflict");
    }
  });

  it("captures schema validation failures into dead-letter store", async () => {
    const store = await createInMemoryStateStore();
    const syncRepo = store.sync;

    const pipeline = new NormalizationPipeline({
      syncRepository: syncRepo,
      dbConnection: store.connection,
    });

    const invalidRecord: RawHarnessRecord = {
      recordId: "rec_invalid_schema",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "custom",
      rawPayload: {
        type: "message",
        role: "invalid_role_not_in_enum",
        content: 12345, // invalid type for content
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    const results = await pipeline.processRecord(invalidRecord);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("dead_letter");

    if (results[0].status === "dead_letter") {
      expect(results[0].errorReason).toContain("Schema validation failed");
      const deadLetter = results[0].deadLetterRecord;
      expect(deadLetter.status).toBe("pending");
    }
  });
});
