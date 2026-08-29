import { createInMemoryStateStore } from "@resin/db";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  NormalizationDeduplicator,
  NormalizationPipeline,
  generateDeterministicEventId,
} from "../../src/normalization/index.js";

describe("Idempotency & Deduplication", () => {
  const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
  const timestamp = "2026-08-17T12:00:00.000Z";

  it("is completely idempotent when re-processing identical raw records", async () => {
    const store = await createInMemoryStateStore();
    const sessionRepo = store.sessions;
    const syncRepo = store.sync;

    // Save session in DB
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

    const rawRecord: RawHarnessRecord = {
      recordId: "rec_dup_1",
      sessionId,
      harnessId: "test_harness",
      sequenceNumber: 1,
      timestamp,
      recordType: "transcript_line",
      rawPayload: {
        role: "user",
        content: "What is the capital of France?",
      },
      cursor: { offset: 0, line: 1, sequence: 1, timestamp },
      metadata: {},
    };

    // First process
    const results1 = await pipeline.processRecord(rawRecord);
    expect(results1.length).toBe(1);
    expect(results1[0].status).toBe("success");
    if (results1[0].status === "success") {
      expect(results1[0].isDuplicate).toBe(false);
      const eventId1 = results1[0].event.eventId;

      // Second process (identical)
      const results2 = await pipeline.processRecord(rawRecord);
      expect(results2.length).toBe(1);
      expect(results2[0].status).toBe("success");
      if (results2[0].status === "success") {
        expect(results2[0].isDuplicate).toBe(true);
        expect(results2[0].event.eventId).toBe(eventId1);
      }

      // Third process (identical)
      const results3 = await pipeline.processRecord(rawRecord);
      expect(results3.length).toBe(1);
      expect(results3[0].status).toBe("success");
      if (results3[0].status === "success") {
        expect(results3[0].isDuplicate).toBe(true);
      }

      // Verify only 1 event persisted in DB
      const dbEvents = await sessionRepo.getEvents(sessionId);
      expect(dbEvents.length).toBe(1);
      expect(dbEvents[0].eventId).toBe(eventId1);

      // Verify only 1 outbox entry enqueued
      const outboxItems = await syncRepo.fetchPendingOutbox(10);
      expect(outboxItems.length).toBe(1);
    }
  });

  it("handles in-memory deduplicator LRU eviction and statistics", () => {
    const deduplicator = new NormalizationDeduplicator({ maxCacheSize: 3 });

    const eventTemplate = {
      schemaVersion: "1.0.0",
      sessionId,
      timestamp,
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none" as const,
        scrubbedPatterns: [],
      },
      metadata: {},
    };

    // Create 4 events
    for (let i = 1; i <= 4; i++) {
      const payload = {
        type: "message" as const,
        role: "user" as const,
        content: `Message ${i}`,
      };
      const eventId = generateDeterministicEventId(sessionId, i, payload);
      const event = {
        ...eventTemplate,
        ...payload,
        eventId,
        causalRef: { causalSequence: i },
      };

      const outcome = deduplicator.checkEvent(event);
      expect(outcome.status).toBe("new");
      deduplicator.recordEvent(event);
    }

    const stats = deduplicator.getStats();
    expect(stats.seenCount).toBe(4);
    expect(stats.newCount).toBe(4);
    expect(stats.duplicateCount).toBe(0);
    expect(stats.cacheSize).toBe(3); // Evicted oldest entry (1)
  });
});
