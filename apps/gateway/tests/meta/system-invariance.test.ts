import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { LocalMcpGateway } from "../../src/gateway.js";
import { SYSTEM_META_TOOL_IDS } from "../../src/meta/system-tools.js";
import type { JsonRpcSuccessResponse, ListToolsResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const toolId = overrides?.id ?? "tool_custom";
  const raw = {
    id: toolId,
    name: overrides?.name ?? toolId,
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "A custom tool",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse(overrides?.capabilities ?? {}),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? {}),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T00:00:00.000Z",
  };

  return {
    ...raw,
    digest: computeManifestDigest(raw),
  };
}

describe("System Meta-Tools Invariance & Non-Shadowability", () => {
  it("always includes all 4 meta-tools in empty registry snapshot", async () => {
    const registry = new ToolRegistry();
    const snapshot = await registry.resolveCatalog("ws-empty");

    const expectedIds = Object.values(SYSTEM_META_TOOL_IDS);
    for (const toolId of expectedIds) {
      expect(snapshot.tools[toolId]).toBeDefined();
      expect(snapshot.tools[toolId].scope).toBe("global");
    }
  });

  it("always includes all 4 meta-tools when all generated tools in workspace are disabled", async () => {
    const registry = new ToolRegistry();
    const wsId = "ws-disabled-all";

    // Add multiple generated workspace tools
    const tool1 = makeManifest({ id: "gen_1", name: "gen_1" });
    const tool2 = makeManifest({ id: "gen_2", name: "gen_2" });
    await registry.registerTool(tool1, undefined, { workspaceId: wsId });
    await registry.registerTool(tool2, undefined, { workspaceId: wsId });

    // Disable all generated tools
    await registry.disableTool("gen_1", wsId);
    await registry.disableTool("gen_2", wsId);

    const snapshot = await registry.resolveCatalog(wsId);

    // Generated tools must be absent
    expect(snapshot.tools.gen_1).toBeUndefined();
    expect(snapshot.tools.gen_2).toBeUndefined();

    // All 4 system meta-tools MUST still be present
    expect(snapshot.tools.sys_search_tools).toBeDefined();
    expect(snapshot.tools.sys_get_tool_schema).toBeDefined();
    expect(snapshot.tools.sys_invoke_tool).toBeDefined();
    expect(snapshot.tools.sys_manage_tools).toBeDefined();
  });

  it("prevents custom workspace tools from shadowing system meta-tool names", async () => {
    const registry = new ToolRegistry();
    const wsId = "ws-collision";

    // User attempts to register a workspace tool named 'search_tools'
    const collidingTool = makeManifest({
      id: "user_search_tools",
      name: "search_tools",
      description: "User tool trying to shadow search_tools",
    });
    await registry.registerTool(collidingTool, undefined, { workspaceId: wsId });

    const snapshot = await registry.resolveCatalog(wsId);

    // System search_tools keeps its exact canonical exposed name
    expect(snapshot.entries).toBeDefined();
    const sysEntry = snapshot.entries?.sys_search_tools;
    expect(sysEntry).toBeDefined();
    expect(sysEntry?.exposedName).toBe("search_tools");

    // The colliding user tool gets disambiguated with a scope prefix
    const collidingEntry = snapshot.entries?.user_search_tools;
    expect(collidingEntry).toBeDefined();
    expect(collidingEntry?.exposedName).not.toBe("search_tools");
    expect(collidingEntry?.exposedName).toContain("search_tools");
  });

  it("strictly prohibits direct registry mutation on system meta-tools", async () => {
    const registry = new ToolRegistry();
    const wsId = "ws-protect";

    await expect(registry.disableTool("search_tools", wsId)).rejects.toThrow(
      "Cannot disable invariant system meta-tool 'search_tools'",
    );

    await expect(registry.pinToolVersion("get_tool_schema", "1.0.0", wsId)).rejects.toThrow(
      "Cannot pin invariant system meta-tool 'get_tool_schema'",
    );

    await expect(registry.unpinToolVersion("invoke_tool", wsId)).rejects.toThrow(
      "Cannot unpin invariant system meta-tool 'invoke_tool'",
    );

    await expect(registry.rollbackTool("manage_tools", "1.0.0", wsId)).rejects.toThrow(
      "Cannot rollback invariant system meta-tool 'manage_tools'",
    );
  });

  it("serves all 4 meta-tools over JSON-RPC MCP gateway tools/list and tools/call", async () => {
    const registry = new ToolRegistry();
    const router = createRegistryGatewayRouter(registry);
    const gateway = new LocalMcpGateway({ router });
    const conn = gateway.createConnection({ cwd: "/workspaces/ws-mcp" });

    // Initialize MCP
    await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    // tools/list
    const listRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })) as JsonRpcSuccessResponse<ListToolsResult>;

    expect(listRes.result.tools).toHaveLength(4);
    const toolNames = listRes.result.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["search_tools", "get_tool_schema", "invoke_tool", "manage_tools"]),
    );

    // Call search_tools via tools/call
    const callRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_tools",
        arguments: {},
      },
    })) as JsonRpcSuccessResponse<{ content: Array<{ type: string; text: string }> }>;

    expect(callRes.result.content[0].text).toContain('"total": 4');
    expect(callRes.result.content[0].text).toContain('"search_tools"');

    // Call get_tool_schema via tools/call
    const schemaRes = (await gateway.handleMessage(conn.connectionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_tool_schema",
        arguments: { toolId: "sys_search_tools" },
      },
    })) as JsonRpcSuccessResponse<{ content: Array<{ type: string; text: string }> }>;

    expect(schemaRes.result.content[0].text).toContain('"name": "search_tools"');
    expect(schemaRes.result.content[0].text).toContain('"inputSchema"');
  });
});
