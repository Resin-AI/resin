// Local SQLite State Store & Repositories

// Connection & Core Database Mechanics
export * from "./connection.js";

// Migrations & Schema Definitions
export * from "./migrations.js";

// Repositories
export * from "./repositories/session-repository.js";
export * from "./repositories/tool-repository.js";
export * from "./repositories/capability-repository.js";
export * from "./repositories/sync-repository.js";
export * from "./repositories/audit-repository.js";

// Retention & Compaction Engine
export * from "./retention.js";

// Diagnostics & Redaction Exporter
export * from "./diagnostics.js";

// Unified Local State Store & Factory Functions
export * from "./store.js";

// Compatibility interfaces
export interface DatabaseConfig {
  url?: string;
  path?: string;
  inMemory?: boolean;
  maxConnections?: number;
}

export interface DatabaseClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export class InMemoryDatabaseClient implements DatabaseClient {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
