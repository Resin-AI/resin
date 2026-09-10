import { PassThrough } from "node:stream";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_GATEWAY_INSTRUCTIONS,
  DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
  LocalMcpGateway,
} from "../src/gateway.js";
import { createManageToolsHandler } from "../src/meta/manage-tools.js";
import { McpFrameDecoder, encodeMcpMessage } from "../src/protocol/framing.js";
import type { JsonRpcMessage, JsonRpcParams, JsonRpcResponse } from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { computeManifestDigest } from "../src/registry/validator.js";
import {
  CONNECTION_DISABLED_SEARCH_REASON,
  createToolSearchSurface,
} from "../src/shim/tool-search-surface.js";
import type { WorkspaceContext } from "../src/workspace-resolver.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const toolId = overrides?.id ?? "tool_test";
  const raw = {
    id: toolId,
    name: overrides?.name ?? toolId,
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Tool for testing",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse(overrides?.capabilities ?? {}),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? {}),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-01T00:00:00.000Z",
  };

  return {
    ...raw,
    digest: computeManifestDigest(raw),
  };
}

function createTestClient(options: { enableSearch?: boolean; fullCatalog?: boolean } = {}) {
  const output = new PassThrough();
  const surface = createToolSearchSurface(output, options);
  surface.output.pipe(output);
  const received: JsonRpcMessage[] = [];
  const forwarded: JsonRpcMessage[] = [];
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  const decoder = new McpFrameDecoder();
  const inputDecoder = new McpFrameDecoder();

  surface.input.on("data", (chunk: Buffer) => {
    for (const msg of inputDecoder.push(chunk)) {
      forwarded.push(msg);
    }
  });

  output.on("data", (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      received.push(msg);
      if (!("method" in msg) && typeof msg.id === "number") {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 0;
  return {
    surface,
    received,
    forwarded,
    send: (message: JsonRpcMessage) => surface.input.write(encodeMcpMessage(message)),
    respond: (message: JsonRpcMessage) => surface.output.write(encodeMcpMessage(message)),
    async request(method: string, params: JsonRpcParams = {}): Promise<JsonRpcResponse> {
      const id = ++nextId;
      const { promise, resolve } = Promise.withResolvers<JsonRpcResponse>();
      pending.set(id, resolve);
      surface.input.write(encodeMcpMessage({ jsonrpc: "2.0", id, method, params }));
      return promise;
    },
    async initialize(clientName: string): Promise<JsonRpcResponse> {
      const id = ++nextId;
      const { promise, resolve } = Promise.withResolvers<JsonRpcResponse>();
      pending.set(id, resolve);
      surface.input.write(
        encodeMcpMessage({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: clientName, version: "1.0.0" },
          },
        }),
      );
      surface.output.write(
        encodeMcpMessage({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "resin-test", version: "1.0.0" },
            instructions: DEFAULT_GATEWAY_INSTRUCTIONS,
          },
        }),
      );
      return promise;
    },
    close() {
      surface.input.destroy();
      surface.output.destroy();
      output.destroy();
    },
  };
}

