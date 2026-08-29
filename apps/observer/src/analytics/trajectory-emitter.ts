import { randomUUID } from "node:crypto";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  type NormalizedSessionEvent,
  type ProviderReportedUsage,
  Sha256DigestSchema,
  hashCanonicalContent,
} from "@resin/contracts";
import { z } from "zod";
import {
  type ProviderUsageAvailability,
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

  private usageEventsCount = 0;
  private allUnavailable = true;
  private anyCompleteOrPartial = false;
  private hasPartialOrUnavailable = false;

  private readonly metrics = {
    inputTokens: { sum: 0, hasValue: false, missingInComplete: false },
    outputTokens: { sum: 0, hasValue: false, missingInComplete: false },
    reasoningTokens: { sum: 0, hasValue: false },
    cachedInputTokens: { sum: 0, hasValue: false },
    totalTokens: { sum: 0, hasValue: false, missingInComplete: false },
    costMicroUsd: { sum: 0, hasValue: false },
    durationMs: { sum: 0, hasValue: false },
  };

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

    if (this.seenEventIds.has(event.eventId)) {
      return false;
    }
    this.seenEventIds.add(event.eventId);

    if (event.timestamp) {
      this.lastObservedAt = event.timestamp;
    }

    // Process provider usage if present on the event
    if (event.providerUsage) {
      this.processProviderUsage(event.providerUsage);
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
   * Processes and aggregates provider usage from a single event.
   */
  private processProviderUsage(usage: ProviderReportedUsage): void {
    // 1. Validate identity consistency (reject mixed identities)
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

    // 2. Aggregate component metrics
    this.usageEventsCount++;
    if (usage.availability === "unavailable") {
      this.hasPartialOrUnavailable = true;
      return;
    }

    this.allUnavailable = false;
    this.anyCompleteOrPartial = true;
    if (usage.availability === "partial") {
      this.hasPartialOrUnavailable = true;
    }

    const aggregateComponent = (
      field:
        | "inputTokens"
        | "outputTokens"
        | "reasoningTokens"
        | "cachedInputTokens"
        | "totalTokens"
        | "costMicroUsd"
        | "durationMs",
    ) => {
      const val = usage[field];
      if (val !== undefined && val !== null) {
        this.metrics[field].hasValue = true;
        this.metrics[field].sum += val;
      } else if (
        usage.availability === "complete" &&
        (field === "totalTokens" || field === "inputTokens" || field === "outputTokens")
      ) {
        this.metrics[field].missingInComplete = true;
      }
    };

    aggregateComponent("inputTokens");
    aggregateComponent("outputTokens");
    aggregateComponent("reasoningTokens");
    aggregateComponent("cachedInputTokens");
    aggregateComponent("totalTokens");
    aggregateComponent("costMicroUsd");
    aggregateComponent("durationMs");
  }

  /**
   * Computes the aggregated TrajectoryUsage without mutating state.
   */
  public computeUsage(): TrajectoryUsage {
    if (this.usageEventsCount === 0 || this.allUnavailable) {
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

    const isPartial =
      this.hasPartialOrUnavailable ||
      !this.metrics.totalTokens.hasValue ||
      this.metrics.totalTokens.missingInComplete;

    const availability: ProviderUsageAvailability = isPartial ? "partial" : "complete";

    const usageObj: TrajectoryUsage = {
      availability,
      inputTokens: this.metrics.inputTokens.hasValue ? this.metrics.inputTokens.sum : null,
      outputTokens: this.metrics.outputTokens.hasValue ? this.metrics.outputTokens.sum : null,
      reasoningTokens: this.metrics.reasoningTokens.hasValue
        ? this.metrics.reasoningTokens.sum
        : null,
      cachedInputTokens: this.metrics.cachedInputTokens.hasValue
        ? this.metrics.cachedInputTokens.sum
        : null,
      totalTokens: this.metrics.totalTokens.hasValue ? this.metrics.totalTokens.sum : null,
      costMicroUsd: this.metrics.costMicroUsd.hasValue ? this.metrics.costMicroUsd.sum : null,
      durationMs: this.metrics.durationMs.hasValue ? this.metrics.durationMs.sum : null,
    };

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
