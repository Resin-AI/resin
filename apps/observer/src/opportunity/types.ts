import type {
  EpisodeSignature,
  NormalizedSessionEvent,
  OpportunityHashOutcome,
} from "@resin/contracts";

/**
 * Data values observed in session event payloads, command parameters, and tool arguments.
 * Kept structural (no unknown-key escape hatch) so the deterministic extractors below only
 * ever hash typed evidence.
 */
export type OpportunityDataValue =
  | string
  | number
  | boolean
  | null
  | readonly OpportunityDataValue[]
  | { readonly [key: string]: OpportunityDataValue };

/**
 * High-level functional category of a tool or command.
 */
export type ToolClass =
  | "file_read"
  | "file_edit"
  | "search"
  | "test_runner"
  | "build_tool"
  | "vcs"
  | "package_manager"
  | "shell_exec"
  | "subagent"
  | "browser"
  | "network"
  | "general";

/**
 * High-level classification of a semantic operation observed during workflow analysis.
 *
 * NOTE: Observed semantic decomposition and classifications are analysis evidence ONLY
 * and MUST NOT grant runtime file/command authority or bypass security/capability checks.
 */
export type SemanticOperationClass =
  | ToolClass
  | "inspect"
  | "verify"
  | "modify"
  | "diagnose"
  | "compile"
  | "test"
  | "query"
  | "execute"
  | "composite";

/**
 * A semantic operation in an observed workflow episode signature.
 *
 * SECURITY INVARIANT: semantic operations and raw command/event evidence are analysis and
 * clustering evidence ONLY. They MUST NOT grant runtime execution authority, file system
 * privileges, or command execution permissions.
 */
export interface SemanticOperation {
  id?: string;
  order?: number;
  operation?: string;
  name?: string;
  toolClass?: ToolClass;
  service?: "fs" | "net" | "cmd" | "secret" | "compute";
  action?: string;
  inputs?: Record<string, OpportunityDataValue>;
  evidenceEventIds?: string[];
  parameterShape?: Record<string, unknown>;
  operationClass?: SemanticOperationClass | string;
  intent?: string;
  commandProfile?: string;
  commandPattern?: string;
  normalizedPath?: string;
  argumentSchemaHash?: string;
  commandProfiles?: string[];
  eventIds?: string[];
  rawEventId?: string;
  profileIds?: string[];
  rawProfileId?: string;
  executable?: string;
  args?: string[];
  rawCommand?: string;
  paths?: string[];
  sequenceIndex?: number;
  isCompound?: boolean;
  subOperations?: SemanticOperation[];
  /** Analysis-only marker ensuring this structure cannot be used to grant execution authority. */
  analysisOnly?: true;
  durationMs?: number;
  estimatedDurationMs?: number;
  tokens?: number;
  estimatedTokens?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
}

/**
 * Metric summary for an individual episode.
 */
export interface EpisodeMetrics {
  stepCount: number;
  /** Provider total per assistant turn, cache reads included. */
  totalTokens: number;
  cachedInputTokens?: number;
  retryCount: number;
  /** Complete captured spend (including harness estimates); null when accounting is unknown. */
  estimatedCostUsd: number | null;
  costSource?: "reported" | "estimated" | "unknown";
  totalDurationMs: number;
}

/**
 * A contiguous segment of a session / branch event stream representing a cohesive workflow.
 */
