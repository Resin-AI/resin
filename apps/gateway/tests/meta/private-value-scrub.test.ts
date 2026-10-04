/**
 * Defense in depth: whatever text a meta tool builds about a learned tool, no private value its plan
 * resolves on this machine reaches the model. Each source here deliberately carries the value (the
 * catalog description, the local describer, the input docs and a dated recorded value), so only the
 * scrub stands between it and the response.
 */

import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createGetToolSchemaHandler } from "../../src/meta/get-tool-schema.js";
import { createManageToolsHandler } from "../../src/meta/manage-tools.js";
import {
  SCRUBBED_PRIVATE_VALUE,
  scrubPrivateValues,
  scrubbablePrivateValues,
} from "../../src/meta/private-values.js";
import { createSearchToolsHandler } from "../../src/meta/search-tools.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

const SECRET = "ghp_canaryTokenValue1234567890";
const DATED_SECRET = `s3://canary-bucket-${SECRET}/2026-10-01/`;

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first && "text" in first ? String(first.text) : "";
}

function context(): WorkspaceContext {
  return {
    workspaceId: "ws-scrub",
    canonicalRoot: "/workspaces/ws-scrub",
    name: "ws-scrub",
    source: "cwd_fallback",
    roots: [{ uri: "file:///workspaces/ws-scrub", path: "/workspaces/ws-scrub" }],
  };
}

function manifest(): ToolManifest {
  const raw = {
    id: "tool_push_release",
    name: "push_release",
    version: "1.0.0",
    description: `Pushes the release with token ${SECRET}.`,
    parameters: ToolParameterSchema.parse({
      type: "object",
      properties: {
        bucket: { type: "string", description: `Bucket, such as ${DATED_SECRET}.` },
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

/** A describer that leaks, standing for any path that would put a resolved value in local detail. */
const describer = () => `Recorded on this machine:\ngh release upload ${SECRET}`;

async function setup() {
  const registry = new ToolRegistry();
  await registry.registerTool(manifest(), undefined, { workspaceId: "ws-scrub" });
  registry.setLocalToolDescriber(describer);
  registry.setLocalToolDatedInputs(() => new Map([["bucket", DATED_SECRET]]));
  registry.setLocalToolPrivateValues(() => scrubbablePrivateValues([SECRET]));
  return registry;
}

describe("scrubbing private values from meta-tool text", () => {
  it("replaces each value, longest first, and skips values too short to be specific", () => {
    const values = scrubbablePrivateValues([
      "abc",
      "token",
      "token-long",
      ["token-long"],
      { k: 7 },
    ]);
    expect(values).toEqual(["token-long", "token"]);
    expect(scrubPrivateValues("a token-long and a token; abc", values)).toBe(
      `a ${SCRUBBED_PRIVATE_VALUE} and a ${SCRUBBED_PRIVATE_VALUE}; abc`,
    );
  });

  it("search_tools returns no private value", async () => {
    const registry = await setup();
    const response = text(
      await createSearchToolsHandler(registry, describer)(context(), {
        query: "push release",
      }),
    );
    expect(response).toContain("push_release");
    expect(response).toContain(SCRUBBED_PRIVATE_VALUE);
    expect(response).not.toContain(SECRET);
  });

  it("get_tool_schema returns no private value", async () => {
    const registry = await setup();
    const response = text(
      await createGetToolSchemaHandler(registry, describer)(context(), { toolId: "push_release" }),
    );
    expect(response).toContain("gh release upload");
    expect(response).not.toContain(SECRET);
  });

  it("manage_tools list_versions returns no private value", async () => {
    const registry = await setup();
    const response = text(
      await createManageToolsHandler(registry)(context(), {
        action: "list_versions",
        compact: true,
      }),
    );
    expect(response).toContain("push_release");
    expect(response).not.toContain(SECRET);
  });

  it("the native tool list returns no private value", async () => {
    const registry = await setup();
    const tools = await new RegistryGatewayRouter(registry).listCatalogNoticeTools(context());
    const tool = tools.find((each) => each.name === "push_release");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).not.toContain(SECRET);
  });
});
