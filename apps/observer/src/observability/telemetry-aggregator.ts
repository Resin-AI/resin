export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ToolMetricsSummary {
  toolId: string;
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  errorRate: number;
  latencies: LatencyStats;
  errorsByType: Record<string, number>;
}

export interface TelemetrySummary {
  timestamp: string;
  totalInvocations: number;
  successfulInvocations: number;
  failedInvocations: number;
  overallErrorRate: number;
  overallLatencies: LatencyStats;
  tools: Record<string, ToolMetricsSummary>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  errorHistograms: Record<string, number>;
}

export function computePercentiles(values: number[]): LatencyStats {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const avgMs = Math.round((sum / count) * 100) / 100;
  const minMs = sorted[0];
  const maxMs = sorted[count - 1];

  const getPercentile = (p: number): number => {
    const index = Math.min(Math.floor((p / 100) * count), count - 1);
    return sorted[index];
  };

  return {
    count,
    minMs,
    maxMs,
    avgMs,
    p50Ms: getPercentile(50),
    p90Ms: getPercentile(90),
    p95Ms: getPercentile(95),
    p99Ms: getPercentile(99),
  };
}

interface ToolMetricStore {
  total: number;
  success: number;
  failure: number;
  durations: number[];
  errors: Map<string, number>;
}

export class TelemetryAggregator {
  private toolMetrics = new Map<string, ToolMetricStore>();
  private allDurations: number[] = [];
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private globalErrors = new Map<string, number>();
  private readonly maxSamplesPerTool: number;

  constructor(options: { maxSamplesPerTool?: number } = {}) {
    this.maxSamplesPerTool = options.maxSamplesPerTool ?? 5000;
  }

  recordInvocation(
    toolId: string,
    durationMs: number,
    success: boolean,
    options: { errorType?: string; workspaceId?: string } = {},
  ): void {
    let store = this.toolMetrics.get(toolId);
    if (!store) {
      store = {
        total: 0,
        success: 0,
        failure: 0,
        durations: [],
        errors: new Map(),
      };
      this.toolMetrics.set(toolId, store);
    }

    store.total++;
    if (success) {
      store.success++;
    } else {
      store.failure++;
      const errType = options.errorType ?? "UnknownError";
      store.errors.set(errType, (store.errors.get(errType) ?? 0) + 1);
      this.globalErrors.set(errType, (this.globalErrors.get(errType) ?? 0) + 1);
    }

    store.durations.push(durationMs);
    if (store.durations.length > this.maxSamplesPerTool) {
      store.durations.shift();
    }

    this.allDurations.push(durationMs);
    if (this.allDurations.length > this.maxSamplesPerTool * 2) {
      this.allDurations.shift();
    }
  }

  incrementCounter(name: string, value = 1, tags?: Record<string, string>): void {
    const key = tags ? `${name}:${JSON.stringify(tags)}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, tags?: Record<string, string>): void {
    const key = tags ? `${name}:${JSON.stringify(tags)}` : name;
    this.gauges.set(key, value);
  }

  getToolMetrics(toolId: string): ToolMetricsSummary | undefined {
    const store = this.toolMetrics.get(toolId);
    if (!store) {
      return undefined;
    }

    const errorRate =
      store.total > 0 ? Math.round((store.failure / store.total) * 10000) / 10000 : 0;
    const errorsByType: Record<string, number> = {};
    for (const [k, v] of store.errors.entries()) {
      errorsByType[k] = v;
    }

    return {
      toolId,
      totalInvocations: store.total,
      successfulInvocations: store.success,
      failedInvocations: store.failure,
      errorRate,
      latencies: computePercentiles(store.durations),
      errorsByType,
    };
  }

  getSummary(): TelemetrySummary {
    let totalInvocations = 0;
    let successfulInvocations = 0;
    let failedInvocations = 0;
    const tools: Record<string, ToolMetricsSummary> = {};

    for (const [toolId, store] of this.toolMetrics.entries()) {
      totalInvocations += store.total;
      successfulInvocations += store.success;
      failedInvocations += store.failure;

      const toolSummary = this.getToolMetrics(toolId);
      if (toolSummary) {
        tools[toolId] = toolSummary;
      }
    }

    const overallErrorRate =
      totalInvocations > 0 ? Math.round((failedInvocations / totalInvocations) * 10000) / 10000 : 0;

    const countersRecord: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) {
      countersRecord[k] = v;
    }

    const gaugesRecord: Record<string, number> = {};
    for (const [k, v] of this.gauges.entries()) {
      gaugesRecord[k] = v;
    }

    const errorHistogramsRecord: Record<string, number> = {};
    for (const [k, v] of this.globalErrors.entries()) {
      errorHistogramsRecord[k] = v;
    }

    return {
      timestamp: new Date().toISOString(),
      totalInvocations,
      successfulInvocations,
      failedInvocations,
      overallErrorRate,
      overallLatencies: computePercentiles(this.allDurations),
      tools,
      counters: countersRecord,
      gauges: gaugesRecord,
      errorHistograms: errorHistogramsRecord,
    };
  }

  reset(): void {
    this.toolMetrics.clear();
    this.allDurations.length = 0;
    this.counters.clear();
    this.gauges.clear();
    this.globalErrors.clear();
  }
}

export function createTelemetryAggregator(options?: {
  maxSamplesPerTool?: number;
}): TelemetryAggregator {
  return new TelemetryAggregator(options);
}
