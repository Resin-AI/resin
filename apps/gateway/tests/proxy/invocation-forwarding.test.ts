import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";
import { type CloudInvocationContext, MockCloudMcpService } from "./mock-service.js";

function makeTool(id = "cloud_weather", name = "get_weather"): ToolManifest {
  const base = {
    id,
    name,
    version: "1.0.0",
    description: "Cloud weather lookup",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    runtime: {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: false,
        allowTemp: false,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: true,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [443],
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
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: "workspace" as const,
    metadata: {},
    createdAt: "2026-08-17T12:00:00.000Z",
  };

  return {
    ...base,
    digest: computeManifestDigest(base),
  };
}

const mockWorkspaceContext: WorkspaceContext = {
  workspaceId: "ws_test",
  sessionId: "sess_test",
  accountId: "acc_test",
  gitRoot: "/workspaces/project",
  harnessId: "test-harness",
  canonicalRoot: "/workspaces/project",
  isSymlinked: false,
  symlinkChain: [],
};

describe("Cloud Invocation Router & Forwarding", () => {
  it("forwards tool call with workspace context, trace context, and idempotencyKey", async () => {
    const mockService = new MockCloudMcpService();
    const tool = makeTool();
    let capturedContext: CloudInvocationContext | null = null;

    mockService.addTool(tool, undefined, async (params, ctx) => {
      capturedContext = ctx;
      return {
        content: [{ type: "text", text: `Weather in ${params.city}: 72F Sunny` }],
      };
    });

    const router = new CloudInvocationRouter({ mockService });

    await router.forwardInvocation(
      "cloud_weather",
      { city: "San Francisco" },
      mockWorkspaceContext,
    );
    expect(capturedContext).not.toBeNull();
    const ctx = capturedContext!;
    const wsCtx = ctx.workspaceContext;
    expect(wsCtx.workspaceId).toBe("ws_test");
    expect(wsCtx.sessionId).toBe("sess_test");
    expect(ctx.idempotencyKey).toBeDefined();
    expect(ctx.traceContext?.traceId).toBeDefined();
    expect(Number.isFinite(ctx.deadline) && (ctx.deadline ?? 0) > Date.now()).toBe(true);
  });

  it("handles cancellation via AbortSignal", async () => {
    const mockService = new MockCloudMcpService();
    mockService.setFaultConfig({ latencyMs: 500 });
    const tool = makeTool();
    mockService.addTool(tool);

    const router = new CloudInvocationRouter({ mockService });
    const abortController = new AbortController();
    // Trigger abort immediately
    abortController.abort();

    await expect(
      router.forwardInvocation("cloud_weather", { city: "Tokyo" }, mockWorkspaceContext, {
        signal: abortController.signal,
      }),
    ).rejects.toThrow();
  });

  it("handles deadline timeout and translates to McpProtocolError(REQUEST_TIMEOUT)", async () => {
    const mockService = new MockCloudMcpService();
    // Simulate long latency
    mockService.setFaultConfig({ latencyMs: 200 });
    const tool = makeTool();
    mockService.addTool(tool);

    const router = new CloudInvocationRouter({ mockService, defaultTimeoutMs: 30 });

    try {
      await router.forwardInvocation("cloud_weather", { city: "London" }, mockWorkspaceContext, {
        timeoutMs: 30,
      });
      expect.unreachable("Should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      if (err instanceof McpProtocolError) {
        expect(err.code).toBe(MCP_ERROR_CODES.REQUEST_TIMEOUT);
      }
    }
  });
  it("forwards progress notifications to onProgress callback", async () => {
    const mockService = new MockCloudMcpService();
    const tool = makeTool();
    const progressUpdates: number[] = [];

    mockService.addTool(tool, undefined, async (_params, ctx) => {
      ctx.onProgress?.(25, 100);
      ctx.onProgress?.(75, 100);
      ctx.onProgress?.(100, 100);
      return { content: [{ type: "text", text: "Done" }] };
    });

    const router = new CloudInvocationRouter({ mockService });
    await router.forwardInvocation("cloud_weather", { city: "Paris" }, mockWorkspaceContext, {
      onProgress: (progress) => progressUpdates.push(progress),
    });

    expect(progressUpdates).toEqual([25, 75, 100]);
  });

  it("translates structured cloud errors into standard MCP protocol errors", async () => {
    const mockService = new MockCloudMcpService();
    const tool = makeTool();
    mockService.addTool(tool);

    const router = new CloudInvocationRouter({ mockService });

    // 1. Tool not found
    await expect(
      router.forwardInvocation("non_existent_tool", {}, mockWorkspaceContext),
    ).rejects.toThrow();

    // 2. Unauthorized
    mockService.simulateUnauthorized(true);
    try {
      await router.forwardInvocation("cloud_weather", { city: "Rome" }, mockWorkspaceContext);
      expect.unreachable("Should throw unauthorized");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      if (err instanceof McpProtocolError) {
        expect(err.code).toBe(MCP_ERROR_CODES.UNAUTHORIZED);
      }
    }
    // 3. Rate Limited
    router.getCircuitBreaker().reset();
    mockService.simulateOnline();
    mockService.simulateRateLimit(5000);
    try {
      await router.forwardInvocation("cloud_weather", { city: "Berlin" }, mockWorkspaceContext);
      expect.unreachable("Should throw rate limited");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      // SAFETY: err is verified to be an McpProtocolError instance by the assertion above.
      expect((err as McpProtocolError).code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
    }
  });

  it("records success and failure in CloudCircuitBreaker", async () => {
    const circuitBreaker = new CloudCircuitBreaker({ failureThreshold: 2 });
    const mockService = new MockCloudMcpService();
    const tool = makeTool();
    mockService.addTool(tool);

    const router = new CloudInvocationRouter({ mockService, circuitBreaker });

    // Success call
    await router.forwardInvocation("cloud_weather", { city: "Madrid" }, mockWorkspaceContext);
    expect(circuitBreaker.getState()).toBe("CLOSED");
    expect(circuitBreaker.getHealth().status).toBe("online");

    // Failures
    mockService.simulateOffline(true);
    await expect(
      router.forwardInvocation("cloud_weather", { city: "Madrid" }, mockWorkspaceContext),
    ).rejects.toThrow();
    await expect(
      router.forwardInvocation("cloud_weather", { city: "Madrid" }, mockWorkspaceContext),
    ).rejects.toThrow();

    // Tripped to OPEN
    expect(circuitBreaker.getState()).toBe("OPEN");
    expect(circuitBreaker.getHealth().status).toBe("offline");

    // Subsequent calls rejected immediately without forwarding
    try {
      await router.forwardInvocation("cloud_weather", { city: "Madrid" }, mockWorkspaceContext);
      expect.unreachable("Should reject while circuit is open");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      if (err instanceof McpProtocolError) {
        expect(err.code).toBe(MCP_ERROR_CODES.CONNECTION_CLOSED);
      }
    }
  });
});
