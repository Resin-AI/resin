import type { TriggerResult } from "@resin/contracts";
import { extractScenarioId } from "./episode.js";
import {
  type CandidateTriggerReason,
  DEFAULT_WASTE_THRESHOLDS,
  type Episode,
  type TriggerOptions,
  type WasteThresholds,
  type WorkflowCluster,
} from "./types.js";

export const DEFAULT_MIN_OCCURRENCES_NORMAL = 1;
export const DEFAULT_MIN_DISTINCT_SCENARIOS = 1;

export interface MaxEpisodeMetrics {
  durationMs: number;
  tokenCount: number;
  retryCount: number;
  estimatedCostUsd: number | null;
  stepCount: number;
}

export interface ExceptionalWasteCheckResult {
  exceeded: boolean;
  reason: CandidateTriggerReason;
  description: string;
}

/**
 * Extracts unique, sorted scenario IDs from a workflow cluster.
 */
export function getClusterScenarioIds(cluster: WorkflowCluster): string[] {
  if (Array.isArray(cluster.scenarioIds) && cluster.scenarioIds.length > 0) {
    return [...new Set(cluster.scenarioIds.filter((s): s is string => s.trim().length > 0))].sort();
  }
  const extracted = new Set<string>();
  if (Array.isArray(cluster.episodes)) {
    for (const ep of cluster.episodes) {
      const sid = ep.scenarioId;
      if (sid && sid.trim().length > 0) {
        extracted.add(sid.trim());
      } else if (Array.isArray(ep.events)) {
        const sidFromEvts = extractScenarioId(ep.events);
        if (sidFromEvts && sidFromEvts.trim().length > 0) {
          extracted.add(sidFromEvts.trim());
        } else if (ep.sessionId && ep.sessionId.trim().length > 0) {
          extracted.add(ep.sessionId.trim());
        }
      } else if (ep.sessionId && ep.sessionId.trim().length > 0) {
        extracted.add(ep.sessionId.trim());
      }
    }
  }
  return Array.from(extracted).sort();
}

/**
 * Returns the count of distinct scenario IDs associated with a workflow cluster.
 */
export function getClusterDistinctScenarioCount(cluster: WorkflowCluster): number {
  const sids = getClusterScenarioIds(cluster);
  if (sids.length > 0) {
    return sids.length;
  }
  if (
    cluster.distinctScenarioCount !== undefined &&
    Number.isFinite(cluster.distinctScenarioCount) &&
    cluster.distinctScenarioCount > 0
  ) {
    return cluster.distinctScenarioCount;
  }
  return 0;
}

/**
 * Opportunity trigger evaluation engine.
 */
export class TriggerEvaluator {
  private readonly minOccurrencesNormal: number;
  private readonly minDistinctScenarios: number;
  private readonly wasteThresholds: WasteThresholds;

  constructor(options: TriggerOptions = {}) {
    this.minOccurrencesNormal =
      options.minOccurrencesNormal ?? options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES_NORMAL;
    this.minDistinctScenarios = options.minDistinctScenarios ?? DEFAULT_MIN_DISTINCT_SCENARIOS;
    this.wasteThresholds = {
      ...DEFAULT_WASTE_THRESHOLDS,
      ...options.wasteThresholds,
    };
  }

