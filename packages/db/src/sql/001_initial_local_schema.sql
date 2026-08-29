-- Resin Local SQLite State Store Schema
-- Migration: 001_initial_local_schema.sql

-- 1. Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  capability_envelope_json TEXT NOT NULL,
  active_tools_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspaces_root_path ON workspaces(root_path);

-- 2. Sessions
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE SET NULL,
  harness_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_identity_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_harness_id ON sessions(harness_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- 3. Source Cursors
CREATE TABLE IF NOT EXISTS source_cursors (
  cursor_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  workspace_id TEXT,
  entity_type TEXT NOT NULL,
  last_synced_sequence INTEGER NOT NULL DEFAULT 0,
  last_synced_timestamp TEXT NOT NULL,
  sync_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_cursors_device_entity ON source_cursors(device_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_source_cursors_workspace ON source_cursors(workspace_id);

-- 4. Raw Record Refs
CREATE TABLE IF NOT EXISTS raw_record_refs (
  record_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  storage_path TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_raw_record_refs_session_id ON raw_record_refs(session_id);
CREATE INDEX IF NOT EXISTS idx_raw_record_refs_source_id ON raw_record_refs(source_id);
CREATE INDEX IF NOT EXISTS idx_raw_record_refs_payload_hash ON raw_record_refs(payload_hash);

-- 5. Normalized Events
CREATE TABLE IF NOT EXISTS normalized_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  causal_parent_id TEXT,
  payload_json TEXT NOT NULL,
  redaction_meta_json TEXT,
  digest TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_normalized_events_session_sequence ON normalized_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_normalized_events_session_time ON normalized_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_normalized_events_type ON normalized_events(type);
CREATE INDEX IF NOT EXISTS idx_normalized_events_digest ON normalized_events(digest);

-- 6. Upload Batches
CREATE TABLE IF NOT EXISTS upload_batches (
  batch_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_batches_status ON upload_batches(status);
CREATE INDEX IF NOT EXISTS idx_upload_batches_created_at ON upload_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_upload_batches_workspace ON upload_batches(workspace_id);

-- 7. Upload Acknowledgements
CREATE TABLE IF NOT EXISTS upload_acknowledgements (
  ack_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(batch_id) ON DELETE CASCADE,
  server_timestamp TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_acknowledgements_batch_id ON upload_acknowledgements(batch_id);

-- 8. Dead Letters
CREATE TABLE IF NOT EXISTS dead_letters (
  dead_letter_id TEXT PRIMARY KEY,
  original_event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_status ON dead_letters(status);
CREATE INDEX IF NOT EXISTS idx_dead_letters_failed_at ON dead_letters(failed_at);

-- 9. Tool Manifests
CREATE TABLE IF NOT EXISTS tool_manifests (
  tool_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'workspace',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  output_schema_json TEXT,
  runtime_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_manifests_name ON tool_manifests(name);
CREATE INDEX IF NOT EXISTS idx_tool_manifests_version ON tool_manifests(version);
CREATE INDEX IF NOT EXISTS idx_tool_manifests_digest ON tool_manifests(digest);
CREATE INDEX IF NOT EXISTS idx_tool_manifests_scope ON tool_manifests(scope);

-- 10. Tool Versions
CREATE TABLE IF NOT EXISTS tool_versions (
  tool_id TEXT NOT NULL REFERENCES tool_manifests(tool_id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  signature_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tool_id, version)
);
CREATE INDEX IF NOT EXISTS idx_tool_versions_manifest_digest ON tool_versions(manifest_digest);
CREATE INDEX IF NOT EXISTS idx_tool_versions_artifact_digest ON tool_versions(artifact_digest);
CREATE INDEX IF NOT EXISTS idx_tool_versions_status ON tool_versions(status);

-- 11. Catalog Snapshots
CREATE TABLE IF NOT EXISTS catalog_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '{}',
  digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_snapshots_workspace_time ON catalog_snapshots(workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_catalog_snapshots_digest ON catalog_snapshots(digest);

-- 12. Capability Envelopes
CREATE TABLE IF NOT EXISTS capability_envelopes (
  envelope_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  version TEXT NOT NULL,
  fs_json TEXT NOT NULL DEFAULT '{}',
  net_json TEXT NOT NULL DEFAULT '{}',
  command_json TEXT NOT NULL DEFAULT '{}',
  secrets_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  is_frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capability_envelopes_workspace ON capability_envelopes(workspace_id);

-- 13. Capability Grants
CREATE TABLE IF NOT EXISTS capability_grants (
  grant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  grant_type TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  actor_json TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_capability_grants_workspace_tool ON capability_grants(workspace_id, tool_id);
CREATE INDEX IF NOT EXISTS idx_capability_grants_granted_at ON capability_grants(granted_at);

-- 14. Deployment Records
CREATE TABLE IF NOT EXISTS deployment_records (
  deployment_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  state TEXT NOT NULL,
  canary_config_json TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  active_traffic_percentage REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployment_records_workspace_tool ON deployment_records(workspace_id, tool_id, tool_version);
CREATE INDEX IF NOT EXISTS idx_deployment_records_state ON deployment_records(state);

-- 15. Installations
CREATE TABLE IF NOT EXISTS installations (
  installation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  config_overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_installations_workspace_tool ON installations(workspace_id, tool_id);
CREATE INDEX IF NOT EXISTS idx_installations_deployment_id ON installations(deployment_id);
CREATE INDEX IF NOT EXISTS idx_installations_state ON installations(state);

-- 16. Harness Installations
CREATE TABLE IF NOT EXISTS harness_installations (
  harness_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (harness_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS idx_harness_installations_state ON harness_installations(state);

-- 17. Invocation Records
CREATE TABLE IF NOT EXISTS invocation_records (
  invocation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  input_digest TEXT NOT NULL,
  output_digest TEXT,
  error_details_json TEXT,
  resource_usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_invocation_records_session ON invocation_records(session_id);
CREATE INDEX IF NOT EXISTS idx_invocation_records_tool ON invocation_records(tool_id);
CREATE INDEX IF NOT EXISTS idx_invocation_records_status ON invocation_records(status);
CREATE INDEX IF NOT EXISTS idx_invocation_records_started_at ON invocation_records(started_at);

-- 18. Audit Records
CREATE TABLE IF NOT EXISTS audit_records (
  audit_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  workspace_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  details_json TEXT NOT NULL DEFAULT '{}',
  client_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_records_event_type ON audit_records(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_records_timestamp ON audit_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_records_workspace ON audit_records(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_records_resource ON audit_records(resource_type, resource_id);

-- 19. Local Outbox
CREATE TABLE IF NOT EXISTS local_outbox (
  outbox_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  next_retry_at TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_outbox_status ON local_outbox(status);
CREATE INDEX IF NOT EXISTS idx_local_outbox_next_retry ON local_outbox(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_local_outbox_created_at ON local_outbox(created_at);

-- 20. Local Inbox
CREATE TABLE IF NOT EXISTS local_inbox (
  inbox_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_inbox_source_msg ON local_inbox(source, message_id);
CREATE INDEX IF NOT EXISTS idx_local_inbox_status ON local_inbox(status);
CREATE INDEX IF NOT EXISTS idx_local_inbox_received_at ON local_inbox(received_at);
