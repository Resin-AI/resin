import {
  COMPUTATION_TRANSFORM_APIS,
  COMPUTATION_TRANSFORM_NODE_KINDS,
  type EstimatedSavedWork,
  type ResinComputationEvidenceV1,
  isSubstantiveComputationEvidence,
  readComputationEvidence,
} from "@resin/contracts";
import { extractScenarioId } from "./episode.js";
import { extractEpisodeSignature } from "./signature.js";
import {
  DEFAULT_RIGHT_SIZING_OPTIONS,
  type RightSizingOptions,
  type RightSizingResult,
  type WorkflowCluster,
  type WorkflowScenarioProvenance,
} from "./types.js";

export { DEFAULT_RIGHT_SIZING_OPTIONS };

const SUBSTANTIVE_NODE_KINDS: Readonly<Record<string, true>> = Object.fromEntries(
  COMPUTATION_TRANSFORM_NODE_KINDS.map((kind) => [kind, true] as const),
);

const SUBSTANTIVE_CALL_APIS: Readonly<Record<string, true>> = Object.fromEntries(
  COMPUTATION_TRANSFORM_APIS.map((api) => [api, true] as const),
);

const AUTHORING_NEGLIGIBLE_APIS: Readonly<Record<string, true>> = {
  "core.to_string": true,
  "json.serialize": true,
};

const COMPUTATION_FIXED_OVERHEAD_UNITS = 256;
const COMPUTATION_SLOT_OVERHEAD_UNITS = 8;
const COMPUTATION_DEFINITION_OVERHEAD_UNITS = 4;

type ComputationEvidenceInput =
  | ResinComputationEvidenceV1
  | readonly ResinComputationEvidenceV1[]
  | undefined;

interface ComputationValueSummary {
  evidenceCount: number;
  uniqueProgramCount: number;
  substantiveNodeCount: number;
  authoringUnits: number;
  overheadUnits: number;
  netAuthoringUnits: number;
}

function normalizeComputationEvidence(
  evidenceInput: ComputationEvidenceInput,
): ResinComputationEvidenceV1[] {
  if (evidenceInput === undefined) {
    return [];
  }
  const candidates = Array.isArray(evidenceInput) ? evidenceInput : [evidenceInput];
  const parsed: ResinComputationEvidenceV1[] = [];
  const seenEvidenceIds = new Set<string>();
  for (const candidate of candidates) {
    const evidence = readComputationEvidence(candidate);
    if (evidence === undefined || !isSubstantiveComputationEvidence(evidence)) {
      continue;
    }
    if (seenEvidenceIds.has(evidence.evidenceId)) {
      continue;
    }
    seenEvidenceIds.add(evidence.evidenceId);
    parsed.push(evidence);
  }

  // Temporal correction selection belongs to the signature extractor. A historical digest set
  // cannot distinguish a superseded invocation from a later deliberate restoration of its body.
  return parsed;
}

function countSubstantiveAuthoringNodes(evidence: ResinComputationEvidenceV1): number {
  let count = 0;
  for (const node of evidence.program.nodes) {
    if (SUBSTANTIVE_NODE_KINDS[node.kind] === true) {
      count += 1;
      continue;
    }
    if (
      node.kind === "call" &&
      typeof node.api === "string" &&
      SUBSTANTIVE_CALL_APIS[node.api] === true &&
      AUTHORING_NEGLIGIBLE_APIS[node.api] !== true
    ) {
      count += 1;
    }
  }
  return count;
}

