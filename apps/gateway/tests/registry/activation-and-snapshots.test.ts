import type { ToolArtifact, ToolManifest, V1ToolLock } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { SYSTEM_META_TOOL_IDS } from "../../src/meta/system-tools.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest, computeSha256 } from "../../src/registry/validator.js";
import { makeV1ToolLockFixture } from "./fixtures.js";
function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "tool_1",
    name: overrides?.name ?? "test_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Test tool description",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https" as const],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("ToolRegistry - Atomic Activation & Snapshots", () => {
  it("atomically creates immutable snapshots with monotonic revisions on activation", async () => {
    const registry = new ToolRegistry();
    const manifestA = makeManifest({ id: "tool_a", name: "toolA", version: "1.0.0" });
    const manifestB = makeManifest({ id: "tool_b", name: "toolB", version: "1.0.0" });

    await registry.stageToolVersion(manifestA);
    await registry.stageToolVersion(manifestB);

    const snapshot1 = await registry.activateToolVersion("tool_a", "1.0.0", "ws-snapshot");
    expect(snapshot1.tools.tool_a).toBeDefined();
    expect(snapshot1.tools.tool_b).toBeUndefined();
    expect(Object.isFrozen(snapshot1.tools)).toBe(true);

    const snapshot2 = await registry.activateToolVersion("tool_b", "1.0.0", "ws-snapshot");
    expect(snapshot2.tools.tool_a).toBeDefined();
    expect(snapshot2.tools.tool_b).toBeDefined();
    expect(registry.getRevision("ws-snapshot")).toBeGreaterThan(1);
    expect(snapshot2.digest).toBeTruthy();
    expect(snapshot2.digest).not.toEqual(snapshot1.digest);
  });

  it("advances monotonic revisions upon deactivation and updates catalog snapshot", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: "tool_c", name: "toolC", version: "1.0.0" });

    await registry.stageToolVersion(manifest);
    const snapActive = await registry.activateToolVersion("tool_c", "1.0.0", "ws-deact");
    expect(snapActive.tools.tool_c).toBeDefined();

    const snapDeact = await registry.deactivateTool("tool_c", "ws-deact");
    expect(snapDeact.tools.tool_c).toBeUndefined();
    expect(registry.getRevision("ws-deact")).toBeGreaterThan(1);
  });

  it("leverages LRU cache and invalidates on workspace update", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: "tool_cache", name: "toolCache", version: "1.0.0" });
    const manifestV2 = makeManifest({ id: "tool_cache", name: "toolCache", version: "2.0.0" });

    await registry.stageToolVersion(manifestV1);
    await registry.stageToolVersion(manifestV2);

    await registry.activateToolVersion("tool_cache", "1.0.0", "ws-cache");

    const resolved1 = await registry.resolveCatalog("ws-cache");
    expect(resolved1.tools.tool_cache.version).toBe("1.0.0");
    expect(registry.cache.has("ws-cache")).toBe(true);

    // Activating v2 invalidates cache and builds new snapshot
    await registry.activateToolVersion("tool_cache", "2.0.0", "ws-cache");
    const resolved2 = await registry.resolveCatalog("ws-cache");

    expect(resolved2.tools.tool_cache.version).toBe("2.0.0");
    expect(resolved2.digest).not.toEqual(resolved1.digest);
  });
});

