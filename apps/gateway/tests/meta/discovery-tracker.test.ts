import {
  CapabilityManifestSchema,
  type InvocationRecord,
  InvocationRecordSchema,
  ToolLimitConfigSchema,
  type ToolManifest,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@resin/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionDiscoveryTracker, isDiscoveryTool } from "../../src/meta/discovery-tracker.js";
import { createInvokeToolHandler } from "../../src/meta/invoke-tool.js";
import type {
  ToolInvocationRequest,
  ToolInvocationRouter,
} from "../../src/meta/router-contract.js";
import type { CallToolResult } from "../../src/protocol/types.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";
import type { WorkspaceContext } from "../../src/workspace-resolver.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const raw = {
    id: overrides?.id ?? "tool_echo",
    name: overrides?.name ?? "echo_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Echo tool for testing",
    parameters: ToolParameterSchema.parse(
      overrides?.parameters ?? {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
    ),
    runtime: ToolRuntimeRequirementSchema.parse({
      runtime: "builtin",
    }),
    capabilities: CapabilityManifestSchema.parse(overrides?.capabilities ?? {}),
    limits: ToolLimitConfigSchema.parse(overrides?.limits ?? { timeoutMs: 1000 }),
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T00:00:00.000Z",
  };

  return {
    ...raw,
    digest: computeManifestDigest(raw),
  };
}

function makeContext(
  workspaceId = "ws-discovery",
  sessionId = "ses-discovery-1",
): WorkspaceContext {
  return {
    workspaceId,
    projectId: "proj-1",
    projectRoot: `/workspaces/${workspaceId}`,
    canonicalRoot: `/workspaces/${workspaceId}`,
    startupPath: `/workspaces/${workspaceId}`,
    isReadOnly: false,
    name: workspaceId,
    source: "cwd_fallback",
    roots: [{ uri: `file:///workspaces/${workspaceId}`, path: `/workspaces/${workspaceId}` }],
    sessionId,
    harnessId: "test-harness",
  };
}

