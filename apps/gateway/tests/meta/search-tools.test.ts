import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import {
  NO_MATCHING_TOOL_NOTE,
  type SearchToolsResponse,
  createSearchToolsHandler,
} from "../../src/meta/search-tools.js";
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
  it("lists the always-exposed meta-tools only when the system scope is requested", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-alpha");

    expect(parseSearchResponse(await handler(context, {})).total).toBe(0);
    expect(parseSearchResponse(await handler(context, { query: "tool" })).total).toBe(0);

    const system = parseSearchResponse(await handler(context, { scope: "system" }));
    expect(system.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_tools", "get_tool_schema", "invoke_tool", "manage_tools"]),
    );
  });

  it("returns each tool's input schema so it can be invoked without a schema lookup", async () => {
    const registry = new ToolRegistry();
    const handler = createSearchToolsHandler(registry);
    const context = makeContext("ws-schema");
    await registry.registerTool(
      makeManifest({ id: "tool_schema", name: "schema_tool" }),
      undefined,
      {
        workspaceId: "ws-schema",
      },
    );

    const [tool] = parseSearchResponse(await handler(context, { query: "schema_tool" })).tools;

    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    });
  });

  it("lists the version invocation would run, not the first one this process registered", async () => {
    const registry = new ToolRegistry();
    const search = createSearchToolsHandler(registry);
    const schema = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-versions");
    // The session started with 1.0.1 registered; the catalog sync then brought 1.0.2.
    for (const version of ["1.0.1", "1.0.2"]) {
      await registry.registerTool(
        makeManifest({ id: "tool_deploy", name: "deploy_application", version }),
        undefined,
        { workspaceId: "ws-versions" },
      );
    }

    const [found] = parseSearchResponse(
      await search(context, { query: "deploy_application" }),
    ).tools;
    const inspected = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          String((await schema(context, { name: "deploy_application" })).content[0]?.text),
        ),
      );

    expect(inspected.version).toBe("1.0.2");
    expect(found?.version).toBe(inspected.version);
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
    expect(page1Data.total).toBe(10);
    expect(page1Data.tools).toHaveLength(5);
    expect(page1Data.limit).toBe(5);
    expect(page1Data.offset).toBe(0);
    expect(page1Data.hasMore).toBe(true);

    // Page 2: limit 5, offset 5
    const page2Res = await handler(context, { limit: 5, offset: 5 });
    const page2Data = parseSearchResponse(page2Res);
    expect(page2Data.tools).toHaveLength(5);
    expect(page2Data.offset).toBe(5);
    expect(page2Data.hasMore).toBe(false);
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

describe("search_tools ranking over learned tools", () => {
  // Learned tools' descriptions share this boilerplate around the recorded program, and all carry
  // the `shell` tag, so only the program and summary distinguish them.
  const learned = (summary: string, program: string) =>
    [
      `Runs ${summary}. Learned from one run; defaults are the recorded values.`,
      "Recorded on this machine:",
      "Step 1 runs this recorded shell program:",
      program,
      "Parameters (each replaces its {name} above; omitted, the recorded value runs)",
    ].join("\n");
  const workspace: [name: string, summary: string, program: string][] = [
    ["watch_pr_checks", "watches the pull request checks", "gh pr checks {pr} --watch"],
    [
      "rerun_failed_pr_checks",
      "reruns failed pull request checks",
      "gh run rerun {run} --failed && gh pr checks {pr}",
    ],
    ["run_workspace_suite", "the workspace suite", "pnpm test --filter {package}"],
    ["filter_test_output", "filters test output down to failures", "grep -E 'FAIL' {log}"],
    ["filter_test_output_summary", "summarizes test output", "tail -n 40 {log}"],
    ["rerun_flaky_test", "reruns one flaky test", "npx vitest run {file}"],
    ["format_luau", "formats Luau sources", "stylua --check src"],
    [
      "watch_lune_build",
      "rebuilds the place on change",
      "lune run build --watch && stylua --check src",
    ],
    ["lint_luau", "lints Luau sources", "selene src && stylua --check src"],
    [
      "fetch_latest_release",
      "downloads the latest release",
      "curl -sL https://example.com/releases/latest -o {out}",
    ],
    ["install_dependencies", "installs dependencies", "pnpm install --frozen-lockfile"],
    ["deploy_docs", "publishes the docs", "rsync -a docs/ {host}:/srv/docs"],
  ];

  async function searchLearned(query: string): Promise<SearchToolsResponse> {
    const registry = new ToolRegistry();
    for (const [name, summary, program] of workspace) {
      await registry.registerTool(
        makeManifest({
          id: `tool_${name}`,
          name,
          description: learned(summary, program),
          metadata: { tags: ["shell"] },
        }),
        undefined,
        { workspaceId: "ws-learned" },
      );
    }
    return parseSearchResponse(
      await createSearchToolsHandler(registry)(makeContext("ws-learned"), { query, limit: 100 }),
    );
  }

  it("finds the gh tools for a gh command line, not Luau tools sharing --check or --watch", async () => {
    const result = await searchLearned("gh pr checks --watch");

    expect(result.tools.map((t) => t.name)).toEqual(["watch_pr_checks", "rerun_failed_pr_checks"]);
    expect(result.total).toBe(2);
  });

  it("ranks the tool running `pnpm test` first and drops tools that only mention test", async () => {
    const names = (await searchLearned("pnpm test")).tools.map((t) => t.name);

    expect(names[0]).toBe("run_workspace_suite");
    expect(names).not.toContain("filter_test_output");
    expect(names).not.toContain("filter_test_output_summary");
    expect(names).not.toContain("rerun_flaky_test");
  });

  it("matches whole words, so `test` does not find a tool that only says `latest`", async () => {
    const names = (await searchLearned("test")).tools.map((t) => t.name);

    expect(names).not.toContain("fetch_latest_release");
    expect(names.sort()).toEqual([
      "filter_test_output",
      "filter_test_output_summary",
      "rerun_flaky_test",
      "run_workspace_suite",
    ]);
  });

  it("ignores words every learned tool shares", async () => {
    expect((await searchLearned("recorded shell program")).total).toBe(0);
    expect((await searchLearned("run vitest tests")).tools.map((t) => t.name)).toEqual([
      "rerun_flaky_test",
    ]);
  });

  it("still ranks an exact tool name first", async () => {
    const names = (await searchLearned("filter_test_output")).tools.map((t) => t.name);

    expect(names.slice(0, 2)).toEqual(["filter_test_output", "filter_test_output_summary"]);
  });
});

