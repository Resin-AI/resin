-- Resin Local SQLite State Store Schema
-- Migration: 004_add_local_opportunity_tables.sql

-- 1. Session Signatures
CREATE TABLE IF NOT EXISTS session_signatures (
  signature_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  structural_hash TEXT NOT NULL,
  episode_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_signatures_session_id ON session_signatures(session_id);
CREATE INDEX IF NOT EXISTS idx_session_signatures_structural_hash ON session_signatures(structural_hash);
CREATE INDEX IF NOT EXISTS idx_session_signatures_episode_id ON session_signatures(episode_id);

-- 2. Workflow Clusters
CREATE TABLE IF NOT EXISTS workflow_clusters (
  cluster_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  structural_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  engine_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_clusters_structural_hash ON workflow_clusters(structural_hash);
CREATE INDEX IF NOT EXISTS idx_workflow_clusters_workspace_id ON workflow_clusters(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workflow_clusters_last_seen_at ON workflow_clusters(last_seen_at);

-- 3. Cluster Episodes
CREATE TABLE IF NOT EXISTS cluster_episodes (
  cluster_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (cluster_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_cluster_episodes_session_id ON cluster_episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_cluster_episodes_episode_id ON cluster_episodes(episode_id);

-- 4. Opportunity Hash Cache
CREATE TABLE IF NOT EXISTS opportunity_hash_cache (
  structural_hash TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  source_revision TEXT,
  synced_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_opportunity_hash_cache_last_seen_at ON opportunity_hash_cache(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_opportunity_hash_cache_expires_at ON opportunity_hash_cache(expires_at);

-- 5. Pattern Outbox
CREATE TABLE IF NOT EXISTS pattern_outbox (
  pattern_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pattern_outbox_workspace_id ON pattern_outbox(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pattern_outbox_created_at ON pattern_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_pattern_outbox_uploaded_at ON pattern_outbox(uploaded_at);
