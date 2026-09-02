import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { JSON_RPC_ERROR_CODES } from "../src/protocol/errors.js";
import type {
  InitializeResult,
  JsonRpcErrorResponse,
  JsonRpcParams,
  JsonRpcSuccessResponse,
} from "../src/protocol/types.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

describe("MCP Initialization & Capability Negotiation", () => {
  it("initializes successfully with Claude Code client", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-claude-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      const initReq = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: {
            name: "claude-code",
            version: "1.0.4",
          },
          capabilities: {
            roots: { listChanged: true },
          },
          rootUri: pathToFileURL(tmpDir).href,
        },
      };
      // SAFETY: Gateway response is confirmed to be InitializeResult success response.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        initReq,
      )) as JsonRpcSuccessResponse<InitializeResult>;
      expect(resp.error).toBeUndefined();
      expect(resp.result.protocolVersion).toBe("2024-11-05");
      expect(resp.result.capabilities.tools?.listChanged).toBe(true);
      expect(resp.result.serverInfo.name).toBe("resin-mcp");
      expect(conn.harnessId).toBe("claude-code");
      expect(conn.isInitialized).toBe(true);
      expect(conn.hasReceivedInitializedNotification).toBe(false);
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(conn.hasReceivedInitializedNotification).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes successfully with Codex CLI client", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-codex-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      const initReq = {
        jsonrpc: "2.0" as const,
        id: "codex-init-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: {
            name: "openai-codex-cli",
            version: "0.9.0",
          },
          capabilities: {},
          rootUri: pathToFileURL(tmpDir).href,
        },
      };
      // SAFETY: Gateway response is confirmed to be InitializeResult success response.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        initReq,
      )) as JsonRpcSuccessResponse<InitializeResult>;
      expect(resp.error).toBeUndefined();
      expect(conn.harnessId).toBe("codex");
      expect(conn.isInitialized).toBe(true);
      expect(conn.hasReceivedInitializedNotification).toBe(false);
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(conn.hasReceivedInitializedNotification).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes successfully with Oh My Pi (OMP) client", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-omp-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      const initReq = {
        jsonrpc: "2.0" as const,
        id: "omp-init-0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: {
            name: "oh-my-pi",
            version: "2.0.0",
          },
          capabilities: {
            roots: { listChanged: true },
          },
          rootUri: pathToFileURL(tmpDir).href,
        },
      };
      // SAFETY: Gateway response is confirmed to be InitializeResult success response.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        initReq,
      )) as JsonRpcSuccessResponse<InitializeResult>;
      expect(resp.error).toBeUndefined();
      expect(conn.harnessId).toBe("omp");
      expect(conn.isInitialized).toBe(true);
      expect(conn.hasReceivedInitializedNotification).toBe(false);
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(conn.hasReceivedInitializedNotification).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not emit tool-list notifications before the initialized notification", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-order-"));
    try {
      const methods: string[] = [];
      const gatewayRef: { current?: LocalMcpGateway } = {};
      const gateway = new LocalMcpGateway({
        router: new FakeGatewayRouter(),
        onWorkspaceReady: async () => gatewayRef.current?.broadcastToolListChanged(),
      });
      gatewayRef.current = gateway;
      const conn = gateway.createConnection({
        cwd: tmpDir,
        sendMessage: (message) => {
          if ("method" in message) methods.push(message.method);
        },
      });

      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id: "ordered-init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "oh-my-pi", version: "18.1.3" },
          capabilities: { tools: { listChanged: true } },
          rootUri: pathToFileURL(tmpDir).href,
        },
      });

      expect(conn.isInitialized).toBe(true);
      expect(conn.hasReceivedInitializedNotification).toBe(false);
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(conn.hasReceivedInitializedNotification).toBe(true);
      gateway.broadcastToolListChanged();
      expect(methods).toEqual(["notifications/tools/list_changed"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects tool calls prior to initialize request", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-reject-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      const listReq = {
        jsonrpc: "2.0" as const,
        id: 10,
        method: "tools/list",
        params: {},
      };
      // SAFETY: Gateway response is confirmed to be JsonRpcErrorResponse for uninitialized tools/list.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        listReq,
      )) as JsonRpcErrorResponse;
      expect(resp.result).toBeUndefined();
      expect(resp.error).toBeDefined();
      expect(resp.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles ping request", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-init-ping-"));
    try {
      const router = new FakeGatewayRouter();
      const gateway = new LocalMcpGateway({ router });
      const conn = gateway.createConnection({ cwd: tmpDir });

      const pingReq = {
        jsonrpc: "2.0" as const,
        id: "ping-1",
        method: "ping",
        params: {},
      };
      // SAFETY: Gateway response is confirmed to be JsonRpcSuccessResponse for ping request.
      const resp = (await gateway.handleMessage(
        conn.connectionId,
        pingReq,
      )) as JsonRpcSuccessResponse<JsonRpcParams>;
      expect(resp.error).toBeUndefined();
      expect(resp.result).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
