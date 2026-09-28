import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY, ValidationError } from "@resin/protocol";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient, type CloudRequestIdentity } from "../../src/proxy/client.js";
import { DeviceSyncStore } from "../../src/proxy/device-sync-store.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { SharedCloudSync } from "../../src/proxy/shared-sync.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ManagedToolAccess } from "../../src/proxy/tool-access.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import {
  FakeCatalogCloud,
  catalogSnapshot,
  catalogTool,
  identityA,
} from "./catalog-cloud-fixture.js";

const TOOL_ONE = "33333333-3333-4333-8333-333333333333";
const TOOL_TWO = "44444444-4444-4444-8444-444444444444";
const INTERVAL_MS = 60_000;

let root: string;
let syncDir: string;
let artifactCache: ArtifactCache;
/** Closed after each test: an open tool-access.db pins the temp dir on Windows. */
const openedAccess = new Set<ManagedToolAccess>();

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-shared-sync-"));
  syncDir = path.join(root, "state", "cloud-sync");
  artifactCache = new ArtifactCache({ cacheDir: path.join(root, "artifacts") });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const access of openedAccess) access.close();
  openedAccess.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

interface GatewayOptions {
  identity?: CloudRequestIdentity;
  shared?: boolean;
  isProcessAlive?: (pid: number) => boolean;
}

/** One gateway process: its own client, cache, registry, access view and shared-sync store. */
function gateway(cloud: FakeCatalogCloud, options: GatewayOptions = {}) {
  const identity = options.identity ?? identityA;
  const client = new CloudCatalogClient({
    identityProvider: async () => identity,
    workspaceId: identity.workspaceId,
    deviceId: identity.deviceId,
    fetchFn: cloud.fetchFn,
  });
  const cache = new CloudCatalogCache();
  const registry = new ToolRegistry({ autoHydrate: false });
  const access = new ManagedToolAccess(path.join(root, "access"), artifactCache, identity);
  openedAccess.add(access);
  registry.setManagedToolAccess(access);
  const store = new DeviceSyncStore({
    dir: syncDir,
    ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
  });
  const errors: Error[] = [];
  const coordinator = new CloudCatalogSyncCoordinator({
    client,
    cache,
    router: new CloudInvocationRouter({ catalogCache: cache }),
    registry,
    workspaceId: identity.workspaceId,
    intervalMs: INTERVAL_MS,
    managedToolAccess: access,
    onSyncError: (error) => errors.push(error),
    ...(options.shared === false
      ? {}
      : {
          sharedSync: new SharedCloudSync({
            store,
            client,
            identityProvider: async () => identity,
          }),
        }),
  });
  return { coordinator, cache, registry, store, errors };
}

function filesIn(dir: string, suffix: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name));
}

function catalogEntryFile(): string {
  const [file] = filesIn(syncDir, ".json").filter(
    (name) => path.basename(name).startsWith("catalog-snapshot-") && !name.endsWith(".body.json"),
  );
  if (!file) throw new Error("no catalog entry published");
  return file;
}

