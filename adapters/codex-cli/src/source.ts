import * as fs from "node:fs/promises";
import type {
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
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

/**
 * Event source that tails and reads from a Codex CLI session transcript (JSONL).
 */
export class CodexSessionEventSource implements SessionEventSource {
  private readonly filePath: string;
  private readonly sessionId: string;
  private cursor: SourceCursor;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly subscribers = new Set<RecordListener>();
  private closed = false;

  constructor(options: CodexSessionEventSourceOptions) {
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

  /**
   * Pulls the next batch of raw harness records from the current cursor position.
   */
  async readNext(batchSize = 100): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];

    let stat: fs.FileHandle | null = null;
    try {
      const handle = await fs.open(this.filePath, "r");
      stat = handle;
      const fileStat = await handle.stat();

      // Check if file was truncated/rotated
      if (fileStat.size < this.cursor.offset) {
        this.cursor.offset = 0;
        this.cursor.line = 1;
      }

      if (fileStat.size <= this.cursor.offset) {
        await handle.close();
        return [];
      }

      const bytesToRead = fileStat.size - this.cursor.offset;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, this.cursor.offset);
      await handle.close();
      stat = null;

      if (bytesRead === 0) return [];

      const rawText = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = rawText.split("\n");

      // If the last line doesn't end with a newline and we haven't reached EOF, don't consume incomplete line
      const hasTrailingNewline = rawText.endsWith("\n");
      const completeLines = hasTrailingNewline
        ? lines.filter((l: string, idx: number) => idx < lines.length - 1 || l.length > 0)
        : lines.slice(0, -1);

      const records: RawHarnessRecord[] = [];
      const startOffset = this.cursor.offset;
      let consumedBytes = 0;

      for (let i = 0; i < completeLines.length && records.length < batchSize; i++) {
        const line = completeLines[i];
        if (line === undefined) continue;

        const lineOffset = startOffset + consumedBytes;
        const lineByteLength = Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
        consumedBytes += lineByteLength;
        const trimmed = line.trim();
        if (!trimmed) continue;

        this.cursor.sequence++;
        this.cursor.line++;
        const recordId = `rec_${this.cursor.sequence}`;

        let parsedPayload: unknown = trimmed;
        let recordTimestamp = new Date().toISOString();
        let recordType: RecordType = "transcript_line";

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          parsedPayload = parsed;
          if (typeof parsed.timestamp === "string") {
            recordTimestamp = new Date(parsed.timestamp).toISOString();
          } else if (typeof parsed.created_at === "string") {
            recordTimestamp = new Date(parsed.created_at).toISOString();
          }

          const rawType = String(parsed.type || parsed.role || "").toLowerCase();
          if (rawType.includes("call")) {
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
        } catch {
          parsedPayload = trimmed;
          recordType = "transcript_line";
        }

        this.cursor.timestamp = recordTimestamp;

        const recordCursor: SourceCursor = {
          offset: lineOffset,
          line: this.cursor.line,
          sequence: this.cursor.sequence,
          timestamp: recordTimestamp,
        };

        records.push({
          recordId,
          sessionId: this.sessionId,
          harnessId: CODEX_HARNESS_ID,
          sequenceNumber: this.cursor.sequence,
          timestamp: recordTimestamp,
          recordType,
          rawPayload: parsedPayload,
          cursor: recordCursor,
          metadata: {
            filePath: this.filePath,
            line: this.cursor.line,
          },
        });
      }

      this.cursor.offset = startOffset + consumedBytes;
      return records;
    } catch (err: unknown) {
      if (stat) {
        try {
          await stat.close();
        } catch {
          // ignore
        }
      }
      return [];
    }
  }

  /**
   * Registers a push callback for real-time streaming of new records.
   */
  onRecords(callback: RecordListener): () => void {
    this.subscribers.add(callback);

    if (!this.pollTimer && !this.closed) {
      this.startPolling();
    }

    return () => {
      this.subscribers.delete(callback);
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
   * Commits a progress checkpoint.
   */
  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
  }

  private startPolling(): void {
    if (this.pollTimer || this.closed) return;

    this.pollTimer = setInterval(async () => {
      if (this.subscribers.size === 0 || this.closed) return;

      try {
        const records = await this.readNext();
        if (records.length > 0) {
          for (const listener of this.subscribers) {
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
    }, this.pollIntervalMs);
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
  async setCursor(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
  }

  /**
   * Detects if the underlying file has been rotated or truncated.
   */
  async detectRotation(): Promise<boolean> {
    try {
      const fileStat = await fs.stat(this.filePath);
      return fileStat.size < this.cursor.offset;
    } catch {
      return false;
    }
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
    this.subscribers.clear();
  }
}
