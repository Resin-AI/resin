import { hashCanonicalContent } from "@resin/contracts";
import type { LocalDatabaseConnection } from "./connection.js";

/**
 * Migration definition structure.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum?: string;
}

/**
 * Record of an applied migration from the `_local_migrations` table.
 */
export interface AppliedMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
  readonly checksum: string;
}

/**
 * Summary of a migration run.
 */
export interface MigrationResult {
  readonly initialVersion: number;
  readonly targetVersion: number;
  readonly appliedVersions: number[];
  readonly integrityOk: boolean;
}

/**
 * Error thrown when database schema is newer than the running codebase.
 */
export class FutureMigrationError extends Error {
  constructor(dbVersion: number, codeVersion: number) {
    super(
      `Database schema version (${dbVersion}) is newer than codebase maximum supported version (${codeVersion}). Downgrades are not supported; update resin software.`,
    );
    this.name = "FutureMigrationError";
  }
}

/**
 * Error thrown when an existing migration's checksum or sequence does not match.
 */
export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(`Migration integrity check failed: ${message}`);
    this.name = "MigrationIntegrityError";
  }
}

/**
 * Initial local database schema SQL.
 */
export const INITIAL_SCHEMA_SQL = `
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
`;

/**
 * Migration 002: Add uploaded_at column to invocation_records for telemetry upload tracking.
 */
export const MIGRATION_002_SQL = `
ALTER TABLE invocation_records ADD COLUMN uploaded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_invocation_records_uploaded_at ON invocation_records(uploaded_at);
`;

/**
 * Registry of built-in migrations for local state store.
 */
export const BUILT_IN_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "001_initial_local_schema",
    sql: INITIAL_SCHEMA_SQL,
    checksum: hashCanonicalContent(INITIAL_SCHEMA_SQL),
  },
  {
    version: 2,
    name: "002_add_invocation_records_uploaded_at",
    sql: MIGRATION_002_SQL,
    checksum: hashCanonicalContent(MIGRATION_002_SQL),
  },
];

/**
 * Migration runner responsible for atomic schema execution, version validation,
 * PRAGMA integrity verification, and future-version protection.
 */
export class MigrationRunner {
  private readonly conn: LocalDatabaseConnection;
  private readonly migrations: readonly Migration[];

  constructor(
    conn: LocalDatabaseConnection,
    migrations: readonly Migration[] = BUILT_IN_MIGRATIONS,
  ) {
    this.conn = conn;
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
  }

  /**
   * Initializes the migrations table and returns applied migrations.
   */
  getAppliedMigrations(): AppliedMigrationRecord[] {
    this.ensureVersionTable();
    return this.conn.all<AppliedMigrationRecord>(
      "SELECT version, name, applied_at, checksum FROM _local_migrations ORDER BY version ASC;",
    );
  }

  /**
   * Returns current schema version or 0 if uninitialized.
   */
  getCurrentVersion(): number {
    this.ensureVersionTable();
    const row = this.conn.get<{ max_version: number | null }>(
      "SELECT MAX(version) AS max_version FROM _local_migrations;",
    );
    return row?.max_version ?? 0;
  }

  /**
   * Executes all pending forward migrations within transactional boundaries.
   */
  async migrate(targetVersion?: number): Promise<MigrationResult> {
    const preCheck = this.conn.integrityCheck();
    if (!preCheck.ok) {
      throw new MigrationIntegrityError(
        `Pre-migration integrity check failed: ${preCheck.details.join("; ")}`,
      );
    }

    this.ensureVersionTable();
    const applied = this.getAppliedMigrations();

    const maxCodebaseVersion =
      this.migrations.length > 0 ? this.migrations[this.migrations.length - 1].version : 0;
    const currentDbVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;

    // Safety guard: prevent older codebase from running on newer schema
    if (currentDbVersion > maxCodebaseVersion) {
      throw new FutureMigrationError(currentDbVersion, maxCodebaseVersion);
    }

    // Verify existing applied migrations match checksums / names
    for (const app of applied) {
      const codeMigration = this.migrations.find((m) => m.version === app.version);
      if (!codeMigration) {
        throw new FutureMigrationError(app.version, maxCodebaseVersion);
      }
      const expectedChecksum = codeMigration.checksum ?? hashCanonicalContent(codeMigration.sql);
      if (app.checksum !== expectedChecksum) {
        throw new MigrationIntegrityError(
          `Checksum mismatch for migration v${app.version} (${app.name}). Applied: ${app.checksum}, Expected: ${expectedChecksum}`,
        );
      }
    }

    const effectiveTarget = targetVersion ?? maxCodebaseVersion;
    const pendingMigrations = this.migrations.filter(
      (m) => m.version > currentDbVersion && m.version <= effectiveTarget,
    );

    const newlyApplied: number[] = [];

    for (const migration of pendingMigrations) {
      await this.conn.transaction((txConn) => {
        txConn.exec(migration.sql);
        const checksum = migration.checksum ?? hashCanonicalContent(migration.sql);
        const now = new Date().toISOString();
        txConn.run(
          "INSERT INTO _local_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?);",
          [migration.version, migration.name, now, checksum],
        );
      });
      newlyApplied.push(migration.version);
    }

    const postCheck = this.conn.integrityCheck();
    if (!postCheck.ok) {
      throw new MigrationIntegrityError(
        `Post-migration integrity check failed: ${postCheck.details.join("; ")}`,
      );
    }

    return {
      initialVersion: currentDbVersion,
      targetVersion: this.getCurrentVersion(),
      appliedVersions: newlyApplied,
      integrityOk: postCheck.ok,
    };
  }

  private ensureVersionTable(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS _local_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
    `);
  }
}
