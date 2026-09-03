import { createHash } from "node:crypto";
import { type NormalizedSessionEvent, NormalizedSessionEventSchema } from "@resin/contracts";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { ExponentialBackoff } from "@resin/protocol";
import { z } from "zod";
import { AuthRecoveryError, ResourceForbiddenError } from "../auth-recovery.js";
import type { CloudObservationClient } from "../cloud-runtime.js";
import type { Logger } from "../lifecycle.js";
import {
  NormalizationPipeline,
  type PipelineProcessContext,
  type PipelineProcessResult,
  generateDeterministicEventId,
} from "../normalization/pipeline.js";
import type { JsonObject, JsonValue } from "../normalization/redaction.js";
import type { TelemetryAggregator } from "../observability/telemetry-aggregator.js";
import type { TailerRecordHandler } from "../tailing/tailer.js";
import { projectEventToMetadataOnly } from "./metadata-projection.js";
import {
  TrajectoryAlreadyFinalizedError,
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

function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return undefined;
}

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
  /**
   * Bounded coalescing dwell window in milliseconds for generic observation sessions.
   * Defaults to 2000 (2 seconds). Set to 0 to disable coalescing.
   */
  coalesceDwellMs?: number;
  /**
   * Maximum batch size (number of observations) before an immediate flush occurs.
   * Defaults to 100.
   */
  maxBatchSize?: number;
  /**
   * Optional local telemetry aggregator for recording batch metrics.
   */
  telemetry?: TelemetryAggregator;
}

interface GenericCoalescingBuffer {
  sessionId: string;
  session: HarnessSession;
  validEvents: NormalizedSessionEvent[];
  rawRecords: RawHarnessRecord[];
  acks: Array<() => Promise<void>>;
  timer: NodeJS.Timeout | null;
  telemetryRecordTimestampMs: number[];
  latestTail?: { eventId: string; causalSequence: number };
  isTerminal: boolean;
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
  private readonly genericSessionTails = new Map<
    string,
    { eventId: string; causalSequence: number }
  >();
  private readonly coalesceDwellMs: number;
  private readonly maxBatchSize: number;
  private readonly telemetry?: TelemetryAggregator;
  private readonly genericCoalescingBuffers = new Map<string, GenericCoalescingBuffer>();
  private readonly sessionBackoffs = new Map<string, ExponentialBackoff>();

