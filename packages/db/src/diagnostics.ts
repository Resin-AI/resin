import fs from "node:fs";
import type { LocalDatabaseConnection } from "./connection.js";

const SENSITIVE_KEY_PATTERN = /token|secret|password|key|auth|credential|jwt/i;
const REDACTED_PLACEHOLDER = "[REDACTED]";

export type DiagnosticMetadataValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | DiagnosticMetadataRecord
  | DiagnosticMetadataValue[];

export interface DiagnosticMetadataRecord {
  [key: string]: DiagnosticMetadataValue;
}

/**
 * Deeply redacts sensitive keys from any object/record.
 */
export function redactSensitiveData(data: DiagnosticMetadataRecord): DiagnosticMetadataRecord {
  if (data === null || data === undefined) {
    return {};
  }

  const result: DiagnosticMetadataRecord = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      Object.prototype.toString.call(value) === "[object String]" &&
      String(value).length > 0
    ) {
      result[key] = REDACTED_PLACEHOLDER;
    } else if (
      Object.prototype.toString.call(value) === "[object Object]" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // SAFETY: Nested object is confirmed to be an object before recursion.
      result[key] = redactSensitiveData(value as DiagnosticMetadataRecord);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (
          Object.prototype.toString.call(item) === "[object Object]" &&
          item !== null &&
          !Array.isArray(item)
        ) {
          // SAFETY: Nested object in array is confirmed to be an object before recursion.
          return redactSensitiveData(item as DiagnosticMetadataRecord);
        }
        return item;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}
/**
 * Diagnostics report structure for LocalStateStore.
 */
export interface DatabaseDiagnosticsReport {
  timestamp: string;
  databasePath: string;
  isMemory: boolean;
  fileSizeBytes: number;
  walFileSizeBytes: number;
  sqliteVersion: string;
  journalMode: string;
  foreignKeysEnabled: boolean;
  busyTimeoutMs: number;
  integrityOk: boolean;
  integrityDetails: string[];
  schemaVersion: number;
  appliedMigrations: Array<{ version: number; name: string; appliedAt: string }>;
  tableCounts: Record<string, number>;
  metadata: DiagnosticMetadataRecord;
}

/**
 * Tables monitored for diagnostics row counting.
 */
export const STATE_STORE_TABLES = [
  "workspaces",
  "sessions",
  "source_cursors",
  "raw_record_refs",
  "normalized_events",
  "upload_batches",
  "upload_acknowledgements",
  "dead_letters",
  "tool_manifests",
  "tool_versions",
  "catalog_snapshots",
  "capability_envelopes",
  "capability_grants",
  "deployment_records",
  "installations",
  "harness_installations",
  "invocation_records",
  "audit_records",
  "local_outbox",
  "local_inbox",
  "_local_migrations",
] as const;

/**
 * Exports detailed database diagnostics with safe redaction.
 */
export function exportDatabaseDiagnostics(
  conn: LocalDatabaseConnection,
  extraMetadata: DiagnosticMetadataRecord = {},
): DatabaseDiagnosticsReport {
  const location = conn.getLocation();
  const isMemory = location === ":memory:";

  let fileSizeBytes = 0;
  let walFileSizeBytes = 0;

  if (!isMemory) {
    try {
      if (fs.existsSync(location)) {
        fileSizeBytes = fs.statSync(location).size;
      }
      const walPath = `${location}-wal`;
      if (fs.existsSync(walPath)) {
        walFileSizeBytes = fs.statSync(walPath).size;
      }
    } catch {
      // Ignore filesystem stat errors in restricted sandbox
    }
  }

  // PRAGMA checks
  const sqliteVerRow = conn.get<{ sqlite_version: string }>(
    "SELECT sqlite_version() AS sqlite_version;",
  );
  const journalRow = conn.get<{ journal_mode: string }>("PRAGMA journal_mode;");
  const fkRow = conn.get<{ foreign_keys: number }>("PRAGMA foreign_keys;");
  const timeoutRow = conn.get<{ timeout: number }>("PRAGMA busy_timeout;");
  const integrity = conn.integrityCheck();

  // Schema version & migrations
  let schemaVersion = 0;
  let appliedMigrations: Array<{ version: number; name: string; appliedAt: string }> = [];

  try {
    const verRow = conn.get<{ max_v: number | null }>(
      "SELECT MAX(version) AS max_v FROM _local_migrations;",
    );
    schemaVersion = verRow?.max_v ?? 0;

    const migRows = conn.all<{ version: number; name: string; applied_at: string }>(
      "SELECT version, name, applied_at FROM _local_migrations ORDER BY version ASC;",
    );
    appliedMigrations = migRows.map((r) => ({
      version: r.version,
      name: r.name,
      appliedAt: r.applied_at,
    }));
  } catch {
    // Migration table might not be created yet
  }

  // Table row counts
  const tableCounts: Record<string, number> = {};
  for (const table of STATE_STORE_TABLES) {
    try {
      const countRow = conn.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`);
      tableCounts[table] = countRow?.count ?? 0;
    } catch {
      tableCounts[table] = -1; // Table not created yet
    }
  }

  // Safe redaction on any extra metadata
  const safeMetadata = redactSensitiveData(extraMetadata);

  return {
    timestamp: new Date().toISOString(),
    databasePath: isMemory ? ":memory:" : location,
    isMemory,
    fileSizeBytes,
    walFileSizeBytes,
    sqliteVersion: sqliteVerRow?.sqlite_version ?? "unknown",
    journalMode: journalRow?.journal_mode ?? "unknown",
    foreignKeysEnabled: (fkRow?.foreign_keys ?? 0) === 1,
    busyTimeoutMs: timeoutRow?.timeout ?? 0,
    integrityOk: integrity.ok,
    integrityDetails: integrity.details,
    schemaVersion,
    appliedMigrations,
    tableCounts,
    metadata: safeMetadata,
  };
}
