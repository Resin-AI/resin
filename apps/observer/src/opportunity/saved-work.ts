import type { EstimatedSavedWork } from "@resin/contracts";
import { extractScenarioId } from "./episode.js";
import {
  DEFAULT_RIGHT_SIZING_OPTIONS,
  type RightSizingOptions,
  type RightSizingResult,
  type WorkflowCluster,
  type WorkflowScenarioProvenance,
} from "./types.js";

export { DEFAULT_RIGHT_SIZING_OPTIONS };

/**
 * Derives deterministic scenario provenance across cluster episodes.
 */
export function deriveScenarioProvenance(cluster: WorkflowCluster): WorkflowScenarioProvenance[] {
  const map = new Map<
    string,
    {
      scenarioId: string;
      episodeIds: Set<string>;
      sessionIds: Set<string>;
      firstSeenAt?: string;
      lastSeenAt?: string;
    }
  >();

  if (Array.isArray(cluster.episodes)) {
    for (const ep of cluster.episodes) {
      let sid = ep.scenarioId?.trim();
      if (!sid && Array.isArray(ep.events)) {
        sid = extractScenarioId(ep.events)?.trim();
      }
      if (!sid) {
        continue;
      }
      let entry = map.get(sid);
      if (!entry) {
        entry = {
          scenarioId: sid,
          episodeIds: new Set<string>(),
          sessionIds: new Set<string>(),
          firstSeenAt: ep.startedAt,
          lastSeenAt: ep.endedAt,
        };
        map.set(sid, entry);
      }
      entry.episodeIds.add(ep.id);
      entry.sessionIds.add(ep.sessionId);
      if (!entry.firstSeenAt || (ep.startedAt && ep.startedAt < entry.firstSeenAt)) {
        entry.firstSeenAt = ep.startedAt;
      }
      if (!entry.lastSeenAt || (ep.endedAt && ep.endedAt > entry.lastSeenAt)) {
        entry.lastSeenAt = ep.endedAt;
      }
    }
  }

  if (map.size === 0 && Array.isArray(cluster.scenarioIds) && cluster.scenarioIds.length > 0) {
    for (const sid of cluster.scenarioIds) {
      const parsedSid = typeof sid === "string" ? sid : undefined;
      if (parsedSid && parsedSid.trim().length > 0) {
        const cleanSid = parsedSid.trim();
        if (!map.has(cleanSid)) {
          map.set(cleanSid, {
            scenarioId: cleanSid,
            episodeIds: new Set(),
            sessionIds: new Set(cluster.distinctSessionIds || []),
            firstSeenAt: cluster.firstSeenAt,
            lastSeenAt: cluster.lastSeenAt,
          });
        }
      }
    }
  }

  return [...map.values()]
    .map((e) => ({
      scenarioId: e.scenarioId,
      episodeIds: [...e.episodeIds].sort(),
      sessionIds: [...e.sessionIds].sort(),
      occurrenceCount: e.episodeIds.size > 0 ? e.episodeIds.size : e.sessionIds.size || 1,
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
    }))
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

/**
 * Derives conservative estimated saved-work metrics from observed cluster history.
 */
export function deriveEstimatedSavedWork(
  cluster: WorkflowCluster,
  operationCount: number,
  scenarioProvenance?: WorkflowScenarioProvenance[],
): EstimatedSavedWork {
  const occurrenceCount =
    cluster.completedOccurrences > 0
      ? cluster.completedOccurrences
      : Math.max(1, cluster.episodeCount || 1);
  const distinctScenarios =
    scenarioProvenance !== undefined
      ? scenarioProvenance.length
      : (cluster.distinctScenarioCount ?? (cluster.scenarioIds?.length || 0));
  const stepCount = Math.max(1, operationCount);
  const avgDurationMs = cluster.metrics?.avgDurationMs ?? cluster.metrics?.totalDurationMs ?? 0;
  const avgTokens = cluster.metrics?.avgTokens ?? cluster.metrics?.totalTokens ?? 0;
  const totalCostUsd = cluster.metrics?.totalCostUsd;
  const avgCostUsd =
    totalCostUsd !== null && totalCostUsd !== undefined && Number.isFinite(totalCostUsd)
      ? totalCostUsd / occurrenceCount
      : null;

  const recurringOccurrences = Math.max(1, occurrenceCount - 1);
  const stepSavingRatio = stepCount > 1 ? (stepCount - 1) / stepCount : 0.5;

  const estimatedStepsSaved = Math.max(0, (stepCount - 1) * occurrenceCount);
  const estimatedDurationSavedMs = Math.round(
    avgDurationMs * stepSavingRatio * recurringOccurrences,
  );
  const estimatedTokensSaved = Math.round(avgTokens * stepSavingRatio * recurringOccurrences);
  const estimatedCostSavedUsd =
    avgCostUsd !== null
      ? Number((avgCostUsd * stepSavingRatio * recurringOccurrences).toFixed(4))
      : undefined;

  const confidence = Math.min(
    0.95,
    Number((0.5 + 0.1 * Math.min(distinctScenarios, 4)).toFixed(2)),
  );

  return {
    estimatedDurationSavedMs,
    estimatedTokensSaved,
    estimatedStepsSaved,
    savedDurationMs: estimatedDurationSavedMs,
    savedTokens: estimatedTokensSaved,
    ...(estimatedCostSavedUsd !== undefined
      ? { estimatedCostSavedUsd, savedCostUsd: estimatedCostSavedUsd }
      : {}),
    savedToolCalls: estimatedStepsSaved,
    confidence,
  };
}

/**
 * Evaluates value-based right-sizing gates for subworkflow candidates.
 */
export function evaluateRightSizing(
  subworkflowStepCount: number,
  scenarioStepCount: number,
  metrics: {
    avgDurationMs?: number;
    avgTokens?: number;
    totalCostUsd?: number | null;
    maxDurationMs?: number;
    maxTokens?: number;
    maxCostUsd?: number | null;
  } = {},
  options: RightSizingOptions = {},
): RightSizingResult {
  const opts: Required<RightSizingOptions> = {
    ...DEFAULT_RIGHT_SIZING_OPTIONS,
    ...options,
  };

  if (subworkflowStepCount <= 0) {
    return {
      isRightSized: false,
      decision: "negligible",
      description: "Empty subworkflow has negligible sizing.",
      subworkflowStepCount: 0,
      scenarioStepCount: scenarioStepCount > 0 ? scenarioStepCount : 1,
      coverageRatio: 0,
      isExpensiveSingleOp: false,
    };
  }
  const steps = subworkflowStepCount;
  const totalScenarioSteps = scenarioStepCount > 0 ? scenarioStepCount : steps;
  const coverageRatio =
    totalScenarioSteps > 0 ? Number((steps / totalScenarioSteps).toFixed(4)) : 1.0;

  const duration = metrics.avgDurationMs ?? metrics.maxDurationMs ?? 0;
  const tokens = metrics.avgTokens ?? metrics.maxTokens ?? 0;
  const cost =
    metrics.totalCostUsd !== undefined ? metrics.totalCostUsd : (metrics.maxCostUsd ?? null);
  const knownCost = cost !== null && Number.isFinite(cost);
  const costDescription = knownCost ? `$${cost}` : "unknown";

  const isExpensiveSingleOp =
    duration >= opts.expensiveSingleOpMinDurationMs ||
    tokens >= opts.expensiveSingleOpMinTokens ||
    (knownCost && cost !== null && cost >= opts.expensiveSingleOpMinCostUsd);

  // Case 1 & 2: Single operation
  if (steps === 1) {
    if (!isExpensiveSingleOp) {
      return {
        isRightSized: false,
        decision: "cheap_single_operation",
        description: `Single-operation wrapper is negligible/cheap (${duration}ms < ${opts.expensiveSingleOpMinDurationMs}ms, ${tokens} tokens < ${opts.expensiveSingleOpMinTokens}, cost: ${costDescription}). Requires >= ${opts.minStepsForCheapOperation} steps or demonstrably expensive operation.`,
        subworkflowStepCount: steps,
        scenarioStepCount: totalScenarioSteps,
        coverageRatio,
        isExpensiveSingleOp: false,
      };
    }
    return {
      isRightSized: true,
      decision: "valid_expensive_single_operation",
      description: `Demonstrably expensive single operation accepted (duration: ${duration}ms, tokens: ${tokens}, cost: ${costDescription}).`,
      subworkflowStepCount: steps,
      scenarioStepCount: totalScenarioSteps,
      coverageRatio,
      isExpensiveSingleOp: true,
    };
  }

  // Case 3: Reusable workflow covering nearly the whole representative scenario
  if (totalScenarioSteps > 1 && coverageRatio >= opts.fullWorkflowCoverageRatio) {
    return {
      isRightSized: true,
      decision: "valid_full_workflow",
      description: `Reusable full workflow (${steps} steps covering ${Math.round(coverageRatio * 100)}% of scenario) accepted.`,
      subworkflowStepCount: steps,
      scenarioStepCount: totalScenarioSteps,
      coverageRatio,
      isExpensiveSingleOp,
    };
  }

  // Case 4: Bounded multi-step subworkflow
  return {
    isRightSized: true,
    decision: "valid_subworkflow",
    description: `Bounded multi-step subworkflow (${steps} steps covering ${Math.round(coverageRatio * 100)}% of scenario) accepted.`,
    subworkflowStepCount: steps,
    scenarioStepCount: totalScenarioSteps,
    coverageRatio,
    isExpensiveSingleOp,
  };
}
