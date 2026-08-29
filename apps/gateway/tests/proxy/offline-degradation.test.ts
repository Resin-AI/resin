import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ToolManifest, V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "@resin/contracts";
import {
  ArtifactCache,
  InMemoryKeyStore,
  RuntimeTrustStore,
  generateBundleKeyPair,
  signActivationCertificate,
  signRevocationMetadata,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { CloudCatalogSyncCoordinator } from "../../src/proxy/sync.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";
import { MockCloudMcpService } from "./mock-service.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const TOOL_QUERY = "22222222-2222-4222-8222-222222222222";
const TOOL_SEARCH = "55555555-5555-4555-8555-555555555555";
const CERT_ID = "33333333-3333-4333-8333-333333333333";
const REVOCATION_ID = "77777777-7777-4777-8777-777777777777";
const GOOD_TOOL_ID = "11111111-2222-4333-8444-555555555555";
const BAD_TOOL_ID = "66666666-7777-4888-8999-000000000000";
const ENVELOPE_DIGEST = "e".repeat(64);
const QUAL_DIGEST = "f".repeat(64);

function makeWorkspaceContext(workspaceId = "ws-1"): WorkspaceContext {
  return {
    workspaceId,
    projectId: PROJECT_ID,
    projectRoot: "/tmp/project",
    canonicalRoot: "/tmp/project",
    name: "test",
    source: "cwd_fallback",
    roots: [{ uri: "file:///tmp/project", path: "/tmp/project" }],
    sessionId: "sess-1",
  };
}

function makeCloudTool(id: string, name: string, version = "1.0.0"): ToolManifest {
  const base = {
    id,
    name,
    version,
    description: `Cloud Tool ${name}`,
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
    metadata: {},
    createdAt: "2026-08-17T12:00:00.000Z",
  };

  const digest = computeManifestDigest(base);
  return {
    ...base,
    digest,
    metadata: {
      manifestDigest: digest,
      artifactDigest: crypto
        .createHash("sha256")
        .update(id + version)
        .digest("hex"),
    },
  };
}

async function seedCachedArtifact(
  artifactCache: ArtifactCache,
  digest: string,
  content: Buffer | string,
  manifest?: ToolManifest,
): Promise<void> {
  const staging = await artifactCache.createStagingDirectory(digest);
  await fs.promises.mkdir(path.join(staging, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(staging, "src/index.js"), content);
  await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest ?? {}));
  const size = typeof content === "string" ? Buffer.byteLength(content) : content.length;
  await artifactCache.commitStagingDirectory(staging, digest, {
    digest,
    extractedAt: new Date().toISOString(),
    fileCount: 2,
    totalSizeBytes: size,
    entrypoint: "src/index.js",
    verified: true,
  });
}

