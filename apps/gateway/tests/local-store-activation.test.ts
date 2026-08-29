import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import stream from "node:stream";
import { pathToFileURL } from "node:url";
import { type ToolManifest, type ToolVersion, nowIso } from "@resin/contracts";
import { LocalDatabaseConnection, MigrationRunner, ToolRepository } from "@resin/db";
import { ArtifactCache } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type {
  CallToolResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { createRegistryGatewayRouter } from "../src/router.js";
import { McpStdioShim } from "../src/shim/stdio-bridge.js";
import { withResolvers } from "../src/utils/deferred.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

async function setupTestDb(): Promise<{
  conn: LocalDatabaseConnection;
  toolRepo: ToolRepository;
}> {
  const conn = new LocalDatabaseConnection({ inMemory: true });
  const migrationRunner = new MigrationRunner(conn);
  await migrationRunner.migrate();
  const toolRepo = new ToolRepository(conn);
  return { conn, toolRepo };
}
interface EvolvedToolFixture {
  manifest: ToolManifest;
  toolVersion: ToolVersion;
}

function makeEvolvedTool(name: string, version = "1.0.0"): EvolvedToolFixture {
  const digest = crypto.createHash("sha256").update(`${name}@${version}`).digest("hex");
  const cache = new ArtifactCache();
  cache.ensureDirectoriesSync();
  const artifactPath = cache.getArtifactPath(digest);
  fs.writeFileSync(
    artifactPath,
    `export default function(ctx) {
      return { status: "executed", tool: "${name}", params: ctx?.input, input: ctx?.input };
    }`,
    "utf8",
  );
  const manifest: ToolManifest = {
    id: `tool_${name}`,
    name,
    version,
    description: `Autonomous evolved tool for ${name}`,
    scope: "workspace",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    runtime: {
      runtime: "node",
      timeoutMs: 15000,
      memoryLimitMb: 256,
      cpuLimitPercent: 80,
      maxOutputSizeBytes: 2097152,
    },
    capabilities: {
      command: { allowedCommands: ["git"] },
      fs: { readOnly: true, allowWorkspaceRoot: true },
    },
    limits: {
      timeoutMs: 15000,
      maxMemoryBytes: 268435456,
      maxOutputBytes: 2097152,
      maxConcurrentInvocations: 4,
    },
    digest,
    createdAt: nowIso(),
    metadata: {},
  };

  const toolVersion: ToolVersion = {
    toolId: `tool_${name}`,
    version,
    manifestDigest: digest,
    artifactDigest: digest,
    manifest,
    artifact: {
      artifactDigest: digest,
      bundleReference: {
        uri: `memory://${name}/${version}`,
        hash: digest,
        sizeBytes: 1024,
        format: "js_bundle",
      },
      entrypoint: "index.js",
    },
    provenance: {
      synthesizedAt: nowIso(),
      synthesizerModel: "test-synthesizer",
      deterministicBuildHash: digest,
      environment: {},
    },
    status: "active",
    createdAt: nowIso(),
    createdBy: "system",
  };

  return { manifest, toolVersion };
}

describe("GitHub Issue #110: Published Tool Versions in Local Gateway Catalog", () => {
  it("loads published tool versions from local store at startup into RegistryGatewayRouter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-local-store-1-"));
    try {
      const { conn, toolRepo } = await setupTestDb();

      // 1. Publish/activate an evolved tool into local store
      const { manifest, toolVersion } = makeEvolvedTool("fast_git_status");
      await toolRepo.saveManifest(manifest);
      await toolRepo.saveToolVersion(toolVersion);

      // 2. Start Gateway backed by the local store
      const registry = new ToolRegistry({ db: conn });
      const router = createRegistryGatewayRouter(registry);
      const gateway = new LocalMcpGateway({ router });
      const connInstance = gateway.createConnection({ cwd: tmpDir });

      await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client", version: "1.0.0" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      // SAFETY: Gateway response is confirmed to be ListToolsResult.
      const listRes = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as JsonRpcSuccessResponse<ListToolsResult>;

      expect(listRes.error).toBeUndefined();
      const toolNames = listRes.result.tools.map((t) => t.name);
      expect(toolNames).toContain("fast_git_status");

      const fastGit = listRes.result.tools.find((t) => t.name === "fast_git_status");
      expect(fastGit).toBeDefined();
      expect(fastGit?.description).toContain("Autonomous evolved tool for fast_git_status");
      expect(fastGit?.inputSchema.type).toBe("object");
      expect(fastGit?.inputSchema.properties).toHaveProperty("query");

      // SAFETY: Gateway response is confirmed to be CallToolResult.
      const callRes = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "fast_git_status",
          arguments: { query: "status --short" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;
      expect(callRes.error).toBeUndefined();
      expect(callRes.result.content).toHaveLength(1);
      expect(callRes.result.content[0].type).toBe("text");
      const parsedOutput = JSON.parse(callRes.result.content[0].text);
      expect(parsedOutput.status).toBe("executed");
      expect(parsedOutput.tool).toBe("fast_git_status");
      expect(parsedOutput.params).toEqual({ query: "status --short" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refreshes gateway catalog and emits tools/list_changed when new tools are published to store", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-local-store-2-"));
    try {
      const { conn, toolRepo } = await setupTestDb();

      // Initial tool
      const initial = makeEvolvedTool("initial_tool");
      await toolRepo.saveManifest(initial.manifest);
      await toolRepo.saveToolVersion(initial.toolVersion);

      const registry = new ToolRegistry({ db: conn, debounceMs: 0 });
      const router = createRegistryGatewayRouter(registry);
      const gateway = new LocalMcpGateway({ router });
      const notifications: JsonRpcNotification[] = [];
      const connInstance = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (msg) => {
          if (!("id" in msg) || msg.id === undefined) {
            // SAFETY: Notification message has no id.
            notifications.push(msg as JsonRpcNotification);
          }
        },
      });

      await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client", version: "1.0.0" },
          capabilities: { tools: { listChanged: true } },
        },
      });

      // SAFETY: Gateway response is confirmed to be ListToolsResult.
      const initialList = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as JsonRpcSuccessResponse<ListToolsResult>;
      expect(initialList.result.tools.map((t) => t.name)).toContain("initial_tool");

      // Publish second tool to store
      const second = makeEvolvedTool("csv_processor");
      await toolRepo.saveManifest(second.manifest);
      await toolRepo.saveToolVersion(second.toolVersion);

      // Trigger refresh on router
      const loaded = await router.refresh();
      expect(loaded).toBeGreaterThanOrEqual(2);

      // tools/list now includes both tools
      // SAFETY: Gateway response is confirmed to be ListToolsResult.
      const listRes2 = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      })) as JsonRpcSuccessResponse<ListToolsResult>;
      const toolNames = listRes2.result.tools.map((t) => t.name);
      expect(toolNames).toContain("initial_tool");
      expect(toolNames).toContain("csv_processor");

      // Calling the newly refreshed tool succeeds
      // SAFETY: Gateway response is confirmed to be CallToolResult.
      const callRes = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "csv_processor",
          arguments: { query: "parse.csv", limit: 50 },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;
      expect(callRes.error).toBeUndefined();
      const output = JSON.parse(callRes.result.content[0].text);
      expect(output.status).toBe("executed");
      expect(output.tool).toBe("csv_processor");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads evolved tools from store in FakeGatewayRouter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-local-store-3-"));
    try {
      const { conn, toolRepo } = await setupTestDb();

      const { manifest, toolVersion } = makeEvolvedTool("regex_matcher");
      await toolRepo.saveManifest(manifest);
      await toolRepo.saveToolVersion(toolVersion);

      const router = new FakeGatewayRouter({ db: conn });
      await router.loadFromStore();

      const gateway = new LocalMcpGateway({ router });
      const connInstance = gateway.createConnection({ cwd: tmpDir });

      await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client", version: "1.0.0" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });
      // SAFETY: Gateway response is confirmed to be ListToolsResult.
      const listRes = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as JsonRpcSuccessResponse<ListToolsResult>;

      const toolNames = listRes.result.tools.map((t) => t.name);
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("workspace_info");
      expect(toolNames).toContain("regex_matcher");
      // SAFETY: Gateway response is confirmed to be CallToolResult.
      const callRes = (await gateway.handleMessage(connInstance.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "regex_matcher",
          arguments: { query: "\\d+" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;
      expect(callRes.error).toBeUndefined();
      const output = JSON.parse(callRes.result.content[0].text);
      expect(output.status).toBe("executed");
      expect(output.tool).toBe("regex_matcher");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("serves published tools in standalone McpStdioShim when backed by local store", async () => {
    const { conn, toolRepo } = await setupTestDb();

    const { manifest, toolVersion } = makeEvolvedTool("standalone_evolved_tool");
    await toolRepo.saveManifest(manifest);
    await toolRepo.saveToolVersion(toolVersion);

    const stdin = new stream.PassThrough();
    const stdout = new stream.PassThrough();
    const stderr = new stream.PassThrough();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-local-store-shim-"));
    const shim = new McpStdioShim({
      standaloneFallback: true,
      db: conn,
      maxStartupAttempts: 0,
      cwd: tmpDir,
      stdin,
      stdout,
      stderr,
    });

    try {
      const status = await shim.start();
      expect(status.mode).toBe("standalone_inprocess");

      let receivedData = "";
      const { promise: listReceived, resolve: resolveList } = withResolvers<void>();
      stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        receivedData += text;
        if (receivedData.includes("standalone_evolved_tool")) {
          resolveList();
        }
      });

      // Send initialize with explicit isolated rootUri
      const initReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "init_1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "1.0.0" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      };
      stdin.write(`${JSON.stringify(initReq)}\n`);

      // Send tools/list
      const listReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "list_1",
        method: "tools/list",
        params: {},
      };
      stdin.write(`${JSON.stringify(listReq)}\n`);

      await listReceived;

      expect(receivedData).toContain("standalone_evolved_tool");
      expect(receivedData).toContain("invoke_tool");
    } finally {
      await shim.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
