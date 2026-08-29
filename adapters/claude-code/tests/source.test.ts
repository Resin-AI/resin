import {
  type HarnessSession,
  InMemoryConfigFsBridge,
  type RawHarnessRecord,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { ClaudeSessionEventSource } from "../src/source.js";

describe("Claude Code Session Event Source", () => {
  const mockSession: HarnessSession = {
    sessionId: "session-source-test",
    workspaceId: "ws-1",
    harnessId: "claude-code",
    transcriptPath: "/transcripts/session.jsonl",
    status: "active",
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
    metadata: {},
  };

  it("reads batches of records and updates cursor monotonically", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const lines = `${[
      JSON.stringify({ type: "session_start", harness: "claude-code" }),
      JSON.stringify({ type: "user", content: "Hello" }),
      JSON.stringify({ type: "assistant", content: "Hi there!" }),
    ].join("\n")}\n`;

    await fsBridge.writeFile(mockSession.transcriptPath, lines);

    const source = new ClaudeSessionEventSource(mockSession, undefined, {
      fsBridge,
    });

    const batch1 = await source.readNext(2);
    expect(batch1).toHaveLength(2);
    expect(batch1[0].sequenceNumber).toBe(1);
    expect(batch1[1].sequenceNumber).toBe(2);

    const cursor1 = source.getCursor();
    expect(cursor1).not.toBeNull();
    expect(cursor1?.sequence).toBe(2);
    expect(cursor1?.line).toBe(2);

    const batch2 = await source.readNext(2);
    expect(batch2).toHaveLength(1);
    expect(batch2[0].sequenceNumber).toBe(3);

    const cursor2 = source.getCursor();
    expect(cursor2?.sequence).toBe(3);
    expect(cursor2?.line).toBe(3);

    const batch3 = await source.readNext(2);
    expect(batch3).toHaveLength(0);

    await source.close();
  });

  it("resumes from checkpointed cursor correctly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const lines = `${[
      JSON.stringify({ type: "msg_1" }),
      JSON.stringify({ type: "msg_2" }),
      JSON.stringify({ type: "msg_3" }),
    ].join("\n")}\n`;

    await fsBridge.writeFile(mockSession.transcriptPath, lines);

    // Create initial source and read 1
    const source1 = new ClaudeSessionEventSource(mockSession, undefined, {
      fsBridge,
    });
    const first = await source1.readNext(1);
    expect(first).toHaveLength(1);
    const checkpointCursor = source1.getCursor();
    expect(checkpointCursor).not.toBeNull();
    if (!checkpointCursor) throw new Error("Expected checkpoint cursor");
    await source1.close();

    // Create second source resuming from checkpoint
    const source2 = new ClaudeSessionEventSource(mockSession, checkpointCursor, {
      fsBridge,
    });
    const remaining = await source2.readNext(10);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].sequenceNumber).toBe(2);
    expect(remaining[1].sequenceNumber).toBe(3);
    await source2.close();
  });

  it("detects file truncation / rotation", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const initialContent = "line 1\nline 2\nline 3\nline 4\n";
    await fsBridge.writeFile(mockSession.transcriptPath, initialContent);

    const source = new ClaudeSessionEventSource(mockSession, undefined, {
      fsBridge,
    });
    await source.readNext(10);

    expect(await source.detectRotation()).toBe(false);

    // Truncate file
    await fsBridge.writeFile(mockSession.transcriptPath, "line 1\n");
    expect(await source.detectRotation()).toBe(true);

    await source.close();
  });

  it("pushes live records to listeners on stream start", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(mockSession.transcriptPath, `${JSON.stringify({ type: "live_1" })}\n`);

    const source = new ClaudeSessionEventSource(mockSession, undefined, {
      fsBridge,
      pollingIntervalMs: 10,
    });

    const received: RawHarnessRecord[] = [];
    const { promise: gotSecondRecord, resolve } = Promise.withResolvers<void>();

    const unsubscribe = source.onRecord((rec) => {
      received.push(rec);
      if (received.length >= 2) {
        resolve();
      }
    });

    await source.start();

    const current = (await fsBridge.readFile(mockSession.transcriptPath)) ?? "";
    await fsBridge.writeFile(
      mockSession.transcriptPath,
      `${current}${JSON.stringify({ type: "live_2" })}\n`,
    );

    await gotSecondRecord;

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0].sequenceNumber).toBe(1);
    expect(received[1].sequenceNumber).toBe(2);

    unsubscribe();
    await source.close();
  });
});
