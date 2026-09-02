import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import type { JsonRpcMessage, JsonRpcNotification } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";

function makeTestManifest(id: string, name: string): ToolManifest {
  const base = {
    id,
    name,
    version: "1.0.0",
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    runtime: {
      runtime: "node" as const,
      timeoutMs: 5000,
      memoryLimitMb: 128,
      cpuLimitPercent: 50,
      maxOutputSizeBytes: 1024 * 1024,
    },
    capabilities: {
      fs: { readOnly: true, allowWorkspaceRoot: true },
    },
    limits: {
      timeoutMs: 5000,
      maxMemoryBytes: 128 * 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxConcurrentInvocations: 1,
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    metadata: {},
  };
  const digest = computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("Gateway Refresh Coordinator End-to-End Integration", () => {
  it("orchestrates tools/list_changed notification dispatch and verification lifecycle", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-refresh-gw-"));
    try {
      const registry = new ToolRegistry({ debounceMs: 0 });
      const router = createRegistryGatewayRouter(registry);

      const gateway = new LocalMcpGateway({
        router,
        registry,
        refreshCoordinatorOptions: {
          debounceMs: 0,
          verificationTimeoutMs: 10_000,
        },
      });

      expect(gateway.refreshCoordinator).toBeDefined();

      const notificationsReceived: JsonRpcNotification[] = [];
      const connection = gateway.createConnection({
        connectionId: "conn-e2e",
        harnessId: "test-harness",
        cwd: tmpDir,
        sendMessage: (msg: JsonRpcMessage) => {
          if (!("id" in msg) || msg.id === undefined) {
            // SAFETY: Notification message has no id.
            notificationsReceived.push(msg as JsonRpcNotification);
          }
        },
      });

      // Initialize the connection with tools.listChanged capability and explicit isolated rootUri
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: true },
          },
          clientInfo: { name: "test-client", version: "1.0.0" },
          rootUri: pathToFileURL(tmpDir).href,
        },
      });
      await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      expect(connection.isInitialized).toBe(true);
      expect(connection.hasReceivedInitializedNotification).toBe(true);

      // Initial tools list
      const initialListResp = await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(initialListResp?.result).toBeDefined();

      // Now register a new tool in the registry for this workspace
      const manifest = makeTestManifest("tool_e2e_1", "e2e_test_tool");
      await registry.registerTool(manifest, undefined, {
        workspaceId: connection.workspaceContext.workspaceId,
      });

      // Allow async coordinator dispatch to settle
      const { promise: delayPromise, resolve: delayResolve } = Promise.withResolvers<void>();
      setTimeout(delayResolve, 50);
      await delayPromise;

      expect(notificationsReceived.length).toBeGreaterThanOrEqual(1);
      const listChangedNotif = notificationsReceived.find(
        (n) => n.method === "notifications/tools/list_changed",
      );
      expect(listChangedNotif).toBeDefined();

      const attempts = gateway.refreshCoordinator!.getAttempts({
        connectionId: connection.connectionId,
      });
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts[0]?.primaryOutcome).toBe("native_sent");

      const pendingVerifs = gateway.refreshCoordinator!.getVerifications({ status: "pending" });
      expect(pendingVerifs.length).toBeGreaterThanOrEqual(1);

      // Client responds to notification by requesting tools/list
      const updatedListResp = await gateway.handleMessage(connection.connectionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      });
      expect(updatedListResp?.result).toBeDefined();

      // Verifier should now observe tools/list
      const observedVerifs = gateway.refreshCoordinator!.getVerifications({ status: "observed" });
      expect(observedVerifs.length).toBeGreaterThanOrEqual(1);
      expect(observedVerifs[0]?.observedVia).toBe("tools_list");

      const updatedAttempts = gateway.refreshCoordinator!.getAttempts({
        connectionId: connection.connectionId,
      });
      expect(updatedAttempts[0]?.verificationStatus).toBe("observed");
      expect(updatedAttempts[0]?.outcomes).toContain("native_observed");

      gateway.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
