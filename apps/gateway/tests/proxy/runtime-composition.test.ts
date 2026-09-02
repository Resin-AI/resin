import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  DeploymentRecordSchema,
  type ToolManifest,
  ToolManifestSchema,
  type V1ProjectMetadata,
  type V1ToolLock,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  hashCanonicalContent,
} from "@resin/contracts";
import { CloudCredentialStore } from "@resin/observer";
import { PROTOCOL_VERSION, ProtocolError } from "@resin/protocol";
import { ArtifactCache, encodeDeterministicTar } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { createProductionProxyRuntime } from "../../src/proxy/runtime.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import type { RegistryTool } from "../../src/registry/types.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

function makeJwt(
  payload: Record<string, string | number | boolean | null | undefined | readonly string[]>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

function makeValidClaims(
  overrides: Record<string, string | number | boolean | null | undefined | readonly string[]> = {},
) {
  return {
    schemaVersion: 1,
    accountId: "acc_test_123",
    workspaceId: "ws_test_456",
    deviceId: "dev_test_789",
    installationId: "inst_test_001",
    userId: "usr_test_abc",
    issuedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    scopes: ["catalog:read", "deployments:read", "device:connect"],
    ...overrides,
  };
}

describe("Production Runtime Composition & Credential Security", () => {
  let tempDir: string;
  let resinHome: string;
  let tokenFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-runtime-test-"));
    resinHome = path.join(tempDir, ".resin");
    fs.mkdirSync(resinHome, { recursive: true });
    tokenFile = path.join(resinHome, "device-token.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("produces safe local-only runtime state without credentials, never throwing", async () => {
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    const registry = new ToolRegistry();

    const runtime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
    });

    expect(runtime.isCloudEnabled).toBe(false);
    expect(runtime.status).toBe("missing");
    expect(runtime.identity).toBeNull();
    expect(runtime.client).toBeUndefined();
    expect(runtime.coordinator).toBeUndefined();
    expect(runtime.router).toBeUndefined();

    // Verify start, stop, and sync are safe no-ops
    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(runtime.sync()).resolves.toBeNull();
  });

  it("constructs full runtime with stored-origin URL and tenant headers on valid credentials", async () => {
    const claims = makeValidClaims();
    const token = makeJwt(claims);

    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.custom-origin.io",
      accessToken: token,
      refreshToken: "rf_valid_123",
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      // SAFETY: Test fixture inspects record headers from RequestInit.
      const headers = (init?.headers as Record<string, string>) || {};
      requests.push({ url: urlStr, headers });

      return new Response(
        JSON.stringify({
          snapshotVersion: "v1.0.0",
          generatedAt: new Date().toISOString(),
          tools: [],
          activeDeployments: [],
          checksum: hashCanonicalContent({
            tools: [],
            activeDeployments: [],
          }),
        }),
        { status: 200, statusText: "OK" },
      );
    });

    const registry = new ToolRegistry();
    const runtime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });

    expect(runtime.isCloudEnabled).toBe(true);
    expect(runtime.status).toBe("valid");
    expect(runtime.identity).not.toBeNull();
    expect(runtime.identity?.cloudUrl).toBe("https://cloud.custom-origin.io");
    expect(runtime.client).toBeDefined();
    expect(runtime.router).toBeDefined();
    expect(runtime.coordinator).toBeDefined();

    // Trigger snapshot fetch through client
    await runtime.client!.fetchCatalogSnapshot();

    expect(requests.length).toBeGreaterThan(0);
    const firstReq = requests[0];
    expect(firstReq.url).toContain("https://cloud.custom-origin.io/v1/catalog/snapshot");
    expect(firstReq.headers.Authorization).toBe(`Bearer ${token}`);
    expect(firstReq.headers["x-account-id"]).toBe(claims.accountId);
    expect(firstReq.headers["x-workspace-id"]).toBe(claims.workspaceId);
    expect(firstReq.headers["x-device-id"]).toBe(claims.deviceId);
    expect(firstReq.headers["x-installation-id"]).toBe(claims.installationId);
    expect(firstReq.headers["x-user-id"]).toBe(claims.userId);
  });

  it("retries request once on 401 via forced refresh and succeeds with rotated token", async () => {
    const claims1 = makeValidClaims({ userId: "usr_1" });
    const token1 = makeJwt(claims1);

    const claims2 = makeValidClaims({ userId: "usr_1" });
    const token2 = makeJwt(claims2);

    let refreshCalled = false;
    const store = new CloudCredentialStore({
      tokenFilePath: tokenFile,
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        if (url.toString().includes("/v1/auth/token/refresh")) {
          refreshCalled = true;
          return new Response(
            JSON.stringify({
              accessToken: token2,
              refreshToken: "rf_refreshed_456",
              claims: claims2,
              deviceId: claims2.deviceId,
              workspaceId: claims2.workspaceId,
            }),
            { status: 200, statusText: "OK" },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token1,
      refreshToken: "rf_valid_123",
      deviceId: claims1.deviceId,
      workspaceId: claims1.workspaceId,
    });

    const tokenHeadersReceived: string[] = [];
    let attempt = 0;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      attempt++;
      const authHeader = init?.headers ? new Headers(init.headers).get("authorization") : null;
      if (authHeader) {
        tokenHeadersReceived.push(authHeader);
      }

      if (attempt === 1) {
        return new Response(JSON.stringify({ message: "JWT expired" }), {
          status: 401,
          statusText: "Unauthorized",
        });
      }

      return new Response(
        JSON.stringify({
          snapshotVersion: "v1.0.0",
          generatedAt: new Date().toISOString(),
          tools: [],
          activeDeployments: [],
          checksum: hashCanonicalContent({
            tools: [],
            activeDeployments: [],
          }),
        }),
        { status: 200, statusText: "OK" },
      );
    });

    const client = new CloudCatalogClient({
      workspaceId: claims1.workspaceId,
      deviceId: claims1.deviceId,
      identityProvider: async (opts) => store.getRequestIdentity(opts),
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });

    const snapshot = await client.fetchCatalogSnapshot();
    expect(snapshot).toBeDefined();
    expect(refreshCalled).toBe(true);
    expect(attempt).toBe(2);
    expect(tokenHeadersReceived[0]).toBe(`Bearer ${token1}`);
    expect(tokenHeadersReceived[1]).toBe(`Bearer ${token2}`);
    expect(client.isCloudPaused()).toBe(false);
  });

  it("pauses cloud calls when 401 refresh fails or credentials are revoked", async () => {
    const claims = makeValidClaims();
    const token = makeJwt(claims);

    const store = new CloudCredentialStore({
      tokenFilePath: tokenFile,
      fetchImpl: async () => {
        return new Response(JSON.stringify({ error: "Token revoked" }), {
          status: 401,
          statusText: "Unauthorized",
        });
      },
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      refreshToken: "rf_revoked",
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      });
    });

    const client = new CloudCatalogClient({
      workspaceId: claims.workspaceId,
      deviceId: claims.deviceId,
      identityProvider: async (opts) => store.getRequestIdentity(opts),
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });

    await expect(client.fetchCatalogSnapshot()).rejects.toThrow();
    expect(client.isCloudPaused()).toBe(true);

    // Subsequent calls fail immediately without hitting the network
    const callCountBefore = mockFetch.mock.calls.length;
    await expect(client.fetchCatalogSnapshot()).rejects.toThrow("Cloud catalog client is paused");
    expect(mockFetch.mock.calls.length).toBe(callCountBefore);
  });

  it("performs authenticated project roundtrip and retains stable project identity", async () => {
    const projectDir = path.join(tempDir, "workspace-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const claims = makeValidClaims();
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // 1. Resolve workspace context (creates .resin/project.json and .resin/resin.lock)
    const ws1 = resolveWorkspaceContext({ cwd: projectDir });
    expect(ws1.project).toBeDefined();
    expect(ws1.project?.projectId).toBeDefined();
    const originalProjectId = ws1.project!.projectId;

    // Verify tenant IDs/tokens are NOT written to project.json
    const projectJsonRaw = fs.readFileSync(ws1.projectJsonPath!, "utf-8");
    const projectJson = JSON.parse(projectJsonRaw);
    expect(projectJson.projectId).toBe(originalProjectId);
    expect(projectJson.workspaceId).toBeUndefined();
    expect(projectJson.accountId).toBeUndefined();
    expect(projectJson.accessToken).toBeUndefined();
    expect(projectJson.token).toBeUndefined();

    // 2. Re-resolve and verify stable project ID reuse
    const ws2 = resolveWorkspaceContext({ cwd: projectDir });
    expect(ws2.project!.projectId).toBe(originalProjectId);

    // 3. Register project via authenticated client
    let registeredWithHeaders: Record<string, string> | undefined;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // SAFETY: Test fixture inspects record headers from RequestInit.
      registeredWithHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(
        JSON.stringify({
          outcome: "registered",
          projectId: originalProjectId,
        }),
        { status: 200 },
      );
    });
    const client = new CloudCatalogClient({
      workspaceId: claims.workspaceId,
      deviceId: claims.deviceId,
      identityProvider: async (opts) => store.getRequestIdentity(opts),
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });

    const regResult = await client.registerProject({
      project: ws1.project!,
      visibility: "workspace",
    });

    expect(regResult.outcome).toBe("registered");
    expect(regResult.projectId).toBe(originalProjectId);
    expect(registeredWithHeaders?.Authorization).toBe(`Bearer ${token}`);
    expect(registeredWithHeaders?.["x-workspace-id"]).toBe(claims.workspaceId);
    expect(registeredWithHeaders?.["x-account-id"]).toBe(claims.accountId);
  });

  it("rejects foreign-project ID substitution and fork_required outcome", async () => {
    const claims = makeValidClaims();
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const projectDir = path.join(tempDir, "foreign-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const ws = resolveWorkspaceContext({ cwd: projectDir });
    const originalProjectId = ws.project!.projectId;

    // Scenario A: Fork required
    const mockForkFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          outcome: "fork_required",
          projectId: ws.project!.projectId,
        }),
        { status: 200 },
      );
    });

    const runtimeFork = await createProductionProxyRuntime({
      credentialStore: store,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockForkFetch as typeof fetch,
    });

    await runtimeFork.onWorkspaceReady(ws);
    expect(ws.project!.projectId).toBe(originalProjectId);
    expect(runtimeFork.isCloudEnabled).toBe(false);

    // Scenario B: Foreign project ID substitution
    const mockSubstitutionFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          outcome: "registered",
          projectId: "different-foreign-uuid-456",
        }),
        { status: 200 },
      );
    });

    const runtimeSub = await createProductionProxyRuntime({
      credentialStore: store,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockSubstitutionFetch as typeof fetch,
    });

    await runtimeSub.onWorkspaceReady(ws);
    expect(ws.project!.projectId).toBe(originalProjectId);
    expect(runtimeSub.isCloudEnabled).toBe(false);
  });

  it("preserves locked and local tools across restart and allows local execution during cloud outage/revocation", async () => {
    const projectDir = path.join(tempDir, "offline-restart-proj");
    fs.mkdirSync(projectDir, { recursive: true });

    // Create a local tool
    const localTool: RegistryTool = {
      toolId: "d0000000-0000-4000-8000-000000000001",
      name: "local_tool",
      version: "1.0.0",
      scope: "system",
      status: "active",
      isSystem: true,
      manifest: {
        name: "local_tool",
        description: "A local deterministic tool",
        parameters: { type: "object", properties: { input: { type: "string" } } },
      },
      handler: async (_ctx, params) => ({
        content: [{ type: "text", text: `local result: ${String(params.input)}` }],
      }),
    };

    const registry = new ToolRegistry();
    registry.registerToolSync(localTool);

    // Bootstrap workspace with a lockfile
    const ws = resolveWorkspaceContext({ cwd: projectDir });
    expect(ws.lockPath).toBeDefined();

    // Write a locked tool entry into resin.lock
    const lockManager = new ProjectLockManager({
      lockPath: ws.lockPath!,
      projectId: ws.project!.projectId,
    });
    lockManager.reconcileQualified({
      toolId: "c0000000-0000-4000-8000-000000000001",
      name: "locked_tool",
      version: "1.0.0",
      manifestDigest: "sha256:abcd000000000000000000000000000000000000000000000000000000000001",
      artifactDigest: "sha256:1234000000000000000000000000000000000000000000000000000000000001",
      status: "active",
    });
    const lock = lockManager.readLock();

    // Bind lock in registry
    registry.bindWorkspaceLock(ws.workspaceId, lock);

    // Persist valid credentials first, then purge/revoke to simulate revocation
    const claims = makeValidClaims();
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // Credential revocation / purge
    await store.purge();

    // Runtime restart / recomposition with purged credentials
    const cloudRuntime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
      lockManager,
    });

    expect(cloudRuntime.isCloudEnabled).toBe(false);

    // Build router & gateway
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({
      router,
      registry,
      cloudRuntime,
    });

    // Simulate client connection & initialization
    let clientMessage: unknown;
    const connection = gateway.createConnection({
      connectionId: "conn_test",
      cwd: projectDir,
      sendMessage: (msg) => {
        clientMessage = msg;
      },
    });

    // Call handleMessage to initialize properly
    await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(connection.isInitialized).toBe(true);

    // Drive JSON-RPC tools/call through LocalMcpGateway.handleMessage (do not call router directly)
    const callResponse = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "local_tool",
        arguments: {
          input: "hello",
        },
      },
    });

    expect(callResponse).toBeDefined();
    expect(callResponse?.error).toBeUndefined();
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const result = callResponse?.result as
      | { content?: Array<{ type: string; text: string }> }
      | undefined;
    expect(result?.content).toBeDefined();
    const firstBlock = result?.content?.[0];
    expect(firstBlock).toBeDefined();
    expect(firstBlock?.type).toBe("text");
    expect(firstBlock?.text).toBe("local result: hello");

    // Gateway close stops runtime safely
    gateway.close();
  });

  it("enforces tenant-isolated credentials across runtime catalog queries and maintains offline local execution upon cross-tenant rejection", async () => {
    const projectDir = path.join(tempDir, "tenant-isolated-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const claims = makeValidClaims({
      accountId: "acc_alpha_gateway",
      workspaceId: "ws_alpha_gateway",
      userId: "usr_alpha_gateway",
      deviceId: "dev_alpha_gateway",
      installationId: "inst_alpha_gateway",
      rawUploadConsent: false,
      scopes: ["catalog:read", "deployments:write"],
    });
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const recordedRequests: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      // SAFETY: Test fixture inspects record headers from RequestInit.
      const headers = (init?.headers as Record<string, string>) || {};
      recordedRequests.push({ url: urlStr, headers });

      if (urlStr.includes("/v1/projects")) {
        const body =
          Object.prototype.toString.call(init?.body) === "[object String]"
            ? JSON.parse(String(init?.body))
            : {};
        return new Response(
          JSON.stringify({
            outcome: "registered",
            projectId: body.project?.projectId ?? ws.project?.projectId ?? "prj_alpha_gateway_01",
          }),
          { status: 200, statusText: "OK" },
        );
      }

      if (urlStr.includes("/v1/catalog/snapshot")) {
        // Enforce that correct workspace header was supplied
        if (headers["x-workspace-id"] !== claims.workspaceId) {
          return new Response(
            JSON.stringify({ error: "FORBIDDEN", message: "Cross-tenant access denied" }),
            { status: 403, statusText: "Forbidden" },
          );
        }

        return new Response(
          JSON.stringify({
            snapshotVersion: "v1.0.0",
            generatedAt: new Date().toISOString(),
            tools: [],
            activeDeployments: [],
          }),
          { status: 200, statusText: "OK" },
        );
      }

      return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
        status: 404,
        statusText: "Not Found",
      });
    });

    const ws = resolveWorkspaceContext({ cwd: projectDir });
    const registry = new ToolRegistry();
    const runtime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });

    await runtime.onWorkspaceReady(ws);

    // Verify composed runtime/onWorkspaceReady path reached /v1/projects and authenticated /v1/catalog/snapshot separately
    expect(recordedRequests.length).toBeGreaterThanOrEqual(2);

    const projectReq = recordedRequests.find((r) => r.url.includes("/v1/projects"));
    expect(projectReq).toBeDefined();
    expect(projectReq!.headers.Authorization ?? projectReq!.headers.authorization).toBe(
      `Bearer ${token}`,
    );
    expect(projectReq!.headers["x-workspace-id"]).toBe(claims.workspaceId);
    expect(projectReq!.headers["x-account-id"]).toBe(claims.accountId);
    expect(projectReq!.headers["x-device-id"]).toBe(claims.deviceId);

    const snapshotReq = recordedRequests.find((r) => r.url.includes("/v1/catalog/snapshot"));
    expect(snapshotReq).toBeDefined();
    expect(snapshotReq).not.toBe(projectReq);
    expect(snapshotReq!.url).not.toBe(projectReq!.url);
    expect(snapshotReq!.headers.Authorization ?? snapshotReq!.headers.authorization).toBe(
      `Bearer ${token}`,
    );
    expect(snapshotReq!.headers["x-workspace-id"]).toBe(claims.workspaceId);
    expect(snapshotReq!.headers["x-account-id"]).toBe(claims.accountId);
    expect(snapshotReq!.headers["x-device-id"]).toBe(claims.deviceId);
    expect(snapshotReq!.headers["x-installation-id"]).toBe(claims.installationId);
    expect(snapshotReq!.headers["x-user-id"]).toBe(claims.userId);

    // Verify no tokens leaked to project metadata
    const projectJson = JSON.parse(fs.readFileSync(ws.projectJsonPath!, "utf-8"));
    expect(projectJson.token).toBeUndefined();
    expect(projectJson.accessToken).toBeUndefined();

    // Verify local tool continues to work through LocalMcpGateway
    const localTool: RegistryTool = {
      toolId: "d0000000-0000-4000-8000-000000000002",
      name: "local_evaluator",
      version: "1.0.0",
      scope: "system",
      status: "active",
      isSystem: true,
      manifest: {
        name: "local_evaluator",
        description: "Local evaluator tool",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
      handler: async (_ctx, params) => ({
        content: [{ type: "text", text: `evaluated: ${String(params.expr)}` }],
      }),
    };
    registry.registerToolSync(localTool);

    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({
      router,
      registry,
      cloudRuntime: runtime,
    });

    const connection = gateway.createConnection({
      connectionId: "conn_tenant_test",
      cwd: projectDir,
    });

    await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const callResponse = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "local_evaluator",
        arguments: { expr: "1 + 1" },
      },
    });

    expect(callResponse).toBeDefined();
    expect(callResponse?.error).toBeUndefined();
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const result = callResponse?.result as
      | { content?: Array<{ type: string; text: string }> }
      | undefined;
    expect(result?.content).toBeDefined();
    const textBlock = result?.content?.[0];
    expect(textBlock?.text).toBe("evaluated: 1 + 1");

    gateway.close();
  });

  it("activates a published cloud tool into the workspace lock and local artifact cache", async () => {
    const projectDir = path.join(tempDir, "published-activation-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const ws = resolveWorkspaceContext({ cwd: projectDir });
    expect(ws.lockPath).toBeDefined();

    const claims = makeValidClaims();
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://cloud.resin.io",
      accessToken: token,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const toolId = "7a1c4e2b-9d3f-4b6a-8c5e-1f2a3b4c5d6e";
    const bundleManifestBase = {
      id: toolId,
      name: "aggregate_status_records",
      version: "1.0.0",
      description: "Aggregates record statuses",
      parameters: {
        type: "object" as const,
        properties: { records: { type: "array" } },
        required: ["records"],
        additionalProperties: false,
      },
      runtime: {
        runtime: "deno" as const,
        memoryLimitMb: 128,
        timeoutMs: 5000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {},
      limits: {
        timeoutMs: 5000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 4,
      },
      scope: "workspace" as const,
      metadata: { origin: "evolution" },
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const bundleManifest = {
      ...bundleManifestBase,
      digest: computeManifestDigest(bundleManifestBase),
    };
    const { archive: plainTar } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(bundleManifest) },
      { path: "src/index.ts", content: "export default async () => ({ total: 0 });" },
    ]);
    const gzipped = zlib.gzipSync(plainTar);
    const artifactDigest = crypto.createHash("sha256").update(gzipped).digest("hex");

    // The catalog serves the schema-normalized manifest with serve-time metadata and a
    // recomputed digest, and signs the checksum over the normalized arrays.
    const { digest: _servedDigest, ...servedBase } = ToolManifestSchema.parse({
      ...bundleManifestBase,
      metadata: {
        ...bundleManifestBase.metadata,
        source: "registry",
        workspaceId: claims.workspaceId,
        accountId: claims.accountId,
        artifactDigest,
      },
      digest: "0".repeat(64),
    });
    const servedManifest: ToolManifest = {
      ...servedBase,
      digest: computeManifestDigest(servedBase),
    };
    const activeDeployments = [
      DeploymentRecordSchema.parse({
        deploymentId: `deploy-${claims.workspaceId}-${toolId}`,
        workspaceId: claims.workspaceId,
        toolId,
        toolVersion: "1.0.0",
        state: "promoted",
        activeTrafficPercentage: 100,
        history: [],
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    const snapshotBody = {
      snapshotVersion: "v1-abcdefabcdef",
      generatedAt: "2026-09-02T00:00:00.000Z",
      checksum: hashCanonicalContent({ tools: [servedManifest], activeDeployments }),
      tools: [servedManifest],
      activeDeployments,
    };

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        const body =
          Object.prototype.toString.call(init?.body) === "[object String]"
            ? JSON.parse(String(init?.body))
            : {};
        return new Response(
          JSON.stringify({ outcome: "registered", projectId: body.project?.projectId }),
          { status: 200, statusText: "OK" },
        );
      }
      if (urlStr.includes("/v1/catalog/snapshot")) {
        return new Response(JSON.stringify(snapshotBody), { status: 200, statusText: "OK" });
      }
      if (urlStr.includes(`/v1/artifacts/${artifactDigest}/download`)) {
        return new Response(gzipped, {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/gzip" },
        });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
        status: 404,
        statusText: "Not Found",
      });
    });

    const registry = new ToolRegistry();
    const artifactCache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifact-cache") });
    const runtime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
      artifactCache,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: mockFetch as typeof fetch,
    });
    expect(runtime.isCloudEnabled).toBe(true);

    await runtime.onWorkspaceReady(ws);
    await runtime.stop();

    const lock = new ProjectLockManager({ lockPath: ws.lockPath!, projectId: ws.projectId }).read();
    expect(lock.tools.aggregate_status_records).toMatchObject({
      toolId,
      version: "1.0.0",
      artifactDigest,
      manifestDigest: servedManifest.digest,
      status: "active",
    });
    expect(artifactCache.isArtifactCached(artifactDigest)).toBe(true);
    expect(
      fs.existsSync(path.join(artifactCache.getArtifactPath(artifactDigest), "src/index.ts")),
    ).toBe(true);

    const registered = registry
      .getAllRegisteredTools()
      .find((tool) => tool.toolId === toolId && tool.version === "1.0.0");
    expect(registered).toBeDefined();
    expect(registered?.workspaceId).toBe(ws.workspaceId);
    expect(registered?.artifactDigest).toBe(artifactDigest);
    expect(registered?.metadata?.source).toBe("cloud");
  });
});
