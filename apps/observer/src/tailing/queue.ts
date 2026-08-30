import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { type RawHarnessRecord, RawHarnessRecordSchema } from "@resin/harness-contracts";

/**
 * Classification reasons for routing a raw record to the Dead Letter Queue.
 */
export type DeadLetterReason =
  | "MALFORMED_RECORD"
  | "PAYLOAD_TOO_LARGE"
  | "PROCESSING_TIMEOUT"
  | "RETRY_EXHAUSTED"
  | "CORRUPT_JSON"
  | "UNHANDLED_ERROR";

/**
 * Structure of a record routed to the Dead Letter Queue.
 */
export interface DeadLetterRecord {
  record: RawHarnessRecord;
  reason: DeadLetterReason;
  error?: string;
  failedAt: string;
  retryAttempts: number;
}

export interface EnqueueBatchResult {
  accepted: number;
  rejected: number;
  backpressured: boolean;
}

/**
 * Metrics describing the state of a BoundedRecordQueue.
 */
export interface QueueMetrics {
  sessionId: string;
  size: number;
  capacity: number;
  highWatermark: number;
  lowWatermark: number;
  isBackpressured: boolean;
  isPaused: boolean;
  enqueuedTotal: number;
  dequeuedTotal: number;
  ackedTotal: number;
  nackedTotal: number;
  deadLetterCount: number;
  droppedTotal: number;
  durablePendingCount: number;
  persistenceHealthy: boolean;
}

/**
 * Options for configuring BoundedRecordQueue.
 */
export interface BoundedRecordQueueOptions {
  sessionId: string;
  /**
   * Maximum number of raw records allowed in queue before dropping or blocking.
   * Defaults to 1000.
   */
  capacity?: number;
  /**
   * High watermark ratio or absolute count to trigger backpressure pause.
   * Defaults to 0.8 (80% of capacity).
   */
  highWatermarkRatio?: number;
  /**
   * Low watermark ratio or absolute count to trigger backpressure resume.
   * Defaults to 0.2 (20% of capacity).
   */
  lowWatermarkRatio?: number;
  /**
   * Maximum retry attempts before routing a nack'd record to DLQ.
   * Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Drop policy when capacity is strictly exceeded: "reject" | "drop_oldest".
   * Defaults to "reject".
   */
  dropPolicy?: "reject" | "drop_oldest";
  /**
   * Secure file used only while authentication-degraded records require durable replay.
   */
  authPendingFilePath?: string;
  /**
   * Maximum serialized durable pending bytes. Defaults to 32 MiB.
   */
  maxPendingBytes?: number;
}

/**
 * Per-source bounded raw-record queue with backpressure, pause/resume signaling,
 * retry tracking, and dead-letter classification.
 */
export class BoundedRecordQueue extends EventEmitter {
  readonly sessionId: string;
  readonly capacity: number;
  readonly highWatermark: number;
  readonly lowWatermark: number;
  readonly maxRetries: number;
  readonly dropPolicy: "reject" | "drop_oldest";

  private queue: RawHarnessRecord[] = [];
  private inFlight = new Map<string, RawHarnessRecord>();
  private attemptCounts = new Map<string, number>();
  private deadLetters: DeadLetterRecord[] = [];

  private _isBackpressured = false;
  private _isPaused = false;
  private durablePendingActive = false;
  private persistenceHealthy = true;
  private pendingPathTrusted = true;
  private pendingFileIdentity: string | null = null;

  private enqueuedTotal = 0;
  private dequeuedTotal = 0;
  private ackedTotal = 0;
  private nackedTotal = 0;
  private droppedTotal = 0;

  private readonly authPendingFilePath?: string;
  private readonly maxPendingBytes: number;

  constructor(options: BoundedRecordQueueOptions) {
    super();
    this.sessionId = options.sessionId;
    this.capacity = options.capacity ?? 1000;
    this.highWatermark = Math.max(
      1,
      Math.floor(this.capacity * (options.highWatermarkRatio ?? 0.8)),
    );
    this.lowWatermark = Math.max(0, Math.floor(this.capacity * (options.lowWatermarkRatio ?? 0.2)));
    this.maxRetries = options.maxRetries ?? 3;
    this.dropPolicy = options.dropPolicy ?? "reject";
    this.authPendingFilePath = options.authPendingFilePath;
    this.maxPendingBytes = Math.max(1, options.maxPendingBytes ?? 32 * 1024 * 1024);
    this.restoreDurablePending();
  }

  /**
   * Current number of queued (pending) records.
   */
  get size(): number {
    return this.queue.length;
  }

