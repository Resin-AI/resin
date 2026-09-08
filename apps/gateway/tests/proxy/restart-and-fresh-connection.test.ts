import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ToolManifest,
  type V1LockedToolEntry,
  type V1ProjectMetadata,
  type V1ToolLock,
  V1_SCHEMA_KINDS,
  V1_SCHEMA_VERSION,
  hashCanonicalContent,
} from "@resin/contracts";
import { CloudCredentialStore } from "@resin/observer";
import { ArtifactCache } from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import type { CallToolResult, JsonRpcResponse, ListToolsResult } from "../../src/protocol/types.js";
import {
  type ProductionProxyRuntime,
  createProductionProxyRuntime,
} from "../../src/proxy/runtime.js";
import { ManagedToolAccess } from "../../src/proxy/tool-access.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";

const ACCOUNT_ID = "acc_restart_test_123";
const USER_ID = "usr_restart_test_456";
const PROJECT_ID_A = "11111111-aaaa-4111-8111-111111111111";
const PROJECT_ID_B = "22222222-bbbb-4222-8222-222222222222";
const TOOL_ID_A = "88888888-8888-4888-8888-888888888888";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

function extractToolNames(response: JsonRpcResponse | null): string[] {
  if (
    response &&
    "result" in response &&
    response.result &&
    typeof response.result === "object" &&
    "tools" in response.result &&
    Array.isArray((response.result as ListToolsResult).tools)
  ) {
    return (response.result as ListToolsResult).tools.map((t) => t.name);
  }
  return [];
}