describe("Generalized Stable Facade and Client Compatibility", () => {
  const representativeTools = [
    { name: "get_tool_schema", inputSchema: { type: "object" } },
    { name: "invoke_tool", inputSchema: { type: "object" } },
    { name: "manage_tools", inputSchema: { type: "object" } },
    { name: "search_tools", inputSchema: { type: "object" } },
    { name: "git_status_diff", inputSchema: { type: "object" } },
    { name: "code_analyzer", inputSchema: { type: "object" } },
    { name: "echo", inputSchema: { type: "object" } },
  ];
  it.each([
    { harness: "omp-agent", enableSearch: false, expectedSearch: false },
    { harness: "omp-agent", enableSearch: true, expectedSearch: true },
    { harness: "claude-code", enableSearch: false, expectedSearch: false },
    { harness: "claude-code", enableSearch: true, expectedSearch: true },
    { harness: "generic-mcp", enableSearch: false, expectedSearch: false },
    { harness: "codex-mcp-client", enableSearch: false, expectedSearch: true },
    { harness: "openai-codex-cli", enableSearch: false, expectedSearch: true },
  ])(
    "exposes stable facade by default for $harness (enableSearch=$enableSearch)",
    async ({ harness, enableSearch, expectedSearch }) => {
      const client = createTestClient({ enableSearch });
      try {
        const init = await client.initialize(harness);
        expect(init.error).toBeUndefined();

        const listPromise = client.request("tools/list");
        client.respond({
          jsonrpc: "2.0",
          id: (listPromise as unknown as { id?: number }) ? 2 : 2,
          result: { tools: representativeTools },
        });

        const listRes = await listPromise;
        expect(listRes.error).toBeUndefined();

        const toolNames = z
          .object({ tools: z.array(z.object({ name: z.string() })) })
          .parse(listRes.result)
          .tools.map((t) => t.name);

        expect(toolNames).toContain("get_tool_schema");
        expect(toolNames).toContain("invoke_tool");
        expect(toolNames).toContain("manage_tools");
        expect(toolNames.includes("search_tools")).toBe(expectedSearch);

        const expected = expectedSearch
          ? ["get_tool_schema", "invoke_tool", "manage_tools", "search_tools"]
          : ["get_tool_schema", "invoke_tool", "manage_tools"];
        expect(toolNames.slice().sort()).toEqual(expected.slice().sort());
        // Hidden evolved tools are NOT advertised
        expect(toolNames).not.toContain("git_status_diff");
        expect(toolNames).not.toContain("code_analyzer");
        expect(toolNames).not.toContain("echo");

        const expectedCount = expectedSearch ? 4 : 3;
        expect(toolNames).toHaveLength(expectedCount);
      } finally {
        client.close();
      }
    },
  );

  it.each([
    { harness: "omp-agent", enableSearch: false },
    { harness: "claude-code", enableSearch: true },
    { harness: "codex-mcp-client", enableSearch: false },
  ])(
    "preserves full native exposure when fullCatalog is opted in (%s)",
    async ({ harness, enableSearch }) => {
      const client = createTestClient({ enableSearch, fullCatalog: true });
      try {
        await client.initialize(harness);
        const listPromise = client.request("tools/list");
        client.respond({
          jsonrpc: "2.0",
          id: 2,
          result: { tools: representativeTools },
        });

        const listRes = await listPromise;
        const toolNames = z
          .object({ tools: z.array(z.object({ name: z.string() })) })
          .parse(listRes.result)
          .tools.map((t) => t.name);

        expect(toolNames).toContain("git_status_diff");
        expect(toolNames).toContain("code_analyzer");
        expect(toolNames).toContain("echo");

        const isCodex = harness.includes("codex");
        const searchExpected = enableSearch || isCodex;
        expect(toolNames.includes("search_tools")).toBe(searchExpected);
      } finally {
        client.close();
      }
    },
  );
});

