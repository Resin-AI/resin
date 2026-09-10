import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { describe, expect, it } from "vitest";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import { createManageToolsHandler } from "../../src/meta/manage-tools.js";
import { SYSTEM_META_TOOL_IDS } from "../../src/meta/system-tools.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const SYSTEM_META_IDS = [
  SYSTEM_META_TOOL_IDS.SEARCH_TOOLS,
  SYSTEM_META_TOOL_IDS.GET_TOOL_SCHEMA,
  SYSTEM_META_TOOL_IDS.INVOKE_TOOL,
  SYSTEM_META_TOOL_IDS.MANAGE_TOOLS,
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
];

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

  describe("compact list_versions discovery", () => {
    it("returns compact active summaries with bounded descriptions and metadata", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-compact");

      const longDescription = "A".repeat(250);
      const t1 = makeManifest({
        id: "tool_long_desc",
        name: "tool_long_desc",
        version: "1.0.0",
        description: longDescription,
      });
      const t2 = makeManifest({
        id: "tool_short",
        name: "tool_short",
        version: "1.2.0",
        description: "Short description",
      });

      await registry.registerTool(t1, undefined, { workspaceId: "ws-compact" });
      await registry.registerTool(t2, undefined, { workspaceId: "ws-compact" });

      const res = await handler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      expect(res.isError).toBeFalsy();
      // Compact JSON output must be unindented
      expect(res.content[0].text).not.toContain("\n");
      interface CompactResponse {
        tools: Array<{
          toolId: string;
          name: string;
          scope: string;
          version: string;
          description: string;
          isDisabled: boolean;
        }>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      }

      const data = parseContentJson<CompactResponse>(res);
      expect(data.total).toBe(2);
      expect(data.limit).toBe(20);
      expect(data.offset).toBe(0);
      expect(data.hasMore).toBe(false);
      expect(data.tools).toHaveLength(2);

      const longTool = data.tools.find((t) => t.toolId === "tool_long_desc");
      expect(longTool).toBeDefined();
      expect(longTool?.description.length).toBe(160);
      expect(longTool?.description).toBe("A".repeat(160));
      expect(longTool?.isDisabled).toBe(false);

      const shortTool = data.tools.find((t) => t.toolId === "tool_short");
      expect(shortTool).toBeDefined();
      expect(shortTool?.description).toBe("Short description");
      expect(shortTool?.version).toBe("1.2.0");
    });

    it("supports case-insensitive keyword filtering across IDs, names, and descriptions", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-query");

      await registry.registerTool(
        makeManifest({
          id: "git_diff_viewer",
          name: "Git Diff",
          description: "Inspect working tree diffs",
        }),
        undefined,
        { workspaceId: "ws-query" },
      );
      await registry.registerTool(
        makeManifest({
          id: "code_formatter",
          name: "Prettier Formatter",
          description: "Formats code cleanly",
        }),
        undefined,
        { workspaceId: "ws-query" },
      );
      await registry.registerTool(
        makeManifest({
          id: "search_replace",
          name: "Find & Replace",
          description: "Performs git grep search",
        }),
        undefined,
        { workspaceId: "ws-query" },
      );

      // Query matching ID and name
      const resGit = await handler(context, {
        action: "list_versions",
        query: "GIT",
      });
      const dataGit = parseContentJson<{ tools: Array<{ toolId: string }> }>(resGit);
      expect(dataGit.tools.map((t) => t.toolId).sort()).toEqual([
        "git_diff_viewer",
        "search_replace",
      ]);

      // Query matching description
      const resClean = await handler(context, {
        action: "list_versions",
        query: "cleanly",
      });
      const dataClean = parseContentJson<{ tools: Array<{ toolId: string }> }>(resClean);
      expect(dataClean.tools).toHaveLength(1);
      expect(dataClean.tools[0].toolId).toBe("code_formatter");

      // Query with no match
      const resNone = await handler(context, {
        action: "list_versions",
        query: "nonexistent_keyword_xyz",
      });
      const dataNone = parseContentJson<{ tools: Array<{ toolId: string }>; total: number }>(
        resNone,
      );
      expect(dataNone.tools).toHaveLength(0);
      expect(dataNone.total).toBe(0);
    });

    it("supports pagination with limit, offset, and deterministic stable sorting", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-page");

      for (let i = 1; i <= 5; i++) {
        await registry.registerTool(
          makeManifest({
            id: `tool_${i.toString().padStart(2, "0")}`,
            name: `Tool ${String.fromCharCode(64 + i)}`,
            description: `Description for ${i}`,
          }),
          undefined,
          { workspaceId: "ws-page" },
        );
      }

      // Page 1: limit 2, offset 0
      const page1 = parseContentJson<{
        tools: Array<{ name: string }>;
        total: number;
        hasMore: boolean;
      }>(
        await handler(context, {
          action: "list_versions",
          compact: true,
          limit: 2,
          offset: 0,
          excludeToolIds: SYSTEM_META_IDS,
        }),
      );
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.tools.map((t) => t.name)).toEqual(["Tool_A", "Tool_B"]);

      // Page 2: limit 2, offset 2
      const page2 = parseContentJson<{
        tools: Array<{ name: string }>;
        total: number;
        hasMore: boolean;
      }>(
        await handler(context, {
          action: "list_versions",
          compact: true,
          limit: 2,
          offset: 2,
          excludeToolIds: SYSTEM_META_IDS,
        }),
      );
      expect(page2.total).toBe(5);
      expect(page2.hasMore).toBe(true);
      expect(page2.tools.map((t) => t.name)).toEqual(["Tool_C", "Tool_D"]);

      // Page 3: limit 2, offset 4
      const page3 = parseContentJson<{
        tools: Array<{ name: string }>;
        total: number;
        hasMore: boolean;
      }>(
        await handler(context, {
          action: "list_versions",
          compact: true,
          limit: 2,
          offset: 4,
          excludeToolIds: SYSTEM_META_IDS,
        }),
      );
      expect(page3.total).toBe(5);
      expect(page3.hasMore).toBe(false);
      expect(page3.tools.map((t) => t.name)).toEqual(["Tool_E"]);
    });

    it("honors disabled policies and includeDisabled flag correctly", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-disabled");

      await registry.registerTool(
        makeManifest({ id: "tool_active", name: "tool_active" }),
        undefined,
        { workspaceId: "ws-disabled" },
      );
      await registry.registerTool(
        makeManifest({ id: "tool_disabled", name: "tool_disabled" }),
        undefined,
        { workspaceId: "ws-disabled" },
      );

      // Disable tool_disabled via control
      await handler(context, { action: "disable", toolId: "tool_disabled" });

      // Default includeDisabled: false
      const resActiveOnly = await handler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      const dataActiveOnly = parseContentJson<{
        tools: Array<{ toolId: string; isDisabled: boolean }>;
      }>(resActiveOnly);
      expect(dataActiveOnly.tools).toHaveLength(1);
      expect(dataActiveOnly.tools[0].toolId).toBe("tool_active");

      // Explicit includeDisabled: true
      const resWithDisabled = await handler(context, {
        action: "list_versions",
        compact: true,
        includeDisabled: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      const dataWithDisabled = parseContentJson<{
        tools: Array<{ toolId: string; isDisabled: boolean }>;
      }>(resWithDisabled);
      expect(dataWithDisabled.tools).toHaveLength(2);
      const disTool = dataWithDisabled.tools.find((t) => t.toolId === "tool_disabled");
      expect(disTool?.isDisabled).toBe(true);
    });

    it("preserves session scope without hiding or coercing to workspace", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context: WorkspaceContext = {
        ...makeContext("ws-session"),
        sessionId: "sess-123",
      };

      await registry.registerTool(
        makeManifest({ id: "ws_tool", name: "ws_tool", scope: "workspace" }),
        undefined,
        { workspaceId: "ws-session" },
      );
      await registry.registerTool(
        makeManifest({ id: "sess_tool", name: "sess_tool", scope: "session" }),
        undefined,
        { workspaceId: "ws-session", sessionId: "sess-123" },
      );

      const res = await handler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      expect(res.isError).toBeFalsy();
      const data = parseContentJson<{ tools: Array<{ toolId: string; scope: string }> }>(res);
      expect(data.tools).toHaveLength(2);
      const sessEntry = data.tools.find((t) => t.toolId === "sess_tool");
      expect(sessEntry?.scope).toBe("session");
      const wsEntry = data.tools.find((t) => t.toolId === "ws_tool");
      expect(wsEntry?.scope).toBe("workspace");
    });

    it("rejects invalid parameters cleanly without state mutation", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-invalid");

      // Invalid compact (string instead of boolean)
      const resCompact = await handler(context, {
        action: "list_versions",
        compact: "true" as unknown as boolean,
      });
      expect(resCompact.isError).toBe(true);
      expect(resCompact.content[0].text).toContain("Parameter 'compact' must be a boolean");

      // Invalid query (number instead of string)
      const resQuery = await handler(context, {
        action: "list_versions",
        query: 123 as unknown as string,
      });
      expect(resQuery.isError).toBe(true);
      expect(resQuery.content[0].text).toContain("Parameter 'query' must be a string");

      // Invalid limit (< 1)
      const resLimitLow = await handler(context, { action: "list_versions", limit: 0 });
      expect(resLimitLow.isError).toBe(true);
      expect(resLimitLow.content[0].text).toContain(
        "Parameter 'limit' must be an integer between 1 and 100",
      );

      // Invalid limit (> 100)
      const resLimitHigh = await handler(context, { action: "list_versions", limit: 101 });
      expect(resLimitHigh.isError).toBe(true);
      expect(resLimitHigh.content[0].text).toContain(
        "Parameter 'limit' must be an integer between 1 and 100",
      );

      // Invalid offset (negative)
      const resOffset = await handler(context, { action: "list_versions", offset: -1 });
      expect(resOffset.isError).toBe(true);
      expect(resOffset.content[0].text).toContain(
        "Parameter 'offset' must be a non-negative integer",
      );

      // Invalid includeDisabled (number)
      const resIncDis = await handler(context, {
        action: "list_versions",
        includeDisabled: 1 as unknown as boolean,
      });
      expect(resIncDis.isError).toBe(true);
      expect(resIncDis.content[0].text).toContain("Parameter 'includeDisabled' must be a boolean");
    });

    it("supports excludeToolIds filter applied before sort and pagination", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-exclude");

      await registry.registerTool(
        makeManifest({ id: "tool_alpha", name: "tool_alpha" }),
        undefined,
        { workspaceId: "ws-exclude" },
      );
      await registry.registerTool(makeManifest({ id: "tool_beta", name: "tool_beta" }), undefined, {
        workspaceId: "ws-exclude",
      });
      await registry.registerTool(
        makeManifest({ id: "tool_gamma", name: "tool_gamma" }),
        undefined,
        { workspaceId: "ws-exclude" },
      );

      const res = await handler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: [...SYSTEM_META_IDS, "tool_beta"],
      });
      expect(res.isError).toBeFalsy();
      const data = parseContentJson<{ tools: Array<{ toolId: string }>; total: number }>(res);
      expect(data.total).toBe(2);
      expect(data.tools.map((t) => t.toolId)).toEqual(["tool_alpha", "tool_gamma"]);
      expect(data.tools.some((t) => t.toolId === "tool_beta")).toBe(false);
    });

    it("rejects invalid excludeToolIds parameters cleanly", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-exclude-inv");

      const resStr = await handler(context, {
        action: "list_versions",
        excludeToolIds: "tool_beta" as unknown as string[],
      });
      expect(resStr.isError).toBe(true);
      expect(resStr.content[0].text).toContain(
        "Parameter 'excludeToolIds' must be an array of strings",
      );

      const resNum = await handler(context, {
        action: "list_versions",
        excludeToolIds: [123] as unknown as string[],
      });
      expect(resNum.isError).toBe(true);
      expect(resNum.content[0].text).toContain(
        "Parameter 'excludeToolIds' must be an array of strings",
      );
    });

    it("preserves authoritative pinned version from resolveCatalog in compact mode", async () => {
      const registry = new ToolRegistry();
      const handler = createManageToolsHandler(registry);
      const context = makeContext("ws-pin-test");

      const v1 = makeManifest({ id: "tool_pinned", name: "tool_pinned", version: "1.0.0" });
      const v2 = makeManifest({ id: "tool_pinned", name: "tool_pinned", version: "2.0.0" });

      await registry.registerTool(v1, undefined, { workspaceId: "ws-pin-test" });
      await registry.registerTool(v2, undefined, { workspaceId: "ws-pin-test" });

      // Pin version 1.0.0
      await handler(context, {
        action: "pin",
        toolId: "tool_pinned",
        version: "1.0.0",
      });

      // Compact discovery must return pinned version 1.0.0, not stale/unpinned version 2.0.0
      const res = await handler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      expect(res.isError).toBeFalsy();
      const data = parseContentJson<{ tools: Array<{ toolId: string; version: string }> }>(res);
      const pinned = data.tools.find((t) => t.toolId === "tool_pinned");
      expect(pinned).toBeDefined();
      expect(pinned?.version).toBe("1.0.0");
    });

    it("resolves name collisions in compact mode and verifies get_schema and invoke roundtrip", async () => {
      const registry = new ToolRegistry();
      const manageHandler = createManageToolsHandler(registry);
      const schemaHandler = createGetToolSchemaHandler(registry);
      const invokeHandler = createInvokeToolHandler(registry, {
        async invoke(request) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ toolId: request.toolId, parameters: request.parameters }),
              },
            ],
          };
        },
      });
      const context = makeContext("ws-collision-test");

      const tool1 = makeManifest({
        id: "tool_dup_one",
        name: "duplicate_name",
        description: "First tool with duplicate name",
      });
      const tool2 = makeManifest({
        id: "tool_dup_two",
        name: "duplicate_name",
        description: "Second tool with duplicate name",
      });

      await registry.registerTool(tool1, undefined, { workspaceId: "ws-collision-test" });
      await registry.registerTool(tool2, undefined, { workspaceId: "ws-collision-test" });

      const res = await manageHandler(context, {
        action: "list_versions",
        compact: true,
        excludeToolIds: SYSTEM_META_IDS,
      });
      expect(res.isError).toBeFalsy();
      const data = parseContentJson<{ tools: Array<{ toolId: string; name: string }> }>(res);
      expect(data.tools).toHaveLength(2);

      const names = data.tools.map((t) => t.name);
      expect(new Set(names).size).toBe(2);

      for (const t of data.tools) {
        // Roundtrip 1: get_tool_schema by discovered name
        const schemaRes = await schemaHandler(context, { name: t.name });
        expect(schemaRes.isError).toBeFalsy();
        const schema = parseContentJson<{ toolId: string; name: string }>(schemaRes);
        expect(schema.toolId).toBe(t.toolId);

        // Roundtrip 2: invoke_tool by discovered name
        const invokeRes = await invokeHandler(context, {
          name: t.name,
          parameters: { input: "test" },
        });
        expect(invokeRes.isError, JSON.stringify(invokeRes)).toBeFalsy();
        expect(parseContentJson(invokeRes)).toEqual({
          toolId: t.toolId,
          parameters: { input: "test" },
        });
      }
    });
  });
});
