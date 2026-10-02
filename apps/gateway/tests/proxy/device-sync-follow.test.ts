import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEVICE_SYNC_PUBLICATION_MAX_AGE_MS,
  DEVICE_SYNC_SAFETY_REFRESH_MS,
  type DeviceSyncResponse,
} from "@resin/protocol";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient, type CloudRequestIdentity } from "../../src/proxy/client.js";
import { DeviceSyncStore } from "../../src/proxy/device-sync-store.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { SharedCloudSync, SharedDeviceSync } from "../../src/proxy/shared-sync.js";
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
const QUIET_MS = 120_000;

let root: string;
let syncDir: string;
let artifactCache: ArtifactCache;
const openedAccess = new Set<ManagedToolAccess>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-device-sync-follow-"));
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

function gateway(cloud: FakeCatalogCloud, identity: CloudRequestIdentity = identityA) {
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
    sharedSync: new SharedCloudSync({
      store: new DeviceSyncStore({ dir: syncDir }),
      client,
      identityProvider: async () => identity,
    }),
  });
  return { coordinator, cache, registry, errors, access };
}

/** The daemon side: its own store instance (another writer) over the same directory. */
function daemon(identity: CloudRequestIdentity = identityA) {
  const shared = new SharedDeviceSync({
    store: new DeviceSyncStore({ dir: syncDir }),
    identityProvider: async () => identity,
  });
  const answer = (overrides: Partial<DeviceSyncResponse> = {}): DeviceSyncResponse => ({
    schemaVersion: "1.0.0",
    deviceId: identity.deviceId,
    accountId: identity.accountId,
    userId: identity.userId,
    toolAccess: "allowed",
    checkedAt: new Date().toISOString(),
    desired: { revisions: { workspace: 1, device: 0 }, revisionToken: "w:1:d:0" },
    catalogToken: "c:1",
    validationToken: "v:1",
    ...overrides,
  });
  return {
    shared,
    answer,
    publish: (overrides: Partial<DeviceSyncResponse> = {}) =>
      shared.publish(answer(overrides), Date.now()),
  };
}

/** Advances time while the daemon publishes an answer every quiet interval. */
async function run(
  d: ReturnType<typeof daemon>,
  durationMs: number,
  overrides: () => Partial<DeviceSyncResponse> = () => ({}),
): Promise<void> {
  for (let elapsed = 0; elapsed < durationMs; elapsed += QUIET_MS) {
    await d.publish(overrides());
    await vi.advanceTimersByTimeAsync(Math.min(QUIET_MS, durationMs - elapsed));
  }
}

describe("a gateway following the daemon's device sync", () => {
  it("makes no cloud calls of its own while the daemon's tokens are unchanged", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);

    gw.coordinator.startPeriodicSync();
    await run(d, 1_200_000);
    gw.coordinator.stopPeriodicSync();

    // One catalog read on the first answer it followed; tool access always came from the answers.
    expect(cloud.catalogRequests).toHaveLength(1);
    expect(cloud.toolAccessRequests).toBe(0);
    expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
      true,
    );
    expect(gw.errors).toEqual([]);
  });

  it("refetches the catalog within one watch interval of the catalog token moving", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(d, 240_000);
    expect(cloud.catalogRequests).toHaveLength(1);

    cloud.setSnapshot(
      catalogSnapshot("v2", [catalogTool(TOOL_ONE, "one"), catalogTool(TOOL_TWO, "two")]),
    );
    await d.publish({ catalogToken: "c:2" });
    await vi.advanceTimersByTimeAsync(5_000);
    gw.coordinator.stopPeriodicSync();

    expect(cloud.catalogRequests).toHaveLength(2);
    expect(cloud.catalogRequests[1]?.currentVersion).toBe("v1");
    expect(gw.cache.getSnapshot(identityA.workspaceId)?.snapshotVersion).toBe("v2");
    expect(cloud.toolAccessRequests).toBe(0);
  });

  it("removes tools on a published downgrade without asking the cloud", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(d, 120_000);
    expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
      true,
    );

    await d.publish({
      toolAccess: "subscription_inactive",
      desired: null,
      catalogToken: null,
      validationToken: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    gw.coordinator.stopPeriodicSync();

    expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
      false,
    );
    expect(gw.cache.getSnapshot(identityA.workspaceId)).toBeNull();
    expect(cloud.catalogRequests).toHaveLength(1);
    expect(cloud.toolAccessRequests).toBe(0);
  });

  it("refreshes the catalog once the safety interval passes", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(d, DEVICE_SYNC_SAFETY_REFRESH_MS + 2 * QUIET_MS);
    gw.coordinator.stopPeriodicSync();

    expect(cloud.catalogRequests).toHaveLength(2);
    expect(cloud.toolAccessRequests).toBe(0);
  });

  it("returns to its own interval once the daemon's answers stop", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(d, 240_000);
    expect(cloud.toolAccessRequests).toBe(0);

    // The last answer is still followed until it is too old to stand in for the gateway's polling.
    await vi.advanceTimersByTimeAsync(DEVICE_SYNC_PUBLICATION_MAX_AGE_MS - QUIET_MS - 5_000);
    expect(cloud.toolAccessRequests).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    gw.coordinator.stopPeriodicSync();
    expect(cloud.toolAccessRequests).toBeGreaterThan(0);
  });

  it("returns to its own interval at once when the daemon withdraws its answer", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(d, 120_000);
    await d.shared.withdraw();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    gw.coordinator.stopPeriodicSync();

    expect(cloud.toolAccessRequests).toBe(1);
  });

  it("never follows an answer published for another login", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const other = daemon({ ...identityA, accountId: "account-b", userId: "user-b" });
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    await run(other, 600_000);
    gw.coordinator.stopPeriodicSync();

    // Exactly the legacy cadence: one cloud read of each per interval.
    expect(cloud.toolAccessRequests).toBe(10);
    expect(cloud.catalogRequests).toHaveLength(10);
  });
});

