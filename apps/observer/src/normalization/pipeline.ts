import { createHash } from "node:crypto";
import {
  type DeadLetterRecord,
  DeadLetterRecordSchema,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RedactionMeta,
  canonicalJson,
  hashCanonical,
  nowIso,
} from "@resin/contracts";
import type { LocalDatabaseConnection, SessionRepository, SyncRepository } from "@resin/db";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import {
  DecoderRegistry,
  type HarnessRecordDecoder,
  type IntermediateSessionEvent,
  type RecordDecoderContext,
  UniversalHarnessRecordDecoder,
} from "./decoder.js";
import {
  NormalizationDeduplicator,
  type NormalizationDeduplicatorOptions,
} from "./deduplicator.js";
import { type RedactionConfig, RedactionEngine } from "./redaction.js";

/**
 * Options for configuring NormalizationPipeline.
 */
export interface NormalizationPipelineOptions {
  decoderRegistry?: DecoderRegistry;
  redactionConfig?: RedactionConfig;
  deduplicator?: NormalizationDeduplicator;
  sessionRepository?: SessionRepository;
  syncRepository?: SyncRepository;
  dbConnection?: LocalDatabaseConnection;
  schemaVersion?: string;
}

/**
 * Context provided during pipeline processing.
 */
export interface PipelineProcessContext extends RecordDecoderContext {
  deviceId?: string;
  workspaceId?: string;
  customMetadata?: Record<string, unknown>;
  /**
   * Stage successful events without local deduplication/persistence until Cloud accepts them.
   */
  deferCommitUntilCloudAck?: boolean;
}

/**
 * Outcome of processing a raw harness record or intermediate event.
 */
export type PipelineProcessResult =
  | {
      status: "success";
      event: NormalizedSessionEvent;
      isDuplicate: boolean;
      revisionNumber?: number;
    }
  | {
      status: "dead_letter";
      errorReason: string;
      deadLetterRecord: DeadLetterRecord;
      rawRecord?: RawHarnessRecord;
    };

/**
 * Generates a deterministic, collision-resistant event ID from session ID, sequence, and content.
 */
export function generateDeterministicEventId(
  sessionId: string,
  causalSequence: number,
  content: unknown,
): string {
  const contentDigest = hashCanonical(content);
  const hash = createHash("sha256")
    .update(`${sessionId}:${causalSequence}:${contentDigest}`, "utf8")
    .digest("hex");
  return `evt_${hash.slice(0, 32)}`;
}

/**
 * Orchestrates transcript decoding, schema validation, privacy redaction,
 * deterministic ID generation, deduplication, and persistence.
 */
export class NormalizationPipeline {
  private readonly decoderRegistry: DecoderRegistry;
  private readonly redactionEngine: RedactionEngine;
  private readonly deduplicator: NormalizationDeduplicator;
  private readonly sessionRepository?: SessionRepository;
  private readonly syncRepository?: SyncRepository;
  private readonly dbConnection?: LocalDatabaseConnection;
  private readonly defaultSchemaVersion: string;

  // Session sequence to event ID map: sessionId -> Map<sequenceNumber, eventId>
  private readonly sessionEventsBySequence = new Map<string, Map<number, string>>();
  private readonly sessionState = new Map<string, { lastSequence: number }>();

  constructor(options: NormalizationPipelineOptions = {}) {
    this.decoderRegistry = options.decoderRegistry ?? new DecoderRegistry();
    this.redactionEngine = new RedactionEngine(options.redactionConfig);
    this.deduplicator =
      options.deduplicator ??
      new NormalizationDeduplicator({
        dbConnection: options.dbConnection,
      });
    this.sessionRepository = options.sessionRepository;
    this.syncRepository = options.syncRepository;
    this.dbConnection = options.dbConnection;
    this.defaultSchemaVersion = options.schemaVersion ?? "1.0.0";
  }

  /**
   * Registers a custom harness record decoder into the pipeline.
   */
  registerDecoder(decoder: HarnessRecordDecoder): void {
    this.decoderRegistry.register(decoder);
  }

  /**
   * Processes a single raw harness record through the complete normalization pipeline.
   */
  async processRecord(
    record: RawHarnessRecord,
    context?: PipelineProcessContext,
  ): Promise<PipelineProcessResult[]> {
    let intermediateEvents: IntermediateSessionEvent[];

    try {
      intermediateEvents = await this.decoderRegistry.decode(record, context);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const deadLetter = await this.createAndSaveDeadLetter(
        record.recordType || "unknown",
        record.rawPayload && typeof record.rawPayload === "object"
          ? (record.rawPayload as Record<string, unknown>)
          : { rawPayload: record.rawPayload },
        `Decoder failure: ${errorMsg}`,
      );

      return [
        {
          status: "dead_letter",
          errorReason: `Decoder failure: ${errorMsg}`,
          deadLetterRecord: deadLetter,
          rawRecord: record,
        },
      ];
    }

    if (!intermediateEvents || intermediateEvents.length === 0) {
      return [];
    }

    const results: PipelineProcessResult[] = [];
    for (const intermediate of intermediateEvents) {
      const result = await this.processIntermediateEvent(intermediate, context, record);
      results.push(result);
    }

    return results;
  }

