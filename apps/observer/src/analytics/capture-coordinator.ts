import { createHash } from "node:crypto";
import type { NormalizedSessionEvent } from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { z } from "zod";
import type { CloudObservationClient, TrajectoryObservation } from "../cloud-runtime.js";
import type { Logger } from "../lifecycle.js";
import {
  NormalizationPipeline,
  type PipelineProcessContext,
  type PipelineProcessResult,
} from "../normalization/pipeline.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { TailerRecordHandler } from "../tailing/tailer.js";
import { projectEventToMetadataOnly } from "./metadata-projection.js";
import {
  TrajectoryAlreadyFinalizedError,
  type TrajectoryAttributionContext,
  type TrajectoryAttributionContextInput,
  TrajectoryAttributionContextSchema,
  type TrajectoryEmitter,
  createTrajectoryEmitter,
} from "./trajectory-emitter.js";

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

/**
 * Function signature for resolving trajectory attribution context from a harness session.
 */
export type TrajectoryAttributionResolverFn = (
  session: HarnessSession,
) =>
  | Promise<TrajectoryAttributionContextInput | null | undefined>
  | TrajectoryAttributionContextInput
  | null
  | undefined;

/**
 * Object interface for resolving trajectory attribution context.
 */
export interface TrajectoryAttributionResolverObject {
  resolveAttribution: TrajectoryAttributionResolverFn;
}

/**
 * Async resolver for trajectory attribution context, accepting either a function or an object.
 */
export type TrajectoryAttributionResolver =
  | TrajectoryAttributionResolverFn
  | TrajectoryAttributionResolverObject;

export interface PrivacyCutoffRecordsResult {
  records: RawHarnessRecord[];
  timestampMs: number[];
}

/**
 * Options for configuring TrajectoryCaptureCoordinator.
 */
export interface TrajectoryCaptureCoordinatorOptions {
  pipeline: NormalizationPipeline;
  observationClient?: CloudObservationClient;
  cloudClient?: CloudObservationClient;
  attributionResolver?: TrajectoryAttributionResolver;
  logger?: Logger;
  /**
   * Dynamic transmission gate. Any value other than an explicit `true` fails closed.
   */
  isTelemetryEnabled?: () => boolean;
  /**
   * Authoritative account-level consent check performed before processing and immediately before
   * every outbound request. The record timestamps describe the payload being authorized. Any
   * value other than an explicit `true` fails closed.
   */
  authorizeTelemetryEmission?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;
  /**
   * Records at or before this privacy cutoff are acknowledged locally without normalization or
   * transmission.
   */
  minimumRecordTimestampMs?: number;
}

/**
 * Coordinates raw record ingestion through normalization, per-session trajectory aggregation,
 * attribution resolution, and privacy-safe cloud observation submission.
 */
export class TrajectoryCaptureCoordinator {
  private readonly pipeline: NormalizationPipeline;
  private readonly observationClient: CloudObservationClient;
  private readonly attributionResolver?: TrajectoryAttributionResolver;
  private readonly logger?: Logger;
  private readonly isTelemetryEnabledFn?: () => boolean;
  private readonly authorizeTelemetryEmissionFn?: (
    recordTimestampMs: readonly number[],
  ) => Promise<boolean | null | undefined>;
  private minimumRecordTimestampMs: number;
  private telemetryEnabled = true;
  private telemetryGeneration = 0;

  private readonly activeSessions = new Map<string, TrajectoryEmitter>();
  private readonly activeGenericSessions = new Set<string>();
  private readonly finalizedSessions = new Set<string>();
  private readonly genericSessions = new Set<string>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(options: TrajectoryCaptureCoordinatorOptions);
  constructor(
    pipeline: NormalizationPipeline,
    observationClient: CloudObservationClient,
    attributionResolver?: TrajectoryAttributionResolver,
    options?: { logger?: Logger },
  );
  constructor(
    pipelineOrOptions: NormalizationPipeline | TrajectoryCaptureCoordinatorOptions,
    observationClient?: CloudObservationClient,
    attributionResolver?: TrajectoryAttributionResolver,
    options?: { logger?: Logger },
  ) {
    if (pipelineOrOptions instanceof NormalizationPipeline) {
      this.pipeline = pipelineOrOptions;
      this.observationClient = observationClient!;
      this.attributionResolver = attributionResolver;
      this.logger = options?.logger;
      this.isTelemetryEnabledFn = undefined;
      this.minimumRecordTimestampMs = 0;
    } else {
      this.pipeline = pipelineOrOptions.pipeline;
      this.observationClient =
        pipelineOrOptions.observationClient ?? pipelineOrOptions.cloudClient!;
      this.attributionResolver = pipelineOrOptions.attributionResolver;
      this.logger = pipelineOrOptions.logger;
      this.isTelemetryEnabledFn = pipelineOrOptions.isTelemetryEnabled;
      this.minimumRecordTimestampMs =
        z.number().safeParse(pipelineOrOptions.minimumRecordTimestampMs).data ?? 0;
    }

    this.authorizeTelemetryEmissionFn = !(pipelineOrOptions instanceof NormalizationPipeline)
      ? pipelineOrOptions.authorizeTelemetryEmission
      : undefined;
  }

