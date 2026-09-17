import { hashCanonicalContent } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
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
  it("runs initial migration on a fresh database and creates all 25 tables", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    expect(runner.getCurrentVersion()).toBe(0);
    expect(runner.getAppliedMigrations()).toHaveLength(0);

    const result = await runner.migrate();
    expect(result.initialVersion).toBe(0);
    expect(result.targetVersion).toBe(5);
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5]);
    expect(result.integrityOk).toBe(true);

    expect(runner.getCurrentVersion()).toBe(5);
    const applied = runner.getAppliedMigrations();
    expect(applied).toHaveLength(5);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe("001_initial_local_schema");
    expect(applied[1].version).toBe(2);
    expect(applied[1].name).toBe("002_add_invocation_records_uploaded_at");
    expect(applied[2].version).toBe(3);
    expect(applied[2].name).toBe("003_add_invocation_records_usage_estimate");
    expect(applied[3].version).toBe(4);
    expect(applied[3].name).toBe("004_add_local_opportunity_tables");
    expect(applied[4].version).toBe(5);
    expect(applied[4].name).toBe("005_normalized_events_causal_step_uniqueness");
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
      "session_signatures",
      "workflow_clusters",
      "cluster_episodes",
      "opportunity_hash_cache",
      "pattern_outbox",
    ];

    for (const table of testTables) {
      const count = conn.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`);
      expect(count?.c).toBe(0);
    }

    // Verify v2 migration column and index exist
    const tableInfo = conn.all<{ name: string }>("PRAGMA table_info(invocation_records);");
    expect(tableInfo.some((col) => col.name === "uploaded_at")).toBe(true);
    expect(tableInfo.some((col) => col.name === "usage_estimate_json")).toBe(true);
    const indexList = conn.all<{ name: string }>("PRAGMA index_list(invocation_records);");
    expect(indexList.some((idx) => idx.name === "idx_invocation_records_uploaded_at")).toBe(true);
    conn.close();
  });

  it("is idempotent when run multiple times on an up-to-date database", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    const firstRun = await runner.migrate();
    expect(firstRun.appliedVersions).toEqual([1, 2, 3, 4, 5]);

    const secondRun = await runner.migrate();
    expect(secondRun.appliedVersions).toHaveLength(0);
    expect(secondRun.initialVersion).toBe(5);
    expect(secondRun.targetVersion).toBe(5);
    conn.close();
  });

  it("replaces the legacy sequence index with the causal-step expression index on upgrade", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    // Simulate a state file written before decoder fan-out existed (schema v4).
    const legacyRunner = new MigrationRunner(
      conn,
      BUILT_IN_MIGRATIONS.filter((migration) => migration.version <= 4),
    );
    expect((await legacyRunner.migrate()).targetVersion).toBe(4);

    const legacyIndex = conn.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_normalized_events_session_sequence';",
    );
    expect(legacyIndex?.sql).toContain("(session_id, sequence)");
    expect(legacyIndex?.sql).not.toContain("json_extract");

    const sessionId = "ses_01j7db4n0000000000000000up";
    conn.run(
      "INSERT INTO sessions (session_id, harness_id, started_at, created_at) VALUES (?, ?, ?, ?);",
      [sessionId, "omp", "2026-08-17T12:00:00.000Z", "2026-08-17T12:00:00.000Z"],
    );

    const legacyPayload = JSON.stringify({
      eventId: "evt_legacy_0001",
      sessionId,
      causalRef: { causalSequence: 1 },
      type: "message",
    });
    conn.run(
      `INSERT INTO normalized_events (event_id, session_id, sequence, type, timestamp, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        "evt_legacy_0001",
        sessionId,
        1,
        "message",
        "2026-08-17T12:05:00.000Z",
        legacyPayload,
        "2026-08-17T12:05:00.000Z",
      ],
    );
    // The legacy index still rejects a second row at the same sequence.
    const legacyCollision = conn.run(
      `INSERT OR IGNORE INTO normalized_events (event_id, session_id, sequence, type, timestamp, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        "evt_legacy_collision",
        sessionId,
        1,
        "message",
        "2026-08-17T12:05:00.000Z",
        legacyPayload,
        "2026-08-17T12:05:00.000Z",
      ],
    );
    expect(legacyCollision.changes).toBe(0);

    // A corrupted historical payload (foreign or hand-edited state file) must not
    // abort the index replacement.
    const malformedPayload = "{not json";
    const malformedRow = conn.run(
      `INSERT INTO normalized_events (event_id, session_id, sequence, type, timestamp, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        "evt_malformed_0001",
        sessionId,
        3,
        "unknown_passthrough",
        "2026-08-17T12:06:00.000Z",
        malformedPayload,
        "2026-08-17T12:06:00.000Z",
      ],
    );
    expect(malformedRow.changes).toBe(1);

    const upgrade = await new MigrationRunner(conn).migrate();
    expect(upgrade.initialVersion).toBe(4);
    expect(upgrade.appliedVersions).toEqual([5]);

    const upgradedIndex = conn.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_normalized_events_session_sequence';",
    );
    expect(upgradedIndex?.sql).toContain("json_valid(payload_json)");
    expect(upgradedIndex?.sql).toContain("json_extract(payload_json, '$.causalRef.stepIndex')");

    // The pre-upgrade row survives byte-identical and still owns step 0.
    const legacyRow = conn.get<{ event_id: string; payload_json: string; sequence: number }>(
      "SELECT event_id, payload_json, sequence FROM normalized_events WHERE event_id = ?;",
      ["evt_legacy_0001"],
    );
    expect(legacyRow).toEqual({
      event_id: "evt_legacy_0001",
      payload_json: legacyPayload,
      sequence: 1,
    });

    const insertSibling = (eventId: string, stepIndex: number | null, sequence = 1): number => {
      const payload = JSON.stringify({
        eventId,
        sessionId,
        causalRef:
          stepIndex === null
            ? { causalSequence: sequence }
            : { causalSequence: sequence, stepIndex },
        type: "tool_call",
      });
      return conn.run(
        `INSERT OR IGNORE INTO normalized_events (event_id, session_id, sequence, type, timestamp, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          eventId,
          sessionId,
          sequence,
          "tool_call",
          "2026-08-17T12:05:00.000Z",
          payload,
          "2026-08-17T12:05:00.000Z",
        ],
      ).changes;
    };

    expect(insertSibling("evt_sibling_0001", 1)).toBe(1);
    expect(insertSibling("evt_sibling_0002", 2)).toBe(1);
    // A step-less row still collides with the legacy row instead of widening to a sibling.
    expect(insertSibling("evt_step_less", null)).toBe(0);

    const causalStepOrder = conn.all<{ event_id: string }>(
      `SELECT event_id FROM normalized_events WHERE session_id = ?
       ORDER BY sequence ASC,
         CASE WHEN json_valid(payload_json)
           THEN COALESCE(json_extract(payload_json, '$.causalRef.stepIndex'), 0)
           ELSE 0
         END ASC;`,
      [sessionId],
    );
    expect(causalStepOrder.map((row) => row.event_id)).toEqual([
      "evt_legacy_0001",
      "evt_sibling_0001",
      "evt_sibling_0002",
      "evt_malformed_0001",
    ]);

    // The malformed row survived the upgrade byte-identical and occupies its
    // sequence at the fail-closed step 0: a step-less row collides, an explicit
    // sibling is still accepted.
    expect(
      conn.get<{ payload_json: string }>(
        "SELECT payload_json FROM normalized_events WHERE event_id = ?;",
        ["evt_malformed_0001"],
      ),
    ).toEqual({ payload_json: malformedPayload });
    expect(insertSibling("evt_malformed_0002", null, 3)).toBe(0);
    expect(insertSibling("evt_malformed_0003", 1, 3)).toBe(1);

    conn.close();
  });

  it("runs the full integrity check twice when new migrations are applied", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();
    const integrityCheckSpy = vi.spyOn(conn, "integrityCheck");

    const runner = new MigrationRunner(conn);
    const result = await runner.migrate();

    // Real migrations keep the full structural verification.
    expect(integrityCheckSpy).toHaveBeenCalledTimes(2);
    expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5]);
    expect(result.integrityOk).toBe(true);
    conn.close();
  });

  it("skips the database scan on an already-current database and returns integrityOk true", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    await runner.migrate();

    const integrityCheckSpy = vi.spyOn(conn, "integrityCheck");
    const result = await runner.migrate();

    // A large state file must not be re-scanned when nothing is pending; doing so
    // previously exceeded the daemon's activation probation window and rolled back
    // otherwise-valid upgrades.
    expect(integrityCheckSpy).toHaveBeenCalledTimes(0);
    expect(result.appliedVersions).toEqual([]);
    expect(result.integrityOk).toBe(true);
    expect(result.initialVersion).toBe(5);
    expect(result.targetVersion).toBe(5);
    conn.close();
  });

  it("skips the pre-migration scan entirely on a no-op migration", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const runner = new MigrationRunner(conn);
    await runner.migrate();

    // Even a failing check result must not be consulted when nothing is pending.
    const integrityCheckSpy = vi
      .spyOn(conn, "integrityCheck")
      .mockReturnValue({ ok: false, details: ["malformed database schema"] });

    const result = await runner.migrate();
    expect(integrityCheckSpy).toHaveBeenCalledTimes(0);
    expect(result.appliedVersions).toEqual([]);
    conn.close();
  });

  it("rejects failed post-migration integrity check when applying migrations", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    vi.spyOn(conn, "integrityCheck")
      .mockReturnValueOnce({ ok: true, details: ["ok"] })
      .mockReturnValueOnce({ ok: false, details: ["corrupted index detected"] });

    const runner = new MigrationRunner(conn);
    let thrownError: unknown;
    try {
      await runner.migrate();
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(MigrationIntegrityError);
    expect((thrownError as Error).message).toMatch(
      /Post-migration integrity check failed: corrupted index detected/,
    );
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
