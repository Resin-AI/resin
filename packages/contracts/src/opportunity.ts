import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";

/**
 * Literal version written by the local opportunity engine when it builds a ProvenPatternDto.
 * Kept as a plain literal (not a schema literal) so newer senders stay parseable by older readers.
 */
export const CURRENT_PATTERN_SCHEMA_VERSION = "1.0.0";

/**
 * Non-negative USD amount. Absent/null means "no usable monetary value", never zero.
 */
const OptionalCostUsdSchema = z.number().nonnegative().nullable().optional();

/**
 * Trigger classification for a detected opportunity.
 * - normal_frequency: recurring structural pattern observed across sessions.
 * - exceptional_waste: single occurrence exceeding exceptional waste thresholds.
 * - none: no trigger fired.
 */
export const TriggerTypeSchema = z.enum(["normal_frequency", "exceptional_waste", "none"]);

export type TriggerType = z.infer<typeof TriggerTypeSchema>;

/**
 * Tool coverage status of a cluster relative to the local catalog.
 * - net_new: no existing tool resembles the workflow.
 * - update_candidate: an existing tool partially covers the workflow.
 * - covered: an existing tool already performs the workflow.
 * - duplicate: the workflow duplicates an already-tracked opportunity.
 */
export const CoverageStatusSchema = z.enum(["net_new", "update_candidate", "covered", "duplicate"]);

export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/**
 * Local persistence outcome tracked per structural hash to avoid re-dispatching a pattern.
 */
export const OpportunityHashOutcomeSchema = z.enum([
  "published",
  "in_progress",
  "rejected_on_merit",
  "failed_infra",
  "not_dispatched",
]);

export type OpportunityHashOutcome = z.infer<typeof OpportunityHashOutcomeSchema>;

/**
 * Aggregated metrics across every episode in a workflow cluster.
 */
export const WorkflowClusterMetricsSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().nullable(),
  avgDurationMs: z.number().nonnegative(),
  avgTokens: z.number().nonnegative(),
  totalRetries: z.number().int().nonnegative(),
  avgStepCount: z.number().nonnegative(),
});

export type WorkflowClusterMetrics = z.infer<typeof WorkflowClusterMetricsSchema>;

/**
 * Estimated work saved by adopting a synthesized tool or reusable subworkflow.
 * Values are advisory ranking heuristics, never verified ledger savings.
 * `estimated*` fields are forward-looking per-occurrence projections;
 * `saved*` fields are totals over the observed cluster occurrences.
 */
