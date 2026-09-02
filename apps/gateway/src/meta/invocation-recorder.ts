import type { InvocationRecord } from "@resin/contracts";
import { AuditRepository, type LocalDatabaseConnection } from "@resin/db";

export interface InvocationRecorderOptions {
  db: LocalDatabaseConnection;
  harnessId?: string;
}

/**
 * Creates an invocation recorder that ensures a stub session row exists
 * in SQLite before persisting the invocation record via AuditRepository.
 */
export function createInvocationRecorder(
  options: InvocationRecorderOptions,
): (record: InvocationRecord) => Promise<void> {
  const { db, harnessId = "resin-mcp" } = options;
  const auditRepo = new AuditRepository(db);

  return async (record: InvocationRecord): Promise<void> => {
    const now = new Date().toISOString();
    let workspaceId: string | null = null;
    if (record.workspaceId) {
      try {
        const row = db.get<{ workspace_id: string }>(
          "SELECT workspace_id FROM workspaces WHERE workspace_id = ?;",
          [record.workspaceId],
        );
        if (row) {
          workspaceId = record.workspaceId;
        }
      } catch {
        // Fallback if workspaces table is unavailable or unmigrated
      }
    }

    db.run(
      `INSERT OR IGNORE INTO sessions (
        session_id,
        workspace_id,
        harness_id,
        status,
        started_at,
        metadata_json,
        source_identity_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [record.sessionId, workspaceId, harnessId, "active", now, "{}", "{}", now],
    );

    await auditRepo.recordInvocation(record);
  };
}
