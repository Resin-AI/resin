import type fs from "node:fs";
import * as fsp from "node:fs/promises";
import type {
  HarnessSession,
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";

export interface OmpEventSourceOptions {
  pollIntervalMs?: number;
  maxBatchSize?: number;
  readChunkSize?: number;
}

/**
 * Event source tailing append-only JSONL transcript files produced by Oh My Pi.
 */
export class OmpSessionEventSource implements SessionEventSource {
  readonly session: HarnessSession;
  private currentCursor: SourceCursor;
  private listeners = new Set<RecordListener>();
  private pollIntervalMs: number;
  private maxBatchSize: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isClosed = false;
  private lastInode: number | null = null;
  private lastFileSize = 0;

  constructor(
    session: HarnessSession,
    initialCursor?: SourceCursor,
    options?: OmpEventSourceOptions,
  ) {
    this.session = session;
    this.pollIntervalMs = options?.pollIntervalMs ?? 100;
    this.maxBatchSize = options?.maxBatchSize ?? 50;

    this.currentCursor = initialCursor
      ? { ...initialCursor }
      : {
          offset: 0,
          line: 1,
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
  }

  getCursor(): SourceCursor {
    return { ...this.currentCursor };
  }

  /**
   * Commits a progress checkpoint.
   */
  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.currentCursor = { ...cursor };
  }

  /**
   * Alias for checkpoint.
   */
  async setCursor(cursor: SourceCursor): Promise<void> {
    return this.checkpoint(cursor);
  }

  /**
   * Pulls the next batch of raw harness records from the current cursor position in the JSONL file.
   */
  async readNext(batchSize?: number): Promise<RawHarnessRecord[]> {
    if (this.isClosed) {
      return [];
    }

    const limit = batchSize ?? this.maxBatchSize;
    const filePath = this.session.transcriptPath;

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return [];
    }

    this.lastInode = stat.ino;
    this.lastFileSize = stat.size;

    // Check if file is smaller than cursor (rotation/truncation)
    if (stat.size < this.currentCursor.offset) {
      this.currentCursor.offset = 0;
      this.currentCursor.line = 1;
      this.currentCursor.sequence = 0;
    }

    const bytesAvailable = stat.size - this.currentCursor.offset;
    if (bytesAvailable <= 0) {
      return [];
    }

    const fd = await fsp.open(filePath, "r");
    let rawChunk = "";
    try {
      const buffer = Buffer.alloc(bytesAvailable);
      const { bytesRead } = await fd.read(buffer, 0, bytesAvailable, this.currentCursor.offset);
      rawChunk = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await fd.close();
    }

    if (rawChunk.length === 0) {
      return [];
    }

    const records: RawHarnessRecord[] = [];
    let lineStart = 0;

    while (lineStart < rawChunk.length && records.length < limit) {
      const newlineIndex = rawChunk.indexOf("\n", lineStart);
      if (newlineIndex === -1) {
        // Trailing line fragment is incomplete, leave for next read
        break;
      }

      const line = rawChunk.slice(lineStart, newlineIndex);
      const lineSliceWithNewline = rawChunk.slice(lineStart, newlineIndex + 1);
      const lineByteLength = Buffer.byteLength(lineSliceWithNewline, "utf8");

      lineStart = newlineIndex + 1;
      this.currentCursor.offset += lineByteLength;
      this.currentCursor.sequence += 1;
      this.currentCursor.timestamp = new Date().toISOString();

      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const recordId = `${this.session.sessionId}-rec-${this.currentCursor.sequence}`;
        let parsedPayload: unknown = trimmed;
        let timestamp = new Date().toISOString();
        let recordType: RecordType = "transcript_line";

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed instanceof Object && !Array.isArray(parsed)) {
            // SAFETY: Parsed JSON represents a structured transcript record object.
            const obj = parsed as {
              timestamp?: string | number;
              updatedAt?: string | number;
              time?: string | number;
              ts?: string | number;
              role?: string;
              type?: string;
              event?: string;
              kind?: string;
              toolCall?: object;
              tool_call?: object;
              toolResult?: object;
              tool_result?: object;
            };
            parsedPayload = parsed;
            const ts = obj.timestamp ?? obj.updatedAt ?? obj.time ?? obj.ts;
            if (ts !== undefined) {
              timestamp = String(ts);
            }
            recordType = this.classifyRecordType(obj);
          }
        } catch {
          parsedPayload = trimmed;
          recordType = "transcript_line";
        }
        records.push({
          recordId,
          sessionId: this.session.sessionId,
          harnessId: "omp",
          sequenceNumber: this.currentCursor.sequence,
          timestamp,
          cursor: { ...this.currentCursor },
          rawPayload: trimmed,
          recordType,
          metadata: {
            transcriptPath: filePath,
            lineNumber: this.currentCursor.line,
            byteOffset: this.currentCursor.offset,
          },
        });
      }

      this.currentCursor.line += 1;
    }

    return records;
  }

  /**
   * Alias for readNext.
   */
  async readBatch(batchSize?: number): Promise<RawHarnessRecord[]> {
    return this.readNext(batchSize);
  }

  /**
   * Registers a push callback for real-time streaming of new records.
   */
  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);

    if (!this.pollTimer && !this.isClosed) {
      this.startPolling();
    }

    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  }

  /**
   * Alias for onRecords.
   */
  subscribe(listener: RecordListener): () => void {
    return this.onRecords(listener);
  }

  /**
   * Detects if the transcript file has undergone rotation, inode replacement, or truncation.
   */
  async detectRotation(): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.session.transcriptPath);

      const inodeChanged = this.lastInode !== null && stat.ino !== this.lastInode;
      const truncated = stat.size < this.currentCursor.offset;

      if (inodeChanged || truncated) {
        this.lastInode = stat.ino;
        this.lastFileSize = stat.size;
        return true;
      }

      this.lastInode = stat.ino;
      this.lastFileSize = stat.size;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Closes the event source and cleans up file polling/watchers.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private startPolling(): void {
    if (this.pollTimer || this.isClosed) {
      return;
    }

    this.pollTimer = setInterval(async () => {
      if (this.isClosed || this.listeners.size === 0) {
        this.stopPolling();
        return;
      }

      try {
        const records = await this.readNext();
        if (records.length > 0) {
          for (const listener of Array.from(this.listeners)) {
            try {
              await listener(records);
            } catch {
              // Listener errors do not stop polling
            }
          }
        }
      } catch {
        // Ignore read errors during background polling
      }
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private classifyRecordType(obj: {
    role?: string;
    type?: string;
    event?: string;
    kind?: string;
    toolCall?: object;
    tool_call?: object;
    toolResult?: object;
    tool_result?: object;
  }): RecordType {
    const rawRole = String(obj.role ?? "").toLowerCase();
    const rawType = String(obj.type ?? obj.event ?? obj.kind ?? "").toLowerCase();

    if (rawRole === "user" || rawType === "user_message" || rawType === "prompt") {
      return "prompt";
    }

    if (rawRole === "assistant" || rawType === "assistant_message" || rawType === "completion") {
      return "completion";
    }

    if (rawRole === "system" || rawType === "system_message" || rawType === "system") {
      return "system";
    }

    if (
      rawType === "tool_call" ||
      rawType === "tool_use" ||
      rawType === "tool_invocation" ||
      (obj.toolCall !== undefined && obj.toolCall instanceof Object) ||
      (obj.tool_call !== undefined && obj.tool_call instanceof Object)
    ) {
      return "tool_call";
    }

    if (
      rawType === "tool_result" ||
      rawType === "tool_response" ||
      rawType === "tool_output" ||
      (obj.toolResult !== undefined && obj.toolResult instanceof Object) ||
      (obj.tool_result !== undefined && obj.tool_result instanceof Object)
    ) {
      return "tool_result";
    }

    return "transcript_line";
  }
}
