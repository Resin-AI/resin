import { randomUUID } from "node:crypto";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  type NormalizedSessionEvent,
  type ProviderReportedUsage,
  Sha256DigestSchema,
  hashCanonicalContent,
  providerUsageRequestKey,
  readRequestLinkMetadata,
  selectProviderUsageSnapshot,
} from "@resin/contracts";
import { z } from "zod";
import {
  type ProviderUsageAvailability,
  type TrajectoryModelUsage,
  type TrajectoryObservation,
  TrajectoryObservationSchema,
  TrajectoryRoleSchema,
  type TrajectoryStatus,
  TrajectoryStatusSchema,
  type TrajectoryUsage,
  TrajectoryUsageSchema,
} from "../cloud-runtime.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);
const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const TrajectoryAttributionContextSchema = z
  .object({
    observationId: IdentifierSchema.optional(),
    accountId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    ownerUserId: IdentifierSchema,
    projectId: IdentifierSchema,
    candidateId: IdentifierSchema,
    toolId: IdentifierSchema,
    toolVersion: z.string().min(1),
    workloadId: z.string().min(1),
    trajectoryId: z.string().min(1),
    parentTrajectoryId: z.string().min(1).nullish(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    accountingVersion: z.string().min(1).optional(),
    runtimeVersion: z.string().min(1),
    role: TrajectoryRoleSchema,
    status: TrajectoryStatusSchema.optional().default("success"),
    isEquivalent: z.boolean().optional().default(false),
    catalogExposureTokens: z.number().int().nonnegative().optional().default(0),
    observedAt: ISOTimestampSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();

export type TrajectoryAttributionContext = z.infer<typeof TrajectoryAttributionContextSchema>;
export type TrajectoryAttributionContextInput = z.input<typeof TrajectoryAttributionContextSchema>;

/**
 * Custom error thrown when trajectory validation fails.
 */
export class TrajectoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryValidationError";
  }
}

/**
 * Custom error thrown when conflicting provider, model, or accountingVersion identities are detected.
 */
export class MixedTrajectoryIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixedTrajectoryIdentityError";
  }
}

/**
 * Custom error thrown when an operation is attempted on an already finalized trajectory emitter.
 */
export class TrajectoryAlreadyFinalizedError extends Error {
  constructor(message = "Trajectory has already been finalized") {
    super(message);
    this.name = "TrajectoryAlreadyFinalizedError";
  }
}

/**
 * Computes deterministic SHA-256 digest of a trajectory observation or its canonical payload.
 */
export function computeTrajectoryObservationDigest(
  observation:
    | TrajectoryObservation
    | {
        digest?: string;
        canonicalPayload?: JsonObject;
        createdAt?: string;
      },
): string {
  if (observation.canonicalPayload) {
    return hashCanonicalContent(observation.canonicalPayload);
  }
  const {
    digest: _digest,
    createdAt: _createdAt,
    canonicalPayload: _canonicalPayload,
    ...rest
  } = observation;
  return hashCanonicalContent(rest);
}

/** One distinct request's latest usage snapshot and the auxiliary purpose its event named. */
interface RequestUsageEntry {
  usage: ProviderReportedUsage;
  /** Absent for the conversation's own requests. */
  purpose: string | undefined;
}

type RequestSums = Omit<TrajectoryModelUsage, "provider" | "model" | "requestCount" | "purposes">;

/**
 * Sums distinct requests the way the cloud request summarizer does. A category sums only when every
 * request reported it, and `missing` requests (named by a link, never reporting usage) leave every
 * category unknown. The total is the four categories' sum only when every request is complete.
 * Cost sums only when every request reported one on the same basis: source-reported and
 * harness-estimated amounts are never added together.
 */
function sumRequests(usages: readonly ProviderReportedUsage[], missing: number): RequestSums {
  const known = (field: keyof RequestSums & keyof ProviderReportedUsage): number | null =>
    missing === 0 && usages.every((usage) => typeof usage[field] === "number")
      ? usages.reduce((total, usage) => total + Number(usage[field]), 0)
      : null;
  const complete = missing === 0 && usages.every((usage) => usage.availability === "complete");
  const inputTokens = known("inputTokens");
  const cachedInputTokens = known("cachedInputTokens");
  const cacheWriteTokens = known("cacheWriteTokens");
  const outputTokens = known("outputTokens");
  const basis = usages[0]?.costProvenance;
  const oneCostBasis =
    basis !== undefined && usages.every((usage) => usage.costProvenance === basis);
  const availability: ProviderUsageAvailability = complete
    ? "complete"
    : missing === 0 && usages.every((usage) => usage.availability === "unavailable")
      ? "unavailable"
      : "partial";
  return {
    availability,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: known("reasoningTokens"),
    totalTokens:
      complete &&
      inputTokens !== null &&
      cachedInputTokens !== null &&
      cacheWriteTokens !== null &&
      outputTokens !== null
        ? inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
        : null,
    costMicroUsd: oneCostBasis ? known("costMicroUsd") : null,
    durationMs: known("durationMs"),
    costProvenances: [
      ...new Set(usages.flatMap((usage) => (usage.costProvenance ? [usage.costProvenance] : []))),
    ].sort(),
  };
}

