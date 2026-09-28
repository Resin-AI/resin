import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CatalogSnapshotResponse } from "@resin/protocol";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/project-lock.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient, type CloudRequestIdentity } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ManagedToolAccess } from "../../src/proxy/tool-access.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import type { CatalogChangeEvent } from "../../src/registry/types.js";
import {
  FakeCatalogCloud,
  catalogSnapshot,
  catalogTool,
  identityA,
} from "./catalog-cloud-fixture.js";

const KEPT = "33333333-3333-4333-8333-333333333333";
const DROPPED = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const PROJECT = "d53e4e21-7947-42ab-bff1-21c10807ea0f";
const NAMES: Record<string, string> = { [KEPT]: "kept", [DROPPED]: "dropped", [OTHER]: "other" };
const workspaceA = identityA.workspaceId;
const identityB: CloudRequestIdentity = { ...identityA, workspaceId: "workspace-b" };

const both = () => [catalogTool(KEPT, "kept"), catalogTool(DROPPED, "dropped")];
const keptOnly = () => [catalogTool(KEPT, "kept")];

let root: string;
let artifactCache: ArtifactCache;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-retire-"));
  artifactCache = new ArtifactCache({ cacheDir: path.join(root, "artifacts") });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

interface GatewayOptions {
  locked: boolean;
  identity?: CloudRequestIdentity;
  registry?: ToolRegistry;
  lockPath?: string;
}

/** One gateway bound to one workspace, with the managed-access receipts production keeps. */
function gateway(cloud: FakeCatalogCloud, options: GatewayOptions) {
  const identity = options.identity ?? identityA;
  const workspaceId = identity.workspaceId;
  const cache = new CloudCatalogCache();
  const registry = options.registry ?? new ToolRegistry({ autoHydrate: false });
  const access = new ManagedToolAccess(path.join(root, "access"), artifactCache, identity);
  registry.setManagedToolAccess(access);
  const lockManager = options.locked
    ? new ProjectLockManager({
        lockPath: options.lockPath ?? path.join(root, workspaceId, ".resin", "resin.lock"),
        projectId: PROJECT,
      })
    : undefined;
  const coordinator = new CloudCatalogSyncCoordinator({
    client: new CloudCatalogClient({
      identityProvider: async () => identity,
      workspaceId,
      deviceId: identity.deviceId,
      fetchFn: cloud.fetchFn,
    }),
    cache,
    router: new CloudInvocationRouter({ catalogCache: cache }),
    registry,
    workspaceId,
    lockManager,
    managedToolAccess: access,
  });
  const listed = async () =>
    Object.keys((await registry.resolveCatalog(workspaceId)).tools)
      .flatMap((toolId) => NAMES[toolId] ?? [])
      .sort();
  return { registry, lockManager, coordinator, access, listed, workspaceId };
}

