import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolManifestSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { SafetyGateEvaluator, createSafetyAttestation } from "@resin/runtime";
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/gateway.js";
import { createGetToolSchemaHandler } from "../src/meta/get-tool-schema.js";
import { createInvokeToolHandler } from "../src/meta/invoke-tool.js";
import { createManageToolsHandler } from "../src/meta/manage-tools.js";
import type { ToolInvocationRouter } from "../src/meta/router-contract.js";
import { createSearchToolsHandler } from "../src/meta/search-tools.js";
import { ToolRegistry } from "../src/registry/registry.js";
import { computeManifestDigest } from "../src/registry/validator.js";
import type { WorkspaceContext } from "../src/workspace-resolver.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const toolId = overrides?.id ?? "test_data_tool";
  const raw = {
    id: toolId,
    name: overrides?.name ?? toolId,
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Test tool description",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse({
      secrets: {
        allowedSecretNames: ["GITHUB_TOKEN"],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      ...overrides?.capabilities,
    }),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? { timeoutMs: 5000 }),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T00:00:00.000Z",
  };

  return ToolManifestSchema.parse({
    ...raw,
    digest: computeManifestDigest(raw),
  });
}

function makeContext(workspaceId = "ws-admin-iso-test"): WorkspaceContext {
  return {
    workspaceId,
    canonicalRoot: `/workspaces/${workspaceId}`,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
    harnessId: "test-harness",
    resolvedAt: new Date().toISOString(),
    allowedPaths: ["/workspace"],
    activeEnvelopes: [],
    metadata: {},
  };
}

describe("Secret Administration Isolation from Gateway & MCP Surfaces", () => {
  it("manage_tools strictly rejects administrative secret management actions", async () => {
    const store = createInMemoryStateStore();
    const registry = new ToolRegistry(store);
    const handler = createManageToolsHandler(registry);
    const context = makeContext();

    const adminActions = [
      "addSecret",
      "setSecret",
      "rotateSecret",
      "deleteSecret",
      "purgeSecrets",
      "getSecret",
      "listSecrets",
      "getVaultKey",
    ];

    for (const action of adminActions) {
      const res = await handler(context, { action, toolId: "tool_secret_worker" });
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? "";
      expect(text).toContain("Unknown management action");
      expect(text).toContain(action);
    }
  });

  it("invoke_tool cannot execute administrative secret operations or bypass registry", async () => {
    const store = createInMemoryStateStore();
    const registry = new ToolRegistry(store);
    const router: ToolInvocationRouter = {
      async invoke(_req) {
        return { content: [{ type: "text", text: "OK" }] };
      },
    };
    const evaluator = new SafetyGateEvaluator({
      attestation: createSafetyAttestation(),
    });
    const handler = createInvokeToolHandler(registry, router, evaluator);
    const context = makeContext();

    // Attempt to invoke secret administrative functions directly via invoke_tool
    const secretTools = ["secret_add", "secret_rotate", "secret_delete", "vault_dump", "getSecret"];

    for (const toolId of secretTools) {
      const res = await handler(context, {
        toolId,
        parameters: { name: "GITHUB_TOKEN", value: "malicious_payload" },
      });

      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? "";
      expect(text).toContain("not found or not accessible in workspace");
    }
  });

  it("search_tools and get_tool_schema never disclose raw secret values or vault internals", async () => {
    const store = createInMemoryStateStore();
    const registry = new ToolRegistry(store);
    const context = makeContext();

    const tool = makeManifest({
      id: "api_fetcher",
      name: "API Fetcher Tool",
      description: "Uses GITHUB_TOKEN to fetch repositories",
    });

    await registry.registerTool(tool, undefined, { workspaceId: context.workspaceId });

    // 1. Search tools
    const searchHandler = createSearchToolsHandler(registry);
    const searchRes = await searchHandler(context, { query: "api" });
    expect(searchRes.isError).toBeFalsy();
    const searchText = searchRes.content[0]?.text ?? "";

    expect(searchText).toContain("api_fetcher");
    // Verify no secret values, private tokens, or vault keys exist in output
    expect(searchText).not.toContain("ghp_");
    expect(searchText).not.toContain("sk_");
    expect(searchText).not.toContain("vault");

    // 2. Get tool schema
    const schemaHandler = createGetToolSchemaHandler(registry);
    const schemaRes = await schemaHandler(context, { toolId: "api_fetcher" });
    expect(schemaRes.isError).toBeFalsy();
    const schemaText = schemaRes.content[0]?.text ?? "";

    expect(schemaText).toContain("api_fetcher");
    expect(schemaText).not.toContain("ghp_");
    expect(schemaText).not.toContain("vault");
  });

  it("redactSensitiveText comprehensively redacts tokens, bearer headers, and keys from errors", () => {
    const sensitiveMessages = [
      "Authorization error: Bearer ghp_1234567890abcdef1234567890abcdef failed",
      "Invalid API key: sk-proj-1234567890abcdef1234567890",
      "Connection failed to http://user:super_secret_password@api.example.com/data",
      "Vault error for secret=my_db_password_123 in /home/user/app",
    ];

    for (const msg of sensitiveMessages) {
      const redacted = redactSensitiveText(msg);
      expect(redacted).not.toContain("ghp_1234567890abcdef1234567890abcdef");
      expect(redacted).not.toContain("sk-proj-1234567890abcdef1234567890");
      expect(redacted).toContain("[REDACTED_SECRET]");
    }
  });

  it("strictly enforces workspace boundary isolation preventing cross-tenant secret discovery", async () => {
    const store = createInMemoryStateStore();
    const registry = new ToolRegistry(store);

    const ctxA = makeContext("workspace_tenant_a");
    const ctxB = makeContext("workspace_tenant_b");

    const toolA = makeManifest({
      id: "tenant_a_tool",
      name: "Tenant A Private Tool",
    });

    await registry.registerTool(toolA, undefined, { workspaceId: ctxA.workspaceId });

    // Workspace B searches tools
    const searchHandler = createSearchToolsHandler(registry);
    const searchRes = await searchHandler(ctxB, { query: "tenant" });
    const searchParsed = JSON.parse(searchRes.content[0]?.text ?? "{}");

    expect(searchParsed.tools.some((t: { toolId: string }) => t.toolId === "tenant_a_tool")).toBe(
      false,
    );

    // Workspace B attempts schema lookup for tool A
    const schemaHandler = createGetToolSchemaHandler(registry);
    const schemaRes = await schemaHandler(ctxB, { toolId: "tenant_a_tool" });
    expect(schemaRes.isError).toBe(true);
    expect(schemaRes.content[0]?.text).toContain(
      "not found or not accessible in workspace 'workspace_tenant_b'",
    );
  });
});
