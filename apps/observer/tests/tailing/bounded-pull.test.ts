import type {
  HarnessSession,
  RawHarnessRecord,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { TranscriptTailer } from "../../src/tailing/index.js";

describe("Bounded pull delivery", () => {
  it("retains appended records upstream while queued and in-flight records fill a tiny queue", async () => {
    const session: HarnessSession = {
      sessionId: "bounded-pull",
      workspaceId: "workspace",
      harnessId: "synthetic-pull",
      transcriptPath: "",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const appended: RawHarnessRecord[] = [];
    let readIndex = 0;
    let checkpoint: SourceCursor | null = null;
    const source: SessionEventSource = {
      async readNext(batchSize = 50) {
        const batch = appended.slice(readIndex, readIndex + batchSize);
        readIndex += batch.length;
        return batch;
      },
      onRecords() {
        // This source is pull-only: appending does not publish records.
        return () => {};
      },
      async checkpoint(cursor) {
        checkpoint = cursor;
      },
      getCursor() {
        return appended[readIndex - 1]?.cursor ?? null;
      },
      async detectRotation() {
        return false;
      },
      async close() {},
    };
    const append = (count: number) => {
      for (let index = 0; index < count; index++) {
        const sequenceNumber = appended.length;
        appended.push({
          recordId: `record-${sequenceNumber}`,
          sessionId: session.sessionId,
          harnessId: session.harnessId,
          sequenceNumber,
          timestamp: session.startedAt,
          recordType: "transcript_line",
          rawPayload: { sequenceNumber },
          cursor: {
            offset: sequenceNumber + 1,
            line: sequenceNumber + 1,
            sequence: sequenceNumber,
            timestamp: session.startedAt,
          },
          metadata: {},
        });
      }
    };
    const tailer = new TranscriptTailer({ pendingStorageDirectory: null });
    const received: RawHarnessRecord[] = [];
    const deliveries: Array<{ count: number; ack: () => Promise<void> }> = [];
    let acknowledged = 0;
    tailer.onRecords((_session, records, ack) => {
      received.push(...records);
      deliveries.push({ count: records.length, ack });
    });
    const expectBoundedPending = () => {
      const queued = tailer.getSessionStatus(session.sessionId)?.queueSize;
      expect(queued).toBeDefined();
      const pending = (queued ?? 0) + received.length - acknowledged;
      expect(pending).toBeLessThanOrEqual(2);
      // Every consumed record must still be accounted for, not silently rejected.
      expect(readIndex).toBe(acknowledged + pending);
    };

    try {
      await tailer.attachSession(session, source, {
        queueCapacity: 2,
        highWatermarkRatio: 1,
      });
      await tailer.pumpSession(session.sessionId);
      append(1);
      await tailer.pumpSession(session.sessionId);
      expect(received.map((record) => record.sequenceNumber)).toEqual([0]);

      // One record is already in flight, leaving room for only one queued record.
      append(19);
      await tailer.pumpSession(session.sessionId);
      expect(readIndex).toBe(2);
      expectBoundedPending();
      expect(checkpoint).toBeNull();

      for (let cycle = 0; cycle < 3; cycle++) {
        await tailer.pumpSession(session.sessionId);
        expect(readIndex).toBe(2);
        expectBoundedPending();
      }

      while (acknowledged < appended.length) {
        const delivery = deliveries.shift();
        expect(delivery).toBeDefined();
        if (!delivery) throw new Error("Delivery did not resume after acknowledgement");
        acknowledged += delivery.count;
        await delivery.ack();
        await tailer.pumpSession(session.sessionId);
        expectBoundedPending();
      }

      expect(received.map((record) => record.recordId)).toEqual(
        appended.map((record) => record.recordId),
      );
      expect(tailer.getSessionStatus(session.sessionId)?.ackedCursor?.sequence).toBe(19);
      expect(tailer.getSessionStatus(session.sessionId)?.queueSize).toBe(0);
    } finally {
      await tailer.close();
    }
  });
});