  private isTelemetryAllowed(generation = this.telemetryGeneration): boolean {
    if (!this.telemetryEnabled || generation !== this.telemetryGeneration) {
      return false;
    }
    if (!this.isTelemetryEnabledFn) {
      return true;
    }
    try {
      return this.isTelemetryEnabledFn() === true;
    } catch {
      return false;
    }
  }

  private async isTelemetryAuthorized(
    generation = this.telemetryGeneration,
    recordTimestampMs: readonly number[] = [],
  ): Promise<boolean> {
    if (!this.isTelemetryAllowed(generation)) {
      return false;
    }
    if (!this.authorizeTelemetryEmissionFn) {
      return true;
    }
    try {
      const authorized = (await this.authorizeTelemetryEmissionFn(recordTimestampMs)) === true;
      return authorized && this.isTelemetryAllowed(generation);
    } catch {
      return false;
    }
  }

  private recordsAfterPrivacyCutoff(records: RawHarnessRecord[]): PrivacyCutoffRecordsResult {
    if (this.minimumRecordTimestampMs <= 0 && !this.authorizeTelemetryEmissionFn) {
      return { records, timestampMs: [] };
    }

    const authorizedRecords: RawHarnessRecord[] = [];
    const timestampMs: number[] = [];
    for (const record of records) {
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= this.minimumRecordTimestampMs) {
        continue;
      }
      authorizedRecords.push(record);
      timestampMs.push(timestamp);
    }
    return { records: authorizedRecords, timestampMs };
  }

  /**
   * Advances the privacy cutoff monotonically and invalidates work that began before it.
   */
  public setPrivacyCutoff(cutoffMs: number): void {
    const normalizedCutoff = Number.isFinite(cutoffMs)
      ? Math.max(0, Math.trunc(cutoffMs))
      : Number.MAX_SAFE_INTEGER;
    if (normalizedCutoff <= this.minimumRecordTimestampMs) {
      return;
    }
    this.minimumRecordTimestampMs = normalizedCutoff;
    this.telemetryGeneration += 1;
    this.activeSessions.clear();
    this.activeGenericSessions.clear();
    this.genericSessions.clear();
  }

  /**
   * Changes the local transmission gate synchronously so in-flight record handlers observe
   * consent withdrawal before they can reach an outbound client call.
   */
  public setTelemetryEnabled(enabled: boolean): void {
    const nextEnabled = enabled === true;
    if (nextEnabled === this.telemetryEnabled) {
      return;
    }
    this.telemetryEnabled = nextEnabled;
    this.telemetryGeneration += 1;
    if (!nextEnabled) {
      this.activeSessions.clear();
      this.activeGenericSessions.clear();
      this.genericSessions.clear();
    }
  }

  private async acknowledgeWithoutTelemetry(
    sessionId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeGenericSessions.delete(sessionId);
    this.genericSessions.delete(sessionId);
    await ack();
  }

  /**
   * Per-session serial lock to ensure records within the same session are processed in order
   * while allowing concurrent sessions to execute in parallel without cross-session blocking.
   */
  private async runSessionTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const { promise: current, resolve: release } = Promise.withResolvers<void>();
    this.sessionLocks.set(sessionId, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Record handler callback compatible with ObserverCoordinator.onRecords and TailerRecordHandler.
   */
  public readonly handleRecords: TailerRecordHandler = async (
    session: HarnessSession,
    records: RawHarnessRecord[],
    ack: () => Promise<void>,
  ): Promise<void> => {
    const { sessionId } = session;
    const telemetryGeneration = this.telemetryGeneration;
    const { records: telemetryRecords, timestampMs: telemetryRecordTimestampMs } =
      this.recordsAfterPrivacyCutoff(records);

    await this.runSessionTask(sessionId, async () => {
      if (
        !this.isTelemetryAllowed(telemetryGeneration) ||
        (records.length > 0 && telemetryRecords.length === 0)
      ) {
        await this.acknowledgeWithoutTelemetry(sessionId, ack);
        return;
      }
      if (
        telemetryRecords.length > 0 &&
        !(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))
      ) {
        await this.acknowledgeWithoutTelemetry(sessionId, ack);
        return;
      }

      // 1. If this session was already finalized and submitted, acknowledge repeated records without re-submitting
      if (this.finalizedSessions.has(sessionId)) {
        await ack();
        return;
      }

      // 2. Classify session as Attributed or Generic
      let emitter: TrajectoryEmitter | undefined;
      let isGeneric = false;

      if (this.activeSessions.has(sessionId)) {
        emitter = this.activeSessions.get(sessionId)!;
      } else if (this.activeGenericSessions.has(sessionId)) {
        isGeneric = true;
      } else {
        // Resolve attribution once per session if not yet classified
        let rawContext: TrajectoryAttributionContextInput | null | undefined;
        try {
          if (this.attributionResolver instanceof Function) {
            rawContext = await this.attributionResolver(session);
          } else if (this.attributionResolver && "resolveAttribution" in this.attributionResolver) {
            rawContext = await this.attributionResolver.resolveAttribution(session);
          } else {
            rawContext = null;
          }
        } catch (err) {
          this.logger?.error(`Failed to resolve attribution for session ${sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          // Resolution error -> do NOT ack, let error throw so tailer retries
          throw err;
        }

        if (rawContext) {
          const parsedContext = TrajectoryAttributionContextSchema.safeParse(rawContext);
          if (parsedContext.success) {
            try {
              emitter = createTrajectoryEmitter(parsedContext.data);
              this.activeSessions.set(sessionId, emitter);
            } catch (err) {
              this.logger?.warn(
                `Failed to construct TrajectoryEmitter for session ${sessionId}; falling back to generic observation submission`,
                { error: err instanceof Error ? err.message : String(err) },
              );
              isGeneric = true;
              this.genericSessions.add(sessionId);
              this.activeGenericSessions.add(sessionId);
            }
          } else {
            this.logger?.info(
              `Session ${sessionId} has invalid attribution context; falling back to generic observation submission`,
              { errors: parsedContext.error.issues.map((issue) => issue.message) },
            );
            isGeneric = true;
            this.genericSessions.add(sessionId);
            this.activeGenericSessions.add(sessionId);
          }
        } else {
          this.logger?.info(
            `Session ${sessionId} has no trajectory attribution; processing as generic observation session`,
          );
          isGeneric = true;
          this.genericSessions.add(sessionId);
          this.activeGenericSessions.add(sessionId);
        }
      }

      // 3. Process records through NormalizationPipeline
      if (emitter) {
        // ATTRIBUTED SESSION PATH
        if (telemetryRecords.length > 0) {
          const customMetadata = JsonObjectSchema.safeParse(session.metadata).data;
          const pipelineContext: PipelineProcessContext = {
            sessionId: session.sessionId,
            harnessId: session.harnessId,
            workspaceId: session.workspaceId,
            customMetadata,
          };

          let pipelineResults: PipelineProcessResult[];
          try {
            pipelineResults = await this.pipeline.processBatch(telemetryRecords, pipelineContext);
          } catch (err) {
            this.logger?.error(`Normalization pipeline failed for session ${sessionId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }

          for (const res of pipelineResults) {
            if (res.status === "dead_letter" || (res.status === "success" && res.isDuplicate)) {
              continue;
            }
            if (res.event) {
              try {
                emitter.ingest(res.event);
              } catch (err) {
                if (err instanceof TrajectoryAlreadyFinalizedError) {
                  break;
                }
                throw err;
              }
            }
          }
        }

        // Check if session has reached a terminal state
        if (!emitter.isFinalized()) {
          if (session.status === "completed") {
            emitter.finalize({ status: "success" });
          } else if (session.status === "failed") {
            emitter.finalize({ status: "failure" });
          } else if (session.status === "interrupted") {
            emitter.finalize({ status: "timeout" });
          }
        }

        // If finalized, submit trajectory to Cloud
        if (emitter.isFinalized()) {
          if (
            !(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))
          ) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }
          const observation = emitter.getObservation() ?? emitter.finalize();
          try {
            await this.observationClient.sendTrajectoryObservationBatch({
              observations: [observation],
            });
          } catch (err) {
            this.logger?.error(
              `Failed to submit trajectory observation batch for session ${sessionId}`,
              { error: err instanceof Error ? err.message : String(err) },
            );
            throw err;
          }

          this.finalizedSessions.add(sessionId);
          this.activeSessions.delete(sessionId);
        }

        if (!this.isTelemetryAllowed(telemetryGeneration)) {
          await this.acknowledgeWithoutTelemetry(sessionId, ack);
          return;
        }

        await ack();
      } else {
        // GENERIC SESSION PATH
        const validEvents: NormalizedSessionEvent[] = [];

        if (telemetryRecords.length > 0) {
          const customMetadata = JsonObjectSchema.safeParse(session.metadata).data;
          const pipelineContext: PipelineProcessContext = {
            sessionId: session.sessionId,
            harnessId: session.harnessId,
            workspaceId: session.workspaceId,
            customMetadata,
            deferCommitUntilCloudAck: true,
          };

          let pipelineResults: PipelineProcessResult[];
          try {
            pipelineResults = await this.pipeline.processBatch(telemetryRecords, pipelineContext);
          } catch (err) {
            this.logger?.error(`Normalization pipeline failed for generic session ${sessionId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }

          for (const res of pipelineResults) {
            if (res.status === "dead_letter" || (res.status === "success" && res.isDuplicate)) {
              continue;
            }
            if (res.event) {
              validEvents.push(res.event);
            }
          }
        }

        if (validEvents.length > 0) {
          if (
            !(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))
          ) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }
          const projectedEvents = validEvents.map((ev) => projectEventToMetadataOnly(ev));
          const firstSeq = projectedEvents[0]?.causalRef.causalSequence ?? 0;
          const batchDigest = createHash("sha256")
            .update(projectedEvents.map((event) => event.eventId).join("\0"))
            .digest("hex")
            .slice(0, 16);
          const sessionKey = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
          const batchId = `obs_${batchDigest}_${sessionKey}_${firstSeq}`.slice(0, 128);
          try {
            await this.observationClient.sendObservationBatch({
              batchId,
              observations: projectedEvents,
            });
            await this.pipeline.commitCloudAcknowledgedEvents(validEvents);
          } catch (err) {
            this.logger?.error(
              `Failed to submit observation batch for generic session ${sessionId}`,
              { error: err instanceof Error ? err.message : String(err) },
            );
            throw err;
          }
        }
        if (!this.isTelemetryAllowed(telemetryGeneration)) {
          await this.acknowledgeWithoutTelemetry(sessionId, ack);
          return;
        }

        const isTerminal =
          session.status === "completed" ||
          session.status === "failed" ||
          session.status === "interrupted" ||
          validEvents.some(
            (e) =>
              e.type === "session_lifecycle" &&
              (e.lifecycleType === "end" || e.lifecycleType === "crash"),
          );

        if (isTerminal) {
          this.finalizedSessions.add(sessionId);
          this.activeGenericSessions.delete(sessionId);
        }

        await ack();
      }
    });
  };

  /**
   * Waits for every session handler already admitted through the tailer boundary to settle.
   */
  public async waitForIdle(): Promise<void> {
    await Promise.all(Array.from(this.sessionLocks.values()));
  }

  /**
   * Returns the count of currently active sessions being tracked.
   */
  public getActiveSessionCount(): number {
    return this.activeSessions.size + this.activeGenericSessions.size;
  }

  /**
   * Returns the count of finalized and submitted sessions.
   */
  public getFinalizedSessionCount(): number {
    return this.finalizedSessions.size;
  }

  /**
   * Returns the count of unattributed discarded sessions.
   */
  public getUnattributedSessionCount(): number {
    return 0;
  }

  /**
   * Returns the count of generic (non-attributed) sessions processed.
   */
  public getGenericSessionCount(): number {
    return this.genericSessions.size;
  }

  /**
   * Whether a session is currently active and accumulating events.
   */
  public hasActiveSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) || this.activeGenericSessions.has(sessionId);
  }

  /**
   * Whether a session has been finalized and submitted.
   */
  public isSessionFinalized(sessionId: string): boolean {
    return this.finalizedSessions.has(sessionId);
  }

  /**
   * Whether a session has no trajectory attribution (processed as generic observations).
   */
  public isSessionUnattributed(sessionId: string): boolean {
    return this.genericSessions.has(sessionId);
  }

  /**
   * Retrieves the active emitter for a session if currently in-flight.
   */
  public getActiveEmitter(sessionId: string): TrajectoryEmitter | undefined {
    return this.activeSessions.get(sessionId);
  }
}
