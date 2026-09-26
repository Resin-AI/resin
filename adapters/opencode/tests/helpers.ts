import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RawHarnessRecord, SessionEventSource } from "@resin/harness-contracts";

export const RECORDED_DIR = path.join(import.meta.dirname, "fixtures", "recorded");
export const SQLITE_EXPORT = path.join(RECORDED_DIR, "1.18.32", "opencode-db.jsonl");
export const LEGACY_STORAGE = path.join(RECORDED_DIR, "1.1.65", "storage");

interface ExportLine {
  table: string;
  schema?: string;
  row?: Record<string, unknown>;
}

function readExport(file: string): ExportLine[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportLine);
}

/** Table DDL from a recorded export, for tests that write their own rows. */
export function exportedSchemas(file: string = SQLITE_EXPORT): Record<string, string> {
  const schemas: Record<string, string> = {};
  for (const line of readExport(file)) {
    if (line.schema) schemas[line.table] = line.schema;
  }
  return schemas;
}

/**
 * Rebuilds an OpenCode SQLite store (WAL mode, like OpenCode itself) from a JSON export
 * written by `scripts/export-db.mjs`.
 */
export function rebuildSqliteStore(dbPath: string, file: string = SQLITE_EXPORT): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN");
  for (const line of readExport(file)) {
    if (line.schema) {
      db.exec(line.schema);
      continue;
    }
    if (!line.row) continue;
    const columns = Object.keys(line.row);
    const values = columns.map((column) => {
      const value = line.row![column];
      return column === "data" && typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : (value as string | number | null);
    });
    db.prepare(
      `INSERT INTO "${line.table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    ).run(...values);
  }
  db.exec("COMMIT");
  db.close();
}

export async function drain(
  source: SessionEventSource,
  batchSize = 50,
): Promise<RawHarnessRecord[]> {
  const records: RawHarnessRecord[] = [];
  for (;;) {
    const batch = await source.readNext(batchSize);
    if (batch.length === 0) return records;
    records.push(...batch);
  }
}
