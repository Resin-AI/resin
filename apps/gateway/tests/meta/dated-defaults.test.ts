/**
 * Recorded defaults that name a date are required, not defaulted: the detection table, the schema
 * an agent is served for them through search_tools, get_tool_schema and the native tool list, and
 * the refusal a call without one gets.
 */

import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  isDatedValue,
  missingDatedInputs,
  missingDatedInputsMessage,
  requireDatedInputs,
} from "../../src/meta/dated-defaults.js";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { type SearchToolsResponse, createSearchToolsHandler } from "../../src/meta/search-tools.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const RECORDED_PERIOD = "Start=2026-10-01,End=2026-10-05";

describe("isDatedValue", () => {
  it.each([
    ["2026-10-01", true],
    ["2026-10-01T09:30:00Z", true],
    ["2026-10-01T09:30:00.123+02:00", true],
    [RECORDED_PERIOD, true],
    ["--since=2024-02-29", true],
    ["report-2026-10-01.csv", true],
    [String(Math.floor(NOW / 1000)), true],
    [String(NOW), true],
    [String(Math.floor(NOW / 1000) - 3 * 365 * 24 * 3600), true],
    // Not dates: versions, addresses, counts, ids, impossible calendar days, far-off epochs.
    ["1.0.120", false],
    ["10.0.0.1", false],
    ["192.168.1.254", false],
    ["30", false],
    ["2026", false],
    ["2025-01", false],
    ["acme-production", false],
    ["550e8400-e29b-41d4-a716-446655440000", false],
    ["2026-13-01", false],
    ["2026-02-30", false],
    ["2025-02-29", false],
    ["12026-10-011", false],
    ["1234567890", false],
    ["9999999999999", false],
    ["0000000000", false],
    ["", false],
  ])("%s → %s", (value, expected) => {
    expect(isDatedValue(value, NOW)).toBe(expected);
  });
});

describe("requireDatedInputs", () => {
  const schema = {
    type: "object",
    properties: {
      aws_profile: {
        type: "string",
        description: "AWS CLI profile name. Omit to use the recorded value.",
      },
      cost_time_period: {
        type: "string",
        description:
          "Time period in Start=YYYY-MM-DD,End=YYYY-MM-DD format. Omit to use the recorded value.",
      },
    },
    required: [] as string[],
    additionalProperties: false,
  };

  it("requires each dated input and says why, leaving every other input as it was", () => {
    const served = requireDatedInputs(schema, new Map([["cost_time_period", RECORDED_PERIOD]]));
    expect(served.required).toEqual(["cost_time_period"]);
    expect(served.properties.aws_profile).toBe(schema.properties.aws_profile);
    expect(served.properties.cost_time_period.description).toBe(
      `Time period in Start=YYYY-MM-DD,End=YYYY-MM-DD format. Required: its recorded value (${RECORDED_PERIOD}) was a date, so pass the current one in the same form.`,
    );
    // The catalog's schema itself is never modified.
    expect(schema.required).toEqual([]);
    expect(schema.properties.cost_time_period.description).toContain("Omit to use");
  });

  it("returns the schema as is with no dated input, or none it declares", () => {
    expect(requireDatedInputs(schema, new Map())).toBe(schema);
    expect(requireDatedInputs(schema, new Map([["undeclared", "2026-10-01"]]))).toBe(schema);
  });

  it("keeps existing required inputs without repeating one", () => {
    const served = requireDatedInputs(
      { ...schema, required: ["aws_profile", "cost_time_period"] },
      new Map([["cost_time_period", RECORDED_PERIOD]]),
    );
    expect(served.required).toEqual(["aws_profile", "cost_time_period"]);
  });
});

describe("missing dated inputs", () => {
  const dated = new Map([["cost_time_period", RECORDED_PERIOD]]);

  it("names each dated input a call left out", () => {
    expect(missingDatedInputs(dated, {})).toEqual(["cost_time_period"]);
    expect(missingDatedInputs(dated, { aws_profile: "x" })).toEqual(["cost_time_period"]);
    expect(missingDatedInputs(dated, { cost_time_period: "Start=2026-11-01" })).toEqual([]);
  });

  it("tells the caller which input, why, and the form to pass", () => {
    expect(missingDatedInputsMessage(dated, ["cost_time_period"])).toBe(
      `Missing required input cost_time_period (recorded: ${RECORDED_PERIOD}): the recorded value was a date, so rerunning it would return results for that recorded date. Pass the current value in the same form and call again.`,
    );
  });
});

