import type { InvocationRecord, ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type { CallToolResult, JsonRpcSuccessResponse } from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { createRegistryGatewayRouter } from "../src/router.js";

function makeManifest(): ToolManifest {
  return {
    name: "calculator_add",
    version: "1.0.0",
    description: "Adds numbers",
    runtime: { type: "node", version: ">=18" },
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowTemp: false,
        allowWorkspaceRoot: false,
        denyPaths: [],
      },
      net: { allowedHosts: [], allowLoopback: false, denyHosts: [], allowedPorts: [] },
      command: {
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowShellExecution: false,
        allowEnvPassthrough: [],
      },
      secrets: { requiredSecrets: [], optionalSecrets: [], allowCustomSecrets: false },
      limits: {
        maxMemoryMb: 128,
        maxExecutionTimeMs: 5000,
        maxOutputSizeBytes: 1024 * 1024,
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 80,
      },
    },
  };
}

describe("direct tools/call invocation records", () => {
  it("records a direct call to an evolved tool exactly like invoke_tool, and never a system tool", async () => {
    // Harnesses call evolved tools by name; the savings ledger is built from these
    // records, so a direct call must leave one behind.
    const records: InvocationRecord[] = [];
    const registry = new ToolRegistry({
      onInvocationRecorded: async (record) => {
        records.push(record);
      },
    });
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection({ cwd: "/tmp/workspace" });
    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-harness", version: "1.0.0" },
      },
    });
    const wsId = conn.workspaceContext.workspaceId;
    await registry.registerTool({
      toolId: "tool_calc",
      name: "calculator_add",
      exposedName: "calculator_add",
      version: "1.0.0",
      scope: "workspace",
      workspaceId: wsId,
      status: "active",
      manifest: makeManifest(),
      handler: async () => ({ content: [{ type: "text", text: "42" }] }),
    });

    const direct = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "calculator_add", arguments: { a: 40, b: 2 } },
    })) as JsonRpcSuccessResponse<CallToolResult>;
    expect(direct.result.content[0].text).toBe("42");

    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_tools", arguments: {} },
    });

    // Recording is fire-and-forget; let the microtask settle.
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      toolId: "tool_calc",
      toolVersion: "1.0.0",
      workspaceId: wsId,
      status: "success",
    });
    expect(records[0]!.invocationId).toMatch(/^inv_[0-9a-f]{32}$/);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(records[0]!.inputDigest).toHaveLength(64);
  });
});
