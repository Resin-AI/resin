import * as fs from "node:fs/promises";
import type {
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import {
  CODEX_REQUEST_LINK_RESUME_KEY,
  CodexRequestLinkPrimer,
  type CodexRequestLinkResume,
} from "./decoder.js";
import { CODEX_HARNESS_ID } from "./discovery.js";

/**
 * Options for creating a CodexSessionEventSource.
 */
export interface CodexSessionEventSourceOptions {
  filePath: string;
  sessionId: string;
  initialCursor?: Partial<SourceCursor>;
  pollIntervalMs?: number;
}

const CODEX_READ_CHUNK_BYTES = 64 * 1024;
const CODEX_READ_QUANTUM_BYTES = 1024 * 1024;
const CODEX_MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024;
const CODEX_NATIVE_RECORD_TYPES: Record<string, true> = {
  event_msg: true,
  response_item: true,
  session_meta: true,
  token_usage_record: true,
  turn_context: true,
  world_state: true,
};

function codexRecordTimestamp(record: Record<string, unknown>, fallback: string): string {
  const payload =
    record.payload !== null && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  for (const value of [
    record.timestamp,
    record.created_at,
    payload.timestamp,
    payload.completed_at,
    payload.started_at,
  ]) {
    if (typeof value !== "string" || value.length === 0) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

function isCodexRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The record the source emits for one non-empty, trimmed rollout line. */
function codexSourceRecord(
  sessionId: string,
  filePath: string,
  trimmed: string,
  fallbackTimestamp: string,
  position: { offset: number; line: number; sequence: number },
): RawHarnessRecord {
  let parsedPayload: unknown = trimmed;
  let recordTimestamp = fallbackTimestamp;
  let recordType: RecordType = "transcript_line";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isCodexRecordObject(parsed)) {
      parsedPayload = parsed;
      recordTimestamp = codexRecordTimestamp(parsed, recordTimestamp);
      const rawType = String(parsed.type ?? parsed.role ?? "").toLowerCase();
      if (Object.hasOwn(CODEX_NATIVE_RECORD_TYPES, rawType)) {
        recordType = "custom";
      } else if (rawType.includes("call")) {
        recordType = "tool_call";
      } else if (rawType.includes("result") || rawType.includes("response")) {
        recordType = "tool_result";
      } else if (rawType === "user" || rawType === "user_message") {
        recordType = "prompt";
      } else if (rawType === "assistant" || rawType === "assistant_message") {
        recordType = "completion";
      } else if (rawType === "system") {
        recordType = "system";
      }
    }
  } catch {
    parsedPayload = trimmed;
    recordType = "transcript_line";
  }

  return {
    recordId: `rec_${position.sequence}`,
    sessionId,
    harnessId: CODEX_HARNESS_ID,
    sequenceNumber: position.sequence,
    timestamp: recordTimestamp,
    recordType,
    rawPayload: parsedPayload,
    cursor: {
      offset: position.offset,
      line: position.line,
      sequence: position.sequence,
      timestamp: recordTimestamp,
    },
    metadata: {
      filePath,
      line: position.line,
    },
  };
}

/**
 * Event source that tails and reads from a Codex CLI session transcript (JSONL).
 */
export class CodexSessionEventSource implements SessionEventSource {
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
  /** Whether the first read has run: a source resuming mid-file primes link state once, then. */
  private primed = false;
  /** Primed link state, held until the first record after the resume (a JSON object) carries it. */
  private pendingLinkResume: CodexRequestLinkResume | undefined;

  constructor(options: CodexSessionEventSourceOptions) {
    this.filePath = options.filePath;
    this.sessionId = options.sessionId;
    // One poll timer per attached session: a 1 s tick keeps an idle daemon near zero CPU.
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
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
        this.pendingLinkResume = undefined;
      } else if (!this.primed && this.cursor.offset > 0) {
        // Resuming mid-file: recover the native context (turn, model, provider) the rollout
        // before the cursor established, which a fresh decoder would otherwise lack.
        this.pendingLinkResume = await this.primeRequestLinks(
          handle,
          this.cursor.offset,
          fileStat.mtime.toISOString(),
        );
      }
      this.primed = true;
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

          this.cursor.sequence++;
          const record = codexSourceRecord(
            this.sessionId,
            this.filePath,
            trimmed,
            fileStat.mtime.toISOString(),
            this.cursor,
          );
          this.cursor.timestamp = record.timestamp;
          if (this.pendingLinkResume !== undefined && isCodexRecordObject(record.rawPayload)) {
            record.metadata[CODEX_REQUEST_LINK_RESUME_KEY] = this.pendingLinkResume;
            this.pendingLinkResume = undefined;
          }
          records.push(record);
          continue;
        }

        const readOffset = this.cursor.offset + pending.length + discardedLineBytes;
        if (bytesReadThisQuantum >= CODEX_READ_QUANTUM_BYTES) {
          if (records.length > 0 || readOffset >= fileStat.size) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
          bytesReadThisQuantum = 0;
          continue;
        }
        const remainingBytes = fileStat.size - readOffset;
        if (remainingBytes <= 0) break;
        const remainingQuantumBytes = CODEX_READ_QUANTUM_BYTES - bytesReadThisQuantum;
        const pendingAllowance = CODEX_MAX_PENDING_RECORD_BYTES - pending.length + 1;
        const preferredChunkBytes =
          droppingOversizedLine || pending.length > 0
            ? CODEX_READ_QUANTUM_BYTES
            : CODEX_READ_CHUNK_BYTES;
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
        if (pending.length + bytesBeforeNewline > CODEX_MAX_PENDING_RECORD_BYTES) {
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
   * Decodes native link state from every complete line in `[0, end)`, in bounded chunks and with
   * the same oversized-line rule as `readNextSerial`. Nothing is emitted and the prefix is never
   * read again.
   */
  private async primeRequestLinks(
    handle: fs.FileHandle,
    end: number,
    fallbackTimestamp: string,
  ): Promise<CodexRequestLinkResume | undefined> {
    const primer = new CodexRequestLinkPrimer(this.sessionId);
    let pending = Buffer.alloc(0);
    let dropping = false;
    let position = 0;
    let offset = 0;
    let line = 1;
    let sequence = 0;
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(CODEX_READ_QUANTUM_BYTES, end - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let chunk = buffer.subarray(0, bytesRead);
      let newline = chunk.indexOf(0x0a);
      while (newline >= 0) {
        const lineLength = pending.length + newline;
        offset += lineLength + 1;
        line++;
        if (!dropping && lineLength <= CODEX_MAX_PENDING_RECORD_BYTES) {
          const lineBytes =
            pending.length > 0
              ? Buffer.concat([pending, chunk.subarray(0, newline)])
              : chunk.subarray(0, newline);
          const trimmed = lineBytes.toString("utf8").trim();
          if (trimmed) {
            sequence++;
            primer.observe(
              codexSourceRecord(this.sessionId, this.filePath, trimmed, fallbackTimestamp, {
                offset,
                line,
                sequence,
              }),
            );
          }
        }
        dropping = false;
        pending = Buffer.alloc(0);
        chunk = chunk.subarray(newline + 1);
        newline = chunk.indexOf(0x0a);
      }
      if (dropping || pending.length + chunk.length > CODEX_MAX_PENDING_RECORD_BYTES) {
        // Track the oversized line's length without buffering it.
        offset += pending.length + chunk.length;
        dropping = true;
        pending = Buffer.alloc(0);
      } else {
        pending = Buffer.concat([pending, chunk]);
      }
    }
    return primer.snapshot();
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