function parseText<T>(result: CallToolResult): T {
  const first = result.content[0];
  return JSON.parse(first && "text" in first ? String(first.text) : "{}") as T;
}

function makeContext(workspaceId: string): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
  };
}

/** A learned tool with one dated and one plain recorded-default input. */
function costManifest(): ToolManifest {
  const raw = {
    id: "tool_cost_usage",
    name: "verify_identity_and_get_cost_usage",
    version: "1.0.0",
    description: "Verifies the AWS identity and reports cost and usage.",
    parameters: ToolParameterSchema.parse({
      type: "object",
      properties: {
        aws_profile: {
          type: "string",
          description: "AWS CLI profile name. Omit to use the recorded value.",
        },
        cost_time_period: {
          type: "string",
          description: "Time period for the cost query. Omit to use the recorded value.",
        },
      },
      required: [],
    }),
    runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
    capabilities: CapabilityManifestSchema.parse({}),
    limits: ToolLimitConfigSchema.parse({}),
    scope: "workspace" as const,
    metadata: {},
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  return { ...raw, digest: computeManifestDigest(raw) };
}

describe("serving a learned tool with a dated recorded default", () => {
  async function setup() {
    const registry = new ToolRegistry();
    const context = makeContext("ws-dated");
    await registry.registerTool(costManifest(), undefined, { workspaceId: "ws-dated" });
    registry.setLocalToolDatedInputs(
      () => new Map([["cost_time_period", RECORDED_PERIOD]]) as ReadonlyMap<string, string>,
    );
    return { registry, context };
  }

  function expectDatedRequired(schema: {
    required?: string[];
    properties?: Record<string, { description?: string }>;
  }) {
    expect(schema.required).toEqual(["cost_time_period"]);
    expect(schema.properties?.cost_time_period?.description).toContain(
      `Required: its recorded value (${RECORDED_PERIOD}) was a date`,
    );
    expect(schema.properties?.cost_time_period?.description).not.toContain("Omit to use");
    expect(schema.properties?.aws_profile?.description).toBe(
      "AWS CLI profile name. Omit to use the recorded value.",
    );
  }

  it("lists the dated input as required in search_tools", async () => {
    const { registry, context } = await setup();
    const response = parseText<SearchToolsResponse>(
      await createSearchToolsHandler(registry)(context, { query: "cost usage" }),
    );
    const tool = response.tools.find((each) => each.name === "verify_identity_and_get_cost_usage");
    expect(tool).toBeDefined();
    expectDatedRequired(tool?.inputSchema as never);
  });

  it("lists the dated input as required in get_tool_schema", async () => {
    const { registry, context } = await setup();
    const response = parseText<{ inputSchema: never }>(
      await createGetToolSchemaHandler(registry)(context, {
        toolId: "verify_identity_and_get_cost_usage",
      }),
    );
    expectDatedRequired(response.inputSchema);
  });

  it("lists the dated input as required in the native tool list", async () => {
    const { registry, context } = await setup();
    const tools = await new RegistryGatewayRouter(registry).listCatalogNoticeTools(context);
    const tool = tools.find((each) => each.name === "verify_identity_and_get_cost_usage");
    expect(tool?.inputSchema.required).toEqual(["cost_time_period"]);
  });

  it("serves the catalog schema unchanged without a dated input", async () => {
    const registry = new ToolRegistry();
    const context = makeContext("ws-dated");
    await registry.registerTool(costManifest(), undefined, { workspaceId: "ws-dated" });
    registry.setLocalToolDatedInputs(() => new Map());
    const response = parseText<{ inputSchema: { required: string[] } }>(
      await createGetToolSchemaHandler(registry)(context, {
        toolId: "verify_identity_and_get_cost_usage",
      }),
    );
    expect(response.inputSchema.required).toEqual([]);
  });
});