/**
 * Request-semantics usage of a trajectory: every distinct request counts once whatever its
 * provider or model, with a per provider/model breakdown (sorted) carrying each model's own sums,
 * cost bases and auxiliary purposes. No price is ever carried from one model to another.
 */
function summarizeTrajectoryRequests(
  entries: readonly RequestUsageEntry[],
  missing: number,
): TrajectoryUsage {
  const groups = new Map<string, RequestUsageEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.usage.provider, entry.usage.model ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const models: TrajectoryModelUsage[] = [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, group]) => ({
      provider: group[0]!.usage.provider,
      model: group[0]!.usage.model ?? null,
      requestCount: group.length,
      ...sumRequests(
        group.map((entry) => entry.usage),
        0,
      ),
      purposes: [
        ...new Set(group.flatMap((entry) => (entry.purpose ? [entry.purpose] : []))),
      ].sort(),
    }));
  return {
    ...sumRequests(
      entries.map((entry) => entry.usage),
      missing,
    ),
    usageSemantics: "request",
    requestCount: entries.length + missing,
    models,
  };
}

/**
 * TrajectoryEmitter: aggregates successful non-duplicate normalized session events
 * into authoritative, privacy-safe TrajectoryObservation records for cloud calibration.
 */
export class TrajectoryEmitter {
  private readonly context: TrajectoryAttributionContext;
  private readonly seenEventIds = new Set<string>();
  private finalized = false;
  private finalizedObservation: TrajectoryObservation | null = null;

  private resolvedProvider: string | null = null;
  private resolvedModel: string | null = null;
  private resolvedAccountingVersion: string | null = null;
  private currentStatus: TrajectoryStatus;
  private lastObservedAt: string | null = null;

  /** The session every ingested event must belong to, named by the first event. */
  private boundSessionId: string | null = null;
  /** Usage records without request identity (legacy), summed as they arrive. */
  private readonly legacyUsages: ProviderReportedUsage[] = [];
  /** Cumulative meters: only the latest snapshot per provider and session counts. */
  private readonly cumulativeUsages = new Map<string, ProviderReportedUsage>();
  /**
   * Request-scoped usage, one snapshot per request identity (provider, session, request id), with
   * the auxiliary purpose its event named (absent for the conversation's own requests).
   */
  private readonly requestUsages = new Map<string, RequestUsageEntry>();
  /** Session-scoped request ids that reported usage, to match request links against. */
  private readonly requestIdsWithUsage = new Set<string>();
  /** Session-scoped request ids that events name as their issuing request. */
  private readonly linkedRequestIds = new Set<string>();
  /** The first auxiliary request's identity, used only when no other names the session. */
  private auxiliaryIdentity: ProviderReportedUsage | null = null;

  constructor(contextInput: TrajectoryAttributionContextInput) {
    this.context = TrajectoryAttributionContextSchema.parse(contextInput);
    this.resolvedProvider = this.context.provider ?? null;
    this.resolvedModel = this.context.model ?? null;
    this.resolvedAccountingVersion = this.context.accountingVersion ?? null;
    this.currentStatus = this.context.status ?? "success";
    this.lastObservedAt = this.context.observedAt ?? null;
  }

  /**
   * Returns a copy of the attribution context.
   */
  public getAttributionContext(): TrajectoryAttributionContext {
    return { ...this.context };
  }

  /**
   * Whether this trajectory has been finalized.
   */
  public isFinalized(): boolean {
    return this.finalized;
  }

  /**
   * Returns the finalized observation if available, otherwise null.
   */
  public getObservation(): TrajectoryObservation | null {
    return this.finalizedObservation;
  }

  /**
   * Returns the count of unique ingested events.
   */
  public getEventCount(): number {
    return this.seenEventIds.size;
  }

