import type { ToolManifest } from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_ERROR_CODES, McpProtocolError } from "../../src/protocol/errors.js";
import { CloudCatalogCache } from "../../src/proxy/cache.js";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";
import { MockCloudMcpService } from "./mock-service.js";

function makeTool(id: string, name: string): ToolManifest {
  const base = {
    id,
    name,
    version: "1.0.0",
    description: `Tool ${name}`,
    parameters: {
      type: "object",
      properties: { action: { type: "string" }, amount: { type: "number" } },
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
  workspaceId: "ws_queue_test",
  sessionId: "sess_1",
  accountId: "acc_1",
  gitRoot: "/workspaces/proj",
  harnessId: "test-harness",
  canonicalRoot: "/workspaces/proj",
  isSymlinked: false,
  symlinkChain: [],
};

describe("Zero Silent Queuing Invariant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("immediately returns failure when cloud is disconnected and never queues call", async () => {
    const mockService = new MockCloudMcpService();
    const circuitBreaker = new CloudCircuitBreaker({ failureThreshold: 1 });
    const cache = new CloudCatalogCache();

    let executionCount = 0;
    const tool = makeTool("cloud_transfer", "transfer_funds");

    mockService.addTool(tool, undefined, async () => {
      executionCount++;
      return { content: [{ type: "text", text: `Transferred at count ${executionCount}` }] };
    });

    const router = new CloudInvocationRouter({
      mockService,
      circuitBreaker,
      catalogCache: cache,
    });

    // 1. First execution succeeds
    const res1 = await router.forwardInvocation(
      "cloud_transfer",
      { amount: 100 },
      mockWorkspaceContext,
    );
    expect(res1.content[0]).toEqual({ type: "text", text: "Transferred at count 1" });
    expect(executionCount).toBe(1);

    // 2. Disconnect cloud service
    mockService.simulateOffline(true);
    circuitBreaker.recordFailure(new Error("Network partitioned"));

    // 3. Attempt multiple invocations while offline
    const call1Promise = router.forwardInvocation(
      "cloud_transfer",
      { amount: 500 },
      mockWorkspaceContext,
    );
    const call2Promise = router.forwardInvocation(
      "cloud_transfer",
      { amount: 1000 },
      mockWorkspaceContext,
    );

    // Both calls MUST fail immediately and synchronously return errors to caller
    await expect(call1Promise).rejects.toThrow(McpProtocolError);
    await expect(call2Promise).rejects.toThrow(McpProtocolError);

    // Execution count MUST still be 1 (no background execution happened)
    expect(executionCount).toBe(1);

    // 4. Restore cloud connection
    mockService.simulateOnline();
    circuitBreaker.reset();

    // Advance timers to let any hypothetical background tasks settle
    vi.advanceTimersByTime(500);

    // Execution count MUST REMAIN 1! No queued calls should run as surprise side effects!
    expect(executionCount).toBe(1);

    // 5. New explicit call from caller succeeds as call #2
    const res3 = await router.forwardInvocation(
      "cloud_transfer",
      { amount: 200 },
      mockWorkspaceContext,
    );
    expect(res3.content[0]).toEqual({ type: "text", text: "Transferred at count 2" });
    expect(executionCount).toBe(2);
  });

  it("does not queue calls on timeout failures", async () => {
    const mockService = new MockCloudMcpService();
    let handlerExecutions = 0;
    const tool = makeTool("cloud_long_op", "long_operation");

    mockService.addTool(tool, undefined, async () => {
      handlerExecutions++;
      return { content: [{ type: "text", text: "Done" }] };
    });

    const router = new CloudInvocationRouter({
      mockService,
      defaultTimeoutMs: 10,
    });

    // Induce latency exceeding timeout
    mockService.setFaultConfig({ latencyMs: 100 });

    const callPromise = router.forwardInvocation("cloud_long_op", {}, mockWorkspaceContext, {
      timeoutMs: 10,
    });
    vi.advanceTimersByTime(20);

    try {
      await callPromise;
      expect.unreachable("Call should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpProtocolError);
      expect((err as McpProtocolError).code).toBe(MCP_ERROR_CODES.REQUEST_TIMEOUT);
    }

    mockService.clearFaults();
    vi.advanceTimersByTime(500);

    // Subsequent explicit call is isolated and runs fresh
    const res = await router.forwardInvocation("cloud_long_op", {}, mockWorkspaceContext);
    expect(res).toBeDefined();
    expect(handlerExecutions).toBe(1);
  });
});
