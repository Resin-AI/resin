import {
  CapabilityManifestSchema,
  ToolArtifactSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type GetToolSchemaResponse,
  createGetToolSchemaHandler,
} from "../../src/meta/get-tool-schema.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function parseResponseJson(result: CallToolResult): GetToolSchemaResponse {
  const first = result.content[0];
  const text =
    first && "text" in first && Object.prototype.toString.call(first.text) === "[object String]"
      ? String(first.text)
      : "{}";
  // SAFETY: Test helper parses serialized JSON response into GetToolSchemaResponse domain object.
  return JSON.parse(text) as GetToolSchemaResponse;
}

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const raw = {
    id: overrides?.id ?? "tool_calc",
    name: overrides?.name ?? "calculator",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "A math calculator",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          expression: { type: "string", description: "Mathematical expression" },
          precision: { type: "integer", description: "Decimal precision" },
        },
        required: ["expression"],
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse(overrides?.capabilities ?? {}),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? {}),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {
      author: "agent-evolution",
      evolutionCycle: 3,
    },
    createdAt: overrides?.createdAt ?? "2026-08-17T00:00:00.000Z",
  };

  return {
    ...raw,
    digest: computeManifestDigest(raw),
  };
}

function makeContext(workspaceId = "ws-schema", sessionId?: string): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
    sessionId,
  };
}