  get pendingCount(): number {
    return this.queue.length + this.inFlight.size;
  }

  /**
   * Whether the queue is currently in a backpressured state.
   */
  get isBackpressured(): boolean {
    return this._isBackpressured;
  }

  /**
   * Whether the upstream source should be paused.
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Whether pending records are backed by the authentication-recovery snapshot.
   */
  get hasDurablePending(): boolean {
    return this.durablePendingActive;
  }

  /**
   * Enqueues a single record. Returns true if accepted, false if rejected due to full capacity.
   */
  enqueue(record: RawHarnessRecord): boolean {
    if (this.pendingCount >= this.capacity) {
      if (this.dropPolicy === "drop_oldest" && this.queue.length > 0) {
        this.queue.shift();
        this.droppedTotal++;
      } else {
        this.droppedTotal++;
        return false;
      }
    }

    this.queue.push(record);
    this.enqueuedTotal++;
    if (this.durablePendingActive) {
      this.persistDurablePending();
    }

    this.checkWatermarks();
    return true;
  }

  /**
   * Enqueues a batch of records. Returns count of accepted vs rejected records.
   */
  enqueueBatch(records: RawHarnessRecord[]): EnqueueBatchResult {
    let accepted = 0;
    let rejected = 0;

    for (const record of records) {
      if (this.enqueue(record)) {
        accepted++;
      } else {
        rejected++;
      }
    }

    return {
      accepted,
      rejected,
      backpressured: this._isBackpressured,
    };
  }

  /**
   * Dequeues up to maxBatchSize records for downstream processing and tracks them as in-flight.
   */
  dequeue(maxBatchSize = 100): RawHarnessRecord[] {
    const batch = this.queue.splice(0, maxBatchSize);
    for (const record of batch) {
      this.inFlight.set(record.recordId, record);
      this.dequeuedTotal++;
    }

    this.checkWatermarks();
    return batch;
  }

  /**
   * Peeks at the next records in queue without removing or marking in-flight.
   */
  peek(maxBatchSize = 100): RawHarnessRecord[] {
    return this.queue.slice(0, maxBatchSize);
  }

  /**
   * Acknowledges successful downstream processing of records.
   */
  ack(recordIds: string | string[]): void {
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
    for (const id of ids) {
      if (!this.inFlight.delete(id)) {
        continue;
      }
      this.attemptCounts.delete(id);
      this.ackedTotal++;
    }

    if (this.durablePendingActive) {
      if (this.pendingCount === 0) {
        this.clearDurablePending();
        this.durablePendingActive = false;
      } else {
        this.persistDurablePending();
      }
    }
    this.checkWatermarks();
  }

  /**
   * Returns an authentication-rejected in-flight batch to the head of the queue and durably
   * snapshots every pending record before cloud delivery is paused.
   */
  deferForAuthentication(recordIds: string[]): boolean {
    const deferred: RawHarnessRecord[] = [];
    for (const recordId of recordIds) {
      const record = this.inFlight.get(recordId);
      if (!record) {
        continue;
      }
      deferred.push(record);
      this.inFlight.delete(recordId);
    }
    if (deferred.length === 0) {
      return this.persistenceHealthy;
    }

    const deferredIds = new Set(deferred.map((record) => record.recordId));
    this.queue = [...deferred, ...this.queue.filter((record) => !deferredIds.has(record.recordId))];
    this.durablePendingActive = true;
    this.pause();
    const persisted = this.persistDurablePending();
    this.checkWatermarks();
    this.emit("authDeferred", {
      sessionId: this.sessionId,
      pendingCount: this.pendingCount,
      persisted,
    });
    return persisted;
  }

  /**
   * Rejects a record. Increments retry attempts; if maxRetries is exceeded,
   * routes to Dead Letter Queue. Otherwise re-queues at head of queue.
   */
  nack(recordId: string, error?: Error | string, forcedReason?: DeadLetterReason): void {
    this.nackedTotal++;
    const record = this.inFlight.get(recordId);
    this.inFlight.delete(recordId);

    const attempts = (this.attemptCounts.get(recordId) ?? 0) + 1;
    this.attemptCounts.set(recordId, attempts);
    const errorMessage =
      error instanceof Error ? error.message : (error ?? "Unknown processing error");

    if (!record) {
      return;
    }

    if (forcedReason || attempts >= this.maxRetries) {
      const reason: DeadLetterReason =
        forcedReason ?? (attempts >= this.maxRetries ? "RETRY_EXHAUSTED" : "UNHANDLED_ERROR");
      const deadLetter: DeadLetterRecord = {
        record,
        reason,
        error: errorMessage,
        failedAt: new Date().toISOString(),
        retryAttempts: attempts,
      };

      this.deadLetters.push(deadLetter);
      this.attemptCounts.delete(recordId);
      this.emit("deadLetter", deadLetter);
    } else {
      this.queue.unshift(record);
    }

    if (this.durablePendingActive) {
      if (this.pendingCount === 0) {
        this.clearDurablePending();
        this.durablePendingActive = false;
      } else {
        this.persistDurablePending();
      }
    }
    this.checkWatermarks();
  }

