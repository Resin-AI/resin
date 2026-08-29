import type { LocalDatabaseConnection } from "./connection.js";

/**
 * Configuration options for state store compaction and retention pruning.
 */
export interface RetentionOptions {
  /**
   * Days to retain acknowledged upload batches. Default: 14 days.
   */
  acknowledgedBatchRetentionDays?: number;
  /**
   * Days to retain acknowledged normalized events. Default: 30 days.
   */
  acknowledgedEventRetentionDays?: number;
  /**
   * Number of latest catalog snapshots to retain per workspace. Default: 5.
   */
  staleSnapshotKeepCount?: number;
  /**
   * Days to retain delivered outbox messages. Default: 7 days.
   */
  deliveredOutboxRetentionDays?: number;
  /**
   * Days to retain processed inbox messages. Default: 7 days.
   */
  processedInboxRetentionDays?: number;
  /**
   * Days to retain resolved or discarded dead letters. Default: 14 days.
   */
  resolvedDeadLetterRetentionDays?: number;
  /**
   * Days to retain general audit records. Default: 90 days.
   */
  auditRetentionDays?: number;
  /**
   * Days to retain tool invocation records. Default: 30 days.
   */
  invocationRetentionDays?: number;
}

/**
 * Summary of records pruned and preserved during compaction.
 */
export interface RetentionSummary {
  deletedEvents: number;
  deletedBatches: number;
  deletedSnapshots: number;
  deletedOutbox: number;
  deletedInbox: number;
  deletedDeadLetters: number;
  deletedAuditRecords: number;
  deletedInvocations: number;
  preservedActiveDeployments: number;
  preservedActiveInstallations: number;
  durationMs: number;
}

/**
 * Active deployment states that must never be pruned.
 */
export const ACTIVE_DEPLOYMENT_STATES = [
  "drafted",
  "validating",
  "replaying",
  "eligible",
  "canary",
  "promoted",
  "suspended",
  "rolling_back",
] as const;

/**
 * Retention and compaction engine responsible for purging stale data
 * while strictly safeguarding active candidate and deployment evidence.
 */
export class RetentionEngine {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  /**
   * Runs compaction and retention pruning within a single atomic transaction.
   */
  async compact(options: RetentionOptions = {}): Promise<RetentionSummary> {
    const start = Date.now();

    const batchDays = options.acknowledgedBatchRetentionDays ?? 14;
    const eventDays = options.acknowledgedEventRetentionDays ?? 30;
    const snapshotKeep = options.staleSnapshotKeepCount ?? 5;
    const outboxDays = options.deliveredOutboxRetentionDays ?? 7;
    const inboxDays = options.processedInboxRetentionDays ?? 7;
    const deadLetterDays = options.resolvedDeadLetterRetentionDays ?? 14;
    const auditDays = options.auditRetentionDays ?? 90;
    const invocationDays = options.invocationRetentionDays ?? 30;

    const now = Date.now();
    const batchCutoff = new Date(now - batchDays * 86400000).toISOString();
    const eventCutoff = new Date(now - eventDays * 86400000).toISOString();
    const outboxCutoff = new Date(now - outboxDays * 86400000).toISOString();
    const inboxCutoff = new Date(now - inboxDays * 86400000).toISOString();
    const deadLetterCutoff = new Date(now - deadLetterDays * 86400000).toISOString();
    const auditCutoff = new Date(now - auditDays * 86400000).toISOString();
    const invocationCutoff = new Date(now - invocationDays * 86400000).toISOString();

    return this.conn.transaction(async (tx) => {
      // 1. Audit active deployments & installations to preserve evidence
      const activeDeploys = tx.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM deployment_records WHERE state IN (${ACTIVE_DEPLOYMENT_STATES.map((s) => `'${s}'`).join(", ")});`,
      );
      const activeInstalls = tx.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM installations WHERE state = 'active';",
      );

      // 2. Prune normalized events older than cutoff for closed sessions without pending batches
      const eventRes = tx.run(
        `DELETE FROM normalized_events
         WHERE timestamp < ?
           AND session_id IN (
             SELECT s.session_id FROM sessions s
             WHERE s.status IN ('closed', 'completed', 'inactive')
               AND NOT EXISTS (
                 SELECT 1 FROM upload_batches ub
                 WHERE ub.status IN ('pending', 'uploading', 'failed')
                   AND (ub.workspace_id = s.workspace_id OR ub.workspace_id IS NULL)
               )
           );`,
        [eventCutoff],
      );

      // 3. Prune acknowledged upload batches older than batch cutoff
      const batchRes = tx.run(
        "DELETE FROM upload_batches WHERE status = 'acknowledged' AND created_at < ?;",
        [batchCutoff],
      );

      // 4. Prune stale catalog snapshots beyond keep count per workspace
      const snapshotRes = tx.run(
        `DELETE FROM catalog_snapshots
         WHERE snapshot_id NOT IN (
           SELECT snapshot_id FROM (
             SELECT snapshot_id,
                    ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY timestamp DESC) AS rn
             FROM catalog_snapshots
           ) WHERE rn <= ?
         );`,
        [snapshotKeep],
      );

      // 5. Prune delivered outbox items
      const outboxRes = tx.run(
        "DELETE FROM local_outbox WHERE status = 'delivered' AND created_at < ?;",
        [outboxCutoff],
      );

      // 6. Prune processed/ignored inbox items
      const inboxRes = tx.run(
        "DELETE FROM local_inbox WHERE status IN ('processed', 'ignored') AND received_at < ?;",
        [inboxCutoff],
      );

      // 7. Prune resolved/discarded dead letters
      const deadLetterRes = tx.run(
        "DELETE FROM dead_letters WHERE status IN ('resolved', 'discarded') AND failed_at < ?;",
        [deadLetterCutoff],
      );

      // 8. Prune old audit records
      const auditRes = tx.run("DELETE FROM audit_records WHERE timestamp < ?;", [auditCutoff]);

      // 9. Prune old invocation records for completed sessions
      const invocationRes = tx.run(
        `DELETE FROM invocation_records
         WHERE started_at < ?
           AND session_id IN (
             SELECT session_id FROM sessions WHERE status IN ('closed', 'completed', 'inactive')
           );`,
        [invocationCutoff],
      );

      return {
        deletedEvents: eventRes.changes,
        deletedBatches: batchRes.changes,
        deletedSnapshots: snapshotRes.changes,
        deletedOutbox: outboxRes.changes,
        deletedInbox: inboxRes.changes,
        deletedDeadLetters: deadLetterRes.changes,
        deletedAuditRecords: auditRes.changes,
        deletedInvocations: invocationRes.changes,
        preservedActiveDeployments: activeDeploys?.count ?? 0,
        preservedActiveInstallations: activeInstalls?.count ?? 0,
        durationMs: Date.now() - start,
      };
    });
  }
}
