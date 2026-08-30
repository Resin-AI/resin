import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptTailer } from "../../src/tailing/index.js";

describe("Historical Backfill Bounded Window Policy", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-backfill-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("reads full history when backfill policy is 'all'", async () => {
    // Populate 10 lines
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ index: i + 1, text: `Line ${i + 1}` }),
    );
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const tailer = new TranscriptTailer({ defaultBackfillPolicy: { mode: "all" } });

    const received: RawHarnessRecord[] = [];
    let resolveDone: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    tailer.onRecords(async (_sess, records, ack) => {
      received.push(...records);
      await ack();
      if (received.length >= 10) {
        resolveDone();
      }
    });

    const session: HarnessSession = {
      sessionId: "session-backfill-all",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    await tailer.attachSession(session, undefined, { pollingIntervalMs: 20 });
    await donePromise;

    expect(received).toHaveLength(10);
    // SAFETY: Test record rawPayload contains index number.
    expect((received[0].rawPayload as { index: number }).index).toBe(1);
    // SAFETY: Test record rawPayload contains index number.
    expect((received[9].rawPayload as { index: number }).index).toBe(10);

    await tailer.close();
  });

  it("skips existing lines and tails only new appends when backfill policy is 'latest'", async () => {
    // Populate initial 5 lines
    const initialLines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ index: i + 1, text: `Old Line ${i + 1}` }),
    );
    fs.writeFileSync(transcriptPath, `${initialLines.join("\n")}\n`);

    const tailer = new TranscriptTailer({ defaultBackfillPolicy: { mode: "latest" } });

    const received: RawHarnessRecord[] = [];
    let resolveDone: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    tailer.onRecords(async (_sess, records, ack) => {
      received.push(...records);
      await ack();
      if (received.length >= 2) {
        resolveDone();
      }
    });

    const session: HarnessSession = {
      sessionId: "session-backfill-latest",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    await tailer.attachSession(session, undefined, {
      backfillPolicy: { mode: "latest" },
      pollingIntervalMs: 20,
    });

    // Append 2 new lines
    const newLines = [
      JSON.stringify({ index: 6, text: "New Line 6" }),
      JSON.stringify({ index: 7, text: "New Line 7" }),
    ];
    fs.appendFileSync(transcriptPath, `${newLines.join("\n")}\n`);

    await donePromise;

    // Must only receive lines 6 and 7 (old lines 1..5 were skipped)
    expect(received).toHaveLength(2);
    // SAFETY: Test record rawPayload contains index number.
    expect((received[0].rawPayload as { index: number }).index).toBe(6);
    // SAFETY: Test record rawPayload contains index number.
    expect((received[1].rawPayload as { index: number }).index).toBe(7);

    await tailer.close();
  });

  it("bounds historical replay to bounded_lines window", async () => {
    // Populate 10 lines
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ index: i + 1, text: `Line ${i + 1}` }),
    );
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);

    const tailer = new TranscriptTailer();

    const received: RawHarnessRecord[] = [];
    let resolveDone: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    tailer.onRecords(async (_sess, records, ack) => {
      received.push(...records);
      await ack();
      if (received.length >= 3) {
        resolveDone();
      }
    });

    const session: HarnessSession = {
      sessionId: "session-backfill-lines",
      workspaceId: "ws-1",
      harnessId: "test-harness",
      transcriptPath,
      status: "active",
      startedAt: new Date().toISOString(),
    };

    // Bounded to last 3 lines
    await tailer.attachSession(session, undefined, {
      backfillPolicy: { mode: "bounded_lines", maxLines: 3 },
      pollingIntervalMs: 20,
    });

    await donePromise;

    // Must receive lines 8, 9, 10
    expect(received).toHaveLength(3);
    // SAFETY: Test record rawPayload contains index number.
    const indices = received.map((r) => (r.rawPayload as { index: number }).index);
    expect(indices).toEqual([8, 9, 10]);

    await tailer.close();
  });
});
