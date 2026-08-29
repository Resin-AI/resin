import { describe, expect, it } from "vitest";
import {
  TelemetryAggregator,
  computePercentiles,
  createTelemetryAggregator,
} from "../../src/observability/telemetry-aggregator.js";

describe("TelemetryAggregator", () => {
  it("computes accurate latency percentiles", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computePercentiles(latencies);

    expect(stats.count).toBe(10);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(100);
    expect(stats.avgMs).toBe(55);
    expect(stats.p50Ms).toBe(60);
    expect(stats.p90Ms).toBe(100);
  });

  it("records tool invocations and maintains per-tool and global stats", () => {
    const telemetry = createTelemetryAggregator();

    telemetry.recordInvocation("file_search", 15, true);
    telemetry.recordInvocation("file_search", 25, true);
    telemetry.recordInvocation("file_search", 100, false, { errorType: "TimeoutError" });

    telemetry.recordInvocation("bash_exec", 50, true);
    telemetry.recordInvocation("bash_exec", 200, false, { errorType: "PermissionDenied" });

    const toolStats = telemetry.getToolMetrics("file_search");
    expect(toolStats).toBeDefined();
    expect(toolStats?.totalInvocations).toBe(3);
    expect(toolStats?.successfulInvocations).toBe(2);
    expect(toolStats?.failedInvocations).toBe(1);
    expect(toolStats?.errorRate).toBeCloseTo(0.3333, 2);
    expect(toolStats?.errorsByType.TimeoutError).toBe(1);

    const summary = telemetry.getSummary();
    expect(summary.totalInvocations).toBe(5);
    expect(summary.successfulInvocations).toBe(3);
    expect(summary.failedInvocations).toBe(2);
    expect(summary.overallErrorRate).toBe(0.4);
    expect(summary.errorHistograms.TimeoutError).toBe(1);
    expect(summary.errorHistograms.PermissionDenied).toBe(1);
  });

  it("supports counters and gauges with tag serialization", () => {
    const telemetry = createTelemetryAggregator();

    telemetry.incrementCounter("http_requests_total", 1, { status: "200" });
    telemetry.incrementCounter("http_requests_total", 2, { status: "200" });
    telemetry.incrementCounter("http_requests_total", 1, { status: "500" });

    telemetry.setGauge("active_worker_threads", 4);
    telemetry.setGauge("active_worker_threads", 8);

    const summary = telemetry.getSummary();
    expect(summary.counters['http_requests_total:{"status":"200"}']).toBe(3);
    expect(summary.counters['http_requests_total:{"status":"500"}']).toBe(1);
    expect(summary.gauges.active_worker_threads).toBe(8);
  });

  it("clears all metrics on reset", () => {
    const telemetry = createTelemetryAggregator();
    telemetry.recordInvocation("tool_a", 10, true);
    telemetry.incrementCounter("c1", 5);

    expect(telemetry.getSummary().totalInvocations).toBe(1);
    telemetry.reset();
    expect(telemetry.getSummary().totalInvocations).toBe(0);
    expect(telemetry.getSummary().counters).toEqual({});
  });
});