describe("Offline Degradation & Locked Trust Verification", () => {
  let tempDir: string;
  const mockWorkspaceContext = makeWorkspaceContext();

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-degrade-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it("leaves local tools and meta-tools 100% operational when cloud goes offline", async () => {
    const mockService = new MockCloudMcpService();
    const cloudTool = makeCloudTool("cloud_tool_1", "cloud_fetch");
    mockService.seedTools([cloudTool]);

    const cache = new CloudCatalogCache();
    const circuitBreaker = new CloudCircuitBreaker({ failureThreshold: 1 });
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
      circuitBreaker,
    });

    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({
      catalogCache: cache,
      circuitBreaker,
      mockService,
    });
    const gatewayRouter = new RegistryGatewayRouter(registry);

    const localManifest = makeCloudTool("local_tool_1", "local_calc");
    registry.registerToolSync({
      toolId: "local_tool_1",
      name: "local_calc",
      version: "1.0.0",
      manifest: localManifest,
      scope: "workspace",
      status: "active",
      workspaceId: "ws-1",
      handler: async () => ({
        content: [{ type: "text", text: "calculated: 42" }],
      }),
    });

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      circuitBreaker,
    });

    await syncCoordinator.sync();

    const localRes = await gatewayRouter.callTool(mockWorkspaceContext, "local_calc", { a: 1 });
    expect(localRes.content[0]).toEqual({ type: "text", text: "calculated: 42" });

    const metaList = await gatewayRouter.callTool(mockWorkspaceContext, "search_tools", {});
    expect(metaList.content[0].type).toBe("text");

    mockService.simulateOffline(true);

    const localRes2 = await gatewayRouter.callTool(mockWorkspaceContext, "local_calc", { a: 2 });
    expect(localRes2.content[0]).toEqual({ type: "text", text: "calculated: 42" });

    const metaList2 = await gatewayRouter.callTool(mockWorkspaceContext, "search_tools", {});
    expect(metaList2.content[0].type).toBe("text");
  });

  it("blocks execution past hard expiry even if cloud tool is cached", async () => {
    const mockService = new MockCloudMcpService();
    const cloudTool = makeCloudTool("translate_text", "translate_text");
    mockService.seedTools([cloudTool]);

    const cache = new CloudCatalogCache({
      freshTtlMs: 5000,
      hardExpiryMs: 10000,
    });
    const circuitBreaker = new CloudCircuitBreaker({ failureThreshold: 1 });
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
      circuitBreaker,
    });

    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({
      catalogCache: cache,
      circuitBreaker,
      mockService,
    });
    const gatewayRouter = new RegistryGatewayRouter(registry);

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      circuitBreaker,
    });

    await syncCoordinator.sync();

    vi.advanceTimersByTime(11000);

    await expect(
      gatewayRouter.callTool(mockWorkspaceContext, "translate_text", { input: "hello" }),
    ).rejects.toThrow();
  });

  it("offline trust verification: expired certificate / lease fails closed", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "test-auth");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: "ed25519",
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "development",
        createdAt: new Date().toISOString(),
      },
    ]);

    const trustStore = new RuntimeTrustStore({
      dataDir: path.join(tempDir, "trust"),
      keyStore,
    });

    const lockPath = path.join(tempDir, "resin.lock");
    const lockManager = new ProjectLockManager({ lockPath, projectId: PROJECT_ID });

    const toolName = "database_query";
    const manifestDigest = "1".repeat(64);
    const artifactDigest = "2".repeat(64);

    lockManager.reconcileQualified({
      toolId: TOOL_QUERY,
      name: toolName,
      version: "1.0.0",
      manifestDigest,
      artifactDigest,
      envelopeDigest: ENVELOPE_DIGEST,
      status: "active",
    });

    const now = Date.now();
    const expiredCert = signActivationCertificate(
      {
        schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
        schemaVersion: V1_SCHEMA_VERSION,
        certificateId: CERT_ID,
        subject: {
          userId: USER_ID,
          accountId: ACCOUNT_A,
        },
        projectId: PROJECT_ID,
        toolId: TOOL_QUERY,
        toolName,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
        qualificationEvidenceDigest: QUAL_DIGEST,
        counter: 1,
        nonce: "nonce-expired-01",
        issuedAt: new Date(now - 2000).toISOString(),
        notBefore: new Date(now - 2000).toISOString(),
        expiresAt: new Date(now + 5000).toISOString(),
        status: "active",
      },
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    const identity = { accountId: ACCOUNT_A, userId: USER_ID, projectId: PROJECT_ID };
    await trustStore.recordActivationCertificate(identity, expiredCert, {
      allowDevKeys: true,
    });

    const artifactCache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    await seedCachedArtifact(artifactCache, artifactDigest, "module.exports = {}");

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

    const degradedEvents: Array<{ tool: string; reason: string }> = [];

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      lockManager,
      artifactCache,
      trustStore,
      identity,
      allowDevKeys: true,
      onOfflineDegraded: (tool, reason) => {
        degradedEvents.push({ tool, reason });
      },
    });

    vi.advanceTimersByTime(10_000);

    const summary = await syncCoordinator.reconcileLockedTools();
    expect(summary.failed).toContain(toolName);
    expect(registry.getToolVersion(TOOL_QUERY, "1.0.0")).toBeUndefined();
    expect(degradedEvents.some((e) => e.tool === toolName)).toBe(true);
  });

  it("offline trust verification: clock rollback detection fails closed", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "test-auth");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: "ed25519",
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "development",
        createdAt: new Date().toISOString(),
      },
    ]);

    const trustStore = new RuntimeTrustStore({
      dataDir: path.join(tempDir, "trust-rollback"),
      keyStore,
    });

    const toolName = "database_query";
    const manifestDigest = "1".repeat(64);
    const artifactDigest = "2".repeat(64);
    const now = Date.now();

    const cert = signActivationCertificate(
      {
        schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
        schemaVersion: V1_SCHEMA_VERSION,
        certificateId: CERT_ID,
        subject: {
          userId: USER_ID,
          accountId: ACCOUNT_A,
        },
        projectId: PROJECT_ID,
        toolId: TOOL_QUERY,
        toolName,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
        qualificationEvidenceDigest: QUAL_DIGEST,
        counter: 1,
        nonce: "nonce-rollback-01",
        issuedAt: new Date(now + 3600000).toISOString(),
        notBefore: new Date(now + 3600000).toISOString(),
        expiresAt: new Date(now + 86400000).toISOString(),
        status: "active",
      },
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    await expect(
      trustStore.recordActivationCertificate(
        { accountId: ACCOUNT_A, userId: USER_ID, projectId: PROJECT_ID },
        cert,
        { allowDevKeys: true },
      ),
    ).rejects.toThrow();
  });

  it("offline trust verification: signed revocation metadata rejects revoked tool", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "test-auth");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: "ed25519",
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "development",
        createdAt: new Date().toISOString(),
      },
    ]);

    const trustStore = new RuntimeTrustStore({
      dataDir: path.join(tempDir, "trust-revocation"),
      keyStore,
    });

    const toolName = "secure_search";
    const manifestDigest = "1".repeat(64);
    const artifactDigest = "2".repeat(64);
    const now = Date.now();
    const identity = { accountId: ACCOUNT_A, userId: USER_ID, projectId: PROJECT_ID };

    const cert = signActivationCertificate(
      {
        schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
        schemaVersion: V1_SCHEMA_VERSION,
        certificateId: CERT_ID,
        subject: {
          userId: USER_ID,
          accountId: ACCOUNT_A,
        },
        projectId: PROJECT_ID,
        toolId: TOOL_SEARCH,
        toolName,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
        qualificationEvidenceDigest: QUAL_DIGEST,
        counter: 1,
        nonce: "nonce-revoked-01",
        issuedAt: new Date(now - 1000).toISOString(),
        notBefore: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        status: "active",
      },
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    await trustStore.recordActivationCertificate(identity, cert, {
      allowDevKeys: true,
    });

    const revocationMetadata = signRevocationMetadata(
      {
        schemaKind: V1_SCHEMA_KINDS.REVOCATION_METADATA,
        schemaVersion: V1_SCHEMA_VERSION,
        revocationListId: REVOCATION_ID,
        authorityId: "test-authority",
        accountId: ACCOUNT_A,
        sequenceNumber: 1,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 86400000).toISOString(),
        revokedTools: [
          {
            toolId: TOOL_SEARCH,
            version: "1.0.0",
            revokedAt: new Date(now).toISOString(),
            reason: "security_vulnerability",
          },
        ],
        revokedCertificates: [],
        revokedKeys: [],
      },
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    await trustStore.recordRevocationMetadata(identity, revocationMetadata, {
      allowDevKeys: true,
    });

    const result = await trustStore.verifyToolTrust(identity, {
      toolId: TOOL_SEARCH,
      version: "1.0.0",
      manifestDigest,
      artifactDigest,
      capabilityEnvelopeDigest: ENVELOPE_DIGEST,
    });

    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/revoked/i);
  });

  it("cross-account isolation: rejects certificate from different accountId partition", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "test-auth");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: "ed25519",
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "development",
        createdAt: new Date().toISOString(),
      },
    ]);

    const trustStore = new RuntimeTrustStore({
      dataDir: path.join(tempDir, "trust-cross-acct"),
      keyStore,
    });

    const toolName = "partition_search";
    const manifestDigest = "1".repeat(64);
    const artifactDigest = "2".repeat(64);
    const now = Date.now();

    const cert = signActivationCertificate(
      {
        schemaKind: V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
        schemaVersion: V1_SCHEMA_VERSION,
        certificateId: CERT_ID,
        subject: {
          userId: USER_ID,
          accountId: ACCOUNT_A,
        },
        projectId: PROJECT_ID,
        toolId: TOOL_SEARCH,
        toolName,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
        qualificationEvidenceDigest: QUAL_DIGEST,
        counter: 1,
        nonce: "nonce-partition-01",
        issuedAt: new Date(now - 1000).toISOString(),
        notBefore: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        status: "active",
      },
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    await trustStore.recordActivationCertificate(
      { accountId: ACCOUNT_A, userId: USER_ID, projectId: PROJECT_ID },
      cert,
      { allowDevKeys: true },
    );

    const resultA = await trustStore.verifyToolTrust(
      { accountId: ACCOUNT_A, userId: USER_ID, projectId: PROJECT_ID },
      {
        toolId: TOOL_SEARCH,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
      },
    );
    expect(resultA.trusted).toBe(true);

    const resultB = await trustStore.verifyToolTrust(
      { accountId: ACCOUNT_B, userId: USER_ID, projectId: PROJECT_ID },
      {
        toolId: TOOL_SEARCH,
        version: "1.0.0",
        manifestDigest,
        artifactDigest,
        capabilityEnvelopeDigest: ENVELOPE_DIGEST,
      },
    );
    expect(resultB.trusted).toBe(false);
  });

  it("partial startup: corrupt/invalid tool fails closed without crashing remaining tools and meta-tools", async () => {
    const lockPath = path.join(tempDir, "resin.lock");
    const lockManager = new ProjectLockManager({ lockPath, projectId: PROJECT_ID });

    const goodArtifact = Buffer.from("console.log('good');");
    const goodDigest = crypto.createHash("sha256").update(goodArtifact).digest("hex");
    const goodManifest = makeCloudTool(GOOD_TOOL_ID, "good_tool");
    const badDigest = "bad".padEnd(64, "0");
    goodManifest.digest = computeManifestDigest(goodManifest);

    lockManager.reconcileQualified({
      toolId: GOOD_TOOL_ID,
      name: "good_tool",
      version: "1.0.0",
      manifestDigest: goodManifest.digest,
      artifactDigest: goodDigest,
      status: "active",
    });

    lockManager.reconcileQualified({
      toolId: BAD_TOOL_ID,
      name: "corrupt_tool",
      version: "1.0.0",
      manifestDigest: "2".repeat(64),
      artifactDigest: badDigest,
      status: "active",
    });

    const artifactCache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    await seedCachedArtifact(artifactCache, goodDigest, goodArtifact, goodManifest);

    const mockService = new MockCloudMcpService();
    mockService.simulateOffline(true);
    const cache = new CloudCatalogCache();
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      deviceId: "dev-1",
      baseUrl: "https://cloud.mock",
      fetchFn: mockService.createFetchHandler(),
    });
    const registry = new ToolRegistry();
    const router = new CloudInvocationRouter({ catalogCache: cache, mockService });
    const gatewayRouter = new RegistryGatewayRouter(registry);

    const syncCoordinator = new CloudCatalogSyncCoordinator({
      client,
      cache,
      router,
      registry,
      workspaceId: "ws-1",
      lockManager,
      artifactCache,
    });

    const summary = await syncCoordinator.reconcileLockedTools();

    expect(summary.activated).toContain("good_tool");
    expect(summary.degraded).toContain("corrupt_tool");

    expect(registry.getToolVersion(GOOD_TOOL_ID, "1.0.0")).toBeDefined();
    expect(registry.getToolVersion(BAD_TOOL_ID, "1.0.0")).toBeUndefined();

    const listRes = await gatewayRouter.callTool(mockWorkspaceContext, "search_tools", {});
    expect(listRes.content[0].type).toBe("text");
  });
});