export const EstimatedSavedWorkSchema = z.object({
  estimatedDurationSavedMs: z.number().nonnegative(),
  estimatedTokensSaved: z.number().int().nonnegative(),
  estimatedStepsSaved: z.number().nonnegative(),
  savedDurationMs: z.number().nonnegative(),
  savedTokens: z.number().int().nonnegative(),
  estimatedCostSavedUsd: OptionalCostUsdSchema,
  savedCostUsd: OptionalCostUsdSchema,
  savedToolCalls: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

export type EstimatedSavedWork = z.infer<typeof EstimatedSavedWorkSchema>;

/**
 * Deterministic structural features extracted from a single episode.
 * Two episodes with equal `structuralHash` are considered structurally identical.
 */
export const EpisodeSignatureSchema = z.object({
  signatureId: IdentifierSchema,
  structuralHash: z.string().min(1),
  operations: z.array(z.string()),
  toolClasses: z.array(z.string()),
  commandPatterns: z.array(z.string()),
  normalizedPaths: z.array(z.string()),
  argumentSchemaHashes: z.array(z.string()),
  semanticOperations: z.array(z.unknown()).optional(),
  stepCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  estimatedCostUsd: OptionalCostUsdSchema,
});

export type EpisodeSignature = z.infer<typeof EpisodeSignatureSchema>;

/**
 * Episode aggregate for one structural pattern, carrying cluster-level evidence and metrics.
 */
export const WorkflowClusterSummarySchema = z.object({
  clusterId: IdentifierSchema,
  structuralHash: z.string().min(1),
  episodeCount: z.number().int().nonnegative(),
  distinctSessionIds: z.array(IdentifierSchema),
  scenarioIds: z.array(IdentifierSchema),
  distinctScenarioCount: z.number().int().nonnegative(),
  completedOccurrences: z.number().int().nonnegative(),
  firstSeenAt: ISOTimestampSchema,
  lastSeenAt: ISOTimestampSchema,
  evidenceEventIds: z.array(IdentifierSchema),
  metrics: WorkflowClusterMetricsSchema,
});

export type WorkflowClusterSummary = z.infer<typeof WorkflowClusterSummarySchema>;

/**
 * Metrics observed by the trigger evaluation, surfaced for local and cloud diagnostics.
 */
export const TriggerMetricsSchema = z.object({
  occurrenceCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  estimatedCostUsd: OptionalCostUsdSchema,
  stepCount: z.number().int().nonnegative().optional(),
});

export type TriggerMetrics = z.infer<typeof TriggerMetricsSchema>;

/**
 * Result of evaluating opportunity triggers against a cluster or single episode.
 */
export const TriggerResultSchema = z.object({
  triggered: z.boolean(),
  triggerType: TriggerTypeSchema,
  reason: z.string(),
  description: z.string(),
  evidenceEventIds: z.array(IdentifierSchema),
  metrics: TriggerMetricsSchema,
});

export type TriggerResult = z.infer<typeof TriggerResultSchema>;

/**
 * Result of suppression analysis for a candidate opportunity.
 * `excludedOperationIds` / `excludedEventIds` record what suppression removed from the evidence set.
 */
export const SuppressionResultSchema = z.object({
  suppressed: z.boolean(),
  reason: z.string(),
  details: z.string(),
  excludedOperationIds: z.array(IdentifierSchema).optional(),
  excludedEventIds: z.array(IdentifierSchema).optional(),
  matchedPattern: z.string().optional(),
});

export type SuppressionResult = z.infer<typeof SuppressionResultSchema>;

/**
 * Result of comparing a cluster against the local tool catalog.
 */
export const CoverageResultSchema = z.object({
  status: CoverageStatusSchema,
  matchingToolId: IdentifierSchema.optional(),
  matchingToolName: z.string().optional(),
  similarityScore: z.number().min(0).max(1),
  overlapRatio: z.number().min(0).max(1),
  reason: z.string(),
  suggestedActions: z.array(z.string()).optional(),
});

export type CoverageResult = z.infer<typeof CoverageResultSchema>;

/**
 * Local verdict bundle accompanying a published pattern: why it triggered, why it survived
 * suppression, how it relates to existing coverage, and what it is expected to save.
 */
export const LocalVerdictsSchema = z.object({
  trigger: TriggerResultSchema,
  suppression: SuppressionResultSchema,
  coverage: CoverageResultSchema,
  estimatedSavedWork: EstimatedSavedWorkSchema,
});

export type LocalVerdicts = z.infer<typeof LocalVerdictsSchema>;

/**
 * Local-to-cloud payload describing a locally detected and proven workflow pattern.
 * Deterministically derived from `signature.structuralHash` + `idempotencyKey` so repeated
 * dispatches for the same pattern are deduplicated by the receiver.
 * `recurrence` carries optional local recurrence metadata and is intentionally opaque here.
 */
export const ProvenPatternDtoSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  patternId: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  engineVersion: SchemaVersionSchema,
  signature: EpisodeSignatureSchema,
  cluster: WorkflowClusterSummarySchema,
  localVerdicts: LocalVerdictsSchema,
  evidenceEventIds: z.array(IdentifierSchema),
  recurrence: z.unknown().optional(),
});

export type ProvenPatternDto = z.infer<typeof ProvenPatternDtoSchema>;

/**
 * Local persistence cache entry keyed by structural hash, tracking dispatch outcome for a pattern.
 * `syncedAt` is null while the entry has not yet been reconciled with the cloud.
 */
export const OpportunityHashCacheEntrySchema = z.object({
  structuralHash: z.string().min(1),
  outcome: OpportunityHashOutcomeSchema,
  lastSeenAt: ISOTimestampSchema,
  attempts: z.number().int().nonnegative(),
  syncedAt: ISOTimestampSchema.nullable(),
  expiresAt: ISOTimestampSchema,
});

export type OpportunityHashCacheEntry = z.infer<typeof OpportunityHashCacheEntrySchema>;