  /**
   * Inspects and triggers watermark events (pause / resume).
   */
  private checkWatermarks(): void {
    const pendingCount = this.pendingCount;
    if (!this._isBackpressured && pendingCount >= this.highWatermark) {
      this._isBackpressured = true;
      this._isPaused = true;
      this.emit("pause", {
        sessionId: this.sessionId,
        queueSize: pendingCount,
        highWatermark: this.highWatermark,
      });
    } else if (this._isBackpressured && pendingCount <= this.lowWatermark) {
      this._isBackpressured = false;
      this._isPaused = false;
      this.emit("resume", {
        sessionId: this.sessionId,
        queueSize: pendingCount,
        lowWatermark: this.lowWatermark,
      });
    }
  }

  /**
   * Manually pause upstream reading.
   */
  pause(): void {
    this._isPaused = true;
    this.emit("pause", { sessionId: this.sessionId, queueSize: this.queue.length, manual: true });
  }

  /**
   * Manually resume upstream reading (if watermark allows).
   */
  resume(): void {
    if (this.pendingCount < this.highWatermark) {
      this._isPaused = false;
      this._isBackpressured = false;
      this.emit("resume", {
        sessionId: this.sessionId,
        queueSize: this.pendingCount,
        manual: true,
      });
    }
  }

  /**
   * Returns copy of all dead-letter records.
   */
  getDeadLetters(): DeadLetterRecord[] {
    return [...this.deadLetters];
  }

  /**
   * Retries a dead-letter record by re-inserting it into queue and clearing its DLQ entry.
   */
  retryDeadLetter(recordId: string): boolean {
    const index = this.deadLetters.findIndex((dl) => dl.record.recordId === recordId);
    if (index === -1) return false;

    const [dl] = this.deadLetters.splice(index, 1);
    this.attemptCounts.delete(recordId);
    this.queue.push(dl.record);
    this.checkWatermarks();
    return true;
  }

  /**
   * Clears the dead-letter records.
   */
  clearDeadLetters(): void {
    this.deadLetters.length = 0;
  }

  /**
   * Clears all queued, in-flight, and dead-letter records.
   */
  clear(preserveDurable = false): void {
    if (!preserveDurable && this.durablePendingActive) {
      this.clearDurablePending();
      this.durablePendingActive = false;
    }
    this.queue.length = 0;
    this.inFlight.clear();
    this.attemptCounts.clear();
    this.deadLetters.length = 0;
    this._isBackpressured = false;
    this._isPaused = false;
  }

  private restoreDurablePending(): void {
    const pendingPath = this.authPendingFilePath;
    if (!pendingPath) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(pendingPath);
    } catch (error) {
      // SAFETY: fs.lstatSync error exposes standard Node.js ErrnoException code.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      this.markPersistenceFailure("read_failed");
      return;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxPendingBytes) {
      this.pendingPathTrusted = false;
      this.markPersistenceFailure("unexpected_path");
      return;
    }

