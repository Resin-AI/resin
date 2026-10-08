import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import type { InvocationRecord, ToolManifest } from "@resin/contracts";
import { timeRecordedCall } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import { failedToolResult } from "../src/meta/invocation-failure.js";
import { MCP_ERROR_CODES, McpProtocolError } from "../src/protocol/errors.js";
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

  it("records a failed direct call with its reason, including one the routing layer threw", async () => {
    const records: InvocationRecord[] = [];
    const registry = new ToolRegistry({
      onInvocationRecorded: async (record) => {
        records.push(record);
      },
    });
    const gateway = new LocalMcpGateway({ router: createRegistryGatewayRouter(registry) });
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
    const register = (toolId: string, handler: () => Promise<CallToolResult>) =>
      registry.registerTool({
        toolId,
        name: toolId,
        exposedName: toolId,
        version: "1.0.0",
        scope: "workspace",
        workspaceId: wsId,
        status: "active",
        manifest: { ...makeManifest(), name: toolId },
        handler,
      });
    await register("tool_missing_artifact", async () =>
      failedToolResult("runtime_unavailable", "Artifact directory does not exist"),
    );
    await register("tool_offline", async () => {
      throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, "Cloud service is offline");
    });

    for (const [id, name] of [
      [2, "tool_missing_artifact"],
      [3, "tool_offline"],
    ] as const) {
      await gateway.handleMessage(conn.connectionId, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: { a: 1, b: 2 } },
      });
    }

    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    expect(
      records.map((record) => [record.toolId, record.status, record.errorDetails?.reason]),
    ).toEqual([
      ["tool_missing_artifact", "error", "runtime_unavailable"],
      ["tool_offline", "error", "runtime_unavailable"],
    ]);
    // The reason travels without any error text.
    expect(records.map((record) => record.errorDetails?.message)).toEqual(["", ""]);
  });

  it("records how long a direct call's recorded calls ran, and the caller never sees it", async () => {
    const records: InvocationRecord[] = [];
    const registry = new ToolRegistry({
      onInvocationRecorded: async (record) => {
        records.push(record);
      },
    });
    const gateway = new LocalMcpGateway({ router: createRegistryGatewayRouter(registry) });
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
    const register = (toolId: string, handler: () => Promise<CallToolResult>) =>
      registry.registerTool({
        toolId,
        name: toolId,
        exposedName: toolId,
        version: "1.0.0",
        scope: "workspace",
        workspaceId: wsId,
        status: "active",
        manifest: { ...makeManifest(), name: toolId },
        handler,
      });
    // Each runs one recorded call, then does Resin's own work after it.
    await register("tool_runs", async () => {
      await timeRecordedCall(() => sleep(120));
      await sleep(150);
      return { content: [{ type: "text", text: "ok" }] };
    });
    await register("tool_check_fails", async () => {
      await timeRecordedCall(() => sleep(120));
      await sleep(150);
      return failedToolResult("check_failed", "1 test failed");
    });
    await register("tool_lost", async () => {
      await timeRecordedCall(() => sleep(120));
      await sleep(150);
      throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, "Cloud service is offline");
    });
    await register("tool_refused", async () => failedToolResult("runtime_unavailable", "gone"));

    const responses: unknown[] = [];
    for (const [id, name] of [
      [2, "tool_runs"],
      [3, "tool_check_fails"],
      [4, "tool_lost"],
      [5, "tool_refused"],
    ] as const) {
      responses.push(
        await gateway.handleMessage(conn.connectionId, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: { a: 1, b: 2 } },
        }),
      );
    }
    await nextTurn();

    expect(records.map((record) => record.toolId)).toEqual([
      "tool_runs",
      "tool_check_fails",
      "tool_lost",
      "tool_refused",
    ]);
    for (const record of records.slice(0, 3)) {
      expect(record.executionDurationMs).toBeGreaterThanOrEqual(115);
      expect(record.executionDurationMs).toBeLessThan(260);
      expect(record.durationMs).toBeGreaterThanOrEqual(265);
    }
    expect(records[3]).not.toHaveProperty("executionDurationMs");
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toMatch(/executionDuration/i);
    }
  });
});
