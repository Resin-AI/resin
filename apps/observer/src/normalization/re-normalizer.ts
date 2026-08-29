import { createHash } from "node:crypto";
import {
  type DeadLetterRecord,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  canonicalJson,
  nowIso,
} from "@resin/contracts";
import type { LocalDatabaseConnection, SessionRepository } from "@resin/db";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import {
  DecoderRegistry,
  type HarnessRecordDecoder,
  type IntermediateSessionEvent,
} from "./decoder.js";
import {
  NormalizationPipeline,
  type PipelineProcessResult,
  generateDeterministicEventId,
} from "./pipeline.js";
import { type RedactionConfig, RedactionEngine } from "./redaction.js";

/**
 * Metadata attached to an event when it has been re-normalized under a new revision.
 */
export interface EventRevisionMeta {
  revisionNumber: number;
  revisionId: string;
  originalEventId?: string;
  decoderVersion: string;
  reNormalizedAt: string;
  reason?: string;
}

/**
 * Options for re-normalization execution.
 */
export interface ReNormalizeOptions {
  decoder?: HarnessRecordDecoder;
  decoderRegistry?: DecoderRegistry;
  redactionConfig?: RedactionConfig;
  revisionNumber?: number;
  revisionReason?: string;
  dryRun?: boolean;
  sessionRepository?: SessionRepository;
  dbConnection?: LocalDatabaseConnection;
  schemaVersion?: string;
}

/**
 * Detailed difference for an event between original and re-normalized versions.
 */
export interface ReNormalizationDiff {
  sequence: number;
  originalEventId?: string;
  newEventId: string;
  originalType?: string;
  newType: string;
  changedFields: string[];
  originalDigest?: string;
  newDigest: string;
  isRedactionChanged: boolean;
}

/**
 * Outcome of a re-normalization process.
 */
export interface ReNormalizationResult {
  sessionId: string;
  revisionNumber: number;
  revisionId: string;
  events: NormalizedSessionEvent[];
  deadLetters: DeadLetterRecord[];
  diffs: ReNormalizationDiff[];
  stats: {
    processedRecords: number;
    generatedEvents: number;
    deadLetterCount: number;
    changedEventCount: number;
  };
  dryRun: boolean;
  completedAt: string;
}

/**
 * Re-normalization engine for decoder and policy upgrades creating new revisions
 * without mutating historical evidence.
 */
export class ReNormalizer {
  private readonly decoderRegistry: DecoderRegistry;
  private readonly redactionConfig?: RedactionConfig;
  private readonly sessionRepository?: SessionRepository;
  private readonly dbConnection?: LocalDatabaseConnection;

  constructor(
    options: {
      decoderRegistry?: DecoderRegistry;
      redactionConfig?: RedactionConfig;
      sessionRepository?: SessionRepository;
      dbConnection?: LocalDatabaseConnection;
    } = {},
  ) {
    this.decoderRegistry = options.decoderRegistry ?? new DecoderRegistry();
    this.redactionConfig = options.redactionConfig;
    this.sessionRepository = options.sessionRepository;
    this.dbConnection = options.dbConnection;
  }

