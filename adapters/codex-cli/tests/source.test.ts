import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexSessionEventSource } from "../src/source.js";

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
});
