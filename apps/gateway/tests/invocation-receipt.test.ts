import {
  type InvocationRecord,
  RESIN_INVOCATION_RECEIPT_META_KEY,
  type ToolManifest,
  bytesToTokens,
  estimatePayloadBytes,
  readResinInvocationReceipt,
  readResinInvocationReceipts,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type { ToolInvocationRequest } from "../src/meta/router-contract.js";
import { createSystemMetaTools } from "../src/meta/system-tools.js";
import { MCP_ERROR_CODES, McpProtocolError } from "../src/protocol/errors.js";
import type {
  CallToolResult,
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
} from "../src/protocol/types.js";
import { RESIN_BENCHMARK_ID_META } from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { createRegistryGatewayRouter } from "../src/router.js";

function makeManifest(name: string): ToolManifest {
  return {
    name,
    version: "1.0.0",
    description: `Runs ${name}`,
    runtime: { type: "node", version: ">=18" },
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
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

/** What a learned tool returns, by its name, on either call path. */
async function runLearned(name: string, value: unknown, signal?: AbortSignal) {
  if (name === "tool_fails") {
    return { isError: true, content: [{ type: "text" as const, text: `failed ${value}` }] };
  }
  if (name === "tool_throws") {
    throw new McpProtocolError(MCP_ERROR_CODES.CONNECTION_CLOSED, "Cloud service is offline");
  }
  if (name === "tool_hangs") {
    const aborted = Promise.withResolvers<never>();
    signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
    await aborted.promise;
  }
  return { content: [{ type: "text" as const, text: `ran ${value}` }] };
}

async function setup(options: { benchmarkId?: unknown; releaseNotice?: string } = {}) {
  const records: InvocationRecord[] = [];
  const onInvocationRecorded = async (record: InvocationRecord) => {
    records.push(record);
  };
  const registry = new ToolRegistry({ onInvocationRecorded });
  // invoke_tool runs learned tools through this router; direct calls run their handlers.
  const invocationRouter = {
    invoke: (request: ToolInvocationRequest): Promise<CallToolResult> =>
      runLearned(request.name, request.parameters.value, request.signal),
  };
  for (const tool of createSystemMetaTools(
    registry,
    invocationRouter,
    undefined,
    onInvocationRecorded,
  )) {
    registry.registerToolSync(tool);
  }
  const gateway = new LocalMcpGateway({
    router: createRegistryGatewayRouter(registry),
    ...(options.releaseNotice === undefined ? {} : { releaseNotice: () => options.releaseNotice }),
  });
  const conn = gateway.createConnection({ cwd: "/tmp/workspace" });
  await gateway.handleMessage(conn.connectionId, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "1.0.0" },
      ...(options.benchmarkId === undefined
        ? {}
        : { _meta: { [RESIN_BENCHMARK_ID_META]: options.benchmarkId } }),
    },
  });
  const workspaceId = conn.workspaceContext.workspaceId;
  for (const toolId of ["tool_ok", "tool_fails", "tool_throws", "tool_hangs"]) {
    await registry.registerTool({
      toolId,
      name: toolId,
      exposedName: toolId,
      version: "1.0.0",
      scope: "workspace",
      workspaceId,
      status: "active",
      manifest: makeManifest(toolId),
      handler: async (_context, params, callOptions) =>
        runLearned(toolId, params.value, callOptions?.signal),
    });
  }
  let nextId = 1;
  const send = (name: string, args: Record<string, unknown>) =>
    gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await send(name, args)) as JsonRpcSuccessResponse<CallToolResult>).result;
  const settled = async () => {
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
  };
  return { records, send, call, settled };
}