  /**
   * Ingests a single NormalizedSessionEvent.
   * Returns true if event was newly processed, false if it was deduplicated.
   * Automatically finalizes on session end or crash lifecycle events.
   */
  public ingest(event: NormalizedSessionEvent): boolean {
    if (this.finalized) {
      throw new TrajectoryAlreadyFinalizedError(
        `Cannot ingest event '${event.eventId}': trajectory '${this.context.trajectoryId}' has already been finalized`,
      );
    }
    if (this.boundSessionId === null) {
      this.boundSessionId = event.sessionId;
    } else if (event.sessionId !== this.boundSessionId) {
      throw new MixedTrajectoryIdentityError(
        `Mixed session identity in trajectory '${this.context.trajectoryId}': expected '${this.boundSessionId}', got '${event.sessionId}'`,
      );
    }

    if (this.seenEventIds.has(event.eventId)) {
      return false;
    }
    this.seenEventIds.add(event.eventId);

    if (event.timestamp) {
      this.lastObservedAt = event.timestamp;
    }

    // Process provider usage if present on the event
    const { modelRequestId, modelRequestPurpose } = readRequestLinkMetadata(event.metadata);
    if (event.providerUsage) {
      this.processProviderUsage(event.sessionId, event.providerUsage, modelRequestPurpose);
    }
    if (modelRequestId !== undefined) {
      this.linkedRequestIds.add(JSON.stringify([event.sessionId, modelRequestId]));
    }

    // Automatically finalize on session end or crash
    if (event.type === "session_lifecycle") {
      if (event.lifecycleType === "crash") {
        this.currentStatus = "failure";
        this.finalize();
        return true;
      }
      if (event.lifecycleType === "end") {
        if (event.exitReason === "error" || event.exitReason === "crash") {
          this.currentStatus = "failure";
        } else if (event.exitReason === "timeout") {
          this.currentStatus = "timeout";
        }
        this.finalize();
        return true;
      }
    }

    return true;
  }

  /**
   * Ingests an array of NormalizedSessionEvents.
   * Returns the count of newly ingested non-duplicate events.
   */
  public ingestBatch(events: NormalizedSessionEvent[]): number {
    let count = 0;
    for (const event of events) {
      if (this.finalized) {
        throw new TrajectoryAlreadyFinalizedError(
          `Cannot ingest event batch: trajectory '${this.context.trajectoryId}' has already been finalized`,
        );
      }
      if (this.ingest(event)) {
        count++;
      }
      if (this.finalized) {
        break;
      }
    }
    return count;
  }

  /**
   * Records provider usage from a single event. Request-scoped snapshots of one request replace each
   * other instead of summing; distinct requests stay separate even when their counts are equal.
   * A session's requests may use several providers, models and accounting versions (fallbacks,
   * judges, title and cache-warming calls), so request-scoped usage is never rejected for its
   * identity; the conversation's own requests name the session when the context does not. Legacy
   * and cumulative records cannot be told apart by request, so they must match the session.
   */
  private processProviderUsage(
    sessionId: string,
    usage: ProviderReportedUsage,
    purpose: string | undefined,
  ): void {
    const requestKey = providerUsageRequestKey(sessionId, usage);
    if (requestKey !== undefined && usage.requestId !== undefined) {
      if (purpose === undefined) {
        this.resolvedProvider ??= usage.provider;
        if (usage.model) this.resolvedModel ??= usage.model;
        this.resolvedAccountingVersion ??= usage.accountingVersion;
      } else {
        this.auxiliaryIdentity ??= usage;
      }
      const current = this.requestUsages.get(requestKey);
      this.requestUsages.set(requestKey, {
        usage: current === undefined ? usage : selectProviderUsageSnapshot(current.usage, usage),
        purpose: purpose ?? current?.purpose,
      });
      this.requestIdsWithUsage.add(JSON.stringify([sessionId, usage.requestId]));
      return;
    }

    // Validate identity consistency (reject mixed identities)
    if (usage.provider) {
      if (this.resolvedProvider === null) {
        this.resolvedProvider = usage.provider;
      } else if (this.resolvedProvider !== usage.provider) {
        throw new MixedTrajectoryIdentityError(
          `Mixed provider identity in trajectory '${this.context.trajectoryId}': expected '${this.resolvedProvider}', got '${usage.provider}'`,
        );
      }
    }

    if (usage.model) {
      if (this.resolvedModel === null) {
        this.resolvedModel = usage.model;
      } else if (this.resolvedModel !== usage.model) {
        throw new MixedTrajectoryIdentityError(
          `Mixed model identity in trajectory '${this.context.trajectoryId}': expected '${this.resolvedModel}', got '${usage.model}'`,
        );
      }
    }

    if (usage.accountingVersion) {
      if (this.resolvedAccountingVersion === null) {
        this.resolvedAccountingVersion = usage.accountingVersion;
      } else if (this.resolvedAccountingVersion !== usage.accountingVersion) {
        throw new MixedTrajectoryIdentityError(
          `Mixed accountingVersion identity in trajectory '${this.context.trajectoryId}': expected '${this.resolvedAccountingVersion}', got '${usage.accountingVersion}'`,
        );
      }
    }

    if (usage.usageScope === "cumulative") {
      const meterKey = JSON.stringify([usage.provider, sessionId]);
      const current = this.cumulativeUsages.get(meterKey);
      this.cumulativeUsages.set(
        meterKey,
        current === undefined ? usage : selectProviderUsageSnapshot(current, usage),
      );
    } else {
      this.legacyUsages.push(usage);
    }
  }

