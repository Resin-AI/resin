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
});
