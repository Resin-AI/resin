import { LocalDatabaseConnection, type LocalDatabaseOptions } from "./connection.js";
import {
  type DatabaseDiagnosticsReport,
  type DiagnosticMetadataRecord,
  exportDatabaseDiagnostics,
} from "./diagnostics.js";
import { type MigrationResult, MigrationRunner } from "./migrations.js";
import { AuditRepository } from "./repositories/audit-repository.js";
import { CapabilityRepository } from "./repositories/capability-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";
import { SyncRepository } from "./repositories/sync-repository.js";
import { ToolRepository } from "./repositories/tool-repository.js";
import { RetentionEngine, type RetentionOptions, type RetentionSummary } from "./retention.js";

/**
 * Main orchestrator for local SQLite state storage, transactional boundaries,
 * and repository access.
 */
export class LocalStateStore {
  readonly conn: LocalDatabaseConnection;
  readonly sessions: SessionRepository;
  readonly tools: ToolRepository;
  readonly capabilities: CapabilityRepository;
  readonly sync: SyncRepository;
  readonly audit: AuditRepository;
  readonly retention: RetentionEngine;
  readonly migrations: MigrationRunner;

  constructor(conn: LocalDatabaseConnection) {
    this.conn = conn;
    this.sessions = new SessionRepository(conn);
    this.tools = new ToolRepository(conn);
    this.capabilities = new CapabilityRepository(conn);
    this.sync = new SyncRepository(conn);
    this.audit = new AuditRepository(conn);
    this.retention = new RetentionEngine(conn);
    this.migrations = new MigrationRunner(conn);
  }

  /**
   * Opens connection and executes pending forward migrations.
   */
  async initialize(targetVersion?: number): Promise<MigrationResult> {
    this.conn.open();
    return this.migrations.migrate(targetVersion);
  }

  /**
   * Closes underlying database connection.
   */
  close(): void {
    this.conn.close();
  }

  /**
   * Returns true if database connection is open.
   */
  isOpen(): boolean {
    return this.conn.isOpen();
  }

  /**
   * Returns underlying database connection.
   */
  getConnection(): LocalDatabaseConnection {
    return this.conn;
  }

  /**
   * Executes callback within transactional boundaries, passing a transaction-scoped
   * store instance. Automatically rolls back on exception.
   */
  async transaction<T>(fn: (txStore: LocalStateStore) => Promise<T> | T): Promise<T> {
    return this.conn.transaction(async (txConn) => {
      const txStore = new LocalStateStore(txConn);
      return fn(txStore);
    });
  }

  /**
   * Executes retention pruning and compaction across acknowledged and stale entities.
   */
  async compact(options?: RetentionOptions): Promise<RetentionSummary> {
    return this.retention.compact(options);
  }

  /**
   * Exports sanitized database diagnostics report.
   */
  getDiagnostics(extraMetadata?: DiagnosticMetadataRecord): DatabaseDiagnosticsReport {
    return exportDatabaseDiagnostics(this.conn, extraMetadata);
  }

  /**
   * Executes SQLite VACUUM to reclaim free space.
   */
  vacuum(): void {
    this.conn.exec("VACUUM;");
  }
}

/**
 * Creates an uninitialized LocalStateStore instance.
 */
export function createLocalStateStore(options: LocalDatabaseOptions = {}): LocalStateStore {
  const conn = new LocalDatabaseConnection(options);
  return new LocalStateStore(conn);
}

/**
 * Creates and initializes an in-memory LocalStateStore for tests or ephemeral tasks.
 */
export async function createInMemoryStateStore(): Promise<LocalStateStore> {
  const store = createLocalStateStore({ inMemory: true });
  await store.initialize();
  return store;
}
