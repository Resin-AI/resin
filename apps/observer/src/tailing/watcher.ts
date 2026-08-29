import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { SourceCursor } from "@resin/harness-contracts";
import { type RecoveryAssessment, SourceRecoveryEngine } from "./recovery.js";

/**
 * Parsed record produced by the watcher for each complete line.
 */
export interface ParsedLineRecord {
  lineText: string;
  parsedJson?: unknown;
  cursor: SourceCursor;
  byteLength: number;
}

/**
 * Options for configuring TranscriptWatcher.
 */
export interface TranscriptWatcherOptions {
  filePath: string;
  sessionId?: string;
  harnessId?: string;
  initialOffset?: number;
  initialLine?: number;
  initialSequence?: number;
  pollingIntervalMs?: number;
  coalesceDebounceMs?: number;
  maxReadChunkSize?: number;
  autoStart?: boolean;
}

/**
 * Filesystem transcript watcher with bounded polling fallback, handling
 * burst coalescing, rapid appends, inode changes, and partial line buffering.
 */
export class TranscriptWatcher extends EventEmitter {
  readonly filePath: string;
  readonly sessionId: string;
  readonly harnessId: string;
  readonly pollingIntervalMs: number;
  readonly coalesceDebounceMs: number;
  readonly maxReadChunkSize: number;

  private fileReadOffset: number;
  private committedOffset: number;
  private currentLine: number;
  private currentSequence: number;

  private partialBuffer = "";
  private isRunning = false;
  private isPaused = false;
  private isReading = false;
  private pendingRead = false;

  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private fsWatcher?: fs.FSWatcher;

  private readonly recoveryEngine: SourceRecoveryEngine;

  constructor(options: TranscriptWatcherOptions) {
    super();
    this.filePath = options.filePath;
    this.sessionId = options.sessionId ?? "default-session";
    this.harnessId = options.harnessId ?? "unknown-harness";
    this.fileReadOffset = options.initialOffset ?? 0;
    this.committedOffset = options.initialOffset ?? 0;
    this.currentLine = options.initialLine ?? 1;
    this.currentSequence = options.initialSequence ?? 0;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;
    this.coalesceDebounceMs = options.coalesceDebounceMs ?? 20;
    this.maxReadChunkSize = options.maxReadChunkSize ?? 64 * 1024;

    this.recoveryEngine = new SourceRecoveryEngine();

    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * Starts the transcript watcher (fs.watch + periodic polling fallback).
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.setupFsWatch();
    this.setupPolling();

    // Trigger initial read
    void this.scheduleRead();
  }