describe("invocation receipts", () => {
  it("returns the recorded invocation id on direct and invoke_tool calls, distinct per call", async () => {
    const { records, call, settled } = await setup();
    const direct = await call("tool_ok", { value: "a" });
    const alias = await call("invoke_tool", { name: "tool_ok", parameters: { value: "a" } });
    const repeat = await call("tool_ok", { value: "a" });
    await settled();

    expect(records).toHaveLength(3);
    const receipts = [direct, alias, repeat].map((result) => readResinInvocationReceipt(result));
    expect(receipts.map((receipt) => receipt?.invocationId)).toEqual(
      records.map((record) => record.invocationId),
    );
    expect(new Set(records.map((record) => record.invocationId)).size).toBe(3);
    for (const [index, result] of [direct, alias, repeat].entries()) {
      // The tool's own output is untouched; the receipt is one more part, mirrored in `_meta`.
      expect(result.content[0]).toEqual({ type: "text", text: "ran a" });
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({
        type: "text",
        text: JSON.stringify({ resinInvocationId: records[index]!.invocationId }),
      });
      expect(result._meta?.[RESIN_INVOCATION_RECEIPT_META_KEY]).toEqual({
        version: 1,
        invocationId: records[index]!.invocationId,
      });
      expect(result.isError).toBeUndefined();
      expect(records[index]!.benchmarkId).toBeUndefined();
    }
  });

  it("carries a receipt on every failure the caller receives", async () => {
    const { records, call, send, settled } = await setup();
    const results: CallToolResult[] = [
      await call("tool_fails", { value: "x" }),
      await call("invoke_tool", { name: "tool_fails", parameters: { value: "x" } }),
      await call("invoke_tool", { name: "tool_throws", parameters: { value: "x" } }),
      await call("invoke_tool", {
        name: "tool_hangs",
        parameters: { value: "x" },
        timeout_ms: 5,
      }),
      await call("invoke_tool", { name: "tool_ok", parameters: {} }),
    ];
    const thrown = (await send("tool_throws", { value: "x" })) as JsonRpcErrorResponse;
    await settled();

    expect(records.map((record) => [record.toolId, record.status])).toEqual([
      ["tool_fails", "error"],
      ["tool_fails", "error"],
      ["tool_throws", "error"],
      ["tool_hangs", "timeout"],
      ["tool_ok", "error"],
      ["tool_throws", "error"],
    ]);
    expect(results.map((result) => result.isError)).toEqual([true, true, true, true, true]);
    expect(results.map((result) => readResinInvocationReceipt(result)?.invocationId)).toEqual(
      records.slice(0, 5).map((record) => record.invocationId),
    );
    expect(results[0]!.content[0]).toEqual({ type: "text", text: "failed x" });
    // A direct call the routing layer threw keeps its JSON-RPC code and message; the receipt
    // travels in the error's data.
    expect(thrown.error.code).toBe(MCP_ERROR_CODES.CONNECTION_CLOSED);
    expect(thrown.error.message).toBe("Cloud service is offline");
    expect(thrown.error.data).toEqual({ resinInvocationId: records[5]!.invocationId });
  });

  it("estimates output usage from what the caller received, receipt included, once", async () => {
    const { records, call, settled } = await setup();
    const direct = await call("tool_ok", { value: "payload" });
    const alias = await call("invoke_tool", { name: "tool_ok", parameters: { value: "payload" } });
    await settled();

    for (const [index, result] of [direct, alias].entries()) {
      const delivered = bytesToTokens(estimatePayloadBytes(result.content)!);
      const withoutReceipt = bytesToTokens(estimatePayloadBytes(result.content.slice(0, 1))!);
      expect(records[index]!.usageEstimate?.outputTokens).toBe(delivered);
      expect(delivered).toBeGreaterThan(withoutReceipt);
    }
  });

  it("marks receipts and records with the connection's benchmark id, dropping an invalid one", async () => {
    const marked = await setup({ benchmarkId: "goal-matrix.resin-arm:3" });
    const direct = await marked.call("tool_ok", { value: "a" });
    const alias = await marked.call("invoke_tool", {
      name: "tool_fails",
      parameters: { value: "a" },
    });
    await marked.settled();
    expect(marked.records.map((record) => record.benchmarkId)).toEqual([
      "goal-matrix.resin-arm:3",
      "goal-matrix.resin-arm:3",
    ]);
    for (const [index, result] of [direct, alias].entries()) {
      expect(readResinInvocationReceipt(result)).toEqual({
        invocationId: marked.records[index]!.invocationId,
        benchmarkId: "goal-matrix.resin-arm:3",
      });
      expect(result.content.at(-1)).toEqual({
        type: "text",
        text: JSON.stringify({
          resinInvocationId: marked.records[index]!.invocationId,
          benchmarkId: "goal-matrix.resin-arm:3",
        }),
      });
    }

    const invalid = await setup({ benchmarkId: "../not a benchmark" });
    const unmarked = await invalid.call("tool_ok", { value: "a" });
    await invalid.settled();
    expect(invalid.records[0]!.benchmarkId).toBeUndefined();
    expect(readResinInvocationReceipt(unmarked)).toEqual({
      invocationId: invalid.records[0]!.invocationId,
    });
  });

  it("gives each for_each run its own receipt, in run order", async () => {
    const { records, call, settled } = await setup();
    const direct = await call("tool_ok", { for_each: { value: ["a", "b"] } });
    const alias = await call("invoke_tool", {
      name: "tool_ok",
      parameters: { for_each: { value: ["c", "d"] } },
    });
    await settled();

    expect(records).toHaveLength(4);
    expect(direct._meta?.[RESIN_INVOCATION_RECEIPT_META_KEY]).toBeUndefined();
    expect(readResinInvocationReceipts(direct).map((receipt) => receipt.invocationId)).toEqual(
      records.slice(0, 2).map((record) => record.invocationId),
    );
    expect(readResinInvocationReceipts(alias).map((receipt) => receipt.invocationId)).toEqual(
      records.slice(2, 4).map((record) => record.invocationId),
    );
    // The receipts stay out of the combined text.
    expect(direct.content[0]!.type === "text" && direct.content[0]!.text).not.toContain("inv_");
  });

  it("never tags discovery calls, and keeps receipts after a release notice", async () => {
    const { records, call, settled } = await setup({ releaseNotice: "Resin 9.9.9 is out." });
    const noticed = await call("tool_ok", { value: "a" });
    const search = await call("search_tools", { query: "anything" });
    const aliasSearch = await call("invoke_tool", {
      name: "search_tools",
      parameters: { query: "anything" },
    });
    await settled();

    expect(records).toHaveLength(1);
    expect(noticed.content.map((part) => part.type === "text" && part.text)).toEqual([
      "ran a",
      "Resin 9.9.9 is out.",
      JSON.stringify({ resinInvocationId: records[0]!.invocationId }),
    ]);
    for (const result of [search, aliasSearch]) {
      expect(result._meta?.[RESIN_INVOCATION_RECEIPT_META_KEY]).toBeUndefined();
      expect(readResinInvocationReceipts(result)).toEqual([]);
    }
  });
});
