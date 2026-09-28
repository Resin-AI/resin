import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessSession } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionEventSource } from "../src/source.js";

const io = vi.hoisted(() => ({ bytesRead: 0 }));

// Counts every byte the source pulls from disk, through handles or whole-file reads.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      io.bytesRead += result.bytesRead;
      return result;
    }) as typeof handle.read;
    return handle;
  }) as typeof actual.open;
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    io.bytesRead += Buffer.byteLength(content);
    return content;
  }) as typeof actual.readFile;
  const mocked = { ...actual, open, readFile };
  return { ...mocked, default: mocked };
});

const LINE_COUNT = 4000;
let dir: string;
let transcriptPath: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-bounded-read-"));
  transcriptPath = path.join(dir, "transcript.jsonl");
  lines = Array.from({ length: LINE_COUNT }, (_, index) =>
    JSON.stringify({ type: "custom", index, pad: "x".repeat(1000) }),
  );
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
  io.bytesRead = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(): HarnessSession {
  return {
    sessionId: "bounded",
    workspaceId: "ws",
    harnessId: "pi",
    transcriptPath,
    status: "idle",
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    metadata: {},
  };
}

/** Byte offset just past line `count` (1-based). */
function offsetAfter(count: number): number {
  return lines.slice(0, count).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

describe("bounded transcript reads", () => {
  it("reads only a bounded window per batch while walking a large file with exact offsets", async () => {
    const fileSize = fs.statSync(transcriptPath).size;
    const source = new PiSessionEventSource(session());
    for (let batch = 0; batch < 3; batch++) {
      io.bytesRead = 0;
      const records = await source.readNext(2);
      expect(records.map((record) => (record.rawPayload as { index: number }).index)).toEqual([
        batch * 2,
        batch * 2 + 1,
      ]);
      expect(records.map((record) => record.cursor.offset)).toEqual([
        offsetAfter(batch * 2 + 1),
        offsetAfter(batch * 2 + 2),
      ]);
      expect(io.bytesRead).toBeGreaterThan(0);
      expect(io.bytesRead).toBeLessThan(fileSize / 20);
    }
    await source.close();
  });

  it("keeps replay state when the committed checkpoint is the position already reached", async () => {
    const fileSize = fs.statSync(transcriptPath).size;
    const source = new PiSessionEventSource(session());
    for (let batch = 0; batch < 3; batch++) {
      io.bytesRead = 0;
      const records = await source.readNext(2);
      expect(records.map((record) => record.metadata?.lineNumber)).toEqual([
        batch * 2 + 1,
        batch * 2 + 2,
      ]);
      await source.checkpoint(source.getCursor());
      expect(io.bytesRead).toBeLessThan(fileSize / 20);
    }
    await source.close();
  });
});
