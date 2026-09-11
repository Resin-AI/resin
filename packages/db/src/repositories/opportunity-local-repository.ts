import {
  type EpisodeSignature,
  type OpportunityHashOutcome,
  type ProvenPatternDto,
  type WorkflowClusterMetrics,
  canonicalJson,
} from "@resin/contracts";
import type { LocalDatabaseConnection } from "../connection.js";

/**
 * Persisted structural signature of one episode.
 * `payload` is the full episode signature; the leading columns are the queryable
 * projection used by the engine and tracker.
 */
export interface SessionSignatureRecord {
  signatureId: string;
  sessionId: string;
  structuralHash: string;
  episodeId?: string;
  payload: EpisodeSignature;
  createdAt: string;
}

/**
 * Locally accumulated aggregate for one structural workflow pattern.
 */
export interface WorkflowClusterRecord {
  clusterId: string;
  workspaceId?: string;
  structuralHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  evidenceEventIds: string[];
  metrics: WorkflowClusterMetrics;
  engineVersion: string;
}

/**
 * Membership edge joining a workflow cluster to the episodes it absorbed.
 */
export interface ClusterEpisodeRecord {
  clusterId: string;
  episodeId: string;
  sessionId?: string;
}

/**
 * Local suppression-cache entry keyed by structural hash, tracking dispatch outcome.
 * `sourceRevision` records which engine revision produced the verdict.
 */
export interface OpportunityHashCacheRecord {
  structuralHash: string;
  outcome: OpportunityHashOutcome;
  lastSeenAt: string;
  attempts: number;
  sourceRevision?: string;
  syncedAt: string | null;
  expiresAt: string;
}

/**
 * Queued local-to-cloud pattern awaiting upload.
 */
export interface PatternOutboxRecord {
  patternId: string;
  idempotencyKey: string;
  workspaceId?: string;
  payload: ProvenPatternDto;
  createdAt: string;
  uploadedAt?: string;
}

/**
 * Repository managing the local opportunity engine's deterministic detection state:
 * episode signatures, workflow clusters, hash suppression cache, and the pattern outbox.
 */
export class OpportunityLocalRepository {
  constructor(private readonly conn: LocalDatabaseConnection) {}

  // ---------------------------------------------------------------------------
  // Session Signatures
  // ---------------------------------------------------------------------------

