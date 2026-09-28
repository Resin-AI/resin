import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { OmpRecordDecoder } from "../src/decoder.js";
import { OmpSessionEventSource, getOmpProgramObservation } from "../src/source.js";

function nativePythonResultPayload(
  callId: string,
  output: string | undefined,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "eval",
      isError: false,
      details: {
        cells: [{ language: "python", status: "complete", exitCode: 0, output }],
        ...(meta === undefined ? {} : { meta }),
      },
    },
  };
}

function nativeJavaScriptResultPayload(
  callId: string,
  output: string | undefined,
  options: { isError?: boolean; cellCount?: number; status?: string } = {},
): Record<string, unknown> {
  const isError = options.isError ?? false;
  const cells = Array.from({ length: options.cellCount ?? 1 }, (_, index) => ({
    index,
    language: "js",
    status: options.status ?? "complete",
    exitCode: isError ? 1 : 0,
    output,
  }));
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "eval",
      isError,
      details: { cells },
    },
  };
}

function sourceTestSession(transcriptPath: string, sessionId: string): HarnessSession {
  const timestamp = "2026-09-22T00:00:00.000Z";
  return {
    sessionId,
    workspaceId: "ws-source-tests",
    harnessId: "omp",
    transcriptPath,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

describe("a subagent transcript forked from its parent", () => {
  const entry = (id: string, parentId: string | null, timestamp: string, message: unknown) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message,
  });
  const call = (callId: string, name: string, args: Record<string, unknown>) => ({
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name, arguments: args }],
  });
  const result = (callId: string, name: string, text: string) => ({
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    isError: false,
    content: [{ type: "text", text }],
  });
  // The parent's history, as OMP writes it and as it copies it verbatim into a forked file.
  const inherited = [
    {
      type: "thinking_level_change",
      id: "e1",
      parentId: null,
      timestamp: "2026-09-26T10:00:00.100Z",
      thinkingLevel: "high",
    },
    entry("e2", "e1", "2026-09-26T10:00:01.000Z", { role: "user", content: "survey the repo" }),
    entry(
      "e3",
      "e2",
      "2026-09-26T10:00:02.000Z",
      call("call_parent|fc_1", "read", { path: "a.ts" }),
    ),
    entry("e4", "e3", "2026-09-26T10:00:03.000Z", result("call_parent|fc_1", "read", "a")),
    entry("e5", "e4", "2026-09-26T10:00:04.000Z", call("call_task|fc_2", "task", { tasks: [] })),
  ];
  const parent = [
    {
      type: "session",
      version: 3,
      id: "parent-session",
      timestamp: "2026-09-26T10:00:00.000Z",
      cwd: "/repo",
      title: "parent",
    },
    ...inherited,
    entry("e9", "e5", "2026-09-26T10:05:00.000Z", result("call_task|fc_2", "task", "done")),
  ];
  const child = [
    {
      type: "session",
      version: 3,
      id: "child-session",
      timestamp: "2026-09-26T10:00:05.000Z",
      cwd: "/repo",
      parentSession: "parent-session",
      title: "child",
    },
    ...inherited,
    entry("c1", "e5", "2026-09-26T10:00:06.000Z", { role: "user", content: "subtask" }),
    entry(
      "c2",
      "c1",
      "2026-09-26T10:00:07.000Z",
      call("call_child|fc_3", "bash", { command: "ls" }),
    ),
    entry("c3", "c2", "2026-09-26T10:00:08.000Z", result("call_child|fc_3", "bash", "a.ts")),
  ];

  async function callIds(
    transcriptPath: string,
    sessionId: string,
    batchSize: number,
  ): Promise<string[]> {
    const decoder = new OmpRecordDecoder();
    const ids: string[] = [];
    let cursor: RawHarnessRecord["cursor"] | undefined;
    for (;;) {
      // A fresh source per batch resumes from the saved cursor, as a restarted tailer does.
      const source = new OmpSessionEventSource(
        sourceTestSession(transcriptPath, sessionId),
        cursor,
      );
      const records = await source.readNext(batchSize);
      cursor = source.getCursor();
      await source.close();
      if (records.length === 0 && cursor.offset === (await fsp.stat(transcriptPath)).size) break;
      for (const record of records) {
        const decoded = decoder.decode(record);
        for (const event of [decoded ?? []].flat()) {
          if (event.type === "tool_call" && event.callId !== undefined) ids.push(event.callId);
        }
      }
    }
    return ids;
  }

  it("records each call once, in the session that executed it", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-test-"));
    try {
      const parentPath = path.join(tmpDir, "parent.jsonl");
      const childPath = path.join(tmpDir, "parent", "child.jsonl");
      await fsp.mkdir(path.dirname(childPath));
      const jsonl = (lines: unknown[]) =>
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
      await fsp.writeFile(parentPath, jsonl(parent));
      await fsp.writeFile(childPath, jsonl(child));

      const parentIds = await callIds(parentPath, "parent-session", 50);
      const childIds = await callIds(childPath, "child-session", 2);
      expect(parentIds.some((id) => id.includes("call_parent"))).toBe(true);
      expect(parentIds.some((id) => id.includes("call_task"))).toBe(true);
      expect(childIds.some((id) => id.includes("call_child"))).toBe(true);
      expect(childIds.filter((id) => parentIds.includes(id))).toEqual([]);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

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

  it("decodes an appended custom session exit once while draining subsequent buffered records", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-exit-"));
    let source: OmpSessionEventSource | undefined;
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const timestamp = "2026-09-19T16:21:41.724Z";
      await fsp.writeFile(transcriptPath, "");
      source = new OmpSessionEventSource({
        sessionId: "session-custom-exit",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      });
      expect(await source.readBatch()).toEqual([]);

      await fsp.appendFile(
        transcriptPath,
        `${[
          JSON.stringify({
            type: "custom",
            customType: "session_exit",
            data: { reason: "dispose", kind: "normal", recordedAt: timestamp },
            id: "exit-record",
            parentId: "previous-transcript-record",
            timestamp,
          }),
          JSON.stringify({
            type: "message",
            role: "assistant",
            content: "Buffered final message",
            timestamp,
          }),
        ].join("\n")}\n`,
      );
      const decoder = new OmpRecordDecoder();
      const terminalBatch = await source.readBatch(1);
      expect(terminalBatch.flatMap((record) => decoder.decode(record) ?? [])).toMatchObject([
        { type: "session_lifecycle", lifecycleType: "end", sessionId: "session-custom-exit" },
      ]);
      const remainingBatch = await source.readBatch(1);
      expect(remainingBatch.flatMap((record) => decoder.decode(record) ?? [])).toMatchObject([
        { type: "message", content: "Buffered final message", sessionId: "session-custom-exit" },
      ]);
      expect(await source.readBatch()).toEqual([]);
    } finally {
      await source?.close();
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

  it("reads a large backlog in bounded chunks and walks it with exact byte offsets", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-bounded-"));
    const probe = await fsp.open(__filename, "r");
    const handleProto = Object.getPrototypeOf(probe) as { read: (...args: never[]) => unknown };
    await probe.close();
    const readSpy = vi.spyOn(handleProto, "read");
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const lines = Array.from({ length: 4000 }, (_, i) =>
        JSON.stringify({
          type: "message",
          role: "user",
          content: `é line ${i} ${"x".repeat(1000)}`,
        }),
      );
      // One line longer than any read window, so the window must widen to fit it.
      lines.splice(2000, 0, JSON.stringify({ type: "message", content: "y".repeat(600_000) }));
      const content = `${lines.join("\n")}\n`;
      await fsp.writeFile(transcriptPath, content);
      const fileBytes = Buffer.byteLength(content);

      const session: HarnessSession = {
        sessionId: "session-bounded",
        workspaceId: "ws-1",
        harnessId: "omp",
        transcriptPath,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };
      const source = new OmpSessionEventSource(session);
      const bytesRequested = () =>
        readSpy.mock.calls.reduce((sum, call) => sum + Number(call[2] ?? 0), 0);

      const first = await source.readNext(2);
      expect(first.map((r) => r.rawPayload)).toEqual(lines.slice(0, 2));
      expect(bytesRequested()).toBeLessThan(fileBytes / 10);

      const payloads = first.map((r) => r.rawPayload);
      let last = first[first.length - 1];
      for (;;) {
        const batch = await source.readNext(50);
        if (batch.length === 0) break;
        payloads.push(...batch.map((r) => r.rawPayload));
        last = batch[batch.length - 1];
      }
      expect(payloads).toEqual(lines);
      expect(last?.cursor.offset).toBe(fileBytes);
      expect(last?.cursor.line).toBe(lines.length);
      // Walking the whole file must cost about one pass, not one pass per batch.
      expect(bytesRequested()).toBeLessThan(fileBytes * 3);

      await source.close();
    } finally {
      readSpy.mockRestore();
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

  it("recovers authoritative native Python output while preserving raw record identity", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-python-artifact-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const artifactRoot = path.join(tmpDir, "session");
      const fullOutput = "authoritative fixture output\n";
      await fsp.mkdir(artifactRoot);
      await fsp.writeFile(path.join(artifactRoot, "9517.eval.log"), fullOutput, "utf8");
      const payload = nativePythonResultPayload("call-native|full", "clipped fixture", {
        limits: { columnTruncated: { artifactId: "9517" } },
      });
      const line = JSON.stringify(payload);
      await fsp.writeFile(transcriptPath, `${line}\n`, "utf8");

      const source = new OmpSessionEventSource(
        sourceTestSession(transcriptPath, "source-artifact"),
      );
      const initialCursor = source.getCursor();
      const records = await source.readNext();
      const record = records[0]!;
      await source.checkpoint(initialCursor);
      const replayed = await source.readNext();
      await source.close();

      expect(records).toHaveLength(1);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).not.toBe(record);
      expect(record.rawPayload).toBe(line);
      expect(record.metadata).not.toHaveProperty("result");
      expect(getOmpProgramObservation(record)).toEqual({
        callId: "call-native_full",
        result: fullOutput,
      });
      expect(getOmpProgramObservation(replayed[0]!)).toEqual({
        callId: "call-native_full",
        result: fullOutput,
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers the full output OMP 18.x spilled for a byte-truncated Eval", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-byte-truncation-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const artifactRoot = path.join(tmpDir, "session");
      const fullOutput = "Duplicates: [ 'wins', 'find' ]\nUnique count: 268\n";
      await fsp.mkdir(artifactRoot);
      await fsp.writeFile(path.join(artifactRoot, "32.eval.log"), fullOutput, "utf8");
      // The shape OMP 18.x records when its output sink spills a cell's stream.
      const payload = nativePythonResultPayload("call-byte-truncated", "Duplicates: [ 'wins'", {
        truncation: {
          direction: "tail",
          truncatedBy: "bytes",
          totalLines: 2,
          totalBytes: 49,
          outputLines: 1,
          outputBytes: 20,
          shownRange: { start: 1, end: 1 },
          artifactId: "32",
        },
      });
      await fsp.writeFile(transcriptPath, `${JSON.stringify(payload)}\n`, "utf8");

      const source = new OmpSessionEventSource(sourceTestSession(transcriptPath, "byte-trunc"));
      const records = await source.readNext();
      await source.close();

      expect(getOmpProgramObservation(records[0]!)).toEqual({
        callId: "call-byte-truncated",
        result: fullOutput,
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("retains an untruncated native Python cell as an explicit text-trim observation", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-python-short-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const output = "short fixture output  \n\n";
      const payload = nativePythonResultPayload("call-native-short", output);
      await fsp.writeFile(transcriptPath, `${JSON.stringify(payload)}\n`, "utf8");

      const source = new OmpSessionEventSource(sourceTestSession(transcriptPath, "source-short"));
      const records = await source.readNext();
      await source.close();

      expect(records).toHaveLength(1);
      expect(getOmpProgramObservation(records[0]!)).toEqual({
        callId: "call-native-short",
        result: output,
        comparison: "text-trim",
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("retains exact output only for a successful single-cell native JavaScript Eval", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-javascript-eval-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const output = "line\nvalue";
      const payloads = [
        nativeJavaScriptResultPayload("call-native-js", output),
        nativeJavaScriptResultPayload("call-native-js-multi", "ignored", { cellCount: 2 }),
        nativeJavaScriptResultPayload("call-native-js-error", "ignored", { isError: true }),
        nativeJavaScriptResultPayload("call-native-js-partial", "ignored", { status: "failed" }),
      ];
      await fsp.writeFile(
        transcriptPath,
        `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`,
        "utf8",
      );

      const source = new OmpSessionEventSource(sourceTestSession(transcriptPath, "source-js-eval"));
      const records = await source.readNext();
      await source.close();

      expect(records).toHaveLength(4);
      expect(records.map((record) => getOmpProgramObservation(record))).toEqual([
        { callId: "call-native-js", result: output },
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, hostile, and linked native Python artifact evidence", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-source-python-hostile-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      const artifactRoot = path.join(tmpDir, "session");
      const outsidePath = path.join(tmpDir, "outside.eval.log");
      await fsp.mkdir(artifactRoot);
      await fsp.writeFile(outsidePath, "outside fixture output\n", "utf8");
      await fsp.writeFile(path.join(artifactRoot, "3.eval.log"), "one stream\n", "utf8");
      await fsp.writeFile(path.join(artifactRoot, "4.eval.log"), "another stream\n", "utf8");
      try {
        await fsp.symlink(outsidePath, path.join(artifactRoot, "1.eval.log"));
      } catch {
        // A missing file exercises the same fail-closed branch on platforms without symlinks.
      }
      const payloads = [
        nativePythonResultPayload("call-invalid-ref", "clipped fixture", {
          limits: { columnTruncated: { artifactId: "../outside" } },
        }),
        nativePythonResultPayload("call-linked", "clipped fixture", {
          limits: { columnTruncated: { artifactId: "1" } },
        }),
        nativePythonResultPayload("call-missing", "clipped fixture", {
          limits: { columnTruncated: { artifactId: "2" } },
        }),
        nativePythonResultPayload("call-unreferenced-trunc", "clipped fixture", {
          truncation: { direction: "tail", truncatedBy: "bytes" },
        }),
        nativePythonResultPayload("call-conflicting-trunc", "clipped fixture", {
          truncation: { artifactId: "3" },
          limits: { columnTruncated: { artifactId: "4" } },
        }),
      ];
      await fsp.writeFile(
        transcriptPath,
        `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`,
        "utf8",
      );

      const source = new OmpSessionEventSource(sourceTestSession(transcriptPath, "source-hostile"));
      const records = await source.readNext();
      await source.close();

      expect(records).toHaveLength(5);
      expect(records.map((record) => getOmpProgramObservation(record))).toEqual([
        { callId: "call-invalid-ref", unavailable: true },
        { callId: "call-linked", unavailable: true },
        { callId: "call-missing", unavailable: true },
        { callId: "call-unreferenced-trunc", unavailable: true },
        { callId: "call-conflicting-trunc", unavailable: true },
      ]);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
