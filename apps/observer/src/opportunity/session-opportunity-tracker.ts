import {
  CURRENT_PATTERN_SCHEMA_VERSION,
  type CapabilityEnvelope,
  type CoverageResult,
  type EpisodeSignature,
  type EstimatedSavedWork,
  type NormalizedSessionEvent,
  type ProvenPatternDto,
  ProvenPatternDtoSchema,
  type SuppressionResult,
  type ToolManifest,
  type TriggerResult,
  hashCanonicalContent,
} from "@resin/contracts";
import type {
  CapabilityRepository,
  OpportunityHashCacheRecord,
  OpportunityLocalRepository,
  ToolRepository,
} from "@resin/db";
import type { HarnessSession } from "@resin/harness-contracts";
import type { SessionEventSinkContext } from "../analytics/capture-coordinator.js";
import type { Logger } from "../lifecycle.js";
import type { KillSwitchManager } from "../observability/kill-switches.js";
import { StructuralClusterer } from "./clustering.js";
import { CoverageEngine } from "./coverage.js";
import { EpisodeSegmenter } from "./episode.js";
import { deriveEstimatedSavedWork, deriveScenarioProvenance } from "./saved-work.js";
import { SignatureExtractor } from "./signature.js";
import { SuppressionEngine } from "./suppression.js";
import { TriggerEvaluator } from "./triggers.js";
import type {
  ClustererOptions,
  Episode,
  RecentOpportunityHashRecord,
  SegmenterOptions,
  SuppressionOptions,
  TriggerOptions,
  WorkflowCluster,
} from "./types.js";

export interface SessionOpportunityTrackerOptions {
  /** Local opportunity repository (`store.opportunities`). */
  opportunities: OpportunityLocalRepository;
  /** Local tool catalog used for coverage evaluation. */
  tools?: ToolRepository;
  /** Local capability envelope source used for suppression evaluation. */
  capabilities?: CapabilityRepository;
  /** Evolution kill switch; a paused switch halts local detection. */
  killSwitches?: KillSwitchManager;
  logger?: Logger;
  /** Injectable clock in epoch milliseconds. */
  now?: () => number;
  /** Cost of synthesizing one tool, in USD. Dispatch requires projected savings to beat it. */
  synthesisCostUsd?: number;
  /** Minimum evidence-maturity confidence (0..1) required to dispatch. */
  minDispatchConfidence?: number;
  /** Rolling per-session episode window bound. */
  maxEpisodesPerSession?: number;
  /** Rolling per-workspace episode window bound used for cross-session recurrence. */
  maxEpisodesPerWorkspace?: number;
  /** Structural hash cache lookback used for suppression evidence. */
  hashCacheLookbackMs?: number;
  /** Idempotency-cache expiry written for freshly dispatched patterns. */
  hashCacheTtlMs?: number;
  segmenterOptions?: SegmenterOptions;
  clustererOptions?: ClustererOptions;
  triggerOptions?: TriggerOptions;
  suppressionOptions?: SuppressionOptions;
  /** Engine revision recorded on cached hashes. Defaults to the clusterer version. */
  engineVersion?: string;
  /**
   * Authenticated account that owns local sessions. Used for the published pattern's
   * `accountId`; absent means the local fallback identifier.
   */
  accountId?: string;
  /** Notified after a proven pattern is durably enqueued in the pattern outbox. */
  onPatternProven?: (pattern: ProvenPatternDto) => void;
}

/** In-flight state for one session's unsegmented event tail. */
interface TrackedSession {
  sessionId: string;
  workspaceId: string;
  /** Metadata-projected events awaiting / driving segmentation. */
  pendingEvents: NormalizedSessionEvent[];
  /** LRU-bounded set of already-observed event ids. */
  seenEventIds: Map<string, true>;
}

/**
 * Workspace-scoped rolling window of closed episodes.
 *
 * Cross-session recurrence is the core normal-frequency signal, so clustering runs over the
 * workspace window rather than one session's episodes. Bounds are enforced both per session and
 * per workspace to keep long-running daemons flat.
 */