function summarizeComputationValue(
  evidenceInput: ComputationEvidenceInput,
): ComputationValueSummary | undefined {
  const evidence = normalizeComputationEvidence(evidenceInput);
  if (evidence.length === 0) {
    return undefined;
  }

  const bestByProgramDigest = new Map<string, ComputationValueSummary>();
  for (const candidate of evidence) {
    const substantiveNodeCount = countSubstantiveAuthoringNodes(candidate);
    const sourceCap = Math.floor(candidate.metrics.sourceBytes / 4);
    const authoringUnits = Math.min(substantiveNodeCount * 16, sourceCap);
    const overheadUnits =
      COMPUTATION_FIXED_OVERHEAD_UNITS +
      candidate.program.slots.length * COMPUTATION_SLOT_OVERHEAD_UNITS +
      candidate.program.definitions.length * COMPUTATION_DEFINITION_OVERHEAD_UNITS +
      candidate.program.outputs.length;
    const summary: ComputationValueSummary = {
      evidenceCount: 1,
      uniqueProgramCount: 1,
      substantiveNodeCount,
      authoringUnits,
      overheadUnits,
      netAuthoringUnits: authoringUnits - overheadUnits,
    };
    const previous = bestByProgramDigest.get(candidate.programDigest);
    if (previous === undefined || summary.netAuthoringUnits > previous.netAuthoringUnits) {
      bestByProgramDigest.set(candidate.programDigest, summary);
    }
  }

  let best: ComputationValueSummary | undefined;
  for (const summary of bestByProgramDigest.values()) {
    if (best === undefined || summary.netAuthoringUnits > best.netAuthoringUnits) {
      best = summary;
    }
  }
  if (best === undefined) {
    return undefined;
  }

  return {
    ...best,
    evidenceCount: evidence.length,
    uniqueProgramCount: bestByProgramDigest.size,
  };
}

function collectClusterComputationEvidence(cluster: WorkflowCluster): ResinComputationEvidenceV1[] {
  const operations =
    cluster.representativeSignature.semanticOperations ??
    cluster.episodes.flatMap(
      (episode) => extractEpisodeSignature(episode).semanticOperations ?? [],
    );
  const candidates: ResinComputationEvidenceV1[] = [];
  for (const operation of operations) {
    if (
      typeof operation !== "object" ||
      operation === null ||
      !("computationEvidence" in operation)
    ) {
      continue;
    }
    const evidence = readComputationEvidence(operation.computationEvidence);
    if (evidence !== undefined) candidates.push(evidence);
  }
  return candidates;
}

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
  const computationSummary = summarizeComputationValue(collectClusterComputationEvidence(cluster));
  if (computationSummary !== undefined) {
    const estimatedTokensSaved = Math.max(0, Math.round(computationSummary.netAuthoringUnits));
    return {
      estimatedDurationSavedMs: 0,
      estimatedTokensSaved,
      estimatedStepsSaved: 0,
      savedDurationMs: 0,
      savedTokens: estimatedTokensSaved,
      savedToolCalls: 0,
      confidence: Math.min(
        0.9,
        Number((0.55 + 0.05 * Math.min(computationSummary.uniqueProgramCount, 4)).toFixed(2)),
      ),
    };
  }

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
    computationEvidence?: ComputationEvidenceInput;
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

  const computationSummary = summarizeComputationValue(metrics.computationEvidence);

  // Case 1 & 2: Single operation
  if (steps === 1) {
    if (computationSummary !== undefined) {
      // Strictly validated substantive computation evidence decides admission on its own. The
      // advisory authoring estimate is reported for ranking and is never an admission threshold,
      // so a small or negative net estimate still qualifies.
      return {
        isRightSized: true,
        decision: "valid_computation" as RightSizingResult["decision"],
        description: `Evidence-backed computation accepted (advisory authoring benefit: ${computationSummary.netAuthoringUnits} bounded units after discovery/invocation/schema/config overhead; ${computationSummary.substantiveNodeCount} substantive semantic nodes across ${computationSummary.uniqueProgramCount} unique program digest(s); priced usage unknown/incomplete).`,
        subworkflowStepCount: steps,
        scenarioStepCount: totalScenarioSteps,
        coverageRatio,
        isExpensiveSingleOp,
      };
    }
    if (!isExpensiveSingleOp) {
      return {
        isRightSized: false,
        decision: "cheap_single_operation",
        description: `Single-operation wrapper is negligible/cheap (${duration}ms < ${opts.expensiveSingleOpMinDurationMs}ms, ${tokens} tokens < ${opts.expensiveSingleOpMinTokens}, cost: ${costDescription}). Requires >= ${opts.minStepsForCheapOperation} steps, demonstrably expensive operation, or credible computation evidence.`,
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
