import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import type { CallToolResult, McpTool } from "../../src/protocol/types.js";
import type { CatalogNoticeTool, GatewayRouter } from "../../src/router.js";

const LEARNED: CatalogNoticeTool = {
  name: "run_vitest_tests",
  inputSchema: { type: "object", properties: {} },
  _meta: { "resin/learned": true },
  localCommands: ["vitest"],
};

class CatalogRouter implements GatewayRouter {
  tools: CatalogNoticeTool[] = [LEARNED];
  private readonly listeners = new Set<() => void>();
  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }
  async listCatalogNoticeTools(): Promise<CatalogNoticeTool[]> {
    return this.tools;
  }
  async callTool(): Promise<CallToolResult> {
    return { content: [] };
  }
  onToolListChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  change(tools: CatalogNoticeTool[]): void {
    this.tools = tools;
    for (const listener of this.listeners) listener();
  }
}

describe("gateway catalog observer", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands every known listing to onCatalogListed, including after a catalog change", async () => {
    const router = new CatalogRouter();
    const observed = vi.fn();
    const gateway = new LocalMcpGateway({
      router,
      enableRefreshCoordinator: false,
      onCatalogListed: observed,
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "resin-suggest-gateway-"));
    tmpDirs.push(cwd);
    try {
      const connection = gateway.createConnection({ cwd });
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-client" },
          capabilities: {},
          rootUri: pathToFileURL(cwd).href,
        },
      });
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(observed).toHaveBeenCalled();
      const [context, tools] = observed.mock.calls.at(-1) ?? [];
      expect(context.startupPath).toBe(cwd);
      expect(tools).toEqual([LEARNED]);

      observed.mockClear();
      router.change([]);
      await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(expect.anything(), []));
    } finally {
      gateway.close();
    }
  });

  it("serves the listing even when the observer throws", async () => {
    const gateway = new LocalMcpGateway({
      router: new CatalogRouter(),
      enableRefreshCoordinator: false,
      onCatalogListed: () => {
        throw new Error("disk full");
      },
    });
    try {
      const connection = gateway.createConnection({ cwd: os.tmpdir() });
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "c" }, capabilities: {} },
      });
      const response = await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect(response && "result" in response).toBe(true);
    } finally {
      gateway.close();
    }
  });
});
