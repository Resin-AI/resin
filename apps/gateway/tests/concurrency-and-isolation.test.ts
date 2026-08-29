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
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

describe("Multi-Client Concurrency & Workspace Isolation", () => {
  it("isolates workspace context between concurrent connections", async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "resin-concurr-a-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "resin-concurr-b-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });

      // Client 1 in Repo A
      const connA = gateway.createConnection({ cwd: tmpA });
      await gateway.handleMessage(connA.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "claude-code" },
          capabilities: {},
          rootUri: pathToFileURL(tmpA).href,
        },
      });

      // Client 2 in Repo B
      const connB = gateway.createConnection({ cwd: tmpB });
      await gateway.handleMessage(connB.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "openai-codex" },
          capabilities: {},
          rootUri: pathToFileURL(tmpB).href,
        },
      });

      // Verify independent workspace IDs
      expect(connA.workspaceContext.workspaceId).not.toBe(connB.workspaceContext.workspaceId);
      expect(connA.workspaceContext.canonicalRoot).toBe(connA.workspaceContext.projectRoot);
      expect(connB.workspaceContext.canonicalRoot).toBe(connB.workspaceContext.projectRoot);

      // Call workspace_info tool on each
      const resA = (await gateway.handleMessage(connA.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workspace_info" },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      const resB = (await gateway.handleMessage(connB.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workspace_info" },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      const infoA = JSON.parse(resA.result.content[0].text);
      const infoB = JSON.parse(resB.result.content[0].text);

      expect(infoA.workspaceId).toBe(connA.workspaceContext.workspaceId);
      expect(infoB.workspaceId).toBe(connB.workspaceContext.workspaceId);
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });

  it("enforces workspace-scoped tool isolation", async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "resin-scope-a-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "resin-scope-b-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });

      const connA = gateway.createConnection({ cwd: tmpA });
      await gateway.handleMessage(connA.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "client-a" },
          capabilities: {},
          rootUri: pathToFileURL(tmpA).href,
        },
      });

      const connB = gateway.createConnection({ cwd: tmpB });
      await gateway.handleMessage(connB.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "client-b" },
          capabilities: {},
          rootUri: pathToFileURL(tmpB).href,
        },
      });

      // Register a tool scoped only to Workspace Alpha
      router.registerTool(
        {
          name: "alpha_exclusive_tool",
          inputSchema: { type: "object" },
        },
        async () => ({ content: [{ type: "text", text: "alpha secret" }] }),
        connA.workspaceContext.workspaceId,
      );

      // Calling from A should succeed
      const callA = (await gateway.handleMessage(connA.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "alpha_exclusive_tool" },
      })) as JsonRpcSuccessResponse<CallToolResult>;

      expect(callA.error).toBeUndefined();
      expect(callA.result.content[0].text).toBe("alpha secret");

      // Calling from B should fail
      const callB = (await gateway.handleMessage(connB.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "alpha_exclusive_tool" },
      })) as JsonRpcErrorResponse;

      expect(callB.error).toBeDefined();
      expect(callB.error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });

  it("enforces rate limits on rapid requests", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-concurr-rate-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({
        router,
        rateLimitBurst: 4,
        rateLimitRps: 1,
      });
      const conn = gateway.createConnection({ cwd: tmpDir });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client" },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      // 3 rapid requests should pass (capacity 4 - 1 for init = 3 remaining)
      const r1 = await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "ping",
      });
      expect(r1?.error).toBeUndefined();

      const r2 = await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "ping",
      });
      expect(r2?.error).toBeUndefined();

      const r3 = await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 4,
        method: "ping",
      });
      expect(r3?.error).toBeUndefined();

      // 4th should be rate limited
      const r4 = (await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: 5,
        method: "ping",
      })) as JsonRpcErrorResponse;

      expect(r4.error).toBeDefined();
      expect(r4.error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