  /**
   * Processes a batch of raw records sequentially.
   */
  async processBatch(
    records: RawHarnessRecord[],
    context?: PipelineProcessContext,
  ): Promise<PipelineProcessResult[]> {
    const results: PipelineProcessResult[] = [];
    for (const record of records) {
      const recordResults = await this.processRecord(record, context);
      results.push(...recordResults);
    }
    return results;
  }

  /**
   * Processes an intermediate session event through redaction, validation, ID generation, deduplication, and persistence.
   */
  async processIntermediateEvent(
    intermediate: IntermediateSessionEvent,
    context?: PipelineProcessContext,
    originalRawRecord?: RawHarnessRecord,
  ): Promise<PipelineProcessResult> {
    const sessionId = intermediate.sessionId || context?.sessionId;
    if (!sessionId) {
      const deadLetter = await this.createAndSaveDeadLetter(
        intermediate.type || "unknown",
        intermediate as unknown as Record<string, unknown>,
        "Missing required sessionId in intermediate event",
      );
      return {
        status: "dead_letter",
        errorReason: "Missing required sessionId in intermediate event",
        deadLetterRecord: deadLetter,
        rawRecord: originalRawRecord,
      };
    }

    // 1. Manage causal sequence and parent lineage
    let sessionMap = this.sessionEventsBySequence.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<number, string>();
      this.sessionEventsBySequence.set(sessionId, sessionMap);
    }
    const state = this.sessionState.get(sessionId) ?? { lastSequence: 0 };
    const explicitSeq = intermediate.causalRef?.causalSequence;
    const causalSequence =
      explicitSeq !== undefined && explicitSeq >= 0 ? explicitSeq : state.lastSequence + 1;

    const parentId =
      intermediate.causalRef?.parentId !== undefined
        ? intermediate.causalRef.parentId
        : causalSequence <= 1
          ? null
          : (sessionMap.get(causalSequence - 1) ?? null);
    // 2. Perform privacy redaction on the payload fields
    const {
      type,
      timestamp,
      schemaVersion,
      metadata,
      sessionId: _s,
      causalRef: _c,
      redaction: _r,
      eventId: _e,
      ...payloadFields
    } = intermediate as unknown as Record<string, unknown>;

    const redactionResult = this.redactionEngine.redact(payloadFields);
    const redactionMeta: RedactionMeta = {
      isRedacted: redactionResult.isRedacted,
      redactedFields: redactionResult.redactedFields,
      redactionStrategy: redactionResult.redactionStrategy,
      scrubbedPatterns: redactionResult.scrubbedPatterns,
      redactedAt: redactionResult.isRedacted ? nowIso() : undefined,
    };

    // 3. Construct deterministic event ID
    const eventBodyForHashing = {
      schemaVersion:
        (typeof schemaVersion === "string" ? schemaVersion : undefined) ??
        this.defaultSchemaVersion,
      sessionId,
      type: String(type),
      timestamp: (typeof timestamp === "string" ? timestamp : undefined) || nowIso(),
      causalRef: {
        parentId: parentId ?? null,
        causalSequence,
        turnIndex: intermediate.causalRef?.turnIndex,
        stepIndex: intermediate.causalRef?.stepIndex,
      },
      redaction: {
        isRedacted: redactionMeta.isRedacted,
        redactedFields: redactionMeta.redactedFields,
        redactionStrategy: redactionMeta.redactionStrategy,
        scrubbedPatterns: redactionMeta.scrubbedPatterns,
      },
      metadata:
        typeof metadata === "object" && metadata !== null
          ? (metadata as Record<string, unknown>)
          : {},
      ...(redactionResult.data as Record<string, unknown>),
    };

    const eventId = generateDeterministicEventId(sessionId, causalSequence, eventBodyForHashing);

    const fullEventCandidate = {
      eventId,
      ...eventBodyForHashing,
      redaction: redactionMeta,
    };

    // 4. Validate against NormalizedSessionEventSchema
    const validationResult = NormalizedSessionEventSchema.safeParse(fullEventCandidate);
    if (!validationResult.success) {
      const errorMsg = `Schema validation failed: ${validationResult.error.message}`;
      const deadLetter = await this.createAndSaveDeadLetter(
        String(type || "unknown"),
        fullEventCandidate as Record<string, unknown>,
        errorMsg,
      );
      return {
        status: "dead_letter",
        errorReason: errorMsg,
        deadLetterRecord: deadLetter,
        rawRecord: originalRawRecord,
      };
    }

