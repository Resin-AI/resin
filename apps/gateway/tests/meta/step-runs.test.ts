/**
 * Every surface describing a learned tool says every step it runs. A tool described as linting
 * Lua files (`lint_lua_source_2`) also started a Studio playtest and ran a recorded server script;
 * each surface now adds `Runs: …` when the purpose leaves a step unnamed.
 */
import { PassThrough } from "node:stream";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
  listingTextTokens,
  listingToolTokens,
} from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalMcpGateway } from "../../src/gateway.js";
import { learnedToolListing, searchListingInstructions } from "../../src/listing-surface.js";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { type SearchToolsResponse, createSearchToolsHandler } from "../../src/meta/search-tools.js";
import type { ToolProfile } from "../../src/meta/tool-profile.js";
import { McpFrameDecoder, encodeMcpMessage } from "../../src/protocol/framing.js";
import type { CallToolResult, JsonRpcMessage } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type GatewayRouter, createRegistryGatewayRouter } from "../../src/router.js";
import {
  type ServedListingSurface,
  createToolSearchSurface,
} from "../../src/shim/tool-search-surface.js";
import { stepRunsSummary, withStepRuns } from "../../src/step-runs.js";
import { suggestToolsFromCatalog } from "../../src/suggest/index-writer.js";
import { renderPromptBlock } from "../../src/suggest/prompt.js";
import { renderSuggestion } from "../../src/suggest/render.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const ALPHA = "a".repeat(64);

vi.mock("../../src/meta/repository-identity.js", () => ({
  repositoryIdentity: (dir: string) =>
    dir === "/repos/alpha" || dir.startsWith("/repos/alpha/")
      ? { id: "a".repeat(64), root: "/repos/alpha" }
      : undefined,
}));

const WORKSPACE = "ws-steps";
const caller = {
  workspaceId: WORKSPACE,
  projectId: WORKSPACE,
  projectRoot: "/repos/alpha",
  canonicalRoot: "/repos/alpha",
  startupPath: "/repos/alpha",
  isReadOnly: false,
  name: WORKSPACE,
  source: "cwd_fallback",
  roots: [{ uri: "file:///repos/alpha", path: "/repos/alpha", name: WORKSPACE }],
  sessionId: "ses_steps",
} as WorkspaceContext;

const LINT_PURPOSE =
  "Runs stylua {source_directory} to format Lua files and selene {lint_targets} to lint them, showing only the last three lines of lint output.";
const LINT_RUNS = [
  "stylua",
  "selene",
  "robloxstudio.solo_playtest",
  "robloxstudio.eval_server_runtime",
  "robloxstudio.solo_playtest",
];
const RUNS_CLAUSE =
  "Runs: stylua, selene, robloxstudio.solo_playtest, robloxstudio.eval_server_runtime, robloxstudio.solo_playtest.";
