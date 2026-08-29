import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest, computeSha256 } from "../../src/registry/validator.js";
import { makeV1ToolLockFixture } from "./fixtures.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "tool_1",
    name: overrides?.name ?? "test_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Test tool description",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https" as const],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("ToolRegistry - Workspace-Scoped Visibility & Scope Hierarchy", () => {
  it("resolves system tools globally across all workspaces", async () => {
    const registry = new ToolRegistry();
    const systemManifest = makeManifest({
      id: "sys_fetch",
      name: "fetch",
      version: "1.0.0",
      scope: "global",
    });

    await registry.registerTool(systemManifest);

    const ws1Catalog = await registry.resolveCatalog("ws-1");
    const ws2Catalog = await registry.resolveCatalog("ws-2");

    expect(ws1Catalog.tools.sys_fetch).toBeDefined();
    expect(ws1Catalog.tools.sys_fetch.version).toBe("1.0.0");
    expect(ws2Catalog.tools.sys_fetch).toBeDefined();
    expect(ws2Catalog.tools.sys_fetch.version).toBe("1.0.0");
  });

  it("isolates workspace-scoped tools to their respective workspace", async () => {
    const registry = new ToolRegistry();
    const wsManifest = makeManifest({
      id: "tool_editor",
      name: "editor",
      version: "1.0.0",
      scope: "workspace",
    });

    await registry.registerTool(wsManifest, undefined, { workspaceId: "ws-alpha" });

    const alphaCatalog = await registry.resolveCatalog("ws-alpha");
    const betaCatalog = await registry.resolveCatalog("ws-beta");

    expect(alphaCatalog.tools.tool_editor).toBeDefined();
    expect(betaCatalog.tools.tool_editor).toBeUndefined();
  });

  it("allows workspace tools to override system tools with same ID", async () => {
    const registry = new ToolRegistry();

    const systemManifest = makeManifest({
      id: "tool_search",
      name: "search",
      version: "1.0.0",
      scope: "global",
    });
    const wsOverrideManifest = makeManifest({
      id: "tool_search",
      name: "search_specialized",
      version: "2.0.0",
      scope: "workspace",
    });

    await registry.registerTool(systemManifest);
    await registry.registerTool(wsOverrideManifest);
    await registry.activateToolVersion("tool_search", "2.0.0", "ws-custom");

    const customCatalog = await registry.resolveCatalog("ws-custom");
    const defaultCatalog = await registry.resolveCatalog("ws-other");

    expect(customCatalog.tools.tool_search.version).toBe("2.0.0");
    expect(defaultCatalog.tools.tool_search.version).toBe("1.0.0");
  });

  it("allows session tools to override workspace tools for a specific session", async () => {
    const registry = new ToolRegistry();

    const wsManifest = makeManifest({
      id: "tool_runner",
      name: "runner",
      version: "1.0.0",
      scope: "workspace",
    });
    const sessionManifest = makeManifest({
      id: "tool_runner",
      name: "runner_canary",
      version: "1.1.0-canary",
      scope: "session",
    });

    await registry.registerTool(wsManifest, undefined, { workspaceId: "ws-main" });
    await registry.registerTool(sessionManifest);
    await registry.activateToolVersion("tool_runner", "1.1.0-canary", "ws-main", {
      sessionId: "sess-canary-42",
    });

    const sessionCatalog = await registry.resolveCatalog("ws-main", "sess-canary-42");
    const generalCatalog = await registry.resolveCatalog("ws-main");

    expect(sessionCatalog.tools.tool_runner.version).toBe("1.1.0-canary");
    expect(generalCatalog.tools.tool_runner.version).toBe("1.0.0");
  });

  it("isolates bound workspaces from unbound workspace scope activations", async () => {
    const registry = new ToolRegistry();

    const toolAlphaId = "550e8400-e29b-41d4-a716-446655440001";
    const manifestAlpha = makeManifest({
      id: toolAlphaId,
      name: "tool_alpha",
      version: "1.0.0",
    });
    const digestAlpha = computeManifestDigest(manifestAlpha);
    const artAlpha = "a".repeat(64);
    await registry.stageToolVersion(manifestAlpha, {
      artifactDigest: artAlpha,
      bundleReference: {
        uri: `memory://${artAlpha}`,
        hash: computeSha256("export default function() {}"),
        sizeBytes: 10,
        format: "embedded",
      },
      entrypoint: "index.js",
      sourceCode: "export default function() {}",
      checksums: {},
    });

    // An unbound tool registered in unbound workspace
    const toolBetaId = "550e8400-e29b-41d4-a716-446655440002";
    const manifestBeta = makeManifest({
      id: toolBetaId,
      name: "tool_beta",
      version: "1.0.0",
    });
    await registry.registerTool(manifestBeta, undefined, { workspaceId: "ws-unbound" });

    // Bound workspace has lock for tool_alpha ONLY
    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId: toolAlphaId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digestAlpha,
        artifactDigest: artAlpha,
        status: "active",
      },
    });

    registry.bindWorkspaceLock("ws-bound", lock);

    const boundCatalog = await registry.resolveCatalog("ws-bound");
    const unboundCatalog = await registry.resolveCatalog("ws-unbound");

    expect(boundCatalog.tools[toolAlphaId]).toBeDefined();
    expect(boundCatalog.tools[toolBetaId]).toBeUndefined();

    expect(unboundCatalog.tools[toolBetaId]).toBeDefined();
  });

  it("allows user controls to disable a tool even if present in the bound lock", async () => {
    const registry = new ToolRegistry();

    const toolAlphaId = "550e8400-e29b-41d4-a716-446655440001";
    const manifestAlpha = makeManifest({
      id: toolAlphaId,
      name: "tool_alpha",
      version: "1.0.0",
    });
    const digestAlpha = computeManifestDigest(manifestAlpha);
    const artAlpha = "a".repeat(64);
    await registry.stageToolVersion(manifestAlpha, {
      artifactDigest: artAlpha,
      bundleReference: {
        uri: `memory://${artAlpha}`,
        hash: computeSha256("export default function() {}"),
        sizeBytes: 10,
        format: "embedded",
      },
      entrypoint: "index.js",
      sourceCode: "export default function() {}",
      checksums: {},
    });

    const lock = makeV1ToolLockFixture({
      tool_alpha: {
        toolId: toolAlphaId,
        name: "tool_alpha",
        version: "1.0.0",
        manifestDigest: digestAlpha,
        artifactDigest: artAlpha,
        status: "active",
      },
    });
    registry.bindWorkspaceLock("ws-disabled-ctrl", lock);

    // Disable via user controls
    await registry.controls.disableTool("ws-disabled-ctrl", toolAlphaId);

    const catalog = await registry.resolveCatalog("ws-disabled-ctrl");
    expect(catalog.tools[toolAlphaId]).toBeUndefined();

    const tool = await registry.getTool("tool_alpha", "ws-disabled-ctrl");
    expect(tool).toBeUndefined();
  });
});