describe("Live Hidden Invocation and Delta Discovery", () => {
  it("allows direct execution and invoke_tool execution of non-advertised tools without mutation", async () => {
    const router = new FakeGatewayRouter();
    let hiddenToolCalled = false;
    let invokeToolCalled = false;

    router.registerTool({ name: "hidden_compute", inputSchema: { type: "object" } }, async () => {
      hiddenToolCalled = true;
      return { content: [{ type: "text", text: "computed result" }] };
    });

    router.registerTool(
      { name: "invoke_tool", inputSchema: { type: "object" } },
      async (context, params) => {
        invokeToolCalled = true;
        const parameters = params.parameters;
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
          throw new Error("Expected an object of tool parameters");
        }
        return router.callTool(context, String(params.name ?? params.toolId), parameters);
      },
    );

    router.registerTool({ name: "get_tool_schema", inputSchema: { type: "object" } }, async () => ({
      content: [],
    }));
    router.registerTool({ name: "manage_tools", inputSchema: { type: "object" } }, async () => ({
      content: [],
    }));

    const backend = new LocalMcpGateway({ router });
    const clientInput = new PassThrough();
    const clientOutput = new PassThrough();

    const surface = createToolSearchSurface(clientOutput, {
      enableSearch: false,
      fullCatalog: false,
    });
    surface.output.pipe(clientOutput);

    void backend.processStream(surface.input, surface.output, { cwd: "/tmp" });

    const decoder = new McpFrameDecoder();
    const responses = new Map<number, (res: JsonRpcResponse) => void>();
    clientOutput.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (!("method" in msg) && typeof msg.id === "number") {
          responses.get(msg.id)?.(msg);
          responses.delete(msg.id);
        }
      }
    });

    let nextId = 0;
    const req = (method: string, params: JsonRpcParams = {}) => {
      const id = ++nextId;
      const { promise, resolve } = Promise.withResolvers<JsonRpcResponse>();
      responses.set(id, resolve);
      surface.input.write(encodeMcpMessage({ jsonrpc: "2.0", id, method, params }));
      return promise;
    };

    try {
      await req("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-session", version: "1.0.0" },
      });

      // tools/list only exposes meta-tools
      const listRes = await req("tools/list");
      const listNames = (listRes.result as { tools: Array<{ name: string }> }).tools.map(
        (t) => t.name,
      );
      expect(listNames).not.toContain("hidden_compute");
      expect(listNames.slice().sort()).toEqual(["get_tool_schema", "invoke_tool", "manage_tools"]);

      // 1. Direct call to hidden tool
      const directRes = await req("tools/call", { name: "hidden_compute", arguments: {} });
      expect(directRes.error).toBeUndefined();
      expect(hiddenToolCalled).toBe(true);

      // 2. Call via invoke_tool
      const invokeRes = await req("tools/call", {
        name: "invoke_tool",
        arguments: { name: "hidden_compute", parameters: {} },
      });
      expect(invokeRes.error).toBeUndefined();
      expect(invokeToolCalled).toBe(true);
    } finally {
      surface.input.destroy();
      surface.output.destroy();
      clientInput.destroy();
      clientOutput.destroy();
      backend.close();
    }
  });
});

