import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type {
  HarnessSession,
  RawHarnessRecord,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { AuthRecoveryError } from "../auth-recovery.js";
import { getDaemonPaths } from "../paths.js";
import { SourceCursorManager } from "./cursor-manager.js";
import { RecordDeduplicator } from "./deduplicator.js";
import { BoundedRecordQueue, type DeadLetterRecord, type QueueMetrics } from "./queue.js";
import { type RecoveryAssessment, SourceRecoveryEngine } from "./recovery.js";
import { type ParsedLineRecord, TranscriptWatcher } from "./watcher.js";

/**
 * Historical backfill policy for new or resuming sessions.
 */
export type BackfillPolicy =
  | { mode: "all" }
  | { mode: "latest" }
  | { mode: "bounded_lines"; maxLines: number }
  | { mode: "bounded_bytes"; maxBytes: number }
  | { mode: "bounded_time"; maxAgeMs: number };

/**
 * Options for attaching a session to TranscriptTailer.
 */
export interface TailerSessionOptions {
  backfillPolicy?: BackfillPolicy;
  queueCapacity?: number;
  highWatermarkRatio?: number;
  lowWatermarkRatio?: number;
  maxBatchSize?: number;
  pollingIntervalMs?: number;
  workspaceId?: string;
  deviceId?: string;
}

/**
 * Per-session tailer tracking state.
 */
export interface TailerSessionContext {
  session: HarnessSession;
  source: SessionEventSource;
  watcher?: TranscriptWatcher;
  queue: BoundedRecordQueue;
  deduplicator: RecordDeduplicator;
  recovery: SourceRecoveryEngine;
  options: TailerSessionOptions;
  latestEmittedCursor: SourceCursor | null;
  latestAckedCursor: SourceCursor | null;
  hasInFlightBatch: boolean;
  isPaused: boolean;
  isAuthDegraded: boolean;
  isRestoringDurablePending: boolean;
  needsAuthRecoveryProbe: boolean;
  unsubscribeSource?: () => void;
  authRecoveryUnsubscribe?: () => void;
}
/**
 * Record delivery callback type providing downstream with records and an atomic ack function.
 */
export type TailerRecordHandler = (
  session: HarnessSession,
  records: RawHarnessRecord[],
  ack: () => Promise<void>,
) => void | Promise<void>;

/**
 * Overall status of a session inside the tailer.
 */
export interface TailerSessionStatus {
  sessionId: string;
  harnessId: string;
  transcriptPath: string;
  isPaused: boolean;
  isBackpressured: boolean;
  queueSize: number;
  deadLetterCount: number;
  isAuthDegraded: boolean;
  latestCursor: SourceCursor | null;
  ackedCursor: SourceCursor | null;
  durablePendingCount: number;
  persistenceHealthy: boolean;
}

/**
 * Options for TranscriptTailer constructor.
 */
export interface TranscriptTailerOptions {
  cursorManager?: SourceCursorManager;
  defaultBackfillPolicy?: BackfillPolicy;
  defaultBatchSize?: number;
  defaultQueueCapacity?: number;
  deviceId?: string;
  pendingStorageDirectory?: string | null;
  maxPendingBytes?: number;
}

/**
 * TranscriptTailer coordinates active SessionEventSource instances across discovered harness sessions,
 * managing per-source bounded queues, backpressure, deduplication, recovery, and durable checkpoints.
 */
export class TranscriptTailer extends EventEmitter {
  private readonly sessions = new Map<string, TailerSessionContext>();
  private readonly cursorManager: SourceCursorManager;
  private readonly defaultBackfillPolicy: BackfillPolicy;
  private readonly defaultBatchSize: number;
  private readonly defaultQueueCapacity: number;
  private readonly defaultDeviceId: string;
  private readonly pendingStorageDirectory: string | null;
  private readonly maxPendingBytes: number;

  private recordHandler?: TailerRecordHandler;
  private isClosed = false;

  constructor(options: TranscriptTailerOptions = {}) {
    super();
    this.cursorManager =
      options.cursorManager ?? new SourceCursorManager({ deviceId: options.deviceId });
    this.defaultBackfillPolicy = options.defaultBackfillPolicy ?? { mode: "all" };
    this.defaultBatchSize = options.defaultBatchSize ?? 50;
    this.defaultQueueCapacity = options.defaultQueueCapacity ?? 1000;
    this.defaultDeviceId = options.deviceId ?? "local-observer";
    this.pendingStorageDirectory =
      options.pendingStorageDirectory === undefined
        ? path.join(getDaemonPaths().stateDir, "auth-pending")
        : options.pendingStorageDirectory;
    this.maxPendingBytes = Math.max(1, options.maxPendingBytes ?? 32 * 1024 * 1024);
  }

  /**
   * Registers a subscriber callback for observing raw records with durable acknowledgement.
   */
  onRecords(handler: TailerRecordHandler): () => void {
    this.recordHandler = handler;
    for (const context of this.sessions.values()) {
      void this.dispatchQueue(context, context.needsAuthRecoveryProbe);
    }
    return () => {
      if (this.recordHandler === handler) {
        this.recordHandler = undefined;
      }
    };
  }

  /**
   * Attaches a session to be actively tailed.
   */
  async attachSession(
    session: HarnessSession,
    providedSource?: SessionEventSource,
    options: TailerSessionOptions = {},
  ): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot attach session to a closed TranscriptTailer");
    }

    if (this.sessions.has(session.sessionId)) {
      return;
    }

    // 1. Resolve starting cursor from CursorManager or calculate backfill
    let startCursor = await this.cursorManager.getCursor(session.sessionId);
    const policy = options.backfillPolicy ?? this.defaultBackfillPolicy;

    if (
      !startCursor &&
      policy.mode !== "all" &&
      session.transcriptPath &&
      fs.existsSync(session.transcriptPath)
    ) {
      startCursor = await this.computeBackfillCursor(session.transcriptPath, policy);
    }

    // 2. Initialize per-session components
    const authPendingFilePath = this.pendingStorageDirectory
      ? path.join(
          this.pendingStorageDirectory,
          `${createHash("sha256").update(session.sessionId).digest("hex")}.json`,
        )
      : undefined;
    const queue = new BoundedRecordQueue({
      sessionId: session.sessionId,
      capacity: options.queueCapacity ?? this.defaultQueueCapacity,
      highWatermarkRatio: options.highWatermarkRatio ?? 0.8,
      lowWatermarkRatio: options.lowWatermarkRatio ?? 0.2,
      authPendingFilePath,
      maxPendingBytes: this.maxPendingBytes,
    });

    const deduplicator = new RecordDeduplicator();
    const hasRestoredAuthPending = queue.hasDurablePending;
    if (hasRestoredAuthPending) {
      for (const record of queue.peek(queue.capacity)) {
        deduplicator.record(record);
      }
    }
    const recovery = new SourceRecoveryEngine();

    // 3. Create or adapt SessionEventSource
    let source: SessionEventSource;
    let watcher: TranscriptWatcher | undefined;

    if (providedSource) {
      source = providedSource;
      if (startCursor) {
        await source.checkpoint(startCursor);
      }
    } else {
      watcher = new TranscriptWatcher({
        filePath: session.transcriptPath,
        sessionId: session.sessionId,
        harnessId: session.harnessId,
        initialOffset: startCursor?.offset ?? 0,
        initialLine: startCursor?.line ?? 1,
        initialSequence: startCursor?.sequence ?? 0,
        pollingIntervalMs: options.pollingIntervalMs ?? 100,
        autoStart: false,
      });

      source = this.createWatcherEventSource(session, watcher);
    }

    const context: TailerSessionContext = {
      session,
      source,
      watcher,
      queue,
      deduplicator,
      recovery,
      options,
      latestEmittedCursor: startCursor,
      latestAckedCursor: startCursor,
      hasInFlightBatch: false,
      isPaused: queue.isPaused,
      isAuthDegraded: hasRestoredAuthPending,
      isRestoringDurablePending: hasRestoredAuthPending,
      needsAuthRecoveryProbe: hasRestoredAuthPending,
    };

    queue.on("resume", () => {
      context.isPaused = false;
      if (!context.isRestoringDurablePending) {
        watcher?.resume();
      }
      this.emit("backpressure:resume", { sessionId: session.sessionId });
      void this.dispatchQueue(context);
      if (!context.isRestoringDurablePending) {
        void this.pumpSession(session.sessionId);
      }
    });

    queue.on("deadLetter", (dl: DeadLetterRecord) => {
      this.emit("deadLetter", { sessionId: session.sessionId, deadLetter: dl });
    });

    queue.on("persistenceFailure", (failure: { reason: string }) => {
      this.emit("persistence:failure", {
        sessionId: session.sessionId,
        reason: failure.reason,
      });
    });

    // 5. Hook up event source listener
    const unsubscribe = source.onRecords((records) => {
      void this.handleIncomingRecords(context, records);
    });
    context.unsubscribeSource = unsubscribe;

    this.sessions.set(session.sessionId, context);
    if (watcher) {
      if (context.isPaused) {
        watcher.pause();
      }
      watcher.start();
    }
    this.emit("session:attached", { sessionId: session.sessionId });

    // Probe restored authentication locally before replay, while keeping the source paused.
    void this.dispatchQueue(context, context.needsAuthRecoveryProbe);
    if (!context.isPaused && !context.isRestoringDurablePending) {
      void this.pumpSession(session.sessionId);
    }
  }

  /**
   * Adapts a TranscriptWatcher into a SessionEventSource.
   */
  private createWatcherEventSource(
    session: HarnessSession,
    watcher: TranscriptWatcher,
  ): SessionEventSource {
    const listeners = new Set<(records: RawHarnessRecord[]) => void | Promise<void>>();

    watcher.onLines((lines: ParsedLineRecord[]) => {
      const rawRecords: RawHarnessRecord[] = lines.map((l) => {
        let recordType: RecordType = "transcript_line";
        if (l.parsedJson && typeof l.parsedJson === "object" && "type" in l.parsedJson) {
          const typeVal = l.parsedJson.type;
          if (typeof typeVal === "string") {
            recordType = typeVal as RecordType;
          }
        }
        return {
          recordId: randomUUID(),
          sessionId: session.sessionId,
          harnessId: session.harnessId,
          sequenceNumber: l.cursor.sequence,
          timestamp: l.cursor.timestamp,
          recordType,
          rawPayload: l.parsedJson ?? l.lineText,
          cursor: l.cursor,
          metadata: {
            byteLength: l.byteLength,
          },
        };
      });

      for (const listener of listeners) {
        void listener(rawRecords);
      }
    });

    return {
      async readNext(batchSize?: number): Promise<RawHarnessRecord[]> {
        const lines = await watcher.readNext(batchSize);
        return lines.map((l) => ({
          recordId: randomUUID(),
          sessionId: session.sessionId,
          harnessId: session.harnessId,
          sequenceNumber: l.cursor.sequence,
          timestamp: l.cursor.timestamp,
          recordType: "transcript_line",
          rawPayload: l.parsedJson ?? l.lineText,
          cursor: l.cursor,
          metadata: { byteLength: l.byteLength },
        }));
      },
      onRecords(callback: (records: RawHarnessRecord[]) => void | Promise<void>): () => void {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      async checkpoint(cursor: SourceCursor): Promise<void> {
        watcher.seek(cursor.offset, cursor.line, cursor.sequence);
      },
      getCursor(): SourceCursor | null {
        return watcher.getCursor();
      },
      async detectRotation(): Promise<boolean> {
        const assessment = await watcher
          .getRecoveryEngine()
          .probe(watcher.filePath, watcher.getCursor().offset, watcher.getCursor().line);
        return assessment.condition === "rotated" || assessment.condition === "truncated";
      },
      async close(): Promise<void> {
        watcher.stop();
        listeners.clear();
      },
    };
  }

  /**
   * Computes a starting cursor based on a backfill policy.
   */
  private async computeBackfillCursor(
    filePath: string,
    policy: BackfillPolicy,
  ): Promise<SourceCursor | null> {
    try {
      const stat = await fs.promises.stat(filePath);

      if (policy.mode === "latest") {
        return {
          offset: stat.size,
          line: 1,
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
      }

      if (policy.mode === "bounded_bytes") {
        const startOffset = Math.max(0, stat.size - policy.maxBytes);
        return {
          offset: startOffset,
          line: 1,
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
      }

      if (policy.mode === "bounded_lines") {
        const content = await fs.promises.readFile(filePath, "utf8");
        const allLines = content.split("\n");
        if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
          allLines.pop();
        }

        const skipLines = Math.max(0, allLines.length - policy.maxLines);
        let offset = 0;
        for (let i = 0; i < skipLines; i++) {
          offset += Buffer.byteLength(`${allLines[i]}\n`, "utf8");
        }

        return {
          offset,
          line: skipLines + 1,
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Ingests newly arrived records, filters duplicates, pushes to per-session queue,
   * and triggers dispatch downstream.
   */
  private async handleIncomingRecords(
    context: TailerSessionContext,
    incoming: RawHarnessRecord[],
  ): Promise<void> {
    if (incoming.length === 0) return;

    // Filter duplicates
    const freshRecords = context.deduplicator.filterNew(incoming);
    if (freshRecords.length === 0) return;

    // Enqueue to isolated queue
    context.queue.enqueueBatch(freshRecords);

    // Pump delivery downstream
    await this.dispatchQueue(context);
  }

  /**
   * Pumps records from the session queue to the downstream subscriber.
   */
  private async dispatchQueue(
    context: TailerSessionContext,
    allowAuthRecoveryProbe = false,
  ): Promise<void> {
    const isAuthRecoveryProbe =
      context.isAuthDegraded && context.needsAuthRecoveryProbe && allowAuthRecoveryProbe;
    if (
      !this.recordHandler ||
      context.queue.size === 0 ||
      context.hasInFlightBatch ||
      (context.isAuthDegraded && !isAuthRecoveryProbe)
    ) {
      return;
    }

    const batchSize = context.options.maxBatchSize ?? this.defaultBatchSize;
    const batch = context.queue.dequeue(batchSize);
    if (batch.length === 0) return;

    context.hasInFlightBatch = true;
    const latestInBatch = batch[batch.length - 1];
    if (!isAuthRecoveryProbe) {
      context.latestEmittedCursor = latestInBatch.cursor;
    }

    // Create durable ack closure
    const ack = async () => {
      // 1. Mark in queue as acknowledged
      context.queue.ack(batch.map((r) => r.recordId));

      // 2. Commit atomic cursor to SQLite
      await this.cursorManager.commitCheckpoint(context.session.sessionId, latestInBatch.cursor, {
        workspaceId: context.options.workspaceId ?? context.session.workspaceId,
        deviceId: context.options.deviceId ?? this.defaultDeviceId,
      });

      // 3. Notify event source of committed checkpoint
      await context.source.checkpoint(latestInBatch.cursor);
      context.latestAckedCursor = latestInBatch.cursor;
      context.hasInFlightBatch = false;

      if (context.isRestoringDurablePending && !context.queue.hasDurablePending) {
        context.isRestoringDurablePending = false;
        if (!context.isAuthDegraded && !context.queue.isPaused) {
          context.isPaused = false;
          context.watcher?.resume();
          void this.pumpSession(context.session.sessionId);
        }
      }

      // 4. Continue draining remaining items
      if (context.queue.size > 0) {
        void this.dispatchQueue(context);
      }
    };

    try {
      await this.recordHandler(context.session, batch, ack);
      if (isAuthRecoveryProbe) {
        context.needsAuthRecoveryProbe = false;
        context.isAuthDegraded = false;
        context.latestEmittedCursor = latestInBatch.cursor;
        this.emit("auth:recovered", {
          sessionId: context.session.sessionId,
          pendingCount: context.queue.pendingCount,
        });
        context.queue.resume();
        void this.dispatchQueue(context);
      }
    } catch (err: unknown) {
      context.hasInFlightBatch = false;
      if (err instanceof AuthRecoveryError) {
        const persisted = context.queue.deferForAuthentication(
          batch.map((record) => record.recordId),
        );
        context.isPaused = true;
        context.isAuthDegraded = true;
        context.needsAuthRecoveryProbe = false;
        context.watcher?.pause();
        context.authRecoveryUnsubscribe?.();
        context.authRecoveryUnsubscribe = err.onRecovered(() => {
          if (this.isClosed || this.sessions.get(context.session.sessionId) !== context) {
            return;
          }
          context.authRecoveryUnsubscribe = undefined;
          context.isAuthDegraded = false;
          this.emit("auth:recovered", {
            sessionId: context.session.sessionId,
            pendingCount: context.queue.pendingCount,
          });
          context.queue.resume();
          void this.dispatchQueue(context);
        });
        this.emit("auth:degraded", {
          sessionId: context.session.sessionId,
          category: err.category,
          remediation: err.remediation,
          pendingCount: context.queue.pendingCount,
          persisted,
        });
        return;
      }

      if (isAuthRecoveryProbe) {
        context.queue.deferForAuthentication(batch.map((record) => record.recordId));
        context.isPaused = true;
        context.needsAuthRecoveryProbe = true;
        context.watcher?.pause();
        return;
      }

      for (const record of batch) {
        context.queue.nack(
          record.recordId,
          err instanceof Error ? err : String(err),
          "UNHANDLED_ERROR",
        );
      }
    }
  }

  /**
   * Actively pulls records from event source if queue has available capacity.
   */
  async pumpSession(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (
      !context ||
      context.isPaused ||
      context.isAuthDegraded ||
      context.isRestoringDurablePending ||
      this.isClosed
    ) {
      return;
    }

    try {
      if (context.queue.size < context.queue.highWatermark) {
        const records = await context.source.readNext(
          context.options.maxBatchSize ?? this.defaultBatchSize,
        );
        if (records.length > 0) {
          await this.handleIncomingRecords(context, records);
        }
      }
    } catch (err: unknown) {
      this.emit("error", { sessionId, error: err });
    }
  }

  /**
   * Pauses tailing for a specific session.
   */
  pauseSession(sessionId: string): void {
    const context = this.sessions.get(sessionId);
    if (context) {
      context.queue.pause();
    }
  }

  /**
   * Resumes tailing for a specific session.
   */
  resumeSession(sessionId: string): void {
    const context = this.sessions.get(sessionId);
    if (context && !context.isAuthDegraded) {
      context.queue.resume();
    }
  }

  /**
   * Detaches and closes a session.
   */
  async detachSession(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (!context) return;

    context.authRecoveryUnsubscribe?.();
    if (context.unsubscribeSource) {
      context.unsubscribeSource();
    }

    await context.source.close();
    context.queue.clear(true);
    context.deduplicator.clear();

    this.sessions.delete(sessionId);
    this.emit("session:detached", { sessionId });
  }

  /**
   * Returns list of currently active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Returns status diagnostics for a session.
   */
  getSessionStatus(sessionId: string): TailerSessionStatus | null {
    const context = this.sessions.get(sessionId);
    if (!context) return null;
    const queueMetrics = context.queue.getMetrics();
    return {
      sessionId: context.session.sessionId,
      harnessId: context.session.harnessId,
      transcriptPath: context.session.transcriptPath,
      isPaused: context.isPaused,
      isBackpressured: context.queue.isBackpressured,
      isAuthDegraded: context.isAuthDegraded,
      queueSize: context.queue.size,
      deadLetterCount: context.queue.getDeadLetters().length,
      latestCursor: context.latestEmittedCursor,
      ackedCursor: context.latestAckedCursor,
      durablePendingCount: queueMetrics.durablePendingCount,
      persistenceHealthy: queueMetrics.persistenceHealthy,
    };
  }

  /**
   * Returns the cursor manager instance.
   */
  getCursorManager(): SourceCursorManager {
    return this.cursorManager;
  }

  /**
   * Closes the tailer and all attached sessions.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.detachSession(sessionId);
    }
    this.sessions.clear();
    this.removeAllListeners();
  }
}