/** A recorded argument and a private value of the plan: neither may be served. */
const RECORDED = /canary|print\(|"start"/u;

function makeManifest(id: string, name: string, description: string): ToolManifest {
  const raw = {
    id,
    name,
    version: "1.0.0",
    description,
    parameters: ToolParameterSchema.parse({
      type: "object",
      properties: { source_directory: { type: "string" }, lint_targets: { type: "string" } },
    }),
    runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
    capabilities: CapabilityManifestSchema.parse({}),
    limits: ToolLimitConfigSchema.parse({}),
    scope: "workspace" as const,
    metadata: { repositories: [ALPHA] },
    createdAt: "2026-10-09T00:00:00.000Z",
  };
  return { ...raw, digest: computeManifestDigest(raw) };
}

/**
 * `lint_lua_source_2`, whose purpose names only its shell step, and `format_lua`, whose purpose
 * names both commands its one step runs.
 */
async function registry(): Promise<ToolRegistry> {
  const tools = new ToolRegistry();
  await tools.registerTool(
    makeManifest("tool_lint", "lint_lua_source_2", LINT_PURPOSE),
    undefined,
    { workspaceId: WORKSPACE },
  );
  await tools.registerTool(
    makeManifest("tool_format", "format_lua", "Runs stylua and selene on the Lua sources."),
    undefined,
    { workspaceId: WORKSPACE },
  );
  const profiles: Record<string, ToolProfile> = {
    tool_lint: { steps: 4, runs: LINT_RUNS, locatedRepositories: [] },
    tool_format: { steps: 1, runs: ["stylua", "selene"], locatedRepositories: [] },
  };
  tools.setLocalToolProfile((tool) => profiles[toolIdOf(tool)]);
  tools.setLocalToolCommands((tool) => (toolIdOf(tool) in profiles ? ["stylua", "selene"] : []));
  tools.setLocalToolPrivateValues(() => ['print("canaryservercode")']);
  return tools;
}

/** The registry hands profile readers the whole registered tool; these fixtures key by its id. */
function toolIdOf(tool: object): string {
  return "toolId" in tool && typeof tool.toolId === "string" ? tool.toolId : "";
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && "text" in first ? String(first.text) : "";
}

describe("step runs summary", () => {
  it("collapses consecutive repeats and leaves a purpose naming every step unchanged", () => {
    expect(
      stepRunsSummary([
        "robloxstudio.get_connected_instances",
        ...Array.from({ length: 5 }, () => "robloxstudio.execute_luau"),
        "stylua",
        "selene",
      ]),
    ).toBe("robloxstudio.get_connected_instances, robloxstudio.execute_luau x5, stylua, selene");
    expect(withStepRuns("Runs `stylua` and Selene.", ["stylua", "selene"])).toBe(
      "Runs `stylua` and Selene.",
    );
    // An MCP step is named by its tool; a word inside another word does not name it.
    expect(withStepRuns("Starts solo_playtest.", ["robloxstudio.solo_playtest"])).toBe(
      "Starts solo_playtest.",
    );
    expect(withStepRuns("Runs styluarc", ["stylua"])).toBe("Runs styluarc. Runs: stylua.");
    expect(withStepRuns(LINT_PURPOSE, LINT_RUNS)).toBe(`${LINT_PURPOSE} ${RUNS_CLAUSE}`);
    expect(withStepRuns(LINT_PURPOSE, undefined)).toBe(LINT_PURPOSE);
  });
});

describe("a learned tool whose purpose leaves a step unnamed", () => {
  it("says every step in its tools/list definition, and not for a purpose naming them all", async () => {
    const tools = await createRegistryGatewayRouter(await registry()).listCatalogNoticeTools(
      caller,
    );
    const lint = tools.find((tool) => tool.name === "lint_lua_source_2");
    const format = tools.find((tool) => tool.name === "format_lua");
    expect(lint?.description).toBe(
      `Optional inputs: source_directory (string), lint_targets (string); omitted ones reuse recorded values. ${LINT_PURPOSE} Replaces 4 recorded steps. ${RUNS_CLAUSE}`,
    );
    expect(lint?.listing).toEqual({
      purpose: `${LINT_PURPOSE} Replaces 4 recorded steps.`,
      signature: "{source_directory?: string, lint_targets?: string}",
      runs: LINT_RUNS,
    });
    expect(format?.description).toBe(
      "Optional inputs: source_directory (string), lint_targets (string); omitted ones reuse recorded values. Runs stylua and selene on the Lua sources.",
    );
    expect(JSON.stringify(tools)).not.toMatch(RECORDED);
  });

  it("says every step in search results, the item and a similar tool", async () => {
    const response = JSON.parse(
      textOf(await createSearchToolsHandler(await registry())(caller, { query: "stylua selene" })),
    ) as SearchToolsResponse;
    expect(response.tools).toHaveLength(1);
    const item = response.tools[0];
    // The tool replacing more recorded work leads; the other runs the same commands.
    expect(item?.name).toBe("lint_lua_source_2");
    expect(item?.description).toBe(`${LINT_PURPOSE} ${RUNS_CLAUSE}`);
    expect(item?.similar?.map((tool) => [tool.name, tool.purpose])).toEqual([
      ["format_lua", "Runs stylua and selene on the Lua sources."],
    ]);
    expect(JSON.stringify(response)).not.toMatch(RECORDED);

    // Listed under another tool, it still says every step.
    const formatFirst = await registry();
    formatFirst.setLocalToolProfile((tool) =>
      toolIdOf(tool) === "tool_lint"
        ? { runs: LINT_RUNS, locatedRepositories: [] }
        : { steps: 9, runs: ["stylua", "selene"], locatedRepositories: [] },
    );
    const similar = (
      JSON.parse(
        textOf(await createSearchToolsHandler(formatFirst)(caller, { query: "stylua selene" })),
      ) as SearchToolsResponse
    ).tools[0]?.similar;
    expect(similar?.map((tool) => [tool.name, tool.purpose])).toEqual([
      [
        "lint_lua_source_2",
        "Runs stylua {source_directory} to format Lua files and selene {lint_targets} to lint them, showing only the last three lines of lint output. Runs: stylua, selene, robloxstudio.solo_playtest, robloxstudio.eval_server_runtime, robloxstudio.solo_playtest.",
      ],
    ]);
  });

  it("says every step in its get_tool_schema docs", async () => {
    const getSchema = createGetToolSchemaHandler(await registry());
    const lint = JSON.parse(textOf(await getSchema(caller, { name: "lint_lua_source_2" })));
    // Its first paragraph is the purpose; the `for_each` usage follows.
    expect(lint.description.split("\n")[0]).toBe(`${LINT_PURPOSE} ${RUNS_CLAUSE}`);
    const format = JSON.parse(textOf(await getSchema(caller, { name: "format_lua" })));
    expect(format.description.split("\n")[0]).toBe("Runs stylua and selene on the Lua sources.");
  });

  it("says every step in prompt-time and command-time suggestions", async () => {
    const tools = await createRegistryGatewayRouter(await registry()).listCatalogNoticeTools(
      caller,
    );
    const indexed = suggestToolsFromCatalog(tools);
    const lint = indexed.find((tool) => tool.name === "lint_lua_source_2");
    const format = indexed.find((tool) => tool.name === "format_lua");
    expect(lint?.runs).toEqual(LINT_RUNS);
    const block = renderPromptBlock(indexed, "omp", true)?.text;
    expect(block).toBe(
      [
        "Resin learned tools for this repository (to run one, write <call> to xd://mcp__resin_invoke_tool):",
        '- {"name":"format_lua","parameters":{}} — Runs stylua and selene on the Lua sources.',
        `- {"name":"lint_lua_source_2","parameters":{}} — Runs stylua {source_directory} to format Lua files and selene {lint_targets} to lint them… ${RUNS_CLAUSE}`,
      ].join("\n"),
    );
    expect(
      renderSuggestion(
        { tool: lint!, covered: ["stylua", "selene"], alsoRuns: [], skip: [] },
        "omp",
      ),
    ).toBe(
      `Resin, next time: learned tool lint_lua_source_2 runs \`stylua\`, \`selene\`; write {"name":"lint_lua_source_2","parameters":{}} to xd://mcp__resin_invoke_tool. ${RUNS_CLAUSE}`,
    );
    expect(
      renderSuggestion(
        { tool: format!, covered: ["stylua", "selene"], alsoRuns: [], skip: [] },
        "omp",
      ),
    ).toBe(
      'Resin, next time: learned tool format_lua runs `stylua`, `selene`; write {"name":"format_lua","parameters":{}} to xd://mcp__resin_invoke_tool.',
    );
  });

  it("says every step in a direct listing's instructions, and the cap measures what is served", async () => {
    const registryRouter = createRegistryGatewayRouter(await registry());
    // The connection's own workspace differs from the fixture's; the router answers for `caller`.
    const router: GatewayRouter = {
      listTools: () => registryRouter.listTools(caller),
      listCatalogNoticeTools: () => registryRouter.listCatalogNoticeTools(caller),
      callTool: (_context, name, args, options) =>
        registryRouter.callTool(caller, name, args, options),
    };
    const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
    const connection = gateway.createConnection({ cwd: "/repos/alpha" });
    const output = new PassThrough();
    let served: ServedListingSurface | undefined;
    const surface = createToolSearchSurface(output, {
      onServed: (surfaceServed) => {
        served = surfaceServed;
      },
    });
    const forwarded: JsonRpcMessage[] = [];
    const decoder = new McpFrameDecoder();
    surface.input.on("data", (chunk: Buffer) => forwarded.push(...decoder.push(chunk)));
    surface.output.pipe(output);
    const exchange = async (message: JsonRpcMessage) => {
      surface.input.write(encodeMcpMessage(message));
      const response = await gateway.handleMessage(connection, forwarded.at(-1)!);
      surface.output.write(encodeMcpMessage(response!));
    };
    await exchange({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-coding-agent", version: "1" },
      },
    });
    await exchange({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(served?.instructions).toContain(
      `- lint_lua_source_2({source_directory?: string, lint_targets?: string}): Runs stylua {source_directory} to format Lua files and selene {lint_targets} to lint them, showing only the last three lines of lint output… ${RUNS_CLAUSE}`,
    );
    expect(served?.instructions).toContain(
      "- format_lua({source_directory?: string, lint_targets?: string}): Runs stylua and selene on the Lua sources.\n",
    );
    const lint = z
      .object({ description: z.string() })
      .parse(served?.tools.find((tool) => tool.name === "lint_lua_source_2"));
    expect(lint.description).toContain(RUNS_CLAUSE);

    // The listing the gateway chose, measured as it is served, is what the shim served.
    const listing = learnedToolListing(await registryRouter.listCatalogNoticeTools(caller));
    expect(listing.listing.map((tool) => tool.name)).toEqual(["lint_lua_source_2", "format_lua"]);
    expect(served?.instructions).toBe(searchListingInstructions(listing));
    const servedTokens =
      listingTextTokens(served!.instructions) +
      served!.tools.reduce((sum, tool) => sum + listingToolTokens(tool), 0);
    const withoutRuns =
      listingTextTokens(
        searchListingInstructions({
          ...listing,
          listing: listing.listing.map(({ runs: _runs, ...tool }) => tool),
        }),
      ) +
      served!.tools.reduce(
        (sum, tool) =>
          sum +
          listingToolTokens({
            ...tool,
            description: (tool.description ?? "").replace(` ${RUNS_CLAUSE}`, ""),
          }),
        0,
      );
    expect(servedTokens).toBeGreaterThan(withoutRuns);
    expect(JSON.stringify(served)).not.toMatch(RECORDED);
  });
});
