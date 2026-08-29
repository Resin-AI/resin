import { describe, expect, it } from "vitest";
import * as ObserverIndex from "../../src/index.js";
import * as ObservabilityModule from "../../src/observability/index.js";

describe("Observability Module Exports", () => {
  it("exports all observability components from src/observability/index.js", () => {
    // Logger
    expect(ObservabilityModule.createStructuredLogger).toBeDefined();
    expect(ObservabilityModule.StructuredLogger).toBeDefined();
    expect(ObservabilityModule.redactSecrets).toBeDefined();

    // Audit Trail
    expect(ObservabilityModule.createAuditTrailManager).toBeDefined();
    expect(ObservabilityModule.AuditTrailManager).toBeDefined();
    expect(ObservabilityModule.GENESIS_HASH).toBeDefined();
    expect(ObservabilityModule.computeAuditEntryHash).toBeDefined();

    // Kill Switches
    expect(ObservabilityModule.createKillSwitchManager).toBeDefined();
    expect(ObservabilityModule.KillSwitchManager).toBeDefined();

    // Health Aggregator
    expect(ObservabilityModule.createHealthAggregator).toBeDefined();
    expect(ObservabilityModule.HealthAggregator).toBeDefined();
    expect(ObservabilityModule.KNOWN_REMEDIATION_HINTS).toBeDefined();

    // Recovery Controller
    expect(ObservabilityModule.createRecoveryController).toBeDefined();
    expect(ObservabilityModule.RecoveryController).toBeDefined();
    expect(ObservabilityModule.CircuitBreaker).toBeDefined();

    // Telemetry Aggregator
    expect(ObservabilityModule.createTelemetryAggregator).toBeDefined();
    expect(ObservabilityModule.TelemetryAggregator).toBeDefined();
    expect(ObservabilityModule.computePercentiles).toBeDefined();

    // Support Bundle
    expect(ObservabilityModule.createSupportBundleGenerator).toBeDefined();
    expect(ObservabilityModule.SupportBundleGenerator).toBeDefined();
  });

  it("re-exports all observability components from src/index.js", () => {
    expect(ObserverIndex.createStructuredLogger).toBeDefined();
    expect(ObserverIndex.createAuditTrailManager).toBeDefined();
    expect(ObserverIndex.createKillSwitchManager).toBeDefined();
    expect(ObserverIndex.createHealthAggregator).toBeDefined();
    expect(ObserverIndex.createRecoveryController).toBeDefined();
    expect(ObserverIndex.createTelemetryAggregator).toBeDefined();
    expect(ObserverIndex.createSupportBundleGenerator).toBeDefined();
  });
});