    const validEvent = validationResult.data;

    // 5. Deduplication and Integrity Check
    const dedupOutcome = this.deduplicator.checkEvent(validEvent);

    if (dedupOutcome.status === "conflict") {
      const deadLetter = await this.createAndSaveDeadLetter(
        validEvent.type,
        validEvent as unknown as Record<string, unknown>,
        `Integrity conflict: ${dedupOutcome.errorReason}`,
      );
      return {
        status: "dead_letter",
        errorReason: dedupOutcome.errorReason,
        deadLetterRecord: deadLetter,
        rawRecord: originalRawRecord,
      };
    }

    if (dedupOutcome.status === "duplicate") {
      return {
        status: "success",
        event: validEvent,
        isDuplicate: true,
      };
    }

    // 6. Update session causal tracking state
    sessionMap.set(causalSequence, validEvent.eventId);
    this.sessionState.set(sessionId, {
      lastSequence: Math.max(state.lastSequence, causalSequence),
    });

    if (!context?.deferCommitUntilCloudAck) {
      await this.commitAcceptedEvent(validEvent, dedupOutcome.contentHash);
    }

    return {
      status: "success",
      event: validEvent,
      isDuplicate: false,
    };
  }

  /**
   * Commits events only after their Cloud batch has been accepted.
   */
  async commitCloudAcknowledgedEvents(events: readonly NormalizedSessionEvent[]): Promise<void> {
    for (const event of events) {
      const dedupOutcome = this.deduplicator.checkEvent(event);
      if (dedupOutcome.status === "conflict") {
        throw new Error(
          `Cannot commit conflicting normalized event ${event.eventId}: ${dedupOutcome.errorReason}`,
        );
      }
      if (dedupOutcome.status === "duplicate") {
        continue;
      }
      await this.commitAcceptedEvent(event, dedupOutcome.contentHash);
    }
  }

  private async commitAcceptedEvent(
    validEvent: NormalizedSessionEvent,
    contentHash: string,
  ): Promise<void> {
    this.deduplicator.recordEvent(validEvent, contentHash);

    if (this.sessionRepository) {
      try {
        await this.sessionRepository.insertEvent(validEvent);
      } catch {
        // The in-memory accepted-event index remains authoritative for this process.
      }
    } else if (this.dbConnection) {
      try {
        this.dbConnection.run(
          `INSERT OR IGNORE INTO normalized_events (
            event_id, session_id, sequence, type, timestamp, causal_parent_id, payload_json, redaction_meta_json, digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            validEvent.eventId,
            validEvent.sessionId,
            validEvent.causalRef.causalSequence,
            validEvent.type,
            validEvent.timestamp,
            validEvent.causalRef.parentId ?? null,
            canonicalJson(validEvent),
            validEvent.redaction ? canonicalJson(validEvent.redaction) : null,
            contentHash,
            validEvent.timestamp,
          ],
        );
      } catch {
        // The in-memory accepted-event index remains authoritative for this process.
      }
    }

    if (this.syncRepository) {
      try {
        await this.syncRepository.enqueueOutbox({
          outboxId: `normalized_event_${validEvent.eventId}`,
          topic: "normalized_event",
          payload: validEvent as unknown as Record<string, unknown>,
        });
      } catch {
        // Cloud acceptance must not be rolled back by secondary outbox persistence.
      }
    }
  }

  /**
   * Helper to construct and persist a DeadLetterRecord.
   */
  private async createAndSaveDeadLetter(
    originalEventType: string,
    payload: Record<string, unknown>,
    errorReason: string,
  ): Promise<DeadLetterRecord> {
    const deadLetterId = `dl_${createHash("sha256")
      .update(`${originalEventType}:${nowIso()}:${canonicalJson(payload)}`)
      .digest("hex")
      .slice(0, 24)}`;

    const deadLetter: DeadLetterRecord = {
      deadLetterId,
      originalEventType,
      payload,
      errorReason,
      failedAt: nowIso(),
      retryCount: 0,
      status: "pending",
    };

    if (this.syncRepository) {
      try {
        await this.syncRepository.saveDeadLetter(deadLetter);
      } catch {
        // Ignore
      }
    } else if (this.dbConnection) {
      try {
        this.dbConnection.run(
          `INSERT INTO dead_letters (
            dead_letter_id, original_event_type, payload_json, error_reason, failed_at, retry_count, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            deadLetter.deadLetterId,
            deadLetter.originalEventType,
            canonicalJson(deadLetter.payload),
            deadLetter.errorReason,
            deadLetter.failedAt,
            deadLetter.retryCount,
            deadLetter.status,
          ],
        );
      } catch {
        // Ignore
      }
    }

    return deadLetter;
  }
}