  /**
   * Evaluates if a workflow cluster meets opportunity trigger criteria.
   */
  evaluateCluster(cluster: WorkflowCluster): TriggerResult {
    const occurrenceCount =
      cluster.completedOccurrences > 0 ? cluster.completedOccurrences : cluster.episodeCount;
    const maxEpisodeMetrics = this.getMaxEpisodeMetrics(cluster.episodes);
    const scenarioIds = getClusterScenarioIds(cluster);
    const distinctScenarioCount = getClusterDistinctScenarioCount(cluster);
    const isLegacyNoScenario = scenarioIds.length === 0;
    const eventIds =
      Array.isArray(cluster.evidenceEventIds) && cluster.evidenceEventIds.length > 0
        ? cluster.evidenceEventIds
        : cluster.episodes.flatMap((e) => e.events.map((evt) => evt.eventId));

    // 1. Exceptional Waste Trigger Check (evaluated first so high-waste single runs are properly categorized)
    const metrics = {
      durationMs: maxEpisodeMetrics.durationMs,
      tokenCount: maxEpisodeMetrics.tokenCount,
      retryCount: maxEpisodeMetrics.retryCount,
      estimatedCostUsd: maxEpisodeMetrics.estimatedCostUsd,
      stepCount: maxEpisodeMetrics.stepCount,
    };

    const wasteCheck = this.checkExceptionalWaste(metrics);
    if (wasteCheck.exceeded) {
      return {
        triggered: true,
        triggerType: "exceptional_waste",
        reason: wasteCheck.reason,
        description: wasteCheck.description,
        evidenceEventIds: eventIds,
        metrics: {
          occurrenceCount,
          durationMs: cluster.metrics.avgDurationMs,
          tokenCount: cluster.metrics.avgTokens,
          retryCount: cluster.metrics.totalRetries,
          estimatedCostUsd: cluster.metrics.totalCostUsd,
          stepCount: cluster.metrics.avgStepCount,
        },
      };
    }

    // 2. Normal Frequency Trigger: >= minOccurrencesNormal completed occurrences
    if (occurrenceCount >= this.minOccurrencesNormal) {
      // Legacy un-scoped scenario data without scenario tagging
      if (isLegacyNoScenario) {
        return {
          triggered: true,
          triggerType: "normal_frequency",
          reason: "repeated_pattern",
          description: `Recurring workflow pattern observed across ${occurrenceCount} occurrences (${cluster.distinctSessionIds?.length ?? occurrenceCount} sessions).`,
          evidenceEventIds: eventIds,
          metrics: {
            occurrenceCount,
            durationMs: cluster.metrics.avgDurationMs,
            tokenCount: cluster.metrics.avgTokens,
            retryCount: cluster.metrics.totalRetries,
            estimatedCostUsd: cluster.metrics.totalCostUsd,
            stepCount: cluster.metrics.avgStepCount,
          },
        };
      }

      // Modern scenario-tagged recurrence: require >= minDistinctScenarios (default 1)
      if (distinctScenarioCount >= this.minDistinctScenarios) {
        const scenarioDetails = ` across ${distinctScenarioCount} scenarios (${scenarioIds.join(", ")})`;
        return {
          triggered: true,
          triggerType: "normal_frequency",
          reason: "repeated_pattern",
          description: `Recurring workflow pattern observed across ${occurrenceCount} occurrences${scenarioDetails}.`,
          evidenceEventIds: eventIds,
          metrics: {
            occurrenceCount,
            durationMs: cluster.metrics.avgDurationMs,
            tokenCount: cluster.metrics.avgTokens,
            retryCount: cluster.metrics.totalRetries,
            estimatedCostUsd: cluster.metrics.totalCostUsd,
            stepCount: cluster.metrics.avgStepCount,
          },
        };
      }
    }

    // 3. No trigger criteria met
    let description = "Workflow pattern does not meet occurrence or exceptional waste criteria.";
    if (
      occurrenceCount >= this.minOccurrencesNormal &&
      !isLegacyNoScenario &&
      distinctScenarioCount < this.minDistinctScenarios
    ) {
      description = `Workflow pattern meets occurrence count (${occurrenceCount} >= ${this.minOccurrencesNormal}) but only spans ${distinctScenarioCount} scenario(s) (minimum ${this.minDistinctScenarios} distinct scenarios required for reusable subworkflow discovery).`;
    }

    return {
      triggered: false,
      triggerType: "none",
      reason: "repeated_pattern",
      description,
      evidenceEventIds: eventIds,
      metrics: {
        occurrenceCount,
        durationMs: cluster.metrics.avgDurationMs,
        tokenCount: cluster.metrics.avgTokens,
        retryCount: cluster.metrics.totalRetries,
        estimatedCostUsd: cluster.metrics.totalCostUsd,
        stepCount: cluster.metrics.avgStepCount,
      },
    };
  }

  /**
   * Evaluates a single episode directly for exceptional waste triggers.
   */
  evaluateSingleEpisode(episode: Episode): TriggerResult {
    const metrics = {
      durationMs: episode.metrics.totalDurationMs,
      tokenCount: episode.metrics.totalTokens,
      retryCount: episode.metrics.retryCount,
      estimatedCostUsd: episode.metrics.estimatedCostUsd,
      stepCount: episode.metrics.stepCount,
    };

    const wasteCheck = this.checkExceptionalWaste(metrics);
    const eventIds = episode.events.map((e) => e.eventId);

    if (wasteCheck.exceeded) {
      return {
        triggered: true,
        triggerType: "exceptional_waste",
        reason: wasteCheck.reason,
        description: `Exceptional resource waste detected in episode: ${wasteCheck.description}`,
        evidenceEventIds: eventIds,
        metrics: {
          occurrenceCount: 1,
          durationMs: episode.metrics.totalDurationMs,
          tokenCount: episode.metrics.totalTokens,
          retryCount: episode.metrics.retryCount,
          estimatedCostUsd: episode.metrics.estimatedCostUsd,
        },
      };
    }

    return {
      triggered: false,
      triggerType: "none",
      reason: "repeated_pattern",
      description: "Single episode does not exceed exceptional waste thresholds.",
      evidenceEventIds: eventIds,
      metrics: {
        occurrenceCount: 1,
        durationMs: episode.metrics.totalDurationMs,
        tokenCount: episode.metrics.totalTokens,
        retryCount: episode.metrics.retryCount,
        estimatedCostUsd: episode.metrics.estimatedCostUsd,
      },
    };
  }

