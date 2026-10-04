import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOURNAL_SIZE_LIMIT_BYTES, LocalDatabaseConnection } from "../src/connection.js";
import { runStateDbMaintenance } from "../src/maintenance.js";
import { createLocalStateStore } from "../src/store.js";

const BLOB_BYTES = 8 * 1024;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-db-maint-"));
  dbPath = path.join(tmpDir, "state.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function walBytes(): number {
  const walPath = `${dbPath}-wal`;
  return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
}

/** Fills then deletes most rows so the file is dominated by free pages. */
function bloat(conn: LocalDatabaseConnection, rows = 1500, keep = 50): void {
  conn.exec("CREATE TABLE IF NOT EXISTS payloads (id INTEGER PRIMARY KEY, body BLOB NOT NULL);");
  conn.exec("BEGIN;");
  for (let i = 0; i < rows; i += 1) {
    conn.run("INSERT INTO payloads (body) VALUES (randomblob(?));", [BLOB_BYTES]);
  }
  conn.exec("COMMIT;");
  conn.run("DELETE FROM payloads WHERE id > ?;", [keep]);
}

/** Creates a database the way releases before auto_vacuum=INCREMENTAL did. */
function createLegacyDatabase(): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("PRAGMA journal_mode = WAL;");
  legacy.exec("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body BLOB NOT NULL);");
  legacy.close();
}

describe("state database storage maintenance", () => {
  it("creates new databases with auto_vacuum=INCREMENTAL and a WAL size limit", async () => {
    const store = createLocalStateStore({ path: dbPath });
    await store.initialize();

    expect(store.conn.pragmaNumber("auto_vacuum")).toBe(2);
    expect(store.conn.pragmaNumber("journal_size_limit")).toBe(JOURNAL_SIZE_LIMIT_BYTES);
    store.close();
  });

  it("releases free pages incrementally and truncates the WAL after a prune", () => {
    const conn = new LocalDatabaseConnection({ path: dbPath }).open();
    bloat(conn);
    const freeBefore = conn.pragmaNumber("freelist_count");
    expect(freeBefore).toBeGreaterThan(1000);
    expect(walBytes()).toBeGreaterThan(0);

    // Bounded: a 1 MiB budget frees exactly 256 four-KiB pages.
    const bounded = runStateDbMaintenance(conn, { incrementalVacuumMaxBytes: 1024 * 1024 });
    expect(bounded.action).toBe("incremental_vacuum");
    expect(bounded.freelistAfter).toBe(freeBefore - (1024 * 1024) / bounded.pageSize);
    expect(walBytes()).toBe(0);

    const full = runStateDbMaintenance(conn);
    expect(full.freelistAfter).toBe(0);
    expect(full.pageCountAfter).toBeLessThan(full.pageCountBefore);
    expect(conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM payloads;")?.n).toBe(50);
    conn.close();

    expect(fs.statSync(dbPath).size).toBe(full.pageCountAfter * full.pageSize);
  });

  it("converts a bloated legacy database with VACUUM and keeps its data", () => {
    createLegacyDatabase();
    const conn = new LocalDatabaseConnection({ path: dbPath }).open();
    expect(conn.pragmaNumber("auto_vacuum")).toBe(0);
    bloat(conn);
    const sizeBefore = fs.statSync(dbPath).size + walBytes();

    const result = runStateDbMaintenance(conn);

    expect(result.action).toBe("vacuum");
    expect(result.autoVacuumBefore).toBe("none");
    expect(result.autoVacuumAfter).toBe("incremental");
    expect(result.freelistAfter).toBe(0);
    expect(walBytes()).toBe(0);
    expect(conn.get<{ n: number }>("SELECT COUNT(*) AS n FROM payloads;")?.n).toBe(50);
    conn.close();

    expect(fs.statSync(dbPath).size).toBeLessThan(sizeBefore / 10);
    const reopened = new LocalDatabaseConnection({ path: dbPath }).open();
    expect(reopened.pragmaNumber("auto_vacuum")).toBe(2);
    expect(reopened.integrityCheck().ok).toBe(true);
    reopened.close();
  });

  it("leaves a mostly-live legacy database alone apart from the WAL checkpoint", () => {
    createLegacyDatabase();
    const conn = new LocalDatabaseConnection({ path: dbPath }).open();
    bloat(conn, 600, 400);

    const result = runStateDbMaintenance(conn);

    expect(result.action).toBe("checkpoint_only");
    expect(result.autoVacuumAfter).toBe("none");
    expect(result.freelistAfter).toBe(result.freelistBefore);
    expect(walBytes()).toBe(0);
    conn.close();
  });

  it("defers VACUUM when the live data exceeds the online rewrite limit", () => {
    createLegacyDatabase();
    const conn = new LocalDatabaseConnection({ path: dbPath }).open();
    bloat(conn);

    const result = runStateDbMaintenance(conn, { vacuumMaxLiveBytes: 4096 });

    expect(result.action).toBe("vacuum_deferred");
    expect(result.freelistAfter).toBe(result.freelistBefore);
    expect(conn.pragmaNumber("auto_vacuum")).toBe(0);
    conn.close();
  });

  it("skips while a transaction is open on the connection", async () => {
    const conn = new LocalDatabaseConnection({ path: dbPath }).open();
    bloat(conn);

    const result = await conn.transaction(() => runStateDbMaintenance(conn));

    expect(result.action).toBe("skipped");
    expect(result.skippedReason).toBe("in_transaction");
    expect(conn.pragmaNumber("freelist_count")).toBe(result.freelistBefore);
    conn.close();
  });
});