  private readonly genericResourceForbiddenRetries = new Map<string, number>();
  private readonly trajectoryResourceForbiddenRetries = new Map<string, number>();
  private totalGenericBatchesUploaded = 0;
  private totalGenericObservationsUploaded = 0;
  private lastGenericBatchSize = 0;
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
      this.coalesceDwellMs = 2000;
      this.maxBatchSize = 100;
      this.telemetry = undefined;
    } else {
      this.pipeline = pipelineOrOptions.pipeline;
      this.observationClient =
        pipelineOrOptions.observationClient ?? pipelineOrOptions.cloudClient!;
      this.attributionResolver = pipelineOrOptions.attributionResolver;
      this.logger = pipelineOrOptions.logger;
      this.isTelemetryEnabledFn = pipelineOrOptions.isTelemetryEnabled;
      this.minimumRecordTimestampMs =
        z.number().safeParse(pipelineOrOptions.minimumRecordTimestampMs).data ?? 0;
      this.coalesceDwellMs =
        pipelineOrOptions.coalesceDwellMs !== undefined
          ? Math.max(0, pipelineOrOptions.coalesceDwellMs)
          : 2000;
      this.maxBatchSize = Math.max(1, pipelineOrOptions.maxBatchSize ?? 100);
      this.telemetry = pipelineOrOptions.telemetry;
    }

    this.authorizeTelemetryEmissionFn = !(pipelineOrOptions instanceof NormalizationPipeline)
      ? pipelineOrOptions.authorizeTelemetryEmission
      : undefined;
  }
  private getSessionBackoff(sessionId: string): ExponentialBackoff {
    let backoff = this.sessionBackoffs.get(sessionId);
    if (!backoff) {
      backoff = new ExponentialBackoff({
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        factor: 2,
        jitter: 0.2,
      });
      this.sessionBackoffs.set(sessionId, backoff);
    }
    return backoff;
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

  private acknowledgeBufferedAcks(acks: ReadonlyArray<() => Promise<void>>): void {
    void (async () => {
      for (const ack of acks) {
        await ack();
      }
    })().catch((err: unknown) => {
      this.logger?.error("Failed to acknowledge locally discarded observation records", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    for (const buf of this.genericCoalescingBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      this.acknowledgeBufferedAcks(buf.acks);
    }
    this.genericCoalescingBuffers.clear();
    this.activeSessions.clear();
    this.activeGenericSessions.clear();
    this.genericSessions.clear();
    this.genericSessionTails.clear();
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
      for (const buf of this.genericCoalescingBuffers.values()) {
        if (buf.timer) clearTimeout(buf.timer);
        this.acknowledgeBufferedAcks(buf.acks);
      }
      this.genericCoalescingBuffers.clear();
      this.activeSessions.clear();
      this.activeGenericSessions.clear();
      this.genericSessions.clear();
      this.genericSessionTails.clear();
    }
  }

  private async acknowledgeWithoutTelemetry(
    sessionId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    const buffer = this.genericCoalescingBuffers.get(sessionId);
    if (buffer) {
      if (buffer.timer) clearTimeout(buffer.timer);
      this.genericCoalescingBuffers.delete(sessionId);
      for (const bufferedAck of buffer.acks) {
        await bufferedAck();
      }
    }
    this.activeSessions.delete(sessionId);
    this.activeGenericSessions.delete(sessionId);
    this.genericSessionTails.delete(sessionId);
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

      if (this.activeSessions.has(sessionId)) {
        emitter = this.activeSessions.get(sessionId)!;
      } else if (!this.activeGenericSessions.has(sessionId)) {
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
              this.genericSessions.add(sessionId);
              this.activeGenericSessions.add(sessionId);
            }
          } else {
            this.logger?.info(
              `Session ${sessionId} has invalid attribution context; falling back to generic observation submission`,
              { errors: parsedContext.error.issues.map((issue) => issue.message) },
            );
            this.genericSessions.add(sessionId);
            this.activeGenericSessions.add(sessionId);
          }
        } else {
          this.logger?.info(
            `Session ${sessionId} has no trajectory attribution; processing as generic observation session`,
          );
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
            this.trajectoryResourceForbiddenRetries.delete(sessionId);
          } catch (err) {
            if (err instanceof ResourceForbiddenError) {
              const retries = (this.trajectoryResourceForbiddenRetries.get(sessionId) ?? 0) + 1;
              this.trajectoryResourceForbiddenRetries.set(sessionId, retries);
              const workspaceId = err.workspaceId ?? "unknown";

              if (retries < 3) {
                this.logger?.warn(
                  `Resource forbidden for workspace ${workspaceId} on trajectory session ${sessionId} (attempt ${retries}/3); will retry`,
                  {
                    sessionId,
                    workspaceId,
                    retries,
                    error: err.message,
                  },
                );
                throw err;
              }

              this.logger?.warn(
                `Resource forbidden for workspace ${workspaceId} on trajectory session ${sessionId}: max retries exceeded, dead-lettering batch`,
                {
                  sessionId,
                  workspaceId,
                  retries,
                  error: err.message,
                },
              );

              try {
                await this.pipeline.createAndSaveDeadLetter(
                  "trajectory_observation_batch",
                  { observations: [observation], workspaceId },
                  `Resource forbidden for workspace ${workspaceId}: ${err.message}`,
                );
              } catch (dlErr) {
                this.logger?.error(
                  `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
                );
              }

              this.trajectoryResourceForbiddenRetries.delete(sessionId);
              this.finalizedSessions.add(sessionId);
              this.activeSessions.delete(sessionId);
              await ack();
              return;
            }

            const status = extractHttpStatus(err);
            const isTerminal4xx =
              typeof status === "number" &&
              status >= 400 &&
              status < 500 &&
              status !== 401 &&
              status !== 403 &&
              status !== 408 &&
              status !== 429;

            if (isTerminal4xx) {
              this.logger?.error(
                `Terminal failure submitting trajectory observation batch for session ${sessionId} with HTTP ${status}: dead-lettering batch`,
                {
                  sessionId,
                  status,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              try {
                await this.pipeline.createAndSaveDeadLetter(
                  "trajectory_observation_batch",
                  { observations: [observation] },
                  `Trajectory observation batch failed with HTTP ${status}: ${err instanceof Error ? err.message : String(err)}`,
                );
              } catch (dlErr) {
                this.logger?.error(
                  `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
                );
              }

              this.finalizedSessions.add(sessionId);
              this.activeSessions.delete(sessionId);
              await ack();
              return;
            }

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
        let hasExplicitTerminal = false;
        let latestTail = this.genericSessionTails.get(sessionId);

        const existingBuffer = this.genericCoalescingBuffers.get(sessionId);
        if (existingBuffer?.latestTail) {
          if (
            !latestTail ||
            existingBuffer.latestTail.causalSequence >= latestTail.causalSequence
          ) {
            latestTail = existingBuffer.latestTail;
          }
        }

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
            if (res.status === "dead_letter") {
              continue;
            }
            if (res.status === "success" && res.event) {
              const ev = res.event;
              if (
                ev.type === "session_lifecycle" &&
                (ev.lifecycleType === "end" || ev.lifecycleType === "crash")
              ) {
                hasExplicitTerminal = true;
              }
              const seq = ev.causalRef?.causalSequence ?? 0;
              if (!latestTail || seq >= latestTail.causalSequence) {
                latestTail = { eventId: ev.eventId, causalSequence: seq };
              }
              if (!res.isDuplicate) {
                validEvents.push(ev);
              }
            }
          }
        }

        if (!this.isTelemetryAllowed(telemetryGeneration)) {
          await this.acknowledgeWithoutTelemetry(sessionId, ack);
          return;
        }

        const isTerminalStatus =
          session.status === "completed" ||
          session.status === "failed" ||
          session.status === "interrupted";

        if (isTerminalStatus && !hasExplicitTerminal && latestTail) {
          const syntheticEvent = this.createSyntheticTerminalEvent(session, latestTail);
          validEvents.push(syntheticEvent);
          latestTail = {
            eventId: syntheticEvent.eventId,
            causalSequence: syntheticEvent.causalRef.causalSequence,
          };
        }

        const isTerminal =
          isTerminalStatus ||
          hasExplicitTerminal ||
          validEvents.some(
            (e) =>
              e.type === "session_lifecycle" &&
              (e.lifecycleType === "end" || e.lifecycleType === "crash"),
          );

        if (validEvents.length === 0 && !existingBuffer) {
          if (!this.isTelemetryAllowed(telemetryGeneration)) {
            await this.acknowledgeWithoutTelemetry(sessionId, ack);
            return;
          }
          if (isTerminal) {
            this.finalizedSessions.add(sessionId);
            this.activeGenericSessions.delete(sessionId);
            this.genericSessionTails.delete(sessionId);
          }
          await ack();
          return;
        }

        let buffer = existingBuffer;
        if (!buffer) {
          buffer = {
            sessionId,
            session,
            validEvents: [],
            rawRecords: [],
            acks: [],
            timer: null,
            telemetryRecordTimestampMs: [],
            latestTail,
            isTerminal: false,
          };
          this.genericCoalescingBuffers.set(sessionId, buffer);
        }

        buffer.session = session;
        buffer.validEvents.push(...validEvents);
        buffer.rawRecords.push(...records);
        buffer.acks.push(ack);
        buffer.telemetryRecordTimestampMs.push(...telemetryRecordTimestampMs);
        if (latestTail) {
          buffer.latestTail = latestTail;
        }
        if (isTerminal) {
          buffer.isTerminal = true;
        }

        const isTurn = this.isTurnBoundary(session, records, validEvents, hasExplicitTerminal);
        const reachedMaxSize =
          buffer.validEvents.length >= this.maxBatchSize || buffer.acks.length >= this.maxBatchSize;
        const shouldFlushImmediately =
          this.coalesceDwellMs === 0 || buffer.isTerminal || reachedMaxSize || isTurn;

        if (shouldFlushImmediately) {
          try {
            await this.flushGenericSession(sessionId);
          } catch (err) {
            if (err instanceof AuthRecoveryError) {
              throw err;
            }
            if (this.coalesceDwellMs === 0) {
              throw err;
            }
            const nextDelay = Math.min(60_000, this.getSessionBackoff(sessionId).nextDelay());
            this.scheduleGenericFlush(sessionId, buffer, nextDelay);
          }
        } else {
          this.scheduleGenericFlush(sessionId, buffer);
        }
      }
    });
  };

  private isTurnBoundary(
    session: HarnessSession,
    records: RawHarnessRecord[],
    events: NormalizedSessionEvent[],
    hasExplicitTerminal: boolean,
  ): boolean {
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "interrupted" ||
      hasExplicitTerminal
    ) {
      return true;
    }

    for (const record of records) {
      if (record.recordType === "completion") {
        return true;
      }
      const rawPayload = record.rawPayload;
      if (rawPayload && typeof rawPayload === "object") {
        const payloadObj = rawPayload as Record<string, unknown>;
        if (payloadObj.type === "completion") {
          return true;
        }
        if (payloadObj.role === "assistant") {
          return true;
        }
      }
    }

    for (const ev of events) {
      if (
        ev.type === "session_lifecycle" &&
        (ev.lifecycleType === "end" || ev.lifecycleType === "crash")
      ) {
        return true;
      }
      if (ev.type === "message" && ev.role === "assistant") {
        return true;
      }
    }

    return false;
  }

  private scheduleGenericFlush(
    sessionId: string,
    buffer: GenericCoalescingBuffer,
    delayMs?: number,
  ): void {
    if (buffer.timer || this.coalesceDwellMs === 0) {
      return;
    }
    const delay = delayMs ?? this.coalesceDwellMs;
    buffer.timer = setTimeout(() => {
      void this.runSessionTask(sessionId, async () => {
        try {
          await this.flushGenericSession(sessionId);
        } catch (err) {
          this.logger?.error(`Deferred flush failed for generic session ${sessionId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          const retryBuffer = this.genericCoalescingBuffers.get(sessionId);
          if (retryBuffer) {
            const nextDelay = Math.min(60_000, this.getSessionBackoff(sessionId).nextDelay());
            this.scheduleGenericFlush(sessionId, retryBuffer, nextDelay);
          }
        }
      });
    }, delay);
  }

  private async flushGenericSession(sessionId: string): Promise<void> {
    const buffer = this.genericCoalescingBuffers.get(sessionId);
    if (!buffer) {
      return;
    }
    clearTimeout(buffer.timer!);
    buffer.timer = null;
    this.genericCoalescingBuffers.delete(sessionId);

    const { validEvents, acks, telemetryRecordTimestampMs } = buffer;

    if (validEvents.length === 0) {
      for (const ack of acks) {
        await ack();
      }
      return;
    }

    const telemetryGeneration = this.telemetryGeneration;
    if (!this.isTelemetryAllowed(telemetryGeneration)) {
      this.genericSessionTails.delete(sessionId);
      this.activeGenericSessions.delete(sessionId);
      this.genericSessions.delete(sessionId);
      for (const ack of acks) {
        await ack();
      }
      return;
    }

    if (!(await this.isTelemetryAuthorized(telemetryGeneration, telemetryRecordTimestampMs))) {
      this.genericSessionTails.delete(sessionId);
      this.activeGenericSessions.delete(sessionId);
      this.genericSessions.delete(sessionId);
      for (const ack of acks) {
        await ack();
      }
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
      this.sessionBackoffs.delete(sessionId);
      this.genericResourceForbiddenRetries.delete(sessionId);
    } catch (err) {
      if (err instanceof ResourceForbiddenError) {
        const retries = (this.genericResourceForbiddenRetries.get(sessionId) ?? 0) + 1;
        this.genericResourceForbiddenRetries.set(sessionId, retries);
        const workspaceId = err.workspaceId ?? "unknown";

        if (retries < 3) {
          this.logger?.warn(
            `Resource forbidden for workspace ${workspaceId} on session ${sessionId} (attempt ${retries}/3); will retry`,
            {
              sessionId,
              workspaceId,
              batchId,
              retries,
              error: err.message,
            },
          );
          this.genericCoalescingBuffers.set(sessionId, buffer);
          throw err;
        }

        this.logger?.warn(
          `Resource forbidden for workspace ${workspaceId} on session ${sessionId}: max retries exceeded, dead-lettering observation batch`,
          {
            sessionId,
            workspaceId,
            batchId,
            retries,
            error: err.message,
          },
        );

        try {
          await this.pipeline.createAndSaveDeadLetter(
            "observation_batch",
            { batchId, workspaceId, observations: projectedEvents },
            `Resource forbidden for workspace ${workspaceId}: ${err.message}`,
          );
        } catch (dlErr) {
          this.logger?.error(
            `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
          );
        }

        this.genericResourceForbiddenRetries.delete(sessionId);
        this.sessionBackoffs.delete(sessionId);
        this.recordBatchTelemetry(projectedEvents.length);

        if (buffer.latestTail) {
          this.genericSessionTails.set(sessionId, buffer.latestTail);
        }

        if (buffer.isTerminal) {
          this.finalizedSessions.add(sessionId);
          this.activeGenericSessions.delete(sessionId);
          this.genericSessionTails.delete(sessionId);
        }

        for (const ack of acks) {
          await ack();
        }

        return;
      }
      const status = extractHttpStatus(err);
      const isTerminal4xx =
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 401 &&
        status !== 403 &&
        status !== 408 &&
        status !== 429;

      if (isTerminal4xx) {
        this.logger?.error(
          `Terminal failure submitting observation batch for generic session ${sessionId} with HTTP ${status}: dead-lettering batch`,
          {
            sessionId,
            status,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        try {
          await this.pipeline.createAndSaveDeadLetter(
            "observation_batch",
            { batchId, observations: projectedEvents },
            `Observation batch failed with HTTP ${status}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch (dlErr) {
          this.logger?.error(
            `Failed to save dead letter for session ${sessionId}: ${String(dlErr)}`,
          );
        }

        this.sessionBackoffs.delete(sessionId);

        this.recordBatchTelemetry(projectedEvents.length);

        if (buffer.latestTail) {
          this.genericSessionTails.set(sessionId, buffer.latestTail);
        }

        if (buffer.isTerminal) {
          this.finalizedSessions.add(sessionId);
          this.activeGenericSessions.delete(sessionId);
          this.genericSessionTails.delete(sessionId);
        }

        for (const ack of acks) {
          await ack();
        }

        return;
      }

      this.logger?.error(`Failed to submit observation batch for generic session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!(err instanceof AuthRecoveryError)) {
        this.genericCoalescingBuffers.set(sessionId, buffer);
      }
      throw err;
    }

    this.recordBatchTelemetry(projectedEvents.length);

    if (buffer.latestTail) {
      this.genericSessionTails.set(sessionId, buffer.latestTail);
    }

    if (buffer.isTerminal) {
      this.finalizedSessions.add(sessionId);
      this.activeGenericSessions.delete(sessionId);
      this.genericSessionTails.delete(sessionId);
    }

    for (const ack of acks) {
      await ack();
    }
  }

  private async flushAllGenericBuffers(): Promise<void> {
    const sessionIds = Array.from(this.genericCoalescingBuffers.keys());
    for (const sessionId of sessionIds) {
      await this.runSessionTask(sessionId, async () => {
        await this.flushGenericSession(sessionId);
      });
    }
  }

  /**
   * Flushes any in-flight coalesced generic observation buffers immediately.
   */
  public async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.runSessionTask(sessionId, async () => {
        await this.flushGenericSession(sessionId);
      });
    } else {
      await this.flushAllGenericBuffers();
    }
  }

  private recordBatchTelemetry(batchSize: number): void {
    this.totalGenericBatchesUploaded++;
    this.totalGenericObservationsUploaded += batchSize;
    this.lastGenericBatchSize = batchSize;

    if (this.telemetry) {
      this.telemetry.incrementCounter("observer.batches.generic.uploaded", 1);
      this.telemetry.incrementCounter("observer.batches.generic.observations_uploaded", batchSize);
      this.telemetry.setGauge("observer.batches.generic.last_size", batchSize);
    }
  }

  /**
   * Returns current generic batching telemetry metrics.
   */
  public getBatchMetrics(): {
    totalBatchesUploaded: number;
    totalObservationsUploaded: number;
    lastBatchSize: number;
  } {
    return {
      totalBatchesUploaded: this.totalGenericBatchesUploaded,
      totalObservationsUploaded: this.totalGenericObservationsUploaded,
      lastBatchSize: this.lastGenericBatchSize,
    };
  }

  /**
   * Waits for every session handler already admitted through the tailer boundary to settle,
   * flushing any pending generic coalescing buffers.
   */
  public async waitForIdle(): Promise<void> {
    await Promise.all(Array.from(this.sessionLocks.values()));
    await this.flushAllGenericBuffers();
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
  private createSyntheticTerminalEvent(
    session: HarnessSession,
    tail: { eventId: string; causalSequence: number },
  ): NormalizedSessionEvent {
    const causalSequence = tail.causalSequence + 1;
    const parentId = tail.eventId;

    const lifecycleType: "end" | "crash" = session.status === "failed" ? "crash" : "end";
    const exitReason =
      session.status === "completed"
        ? "completed"
        : session.status === "failed"
          ? "failed"
          : "interrupted";

    const timestamp = session.updatedAt;

    const payloadForHash = {
      schemaVersion: "1.0.0",
      sessionId: session.sessionId,
      type: "session_lifecycle" as const,
      lifecycleType,
      exitReason,
      timestamp,
      causalRef: {
        parentId,
        causalSequence,
      },
      redaction: {
        isRedacted: true,
        redactedFields: [],
        redactionStrategy: "drop" as const,
        scrubbedPatterns: [],
        redactedAt: timestamp,
      },
      metadata: {},
      ...(typeof session.harnessId === "string" && session.harnessId.length > 0
        ? { harnessName: session.harnessId }
        : {}),
      ...(typeof session.workspaceId === "string" && session.workspaceId.length > 0
        ? { workspaceId: session.workspaceId }
        : {}),
    };

    const eventId = generateDeterministicEventId(session.sessionId, causalSequence, payloadForHash);

    const event: NormalizedSessionEvent = {
      ...payloadForHash,
      eventId,
    };

    return NormalizedSessionEventSchema.parse(event);
  }
}
