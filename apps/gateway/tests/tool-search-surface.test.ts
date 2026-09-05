import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalMcpGateway } from "../src/gateway.js";
import { MCP_ERROR_CODES } from "../src/protocol/errors.js";
import { McpFrameDecoder, encodeMcpMessage } from "../src/protocol/framing.js";
import type { JsonRpcParams, JsonRpcResponse } from "../src/protocol/types.js";
import { McpStdioShim } from "../src/shim/stdio-bridge.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

// A fresh client view must not alter the backend router or its refreshed catalog.
describe.each(["standalone", "fallback", "daemon"] as const)("tool search surface: %s", (mode) => {
  it.each([undefined, true])(
    "respects enableToolSearch=%s across calls and refreshes",
    async (enabled) => {
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
      if (mode === "daemon")
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
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
        const result = new Promise<JsonRpcResponse>((resolve) => pending.set(requestId, resolve));
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
        await request("initialize", {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "1" },
          capabilities: {},
        });
        for (let refresh = 0; refresh < 2; refresh++) {
          const response = await request("tools/list", {}, refresh === 1);
          const tools = z
            .object({ tools: z.array(z.object({ name: z.string() })) })
            .parse(response.result)
            .tools.map((tool) => tool.name);
          expect(tools.includes("search_tools")).toBe(enabled === true);
          expect(tools.includes("sys_search_tools")).toBe(enabled === true);
          expect(tools).toContain("get_tool_schema");
          expect(tools).toContain("invoke_tool");
          expect(tools).toContain("echo");
          if (refresh === 1) expect(tools).toContain("fresh_generated_tool");
          router.registerTool(
            { name: "fresh_generated_tool", inputSchema: { type: "object" } },
            async () => ({ content: [] }),
          );
        }
        const calls: JsonRpcParams[] = [
          { name: "search_tools", arguments: {} },
          { name: "sys_search_tools", arguments: {} },
          ...["name", "tool_name", "toolId"].flatMap((alias) =>
            ["search_tools", "sys_search_tools"].map((target) => ({
              name: "invoke_tool",
              arguments: { [alias]: ` ${target} ` },
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
          if (enabled) expect(response.error).toBeUndefined();
          else expect(response.error?.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
        }
        expect(searchCalls).toBe(enabled ? calls.length : 0);
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
          if (!enabled && target === "search_tools")
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
