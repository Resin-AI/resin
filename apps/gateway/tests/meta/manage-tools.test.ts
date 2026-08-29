import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { describe, expect, it } from "vitest";
import { createManageToolsHandler } from "../../src/meta/manage-tools.js";
import type { CallToolResult, JsonRpcParams } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function parseContentJson<T = JsonRpcParams>(result: CallToolResult): T {
  const first = result.content[0];
  const text =
    first && "text" in first && Object.prototype.toString.call(first.text) === "[object String]"
      ? String(first.text)
      : "{}";
  // SAFETY: Test helper parses JSON text from CallToolResult into typed object.
  return JSON.parse(text) as T;
}

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const toolId = overrides?.id ?? "tool_manage";
  const raw = {
    id: toolId,
    name: overrides?.name ?? toolId,
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Tool for management testing",
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

function makeContext(workspaceId = "ws-manage"): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
  };
}

describe("manage_tools Meta-Tool", () => {
  it("lists all installed versions for a tool and overall workspace", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context = makeContext("ws-manage");

    const v1 = makeManifest({ id: "tool_alpha", name: "tool_alpha", version: "1.0.0" });
    const v2 = makeManifest({ id: "tool_alpha", name: "tool_alpha", version: "2.0.0" });
    const v3 = makeManifest({ id: "tool_beta", name: "tool_beta", version: "1.0.0" });

    await registry.registerTool(v1, undefined, { workspaceId: "ws-manage" });
    await registry.registerTool(v2, undefined, { workspaceId: "ws-manage" });
    await registry.registerTool(v3, undefined, { workspaceId: "ws-manage" });

    // List single tool versions
    const resSingle = await handler(context, {
      action: "list_versions",
      toolId: "tool_alpha",
    });
    expect(resSingle.isError).toBeFalsy();
    const dataSingle = parseContentJson<{
      toolId: string;
      installedVersions: Array<{ version: string }>;
    }>(resSingle);
    expect(dataSingle.toolId).toBe("tool_alpha");
    expect(dataSingle.installedVersions).toHaveLength(2);
    expect(dataSingle.installedVersions.map((v: { version: string }) => v.version)).toEqual([
      "1.0.0",
      "2.0.0",
    ]);

    // List all workspace tools
    const resAll = await handler(context, { action: "list_versions" });
    expect(resAll.isError).toBeFalsy();
    const dataAll = parseContentJson<Record<string, Array<{ version: string }>>>(resAll);
    expect(dataAll.tools.some((t: { toolId: string }) => t.toolId === "tool_alpha")).toBe(true);
    expect(dataAll.tools.some((t: { toolId: string }) => t.toolId === "tool_beta")).toBe(true);
  });

  it("inspects status of a tool including active version, pins, and disabled state", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context = makeContext("ws-status");

    const tool = makeManifest({ id: "tool_stat", name: "stat_tool", version: "1.0.0" });
    await registry.registerTool(tool, undefined, { workspaceId: "ws-status" });

    const res = await handler(context, { action: "status", toolId: "tool_stat" });
    expect(res.isError).toBeFalsy();
    const data = parseContentJson<{
      toolId: string;
      activeVersion: string;
      pinnedVersion?: string;
      isDisabled: boolean;
    }>(res);
    expect(data.toolId).toBe("tool_stat");
    expect(data.activeVersion).toBe("1.0.0");
    expect(data.pinnedVersion).toBeUndefined();
    expect(data.isDisabled).toBe(false);
  });

  it("pins and unpins a tool version, persisting to SQLite across registry restart", async () => {
    const db = await createInMemoryStateStore();
    const registry1 = new ToolRegistry({ db });
    const handler1 = createManageToolsHandler(registry1);
    const context = makeContext("ws-pin-test");

    const v1 = makeManifest({ id: "tool_pin", version: "1.0.0" });
    const v2 = makeManifest({ id: "tool_pin", version: "2.0.0" });

    await registry1.registerTool(v1, undefined, { workspaceId: "ws-pin-test" });
    await registry1.registerTool(v2, undefined, { workspaceId: "ws-pin-test" });

    // Pin to v1
    const pinRes = await handler1(context, {
      action: "pin",
      toolId: "tool_pin",
      version: "1.0.0",
    });
    expect(pinRes.isError).toBeFalsy();

    // Verify pinned in registry 1 catalog
    const cat1 = await registry1.resolveCatalog("ws-pin-test");
    expect(cat1.tools.tool_pin.version).toBe("1.0.0");

    // Restart gateway with new ToolRegistry sharing the same SQLite DB
    const registry2 = new ToolRegistry({ db });
    await registry2.registerTool(v1, undefined, { workspaceId: "ws-pin-test" });
    await registry2.registerTool(v2, undefined, { workspaceId: "ws-pin-test" });

    const cat2 = await registry2.resolveCatalog("ws-pin-test");
    expect(cat2.tools.tool_pin.version).toBe("1.0.0");

    // Unpin in registry 2
    const handler2 = createManageToolsHandler(registry2);
    const unpinRes = await handler2(context, {
      action: "unpin",
      toolId: "tool_pin",
    });
    expect(unpinRes.isError).toBeFalsy();

    const cat3 = await registry2.resolveCatalog("ws-pin-test");
    expect(cat3.tools.tool_pin.version).toBe("2.0.0");
  });

  it("disables and enables a tool, persisting to SQLite across restart", async () => {
    const db = await createInMemoryStateStore();
    const registry1 = new ToolRegistry({ db });
    const handler1 = createManageToolsHandler(registry1);
    const context = makeContext("ws-dis-test");

    const tool = makeManifest({ id: "tool_dis_test", name: "dis_tool" });
    await registry1.registerTool(tool, undefined, { workspaceId: "ws-dis-test" });

    // Disable tool
    const disRes = await handler1(context, {
      action: "disable",
      toolId: "tool_dis_test",
    });
    expect(disRes.isError).toBeFalsy();

    const cat1 = await registry1.resolveCatalog("ws-dis-test");
    expect(cat1.tools.tool_dis_test).toBeUndefined();

    // Restart gateway
    const registry2 = new ToolRegistry({ db });
    await registry2.registerTool(tool, undefined, { workspaceId: "ws-dis-test" });

    const cat2 = await registry2.resolveCatalog("ws-dis-test");
    expect(cat2.tools.tool_dis_test).toBeUndefined();

    // Enable tool
    const handler2 = createManageToolsHandler(registry2);
    const enableRes = await handler2(context, {
      action: "enable",
      toolId: "tool_dis_test",
    });
    expect(enableRes.isError).toBeFalsy();

    const cat3 = await registry2.resolveCatalog("ws-dis-test");
    expect(cat3.tools.tool_dis_test).toBeDefined();
  });

  it("rolls back tool to a previous version and records rollback in history", async () => {
    const db = await createInMemoryStateStore();
    const registry = new ToolRegistry({ db });
    const handler = createManageToolsHandler(registry);
    const context = makeContext("ws-rollback");

    const v1 = makeManifest({ id: "tool_roll", version: "1.0.0" });
    const v2 = makeManifest({ id: "tool_roll", version: "2.0.0" });

    await registry.registerTool(v1, undefined, { workspaceId: "ws-rollback" });
    await registry.registerTool(v2, undefined, { workspaceId: "ws-rollback" });

    // Active version is currently 2.0.0
    const catInitial = await registry.resolveCatalog("ws-rollback");
    expect(catInitial.tools.tool_roll.version).toBe("2.0.0");

    // Rollback to v1
    const rollRes = await handler(context, {
      action: "rollback",
      toolId: "tool_roll",
      version: "1.0.0",
    });
    expect(rollRes.isError).toBeFalsy();

    const catPostRoll = await registry.resolveCatalog("ws-rollback");
    expect(catPostRoll.tools.tool_roll.version).toBe("1.0.0");

    // Check status contains rollback record
    const statusRes = await handler(context, {
      action: "status",
      toolId: "tool_roll",
    });
    const statusData = parseContentJson<{
      activeVersion: string;
      rollbacks: Array<{ restoredSnapshotId: string }>;
    }>(statusRes);
    expect(statusData.activeVersion).toBe("1.0.0");
    expect(statusData.rollbacks).toHaveLength(1);
    expect(statusData.rollbacks[0].restoredSnapshotId).toBe("1.0.0");
  });

  it("clears user overrides via clear_override action", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context = makeContext("ws-clear");

    const v1 = makeManifest({ id: "tool_override", version: "1.0.0" });
    const v2 = makeManifest({ id: "tool_override", version: "2.0.0" });

    await registry.registerTool(v1, undefined, { workspaceId: "ws-clear" });
    await registry.registerTool(v2, undefined, { workspaceId: "ws-clear" });

    // Pin and disable
    await handler(context, { action: "pin", toolId: "tool_override", version: "1.0.0" });
    await handler(context, { action: "disable", toolId: "tool_override" });
    const statusPre = parseContentJson<{ pinnedVersion?: string; isDisabled?: boolean }>(
      await handler(context, { action: "status", toolId: "tool_override" }),
    );
    expect(statusPre.pinnedVersion).toBe("1.0.0");
    expect(statusPre.isDisabled).toBe(true);

    // Clear overrides
    const clearRes = await handler(context, { action: "clear_override", toolId: "tool_override" });
    expect(clearRes.isError).toBeFalsy();
    const statusPost = parseContentJson<{
      pinnedVersion?: string;
      isDisabled?: boolean;
      activeVersion?: string;
    }>(await handler(context, { action: "status", toolId: "tool_override" }));
    expect(statusPost.pinnedVersion).toBeUndefined();
    expect(statusPost.isDisabled).toBe(false);
    expect(statusPost.activeVersion).toBe("2.0.0");
  });

  it("strictly rejects disabling, pinning, unpinning, or rolling back invariant system meta-tools", async () => {
    const registry = new ToolRegistry();
    const handler = createManageToolsHandler(registry);
    const context = makeContext("ws-sys-protect");

    // Attempt to disable search_tools
    const disRes = await handler(context, { action: "disable", toolId: "search_tools" });
    expect(disRes.isError).toBe(true);
    expect(disRes.content[0].text).toContain("Cannot disable invariant system meta-tool");

    // Attempt to pin get_tool_schema
    const pinRes = await handler(context, {
      action: "pin",
      toolId: "get_tool_schema",
      version: "1.0.0",
    });
    expect(pinRes.isError).toBe(true);
    expect(pinRes.content[0].text).toContain("Cannot pin invariant system meta-tool");

    // Attempt to unpin invoke_tool
    const unpinRes = await handler(context, { action: "unpin", toolId: "invoke_tool" });
    expect(unpinRes.isError).toBe(true);
    expect(unpinRes.content[0].text).toContain("Cannot unpin invariant system meta-tool");

    // Attempt to rollback manage_tools
    const rollRes = await handler(context, {
      action: "rollback",
      toolId: "manage_tools",
      version: "0.1.0",
    });
    expect(rollRes.isError).toBe(true);
    expect(rollRes.content[0].text).toContain("Cannot rollback invariant system meta-tool");
  });
});
