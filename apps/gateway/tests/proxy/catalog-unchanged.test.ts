import type { ToolManifest } from "@resin/contracts";
import {
  CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY,
  CATALOG_TOOL_RECOMMENDATION_CAPABILITY,
  ValidationError,
  parseCatalogCapabilities,
} from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient, verifyCatalogSnapshot } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import {
  FakeCatalogCloud,
  catalogSnapshot,
  catalogTool,
  identityA,
} from "./catalog-cloud-fixture.js";

const TOOL_ONE = "33333333-3333-4333-8333-333333333333";
const TOOL_TWO = "44444444-4444-4444-8444-444444444444";
const workspaceId = identityA.workspaceId;

function setup(cloud: FakeCatalogCloud) {
  const client = new CloudCatalogClient({
    identityProvider: async () => identityA,
    workspaceId,
    deviceId: identityA.deviceId,
    fetchFn: cloud.fetchFn,
  });
  const cache = new CloudCatalogCache();
  const registry = new ToolRegistry({ autoHydrate: false });
  const errors: Error[] = [];
  const coordinator = new CloudCatalogSyncCoordinator({
    client,
    cache,
    router: new CloudInvocationRouter({ catalogCache: cache }),
    registry,
    workspaceId,
    onSyncError: (error) => errors.push(error),
  });
  return { client, cache, registry, errors, coordinator };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Catalog client unchanged capability", () => {
  it("advertises the capability only when it names a version it holds", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const { client } = setup(cloud);

    const first = await client.fetchCatalogSnapshotResult({ acceptUnchanged: true });
    expect(first.kind).toBe("snapshot");
    const second = await client.fetchCatalogSnapshotResult({
      currentVersion: "v1",
      acceptUnchanged: true,
    });
    expect(second).toEqual({ kind: "unchanged", snapshotVersion: "v1" });
    const plain = await client.fetchCatalogSnapshot({ currentVersion: "v1" });
    expect(plain.snapshotVersion).toBe("v1");

    expect(cloud.catalogRequests).toEqual([
      { workspaceId, currentVersion: null, capabilities: null },
      { workspaceId, currentVersion: "v1", capabilities: CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY },
      { workspaceId, currentVersion: "v1", capabilities: null },
    ]);
  });

  it("rejects an unchanged body the request did not accept", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", []));
    const { client } = setup(cloud);
    const fetchFn = vi.fn(async () => Response.json({ unchanged: true, snapshotVersion: "v1" }));
    const strictClient = new CloudCatalogClient({
      identityProvider: async () => identityA,
      workspaceId,
      deviceId: identityA.deviceId,
      fetchFn,
    });
    await expect(
      strictClient.fetchCatalogSnapshot({ currentVersion: "v1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.getCircuitBreaker().getHealth().failureCount).toBe(0);
  });
});

