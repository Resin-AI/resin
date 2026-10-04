import { randomUUID } from "node:crypto";
import type { InvocationRecord } from "@resin/contracts";
import type { AuditRepository } from "@resin/db";
import { ProtocolError } from "@resin/protocol";
import { ResourceForbiddenError } from "../auth-recovery.js";
import type { CloudObservationClient } from "../cloud-runtime.js";
import type { Logger } from "../lifecycle.js";

// Resin Cloud's telemetry schema guard rejects the whole batch with HTTP 400 when an
// invocation's error type exceeds 64 characters, its message exceeds 128, or it carries a stack.
const MAX_ERROR_TYPE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 128;

function toWireInvocation(record: InvocationRecord): InvocationRecord {
  if (!record.errorDetails) {
    return record;
  }
  const { errorType, message, reason } = record.errorDetails;
  return {
    ...record,
    errorDetails: {
      errorType: errorType.slice(0, MAX_ERROR_TYPE_LENGTH),
      message:
        message.length > MAX_ERROR_MESSAGE_LENGTH
          ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
          : message,
      ...(reason ? { reason } : {}),
    },
  };
}

/** A 4xx other than auth/rate-limit: resending the same batch can never succeed. */
function isPermanentRejection(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === "validation" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** First retry delay for a workspace the cloud refuses; doubles per refusal up to the cap. */
const REFUSAL_BACKOFF_BASE_MS = 15 * 60_000;
const REFUSAL_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/**
 * Options for configuring InvocationTelemetryUploader.
 */
export interface InvocationTelemetryUploaderOptions {
  readonly auditRepository: AuditRepository;
  readonly cloudClient: CloudObservationClient;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly logger?: Logger;
  /** Clock for backoff decisions; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Background uploader periodically reading pending invocation records from local state store
 * and transmitting them to the paired Resin Cloud origin via POST /v1/telemetry/batch.
 */
export class InvocationTelemetryUploader {
  private readonly auditRepository: AuditRepository;
  private readonly cloudClient: CloudObservationClient;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger?: Logger;
  private readonly now: () => number;
  /** Workspaces the cloud refused, and when each may be tried again. */
  private readonly refusals = new Map<string, { retryAtMs: number }>();
  /** Consecutive refusals per workspace; drives the backoff delay. */
  private readonly refusalAttempts = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isFlushing = false;

  constructor(options: InvocationTelemetryUploaderOptions) {
    this.auditRepository = options.auditRepository;
    this.cloudClient = options.cloudClient;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 200;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts periodic upload timer.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.timer = setInterval(() => {
      void this.flushOnce().catch((error) => {
        this.logger?.error("Unhandled error during invocation telemetry flush", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops periodic upload timer.
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Performs a single upload cycle:
   * 1. Reads up to `batchSize` pending invocation records (where uploaded_at IS NULL).
   * 2. Groups them by `workspaceId`.
   * 3. Dispatches one telemetry batch request per workspace to Resin Cloud.
   * 4. Marks accepted/partial records as uploaded in the audit repository.
   * 5. A batch the cloud refuses with 403 (a workspace not linked to the account, or tools the
   *    cloud does not know) leaves its rows pending and puts that workspace on a growing backoff:
   *    no dead letter, no repeated warning. A payload it will never accept (other 4xx) is
   *    dead-lettered after that one attempt, never retried; one summary line per cycle reports
   *    every such batch.
   * 6. Any other failure leaves records pending for the next cycle.
   */
  async flushOnce(): Promise<{ uploaded: number }> {
    if (this.isFlushing) {
      return { uploaded: 0 };
    }
    this.isFlushing = true;

    try {
      const nowMs = this.now();
      for (const [workspaceId, refusal] of this.refusals) {
        if (refusal.retryAtMs <= nowMs) this.refusals.delete(workspaceId);
      }
      // A workspace the cloud refused stays out of the listing until its backoff elapses, so its
      // backlog cannot starve healthy workspaces and is not retired.
      const pending = this.auditRepository.listPendingInvocationUploads(this.batchSize, [
        ...this.refusals.keys(),
      ]);
      if (pending.length === 0) {
        return { uploaded: 0 };
      }

      // Group records by workspaceId
      const byWorkspace = new Map<string, InvocationRecord[]>();
      for (const record of pending) {
        const group = byWorkspace.get(record.workspaceId) ?? [];
        group.push(record);
        byWorkspace.set(record.workspaceId, group);
      }

      let totalUploaded = 0;
      // One batch per workspace per cycle, so `batches` is also the number of workspaces refused.
      const refused = { batches: 0, records: 0, errors: [] as string[] };

      for (const [workspaceId, invocations] of byWorkspace.entries()) {
        try {
          // `workspaceId` here is the daemon's local workspace identifier, which the
          // cloud has never seen; the batch is addressed to the paired cloud
          // workspace (the client's identity), which the cloud enforces with a 403.
          const response = await this.cloudClient.sendTelemetryBatch({
            invocations: invocations.map(toWireInvocation),
          });
          this.refusals.delete(workspaceId);
          this.refusalAttempts.delete(workspaceId);

          if (response.status === "accepted" || response.status === "partial") {
            const uploadedAt = new Date().toISOString();
            const ids = invocations.map((inv) => inv.invocationId);
            this.auditRepository.markInvocationsUploaded(ids, uploadedAt);
            totalUploaded += invocations.length;
          } else {
            this.logger?.warn("Telemetry batch rejected by cloud", {
              workspaceId,
              batchId: response.batchId,
              status: response.status,
            });
          }
        } catch (error) {
          if (error instanceof ResourceForbiddenError) {
            this.backOffRefusedWorkspace(workspaceId, invocations.length, error.message, nowMs);
          } else if (isPermanentRejection(error)) {
            const reason = error instanceof Error ? error.message : String(error);
            this.deadLetter(workspaceId, invocations, reason);
            refused.batches += 1;
            refused.records += invocations.length;
            if (!refused.errors.includes(reason)) refused.errors.push(reason);
          } else {
            this.logger?.warn("Failed to upload invocation telemetry batch for workspace", {
              workspaceId,
              count: invocations.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (refused.batches > 0) {
        this.logger?.warn(
          "Invocation telemetry refused by cloud; dead-lettered without retry",
          refused,
        );
      }

      return { uploaded: totalUploaded };
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * A 403 means the paired cloud does not accept this workspace's telemetry: it is not linked to
   * the account, or its tools are unknown to the cloud (fixture and test workspaces). The rows
   * stay pending, not dead-lettered, and the workspace is left alone for a growing interval, so
   * it costs one request per interval rather than one per flush. The first refusal in this
   * process is reported once; repeats are debug lines.
   */
  private backOffRefusedWorkspace(
    workspaceId: string,
    count: number,
    reason: string,
    nowMs: number,
  ): void {
    const previous = this.refusalAttempts.get(workspaceId) ?? 0;
    const delayMs = Math.min(REFUSAL_BACKOFF_BASE_MS * 2 ** previous, REFUSAL_BACKOFF_MAX_MS);
    this.refusalAttempts.set(workspaceId, previous + 1);
    this.refusals.set(workspaceId, { retryAtMs: nowMs + delayMs });
    const meta = { workspaceId, pendingRecords: count, retryInMs: delayMs, reason };
    if (previous === 0) {
      this.logger?.info("Invocation telemetry not accepted for workspace; backing off", meta);
    } else {
      this.logger?.debug("Invocation telemetry still not accepted for workspace", meta);
    }
  }

  private deadLetter(workspaceId: string, invocations: InvocationRecord[], reason: string): void {
    const failedAt = new Date().toISOString();
    const ids = invocations.map((inv) => inv.invocationId);
    // Retire the rows without touching their status: the invocations ran as recorded; only
    // their telemetry was refused, and the dead letter below keeps that outcome.
    this.auditRepository.markInvocationsUploaded(ids, failedAt);
    const deadLetterId = `dl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    try {
      this.auditRepository.saveDeadLetter({
        deadLetterId,
        originalEventType: "invocation_telemetry_batch",
        payload: { workspaceId, invocationIds: ids, count: invocations.length },
        errorReason: `Telemetry batch refused for workspace ${workspaceId}: ${reason}`,
        failedAt,
        retryCount: 0,
        status: "exhausted",
      });
    } catch (dlError) {
      this.logger?.error("Failed to save dead letter for invocation telemetry batch", {
        workspaceId,
        deadLetterId,
        error: dlError instanceof Error ? dlError.message : String(dlError),
      });
    }
  }
}
