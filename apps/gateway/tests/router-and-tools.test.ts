import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { MCP_ERROR_CODES } from "../src/protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

describe("GatewayRouter & Tool Lifecycle", () => {
  it("lists all available tools via tools/list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-list-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      // Initialize client
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-agent" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      // SAFETY: Gateway response is confirmed to be ListToolsResult.
      const listResp = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as JsonRpcSuccessResponse<ListToolsResult>;

      expect(listResp.error).toBeUndefined();
      expect(listResp.result.tools.length).toBeGreaterThanOrEqual(4);
      const toolNames = listResp.result.tools.map((t) => t.name);
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("fail_tool");
      expect(toolNames).toContain("resin_echo");
      expect(toolNames).toContain("slow_tool");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes standard echo tool and returns structured text content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-echo-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-agent" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      // SAFETY: Gateway response is confirmed to be CallToolResult.
      const callResp = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "hello world" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      expect(callResp.error).toBeUndefined();
      expect(callResp.result.content).toBeDefined();
      expect(callResp.result.content[0].text).toContain("hello world");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles progress notifications during long-running tool execution", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-prog-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const notifications: JsonRpcNotification[] = [];

      const conn = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (msg) => {
          if (!("id" in msg) || msg.id === undefined) {
            // SAFETY: Notification message has no id.
            notifications.push(msg as JsonRpcNotification);
          }
        },
      });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-agent" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      // SAFETY: Gateway response is confirmed to be CallToolResult.
      const callResp = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "slow_tool",
          arguments: { durationMs: 50, steps: 2 },
          _meta: { progressToken: "token-123" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      expect(callResp.error).toBeUndefined();
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      const progressNotifs = notifications.filter((n) => n.method === "notifications/progress");
      expect(progressNotifs.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles cancellation via $/cancelRequest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-cancel-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-agent" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      const callPromise = gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "slow_tool",
          arguments: { durationMs: 500, steps: 10 },
        },
      });

      // Send cancellation after slight delay
      setTimeout(() => {
        gateway.handleMessage(conn.connectionId, {
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { requestId: 2 },
        });
      }, 50);

      // SAFETY: Gateway response is confirmed to be JsonRpcErrorResponse.
      const callResp = (await callPromise) as JsonRpcErrorResponse;
      expect(callResp.error).toBeDefined();
      expect(callResp.error.code).toBe(MCP_ERROR_CODES.CANCELLED);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts notifications/tools/list_changed on router tool registration", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-broadcast-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const notifications: JsonRpcNotification[] = [];

      const conn = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (msg) => {
          if (!("id" in msg) || msg.id === undefined) {
            // SAFETY: Notification message has no id.
            notifications.push(msg as JsonRpcNotification);
          }
        },
      });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-agent" },
          capabilities: { tools: { listChanged: true } },
          rootUri: pathToFileURL(tmpDir).href,
        },
      });
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // Register new tool dynamically
      router.registerTool(
        {
          name: "dynamic_new_tool",
          description: "Dynamically added tool",
          inputSchema: { type: "object", properties: {} },
        },
        async () => ({ content: [{ type: "text", text: "dynamic" }] }),
      );

      const listChangedNotifs = notifications.filter(
        (n) => n.method === "notifications/tools/list_changed",
      );
      expect(listChangedNotifs.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
