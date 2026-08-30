import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { type SearchToolsResponse, createSearchToolsHandler } from "../../src/meta/search-tools.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function parseSearchResponse(result: CallToolResult): SearchToolsResponse {
  const first = result.content[0];
  const text =
    first && "text" in first && Object.prototype.toString.call(first.text) === "[object String]"
      ? String(first.text)
      : "{}";
  // SAFETY: Test helper parses JSON response into SearchToolsResponse domain object.
  return JSON.parse(text) as SearchToolsResponse;
}

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const raw = {
    id: overrides?.id ?? "tool_custom",
    name: overrides?.name ?? "custom_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "A custom utility tool",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          input: { type: "string", description: "Input value" },
        },
        required: ["input"],
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

function makeContext(workspaceId = "ws-alpha", sessionId?: string): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
    sessionId,
  };
}

describe("search_tools Meta-Tool", () => {
  it("returns invariant system meta-tools by default", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-alpha");

    const result = await handler(context, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");

    const data = parseSearchResponse(result);
    expect(data.total).toBe(4);
    expect(data.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_tools", "get_tool_schema", "invoke_tool", "manage_tools"]),
    );
  });

  it("strictly enforces workspace isolation and never leaks other workspaces' tools", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);

    // Register tool in workspace A
    const toolA = makeManifest({
      id: "tool_alpha",
      name: "alpha_exclusive_tool",
      description: "Only for Alpha workspace",
    });
    await registry.registerTool(toolA, undefined, { workspaceId: "ws-alpha" });

    // Register tool in workspace B
    const toolB = makeManifest({
      id: "tool_beta",
      name: "beta_secret_tool",
      description: "Only for Beta workspace",
    });
    await registry.registerTool(toolB, undefined, { workspaceId: "ws-beta" });

    // Caller in workspace A searches
    const contextA = makeContext("ws-alpha");
    const resA = await handler(contextA, {});
    const dataA = parseSearchResponse(resA);

    const namesA = dataA.tools.map((t) => t.name);
    expect(namesA).toContain("alpha_exclusive_tool");
    expect(namesA).not.toContain("beta_secret_tool");

    // Caller in workspace B searches
    const contextB = makeContext("ws-beta");
    const resB = await handler(contextB, {});
    const dataB = parseSearchResponse(resB);

    const namesB = dataB.tools.map((t) => t.name);
    expect(namesB).toContain("beta_secret_tool");
    expect(namesB).not.toContain("alpha_exclusive_tool");
  });

  it("strictly enforces session isolation", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);

    const toolSess1 = makeManifest({
      id: "tool_sess_1",
      name: "session_1_tool",
      scope: "session",
    });
    await registry.registerTool(toolSess1, undefined, {
      workspaceId: "ws-shared",
      sessionId: "session-1",
      scope: "session",
    });

    const contextSess1 = makeContext("ws-shared", "session-1");
    const res1 = await handler(contextSess1, {});
    const data1 = parseSearchResponse(res1);
    expect(data1.tools.some((t) => t.name === "session_1_tool")).toBe(true);

    const contextSess2 = makeContext("ws-shared", "session-2");
    const res2 = await handler(contextSess2, {});
    const data2 = parseSearchResponse(res2);
    expect(data2.tools.some((t) => t.name === "session_1_tool")).toBe(false);
  });

  it("supports pagination with limit, offset, total, and hasMore", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-page");

    // Add 10 tools
    for (let i = 1; i <= 10; i++) {
      const tool = makeManifest({
        id: `tool_page_${i}`,
        name: `paginated_tool_${i}`,
        description: `Page test tool ${i}`,
      });
      await registry.registerTool(tool, undefined, { workspaceId: "ws-page" });
    }

    // Page 1: limit 5, offset 0
    const page1Res = await handler(context, { limit: 5, offset: 0 });
    const page1Data = parseSearchResponse(page1Res);
    expect(page1Data.total).toBe(14); // 10 custom + 4 system
    expect(page1Data.tools).toHaveLength(5);
    expect(page1Data.limit).toBe(5);
    expect(page1Data.offset).toBe(0);
    expect(page1Data.hasMore).toBe(true);

    // Page 2: limit 5, offset 5
    const page2Res = await handler(context, { limit: 5, offset: 5 });
    const page2Data = parseSearchResponse(page2Res);
    expect(page2Data.tools).toHaveLength(5);
    expect(page2Data.offset).toBe(5);
    expect(page2Data.hasMore).toBe(true);

    // Page 3: limit 5, offset 10
    const page3Res = await handler(context, { limit: 5, offset: 10 });
    const page3Data = parseSearchResponse(page3Res);
    expect(page3Data.tools).toHaveLength(4);
    expect(page3Data.hasMore).toBe(false);
  });

  it("ranks exact name match highest, followed by prefix and substring", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-rank");

    await registry.registerTool(
      makeManifest({ id: "t1", name: "format_json", description: "Formats JSON data" }),
      undefined,
      { workspaceId: "ws-rank" },
    );
    await registry.registerTool(
      makeManifest({
        id: "t2",
        name: "format_json_pretty",
        description: "Pretty printer for JSON",
      }),
      undefined,
      { workspaceId: "ws-rank" },
    );
    await registry.registerTool(
      makeManifest({ id: "t3", name: "convert_xml_to_format_json", description: "Converter tool" }),
      undefined,
      { workspaceId: "ws-rank" },
    );
    await registry.registerTool(
      makeManifest({ id: "t4", name: "csv_parser", description: "Parses format_json strings" }),
      undefined,
      { workspaceId: "ws-rank" },
    );

    const res = await handler(context, { query: "format_json" });
    const data = parseSearchResponse(res);

    expect(data.tools[0].name).toBe("format_json");
    expect(data.tools[1].name).toBe("format_json_pretty");
    expect(data.tools[2].name).toBe("convert_xml_to_format_json");
    expect(data.tools[3].name).toBe("csv_parser");
  });

  it("filters by capabilities and tags correctly", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-caps");

    await registry.registerTool(
      makeManifest({
        id: "net_tool",
        name: "github_fetcher",
        description: "Fetches from GitHub",
        capabilities: {
          net: {
            allowedHosts: ["api.github.com"],
            allowedPorts: [443],
            allowOutbound: true,
          },
        },
        metadata: {
          tags: ["github", "api", "vcs"],
        },
      }),
      undefined,
      { workspaceId: "ws-caps" },
    );

    await registry.registerTool(
      makeManifest({
        id: "fs_tool",
        name: "file_cleaner",
        description: "Cleans temp files",
        capabilities: {
          fs: {
            readPaths: ["/tmp"],
            writePaths: ["/tmp"],
            allowWorkspaceRoot: false,
            allowTemp: true,
          },
        },
        metadata: {
          tags: ["cleanup", "disk"],
        },
      }),
      undefined,
      { workspaceId: "ws-caps" },
    );

    // Filter by tag
    const tagRes = await handler(context, { tags: ["github"] });
    const tagData = parseSearchResponse(tagRes);
    expect(tagData.tools.map((t) => t.name)).toContain("github_fetcher");
    expect(tagData.tools.map((t) => t.name)).not.toContain("file_cleaner");

    // Filter by capability
    const capRes = await handler(context, { capabilities: ["filesystem"] });
    const capData = parseSearchResponse(capRes);
    expect(capData.tools.map((t) => t.name)).toContain("file_cleaner");
    expect(capData.tools.map((t) => t.name)).not.toContain("github_fetcher");
  });

  it("generates structured capability summaries for tools", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-summary");

    await registry.registerTool(
      makeManifest({
        id: "tool_caps_summary",
        name: "s3_syncer",
        capabilities: {
          net: {
            allowedHosts: ["s3.amazonaws.com"],
            allowedPorts: [443],
            allowOutbound: true,
          },
          fs: {
            readPaths: ["/data"],
            writePaths: [],
            allowWorkspaceRoot: false,
            allowTemp: false,
          },
        },
      }),
      undefined,
      { workspaceId: "ws-summary" },
    );

    const res = await handler(context, { query: "s3_syncer" });
    const data = parseSearchResponse(res);
    const tool = data.tools.find((t) => t.name === "s3_syncer");
    expect(tool).toBeDefined();
    expect(tool?.capabilities.types).toEqual(expect.arrayContaining(["network", "filesystem"]));
    expect(tool?.capabilities.network?.allowedHosts).toContain("s3.amazonaws.com");
    expect(tool?.capabilities.filesystem?.readOnly).toBe(true);
    expect(tool?.capabilities.filesystem?.allowedPaths).toContain("/data");
  });
});
