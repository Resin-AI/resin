import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * Supported SQL bind input value type in node:sqlite.
 */
export type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

export type SQLBindScalar =
  | null
  | undefined
  | number
  | bigint
  | string
  | boolean
  | NodeJS.ArrayBufferView;

export interface SQLBindRecord {
  [key: string]: SQLBindValue;
}

export type SQLBindValue = SQLBindScalar | SQLBindRecord | SQLBindValue[];

export interface SQLNamedParams {
  [param: string]: SQLBindValue;
}

export type SQLParams = SQLBindValue[] | SQLNamedParams;

export interface SQLRow {
  [column: string]: SQLInputValue;
}
/**
 * Options for configuring a LocalDatabaseConnection.
 */
export interface LocalDatabaseOptions {
  /**
   * File path to SQLite database. Use ':memory:' or leave blank when inMemory is true.
   */
  path?: string;
  /**
   * If true, opens an isolated in-memory SQLite database.
   */
  inMemory?: boolean;
  /**
   * Timeout in milliseconds to wait for locked tables. Default: 5000ms.
   */
  busyTimeoutMs?: number;
  /**
   * If true, opens database in read-only mode.
   */
  readOnly?: boolean;
  /**
   * Max cached prepared statements per connection. Default: 256.
   */
  statementCacheSize?: number;
}

/**
 * Result of an insert / update / delete execution.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Result of database integrity checks.
 */
export interface IntegrityCheckResult {
  ok: boolean;
  details: string[];
}

/**
 * Result of PRAGMA wal_checkpoint. `busy` means a reader or writer blocked completion.
 */
export interface WalCheckpointResult {
  busy: boolean;
  logFrames: number;
  checkpointedFrames: number;
}

/** Size a reset WAL is truncated back to (PRAGMA journal_size_limit). */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Normalizes any JavaScript value to a valid SQLite bind parameter.
 */
export function toSQLInputValue(val: SQLBindValue): SQLInputValue {
  if (val === undefined || val === null) {
    return null;
  }
  if (Object.prototype.toString.call(val) === "[object Boolean]") {
    return val ? 1 : 0;
  }
  if (
    Object.prototype.toString.call(val) === "[object Number]" ||
    Object.prototype.toString.call(val) === "[object BigInt]" ||
    Object.prototype.toString.call(val) === "[object String]"
  ) {
    // SAFETY: val is verified to be a number, bigint, or string SQLite value.
    return val as SQLInputValue;
  }
  if (ArrayBuffer.isView(val)) {
    return val;
  }
  return JSON.stringify(val);
}

/**
 * Encapsulated SQLite connection managing PRAGMAs, statement caches,
 * transactional savepoints, and crash-resilient WAL operations.
 */
export class LocalDatabaseConnection {
  private readonly options: LocalDatabaseOptions;
  private readonly location: string;
  private db: DatabaseSync | null = null;
  private statementCache = new Map<string, StatementSync>();
  private savepointDepth = 0;

  constructor(options: LocalDatabaseOptions = {}) {
    this.options = {
      busyTimeoutMs: 5000,
      statementCacheSize: 256,
      ...options,
    };

    if (this.options.inMemory || !this.options.path || this.options.path === ":memory:") {
      this.location = ":memory:";
    } else {
      this.location = path.resolve(this.options.path);
    }
  }

  /**
   * Location of the database (file path or ':memory:').
   */
  getLocation(): string {
    return this.location;
  }

