import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInMemoryStateStore, createLocalStateStore } from "@resin/db";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RecordDeduplicator,
  SourceCursorManager,
  TranscriptTailer,
} from "../../src/tailing/index.js";
import { FakeSessionEventSource } from "../fake-harness.js";

describe("Restart Resilience and Deduplication", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-restart-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("resumes from last committed checkpoint after restart without duplicates or data loss", async () => {
    const store = await createInMemoryStateStore();
    const cursorManager = new SourceCursorManager({ store });

    const session: HarnessSession = {
      sessionId: "session-restart-1",
      workspaceId: "ws-restart",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    // Write initial 5 lines
    const lines1to5 = [
      JSON.stringify({ seq: 1, text: "Record 1" }),
      JSON.stringify({ seq: 2, text: "Record 2" }),
      JSON.stringify({ seq: 3, text: "Record 3" }),
      JSON.stringify({ seq: 4, text: "Record 4" }),
      JSON.stringify({ seq: 5, text: "Record 5" }),
    ];
    fs.writeFileSync(transcriptPath, `${lines1to5.join("\n")}\n`);

    // 1. Initial Tailer instance
    let tailer1: TranscriptTailer | undefined = new TranscriptTailer({
      cursorManager,
      defaultBatchSize: 3, // Batch size 3 so first batch is lines 1..3
    });

    const receivedPass1: RawHarnessRecord[] = [];
    let p1Resolve: () => void;
    const p1 = new Promise<void>((resolve) => {
      p1Resolve = resolve;
    });

    tailer1.onRecords(async (_sess, records, ack) => {
      receivedPass1.push(...records);
      await ack();
      p1Resolve();
    });

    await tailer1.attachSession(session, undefined, { pollingIntervalMs: 10 });
    await p1;

    // First batch of 3 received and acked
    expect(receivedPass1).toHaveLength(3);
    // SAFETY: Test record rawPayload carries seq number.
    expect((receivedPass1[0].rawPayload as { seq: number }).seq).toBe(1);
    // SAFETY: Test record rawPayload carries seq number.
    expect((receivedPass1[2].rawPayload as { seq: number }).seq).toBe(3);

    // Verify checkpoint in DB is at sequence 3
    const checkpointBeforeCrash = await cursorManager.getCursor(session.sessionId);
    expect(checkpointBeforeCrash).not.toBeNull();
    expect(checkpointBeforeCrash?.sequence).toBe(3);

    // 2. Simulate process restart: close tailer1
    await tailer1.close();
    tailer1 = undefined;

    // Append 3 more records (6..8) while observer is down
    const lines6to8 = [
      JSON.stringify({ seq: 6, text: "Record 6" }),
      JSON.stringify({ seq: 7, text: "Record 7" }),
      JSON.stringify({ seq: 8, text: "Record 8" }),
    ];
    fs.appendFileSync(transcriptPath, `${lines6to8.join("\n")}\n`);

    // 3. Restart new Tailer with the SAME cursorManager / database
    const tailer2 = new TranscriptTailer({
      cursorManager,
      defaultBatchSize: 10,
    });

    const receivedPass2: RawHarnessRecord[] = [];
    let p2Resolve: () => void;
    const p2 = new Promise<void>((resolve) => {
      p2Resolve = resolve;
    });

    tailer2.onRecords(async (_sess, records, ack) => {
      receivedPass2.push(...records);
      await ack();
      p2Resolve();
    });

    await tailer2.attachSession(session, undefined, { pollingIntervalMs: 10 });
    await p2;

    // Pass 2 must receive records 4, 5, 6, 7, 8 (no duplicate records 1, 2, 3!)
    expect(receivedPass2).toHaveLength(5);
    // SAFETY: Test record rawPayload carries seq number.
    const seqs = receivedPass2.map((r) => (r.rawPayload as { seq: number }).seq);
    expect(seqs).toEqual([4, 5, 6, 7, 8]);

    // Checkpoint must now be sequence 8
    const checkpointAfter = await cursorManager.getCursor(session.sessionId);
    expect(checkpointAfter?.sequence).toBe(8);

    await tailer2.close();
    store.close();
  });

  it("persists cursor across complete process component recreation with disk-backed state.db", async () => {
    const stateDbPath = path.join(tmpDir, "state.db");

    const session: HarnessSession = {
      sessionId: "session-disk-restart-1",
      workspaceId: "ws-disk-restart",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    // Write initial 5 lines
    const lines1to5 = [
      JSON.stringify({ seq: 1, text: "Disk Record 1" }),
      JSON.stringify({ seq: 2, text: "Disk Record 2" }),
      JSON.stringify({ seq: 3, text: "Disk Record 3" }),
      JSON.stringify({ seq: 4, text: "Disk Record 4" }),
      JSON.stringify({ seq: 5, text: "Disk Record 5" }),
    ];
    fs.writeFileSync(transcriptPath, `${lines1to5.join("\n")}\n`);

    // Phase 1: Initialize first persistent store, cursor manager, and tailer
    const store1 = createLocalStateStore({ path: stateDbPath });
    await store1.initialize();
    const cursorManager1 = new SourceCursorManager({ store: store1 });

    let tailer1: TranscriptTailer | undefined = new TranscriptTailer({
      cursorManager: cursorManager1,
      defaultBatchSize: 3, // Batch size 3 so first batch reads records 1..3
    });

    const receivedPass1: RawHarnessRecord[] = [];
    let p1Resolve: () => void;
    const p1 = new Promise<void>((resolve) => {
      p1Resolve = resolve;
    });

    tailer1.onRecords(async (_session, records, ack) => {
      receivedPass1.push(...records);
      await ack();
      p1Resolve();
    });

    await tailer1.attachSession(session, undefined, { pollingIntervalMs: 10 });
    await p1;

    expect(receivedPass1).toHaveLength(3);
    // SAFETY: Test record rawPayload carries seq number.
    expect((receivedPass1[0].rawPayload as { seq: number }).seq).toBe(1);
    // SAFETY: Test record rawPayload carries seq number.
    expect((receivedPass1[2].rawPayload as { seq: number }).seq).toBe(3);

    // Verify checkpoint in SQLite DB is at sequence 3
    const checkpointPass1 = await cursorManager1.getCursor(session.sessionId);
    expect(checkpointPass1).not.toBeNull();
    expect(checkpointPass1?.sequence).toBe(3);

    // Phase 2: Orderly shutdown of first process components
    await tailer1.close();
    tailer1 = undefined;
    store1.close();

    // Append 3 more records (6..8) while observer is down
    const lines6to8 = [
      JSON.stringify({ seq: 6, text: "Disk Record 6" }),
      JSON.stringify({ seq: 7, text: "Disk Record 7" }),
      JSON.stringify({ seq: 8, text: "Disk Record 8" }),
    ];
    fs.appendFileSync(transcriptPath, `${lines6to8.join("\n")}\n`);

    // Phase 3: Completely recreate fresh store, cursor manager, and tailer against SAME state.db
    const store2 = createLocalStateStore({ path: stateDbPath });
    await store2.initialize();
    const cursorManager2 = new SourceCursorManager({ store: store2 });

    // Verify cursor persisted on disk survives complete recreation before tailer starts
    const recoveredCursor = await cursorManager2.getCursor(session.sessionId);
    expect(recoveredCursor).not.toBeNull();
    expect(recoveredCursor?.sequence).toBe(3);

    const tailer2 = new TranscriptTailer({
      cursorManager: cursorManager2,
      defaultBatchSize: 10,
    });

    const receivedPass2: RawHarnessRecord[] = [];
    let p2Resolve: () => void;
    const p2 = new Promise<void>((resolve) => {
      p2Resolve = resolve;
    });

    tailer2.onRecords(async (_session, records, ack) => {
      receivedPass2.push(...records);
      await ack();
      p2Resolve();
    });

    await tailer2.attachSession(session, undefined, { pollingIntervalMs: 10 });
    await p2;

    // Second tailer must resume from sequence 3 and receive records 4..8 without replaying 1..3
    expect(receivedPass2).toHaveLength(5);
    // SAFETY: Test record rawPayload carries seq number.
    const seqs = receivedPass2.map((r) => (r.rawPayload as { seq: number }).seq);
    expect(seqs).toEqual([4, 5, 6, 7, 8]);

    // Final checkpoint on disk must now be sequence 8
    const finalCheckpoint = await cursorManager2.getCursor(session.sessionId);
    expect(finalCheckpoint?.sequence).toBe(8);

    await tailer2.close();
    store2.close();
  });
  it("deduplicates overlapping records from FakeSessionEventSource on reconnect", async () => {
    const deduplicator = new RecordDeduplicator();
    const fakeSource = new FakeSessionEventSource("sess-1");

    const recordA = fakeSource.appendRecord({ data: "A" });
    const recordB = fakeSource.appendRecord({ data: "B" });
    const recordC = fakeSource.appendRecord({ data: "C" });

    // Initial batch [A, B]
    const filtered1 = deduplicator.filterNew([recordA, recordB]);
    expect(filtered1).toHaveLength(2);

    // Overlapping batch on reconnect [A, B, C]
    const filtered2 = deduplicator.filterNew([recordA, recordB, recordC]);
    expect(filtered2).toHaveLength(1);
    expect(filtered2[0].recordId).toBe(recordC.recordId);
    const stats = deduplicator.getStats();
    expect(stats.seenCount).toBe(5);
    expect(stats.duplicateCount).toBe(2);
  });
});
