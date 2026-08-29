import { hashCanonicalContent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { LocalDatabaseConnection } from "../src/connection.js";
import {
  BUILT_IN_MIGRATIONS,
  FutureMigrationError,
  INITIAL_SCHEMA_SQL,
  type Migration,
  MigrationIntegrityError,
  MigrationRunner,
} from "../src/migrations.js";

describe("MigrationRunner", () => {
  it("runs initial migration on a fresh database and creates all 20 tables", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    expect(runner.getCurrentVersion()).toBe(0);
    expect(runner.getAppliedMigrations()).toHaveLength(0);

    const result = await runner.migrate();
    expect(result.initialVersion).toBe(0);
    expect(result.targetVersion).toBe(1);
    expect(result.appliedVersions).toEqual([1]);
    expect(result.integrityOk).toBe(true);

    expect(runner.getCurrentVersion()).toBe(1);
    const applied = runner.getAppliedMigrations();
    expect(applied).toHaveLength(1);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe("001_initial_local_schema");

    // Verify key tables exist and are queryable
    const testTables = [
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
    ];

    for (const table of testTables) {
      const count = conn.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`);
      expect(count?.c).toBe(0);
    }

    conn.close();
  });

  it("is idempotent when run multiple times on an up-to-date database", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    const firstRun = await runner.migrate();
    expect(firstRun.appliedVersions).toEqual([1]);

    const secondRun = await runner.migrate();
    expect(secondRun.appliedVersions).toHaveLength(0);
    expect(secondRun.initialVersion).toBe(1);
    expect(secondRun.targetVersion).toBe(1);

    conn.close();
  });

  it("executes incremental multi-version migrations in order", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const customMigrations: Migration[] = [
      {
        version: 1,
        name: "001_initial_local_schema",
        sql: INITIAL_SCHEMA_SQL,
        checksum: hashCanonicalContent(INITIAL_SCHEMA_SQL),
      },
      {
        version: 2,
        name: "002_add_test_feature_flag",
        sql: "CREATE TABLE feature_flags (flag_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);",
        checksum: hashCanonicalContent(
          "CREATE TABLE feature_flags (flag_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);",
        ),
      },
    ];

    const runner = new MigrationRunner(conn, customMigrations);
    const result = await runner.migrate();

    expect(result.initialVersion).toBe(0);
    expect(result.targetVersion).toBe(2);
    expect(result.appliedVersions).toEqual([1, 2]);
    expect(runner.getCurrentVersion()).toBe(2);

    // Verify v2 table exists
    conn.run("INSERT INTO feature_flags (flag_key, enabled) VALUES (?, ?);", ["beta_feature", 1]);
    const row = conn.get<{ flag_key: string; enabled: number }>(
      "SELECT * FROM feature_flags WHERE flag_key = 'beta_feature';",
    );
    expect(row).toEqual({ flag_key: "beta_feature", enabled: 1 });

    conn.close();
  });

  it("throws MigrationIntegrityError on checksum mismatch for an already applied migration", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner1 = new MigrationRunner(conn, BUILT_IN_MIGRATIONS);
    await runner1.migrate();

    // Alter applied checksum manually to simulate corruption/tampering
    conn.run("UPDATE _local_migrations SET checksum = 'tampered_checksum' WHERE version = 1;");

    const runner2 = new MigrationRunner(conn, BUILT_IN_MIGRATIONS);
    await expect(runner2.migrate()).rejects.toThrow(MigrationIntegrityError);

    conn.close();
  });

  it("throws FutureMigrationError when database version exceeds current codebase version", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner1 = new MigrationRunner(conn, [
      {
        version: 1,
        name: "001_initial_local_schema",
        sql: INITIAL_SCHEMA_SQL,
        checksum: hashCanonicalContent(INITIAL_SCHEMA_SQL),
      },
      {
        version: 99,
        name: "099_future_migration",
        sql: "CREATE TABLE future_table (id TEXT PRIMARY KEY);",
        checksum: hashCanonicalContent("CREATE TABLE future_table (id TEXT PRIMARY KEY);"),
      },
    ]);
    await runner1.migrate();

    // Now run with a codebase that only knows up to version 1
    const runnerOlderCodebase = new MigrationRunner(conn, BUILT_IN_MIGRATIONS);
    await expect(runnerOlderCodebase.migrate()).rejects.toThrow(FutureMigrationError);

    conn.close();
  });
});
