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
import { LISTING_CAP, learnedToolListing } from "../../src/listing-surface.js";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import {
  isToolOfferedHere,
  isToolScopedHere,
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
import { McpFrameDecoder, encodeMcpMessage } from "../../src/protocol/framing.js";
import {
  type CallToolResult,
  type JsonRpcMessage,
  RESIN_LEARNED_TOOL_COMMANDS_META,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_LISTING_META,
  RESIN_LEARNED_TOOL_META,
  RESIN_SEARCH_LISTING_META,
} from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import {
  type CatalogNoticeTool,
  type GatewayRouter,
  createRegistryGatewayRouter,
} from "../../src/router.js";
import {
  type ServedListingSurface,
  createToolSearchSurface,
} from "../../src/shim/tool-search-surface.js";
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

  it("puts the hint in the listed purpose", async () => {
    const registry = await registryWith(twins, profiles);
    const tools = await createRegistryGatewayRouter(registry).listCatalogNoticeTools(
      callerIn("/repos/alpha"),
    );
    expect(tools.find((tool) => tool.name === "deploy_full")?.listing?.purpose).toBe(
      "Deploys the application to staging. Replaces 6 recorded steps.",
    );
    expect(tools.find((tool) => tool.name === "deploy_quick")?.listing?.purpose).toBe(
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

const ResultMetaSchema = z.object({ result: z.object({ _meta: z.record(z.unknown()) }) });

/** The names a gateway result's `_meta` lists directly, in listing order. */
const listingNamesOf = (meta: Record<string, unknown>) =>
  z
    .array(z.object({ name: z.string() }))
    .parse(meta[RESIN_LEARNED_TOOL_LISTING_META] ?? [])
    .map((tool) => tool.name);

/**
 * Initializes a search-listing connection to `router` and lists its tools, both through the stdio
 * shim's surface: the gateway's `_meta` and what the harness was served.
 */
async function serveSearchListing(router: GatewayRouter, cwd = "/repos/alpha") {
  const gateway = new LocalMcpGateway({ router, enableRefreshCoordinator: false });
  const connection = gateway.createConnection({ cwd });
  const output = new PassThrough();
  let footprint: ServedListingSurface | undefined;
  const surface = createToolSearchSurface(output, {
    onServed: (served) => {
      footprint = served;
    },
  });
  const received: JsonRpcMessage[] = [];
  const decoder = new McpFrameDecoder();
  output.on("data", (chunk: Buffer) => received.push(...decoder.push(chunk)));
  surface.output.pipe(output);
  const forwarded: JsonRpcMessage[] = [];
  const inputDecoder = new McpFrameDecoder();
  surface.input.on("data", (chunk: Buffer) => forwarded.push(...inputDecoder.push(chunk)));
  const exchange = async (message: JsonRpcMessage) => {
    surface.input.write(encodeMcpMessage(message));
    const sent = forwarded.at(-1);
    if (sent === undefined) throw new Error("The shim forwarded nothing");
    const response = await gateway.handleMessage(connection, sent);
    if (response === null) throw new Error("The gateway did not answer");
    surface.output.write(encodeMcpMessage(response));
    return { gateway: response, served: received.at(-1) };
  };
  const initialized = await exchange({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omp-coding-agent", version: "1" },
    },
  });
  const listed = await exchange({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const served = z
    .object({
      result: z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.unknown(),
          }),
        ),
      }),
    })
    .parse(listed.served).result.tools;
  const instructions = z
    .object({ result: z.object({ instructions: z.string() }) })
    .parse(initialized.served).result.instructions;
  return {
    gateway,
    connection,
    initializeMeta: ResultMetaSchema.parse(initialized.gateway).result._meta,
    listMeta: ResultMetaSchema.parse(listed.gateway).result._meta,
    instructions,
    tools: served,
    tokens:
      listingTextTokens(instructions) +
      served.reduce((sum, tool) => sum + listingToolTokens(tool), 0),
    /** What the shim reported serving: the listing footprint's tool ids and cap flag. */
    footprint,
  };
}

