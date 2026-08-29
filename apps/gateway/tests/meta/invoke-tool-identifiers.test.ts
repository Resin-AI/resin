import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import type {
  ToolInvocationRequest,
  ToolInvocationRouter,
} from "../../src/meta/router-contract.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function manifest(id: string, name: string): ToolManifest {
  const raw = {
    id,
    name,
    version: "1.0.0",
    description: "Identifier resolution test tool",
    parameters: ToolParameterSchema.parse({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    runtime: ToolRuntimeRequirementSchema.parse({ runtime: "builtin" }),
    capabilities: CapabilityManifestSchema.parse({}),
    limits: ToolLimitConfigSchema.parse({ timeoutMs: 1000 }),
    scope: "workspace" as const,
    metadata: {},
    createdAt: "2026-08-18T00:00:00.000Z",
  };
  return { ...raw, digest: computeManifestDigest(raw) };
}

function context(): WorkspaceContext {
  return {
    workspaceId: "ws-identifiers",
    canonicalRoot: "/workspaces/ws-identifiers",
    name: "ws-identifiers",
    source: "cwd_fallback",
    roots: [
      {
        uri: "file:///workspaces/ws-identifiers",
        path: "/workspaces/ws-identifiers",
      },
    ],
    harnessId: "test-harness",
  };
}

describe("invoke_tool identifier resolution", () => {
  it("uses an unambiguous public name when the supplied internal toolId is stale", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(manifest("tool-current", "public_tool"), undefined, {
      workspaceId: "ws-identifiers",
    });

    let captured: ToolInvocationRequest | undefined;
    const router: ToolInvocationRouter = {
      async invoke(request: ToolInvocationRequest): Promise<CallToolResult> {
        captured = request;
        return { content: [{ type: "text", text: "OK" }] };
      },
    };

    const result = await createInvokeToolHandler(registry, router)(context(), {
      toolId: "tool-stale",
      name: "public_tool",
      parameters: {},
    });

    expect(result.isError).toBeFalsy();
    expect(captured?.toolId).toBe("tool-current");
    expect(captured?.name).toBe("public_tool");
  });

  it("rejects identifiers that resolve to different installed tools", async () => {
    const registry = new ToolRegistry();
    await registry.registerTool(manifest("tool-one", "public_one"), undefined, {
      workspaceId: "ws-identifiers",
    });
    await registry.registerTool(manifest("tool-two", "public_two"), undefined, {
      workspaceId: "ws-identifiers",
    });

    const router: ToolInvocationRouter = {
      async invoke(): Promise<CallToolResult> {
        return { content: [{ type: "text", text: "unexpected" }] };
      },
    };

    const result = await createInvokeToolHandler(registry, router)(context(), {
      toolId: "tool-one",
      name: "public_two",
      parameters: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Conflicting tool identifiers");
  });
});
