import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { OmpSessionEventSource } from "../src/source.js";

describe("OmpSessionEventSource (Transcript Tailing & Streaming)", () => {
  it("reads batches incrementally and advances cursor accurately", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-test-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");

      const line1 = JSON.stringify({
        type: "title",
        updatedAt: "2026-08-31T19:49:42.203Z",
      });
      const line2 = JSON.stringify({ type: "message", role: "user", content: "hi" });
      const line3 = JSON.stringify({ type: "message", role: "assistant", content: "hello" });

      await fsp.writeFile(transcriptPath, `${line1}\n${line2}\n${line3}\n`);

      const session: HarnessSession = {
        sessionId: "session-src-1",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      const source = new OmpSessionEventSource(session);

      // Read batch with limit 2
      const batch1 = await source.readBatch(2);
      expect(batch1.length).toBe(2);
      expect(batch1[0].recordType).toBe("transcript_line");
      expect(batch1[1].recordType).toBe("prompt");
      expect(batch1[0].timestamp).toBe("2026-08-31T19:49:42.203Z");

      const cursor1 = source.getCursor();
      expect(cursor1.line).toBe(3);
      expect(cursor1.sequence).toBe(2);
      expect(cursor1.offset).toBeGreaterThan(0);

      // Read remaining batch
      const batch2 = await source.readBatch(2);
      expect(batch2.length).toBe(1);
      expect(batch2[0].recordType).toBe("completion");

      const cursor2 = source.getCursor();
      expect(cursor2.line).toBe(4);
      expect(cursor2.sequence).toBe(3);

      // Read empty batch (at EOF)
      const batch3 = await source.readBatch();
      expect(batch3.length).toBe(0);

      await source.close();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles newly appended lines seamlessly", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-append-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      await fsp.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "message", role: "user", content: "1" })}\n`,
      );

      const session: HarnessSession = {
        sessionId: "session-src-2",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      const source = new OmpSessionEventSource(session);
      const batch1 = await source.readBatch();
      expect(batch1.length).toBe(1);

      // Append new line
      await fsp.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "message", role: "user", content: "2" })}\n`,
      );

      const batch2 = await source.readBatch();
      expect(batch2.length).toBe(1);
      expect(batch2[0].cursor.line).toBe(2);

      await source.close();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects file truncation / rotation and resets offset", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-trunc-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");

      const largeContent = `${Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: "message", content: `line-${i}` }),
      ).join("\n")}\n`;

      await fsp.writeFile(transcriptPath, largeContent);

      const session: HarnessSession = {
        sessionId: "session-src-3",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      const source = new OmpSessionEventSource(session);
      const batch1 = await source.readBatch(10);
      expect(batch1.length).toBe(10);

      // Truncate file to shorter content
      await fsp.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "message", content: "new-line" })}\n`,
      );

      const rotationDetected = await source.detectRotation();
      expect(rotationDetected).toBe(true);

      const batchAfterTrunc = await source.readBatch();
      expect(batchAfterTrunc.length).toBe(1);

      await source.close();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports listener subscription for streaming updates", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-sub-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      await fsp.writeFile(transcriptPath, "");

      const session: HarnessSession = {
        sessionId: "session-src-4",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      const source = new OmpSessionEventSource(session, undefined, { pollIntervalMs: 20 });

      const collected: RawHarnessRecord[] = [];
      const { promise: secondItemReceived, resolve } = Promise.withResolvers<void>();

      const unsubscribe = source.subscribe((records) => {
        collected.push(...records);
        if (collected.length >= 2) {
          resolve();
        }
      });

      // Append lines
      await fsp.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "message", content: "stream-1" })}\n`,
      );
      await fsp.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "message", content: "stream-2" })}\n`,
      );

      await secondItemReceived;

      unsubscribe();
      await source.close();

      expect(collected.length).toBeGreaterThanOrEqual(2);
      expect(collected[0].rawPayload).toContain("stream-1");
      expect(collected[1].rawPayload).toContain("stream-2");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies tool_execution_start and tool_execution_end records properly", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-tool-exec-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const content = `${[
        JSON.stringify({ type: "tool_execution_start", toolName: "read", callId: "c1" }),
        JSON.stringify({ type: "tool_execution_end", callId: "c1", result: "ok" }),
      ].join("\n")}\n`;

      await fsp.writeFile(transcriptPath, content);

      const session: HarnessSession = {
        sessionId: "session-tool-1",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      const source = new OmpSessionEventSource(session);
      const records = await source.readNext();
      await source.close();

      expect(records).toHaveLength(2);
      expect(records[0].recordType).toBe("tool_call");
      expect(records[1].recordType).toBe("tool_result");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
