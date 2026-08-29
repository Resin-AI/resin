import {
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type SyncCursor,
  SyncCursorSchema,
  type WorkspaceRecord,
  WorkspaceRecordSchema,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection } from "../connection.js";

/**
 * Session entity representation.
 */
export interface SessionRecord {
  sessionId: string;
  workspaceId?: string;
  harnessId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
  sourceIdentity: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Raw record pointer entity.
 */
export interface RawRecordRef {
  recordId: string;
  sessionId?: string;
  sourceId: string;
  payloadHash: string;
  storagePath?: string;
  byteSize: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Repository managing workspaces, sessions, source cursors, raw record pointers,
 * and normalized session events.
 */
export class SessionRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  async saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const validated = WorkspaceRecordSchema.parse(workspace);
    this.conn.run(
      `INSERT INTO workspaces (
        workspace_id, root_path, name, config_json, capability_envelope_json, active_tools_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        root_path = excluded.root_path,
        name = excluded.name,
        config_json = excluded.config_json,
        capability_envelope_json = excluded.capability_envelope_json,
        active_tools_json = excluded.active_tools_json,
        updated_at = excluded.updated_at;`,
      [
        validated.workspaceId,
        validated.rootPath,
        validated.name,
        canonicalJson(validated.config),
        canonicalJson(validated.capabilityEnvelope),
        canonicalJson(validated.activeTools),
        validated.createdAt,
        validated.updatedAt ?? null,
      ],
    );
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const row = this.conn.get<{
      workspace_id: string;
      root_path: string;
      name: string;
      config_json: string;
      capability_envelope_json: string;
      active_tools_json: string;
      created_at: string;
      updated_at: string | null;
    }>("SELECT * FROM workspaces WHERE workspace_id = ?;", [workspaceId]);

    if (!row) {
      return null;
    }

