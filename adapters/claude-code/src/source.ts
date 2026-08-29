import {
  type ConfigFsBridge,
  type HarnessSession,
  type ObservationFidelity,
  type RawHarnessRecord,
  type RecordListener,
  type SessionEventSource,
  type SourceCursor,
  TIER2_MEDIUM_FIDELITY,
  computeConfigHash,
  defaultFsBridge,
} from "@resin/harness-contracts";

/**
 * Options for configuring ClaudeSessionEventSource.
 */
export interface ClaudeSessionEventSourceOptions {
  pollingIntervalMs?: number;
  fsBridge?: ConfigFsBridge;
}

/**
 * Event source that tails, batches, and streams active Claude Code JSONL transcripts.
 */
export class ClaudeSessionEventSource implements SessionEventSource {
  readonly sessionId: string;
  readonly harnessId = "claude-code";
  readonly transcriptPath: string;

  private cursor: SourceCursor | null = null;
  private readonly listeners = new Set<RecordListener>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly pollingIntervalMs: number;
  private readonly fsBridge: ConfigFsBridge;

  private isRunning = false;
  private isProcessing = false;
  private closed = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentByteOffset = 0;
  private currentLineNumber = 0;
  private currentSequence = 0;

  constructor(
    session: HarnessSession,
    initialCursor?: SourceCursor,
    options?: ClaudeSessionEventSourceOptions,
  ) {
    this.sessionId = session.sessionId;
    this.transcriptPath = session.transcriptPath;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 50;
    this.fsBridge = options?.fsBridge ?? defaultFsBridge;

    if (initialCursor) {
      this.cursor = { ...initialCursor };
      this.currentByteOffset = initialCursor.offset ?? 0;
      this.currentLineNumber = initialCursor.line ?? 0;
      this.currentSequence = initialCursor.sequence ?? 0;
    }
  }

  async readNext(batchSize = 50): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];
    return await this.fetchRecords(batchSize);
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  onRecord(callback: (record: RawHarnessRecord) => void | Promise<void>): () => void {
    const multiListener: RecordListener = async (records) => {
      for (const r of records) {
        await callback(r);
      }
    };
    this.listeners.add(multiListener);
    return () => {
      this.listeners.delete(multiListener);
    };
  }

  onError(callback: (err: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
    this.currentByteOffset = cursor.offset ?? this.currentByteOffset;
    this.currentLineNumber = cursor.line ?? this.currentLineNumber;
    this.currentSequence = cursor.sequence ?? this.currentSequence;
  }

  getCursor(): SourceCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  async detectRotation(): Promise<boolean> {
    const content = await this.fsBridge.readFile(this.transcriptPath);
    if (content === null) return false;
    const currentSize = Buffer.byteLength(content, "utf8");
    if (currentSize < this.currentByteOffset) {
      return true; // file truncated or rotated
    }
    return false;
  }

  async start(): Promise<void> {
    if (this.isRunning || this.closed) return;
    this.isRunning = true;

    // Read initial existing records
    const initialRecords = await this.fetchRecords();
    if (initialRecords.length > 0) {
      for (const listener of this.listeners) {
        try {
          await listener(initialRecords);
        } catch (err) {
          this.notifyError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    this.pollTimer = setInterval(async () => {
      if (!this.isRunning || this.closed) return;
      const records = await this.fetchRecords();
      if (records.length > 0) {
        for (const listener of this.listeners) {
          try {
            await listener(records);
          } catch (err) {
            this.notifyError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    }, this.pollingIntervalMs);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    this.listeners.clear();
    this.errorListeners.clear();
  }

  getFidelity(): ObservationFidelity {
    return TIER2_MEDIUM_FIDELITY;
  }

  /**
   * Fetches newly appended records from transcript file.
   */
  private async fetchRecords(maxRecords = 50): Promise<RawHarnessRecord[]> {
    if (this.isProcessing) return [];
    this.isProcessing = true;

    const records: RawHarnessRecord[] = [];

    try {
      const exists = await this.fsBridge.exists(this.transcriptPath);
      if (!exists) {
        return [];
      }

      const content = await this.fsBridge.readFile(this.transcriptPath);
      if (content === null) {
        return [];
      }

      const buffer = Buffer.from(content, "utf8");
      if (buffer.length < this.currentByteOffset) {
        this.currentByteOffset = 0;
        this.currentLineNumber = 1;
        this.currentSequence = 0;
      }
      if (buffer.length <= this.currentByteOffset) {
        return [];
      }

      const newBytes = buffer.subarray(this.currentByteOffset);
      const newText = newBytes.toString("utf8");

      const lines = newText.split("\n");
      const completeLines = lines.slice(0, -1);

      let consumedBytes = 0;

      for (let i = 0; i < completeLines.length && records.length < maxRecords; i++) {
        const line = completeLines[i];
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;

        if (line.trim().length === 0) {
          consumedBytes += lineBytes;
          this.currentLineNumber++;
          continue;
        }

        this.currentSequence++;
        this.currentLineNumber++;
        consumedBytes += lineBytes;

        const lineHash = computeConfigHash(line);
        const recordTime = new Date().toISOString();

        const cursor: SourceCursor = {
          offset: this.currentByteOffset + consumedBytes,
          line: Math.max(1, this.currentLineNumber),
          sequence: this.currentSequence,
          checkpoint: lineHash,
          timestamp: recordTime,
        };
        this.cursor = cursor;

        let rawPayload: unknown = line;
        try {
          rawPayload = JSON.parse(line);
        } catch {
          rawPayload = { text: line };
        }

        const record: RawHarnessRecord = {
          recordId: `${this.sessionId}-rec-${this.currentSequence}`,
          sessionId: this.sessionId,
          harnessId: this.harnessId,
          sequenceNumber: this.currentSequence,
          timestamp: recordTime,
          recordType: "transcript_line",
          rawPayload,
          cursor,
          metadata: {
            transcriptPath: this.transcriptPath,
            line: this.currentLineNumber,
          },
        };

        records.push(record);
      }

      this.currentByteOffset += consumedBytes;
    } catch (err) {
      this.notifyError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isProcessing = false;
    }

    return records;
  }

  private notifyError(err: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch {
        // Prevent listener crashes from propagating
      }
    }
  }
}
