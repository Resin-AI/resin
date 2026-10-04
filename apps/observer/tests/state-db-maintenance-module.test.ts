import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LocalStateStore, createLocalStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConfigSchema } from "../src/config.js";
import type { Logger, ModuleContext } from "../src/lifecycle.js";
import { resolvePaths } from "../src/paths.js";
import { StateDbMaintenanceModule } from "../src/state-db-maintenance-module.js";

let tmpDir: string;
let store: LocalStateStore;

function createContext(logger: Logger): ModuleContext {
  return {
    config: DaemonConfigSchema.parse({}),
    paths: resolvePaths({ home: tmpDir }),
    logger,
    getModule: () => undefined,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-state-maint-"));
  store = createLocalStateStore({ path: path.join(tmpDir, "state.db") });
  await store.initialize();
  store.conn.exec("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body BLOB NOT NULL);");
  store.conn.exec("BEGIN;");
  for (let i = 0; i < 1000; i += 1) {
    store.conn.run("INSERT INTO payloads (body) VALUES (randomblob(8192));");
  }
  store.conn.exec("COMMIT;");
  store.conn.run("DELETE FROM payloads;");
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("StateDbMaintenanceModule", () => {
  it("does nothing at startup, then reclaims pruned pages on its timer until stopped", async () => {
    vi.useFakeTimers();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const module = new StateDbMaintenanceModule({
      conn: store.conn,
      initialDelayMs: 1_000,
      intervalMs: 5_000,
    });
    const freeAtStart = store.conn.pragmaNumber("freelist_count");
    expect(freeAtStart).toBeGreaterThan(1000);

    await module.start(createContext(logger));
    expect(module.getState()).toBe("ready");
    expect(store.conn.pragmaNumber("freelist_count")).toBe(freeAtStart);

    vi.advanceTimersByTime(1_000);
    expect(store.conn.pragmaNumber("freelist_count")).toBe(0);
    expect(fs.statSync(path.join(tmpDir, "state.db-wal")).size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "Reclaimed free space in state database",
      expect.objectContaining({ action: "incremental_vacuum", freelistAfter: 0 }),
    );
    expect(await module.getDiagnostics()).toMatchObject({ runs: 1, freelistPages: 0 });

    vi.advanceTimersByTime(5_000);
    expect((await module.getDiagnostics()).runs).toBe(2);

    await module.stop();
    vi.advanceTimersByTime(60_000);
    expect((await module.getDiagnostics()).runs).toBe(2);
  });
});