describe.each([
  ["a project lock", true],
  ["no project lock", false],
])("catalog retirement with %s", (_label, locked) => {
  it("stops listing and invoking a tool the newest snapshot drops, keeping the rest", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { registry, lockManager, coordinator, listed } = gateway(cloud, { locked });
    await coordinator.sync();
    expect(await listed()).toEqual(["dropped", "kept"]);
    const stale = await registry.getTool("dropped", workspaceA);
    if (!stale?.handler) throw new Error("dropped tool was never active");

    cloud.setSnapshot(catalogSnapshot("v2", keptOnly()));
    await coordinator.sync({ fresh: true });

    expect(await listed()).toEqual(["kept"]);
    expect(await registry.getTool("dropped", workspaceA)).toBeUndefined();
    expect(await registry.getTool(DROPPED, workspaceA)).toBeUndefined();
    expect(registry.getAllRegisteredTools().some((tool) => tool.toolId === DROPPED)).toBe(false);
    expect(registry.retiredToolMessage("dropped", workspaceA)).toMatch(/no longer available/);
    await expect(stale.handler({ workspaceId: workspaceA }, {})).rejects.toThrow(
      /no longer available/,
    );
    expect(await registry.getTool("kept", workspaceA)).toBeDefined();
    if (lockManager) expect(Object.keys(lockManager.read().tools)).toEqual(["kept"]);

    // A later snapshot that publishes the tool again brings it back.
    cloud.setSnapshot(catalogSnapshot("v3", both()));
    await coordinator.sync({ fresh: true });
    expect(await listed()).toEqual(["dropped", "kept"]);
    expect(registry.retiredToolMessage("dropped", workspaceA)).toBeUndefined();
  });

  it("replaces an old version with the version the new snapshot publishes", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(KEPT, "kept", "1.0.0")]));
    const { registry, lockManager, coordinator } = gateway(cloud, { locked });
    await coordinator.sync();

    cloud.setSnapshot(catalogSnapshot("v2", [catalogTool(KEPT, "kept", "2.0.0")]));
    await coordinator.sync({ fresh: true });

    expect((await registry.getTool("kept", workspaceA))?.version).toBe("2.0.0");
    expect(registry.retiredToolMessage("kept", workspaceA)).toBeUndefined();
    if (lockManager) expect(lockManager.read().tools.kept?.version).toBe("2.0.0");
  });

  it("retires nothing when a verified snapshot suddenly lists no tools", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { lockManager, coordinator, listed } = gateway(cloud, { locked });
    await coordinator.sync();

    cloud.setSnapshot(catalogSnapshot("v2", []));
    await coordinator.sync({ fresh: true });

    expect(await listed()).toEqual(["dropped", "kept"]);
    if (lockManager)
      expect(Object.keys(lockManager.read().tools).sort()).toEqual(["dropped", "kept"]);
  });

  it("emits the resolved catalog, not an empty one, when it retires a tool", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { registry, coordinator } = gateway(cloud, { locked });
    await coordinator.sync();
    const events: CatalogChangeEvent[] = [];
    registry.events.onWorkspaceCatalogChanged(workspaceA, (event) => events.push(event));

    cloud.setSnapshot(catalogSnapshot("v2", keptOnly()));
    await coordinator.sync({ fresh: true });
    registry.flushEvents();

    const retirement = events.find((event) => event.changedToolIds.includes(DROPPED));
    expect(retirement).toBeDefined();
    expect(Object.keys(retirement?.snapshot.tools ?? {})).toContain(KEPT);
    expect(Object.keys(retirement?.snapshot.tools ?? {})).not.toContain(DROPPED);
    expect(Object.keys(retirement?.snapshot.tools ?? {})).toContain("sys_invoke_tool");
  });
});