  /**
   * Re-normalizes a collection of raw harness records under a new revision.
   */
  async reNormalizeRecords(
    rawRecords: RawHarnessRecord[],
    options: ReNormalizeOptions = {},
  ): Promise<ReNormalizationResult> {
    if (!rawRecords || rawRecords.length === 0) {
      return {
        sessionId: "unknown",
        revisionNumber: options.revisionNumber ?? 2,
        revisionId: `rev_${Date.now()}`,
        events: [],
        deadLetters: [],
        diffs: [],
        stats: {
          processedRecords: 0,
          generatedEvents: 0,
          deadLetterCount: 0,
          changedEventCount: 0,
        },
        dryRun: Boolean(options.dryRun),
        completedAt: nowIso(),
      };
    }

    const sessionId = rawRecords[0].sessionId;
    const revisionNumber = options.revisionNumber ?? 2;
    const decoderRegistry = options.decoderRegistry ?? this.decoderRegistry;
    if (options.decoder) {
      decoderRegistry.register(options.decoder);
    }

    const redactionConfig = options.redactionConfig ?? this.redactionConfig;
    const dryRun = options.dryRun ?? false;
    const revisionTimestamp = nowIso();
    const revisionId = `rev_${createHash("sha256").update(`${sessionId}:rev_${revisionNumber}:${revisionTimestamp}`).digest("hex").slice(0, 24)}`;

    // Create an isolated pipeline for this re-normalization run
    const pipeline = new NormalizationPipeline({
      decoderRegistry,
      redactionConfig,
      schemaVersion: options.schemaVersion,
      // In dryRun mode, avoid persisting
      sessionRepository: dryRun ? undefined : (options.sessionRepository ?? this.sessionRepository),
      dbConnection: dryRun ? undefined : (options.dbConnection ?? this.dbConnection),
    });

    const generatedEvents: NormalizedSessionEvent[] = [];
    const deadLetters: DeadLetterRecord[] = [];
    const diffs: ReNormalizationDiff[] = [];

    // Fetch existing historical events for this session to compute diffs if DB available
    const existingEventsBySeq = new Map<number, NormalizedSessionEvent>();
    const dbConn = options.dbConnection ?? this.dbConnection;
    if (dbConn) {
      try {
        const rows = dbConn.all<{ sequence: number; payload_json: string }>(
          "SELECT sequence, payload_json FROM normalized_events WHERE session_id = ? ORDER BY sequence ASC;",
          [sessionId],
        );
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.payload_json);
            existingEventsBySeq.set(row.sequence, parsed);
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }

    // Sort raw records chronologically by sequence or timestamp
    const sortedRecords = [...rawRecords].sort(
      (a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0),
    );

    for (const record of sortedRecords) {
      const results: PipelineProcessResult[] = await pipeline.processRecord(record, {
        sessionId,
      });

      for (const res of results) {
        if (res.status === "dead_letter") {
          deadLetters.push(res.deadLetterRecord);
        } else if (res.status === "success") {
          // Attach revision metadata to the re-normalized event
          const decoder = decoderRegistry.findDecoder(record);
          const revisionMeta: EventRevisionMeta = {
            revisionNumber,
            revisionId,
            decoderVersion: decoder.decoderVersion,
            reNormalizedAt: revisionTimestamp,
            reason: options.revisionReason ?? "decoder_upgrade",
          };

          const eventWithRevision: NormalizedSessionEvent = {
            ...res.event,
            metadata: {
              ...(res.event.metadata ?? {}),
              revision: revisionMeta,
            },
          };

          generatedEvents.push(eventWithRevision);

          // Calculate diff against existing historical event
          const seq = eventWithRevision.causalRef.causalSequence;
          const original = existingEventsBySeq.get(seq);
          const newDigest = createHash("sha256")
            .update(canonicalJson(eventWithRevision), "utf8")
            .digest("hex");
          const originalDigest = original
            ? createHash("sha256").update(canonicalJson(original), "utf8").digest("hex")
            : undefined;

          const changedFields: string[] = [];
          let isRedactionChanged = false;

          if (original) {
            if (original.type !== eventWithRevision.type) {
              changedFields.push("type");
            }
            if (canonicalJson(original.redaction) !== canonicalJson(eventWithRevision.redaction)) {
              changedFields.push("redaction");
              isRedactionChanged = true;
            }
            if (original.eventId !== eventWithRevision.eventId) {
              changedFields.push("eventId");
            }
          } else {
            changedFields.push("new_event");
          }

          diffs.push({
            sequence: seq,
            originalEventId: original?.eventId,
            newEventId: eventWithRevision.eventId,
            originalType: original?.type,
            newType: eventWithRevision.type,
            changedFields,
            originalDigest,
            newDigest,
            isRedactionChanged,
          });
        }
      }
    }

    const changedCount = diffs.filter(
      (d) => d.changedFields.length > 0 && !d.changedFields.includes("new_event"),
    ).length;

    return {
      sessionId,
      revisionNumber,
      revisionId,
      events: generatedEvents,
      deadLetters,
      diffs,
      stats: {
        processedRecords: rawRecords.length,
        generatedEvents: generatedEvents.length,
        deadLetterCount: deadLetters.length,
        changedEventCount: changedCount,
      },
      dryRun,
      completedAt: nowIso(),
    };
  }

  /**
   * Dry-run preview of re-normalization.
   */
  async preview(
    rawRecords: RawHarnessRecord[],
    options: Omit<ReNormalizeOptions, "dryRun"> = {},
  ): Promise<ReNormalizationResult> {
    return this.reNormalizeRecords(rawRecords, {
      ...options,
      dryRun: true,
    });
  }
}
