import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { ToolManifestSchema } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalMcpGateway } from "../../src/gateway.js";
import { McpFrameDecoder, encodeMcpMessage } from "../../src/protocol/framing.js";
import type { JsonRpcParams, JsonRpcResponse } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import type { RegistryTool, ToolRepoLike } from "../../src/registry/types.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";
import { createToolSearchSurface } from "../../src/shim/tool-search-surface.js";
import type { DeferredPromise } from "../../src/utils/deferred.js";

const TextResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
});

function registeredTool(version = "1.0.0", outputProperty = "answer"): RegistryTool {
  const manifest = ToolManifestSchema.parse({
    id: "tool_live_catalog_uppercase",
    name: "live_catalog_uppercase",
    version,
    description: "Uppercases a supplied query.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { [outputProperty]: { type: "string" } } },
    runtime: { runtime: "builtin" },
    capabilities: {},
    scope: "workspace",
    digest: "0".repeat(64),
    createdAt: "2026-09-07T00:00:00.000Z",
  });
  manifest.digest = computeManifestDigest(manifest);
  return {
    toolId: manifest.id,
    name: manifest.name,
    version,
    manifest,
    description: manifest.description,
    scope: "workspace",
    status: "active",
    handler: async (_context, params) => {
      if (typeof params.query !== "string") throw new Error("query must be a string");
      const answer = params.query.toUpperCase();
      return {
        content: [{ type: "text", text: answer }],
        structuredContent: { answer },
      };
    },
  };
}

