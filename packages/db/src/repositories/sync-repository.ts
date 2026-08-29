import crypto from "node:crypto";
import { type DeadLetterRecord, DeadLetterRecordSchema, canonicalJson } from "@resin/contracts";
import type { LocalDatabaseConnection } from "../connection.js";

/**
 * Outbox message queue item.
 */
export interface OutboxItem {
  outboxId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "delivered" | "failed";
  retryCount: number;
  lastError?: string;
  createdAt: string;
  nextRetryAt?: string;
  sentAt?: string;
}

/**
 * Inbox message queue item.
 */
export interface InboxItem {
  inboxId: string;
  source: string;
  messageId: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "processed" | "failed" | "ignored";
  receivedAt: string;
  processedAt?: string;
}

/**
 * Upload batch tracking entity.
 */
export interface UploadBatch {
  batchId: string;
  workspaceId?: string;
  eventCount: number;
  byteSize: number;
  status: "pending" | "uploading" | "acknowledged" | "failed" | "rejected";
  createdAt: string;
  uploadedAt?: string;
  retryCount: number;
  checksum: string;
}

/**
 * Upload acknowledgement tracking entity.
 */
export interface UploadAcknowledgement {
  ackId: string;
  batchId: string;
  serverTimestamp: string;
  processedCount: number;
  status: "accepted" | "partially_accepted" | "rejected";
  receivedAt: string;
}

/**
 * Repository managing outbox/inbox queues, upload batches, acknowledgements,
 * and dead letters.
 */
