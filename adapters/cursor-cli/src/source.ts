import * as fsp from "node:fs/promises";
import type {
  HarnessSession,
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { parseSpoolLine } from "./hook-records.js";
import { CURSOR_HARNESS_ID } from "./paths.js";

const READ_CHUNK_BYTES = 64 * 1024;

const RECORD_TYPE_BY_EVENT: Record<string, RecordType> = {
  beforeSubmitPrompt: "prompt",
  afterAgentResponse: "completion",
  postToolUse: "tool_result",
  postToolUseFailure: "tool_result",
};

export interface CursorEventSourceOptions {
  pollIntervalMs?: number;
  maxBatchSize?: number;
}

/**
 * Tails one conversation's hook spool file (`<conversation_id>.jsonl`). The spool is
 * append-only, so the byte offset in the cursor resumes exactly after a daemon restart; a
 * trailing partial line is left for the next read.
 */
export class CursorSessionEventSource implements SessionEventSource {
  private cursor: SourceCursor;
  private readonly listeners = new Set<RecordListener>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastInode: number | null = null;
  private closed = false;
  private readonly pollIntervalMs: number;
  private readonly maxBatchSize: number;

  constructor(
    private readonly session: HarnessSession,
    initialCursor?: SourceCursor,
    options: CursorEventSourceOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxBatchSize = options.maxBatchSize ?? 200;
    this.cursor = initialCursor
      ? { ...initialCursor }
      : { offset: 0, line: 1, sequence: 0, timestamp: new Date().toISOString() };
  }

  getCursor(): SourceCursor {
    return { ...this.cursor };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
  }

  async readNext(batchSize?: number): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];
    const filePath = this.session.transcriptPath;
    let size: number;
    try {
      const stat = await fsp.stat(filePath);
      if (this.lastInode !== null && stat.ino !== this.lastInode) {
        this.cursor = { offset: 0, line: 1, sequence: 0, timestamp: this.cursor.timestamp };
      }
      this.lastInode = stat.ino;
      size = stat.size;
    } catch {
      return [];
    }
    if (size < this.cursor.offset) {
      this.cursor = { offset: 0, line: 1, sequence: 0, timestamp: this.cursor.timestamp };
    }
    if (size <= this.cursor.offset) return [];

    const limit = batchSize ?? this.maxBatchSize;
    const records: RawHarnessRecord[] = [];
    // Read bounded chunks from the cursor and stop once `limit` records are collected, so a
    // large spool is never loaded (or re-read) whole per call.
    const handle = await fsp.open(filePath, "r");
    try {
      let pending = Buffer.alloc(0);
      let position = this.cursor.offset;
      while (records.length < limit && position < size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending =
          pending.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

        let newline = pending.indexOf(0x0a);
        while (newline !== -1 && records.length < limit) {
          const line = pending.toString("utf8", 0, newline);
          pending = pending.subarray(newline + 1);
          this.cursor.offset += newline + 1;
          newline = pending.indexOf(0x0a);
          const lineNumber = this.cursor.line;
          this.cursor.line += 1;
          const payload = parseSpoolLine(line);
          if (payload === null) continue;
          this.cursor.sequence += 1;
          const receivedAt = payload.resin_received_at;
          const timestamp =
            typeof receivedAt === "string" && !Number.isNaN(Date.parse(receivedAt))
              ? receivedAt
              : new Date().toISOString();
          this.cursor.timestamp = timestamp;
          const event = payload.hook_event_name;
          records.push({
            recordId: `${this.session.sessionId}-rec-${this.cursor.sequence}`,
            sessionId: this.session.sessionId,
            harnessId: CURSOR_HARNESS_ID,
            sequenceNumber: this.cursor.sequence,
            timestamp,
            recordType: (typeof event === "string" && RECORD_TYPE_BY_EVENT[event]) || "custom",
            rawPayload: payload,
            cursor: { ...this.cursor },
            metadata: { transcriptPath: filePath, lineNumber, byteOffset: this.cursor.offset },
          });
        }
      }
    } finally {
      await handle.close();
    }
    return records;
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    if (this.pollTimer === null && !this.closed) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    }
    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  async detectRotation(): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.session.transcriptPath);
      return (
        (this.lastInode !== null && stat.ino !== this.lastInode) || stat.size < this.cursor.offset
      );
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private async poll(): Promise<void> {
    try {
      const records = await this.readNext();
      if (records.length === 0) return;
      for (const listener of [...this.listeners]) {
        try {
          await listener(records);
        } catch {
          // A failing listener must not stop the tail.
        }
      }
    } catch {
      // Transient read errors retry on the next tick.
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