    return WorkspaceRecordSchema.parse({
      workspaceId: row.workspace_id,
      rootPath: row.root_path,
      name: row.name,
      config: JSON.parse(row.config_json),
      capabilityEnvelope: JSON.parse(row.capability_envelope_json),
      activeTools: JSON.parse(row.active_tools_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const rows = this.conn.all<{
      workspace_id: string;
      root_path: string;
      name: string;
      config_json: string;
      capability_envelope_json: string;
      active_tools_json: string;
      created_at: string;
      updated_at: string | null;
    }>("SELECT * FROM workspaces ORDER BY created_at ASC;");

    return rows.map((row) =>
      WorkspaceRecordSchema.parse({
        workspaceId: row.workspace_id,
        rootPath: row.root_path,
        name: row.name,
        config: JSON.parse(row.config_json),
        capabilityEnvelope: JSON.parse(row.capability_envelope_json),
        activeTools: JSON.parse(row.active_tools_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async saveSession(session: {
    sessionId: string;
    workspaceId?: string;
    harnessId: string;
    status?: string;
    startedAt: string;
    endedAt?: string;
    metadata?: Record<string, unknown>;
    sourceIdentity?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO sessions (
        session_id, workspace_id, harness_id, status, started_at, ended_at, metadata_json, source_identity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        harness_id = excluded.harness_id,
        status = excluded.status,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        metadata_json = excluded.metadata_json,
        source_identity_json = excluded.source_identity_json,
        updated_at = excluded.updated_at;`,
      [
        session.sessionId,
        session.workspaceId ?? null,
        session.harnessId,
        session.status ?? "active",
        session.startedAt,
        session.endedAt ?? null,
        canonicalJson(session.metadata ?? {}),
        canonicalJson(session.sourceIdentity ?? {}),
        session.createdAt ?? now,
        session.updatedAt ?? null,
      ],
    );
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.conn.get<{
      session_id: string;
      workspace_id: string | null;
      harness_id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      metadata_json: string;
      source_identity_json: string;
      created_at: string;
      updated_at: string | null;
    }>("SELECT * FROM sessions WHERE session_id = ?;", [sessionId]);

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      workspaceId: row.workspace_id ?? undefined,
      harnessId: row.harness_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      metadata: JSON.parse(row.metadata_json || "{}"),
      sourceIdentity: JSON.parse(row.source_identity_json || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  async listSessions(filter?: {
    workspaceId?: string;
    status?: string;
    limit?: number;
  }): Promise<SessionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    let sql = "SELECT * FROM sessions";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY started_at DESC";
    if (filter?.limit) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.conn.all<{
      session_id: string;
      workspace_id: string | null;
      harness_id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
      metadata_json: string;
      source_identity_json: string;
      created_at: string;
      updated_at: string | null;
    }>(sql, params);

    return rows.map((row) => ({
      sessionId: row.session_id,
      workspaceId: row.workspace_id ?? undefined,
      harnessId: row.harness_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      metadata: JSON.parse(row.metadata_json || "{}"),
      sourceIdentity: JSON.parse(row.source_identity_json || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    }));
  }

  // ---------------------------------------------------------------------------
  // Source Cursors
  // ---------------------------------------------------------------------------

  async saveCursor(cursor: SyncCursor): Promise<void> {
    const validated = SyncCursorSchema.parse(cursor);
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
        validated.cursorId,
        validated.deviceId,
        validated.workspaceId ?? null,
        validated.entityType,
        validated.lastSyncedSequence,
        validated.lastSyncedTimestamp,
        validated.syncToken,
      ],
    );
  }

  async getCursor(cursorId: string): Promise<SyncCursor | null> {
    const row = this.conn.get<{
      cursor_id: string;
      device_id: string;
      workspace_id: string | null;
      entity_type: string;
      last_synced_sequence: number;
      last_synced_timestamp: string;
      sync_token: string;
    }>("SELECT * FROM source_cursors WHERE cursor_id = ?;", [cursorId]);

    if (!row) {
      return null;
    }

    return SyncCursorSchema.parse({
      cursorId: row.cursor_id,
      deviceId: row.device_id,
      workspaceId: row.workspace_id ?? undefined,
      entityType: row.entity_type,
      lastSyncedSequence: row.last_synced_sequence,
      lastSyncedTimestamp: row.last_synced_timestamp,
      syncToken: row.sync_token,
    });
  }

  async getCursorByDevice(deviceId: string, entityType: string): Promise<SyncCursor | null> {
    const row = this.conn.get<{
      cursor_id: string;
      device_id: string;
      workspace_id: string | null;
      entity_type: string;
      last_synced_sequence: number;
      last_synced_timestamp: string;
      sync_token: string;
    }>("SELECT * FROM source_cursors WHERE device_id = ? AND entity_type = ? LIMIT 1;", [
      deviceId,
      entityType,
    ]);

    if (!row) {
      return null;
    }

    return SyncCursorSchema.parse({
      cursorId: row.cursor_id,
      deviceId: row.device_id,
      workspaceId: row.workspace_id ?? undefined,
      entityType: row.entity_type,
      lastSyncedSequence: row.last_synced_sequence,
      lastSyncedTimestamp: row.last_synced_timestamp,
      syncToken: row.sync_token,
    });
  }

  async listCursors(deviceId?: string): Promise<SyncCursor[]> {
    let sql = "SELECT * FROM source_cursors";
    const params: unknown[] = [];
    if (deviceId) {
      sql += " WHERE device_id = ?";
      params.push(deviceId);
    }
    sql += " ORDER BY last_synced_timestamp DESC;";

    const rows = this.conn.all<{
      cursor_id: string;
      device_id: string;
      workspace_id: string | null;
      entity_type: string;
      last_synced_sequence: number;
      last_synced_timestamp: string;
      sync_token: string;
    }>(sql, params);

    return rows.map((row) =>
      SyncCursorSchema.parse({
        cursorId: row.cursor_id,
        deviceId: row.device_id,
        workspaceId: row.workspace_id ?? undefined,
        entityType: row.entity_type,
        lastSyncedSequence: row.last_synced_sequence,
        lastSyncedTimestamp: row.last_synced_timestamp,
        syncToken: row.sync_token,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Raw Record References
  // ---------------------------------------------------------------------------

  async saveRawRecordRef(ref: {
    recordId: string;
    sessionId?: string;
    sourceId: string;
    payloadHash: string;
    storagePath?: string;
    byteSize?: number;
    createdAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO raw_record_refs (
        record_id, session_id, source_id, payload_hash, storage_path, byte_size, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        session_id = excluded.session_id,
        source_id = excluded.source_id,
        payload_hash = excluded.payload_hash,
        storage_path = excluded.storage_path,
        byte_size = excluded.byte_size,
        metadata_json = excluded.metadata_json;`,
      [
        ref.recordId,
        ref.sessionId ?? null,
        ref.sourceId,
        ref.payloadHash,
        ref.storagePath ?? null,
        ref.byteSize ?? 0,
        ref.createdAt ?? now,
        canonicalJson(ref.metadata ?? {}),
      ],
    );
  }

  async getRawRecordRef(recordId: string): Promise<RawRecordRef | null> {
    const row = this.conn.get<{
      record_id: string;
      session_id: string | null;
      source_id: string;
      payload_hash: string;
      storage_path: string | null;
      byte_size: number;
      created_at: string;
      metadata_json: string;
    }>("SELECT * FROM raw_record_refs WHERE record_id = ?;", [recordId]);

    if (!row) {
      return null;
    }

    return {
      recordId: row.record_id,
      sessionId: row.session_id ?? undefined,
      sourceId: row.source_id,
      payloadHash: row.payload_hash,
      storagePath: row.storage_path ?? undefined,
      byteSize: row.byte_size,
      createdAt: row.created_at,
      metadata: JSON.parse(row.metadata_json || "{}"),
    };
  }

  // ---------------------------------------------------------------------------
  // Normalized Session Events
  // ---------------------------------------------------------------------------

  async insertEvent(event: NormalizedSessionEvent): Promise<boolean> {
    const validated = NormalizedSessionEventSchema.parse(event);

    const res = this.conn.run(
      `INSERT OR IGNORE INTO normalized_events (
        event_id, session_id, sequence, type, timestamp, causal_parent_id, payload_json, redaction_meta_json, digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        validated.eventId,
        validated.sessionId,
        validated.causalRef.causalSequence,
        validated.type,
        validated.timestamp,
        validated.causalRef.parentId ?? null,
        canonicalJson(validated),
        validated.redaction ? canonicalJson(validated.redaction) : null,
        null,
        validated.timestamp,
      ],
    );

    return res.changes > 0;
  }

  async insertEvents(events: NormalizedSessionEvent[]): Promise<number> {
    let inserted = 0;
    for (const event of events) {
      const ok = await this.insertEvent(event);
      if (ok) {
        inserted++;
      }
    }
    return inserted;
  }

  async getEventById(eventId: string): Promise<NormalizedSessionEvent | null> {
    const row = this.conn.get<{
      event_id: string;
      session_id: string;
      sequence: number;
      type: string;
      timestamp: string;
      causal_parent_id: string | null;
      payload_json: string;
      redaction_meta_json: string | null;
      digest: string | null;
      created_at: string;
    }>("SELECT * FROM normalized_events WHERE event_id = ?;", [eventId]);

    if (!row) {
      return null;
    }

    const parsed = JSON.parse(row.payload_json);
    return NormalizedSessionEventSchema.parse(parsed);
  }

  async getEvents(
    sessionId: string,
    options?: { sinceSequence?: number; limit?: number },
  ): Promise<NormalizedSessionEvent[]> {
    const conditions = ["session_id = ?"];
    const params: unknown[] = [sessionId];

    if (options?.sinceSequence !== undefined) {
      conditions.push("sequence > ?");
      params.push(options.sinceSequence);
    }

    let sql = `SELECT * FROM normalized_events WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC`;
    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.conn.all<{
      event_id: string;
      session_id: string;
      sequence: number;
      type: string;
      timestamp: string;
      causal_parent_id: string | null;
      payload_json: string;
      redaction_meta_json: string | null;
      digest: string | null;
      created_at: string;
    }>(sql, params);

    return rows.map((r) => {
      const parsed = JSON.parse(r.payload_json);
      return NormalizedSessionEventSchema.parse(parsed);
    });
  }

  async getLatestEventSequence(sessionId: string): Promise<number> {
    const row = this.conn.get<{ max_seq: number | null }>(
      "SELECT MAX(sequence) AS max_seq FROM normalized_events WHERE session_id = ?;",
      [sessionId],
    );
    return row?.max_seq ?? 0;
  }
}
