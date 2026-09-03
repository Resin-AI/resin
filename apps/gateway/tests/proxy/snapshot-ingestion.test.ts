import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { hashCanonicalContent } from "@resin/contracts";
import { QuarantineManager } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { MockCloudMcpService } from "./mock-service.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const LOCKED_TOOL_ID = "55555555-5555-4555-8555-555555555555";

function makeCloudManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: "cloud_search",
    name: "cloud_search",
    version: "1.0.0",
    description: "Search documents via cloud proxy",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 256,
      timeoutMs: 10000,
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
        allowOutbound: true,
        allowedDomains: ["api.example.com"],
        allowedHosts: [],
        allowedPorts: [443],
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
        maxMemoryMb: 256,
        maxExecutionTimeMs: 10000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 10000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 268435456,
      maxConcurrentInvocations: 4,
    },
    scope: "workspace" as const,
    metadata: {
      source: "cloud",
      artifactDigest: crypto
        .createHash("sha256")
        .update((overrides?.id ?? "cloud_search") + (overrides?.version ?? "1.0.0"))
        .digest("hex"),
      ...overrides?.metadata,
    },
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };

  const digest = computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("Snapshot Ingestion & Quarantine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-ingest-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it("ingests a valid cloud snapshot", async () => {
    const mockService = new MockCloudMcpService();
    const manifest = makeCloudManifest();
    mockService.seedTools([manifest]);

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

    const snapshot = await syncCoordinator.sync();

    expect(snapshot.snapshotVersion).toBeDefined();
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.tools[0].id).toBe("cloud_search");
    expect(snapshot.checksum).toBeDefined();

    const cachedTool = cache.getTool("cloud_search", "ws-1");
    expect(cachedTool).toBeTruthy();
    expect(cachedTool?.availability).toBe("fresh");
    expect(cachedTool?.source).toBe("cloud");
  });

  it("rejects snapshot with corrupted or tampered canonical checksum", async () => {
    const mockService = new MockCloudMcpService();
    const manifest = makeCloudManifest();
    mockService.seedTools([manifest]);

    const cache = new CloudCatalogCache();
    const customFetch = async (
      input: Request | URL | string,
      init?: RequestInit,
    ): Promise<Response> => {
      const fetchHandler = mockService.createFetchHandler();
      const res = await fetchHandler(input, init);
      const data = await res.json();
      data.checksum = "f".repeat(64);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      // SAFETY: Test fixture provides mock fetchFn matching fetch signature.
      fetchFn: customFetch as typeof fetch,
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache });

    let syncError: Error | null = null;
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      onSyncError: (err) => {
        syncError = err;
      },
    });

    await syncCoordinator.sync();

    expect(syncError).toBeDefined();
    expect(syncError?.message.toLowerCase()).toContain("checksum mismatch");
    expect(cache.getTool("cloud_search", "ws-1")).toBeNull();
  });

  it("caches snapshot and tracks soft TTL and hard expiry", async () => {
    vi.useFakeTimers();
    const cache = new CloudCatalogCache({ freshTtlMs: 1000, hardExpiryMs: 5000 });
    const manifest = makeCloudManifest();
    const snapshot = {
      snapshotVersion: "v1",
      generatedAt: new Date().toISOString(),
      tools: [manifest],
      activeDeployments: [],
      checksum: hashCanonicalContent({ tools: [manifest], activeDeployments: [] }),
    };

    cache.setSnapshot(snapshot, { workspaceId: "ws-1" });

    let tool = cache.getTool("cloud_search", "ws-1");
    expect(tool?.availability).toBe("fresh");

    vi.advanceTimersByTime(1500);
    tool = cache.getTool("cloud_search", "ws-1");
    expect(tool?.availability).toBe("stale");
    expect(tool?.staleReason).toContain("Soft TTL expired");

    vi.advanceTimersByTime(5000);
    tool = cache.getTool("cloud_search", "ws-1");
    expect(tool?.availability).toBe("expired");
  });

  it("integrates cloud catalog into ToolRegistry and resolves correctly", async () => {
    const mockService = new MockCloudMcpService();
    const manifest = makeCloudManifest();
    mockService.seedTools([manifest]);

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

    const regTool = registry.getToolVersion("cloud_search", "1.0.0");
    expect(regTool).toBeDefined();
    expect(regTool?.manifest.id).toBe("cloud_search");
    expect(regTool?.metadata?.source).toBe("cloud");
    expect(regTool?.metadata?.availability).toBe("fresh");

    const catalog = await registry.resolveCatalog("ws-1");
    expect(catalog.tools.cloud_search).toBeDefined();
    expect(catalog.tools.cloud_search.toolId).toBe("cloud_search");
  });

  it("quarantine handling: corrupt or tampered artifact is quarantined and isolated", async () => {
    const quarantineDir = path.join(tempDir, "quarantine");
    const quarantineManager = new QuarantineManager({ quarantineDir });

    const corruptPayload = Buffer.from("malformed or malicious tool code");
    const digest = crypto.createHash("sha256").update(corruptPayload).digest("hex");

    const record = await quarantineManager.quarantinePayload(
      corruptPayload,
      "digest_mismatch",
      {
        expectedDigest: "expected_valid_digest",
        actualDigest: digest,
        toolId: "malicious_tool_id",
        version: "1.0.0",
      },
      digest,
      "malicious_tool_id",
    );

    expect(record.quarantineId).toBeDefined();
    expect(record.reason).toBe("digest_mismatch");
    expect(record.digest).toBe(`sha256:${digest}`);

    const listing = await quarantineManager.listQuarantined();
    expect(
      listing.some(
        (r) =>
          r.sourceIdentifier === "malicious_tool_id" || r.details?.toolId === "malicious_tool_id",
      ),
    ).toBe(true);
  });

  it("no exact match / no substitution: rejects/ignores catalog tool when exact locked tuple does not match", async () => {
    const lockPath = path.join(tempDir, "resin.lock");
    const lockManager = new ProjectLockManager({ lockPath, projectId: PROJECT_ID });

    const lockedManifestDigest = "1".repeat(64);
    const lockedArtifactDigest = "2".repeat(64);

    lockManager.reconcileQualified({
      toolId: LOCKED_TOOL_ID,
      name: "query_runner",
      version: "1.0.0",
      manifestDigest: lockedManifestDigest,
      artifactDigest: lockedArtifactDigest,
      status: "active",
    });

    const mockService = new MockCloudMcpService();
    const cloudManifest = makeCloudManifest({
      id: LOCKED_TOOL_ID,
      name: "query_runner",
      version: "2.0.0",
    });
    mockService.seedTools([cloudManifest]);

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
      isPinned: (id) => id === LOCKED_TOOL_ID || id === "query_runner",
    });

    await syncCoordinator.sync();

    const currentLock = lockManager.read();
    expect(currentLock.tools.query_runner.version).toBe("1.0.0");
    expect(currentLock.tools.query_runner.manifestDigest).toBe(lockedManifestDigest);

    expect(registry.getToolVersion(LOCKED_TOOL_ID, "2.0.0")).toBeUndefined();
  });

  it("lock advances to newer version when tool is not pinned", async () => {
    const lockPath = path.join(tempDir, "resin-advance.lock");
    const lockManager = new ProjectLockManager({ lockPath, projectId: PROJECT_ID });

    const lockedManifestDigest = "1".repeat(64);
    const lockedArtifactDigest = "2".repeat(64);

    lockManager.reconcileQualified({
      toolId: LOCKED_TOOL_ID,
      name: "query_runner",
      version: "1.0.0",
      manifestDigest: lockedManifestDigest,
      artifactDigest: lockedArtifactDigest,
      status: "active",
    });

    const mockService = new MockCloudMcpService();
    const cloudManifest = makeCloudManifest({
      id: LOCKED_TOOL_ID,
      name: "query_runner",
      version: "2.0.0",
    });
    mockService.seedTools([cloudManifest]);

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
    });

    await syncCoordinator.sync();

    const currentLock = lockManager.read();
    expect(currentLock.tools.query_runner.version).toBe("2.0.0");
  });

  it("skips catalog entries that violate the lock contract without blocking other tools", async () => {
    const lockPath = path.join(tempDir, "resin.lock");
    const lockManager = new ProjectLockManager({ lockPath, projectId: PROJECT_ID });

    const mockService = new MockCloudMcpService();
    mockService.seedTools([
      makeCloudManifest({ id: "tool_legacy_nonuuid", name: "legacy_tool", version: "1.0.0" }),
      makeCloudManifest({ id: LOCKED_TOOL_ID, name: "query_runner", version: "1.0.0" }),
    ]);

    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const skipped: string[] = [];
    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router: new CloudInvocationRouter({ catalogCache: cache }),
      registry: new ToolRegistry(),
      workspaceId: "ws-1",
      lockManager,
      onToolSyncError: (toolName) => {
        skipped.push(toolName);
      },
    });

    await syncCoordinator.sync();

    const currentLock = lockManager.read();
    expect(currentLock.tools.legacy_tool).toBeUndefined();
    expect(currentLock.tools.query_runner?.toolId).toBe(LOCKED_TOOL_ID);
    expect(skipped).toContain("legacy_tool");
  });
});