  /**
   * Computes the maximum metric values observed across any single episode in the cluster.
   */
  private getMaxEpisodeMetrics(episodes: Episode[]): MaxEpisodeMetrics {
    let maxDurationMs = 0;
    let maxTokens = 0;
    let maxRetries = 0;
    let maxCostUsd: number | null = episodes.length > 0 ? 0 : null;
    let maxSteps = 0;

    for (const ep of episodes) {
      if (ep.metrics.totalDurationMs > maxDurationMs) maxDurationMs = ep.metrics.totalDurationMs;
      if (ep.metrics.totalTokens > maxTokens) maxTokens = ep.metrics.totalTokens;
      if (ep.metrics.retryCount > maxRetries) maxRetries = ep.metrics.retryCount;
      const episodeCostUsd = ep.metrics.estimatedCostUsd;
      maxCostUsd =
        maxCostUsd !== null && episodeCostUsd !== null && Number.isFinite(episodeCostUsd)
          ? Math.max(maxCostUsd, episodeCostUsd)
          : null;
      if (ep.metrics.stepCount > maxSteps) maxSteps = ep.metrics.stepCount;
    }

    return {
      durationMs: maxDurationMs,
      tokenCount: maxTokens,
      retryCount: maxRetries,
      estimatedCostUsd: maxCostUsd,
      stepCount: maxSteps,
    };
  }

  private checkExceptionalWaste(metrics: MaxEpisodeMetrics): ExceptionalWasteCheckResult {
    // 1. Retry / failure recovery waste
    if (metrics.retryCount >= this.wasteThresholds.exceptionalRetryCount) {
      return {
        exceeded: true,
        reason: "failure_recovery",
        description: `High retry count (${metrics.retryCount} retries >= threshold ${this.wasteThresholds.exceptionalRetryCount})`,
      };
    }

    // 2. High latency bottleneck
    if (metrics.durationMs >= this.wasteThresholds.exceptionalDurationMs) {
      return {
        exceeded: true,
        reason: "latency_bottleneck",
        description: `High duration (${Math.round(metrics.durationMs / 1000)}s >= threshold ${Math.round(this.wasteThresholds.exceptionalDurationMs / 1000)}s)`,
      };
    }

    // 3. Token volume waste
    if (metrics.tokenCount >= this.wasteThresholds.exceptionalTokenCount) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High token consumption (${metrics.tokenCount} tokens >= threshold ${this.wasteThresholds.exceptionalTokenCount})`,
      };
    }

    // 4. Financial cost waste
    if (
      metrics.estimatedCostUsd !== null &&
      Number.isFinite(metrics.estimatedCostUsd) &&
      metrics.estimatedCostUsd >= this.wasteThresholds.exceptionalCostUsd
    ) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High estimated cost ($${metrics.estimatedCostUsd} >= threshold $${this.wasteThresholds.exceptionalCostUsd})`,
      };
    }

    // 5. Excessive manual steps
    if (metrics.stepCount >= this.wasteThresholds.exceptionalStepCount) {
      return {
        exceeded: true,
        reason: "missing_abstraction",
        description: `High step count (${metrics.stepCount} steps >= threshold ${this.wasteThresholds.exceptionalStepCount})`,
      };
    }

    return {
      exceeded: false,
      reason: "repeated_pattern",
      description: "No waste thresholds exceeded.",
    };
  }
}

/**
 * Convenience function to evaluate triggers for a cluster.
 */
export function evaluateOpportunityTriggers(
  cluster: WorkflowCluster,
  options?: TriggerOptions,
): TriggerResult {
  const evaluator = new TriggerEvaluator(options);
  return evaluator.evaluateCluster(cluster);
}