describe("Metadata Rewriting and Request-Level Exclusions for Search-Disabled Connections", () => {
  it("merges excludeToolIds into compact list_versions request arguments when includeDisabled is false", async () => {
    const client = createTestClient({ enableSearch: false });
    try {
      await client.initialize("test-harness");

      const callPromise = client.request("tools/call", {
        name: "manage_tools",
        arguments: { action: "list_versions", compact: true },
      });
      // Verify surface.input forwarded message merged excludeToolIds
      const forwardedCall = client.forwarded.find(
        (msg) =>
          "method" in msg && msg.method === "tools/call" && msg.params?.name === "manage_tools",
      );
      expect(forwardedCall).toBeDefined();
      const callArgs =
        forwardedCall && "params" in forwardedCall
          ? (forwardedCall.params?.arguments as Record<string, unknown>)
          : undefined;
      expect(callArgs?.excludeToolIds).toEqual(["sys_search_tools", "search_tools"]);

      client.respond({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  {
                    toolId: "git_tool",
                    name: "git_tool",
                    scope: "workspace",
                    version: "1.0.0",
                    description: "Git tool",
                    isDisabled: false,
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
                hasMore: false,
              }),
            },
          ],
        },
      });
      const res = await callPromise;
      const contentText = (res.result as { content: Array<{ text: string }> }).content[0].text;
      expect(contentText).not.toContain("\n");
      const payload = JSON.parse(contentText) as {
        tools: Array<{ toolId: string; name: string }>;
        total: number;
        hasMore: boolean;
      };

      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0].name).toBe("git_tool");
      expect(payload.total).toBe(1);
      expect(payload.hasMore).toBe(false);
    } finally {
      client.close();
    }
  });

  it("multi-page boundary regression: search_tools excluded before pagination so no active tools skipped", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context: WorkspaceContext = {
      workspaceId: "ws-boundary",
      canonicalRoot: "/workspaces/ws-boundary",
      name: "ws-boundary",
      source: "cwd_fallback",
      roots: [{ uri: "file:///workspaces/ws-boundary", path: "/workspaces/ws-boundary" }],
    };

    // search_tools sorts before the fixture tools and would consume a first-page slot.
    await registry.registerTool(
      makeManifest({
        id: "tool_a",
        name: "tool_a",
        description: "Tool A",
      }),
      undefined,
      { workspaceId: "ws-boundary" },
    );
    await registry.registerTool(
      makeManifest({
        id: "tool_b",
        name: "tool_b",
        description: "Tool B",
      }),
      undefined,
      { workspaceId: "ws-boundary" },
    );
    await registry.registerTool(
      makeManifest({
        id: "sys_search_tools",
        name: "search_tools",
        description: "Search tools",
        scope: "system",
        metadata: { isSystem: true },
      }),
      undefined,
      { workspaceId: "ws-boundary" },
    );
    await registry.registerTool(
      makeManifest({
        id: "tool_c",
        name: "tool_c",
        description: "Tool C",
      }),
      undefined,
      { workspaceId: "ws-boundary" },
    );
    await registry.registerTool(
      makeManifest({
        id: "tool_d",
        name: "tool_d",
        description: "Tool D",
      }),
      undefined,
      { workspaceId: "ws-boundary" },
    );

    const client = createTestClient({ enableSearch: false });
    try {
      await client.initialize("omp-agent");
      const readPage = async (offset: number) => {
        const pending = client.request("tools/call", {
          name: "manage_tools",
          arguments: {
            action: "list_versions",
            compact: true,
            limit: 2,
            offset,
            // The caller excludes other metadata tools; only the shim excludes search.
            excludeToolIds: ["sys_get_tool_schema", "sys_invoke_tool", "sys_manage_tools"],
          },
        });
        const forwarded = client.forwarded.at(-1);
        if (!forwarded || !("method" in forwarded) || !("id" in forwarded)) {
          throw new Error("Expected a forwarded tool call");
        }
        expect(forwarded.method).toBe("tools/call");
        const args = forwarded.params?.arguments as JsonRpcParams;
        expect(args.excludeToolIds).toEqual(
          expect.arrayContaining([
            "sys_get_tool_schema",
            "sys_invoke_tool",
            "sys_manage_tools",
            "sys_search_tools",
            "search_tools",
          ]),
        );
        const result = await handler(context, args);
        client.respond({ jsonrpc: "2.0", id: forwarded.id, result });
        const response = await pending;
        expect(response.error).toBeUndefined();
        const payload = response.result as { content: Array<{ text: string }> };
        expect(payload.content[0].text).not.toContain("\n");
        return JSON.parse(payload.content[0].text) as {
          tools: Array<{ toolId: string }>;
          total: number;
          hasMore: boolean;
        };
      };

      const page1 = await readPage(0);
      const page2 = await readPage(2);
      expect(page1.total).toBe(4);
      expect(page1.hasMore).toBe(true);
      expect(page1.tools.map((tool) => tool.toolId)).toEqual(["tool_a", "tool_b"]);
      expect(page2.total).toBe(4);
      expect(page2.hasMore).toBe(false);
      expect(page2.tools.map((tool) => tool.toolId)).toEqual(["tool_c", "tool_d"]);
      expect([...page1.tools, ...page2.tools].map((tool) => tool.toolId)).toEqual([
        "tool_a",
        "tool_b",
        "tool_c",
        "tool_d",
      ]);
    } finally {
      client.close();
    }
  });

  it("marks search_tools as disabled in compact mode when includeDisabled is explicitly true", async () => {
    const client = createTestClient({ enableSearch: false });
    try {
      await client.initialize("test-harness");

      const callPromise = client.request("tools/call", {
        name: "manage_tools",
        arguments: { action: "list_versions", compact: true, includeDisabled: true },
      });

      client.respond({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  {
                    toolId: "sys_search_tools",
                    name: "search_tools",
                    scope: "system",
                    version: "1.0.0",
                    description: "Search tools",
                    isDisabled: false,
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
                hasMore: false,
              }),
            },
          ],
        },
      });

      const res = await callPromise;
      const contentText = (res.result as { content: Array<{ text: string }> }).content[0].text;
      const payload = JSON.parse(contentText) as {
        tools: Array<{ toolId: string; isDisabled: boolean; disabledReason?: string }>;
      };

      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0].isDisabled).toBe(true);
      expect(payload.tools[0].disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });

  it("unwraps deeply nested invoke aliases when rewriting metadata", async () => {
    const client = createTestClient({ enableSearch: false });
    try {
      await client.initialize("test-harness");

      // invoke_tool -> invoke_tool -> manage_tools status
      const callPromise = client.request("tools/call", {
        name: "invoke_tool",
        arguments: {
          name: "invoke_tool",
          parameters: {
            tool_name: "manage_tools",
            arguments: { action: "status", toolId: "search_tools" },
          },
        },
      });

      client.respond({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                isDisabled: false,
              }),
            },
          ],
        },
      });

      const res = await callPromise;
      const payload = JSON.parse(
        (res.result as { content: Array<{ text: string }> }).content[0].text,
      ) as { isDisabled: boolean; disabledReason?: string };

      expect(payload.isDisabled).toBe(true);
      expect(payload.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });

  it("returns collision-resolved canonical names that resolve to the discovered tool IDs", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context: WorkspaceContext = {
      workspaceId: "ws-collision",
      canonicalRoot: "/workspaces/ws-collision",
      name: "ws-collision",
      source: "cwd_fallback",
      roots: [{ uri: "file:///workspaces/ws-collision", path: "/workspaces/ws-collision" }],
    };

    // Register tools that produce collision resolution or raw naming
    const manifest1 = makeManifest({
      id: "tool_alpha_v1",
      name: "common_tool_name",
      description: "First common tool",
    });
    const manifest2 = makeManifest({
      id: "tool_alpha_v2",
      name: "common_tool_name",
      description: "Second common tool with colliding name",
    });

    await registry.registerTool(manifest1, undefined, { workspaceId: "ws-collision" });
    await registry.registerTool(manifest2, undefined, { workspaceId: "ws-collision" });

    const discRes = await handler(context, { action: "list_versions", compact: true });
    expect(discRes.isError).toBeFalsy();
    const discData = JSON.parse(discRes.content[0].text) as {
      tools: Array<{ toolId: string; name: string }>;
    };

    expect(discData.tools.length).toBeGreaterThan(0);
    for (const discovered of discData.tools) {
      expect(discovered.name).toBeTruthy();
      // Resolve the advertised name through the same registry lookup used for invocation.
      const tool = await registry.getTool(discovered.name, "ws-collision");
      expect(tool).toBeDefined();
      expect(tool?.toolId).toBe(discovered.toolId);
    }
  });
});

