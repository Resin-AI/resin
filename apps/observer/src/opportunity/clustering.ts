import {
  type EpisodeSignature,
  type NormalizedSessionEvent,
  hashCanonicalContent,
} from "@resin/contracts";
import {
  extractScenarioId,
  isActionableStep,
  isErrorEvent,
  parseTimestampMs,
  summarizeEpisodeUsage,
} from "./episode.js";
import { SignatureExtractor } from "./signature.js";
import type {
  ClusterMetrics,
  ClustererOptions,
  Episode,
  EpisodeMetrics,
  SemanticOperation,
  WorkflowCluster,
} from "./types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
export const CLUSTER_ENGINE_VERSION = "1.0.0";

/**
 * Computes Jaccard similarity between two arrays of strings.
 */
function computeJaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersection++;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/**
 * Computes sequence alignment similarity ratio (Levenshtein-based) between two string arrays.
 */
function computeSequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Exact match
  if (a.length === b.length && a.every((v, i) => v === b[i])) {
    return 1.0;
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  return Math.max(0, 1 - distance / maxLen);
}

/**
 * Checks if candidate subsequence is contiguously contained within a larger sequence.
 */
function isSubsequenceContained(subSeq: string[], largerSeq: string[]): boolean {
  if (subSeq.length === 0) return true;
  if (subSeq.length > largerSeq.length) return false;
  for (let i = 0; i <= largerSeq.length - subSeq.length; i++) {
    let match = true;
    for (let j = 0; j < subSeq.length; j++) {
      if (largerSeq[i + j] !== subSeq[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Computes composite structural similarity score between two EpisodeSignatures.
 */
export function computeSignatureSimilarity(sigA: EpisodeSignature, sigB: EpisodeSignature): number {
  // Exact structural hash match
  if (sigA.structuralHash === sigB.structuralHash) {
    return 1.0;
  }
  const shapedA = (sigA.semanticOperations as SemanticOperation[] | undefined)?.some(
    (operation) => operation.parameterShape !== undefined,
  );
  const shapedB = (sigB.semanticOperations as SemanticOperation[] | undefined)?.some(
    (operation) => operation.parameterShape !== undefined,
  );
  if (
    (shapedA || shapedB) &&
    JSON.stringify(sigA.argumentSchemaHashes) !== JSON.stringify(sigB.argumentSchemaHashes)
  ) {
    return 0;
  }

  const opSim = computeSequenceSimilarity(sigA.operations, sigB.operations);
  const classSim = computeJaccardSimilarity(sigA.toolClasses, sigB.toolClasses);
  const argSim = computeJaccardSimilarity(sigA.argumentSchemaHashes, sigB.argumentSchemaHashes);
  const cmdSim = computeSequenceSimilarity(sigA.commandPatterns, sigB.commandPatterns);

  if (sigA.commandPatterns.length > 0 || sigB.commandPatterns.length > 0) {
    return 0.35 * opSim + 0.35 * cmdSim + 0.2 * classSim + 0.1 * argSim;
  }

  return 0.5 * opSim + 0.3 * classSim + 0.2 * argSim;
}

interface StepRange {
  stepIndex: number;
  startEventIndex: number;
  endEventIndex: number;
}

/**
 * Identifies contiguous event boundaries for each actionable workflow step in an episode.
 */
function getActionableStepRanges(events: NormalizedSessionEvent[]): StepRange[] {
  if (events.length === 0) return [];

  const actionableIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (isActionableStep(events[i])) {
      actionableIndices.push(i);
    }
  }

  if (actionableIndices.length === 0) {
    return [{ stepIndex: 0, startEventIndex: 0, endEventIndex: events.length - 1 }];
  }

  const ranges: StepRange[] = [];
  for (let k = 0; k < actionableIndices.length; k++) {
    const startEventIndex = k === 0 ? 0 : actionableIndices[k];
    const endEventIndex =
      k === actionableIndices.length - 1 ? events.length - 1 : actionableIndices[k + 1] - 1;
    ranges.push({
      stepIndex: k,
      startEventIndex,
      endEventIndex,
    });
  }

  return ranges;
}

/**
 * Builds a deterministic sub-episode from a contiguous slice of events.
 */
function buildSubEpisode(
  parent: Episode,
  events: NormalizedSessionEvent[],
  sliceStart: number,
  sliceEnd: number,
): Episode {
  const first = events[0];
  const last = events[events.length - 1];
  const startedAt = first?.timestamp ?? parent.startedAt;
  const endedAt = last?.timestamp ?? parent.endedAt;

  const startMs = parseTimestampMs(startedAt);
  const endMs = parseTimestampMs(endedAt);
  const wallDurationMs = Math.max(0, endMs - startMs);

  let stepCount = 0;
  let hasErrors = false;
  const retryCount = 0;
  let accumulatedToolDurationMs = 0;

  for (const evt of events) {
    if (isActionableStep(evt)) {
      stepCount++;
    }

    if (isErrorEvent(evt)) {
      hasErrors = true;
    }
    if (evt.type === "command_exec") {
      accumulatedToolDurationMs += evt.durationMs;
    } else if (evt.type === "tool_result") {
      accumulatedToolDurationMs += evt.executionDurationMs;
    }
  }

  const totalDurationMs = Math.max(wallDurationMs, accumulatedToolDurationMs);
  const usage = summarizeEpisodeUsage(events);

  const metrics: EpisodeMetrics = {
    stepCount,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    retryCount,
    estimatedCostUsd: usage.costUsd,
    costSource: usage.costSource,
    totalDurationMs,
  };

  const eventIdsDigest = hashCanonicalContent(events.map((e) => e.eventId)).slice(0, 12);
  const id = `${parent.id}_sub_${sliceStart}_${sliceEnd}_${eventIdsDigest}`;

  let scenarioId = parent.scenarioId;
  if (!scenarioId && Array.isArray(events)) {
    scenarioId = extractScenarioId(events);
  }
  if (!scenarioId) {
    scenarioId = parent.sessionId;
  }

  return {
    id,
    sessionId: parent.sessionId,
    branchId: parent.branchId,
    accountId: parent.accountId,
    workspaceId: parent.workspaceId,
    events,
    startedAt,
    endedAt,
    durationMs: totalDurationMs,
    turnIndex: parent.turnIndex,
    isCompleted: parent.isCompleted,
    hasErrors,
    metrics,
    scenarioId,
  };
}

interface CandidateItem {
  episode: Episode;
  signature: EpisodeSignature;
  parentEpisodeId: string;
  parentSessionId: string;
  parentScenarioId?: string;
  stepCount: number;
  isFullEpisode: boolean;
  sliceStart: number;
  sliceEnd: number;
}

interface CandidateCluster {
  representativeSignature: EpisodeSignature;
  items: CandidateItem[];
}

/**
 * Structural similarity clustering engine for Workflow Episodes.
 * Supports whole-episode clustering and recurring contiguous semantic subworkflow discovery.
 */
export class StructuralClusterer {
  private readonly version: string;
  private readonly similarityThreshold: number;
  private readonly extractor: SignatureExtractor;

  constructor(options: ClustererOptions = {}) {
    this.version = options.version ?? CLUSTER_ENGINE_VERSION;
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.extractor = new SignatureExtractor();
  }

  /**
   * Clusters a collection of episodes by structural similarity within workspace boundaries.
   * Discovers recurring contiguous semantic subsequences across distinct scenarios.
   */
  clusterEpisodes(episodes: Episode[]): WorkflowCluster[] {
    if (!episodes || episodes.length === 0) {
      return [];
    }

    // Group by workspace first to strictly enforce workspace isolation
    const byWorkspace = new Map<string, Episode[]>();
    for (const ep of episodes) {
      const ws = ep.workspaceId || "default-workspace";
      const existing = byWorkspace.get(ws) || [];
      existing.push(ep);
      byWorkspace.set(ws, existing);
    }

    const clusters: WorkflowCluster[] = [];

    for (const [workspaceId, wsEpisodes] of byWorkspace.entries()) {
      const candidates: CandidateItem[] = [];

      for (const ep of wsEpisodes) {
        let epScenarioId = ep.scenarioId;
        if (!epScenarioId && Array.isArray(ep.events)) {
          epScenarioId = extractScenarioId(ep.events);
        }
        if (!epScenarioId) {
          epScenarioId = ep.sessionId;
        }
        if (!ep.scenarioId) {
          ep.scenarioId = epScenarioId;
        }

        const stepRanges = getActionableStepRanges(ep.events);
        const m = stepRanges.length;

        // 1. Full episode candidate
        const fullSig = this.extractor.extractSignature(ep);
        candidates.push({
          episode: ep,
          signature: fullSig,
          parentEpisodeId: ep.id,
          parentSessionId: ep.sessionId,
          parentScenarioId: epScenarioId,
          stepCount: ep.metrics.stepCount || m,
          isFullEpisode: true,
          sliceStart: 0,
          sliceEnd: m > 0 ? m - 1 : 0,
        });

        // 2. Contiguous sub-slices of length 2 to (m - 1)
        if (m >= 3) {
          for (let s = 0; s < m; s++) {
            for (let e = s + 1; e < m; e++) {
              const sliceLen = e - s + 1;
              if (sliceLen >= 2 && sliceLen < m) {
                const startEvtIdx = stepRanges[s].startEventIndex;
                const endEvtIdx = stepRanges[e].endEventIndex;
                const slicedEvents = ep.events.slice(startEvtIdx, endEvtIdx + 1);
                const subEp = buildSubEpisode(ep, slicedEvents, s, e);
                const subSig = this.extractor.extractSignature(subEp);
                candidates.push({
                  episode: subEp,
                  signature: subSig,
                  parentEpisodeId: ep.id,
                  parentSessionId: ep.sessionId,
                  parentScenarioId: epScenarioId,
                  stepCount: sliceLen,
                  isFullEpisode: false,
                  sliceStart: s,
                  sliceEnd: e,
                });
              }
            }
          }
        }
      }
      // Sort candidates deterministically: larger chunks first, then timestamp, parentEpisodeId, slice
      candidates.sort((a, b) => {
        if (b.stepCount !== a.stepCount) return b.stepCount - a.stepCount;
        const tsA = Date.parse(a.episode.startedAt) || 0;
        const tsB = Date.parse(b.episode.startedAt) || 0;
        if (tsA !== tsB) return tsA - tsB;
        if (a.parentEpisodeId !== b.parentEpisodeId) {
          return a.parentEpisodeId.localeCompare(b.parentEpisodeId);
        }
        return a.sliceStart - b.sliceStart;
      });

      // Cluster candidates by signature similarity
      const candidateClusters: CandidateCluster[] = [];

      for (const cand of candidates) {
        let matchedClusterIndex = -1;
        let highestSim = 0;

        for (let i = 0; i < candidateClusters.length; i++) {
          const c = candidateClusters[i];
          const candidateLength = cand.signature.operations.length;
          const representativeLength = c.representativeSignature.operations.length;
          const maxLength = Math.max(candidateLength, representativeLength);
          const lengthRatio =
            maxLength === 0 ? 1 : Math.min(candidateLength, representativeLength) / maxLength;
          if (lengthRatio < this.similarityThreshold) {
            continue;
          }

          // Sequence alignment already accounts for small ordering and command-profile
          // differences. Exact equality here would discard the reusable full workflow.

          const sim = computeSignatureSimilarity(cand.signature, c.representativeSignature);
          if (sim >= this.similarityThreshold && sim > highestSim) {
            highestSim = sim;
            matchedClusterIndex = i;
          }
        }
        if (matchedClusterIndex >= 0) {
          candidateClusters[matchedClusterIndex].items.push(cand);
        } else {
          candidateClusters.push({
            representativeSignature: cand.signature,
            items: [cand],
          });
        }
      }

      // Analyze candidate clusters for recurrence and deduplicate subsumed sub-chunks
      interface EvaluatedCluster {
        cluster: CandidateCluster;
        parentEpisodeIds: Set<string>;
        sessionIds: Set<string>;
        scenarioIds: Set<string>;
        distinctOccurrences: number;
        stepCount: number;
        operationSequence: string[];
        hasFullEpisode: boolean;
      }

      const evaluatedClusters: EvaluatedCluster[] = candidateClusters.map((cc) => {
        const parentEpisodeIds = new Set(cc.items.map((i) => i.parentEpisodeId));
        const sessionIds = new Set(cc.items.map((i) => i.parentSessionId));
        const scenarioIds = new Set(
          cc.items
            .map((i) => i.parentScenarioId)
            .filter((s): s is string => Boolean(s && s.trim().length > 0)),
        );
        const hasFullEpisode = cc.items.some((i) => i.isFullEpisode);
        return {
          cluster: cc,
          parentEpisodeIds,
          sessionIds,
          scenarioIds,
          distinctOccurrences: parentEpisodeIds.size,
          stepCount: cc.representativeSignature.operations.length,
          operationSequence: cc.representativeSignature.operations,
          hasFullEpisode,
        };
      });

      // Split into recurring (occurrence >= 2) and single-occurrence
      const recurring = evaluatedClusters.filter((ec) => ec.distinctOccurrences >= 2);
      const acceptedRecurring: EvaluatedCluster[] = [];

      // Sort recurring by stepCount descending, then distinctOccurrences descending
      recurring.sort((a, b) => {
        if (b.stepCount !== a.stepCount) return b.stepCount - a.stepCount;
        return b.distinctOccurrences - a.distinctOccurrences;
      });

      for (const cand of recurring) {
        const isSubsumed = acceptedRecurring.some((accepted) => {
          if (accepted.stepCount <= cand.stepCount) return false;
          const containsOps = isSubsequenceContained(
            cand.operationSequence,
            accepted.operationSequence,
          );
          if (!containsOps) return false;
          const coversAllEpisodes = Array.from(cand.parentEpisodeIds).every((epId) =>
            accepted.parentEpisodeIds.has(epId),
          );
          return coversAllEpisodes;
        });

        if (!isSubsumed) {
          acceptedRecurring.push(cand);
        }
      }

      // Track parent episodes covered by accepted recurring clusters
      const coveredParentEpisodes = new Set<string>();
      for (const ar of acceptedRecurring) {
        for (const epId of ar.parentEpisodeIds) {
          coveredParentEpisodes.add(epId);
        }
      }

      // For single-occurrence full episodes: if not covered by any recurring cluster, retain as standalone cluster
      const acceptedSingle: EvaluatedCluster[] = [];
      const singleOccurrences = evaluatedClusters.filter(
        (ec) => ec.distinctOccurrences === 1 && ec.hasFullEpisode,
      );

      for (const single of singleOccurrences) {
        const epId = Array.from(single.parentEpisodeIds)[0];
        if (!coveredParentEpisodes.has(epId)) {
          acceptedSingle.push(single);
        }
      }

      const selectedClusters = [...acceptedRecurring, ...acceptedSingle];
      selectedClusters.sort((a, b) => {
        if (b.distinctOccurrences !== a.distinctOccurrences) {
          return b.distinctOccurrences - a.distinctOccurrences;
        }
        if (b.stepCount !== a.stepCount) {
          return b.stepCount - a.stepCount;
        }
        return a.cluster.representativeSignature.structuralHash.localeCompare(
          b.cluster.representativeSignature.structuralHash,
        );
      });

      for (const sel of selectedClusters) {
        const clusterEpisodes: Episode[] = [];
        const seenParent = new Set<string>();

        for (const item of sel.cluster.items) {
          if (!seenParent.has(item.parentEpisodeId)) {
            seenParent.add(item.parentEpisodeId);
            clusterEpisodes.push(item.episode);
          }
        }

        const cluster = this.buildCluster(
          workspaceId,
          sel.cluster.representativeSignature,
          clusterEpisodes,
        );
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Builds an aggregated WorkflowCluster with deterministic metrics and scenario provenance.
   */
  private buildCluster(
    workspaceId: string,
    representativeSignature: EpisodeSignature,
    episodes: Episode[],
  ): WorkflowCluster {
    const episodeCount = episodes.length;
    const sessionIdsSet = new Set<string>();
    const scenarioIdsSet = new Set<string>();
    const evidenceEventIdsSet = new Set<string>();
    let completedOccurrences = 0;

    let totalDurationMs = 0;
    let totalTokens = 0;
    let totalCostUsd: number | null = 0;
    let totalRetries = 0;
    let totalStepCount = 0;

    let firstSeenMs = Number.MAX_SAFE_INTEGER;
    let firstSeenAt = new Date().toISOString();
    let lastSeenMs = 0;
    let lastSeenAt = new Date(0).toISOString();

    for (const ep of episodes) {
      if (ep.sessionId) {
        sessionIdsSet.add(ep.sessionId);
      }
      let sid = ep.scenarioId && ep.scenarioId.trim().length > 0 ? ep.scenarioId.trim() : undefined;
      if (!sid && Array.isArray(ep.events)) {
        sid = extractScenarioId(ep.events);
      }
      if (!sid) {
        sid = ep.sessionId;
      }
      if (sid && sid.trim().length > 0) {
        const trimmed = sid.trim();
        scenarioIdsSet.add(trimmed);
        if (!ep.scenarioId) {
          ep.scenarioId = trimmed;
        }
      }
      if (ep.isCompleted || (ep.isCompleted === undefined && !ep.hasErrors)) {
        completedOccurrences++;
      }

      totalDurationMs += ep.metrics.totalDurationMs;
      totalTokens += ep.metrics.totalTokens;
      const episodeCostUsd = ep.metrics.estimatedCostUsd;
      totalCostUsd =
        totalCostUsd !== null && episodeCostUsd !== null && Number.isFinite(episodeCostUsd)
          ? totalCostUsd + episodeCostUsd
          : null;
      totalRetries += ep.metrics.retryCount;
      totalStepCount += ep.metrics.stepCount;

      for (const evt of ep.events) {
        evidenceEventIdsSet.add(evt.eventId);
      }

      const startMs = Date.parse(ep.startedAt) || 0;
      const endMs = Date.parse(ep.endedAt) || startMs;

      if (startMs < firstSeenMs) {
        firstSeenMs = startMs;
        firstSeenAt = ep.startedAt;
      }
      if (endMs > lastSeenMs) {
        lastSeenMs = endMs;
        lastSeenAt = ep.endedAt;
      }
    }

    const avgDurationMs = episodeCount > 0 ? Math.round(totalDurationMs / episodeCount) : 0;
    const avgTokens = episodeCount > 0 ? Math.round(totalTokens / episodeCount) : 0;
    const avgStepCount =
      episodeCount > 0 ? Math.round((totalStepCount / episodeCount) * 10) / 10 : 0;

    const metrics: ClusterMetrics = {
      totalDurationMs,
      avgDurationMs,
      totalTokens,
      avgTokens,
      totalCostUsd:
        totalCostUsd !== null && Number.isFinite(totalCostUsd)
          ? Number(totalCostUsd.toFixed(6))
          : null,
      totalRetries,
      totalStepCount,
      avgStepCount,
    };

    const structuralHash = representativeSignature.structuralHash;
    const clusterId = `cluster_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "")}_${structuralHash.slice(0, 16)}`;
    const scenarioIds = Array.from(scenarioIdsSet).sort();
    const distinctScenarioCount = scenarioIds.length > 0 ? scenarioIds.length : undefined;
    const isCrossScenario = (distinctScenarioCount ?? 0) >= 2;

    return {
      clusterId,
      workspaceId,
      version: this.version,
      structuralHash,
      representativeSignature,
      episodes,
      episodeCount,
      distinctSessionIds: Array.from(sessionIdsSet).sort(),
      scenarioIds,
      distinctScenarioCount,
      isCrossScenario,
      completedOccurrences,
      metrics,
      firstSeenAt,
      lastSeenAt,
      evidenceEventIds: Array.from(evidenceEventIdsSet).sort(),
    };
  }
}

/**
 * Convenience function to cluster episodes.
 */
export function clusterWorkflowEpisodes(
  episodes: Episode[],
  options?: ClustererOptions,
): WorkflowCluster[] {
  const clusterer = new StructuralClusterer(options);
  return clusterer.clusterEpisodes(episodes);
}