describe("following the daemon's device sync safely", () => {
  it("never lets a published allowance clear a denial recorded after it", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    const allowedAt = Date.now();
    await d.publish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gw.access.isInactive()).toBe(false);

    // The account is revoked and this gateway learns it from the cloud directly.
    cloud.toolAccess = "subscription_inactive";
    await gw.coordinator.checkToolAccess();
    expect(gw.access.isInactive()).toBe(true);
    const reads = cloud.toolAccessRequests;

    // A publication of an allowance read before the revocation arrives afterwards.
    await d.shared.publish(d.answer(), allowedAt + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gw.access.isInactive()).toBe(true);
    // Only a fresh read of the cloud's authority could have cleared the denial; it confirmed it.
    expect(cloud.toolAccessRequests).toBe(reads + 1);
    expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
      false,
    );

    // Once the cloud really allows access again, the fresh read restores it.
    cloud.toolAccess = "allowed";
    await d.publish();
    await vi.advanceTimersByTimeAsync(5_000);
    gw.coordinator.stopPeriodicSync();
    expect(gw.access.isInactive()).toBe(false);
  });

  it("does not apply an old allowance queued behind a sync that recorded a revocation", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    await d.publish();
    await gw.coordinator.followDeviceSync();
    expect(gw.access.isInactive()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    cloud.toolAccess = "subscription_inactive";
    const gate = Promise.withResolvers<void>();
    cloud.toolAccessGate = gate.promise;
    const revoking = gw.coordinator.checkToolAccess();
    await vi.advanceTimersByTimeAsync(0);
    // An allowance read before the revocation is published while the revoking sync is in flight.
    await d.shared.publish(d.answer(), Date.now());
    const queued = gw.coordinator.followDeviceSync();
    cloud.toolAccessGate = undefined;
    gate.resolve();
    await Promise.all([revoking, queued]);

    expect(gw.access.isInactive()).toBe(true);
  });

  it("retries a catalog whose reconciliation failed on its own interval, not after an hour", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    const activate = gw.registry.activateToolVersion.bind(gw.registry);
    const activations = vi
      .spyOn(gw.registry, "activateToolVersion")
      .mockRejectedValueOnce(new Error("transient activation failure"))
      .mockImplementation(activate);
    gw.coordinator.startPeriodicSync();
    await d.publish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(activations).toHaveBeenCalledTimes(1);

    // Same answer, same tokens: the gateway's own interval retries the unsettled catalog.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(activations).toHaveBeenCalledTimes(2);
    expect(gw.registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", identityA.workspaceId)).toBe(
      true,
    );
    const requests = cloud.catalogRequests.length;

    // Settled now: unchanged tokens fetch nothing more.
    await run(d, 600_000);
    gw.coordinator.stopPeriodicSync();
    expect(cloud.catalogRequests).toHaveLength(requests);
    expect(cloud.toolAccessRequests).toBe(0);
  });

  it("keeps held tools invocable past the cache's hard expiry while tokens stay unchanged", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const d = daemon();
    const gw = gateway(cloud);
    gw.coordinator.startPeriodicSync();
    // Quiet syncs at their longest jitter (125 s). The catalog was fetched once, at 5 s; its hard
    // expiry (1 h) falls at 3,605 s, before the safety refresh the 3,625 s answer would trigger.
    const startedAt = Date.now();
    for (let at = 0; at < 3_500_000; at += 125_000) {
      await d.publish();
      await vi.advanceTimersByTimeAsync(125_000);
    }
    await d.publish();
    await vi.advanceTimersByTimeAsync(startedAt + 3_610_000 - Date.now());
    expect(cloud.catalogRequests).toHaveLength(1);
    expect(gw.cache.getSnapshot(identityA.workspaceId)?.snapshotVersion).toBe("v1");
    expect(gw.cache.getToolAvailability(TOOL_ONE, identityA.workspaceId).availability).toBe(
      "fresh",
    );
    await run(d, 600_000);
    gw.coordinator.stopPeriodicSync();
    expect(gw.cache.getToolAvailability(TOOL_ONE, identityA.workspaceId).availability).toBe(
      "fresh",
    );
  });
});

describe("the shared device sync entry", () => {
  it("is never read back by the process that published it", async () => {
    const d = daemon();
    await d.publish();
    expect(await d.shared.read()).toBeUndefined();
    expect(await daemon().shared.read()).toBeDefined();
  });

  it("refuses to publish an answer for another identity", async () => {
    const d = daemon();
    expect(await d.shared.publish(d.answer({ accountId: "account-b" }), Date.now())).toBe(false);
    expect(await d.shared.publish(d.answer({ deviceId: "device-b" }), Date.now())).toBe(false);
    expect(await daemon().shared.read()).toBeUndefined();
  });

  it("never steps back to an answer read before the published one", async () => {
    const d = daemon();
    await d.publish({ catalogToken: "c:2" });
    expect(await d.shared.publish(d.answer({ catalogToken: "c:1" }), Date.now() - 1)).toBe(false);
    expect((await daemon().shared.read())?.sync.catalogToken).toBe("c:2");
  });

  it("ignores an answer that is too old or stamped in the future", async () => {
    const d = daemon();
    const reader = daemon();
    await d.shared.publish(d.answer(), Date.now() + 60_000);
    expect(await reader.shared.read()).toBeUndefined();
    await d.shared.withdraw();
    await d.shared.publish(d.answer(), Date.now() - DEVICE_SYNC_PUBLICATION_MAX_AGE_MS - 1);
    expect(await reader.shared.read()).toBeUndefined();
  });
});