  /**
   * Computes the aggregated TrajectoryUsage without mutating state.
   *
   * Request semantics apply only when every usage record is request-scoped; see
   * {@link summarizeTrajectoryRequests}. Any legacy or cumulative record keeps the trajectory on
   * legacy semantics, whose output shape is unchanged.
   */
  public computeUsage(): TrajectoryUsage {
    const requestEntries = [...this.requestUsages.values()];
    const usages = [
      ...this.legacyUsages,
      ...this.cumulativeUsages.values(),
      ...requestEntries.map((entry) => entry.usage),
    ];
    if (usages.every((usage) => usage.availability === "unavailable")) {
      return TrajectoryUsageSchema.parse({
        availability: "unavailable",
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: null,
        costMicroUsd: null,
        durationMs: null,
      });
    }

    const requestsWithoutUsage = [...this.linkedRequestIds].filter(
      (id) => !this.requestIdsWithUsage.has(id),
    ).length;
    if (
      requestEntries.length > 0 &&
      this.legacyUsages.length === 0 &&
      this.cumulativeUsages.size === 0
    ) {
      return TrajectoryUsageSchema.parse(
        summarizeTrajectoryRequests(requestEntries, requestsWithoutUsage),
      );
    }

    const metrics = {
      inputTokens: { sum: 0, hasValue: false, missingInComplete: false },
      outputTokens: { sum: 0, hasValue: false, missingInComplete: false },
      reasoningTokens: { sum: 0, hasValue: false, missingInComplete: false },
      cachedInputTokens: { sum: 0, hasValue: false, missingInComplete: false },
      cacheWriteTokens: { sum: 0, hasValue: false, missingInComplete: false },
      totalTokens: { sum: 0, hasValue: false, missingInComplete: false },
      costMicroUsd: { sum: 0, hasValue: false, missingInComplete: false },
      durationMs: { sum: 0, hasValue: false, missingInComplete: false },
    };
    // Legacy aggregation keeps its original rule: only a complete record's missing total makes the
    // aggregate incomplete.
    const requiredInComplete: readonly (keyof typeof metrics)[] = ["totalTokens"];
    let hasPartialOrUnavailable = false;
    for (const usage of usages) {
      if (usage.availability !== "complete") hasPartialOrUnavailable = true;
      if (usage.availability === "unavailable") continue;
      for (const field of Object.keys(metrics) as (keyof typeof metrics)[]) {
        const value = usage[field];
        if (value !== undefined && value !== null) {
          metrics[field].hasValue = true;
          metrics[field].sum += value;
        } else if (usage.availability === "complete" && requiredInComplete.includes(field)) {
          metrics[field].missingInComplete = true;
        }
      }
    }

    const isPartial =
      hasPartialOrUnavailable ||
      requestsWithoutUsage > 0 ||
      !metrics.totalTokens.hasValue ||
      requiredInComplete.some((field) => metrics[field].missingInComplete);

    const availability: ProviderUsageAvailability = isPartial ? "partial" : "complete";
    const metricValue = (field: keyof typeof metrics): number | null =>
      metrics[field].hasValue ? metrics[field].sum : null;

    const usageObj: TrajectoryUsage = {
      availability,
      inputTokens: metricValue("inputTokens"),
      outputTokens: metricValue("outputTokens"),
      reasoningTokens: metricValue("reasoningTokens"),
      cachedInputTokens: metricValue("cachedInputTokens"),
      totalTokens: metricValue("totalTokens"),
      costMicroUsd: metricValue("costMicroUsd"),
      durationMs: metricValue("durationMs"),
    };
    if (metrics.cacheWriteTokens.hasValue) {
      usageObj.cacheWriteTokens = metrics.cacheWriteTokens.sum;
    }

    return TrajectoryUsageSchema.parse(usageObj);
  }

