import type { InvocationRecord } from "@resin/contracts";
import type { AuditRepository } from "@resin/db";
import type { CloudObservationClient } from "../cloud-runtime.js";
import type { Logger } from "../lifecycle.js";

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
   * 5. On failure, logs and leaves records pending for the next cycle.
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

      for (const [workspaceId, invocations] of byWorkspace.entries()) {
        try {
          const response = await this.cloudClient.sendTelemetryBatch({
            workspaceId,
            invocations,
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
          this.logger?.warn("Failed to upload invocation telemetry batch for workspace", {
            workspaceId,
            count: invocations.length,
            error: error instanceof Error ? error.message : String(error),
          });
          // Rows remain pending for retry on the next cycle
        }
      }

      return { uploaded: totalUploaded };
    } finally {
      this.isFlushing = false;
    }
  }
}