describe("Gateway SessionDiscoveryTracker & Usage Estimates", () => {
  let tracker: SessionDiscoveryTracker;

  beforeEach(() => {
    tracker = new SessionDiscoveryTracker();
  });

  describe("isDiscoveryTool", () => {
    it("identifies built-in metadata discovery tools and excludes invoke_tool", () => {
      expect(isDiscoveryTool("search_tools")).toBe(true);
      expect(isDiscoveryTool("sys_search_tools")).toBe(true);
      expect(isDiscoveryTool("get_tool_schema")).toBe(true);
      expect(isDiscoveryTool("sys_get_tool_schema")).toBe(true);
      expect(isDiscoveryTool("manage_tools")).toBe(true);
      expect(isDiscoveryTool("sys_manage_tools")).toBe(true);

      // invoke_tool executes generated tools; it is NOT a discovery tool
      expect(isDiscoveryTool("invoke_tool")).toBe(false);
      expect(isDiscoveryTool("sys_invoke_tool")).toBe(false);
      expect(isDiscoveryTool("my_custom_tool")).toBe(false);
      expect(isDiscoveryTool(undefined)).toBe(false);
    });
  });

  describe("Discovery overhead accumulation and single-charge lifecycle", () => {
    it("accumulates discovery overhead, drains once, and allows later accumulation in same session", () => {
      tracker.recordDiscoveryOverhead("ses-1", 50);
      tracker.recordDiscoveryOverhead("ses-1", 30);
      expect(tracker.getPendingTokens("ses-1")).toBe(80);
      expect(tracker.isCharged("ses-1")).toBe(false);

      // Consuming drains pending once
      const charged = tracker.consumeDiscoveryTokens("ses-1");
      expect(charged).toBe(80);
      expect(tracker.isCharged("ses-1")).toBe(true);
      expect(tracker.getPendingTokens("ses-1")).toBe(0);

      // Subsequent generated invocation receives 0 discovery tokens
      const nextCharged = tracker.consumeDiscoveryTokens("ses-1");
      expect(nextCharged).toBe(0);

      // Subsequent discovery calls in the same session accumulate again
      tracker.recordDiscoveryOverhead("ses-1", 100);
      expect(tracker.getPendingTokens("ses-1")).toBe(100);
      expect(tracker.isCharged("ses-1")).toBe(true);

      // Next generated invocation drains the newly accumulated overhead
      const secondCharged = tracker.consumeDiscoveryTokens("ses-1");
      expect(secondCharged).toBe(100);
      expect(tracker.getPendingTokens("ses-1")).toBe(0);

      // And following invocation gets 0 again
      expect(tracker.consumeDiscoveryTokens("ses-1")).toBe(0);
      expect(tracker.getTotalChargedTokens("ses-1")).toBe(180);
    });

    it("isolates discovery tracking between different sessions", () => {
      tracker.recordDiscoveryOverhead("ses-A", 40);
      tracker.recordDiscoveryOverhead("ses-B", 70);

      expect(tracker.consumeDiscoveryTokens("ses-A")).toBe(40);
      expect(tracker.isCharged("ses-A")).toBe(true);

      expect(tracker.isCharged("ses-B")).toBe(false);
      expect(tracker.consumeDiscoveryTokens("ses-B")).toBe(70);
    });

    it("prevents double-charging across concurrent invocations in the same session", () => {
      tracker.recordDiscoveryOverhead("ses-concurrent", 120);

      // Simulate two concurrent invocations completing in parallel
      const chargeA = tracker.consumeDiscoveryTokens("ses-concurrent");
      const chargeB = tracker.consumeDiscoveryTokens("ses-concurrent");

      // Exactly one invocation receives the 120 discovery tokens, the other receives 0
      expect(chargeA + chargeB).toBe(120);
      expect(chargeA === 120 ? chargeB : chargeA).toBe(0);
      expect(tracker.getPendingTokens("ses-concurrent")).toBe(0);
      expect(tracker.getTotalChargedTokens("ses-concurrent")).toBe(120);
    });

    it("bounds tracker state via LRU eviction and supports explicit cleanup", () => {
      const boundedTracker = new SessionDiscoveryTracker({ maxSessions: 3 });

      boundedTracker.recordDiscoveryOverhead("s1", 10);
      boundedTracker.recordDiscoveryOverhead("s2", 20);
      boundedTracker.recordDiscoveryOverhead("s3", 30);

      // Access s1 to make it more recently used
      expect(boundedTracker.getPendingTokens("s1")).toBe(10);

      // Adding s4 should evict s2 (oldest unaccessed session)
      boundedTracker.recordDiscoveryOverhead("s4", 40);

      expect(boundedTracker.getPendingTokens("s2")).toBe(0); // evicted
      expect(boundedTracker.getPendingTokens("s1")).toBe(10);
      expect(boundedTracker.getPendingTokens("s3")).toBe(30);
      expect(boundedTracker.getPendingTokens("s4")).toBe(40);

      // Explicit cleanup
      boundedTracker.cleanupSession("s1");
      expect(boundedTracker.getPendingTokens("s1")).toBe(0);
    });
  });

  describe("invoke_tool execution with usageEstimate and discovery allocation", () => {
    it("records usageEstimate on generated invocation and charges discovery overhead", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest();
      await registry.registerTool(manifest, undefined, { workspaceId: "ws-discovery" });

      tracker.recordDiscoveryOverhead("session-test-1", 25);

      let capturedRecord: InvocationRecord | undefined;
      const onInvocationRecorded = async (record: InvocationRecord) => {
        capturedRecord = record;
      };

      const mockRouter: ToolInvocationRouter = {
        async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
          return { content: [{ type: "text", text: "Echo output message" }] };
        },
      };

      const handler = createInvokeToolHandler(registry, mockRouter, {
        onInvocationRecorded,
        discoveryTracker: tracker,
      });
      const context = makeContext("ws-discovery", "session-test-1");

      const res = await handler(context, {
        toolId: "tool_echo",
        parameters: { message: "Hello world" },
      });
      expect(res.isError).toBeFalsy();

      expect(capturedRecord).toBeDefined();
      const validated = InvocationRecordSchema.parse(capturedRecord);
      expect(validated.status).toBe("success");
      expect(validated.usageEstimate).toBeDefined();
      expect(validated.usageEstimate?.method).toBe("tool_io_utf8_v1");
      expect(validated.usageEstimate?.discoveryTokens).toBe(25);
      expect(validated.usageEstimate?.inputTokens).toBeGreaterThan(0);
      expect(validated.usageEstimate?.outputTokens).toBeGreaterThan(0);
      expect(validated.usageEstimate?.totalTokens).toBe(
        (validated.usageEstimate?.inputTokens ?? 0) +
          (validated.usageEstimate?.outputTokens ?? 0) +
          25,
      );

      // Second invocation in same session has 0 discoveryTokens
      let secondRecord: InvocationRecord | undefined;
      const handler2 = createInvokeToolHandler(registry, mockRouter, {
        onInvocationRecorded: async (record) => {
          secondRecord = record;
        },
        discoveryTracker: tracker,
      });
      await handler2(context, {
        toolId: "tool_echo",
        parameters: { message: "Second call" },
      });

      expect(secondRecord?.usageEstimate?.discoveryTokens).toBe(0);
    });

    it("retains failure status with usage estimate on invocation error", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest();
      await registry.registerTool(manifest, undefined, { workspaceId: "ws-discovery" });

      let capturedRecord: InvocationRecord | undefined;
      const onInvocationRecorded = async (record: InvocationRecord) => {
        capturedRecord = record;
      };

      const mockRouter: ToolInvocationRouter = {
        async invoke(): Promise<CallToolResult> {
          return { isError: true, content: [{ type: "text", text: "Runtime failure" }] };
        },
      };

      const handler = createInvokeToolHandler(registry, mockRouter, {
        onInvocationRecorded,
        discoveryTracker: tracker,
      });
      const context = makeContext("ws-discovery", "session-err");

      await handler(context, {
        toolId: "tool_echo",
        parameters: { message: "will fail" },
      });

      expect(capturedRecord).toBeDefined();
      expect(capturedRecord?.status).toBe("error");
      expect(capturedRecord?.usageEstimate).toBeDefined();
      expect(capturedRecord?.usageEstimate?.method).toBe("tool_io_utf8_v1");
      expect(capturedRecord?.usageEstimate?.totalTokens).toBeGreaterThan(0);
    });
  });

  describe("Direct invocation path via RegistryGatewayRouter", () => {
    it("records generated tool calls directly and does not record system meta calls as generated invocations", async () => {
      const recordedList: InvocationRecord[] = [];
      const onInvocationRecorded = async (record: InvocationRecord) => {
        recordedList.push(record);
      };

      const mockRouter: ToolInvocationRouter = {
        async invoke(_req: ToolInvocationRequest): Promise<CallToolResult> {
          return { content: [{ type: "text", text: "Direct result" }] };
        },
      };

      const registry = new ToolRegistry({
        onInvocationRecorded,
        invocationRouter: mockRouter,
      });
      const manifest = makeManifest();
      await registry.registerTool(manifest, undefined, { workspaceId: "ws-discovery" });

      const router = new RegistryGatewayRouter(registry, mockRouter, undefined, undefined, tracker);
      const context = makeContext("ws-discovery", "session-direct-1");

      // 1. Call system meta-tool search_tools directly: should NOT be recorded as generated invocation
      await router.callTool(context, "search_tools", { query: "echo" });
      expect(recordedList).toHaveLength(0);
      // But discovery overhead should be recorded!
      expect(tracker.getPendingTokens("session-direct-1")).toBeGreaterThan(0);
      const accumulatedDiscovery = tracker.getPendingTokens("session-direct-1");

      // 2. Call generated tool directly: should be recorded as generated invocation with discoveryTokens
      await router.callTool(context, "echo_tool", { message: "direct hello" });
      expect(recordedList).toHaveLength(1);
      const directRecord = recordedList[0];
      expect(directRecord.status).toBe("success");
      expect(directRecord.toolId).toBe("tool_echo");
      expect(directRecord.usageEstimate?.discoveryTokens).toBe(accumulatedDiscovery);
      expect(directRecord.usageEstimate?.totalTokens).toBe(
        (directRecord.usageEstimate?.inputTokens ?? 0) +
          (directRecord.usageEstimate?.outputTokens ?? 0) +
          accumulatedDiscovery,
      );
    });
  });
});
