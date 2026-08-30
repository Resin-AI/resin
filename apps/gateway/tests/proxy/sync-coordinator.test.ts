import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ToolManifest, type V1LockedToolEntry, hashCanonicalContent } from "@resin/contracts";
import type { ArtifactTransferClient } from "@resin/observer";
import { ArtifactCache, encodeDeterministicTar } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { MockCloudMcpService } from "./mock-service.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const TOOL_CALC = "33333333-3333-4333-8333-333333333333";
const TOOL_SEARCH = "44444444-4444-4444-8444-444444444444";
const TOOL_FORMATTER = "55555555-5555-4555-8555-555555555555";
const TOOL_SHARED = "66666666-6666-4666-8666-666666666666";

function makeTool(id: string, name: string, version = "1.0.0"): ToolManifest {
  const base = {
    id,
    name,
    version,
    description: `Tool ${name}`,
    parameters: {
      type: "object" as const,
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 5000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
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
        maxExecutionTimeMs: 5000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: "workspace" as const,
    metadata: {
      artifactDigest: crypto
        .createHash("sha256")
        .update(id + version)
        .digest("hex"),
    },
    createdAt: "2026-08-17T12:00:00.000Z",
  };

  const digest = computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("CloudCatalogSyncCoordinator", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-coord-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it("handles emergency revocation invalidation events immediately", async () => {
    const mockService = new MockCloudMcpService();
    const toolA = makeTool("tool_a", "tool_a");
    const toolB = makeTool("tool_b", "tool_b");
    mockService.seedTools([toolA, toolB]);

    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
    });

    await syncCoordinator.sync();

    expect(cache.getTool("tool_a", "ws-1")?.availability).toBe("fresh");
    expect(cache.getTool("tool_b", "ws-1")?.availability).toBe("fresh");

    await syncCoordinator.handleInvalidation({
      type: "server.catalog_invalidation",
      workspaceId: "ws-1",
      reason: "emergency_revocation",
      toolIds: ["tool_a"],
      timestamp: new Date().toISOString(),
    });

    expect(cache.getTool("tool_a", "ws-1")).toBeNull();
    expect(cache.getTool("tool_b", "ws-1")?.availability).toBe("fresh");
  });

  it("handles version published and triggers incremental resync", async () => {
    const mockService = new MockCloudMcpService();
    const toolA = makeTool("tool_a", "tool_a");
    mockService.seedTools([toolA]);

    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
    });

    await syncCoordinator.sync();
    expect(cache.getTool("tool_a", "ws-1")).toBeTruthy();
    expect(cache.getTool("tool_b", "ws-1")).toBeNull();

    const toolB = makeTool("tool_b", "tool_b");
    mockService.seedTools([toolA, toolB]);

    await syncCoordinator.handleInvalidation({
      type: "server.catalog_invalidation",
      workspaceId: "ws-1",
      reason: "version_published",
      toolIds: ["tool_b"],
      timestamp: new Date().toISOString(),
    });

    expect(cache.getTool("tool_b", "ws-1")?.availability).toBe("fresh");
  });

  it("manages background periodic sync lifecycle", async () => {
    let fetchCount = 0;
    const mockService = new MockCloudMcpService();
    const originalHandler = mockService.createFetchHandler();
    // SAFETY: Test fixture provides mock fetchFn matching fetch signature.
    const fetchFn = (async (input: Request | URL | string, init?: RequestInit) => {
      fetchCount++;
      return originalHandler(input, init);
    }) as typeof fetch;

    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn,
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      intervalMs: 1000,
    });

    expect(syncCoordinator.isRunning()).toBe(false);
    syncCoordinator.startPeriodicSync();
    expect(syncCoordinator.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchCount).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchCount).toBeGreaterThanOrEqual(2);

    syncCoordinator.stopPeriodicSync();
    expect(syncCoordinator.isRunning()).toBe(false);

    const countAfterStop = fetchCount;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchCount).toBe(countAfterStop);
  });

  it("downloads missing locked artifact once and caches it in ArtifactCache", async () => {
    const lockPath = path.join(tempDir, "resin.lock");
    const cacheDir = path.join(tempDir, "artifacts");
    const projectId = PROJECT_A;

    const lockManager = new ProjectLockManager({ lockPath, projectId });
    const artifactCache = new ArtifactCache({ cacheDir });

    const manifest = makeTool(TOOL_CALC, "calc_tool", "1.0.0");
    const { archive: artifactContent } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(manifest) },
      { path: "src/index.js", content: "console.log('test tool');" },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(artifactContent).digest("hex");
    const manifestDigest = manifest.digest;

    lockManager.reconcileQualified({
      toolId: TOOL_CALC,
      name: "calc_tool",
      version: "1.0.0",
      manifestDigest,
      artifactDigest,
      status: "active",
    });
    let downloadCount = 0;
    // SAFETY: Test fixture provides mock ArtifactTransferClient.
    const transferClient = {
      downloadArtifact: async (digest: string) => {
        downloadCount++;
        if (digest === artifactDigest) {
          return { bytes: artifactContent, digest: artifactDigest };
        }
        throw new Error("Not found");
      },
    };

    const mockService = new MockCloudMcpService();
    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      lockManager,
      transferClient,
      artifactCache,
    });

    const res1 = await syncCoordinator.reconcileLockedTools();
    expect(res1.activated).toContain("calc_tool");
    expect(downloadCount).toBe(1);
    expect(fs.existsSync(artifactCache.getArtifactPath(artifactDigest))).toBe(true);

    const res2 = await syncCoordinator.reconcileLockedTools();
    expect(res2.activated).toContain("calc_tool");
    expect(downloadCount).toBe(1);
  });

  it("reconcileQualified adds new tool but reports newer_available without rewriting existing lock", async () => {
    const lockPath = path.join(tempDir, "resin.lock");
    const projectId = PROJECT_A;
    const toolV1 = makeTool(TOOL_SEARCH, "search_tool", "1.0.0");
    const lockManager = new ProjectLockManager({ lockPath, projectId });
    const toolV1Meta =
      toolV1.metadata && toolV1.metadata instanceof Object ? toolV1.metadata : undefined;
    const metaArtifactDigest =
      toolV1Meta &&
      "artifactDigest" in toolV1Meta &&
      Object.prototype.toString.call(toolV1Meta.artifactDigest) === "[object String]"
        ? String(toolV1Meta.artifactDigest)
        : toolV1.digest;
    lockManager.reconcileQualified({
      toolId: TOOL_SEARCH,
      name: "search_tool",
      version: "1.0.0",
      manifestDigest: toolV1.digest,
      artifactDigest: metaArtifactDigest,
      status: "active",
    });

    const mockService = new MockCloudMcpService();
    const toolCalc = makeTool(TOOL_CALC, "calc_tool", "1.0.0");
    mockService.seedTools([toolCalc]);
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const cache = new CloudCatalogCache();
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const qualifiedEvents: Array<{ tool: V1LockedToolEntry; outcome: string }> = [];

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      lockManager,
      onToolQualified: (tool, outcome) => {
        qualifiedEvents.push({ tool, outcome });
      },
    });

    await syncCoordinator.sync();
    const lock1 = lockManager.read();
    expect(lock1.tools.search_tool).toBeDefined();
    expect(lock1.tools.search_tool.version).toBe("1.0.0");
    expect(lock1.tools.calc_tool).toBeDefined();
    expect(lock1.tools.calc_tool.version).toBe("1.0.0");
    expect(qualifiedEvents.some((e) => e.tool.name === "calc_tool" && e.outcome === "added")).toBe(
      true,
    );

    const toolV2 = makeTool(TOOL_SEARCH, "search_tool", "2.0.0");
    mockService.seedTools([toolCalc, toolV2]);

    await syncCoordinator.sync();

    const lock2 = lockManager.read();
    expect(lock2.tools.search_tool.version).toBe("1.0.0");
    expect(
      qualifiedEvents.some(
        (e) =>
          e.tool.name === "search_tool" &&
          e.tool.version === "2.0.0" &&
          e.outcome === "newer_available",
      ),
    ).toBe(true);
  });

  it("supports two projects with different locked versions of same tool running concurrently", async () => {
    const project1Dir = path.join(tempDir, "proj1");
    const project2Dir = path.join(tempDir, "proj2");
    fs.mkdirSync(project1Dir, { recursive: true });
    fs.mkdirSync(project2Dir, { recursive: true });
    const manifestV1 = makeTool(TOOL_FORMATTER, "data_formatter", "1.0.0");
    const manifestV2 = makeTool(TOOL_FORMATTER, "data_formatter", "2.0.0");

    const lock1 = new ProjectLockManager({
      lockPath: path.join(project1Dir, "resin.lock"),
      projectId: PROJECT_A,
    });
    const lock2 = new ProjectLockManager({
      lockPath: path.join(project2Dir, "resin.lock"),
      projectId: PROJECT_B,
    });

    lock1.reconcileQualified({
      toolId: TOOL_FORMATTER,
      name: "data_formatter",
      version: "1.0.0",
      manifestDigest: manifestV1.digest,
      artifactDigest: "b".repeat(64),
      status: "active",
    });

    lock2.reconcileQualified({
      toolId: TOOL_FORMATTER,
      name: "data_formatter",
      version: "2.0.0",
      manifestDigest: manifestV2.digest,
      artifactDigest: "d".repeat(64),
      status: "active",
    });

    const registry1 = new ToolRegistry();
    const registry2 = new ToolRegistry();

    const mockService = new MockCloudMcpService();
    const cache = new CloudCatalogCache();
    for (const [workspaceId, manifest] of [
      ["ws-proj1", manifestV1],
      ["ws-proj2", manifestV2],
    ] as const) {
      const payload = { tools: [manifest], activeDeployments: [] };
      cache.setSnapshot(
        {
          snapshotVersion: "v1",
          generatedAt: "2026-08-17T12:00:00.000Z",
          ...payload,
          checksum: hashCanonicalContent(payload),
        },
        { workspaceId },
      );
    }
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const sync1 = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry: registry1,
      workspaceId: "ws-proj1",
      lockManager: lock1,
    });

    const sync2 = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry: registry2,
      workspaceId: "ws-proj2",
      lockManager: lock2,
    });

    const res1 = await sync1.reconcileLockedTools();
    const res2 = await sync2.reconcileLockedTools();

    expect(res1.activated).toContain("data_formatter");
    expect(res2.activated).toContain("data_formatter");

    expect(registry1.getToolVersion(TOOL_FORMATTER, "1.0.0")).toBeDefined();
    expect(registry1.getToolVersion(TOOL_FORMATTER, "2.0.0")).toBeUndefined();

    expect(registry2.getToolVersion(TOOL_FORMATTER, "2.0.0")).toBeDefined();
    expect(registry2.getToolVersion(TOOL_FORMATTER, "1.0.0")).toBeUndefined();
  });

  it("same digest dedupe: deduplicates artifact storage while maintaining independent locks", async () => {
    const cacheDir = path.join(tempDir, "shared_artifacts");
    const artifactCache = new ArtifactCache({ cacheDir });

    const manifest = makeTool(TOOL_SHARED, "shared_tool", "1.0.0");
    const { archive: artifactContent } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(manifest) },
      { path: "src/index.js", content: "console.log('shared executable logic');" },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(artifactContent).digest("hex");

    const lock1 = new ProjectLockManager({
      lockPath: path.join(tempDir, "proj1.lock"),
      projectId: PROJECT_A,
    });
    const lock2 = new ProjectLockManager({
      lockPath: path.join(tempDir, "proj2.lock"),
      projectId: PROJECT_B,
    });

    lock1.reconcileQualified({
      toolId: TOOL_SHARED,
      name: "shared_tool",
      version: "1.0.0",
      manifestDigest: manifest.digest,
      artifactDigest,
      status: "active",
    });

    lock2.reconcileQualified({
      toolId: TOOL_SHARED,
      name: "shared_tool",
      version: "1.0.0",
      manifestDigest: manifest.digest,
      artifactDigest,
      status: "active",
    });

    let downloadCount = 0;
    // SAFETY: Test fixture provides mock ArtifactTransferClient.
    const transferClient = {
      downloadArtifact: async () => {
        downloadCount++;
        return { bytes: artifactContent, digest: artifactDigest };
      },
    } as ArtifactTransferClient;

    const mockService = new MockCloudMcpService();
    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const router = new CloudInvocationRouter({ catalogCache: cache });

    const sync1 = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      workspaceId: "ws-1",
      lockManager: lock1,
      transferClient,
      artifactCache,
    });

    const sync2 = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      workspaceId: "ws-2",
      lockManager: lock2,
      transferClient,
      artifactCache,
    });

    await sync1.reconcileLockedTools();
    expect(downloadCount).toBe(1);

    await sync2.reconcileLockedTools();
    expect(downloadCount).toBe(1);

    expect(fs.existsSync(artifactCache.getArtifactPath(artifactDigest))).toBe(true);
  });

  it("handles circuit breaker trips and gracefully degrades to local locked sync", async () => {
    const mockService = new MockCloudMcpService();
    const cache = new CloudCatalogCache();
    const circuitBreaker = new CloudCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
      circuitBreaker,
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache, circuitBreaker });

    let circuitBrokenCalled = false;
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      circuitBreaker,
      onSyncCircuitBroken: () => {
        circuitBrokenCalled = true;
      },
    });

    mockService.injectError(new Error("Cloud outage 503"));

    await syncCoordinator.sync();
    await syncCoordinator.sync();

    expect(circuitBreaker.getState()).toBe("OPEN");

    const offlineSnapshot = await syncCoordinator.sync();
    expect(offlineSnapshot).toBeDefined();
    expect(circuitBrokenCalled).toBe(true);
  });
});
