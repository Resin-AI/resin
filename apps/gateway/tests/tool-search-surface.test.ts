import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalMcpGateway } from "../src/gateway.js";
import { MCP_ERROR_CODES } from "../src/protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../src/protocol/framing.js";
import type { JsonRpcMessage, JsonRpcParams, JsonRpcResponse } from "../src/protocol/types.js";
import { McpStdioShim } from "../src/shim/stdio-bridge.js";
import { createToolSearchSurface } from "../src/shim/tool-search-surface.js";
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
        input.write(encodeMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
        for (let refresh = 0; refresh < 2; refresh++) {
          const response = await request("tools/list", {}, refresh === 1);
          expect(response.error).toBeUndefined();
          const tools = z
            .object({ tools: z.array(z.object({ name: z.string() })) })
            .parse(response.result)
            .tools.map((tool) => tool.name);
          expect(tools.includes("search_tools")).toBe(searchable);
          expect(tools.includes("sys_search_tools")).toBe(searchable && !codexClient);
          expect(tools).toContain("get_tool_schema");
          expect(tools).toContain("invoke_tool");
          if (codexClient) {
            expect(tools.sort()).toEqual([
              "get_tool_schema",
              "invoke_tool",
              "manage_tools",
              "search_tools",
            ]);
          } else {
            expect(tools).toContain("echo");
            if (refresh === 1) expect(tools).toContain("fresh_generated_tool");
          }
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
          else expect(response.error?.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
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

function createSurfaceClient() {
  const output = new PassThrough();
  const surface = createToolSearchSurface(output);
  const forwarded: JsonRpcMessage[] = [];
  const received: JsonRpcMessage[] = [];
  const inputDecoder = new McpFrameDecoder();
  const outputDecoder = new McpFrameDecoder();
  surface.input.on("data", (chunk: Buffer) => forwarded.push(...inputDecoder.push(chunk)));
  output.on("data", (chunk: Buffer) => received.push(...outputDecoder.push(chunk)));
  surface.output.pipe(output);
  return {
    forwarded,
    received,
    send: (message: JsonRpcMessage) => surface.input.write(encodeMcpMessage(message)),
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
