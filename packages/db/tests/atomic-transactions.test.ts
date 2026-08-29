import type { NormalizedMessageEvent, SyncCursor } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/store.js";

describe("Atomic Transaction Operations", () => {
  it("atomically commits cursor advancement, normalized event insertion, and outbox write", async () => {
    const store = await createInMemoryStateStore();

    // Prepare session
    await store.sessions.saveSession({
      sessionId: "ses_01j7db4n000000000000000010",
      harnessId: "omp",
      status: "active",
      startedAt: "2026-08-17T15:00:00.000Z",
    });

    const cursor: SyncCursor = {
      cursorId: "cur_01j7db4n000000000000000010",
      deviceId: "dev_01j7db4n000000000000000010",
      entityType: "normalized_events",
      lastSyncedSequence: 10,
      lastSyncedTimestamp: "2026-08-17T15:00:01.000Z",
      syncToken: "sync_token_v1",
    };

    const event: NormalizedMessageEvent = {
      eventId: "evt_01j7db4n000000000000000010",
      schemaVersion: "0.1.0",
      sessionId: "ses_01j7db4n000000000000000010",
      timestamp: "2026-08-17T15:00:01.000Z",
      causalRef: {
        causalSequence: 10,
      },
      redaction: {
        isRedacted: false,
        redactionRulesApplied: [],
      },
      type: "message",
      role: "assistant",
      content: "Executed tool successfully.",
    };

    // Execute atomic composite operation in store.transaction
    await store.transaction(async (txStore) => {
      // 1. Advance cursor
      await txStore.sessions.saveCursor(cursor);

      // 2. Insert event
      await txStore.sessions.insertEvent(event);

      // 3. Enqueue outbox notification
      await txStore.sync.enqueueOutbox({
        outboxId: "out_01j7db4n000000000000000010",
        topic: "events.uploaded",
        payload: { eventId: event.eventId, sequence: 10 },
      });
    });

    // Verify all 3 writes are visible and committed
    const savedCursor = await store.sessions.getCursor(cursor.cursorId);
    expect(savedCursor?.lastSyncedSequence).toBe(10);

    const savedEvent = await store.sessions.getEventById(event.eventId);
    expect(savedEvent?.eventId).toBe(event.eventId);

    const pendingOutbox = await store.sync.fetchPendingOutbox();
    expect(pendingOutbox.some((o) => o.outboxId === "out_01j7db4n000000000000000010")).toBe(true);

    store.close();
  });

  it("rolls back all operations if any failure occurs during the atomic transaction", async () => {
    const store = await createInMemoryStateStore();

    await store.sessions.saveSession({
      sessionId: "ses_01j7db4n000000000000000011",
      harnessId: "omp",
      status: "active",
      startedAt: "2026-08-17T15:10:00.000Z",
    });

    const cursor: SyncCursor = {
      cursorId: "cur_01j7db4n000000000000000011",
      deviceId: "dev_01j7db4n000000000000000011",
      entityType: "normalized_events",
      lastSyncedSequence: 20,
      lastSyncedTimestamp: "2026-08-17T15:10:01.000Z",
      syncToken: "sync_token_v2",
    };

    const event: NormalizedMessageEvent = {
      eventId: "evt_01j7db4n000000000000000011",
      schemaVersion: "0.1.0",
      sessionId: "ses_01j7db4n000000000000000011",
      timestamp: "2026-08-17T15:10:01.000Z",
      causalRef: {
        causalSequence: 20,
      },
      redaction: {
        isRedacted: false,
        redactionRulesApplied: [],
      },
      type: "message",
      role: "assistant",
      content: "This write will be aborted.",
    };

    await expect(
      store.transaction(async (txStore) => {
        // 1. Advance cursor
        await txStore.sessions.saveCursor(cursor);

        // 2. Insert event
        await txStore.sessions.insertEvent(event);

        // 3. Simulated panic / crash before outbox write completes
        throw new Error("Network crash or power loss simulation");
      }),
    ).rejects.toThrow("Network crash or power loss simulation");

    // Verify NONE of the 3 writes persisted
    const savedCursor = await store.sessions.getCursor(cursor.cursorId);
    expect(savedCursor).toBeNull();

    const savedEvent = await store.sessions.getEventById(event.eventId);
    expect(savedEvent).toBeNull();

    const pendingOutbox = await store.sync.fetchPendingOutbox();
    expect(pendingOutbox.find((o) => o.topic === "events.uploaded")).toBeUndefined();

    store.close();
  });
});
