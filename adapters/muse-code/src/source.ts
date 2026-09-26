import * as fs from "node:fs/promises";
import type {
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { MUSE_HARNESS_ID, expandMuseLogLine } from "./discovery.js";

/**
 * Options for creating a MuseSessionEventSource.
 */
export interface MuseSessionEventSourceOptions {
  filePath: string;
  sessionId: string;
  initialCursor?: Partial<SourceCursor>;
  pollIntervalMs?: number;
}

const READ_CHUNK_BYTES = 64 * 1024;
const READ_QUANTUM_BYTES = 1024 * 1024;
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * Muse stamps `recorded_at` in microseconds since the Unix epoch.
 */
export function museRecordTimestamp(record: Record<string, unknown>, fallback: string): string {
  const micros = record.recorded_at;
  if (typeof micros === "number" && Number.isFinite(micros) && micros > 0) {
    return new Date(Math.floor(micros / 1000)).toISOString();
  }
  return fallback;
}

/** Classifies a muse record by its `payload_type` for the raw record envelope. */
function museRecordType(record: Record<string, unknown>): RecordType {
  const payloadType = typeof record.payload_type === "string" ? record.payload_type : "";
  const payload = record.payload as Record<string, unknown> | undefined;
  const eventKind =
    payload && typeof payload.event === "object" && payload.event !== null
      ? (payload.event as Record<string, unknown>).kind
      : undefined;
  if (eventKind === "assistant_tool_calls_committed") return "tool_call";
  if (eventKind === "tool_result_batch_committed") return "tool_result";
  if (eventKind === "assistant_message_committed") return "completion";
  if (payloadType === "runtime.user_intent.accepted") return "prompt";
  return "custom";
}

/**
 * Event source that tails and reads from a Muse Code session event log (JSONL).
 */
export class MuseSessionEventSource implements SessionEventSource {
  private readonly filePath: string;
  private readonly sessionId: string;
  // Complete-line cursor is the read frontier; pending/discarded bytes hold read-ahead.
  private cursor: SourceCursor;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private subscribers = new Set<RecordListener>();
  private closed = false;
  private pendingBytes = Buffer.alloc(0);
  private pendingSearchOffset = 0;
  private droppingOversizedLine = false;
  private discardedLineBytes = 0;
  private fileIdentity: { device: number; inode: number } | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private hasReadActivity = false;
  private activePoll?: Promise<void>;

  constructor(options: MuseSessionEventSourceOptions) {
    this.filePath = options.filePath;
    this.sessionId = options.sessionId;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.cursor = {
      offset: options.initialCursor?.offset ?? 0,
      line: options.initialCursor?.line ?? 1,
      sequence: options.initialCursor?.sequence ?? 0,
      checkpoint: options.initialCursor?.checkpoint,
      timestamp: options.initialCursor?.timestamp ?? new Date().toISOString(),
    };
  }

  private enqueueOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Pulls the next batch of raw harness records from the current cursor position.
   */
  readNext(batchSize = 100): Promise<RawHarnessRecord[]> {
    if (this.closed || batchSize <= 0) return Promise.resolve([]);
    return this.enqueueOperation(() => this.readNextSerial(batchSize));
  }

  private async readNextSerial(batchSize: number): Promise<RawHarnessRecord[]> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.filePath, "r");
      const fileStat = await handle.stat();
      const identityChanged =
        this.fileIdentity !== null &&
        (this.fileIdentity.device !== fileStat.dev || this.fileIdentity.inode !== fileStat.ino);
      const unreadBytes = this.cursor.offset + this.pendingBytes.length + this.discardedLineBytes;
      if (identityChanged || fileStat.size < unreadBytes) {
        this.cursor.offset = 0;
        this.cursor.line = 1;
        this.pendingBytes = Buffer.alloc(0);
        this.pendingSearchOffset = 0;
        this.droppingOversizedLine = false;
        this.discardedLineBytes = 0;
      }
      this.fileIdentity = { device: fileStat.dev, inode: fileStat.ino };

      const records: RawHarnessRecord[] = [];
      let pending = this.pendingBytes;
      let pendingSearchOffset = this.pendingSearchOffset;
      let droppingOversizedLine = this.droppingOversizedLine;
      let discardedLineBytes = this.discardedLineBytes;
      let bytesReadThisQuantum = 0;
      while (records.length < batchSize) {
        const newlineOffset = pending.indexOf(0x0a, pendingSearchOffset);
        if (newlineOffset >= 0) {
          const lineBytes = pending.subarray(0, newlineOffset);
          pending = pending.subarray(newlineOffset + 1);
          pendingSearchOffset = 0;
          this.cursor.offset += newlineOffset + 1;
          this.cursor.line++;
          const trimmed = lineBytes.toString("utf8").trim();
          if (!trimmed) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // A torn or foreign line carries no muse record.
            continue;
          }
          // A retained frame line holds several records; all of them share this line's cursor.
          for (const inner of expandMuseLogLine(parsed)) {
            this.cursor.sequence++;
            const recordTimestamp = museRecordTimestamp(inner, fileStat.mtime.toISOString());
            this.cursor.timestamp = recordTimestamp;
            records.push({
              recordId: `rec_${this.cursor.sequence}`,
              sessionId: this.sessionId,
              harnessId: MUSE_HARNESS_ID,
              sequenceNumber: this.cursor.sequence,
              timestamp: recordTimestamp,
              recordType: museRecordType(inner),
              rawPayload: inner,
              cursor: {
                offset: this.cursor.offset,
                line: this.cursor.line,
                sequence: this.cursor.sequence,
                timestamp: recordTimestamp,
              },
              metadata: {
                filePath: this.filePath,
                line: this.cursor.line,
              },
            });
          }
          continue;
        }

        const readOffset = this.cursor.offset + pending.length + discardedLineBytes;
        if (bytesReadThisQuantum >= READ_QUANTUM_BYTES) {
          if (records.length > 0 || readOffset >= fileStat.size) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
          bytesReadThisQuantum = 0;
          continue;
        }
        const remainingBytes = fileStat.size - readOffset;
        if (remainingBytes <= 0) break;
        const remainingQuantumBytes = READ_QUANTUM_BYTES - bytesReadThisQuantum;
        const pendingAllowance = MAX_PENDING_RECORD_BYTES - pending.length + 1;
        const preferredChunkBytes =
          droppingOversizedLine || pending.length > 0
            ? READ_QUANTUM_BYTES
            : READ_CHUNK_BYTES;
        const bytesToRead = Math.min(
          preferredChunkBytes,
          remainingBytes,
          remainingQuantumBytes,
          droppingOversizedLine ? remainingQuantumBytes : pendingAllowance,
        );
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, readOffset);
        if (bytesRead === 0) break;
        this.hasReadActivity = true;
        bytesReadThisQuantum += bytesRead;
        const incoming = buffer.subarray(0, bytesRead);

        if (droppingOversizedLine) {
          const newline = incoming.indexOf(0x0a);
          if (newline < 0) {
            discardedLineBytes += bytesRead;
            continue;
          }
          discardedLineBytes += newline + 1;
          this.cursor.offset += discardedLineBytes;
          this.cursor.line++;
          discardedLineBytes = 0;
          droppingOversizedLine = false;
          pending = incoming.subarray(newline + 1);
          pendingSearchOffset = 0;
          continue;
        }

        const newline = incoming.indexOf(0x0a);
        const bytesBeforeNewline = newline >= 0 ? newline : incoming.length;
        if (pending.length + bytesBeforeNewline > MAX_PENDING_RECORD_BYTES) {
          discardedLineBytes = pending.length + bytesBeforeNewline;
          pending = Buffer.alloc(0);
          pendingSearchOffset = 0;
          droppingOversizedLine = true;
          if (newline >= 0) {
            discardedLineBytes++;
            this.cursor.offset += discardedLineBytes;
            this.cursor.line++;
            discardedLineBytes = 0;
            droppingOversizedLine = false;
            pending = incoming.subarray(newline + 1);
          }
          continue;
        }
        pending = pending.length > 0 ? Buffer.concat([pending, incoming]) : Buffer.from(incoming);
      }
      this.pendingBytes = pending.length > 0 ? pending : Buffer.alloc(0);
      this.pendingSearchOffset = pendingSearchOffset;
      this.droppingOversizedLine = droppingOversizedLine;
      this.discardedLineBytes = discardedLineBytes;
      return records;
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Registers a push callback for real-time streaming of new records.
   */
  onRecords(callback: RecordListener): () => void {
    if (this.closed) return () => {};

    const subscribers = new Set(this.subscribers);
    subscribers.add(callback);
    this.subscribers = subscribers;

    if (!this.pollTimer) {
      this.startPolling();
    }

    return () => {
      if (!this.subscribers.has(callback)) return;
      const subscribers = new Set(this.subscribers);
      subscribers.delete(callback);
      this.subscribers = subscribers;
      if (this.subscribers.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  /**
   * Alias for onRecords to support subscribe style listener registration.
   */
  async subscribe(listener: RecordListener): Promise<() => void> {
    return this.onRecords(listener);
  }

  /**
   * Commits a progress checkpoint without rewinding bytes already read ahead.
   */
  checkpoint(cursor: SourceCursor): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Before the first read, an ahead checkpoint may restore position; afterward checkpoints only acknowledge read-ahead.
    return this.enqueueOperation(() => {
      const isAheadOfReadFrontier =
        cursor.offset > this.cursor.offset ||
        (cursor.offset === this.cursor.offset && cursor.sequence > this.cursor.sequence);
      if (this.hasReadActivity || !isAheadOfReadFrontier) return;

      this.cursor = { ...cursor };
      this.pendingSearchOffset = 0;
      this.pendingBytes = Buffer.alloc(0);
      this.droppingOversizedLine = false;
      this.discardedLineBytes = 0;
    });
  }

  private startPolling(): void {
    if (this.pollTimer || this.closed) return;

    this.pollTimer = setInterval(() => {
      if (this.subscribers.size === 0 || this.closed || this.activePoll) return;
      const poll = this.pollSubscribers();
      this.activePoll = poll;
      void poll.then(
        () => {
          if (this.activePoll === poll) this.activePoll = undefined;
        },
        () => {
          if (this.activePoll === poll) this.activePoll = undefined;
        },
      );
    }, this.pollIntervalMs);
  }

  private async pollSubscribers(): Promise<void> {
    const subscribers = this.subscribers;
    try {
      const records = await this.readNext();
      if (records.length > 0 && !this.closed) {
        for (const listener of subscribers) {
          if (this.closed) break;
          try {
            await listener(records);
          } catch {
            // Ignore subscriber errors
          }
        }
      }
    } catch {
      // Polling read error
    }
  }

  /**
   * Returns current reading cursor position.
   */
  getCursor(): SourceCursor | null {
    return { ...this.cursor };
  }

  /**
   * Sets or rewinds reading cursor position.
   */
  setCursor(cursor: SourceCursor): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueueOperation(() => {
      this.cursor = { ...cursor };
      this.pendingSearchOffset = 0;
      this.pendingBytes = Buffer.alloc(0);
      this.droppingOversizedLine = false;
      this.discardedLineBytes = 0;
      this.hasReadActivity = false;
    });
  }

  /**
   * Detects if the underlying file has been rotated or truncated.
   */
  detectRotation(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.enqueueOperation(async () => {
      try {
        const fileStat = await fs.stat(this.filePath);
        const identityChanged =
          this.fileIdentity !== null &&
          (this.fileIdentity.device !== fileStat.dev || this.fileIdentity.inode !== fileStat.ino);
        return (
          identityChanged ||
          fileStat.size < this.cursor.offset + this.pendingBytes.length + this.discardedLineBytes
        );
      } catch {
        return false;
      }
    });
  }

  /**
   * Closes the event source and cleans up any open handles or timers.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscribers = new Set();
    await this.operationQueue;
    this.activePoll = undefined;
    this.pendingBytes = Buffer.alloc(0);
    this.pendingSearchOffset = 0;
    this.droppingOversizedLine = false;
    this.discardedLineBytes = 0;
  }
}