describe("direct listing of a per-repository catalog", () => {
  const META_TOOLS: CatalogNoticeTool[] = [
    { name: "search_tools", description: "Searches.", inputSchema: { type: "object" } },
    { name: "get_tool_schema", description: "Schema.", inputSchema: { type: "object" } },
    { name: "invoke_tool", description: "Invokes.", inputSchema: { type: "object" } },
    { name: "manage_tools", description: "Manages.", inputSchema: { type: "object" } },
  ];
  const learnedTool = (
    index: number,
    extra: Partial<CatalogNoticeTool> = {},
  ): CatalogNoticeTool => ({
    name: `learned_${index}`,
    description: `Runs job ${index}.`,
    inputSchema: { type: "object", properties: {} },
    _meta: { [RESIN_LEARNED_TOOL_META]: true },
    localCommands: [`job${index}`],
    scopedHere: true,
    ...extra,
  });
  const routerOf = (tools: CatalogNoticeTool[]): GatewayRouter => ({
    listTools: async () => [...META_TOOLS, ...tools],
    callTool: async () => ({ content: [] }),
  });

  it("lists every relevant tool, and no search, when all fit the cap", async () => {
    const tools = Array.from({ length: 3 }, (_, index) => learnedTool(index));
    const served = await serveSearchListing(routerOf(tools));
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(3);
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_LISTING_META]).toContainEqual({
      name: "learned_0",
      description: "Runs job 0.",
    });
    expect(served.listMeta[RESIN_LEARNED_TOOL_LISTING_META]).toHaveLength(3);
    expect(served.tools.map((tool) => tool.name)).toEqual([
      "invoke_tool",
      "learned_0",
      "learned_1",
      "learned_2",
    ]);
  });

  it(`lists at most ${LISTING_CAP.maxTools} tools, pinned and most recorded steps first, and the rest by search`, async () => {
    const tools = Array.from({ length: 10 }, (_, index) =>
      learnedTool(index, {
        ...(index === 9 ? { pinned: true as const } : {}),
        ...(index === 5 ? { steps: 4 } : {}),
      }),
    );
    const served = await serveSearchListing(routerOf(tools));
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(10);
    const order = ["learned_9", "learned_5", "learned_0", "learned_1", "learned_2", "learned_3"];
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(served.initializeMeta[RESIN_LEARNED_TOOL_LISTING_META])
        .map((tool) => tool.name),
    ).toEqual([...order, "learned_4", "learned_6"]);
    // The commands of the two left out, for search to find them.
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COMMANDS_META]).toEqual(
      expect.arrayContaining(["job7", "job8"]),
    );
    const names = served.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("learned_"))).toHaveLength(LISTING_CAP.maxTools);
    expect(names).toContain("search_tools");
    expect(names).not.toContain("get_tool_schema");
    expect(names).not.toContain("manage_tools");
    expect(served.instructions).toContain("2 more learned tools");
    expect(served.tools.find((tool) => tool.name === "search_tools")?.description).toContain(
      "2 more learned tools",
    );
    expect(served.tokens).toBeLessThanOrEqual(LISTING_CAP.maxTokens);
  });

  it("lists fewer tools when their definitions are large, keeping the served surface within the cap", async () => {
    const tools = Array.from({ length: 10 }, (_, index) =>
      learnedTool(index, { description: `Runs job ${index}. ${"Detail. ".repeat(80)}` }),
    );
    const served = await serveSearchListing(routerOf(tools));
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(10);
    const listed = served.tools.filter((tool) => tool.name.startsWith("learned_"));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(LISTING_CAP.maxTools);
    expect(served.tools.map((tool) => tool.name)).toContain("search_tools");
    expect(served.tokens).toBeLessThanOrEqual(LISTING_CAP.maxTokens);
  });

  /** A learned tool whose served definition costs exactly `tokens`, padded in its description. */
  const sizedTool = (
    name: string,
    tokens: number,
    extra: Partial<CatalogNoticeTool> = {},
  ): CatalogNoticeTool => {
    const inputSchema = { type: "object", properties: {} };
    let description = `Runs ${name}.`;
    while (listingToolTokens({ name, description, inputSchema }) < tokens) description += " x";
    if (listingToolTokens({ name, description, inputSchema }) !== tokens) description += "y";
    expect(listingToolTokens({ name, description, inputSchema })).toBe(tokens);
    return {
      name,
      description,
      inputSchema,
      _meta: { [RESIN_LEARNED_TOOL_META]: true },
      localCommands: [`run_${name}`],
      listing: { purpose: `Runs ${name}.`, signature: "{}" },
      toolId: `id_${name}`,
      scopedHere: true,
      ...extra,
    };
  };
  const listedNames = (tools: CatalogNoticeTool[]) =>
    learnedToolListing([...META_TOOLS, ...tools]).listing.map((tool) => tool.name);

  it("orders by the model requests the cloud observed a tool saving before recorded steps", () => {
    const tools = [
      learnedTool(0, { steps: 9 }),
      learnedTool(1, { steps: 2, avoidableRequests: 3 }),
      learnedTool(2, { steps: 5, avoidableRequests: 1 }),
      learnedTool(3, { steps: 1, pinned: true }),
    ];
    expect(listedNames(tools)).toEqual(["learned_3", "learned_1", "learned_2", "learned_0"]);
  });

  it("skips a tool that does not fit and lists a later one that does", async () => {
    const tools = [
      sizedTool("big_first", 900, { steps: 10 }),
      sizedTool("big_second", 400, { steps: 8 }),
      sizedTool("small_last", 60, { steps: 1 }),
    ];
    expect(listedNames(tools)).toEqual(["big_first", "small_last"]);
    const served = await serveSearchListing(routerOf(tools));
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(3);
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COMMANDS_META]).toEqual(["run_big_second"]);
    expect(served.tools.map((tool) => tool.name)).toEqual([
      "search_tools",
      "invoke_tool",
      "big_first",
      "small_last",
    ]);
    expect(served.instructions).toContain("1 more learned tool, not listed");
    expect(served.footprint?.listedToolIds).toEqual(["id_big_first", "id_small_last"]);
    expect(served.footprint?.capped).toBe(true);
    expect(served.tokens).toBeLessThanOrEqual(LISTING_CAP.maxTokens);
  });

  it("lists all of the A-D fixture, C and D first by observed requests, within the cap", async () => {
    // D is unscoped by its own record; its observed opportunities in the caller's repository make
    // it scopedHere (see the registry tests below), which is all the listing reads.
    const tools = [
      sizedTool("tool_a", 330, { steps: 10 }),
      sizedTool("tool_b", 200, { steps: 7 }),
      sizedTool("tool_c", 71, { steps: 2, avoidableRequests: 3 }),
      sizedTool("tool_d", 160, { steps: 2, avoidableRequests: 1 }),
    ];
    const served = await serveSearchListing(routerOf(tools));
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(4);
    expect(listingNamesOf(served.initializeMeta)).toEqual(["tool_c", "tool_d", "tool_a", "tool_b"]);
    // tools/list keeps catalog order; search_tools is dropped with nothing left out.
    expect(served.tools.map((tool) => tool.name)).toEqual([
      "invoke_tool",
      "tool_a",
      "tool_b",
      "tool_c",
      "tool_d",
    ]);
    expect(served.footprint?.listedToolIds).toEqual([
      "id_tool_a",
      "id_tool_b",
      "id_tool_c",
      "id_tool_d",
    ]);
    expect(served.footprint?.capped).toBe(false);
    expect(served.tokens).toBe(958);
  });
});

