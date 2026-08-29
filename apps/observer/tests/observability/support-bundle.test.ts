import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditTrailManager } from "../../src/observability/audit-trail.js";
import { createHealthAggregator } from "../../src/observability/health-aggregator.js";
import { createKillSwitchManager } from "../../src/observability/kill-switches.js";
import { createStructuredLogger } from "../../src/observability/logger.js";
import { createRecoveryController } from "../../src/observability/recovery-controller.js";
import {
  SupportBundleGenerator,
  createSupportBundleGenerator,
} from "../../src/observability/support-bundle.js";
import { createTelemetryAggregator } from "../../src/observability/telemetry-aggregator.js";

describe("SupportBundleGenerator", () => {
  it("generates comprehensive support bundle with all diagnostics", async () => {
    const logger = createStructuredLogger();
    logger.info("Daemon started successfully");
    logger.warn("Worker pool high load", { activeWorkers: 8 });

    const auditTrail = createAuditTrailManager();
    await auditTrail.append({
      eventType: "config_updated",
      actor: { type: "user", id: "admin" },
      resourceType: "config",
      resourceId: "logLevel",
      action: "update",
      status: "success",
      details: { old: "info", new: "debug" },
    });

    const killSwitches = createKillSwitchManager();
    await killSwitches.disableTool("deprecated_eval", "Security deprecation");

    const healthAggregator = createHealthAggregator(undefined, killSwitches);
    healthAggregator.registerComponent("gateway", () => ({ status: "ready" }));

    const telemetry = createTelemetryAggregator();
    telemetry.recordInvocation("file_read", 20, true);

    const recoveryController = createRecoveryController();
    await recoveryController.quarantineTool("buggy_tool", "1.0.0", "Worker crash loop");

    const generator = createSupportBundleGenerator({
      observerVersion: "0.1.0",
      logger,
      auditTrail,
      killSwitches,
      healthAggregator,
      telemetry,
      recoveryController,
      databaseDiagnosticsProvider: async () => ({
        tableCounts: { audit_trail_chain: 1, sessions: 0 },
        walMode: true,
      }),
    });

    const bundle = await generator.generateBundle();

    expect(bundle.bundleId).toMatch(/^sb_\d+_[a-z0-9]+/);
    expect(bundle.observerVersion).toBe("0.1.0");
    expect(bundle.platform.nodeVersion).toBeDefined();
    expect(bundle.platform.cpuCount).toBeGreaterThan(0);
    expect(bundle.health.overallStatus).toBe("ready");
    expect(bundle.killSwitches?.disabledTools).toContain("deprecated_eval");
    expect(bundle.auditSummary?.totalEntries).toBe(1);
    expect(bundle.telemetry?.totalInvocations).toBe(1);
    expect(bundle.quarantinedTools).toHaveLength(1);
    expect(bundle.sanitizedLogs.length).toBeGreaterThanOrEqual(2);
    expect(bundle.schemaCompatibility.protocolVersion).toBe("1.0.0");
  });

  it("strictly sanitizes all secrets, credentials, and API keys from the entire bundle", async () => {
    const rawApiKey = "sk-proj-99999999999999999999999999999999";
    const rawBearer =
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    const rawPassword = "VerySecretPassword123";
    const sentinelAccess = "sentinel-access-token-leak-11111";
    const sentinelRefresh = "sentinel-refresh-token-leak-22222";
    const sentinelAssertion = "sentinel-approval-assertion-sig-33333";
    const sentinelVault = "sentinel-vault-secret-val-44444";
    const sentinelIpcToken = "sentinel-local-ipc-token-55555";

    const logger = createStructuredLogger();
    logger.info(`Request authorized using ${rawBearer} and password ${rawPassword}`, {
      apiKey: rawApiKey,
      authorization: rawBearer,
      accessToken: sentinelAccess,
      refreshToken: sentinelRefresh,
      approvalAssertion: sentinelAssertion,
      vaultSecret: sentinelVault,
    });

    const auditTrail = createAuditTrailManager();
    await auditTrail.append({
      eventType: "auth_token_issued",
      actor: { type: "user", id: "user_secret" },
      resourceType: "session",
      resourceId: "sess_1",
      action: "create",
      status: "success",
      details: {
        token: rawApiKey,
        accessToken: sentinelAccess,
        refreshToken: sentinelRefresh,
        connectionString: `postgres://admin:${rawPassword}@db.internal:5432/main`,
      },
    });

    const generator = createSupportBundleGenerator({
      config: {
        version: "0.1.0",
        authToken: sentinelIpcToken,
        logLevel: "info",
        host: "127.0.0.1",
        port: 9400,
        cloudUrl: "https://api.resin.dev",
        telemetryEnabled: false,
        heartbeatIntervalMs: 5000,
        lockStaleThresholdMs: 15000,
        shutdownTimeoutMs: 10000,
        maxWorkerMemoryMb: 512,
        workerExecutionTimeoutMs: 30000,
        maxConcurrentWorkers: 4,
        corsAllowedOrigins: ["*"],
        rateLimitMaxRequests: 1000,
        rateLimitWindowMs: 60000,
        moduleConfigs: {},
      },
      cloudState: {
        status: "valid",
        cloudUrl: "https://api.resin.dev",
        accountId: "acc-sentinel-test-123",
        workspaceId: "ws-sentinel-test-456",
        deviceId: "dev-sentinel-test-789",
        userId: "usr-sentinel-test-012",
      },
      logger,
      auditTrail,
      databaseDiagnosticsProvider: async () => ({
        apiKey: rawApiKey,
        dbPassword: rawPassword,
        vaultSecret: sentinelVault,
      }),
    });

    const bundleJson = await generator.generateBundleJson();

    // Verify raw secrets and sentinels are nowhere in the generated JSON string
    expect(bundleJson).not.toContain(rawApiKey);
    expect(bundleJson).not.toContain(rawPassword);
    expect(bundleJson).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(bundleJson).not.toContain(sentinelAccess);
    expect(bundleJson).not.toContain(sentinelRefresh);
    expect(bundleJson).not.toContain(sentinelAssertion);
    expect(bundleJson).not.toContain(sentinelVault);
    expect(bundleJson).not.toContain(sentinelIpcToken);

    // Verify redaction markers exist in JSON
    expect(bundleJson).toContain("[REDACTED]");

    // Verify safe diagnostics and binding fields remain present and un-redacted
    const parsed = JSON.parse(bundleJson);
    expect(parsed.cloudState).toBeDefined();
    expect(parsed.cloudState.status).toBe("valid");
    expect(parsed.cloudState.cloudUrl).toBe("https://api.resin.dev");
    expect(parsed.cloudState.accountId).toBe("acc-sentinel-test-123");
    expect(parsed.cloudState.workspaceId).toBe("ws-sentinel-test-456");
    expect(parsed.cloudState.deviceId).toBe("dev-sentinel-test-789");
    expect(parsed.cloudState.userId).toBe("usr-sentinel-test-012");
  });

  it("never includes credential secrets and represents cloud state with safe status and binding fields", async () => {
    const sentinelAccessLeak = "sentinel-leak-attempt-access-9999";
    const sentinelRefreshLeak = "sentinel-leak-attempt-refresh-8888";

    const generator = createSupportBundleGenerator({
      observerVersion: "0.1.0",
      cloudStateProvider: async () => ({
        status: "valid",
        cloudUrl: "https://api.resin.sh",
        accountId: "acc-safe-1",
        workspaceId: "ws-safe-2",
        deviceId: "dev-safe-3",
        userId: "usr-safe-4",
        // Accidental or malicious credential field injection
        accessToken: sentinelAccessLeak,
        refreshToken: sentinelRefreshLeak,
      }),
    });

    const bundle = await generator.generateBundle();
    const bundleJson = await generator.generateBundleJson();

    expect(bundle.cloudState?.status).toBe("valid");
    expect(bundle.cloudState?.cloudUrl).toBe("https://api.resin.sh");
    expect(bundle.cloudState?.accountId).toBe("acc-safe-1");
    expect(bundle.cloudState?.workspaceId).toBe("ws-safe-2");
    expect(bundle.cloudState?.deviceId).toBe("dev-safe-3");
    expect(bundle.cloudState?.userId).toBe("usr-safe-4");
    expect(bundle.cloudState?.accessToken).toBe("[REDACTED]");
    expect(bundle.cloudState?.refreshToken).toBe("[REDACTED]");

    expect(bundleJson).not.toContain(sentinelAccessLeak);
    expect(bundleJson).not.toContain(sentinelRefreshLeak);
    expect(bundleJson).toContain("[REDACTED]");
  });

  it("writes formatted bundle JSON to destination file", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bundle-test-"));
    const bundleFilePath = path.join(tmpDir, "support-bundle.json");

    const generator = createSupportBundleGenerator({ observerVersion: "0.1.0" });
    const result = await generator.writeBundleToFile(bundleFilePath);

    expect(result.filePath).toBe(bundleFilePath);
    expect(result.bytesWritten).toBeGreaterThan(100);
    expect(fs.existsSync(bundleFilePath)).toBe(true);

    const fileContent = await fs.promises.readFile(bundleFilePath, "utf8");
    const parsed = JSON.parse(fileContent);
    expect(parsed.bundleId).toBe(result.bundleId);
    expect(parsed.platform).toBeDefined();

    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
});