describe("catalog retirement boundaries", () => {
  it("retires nothing from a response without a tools array and keeps serving offline", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { lockManager, coordinator, listed } = gateway(cloud, { locked: true });
    await coordinator.sync();

    const { tools: _omitted, ...withoutTools } = catalogSnapshot("v2", keptOnly());
    cloud.setSnapshot(withoutTools as CatalogSnapshotResponse);
    await coordinator.sync({ fresh: true });

    expect(await listed()).toEqual(["dropped", "kept"]);
    expect(Object.keys(lockManager?.read().tools ?? {}).sort()).toEqual(["dropped", "kept"]);
  });

  it("keeps the last verified snapshot's tools when the cloud becomes unreachable", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const failing = vi.fn(cloud.fetchFn);
    const { lockManager, coordinator, listed } = gateway(
      { ...cloud, fetchFn: failing } as FakeCatalogCloud,
      { locked: true },
    );
    await coordinator.sync();

    failing.mockRejectedValue(new TypeError("fetch failed"));
    await coordinator.sync({ fresh: true });

    expect(await listed()).toEqual(["dropped", "kept"]);
    expect(Object.keys(lockManager?.read().tools ?? {}).sort()).toEqual(["dropped", "kept"]);
  });

  it("offline, drops lock entries the last verified snapshot no longer carries", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", keptOnly()));
    const { lockManager, access, coordinator, listed } = gateway(cloud, { locked: true });
    await coordinator.sync();
    // A lock this workspace wrote before the fix still names a tool the verified snapshot dropped.
    const kept = lockManager?.read().tools.kept;
    if (!lockManager || !kept) throw new Error("kept tool was not locked");
    const stale = { ...kept, toolId: DROPPED, name: "dropped" };
    lockManager.reconcileQualified(stale);
    access.record(stale, workspaceA, lockManager);

    await coordinator.reconcileLockedToolsOffline();

    expect(await listed()).toEqual(["kept"]);
    expect(Object.keys(lockManager.read().tools)).toEqual(["kept"]);
  });

  it("leaves a lock another workspace recorded untouched", async () => {
    const lockPath = path.join(root, "shared-project", ".resin", "resin.lock");
    const cloudA = new FakeCatalogCloud(catalogSnapshot("va", both()));
    const a = gateway(cloudA, { locked: true, lockPath });
    await a.coordinator.sync();

    // The same project opened under workspace B, whose catalog never published these tools.
    const cloudB = new FakeCatalogCloud(catalogSnapshot("vb", keptOnly()), identityB.workspaceId);
    const b = gateway(cloudB, { locked: true, lockPath, identity: identityB });
    await b.coordinator.sync();

    expect(Object.keys(b.lockManager?.read().tools ?? {}).sort()).toEqual(["dropped", "kept"]);
    expect(b.registry.retiredToolMessage("dropped", identityB.workspaceId)).toBeUndefined();
  });

  it("scopes retirement to one workspace of a shared registry and spares system tools", async () => {
    const registry = new ToolRegistry({ autoHydrate: false });
    const cloudA = new FakeCatalogCloud(catalogSnapshot("va", both()));
    const cloudB = new FakeCatalogCloud(
      catalogSnapshot("vb", [catalogTool(OTHER, "other")]),
      identityB.workspaceId,
    );
    const a = gateway(cloudA, { locked: false, registry });
    const b = gateway(cloudB, { locked: false, registry, identity: identityB });
    await a.coordinator.sync();
    await b.coordinator.sync();

    // B's catalog never carried A's tools; syncing it again must not retire them.
    await b.coordinator.sync({ fresh: true });
    expect(await a.listed()).toEqual(["dropped", "kept"]);

    cloudA.setSnapshot(catalogSnapshot("va2", keptOnly()));
    await a.coordinator.sync({ fresh: true });

    expect(await a.listed()).toEqual(["kept"]);
    expect(await b.listed()).toEqual(["other"]);
    expect(registry.retiredToolMessage("dropped", identityB.workspaceId)).toBeUndefined();
    const catalogA = await registry.resolveCatalog(workspaceA);
    expect(Object.keys(catalogA.tools)).toContain("sys_invoke_tool");
    expect(await registry.getTool("invoke_tool", workspaceA)).toBeDefined();
  });

  it("skips cleanup for a tool reinstated before its release runs", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { registry, coordinator } = gateway(cloud, { locked: true });
    await coordinator.sync();
    const remove = vi.spyOn(registry, "removeManagedTool");
    const retire = registry.retireCloudTools.bind(registry);
    vi.spyOn(registry, "retireCloudTools").mockImplementation(async (workspaceId, tools) => {
      await retire(workspaceId, tools);
      // A republish lands between retirement and the release of the stored manifest.
      registry.reinstateCloudTools(workspaceId, [{ id: DROPPED, name: "dropped" }]);
    });

    cloud.setSnapshot(catalogSnapshot("v2", keptOnly()));
    await coordinator.sync({ fresh: true });

    expect(remove).not.toHaveBeenCalled();
  });

  it("releases the stored manifest of a tool that stays retired", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", both()));
    const { registry, coordinator } = gateway(cloud, { locked: true });
    await coordinator.sync();
    const remove = vi.spyOn(registry, "removeManagedTool");

    cloud.setSnapshot(catalogSnapshot("v2", keptOnly()));
    await coordinator.sync({ fresh: true });

    expect(remove.mock.calls.map(([entry]) => entry.toolId)).toEqual([DROPPED]);
  });
});
