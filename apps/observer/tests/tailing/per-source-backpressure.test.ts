import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { BoundedRecordQueue, TranscriptTailer } from "../../src/tailing/index.js";
import { FakeSessionEventSource } from "../fake-harness.js";

describe("Independent Per-Source Backpressure and Queue Isolation", () => {
  it("isolates queues so a slow/stalled session does not block parallel active sessions", async () => {
    const tailer = new TranscriptTailer({
      defaultQueueCapacity: 10,
      defaultBatchSize: 2,
    });

    const sessionA: HarnessSession = {
      sessionId: "session-slow-A",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath: "/tmp/fake-A.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const sessionB: HarnessSession = {
      sessionId: "session-fast-B",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath: "/tmp/fake-B.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const sourceA = new FakeSessionEventSource(sessionA.sessionId);
    const sourceB = new FakeSessionEventSource(sessionB.sessionId);

    const receivedA: RawHarnessRecord[] = [];
    const receivedB: RawHarnessRecord[] = [];
    const ackQueueA: Array<() => Promise<void>> = [];

    let resolveFastDone: () => void;
    const fastDonePromise = new Promise<void>((resolve) => {
      resolveFastDone = resolve;
    });

    tailer.onRecords(async (session, records, ack) => {
      if (session.sessionId === sessionA.sessionId) {
        receivedA.push(...records);
        // Do NOT ack session A immediately (simulate slow consumer)
        ackQueueA.push(ack);
      } else if (session.sessionId === sessionB.sessionId) {
        receivedB.push(...records);
        // Fast consumer: immediately ack
        await ack();
        if (receivedB.length >= 10) {
          resolveFastDone();
        }
      }
    });

    await tailer.attachSession(sessionA, sourceA, {
      queueCapacity: 10,
      highWatermarkRatio: 0.5,
      lowWatermarkRatio: 0.2,
    });
    await tailer.attachSession(sessionB, sourceB, { queueCapacity: 10 });

    // Emit 10 records for session A
    for (let i = 1; i <= 10; i++) {
      sourceA.appendRecord({ item: `A-${i}` });
    }

    // Emit 10 records for session B
    for (let i = 1; i <= 10; i++) {
      sourceB.appendRecord({ item: `B-${i}` });
    }

    // Session B must finish fast without being blocked by Session A
    await fastDonePromise;
    expect(receivedB).toHaveLength(10);
    expect(receivedB.map((r) => (r.rawPayload as { item: string }).item)).toEqual([
      "B-1",
      "B-2",
      "B-3",
      "B-4",
      "B-5",
      "B-6",
      "B-7",
      "B-8",
      "B-9",
      "B-10",
    ]);

    // Session A should have paused / hit backpressure
    const statusA = tailer.getSessionStatus(sessionA.sessionId);
    expect(statusA).not.toBeNull();
    expect(statusA?.queueSize).toBeGreaterThan(0);

    // Now drain session A by calling its pending acks
    while (ackQueueA.length > 0) {
      const ack = ackQueueA.shift();
      if (ack) await ack();
    }

    await tailer.close();
  });

  it("handles retry exhaustion and routes repeatedly failed records to DLQ", async () => {
    const queue = new BoundedRecordQueue({
      sessionId: "session-dlq-test",
      capacity: 20,
      maxRetries: 2,
    });

    const fakeSource = new FakeSessionEventSource("session-dlq-test");
    const badRecord = fakeSource.appendRecord({ corrupt: true });
    const goodRecord = fakeSource.appendRecord({ valid: true });

    queue.enqueue(badRecord);
    queue.enqueue(goodRecord);

    expect(queue.size).toBe(2);

    // 1st dequeue & failure on bad record
    const batch1 = queue.dequeue(1);
    expect(batch1[0].recordId).toBe(badRecord.recordId);
    queue.nack(badRecord.recordId, "Parsing error 1");

    // badRecord is re-queued at front for 2nd attempt
    const batch2 = queue.dequeue(1);
    expect(batch2[0].recordId).toBe(badRecord.recordId);
    queue.nack(badRecord.recordId, "Parsing error 2");

    // Now maxRetries (2) is reached -> routed to DLQ!
    const deadLetters = queue.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].record.recordId).toBe(badRecord.recordId);
    expect(deadLetters[0].reason).toBe("RETRY_EXHAUSTED");

    // Good record can now be dequeued and acked normally
    const batch3 = queue.dequeue(1);
    expect(batch3[0].recordId).toBe(goodRecord.recordId);
    queue.ack(goodRecord.recordId);

    expect(queue.size).toBe(0);
    expect(queue.getMetrics().deadLetterCount).toBe(1);
    expect(queue.getMetrics().ackedTotal).toBe(1);
  });
});
