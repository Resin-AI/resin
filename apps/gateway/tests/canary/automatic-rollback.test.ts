import type { ToolManifest } from "@resin/contracts";
import { type LocalStateStore, createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonRpcParams } from "../../src/protocol/types.js";
import { CanaryRouter } from "../../src/registry/canary-router.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { RegistryGatewayRouter } from "../../src/router.js";

function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? "auto_rollback_tool",
    name: overrides?.name ?? "auto_rollback_tool",
    version: overrides?.version ?? "1.0.0",
    description: "Sample tool for automatic rollback testing",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
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

describe("Automatic Rollback, Health Monitoring & Quarantine Suite", () => {
  let store: LocalStateStore;
  let registry: ToolRegistry;
  let canaryRouter: CanaryRouter;
  let router: RegistryGatewayRouter;
  const emittedIncidents: JsonRpcParams[] = [];

  const workspaceId = "ws-rollback-test";
  const context: WorkspaceContext = {
    workspaceId,
    sessionId: "sess-rollback-1",
    rootPath: "/workspaces/rollback-test",
    timestamp: Date.now(),
  };

  beforeEach(async () => {
    store = await createInMemoryStateStore();
    registry = new ToolRegistry({ db: store.conn, debounceMs: 0 });
    emittedIncidents.length = 0;
    canaryRouter = new CanaryRouter({
      registry,
      userControls: registry.controls,
      db: store.conn,
      auditCallback: (incident) => {
        emittedIncidents.push(incident);
      },
    });
    router = new RegistryGatewayRouter(registry, undefined, undefined, canaryRouter);
  });

  afterEach(() => {
    router.destroy();
  });

  it("triggers automatic rollback on consecutive failure threshold breach", async () => {
    let stableCalls = 0;
    let candidateCalls = 0;

    // Stable version 1.0.0
    const tool1 = await registry.registerTool(
      makeManifest({ id: "faulty_service", version: "1.0.0" }),
    );
    tool1.handler = async () => {
      stableCalls++;
      return { content: [{ type: "text", text: "stable v1.0.0 result" }] };
    };
    await registry.activateToolVersion("faulty_service", "1.0.0", workspaceId);

    // Faulty candidate version 2.0.0
    const tool2 = await registry.registerTool(
      makeManifest({ id: "faulty_service", version: "2.0.0-broken" }),
    );
    tool2.handler = async () => {
      candidateCalls++;
      return {
        isError: true,
        content: [{ type: "text", text: "Database connection failed in worker" }],
      };
    };

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "faulty_service",
      candidateVersion: "2.0.0-broken",
      stableVersion: "1.0.0",
      config: {
        strategy: "traffic_split",
        trafficPercentage: 100,
        autoRollbackThresholds: {
          consecutiveFailureThreshold: 3,
        },
      },
    });

    expect(canaryRouter.getCanary("faulty_service", workspaceId)?.status).toBe("active");

    // Invocations 1, 2, 3 fail in candidate and fall back to stable
    await router.callTool(context, "faulty_service", { query: "q1" });
    await router.callTool(context, "faulty_service", { query: "q2" });
    await router.callTool(context, "faulty_service", { query: "q3" });

    // Threshold breached (3 consecutive failures) -> candidate rolled back automatically
    expect(candidateCalls).toBe(3);
    expect(canaryRouter.getCanary("faulty_service", workspaceId)).toBeUndefined();
    expect(canaryRouter.isQuarantined("faulty_service", "2.0.0-broken", workspaceId)).toBe(true);

    // Next invocation routes directly to stable version without attempting candidate
    const result = await router.callTool(context, "faulty_service", { query: "q4" });
    expect(result.content[0].text).toBe("stable v1.0.0 result");
    expect(candidateCalls).toBe(3); // Candidate was not called again
  });

  it("triggers automatic rollback on output schema mismatch rate breach", async () => {
    const tool1 = await registry.registerTool(
      makeManifest({ id: "schema_tool", version: "1.0.0" }),
    );
    tool1.handler = async () => ({
      content: [{ type: "text", text: "valid stable output" }],
    });
    await registry.activateToolVersion("schema_tool", "1.0.0", workspaceId);

    const tool2 = await registry.registerTool(
      makeManifest({ id: "schema_tool", version: "2.0.0-schema-bug" }),
    );
    tool2.handler = async () => ({
      isError: true,
      content: [{ type: "text", text: "Invalid schema output: expected string, received number" }],
    });

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "schema_tool",
      candidateVersion: "2.0.0-schema-bug",
      stableVersion: "1.0.0",
      config: {
        strategy: "traffic_split",
        trafficPercentage: 100,
        autoRollbackThresholds: {
          maxSchemaMismatchRate: 0.01,
          consecutiveFailureThreshold: 10,
        },
      },
    });

    for (let i = 0; i < 4; i++) {
      await router.callTool(context, "schema_tool", { query: `req-${i}` });
    }

    // Schema mismatch rate breached -> candidate automatically rolled back & quarantined
    expect(canaryRouter.getCanary("schema_tool", workspaceId)).toBeUndefined();
    expect(canaryRouter.isQuarantined("schema_tool", "2.0.0-schema-bug", workspaceId)).toBe(true);
  });

  it("triggers immediate automatic rollback on capability or envelope violation", async () => {
    const tool1 = await registry.registerTool(
      makeManifest({ id: "security_tool", version: "1.0.0" }),
    );
    tool1.handler = async () => ({
      content: [{ type: "text", text: "secure result" }],
    });
    await registry.activateToolVersion("security_tool", "1.0.0", workspaceId);

    const tool2 = await registry.registerTool(
      makeManifest({ id: "security_tool", version: "2.0.0-violator" }),
    );
    tool2.handler = async () => {
      throw new Error(
        "capability violation: unauthorized network access attempted to 169.254.169.254",
      );
    };

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "security_tool",
      candidateVersion: "2.0.0-violator",
      stableVersion: "1.0.0",
      config: {
        strategy: "traffic_split",
        trafficPercentage: 100,
      },
    });

    // Single invocation with capability violation triggers immediate rollback
    await router.callTool(context, "security_tool", { query: "test" });

    expect(canaryRouter.getCanary("security_tool", workspaceId)).toBeUndefined();
    expect(canaryRouter.isQuarantined("security_tool", "2.0.0-violator", workspaceId)).toBe(true);
    expect(emittedIncidents.length).toBeGreaterThanOrEqual(1);
    expect(emittedIncidents[0].reason).toContain("Capability violation");
  });

  it("measures sub-100ms atomic routing switch during rollback", async () => {
    await registry.registerTool(makeManifest({ id: "timing_tool", version: "1.0.0" }));
    await registry.activateToolVersion("timing_tool", "1.0.0", workspaceId);

    await registry.registerTool(makeManifest({ id: "timing_tool", version: "2.0.0-canary" }));

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "timing_tool",
      candidateVersion: "2.0.0-canary",
      stableVersion: "1.0.0",
      config: { strategy: "traffic_split", trafficPercentage: 100 },
    });

    const rollbackResult = await canaryRouter.triggerRollback(
      "timing_tool",
      workspaceId,
      "Simulated manual rollback switch speed test",
    );

    expect(rollbackResult.switchDurationMs).toBeLessThan(100);
    expect(rollbackResult.rolledBackVersion).toBe("2.0.0-canary");
    expect(rollbackResult.restoredVersion).toBe("1.0.0");
    expect(rollbackResult.quarantined).toBe(true);
  });

  it("redacts sensitive tokens and credentials in emitted audit incidents", async () => {
    await registry.registerTool(makeManifest({ id: "secret_tool", version: "1.0.0" }));
    await registry.activateToolVersion("secret_tool", "1.0.0", workspaceId);

    await registry.registerTool(makeManifest({ id: "secret_tool", version: "2.0.0-leaky" }));

    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "secret_tool",
      candidateVersion: "2.0.0-leaky",
      stableVersion: "1.0.0",
      config: { strategy: "traffic_split", trafficPercentage: 100 },
    });

    // Trigger rollback with an error string containing sensitive bearer tokens and GitHub secrets
    await canaryRouter.triggerRollback(
      "secret_tool",
      workspaceId,
      "Incident with secret: Bearer secret_token_xyz_1234567890123456 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      {
        error: "Failed request with Authorization: Bearer secret_api_key_sensitive_999999",
      },
    );

    expect(emittedIncidents.length).toBeGreaterThanOrEqual(1);
    const incident = emittedIncidents[emittedIncidents.length - 1];
    const incidentJson = JSON.stringify(incident);

    // Verify secret values are not present in raw plaintext
    expect(incidentJson).not.toContain("secret_token_xyz_1234567890123456");
    expect(incidentJson).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    expect(incidentJson).not.toContain("secret_api_key_sensitive_999999");
  });

  it("quarantines faulty candidate so subsequent activations are strictly refused", async () => {
    await canaryRouter.quarantineCandidate(
      "quarantined_tool",
      "2.0.0-bad",
      workspaceId,
      "tampered_archive",
      "Signature mismatch detected during verification",
    );

    expect(canaryRouter.isQuarantined("quarantined_tool", "2.0.0-bad", workspaceId)).toBe(true);

    // Attempting to register canary for quarantined version throws error
    await expect(
      canaryRouter.registerCanary({
        workspaceId,
        toolId: "quarantined_tool",
        candidateVersion: "2.0.0-bad",
        stableVersion: "1.0.0",
      }),
    ).rejects.toThrow(/version is quarantined/);
  });

  it("routing, rollback, and quarantine states survive daemon restart and reload from SQLite", async () => {
    // 1. Setup candidate and trigger rollback
    await canaryRouter.registerCanary({
      workspaceId,
      toolId: "persistent_tool",
      candidateVersion: "2.0.0-crashed",
      stableVersion: "1.0.0",
    });

    await canaryRouter.triggerRollback("persistent_tool", workspaceId, "Crash simulation rollback");

    expect(canaryRouter.isQuarantined("persistent_tool", "2.0.0-crashed", workspaceId)).toBe(true);

    // 2. Simulate daemon restart with fresh CanaryRouter instance sharing the same SQLite DB
    const restartedCanaryRouter = new CanaryRouter({
      db: store.conn,
    });

    // 3. Verify quarantined candidate is still recognized as quarantined after restart
    expect(
      restartedCanaryRouter.isQuarantined("persistent_tool", "2.0.0-crashed", workspaceId),
    ).toBe(true);

    // 4. Verify candidate is no longer active
    expect(restartedCanaryRouter.getCanary("persistent_tool", workspaceId)).toBeUndefined();

    // 5. Attempting to activate quarantined candidate throws
    await expect(
      restartedCanaryRouter.registerCanary({
        workspaceId,
        toolId: "persistent_tool",
        candidateVersion: "2.0.0-crashed",
      }),
    ).rejects.toThrow(/version is quarantined/);
  });
});
