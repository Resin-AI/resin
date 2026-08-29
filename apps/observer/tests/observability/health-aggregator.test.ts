import { LocalDatabaseConnection } from "@resin/db";
import { describe, expect, it } from "vitest";
import {
  HealthAggregator,
  KNOWN_REMEDIATION_HINTS,
  createHealthAggregator,
} from "../../src/observability/health-aggregator.js";
import { createKillSwitchManager } from "../../src/observability/kill-switches.js";

describe("HealthAggregator", () => {
  it("aggregates status across ready components", async () => {
    const aggregator = createHealthAggregator();

    aggregator.registerComponent("gateway", () => ({
      status: "ready",
      details: { connections: 4 },
    }));

    aggregator.registerComponent("runtime", () => ({
      status: "ready",
      details: { workersActive: 2 },
    }));

    const report = await aggregator.checkHealth();
    expect(report.overallStatus).toBe("ready");
    expect(report.components.gateway?.status).toBe("ready");
    expect(report.components.runtime?.status).toBe("ready");
    expect(report.components.observer?.status).toBe("ready");
  });

  it("sets overall status to degraded when a component is degraded", async () => {
    const aggregator = createHealthAggregator();

    aggregator.registerComponent("runtime", () => ({
      status: "degraded",
      reasonCode: "RUNTIME_QUARANTINE_ACTIVE",
      remediationHint: KNOWN_REMEDIATION_HINTS.RUNTIME_QUARANTINE_ACTIVE,
    }));

    const report = await aggregator.checkHealth();
    expect(report.overallStatus).toBe("degraded");
    expect(report.activeReasonCodes).toContain("RUNTIME_QUARANTINE_ACTIVE");
    expect(report.remediationHints).toContain(KNOWN_REMEDIATION_HINTS.RUNTIME_QUARANTINE_ACTIVE);
  });

  it("sets overall status to offline when a critical component is offline", async () => {
    const aggregator = createHealthAggregator();

    aggregator.registerComponent(
      "gateway",
      () => ({
        status: "offline",
        reasonCode: "GATEWAY_UNREACHABLE",
        message: "Socket connection refused",
      }),
      { critical: true },
    );

    const report = await aggregator.checkHealth();
    expect(report.overallStatus).toBe("offline");
    expect(report.components.gateway?.critical).toBe(true);
    expect(report.activeReasonCodes).toContain("GATEWAY_UNREACHABLE");
  });

  it("sets overall status to paused when kill switches are active", async () => {
    const killSwitches = createKillSwitchManager();
    await killSwitches.pauseEvolution("Manual inspection requested");

    const aggregator = createHealthAggregator(undefined, killSwitches);
    const report = await aggregator.checkHealth();

    expect(report.overallStatus).toBe("paused");
    expect(report.activeReasonCodes).toContain("EVOLUTION_PAUSED");
    expect(report.remediationHints).toContain(KNOWN_REMEDIATION_HINTS.EVOLUTION_PAUSED);
    expect(report.killSwitchesSummary?.evolutionPaused).toBe(true);
  });

  it("sets overall status to upgrade_required when protocol deprecation occurs", async () => {
    const killSwitches = createKillSwitchManager();
    await killSwitches.pauseEvolution();

    const aggregator = createHealthAggregator(undefined, killSwitches);

    aggregator.registerComponent("cloud", () => ({
      status: "upgrade_required",
      reasonCode: "CLOUD_UPGRADE_REQUIRED",
      remediationHint: KNOWN_REMEDIATION_HINTS.CLOUD_UPGRADE_REQUIRED,
    }));

    const report = await aggregator.checkHealth();
    // upgrade_required takes precedence over paused or degraded
    expect(report.overallStatus).toBe("upgrade_required");
    expect(report.activeReasonCodes).toContain("CLOUD_UPGRADE_REQUIRED");
  });

  it("integrates database health checks", async () => {
    const conn = new LocalDatabaseConnection({ inMemory: true });
    conn.open();

    const aggregator = createHealthAggregator(conn);
    const report = await aggregator.checkHealth();

    expect(report.components.db?.status).toBe("ready");
    expect(report.components.db?.details?.integrity).toBe("ok");

    conn.close();
  });
});