describe("Shared catalog sync across gateways", () => {
  it("serves two gateways sharing a state dir with one cloud call per interval", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud);
    const b = gateway(cloud);

    a.coordinator.startPeriodicSync();
    await vi.advanceTimersByTimeAsync(20_000);
    b.coordinator.startPeriodicSync();
    // Ten intervals: A ticks at 60 s … 600 s, B at 80 s … 620 s.
    await vi.advanceTimersByTimeAsync(600_000);
    a.coordinator.stopPeriodicSync();
    b.coordinator.stopPeriodicSync();

    expect(cloud.catalogRequests).toHaveLength(10);
    expect(cloud.toolAccessRequests).toBe(10);
    // After the first full fetch every cloud request only confirms the held version.
    expect(cloud.catalogRequests.slice(1).every((r) => r.currentVersion === "v1")).toBe(true);
    expect(
      cloud.catalogRequests
        .slice(1)
        .every((r) => r.capabilities === CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY),
    ).toBe(true);
    for (const gw of [a, b]) {
      expect(gw.cache.getSnapshot(identityA.workspaceId)?.snapshotVersion).toBe("v1");
      expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
        true,
      );
      expect(gw.errors).toEqual([]);
    }
  });

  it("makes twice the calls without sharing, the baseline it replaces", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud, { shared: false });
    const b = gateway(cloud, { shared: false });

    a.coordinator.startPeriodicSync();
    await vi.advanceTimersByTimeAsync(20_000);
    b.coordinator.startPeriodicSync();
    await vi.advanceTimersByTimeAsync(600_000);
    a.coordinator.stopPeriodicSync();
    b.coordinator.stopPeriodicSync();

    expect(cloud.catalogRequests).toHaveLength(20);
    expect(cloud.toolAccessRequests).toBe(20);
  });

  it("calls the cloud on every sync when a gateway has no peers", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud);

    await a.coordinator.sync();
    await a.coordinator.sync();
    await a.coordinator.sync();

    expect(cloud.catalogRequests).toHaveLength(3);
    expect(cloud.toolAccessRequests).toBe(3);
  });

  it("lets a gateway wait for a peer's in-flight fetch instead of calling the cloud", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const gate = Promise.withResolvers<void>();
    cloud.catalogGate = gate.promise;
    const a = gateway(cloud);
    const b = gateway(cloud);

    const first = a.coordinator.sync();
    await vi.advanceTimersByTimeAsync(0);
    const second = b.coordinator.sync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cloud.catalogRequests).toHaveLength(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    const [snapshotA, snapshotB] = await Promise.all([first, second]);

    expect(snapshotA.snapshotVersion).toBe("v1");
    expect(snapshotB.snapshotVersion).toBe("v1");
    expect(cloud.catalogRequests).toHaveLength(1);
    expect(cloud.toolAccessRequests).toBe(1);
  });

  it("refetches when asked for a fresh answer after a peer published", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud);
    const b = gateway(cloud);

    await a.coordinator.sync();
    await vi.advanceTimersByTimeAsync(10_000);
    await b.coordinator.sync();
    expect(cloud.catalogRequests).toHaveLength(1);

    cloud.setSnapshot(catalogSnapshot("v2", [catalogTool(TOOL_TWO, "two")]));
    const fresh = await b.coordinator.sync({ fresh: true });
    expect(cloud.catalogRequests).toHaveLength(2);
    expect(fresh.snapshotVersion).toBe("v2");
  });

  it("refetches in full without the capability when the cloud misanswers a shared base", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud);
    await a.coordinator.sync();

    // B holds nothing; the expired shared entry becomes its base, and the cloud misanswers it.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 1_000);
    cloud.unchangedOverride = () => ({ unchanged: true, snapshotVersion: "v0" });
    const b = gateway(cloud);
    const result = await b.coordinator.sync();

    expect(cloud.catalogRequests.slice(1)).toEqual([
      {
        workspaceId: identityA.workspaceId,
        currentVersion: "v1",
        capabilities: CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY,
      },
      { workspaceId: identityA.workspaceId, currentVersion: null, capabilities: null },
    ]);
    expect(result.snapshotVersion).toBe("v1");
    expect(b.errors[0]).toBeInstanceOf(ValidationError);
    expect(b.errors[0]?.message).toContain("holds no snapshot");
  });
});

describe("Shared sync lock recovery", () => {
  it("takes over at once from a lock holder whose process died", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const gate = Promise.withResolvers<void>();
    cloud.catalogGate = gate.promise;
    const a = gateway(cloud);
    const holder = a.coordinator.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.catalogRequests).toHaveLength(1);

    // Rewrite A's lock as if a process that has since exited held it.
    const exited = childProcess.spawnSync(process.execPath, ["-e", ""]);
    const deadPid = exited.pid;
    if (deadPid === undefined) throw new Error("no child pid");
    const [lockFile] = filesIn(syncDir, ".lock").filter((file) =>
      path.basename(file).startsWith("catalog-snapshot-"),
    );
    if (!lockFile) throw new Error("no lock held");
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, pid: deadPid }));

    const b = gateway(cloud);
    cloud.catalogGate = undefined;
    const taken = b.coordinator.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.catalogRequests).toHaveLength(2);
    expect((await taken).snapshotVersion).toBe("v1");
    gate.resolve();
    expect((await holder).snapshotVersion).toBe("v1");
  });

  it("takes over from a live but stuck holder only after the stale timeout", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const gate = Promise.withResolvers<void>();
    cloud.catalogGate = gate.promise;
    const a = gateway(cloud);
    const holder = a.coordinator.sync();
    await vi.advanceTimersByTimeAsync(0);

    const b = gateway(cloud);
    cloud.catalogGate = undefined;
    const taken = b.coordinator.sync();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(cloud.catalogRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cloud.catalogRequests).toHaveLength(2);
    expect((await taken).snapshotVersion).toBe("v1");
    gate.resolve();
    expect((await holder).snapshotVersion).toBe("v1");
  });
});

