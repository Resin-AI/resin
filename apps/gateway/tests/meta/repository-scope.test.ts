import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DIRECT_LISTING_MAX_TOOLS, LocalMcpGateway } from "../../src/gateway.js";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import {
  isToolOfferedHere,
  toolInRepository,
  toolRepositories,
} from "../../src/meta/repository-scope.js";
import {
  NO_MATCHING_TOOL_NOTE,
  type SearchToolsResponse,
  createSearchToolsHandler,
} from "../../src/meta/search-tools.js";
import type { ToolProfile } from "../../src/meta/tool-profile.js";
import { recordedWorkStepCount } from "../../src/meta/tool-profile.js";
import {
  type CallToolResult,
  type McpTool,
  RESIN_LEARNED_TOOL_COMMANDS_META,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_LISTING_META,
  RESIN_LEARNED_TOOL_META,
  RESIN_SEARCH_LISTING_META,
} from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type GatewayRouter, createRegistryGatewayRouter } from "../../src/router.js";
import { suggestToolsFromCatalog } from "../../src/suggest/index-writer.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

// Synthetic repositories: the identity of each is a fixed 64-hex id, keyed by checkout path. Two
// checkouts of ALPHA (a clone and a worktree) share its id.
const ALPHA = "a".repeat(64);
const BETA = "b".repeat(64);
const CHECKOUTS: Record<string, string> = {
  "/repos/alpha": ALPHA,
  "/repos/alpha-worktree": ALPHA,
  "/repos/beta": BETA,
};

vi.mock("../../src/meta/repository-identity.js", () => ({
  repositoryIdentity: (dir: string) => {
    const root = Object.keys(CHECKOUTS).find(
      (checkout) => dir === checkout || dir.startsWith(`${checkout}/`),
    );
    return root === undefined ? undefined : { id: CHECKOUTS[root], root };
  },
}));

const WORKSPACE = "ws-repo";

function makeManifest(overrides: {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): ToolManifest {
  const raw = {
    id: overrides.id,
    name: overrides.name,
    version: "1.0.0",
    description: overrides.description ?? `Runs ${overrides.name}.`,
    parameters: ToolParameterSchema.parse({ type: "object", properties: {} }),
    runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
    capabilities: CapabilityManifestSchema.parse({}),
    limits: ToolLimitConfigSchema.parse({}),
    scope: "workspace" as const,
    metadata: overrides.metadata ?? {},
    createdAt: "2026-08-17T00:00:00.000Z",
  };
  return { ...raw, digest: computeManifestDigest(raw) };
}

/** A caller whose session started in `directory` (a checkout above, or anywhere else). */
function callerIn(directory: string): WorkspaceContext {
  return {
    workspaceId: WORKSPACE,
    projectId: WORKSPACE,
    projectRoot: directory,
    canonicalRoot: directory,
    startupPath: directory,
    isReadOnly: false,
    name: WORKSPACE,
    source: "cwd_fallback",
    roots: [{ uri: `file://${directory}`, path: directory, name: WORKSPACE }],
    sessionId: "ses_repo",
  } as WorkspaceContext;
}

function parseSearch(result: CallToolResult): SearchToolsResponse {
  const first = result.content[0];
  return JSON.parse(first && "text" in first ? String(first.text) : "{}") as SearchToolsResponse;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && "text" in first ? String(first.text) : "";
}

async function registryWith(
  tools: Array<{ id: string; name: string; description?: string; repositories?: string[] }>,
  profiles: Record<string, ToolProfile> = {},
): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    await registry.registerTool(
      makeManifest({
        id: tool.id,
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.repositories === undefined
          ? {}
          : { metadata: { repositories: tool.repositories } }),
      }),
      undefined,
      { workspaceId: WORKSPACE },
    );
  }
  // The profile reader is keyed by tool id here; the device keys it by the cached plan.
  registry.setLocalToolProfile((tool) => {
    const id = (tool as { toolId?: string }).toolId;
    return id === undefined ? undefined : profiles[id];
  });
  return registry;
}

const listed = async (registry: ToolRegistry, directory: string) =>
  parseSearch(await createSearchToolsHandler(registry)(callerIn(directory), {}))
    .tools.map((tool) => tool.name)
    .sort();

