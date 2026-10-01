import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOmpCatalogInstructions } from "@resin/adapter-omp";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { RESIN_LEARNED_TOOL_META, RESIN_SEARCH_LISTING_META } from "../../src/protocol/types.js";
import type { ProductionProxyRuntime } from "../../src/proxy/runtime.js";

describe("OMP learned-tool block on connect", () => {
  it("leaves the block alone until the catalog is loaded, then syncs it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-connect-block-"));
    const appendSystem = path.join(root, "APPEND_SYSTEM.md");
    const original =
      "User notes\n<!-- resin:catalog:start -->\n### `retired_tool`\n<!-- resin:catalog:end -->\n";
    fs.writeFileSync(appendSystem, original);
    const loaded = Promise.withResolvers<void>();
    const awaitingCatalog = Promise.withResolvers<void>();
    // SAFETY: The gateway only calls these members of the runtime on this path.
    const cloudRuntime = {
      onWorkspaceReady: async () => {},
      whenCatalogLoaded: () => {
        awaitingCatalog.resolve();
        return loaded.promise;
      },
      stop: async () => {},
    } as unknown as ProductionProxyRuntime;
    const gateway = new LocalMcpGateway({
      // The cloud has not answered yet, so the registry holds no learned tools.
      router: { listTools: async () => [], callTool: async () => ({ content: [] }) },
      cloudRuntime,
      refreshCoordinatorOptions: {
        adapters: {
          omp: {
            harnessId: "omp",
            syncCatalogInstructions: async (_workspace, instructions) => {
              await applyOmpCatalogInstructions({
                ...instructions,
                appendSystemPath: appendSystem,
              });
            },
          },
        },
      },
    });
    try {
      const connection = gateway.createConnection({
        connectionId: "conn-omp",
        cwd: root,
        sendMessage: () => {},
      });
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "omp-coding-agent", version: "18.3.5" },
          capabilities: {},
        },
      });
      expect(connection.harnessId).toBe("omp");

      // The connect-time sync is parked on the catalog load; nothing has been written.
      await awaitingCatalog.promise;
      expect(fs.readFileSync(appendSystem, "utf8")).toBe(original);

      loaded.resolve();
      await expect.poll(() => fs.readFileSync(appendSystem, "utf8")).toBe("User notes\n");
    } finally {
      gateway.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    { searchListing: false, expected: "User notes\n<!-- resin:catalog:start -->" },
    { searchListing: true, expected: "User notes\n" },
  ])(
    "on connect, writes the learned-tool block only when the client lists learned tools (searchListing=$searchListing)",
    async ({ searchListing, expected }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-connect-block-"));
      const appendSystem = path.join(root, "APPEND_SYSTEM.md");
      fs.writeFileSync(
        appendSystem,
        "User notes\n<!-- resin:catalog:start -->\n### `stale_tool`\n<!-- resin:catalog:end -->\n",
      );
      const gateway = new LocalMcpGateway({
        router: {
          listTools: async () => [
            {
              name: "release_notes",
              description: "Drafts release notes.",
              inputSchema: { type: "object" },
              _meta: { [RESIN_LEARNED_TOOL_META]: true },
            },
          ],
          callTool: async () => ({ content: [] }),
        },
        refreshCoordinatorOptions: {
          adapters: {
            omp: {
              harnessId: "omp",
              syncCatalogInstructions: async (_workspace, instructions) => {
                await applyOmpCatalogInstructions({
                  ...instructions,
                  appendSystemPath: appendSystem,
                });
              },
            },
          },
        },
      });
      try {
        const connection = gateway.createConnection({
          connectionId: "conn-omp",
          cwd: root,
          sendMessage: () => {},
        });
        await gateway.handleMessage(connection.connectionId, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            clientInfo: { name: "omp-coding-agent", version: "18.3.5" },
            capabilities: {},
            ...(searchListing ? { _meta: { [RESIN_SEARCH_LISTING_META]: true } } : {}),
          },
        });
        expect(connection.searchListing).toBe(searchListing);
        await expect
          .poll(() => fs.readFileSync(appendSystem, "utf8"))
          .toSatisfy((text: string) =>
            searchListing
              ? text === expected
              : text.startsWith(expected) && text.includes("### `release_notes`"),
          );
      } finally {
        gateway.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
