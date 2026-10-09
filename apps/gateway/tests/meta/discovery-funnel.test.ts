import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import {
  DiscoveryFunnelStore,
  emptyDiscoveryFunnelCounts,
  setDiscoveryFunnelStore,
} from "@resin/observer/discovery-funnel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import { createManageToolsHandler } from "../../src/meta/manage-tools.js";
import type { ToolInvocationRouter } from "../../src/meta/router-contract.js";
import { createSearchToolsHandler } from "../../src/meta/search-tools.js";
import { McpFrameDecoder, encodeMcpMessage } from "../../src/protocol/framing.js";
import {
  type CallToolResult,
  type JsonRpcMessage,
  RESIN_LEARNED_TOOL_COUNT_META,
  RESIN_LEARNED_TOOL_IDS_META,
  RESIN_LEARNED_TOOL_LISTING_META,
  RESIN_LEARNED_TOOL_META,
} from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { createRegistryGatewayRouter } from "../../src/router.js";
import { createToolSearchSurface } from "../../src/shim/tool-search-surface.js";
import { countSuggestionShown } from "../../src/suggest/funnel.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const WORKSPACE = "ws-funnel";

function makeManifest(): ToolManifest {
  const raw: Omit<ToolManifest, "digest"> = {
    id: "tool_release_notes",
    name: "draft_release_notes",
    version: "1.0.0",
    description: "Draft release notes from merged changes",
    parameters: ToolParameterSchema.parse({
      type: "object",
      properties: { since: { type: "string", description: "Starting tag" } },
      required: ["since"],
    }),
    runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
    capabilities: CapabilityManifestSchema.parse({}),
    limits: ToolLimitConfigSchema.parse({ timeoutMs: 1000 }),
    scope: "workspace",
    metadata: {},
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  // The digest is computed over the manifest without one.
  return { ...raw, digest: computeManifestDigest({ ...raw, digest: "" }) };
}

function makeContext(): WorkspaceContext {
  return {
    workspaceId: WORKSPACE,
    projectId: WORKSPACE,
    projectRoot: `/workspaces/${WORKSPACE}`,
    canonicalRoot: `/workspaces/${WORKSPACE}`,
    startupPath: `/workspaces/${WORKSPACE}`,
    isReadOnly: false,
    name: WORKSPACE,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${WORKSPACE}`, path: `/workspaces/${WORKSPACE}` }],
    harnessId: "test-harness",
  };
}

let stateDir: string;
let store: DiscoveryFunnelStore;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-gateway-funnel-"));
  store = new DiscoveryFunnelStore({
    stateDir,
    flushOnExit: false,
    reporter: () => {
      throw new Error("no reporting in this test");
    },
  });
  setDiscoveryFunnelStore(store);
});

afterEach(() => {
  store.dispose();
  setDiscoveryFunnelStore(undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function registry(): Promise<ToolRegistry> {
  const tools = new ToolRegistry();
  await tools.registerTool(makeManifest(), undefined, { workspaceId: WORKSPACE });
  return tools;
}

/** A registry whose one learned tool this machine says cannot run here. */
async function unavailableRegistry(): Promise<ToolRegistry> {
  const tools = await registry();
  tools.setLocalToolProfile(() => ({ steps: 1, unavailableReason: "its directory is gone" }));
  return tools;
}

const ok: ToolInvocationRouter = {
  async invoke(): Promise<CallToolResult> {
    return { content: [{ type: "text", text: "notes drafted" }] };
  },
};
const failing: ToolInvocationRouter = {
  async invoke(): Promise<CallToolResult> {
    return { isError: true, content: [{ type: "text", text: "git failed" }] };
  },
};

describe("gateway discovery funnel", () => {
  it("counts searches, and searches with results, from search_tools and manage_tools", async () => {
    const tools = await registry();
    const search = createSearchToolsHandler(tools);
    const manage = createManageToolsHandler(tools);

    await search(makeContext(), { query: "release notes" });
    await search(makeContext(), { query: "posthog error tracking" });
    await manage(makeContext(), { action: "list_versions", query: "release" });
    await manage(makeContext(), { action: "list_versions", query: "kubernetes" });
    // A plain listing is not a search.
    await manage(makeContext(), { action: "list_versions" });

    expect(store.pending()).toEqual({
      ...emptyDiscoveryFunnelCounts(),
      searches: 4,
      searches_with_results: 2,
    });
  });

  it("counts schema reads of learned tools only", async () => {
    const tools = await registry();
    const schema = createGetToolSchemaHandler(tools);

    expect((await schema(makeContext(), { name: "draft_release_notes" })).isError).toBeFalsy();
    expect((await schema(makeContext(), { toolId: "sys_search_tools" })).isError).toBeFalsy();
    expect((await schema(makeContext(), { name: "missing_tool" })).isError).toBe(true);

    expect(store.pending()).toEqual({ ...emptyDiscoveryFunnelCounts(), schema_reads: 1 });
  });

  it("counts invoke_tool successes and failures of learned tools", async () => {
    const tools = await registry();
    const params = { name: "draft_release_notes", parameters: { since: "v1.2.0" } };

    expect((await createInvokeToolHandler(tools, ok)(makeContext(), params)).isError).toBeFalsy();
    expect((await createInvokeToolHandler(tools, failing)(makeContext(), params)).isError).toBe(
      true,
    );
    // An unknown tool is not an invocation.
    await createInvokeToolHandler(tools, ok)(makeContext(), { name: "missing", parameters: {} });

    expect(store.pending()).toMatchObject({ invocations_succeeded: 1, invocations_failed: 1 });
  });

  it("counts learned tools the harness calls by name, and not meta-tool calls", async () => {
    const tools = await registry();
    const succeeding = createRegistryGatewayRouter(tools, ok);
    const erroring = createRegistryGatewayRouter(tools, failing);

    await succeeding.callTool(makeContext(), "draft_release_notes", { since: "v1.2.0" });
    await erroring.callTool(makeContext(), "draft_release_notes", { since: "v1.2.0" });
    await succeeding.callTool(makeContext(), "search_tools", { query: "release" });

    expect(store.pending()).toEqual({
      ...emptyDiscoveryFunnelCounts(),
      searches: 1,
      searches_with_results: 1,
      invocations_succeeded: 1,
      invocations_failed: 1,
    });
  });

  it("counts refusals of a tool not offered here, and nothing else for them", async () => {
    const tools = await unavailableRegistry();
    const params = { name: "draft_release_notes", parameters: { since: "v1.2.0" } };

    const viaInvoke = await createInvokeToolHandler(tools, ok)(makeContext(), params);
    const byName = await createRegistryGatewayRouter(tools, ok).callTool(
      makeContext(),
      "draft_release_notes",
      { since: "v1.2.0" },
    );
    const schema = await createGetToolSchemaHandler(tools)(makeContext(), {
      name: "draft_release_notes",
    });

    for (const result of [viaInvoke, byName, schema]) expect(result.isError).toBe(true);
    expect(store.pending()).toEqual({ ...emptyDiscoveryFunnelCounts(), unavailable_here: 3 });
  });

  it("counts the learned tools a search-listing connection lists directly", () => {
    const output = new PassThrough();
    const surface = createToolSearchSurface(output);
    const decoder = new McpFrameDecoder();
    const received: JsonRpcMessage[] = [];
    output.on("data", (chunk: Buffer) => received.push(...decoder.push(chunk)));
    surface.output.pipe(output);
    const list = (id: number, learned: number, listed: number) => {
      const names = Array.from({ length: learned }, (_, index) => `learned_${index}`);
      surface.input.write(encodeMcpMessage({ jsonrpc: "2.0", id, method: "tools/list" }));
      surface.output.write(
        encodeMcpMessage({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              { name: "search_tools", inputSchema: { type: "object" } },
              ...names.map((name) => ({
                name,
                inputSchema: { type: "object" },
                _meta: { [RESIN_LEARNED_TOOL_META]: true },
              })),
            ],
            _meta: {
              [RESIN_LEARNED_TOOL_COUNT_META]: learned,
              [RESIN_LEARNED_TOOL_LISTING_META]: names.slice(0, listed).map((name) => ({ name })),
              [RESIN_LEARNED_TOOL_IDS_META]: Object.fromEntries(
                names.map((name) => [name, `tool_${name}`]),
              ),
            },
          },
        }),
      );
    };
    try {
      list(1, 3, 3);
      // Tools the listing leaves to search are not listed, so none is counted.
      list(2, 11, 0);
      expect(received).toHaveLength(2);
      expect(store.pending()).toEqual({ ...emptyDiscoveryFunnelCounts(), tools_listed: 3 });
    } finally {
      surface.input.end();
      surface.output.end();
    }
  });

  it("counts a shown command suggestion by default", () => {
    countSuggestionShown({ harness: "claude-code" });
    expect(store.pending()).toEqual({ ...emptyDiscoveryFunnelCounts(), suggestions_shown: 1 });
  });
});
