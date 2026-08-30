import type { SyncCursor } from "@resin/contracts";
import type { LocalDatabaseConnection, LocalStateStore, SessionRepository } from "@resin/db";
import { type SourceCursor, SourceCursorSchema } from "@resin/harness-contracts";
import { z } from "zod";

/**
 * Options for committing a checkpoint.
 */
export interface CheckpointCommitOptions {
  workspaceId?: string;
  deviceId?: string;
  entityType?: string;
  allowRegression?: boolean;
}

/**
 * Configuration options for SourceCursorManager.
 */
export interface CursorManagerOptions {
  /**
   * Database store or connection. If not provided, operates in-memory.
   */
  store?: LocalStateStore | LocalDatabaseConnection;
  /**
   * Session repository instance.
   */
  sessionRepository?: SessionRepository;
  /**
   * Default device ID. Defaults to "local-observer".
   */
  deviceId?: string;
}

/**
 * Atomic checkpoint manager advancing SourceCursor in SQLite via @resin/db
 * only upon durable handoff to downstream storage or event pipelines.
 */
export class SourceCursorManager {
  private readonly memoryCursors = new Map<string, SourceCursor>();
  private readonly defaultDeviceId: string;
  private readonly conn?: LocalDatabaseConnection;
  private readonly sessionRepo?: SessionRepository;

  constructor(options: CursorManagerOptions = {}) {
    this.defaultDeviceId = options.deviceId ?? "local-observer";

    if (options.sessionRepository) {
      this.sessionRepo = options.sessionRepository;
    } else if (options.store) {
      if ("sessions" in options.store) {
        // SAFETY: store with sessions property conforms to LocalStateStore.
        const store = options.store as LocalStateStore;
        this.sessionRepo = store.sessions;
        this.conn = store.conn;
      } else {
        // SAFETY: store without sessions conforms directly to LocalDatabaseConnection.
        this.conn = options.store as LocalDatabaseConnection;
      }
    }
  }

  /**
   * Builds the primary key for the cursor in the source_cursors table.
   */
  private buildCursorKey(sessionId: string): string {
    return `transcript:${sessionId}`;
  }

  /**
   * Parses and validates a stored JSON syncToken into a SourceCursor.
   */
  private parseSyncToken(
    syncToken: string,
    fallbackTimestamp?: string,
    fallbackSeq?: number,
  ): SourceCursor | null {
    try {
      const parsed = JSON.parse(syncToken);
      const parsedObj = z.record(z.unknown()).safeParse(parsed);
      const record = parsedObj.success ? parsedObj.data : {};
      return SourceCursorSchema.parse({
        offset: record.offset ?? 0,
        line: record.line ?? 1,
        sequence: record.sequence ?? fallbackSeq ?? 0,
        checkpoint: record.checkpoint ?? undefined,
        timestamp: record.timestamp ?? fallbackTimestamp ?? new Date().toISOString(),
      });
    } catch {
      return null;
    }
  }

  /**
   * Retrieves the current checkpoint cursor for a session.
   */
  async getCursor(sessionId: string): Promise<SourceCursor | null> {
    const cursorKey = this.buildCursorKey(sessionId);

    // If SQLite repo is available, query SQLite
    if (this.sessionRepo) {
      const syncCursor = await this.sessionRepo.getCursor(cursorKey);
      if (syncCursor) {
        const decoded = this.parseSyncToken(
          syncCursor.syncToken,
          syncCursor.lastSyncedTimestamp,
          syncCursor.lastSyncedSequence,
        );
        if (decoded) {
          this.memoryCursors.set(sessionId, decoded);
          return decoded;
        }
      }
    } else if (this.conn) {
      const row = this.conn.get<{
        cursor_id: string;
        last_synced_sequence: number;
        last_synced_timestamp: string;
        sync_token: string;
      }>("SELECT * FROM source_cursors WHERE cursor_id = ?;", [cursorKey]);

      if (row) {
        const decoded = this.parseSyncToken(
          row.sync_token,
          row.last_synced_timestamp,
          row.last_synced_sequence,
        );
        if (decoded) {
          this.memoryCursors.set(sessionId, decoded);
          return decoded;
        }
      }
    }

    return this.memoryCursors.get(sessionId) ?? null;
  }

