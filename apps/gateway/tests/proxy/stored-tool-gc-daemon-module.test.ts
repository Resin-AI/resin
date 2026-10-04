import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORPHANED_STORED_TOOLS_FILE_NAME,
  StoredToolGcModule,
  readPinnedStoredTools,
  readServedToolIds,
  sweepOrphanedStoredTools,
} from "../../src/proxy/stored-tool-gc-daemon-module.js";

const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const digest = (label: string) => label.repeat(64).slice(0, 64);

function device() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-stored-tool-gc-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const cache = new ArtifactCache({ cacheDir: path.join(dataDir, "artifacts") });
  return { root, dataDir, stateDir, cache };
}

async function storeTool(
  cache: ArtifactCache,
  artifactDigest: string,
  toolId: string,
  refType: "active" | "pinned" = "active",
) {
  const dir = cache.getArtifactPath(artifactDigest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), "{}");
  await cache.acquireReference(artifactDigest, {
    refId: `project:${toolId}`,
    refType,
    toolId,
    version: "1.0.0",
  });
}

function serveCatalog(dataDir: string, toolIds: string[]) {
  const db = new DatabaseSync(path.join(dataDir, "state.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_snapshots (
    snapshot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    tools_json TEXT NOT NULL DEFAULT '{}', digest TEXT NOT NULL)`);
  db.prepare("INSERT INTO catalog_snapshots VALUES (?, ?, ?, ?, ?)").run(
    `snap-${toolIds.join("-")}`,
    "ws-gc",
    new Date().toISOString(),
    JSON.stringify(Object.fromEntries(toolIds.map((toolId) => [toolId, { toolId }]))),
    "d",
  );
  db.close();
}

function pinInLock(root: string, stateDir: string, tools: Record<string, unknown>) {
  const lockPath = path.join(root, "project", ".resin", "resin.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ schemaKind: "tool_lock", tools }));
  const receipts = path.join(stateDir, "managed-tool-access", "tools");
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(receipts, `${"e".repeat(64)}.json`), JSON.stringify({ lockPath }));
  return lockPath;
}

describe("stored tool cleanup", () => {
  it("removes stored tools nothing serves or pins once they stay orphaned for the grace period", async () => {
    const { root, dataDir, stateDir, cache } = device();
    await storeTool(cache, digest("a"), "tool-orphaned");
    await storeTool(cache, digest("b"), "tool-served");
    await storeTool(cache, digest("c"), "tool-pinned-by-lock");
    await storeTool(cache, digest("d"), "tool-pinned-ref", "pinned");
    await storeTool(cache, digest("f"), "tool-returning");
    serveCatalog(dataDir, ["tool-served"]);
    pinInLock(root, stateDir, { pinned: { toolId: "tool-pinned-by-lock" } });
    const ledgerPath = path.join(stateDir, ORPHANED_STORED_TOOLS_FILE_NAME);
    const sweep = (now: number, served = readServedToolIds(dataDir)!) =>
      sweepOrphanedStoredTools({
        cache,
        served,
        pinned: readPinnedStoredTools(stateDir),
        ledgerPath,
        now,
      });
    const start = Date.now();

    expect(await sweep(start)).toEqual({ examined: 5, orphaned: 2, removed: 0 });
    expect(fs.existsSync(cache.getArtifactPath(digest("a")))).toBe(true);

    // The returning tool is served again before the grace period ends: its sighting is dropped.
    const later = await sweep(start + 8 * DAY, new Set(["tool-served", "tool-returning"]));
    expect(later).toEqual({ examined: 5, orphaned: 1, removed: 1 });
    expect(fs.existsSync(cache.getArtifactPath(digest("a")))).toBe(false);
    expect(Object.keys(await cache.getAllReferences()).sort()).toEqual(
      [digest("b"), digest("c"), digest("d"), digest("f")].sort(),
    );
    expect(JSON.parse(fs.readFileSync(ledgerPath, "utf8"))).toEqual({});

    // Orphaned again, it starts a fresh grace period instead of reusing the old sighting.
    expect(await sweep(start + 9 * DAY)).toEqual({ examined: 4, orphaned: 1, removed: 0 });
    expect(fs.existsSync(cache.getArtifactPath(digest("f")))).toBe(true);
  });

  it("removes nothing while the catalog or a pinning lock cannot be read", async () => {
    const { root, dataDir, stateDir, cache } = device();
    await storeTool(cache, digest("a"), "tool-orphaned");
    const ledgerPath = path.join(stateDir, ORPHANED_STORED_TOOLS_FILE_NAME);
    fs.writeFileSync(ledgerPath, JSON.stringify({ [digest("a")]: Date.now() - 30 * DAY }));
    const module = new StoredToolGcModule({ dataDir, stateDir, cache });

    // No catalog was ever synced: an unknown catalog is not an empty one.
    expect(readServedToolIds(dataDir)).toBeUndefined();
    expect(await module.runOnce()).toBeUndefined();

    serveCatalog(dataDir, ["tool-other"]);
    const lockPath = pinInLock(root, stateDir, {});
    fs.writeFileSync(lockPath, "{not json");
    expect(await module.runOnce()).toBeUndefined();
    expect((await module.healthCheck()).status).toBe("degraded");
    expect(fs.existsSync(cache.getArtifactPath(digest("a")))).toBe(true);

    fs.writeFileSync(lockPath, JSON.stringify({ tools: {} }));
    expect(await module.runOnce()).toEqual({ examined: 1, orphaned: 1, removed: 1 });
    expect(fs.existsSync(cache.getArtifactPath(digest("a")))).toBe(false);
    expect((await module.healthCheck()).status).toBe("ready");
  });
});
