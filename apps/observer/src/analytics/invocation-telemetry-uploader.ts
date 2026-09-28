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
  const { errorType, message } = record.errorDetails;
  return {
    ...record,
    errorDetails: {
      errorType: errorType.slice(0, MAX_ERROR_TYPE_LENGTH),
      message:
        message.length > MAX_ERROR_MESSAGE_LENGTH
          ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
          : message,
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

/**
 * Options for configuring InvocationTelemetryUploader.
 */
export interface InvocationTelemetryUploaderOptions {
  readonly auditRepository: AuditRepository;
  readonly cloudClient: CloudObservationClient;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly logger?: Logger;
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

  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isFlushing = false;

  constructor(options: InvocationTelemetryUploaderOptions) {
    this.auditRepository = options.auditRepository;
    this.cloudClient = options.cloudClient;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 200;
    this.logger = options.logger;
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
   * 5. A batch the cloud refuses for good (403: a workspace or tool this device may not report
   *    on; other 4xx: a payload it will never accept) is dead-lettered after that one attempt,
   *    never retried; one summary line per cycle reports every such batch.
   * 6. Any other failure leaves records pending for the next cycle.
   */
  async flushOnce(): Promise<{ uploaded: number }> {
    if (this.isFlushing) {
      return { uploaded: 0 };
    }
    this.isFlushing = true;

    try {
      const pending = this.auditRepository.listPendingInvocationUploads(this.batchSize);
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
          if (error instanceof ResourceForbiddenError || isPermanentRejection(error)) {
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