    try {
      // SAFETY: Reads and parses pending serialized JSON state from disk.
      const parsed = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as {
        version?: unknown;
        sessionId?: unknown;
        records?: unknown;
      };
      if (
        parsed.version !== 1 ||
        parsed.sessionId !== this.sessionId ||
        !Array.isArray(parsed.records) ||
        parsed.records.length > this.capacity
      ) {
        this.pendingPathTrusted = false;
        this.markPersistenceFailure("invalid_state");
        return;
      }

      const restored: RawHarnessRecord[] = [];
      for (const candidate of parsed.records) {
        const result = RawHarnessRecordSchema.safeParse(candidate);
        if (!result.success || result.data.sessionId !== this.sessionId) {
          this.pendingPathTrusted = false;
          this.markPersistenceFailure("invalid_state");
          return;
        }
        restored.push(result.data);
      }

      this.pendingFileIdentity = `${stat.dev}:${stat.ino}`;
      fs.chmodSync(pendingPath, 0o600);
      if (restored.length > 0) {
        this.queue = restored;
        this.durablePendingActive = true;
        this._isPaused = true;
        this.checkWatermarks();
      }
    } catch {
      this.pendingPathTrusted = false;
      this.markPersistenceFailure("invalid_state");
    }
  }

  private persistDurablePending(): boolean {
    const pendingPath = this.authPendingFilePath;
    if (!pendingPath || !this.pendingPathTrusted) {
      this.markPersistenceFailure(pendingPath ? "unexpected_path" : "not_configured");
      return false;
    }

    const records = [...this.inFlight.values(), ...this.queue];
    const serialized = JSON.stringify({
      version: 1,
      sessionId: this.sessionId,
      records,
    });
    if (Buffer.byteLength(serialized, "utf8") > this.maxPendingBytes) {
      this.markPersistenceFailure("capacity_exceeded");
      return false;
    }

    const parentDirectory = path.dirname(pendingPath);
    const temporaryPath = `${pendingPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      fs.mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
      fs.chmodSync(parentDirectory, 0o700);

      if (fs.existsSync(pendingPath)) {
        const existing = fs.lstatSync(pendingPath);
        const identity = `${existing.dev}:${existing.ino}`;
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          this.pendingFileIdentity === null ||
          identity !== this.pendingFileIdentity
        ) {
          this.pendingPathTrusted = false;
          this.markPersistenceFailure("unexpected_path");
          return false;
        }
      } else if (this.pendingFileIdentity !== null) {
        this.pendingFileIdentity = null;
      }

      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, pendingPath);
      fs.chmodSync(pendingPath, 0o600);
      if (process.platform !== "win32") {
        let directoryDescriptor: number | null = null;
        try {
          directoryDescriptor = fs.openSync(parentDirectory, "r");
          fs.fsyncSync(directoryDescriptor);
        } catch {
          // Some filesystems do not support directory fsync; the file itself is already synced.
        } finally {
          if (directoryDescriptor !== null) {
            fs.closeSync(directoryDescriptor);
          }
        }
      }
      const installed = fs.lstatSync(pendingPath);
      this.pendingFileIdentity = `${installed.dev}:${installed.ino}`;
      this.persistenceHealthy = true;
      return true;
    } catch {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The original persistence failure is the actionable signal.
        }
      }
      try {
        const temporaryStat = fs.lstatSync(temporaryPath);
        if (temporaryStat.isFile() && !temporaryStat.isSymbolicLink()) {
          fs.unlinkSync(temporaryPath);
        }
      } catch {
        // Missing or replaced temporary paths are deliberately left untouched.
      }
      this.markPersistenceFailure("write_failed");
      return false;
    }
  }

  private clearDurablePending(): boolean {
    const pendingPath = this.authPendingFilePath;
    if (!pendingPath || !this.pendingPathTrusted) {
      return false;
    }

    try {
      const stat = fs.lstatSync(pendingPath);
      const identity = `${stat.dev}:${stat.ino}`;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        this.pendingFileIdentity === null ||
        identity !== this.pendingFileIdentity
      ) {
        this.pendingPathTrusted = false;
        this.markPersistenceFailure("unexpected_path");
        return false;
      }
      fs.unlinkSync(pendingPath);
      this.pendingFileIdentity = null;
      this.persistenceHealthy = true;
      return true;
    } catch (error) {
      // SAFETY: fs.unlinkSync error exposes standard Node.js ErrnoException code.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      this.markPersistenceFailure("delete_failed");
      return false;
    }
  }

  private markPersistenceFailure(reason: string): void {
    this.persistenceHealthy = false;
    this.emit("persistenceFailure", {
      sessionId: this.sessionId,
      reason,
    });
  }
  /**
   * Returns current queue diagnostics and telemetry metrics.
   */
  getMetrics(): QueueMetrics {
    return {
      sessionId: this.sessionId,
      size: this.queue.length,
      capacity: this.capacity,
      highWatermark: this.highWatermark,
      lowWatermark: this.lowWatermark,
      isBackpressured: this._isBackpressured,
      isPaused: this._isPaused,
      enqueuedTotal: this.enqueuedTotal,
      dequeuedTotal: this.dequeuedTotal,
      ackedTotal: this.ackedTotal,
      nackedTotal: this.nackedTotal,
      deadLetterCount: this.deadLetters.length,
      droppedTotal: this.droppedTotal,
      durablePendingCount: this.durablePendingActive ? this.pendingCount : 0,
      persistenceHealthy: this.persistenceHealthy,
    };
  }
}
