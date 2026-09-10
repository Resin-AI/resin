import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_GATEWAY_INSTRUCTIONS, LocalMcpGateway } from "../src/gateway.js";
import { MCP_ERROR_CODES } from "../src/protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../src/protocol/framing.js";
import type { JsonRpcMessage, JsonRpcParams, JsonRpcResponse } from "../src/protocol/types.js";
import { McpStdioShim } from "../src/shim/stdio-bridge.js";
import {
  CONNECTION_DISABLED_SEARCH_REASON,
  DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
  createToolSearchSurface,
} from "../src/shim/tool-search-surface.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

// A fresh client view must not alter the backend router or its refreshed catalog.
describe.each(["standalone", "fallback", "daemon"] as const)("tool search surface: %s", (mode) => {
  it.each([
    { enabled: undefined, clientName: "test", searchable: false },
    { enabled: true, clientName: "test", searchable: true },
    { enabled: undefined, clientName: "codex-mcp-client", searchable: true },
    { enabled: true, clientName: "codex-mcp-client", searchable: true },
    { enabled: undefined, clientName: "openai-codex-cli", searchable: true },
  ])(
    "respects enableToolSearch=$enabled for $clientName across calls and refreshes",
    async ({ enabled, clientName, searchable }) => {
      const codexClient = clientName !== "test";
      const router = new FakeGatewayRouter();
      let searchCalls = 0;
      for (const name of ["search_tools", "sys_search_tools", "invoke_tool", "sys_invoke_tool"]) {
        router.registerTool({ name, inputSchema: { type: "object" } }, async () => {
          searchCalls++;
          return { content: [{ type: "text", text: "search executed" }] };
        });
      }
      router.registerTool(
        { name: "get_tool_schema", inputSchema: { type: "object" } },
        async () => ({ content: [] }),
      );
      router.registerTool({ name: "manage_tools", inputSchema: { type: "object" } }, async () => ({
        content: [],
      }));
      const backend = new LocalMcpGateway({ router });
      const sockets = new Set<net.Socket>();
      const socketPath = path.join(
        os.tmpdir(),
        `search-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
      );
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        void backend.processStream(socket, socket, { cwd: os.tmpdir() });
      });
      if (mode === "daemon") {
        const listening = Promise.withResolvers<void>();
        server.listen(socketPath, listening.resolve);
        await listening.promise;
      }
      const input = new PassThrough();
      const output = new PassThrough();
      const shim = new McpStdioShim({
        socketPath: mode === "standalone" ? "" : socketPath,
        standaloneFallback: mode !== "daemon",
        maxStartupAttempts: 0,
        enableToolSearch: enabled,
        router,
        stdin: input,
        stdout: output,
        stderr: new PassThrough(),
        cwd: os.tmpdir(),
        home: os.tmpdir(),
      });
      const pending = new Map<number, (message: JsonRpcResponse) => void>();
      const decoder = new McpFrameDecoder();
      output.on("data", (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (!("method" in message) && typeof message.id === "number") {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
          }
        }
      });
      let id = 0;
      const request = (method: string, params: JsonRpcParams = {}, framed = false) => {
        const requestId = ++id;
        const { promise: result, resolve } = Promise.withResolvers<JsonRpcResponse>();
        pending.set(requestId, resolve);
        const message = { jsonrpc: "2.0" as const, id: requestId, method, params };
        const body = JSON.stringify(message);
        const wire = framed
          ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
          : encodeMcpMessage(message);
        // Exercise partial frames on both forwarding paths.
        input.write(wire.slice(0, 9));
        input.write(wire.slice(9));
        return result;
      };
      try {
        expect((await shim.start()).mode).toBe(
          mode === "daemon" ? "daemon_ipc" : "standalone_inprocess",
        );
        const initialized = await request("initialize", {
          protocolVersion: "2024-11-05",
          clientInfo: { name: clientName, version: "0.153.4" },
          capabilities: {},
        });
        expect(initialized.error).toBeUndefined();
        const initResult =
          "result" in initialized && initialized.result && typeof initialized.result === "object"
            ? initialized.result
            : null;
        const initInstructions =
          initResult && "instructions" in initResult && typeof initResult.instructions === "string"
            ? initResult.instructions
            : undefined;
        expect(initInstructions).toBe(
          searchable ? DEFAULT_GATEWAY_INSTRUCTIONS : DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
        );
        input.write(encodeMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
        for (let refresh = 0; refresh < 2; refresh++) {
          const response = await request("tools/list", {}, refresh === 1);
          expect(response.error).toBeUndefined();
          const tools = z
            .object({ tools: z.array(z.object({ name: z.string() })) })
            .parse(response.result)
            .tools.map((tool) => tool.name);
          expect(tools.includes("search_tools")).toBe(searchable);
          expect(tools).toContain("get_tool_schema");
          expect(tools).toContain("invoke_tool");
          expect(tools).toContain("manage_tools");
          expect(tools.sort()).toEqual(
            searchable
              ? ["get_tool_schema", "invoke_tool", "manage_tools", "search_tools"]
              : ["get_tool_schema", "invoke_tool", "manage_tools"],
          );
          expect(tools).not.toContain("echo");
          expect(tools).not.toContain("fresh_generated_tool");
          router.registerTool(
            { name: "fresh_generated_tool", inputSchema: { type: "object" } },
            async () => ({ content: [] }),
          );
        }
        // Hiding individual tools from announcements must not block a known direct call.
        const directCall = await request("tools/call", {
          name: "fresh_generated_tool",
          arguments: {},
        });
        expect(directCall.error).toBeUndefined();
        expect(directCall.result).toMatchObject({
          content: [
            {
              type: "text",
              text: expect.stringContaining('New: "fresh_generated_tool"'),
            },
          ],
        });
        // The successful call retains its content and consumes the notice only once.
        expect(
          (await request("tools/call", { name: "fresh_generated_tool", arguments: {} })).result,
        ).toEqual({ content: [] });
        const calls: JsonRpcParams[] = [
          { name: "search_tools", arguments: { query: "exports" } },
          { name: "sys_search_tools", arguments: { query: "exports" } },
          ...["name", "tool_name", "toolId"].flatMap((alias) =>
            ["search_tools", "sys_search_tools"].map((target) => ({
              name: "invoke_tool",
              arguments: { [alias]: ` ${target} `, parameters: { query: "exports" } },
            })),
          ),
          { name: "sys_invoke_tool", arguments: { toolId: "sys_search_tools" } },
          {
            name: "invoke_tool",
            arguments: { name: "invoke_tool", parameters: { tool_name: "search_tools" } },
          },
        ];
        for (const params of calls) {
          const response = await request("tools/call", params);
          if (searchable) expect(response.error).toBeUndefined();
          else
            expect(response.error).toEqual({
              code: MCP_ERROR_CODES.TOOL_NOT_FOUND,
              message:
                "Tool 'search_tools' is disabled for this connection. " +
                'Use manage_tools with {"action":"list_versions","scope":"workspace"} ' +
                "for read-only discovery, or start the MCP shim with --enable-tool-search.",
            });
        }
        expect(searchCalls).toBe(searchable ? calls.length : 0);
        // Multiple aliases must not multiply work at each nesting level.
        for (const target of ["echo", "search_tools"]) {
          let args: JsonRpcParams = { name: target };
          for (let depth = 0; depth < 40; depth++)
            args = {
              name: "invoke_tool",
              tool_name: "invoke_tool",
              toolId: "sys_invoke_tool",
              parameters: args,
            };
          const response = await request("tools/call", { name: "invoke_tool", arguments: args });
          if (!searchable && target === "search_tools")
            expect(response.error?.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
          else expect(response.error).toBeUndefined();
        }
        expect(
          (await request("tools/call", { name: "echo", arguments: { message: "still usable" } }))
            .result,
        ).toMatchObject({ content: [{ text: "Echo: still usable" }] });
        expect(
          (await request("tools/call", { name: "get_tool_schema", arguments: {} })).error,
        ).toBeUndefined();
      } finally {
        await shim.stop();
        input.destroy();
        output.destroy();
        backend.close();
        for (const socket of sockets) socket.destroy();
        if (mode === "daemon") await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

function createSurfaceClient(
  enableSearch: boolean | { enableSearch?: boolean; fullCatalog?: boolean } = false,
  fullCatalog = false,
) {
  const output = new PassThrough();
  const surface = createToolSearchSurface(output, enableSearch, fullCatalog);
  const forwarded: JsonRpcMessage[] = [];
  const received: JsonRpcMessage[] = [];
  const inputDecoder = new McpFrameDecoder();
  const outputDecoder = new McpFrameDecoder();
  surface.input.on("data", (chunk: Buffer) => forwarded.push(...inputDecoder.push(chunk)));
  output.on("data", (chunk: Buffer) => received.push(...outputDecoder.push(chunk)));
  surface.output.pipe(output);
  return {
    surface,
    forwarded,
    received,
    send: (message: JsonRpcMessage) => surface.input.write(encodeMcpMessage(message)),
    respond: (message: JsonRpcMessage) => surface.output.write(encodeMcpMessage(message)),
    list() {
      surface.input.write(encodeMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      surface.output.write(
        encodeMcpMessage({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              "search_tools",
              "sys_search_tools",
              "get_tool_schema",
              "invoke_tool",
              "manage_tools",
              "generated_tool",
            ].map((name) => ({ name, inputSchema: { type: "object" } })),
          },
        }),
      );
      const response = received.at(-1);
      if (!response || !("result" in response)) throw new Error("Expected tools/list response");
      return z
        .object({ tools: z.array(z.object({ name: z.string() })) })
        .parse(response.result)
        .tools.map((tool) => tool.name);
    },
    close() {
      surface.input.destroy();
      surface.output.destroy();
      output.destroy();
    },
  };
}

describe("Codex connection-local search compatibility", () => {
  const initialize = (clientName: string): JsonRpcMessage => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0.153.4" },
    },
  });

  it("keeps simultaneous and newly opened clients isolated", () => {
    const codex = createSurfaceClient();
    const other = createSurfaceClient();
    try {
      other.send(initialize("unknown-codex-wrapper"));
      codex.send(initialize("codex-mcp-client"));
      expect(codex.list()).toContain("search_tools");
      expect(other.list()).not.toContain("search_tools");
      const fresh = createSurfaceClient();
      try {
        fresh.send(initialize("test"));
        expect(fresh.list()).not.toContain("search_tools");
        // Another client's initialization cannot hide Codex's live surface.
        expect(codex.list()).toContain("search_tools");
        // A second identity on one connection cannot upgrade its first valid identity.
        other.send(initialize("codex-mcp-client"));
        expect(other.list()).not.toContain("search_tools");
      } finally {
        fresh.close();
      }
    } finally {
      codex.close();
      other.close();
    }
  });

  it.each([
    { clientInfo: { name: "codex-mcp-client", version: "0.153.4" } },
    { protocolVersion: "2024-11-05", clientInfo: { name: "codex-mcp-client", version: 153 } },
    {
      protocolVersion: "2024-11-05",
      capabilities: [],
      clientInfo: { name: "codex-mcp-client", version: "0.153.4" },
    },
  ])("does not enable search for malformed initialize params %j", (params) => {
    const client = createSurfaceClient();
    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params });
      expect(client.list()).not.toContain("search_tools");
      client.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_tools", arguments: { query: "exports" } },
      });
      expect(client.received.at(-1)).toMatchObject({
        id: 3,
        error: { code: MCP_ERROR_CODES.TOOL_NOT_FOUND },
      });
      expect(
        client.forwarded.some((message) => "method" in message && message.method === "tools/call"),
      ).toBe(false);
      client.send(initialize("codex-mcp-client"));
      expect(client.list()).toContain("search_tools");
    } finally {
      client.close();
    }
  });

  it("ignores initialize notifications when selecting the client surface", () => {
    const client = createSurfaceClient();
    try {
      const message = initialize("codex-mcp-client");
      if (!("method" in message)) throw new Error("Expected initialize request");
      client.send({ jsonrpc: "2.0", method: message.method, params: message.params });
      expect(client.list()).not.toContain("search_tools");
      client.send(initialize("test"));
      expect(client.list()).not.toContain("search_tools");
    } finally {
      client.close();
    }
  });
});

describe("connection-local metadata consistency for disabled search", () => {
  const parseResultJson = (message: JsonRpcMessage | undefined): Record<string, unknown> => {
    if (!message || !("result" in message)) throw new Error("Expected result in message");
    const result =
      message.result && typeof message.result === "object" ? message.result : undefined;
    if (!result || !("content" in result) || !Array.isArray(result.content)) {
      throw new Error("Expected content array in result");
    }
    const first = result.content[0];
    if (
      !first ||
      typeof first !== "object" ||
      !("text" in first) ||
      typeof first.text !== "string"
    ) {
      throw new Error("Expected text property in first content item");
    }
    return JSON.parse(first.text) as Record<string, unknown>;
  };

  it("returns disabled-search instructions for standard/default MCP clients", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "oh-my-pi", version: "2.0.0" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "resin", version: "0.1.0" },
          instructions: DEFAULT_GATEWAY_INSTRUCTIONS,
        },
      });
      const response = client.received.find((msg) => "id" in msg && msg.id === 1);
      if (!response || !("result" in response)) throw new Error("Expected initialize response");
      const result =
        response.result && typeof response.result === "object" ? response.result : undefined;
      expect(result && "instructions" in result ? result.instructions : undefined).toBe(
        DISABLED_SEARCH_GATEWAY_INSTRUCTIONS,
      );
    } finally {
      client.close();
    }
  });

  it("returns default instructions when search is explicitly enabled or client is Codex", () => {
    const codex = createSurfaceClient();
    const optIn = createSurfaceClient(true);
    try {
      codex.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.153.4" },
        },
      });
      codex.respond({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "resin", version: "0.1.0" },
          instructions: DEFAULT_GATEWAY_INSTRUCTIONS,
        },
      });
      const codexResp = codex.received.find((msg) => "id" in msg && msg.id === 1);
      if (!codexResp || !("result" in codexResp)) throw new Error("Expected codex response");
      const codexRes =
        codexResp.result && typeof codexResp.result === "object" ? codexResp.result : undefined;
      expect(codexRes && "instructions" in codexRes ? codexRes.instructions : undefined).toBe(
        DEFAULT_GATEWAY_INSTRUCTIONS,
      );

      optIn.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      });
      optIn.respond({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "resin", version: "0.1.0" },
          instructions: DEFAULT_GATEWAY_INSTRUCTIONS,
        },
      });
      const optInResp = optIn.received.find((msg) => "id" in msg && msg.id === 1);
      if (!optInResp || !("result" in optInResp)) throw new Error("Expected optIn response");
      const optInRes =
        optInResp.result && typeof optInResp.result === "object" ? optInResp.result : undefined;
      expect(optInRes && "instructions" in optInRes ? optInRes.instructions : undefined).toBe(
        DEFAULT_GATEWAY_INSTRUCTIONS,
      );
    } finally {
      codex.close();
      optIn.close();
    }
  });

  it("marks search_tools as disabled in manage_tools bulk discovery while preserving other tools", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "manage_tools",
          arguments: { action: "list_versions", scope: "workspace" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 10,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  { toolId: "search_tools", name: "search_tools", isDisabled: false },
                  { toolId: "sys_search_tools", name: "sys_search_tools", isDisabled: false },
                  { toolId: "calculator_add", name: "calculator_add", isDisabled: false },
                ],
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 10));
      const tools = Array.isArray(data.tools) ? (data.tools as Array<Record<string, unknown>>) : [];
      const searchTool = tools.find((t) => t.toolId === "search_tools");
      const sysSearchTool = tools.find((t) => t.toolId === "sys_search_tools");
      const calcTool = tools.find((t) => t.toolId === "calculator_add");

      expect(searchTool?.isDisabled).toBe(true);
      expect(searchTool?.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      expect(sysSearchTool?.isDisabled).toBe(true);
      expect(sysSearchTool?.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      expect(calcTool?.isDisabled).toBe(false);
      expect(calcTool?.disabledReason).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("marks targeted list_versions inactive while preserving lifecycle active status", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "manage_tools",
          arguments: { action: "list_versions", toolId: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 20,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                scope: "workspace",
                pinnedVersion: null,
                isDisabled: false,
                installedVersions: [
                  {
                    version: "1.0.0",
                    status: "active",
                    manifestDigest: "abc",
                    createdAt: "2026-01-01",
                    isPinned: false,
                    isActive: true,
                  },
                ],
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 20));
      expect(data.isDisabled).toBe(true);
      expect(data.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      const versions = Array.isArray(data.installedVersions)
        ? (data.installedVersions as Array<Record<string, unknown>>)
        : [];
      expect(versions[0]?.status).toBe("active");
      expect(versions[0]?.isActive).toBe(false);
    } finally {
      client.close();
    }
  });

  it("updates manage_tools status for search_tools with connection-scoped disabled reason", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "manage_tools",
          arguments: { action: "status", toolId: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 30,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                activeVersion: "1.0.0",
                pinnedVersion: null,
                isDisabled: false,
                isSystem: true,
                installedVersions: ["1.0.0"],
                rollbacks: [],
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 30));
      expect(data.isDisabled).toBe(true);
      expect(data.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      expect(data.activeVersion).toBe("1.0.0");
      expect(data.isSystem).toBe(true);
    } finally {
      client.close();
    }
  });

  it("updates get_tool_schema for search_tools while preserving lifecycle status active", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "get_tool_schema",
          arguments: { toolId: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 40,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                version: "1.0.0",
                scope: "workspace",
                status: "active",
                description: "Read-only live lookup",
                inputSchema: { type: "object" },
                capabilities: {},
                limits: {},
                isPinned: false,
                isDisabled: false,
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 40));
      expect(data.isDisabled).toBe(true);
      expect(data.status).toBe("active");
      expect(data.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });
});

describe("nested invoke_tool metadata consistency", () => {
  const parseResultJson = (message: JsonRpcMessage | undefined): Record<string, unknown> => {
    if (!message || !("result" in message)) throw new Error("Expected result in message");
    const result =
      message.result && typeof message.result === "object" ? message.result : undefined;
    if (!result || !("content" in result) || !Array.isArray(result.content)) {
      throw new Error("Expected content array in result");
    }
    const first = result.content[0];
    if (
      !first ||
      typeof first !== "object" ||
      !("text" in first) ||
      typeof first.text !== "string"
    ) {
      throw new Error("Expected text property in first content item");
    }
    return JSON.parse(first.text) as Record<string, unknown>;
  };

  it.each([
    { alias: "name", target: "manage_tools" },
    { alias: "tool_name", target: "manage_tools" },
    { alias: "toolId", target: "sys_manage_tools" },
  ])(
    "transforms manage_tools bulk discovery when invoked via invoke_tool ($alias)",
    ({ alias, target }) => {
      const client = createSurfaceClient();
      try {
        client.send({
          jsonrpc: "2.0",
          id: 50,
          method: "tools/call",
          params: {
            name: "invoke_tool",
            arguments: {
              [alias]: target,
              parameters: { action: "list_versions", scope: "workspace" },
            },
          },
        });
        client.respond({
          jsonrpc: "2.0",
          id: 50,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tools: [
                    { toolId: "search_tools", name: "search_tools", isDisabled: false },
                    { toolId: "calculator_add", name: "calculator_add", isDisabled: false },
                  ],
                }),
              },
            ],
          },
        });
        const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 50));
        const tools = Array.isArray(data.tools)
          ? (data.tools as Array<Record<string, unknown>>)
          : [];
        const searchTool = tools.find((t) => t.toolId === "search_tools");
        expect(searchTool?.isDisabled).toBe(true);
        expect(searchTool?.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      } finally {
        client.close();
      }
    },
  );

  it("transforms double-nested invoke_tool calls targeting get_tool_schema", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: {
          name: "invoke_tool",
          arguments: {
            name: "invoke_tool",
            parameters: {
              toolId: "get_tool_schema",
              parameters: { toolId: "search_tools" },
            },
          },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 60,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                version: "1.0.0",
                status: "active",
                isDisabled: false,
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 60));
      expect(data.isDisabled).toBe(true);
      expect(data.status).toBe("active");
      expect(data.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });
});

describe("unrelated tool result preservation and safety", () => {
  it("leaves unrelated tool execution results completely untouched", () => {
    const client = createSurfaceClient();
    try {
      const rawPayload = JSON.stringify({
        calculation: "42 * 2",
        result: 84,
        search_tools: "a text string mentions search_tools inside tool data",
      });
      client.send({
        jsonrpc: "2.0",
        id: 70,
        method: "tools/call",
        params: {
          name: "calculator_multiply",
          arguments: { a: 42, b: 2 },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 70,
        result: {
          content: [{ type: "text", text: rawPayload }],
        },
      });
      const response = client.received.find((msg) => "id" in msg && msg.id === 70);
      if (!response || !("result" in response)) throw new Error("Expected response");
      const result =
        response.result && typeof response.result === "object" ? response.result : undefined;
      if (!result || !("content" in result) || !Array.isArray(result.content)) {
        throw new Error("Expected content array");
      }
      const first = result.content[0];
      expect(first && typeof first === "object" && "text" in first ? first.text : undefined).toBe(
        rawPayload,
      );
    } finally {
      client.close();
    }
  });

  it("passes error responses through without modification", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 80,
        method: "tools/call",
        params: {
          name: "manage_tools",
          arguments: { action: "unknown_action" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 80,
        result: {
          isError: true,
          content: [{ type: "text", text: "Parameter 'action' is required" }],
        },
      });
      const response = client.received.find((msg) => "id" in msg && msg.id === 80);
      if (!response || !("result" in response)) throw new Error("Expected response");
      const result =
        response.result && typeof response.result === "object" ? response.result : undefined;
      expect(result && "isError" in result ? result.isError : undefined).toBe(true);
    } finally {
      client.close();
    }
  });

  it("handles malformed JSON content safely without throwing", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: {
          name: "get_tool_schema",
          arguments: { toolId: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 90,
        result: {
          content: [{ type: "text", text: "Not valid JSON: { broken" }],
        },
      });
      const response = client.received.find((msg) => "id" in msg && msg.id === 90);
      if (!response || !("result" in response)) throw new Error("Expected response");
      const result =
        response.result && typeof response.result === "object" ? response.result : undefined;
      if (!result || !("content" in result) || !Array.isArray(result.content)) {
        throw new Error("Expected content array");
      }
      const first = result.content[0];
      expect(first && typeof first === "object" && "text" in first ? first.text : undefined).toBe(
        "Not valid JSON: { broken",
      );
    } finally {
      client.close();
    }
  });
});

describe("targeted regression coverage for response identity, aliases, and prototype safety", () => {
  const parseResultJson = (message: JsonRpcMessage | undefined): Record<string, unknown> => {
    if (!message || !("result" in message)) throw new Error("Expected result in message");
    const result =
      message.result && typeof message.result === "object" ? message.result : undefined;
    if (!result || !("content" in result) || !Array.isArray(result.content)) {
      throw new Error("Expected content array in result");
    }
    const first = result.content[0];
    if (
      !first ||
      typeof first !== "object" ||
      !("text" in first) ||
      typeof first.text !== "string"
    ) {
      throw new Error("Expected text property in first content item");
    }
    return JSON.parse(first.text) as Record<string, unknown>;
  };

  it("does not block or crash on prototype property names like constructor or toString", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "constructor", arguments: { query: "test" } },
      });
      expect(client.forwarded.some((msg) => "id" in msg && msg.id === 101)).toBe(true);
      expect(client.received.some((msg) => "id" in msg && msg.id === 101)).toBe(false);

      client.send({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "toString", arguments: {} },
      });
      expect(client.forwarded.some((msg) => "id" in msg && msg.id === 102)).toBe(true);
      expect(client.received.some((msg) => "id" in msg && msg.id === 102)).toBe(false);

      client.send({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: {
          name: "get_tool_schema",
          arguments: { toolId: "constructor" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 103,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "constructor",
                name: "constructor",
                status: "active",
                isDisabled: false,
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 103));
      expect(data.isDisabled).toBe(false);
      expect(data.disabledReason).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("transforms get_tool_schema when competing aliases result in search response payload", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 104,
        method: "tools/call",
        params: {
          name: "get_tool_schema",
          arguments: { name: "echo", toolId: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 104,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                toolId: "search_tools",
                name: "search_tools",
                version: "1.0.0",
                status: "active",
                isDisabled: false,
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 104));
      expect(data.isDisabled).toBe(true);
      expect(data.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });

  it("transforms bulk discovery when manage_tools list_versions has tool_name ignored by handler", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 105,
        method: "tools/call",
        params: {
          name: "manage_tools",
          arguments: { action: "list_versions", tool_name: "search_tools" },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 105,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  { toolId: "search_tools", name: "search_tools", isDisabled: false },
                  { toolId: "echo", name: "echo", isDisabled: false },
                ],
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 105));
      const tools = Array.isArray(data.tools) ? (data.tools as Array<Record<string, unknown>>) : [];
      const searchTool = tools.find((t) => t.toolId === "search_tools");
      const echoTool = tools.find((t) => t.toolId === "echo");
      expect(searchTool?.isDisabled).toBe(true);
      expect(searchTool?.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      expect(echoTool?.isDisabled).toBe(false);
    } finally {
      client.close();
    }
  });

  it("prioritizes name over tool_name when nested invoke has competing aliases", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 106,
        method: "tools/call",
        params: {
          name: "invoke_tool",
          arguments: {
            name: "manage_tools",
            tool_name: "invoke_tool",
            parameters: { action: "list_versions", scope: "workspace" },
          },
        },
      });
      client.respond({
        jsonrpc: "2.0",
        id: 106,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [{ toolId: "search_tools", name: "search_tools", isDisabled: false }],
              }),
            },
          ],
        },
      });
      const data = parseResultJson(client.received.find((msg) => "id" in msg && msg.id === 106));
      const tools = Array.isArray(data.tools) ? (data.tools as Array<Record<string, unknown>>) : [];
      expect(tools[0]?.isDisabled).toBe(true);
      expect(tools[0]?.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
    } finally {
      client.close();
    }
  });

  it("keeps simultaneous disabled, Codex, and opt-in metadata responses isolated", () => {
    const disabled = createSurfaceClient(false);
    const codex = createSurfaceClient(false);
    const optIn = createSurfaceClient(true);
    try {
      disabled.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "oh-my-pi", version: "1.0" },
        },
      });
      codex.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "1.0" },
        },
      });
      optIn.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-cli", version: "1.0" },
        },
      });

      disabled.send({
        jsonrpc: "2.0",
        id: 200,
        method: "tools/call",
        params: { name: "manage_tools", arguments: { action: "status", toolId: "search_tools" } },
      });
      codex.send({
        jsonrpc: "2.0",
        id: 200,
        method: "tools/call",
        params: { name: "manage_tools", arguments: { action: "status", toolId: "search_tools" } },
      });
      optIn.send({
        jsonrpc: "2.0",
        id: 200,
        method: "tools/call",
        params: { name: "manage_tools", arguments: { action: "status", toolId: "search_tools" } },
      });

      const rawStatus = {
        toolId: "search_tools",
        name: "search_tools",
        activeVersion: "1.0.0",
        isDisabled: false,
        isSystem: true,
      };
      disabled.respond({
        jsonrpc: "2.0",
        id: 200,
        result: { content: [{ type: "text", text: JSON.stringify(rawStatus) }] },
      });
      codex.respond({
        jsonrpc: "2.0",
        id: 200,
        result: { content: [{ type: "text", text: JSON.stringify(rawStatus) }] },
      });
      optIn.respond({
        jsonrpc: "2.0",
        id: 200,
        result: { content: [{ type: "text", text: JSON.stringify(rawStatus) }] },
      });

      const disabledData = parseResultJson(
        disabled.received.find((msg) => "id" in msg && msg.id === 200),
      );
      const codexData = parseResultJson(
        codex.received.find((msg) => "id" in msg && msg.id === 200),
      );
      const optInData = parseResultJson(
        optIn.received.find((msg) => "id" in msg && msg.id === 200),
      );

      expect(disabledData.isDisabled).toBe(true);
      expect(disabledData.disabledReason).toBe(CONNECTION_DISABLED_SEARCH_REASON);
      expect(codexData.isDisabled).toBe(false);
      expect(codexData.disabledReason).toBeUndefined();
      expect(optInData.isDisabled).toBe(false);
      expect(optInData.disabledReason).toBeUndefined();
    } finally {
      disabled.close();
      codex.close();
      optIn.close();
    }
  });

  it("preserves custom initialize instructions appended to DEFAULT instructions", () => {
    const client = createSurfaceClient();
    try {
      client.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "oh-my-pi", version: "2.0.0" },
        },
      });
      const customSuffix = "\n\nExtra custom organizational directive: do not touch production db.";
      client.respond({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "resin", version: "0.1.0" },
          instructions: `${DEFAULT_GATEWAY_INSTRUCTIONS}${customSuffix}`,
        },
      });
      const response = client.received.find((msg) => "id" in msg && msg.id === 1);
      if (!response || !("result" in response)) throw new Error("Expected initialize response");
      const result =
        response.result && typeof response.result === "object" ? response.result : undefined;
      const instructions =
        result && "instructions" in result && typeof result.instructions === "string"
          ? result.instructions
          : undefined;
      expect(instructions).toBe(`${DISABLED_SEARCH_GATEWAY_INSTRUCTIONS}${customSuffix}`);
    } finally {
      client.close();
    }
  });
});