interface WorkspaceWindow {
  episodes: Episode[];
  episodeIds: Set<string>;
  perSessionCounts: Map<string, number>;
}

export interface SessionOpportunityTrackerDiagnostics {
  trackedSessions: number;
  trackedWorkspaces: number;
  observedEvents: number;
  closedEpisodes: number;
  clustersEvaluated: number;
  patternsProven: number;
  suppressedClusters: number;
  skippedByHashCache: number;
  killSwitchBlocked: number;
  droppedEpisodes: number;
}

const DEFAULT_SYNTHESIS_COST_USD = 0.05;
const DEFAULT_MIN_DISPATCH_CONFIDENCE = 0.5;
const DEFAULT_MAX_EPISODES_PER_SESSION = 64;
const WORKSPACE_EPISODE_FACTOR = 8;
const MAX_EPISODES_PER_WORKSPACE = 1_024;
const DEFAULT_HASH_CACHE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_HASH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EVENTS_PER_EPISODE_BUDGET = 64;
const MIN_PENDING_EVENT_CAPACITY = 512;
const MAX_PENDING_EVENT_CAPACITY = 20_000;
const MIN_SEEN_EVENT_CAPACITY = 4_096;
const MAX_TRACKED_SESSIONS = 128;
const MAX_TRACKED_WORKSPACES = 32;
const TOOL_CATALOG_TTL_MS = 30_000;
const HASH_CACHE_TTL_MS = 5_000;

function toPositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Continuous per-session opportunity tracker.
 *
 * Consumes the metadata-projected normalized event stream emitted by
 * {@link TrajectoryCaptureCoordinator} and incrementally runs the deterministic local
 * opportunity engine over each session's rolling episode window:
 * segment -> sign -> cluster -> trigger -> suppress -> cover -> estimate saved work.
 *
 * A pattern is dispatched only when the projected per-pattern savings, discounted by evidence
 * maturity (`confidence = min(1, occurrences / 2)`), exceed the configured synthesis cost.
 * Proven patterns are enqueued into the local pattern outbox (idempotent on idempotency key)
 * and recorded in the local structural-hash cache so repeated sessions do not re-dispatch them.
 */
export class SessionOpportunityTracker {
  private readonly opportunities: OpportunityLocalRepository;
  private readonly tools?: ToolRepository;
  private readonly capabilities?: CapabilityRepository;
  private readonly killSwitches?: KillSwitchManager;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly synthesisCostUsd: number;
  private readonly minDispatchConfidence: number;
  private readonly maxEpisodesPerSession: number;
  private readonly maxEpisodesPerWorkspace: number;
  private readonly pendingEventCapacity: number;
  private readonly seenEventCapacity: number;
  private readonly hashCacheLookbackMs: number;
  private readonly hashCacheTtlMs: number;
  private readonly engineVersion?: string;
  private readonly accountId?: string;
  private readonly segmenter: EpisodeSegmenter;
  private readonly extractor: SignatureExtractor;
  private readonly clusterer: StructuralClusterer;
  private readonly triggers: TriggerEvaluator;
  private readonly suppression: SuppressionEngine;
  private readonly coverage: CoverageEngine;
  private readonly onPatternProvenFn?: (pattern: ProvenPatternDto) => void;
  private readonly listeners = new Set<(pattern: ProvenPatternDto) => void>();

  private readonly sessions = new Map<string, TrackedSession>();
  private readonly workspaces = new Map<string, WorkspaceWindow>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly dispatchedHashes = new Set<string>();

  private toolCatalogCache?: { expiresAtMs: number; manifests: ToolManifest[] };
  private hashCacheSnapshot?: {
    expiresAtMs: number;
    records: Map<string, RecentOpportunityHashRecord>;
  };
  private diagnostics: SessionOpportunityTrackerDiagnostics = {
    trackedSessions: 0,
    trackedWorkspaces: 0,
    observedEvents: 0,
    closedEpisodes: 0,
    clustersEvaluated: 0,
    patternsProven: 0,
    suppressedClusters: 0,
    skippedByHashCache: 0,
    killSwitchBlocked: 0,
    droppedEpisodes: 0,
  };