describe("Coordinator on an unchanged catalog", () => {
  it("keeps the cached snapshot and skips downstream reconciliation", async () => {
    const tool = catalogTool(TOOL_ONE, "one");
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [tool]));
    const { cache, registry, errors, coordinator } = setup(cloud);

    const first = await coordinator.sync();
    expect(first.snapshotVersion).toBe("v1");
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(true);

    const register = vi.spyOn(registry, "registerToolSync");
    const activate = vi.spyOn(registry, "activateToolVersion");
    const second = await coordinator.sync();

    expect(cloud.catalogRequests.at(-1)?.capabilities).toBe(CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY);
    expect(second).toBe(first);
    expect(cache.getSnapshot(workspaceId)).toBe(first);
    expect(register).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("treats unchanged as a current sync that restarts cache freshness", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const { cache, coordinator } = setup(cloud);

    await coordinator.sync();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await coordinator.sync();
    expect(cloud.catalogRequests.at(-1)?.capabilities).toBe(CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY);

    // Past the 5-minute soft TTL of the first fetch, but not of the unchanged sync.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(cache.getToolAvailability(TOOL_ONE, workspaceId).availability).toBe("fresh");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(cache.getToolAvailability(TOOL_ONE, workspaceId).availability).toBe("stale");
  });

  it("still reconciles an unchanged catalog when a tool it activated went inactive", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const { registry, coordinator } = setup(cloud);

    await coordinator.sync();
    await registry.deactivateTool(TOOL_ONE, workspaceId);
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(false);

    await coordinator.sync();
    expect(cloud.catalogRequests.at(-1)?.capabilities).toBe(CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY);
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(true);
  });

  it("reconciles a new catalog version in full", async () => {
    const one = catalogTool(TOOL_ONE, "one");
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [one]));
    const { cache, registry, coordinator } = setup(cloud);

    await coordinator.sync();
    cloud.setSnapshot(catalogSnapshot("v2", [one, catalogTool(TOOL_TWO, "two")]));
    const next = await coordinator.sync();

    expect(next.snapshotVersion).toBe("v2");
    expect(cache.getSnapshot(workspaceId)?.snapshotVersion).toBe("v2");
    expect(registry.isToolActiveForWorkspace(TOOL_TWO, "1.0.0", workspaceId)).toBe(true);
  });

  it("refetches in full, without the capability, when unchanged names another version", async () => {
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [catalogTool(TOOL_ONE, "one")]));
    const { cache, errors, coordinator } = setup(cloud);

    await coordinator.sync();
    cloud.unchangedOverride = () => ({ unchanged: true, snapshotVersion: "v0" });
    const result = await coordinator.sync();

    expect(cloud.catalogRequests.slice(1)).toEqual([
      { workspaceId, currentVersion: "v1", capabilities: CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY },
      { workspaceId, currentVersion: "v1", capabilities: null },
    ]);
    expect(result.snapshotVersion).toBe("v1");
    expect(cache.getSnapshot(workspaceId)?.snapshotVersion).toBe("v1");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ValidationError);
    expect(errors[0]?.message).toContain("holds 'v1'");
  });

  it("refetches in full, without the capability, when unchanged arrives with no cached snapshot", async () => {
    const tool = catalogTool(TOOL_ONE, "one");
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [tool]));
    const { client, cache, registry, errors, coordinator } = setup(cloud);
    vi.spyOn(client, "fetchCatalogSnapshotResult").mockResolvedValueOnce({
      kind: "unchanged",
      snapshotVersion: "v1",
    });

    const result = await coordinator.sync();

    expect(cloud.catalogRequests).toEqual([
      { workspaceId, currentVersion: null, capabilities: null },
    ]);
    expect(result.snapshotVersion).toBe("v1");
    expect(cache.getSnapshot(workspaceId)?.tools).toHaveLength(1);
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(true);
    expect(errors[0]?.message).toContain("holds no snapshot");
  });
});

describe("Catalog tool recommendation", () => {
  const demoted = {
    automatic: false,
    reason: "measured_net_cost",
    invocations: 4,
    savedTokens: -2480,
    savedCostUsd: -0.0091,
  };
  const withRecommendation = (tool: ToolManifest, recommendation = demoted): ToolManifest => ({
    ...tool,
    recommendation,
  });
  const registeredRecommendation = (registry: ToolRegistry) =>
    registry.getAllRegisteredTools().find((tool) => tool.toolId === TOOL_ONE)?.manifest
      .recommendation;

  it("is advertised on every snapshot request and left out of the manifest digest", async () => {
    const tool = catalogTool(TOOL_ONE, "one");
    expect(computeManifestDigest(withRecommendation(tool))).toBe(tool.digest);
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [withRecommendation(tool)]));
    const { client } = setup(cloud);

    const snapshot = await client.fetchCatalogSnapshot();
    await client.fetchCatalogSnapshotResult({ currentVersion: "v1", acceptUnchanged: true });

    expect(snapshot.tools[0]?.recommendation).toEqual(demoted);
    for (const header of cloud.capabilityHeaders) {
      expect(parseCatalogCapabilities(header).has(CATALOG_TOOL_RECOMMENDATION_CAPABILITY)).toBe(
        true,
      );
    }
  });

  it("verifies a snapshot whose recommendation carries keys this client does not know", () => {
    const tool = withRecommendation(catalogTool(TOOL_ONE, "one"), {
      ...demoted,
      measuredSince: "2026-10-01",
    } as typeof demoted);
    const verified = verifyCatalogSnapshot(catalogSnapshot("v1", [tool]));
    expect(verified.tools[0]?.recommendation).toMatchObject({ measuredSince: "2026-10-01" });
  });

  it("reaches the registered tool, follows the cloud at the same version, and reverts", async () => {
    const tool = catalogTool(TOOL_ONE, "one");
    const cloud = new FakeCatalogCloud(catalogSnapshot("v1", [withRecommendation(tool)]));
    const { registry, coordinator } = setup(cloud);

    await coordinator.sync();
    expect(registeredRecommendation(registry)).toEqual(demoted);

    // Same tool version, new measurements: the cloud bumps the snapshot version only.
    cloud.setSnapshot(catalogSnapshot("v2", [tool]));
    await coordinator.sync();
    expect(registry.isToolActiveForWorkspace(TOOL_ONE, "1.0.0", workspaceId)).toBe(true);
    expect(registeredRecommendation(registry)).toBeUndefined();

    cloud.setSnapshot(catalogSnapshot("v3", [withRecommendation(tool)]));
    await coordinator.sync();
    expect(registeredRecommendation(registry)).toEqual(demoted);
  });
});
