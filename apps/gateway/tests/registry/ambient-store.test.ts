import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalStateStore } from "@resin/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/registry/registry.js";

// A registry built without a store must stay in memory. It used to open `<RESIN_HOME>/data/state.db`
// whenever that file existed, so embedders and test fixtures that construct `new ToolRegistry()`
// (or a bare `LocalMcpGateway`, which builds one) wrote catalog snapshots and invocation records
// into the user's real store.
describe("ToolRegistry without a store", () => {
  let home: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  async function seedAmbientStore(): Promise<string> {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ambient-store-"));
    const resinHome = path.join(home, ".resin");
    const dbPath = path.join(resinHome, "data", "state.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = createLocalStateStore({ path: dbPath });
    await store.initialize();
    store.close();
    vi.stubEnv("HOME", home);
    vi.stubEnv("RESIN_HOME", resinHome);
    return dbPath;
  }

  function snapshotCount(dbPath: string): number {
    const store = createLocalStateStore({ path: dbPath });
    try {
      const row = store.conn.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM catalog_snapshots",
      );
      return row?.count ?? -1;
    } finally {
      store.close();
    }
  }

  it("does not persist catalog snapshots into the ambient RESIN_HOME state.db", async () => {
    const dbPath = await seedAmbientStore();

    const registry = new ToolRegistry();
    await registry.hydrateFromStore();
    await registry.resolveCatalog("ws_ambient_probe");

    expect(snapshotCount(dbPath)).toBe(0);
  });
});
