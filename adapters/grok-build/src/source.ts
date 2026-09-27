import * as fs from "node:fs/promises";
import type {
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { GROK_HARNESS_ID } from "./paths.js";

export interface GrokSessionEventSourceOptions {
  /** The session's `updates.jsonl`. */
  filePath: string;
  sessionId: string;
  /** Resume position; wins over `startOffset` when ahead of it. */
  initialCursor?: Partial<SourceCursor>;
  /** First byte to read (a fork's inherited prefix is skipped; see `computeGrokForkPrefixOffset`). */
  startOffset?: number;
  /** Parent session a fork branched from; emitted once as a synthetic fork record. */
  forkParentSessionId?: string;
  pollIntervalMs?: number;
}

const READ_CHUNK_BYTES = 256 * 1024;

/** Payload of the synthetic record that opens a fork's captured stream. */
export interface GrokForkRecordPayload {
  readonly method: "resin/grok-fork";
  readonly params: { readonly sessionId: string; readonly parentSessionId: string };
}

function recordTypeFor(payload: Record<string, unknown>): RecordType {
  const update = (payload.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
  switch (update?.sessionUpdate) {
    case "user_message_chunk":
      return "prompt";
    case "agent_message_chunk":
      return "completion";
    case "tool_call":
      return "tool_call";
    case "tool_call_update":
      return "tool_result";
    default:
      return "custom";
  }
}

/** Tails a Grok session's append-only `updates.jsonl`, one record per complete line. */
export class GrokSessionEventSource implements SessionEventSource {
  private readonly filePath: string;
  private readonly sessionId: string;
  private readonly pollIntervalMs: number;
  private readonly startOffset: number;
  private cursor: SourceCursor;
  private pendingFork: string | undefined;
  private subscribers = new Set<RecordListener>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GrokSessionEventSourceOptions) {
    this.filePath = options.filePath;
    this.sessionId = options.sessionId;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.startOffset = options.startOffset ?? 0;
    const resumeOffset = options.initialCursor?.offset ?? 0;
    this.cursor = {
      offset: Math.max(resumeOffset, this.startOffset),
      line: options.initialCursor?.line ?? 1,
      sequence: options.initialCursor?.sequence ?? 0,
      timestamp: options.initialCursor?.timestamp ?? new Date(0).toISOString(),
    };
    // The fork marker belongs before the fork's first own line; a resumed cursor already passed it.
    this.pendingFork = resumeOffset <= this.startOffset ? options.forkParentSessionId : undefined;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private makeRecord(
    rawPayload: unknown,
    recordType: RecordType,
    timestamp: string,
  ): RawHarnessRecord {
    this.cursor.sequence++;
    this.cursor.timestamp = timestamp;
    return {
      recordId: `${this.sessionId}:${this.cursor.offset}:${this.cursor.sequence}`,
      sessionId: this.sessionId,
      harnessId: GROK_HARNESS_ID,
      sequenceNumber: this.cursor.sequence,
      timestamp,
      recordType,
      rawPayload,
      cursor: { ...this.cursor },
      metadata: { filePath: this.filePath, line: this.cursor.line },
    };
  }

  readNext(batchSize = 200): Promise<RawHarnessRecord[]> {
    if (this.closed || batchSize <= 0) return Promise.resolve([]);
    return this.serial(() => this.readBatch(batchSize));
  }

  private async readBatch(batchSize: number): Promise<RawHarnessRecord[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, "r");
    } catch {
      return [];
    }
    const records: RawHarnessRecord[] = [];
    try {
      const size = (await handle.stat()).size;
      if (size < this.cursor.offset) return [];
      if (this.pendingFork) {
        const payload: GrokForkRecordPayload = {
          method: "resin/grok-fork",
          params: { sessionId: this.sessionId, parentSessionId: this.pendingFork },
        };
        this.pendingFork = undefined;
        records.push(this.makeRecord(payload, "custom", this.cursor.timestamp));
      }
      let pending = Buffer.alloc(0);
      let readOffset = this.cursor.offset;
      while (records.length < batchSize && readOffset < size) {
        const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - readOffset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
        if (bytesRead === 0) break;
        readOffset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0 && records.length < batchSize) {
          const text = pending.subarray(0, newline).toString("utf8").trim();
          pending = pending.subarray(newline + 1);
          this.cursor.offset += newline + 1;
          this.cursor.line++;
          newline = pending.indexOf(0x0a);
          if (!text) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          const payload = parsed as Record<string, unknown>;
          // Grok stamps each line with unix seconds.
          const seconds = typeof payload.timestamp === "number" ? payload.timestamp : undefined;
          const timestamp =
            seconds !== undefined ? new Date(seconds * 1000).toISOString() : this.cursor.timestamp;
          records.push(this.makeRecord(payload, recordTypeFor(payload), timestamp));
        }
      }
      return records;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  onRecords(callback: RecordListener): () => void {
    if (this.closed) return () => {};
    this.subscribers.add(callback);
    this.pollTimer ??= setInterval(() => void this.poll(), this.pollIntervalMs);
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const records = await this.readNext();
      if (records.length === 0) return;
      for (const listener of this.subscribers) {
        try {
          await listener(records);
        } catch {
          // A failing subscriber must not stop the others.
        }
      }
    } finally {
      this.polling = false;
    }
  }

  checkpoint(cursor: SourceCursor): Promise<void> {
    return this.serial(async () => {
      if (cursor.offset > this.cursor.offset) {
        this.cursor = { ...cursor };
        this.pendingFork = undefined;
      }
    });
  }

  getCursor(): SourceCursor | null {
    return { ...this.cursor };
  }

  async detectRotation(): Promise<boolean> {
    try {
      return (await fs.stat(this.filePath)).size < this.cursor.offset;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.subscribers.clear();
    await this.queue;
  }
}