describe("get_tool_schema Meta-Tool", () => {
  it("retrieves schema by toolId or exposed name", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-schema");

    const manifest = makeManifest({
      id: "tool_math",
      name: "calc_tool",
    });
    await registry.registerTool(manifest, undefined, { workspaceId: "ws-schema" });

    // Lookup by toolId
    const resId = await handler(context, { toolId: "tool_math" });
    expect(resId.isError).toBeFalsy();
    const dataId = parseResponseJson(resId);
    expect(dataId.toolId).toBe("tool_math");
    expect(dataId.name).toBe("calc_tool");
    expect(dataId.inputSchema.properties).toHaveProperty("expression");

    // Lookup by name
    const resName = await handler(context, { name: "calc_tool" });
    expect(resName.isError).toBeFalsy();
    const dataName = parseResponseJson(resName);
    expect(dataName.toolId).toBe("tool_math");

    // Lookup by tool_name alias
    const resAlias = await handler(context, { tool_name: "calc_tool" });
    expect(resAlias.isError).toBeFalsy();
  });

  it("retrieves system meta-tool schemas", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-schema");

    const res = await handler(context, { toolId: "sys_search_tools" });
    expect(res.isError).toBeFalsy();
    const data = parseResponseJson(res);
    expect(data.name).toBe("search_tools");
    expect(data.scope).toBe("system");
    expect(data.inputSchema.properties).toHaveProperty("query");
    expect(data.inputSchema.properties).toHaveProperty("limit");
  });

  it("supports version selection and resolves pinned version by default", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-version");

    const v1 = makeManifest({
      id: "tool_multiver",
      name: "multi_version_tool",
      version: "1.0.0",
      description: "Version 1.0.0 description",
    });
    const v2 = makeManifest({
      id: "tool_multiver",
      name: "multi_version_tool",
      version: "2.0.0",
      description: "Version 2.0.0 description",
    });

    await registry.registerTool(v1, undefined, { workspaceId: "ws-version" });
    await registry.registerTool(v2, undefined, { workspaceId: "ws-version" });

    // Request specific version v1
    const resV1 = await handler(context, { toolId: "tool_multiver", version: "1.0.0" });
    const dataV1 = parseResponseJson(resV1);
    expect(dataV1.version).toBe("1.0.0");
    expect(dataV1.description).toBe("Version 1.0.0 description");

    // Request specific version v2
    const resV2 = await handler(context, { toolId: "tool_multiver", version: "2.0.0" });
    const dataV2 = parseResponseJson(resV2);
    expect(dataV2.version).toBe("2.0.0");
    expect(dataV2.description).toBe("Version 2.0.0 description");

    // Pin to v1 and check default resolution without version param
    await registry.pinToolVersion("tool_multiver", "1.0.0", "ws-version");
    const resPinned = await handler(context, { toolId: "tool_multiver" });
    const dataPinned = parseResponseJson(resPinned);
    expect(dataPinned.version).toBe("1.0.0");
    expect(dataPinned.isPinned).toBe(true);
  });

  it("returns error states for unknown, out-of-scope, and incompatible versions", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);

    // Missing identifier
    const resEmpty = await handler(makeContext("ws-1"), {});
    expect(resEmpty.isError).toBe(true);
    expect(resEmpty.content[0].text).toContain("Parameter 'toolId' or 'name' is required");

    // Unknown tool
    const resUnknown = await handler(makeContext("ws-1"), { toolId: "non_existent_tool" });
    expect(resUnknown.isError).toBe(true);
    expect(resUnknown.content[0].text).toContain("not found or not accessible");

    // Tool registered in workspace 2 looked up from workspace 1
    const toolWs2 = makeManifest({
      id: "tool_ws2",
      name: "ws2_only_tool",
    });
    await registry.registerTool(toolWs2, undefined, { workspaceId: "ws-2" });

    const resLeaked = await handler(makeContext("ws-1"), { toolId: "tool_ws2" });
    expect(resLeaked.isError).toBe(true);
    expect(resLeaked.content[0].text).toContain("not found or not accessible");

    // Incompatible / non-existent version
    const resBadVer = await handler(makeContext("ws-2"), { toolId: "tool_ws2", version: "9.9.9" });
    expect(resBadVer.isError).toBe(true);
    expect(resBadVer.content[0].text).toContain("Version '9.9.9' of tool 'tool_ws2' not found");
  });

  it("returns disabled status when tool is disabled in caller workspace", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-dis");

    const tool = makeManifest({
      id: "tool_dis",
      name: "disable_test_tool",
    });
    await registry.registerTool(tool, undefined, { workspaceId: "ws-dis" });
    await registry.disableTool("tool_dis", "ws-dis");

    const res = await handler(context, { toolId: "tool_dis" });
    expect(res.isError).toBeFalsy();
    const data = parseResponseJson(res);
    expect(data.isDisabled).toBe(true);
    expect(data.status).toBe("disabled");
  });

  it("never leaks raw source code, bundles, or private credentials in schema response", async () => {
    const registry = new ToolRegistry();
    const handler = createGetToolSchemaHandler(registry);
    const context = makeContext("ws-sec");

    const artifact = ToolArtifactSchema.parse({
      artifactDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bundleReference: {
        uri: "file:///workspaces/bundle.js",
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 1024,
        format: "js_bundle",
      },
      entrypoint: "bundle.js",
      checksums: {},
      sourceCode: "const SECRET_KEY = 'super_secret_token_12345'; export function run() { ... }",
    });

    const manifest = makeManifest({
      id: "tool_secure",
      name: "secure_worker",
      metadata: {
        author: "security-auditor",
        evolutionCycle: 5,
        secretEnv: "API_SECRET_TOKEN",
      },
    });

    await registry.registerTool(manifest, artifact, { workspaceId: "ws-sec" });

    const res = await handler(context, { toolId: "tool_secure" });
    expect(res.isError).toBeFalsy();
    const first = res.content[0];
    const rawText =
      first && "text" in first && Object.prototype.toString.call(first.text) === "[object String]"
        ? String(first.text)
        : "";
    expect(rawText).not.toContain("super_secret_token_12345");
    expect(rawText).not.toContain("const SECRET_KEY");

    const data = parseResponseJson(res);
    expect(data.provenance.manifestDigest).toBe(manifest.digest);
    expect(data.provenance.artifactDigest).toBe(artifact.artifactDigest);
    expect(data.provenance.author).toBe("security-auditor");
    expect(data.provenance.evolutionCycle).toBe(5);
  });
});