  /**
   * Commits an atomic checkpoint for a session upon durable handoff.
   * Enforces monotonicity unless allowRegression is explicitly true.
   */
  async commitCheckpoint(
    sessionId: string,
    cursor: SourceCursor,
    options: CheckpointCommitOptions = {},
  ): Promise<void> {
    const validated = SourceCursorSchema.parse(cursor);
    const existing = await this.getCursor(sessionId);

    if (existing && !options.allowRegression) {
      if (validated.sequence < existing.sequence || validated.offset < existing.offset) {
        throw new Error(
          `Cannot regress cursor for session ${sessionId}: existing (seq: ${existing.sequence}, offset: ${existing.offset}) -> new (seq: ${validated.sequence}, offset: ${validated.offset})`,
        );
      }
    }

    const cursorKey = this.buildCursorKey(sessionId);
    const deviceId = options.deviceId ?? this.defaultDeviceId;
    const syncToken = JSON.stringify(validated);

    const syncCursor: SyncCursor = {
      cursorId: cursorKey,
      deviceId,
      workspaceId: options.workspaceId,
      entityType: options.entityType ?? "transcript",
      lastSyncedSequence: validated.sequence,
      lastSyncedTimestamp: validated.timestamp,
      syncToken,
    };

    if (this.sessionRepo) {
      await this.sessionRepo.saveCursor(syncCursor);
    } else if (this.conn) {
      this.conn.run(
        `INSERT INTO source_cursors (
          cursor_id, device_id, workspace_id, entity_type, last_synced_sequence, last_synced_timestamp, sync_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cursor_id) DO UPDATE SET
          device_id = excluded.device_id,
          workspace_id = excluded.workspace_id,
          entity_type = excluded.entity_type,
          last_synced_sequence = excluded.last_synced_sequence,
          last_synced_timestamp = excluded.last_synced_timestamp,
          sync_token = excluded.sync_token;`,
        [
          syncCursor.cursorId,
          syncCursor.deviceId,
          syncCursor.workspaceId ?? null,
          syncCursor.entityType,
          syncCursor.lastSyncedSequence,
          syncCursor.lastSyncedTimestamp,
          syncCursor.syncToken,
        ],
      );
    }

    this.memoryCursors.set(sessionId, validated);
  }

  /**
   * Commits a batch of session checkpoints in an atomic transaction.
   */
  async commitBatch(
    checkpoints: Array<{
      sessionId: string;
      cursor: SourceCursor;
      workspaceId?: string;
      deviceId?: string;
      allowRegression?: boolean;
    }>,
  ): Promise<void> {
    if (checkpoints.length === 0) return;

    if (this.conn) {
      this.conn.transaction(() => {
        for (const item of checkpoints) {
          const validated = SourceCursorSchema.parse(item.cursor);
          const cursorKey = this.buildCursorKey(item.sessionId);
          const deviceId = item.deviceId ?? this.defaultDeviceId;
          const syncToken = JSON.stringify(validated);

          this.conn!.run(
            `INSERT INTO source_cursors (
              cursor_id, device_id, workspace_id, entity_type, last_synced_sequence, last_synced_timestamp, sync_token
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cursor_id) DO UPDATE SET
              device_id = excluded.device_id,
              workspace_id = excluded.workspace_id,
              entity_type = excluded.entity_type,
              last_synced_sequence = excluded.last_synced_sequence,
              last_synced_timestamp = excluded.last_synced_timestamp,
              sync_token = excluded.sync_token;`,
            [
              cursorKey,
              deviceId,
              item.workspaceId ?? null,
              "transcript",
              validated.sequence,
              validated.timestamp,
              syncToken,
            ],
          );
          this.memoryCursors.set(item.sessionId, validated);
        }
      });
    } else {
      for (const item of checkpoints) {
        await this.commitCheckpoint(item.sessionId, item.cursor, {
          workspaceId: item.workspaceId,
          deviceId: item.deviceId,
          allowRegression: item.allowRegression,
        });
      }
    }
  }

  /**
   * Deletes checkpoint for a session.
   */
  async deleteCursor(sessionId: string): Promise<void> {
    const cursorKey = this.buildCursorKey(sessionId);
    if (this.conn) {
      this.conn.run("DELETE FROM source_cursors WHERE cursor_id = ?;", [cursorKey]);
    }
    this.memoryCursors.delete(sessionId);
  }

  /**
   * Lists all known session cursors.
   */
  async listCursors(): Promise<Map<string, SourceCursor>> {
    const result = new Map<string, SourceCursor>();

    if (this.conn) {
      const rows = this.conn.all<{
        cursor_id: string;
        last_synced_sequence: number;
        last_synced_timestamp: string;
        sync_token: string;
      }>("SELECT * FROM source_cursors WHERE entity_type = 'transcript';");

      for (const row of rows) {
        const sessionId = row.cursor_id.startsWith("transcript:")
          ? row.cursor_id.slice("transcript:".length)
          : row.cursor_id;

        const decoded = this.parseSyncToken(
          row.sync_token,
          row.last_synced_timestamp,
          row.last_synced_sequence,
        );
        if (decoded) {
          result.set(sessionId, decoded);
          this.memoryCursors.set(sessionId, decoded);
        }
      }
    } else {
      for (const [sessionId, cursor] of this.memoryCursors.entries()) {
        result.set(sessionId, cursor);
      }
    }

    return result;
  }
}