describe("ToolRegistry - Exact-Version Locked Workspace Resolution", () => {
  const toolId = "550e8400-e29b-41d4-a716-446655440000";

  function makeValidArtifact(
    digest: string,
    sourceCode = "export default function() { return 'ok'; }",
  ): ToolArtifact {
    return {
      artifactDigest: digest,
      bundleReference: {
        uri: `memory://${digest}`,
        hash: computeSha256(sourceCode),
        sizeBytes: Buffer.byteLength(sourceCode, "utf8"),
        format: "embedded",
      },
      entrypoint: "index.js",
      sourceCode,
      checksums: {},
    };
  }

  it("resolves exact locked entries when bound to a validated V1ToolLock", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const manifestDigest = computeManifestDigest(manifest);
    const artifactDigest = "a".repeat(64);
    const artifact = makeValidArtifact(artifactDigest);

    await registry.stageToolVersion(manifest, artifact);

    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-exact", lock);

    const catalog = await registry.resolveCatalog("ws-exact");
    expect(catalog.tools[toolId]).toBeDefined();
    expect(catalog.tools[toolId].version).toBe("1.0.0");
    expect(catalog.tools[toolId].toolId).toBe(toolId);

    const tool = await registry.getTool("tool_alpha", "ws-exact");
    expect(tool).toBeDefined();
    expect(tool?.version).toBe("1.0.0");
  });

  it("resolves multiple tools locked at different versions across isolated workspaces", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const manifestV2 = makeManifest({ id: toolId, name: "tool_alpha", version: "2.0.0" });
    const digestV1 = computeManifestDigest(manifestV1);
    const digestV2 = computeManifestDigest(manifestV2);
    const artV1 = "1".repeat(64);
    const artV2 = "2".repeat(64);

    await registry.stageToolVersion(manifestV1, makeValidArtifact(artV1));
    await registry.stageToolVersion(manifestV2, makeValidArtifact(artV2));

    // Workspace 1 locks to 1.0.0, Workspace 2 locks to 2.0.0
    const lockWs1 = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digestV1,
        artifactDigest: artV1,
        status: "active",
      },
    });

    const lockWs2 = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "2.0.0",
        manifestDigest: digestV2,
        artifactDigest: artV2,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-project-1", lockWs1);
    registry.bindWorkspaceLock("ws-project-2", lockWs2);

    const [catalog1, catalog2] = await Promise.all([
      registry.resolveCatalog("ws-project-1"),
      registry.resolveCatalog("ws-project-2"),
    ]);

    expect(catalog1.tools[toolId].version).toBe("1.0.0");
    expect(catalog2.tools[toolId].version).toBe("2.0.0");

    const tool1 = await registry.getTool("tool_alpha", "ws-project-1");
    const tool2 = await registry.getTool("tool_alpha", "ws-project-2");
    expect(tool1?.version).toBe("1.0.0");
    expect(tool2?.version).toBe("2.0.0");
  });

  it("fails closed when exact locked version is missing (no latest fallback)", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const digestV1 = computeManifestDigest(manifestV1);
    const artV1 = "1".repeat(64);
    await registry.stageToolVersion(manifestV1, makeValidArtifact(artV1));

    // Lock specifies 2.0.0 which has NOT been staged/registered
    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "2.0.0",
        manifestDigest: "2".repeat(64),
        artifactDigest: "2".repeat(64),
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-missing-v2", lock);

    const catalog = await registry.resolveCatalog("ws-missing-v2");
    // tool_alpha must NOT resolve and MUST NOT fallback to 1.0.0
    expect(catalog.tools[toolId]).toBeUndefined();

    const tool = await registry.getTool("tool_alpha", "ws-missing-v2");
    expect(tool).toBeUndefined();
  });

  it("does not perform latest-version substitution when a newer version is staged", async () => {
    const registry = new ToolRegistry();
    const manifestV1 = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const digestV1 = computeManifestDigest(manifestV1);
    const artV1 = "1".repeat(64);
    await registry.stageToolVersion(manifestV1, makeValidArtifact(artV1));

    // Lock specifies 1.0.0
    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digestV1,
        artifactDigest: artV1,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-pin-test", lock);

    // Stage newer version 3.0.0
    const manifestV3 = makeManifest({ id: toolId, name: "tool_alpha", version: "3.0.0" });
    const digestV3 = computeManifestDigest(manifestV3);
    const artV3 = "3".repeat(64);
    await registry.stageToolVersion(manifestV3, makeValidArtifact(artV3));

    const catalog = await registry.resolveCatalog("ws-pin-test");
    expect(catalog.tools[toolId]).toBeDefined();
    // MUST strictly resolve locked 1.0.0, NOT newer 3.0.0
    expect(catalog.tools[toolId].version).toBe("1.0.0");
    const tool = await registry.getTool("tool_alpha", "ws-pin-test");
    expect(tool?.version).toBe("1.0.0");
  });

  it("rejects malformed locks on binding", () => {
    const registry = new ToolRegistry();
    const malformedLock = {
      schemaKind: "invalid_kind",
      tools: {
        tool_alpha: {
          toolId,
          name: "tool_alpha",
          version: "1.0.0",
          manifestDigest: "a".repeat(64),
          artifactDigest: "a".repeat(64),
          status: "active",
        },
      },
    };

    expect(() => registry.bindWorkspaceLock("ws-malformed", malformedLock)).toThrow();
  });

  it("fails closed on manifest or artifact digest mismatch without crashing unrelated tools", async () => {
    const registry = new ToolRegistry();
    const manifest1 = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const digest1 = computeManifestDigest(manifest1);
    const art1 = "a".repeat(64);
    await registry.stageToolVersion(manifest1, makeValidArtifact(art1));

    const toolId2 = "660e8400-e29b-41d4-a716-446655440001";
    const manifest2 = makeManifest({ id: toolId2, name: "tool_beta", version: "1.0.0" });
    const digest2 = computeManifestDigest(manifest2);
    const art2 = "b".repeat(64);
    await registry.stageToolVersion(manifest2, makeValidArtifact(art2));

    // Lock has tampered manifestDigest for tool_alpha, but valid digest for tool_beta
    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: "f".repeat(64), // mismatched
        artifactDigest: art1,
        status: "active",
      },
      tool_beta: {
        toolId: toolId2,
        name: "tool_beta",
        version: "1.0.0",
        manifestDigest: digest2,
        artifactDigest: art2,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-digest-check", lock);

    const catalog = await registry.resolveCatalog("ws-digest-check");
    // tool_alpha fails closed because digest mismatch
    expect(catalog.tools[toolId]).toBeUndefined();
    // tool_beta resolves successfully
    expect(catalog.tools[toolId2]).toBeDefined();
    expect(catalog.tools[toolId2].version).toBe("1.0.0");
  });

  it("never resolves tools with disabled, revoked, or blocked status", async () => {
    const registry = new ToolRegistry();
    const toolId1 = "550e8400-e29b-41d4-a716-446655440001";
    const toolId2 = "550e8400-e29b-41d4-a716-446655440002";

    const manifest1 = makeManifest({ id: toolId1, name: "tool_alpha", version: "1.0.0" });
    const manifest2 = makeManifest({ id: toolId2, name: "tool_beta", version: "1.0.0" });

    await registry.stageToolVersion(manifest1, makeValidArtifact("a".repeat(64)));
    await registry.stageToolVersion(manifest2, makeValidArtifact("b".repeat(64)));

    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId: toolId1,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: computeManifestDigest(manifest1),
        artifactDigest: "a".repeat(64),
        status: "disabled",
      },
      tool_beta: {
        toolId: toolId2,
        name: "tool_beta",
        version: "1.0.0",
        manifestDigest: computeManifestDigest(manifest2),
        artifactDigest: "b".repeat(64),
        status: "disabled",
      },
    });

    registry.bindWorkspaceLock("ws-status-check", lock);

    const catalog = await registry.resolveCatalog("ws-status-check");
    expect(catalog.tools[toolId1]).toBeUndefined();
    expect(catalog.tools[toolId2]).toBeUndefined();
    const toolAlpha = await registry.getTool("tool_alpha", "ws-status-check");
    expect(toolAlpha).toBeUndefined();
  });

  it("preserves invariant system meta-tools in bound workspaces", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ id: toolId, name: "tool_alpha", version: "1.0.0" });
    const digest = computeManifestDigest(manifest);
    const art = "a".repeat(64);
    await registry.stageToolVersion(manifest, makeValidArtifact(art));

    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digest,
        artifactDigest: art,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-meta-check", lock);

    const catalog = await registry.resolveCatalog("ws-meta-check");
    expect(catalog.tools[toolId]).toBeDefined();
    // System meta-tools must remain accessible
    expect(catalog.tools[SYSTEM_META_TOOL_IDS.INVOKE_TOOL]).toBeDefined();
    expect(catalog.tools[SYSTEM_META_TOOL_IDS.SEARCH_TOOLS]).toBeDefined();
    expect(catalog.tools[SYSTEM_META_TOOL_IDS.MANAGE_TOOLS]).toBeDefined();
    expect(catalog.tools[SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA]).toBeDefined();
  });

  it("rejects manual activation of unlocked tools or mismatched versions in bound workspace", async () => {
    const registry = new ToolRegistry();
    const lockedToolId = "550e8400-e29b-41d4-a716-446655440001";
    const manifestLocked = makeManifest({ id: lockedToolId, name: "tool_alpha", version: "1.0.0" });
    const digest = computeManifestDigest(manifestLocked);
    const art = "a".repeat(64);
    await registry.stageToolVersion(manifestLocked, makeValidArtifact(art));

    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId: lockedToolId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digest,
        artifactDigest: art,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-lock-gate", lock);

    // Staging and activating an unlocked tool
    const unlockedManifest = makeManifest({
      id: "990e8400-e29b-41d4-a716-446655440099",
      name: "tool_unlocked",
      version: "1.0.0",
    });
    await registry.stageToolVersion(unlockedManifest, makeValidArtifact("9".repeat(64)));

    // Activating unlocked tool on bound workspace must throw
    await expect(
      registry.activateToolVersion("990e8400-e29b-41d4-a716-446655440099", "1.0.0", "ws-lock-gate"),
    ).rejects.toThrow(/bound to a lockfile/);
  });
});
