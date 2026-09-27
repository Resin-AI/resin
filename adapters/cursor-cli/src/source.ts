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

    const handle = await fsp.open(filePath, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - this.cursor.offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.cursor.offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    const limit = batchSize ?? this.maxBatchSize;
    const records: RawHarnessRecord[] = [];
    let start = 0;
    while (records.length < limit) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const line = chunk.toString("utf8", start, newline);
      this.cursor.offset += newline + 1 - start;
      start = newline + 1;
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
