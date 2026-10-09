import fs from "node:fs/promises";
import {
  type ConfigFsBridge,
  type HarnessSession,
  InMemoryConfigFsBridge,
  type ObservationFidelity,
  type RawHarnessRecord,
  type RecordListener,
  type SessionEventSource,
  type SourceCursor,
  TIER2_MEDIUM_FIDELITY,
  computeConfigHash,
  defaultFsBridge,
} from "@resin/harness-contracts";
import {
  CLAUDE_REQUEST_LINK_RESUME_KEY,
  ClaudeRequestLinkPrimer,
  type ClaudeRequestLinkResume,
} from "./decoder.js";

const READ_CHUNK_BYTES = 64 * 1024;

interface TranscriptReader {
  size: number;
  read(target: Buffer, position: number): Promise<number>;
  close(): Promise<void>;
}

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
  /** Whether the first read has run: a source resuming mid-file primes link state once, then. */
  private primed = false;
  /** Primed link state, held until the first record after the resume carries it. */
  private pendingLinkResume: ClaudeRequestLinkResume | undefined;

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
    const transcript = await this.openTranscript();
    if (transcript === null) return false;
    try {
      return transcript.size < this.currentByteOffset; // file truncated or rotated
    } finally {
      await transcript.close();
    }
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

      const transcript = await this.openTranscript();
      if (transcript === null) {
        return [];
      }

      try {
        const { size } = transcript;
        if (size < this.currentByteOffset) {
          this.currentByteOffset = 0;
          this.currentLineNumber = 1;
          this.currentSequence = 0;
          this.pendingLinkResume = undefined;
        } else if (!this.primed && this.currentByteOffset > 0) {
          // Resuming mid-file: recover the task and call links the transcript before the cursor
          // established, which a fresh decoder would otherwise lose until the next prompt.
          this.pendingLinkResume = await this.primeRequestLinks(transcript, this.currentByteOffset);
        }
        this.primed = true;

        // Read bounded chunks from the cursor and stop once maxRecords complete lines are
        // collected, so large transcripts are never loaded (or re-read) whole per call.
        let pending = Buffer.alloc(0);
        let position = this.currentByteOffset;
        while (records.length < maxRecords && position < size) {
          const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
          const bytesRead = await transcript.read(chunk, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          pending =
            pending.length === 0
              ? chunk.subarray(0, bytesRead)
              : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

          let newline = pending.indexOf(0x0a);
          while (newline !== -1 && records.length < maxRecords) {
            // Decode each line from its own byte range so records never retain the chunk.
            const line = pending.toString("utf8", 0, newline);
            pending = pending.subarray(newline + 1);
            this.currentByteOffset += newline + 1;
            this.currentLineNumber++;
            newline = pending.indexOf(0x0a);

            if (line.trim().length === 0) {
              continue;
            }

            this.currentSequence++;
            records.push(this.toRecord(line));
          }
        }
      } finally {
        await transcript.close();
      }
    } catch (err) {
      this.notifyError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isProcessing = false;
    }

    return records;
  }

  /**
   * Decodes link state from every complete line in `[0, end)` in bounded chunks. Nothing is emitted
   * and the prefix is never read again.
   */
  private async primeRequestLinks(
    transcript: TranscriptReader,
    end: number,
  ): Promise<ClaudeRequestLinkResume | undefined> {
    const primer = new ClaudeRequestLinkPrimer(this.sessionId);
    let sequence = 0;
    let pending = Buffer.alloc(0);
    let position = 0;
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, end - position));
      const bytesRead = await transcript.read(chunk, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        const line = pending.toString("utf8", 0, newline);
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
        if (line.trim().length === 0) continue;
        sequence++;
        primer.observe(parseTranscriptLine(line), sequence);
      }
    }
    const resume = primer.snapshot();
    return resume.taskId === undefined && resume.calls.length === 0 ? undefined : resume;
  }

  private toRecord(line: string): RawHarnessRecord {
    const lineHash = computeConfigHash(line);
    const recordTime = new Date().toISOString();

    const cursor: SourceCursor = {
      offset: this.currentByteOffset,
      line: Math.max(1, this.currentLineNumber),
      sequence: this.currentSequence,
      checkpoint: lineHash,
      timestamp: recordTime,
    };
    this.cursor = cursor;

    const linkResume = this.pendingLinkResume;
    this.pendingLinkResume = undefined;

    return {
      recordId: `${this.sessionId}-rec-${this.currentSequence}`,
      sessionId: this.sessionId,
      harnessId: this.harnessId,
      sequenceNumber: this.currentSequence,
      timestamp: recordTime,
      recordType: "transcript_line",
      rawPayload: parseTranscriptLine(line),
      cursor,
      metadata: {
        transcriptPath: this.transcriptPath,
        line: this.currentLineNumber,
        ...(linkResume === undefined ? {} : { [CLAUDE_REQUEST_LINK_RESUME_KEY]: linkResume }),
      },
    };
  }

  /**
   * Opens the transcript for ranged reads. In-memory test bridges have no ranged API, so their
   * content is served from a buffer; every other bridge is backed by the real filesystem.
   */
  private async openTranscript(): Promise<TranscriptReader | null> {
    if (this.fsBridge instanceof InMemoryConfigFsBridge) {
      const content = await this.fsBridge.readFile(this.transcriptPath);
      if (content === null) return null;
      const buffer = Buffer.from(content, "utf8");
      return {
        size: buffer.length,
        read: async (target, position) =>
          buffer.copy(target, 0, position, position + target.length),
        close: async () => {},
      };
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.transcriptPath, "r");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      return {
        size,
        read: async (target, position) =>
          (await handle.read(target, 0, target.length, position)).bytesRead,
        close: () => handle.close(),
      };
    } catch (err) {
      await handle.close();
      throw err;
    }
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

/** A transcript line's payload: its JSON value, or the raw text of a line that is not JSON. */
function parseTranscriptLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { text: line };
  }
}
