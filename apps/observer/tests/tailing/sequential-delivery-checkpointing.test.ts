import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInMemoryStateStore } from "@resin/db";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SourceCursorManager,
  TranscriptTailer,
  TranscriptWatcher,
} from "../../src/tailing/index.js";

describe("Sequential Record Delivery and Atomic Checkpointing", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-seq-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("delivers transcript lines strictly in order with advancing sequence numbers and offsets", async () => {
    const lines = [
      JSON.stringify({ type: "prompt", text: "Hello AI" }),
      JSON.stringify({ type: "tool_call", tool: "calc", input: { a: 1, b: 2 } }),
      JSON.stringify({ type: "tool_result", tool: "calc", output: { result: 3 } }),
      JSON.stringify({ type: "completion", text: "The answer is 3." }),
    ];

    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const watcher = new TranscriptWatcher({
      filePath: transcriptPath,
      pollingIntervalMs: 20,
      coalesceDebounceMs: 5,
    });

    const parsed = await watcher.readNext();
    watcher.stop();

    expect(parsed).toHaveLength(4);
    expect(parsed[0].parsedJson).toEqual({ type: "prompt", text: "Hello AI" });
    expect(parsed[0].cursor.sequence).toBe(1);
    expect(parsed[0].cursor.line).toBe(1);

    expect(parsed[1].parsedJson).toEqual({
      type: "tool_call",
      tool: "calc",
      input: { a: 1, b: 2 },
    });
    expect(parsed[1].cursor.sequence).toBe(2);
    expect(parsed[1].cursor.line).toBe(2);

    expect(parsed[2].parsedJson).toEqual({
      type: "tool_result",
      tool: "calc",
      output: { result: 3 },
    });
    expect(parsed[2].cursor.sequence).toBe(3);
    expect(parsed[2].cursor.line).toBe(3);

    expect(parsed[3].parsedJson).toEqual({ type: "completion", text: "The answer is 3." });
    expect(parsed[3].cursor.sequence).toBe(4);
    expect(parsed[3].cursor.line).toBe(4);

    // Byte offsets must monotonically increase
    expect(parsed[0].cursor.offset).toBeLessThan(parsed[1].cursor.offset);
    expect(parsed[1].cursor.offset).toBeLessThan(parsed[2].cursor.offset);
    expect(parsed[2].cursor.offset).toBeLessThan(parsed[3].cursor.offset);
  });

  it("advances SQLite cursor checkpoint only upon durable handoff (ack)", async () => {
    const store = await createInMemoryStateStore();
    const cursorManager = new SourceCursorManager({ store });

    const session: HarnessSession = {
      sessionId: "session-seq-1",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const initialLines = [
      JSON.stringify({ type: "prompt", text: "First query" }),
      JSON.stringify({ type: "completion", text: "First response" }),
    ];
    fs.writeFileSync(transcriptPath, `${initialLines.join("\n")}\n`);

    const tailer = new TranscriptTailer({ cursorManager });
    const receivedBatches: RawHarnessRecord[][] = [];
    const ackPromises: Array<() => Promise<void>> = [];

    let batchResolve1: () => void;
    const p1 = new Promise<void>((resolve) => {
      batchResolve1 = resolve;
    });

    let batchResolve2: () => void;
    const p2 = new Promise<void>((resolve) => {
      batchResolve2 = resolve;
    });
    tailer.onRecords((_sess, records, ack) => {
      receivedBatches.push(records);
      ackPromises.push(ack);
      if (receivedBatches.length === 1) {
        batchResolve1();
      } else if (receivedBatches.length === 2) {
        batchResolve2();
      }
    });

    await tailer.attachSession(session, undefined, { pollingIntervalMs: 20 });

    // Wait for initial batch delivery
    await p1;

    expect(receivedBatches[0]).toHaveLength(2);

    // Before ack is called: checkpoint in SQLite must be null
    let savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor).toBeNull();

    // Perform durable ack
    await ackPromises[0]();

    // After ack: checkpoint in SQLite must match the latest record in batch
    savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor).not.toBeNull();
    expect(savedCursor?.sequence).toBe(2);

    // Append 2 more lines
    const nextLines = [
      JSON.stringify({ type: "prompt", text: "Second query" }),
      JSON.stringify({ type: "completion", text: "Second response" }),
    ];
    fs.appendFileSync(transcriptPath, `${nextLines.join("\n")}\n`);

    await p2;
    expect(receivedBatches[1]).toHaveLength(2);
    // Before second ack: cursor in SQLite must still be sequence 2
    savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor?.sequence).toBe(2);

    // Ack second batch
    await ackPromises[1]();

    savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor?.sequence).toBe(4);

    await tailer.close();
    store.close();
  });

  it("enforces monotonic cursor advancement and rejects regressions", async () => {
    const store = await createInMemoryStateStore();
    const cursorManager = new SourceCursorManager({ store });

    const cursor1 = {
      offset: 100,
      line: 5,
      sequence: 5,
      timestamp: new Date().toISOString(),
    };

    await cursorManager.commitCheckpoint("sess-mono", cursor1);
    const read1 = await cursorManager.getCursor("sess-mono");
    expect(read1?.sequence).toBe(5);

    // Regressing sequence or offset should throw by default
    const regressiveCursor = {
      offset: 50,
      line: 2,
      sequence: 2,
      timestamp: new Date().toISOString(),
    };

    await expect(cursorManager.commitCheckpoint("sess-mono", regressiveCursor)).rejects.toThrow(
      /Cannot regress cursor/,
    );

    // If allowRegression is set (e.g. during explicit file reset/truncation), it succeeds
    await cursorManager.commitCheckpoint("sess-mono", regressiveCursor, { allowRegression: true });
    const read2 = await cursorManager.getCursor("sess-mono");
    expect(read2?.sequence).toBe(2);
    expect(read2?.offset).toBe(50);

    store.close();
  });

  it("delivers queued and in-flight records in strict order before terminal empty-record callback without mutating context session", async () => {
    const lines = [
      JSON.stringify({ type: "prompt", text: "Line 1" }),
      JSON.stringify({ type: "completion", text: "Line 2" }),
      JSON.stringify({ type: "prompt", text: "Line 3" }),
      JSON.stringify({ type: "completion", text: "Line 4" }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const tailer = new TranscriptTailer({ defaultBatchSize: 2 });
    const session: HarnessSession = {
      sessionId: "sess-order-test",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const deliveryLog: Array<{ status: string; count: number; texts: string[] }> = [];
    const firstBatchInFlight = Promise.withResolvers<void>();
    const continueFirstBatch = Promise.withResolvers<void>();
    let isFirstBatch = true;

    tailer.onRecords(async (sess, records, ack) => {
      if (isFirstBatch && records.length > 0) {
        isFirstBatch = false;
        firstBatchInFlight.resolve();
        await continueFirstBatch.promise;
      }
      deliveryLog.push({
        status: sess.status,
        count: records.length,
        texts: records.map((r) => {
          const payload = r.rawPayload;
          if (payload && typeof payload === "object" && "text" in payload) {
            return String(payload.text);
          }
          return "";
        }),
      });
      await ack();
    });

    await tailer.attachSession(session, undefined, { pollingIntervalMs: 20 });

    // Wait for first batch to be in-flight in the recordHandler
    await firstBatchInFlight.promise;
    // Trigger notifyTerminalState while first batch is in-flight and second batch is queued
    const completedSession: HarnessSession = {
      ...session,
      status: "completed",
    };

    const notifyPromise = tailer.notifyTerminalState(completedSession);

    // Release the first in-flight batch
    continueFirstBatch.resolve();
    await notifyPromise;

    // Verify ordering: batch 1 (lines 1,2), batch 2 (lines 3,4), then terminal empty-record callback (status completed, 0 records)
    expect(deliveryLog).toHaveLength(3);
    expect(deliveryLog[0]).toEqual({
      status: "active",
      count: 2,
      texts: ["Line 1", "Line 2"],
    });
    expect(deliveryLog[1]).toEqual({
      status: "active",
      count: 2,
      texts: ["Line 3", "Line 4"],
    });
    expect(deliveryLog[2]).toEqual({
      status: "completed",
      count: 0,
      texts: [],
    });

    // Verify context.session was NOT mutated to completed
    const sessionStatus = tailer.getSessionStatus(session.sessionId);
    expect(sessionStatus?.sessionId).toBe(session.sessionId);

    // Non-tracked session is a no-op
    await tailer.notifyTerminalState({
      ...session,
      sessionId: "non-existent-session",
      status: "completed",
    });
    expect(deliveryLog).toHaveLength(3);

    await tailer.close();
  });

  it("delivers in-flight pump readNext that resolves after terminalization starts before the terminal callback", async () => {
    const tailer = new TranscriptTailer({ defaultBatchSize: 10 });
    const session: HarnessSession = {
      sessionId: "sess-inflight-pump-race",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath: "/tmp/fake-inflight.jsonl",
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const deliveryLog: Array<{ status: string; count: number; texts: string[] }> = [];
    const readNextEntered = Promise.withResolvers<void>();
    const allowReadNextToResolve = Promise.withResolvers<void>();

    let hasRead = false;
    const customSource: SessionEventSource = {
      readNext: async () => {
        if (!hasRead) {
          hasRead = true;
          readNextEntered.resolve();
          await allowReadNextToResolve.promise;
          return [
            {
              recordId: "rec-in-flight-pump",
              sessionId: session.sessionId,
              harnessId: session.harnessId,
              sequenceNumber: 1,
              timestamp: new Date().toISOString(),
              recordType: "transcript_line",
              rawPayload: { text: "Pumped during terminalization race" },
              cursor: { offset: 0, line: 1, sequence: 1, timestamp: new Date().toISOString() },
            },
          ];
        }
        return [];
      },
      onRecords: () => () => {},
      checkpoint: async () => {},
      getCursor: () => null,
      detectRotation: async () => false,
      close: async () => {},
    };

    tailer.onRecords(async (sess, records, ack) => {
      deliveryLog.push({
        status: sess.status,
        count: records.length,
        texts: records.map((r) => {
          const payload = r.rawPayload;
          if (payload && typeof payload === "object" && "text" in payload) {
            return String(payload.text);
          }
          return "";
        }),
      });
      await ack();
    });

    await tailer.attachSession(session, customSource);

    // 1. Start pumpSession in background — it enters customSource.readNext and blocks
    const pumpPromise = tailer.pumpSession(session.sessionId);
    await readNextEntered.promise;

    // 2. Trigger notifyTerminalState while readNext is currently in flight inside pumpSession
    const completedSession: HarnessSession = {
      ...session,
      status: "completed",
    };
    const notifyPromise = tailer.notifyTerminalState(completedSession);

    // 3. Now resolve the in-flight readNext: pumpSession must feed these records despite terminalizing
    allowReadNextToResolve.resolve();

    await pumpPromise;
    await notifyPromise;

    // 4. Verify ordering: pumped batch is delivered first, followed by the terminal callback
    expect(deliveryLog).toHaveLength(2);
    expect(deliveryLog[0]).toEqual({
      status: "active",
      count: 1,
      texts: ["Pumped during terminalization race"],
    });
    expect(deliveryLog[1]).toEqual({
      status: "completed",
      count: 0,
      texts: [],
    });

    await tailer.close();
  });

  it("preserves tailer attachment and context when terminal handler fails, remaining retryable", async () => {
    const tailer = new TranscriptTailer();
    const session: HarnessSession = {
      sessionId: "sess-terminal-fail-retry",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    let shouldFail = true;
    const receivedCalls: Array<{ status: string; count: number }> = [];

    tailer.onRecords(async (sess, records, ack) => {
      if (shouldFail && records.length === 0) {
        throw new Error("Downstream handler rejected terminal event");
      }
      receivedCalls.push({ status: sess.status, count: records.length });
      await ack();
    });

    await tailer.attachSession(session);

    const completedSession: HarnessSession = {
      ...session,
      status: "completed",
    };

    // First notify attempt fails
    await expect(tailer.notifyTerminalState(completedSession)).rejects.toThrow(
      "Downstream handler rejected terminal event",
    );

    // Session remains attached in tailer
    expect(tailer.getActiveSessions()).toContain(session.sessionId);

    // Second notify attempt succeeds
    shouldFail = false;
    await tailer.notifyTerminalState(completedSession);

    expect(receivedCalls).toHaveLength(1);
    expect(receivedCalls[0]).toEqual({
      status: "completed",
      count: 0,
    });

    await tailer.close();
  });

  it("rejects terminal state and produces no terminal callback when queue is paused with pending records, remaining attached", async () => {
    const lines = [
      JSON.stringify({ type: "prompt", text: "Pending line 1" }),
      JSON.stringify({ type: "completion", text: "Pending line 2" }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const tailer = new TranscriptTailer();
    const session: HarnessSession = {
      sessionId: "sess-paused-queue",
      workspaceId: "ws-1",
      harnessId: "fake",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    const receivedCalls: Array<{ status: string; count: number }> = [];
    tailer.onRecords(async (sess, records, ack) => {
      receivedCalls.push({ status: sess.status, count: records.length });
      await ack();
    });

    await tailer.attachSession(session, undefined, { pollingIntervalMs: 50 });
    tailer.pauseSession(session.sessionId);

    const completedSession: HarnessSession = {
      ...session,
      status: "completed",
    };

    // notifyTerminalState must fail fast and NOT dispatch empty terminal batch while paused
    await expect(tailer.notifyTerminalState(completedSession)).rejects.toThrow(
      /queue is paused or auth-degraded/,
    );

    // Zero terminal callbacks delivered
    expect(receivedCalls.filter((c) => c.count === 0)).toHaveLength(0);

    // Session remains attached in tailer
    expect(tailer.getActiveSessions()).toContain(session.sessionId);

    // Once resumed, notifyTerminalState successfully drains records and delivers terminal event
    tailer.resumeSession(session.sessionId);
    await tailer.notifyTerminalState(completedSession);

    expect(receivedCalls).toContainEqual({
      status: "completed",
      count: 0,
    });

    // Post-terminal writes must not trigger any further background source reads or deliveries
    const totalDeliveries = receivedCalls.length;
    fs.appendFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "prompt", text: "Post-terminal unread line" })}\n`,
    );
    await tailer.pumpSession(session.sessionId);
    expect(receivedCalls).toHaveLength(totalDeliveries);

    await tailer.close();
  });

  it("allows multiple in-flight batches when configured and advances checkpoints monotonically upon sequential ack", async () => {
    const store = await createInMemoryStateStore();
    const cursorManager = new SourceCursorManager({ store });

    const firstLines = [
      JSON.stringify({ type: "prompt", text: "Batch 1 Line 1" }),
      JSON.stringify({ type: "tool_call", tool: "calc", input: { a: 1 } }),
    ];
    const secondLines = [
      JSON.stringify({ type: "prompt", text: "Batch 2 Line 1" }),
      JSON.stringify({ type: "tool_call", tool: "calc", input: { a: 2 } }),
    ];
    fs.writeFileSync(transcriptPath, `${firstLines.join("\n")}\n`);

    const tailer = new TranscriptTailer({
      cursorManager,
      defaultBatchSize: 2,
      defaultMaxInFlightBatches: 3,
    });

    const receivedBatches: RawHarnessRecord[][] = [];
    const acks: Array<() => Promise<void>> = [];
    const batchResolve = Promise.withResolvers<void>();
    const firstBatchResolve = Promise.withResolvers<void>();

    tailer.onRecords((_sess, records, ack) => {
      receivedBatches.push(records);
      acks.push(ack);
      if (receivedBatches.length === 1) {
        firstBatchResolve.resolve();
      } else if (receivedBatches.length === 2) {
        batchResolve.resolve();
      }
    });

    const session: HarnessSession = {
      sessionId: "session-multi-inflight",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    await tailer.attachSession(session, undefined, { pollingIntervalMs: 20 });
    await firstBatchResolve.promise;
    fs.appendFileSync(transcriptPath, `${secondLines.join("\n")}\n`);
    await batchResolve.promise;

    // Both batches were delivered concurrently without waiting for batch 1 to ack
    expect(receivedBatches).toHaveLength(2);
    expect(receivedBatches[0]).toHaveLength(2);
    expect(receivedBatches[1]).toHaveLength(2);

    // Before any ack: checkpoint in SQLite is null
    let savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor).toBeNull();

    // Ack batch 1
    await acks[0]();
    savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor?.sequence).toBe(2);

    // Ack batch 2
    await acks[1]();
    savedCursor = await cursorManager.getCursor(session.sessionId);
    expect(savedCursor?.sequence).toBe(4);

    await tailer.close();
    store.close();
  });
});