  constructor(options: SessionOpportunityTrackerOptions) {
    this.opportunities = options.opportunities;
    this.tools = options.tools;
    this.capabilities = options.capabilities;
    this.killSwitches = options.killSwitches;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.synthesisCostUsd = options.synthesisCostUsd ?? DEFAULT_SYNTHESIS_COST_USD;
    this.minDispatchConfidence = options.minDispatchConfidence ?? DEFAULT_MIN_DISPATCH_CONFIDENCE;
    this.maxEpisodesPerSession = toPositiveInt(
      options.maxEpisodesPerSession,
      DEFAULT_MAX_EPISODES_PER_SESSION,
    );
    this.maxEpisodesPerWorkspace = Math.min(
      MAX_EPISODES_PER_WORKSPACE,
      toPositiveInt(
        options.maxEpisodesPerWorkspace,
        this.maxEpisodesPerSession * WORKSPACE_EPISODE_FACTOR,
      ),
    );
    this.pendingEventCapacity = Math.min(
      MAX_PENDING_EVENT_CAPACITY,
      Math.max(MIN_PENDING_EVENT_CAPACITY, this.maxEpisodesPerSession * EVENTS_PER_EPISODE_BUDGET),
    );
    this.seenEventCapacity = Math.max(MIN_SEEN_EVENT_CAPACITY, this.pendingEventCapacity * 4);
    this.hashCacheLookbackMs = toPositiveInt(
      options.hashCacheLookbackMs,
      DEFAULT_HASH_CACHE_LOOKBACK_MS,
    );
    this.hashCacheTtlMs = toPositiveInt(options.hashCacheTtlMs, DEFAULT_HASH_CACHE_TTL_MS);
    this.engineVersion = options.engineVersion;
    this.accountId = options.accountId;
    this.onPatternProvenFn = options.onPatternProven;
    this.segmenter = new EpisodeSegmenter(options.segmenterOptions);
    this.extractor = new SignatureExtractor();
    this.clusterer = new StructuralClusterer(options.clustererOptions);
    this.triggers = new TriggerEvaluator(options.triggerOptions);
    this.suppression = new SuppressionEngine(options.suppressionOptions);
    this.coverage = new CoverageEngine();
  }