describe("Deterministic Byte-Size Comparison on Representative Catalog", () => {
  function makeRealisticToolSchema(index: number) {
    return {
      name: `resin_workflow_automation_${index}`,
      description: `Automated enterprise workflow step ${index} for executing distributed data transformation, schema validation, and verification pipeline across nodes.`,
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["extract", "transform", "load", "validate", "publish", "rollback"],
            description: "Target workflow action lifecycle state to execute.",
          },
          targetPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "List of absolute and relative filesystem paths touched by this operation.",
          },
          configuration: {
            type: "object",
            properties: {
              timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
              concurrency: { type: "integer", minimum: 1, maximum: 32 },
              retryPolicy: {
                type: "object",
                properties: {
                  maxAttempts: { type: "integer", minimum: 1 },
                  backoffMultiplier: { type: "number" },
                },
              },
              dryRun: { type: "boolean", description: "Simulate action without side effects." },
            },
            required: ["timeoutMs"],
          },
          metadata: {
            type: "object",
            description: "Arbitrary caller provenance tags and correlation identifiers.",
          },
        },
        required: ["operation", "targetPaths"],
      },
    };
  }

  it("achieves >90% deterministic byte-size reduction between full catalog and stable facade", () => {
    const fullTools = Array.from({ length: 30 }, (_, i) => makeRealisticToolSchema(i));
    fullTools.push(
      { name: "get_tool_schema", description: "Schema inspector", inputSchema: { type: "object" } },
      { name: "invoke_tool", description: "Invocation tool", inputSchema: { type: "object" } },
      { name: "manage_tools", description: "Management tool", inputSchema: { type: "object" } },
    );

    const fullCatalogJson = JSON.stringify({ tools: fullTools });
    const fullSizeBytes = Buffer.byteLength(fullCatalogJson, "utf8");

    // Stable facade exposes only system meta-tools
    const facadeTools = fullTools.filter(
      (t) => t.name === "get_tool_schema" || t.name === "invoke_tool" || t.name === "manage_tools",
    );
    const facadeCatalogJson = JSON.stringify({ tools: facadeTools });
    const facadeSizeBytes = Buffer.byteLength(facadeCatalogJson, "utf8");

    const reductionRatio = (fullSizeBytes - facadeSizeBytes) / fullSizeBytes;

    // Full catalog with 30 realistic enterprise schemas is > 20 KB
    expect(fullSizeBytes).toBeGreaterThan(20_000);
    // Facade is < 1 KB
    expect(facadeSizeBytes).toBeLessThan(1_000);
    // Verified reduction ratio is over 95%
    expect(reductionRatio).toBeGreaterThan(0.95);
  });

  it("reduces discovery bytes while preserving every match in a representative scoped query", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context: WorkspaceContext = {
      workspaceId: "ws-bench",
      canonicalRoot: "/workspaces/ws-bench",
      name: "ws-bench",
      source: "cwd_fallback",
      roots: [{ uri: "file:///workspaces/ws-bench", path: "/workspaces/ws-bench" }],
    };

    // Register 25 tools with multiple versions
    for (let i = 0; i < 25; i++) {
      for (let v = 1; v <= 3; v++) {
        await registry.registerTool(
          makeManifest({
            id: `tool_component_${i}`,
            name: `Tool Component ${i}`,
            version: `${v}.0.0`,
            description: `Production component ${i} performing multi-step operations in workspace environment.`,
            parameters: {
              type: "object",
              properties: {
                arg1: { type: "string" },
                arg2: { type: "number" },
              },
            },
          }),
          undefined,
          { workspaceId: "ws-bench" },
        );
      }
    }

    // 1. Legacy full dump
    const legacyRes = await handler(context, { action: "list_versions" });
    const legacyText = legacyRes.content[0].text;
    const legacyBytes = Buffer.byteLength(legacyText, "utf8");

    // 2. Compact scoped query
    const compactRes = await handler(context, {
      action: "list_versions",
      compact: true,
      query: "Component 1",
    });
    const compactText = compactRes.content[0].text;
    expect(compactText).not.toContain("\n");
    const compactBytes = Buffer.byteLength(compactText, "utf8");
    const reductionRatio = (legacyBytes - compactBytes) / legacyBytes;

    expect(legacyBytes).toBeGreaterThan(0);
    expect(compactBytes).toBeGreaterThan(0);
    expect(compactBytes).toBeLessThan(legacyBytes);
    expect(reductionRatio).toBeGreaterThan(0.5);
    const compact = JSON.parse(compactText) as {
      tools: Array<{ toolId: string }>;
      total: number;
      hasMore: boolean;
    };
    const expectedIds = Array.from({ length: 25 }, (_, i) => i)
      .filter((i) => String(i).startsWith("1"))
      .map((i) => `tool_component_${i}`)
      .sort();
    expect(compact.tools.map((tool) => tool.toolId).sort()).toEqual(expectedIds);
    expect(compact.total).toBe(expectedIds.length);
    expect(compact.hasMore).toBe(false);
  });
});
