import { describe, expect, it } from "vitest";
import { STATE_STORE_TABLES, exportDatabaseDiagnostics } from "../src/diagnostics.js";
import { createInMemoryStateStore } from "../src/store.js";

describe("Database Diagnostics & Safe Redaction", () => {
  it("exports diagnostics report with table counts and pragma status", async () => {
    const store = await createInMemoryStateStore();

    // Insert some sample data
    await store.sync.enqueueOutbox({
      topic: "test.topic",
      payload: { foo: "bar" },
    });

    const diagnostics = store.getDiagnostics();
    expect(diagnostics.isMemory).toBe(true);
    expect(diagnostics.databasePath).toBe(":memory:");
    expect(diagnostics.integrityOk).toBe(true);
    expect(diagnostics.integrityDetails).toEqual(["ok"]);
    expect(diagnostics.foreignKeysEnabled).toBe(true);
    expect(diagnostics.schemaVersion).toBe(2);
    expect(diagnostics.appliedMigrations).toHaveLength(2);
    expect(diagnostics.appliedMigrations[0].name).toBe("001_initial_local_schema");

    // All monitored tables must be tracked
    for (const table of STATE_STORE_TABLES) {
      expect(diagnostics.tableCounts[table]).toBeDefined();
      expect(diagnostics.tableCounts[table]).toBeGreaterThanOrEqual(0);
    }

    expect(diagnostics.tableCounts.local_outbox).toBe(1);
    expect(diagnostics.tableCounts.workspaces).toBe(0);

    store.close();
  });

  it("safely redacts sensitive credentials and tokens in extra diagnostic metadata", async () => {
    const store = await createInMemoryStateStore();

    const rawMetadata = {
      environment: "test",
      daemonVersion: "0.1.0",
      apiToken: "sk-ant-api03-secret-token-12345",
      userPassword: "SuperSecretPassword!",
      authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      databaseSecret: "secret_db_pass",
      normalField: "public_value",
    };

    const diagnostics = exportDatabaseDiagnostics(store.getConnection(), rawMetadata);

    expect(diagnostics.metadata.environment).toBe("test");
    expect(diagnostics.metadata.daemonVersion).toBe("0.1.0");
    expect(diagnostics.metadata.normalField).toBe("public_value");

    // Sensitive keys must be redacted
    expect(diagnostics.metadata.apiToken).toBe("[REDACTED]");
    expect(diagnostics.metadata.userPassword).toBe("[REDACTED]");
    expect(diagnostics.metadata.authHeader).toBe("[REDACTED]");
    expect(diagnostics.metadata.databaseSecret).toBe("[REDACTED]");

    store.close();
  });
});