describe("production gateway catalog response notices", () => {
  it("notifies a stable Codex facade once, invokes new tools without a native refetch, and hides disabled metadata", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resin-response-notices-"));
    const registry = new ToolRegistry();
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router, registry, enableRefreshCoordinator: false });
    const output = new PassThrough();
    const surface = createToolSearchSurface(output);
    const decoder = new McpFrameDecoder();
    const responses = new Map<number, DeferredPromise<JsonRpcResponse>>();
    output.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if ("id" in message && typeof message.id === "number" && !("method" in message)) {
          responses.get(message.id)?.resolve(message);
          responses.delete(message.id);
        }
      }
    });
    surface.output.pipe(output);
    const connection = await gateway.processStream(surface.input, surface.output, {
      cwd: directory,
    });
    let nextId = 0;
    const request = async (method: string, params?: JsonRpcParams): Promise<JsonRpcResponse> => {
      const id = ++nextId;
      const pending = Promise.withResolvers<JsonRpcResponse>();
      responses.set(id, pending);
      surface.input.write(encodeMcpMessage({ jsonrpc: "2.0", id, method, params }));
      return pending.promise;
    };
    const call = async (name: string, args: JsonRpcParams) => {
      const response = await request("tools/call", { name, arguments: args });
      expect(response.error).toBeUndefined();
      return TextResultSchema.parse(response.result);
    };
    try {
      const initialized = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.153.4" },
        rootUri: pathToFileURL(directory).href,
      });
      expect(initialized.error).toBeUndefined();
      surface.input.write(
        encodeMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
      );
      const listed = await request("tools/list");
      const names = z
        .object({ tools: z.array(z.object({ name: z.string() })) })
        .parse(listed.result)
        .tools.map((entry) => entry.name)
        .sort();
      expect(names).toEqual(["get_tool_schema", "invoke_tool", "manage_tools", "search_tools"]);

      const added = registeredTool();
      await registry.registerTool(added);
      await registry.activateToolVersion(
        added.toolId,
        added.version,
        connection.workspaceContext.workspaceId,
      );
      // No clock advancement: the debounced notification has not fired. The next
      // successful response must still see the live catalog through the public router.
      const announced = await call("get_tool_schema", { name: "invoke_tool" });
      expect(announced.content).toHaveLength(2);
      expect(announced.content[1]?.text).toContain('New: "live_catalog_uppercase"');
      expect(announced.content[1]?.text).toContain("get_tool_schema(name=...)");
      expect(announced.content[1]?.text).toContain("invoke_tool(name=..., parameters=...)");
      expect((await call("get_tool_schema", { name: "invoke_tool" })).content).toHaveLength(1);

      // Only stable meta-tools are used after the initial native list. The actual
      // registry handler executes, rather than a fake router or patched gateway.
      const schema = await call("get_tool_schema", { name: added.name });
      expect(schema.isError).not.toBe(true);
      expect(schema.content[0]?.text).toContain('"outputSchema"');
      const invoked = await call("invoke_tool", {
        name: added.name,
        parameters: { query: "live" },
      });
      expect(invoked).toEqual({
        content: [{ type: "text", text: "LIVE" }],
        structuredContent: { answer: "LIVE" },
      });

      const updated = registeredTool("1.0.1", "never_include_raw_output_schema");
      await registry.registerTool(updated);
      await registry.activateToolVersion(
        updated.toolId,
        updated.version,
        connection.workspaceContext.workspaceId,
      );
      const schemaUpdate = await call("get_tool_schema", { name: "invoke_tool" });
      expect(schemaUpdate.content[1]?.text).toContain('Updated: "live_catalog_uppercase"');
      expect(schemaUpdate.content[1]?.text).not.toContain("never_include_raw_output_schema");

      await registry.controls.disableTool(connection.workspaceContext.workspaceId, added.toolId);
      const removed = await call("get_tool_schema", { name: "invoke_tool" });
      expect(removed.content[1]?.text).toContain("no longer available");
      expect(removed.content[1]?.text).not.toContain(added.name);
      expect(removed.content[1]?.text).not.toContain(added.toolId);
      expect((await call("get_tool_schema", { name: "invoke_tool" })).content).toHaveLength(1);
      const disabled = await call("invoke_tool", {
        name: added.name,
        parameters: { query: "denied" },
      });
      expect(disabled.isError).toBe(true);
    } finally {
      connection.close();
      gateway.close();
      router.destroy();
      registry.destroy();
      surface.input.destroy();
      surface.output.destroy();
      output.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
  it("keeps output schemas internal and rejects a snapshot disabled during persistence", async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resin-notice-read-race-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blockSave = false;
    let invalidateAfterExecution = false;
    const repository: ToolRepoLike = {
      saveManifest: async () => {},
      listToolVersions: async () => [],
      saveCatalogSnapshot: async () => {
        if (!blockSave) return;
        blockSave = false;
        entered.resolve();
        await release.promise;
      },
    };
    const registry = new ToolRegistry({ db: repository, autoHydrate: false });
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router, registry, enableRefreshCoordinator: false });
    const connection = gateway.createConnection({ cwd: directory });
    let requestId = 0;
    const request = (method: string, params?: JsonRpcParams) =>
      gateway.handleMessage(connection, { jsonrpc: "2.0", id: ++requestId, method, params });
    const callExisting = () =>
      request("tools/call", {
        name: "live_catalog_uppercase",
        arguments: { query: "original result" },
      });
    const existing = registeredTool();
    existing.handler = async (context) => {
      if (invalidateAfterExecution) {
        invalidateAfterExecution = false;
        await registry.controls.enableTool(context.workspaceId, existing.toolId);
        blockSave = true;
      }
      // Existing production text-only handlers must not acquire a native MCP
      // structured-output promise merely because their manifest has a schema.
      return { content: [{ type: "text", text: "original result" }] };
    };
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "generic-mcp-client", version: "1.0.0" },
        rootUri: pathToFileURL(directory).href,
      });
      await registry.registerTool(existing);
      await registry.activateToolVersion(
        existing.toolId,
        existing.version,
        connection.workspaceContext.workspaceId,
      );
      const listed = await request("tools/list");
      const native = z.object({ tools: z.array(z.record(z.unknown())) }).parse(listed?.result);
      const entry = native.tools.find((candidate) => candidate.name === existing.name);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("outputSchema");
      expect(entry).not.toHaveProperty("catalogOutputSchema");
      const directCatalog = await router.listTools(connection.workspaceContext);
      expect(
        directCatalog.find((candidate) => candidate.name === existing.name),
      ).not.toHaveProperty("outputSchema");
      expect(TextResultSchema.parse((await callExisting())?.result).content).toEqual([
        { type: "text", text: "original result" },
      ]);

      const added = registeredTool();
      added.toolId = "tool_disabled_during_notice_read";
      added.name = "disabled_during_notice_read";
      added.description = "Never disclose the disabled description";
      added.manifest = {
        ...added.manifest,
        id: added.toolId,
        name: added.name,
        description: added.description,
      };
      added.manifest.digest = computeManifestDigest(added.manifest);
      await registry.registerTool(added);
      await registry.activateToolVersion(
        added.toolId,
        added.version,
        connection.workspaceContext.workspaceId,
      );
      // Execution invalidates the cache, so the supplementary read must rebuild
      // and pause at the real repository saveCatalogSnapshot await.
      invalidateAfterExecution = true;
      const pendingResponse = callExisting();
      await entered.promise;
      await registry.controls.disableTool(connection.workspaceContext.workspaceId, added.toolId);
      release.resolve();
      const response = TextResultSchema.parse((await pendingResponse)?.result);
      expect(response.content).toEqual([{ type: "text", text: "original result" }]);
      expect(JSON.stringify(response)).not.toContain(added.name);
      expect(JSON.stringify(response)).not.toContain(added.description);

      await registry.controls.enableTool(connection.workspaceContext.workspaceId, added.toolId);
      const enabled = TextResultSchema.parse((await callExisting())?.result);
      expect(enabled.content[1]?.text).toContain(`New: "${added.name}"`);
      expect(TextResultSchema.parse((await callExisting())?.result).content).toHaveLength(1);
    } finally {
      release.resolve();
      connection.close();
      gateway.close();
      router.destroy();
      registry.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