export class SyncRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Outbox
  // ---------------------------------------------------------------------------

  async enqueueOutbox(item: {
    outboxId?: string;
    topic: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const id = item.outboxId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO local_outbox (
        outbox_id, topic, payload_json, status, retry_count, last_error, created_at, next_retry_at, sent_at
      ) VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL)
      ON CONFLICT(outbox_id) DO NOTHING;`,
      [id, item.topic, canonicalJson(item.payload), now],
    );
    return id;
  }

  async fetchPendingOutbox(limit = 50): Promise<OutboxItem[]> {
    const now = new Date().toISOString();
    const rows = this.conn.all<{
      outbox_id: string;
      topic: string;
      payload_json: string;
      status: "pending" | "processing" | "delivered" | "failed";
      retry_count: number;
      last_error: string | null;
      created_at: string;
      next_retry_at: string | null;
      sent_at: string | null;
    }>(
      `SELECT * FROM local_outbox
       WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?))
       ORDER BY created_at ASC
       LIMIT ?;`,
      [now, limit],
    );

    return rows.map((r) => ({
      outboxId: r.outbox_id,
      topic: r.topic,
      payload: JSON.parse(r.payload_json || "{}"),
      status: r.status,
      retryCount: r.retry_count,
      lastError: r.last_error ?? undefined,
      createdAt: r.created_at,
      nextRetryAt: r.next_retry_at ?? undefined,
      sentAt: r.sent_at ?? undefined,
    }));
  }

  async markOutboxDelivered(outboxId: string, sentAt?: string): Promise<void> {
    const at = sentAt ?? new Date().toISOString();
    this.conn.run(
      "UPDATE local_outbox SET status = 'delivered', sent_at = ? WHERE outbox_id = ?;",
      [at, outboxId],
    );
  }

  async markOutboxFailed(outboxId: string, error: string, nextRetryAt?: string): Promise<void> {
    this.conn.run(
      `UPDATE local_outbox
       SET status = 'failed',
           retry_count = retry_count + 1,
           last_error = ?,
           next_retry_at = ?
       WHERE outbox_id = ?;`,
      [error, nextRetryAt ?? null, outboxId],
    );
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  async enqueueInbox(item: {
    inboxId?: string;
    source: string;
    messageId: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const id = item.inboxId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO local_inbox (
        inbox_id, source, message_id, payload_json, status, received_at, processed_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(source, message_id) DO NOTHING;`,
      [id, item.source, item.messageId, canonicalJson(item.payload), now],
    );
    return id;
  }

  async fetchPendingInbox(limit = 50): Promise<InboxItem[]> {
    const rows = this.conn.all<{
      inbox_id: string;
      source: string;
      message_id: string;
      payload_json: string;
      status: "pending" | "processing" | "processed" | "failed" | "ignored";
      received_at: string;
      processed_at: string | null;
    }>("SELECT * FROM local_inbox WHERE status = 'pending' ORDER BY received_at ASC LIMIT ?;", [
      limit,
    ]);

    return rows.map((r) => ({
      inboxId: r.inbox_id,
      source: r.source,
      messageId: r.message_id,
      payload: JSON.parse(r.payload_json || "{}"),
      status: r.status,
      receivedAt: r.received_at,
      processedAt: r.processed_at ?? undefined,
    }));
  }

  async markInboxProcessed(inboxId: string, processedAt?: string): Promise<void> {
    const at = processedAt ?? new Date().toISOString();
    this.conn.run(
      "UPDATE local_inbox SET status = 'processed', processed_at = ? WHERE inbox_id = ?;",
      [at, inboxId],
    );
  }

  // ---------------------------------------------------------------------------
  // Upload Batches
  // ---------------------------------------------------------------------------

  async saveUploadBatch(batch: UploadBatch): Promise<void> {
    this.conn.run(
      `INSERT INTO upload_batches (
        batch_id, workspace_id, event_count, byte_size, status, created_at, uploaded_at, retry_count, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        event_count = excluded.event_count,
        byte_size = excluded.byte_size,
        status = excluded.status,
        uploaded_at = excluded.uploaded_at,
        retry_count = excluded.retry_count,
        checksum = excluded.checksum;`,
      [
        batch.batchId,
        batch.workspaceId ?? null,
        batch.eventCount,
        batch.byteSize,
        batch.status,
        batch.createdAt,
        batch.uploadedAt ?? null,
        batch.retryCount,
        batch.checksum,
      ],
    );
  }

  async getUploadBatch(batchId: string): Promise<UploadBatch | null> {
    const row = this.conn.get<{
      batch_id: string;
      workspace_id: string | null;
      event_count: number;
      byte_size: number;
      status: "pending" | "uploading" | "acknowledged" | "failed" | "rejected";
      created_at: string;
      uploaded_at: string | null;
      retry_count: number;
      checksum: string;
    }>("SELECT * FROM upload_batches WHERE batch_id = ?;", [batchId]);

    if (!row) {
      return null;
    }

    return {
      batchId: row.batch_id,
      workspaceId: row.workspace_id ?? undefined,
      eventCount: row.event_count,
      byteSize: row.byte_size,
      status: row.status,
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at ?? undefined,
      retryCount: row.retry_count,
      checksum: row.checksum,
    };
  }

  async listUploadBatches(options?: {
    status?: UploadBatch["status"];
    limit?: number;
  }): Promise<UploadBatch[]> {
    let sql = "SELECT * FROM upload_batches";
    const params: unknown[] = [];
    if (options?.status) {
      sql += " WHERE status = ?";
      params.push(options.status);
    }
    sql += " ORDER BY created_at DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.conn.all<{
      batch_id: string;
      workspace_id: string | null;
      event_count: number;
      byte_size: number;
      status: "pending" | "uploading" | "acknowledged" | "failed" | "rejected";
      created_at: string;
      uploaded_at: string | null;
      retry_count: number;
      checksum: string;
    }>(sql, params);

    return rows.map((row) => ({
      batchId: row.batch_id,
      workspaceId: row.workspace_id ?? undefined,
      eventCount: row.event_count,
      byteSize: row.byte_size,
      status: row.status,
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at ?? undefined,
      retryCount: row.retry_count,
      checksum: row.checksum,
    }));
  }

  async updateUploadBatchStatus(
    batchId: string,
    status: UploadBatch["status"],
    uploadedAt?: string,
  ): Promise<void> {
    this.conn.run(
      "UPDATE upload_batches SET status = ?, uploaded_at = COALESCE(?, uploaded_at) WHERE batch_id = ?;",
      [status, uploadedAt ?? null, batchId],
    );
  }

  // ---------------------------------------------------------------------------
  // Upload Acknowledgements
  // ---------------------------------------------------------------------------

  async saveUploadAcknowledgement(ack: UploadAcknowledgement): Promise<void> {
    this.conn.run(
      `INSERT INTO upload_acknowledgements (
        ack_id, batch_id, server_timestamp, processed_count, status, received_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ack_id) DO UPDATE SET
        batch_id = excluded.batch_id,
        server_timestamp = excluded.server_timestamp,
        processed_count = excluded.processed_count,
        status = excluded.status,
        received_at = excluded.received_at;`,
      [ack.ackId, ack.batchId, ack.serverTimestamp, ack.processedCount, ack.status, ack.receivedAt],
    );
  }

  async getUploadAcknowledgement(ackId: string): Promise<UploadAcknowledgement | null> {
    const row = this.conn.get<{
      ack_id: string;
      batch_id: string;
      server_timestamp: string;
      processed_count: number;
      status: "accepted" | "partially_accepted" | "rejected";
      received_at: string;
    }>("SELECT * FROM upload_acknowledgements WHERE ack_id = ?;", [ackId]);

    if (!row) {
      return null;
    }

    return {
      ackId: row.ack_id,
      batchId: row.batch_id,
      serverTimestamp: row.server_timestamp,
      processedCount: row.processed_count,
      status: row.status,
      receivedAt: row.received_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Dead Letters
  // ---------------------------------------------------------------------------

  async saveDeadLetter(deadLetter: DeadLetterRecord): Promise<void> {
    const validated = DeadLetterRecordSchema.parse(deadLetter);
    this.conn.run(
      `INSERT INTO dead_letters (
        dead_letter_id, original_event_type, payload_json, error_reason, failed_at, retry_count, next_retry_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dead_letter_id) DO UPDATE SET
        original_event_type = excluded.original_event_type,
        payload_json = excluded.payload_json,
        error_reason = excluded.error_reason,
        failed_at = excluded.failed_at,
        retry_count = excluded.retry_count,
        next_retry_at = excluded.next_retry_at,
        status = excluded.status;`,
      [
        validated.deadLetterId,
        validated.originalEventType,
        canonicalJson(validated.payload),
        validated.errorReason,
        validated.failedAt,
        validated.retryCount,
        validated.nextRetryAt ?? null,
        validated.status,
      ],
    );
  }

  async getDeadLetter(deadLetterId: string): Promise<DeadLetterRecord | null> {
    const row = this.conn.get<{
      dead_letter_id: string;
      original_event_type: string;
      payload_json: string;
      error_reason: string;
      failed_at: string;
      retry_count: number;
      next_retry_at: string | null;
      status: "pending" | "exhausted" | "resolved" | "discarded";
    }>("SELECT * FROM dead_letters WHERE dead_letter_id = ?;", [deadLetterId]);

    if (!row) {
      return null;
    }

    return DeadLetterRecordSchema.parse({
      deadLetterId: row.dead_letter_id,
      originalEventType: row.original_event_type,
      payload: JSON.parse(row.payload_json || "{}"),
      errorReason: row.error_reason,
      failedAt: row.failed_at,
      retryCount: row.retry_count,
      nextRetryAt: row.next_retry_at ?? undefined,
      status: row.status,
    });
  }

  async listDeadLetters(options?: {
    status?: DeadLetterRecord["status"];
    limit?: number;
  }): Promise<DeadLetterRecord[]> {
    let sql = "SELECT * FROM dead_letters";
    const params: unknown[] = [];
    if (options?.status) {
      sql += " WHERE status = ?";
      params.push(options.status);
    }
    sql += " ORDER BY failed_at DESC";
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.conn.all<{
      dead_letter_id: string;
      original_event_type: string;
      payload_json: string;
      error_reason: string;
      failed_at: string;
      retry_count: number;
      next_retry_at: string | null;
      status: "pending" | "exhausted" | "resolved" | "discarded";
    }>(sql, params);

    return rows.map((row) =>
      DeadLetterRecordSchema.parse({
        deadLetterId: row.dead_letter_id,
        originalEventType: row.original_event_type,
        payload: JSON.parse(row.payload_json || "{}"),
        errorReason: row.error_reason,
        failedAt: row.failed_at,
        retryCount: row.retry_count,
        nextRetryAt: row.next_retry_at ?? undefined,
        status: row.status,
      }),
    );
  }
}