  async insertSignature(signature: {
    signatureId: string;
    sessionId: string;
    structuralHash: string;
    episodeId?: string;
    payload: EpisodeSignature;
    createdAt?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.conn.run(
      `INSERT INTO session_signatures (
        signature_id, session_id, structural_hash, episode_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(signature_id) DO UPDATE SET
        session_id = excluded.session_id,
        structural_hash = excluded.structural_hash,
        episode_id = excluded.episode_id,
        payload_json = excluded.payload_json;`,
      [
        signature.signatureId,
        signature.sessionId,
        signature.structuralHash,
        signature.episodeId ?? null,
        canonicalJson(signature.payload),
        signature.createdAt ?? now,
      ],
    );
  }

  async getSignaturesBySession(sessionId: string): Promise<SessionSignatureRecord[]> {
    const rows = this.conn.all<{
      signature_id: string;
      session_id: string;
      structural_hash: string;
      episode_id: string | null;
      payload_json: string;
      created_at: string;
    }>(
      `SELECT * FROM session_signatures
       WHERE session_id = ?
       ORDER BY created_at ASC, signature_id ASC;`,
      [sessionId],
    );

    return rows.map((row) => this.mapSignatureRow(row));
  }

  async getSignaturesByHash(structuralHash: string): Promise<SessionSignatureRecord[]> {
    const rows = this.conn.all<{
      signature_id: string;
      session_id: string;
      structural_hash: string;
      episode_id: string | null;
      payload_json: string;
      created_at: string;
    }>(
      `SELECT * FROM session_signatures
       WHERE structural_hash = ?
       ORDER BY created_at ASC, signature_id ASC;`,
      [structuralHash],
    );

    return rows.map((row) => this.mapSignatureRow(row));
  }

  private mapSignatureRow(row: {
    signature_id: string;
    session_id: string;
    structural_hash: string;
    episode_id: string | null;
    payload_json: string;
    created_at: string;
  }): SessionSignatureRecord {
    return {
      signatureId: row.signature_id,
      sessionId: row.session_id,
      structuralHash: row.structural_hash,
      episodeId: row.episode_id ?? undefined,
      payload: JSON.parse(row.payload_json || "{}") as EpisodeSignature,
      createdAt: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow Clusters
  // ---------------------------------------------------------------------------

  async upsertCluster(cluster: WorkflowClusterRecord): Promise<void> {
    this.conn.run(
      `INSERT INTO workflow_clusters (
        cluster_id, workspace_id, structural_hash, first_seen_at, last_seen_at,
        occurrence_count, evidence_event_ids_json, metrics_json, engine_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cluster_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        structural_hash = excluded.structural_hash,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        occurrence_count = excluded.occurrence_count,
        evidence_event_ids_json = excluded.evidence_event_ids_json,
        metrics_json = excluded.metrics_json,
        engine_version = excluded.engine_version;`,
      [
        cluster.clusterId,
        cluster.workspaceId ?? null,
        cluster.structuralHash,
        cluster.firstSeenAt,
        cluster.lastSeenAt,
        cluster.occurrenceCount,
        canonicalJson(cluster.evidenceEventIds),
        canonicalJson(cluster.metrics),
        cluster.engineVersion,
      ],
    );
  }

  async getCluster(clusterId: string): Promise<WorkflowClusterRecord | null> {
    const row = this.conn.get<{
      cluster_id: string;
      workspace_id: string | null;
      structural_hash: string;
      first_seen_at: string;
      last_seen_at: string;
      occurrence_count: number;
      evidence_event_ids_json: string;
      metrics_json: string;
      engine_version: string;
    }>("SELECT * FROM workflow_clusters WHERE cluster_id = ?;", [clusterId]);

    return row ? this.mapClusterRow(row) : null;
  }

  async listClustersByHash(structuralHash: string): Promise<WorkflowClusterRecord[]> {
    const rows = this.conn.all<{
      cluster_id: string;
      workspace_id: string | null;
      structural_hash: string;
      first_seen_at: string;
      last_seen_at: string;
      occurrence_count: number;
      evidence_event_ids_json: string;
      metrics_json: string;
      engine_version: string;
    }>(
      `SELECT * FROM workflow_clusters
       WHERE structural_hash = ?
       ORDER BY last_seen_at DESC, cluster_id ASC;`,
      [structuralHash],
    );

    return rows.map((row) => this.mapClusterRow(row));
  }

  async listClustersByWorkspace(workspaceId: string): Promise<WorkflowClusterRecord[]> {
    const rows = this.conn.all<{
      cluster_id: string;
      workspace_id: string | null;
      structural_hash: string;
      first_seen_at: string;
      last_seen_at: string;
      occurrence_count: number;
      evidence_event_ids_json: string;
      metrics_json: string;
      engine_version: string;
    }>(
      `SELECT * FROM workflow_clusters
       WHERE workspace_id = ?
       ORDER BY last_seen_at DESC, cluster_id ASC;`,
      [workspaceId],
    );

    return rows.map((row) => this.mapClusterRow(row));
  }

  private mapClusterRow(row: {
    cluster_id: string;
    workspace_id: string | null;
    structural_hash: string;
    first_seen_at: string;
    last_seen_at: string;
    occurrence_count: number;
    evidence_event_ids_json: string;
    metrics_json: string;
    engine_version: string;
  }): WorkflowClusterRecord {
    return {
      clusterId: row.cluster_id,
      workspaceId: row.workspace_id ?? undefined,
      structuralHash: row.structural_hash,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      occurrenceCount: row.occurrence_count,
      evidenceEventIds: JSON.parse(row.evidence_event_ids_json || "[]") as string[],
      metrics: JSON.parse(row.metrics_json || "{}") as WorkflowClusterMetrics,
      engineVersion: row.engine_version,
    };
  }

  // ---------------------------------------------------------------------------
  // Cluster Episodes
  // ---------------------------------------------------------------------------

  async linkClusterEpisode(
    clusterId: string,
    episodeId: string,
    sessionId?: string,
  ): Promise<void> {
    this.conn.run(
      `INSERT INTO cluster_episodes (cluster_id, episode_id, session_id)
      VALUES (?, ?, ?)
      ON CONFLICT(cluster_id, episode_id) DO UPDATE SET
        session_id = excluded.session_id;`,
      [clusterId, episodeId, sessionId ?? null],
    );
  }

  // ---------------------------------------------------------------------------
  // Opportunity Hash Cache
  // ---------------------------------------------------------------------------

  async upsertHashCacheEntry(entry: OpportunityHashCacheRecord): Promise<void> {
    this.conn.run(
      `INSERT INTO opportunity_hash_cache (
        structural_hash, outcome, last_seen_at, attempts, source_revision, synced_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(structural_hash) DO UPDATE SET
        outcome = excluded.outcome,
        last_seen_at = excluded.last_seen_at,
        attempts = excluded.attempts,
        source_revision = excluded.source_revision,
        synced_at = excluded.synced_at,
        expires_at = excluded.expires_at;`,
      [
        entry.structuralHash,
        entry.outcome,
        entry.lastSeenAt,
        entry.attempts,
        entry.sourceRevision ?? null,
        entry.syncedAt,
        entry.expiresAt,
      ],
    );
  }

  async getHashCacheEntry(structuralHash: string): Promise<OpportunityHashCacheRecord | null> {
    const row = this.conn.get<{
      structural_hash: string;
      outcome: OpportunityHashOutcome;
      last_seen_at: string;
      attempts: number;
      source_revision: string | null;
      synced_at: string | null;
      expires_at: string;
    }>("SELECT * FROM opportunity_hash_cache WHERE structural_hash = ?;", [structuralHash]);

    return row ? this.mapHashCacheRow(row) : null;
  }

  async listRecentHashCache(since: string): Promise<OpportunityHashCacheRecord[]> {
    const rows = this.conn.all<{
      structural_hash: string;
      outcome: OpportunityHashOutcome;
      last_seen_at: string;
      attempts: number;
      source_revision: string | null;
      synced_at: string | null;
      expires_at: string;
    }>(
      `SELECT * FROM opportunity_hash_cache
       WHERE last_seen_at >= ?
       ORDER BY last_seen_at DESC, structural_hash ASC;`,
      [since],
    );

    return rows.map((row) => this.mapHashCacheRow(row));
  }

  async pruneHashCache(before: string): Promise<number> {
    const result = this.conn.run(
      "DELETE FROM opportunity_hash_cache WHERE expires_at IS NOT NULL AND expires_at < ?;",
      [before],
    );
    return result.changes;
  }

  private mapHashCacheRow(row: {
    structural_hash: string;
    outcome: OpportunityHashOutcome;
    last_seen_at: string;
    attempts: number;
    source_revision: string | null;
    synced_at: string | null;
    expires_at: string;
  }): OpportunityHashCacheRecord {
    return {
      structuralHash: row.structural_hash,
      outcome: row.outcome,
      lastSeenAt: row.last_seen_at,
      attempts: row.attempts,
      sourceRevision: row.source_revision ?? undefined,
      syncedAt: row.synced_at,
      expiresAt: row.expires_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Pattern Outbox
  // ---------------------------------------------------------------------------

  async enqueuePattern(pattern: {
    patternId: string;
    idempotencyKey: string;
    workspaceId?: string;
    payload: ProvenPatternDto;
    createdAt?: string;
  }): Promise<string> {
    const now = new Date().toISOString();
    const result = this.conn.run(
      `INSERT INTO pattern_outbox (
        pattern_id, idempotency_key, workspace_id, payload_json, created_at, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(idempotency_key) DO NOTHING;`,
      [
        pattern.patternId,
        pattern.idempotencyKey,
        pattern.workspaceId ?? null,
        canonicalJson(pattern.payload),
        pattern.createdAt ?? now,
      ],
    );

    if (result.changes > 0) {
      return pattern.patternId;
    }

    // Duplicate dispatch for the same idempotency key: return the already-queued pattern id.
    const existing = await this.getPatternByIdempotencyKey(pattern.idempotencyKey);
    return existing?.patternId ?? pattern.patternId;
  }

  async listPendingPatterns(limit = 50): Promise<PatternOutboxRecord[]> {
    const rows = this.conn.all<{
      pattern_id: string;
      idempotency_key: string;
      workspace_id: string | null;
      payload_json: string;
      created_at: string;
      uploaded_at: string | null;
    }>(
      `SELECT * FROM pattern_outbox
       WHERE uploaded_at IS NULL
       ORDER BY created_at ASC, pattern_id ASC
       LIMIT ?;`,
      [limit],
    );

    return rows.map((row) => this.mapPatternRow(row));
  }

  async markPatternUploaded(patternId: string, uploadedAt?: string): Promise<void> {
    this.conn.run(
      "UPDATE pattern_outbox SET uploaded_at = ? WHERE pattern_id = ? AND uploaded_at IS NULL;",
      [uploadedAt ?? new Date().toISOString(), patternId],
    );
  }

  async getPatternByIdempotencyKey(idempotencyKey: string): Promise<PatternOutboxRecord | null> {
    const row = this.conn.get<{
      pattern_id: string;
      idempotency_key: string;
      workspace_id: string | null;
      payload_json: string;
      created_at: string;
      uploaded_at: string | null;
    }>("SELECT * FROM pattern_outbox WHERE idempotency_key = ?;", [idempotencyKey]);

    return row ? this.mapPatternRow(row) : null;
  }

  private mapPatternRow(row: {
    pattern_id: string;
    idempotency_key: string;
    workspace_id: string | null;
    payload_json: string;
    created_at: string;
    uploaded_at: string | null;
  }): PatternOutboxRecord {
    return {
      patternId: row.pattern_id,
      idempotencyKey: row.idempotency_key,
      workspaceId: row.workspace_id ?? undefined,
      payload: JSON.parse(row.payload_json) as ProvenPatternDto,
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at ?? undefined,
    };
  }
}
