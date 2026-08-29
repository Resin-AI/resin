import type { ToolManifest } from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CanaryCandidate, CanaryRouter } from "../../src/registry/canary-router.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "code_analyzer",
    name: overrides?.name ?? "code_analyzer",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Sample tool for analysis",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "deno" as const,
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
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 80,
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
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("Real Canary Routing & Shadow Execution Suite", () => {
  let store: LocalStateStore;
  let registry: ToolRegistry;
  let canaryRouter: CanaryRouter;
  let router: RegistryGatewayRouter;
  const workspaceId = "ws-canary-test";
  const context: WorkspaceContext = {
    workspaceId,
    sessionId: "session-canary-1",
    rootPath: "/workspaces/canary-test",
    timestamp: Date.now(),
  };

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    registry = new ToolRegistry({ db: store.conn, debounceMs: 0 });
    canaryRouter = new CanaryRouter({
      registry,
      userControls: registry.controls,
      db: store.conn,
    });
    router = new RegistryGatewayRouter(registry, undefined, undefined, canaryRouter);
  });

  afterEach(() => {
    router.destroy();
  });
  it("executes shadow canary mode: returns stable version to client while shadowing candidate in background", async () => {
    let stableCallCount = 0;
    let candidateCallCount = 0;
    const { promise: shadowDone, resolve: resolveShadow } = Promise.withResolvers<void>();

    // Register stable version 1.0.0
    const manifestV1 = makeManifest({ id: "linter", version: "1.0.0" });
    const tool1 = await registry.registerTool(manifestV1);
    tool1.handler = async (_ctx, params) => {
      stableCallCount++;
      return {
        content: [{ type: "text", text: `v1.0.0 result: ${params.code}` }],
      };
    };
    await registry.activateToolVersion("linter", "1.0.0", workspaceId);

    // Register candidate version 2.0.0-canary
    const manifestV2 = makeManifest({ id: "linter", version: "2.0.0-canary" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async (_ctx, params) => {
      candidateCallCount++;
      resolveShadow();
      return {
        content: [{ type: "text", text: `v2.0.0 candidate result: ${params.code}` }],
      };
    };

    // Register canary in shadow mode
    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "linter",
      candidateVersion: "2.0.0-canary",
      stableVersion: "1.0.0",
      config: {
        strategy: "shadow",
        trafficPercentage: 100,
        durationMinutes: 15,
      },
    });

    // Client executes tool
    const result = await router.callTool(context, "linter", { code: "const x = 1;" });

    // Client receives stable v1.0.0 response immediately
    expect(stableCallCount).toBe(1);
    expect(result.content[0].text).toContain("v1.0.0 result: const x = 1;");

    // Await asynchronous shadow execution
    await shadowDone;

    expect(candidateCallCount).toBe(1);
    const metrics = canaryRouter.getHealthMetrics("linter", workspaceId);
    expect(metrics.totalCalls).toBe(1);
    expect(metrics.successCalls).toBe(1);
    expect(metrics.errorCalls).toBe(0);
  });

  it("shadow execution failure does not fail client response", async () => {
    const { promise: shadowDone, resolve: resolveShadow } = Promise.withResolvers<void>();

    // Stable v1.0.0 works
    const manifestV1 = makeManifest({ id: "parser", version: "1.0.0" });
    const tool1 = await registry.registerTool(manifestV1);
    tool1.handler = async (_ctx, params) => ({
      content: [{ type: "text", text: `v1.0.0 parsed: ${params.code}` }],
    });
    await registry.activateToolVersion("parser", "1.0.0", workspaceId);

    // Candidate v2.0.0 throws error
    const manifestV2 = makeManifest({ id: "parser", version: "2.0.0-buggy" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async () => {
      resolveShadow();
      throw new Error("Candidate crashed due to segmentation fault simulation");
    };

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "parser",
      candidateVersion: "2.0.0-buggy",
      stableVersion: "1.0.0",
      config: { strategy: "shadow" },
    });

    // Client calls tool
    const result = await router.callTool(context, "parser", { code: "let y = 2;" });

    // Client still gets successful stable response
    expect(result.content[0].text).toContain("v1.0.0 parsed: let y = 2;");

    await shadowDone;

    const metrics = canaryRouter.getHealthMetrics("parser", workspaceId);
    expect(metrics.totalCalls).toBe(1);
    expect(metrics.errorCalls).toBe(1);
  });

  it("executes deterministic traffic split canary routing according to percentage", async () => {
    let stableHits = 0;
    let candidateHits = 0;

    const manifestV1 = makeManifest({ id: "formatter", version: "1.0.0" });
    const tool1 = await registry.registerTool(manifestV1);
    tool1.handler = async () => {
      stableHits++;
      return { content: [{ type: "text", text: "v1.0.0 formatted" }] };
    };
    await registry.activateToolVersion("formatter", "1.0.0", workspaceId);

    const manifestV2 = makeManifest({ id: "formatter", version: "1.1.0-canary" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async () => {
      candidateHits++;
      return { content: [{ type: "text", text: "v1.1.0 formatted" }] };
    };

    // 50% traffic split
    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "formatter",
      candidateVersion: "1.1.0-canary",
      stableVersion: "1.0.0",
      config: {
        strategy: "traffic_split",
        trafficPercentage: 50,
      },
    });

    // Execute 20 invocations across sessions
    for (let i = 0; i < 20; i++) {
      const sessionCtx: WorkspaceContext = {
        workspaceId,
        sessionId: `sess-${i}`,
        rootPath: "/workspaces/canary-test",
        timestamp: Date.now(),
      };
      await router.callTool(sessionCtx, "formatter", { code: `test(${i});` });
    }

    expect(stableHits + candidateHits).toBe(20);
    expect(candidateHits).toBeGreaterThan(0);
    expect(stableHits).toBeGreaterThan(0);

    const metrics = canaryRouter.getHealthMetrics("formatter", workspaceId);
    expect(metrics.totalCalls).toBe(candidateHits);
  });

  it("in-flight fallback: gracefully falls back to stable version when canary candidate fails in traffic split", async () => {
    let candidateAttempts = 0;
    let stableFallbacks = 0;

    const manifestV1 = makeManifest({ id: "compiler", version: "1.0.0" });
    const tool1 = await registry.registerTool(manifestV1);
    tool1.handler = async () => {
      stableFallbacks++;
      return { content: [{ type: "text", text: "v1.0.0 fallback compilation success" }] };
    };
    await registry.activateToolVersion("compiler", "1.0.0", workspaceId);

    const manifestV2 = makeManifest({ id: "compiler", version: "2.0.0-failing" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async () => {
      candidateAttempts++;
      throw new Error("Candidate worker process timed out");
    };

    // 100% traffic split to candidate to test fallback
    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "compiler",
      candidateVersion: "2.0.0-failing",
      stableVersion: "1.0.0",
      config: {
        strategy: "traffic_split",
        trafficPercentage: 100,
        autoRollbackThresholds: {
          consecutiveFailureThreshold: 10, // higher threshold so we test fallback first
          maxErrorRate: 1.0,
        },
      },
    });

    const result = await router.callTool(context, "compiler", { code: "fn main() {}" });

    expect(candidateAttempts).toBe(1);
    expect(stableFallbacks).toBe(1);
    expect(result.content[0].text).toContain("v1.0.0 fallback compilation success");
  });

  it("stable meta-tools remain continuously available and invariant during canary activations", async () => {
    const manifest = makeManifest({ id: "worker_tool", version: "1.0.0" });
    const tool = await registry.registerTool(manifest);
    tool.handler = async () => ({
      content: [{ type: "text", text: "worker tool result" }],
    });
    await registry.activateToolVersion("worker_tool", "1.0.0", workspaceId);

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "worker_tool",
      candidateVersion: "2.0.0-canary",
      stableVersion: "1.0.0",
      config: { strategy: "shadow" },
    });

    // System meta-tools: listTools, search_tools, etc.
    const tools = await router.listTools(context);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name.includes("search_tools") || t.name === "search_tools")).toBe(
      true,
    );

    // Call search_tools system meta tool
    const searchRes = await router.callTool(context, "search_tools", { query: "worker" });
    expect(searchRes.content[0].text).toBeDefined();
  });

  it("enforces user overrides: pinning overrides canary candidate routing", async () => {
    let v1Hits = 0;
    let v2Hits = 0;

    const manifestV1 = makeManifest({ id: "pinned_tool", version: "1.0.0" });
    const tool1 = await registry.registerTool(manifestV1);
    tool1.handler = async () => {
      v1Hits++;
      return { content: [{ type: "text", text: "v1.0.0" }] };
    };
    await registry.activateToolVersion("pinned_tool", "1.0.0", workspaceId);

    const manifestV2 = makeManifest({ id: "pinned_tool", version: "2.0.0-canary" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async () => {
      v2Hits++;
      return { content: [{ type: "text", text: "v2.0.0" }] };
    };

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "pinned_tool",
      candidateVersion: "2.0.0-canary",
      stableVersion: "1.0.0",
      config: { strategy: "traffic_split", trafficPercentage: 100 },
    });

    // Pin tool to v1.0.0
    await registry.controls.pinToolVersion(workspaceId, "pinned_tool", "1.0.0");

    // Call tool
    const res = await router.callTool(context, "pinned_tool", { code: "abc" });
    expect(v1Hits).toBe(1);
    expect(v2Hits).toBe(0);
    expect(res.content[0].text).toBe("v1.0.0");
  });

  it("enforces user overrides: freezing prevents canary activations and updates", async () => {
    await registry.controls.freezeTool(workspaceId, "frozen_tool");

    await expect(
      canaryRouter.registerCanary({
        workspaceId,
        toolId: "frozen_tool",
        candidateVersion: "2.0.0",
      }),
    ).rejects.toThrow(/frozen by user control/);
  });

  it("enforces user overrides: disabling rejects all invocations", async () => {
    const manifest = makeManifest({ id: "disabled_tool", version: "1.0.0" });
    const tool = await registry.registerTool(manifest);
    tool.handler = async () => ({
      content: [{ type: "text", text: "ok" }],
    });
    await registry.activateToolVersion("disabled_tool", "1.0.0", workspaceId);

    await registry.controls.disableTool(workspaceId, "disabled_tool");

    await expect(router.callTool(context, "disabled_tool", { code: "x" })).rejects.toThrow(
      /disabled/,
    );
  });

  it("promotes a healthy candidate to standard 100% active state", async () => {
    const manifestV1 = makeManifest({ id: "promoted_tool", version: "1.0.0" });
    await registry.registerTool(manifestV1);
    await registry.activateToolVersion("promoted_tool", "1.0.0", workspaceId);

    const manifestV2 = makeManifest({ id: "promoted_tool", version: "2.0.0" });
    const tool2 = await registry.registerTool(manifestV2);
    tool2.handler = async () => ({
      content: [{ type: "text", text: "v2.0.0 promoted result" }],
    });

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "promoted_tool",
      candidateVersion: "2.0.0",
      stableVersion: "1.0.0",
      config: { strategy: "traffic_split", trafficPercentage: 10 },
    });

    expect(canaryRouter.getCanary("promoted_tool", workspaceId)?.status).toBe("active");

    // Promote candidate
    await canaryRouter.promoteCanary("promoted_tool", workspaceId);

    // Canary candidate should now be promoted
    expect(canaryRouter.getCanary("promoted_tool", workspaceId)).toBeUndefined();

    // Call tool should now execute promoted v2.0.0
    const result = await router.callTool(context, "promoted_tool", { code: "test" });
    expect(result.content[0].text).toBe("v2.0.0 promoted result");
  });
});