  /**
   * Finalizes trajectory observation exactly once and returns the canonical TrajectoryObservation.
   */
  public finalize(options?: {
    observedAt?: string;
    status?: TrajectoryStatus;
  }): TrajectoryObservation {
    if (this.finalized) {
      throw new TrajectoryAlreadyFinalizedError(
        `Trajectory '${this.context.trajectoryId}' has already been finalized`,
      );
    }

    if (options?.status) {
      this.currentStatus = options.status;
    }
    // A session whose only requests were auxiliary is named by the first of them.
    if (this.auxiliaryIdentity !== null) {
      this.resolvedProvider ??= this.auxiliaryIdentity.provider;
      if (this.auxiliaryIdentity.model) this.resolvedModel ??= this.auxiliaryIdentity.model;
      this.resolvedAccountingVersion ??= this.auxiliaryIdentity.accountingVersion;
    }
    if (!this.resolvedProvider || this.resolvedProvider.trim() === "") {
      throw new TrajectoryValidationError(
        `Cannot finalize trajectory '${this.context.trajectoryId}': provider identity was not established in context or events`,
      );
    }

    if (!this.resolvedModel || this.resolvedModel.trim() === "") {
      throw new TrajectoryValidationError(
        `Cannot finalize trajectory '${this.context.trajectoryId}': model identity was not established in context or events`,
      );
    }

    const observationId = this.context.observationId ?? `obs_${randomUUID()}`;
    const observedAt =
      options?.observedAt ??
      this.lastObservedAt ??
      this.context.observedAt ??
      new Date().toISOString();

    const usage = this.computeUsage();

    const canonicalPayload: JsonObject = {
      observationId,
      accountId: this.context.accountId,
      workspaceId: this.context.workspaceId,
      ownerUserId: this.context.ownerUserId,
      projectId: this.context.projectId,
      candidateId: this.context.candidateId,
      toolId: this.context.toolId,
      toolVersion: this.context.toolVersion,
      workloadId: this.context.workloadId,
      trajectoryId: this.context.trajectoryId,
      provider: this.resolvedProvider,
      model: this.resolvedModel,
      runtimeVersion: this.context.runtimeVersion,
      role: this.context.role,
      status: this.currentStatus,
      isEquivalent: this.context.isEquivalent,
      catalogExposureTokens: this.context.catalogExposureTokens,
      usage,
    };
    if (this.context.parentTrajectoryId !== undefined) {
      canonicalPayload.parentTrajectoryId = this.context.parentTrajectoryId;
    }
    if (this.resolvedAccountingVersion) {
      canonicalPayload.accountingVersion = this.resolvedAccountingVersion;
    }

    const metadata: JsonObject = {
      ...this.context.metadata,
    };
    if (this.resolvedAccountingVersion) {
      metadata.accountingVersion = this.resolvedAccountingVersion;
    }

    const digest = computeTrajectoryObservationDigest({ canonicalPayload });

    const observation: TrajectoryObservation = {
      observationId,
      accountId: this.context.accountId,
      workspaceId: this.context.workspaceId,
      ownerUserId: this.context.ownerUserId,
      projectId: this.context.projectId,
      candidateId: this.context.candidateId,
      toolId: this.context.toolId,
      toolVersion: this.context.toolVersion,
      workloadId: this.context.workloadId,
      trajectoryId: this.context.trajectoryId,
      parentTrajectoryId: this.context.parentTrajectoryId ?? null,
      provider: this.resolvedProvider,
      model: this.resolvedModel,
      runtimeVersion: this.context.runtimeVersion,
      role: this.context.role,
      status: this.currentStatus,
      isEquivalent: this.context.isEquivalent,
      catalogExposureTokens: this.context.catalogExposureTokens,
      usage,
      canonicalPayload,
      metadata,
      observedAt,
      digest,
    };
    const parsed = TrajectoryObservationSchema.parse(observation);
    this.finalized = true;
    this.finalizedObservation = parsed;
    return parsed;
  }
}

/**
 * Creates a new TrajectoryEmitter instance.
 */
export function createTrajectoryEmitter(
  contextInput: TrajectoryAttributionContextInput,
): TrajectoryEmitter {
  return new TrajectoryEmitter(contextInput);
}

/**
 * Helper to aggregate an array of normalized events and finalize into a TrajectoryObservation.
 */
export function aggregateTrajectoryEvents(
  events: NormalizedSessionEvent[],
  contextInput: TrajectoryAttributionContextInput,
): TrajectoryObservation {
  const emitter = new TrajectoryEmitter(contextInput);
  emitter.ingestBatch(events);
  if (emitter.isFinalized()) {
    const obs = emitter.getObservation();
    if (obs) {
      return obs;
    }
  }
  return emitter.finalize();
}
