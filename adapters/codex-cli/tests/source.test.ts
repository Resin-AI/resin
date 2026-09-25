import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodexSessionEventSource } from "../src/source.js";

const RecordOrdinalSchema = z.object({ ordinal: z.number() }).passthrough();
const RecordPayloadTextSchema = z
  .object({ payload: z.object({ text: z.string() }).passthrough() })
  .passthrough();

function recordOrdinal(value: unknown): number | undefined {
  const result = RecordOrdinalSchema.safeParse(value);
  return result.success ? result.data.ordinal : undefined;
}

function recordPayloadText(value: unknown): string | undefined {
  const result = RecordPayloadTextSchema.safeParse(value);
  return result.success ? result.data.payload.text : undefined;
}

async function drainUntilEmpty<T>(readNext: () => Promise<T[]>): Promise<T[]> {
  const records: T[] = [];
  while (true) {
    const batch = await readNext();
    if (batch.length === 0) return records;
    records.push(...batch);
  }
}

describe("CodexSessionEventSource", () => {
  it("reads records incrementally and updates cursor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-source-test-"));
    const transcriptPath = path.join(tempDir, "session.jsonl");

    const line1 = '{"type":"user_message","content":"Hello world"}\n';
    const line2 = '{"type":"assistant_message","content":"Hi there!"}\n';
    await fs.writeFile(transcriptPath, line1 + line2, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess_source_01",
    });

    // Read batch of 1
    const firstBatch = await source.readNext(1);
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]?.rawPayload).toEqual({ type: "user_message", content: "Hello world" });

    const cursorAfterFirst = source.getCursor();
    expect(cursorAfterFirst?.sequence).toBe(1);
    expect(cursorAfterFirst?.offset).toBe(Buffer.byteLength(line1, "utf8"));

    // Read next batch
    const secondBatch = await source.readNext(10);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]?.rawPayload).toEqual({ type: "assistant_message", content: "Hi there!" });

    const cursorAfterSecond = source.getCursor();
    expect(cursorAfterSecond?.sequence).toBe(2);
    expect(cursorAfterSecond?.offset).toBe(Buffer.byteLength(line1 + line2, "utf8"));

    // Subsequent read returns empty when no new lines
    const emptyBatch = await source.readNext();
    expect(emptyBatch).toHaveLength(0);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("preserves native rollout wrappers and resumes at the exact partial-line boundary", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-source-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const callRecord = {
      timestamp: "2026-09-23T12:00:00.000Z",
      ordinal: 10,
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-native-01",
        name: "exec_command",
        arguments: '{"cmd":"printf hello"}',
      },
    };
    const partialRecord = JSON.stringify({
      timestamp: "2026-09-23T12:00:01.000Z",
      ordinal: 11,
      type: "event_msg",
      payload: { type: "task_complete" },
    }).slice(0, -1);
    const firstLine = `${JSON.stringify(callRecord)}\n`;
    await fs.writeFile(transcriptPath, firstLine + partialRecord, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess_stable-rollout",
    });
    const firstBatch = await source.readNext(10);
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]?.rawPayload).toEqual(callRecord);
    expect(firstBatch[0]?.recordType).toBe("custom");
    expect(firstBatch[0]?.timestamp).toBe(callRecord.timestamp);
    expect(source.getCursor()?.offset).toBe(Buffer.byteLength(firstLine, "utf8"));
    expect(await source.readNext(10)).toHaveLength(0);

    const invalidTimestampRecord = {
      timestamp: "not-a-timestamp",
      ordinal: 12,
      type: "turn_context",
      payload: { cwd: "/recorded/project" },
    };
    const completedPartial = `${partialRecord}}\n`;
    const invalidTimestampLine = `${JSON.stringify(invalidTimestampRecord)}\n`;
    await fs.appendFile(transcriptPath, `}\n${invalidTimestampLine}`, "utf8");
    const resumedBatch = await source.readNext(10);
    expect(resumedBatch).toHaveLength(2);
    expect(resumedBatch[0]?.rawPayload).toEqual(JSON.parse(`${partialRecord}}\n`));
    expect(resumedBatch[0]?.recordId).toBe("rec_2");
    expect(resumedBatch[1]?.rawPayload).toEqual(invalidTimestampRecord);
    expect(Number.isFinite(Date.parse(resumedBatch[1]!.timestamp))).toBe(true);
    expect(resumedBatch[1]?.recordId).toBe("rec_3");
    expect(source.getCursor()?.offset).toBe(
      Buffer.byteLength(firstLine + completedPartial + invalidTimestampLine, "utf8"),
    );

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("drains a 2 MiB native JSONL record in bounded read quanta", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-large-record-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const text = "x".repeat(2 * 1024 * 1024);
    const record = {
      timestamp: "2026-09-23T12:00:00.000Z",
      ordinal: 1,
      type: "response_item",
      payload: { type: "message", text },
    };
    const serialized = `${JSON.stringify(record)}\n`;
    await fs.writeFile(transcriptPath, serialized, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess_large-record",
    });
    const records = await drainUntilEmpty(() => source.readNext(100));
    expect(records).toHaveLength(1);
    expect(recordPayloadText(records[0]?.rawPayload)).toHaveLength(text.length);
    expect(source.getCursor()?.offset).toBe(Buffer.byteLength(serialized, "utf8"));
    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("bounds an unfinished oversized line and resumes after its delimiter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-oversized-line-cap-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const oversizedLine = JSON.stringify({
      type: "response_item",
      payload: { type: "message", text: "x".repeat(8 * 1024 * 1024 + 1024) },
    });
    const nextRecord = {
      timestamp: "2026-09-23T12:00:00.000Z",
      ordinal: 2,
      type: "event_msg",
      payload: { type: "task_complete" },
    };
    const nextLine = `${JSON.stringify(nextRecord)}\n`;
    await fs.writeFile(transcriptPath, oversizedLine, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-oversized-line",
    });
    const beforeAppend = await drainUntilEmpty(() => source.readNext(100));
    expect(beforeAppend).toHaveLength(0);
    expect(source.getCursor()?.offset).toBe(0);
    expect(await source.detectRotation()).toBe(false);

    await fs.appendFile(transcriptPath, `\n${nextLine}`, "utf8");
    const records = await drainUntilEmpty(() => source.readNext(100));
    expect(records).toHaveLength(1);
    expect(records[0]?.rawPayload).toEqual(nextRecord);
    expect(records[0]?.recordId).toBe("rec_1");
    expect(source.getCursor()?.offset).toBe(
      Buffer.byteLength(`${oversizedLine}\n${nextLine}`, "utf8"),
    );

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("serializes concurrent reads and preserves the frontier after a delayed checkpoint", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-concurrent-read-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const lines = [1, 2, 3].map(
      (ordinal) =>
        `${JSON.stringify({
          timestamp: "2026-09-23T12:00:00.000Z",
          ordinal,
          type: "response_item",
          payload: { type: "message", text: `record-${ordinal}` },
        })}\n`,
    );
    await fs.writeFile(transcriptPath, lines.join(""), "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-concurrent-read",
    });
    const [firstBatch, secondBatch] = await Promise.all([source.readNext(1), source.readNext(1)]);
    expect(recordOrdinal(firstBatch[0]?.rawPayload)).toBe(1);
    expect(recordOrdinal(secondBatch[0]?.rawPayload)).toBe(2);

    await source.checkpoint(firstBatch[0]!.cursor);
    const thirdBatch = await source.readNext(1);
    expect(recordOrdinal(thirdBatch[0]?.rawPayload)).toBe(3);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("restores a pre-read checkpoint and keeps explicit cursor rewinds available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-checkpoint-restore-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const lines = [1, 2, 3].map(
      (ordinal) =>
        `${JSON.stringify({
          timestamp: "2026-09-23T12:00:00.000Z",
          ordinal,
          type: "response_item",
          payload: { type: "message", text: `record-${ordinal}` },
        })}\n`,
    );
    await fs.writeFile(transcriptPath, lines.join(""), "utf8");

    const cursorSource = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-checkpoint-restore",
    });
    const firstRecord = (await cursorSource.readNext(1))[0]!;
    await cursorSource.close();

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-checkpoint-restore",
    });
    const initialCursor = source.getCursor()!;
    await source.checkpoint(firstRecord.cursor);
    const restoredBatch = await source.readNext(1);
    expect(recordOrdinal(restoredBatch[0]?.rawPayload)).toBe(2);

    await source.setCursor(initialCursor);
    const rewoundBatch = await source.readNext(1);
    expect(recordOrdinal(rewoundBatch[0]?.rawPayload)).toBe(1);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("waits for accepted reads before closing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-close-queued-read-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const rows = [1, 2].map(
      (ordinal) =>
        `${JSON.stringify({
          timestamp: "2026-09-23T12:00:00.000Z",
          ordinal,
          type: "response_item",
          payload: { type: "message", text: `record-${ordinal}` },
        })}\n`,
    );
    await fs.writeFile(transcriptPath, rows.join(""), "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-close-queued-read",
    });
    const firstRead = source.readNext(1);
    const secondRead = source.readNext(1);
    const close = source.close();
    const [firstBatch, secondBatch] = await Promise.all([firstRead, secondRead]);
    await close;

    expect(recordOrdinal(firstBatch[0]?.rawPayload)).toBe(1);
    expect(recordOrdinal(secondBatch[0]?.rawPayload)).toBe(2);
    expect(await source.readNext(1)).toEqual([]);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("detects rotation when file is truncated", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rotation-test-"));
    const transcriptPath = path.join(tempDir, "session.jsonl");

    const fullContent = '{"type":"user_message","content":"Initial long message..."}\n'.repeat(5);
    await fs.writeFile(transcriptPath, fullContent, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess_rot_01",
    });

    await source.readNext(5);
    const rotationBefore = await source.detectRotation();
    expect(rotationBefore).toBe(false);

    // Truncate file to shorter length
    await fs.writeFile(transcriptPath, '{"type":"user_message","content":"Reset"}\n', "utf8");

    const rotationAfter = await source.detectRotation();
    expect(rotationAfter).toBe(true);

    await source.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("streams new records via onRecords listener", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sub-test-"));
    const transcriptPath = path.join(tempDir, "session.jsonl");
    await fs.writeFile(transcriptPath, "", "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess_stream_01",
      pollIntervalMs: 25,
    });

    const { promise: gotTwoRecords, resolve: onTwoRecords } = Promise.withResolvers<void>();
    const received: string[] = [];

    const unsubscribe = source.onRecords((records) => {
      for (const r of records) {
        // SAFETY: Test transcript records are JSON objects containing string content.
        const payload = r.rawPayload as { content?: string };
        if (payload.content) received.push(payload.content);
      }
      if (received.length >= 2) {
        onTwoRecords();
      }
    });

    // Append records
    await fs.appendFile(transcriptPath, '{"type":"user_message","content":"Message 1"}\n');
    await fs.appendFile(transcriptPath, '{"type":"user_message","content":"Message 2"}\n');

    await gotTwoRecords;

    unsubscribe();
    await source.close();

    expect(received).toContain("Message 1");
    expect(received).toContain("Message 2");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("delivers accepted push batches after unsubscribe before the remaining pull drain", async () => {
    vi.useFakeTimers();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-inflight-push-test-"));
    const transcriptPath = path.join(tempDir, "rollout.jsonl");
    const lines = [1, 2, 3].map(
      (ordinal) =>
        `${JSON.stringify({
          timestamp: "2026-09-23T12:00:00.000Z",
          ordinal,
          type: "response_item",
          payload: { type: "message", text: `record-${ordinal}` },
        })}\n`,
    );
    const content = lines.join("");
    await fs.writeFile(transcriptPath, content, "utf8");

    const source = new CodexSessionEventSource({
      filePath: transcriptPath,
      sessionId: "sess-inflight-push",
      pollIntervalMs: 5,
    });
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const readFinished = Promise.withResolvers<void>();
    const originalReadNext = source.readNext.bind(source);
    let delayFirstRead = true;
    source.readNext = async (batchSize = 100) => {
      const shouldDelay = delayFirstRead;
      if (shouldDelay) {
        delayFirstRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      }
      const records = await originalReadNext(batchSize);
      if (shouldDelay) readFinished.resolve();
      return records;
    };

    try {
      const pushed: number[] = [];
      const unsubscribe = source.onRecords((records) => {
        for (const record of records) {
          pushed.push(recordOrdinal(record.rawPayload) ?? -1);
        }
      });
      await vi.advanceTimersByTimeAsync(5);
      await readStarted.promise;
      unsubscribe();
      releaseRead.resolve();
      await readFinished.promise;
      await Promise.resolve();

      const remaining = await drainUntilEmpty(() => source.readNext(100));
      const delivered = [
        ...pushed,
        ...remaining.map((record) => recordOrdinal(record.rawPayload) ?? -1),
      ].sort((left, right) => left - right);
      expect(delivered).toEqual([1, 2, 3]);
      expect(new Set(delivered).size).toBe(3);
      expect(source.getCursor()?.offset).toBe(Buffer.byteLength(content, "utf8"));

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: "2026-09-23T12:00:01.000Z",
          ordinal: 4,
          type: "response_item",
          payload: { type: "message", text: "record-4" },
        })}\n`,
        "utf8",
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(pushed).toEqual([1, 2, 3]);
      const laterRecords = await drainUntilEmpty(() => source.readNext(100));
      expect(laterRecords.map((record) => recordOrdinal(record.rawPayload) ?? -1)).toEqual([4]);
    } finally {
      releaseRead.resolve();
      await source.close();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