describe("repository scope", () => {
  const catalog = [
    { id: "tool_alpha", name: "alpha_tests", repositories: [ALPHA] },
    { id: "tool_beta", name: "beta_build", repositories: [BETA] },
    { id: "tool_both", name: "shared_lint", repositories: [BETA, ALPHA] },
    { id: "tool_old", name: "old_report" },
  ];

  it("reads the declared repositories, ignoring malformed ids", () => {
    expect(
      toolRepositories(
        makeManifestTool({ repositories: [BETA, "not-an-id", ALPHA, ALPHA.toUpperCase(), BETA] }),
      ),
    ).toEqual([ALPHA, BETA]);
    expect(toolRepositories(makeManifestTool({}))).toBeUndefined();
    expect(toolRepositories(makeManifestTool({ repositories: ["nope"] }))).toBeUndefined();
    expect(toolInRepository(makeManifestTool({ repositories: [ALPHA] }), ALPHA)).toBe(true);
    expect(toolInRepository(makeManifestTool({ repositories: [ALPHA] }), BETA)).toBe(false);
    expect(toolInRepository(makeManifestTool({ repositories: [ALPHA] }), undefined)).toBe(false);
    expect(toolInRepository(makeManifestTool({}), undefined)).toBe(true);
  });

  it("offers a tool only in its repositories, in any checkout of them", async () => {
    const registry = await registryWith(catalog);
    expect(await listed(registry, "/repos/alpha")).toEqual([
      "alpha_tests",
      "old_report",
      "shared_lint",
    ]);
    // A worktree of the same repository, from a subdirectory.
    expect(await listed(registry, "/repos/alpha-worktree/apps/web")).toEqual([
      "alpha_tests",
      "old_report",
      "shared_lint",
    ]);
    expect(await listed(registry, "/repos/beta")).toEqual([
      "beta_build",
      "old_report",
      "shared_lint",
    ]);
  });

  it("offers outside any repository only the tools that declare none", async () => {
    const registry = await registryWith(catalog);
    expect(await listed(registry, "/tmp/scratch")).toEqual(["old_report"]);
  });

  it("keeps an older tool without the field offered, unless this machine says it cannot run here", async () => {
    const registry = await registryWith(
      [
        { id: "tool_old", name: "old_report" },
        { id: "tool_gone", name: "gone_dir_tests" },
      ],
      { tool_gone: { steps: 2, unavailableReason: "its recorded directory no longer exists" } },
    );
    expect(await listed(registry, "/repos/alpha")).toEqual(["old_report"]);
    expect(await listed(registry, "/tmp/scratch")).toEqual(["old_report"]);
  });

  it("scopes a tool by its plan's repository-located steps when the catalog declares none", async () => {
    const registry = await registryWith([{ id: "tool_located", name: "located_tests" }], {
      tool_located: { steps: 1, locatedRepositories: [BETA] },
    });
    expect(await listed(registry, "/repos/beta")).toEqual(["located_tests"]);
    expect(await listed(registry, "/repos/alpha")).toEqual([]);
  });

  it("offers a repo-agnostic tool everywhere: no declared repository and no located step", async () => {
    const registry = await registryWith([{ id: "tool_gh", name: "gh_pr_status" }], {
      tool_gh: { steps: 1, locatedRepositories: [] },
    });
    for (const directory of ["/repos/alpha", "/repos/beta", "/tmp/scratch"]) {
      expect(await listed(registry, directory)).toEqual(["gh_pr_status"]);
    }
  });

  it("hides a scoped-out tool from search by name, tools/list, get_tool_schema and calls", async () => {
    const registry = await registryWith(catalog);
    const beta = callerIn("/repos/beta");

    const found = parseSearch(
      await createSearchToolsHandler(registry)(beta, { query: "alpha_tests" }),
    );
    expect(found.tools).toEqual([]);
    expect(found.note).toBe(NO_MATCHING_TOOL_NOTE);

    const router = createRegistryGatewayRouter(registry);
    const names = (await router.listCatalogNoticeTools(beta)).map((tool) => tool.name);
    expect(names).toContain("beta_build");
    expect(names).not.toContain("alpha_tests");

    const schema = await createGetToolSchemaHandler(registry)(beta, { name: "alpha_tests" });
    expect(schema.isError).toBe(true);
    expect(textOf(schema)).toMatch(/not available here/);

    const called = await router.callTool(beta, "alpha_tests", {});
    expect(called.isError).toBe(true);
    expect(textOf(called)).toMatch(/not available here/);

    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const invoked = await createInvokeToolHandler(registry, { invoke })(beta, {
      name: "alpha_tests",
    });
    expect(invoked.isError).toBe(true);
    expect(textOf(invoked)).toMatch(/not available here/);
    expect(invoke).not.toHaveBeenCalled();

    // The same tool is offered, and runs, in its own repository.
    const alphaTool = registry.getAllRegisteredTools().find((tool) => tool.name === "alpha_tests");
    expect(alphaTool && isToolOfferedHere(registry, alphaTool, callerIn("/repos/alpha"))).toBe(
      true,
    );
    await createInvokeToolHandler(registry, { invoke })(callerIn("/repos/alpha"), {
      name: "alpha_tests",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

function makeManifestTool(metadata: Record<string, unknown>) {
  return { manifest: makeManifest({ id: "tool_x", name: "x", metadata }) };
}

describe("search relevance threshold", () => {
  // Every description mentions errors: a word shared by tools that have nothing to do with the
  // service a question names.
  const catalog = [
    {
      id: "tool_merge",
      name: "merge_pr",
      description: "Merges the pull request once checks pass and reports merge errors.",
    },
    {
      id: "tool_tests",
      name: "run_unit_tests",
      description: "Runs the vitest unit test suite and reports test errors.",
    },
    {
      id: "tool_build",
      name: "build_web_app",
      description: "Builds the web app bundle with vite and reports build errors.",
    },
  ];

  it.each([
    "posthog errors",
    "PostHog errors in the last 24 hours",
    "what errors does posthog show for signup",
    "sentry issues for checkout",
  ])("returns nothing, with the no-match note, for an unrelated question: %s", async (query) => {
    const registry = await registryWith(catalog);
    const response = parseSearch(
      await createSearchToolsHandler(registry)(callerIn("/repos/alpha"), { query }),
    );
    expect(response.tools.map((tool) => tool.name)).toEqual([]);
    expect(response.total).toBe(0);
    expect(response.note).toBe(NO_MATCHING_TOOL_NOTE);
  });

  it("finds the tool a question is about, and only it", async () => {
    const registry = await registryWith([
      ...catalog,
      {
        id: "tool_posthog",
        name: "posthog_error_summary",
        description: "Summarizes PostHog exceptions and errors by issue.",
      },
    ]);
    const search = createSearchToolsHandler(registry);
    const alpha = callerIn("/repos/alpha");
    expect(
      parseSearch(await search(alpha, { query: "posthog errors" })).tools.map((t) => t.name),
    ).toEqual(["posthog_error_summary"]);
    expect(
      parseSearch(await search(alpha, { query: "run the vitest tests" })).tools.map((t) => t.name),
    ).toEqual(["run_unit_tests"]);
  });

  it("still matches a command a tool runs, however much else the query names", async () => {
    const registry = await registryWith(catalog);
    registry.setLocalToolCommands((tool) =>
      (tool as { toolId?: string }).toolId === "tool_merge" ? ["gh pr merge"] : [],
    );
    const response = parseSearch(
      await createSearchToolsHandler(registry)(callerIn("/repos/alpha"), {
        query: "gh pr merge --squash for the billing invoice refactor",
      }),
    );
    expect(response.tools.map((tool) => tool.name)).toEqual(["merge_pr"]);
  });
});

describe("ranking by recorded work", () => {
  const twins = [
    { id: "tool_quick", name: "deploy_quick", description: "Deploys the application to staging." },
    { id: "tool_full", name: "deploy_full", description: "Deploys the application to staging." },
    { id: "tool_mid", name: "deploy_mid", description: "Deploys the application to staging." },
  ];
  const profiles = {
    tool_quick: { steps: 1 },
    tool_full: { steps: 6 },
    tool_mid: { steps: 2 },
  };

  it("ranks tools replacing more recorded steps first, with a short hint", async () => {
    const registry = await registryWith(twins, profiles);
    const response = parseSearch(
      await createSearchToolsHandler(registry)(callerIn("/repos/alpha"), {
        query: "deploy application staging",
      }),
    );
    expect(response.tools.map((tool) => [tool.name, tool.replaces])).toEqual([
      ["deploy_full", "Replaces 6 recorded steps."],
      ["deploy_mid", "Replaces 2 recorded steps."],
      ["deploy_quick", undefined],
    ]);
  });

  it("orders a plain listing the same way", async () => {
    const registry = await registryWith(twins, profiles);
    expect(
      parseSearch(await createSearchToolsHandler(registry)(callerIn("/repos/alpha"), {})).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["deploy_full", "deploy_mid", "deploy_quick"]);
  });

  it("never lifts a multi-step tool over one the query names", async () => {
    const registry = await registryWith(twins, profiles);
    const [first] = parseSearch(
      await createSearchToolsHandler(registry)(callerIn("/repos/alpha"), { query: "deploy_quick" }),
    ).tools;
    expect(first?.name).toBe("deploy_quick");
  });

  it("puts the hint in the listed purpose, before the inputs", async () => {
    const registry = await registryWith(twins, profiles);
    const tools = await createRegistryGatewayRouter(registry).listCatalogNoticeTools(
      callerIn("/repos/alpha"),
    );
    expect(tools.find((tool) => tool.name === "deploy_full")?.description).toBe(
      "Deploys the application to staging. Replaces 6 recorded steps.",
    );
    expect(tools.find((tool) => tool.name === "deploy_quick")?.description).toBe(
      "Deploys the application to staging.",
    );
  });

  it("counts recorded steps, not derivations or bare directory changes", () => {
    const step = (source: string, origin?: "derivation") => ({
      callable: { runtime: "resin-program", name: "bash", program: { kind: "shell", source } },
      ...(origin === undefined ? {} : { origin }),
    });
    expect(
      recordedWorkStepCount({
        steps: [
          step("cd apps/web"),
          step("pnpm build"),
          step("pnpm test"),
          step("x = 1", "derivation"),
        ],
      } as never),
    ).toBe(2);
  });
});

describe("direct listing of a small per-repository catalog", () => {
  const learnedTool = (index: number): McpTool => ({
    name: `learned_${index}`,
    description: `Runs job ${index}.`,
    inputSchema: { type: "object", properties: {} },
    _meta: { [RESIN_LEARNED_TOOL_META]: true },
  });

  async function initializeAndList(count: number) {
    const tools = Array.from({ length: count }, (_, index) => learnedTool(index));
    const router: GatewayRouter = {
      listTools: async () => tools,
      callTool: async () => ({ content: [] }),
    };
    const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
    const connection = gateway.createConnection({ cwd: "/tmp" });
    const initialized = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-coding-agent", version: "1" },
        _meta: { [RESIN_SEARCH_LISTING_META]: true },
      },
    });
    const listedTools = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const meta = z.object({ result: z.object({ _meta: z.record(z.unknown()) }) });
    return {
      initialize: meta.parse(initialized).result._meta,
      list: meta.parse(listedTools).result._meta,
    };
  }

  it(`reports each tool's name and purpose for at most ${DIRECT_LISTING_MAX_TOOLS} tools`, async () => {
    const { initialize, list } = await initializeAndList(DIRECT_LISTING_MAX_TOOLS);
    expect(initialize[RESIN_LEARNED_TOOL_COUNT_META]).toBe(DIRECT_LISTING_MAX_TOOLS);
    expect(initialize[RESIN_LEARNED_TOOL_LISTING_META]).toHaveLength(DIRECT_LISTING_MAX_TOOLS);
    expect(initialize[RESIN_LEARNED_TOOL_LISTING_META]).toContainEqual({
      name: "learned_0",
      description: "Runs job 0.",
    });
    expect(list[RESIN_LEARNED_TOOL_LISTING_META]).toHaveLength(DIRECT_LISTING_MAX_TOOLS);
  });

  it("reports no listing above the limit, so the shim stays search-only", async () => {
    const { initialize, list } = await initializeAndList(DIRECT_LISTING_MAX_TOOLS + 1);
    expect(initialize[RESIN_LEARNED_TOOL_COUNT_META]).toBe(DIRECT_LISTING_MAX_TOOLS + 1);
    expect(initialize[RESIN_LEARNED_TOOL_LISTING_META]).toBeUndefined();
    expect(list[RESIN_LEARNED_TOOL_LISTING_META]).toBeUndefined();
  });
});

describe("a learned tool measured to cost more than doing the job directly", () => {
  const caller = callerIn("/repos/alpha");
  const demoted = {
    automatic: false,
    reason: "measured_net_cost",
    invocations: 4,
    savedTokens: -2480,
    savedCostUsd: -0.0091,
  };

  async function catalogWithDemotedStyleCheck() {
    const registry = await registryWith([
      { id: "tool_style", name: "check_lua_style" },
      { id: "tool_deploy", name: "deploy_place" },
    ]);
    registry.setLocalToolCommands((tool) =>
      "toolId" in tool && tool.toolId === "tool_style" ? ["stylua"] : ["rojo"],
    );
    const style = registry.getAllRegisteredTools().find((tool) => tool.toolId === "tool_style");
    if (!style) throw new Error("tool_style was not registered");
    registry.applyToolRecommendations([{ ...style.manifest, recommendation: demoted }]);
    return { registry, style };
  }

  it("keeps the recommendation on every registered version and reverts when it is gone", async () => {
    const { registry, style } = await catalogWithDemotedStyleCheck();
    const router = createRegistryGatewayRouter(registry);
    const listed = await router.listCatalogNoticeTools(caller);
    expect(listed.find((tool) => tool.name === "check_lua_style")?.recommended).toBe(false);
    expect(listed.find((tool) => tool.name === "deploy_place")).not.toHaveProperty("recommended");
    // Internal: never sent to a harness.
    expect((await router.listTools(caller)).some((tool) => "recommended" in tool)).toBe(false);

    const { recommendation: _recommendation, ...withoutRecommendation } = style.manifest;
    registry.applyToolRecommendations([withoutRecommendation]);
    expect(
      (await router.listCatalogNoticeTools(caller)).find((tool) => tool.name === "check_lua_style"),
    ).not.toHaveProperty("recommended");
  });

  it("is left out of the instructions' count, commands and direct listing, and of suggestions", async () => {
    const { registry } = await catalogWithDemotedStyleCheck();
    const registryRouter = createRegistryGatewayRouter(registry);
    // The caller's repository, whatever workspace initialize resolves for the connection.
    const router: GatewayRouter = {
      listTools: () => registryRouter.listTools(caller),
      listCatalogNoticeTools: () => registryRouter.listCatalogNoticeTools(caller),
      callTool: async () => ({ content: [] }),
    };
    const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
    const connection = gateway.createConnection({ cwd: "/repos/alpha" });
    const initialized = await gateway.handleMessage(connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omp-coding-agent", version: "1" },
        _meta: { [RESIN_SEARCH_LISTING_META]: true },
      },
    });
    const meta = z.object({ result: z.object({ _meta: z.record(z.unknown()) }) }).parse(initialized)
      .result._meta;
    expect(meta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(1);
    expect(meta[RESIN_LEARNED_TOOL_COMMANDS_META]).toEqual(["rojo"]);
    expect(meta[RESIN_LEARNED_TOOL_LISTING_META]).toEqual([
      { name: "deploy_place", description: expect.any(String) },
    ]);
    expect(await gateway.listLearnedTools(caller)).toEqual([
      { name: "deploy_place", description: expect.any(String) },
    ]);
    expect(
      suggestToolsFromCatalog(await registryRouter.listCatalogNoticeTools(caller)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["deploy_place"]);
  });

  it("still answers get_tool_schema and invoke_tool by name", async () => {
    const { registry } = await catalogWithDemotedStyleCheck();
    const schema = await createGetToolSchemaHandler(registry)(caller, { name: "check_lua_style" });
    expect(schema.isError).not.toBe(true);
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const invoked = await createInvokeToolHandler(registry, { invoke })(caller, {
      name: "check_lua_style",
    });
    expect(invoked.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
