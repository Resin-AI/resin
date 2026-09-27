import { describe, expect, it } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { FakeCatalogCloud, catalogSnapshot, identityA } from "./catalog-cloud-fixture.js";

const workspaceId = identityA.workspaceId;

function coordinatorFor(fetchFn: typeof fetch): CloudCatalogSyncCoordinator {
  const cache = new CloudCatalogCache();
  return new CloudCatalogSyncCoordinator({
    client: new CloudCatalogClient({
      identityProvider: async () => identityA,
      workspaceId,
      deviceId: identityA.deviceId,
      fetchFn,
    }),
    cache,
    router: new CloudInvocationRouter({ catalogCache: cache }),
    registry: new ToolRegistry({ autoHydrate: false }),
    workspaceId,
    onSyncError: () => {},
  });
}

describe("Catalog loaded signal", () => {
  it("stays pending while the cloud is unreachable and settles once it answers", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", []));
    let reachable = false;
    const coordinator = coordinatorFor(async (input, init) => {
      if (!reachable) throw new TypeError("fetch failed");
      return cloud.fetchFn(input, init);
    });
    let loaded = false;
    void coordinator.whenCatalogLoaded().then(() => {
      loaded = true;
    });

    // The offline fallback answers with an empty catalog, which says nothing about the real one.
    const offline = await coordinator.sync();
    expect(offline.tools).toEqual([]);
    await Promise.resolve();
    expect(loaded).toBe(false);

    reachable = true;
    await coordinator.sync();
    await coordinator.whenCatalogLoaded();
    expect(loaded).toBe(true);
  });
});
