import { describe, expect, it } from "vitest";
import type { RawHarnessRecord, SourceCursor } from "../src/types.js";
import { FakeSessionEventSource } from "./fake.js";

describe("FakeSessionEventSource & SessionEventSource Contract", () => {
  it("reads records sequentially in batches and advances cursor", async () => {
    const source = new FakeSessionEventSource("sess-100");

    // Initially empty
    expect(await source.readNext()).toEqual([]);
    expect(source.getCursor()).toBeNull();

    // Append 5 records
    source.appendRecord({ text: "Hello" }, "prompt");
    source.appendRecord({ tool: "bash", args: ["ls"] }, "tool_call");
    source.appendRecord({ exitCode: 0, output: "file.ts" }, "tool_result");
    source.appendRecord({ text: "I see file.ts" }, "completion");
    source.appendRecord({ text: "Done" }, "transcript_line");

    // Read batch of 2
    const batch1 = await source.readNext(2);
    expect(batch1).toHaveLength(2);
    expect(batch1[0]?.recordType).toBe("prompt");
    expect(batch1[1]?.recordType).toBe("tool_call");

    const cursor1 = source.getCursor();
    expect(cursor1?.sequence).toBe(1);

    // Read batch of 2
    const batch2 = await source.readNext(2);
    expect(batch2).toHaveLength(2);
    expect(batch2[0]?.recordType).toBe("tool_result");
    expect(batch2[1]?.recordType).toBe("completion");

    // Read remaining
    const batch3 = await source.readNext(5);
    expect(batch3).toHaveLength(1);
    expect(batch3[0]?.recordType).toBe("transcript_line");

    // Subsequent reads return empty
    expect(await source.readNext()).toEqual([]);
  });

  it("supports checkpointing and resuming from a cursor", async () => {
    const source = new FakeSessionEventSource("sess-200");

    for (let i = 0; i < 10; i++) {
      source.appendRecord({ message: `Record ${i}` });
    }

    // Read first 3
    const initial = await source.readNext(3);
    expect(initial).toHaveLength(3);

    // Set checkpoint at sequence 6
    const checkpointCursor: SourceCursor = {
      offset: 6 * 128,
      line: 7,
      sequence: 6,
      timestamp: new Date().toISOString(),
    };

    await source.checkpoint(checkpointCursor);
    expect(source.getCursor()?.sequence).toBe(6);

    // Next read should resume after sequence 6 (record at index 7)
    const resumed = await source.readNext(2);
    expect(resumed).toHaveLength(2);
    expect(resumed[0]?.sequenceNumber).toBe(7);
    expect(resumed[1]?.sequenceNumber).toBe(8);
  });

  it("broadcasts newly appended records to listeners and supports unsubscribe", () => {
    const source = new FakeSessionEventSource("sess-300");
    const received: RawHarnessRecord[] = [];

    const unsubscribe = source.onRecords((records) => {
      received.push(...records);
    });

    source.appendRecord({ event: "start" });
    source.appendRecord({ event: "step" });

    expect(received).toHaveLength(2);
    const firstPayload = received[0]?.rawPayload;
    expect(firstPayload).toEqual({ event: "start" });

    // Unsubscribe
    unsubscribe();

    source.appendRecord({ event: "after_unsub" });
    expect(received).toHaveLength(2); // No new events added
  });

  it("detects log rotation and truncation", async () => {
    const source = new FakeSessionEventSource("sess-400");
    expect(await source.detectRotation()).toBe(false);

    source.appendRecord({ line: 1 });
    source.appendRecord({ line: 2 });

    // Simulate log rotation
    source.simulateRotation();
    expect(await source.detectRotation()).toBe(true);

    source.resetRotation();
    expect(await source.detectRotation()).toBe(false);

    // Simulate truncation
    source.simulateTruncation();
    expect(await source.detectRotation()).toBe(true);
    expect(source.getRecordCount()).toBe(0);
    expect(await source.readNext()).toEqual([]);
  });

  it("handles close() cleanly", async () => {
    const source = new FakeSessionEventSource("sess-500");
    source.appendRecord({ text: "active" });

    expect(source.isClosed()).toBe(false);
    await source.close();
    expect(source.isClosed()).toBe(true);

    // Reads on closed source return empty array
    expect(await source.readNext()).toEqual([]);
  });
});