  /**
   * Stops the transcript watcher and cleans up all timers and open handles.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // Ignore close errors
      }
      this.fsWatcher = undefined;
    }
  }

  /**
   * Pauses emission of new records (e.g. on downstream backpressure).
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resumes emission of new records.
   */
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.isRunning) {
      void this.scheduleRead();
    }
  }

  /**
   * Registers a callback invoked whenever complete line records are read.
   */
  onLines(callback: (records: ParsedLineRecord[]) => void | Promise<void>): () => void {
    const handler = (records: ParsedLineRecord[]) => {
      void callback(records);
    };
    this.on("lines", handler);
    return () => {
      this.off("lines", handler);
    };
  }

  /**
   * Sets up native fs.watch on the transcript file.
   */
  private setupFsWatch(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.fsWatcher = fs.watch(this.filePath, () => {
          void this.scheduleRead();
        });
        this.fsWatcher.on("error", () => {
          // File watch error (e.g. rotated/deleted), fallback to polling
          this.fsWatcher?.close();
          this.fsWatcher = undefined;
        });
      }
    } catch {
      // Ignore watch setup error, polling will catch updates
    }
  }

  /**
   * Sets up bounded periodic polling interval fallback.
   */
  private setupPolling(): void {
    this.pollTimer = setInterval(() => {
      if (!this.isRunning || this.isPaused) return;

      // Re-establish fsWatcher if it died or file was created
      if (!this.fsWatcher && fs.existsSync(this.filePath)) {
        this.setupFsWatch();
      }

      void this.scheduleRead();
    }, this.pollingIntervalMs);
  }

  /**
   * Schedules a debounced read operation to coalesce rapid appends.
   */
  scheduleRead(): void {
    if (!this.isRunning || this.isPaused) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.executeRead();
    }, this.coalesceDebounceMs);
  }

  /**
   * Manually triggers an immediate read step, returning newly read records.
   */
  async readNext(maxBatchSize?: number): Promise<ParsedLineRecord[]> {
    return await this.executeRead(maxBatchSize);
  }

  /**
   * Main reading execution loop.
   */
  private async executeRead(maxBatchSize?: number): Promise<ParsedLineRecord[]> {
    if (this.isReading) {
      this.pendingRead = true;
      return [];
    }

    this.isReading = true;
    const emittedRecords: ParsedLineRecord[] = [];

    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }

      // Check recovery / rotation / truncation
      const assessment = await this.recoveryEngine.probe(
        this.filePath,
        this.committedOffset,
        this.currentLine,
      );

      if (assessment.isActionable) {
        if (assessment.condition === "rotated" || assessment.condition === "archived") {
          this.emit("rotation", assessment);
          this.fileReadOffset = assessment.suggestedOffset;
          this.committedOffset = assessment.suggestedOffset;
          this.currentLine = assessment.suggestedLine;
          this.partialBuffer = "";
        } else if (assessment.condition === "truncated") {
          this.emit("truncate", assessment);
          this.fileReadOffset = assessment.suggestedOffset;
          this.committedOffset = assessment.suggestedOffset;
          this.currentLine = assessment.suggestedLine;
          this.partialBuffer = "";
        } else if (assessment.condition === "inaccessible" || assessment.condition === "missing") {
          return [];
        }
      }

      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= this.fileReadOffset && this.partialBuffer.length === 0) {
        return [];
      }

      const fileHandle = await fs.promises.open(this.filePath, "r");
      try {
        const bytesToRead = Math.min(stat.size - this.fileReadOffset, this.maxReadChunkSize);
        if (bytesToRead > 0) {
          const buffer = Buffer.alloc(bytesToRead);
          const readResult = await fileHandle.read(buffer, 0, bytesToRead, this.fileReadOffset);

          if (readResult.bytesRead > 0) {
            this.fileReadOffset += readResult.bytesRead;
            const chunkStr = buffer.subarray(0, readResult.bytesRead).toString("utf8");
            const combined = this.partialBuffer + chunkStr;

            // Split into lines while buffering incomplete trailing lines
            const lastNewlineIndex = combined.lastIndexOf("\n");

            if (lastNewlineIndex !== -1) {
              const completeSegment = combined.slice(0, lastNewlineIndex + 1);
              this.partialBuffer = combined.slice(lastNewlineIndex + 1);

              const lines = completeSegment.split("\n");
              if (lines.length > 0 && lines[lines.length - 1] === "") {
                lines.pop();
              }

              for (const line of lines) {
                const lineWithNewline = `${line}\n`;
                const lineByteLen = Buffer.byteLength(lineWithNewline, "utf8");
                this.committedOffset += lineByteLen;

                const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
                if (cleanLine.trim().length === 0) {
                  this.currentLine++;
                  continue;
                }

                this.currentSequence++;

                let parsedJson: unknown | undefined;
                try {
                  parsedJson = JSON.parse(cleanLine);
                } catch {
                  // Not valid JSON, keep as raw text
                }

                const checkpoint = createHash("sha256").update(cleanLine).digest("hex");

                const record: ParsedLineRecord = {
                  lineText: cleanLine,
                  parsedJson,
                  byteLength: lineByteLen,
                  cursor: {
                    offset: this.committedOffset,
                    line: this.currentLine,
                    sequence: this.currentSequence,
                    checkpoint,
                    timestamp: new Date().toISOString(),
                  },
                };

                this.currentLine++;
                emittedRecords.push(record);

                if (maxBatchSize && emittedRecords.length >= maxBatchSize) {
                  break;
                }
              }
            } else {
              // No newline found yet, retain in partialBuffer
              this.partialBuffer = combined;
            }
          }
        }
      } finally {
        await fileHandle.close();
      }

      if (emittedRecords.length > 0) {
        this.emit("lines", emittedRecords);
      }
    } catch (err: unknown) {
      this.emit("error", err);
    } finally {
      this.isReading = false;
      if (this.pendingRead) {
        this.pendingRead = false;
        void this.scheduleRead();
      }
    }

    return emittedRecords;
  }

  /**
   * Returns current cursor position.
   */
  getCursor(): SourceCursor {
    return {
      offset: this.committedOffset,
      line: this.currentLine,
      sequence: this.currentSequence,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Manually seeks to a specific offset and line position.
   */
  seek(offset: number, line = 1, sequence = 0): void {
    this.fileReadOffset = offset;
    this.committedOffset = offset;
    this.currentLine = line;
    this.currentSequence = sequence;
    this.partialBuffer = "";
  }

  /**
   * Returns the underlying recovery engine.
   */
  getRecoveryEngine(): SourceRecoveryEngine {
    return this.recoveryEngine;
  }
}