describe("a learned tool that declares no repository", () => {
  const caller = callerIn("/repos/alpha");

  it("is neither listed nor counted, but runs by name through invoke_tool and tools/call", async () => {
    const registry = await registryWith([
      { id: "tool_alpha", name: "alpha_tests", repositories: [ALPHA] },
      { id: "tool_old", name: "old_report" },
    ]);
    const invoke = vi.fn(async (request: { name: string }) => ({
      content: [{ type: "text" as const, text: `ran ${request.name}` }],
    }));
    const registryRouter = createRegistryGatewayRouter(registry, { invoke });
    // The caller's repository, whatever workspace initialize resolves for the connection.
    const router: GatewayRouter = {
      listTools: () => registryRouter.listTools(caller),
      listCatalogNoticeTools: () => registryRouter.listCatalogNoticeTools(caller),
      callTool: (_context, name, args, options) =>
        registryRouter.callTool(caller, name, args, options),
    };
    const served = await serveSearchListing(router);
    expect(served.initializeMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(1);
    expect(served.listMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(1);
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(served.listMeta[RESIN_LEARNED_TOOL_LISTING_META])
        .map((tool) => tool.name),
    ).toEqual(["alpha_tests"]);
    expect(served.tools.map((tool) => tool.name).sort()).toEqual(["alpha_tests", "invoke_tool"]);
    expect(served.instructions).not.toContain("old_report");
    // Still offered: search finds it.
    expect(await listed(registry, "/repos/alpha")).toContain("old_report");

    const viaInvoke = await served.gateway.handleMessage(served.connection, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoke_tool", arguments: { name: "old_report" } },
    });
    expect(viaInvoke).toMatchObject({
      result: { content: [{ text: expect.stringContaining("ran old_report") }] },
    });
    const direct = await served.gateway.handleMessage(served.connection, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "old_report", arguments: {} },
    });
    expect(direct).toMatchObject({
      result: { content: [{ text: expect.stringContaining("ran old_report") }] },
    });
    expect(invoke.mock.calls.map(([request]) => request.name)).toEqual([
      "old_report",
      "old_report",
    ]);
  });
});