/** A learned tool as the agent sees it: catalog description, then the local recorded program. */
type LearnedTool = [name: string, catalog: string, recorded: string];

/** Searches a workspace holding `tools`, each tool's recorded program described locally. */
async function searchLearnedCatalog(
  tools: readonly LearnedTool[],
  query: string,
): Promise<SearchToolsResponse> {
  const registry = new ToolRegistry();
  const recordedByDigest = new Map<string, string>();
  for (const [index, [name, catalog, recorded]] of tools.entries()) {
    const artifactDigest = String(index).repeat(64);
    recordedByDigest.set(artifactDigest, recorded);
    await registry.registerTool(
      makeManifest({
        id: `tool_${name}`,
        name,
        description: catalog,
        metadata: { tags: ["shell"] },
      }),
      undefined,
      { workspaceId: "ws-learned-catalog", artifactDigest },
    );
  }
  const describer = (tool: { artifactDigest?: string }) =>
    tool.artifactDigest === undefined ? undefined : recordedByDigest.get(tool.artifactDigest);
  return parseSearchResponse(
    await createSearchToolsHandler(registry, describer)(makeContext("ws-learned-catalog"), {
      query,
      limit: 100,
    }),
  );
}

describe("search_tools over a small catalog of learned AWS tools", () => {
  // Three tools learned from real recurring jobs, described as the agent saw them. Too few tools
  // for any word to be ubiquitous.
  const awsTools: LearnedTool[] = [
    [
      "fetch_aws_cost_and_usage_by_service",
      "Runs `aws ce get-cost-and-usage --profile {profile} --time-period Start=$(date -u -d {relative_start_offset} +%Y-%m-%dT%H:%M:%SZ),End=$(date -u +%Y-%m-%dT%H:%M:%SZ) --granularity {granularity} --metrics {metrics} --group-by Type=DIMENSION,Key=SERVICE` (steps 1 and 5), `aws ce get-cost-and-usage --profile {profile} --time-period Start=$(date. Learned from one run; defaults are the recorded values.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "aws ce get-cost-and-usage --profile {profile} --time-period Start=$(date -u -d {relative_start_offset} +%Y-%m-%dT%H:%M:%SZ),End=$(date -u +%Y-%m-%dT%H:%M:%SZ) --granularity {granularity} --metrics {metrics} --group-by Type=DIMENSION,Key=SERVICE",
        "Step 2 calls the harness's read tool with path = artifact://1",
        "Step 3 runs this recorded shell program:",
        "aws ce get-cost-and-usage --profile {profile} --time-period Start=$(date -u -d {relative_start_offset} +%Y-%m-%dT%H:%M:%SZ),End=$(date -u +%Y-%m-%dT%H:%M:%SZ) --granularity {granularity_sub} --metrics {metrics} --group-by Type=DIMENSION,Key=SERVICE",
        "Step 4 calls the harness's read tool with path = artifact://3",
        "Step 5 runs this recorded shell program:",
        "aws ce get-cost-and-usage --profile {profile} --time-period Start=$(date -u -d {relative_start_offset} +%Y-%m-%dT%H:%M:%SZ),End=$(date -u +%Y-%m-%dT%H:%M:%SZ) --granularity {granularity} --metrics {metrics} --group-by Type=DIMENSION,Key=SERVICE --output json | jq '[.ResultsByTime[].Groups[] | {service: .Keys[0], amount: (.Metrics.{metrics}.Amount | tonumber)}] | group_by(.service) | map({service: .[0].service, usd: (map(.amount) | add)}) | sort_by(-.usd)'",
        "Parameters (each replaces its {name} above; omitted, the recorded value runs): profile = acme-production-auto; relative_start_offset = 24 hours ago; granularity = HOURLY; metrics = UnblendedCost; granularity_sub = DAILY",
      ].join("\n"),
    ],
    [
      "verify_identity_and_get_cost_usage",
      "Runs aws sts get-caller-identity --profile acme-production-auto && aws sts get-caller-identity --profile acme-nonprod-auto, then aws ce get-cost-and-usage --profile {aws_profile} --time-period {cost_time_period} --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json. Returns the outputs of both steps in recorded order.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "aws sts get-caller-identity --profile acme-production-auto && aws sts get-caller-identity --profile acme-nonprod-auto",
        "Step 2 runs this recorded shell program:",
        "aws ce get-cost-and-usage --profile {aws_profile} --time-period {cost_time_period} --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json",
        "Parameters (each replaces its {name} above; omitted, the recorded value runs): aws_profile = acme-production-auto; cost_time_period = Start=2026-10-01,End=2026-10-05",
      ].join("\n"),
    ],
    [
      "describe_cloudwatch_alarms",
      "Runs aws cloudwatch describe-alarms --profile {profile} --region {region} --alarm-names {alarm_names} {text_filter}. Returns the JSON result of the describe-alarms call. Use this tool when you need to retrieve CloudWatch alarms matching the given names and text filter, instead of running the AWS CLI command manually. Learned from one run; defaults are the recorded values.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "aws cloudwatch describe-alarms --profile {profile} --region {region} --alarm-names {alarm_names} {text_filter}",
        "Parameters (each replaces its {name} above; omitted, the recorded value runs): profile = acme-production-auto; region = us-east-1; alarm_names = acme-production-http-api-latency-p95; text_filter = acme-production-active-daemons-anomaly",
      ].join("\n"),
    ],
  ];

  async function searchAwsResponse(query: string): Promise<SearchToolsResponse> {
    return searchLearnedCatalog(awsTools, query);
  }

  async function searchAws(query: string): Promise<string[]> {
    return (await searchAwsResponse(query)).tools.map((tool) => tool.name);
  }

  it("finds both cost tools for a cost question, and not the alarm tool", async () => {
    const names = await searchAws(
      "AWS cost and usage compare daily service breakdown today yesterday",
    );

    expect(names[0]).toBe("fetch_aws_cost_and_usage_by_service");
    expect(names.sort()).toEqual([
      "fetch_aws_cost_and_usage_by_service",
      "verify_identity_and_get_cost_usage",
    ]);
  });

  it("finds only the alarm tool for a CloudWatch alarm question", async () => {
    expect(
      await searchAws("CloudWatch describe-alarms investigate alarm history metric datapoints"),
    ).toEqual(["describe_cloudwatch_alarms"]);
  });

  it("finds nothing for a PostHog question that shares only `hours` with the cost tool", async () => {
    expect(
      await searchAws(
        "PostHog error tracking issues exceptions insights events breakdown last 36 hours",
      ),
    ).toEqual([]);
    expect(
      await searchAws("PostHog errors insights exceptions error tracking last 24 hours"),
    ).toEqual([]);
  });

  it("finds nothing for a grievance question that shares only `and` or `the` with the tools", async () => {
    expect(
      await searchAws("omp grievances list current grievances and identify most destructive"),
    ).toEqual([]);
    expect(
      await searchAws("review grievances and identify the most destructive grievance currently"),
    ).toEqual([]);
  });

  it("does not match on task-framing words alone, but still lists every tool for an empty query", async () => {
    expect(
      await searchAws(
        "list the current breakdown for the last hours, identify most, compare today",
      ),
    ).toEqual([]);
    expect((await searchAws("")).sort()).toEqual(awsTools.map(([name]) => name).sort());
  });

  it("still lets a framing word rank tools once a distinctive word matches", async () => {
    expect(await searchAws("daily aws cost")).toEqual([
      "fetch_aws_cost_and_usage_by_service",
      "verify_identity_and_get_cost_usage",
    ]);
  });

  it("tells the agent to do the task itself only when a non-empty query matches no tool", async () => {
    const none = await searchAwsResponse("PostHog errors insights exceptions error tracking");
    expect(none).toEqual({
      tools: [],
      total: 0,
      limit: 100,
      offset: 0,
      hasMore: false,
      note: NO_MATCHING_TOOL_NOTE,
    });

    expect(await searchAwsResponse("aws cost")).not.toHaveProperty("note");
    expect(await searchAwsResponse("")).not.toHaveProperty("note");
    expect(await searchAwsResponse("   ")).not.toHaveProperty("note");
  });

  it("matches a command a tool's recorded program runs, but not a value one run passed it", async () => {
    // `jq` and `sts` are commands, `jq` only in the local recorded program.
    expect(await searchAws("jq")).toEqual(["fetch_aws_cost_and_usage_by_service"]);
    expect(await searchAws("sts get-caller-identity")).toEqual([
      "verify_identity_and_get_cost_usage",
    ]);
    // Profile, alarm and dimension values, and Resin's framing around the programs.
    expect(await searchAws("acme")).toEqual([]);
    expect(await searchAws("anomaly daemons nonprod")).toEqual([]);
    expect(await searchAws("this machine")).toEqual([]);
  });
});

