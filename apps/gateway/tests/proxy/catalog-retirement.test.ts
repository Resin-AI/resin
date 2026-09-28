import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectLockManager } from "../../src/project/project-lock.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import {
  FakeCatalogCloud,
  catalogSnapshot,
  catalogTool,
  identityA,
} from "./catalog-cloud-fixture.js";

const KEPT = "33333333-3333-4333-8333-333333333333";
const DROPPED = "44444444-4444-4444-8444-444444444444";
const PROJECT = "d53e4e21-7947-42ab-bff1-21c10807ea0f";
const workspaceId = identityA.workspaceId;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-retire-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(cloud: FakeCatalogCloud, options: { locked: boolean }) {
  const cache = new CloudCatalogCache();
  const registry = new ToolRegistry({ autoHydrate: false });
  const lockManager = options.locked
    ? new ProjectLockManager({
        lockPath: path.join(root, ".resin", "resin.lock"),
        projectId: PROJECT,
      })
    : undefined;
  const coordinator = new CloudCatalogSyncCoordinator({
    client: new CloudCatalogClient({
      identityProvider: async () => identityA,
      workspaceId,
      deviceId: identityA.deviceId,
      fetchFn: cloud.fetchFn,
    }),
    cache,
    router: new CloudInvocationRouter({ catalogCache: cache }),
    registry,
    workspaceId,
    lockManager,
  });
  const names: Record<string, string> = { [KEPT]: "kept", [DROPPED]: "dropped" };
  const listed = async () =>
    Object.keys((await registry.resolveCatalog(workspaceId)).tools)
      .flatMap((toolId) => names[toolId] ?? [])
      .sort();
  return { registry, lockManager, coordinator, listed };
}

describe.each([
  ["a project lock", true],
  ["no project lock", false],
])("catalog retirement with %s", (_label, locked) => {
  it("stops listing and invoking a tool the newest snapshot drops, keeping the rest", async () => {
    const cloud = new FakeCatalogCloud(
      catalogSnapshot("v1", [catalogTool(KEPT, "kept"), catalogTool(DROPPED, "dropped")]),
    );
    const { registry, lockManager, coordinator, listed } = setup(cloud, { locked });
    await coordinator.sync();
    expect(await listed()).toEqual(["dropped", "kept"]);
    const stale = await registry.getTool("dropped", workspaceId);
    if (!stale?.handler) throw new Error("dropped tool was never active");

    cloud.setSnapshot(catalogSnapshot("v2", [catalogTool(KEPT, "kept")]));
    await coordinator.sync({ fresh: true });

    expect(await listed()).toEqual(["kept"]);
    expect(await registry.getTool("dropped", workspaceId)).toBeUndefined();
    expect(await registry.getTool(DROPPED, workspaceId)).toBeUndefined();
    expect(registry.getAllRegisteredTools().some((tool) => tool.toolId === DROPPED)).toBe(false);
    expect(registry.retiredToolMessage("dropped")).toMatch(/no longer available/);
    await expect(stale.handler({ workspaceId }, {})).rejects.toThrow(/no longer available/);
    expect(await registry.getTool("kept", workspaceId)).toBeDefined();
    if (lockManager) expect(Object.keys(lockManager.read().tools)).toEqual(["kept"]);

    // A later snapshot that publishes the tool again brings it back.
    cloud.setSnapshot(
      catalogSnapshot("v3", [catalogTool(KEPT, "kept"), catalogTool(DROPPED, "dropped")]),
    );
    await coordinator.sync({ fresh: true });
    expect(await listed()).toEqual(["dropped", "kept"]);
    expect(registry.retiredToolMessage("dropped")).toBeUndefined();
  });

  it("replaces an old version with the version the new snapshot publishes", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(KEPT, "kept", "1.0.0")]));
    const { registry, lockManager, coordinator } = setup(cloud, { locked });
    await coordinator.sync();

    cloud.setSnapshot(catalogSnapshot("v2", [catalogTool(KEPT, "kept", "2.0.0")]));
    await coordinator.sync({ fresh: true });

    expect((await registry.getTool("kept", workspaceId))?.version).toBe("2.0.0");
    expect(registry.retiredToolMessage("kept")).toBeUndefined();
    if (lockManager) expect(lockManager.read().tools.kept?.version).toBe("2.0.0");
  });
});

describe("catalog retirement offline", () => {
  it("serves the last verified snapshot, not tools a stale lock still names", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(KEPT, "kept")]));
    const { lockManager, coordinator, listed } = setup(cloud, { locked: true });
    await coordinator.sync();
    // A lock written before this fix still names a tool the verified snapshot dropped.
    const kept = lockManager?.read().tools.kept;
    if (!lockManager || !kept) throw new Error("kept tool was not locked");
    lockManager.reconcileQualified({ ...kept, toolId: DROPPED, name: "dropped" });

    await coordinator.reconcileLockedToolsOffline();

    expect(await listed()).toEqual(["kept"]);
    expect(Object.keys(lockManager.read().tools)).toEqual(["kept"]);
  });
});
