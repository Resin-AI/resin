import { describe, expect, it } from "vitest";
import {
  BUILT_IN_MIGRATIONS,
  INITIAL_SCHEMA_SQL,
  InMemoryDatabaseClient,
  LocalDatabaseConnection,
  LocalStateStore,
  MigrationRunner,
  createInMemoryStateStore,
  createLocalStateStore,
  exportDatabaseDiagnostics,
} from "../src/index.js";

describe("@resin/db public API", () => {
  it("exports all stores, repositories, connections, and migrations", async () => {
    expect(LocalDatabaseConnection).toBeDefined();
    expect(MigrationRunner).toBeDefined();
    expect(LocalStateStore).toBeDefined();
    expect(BUILT_IN_MIGRATIONS).toBeDefined();
    expect(INITIAL_SCHEMA_SQL).toBeDefined();
    expect(exportDatabaseDiagnostics).toBeDefined();
    expect(createLocalStateStore).toBeDefined();
    expect(createInMemoryStateStore).toBeDefined();

    const store = await createInMemoryStateStore();
    expect(store.isOpen()).toBe(true);
    expect(store.sessions).toBeDefined();
    expect(store.tools).toBeDefined();
    expect(store.capabilities).toBeDefined();
    expect(store.sync).toBeDefined();
    expect(store.audit).toBeDefined();
    expect(store.retention).toBeDefined();
    expect(store.migrations).toBeDefined();

    store.close();
    expect(store.isOpen()).toBe(false);
  });

  it("supports legacy InMemoryDatabaseClient interface", async () => {
    const client = new InMemoryDatabaseClient();
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});
