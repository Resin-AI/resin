import type { ToolManifest } from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/registry/registry.js";
import type { CatalogChangeEvent } from "../../src/registry/types.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

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

describe("ToolRegistry - Debounced Catalog Change Events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid multi-tool activations into a single debounced change event", async () => {
    const registry = new ToolRegistry({ debounceMs: 40 });
    const receivedEvents: CatalogChangeEvent[] = [];

    const unsubscribe = registry.events.onCatalogChanged((evt) => {
      receivedEvents.push(evt);
    });

    const m1 = makeManifest({ id: "t_1", name: "tool1", version: "1.0.0" });
    const m2 = makeManifest({ id: "t_2", name: "tool2", version: "1.0.0" });
    const m3 = makeManifest({ id: "t_3", name: "tool3", version: "1.0.0" });

    await registry.stageToolVersion(m1);
    await registry.stageToolVersion(m2);
    await registry.stageToolVersion(m3);

    // Rapid sequential activations in same workspace
    await registry.activateToolVersion("t_1", "1.0.0", "ws-debounce");
    await registry.activateToolVersion("t_2", "1.0.0", "ws-debounce");
    await registry.activateToolVersion("t_3", "1.0.0", "ws-debounce");

    // Before debounce interval elapses
    expect(receivedEvents).toHaveLength(0);

    // Advance fake timer by debounce interval
    vi.advanceTimersByTime(50);

    expect(receivedEvents).toHaveLength(1);
    const evt = receivedEvents[0];
    expect(evt.workspaceId).toBe("ws-debounce");
    expect(evt.changedToolIds).toContain("t_1");
    expect(evt.changedToolIds).toContain("t_2");
    expect(evt.changedToolIds).toContain("t_3");
    expect(evt.snapshot.tools.t_1).toBeDefined();
    expect(evt.snapshot.tools.t_2).toBeDefined();
    expect(evt.snapshot.tools.t_3).toBeDefined();

    unsubscribe();
  });

  it("notifies workspace-scoped listeners for their respective workspace only", async () => {
    const registry = new ToolRegistry({ debounceMs: 20 });
    const ws1Events: CatalogChangeEvent[] = [];
    const ws2Events: CatalogChangeEvent[] = [];

    registry.events.onWorkspaceCatalogChanged("ws-target", (evt) => {
      ws1Events.push(evt);
    });
    registry.events.onWorkspaceCatalogChanged("ws-other", (evt) => {
      ws2Events.push(evt);
    });

    const m = makeManifest({ id: "t_ws_scoped", name: "toolWsScoped", version: "1.0.0" });
    await registry.stageToolVersion(m);
    await registry.activateToolVersion("t_ws_scoped", "1.0.0", "ws-target");

    vi.advanceTimersByTime(30);

    expect(ws1Events).toHaveLength(1);
    expect(ws2Events).toHaveLength(0);
  });

  it("flushes pending events immediately on flushEvents()", async () => {
    const registry = new ToolRegistry({ debounceMs: 1000 });
    const receivedEvents: CatalogChangeEvent[] = [];

    registry.events.onCatalogChanged((evt) => {
      receivedEvents.push(evt);
    });

    const m = makeManifest({ id: "t_flush", name: "toolFlush", version: "1.0.0" });
    await registry.stageToolVersion(m);
    await registry.activateToolVersion("t_flush", "1.0.0", "ws-flush");

    expect(receivedEvents).toHaveLength(0);

    registry.flushEvents();
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].workspaceId).toBe("ws-flush");
  });
});
