import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type { CallToolResult, JsonRpcSuccessResponse } from "../src/protocol/types.js";
import { FakeGatewayRouter } from "./fixtures/fake-router.js";

describe("release notice in tool results", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect(gateway: LocalMcpGateway): Promise<string> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "resin-release-notice-"));
    tmpDirs.push(cwd);
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
    return connection.connectionId;
  }

  async function echo(gateway: LocalMcpGateway, connectionId: string, id: number) {
    // SAFETY: A successful tools/call returns a CallToolResult.
    const response = (await gateway.handleMessage(connectionId, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hi" } },
    })) as JsonRpcSuccessResponse;
    // SAFETY: tools/call results are CallToolResult objects.
    return (response.result as unknown as CallToolResult).content.map((item) =>
      item.type === "text" ? item.text : item.type,
    );
  }

  it("appends a newly reported notice once per connection, and again for a different one", async () => {
    let notice: string | undefined;
    const gateway = new LocalMcpGateway({
      router: new FakeGatewayRouter(),
      enableRefreshCoordinator: false,
      releaseNotice: () => notice,
    });
    try {
      const first = await connect(gateway);
      await expect(echo(gateway, first, 2)).resolves.toEqual(["Echo: hi"]);

      notice = "Resin v1.1.0 was activated; restart this session.";
      await expect(echo(gateway, first, 3)).resolves.toEqual(["Echo: hi", notice]);
      await expect(echo(gateway, first, 4)).resolves.toEqual(["Echo: hi"]);

      const second = await connect(gateway);
      await expect(echo(gateway, second, 5)).resolves.toEqual(["Echo: hi", notice]);

      notice = "Resin v1.2.0 was activated; restart this session.";
      await expect(echo(gateway, first, 6)).resolves.toEqual(["Echo: hi", notice]);
    } finally {
      gateway.close();
    }
  });

  it("never lets a failing notice check affect the tool result", async () => {
    const gateway = new LocalMcpGateway({
      router: new FakeGatewayRouter(),
      enableRefreshCoordinator: false,
      releaseNotice: () => {
        throw new Error("pointer unreadable");
      },
    });
    try {
      const connectionId = await connect(gateway);
      await expect(echo(gateway, connectionId, 2)).resolves.toEqual(["Echo: hi"]);
    } finally {
      gateway.close();
    }
  });
});