describe("Shared sync isolation and integrity", () => {
  it("never serves one workspace's catalog to another", async () => {
    const identityB: CloudRequestIdentity = { ...identityA, workspaceId: "workspace-b" };
    const cloud = new FakeCatalogCloud(catalogSnapshot("va", [catalogTool(TOOL_ONE, "one")]));
    cloud.setSnapshot(catalogSnapshot("vb", [catalogTool(TOOL_TWO, "two")]), "workspace-b");
    const a = gateway(cloud);
    const b = gateway(cloud, { identity: identityB });

    await a.coordinator.sync();
    await vi.advanceTimersByTimeAsync(5_000);
    const resultB = await b.coordinator.sync();

    expect(resultB.snapshotVersion).toBe("vb");
    expect(resultB.tools.map((tool) => tool.id)).toEqual([TOOL_TWO]);
    expect(cloud.catalogRequests.map((r) => r.workspaceId)).toEqual(["workspace-a", "workspace-b"]);
  });

  it("ignores another scope's entry copied over this scope's file", async () => {
    const identityB: CloudRequestIdentity = { ...identityA, workspaceId: "workspace-b" };
    const scopeA = { workspaceId: identityA.workspaceId };
    const scopeB = { workspaceId: identityB.workspaceId };
    const writer = new DeviceSyncStore({ dir: syncDir });
    writer.write("probe", scopeA, { fetchedAt: Date.now(), payload: { secret: "a" } });
    writer.write("probe", scopeB, { fetchedAt: Date.now(), payload: { secret: "b" } });
    const entries = filesIn(syncDir, ".json");
    const fileA = entries.find((file) => fs.readFileSync(file, "utf8").includes('"secret":"a"'));
    const fileB = entries.find((file) => fs.readFileSync(file, "utf8").includes('"secret":"b"'));
    if (!fileA || !fileB) throw new Error("entries missing");
    fs.copyFileSync(fileA, fileB);

    const reader = new DeviceSyncStore({ dir: syncDir });
    expect(reader.read("probe", scopeA)?.payload).toEqual({ secret: "a" });
    expect(reader.read("probe", scopeB)).toBeUndefined();
  });

  it.each([
    ["an unparsable entry", (file: string) => fs.writeFileSync(file, "{not json")],
    [
      "a truncated entry",
      (file: string) => fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 40)),
    ],
    [
      "a truncated body",
      (file: string) => {
        const body = file.replace(/\.json$/, ".body.json");
        fs.writeFileSync(body, fs.readFileSync(body, "utf8").slice(0, 200));
      },
    ],
    [
      "a tampered body",
      (file: string) => {
        const body = file.replace(/\.json$/, ".body.json");
        fs.writeFileSync(
          body,
          fs.readFileSync(body, "utf8").replace('"name":"one"', '"name":"evil"'),
        );
      },
    ],
  ])("ignores %s and refetches", async (_label, corrupt) => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const a = gateway(cloud);
    await a.coordinator.sync();
    corrupt(catalogEntryFile());

    const b = gateway(cloud);
    const result = await b.coordinator.sync();

    expect(cloud.catalogRequests).toHaveLength(2);
    expect(result.snapshotVersion).toBe("v1");
    expect(result.tools.map((tool) => tool.name)).toEqual(["one"]);
    // The refetch repaired the shared files for the next peer.
    const c = gateway(cloud);
    await c.coordinator.sync();
    expect(cloud.catalogRequests).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "keeps entries 0600 in a 0700 directory, tightening a looser directory",
    async () => {
      fs.mkdirSync(syncDir, { recursive: true, mode: 0o755 });
      fs.chmodSync(syncDir, 0o755);
      const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
      const a = gateway(cloud);
      await a.coordinator.sync();

      expect(fs.statSync(syncDir).mode & 0o777).toBe(0o700);
      const files = fs.readdirSync(syncDir);
      expect(files.some((name) => name.endsWith(".body.json"))).toBe(true);
      expect(files.some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
      for (const name of files) {
        expect(fs.statSync(path.join(syncDir, name)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked directory and falls back to per-gateway fetches",
    async () => {
      const elsewhere = path.join(root, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o700 });
      fs.mkdirSync(path.dirname(syncDir), { recursive: true });
      fs.symlinkSync(elsewhere, syncDir);
      const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
      const a = gateway(cloud);
      const b = gateway(cloud);

      await a.coordinator.sync();
      await b.coordinator.sync();

      expect(cloud.catalogRequests).toHaveLength(2);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    },
  );
});