  /** Registers a listener invoked after a proven pattern is durably enqueued. */
  subscribe(listener: (pattern: ProvenPatternDto) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Consumes one batch of metadata-projected normalized events for a session.
   *
   * Batches are serialized per session so segmentation, clustering, and dispatch observe a
   * deterministic event order regardless of caller concurrency. Rejections never reach the
   * caller: a local consumer failure must not break capture or cloud submission.
   */
  handleSessionEvents(
    session: HarnessSession,
    events: readonly NormalizedSessionEvent[],
    context: SessionEventSinkContext,
  ): Promise<void> {
    if (events.length === 0) {
      return Promise.resolve();
    }
    const { sessionId } = session;
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.trackBatch(session, events, context))
      .catch((err) => {
        this.logger?.warn(`Opportunity tracking failed for session ${sessionId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    this.sessionQueues.set(sessionId, next);
    void next.finally(() => {
      if (this.sessionQueues.get(sessionId) === next) {
        this.sessionQueues.delete(sessionId);
      }
    });
    return next;
  }

  /**
   * Releases a session's in-flight event tail. Episodes already contributed to the workspace
   * window stay available for cross-session recurrence.
   */
  pruneSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
  }

  /** Drops all in-memory tracking state. Persisted signatures, clusters and hashes remain. */
  reset(): void {
    this.sessions.clear();
    this.workspaces.clear();
    this.sessionQueues.clear();
    this.dispatchedHashes.clear();
    this.toolCatalogCache = undefined;
    this.hashCacheSnapshot = undefined;
  }

  getDiagnostics(): SessionOpportunityTrackerDiagnostics {
    return {
      ...this.diagnostics,
      trackedSessions: this.sessions.size,
      trackedWorkspaces: this.workspaces.size,
    };
  }

  /** Session ids with an in-flight event tail, oldest first. */
  getTrackedSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private isEvolutionAllowed(): boolean {
    if (!this.killSwitches) {
      return true;
    }
    try {
      return this.killSwitches.canEvolve().allowed === true;
    } catch (err) {
      this.logger?.warn("Kill switch evaluation failed; halting opportunity detection", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async trackBatch(
    session: HarnessSession,
    events: readonly NormalizedSessionEvent[],
    context: SessionEventSinkContext,
  ): Promise<void> {
    if (!this.isEvolutionAllowed()) {
      this.diagnostics.killSwitchBlocked += 1;
      return;
    }
    const state = this.getOrCreateSession(session);
    const freshEvents: NormalizedSessionEvent[] = [];
    for (const event of events) {
      if (state.seenEventIds.has(event.eventId)) {
        continue;
      }
      this.rememberEventId(state, event.eventId);
      state.pendingEvents.push(this.stampWorkspace(state.workspaceId, event));
      freshEvents.push(event);
    }
    if (freshEvents.length === 0) {
      return;
    }
    this.diagnostics.observedEvents += freshEvents.length;
    this.enforceEventCapacity(state);

    const episodes = this.segmenter.segmentEvents(state.pendingEvents);
    // The segmenter always flushes a trailing batch, so its last episode may still be an open
    // turn. It only counts as closed once the session is terminal or a later episode exists.
    const closedCount = context.isTerminal ? episodes.length : Math.max(0, episodes.length - 1);
    const window = this.getOrCreateWorkspace(state.workspaceId);
    const closedEpisodes: Episode[] = [];
    for (const episode of episodes.slice(0, closedCount)) {
      if (window.episodeIds.has(episode.id)) {
        continue;
      }
      closedEpisodes.push(episode);
    }
    if (closedEpisodes.length === 0) {
      if (context.isTerminal) {
        this.pruneSession(session.sessionId);
      }
      return;
    }

    this.diagnostics.closedEpisodes += closedEpisodes.length;
    for (const episode of closedEpisodes) {
      await this.persistSignature(episode);
      this.retainEpisode(window, episode);
    }
    this.enforceWorkspaceCapacity();

    await this.evaluateClusters(window, state.workspaceId);

    if (context.isTerminal) {
      this.pruneSession(session.sessionId);
    }
  }

  /**
   * Attributes an event to the session's workspace.
   *
   * The normalization pipeline does not stamp tenant identity onto events, so without this every
   * local episode collapses into one default workspace bucket and the clusterer can never isolate
   * workspaces. Identity goes into `metadata` (schema-valid, and the engine's documented fallback
   * source); structural hashing never reads it.
   */
  private stampWorkspace(
    workspaceId: string,
    event: NormalizedSessionEvent,
  ): NormalizedSessionEvent {
    const existing = event.metadata?.workspaceId;
    if (!workspaceId || (typeof existing === "string" && existing.length > 0)) {
      return event;
    }
    return {
      ...event,
      metadata: { ...(event.metadata ?? {}), workspaceId },
    } as NormalizedSessionEvent;
  }

  private getOrCreateSession(session: HarnessSession): TrackedSession {
    const existing = this.sessions.get(session.sessionId);
    if (existing) {
      if (session.workspaceId) {
        existing.workspaceId = session.workspaceId;
      }
      // Re-insert to move the session to the freshest end of the LRU ordering.
      this.sessions.delete(session.sessionId);
      this.sessions.set(session.sessionId, existing);
      return existing;
    }
    const created: TrackedSession = {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId || "default-workspace",
      pendingEvents: [],
      seenEventIds: new Map(),
    };
    this.sessions.set(session.sessionId, created);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) {
        break;
      }
      this.sessions.delete(oldest.value);
    }
    return created;
  }

  private rememberEventId(state: TrackedSession, eventId: string): void {
    state.seenEventIds.set(eventId, true);
    while (state.seenEventIds.size > this.seenEventCapacity) {
      const oldest = state.seenEventIds.keys().next();
      if (oldest.done) {
        return;
      }
      state.seenEventIds.delete(oldest.value);
    }
  }

  private enforceEventCapacity(state: TrackedSession): void {
    const overflow = state.pendingEvents.length - this.pendingEventCapacity;
    if (overflow > 0) {
      state.pendingEvents.splice(0, overflow);
    }
  }

  private getOrCreateWorkspace(workspaceId: string): WorkspaceWindow {
    const existing = this.workspaces.get(workspaceId);
    if (existing) {
      // Re-insert to move the workspace to the freshest end of the LRU ordering.
      this.workspaces.delete(workspaceId);
      this.workspaces.set(workspaceId, existing);
      return existing;
    }
    const created: WorkspaceWindow = {
      episodes: [],
      episodeIds: new Set(),
      perSessionCounts: new Map(),
    };
    this.workspaces.set(workspaceId, created);
    return created;
  }

  private retainEpisode(window: WorkspaceWindow, episode: Episode): void {
    window.episodes.push(episode);
    window.episodeIds.add(episode.id);
    const sessionCount = (window.perSessionCounts.get(episode.sessionId) ?? 0) + 1;
    window.perSessionCounts.set(episode.sessionId, sessionCount);
    if (sessionCount <= this.maxEpisodesPerSession) {
      return;
    }
    // Per-session overflow: drop this session's oldest retained episode.
    const index = window.episodes.findIndex(
      (candidate) => candidate.sessionId === episode.sessionId,
    );
    if (index >= 0) {
      this.dropEpisodeAt(window, index);
    }
  }

  private enforceWorkspaceCapacity(): void {
    while (this.workspaces.size > MAX_TRACKED_WORKSPACES) {
      const oldest = this.workspaces.keys().next();
      if (oldest.done) {
        break;
      }
      this.workspaces.delete(oldest.value);
    }
    for (const window of this.workspaces.values()) {
      while (window.episodes.length > this.maxEpisodesPerWorkspace) {
        this.dropEpisodeAt(window, 0);
      }
    }
  }

  private dropEpisodeAt(window: WorkspaceWindow, index: number): void {
    const [dropped] = window.episodes.splice(index, 1);
    if (!dropped) {
      return;
    }
    window.episodeIds.delete(dropped.id);
    const remaining = (window.perSessionCounts.get(dropped.sessionId) ?? 1) - 1;
    if (remaining > 0) {
      window.perSessionCounts.set(dropped.sessionId, remaining);
    } else {
      window.perSessionCounts.delete(dropped.sessionId);
    }
    this.diagnostics.droppedEpisodes += 1;
  }

  private async persistSignature(episode: Episode): Promise<void> {
    const signature: EpisodeSignature = this.extractor.extractSignature(episode);
    await this.opportunities.insertSignature({
      signatureId: signature.signatureId,
      sessionId: episode.sessionId,
      structuralHash: signature.structuralHash,
      episodeId: episode.id,
      payload: signature,
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  private async evaluateClusters(window: WorkspaceWindow, workspaceId: string): Promise<void> {
    const clusters = this.clusterer.clusterEpisodes(window.episodes);
    if (clusters.length === 0) {
      return;
    }
    const manifests = await this.loadToolCatalog();
    const recentHashes = await this.loadRecentHashCache();
    const envelope = await this.loadCapabilityEnvelope(workspaceId);

    for (const cluster of clusters) {
      this.diagnostics.clustersEvaluated += 1;
      if (cluster.episodeCount === 0 || this.dispatchedHashes.has(cluster.structuralHash)) {
        continue;
      }
      if (await this.isHashCacheBlocked(cluster.structuralHash)) {
        this.diagnostics.skippedByHashCache += 1;
        continue;
      }

      const trigger = this.triggers.evaluateCluster(cluster);
      if (!trigger.triggered) {
        continue;
      }

      const suppression = this.suppression.evaluateSuppression(cluster, {
        envelope,
        recentOpportunityHashes: recentHashes,
        now: this.now(),
      });
      if (suppression.suppressed) {
        this.diagnostics.suppressedClusters += 1;
        continue;
      }

      const coverage = this.coverage.evaluateCoverage(cluster, manifests);
      if (coverage.status === "covered" || coverage.status === "duplicate") {
        this.diagnostics.suppressedClusters += 1;
        continue;
      }

      const estimatedSavedWork = deriveEstimatedSavedWork(
        cluster,
        cluster.representativeSignature.operations.length ||
          cluster.representativeSignature.stepCount,
        deriveScenarioProvenance(cluster),
      );
      const confidence = this.computeDispatchConfidence(cluster);
      if (confidence < this.minDispatchConfidence) {
        continue;
      }
      // Dynamic dispatch predicate: only pay for synthesis when discounted savings clear it.
      if (this.expectedSavingsUsd(estimatedSavedWork) * confidence <= this.synthesisCostUsd) {
        continue;
      }

      await this.dispatchPattern(
        cluster,
        estimatedSavedWork,
        trigger,
        suppression,
        coverage,
        confidence,
      );
    }
  }

  private computeDispatchConfidence(cluster: WorkflowCluster): number {
    const occurrences =
      cluster.completedOccurrences > 0 ? cluster.completedOccurrences : cluster.episodeCount;
    return Math.min(1, occurrences / 2);
  }

  private expectedSavingsUsd(estimated: EstimatedSavedWork): number {
    return estimated.estimatedCostSavedUsd ?? estimated.savedCostUsd ?? 0;
  }

  private async dispatchPattern(
    cluster: WorkflowCluster,
    estimatedSavedWork: EstimatedSavedWork,
    trigger: TriggerResult,
    suppression: SuppressionResult,
    coverage: CoverageResult,
    confidence: number,
  ): Promise<void> {
    const workspaceId = cluster.workspaceId || "default-workspace";
    const evidenceEventIds = [...cluster.evidenceEventIds].sort();
    const idempotencyKey = `opp_ik_${hashCanonicalContent({
      workspaceId,
      structuralHash: cluster.structuralHash,
      triggerType: trigger.triggerType,
      triggerReason: trigger.reason,
      evidenceEventIds,
    })}`;
    const patternId = `pat_${hashCanonicalContent({
      workspaceId,
      structuralHash: cluster.structuralHash,
      triggerReason: trigger.reason,
      idempotencyKey,
    }).slice(0, 32)}`;
    const engineVersion = this.engineVersion ?? cluster.version;

    const pattern = ProvenPatternDtoSchema.parse({
      schemaVersion: CURRENT_PATTERN_SCHEMA_VERSION,
      patternId,
      idempotencyKey,
      accountId: this.accountId || cluster.episodes[0]?.accountId || "default-account",
      workspaceId,
      engineVersion,
      signature: cluster.representativeSignature,
      cluster: {
        clusterId: cluster.clusterId,
        structuralHash: cluster.structuralHash,
        episodeCount: cluster.episodeCount,
        distinctSessionIds: [...cluster.distinctSessionIds],
        scenarioIds: [...(cluster.scenarioIds ?? [])],
        distinctScenarioCount: cluster.distinctScenarioCount ?? cluster.scenarioIds?.length ?? 0,
        completedOccurrences: cluster.completedOccurrences,
        firstSeenAt: cluster.firstSeenAt,
        lastSeenAt: cluster.lastSeenAt,
        evidenceEventIds: [...cluster.evidenceEventIds],
        metrics: {
          totalTokens: cluster.metrics.totalTokens,
          totalCostUsd: cluster.metrics.totalCostUsd,
          avgDurationMs: cluster.metrics.avgDurationMs,
          avgTokens: cluster.metrics.avgTokens,
          totalRetries: cluster.metrics.totalRetries,
          avgStepCount: cluster.metrics.avgStepCount,
        },
      },
      localVerdicts: { trigger, suppression, coverage, estimatedSavedWork },
      evidenceEventIds,
      recurrence: { confidence, occurrences: cluster.episodeCount },
    });

    await this.opportunities.enqueuePattern({
      patternId,
      idempotencyKey,
      workspaceId,
      payload: pattern,
      createdAt: new Date(this.now()).toISOString(),
    });
    await this.recordDispatchedHash(cluster.structuralHash, engineVersion);

    this.dispatchedHashes.add(cluster.structuralHash);
    this.diagnostics.patternsProven += 1;
    this.emitPatternProven(pattern);
  }

  private async recordDispatchedHash(structuralHash: string, engineVersion: string): Promise<void> {
    const nowMs = this.now();
    const existing = await this.opportunities.getHashCacheEntry(structuralHash);
    await this.opportunities.upsertHashCacheEntry({
      structuralHash,
      outcome: "in_progress",
      lastSeenAt: new Date(nowMs).toISOString(),
      attempts: (existing?.attempts ?? 0) + 1,
      sourceRevision: engineVersion,
      syncedAt: null,
      expiresAt: new Date(nowMs + this.hashCacheTtlMs).toISOString(),
    });
    this.hashCacheSnapshot = undefined;
  }

  private async isHashCacheBlocked(structuralHash: string): Promise<boolean> {
    const entry = await this.opportunities.getHashCacheEntry(structuralHash);
    if (!entry) {
      return false;
    }
    if (entry.outcome === "published" || entry.outcome === "in_progress") {
      return true;
    }
    if (entry.outcome === "rejected_on_merit") {
      const expiresAtMs = Date.parse(entry.expiresAt);
      return !Number.isFinite(expiresAtMs) || expiresAtMs > this.now();
    }
    return false;
  }

  private async loadToolCatalog(): Promise<ToolManifest[]> {
    if (!this.tools) {
      return [];
    }
    const cached = this.toolCatalogCache;
    if (cached && cached.expiresAtMs > this.now()) {
      return cached.manifests;
    }
    try {
      const manifests = await this.tools.listManifests();
      this.toolCatalogCache = { expiresAtMs: this.now() + TOOL_CATALOG_TTL_MS, manifests };
      return manifests;
    } catch (err) {
      this.logger?.warn("Failed to load local tool catalog for coverage evaluation", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async loadCapabilityEnvelope(
    workspaceId: string,
  ): Promise<CapabilityEnvelope | undefined> {
    if (!this.capabilities) {
      return undefined;
    }
    try {
      return (await this.capabilities.getEnvelope(workspaceId)) ?? undefined;
    } catch (err) {
      this.logger?.warn("Failed to load capability envelope for suppression evaluation", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async loadRecentHashCache(): Promise<Map<string, RecentOpportunityHashRecord>> {
    const cached = this.hashCacheSnapshot;
    if (cached && cached.expiresAtMs > this.now()) {
      return cached.records;
    }
    const since = new Date(this.now() - this.hashCacheLookbackMs).toISOString();
    let records: OpportunityHashCacheRecord[] = [];
    try {
      records = await this.opportunities.listRecentHashCache(since);
    } catch (err) {
      this.logger?.warn("Failed to load local structural hash cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const map = new Map<string, RecentOpportunityHashRecord>();
    for (const record of records) {
      map.set(record.structuralHash, {
        lastSeenAt: new Date(record.lastSeenAt),
        outcome: record.outcome,
        attempts: record.attempts,
      });
    }
    this.hashCacheSnapshot = { expiresAtMs: this.now() + HASH_CACHE_TTL_MS, records: map };
    return map;
  }

  private emitPatternProven(pattern: ProvenPatternDto): void {
    if (this.onPatternProvenFn) {
      try {
        this.onPatternProvenFn(pattern);
      } catch (err) {
        this.logger?.warn("Opportunity pattern listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(pattern);
      } catch (err) {
        this.logger?.warn("Opportunity pattern subscriber failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