describe("a learned tool that declares no repository, observed saving work", () => {
  const observedIn = (repositories: unknown, avoidableRequests = 3) => ({
    automatic: true,
    reason: "expected_net_value",
    tasks: 0,
    invocations: 0,
    savedTokens: 0,
    opportunities: { runs: 2, avoidableRequests, sessions: 5, repositories },
  });

  async function catalogObserving(recommendation: Record<string, unknown> | undefined) {
    const registry = await registryWith(
      [
        { id: "tool_alpha", name: "alpha_tests", repositories: [ALPHA] },
        { id: "tool_logs", name: "evaluate_code_and_get_logs" },
      ],
      { tool_alpha: { steps: 4 }, tool_logs: { steps: 2, locatedRepositories: [] } },
    );
    const logs = registry.getAllRegisteredTools().find((tool) => tool.toolId === "tool_logs");
    if (!logs) throw new Error("tool_logs was not registered");
    if (recommendation !== undefined) {
      registry.applyToolRecommendations([
        { ...logs.manifest, recommendation: recommendation as ToolManifest["recommendation"] },
      ]);
    }
    const invoke = vi.fn(async (request: { name: string }) => ({
      content: [{ type: "text" as const, text: `ran ${request.name}` }],
    }));
    const serveIn = async (directory: string) => {
      const caller = callerIn(directory);
      const registryRouter = createRegistryGatewayRouter(registry, { invoke });
      return await serveSearchListing(
        {
          listTools: () => registryRouter.listTools(caller),
          listCatalogNoticeTools: () => registryRouter.listCatalogNoticeTools(caller),
          callTool: (_context, name, args, options) =>
            registryRouter.callTool(caller, name, args, options),
        },
        directory,
      );
    };
    return { registry, logs, invoke, serveIn };
  }

  it("is listed, first, and counted in the footprint in a repository it was observed in", async () => {
    const { serveIn } = await catalogObserving(observedIn([ALPHA]));
    const served = await serveIn("/repos/alpha");
    expect(served.listMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(2);
    expect(listingNamesOf(served.listMeta)).toEqual(["evaluate_code_and_get_logs", "alpha_tests"]);
    expect(served.tools.map((tool) => tool.name).sort()).toEqual([
      "alpha_tests",
      "evaluate_code_and_get_logs",
      "invoke_tool",
    ]);
    expect(served.footprint?.listedToolIds.slice().sort()).toEqual(["tool_alpha", "tool_logs"]);
    expect(served.footprint?.capped).toBe(false);
  });

  it("is not listed in another repository, but stays searchable and invocable there", async () => {
    const { registry, invoke, serveIn } = await catalogObserving(observedIn([BETA]));
    const served = await serveIn("/repos/alpha");
    expect(served.listMeta[RESIN_LEARNED_TOOL_COUNT_META]).toBe(1);
    expect(listingNamesOf(served.listMeta)).toEqual(["alpha_tests"]);
    expect(served.footprint?.listedToolIds).toEqual(["tool_alpha"]);
    expect(await listed(registry, "/repos/alpha")).toContain("evaluate_code_and_get_logs");
    const viaInvoke = await served.gateway.handleMessage(served.connection, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoke_tool", arguments: { name: "evaluate_code_and_get_logs" } },
    });
    expect(viaInvoke).toMatchObject({
      result: { content: [{ text: expect.stringContaining("ran evaluate_code_and_get_logs") }] },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("is not scoped by observations while demoted, and a repo-scoped tool keeps its own scope", async () => {
    const { registry, logs } = await catalogObserving({
      ...observedIn([ALPHA]),
      automatic: false,
      reason: "measured_net_cost",
    });
    expect(isToolScopedHere(registry, logs, callerIn("/repos/alpha"))).toBe(false);
    const alpha = registry.getAllRegisteredTools().find((tool) => tool.toolId === "tool_alpha");
    if (!alpha) throw new Error("tool_alpha was not registered");
    registry.applyToolRecommendations([
      { ...alpha.manifest, recommendation: observedIn([BETA]) as ToolManifest["recommendation"] },
    ]);
    expect(isToolScopedHere(registry, alpha, callerIn("/repos/alpha"))).toBe(true);
    expect(isToolScopedHere(registry, alpha, callerIn("/repos/beta"))).toBe(false);
    expect(isToolOfferedHere(registry, alpha, callerIn("/repos/beta"))).toBe(false);
  });

  it.each([
    ["a malformed repository id", observedIn(["not-a-repository", ALPHA])],
    ["a negative count", observedIn([ALPHA], -1)],
    ["a non-object", { ...observedIn([ALPHA]), opportunities: "many" }],
  ])("is ignored with %s, and the catalog lists as without it", async (_case, recommendation) => {
    const baseline = await (await catalogObserving(undefined)).serveIn("/repos/alpha");
    const served = await (await catalogObserving(recommendation)).serveIn("/repos/alpha");
    expect(listingNamesOf(served.listMeta)).toEqual(["alpha_tests"]);
    expect(served.listMeta).toEqual(baseline.listMeta);
    expect(served.tools).toEqual(baseline.tools);
    expect(served.instructions).toBe(baseline.instructions);
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
      { id: "tool_style", name: "check_lua_style", repositories: [ALPHA] },
      { id: "tool_deploy", name: "deploy_place", repositories: [ALPHA] },
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
    // Neither listed nor named among the commands left to search.
    expect(meta[RESIN_LEARNED_TOOL_COMMANDS_META] ?? []).not.toContain("stylua");
    expect(meta[RESIN_LEARNED_TOOL_LISTING_META]).toEqual([
      { name: "deploy_place", signature: expect.any(String), description: expect.any(String) },
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