  /**
   * Returns true if database is currently open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Opens the database connection and configures required PRAGMAs.
   */
  open(): this {
    if (this.db) {
      return this;
    }

    if (this.location !== ":memory:") {
      const dir = path.dirname(this.location);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.location, {
      readOnly: this.options.readOnly ?? false,
      enableForeignKeyConstraints: true,
    });

    // Execute standard SQLite pragmas
    this.db.exec("PRAGMA foreign_keys = ON;");
    const timeout = this.options.busyTimeoutMs ?? 5000;
    this.db.exec(`PRAGMA busy_timeout = ${timeout};`);

    if (!this.options.readOnly && this.pragmaNumber("page_count") === 0) {
      // auto_vacuum only applies before the first page is written; existing databases are
      // converted by runStateDbMaintenance's VACUUM instead.
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    }

    if (this.location !== ":memory:") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
        // Without a limit a WAL keeps its high-water size after every checkpoint.
        this.db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES};`);
      } catch {
        // Fall back gracefully if journal mode alteration fails (e.g. read-only)
      }
    }

    return this;
  }

  /**
   * Closes connection and cleans up prepared statement cache.
   */
  close(): void {
    if (!this.db) {
      return;
    }

    this.statementCache.clear();
    this.db.close();
    this.db = null;
    this.savepointDepth = 0;
  }

  /**
   * Returns underlying SQLite DatabaseSync instance.
   */
  getRawHandle(): DatabaseSync {
    this.ensureOpen();
    return this.db!;
  }

  /**
   * Executes one or more raw SQL statements directly.
   */
  exec(sql: string): void {
    this.ensureOpen();
    this.db!.exec(sql);
  }

  /**
   * Prepares and caches a SQL statement.
   */
  prepare(sql: string): StatementSync {
    this.ensureOpen();
    const cached = this.statementCache.get(sql);
    if (cached) {
      return cached;
    }

    const stmt = this.db!.prepare(sql);
    const maxCache = this.options.statementCacheSize ?? 256;
    if (this.statementCache.size >= maxCache) {
      const firstKey = this.statementCache.keys().next().value;
      if (firstKey !== undefined) {
        this.statementCache.delete(firstKey);
      }
    }
    this.statementCache.set(sql, stmt);
    return stmt;
  }

  /**
   * Runs a parameterized query and returns changes and lastInsertRowid.
   */
  run(sql: string, params?: SQLParams): RunResult {
    const stmt = this.prepare(sql);
    const res = this.bindAndRun(stmt, params);
    return {
      changes: Number(res.changes),
      lastInsertRowid: res.lastInsertRowid,
    };
  }

  /**
   * Executes query and returns first matched row or null.
   */
  get<T = SQLRow>(sql: string, params?: SQLParams): T | null {
    const stmt = this.prepare(sql);
    const row = this.bindAndGet(stmt, params);
    if (!row) {
      return null;
    }
    // SAFETY: Row is cast to caller-requested schema type T.
    return row as T;
  }

  /**
   * Executes query and returns all matching rows.
   */
  all<T = SQLRow>(sql: string, params?: SQLParams): T[] {
    const stmt = this.prepare(sql);
    // SAFETY: Rows array is cast to caller-requested schema rows T[].
    return this.bindAndAll(stmt, params) as T[];
  }

  /**
   * Executes a transaction block with automatic rollback on error.
   * Supports nested transactions via named SAVEPOINTs.
   */
  async transaction<T>(fn: (conn: LocalDatabaseConnection) => Promise<T> | T): Promise<T> {
    this.ensureOpen();
    const isRoot = this.savepointDepth === 0;
    const savepointName = `sp_${this.savepointDepth++}`;

    try {
      if (isRoot) {
        this.db!.exec("BEGIN IMMEDIATE;");
      } else {
        this.db!.exec(`SAVEPOINT ${savepointName};`);
      }

      const result = await fn(this);

      if (isRoot) {
        this.db!.exec("COMMIT;");
      } else {
        this.db!.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }

      this.savepointDepth--;
      return result;
    } catch (err) {
      try {
        if (isRoot) {
          this.db!.exec("ROLLBACK;");
        } else {
          this.db!.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
          this.db!.exec(`RELEASE SAVEPOINT ${savepointName};`);
        }
      } catch {
        // Ignore secondary rollback failures
      }
      this.savepointDepth = Math.max(0, this.savepointDepth - 1);
      throw err;
    }
  }

  /**
   * Runs SQLite PRAGMA integrity_check and returns status.
   */
  integrityCheck(): IntegrityCheckResult {
    this.ensureOpen();
    const rows = this.all<{ integrity_check: string }>("PRAGMA integrity_check;");
    const details = rows.map((r) => r.integrity_check);
    const ok = details.length === 1 && details[0] === "ok";
    return { ok, details };
  }

  /**
   * Returns true while a transaction or savepoint opened through transaction() is active.
   */
  inTransaction(): boolean {
    return this.savepointDepth > 0;
  }

  /**
   * Returns true when the connection was opened read-only.
   */
  isReadOnly(): boolean {
    return this.options.readOnly === true;
  }

  /**
   * Reads a single-valued numeric PRAGMA such as page_count or freelist_count.
   */
  pragmaNumber(name: string): number {
    this.ensureOpen();
    const row = this.db!.prepare(`PRAGMA ${name};`).get() as Record<string, unknown> | undefined;
    return Number(row ? Object.values(row)[0] : 0);
  }

  /**
   * Checkpoints the WAL into the main database file. Returns SQLite's result row, or null for
   * in-memory databases that have no WAL.
   */
  checkpoint(
    mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE",
  ): WalCheckpointResult | null {
    this.ensureOpen();
    if (this.location === ":memory:") {
      return null;
    }
    const row = this.db!.prepare(`PRAGMA wal_checkpoint(${mode});`).get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    return {
      busy: Number(row?.busy ?? 0) !== 0,
      logFrames: Number(row?.log ?? 0),
      checkpointedFrames: Number(row?.checkpointed ?? 0),
    };
  }

  private ensureOpen(): void {
    if (!this.db) {
      this.open();
    }
  }

  private bindAndRun(
    stmt: StatementSync,
    params?: SQLParams,
  ): { changes: number | bigint; lastInsertRowid: number | bigint } {
    if (params === undefined || params === null) {
      return stmt.run();
    }
    if (Array.isArray(params)) {
      const bound = params.map(toSQLInputValue);
      return stmt.run(...bound);
    }
    const bound: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) {
      bound[k] = toSQLInputValue(v);
    }
    return stmt.run(bound);
  }

  private bindAndGet(
    stmt: StatementSync,
    params?: SQLParams,
  ): Record<string, SQLInputValue> | undefined {
    if (params === undefined || params === null) {
      // SAFETY: node:sqlite statement get returns row record or undefined.
      return stmt.get() as Record<string, SQLInputValue> | undefined;
    }
    if (Array.isArray(params)) {
      const bound = params.map(toSQLInputValue);
      // SAFETY: node:sqlite statement get returns row record or undefined.
      return stmt.get(...bound) as Record<string, SQLInputValue> | undefined;
    }
    const bound: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) {
      bound[k] = toSQLInputValue(v);
    }
    // SAFETY: node:sqlite statement get returns row record or undefined.
    return stmt.get(bound) as Record<string, SQLInputValue> | undefined;
  }

  private bindAndAll(
    stmt: StatementSync,
    params?: SQLParams,
  ): Array<Record<string, SQLInputValue>> {
    if (params === undefined || params === null) {
      // SAFETY: node:sqlite statement all returns row records array.
      return stmt.all() as Array<Record<string, SQLInputValue>>;
    }
    if (Array.isArray(params)) {
      const bound = params.map(toSQLInputValue);
      // SAFETY: node:sqlite statement all returns row records array.
      return stmt.all(...bound) as Array<Record<string, SQLInputValue>>;
    }
    const bound: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) {
      bound[k] = toSQLInputValue(v);
    }
    // SAFETY: node:sqlite statement all returns row records array.
    return stmt.all(bound) as Array<Record<string, SQLInputValue>>;
  }
}