describe("search_tools over the learned tools of a later run", () => {
  // The workspace's tools after a second run of the same jobs, as the agent saw them.
  const laterTools: LearnedTool[] = [
    [
      "get_aws_cost_and_usage",
      "Runs `aws sts get-caller-identity --profile acme-production-auto` and `aws ce get-cost-and-usage --profile acme-production-auto --time-period {time_period} --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE` to verify the caller identity and retrieve monthly. The job ran 2 times with different time_period; call it once per value or use for_each to cover them all.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "aws sts get-caller-identity --profile acme-production-auto",
        "Step 2 runs this recorded shell program:",
        "aws ce get-cost-and-usage --profile acme-production-auto --time-period {time_period} --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE",
        "Required parameters (each replaces its {name} above; its recorded value was a date, so pass the current one in the same form): time_period (recorded: Start=2026-10-01,End=2026-10-05)",
      ].join("\n"),
    ],
    [
      "describe_cloudwatch_alarms",
      "Runs aws cloudwatch describe-alarms --profile {profile} --region {region} --alarm-names {alarm_names}. Returns the JSON result of describing the specified CloudWatch alarms. An agent should call this when it needs to retrieve alarm details instead of manually querying the AWS CLI. Learned from one run; defaults are the recorded values.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "aws cloudwatch describe-alarms --profile {profile} --region {region} --alarm-names {alarm_names}",
        'Parameters (each replaces its {name} above; omitted, the recorded value runs): profile = acme-production-auto; region = us-east-1; alarm_names = ["acme-production-serverless-http-api-latency-p95","acme-production-serverless-active-daemons-anomaly"]',
      ].join("\n"),
    ],
    [
      "run_omp_grievances",
      "Runs omp grievances, processing complaint records and generating resolution reports for the grievance management system. Learned from one run; defaults are the recorded values.",
      [
        "Recorded on this machine:",
        "Step 1 runs this recorded shell program:",
        "omp grievances",
      ].join("\n"),
    ],
  ];

  async function searchLater(query: string): Promise<string[]> {
    return (await searchLearnedCatalog(laterTools, query)).tools.map((tool) => tool.name);
  }

  it("finds nothing for a question about the acme daemon that only recorded values mention", async () => {
    // `acme` is only in the recorded profile and alarm names, `daemons` only in an alarm name,
    // `service` only in `Key=SERVICE` and `machine` only in Resin's "Recorded on this machine".
    expect(
      await searchLater(
        "check whether any acme daemon processes or services are currently running on this machine",
      ),
    ).toEqual([]);
  });

  it("still finds each tool for the questions it was learned for", async () => {
    expect(
      await searchLater(
        "AWS Cost Explorer daily cost breakdown by service yesterday today get-cost-and-usage",
      ),
    ).toEqual(["get_aws_cost_and_usage"]);
    expect(
      await searchLater(
        "CloudWatch describe-alarms production HTTP API 5xx alarm and investigate alarm history",
      ),
    ).toEqual(["describe_cloudwatch_alarms"]);
    expect(
      await searchLater(
        "omp grievances list review current grievances and identify most destructive",
      ),
    ).toEqual(["run_omp_grievances"]);
    expect(
      await searchLater("PostHog errors analytics insights exception issues last 36 hours"),
    ).toEqual([]);
  });
});
