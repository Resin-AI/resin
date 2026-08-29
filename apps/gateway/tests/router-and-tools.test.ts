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

      // Initialize
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
      expect(toolNames).toContain("workspace_info");
      expect(toolNames).toContain("fail_tool");
      expect(toolNames).toContain("slow_tool");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes tool and returns content via tools/call", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-call-"));
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

      const callResp = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "Hello Gateway!" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      expect(callResp.error).toBeUndefined();
      expect(callResp.result.content).toEqual([{ type: "text", text: "Echo: Hello Gateway!" }]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends progress notifications when progressToken is supplied", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-prog-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const notifications: JsonRpcNotification[] = [];

      const conn = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (msg) => {
          if (!("id" in msg)) {
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

      const callResp = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "slow_tool",
          arguments: { durationMs: 120, steps: 3 },
          _meta: { progressToken: "token-abc" },
        },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      expect(callResp.error).toBeUndefined();
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      const progressNotifs = notifications.filter((n) => n.method === "notifications/progress");
      expect(progressNotifs.length).toBe(3);
      expect(progressNotifs[0].params).toMatchObject({
        progressToken: "token-abc",
        progress: 1,
        total: 3,
      });
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

      // Start slow tool promise
      const toolPromise = gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: "req-to-cancel",
        method: "tools/call",
        params: {
          name: "slow_tool",
          arguments: { durationMs: 1000, steps: 10 },
        },
      });

      // Send cancellation after short delay
      setTimeout(() => {
        gateway.handleMessage(conn.connectionId, {
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: {
            requestId: "req-to-cancel",
            reason: "User cancelled task",
          },
        });
      }, 50);

      const resp = (await toolPromise) as JsonRpcErrorResponse;
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe(MCP_ERROR_CODES.CANCELLED);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts notifications/tools/list_changed when router tools update", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-router-change-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const notifications: JsonRpcNotification[] = [];

      const conn = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (msg) => {
          if (!("id" in msg)) {
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

      // Register dynamic tool
      router.registerTool(
        {
          name: "new_dynamic_tool",
          inputSchema: { type: "object" },
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