export interface Episode {
  id: string;
  sessionId: string;
  scenarioId?: string;
  branchId?: string;
  accountId: string;
  workspaceId: string;
  events: NormalizedSessionEvent[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnIndex: number;
  isCompleted: boolean;
  hasErrors: boolean;
  metrics: EpisodeMetrics;
}

/**
 * Aggregated metrics across all episodes in a workflow cluster.
 * Superset of the `WorkflowClusterMetrics` DTO projected for the cloud.
 */
export interface ClusterMetrics {
  totalDurationMs: number;
  avgDurationMs: number;
  totalTokens: number;
  avgTokens: number;
  totalCostUsd: number | null;
  totalRetries: number;
  totalStepCount: number;
  avgStepCount: number;
}

/**
 * Structural cluster of similar episodes in a workspace.
 */
export interface WorkflowCluster {
  clusterId: string;
  workspaceId: string;
  version: string;
  structuralHash: string;
  representativeSignature: EpisodeSignature;
  episodes: Episode[];
  episodeCount: number;
  distinctSessionIds: string[];
  scenarioIds?: string[];
  distinctScenarioCount?: number;
  isCrossScenario?: boolean;
  completedOccurrences: number;
  metrics: ClusterMetrics;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceEventIds: string[];
}

/**
 * Trigger reason classification carried on candidate lifecycle state.
 */
export type CandidateTriggerReason =
  | "repeated_pattern"
  | "latency_bottleneck"
  | "failure_recovery"
  | "missing_abstraction"
  | "manual_request";

/**
 * Waste thresholds for triggering exceptional opportunities on a single occurrence.
 */
export interface WasteThresholds {
  exceptionalDurationMs: number;
  exceptionalTokenCount: number;
  exceptionalRetryCount: number;
  exceptionalCostUsd: number;
  exceptionalStepCount: number;
}

export const DEFAULT_WASTE_THRESHOLDS: WasteThresholds = {
  exceptionalDurationMs: 120_000, // 2 minutes
  exceptionalTokenCount: 25_000,
  exceptionalRetryCount: 3,
  exceptionalCostUsd: 0.5,
  exceptionalStepCount: 15,
};

/**
 * Suppression reason for unviable opportunities.
 */
export type SuppressionReason =
  | "trivial"
  | "out_of_envelope"
  | "destructive"
  | "unobservable"
  | "already_learned"
  | "in_progress"
  | "no_tool_operations"
  | "none";

/**
 * Most recent local lifecycle outcome recorded for a structural hash.
 */
export interface RecentOpportunityHashRecord {
  lastSeenAt: Date;
  outcome: OpportunityHashOutcome;
  attempts: number;
}

/**
 * Scenario provenance detailing cross-scenario occurrences.
 */
export interface WorkflowScenarioProvenance {
  scenarioId: string;
  episodeIds: string[];
  sessionIds: string[];
  occurrenceCount: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface RightSizingOptions {
  /** Coverage ratio at which a reusable multi-step candidate represents the full workflow (default: 0.85 = 85%) */
  fullWorkflowCoverageRatio?: number;
  /** Minimum step count for a cheap operation to be considered a subworkflow (default: 2) */
  minStepsForCheapOperation?: number;
  /** Minimum duration in ms for a single operation to be considered expensive (default: 5000) */
  expensiveSingleOpMinDurationMs?: number;
  /** Minimum tokens for a single operation to be considered expensive (default: 2000) */
  expensiveSingleOpMinTokens?: number;
  /** Minimum cost in USD for a single operation to be considered expensive (default: 0.05) */
  expensiveSingleOpMinCostUsd?: number;
}

export const DEFAULT_RIGHT_SIZING_OPTIONS: Required<RightSizingOptions> = {
  fullWorkflowCoverageRatio: 0.85,
  minStepsForCheapOperation: 2,
  expensiveSingleOpMinDurationMs: 5000,
  expensiveSingleOpMinTokens: 2000,
  expensiveSingleOpMinCostUsd: 0.05,
};

export type RightSizingDecision =
  | "negligible"
  | "cheap_single_operation"
  | "valid_full_workflow"
  | "valid_subworkflow"
  | "valid_expensive_single_operation";

export interface RightSizingResult {
  isRightSized: boolean;
  decision: RightSizingDecision;
  description: string;
  subworkflowStepCount: number;
  scenarioStepCount: number;
  coverageRatio: number;
  isExpensiveSingleOp: boolean;
}

/**
 * Options for EpisodeSegmenter.
 */
export interface SegmenterOptions {
  idleGapThresholdMs?: number;
  minEventsPerEpisode?: number;
  maxEventsPerEpisode?: number;
}

/**
 * Options for StructuralClusterer.
 */
export interface ClustererOptions {
  version?: string;
  similarityThreshold?: number;
}

/**
 * Options for TriggerEvaluator.
 */
export interface TriggerOptions {
  minOccurrencesNormal?: number;
  minOccurrences?: number;
  minDistinctScenarios?: number;
  wasteThresholds?: Partial<WasteThresholds>;
}

/**
 * Options for SuppressionEngine.
 */
export interface SuppressionOptions {
  disallowedCommands?: string[];
  minMeaningfulSteps?: number;
}