function extractTextContent(response: JsonRpcResponse | null): string {
  if (
    response &&
    "result" in response &&
    response.result &&
    typeof response.result === "object" &&
    "content" in response.result
  ) {
    const callResult = response.result as CallToolResult;
    const item = callResult.content?.[0];
    if (item && "text" in item && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

function isErrorResponse(response: JsonRpcResponse | null): boolean {
  if (response && "result" in response && response.result && typeof response.result === "object") {
    const callResult = response.result as CallToolResult;
    return callResult.isError === true;
  }
  return true;
}

function makeManifest(id: string, name: string, version = "1.0.0"): ToolManifest {
  const base = {
    id,
    name,
    version,
    description: `Generated tool ${name}`,
    parameters: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object" as const,
      properties: { content: { type: "string" } },
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
        readPaths: ["."],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
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
      source: "cloud",
      accountId: ACCOUNT_ID,
    },
    createdAt: "2026-09-08T00:00:00.000Z",
  };
  const digest = computeManifestDigest(base);
  return { ...base, digest };
}

describe("Restart & Fresh Connection Regression Tests", () => {
  let rootDir: string;
  let homeDir: string;
  let resinHome: string;
  let tokenFile: string;
  let stateDir: string;
  let cacheDir: string;
  let projectDirA: string;
  let projectDirB: string;

  const claims = {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    workspaceId: "ws_restart_test_default",
    deviceId: "dev_restart_test_1",
    installationId: "inst_restart_test_1",
    userId: USER_ID,
    issuedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    scopes: ["catalog:read", "deployments:read", "device:connect"],
  };

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-restart-test-"));
    homeDir = path.join(rootDir, "home");
    resinHome = path.join(homeDir, ".resin");
    tokenFile = path.join(resinHome, "device-token.json");
    stateDir = path.join(resinHome, "state", "managed-tool-access");
    cacheDir = path.join(resinHome, "data", "artifacts");
    projectDirA = path.join(rootDir, "workspace-a");
    projectDirB = path.join(rootDir, "workspace-b");

    fs.mkdirSync(resinHome, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(projectDirA, { recursive: true });
    fs.mkdirSync(projectDirB, { recursive: true });

    // Persist valid credential store token
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    await store.persist({
      cloudUrl: "https://api.resin.sh",
      accessToken: makeJwt(claims),
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // Write positive account confirmation
    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.confirm({
      schemaVersion: "1.0.0",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      toolAccess: "allowed",
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function setupProject(
    projectDir: string,
    projectId: string,
    projectName: string,
    tools: Record<string, V1LockedToolEntry>,
  ): void {
    const resinDir = path.join(projectDir, ".resin");
    fs.mkdirSync(resinDir, { recursive: true });

    const projectMeta: V1ProjectMetadata = {
      schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
      schemaVersion: V1_SCHEMA_VERSION,
      projectId,
      name: projectName,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(resinDir, "project.json"), JSON.stringify(projectMeta, null, 2));

    const lock: V1ToolLock = {
      schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
      schemaVersion: V1_SCHEMA_VERSION,
      projectId,
      updatedAt: new Date().toISOString(),
      tools,
    };
    fs.writeFileSync(path.join(resinDir, "resin.lock"), JSON.stringify(lock, null, 2));
  }

  function deployArtifactBundle(tool: ToolManifest, artifactDigest: string): void {
    const bundleDir = path.join(cacheDir, artifactDigest);
    fs.mkdirSync(path.join(bundleDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(tool, null, 2));
    fs.writeFileSync(
      path.join(bundleDir, "src", "index.ts"),
      `export default async function run(params: Record<string, unknown>) { return { content: "read:" + String(params.path) }; }`,
    );
    fs.writeFileSync(
      path.join(bundleDir, ".extracted"),
      JSON.stringify({
        digest: artifactDigest,
        entrypoint: "src/index.ts",
        extractedAt: new Date().toISOString(),
        fileCount: 2,
        totalSizeBytes: 512,
        verified: true,
      }),
    );
  }

  async function createProductionGateway(fetchImpl: typeof fetch): Promise<{
    gateway: LocalMcpGateway;
    registry: ToolRegistry;
    runtime: ProductionProxyRuntime;
  }> {
    const registry = new ToolRegistry({ autoHydrate: false });
    const store = new CloudCredentialStore({ tokenFilePath: tokenFile });
    const artifactCache = new ArtifactCache({ cacheDir });

    const runtime = await createProductionProxyRuntime({
      credentialStore: store,
      registry,
      artifactCache,
      fetchFn: fetchImpl,
      home: homeDir,
      resinHome,
      allowDevKeys: true,
    });

    const router = createRegistryGatewayRouter(registry, runtime.router);
    const gateway = new LocalMcpGateway({
      router,
      registry,
      cloudRuntime: runtime,
    });

    return { gateway, registry, runtime };
  }

  it("exposes and resolves authorized cached generated tool across gateway restart via production runtime", async () => {
    const tool = makeManifest(TOOL_ID_A, "read_workspace_file");
    const artifactDigest = "b".repeat(64);
    const manifestDigest = tool.digest!;

    deployArtifactBundle(tool, artifactDigest);

    const lockedEntry: V1LockedToolEntry = {
      toolId: tool.id,
      name: tool.name,
      version: tool.version,
      manifestDigest,
      artifactDigest,
      status: "active",
    };

    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [tool.name]: lockedEntry,
    });

    // Record verified receipt in managed-tool-access
    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.record(
      lockedEntry,
      PROJECT_ID_A,
      new ProjectLockManager({
        lockPath: path.join(projectDirA, ".resin", "resin.lock"),
        projectId: PROJECT_ID_A,
      }),
    );

    const mockFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      if (urlStr.includes("/v1/account/tool-access")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            accountId: ACCOUNT_ID,
            userId: USER_ID,
            toolAccess: "allowed",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    // --- FIRST CONNECTION (Cold start with production runtime composition) ---
    const instance1 = await createProductionGateway(mockFetch);
    const conn1 = instance1.gateway.createConnection({ cwd: projectDirA });

    const initResp1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });
    expect(initResp1?.result).toBeDefined();

    // Verify tools/list contains generated tool
    const listResp1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const toolNames1 = extractToolNames(listResp1);
    expect(toolNames1).toContain("read_workspace_file");

    // Verify manage_tools returns active generated tool
    const manageResp1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "manage_tools",
        arguments: { action: "list_versions", scope: "workspace" },
      },
    });
    expect(isErrorResponse(manageResp1)).toBe(false);
    const manageText1 = extractTextContent(manageResp1);
    expect(manageText1).toContain("read_workspace_file");
    expect(manageText1).toContain("1.0.0");

    // Verify get_tool_schema resolves full schema
    const schemaResp1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_tool_schema",
        arguments: { toolId: TOOL_ID_A },
      },
    });
    expect(isErrorResponse(schemaResp1)).toBe(false);
    const schemaText1 = extractTextContent(schemaResp1);
    const schemaParsed1 = JSON.parse(schemaText1) as {
      toolId?: string;
      name?: string;
      isDisabled?: boolean;
    };
    expect(schemaParsed1.toolId).toBe(TOOL_ID_A);
    expect(schemaParsed1.name).toBe("read_workspace_file");
    expect(schemaParsed1.isDisabled).toBe(false);

    await instance1.runtime.stop();
    instance1.gateway.close();

    // --- RESTART / FRESH PROCESS (Simulates gateway restart / second connection) ---
    const instance2 = await createProductionGateway(mockFetch);
    const conn2 = instance2.gateway.createConnection({ cwd: projectDirA });

    const initResp2 = await instance2.gateway.handleMessage(conn2.connectionId, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });
    expect(initResp2?.result).toBeDefined();

    // Immediately available across restart from local cache
    const listResp2 = await instance2.gateway.handleMessage(conn2.connectionId, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    });
    const toolNames2 = extractToolNames(listResp2);
    expect(toolNames2).toContain("read_workspace_file");

    const schemaResp2 = await instance2.gateway.handleMessage(conn2.connectionId, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "get_tool_schema",
        arguments: { name: "read_workspace_file" },
      },
    });
    expect(isErrorResponse(schemaResp2)).toBe(false);
    const schemaParsed2 = JSON.parse(extractTextContent(schemaResp2)) as {
      toolId?: string;
      name?: string;
    };
    expect(schemaParsed2.toolId).toBe(TOOL_ID_A);
    expect(schemaParsed2.name).toBe("read_workspace_file");

    await instance2.runtime.stop();
    instance2.gateway.close();
  });

  it("gated fetch proves one runtime blocked on network does not block second runtime initialize and tool listing", async () => {
    const tool = makeManifest(TOOL_ID_A, "concurrent_tool");
    const artifactDigest = "e".repeat(64);
    deployArtifactBundle(tool, artifactDigest);

    const lockedEntry: V1LockedToolEntry = {
      toolId: tool.id,
      name: tool.name,
      version: tool.version,
      manifestDigest: tool.digest!,
      artifactDigest,
      status: "active",
    };

    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [tool.name]: lockedEntry,
    });

    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.record(
      lockedEntry,
      PROJECT_ID_A,
      new ProjectLockManager({
        lockPath: path.join(projectDirA, ".resin", "resin.lock"),
        projectId: PROJECT_ID_A,
      }),
    );

    // Gate fetch calls for Instance 1 to simulate an in-flight network call
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const slowFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects") || urlStr.includes("/v1/account/tool-access")) {
        await gatePromise;
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    const fastFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      if (urlStr.includes("/v1/account/tool-access")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            accountId: ACCOUNT_ID,
            userId: USER_ID,
            toolAccess: "allowed",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    // Instance 1 starts and initiates workspace ready, which returns promptly while network runs in background
    const instance1 = await createProductionGateway(slowFetch);
    const conn1 = instance1.gateway.createConnection({ cwd: projectDirA });

    const init1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-slow", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });
    expect(init1?.result).toBeDefined();

    const list1 = await instance1.gateway.handleMessage(conn1.connectionId, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
      params: {},
    });
    const tools1 = extractToolNames(list1);
    expect(tools1).toContain("concurrent_tool");

    // WHILE Instance 1's background network task is blocked on the network gate,
    // Instance 2 initializes and lists tools immediately without blocking!
    const instance2 = await createProductionGateway(fastFetch);
    const conn2 = instance2.gateway.createConnection({ cwd: projectDirA });

    const init2 = await instance2.gateway.handleMessage(conn2.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-fast", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });
    expect(init2?.result).toBeDefined();

    const list2 = await instance2.gateway.handleMessage(conn2.connectionId, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/list",
      params: {},
    });
    const tools2 = extractToolNames(list2);
    expect(tools2).toContain("concurrent_tool");

    // Release gate for Instance 1 background task to complete cleanly
    releaseGate();

    // Await and stop all runtime tasks during cleanup
    await instance1.runtime.stop();
    await instance2.runtime.stop();
    instance1.gateway.close();
    instance2.gateway.close();
  });

  it("preserves fail-closed behavior when account access is revoked", async () => {
    const tool = makeManifest(TOOL_ID_A, "read_workspace_file");
    const artifactDigest = "c".repeat(64);
    deployArtifactBundle(tool, artifactDigest);

    const lockedEntry: V1LockedToolEntry = {
      toolId: tool.id,
      name: tool.name,
      version: tool.version,
      manifestDigest: tool.digest!,
      artifactDigest,
      status: "active",
    };

    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [tool.name]: lockedEntry,
    });

    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.record(
      lockedEntry,
      PROJECT_ID_A,
      new ProjectLockManager({
        lockPath: path.join(projectDirA, ".resin", "resin.lock"),
        projectId: PROJECT_ID_A,
      }),
    );

    // Simulate account revocation
    access.confirm({
      schemaVersion: "1.0.0",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      toolAccess: "subscription_inactive",
    });

    expect(access.isInactive()).toBe(true);
    expect(access.isBlocked(lockedEntry)).toBe(true);

    const mockFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      if (urlStr.includes("/v1/account/tool-access")) {
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            accountId: ACCOUNT_ID,
            userId: USER_ID,
            toolAccess: "subscription_inactive",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    const instance = await createProductionGateway(mockFetch);
    const conn = instance.gateway.createConnection({ cwd: projectDirA });

    await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });

    const listResp = await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    // Revoked tool MUST NOT be exposed
    const toolNames = extractToolNames(listResp);
    expect(toolNames).not.toContain("read_workspace_file");

    await instance.runtime.stop();
    instance.gateway.close();
  });

  it("never activates missing or unverified artifacts", async () => {
    const tool = makeManifest(TOOL_ID_A, "missing_artifact_tool");
    const nonExistentDigest = "9".repeat(64);

    const lockedEntry: V1LockedToolEntry = {
      toolId: tool.id,
      name: tool.name,
      version: tool.version,
      manifestDigest: tool.digest!,
      artifactDigest: nonExistentDigest,
      status: "active",
    };

    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [tool.name]: lockedEntry,
    });

    const mockFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    const instance = await createProductionGateway(mockFetch);
    const conn = instance.gateway.createConnection({ cwd: projectDirA });

    await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });

    const listResp = await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolNames = extractToolNames(listResp);
    expect(toolNames).not.toContain("missing_artifact_tool");

    await instance.runtime.stop();
    instance.gateway.close();
  });

  it("preserves strict cross-workspace isolation without exposing foreign tools", async () => {
    const toolA = makeManifest(TOOL_ID_A, "workspace_a_exclusive_tool");
    const artifactDigest = "d".repeat(64);
    deployArtifactBundle(toolA, artifactDigest);

    const lockedEntryA: V1LockedToolEntry = {
      toolId: toolA.id,
      name: toolA.name,
      version: toolA.version,
      manifestDigest: toolA.digest!,
      artifactDigest,
      status: "active",
    };

    // Project A has toolA locked and authorized
    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [toolA.name]: lockedEntryA,
    });

    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.record(
      lockedEntryA,
      PROJECT_ID_A,
      new ProjectLockManager({
        lockPath: path.join(projectDirA, ".resin", "resin.lock"),
        projectId: PROJECT_ID_A,
      }),
    );

    // Project B has empty tool lock
    setupProject(projectDirB, PROJECT_ID_B, "workspace-b", {});

    const mockFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_B }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    // Connect to Project B
    const instanceB = await createProductionGateway(mockFetch);
    const connB = instanceB.gateway.createConnection({ cwd: projectDirB });

    await instanceB.gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirB).href,
      },
    });

    const listRespB = await instanceB.gateway.handleMessage(connB.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolNamesB = extractToolNames(listRespB);
    // Tool A MUST NOT be visible in Workspace B
    expect(toolNamesB).not.toContain("workspace_a_exclusive_tool");

    await instanceB.runtime.stop();
    instanceB.gateway.close();
  });

  it("rejects stale allowed response after intervening revocation and prevents new tool activation", async () => {
    const toolA = makeManifest(TOOL_ID_A, "preexisting_tool");
    const artifactDigestA = "a".repeat(64);
    deployArtifactBundle(toolA, artifactDigestA);

    const lockedEntryA: V1LockedToolEntry = {
      toolId: toolA.id,
      name: toolA.name,
      version: toolA.version,
      manifestDigest: toolA.digest!,
      artifactDigest: artifactDigestA,
      status: "active",
    };

    setupProject(projectDirA, PROJECT_ID_A, "workspace-a", {
      [toolA.name]: lockedEntryA,
    });

    const artifactCache = new ArtifactCache({ cacheDir });
    const access = new ManagedToolAccess(stateDir, artifactCache, {
      cloudUrl: "https://api.resin.sh",
      accountId: ACCOUNT_ID,
      userId: USER_ID,
    });
    access.record(
      lockedEntryA,
      PROJECT_ID_A,
      new ProjectLockManager({
        lockPath: path.join(projectDirA, ".resin", "resin.lock"),
        projectId: PROJECT_ID_A,
      }),
    );

    // Mock fetch that simulates an intervening revocation during the in-flight fetch window
    let fetchCount = 0;
    let catalogFetchCount = 0;
    const mockFetch: typeof fetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/projects")) {
        return new Response(JSON.stringify({ outcome: "registered", projectId: PROJECT_ID_A }), {
          status: 200,
        });
      }
      if (urlStr.includes("/v1/account/tool-access")) {
        fetchCount++;
        // 1. Intervening revocation bumps epoch and records revocationId
        const competingProcessAccess = new ManagedToolAccess(stateDir, artifactCache, {
          cloudUrl: "https://api.resin.sh",
          accountId: ACCOUNT_ID,
          userId: USER_ID,
        });
        competingProcessAccess.confirm({
          schemaVersion: "1.0.0",
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          toolAccess: "subscription_inactive",
        });
        // 2. Subsequent renewal sets toolAccess back to allowed on disk (isInactive is false),
        // but under a newer epoch, so the old in-flight response is stale!
        competingProcessAccess.confirm({
          schemaVersion: "1.0.0",
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          toolAccess: "allowed",
        });

        // Server returns a stale 'allowed' response captured from the earlier epoch
        return new Response(
          JSON.stringify({
            schemaVersion: "1.0.0",
            accountId: ACCOUNT_ID,
            userId: USER_ID,
            toolAccess: "allowed",
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/v1/catalog/snapshot")) {
        catalogFetchCount++;
        // Cloud catalog proposes a new tool with a strictly valid computed checksum
        const newTool = makeManifest(
          "99999999-9999-4999-9999-999999999999",
          "unauthorized_new_tool",
        );
        const checksum = hashCanonicalContent({ tools: [newTool], activeDeployments: [] });
        return new Response(
          JSON.stringify({
            snapshotVersion: "v2-stale",
            generatedAt: new Date().toISOString(),
            checksum,
            tools: [newTool],
            activeDeployments: [],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    };

    const instance = await createProductionGateway(mockFetch);
    const conn = instance.gateway.createConnection({ cwd: projectDirA });

    await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-omp", version: "1.0.0" },
        rootUri: pathToFileURL(projectDirA).href,
      },
    });

    // Complete the background cloud sync lifecycle
    await instance.runtime.sync();

    const listResp = await instance.gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const toolNames = extractToolNames(listResp);
    // 1. Project registration succeeded so cloud remains enabled
    expect(instance.runtime.isCloudEnabled).toBe(true);
    // 2. Account access was probed over the network
    expect(fetchCount).toBeGreaterThanOrEqual(1);
    // 3. Rejected stale allowance strictly prevented entering catalog sync (counter remains 0)
    expect(catalogFetchCount).toBe(0);
    // 4. Account is currently 'allowed' on disk (proves isInactive gate did not cause this)
    expect(access.isInactive()).toBe(false);
    // 5. The unauthorized new tool proposed by the catalog MUST NOT be activated
    expect(toolNames).not.toContain("unauthorized_new_tool");

    await instance.runtime.stop();
    instance.gateway.close();
  });
});
