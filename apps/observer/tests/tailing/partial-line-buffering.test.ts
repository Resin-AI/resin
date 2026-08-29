import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptWatcher } from "../../src/tailing/index.js";

describe("Partial Line Buffering and JSONL Framing", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-partial-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("buffers partial incomplete line until closing newline arrives", async () => {
    const watcher = new TranscriptWatcher({
      filePath: transcriptPath,
      pollingIntervalMs: 50,
      coalesceDebounceMs: 5,
    });

    // 1. Write incomplete line (no trailing newline)
    fs.writeFileSync(transcriptPath, `{"type":"prompt","text":"Incomplete`);

    const read1 = await watcher.readNext();
    // Must return 0 records because newline has not arrived
    expect(read1).toHaveLength(0);

    // 2. Append the rest of the line with closing newline
    fs.appendFileSync(transcriptPath, ` message here"}\n`);

    const read2 = await watcher.readNext();
    expect(read2).toHaveLength(1);
    expect(read2[0].parsedJson).toEqual({
      type: "prompt",
      text: "Incomplete message here",
    });
    expect(read2[0].cursor.line).toBe(1);
    expect(read2[0].cursor.sequence).toBe(1);

    watcher.stop();
  });

  it("handles multiple fragmented chunks across writes and multi-byte UTF-8", async () => {
    const watcher = new TranscriptWatcher({
      filePath: transcriptPath,
      pollingIntervalMs: 50,
      coalesceDebounceMs: 5,
    });

    // Chunk 1: half of line 1
    fs.writeFileSync(transcriptPath, `{"tool":"search","query":"🚀 `);
    const read1 = await watcher.readNext();
    expect(read1).toHaveLength(0);

    // Chunk 2: second half of line 1 + first half of line 2
    fs.appendFileSync(transcriptPath, `rocket"}\n{"tool":"echo","data":"`);
    const read2 = await watcher.readNext();
    // Line 1 is completed, Line 2 is still partial
    expect(read2).toHaveLength(1);
    expect(read2[0].parsedJson).toEqual({
      tool: "search",
      query: "🚀 rocket",
    });
    expect(read2[0].cursor.line).toBe(1);

    // Chunk 3: second half of line 2 + line 3 and line 4 complete
    fs.appendFileSync(transcriptPath, `hello world"}\r\n{"line":3}\n{"line":4}\n`);
    const read3 = await watcher.readNext();
    expect(read3).toHaveLength(3);
    expect(read3[0].parsedJson).toEqual({ tool: "echo", data: "hello world" });
    expect(read3[0].cursor.line).toBe(2);
    expect(read3[1].parsedJson).toEqual({ line: 3 });
    expect(read3[1].cursor.line).toBe(3);
    expect(read3[2].parsedJson).toEqual({ line: 4 });
    expect(read3[2].cursor.line).toBe(4);

    watcher.stop();
  });
});
