import {
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  SAFETY_GATE_ERROR_CODES,
  type ToolManifest,
} from "@resin/contracts";
import { SafetyGateEvaluator, createSafetyAttestation } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../src/gateway.js";
import type {
  CallToolResult,
  JsonRpcSuccessResponse,
  ListToolsResult,
} from "../src/protocol/types.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { createRegistryGatewayRouter } from "../src/router.js";

function makeManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: "calculator_add",
    version: "1.0.0",
    description: "Adds numbers",
    runtime: { type: "node", version: ">=18" },
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
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
    ...overrides,
  };
}

describe("Gateway Safety Gate Interception", () => {
  it("allows system meta-tools but blocks generated tool invocation when gate is fail-closed", async () => {
    // Fail-closed evaluator with missing attestation
    const safetyGate = new SafetyGateEvaluator({ attestation: null });
    const registry = new ToolRegistry({ safetyGateEvaluator: safetyGate });
    const router = createRegistryGatewayRouter(registry, undefined, safetyGate);
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

    // Register a generated tool in the active workspace
    await registry.registerTool({
      toolId: "tool_calc",
      name: "calculator_add",
      exposedName: "calculator_add",
      version: "1.0.0",
      scope: "workspace",
      workspaceId: wsId,
      status: "active",
      manifest: makeManifest(),
      handler: async () => ({
        content: [{ type: "text", text: "42" }],
      }),
    });

    // 1. System meta-tools (search_tools, get_tool_schema, manage_tools) are usable
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const searchRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_tools",
        arguments: {},
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;
    expect(searchRes.result.isError).toBeFalsy();
    expect(searchRes.result.content[0].text).toContain("calculator_add");

    // 2. Direct invocation of generated tool is blocked with structured refusal
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const directCall = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "calculator_add",
        arguments: { a: 40, b: 2 },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(directCall.result.isError).toBe(true);
    expect(directCall.result.content[0].text).toContain("[SAFETY GATE REFUSAL]");
    expect(directCall.result._meta?.refusal).toBeDefined();

    // 3. Indirect invocation via invoke_tool is also intercepted
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const invokeToolCall = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "invoke_tool",
        arguments: { name: "calculator_add", parameters: { a: 1, b: 1 } },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(invokeToolCall.result.isError).toBe(true);
    expect(invokeToolCall.result.content[0].text).toContain("[SAFETY GATE REFUSAL]");
    // 4. manage_tools status includes safety gate status
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const manageStatus = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "manage_tools",
        arguments: {
          action: "status",
          toolId: "calculator_add",
        },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;
    expect(manageStatus.result.isError).toBeFalsy();
    const statusPayload = JSON.parse(manageStatus.result.content[0].text);
    expect(statusPayload.safetyGate).toBeDefined();
    expect(statusPayload.safetyGate.isOpen).toBe(false);
    expect(statusPayload.safetyGate.status).toBe("uninitialized");
  });

  it("permits generated tool execution when a valid attestation is provided", async () => {
    const validAttestation = createSafetyAttestation();
    const safetyGate = new SafetyGateEvaluator({ attestation: validAttestation });
    const registry = new ToolRegistry({ safetyGateEvaluator: safetyGate });
    const router = createRegistryGatewayRouter(registry, undefined, safetyGate);
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
      handler: async () => ({
        content: [{ type: "text", text: "42" }],
      }),
    });
    // When safety gate gives true, execution proceeds
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const callRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "calculator_add",
        arguments: { a: 42, b: 42 },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.result.isError).toBeFalsy();
    expect(callRes.result.content[0].text).toBe("42");
  });

  it("permits generated tool execution when unsafe development override is active", async () => {
    const safetyGate = new SafetyGateEvaluator({
      attestation: null,
      allowUnsafeDevOverride: true,
    });
    const registry = new ToolRegistry({ safetyGateEvaluator: safetyGate });
    const router = createRegistryGatewayRouter(registry, undefined, safetyGate);
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
      handler: async () => ({
        content: [{ type: "text", text: "84" }],
      }),
    });
    // Call approved tool
    // SAFETY: Gateway response is confirmed to be CallToolResult.
    const callRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "calculator_add",
        arguments: { a: 42, b: 42 },
      },
    })) as JsonRpcSuccessResponse<CallToolResult>;

    expect(callRes.result.isError).toBeFalsy();
    expect(callRes.result.content[0].text).toBe("84");
  });
});
