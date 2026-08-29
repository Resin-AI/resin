import { canonicalJson, hashCanonical } from "@resin/contracts";
import type { NormalizedSessionEvent } from "@resin/contracts";
import type { LocalDatabaseConnection } from "@resin/db";

/**
 * Deduplication check outcome.
 */
export type DeduplicationResult =
  | {
      status: "new";
      eventId: string;
      contentHash: string;
    }
  | {
      status: "duplicate";
      eventId: string;
      contentHash: string;
    }
  | {
      status: "conflict";
      eventId: string;
      existingHash: string;
      incomingHash: string;
      errorReason: string;
    };

/**
 * Options for configuring NormalizationDeduplicator.
 */
export interface NormalizationDeduplicatorOptions {
  /** Maximum number of event digests to cache in memory (default: 10,000) */
  maxCacheSize?: number;
  /** Optional SQLite connection to check against historical persisted events */
  dbConnection?: LocalDatabaseConnection;
}

/**
 * Cached entry for an observed normalized event.
 */
interface CachedEventEntry {
  eventId: string;
  sessionId: string;
  sequence: number;
  contentHash: string;
  timestamp: number;
}

/**
 * Normalization deduplicator that enforces idempotency and detects content conflicts.
 */
export class NormalizationDeduplicator {
  private readonly maxCacheSize: number;
  private readonly dbConnection?: LocalDatabaseConnection;

  // Primary lookup: eventId -> CachedEventEntry
  private readonly eventIdCache = new Map<string, CachedEventEntry>();
  // Secondary lookup: `${sessionId}:${sequence}` -> eventId
  private readonly sessionSequenceMap = new Map<string, string>();

  // Statistics
  private stats = {
    seenCount: 0,
    newCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
  };

  constructor(options: NormalizationDeduplicatorOptions = {}) {
    this.maxCacheSize = options.maxCacheSize ?? 10000;
    this.dbConnection = options.dbConnection;
  }

  /**
   * Computes deterministic canonical content digest for a normalized event.
   */
  computeContentHash(event: NormalizedSessionEvent): string {
    // Hash the event content excluding eventId and variable redaction timestamp
    const { eventId: _ignored, redaction, ...rest } = event;
    const stableRedaction = redaction
      ? {
          isRedacted: redaction.isRedacted,
          redactedFields: [...(redaction.redactedFields ?? [])].sort(),
          redactionStrategy: redaction.redactionStrategy,
          scrubbedPatterns: [...(redaction.scrubbedPatterns ?? [])].sort(),
        }
      : undefined;

    return hashCanonical({
      ...rest,
      redaction: stableRedaction,
    });
  }

  /**
   * Checks if an event is new, an idempotent duplicate, or a conflicting mutation.
   */
  checkEvent(event: NormalizedSessionEvent): DeduplicationResult {
    this.stats.seenCount++;
    const eventId = event.eventId;
    const sessionId = event.sessionId;
    const sequence = event.causalRef?.causalSequence ?? 0;
    const incomingHash = this.computeContentHash(event);
    const sessionSeqKey = `${sessionId}:${sequence}`;

    // 1. Check in-memory cache by eventId
    const cachedByEventId = this.eventIdCache.get(eventId);
    if (cachedByEventId) {
      if (cachedByEventId.contentHash === incomingHash) {
        this.stats.duplicateCount++;
        return {
          status: "duplicate",
          eventId,
          contentHash: incomingHash,
        };
      }
      this.stats.conflictCount++;
      return {
        status: "conflict",
        eventId,
        existingHash: cachedByEventId.contentHash,
        incomingHash,
        errorReason: `Conflicting content detected for eventId ${eventId}: existing digest ${cachedByEventId.contentHash} vs incoming ${incomingHash}`,
      };
    }

    // 2. Check in-memory cache by session:sequence
    const cachedEventIdForSeq = this.sessionSequenceMap.get(sessionSeqKey);
    if (cachedEventIdForSeq && cachedEventIdForSeq !== eventId) {
      const entry = this.eventIdCache.get(cachedEventIdForSeq);
      this.stats.conflictCount++;
      return {
        status: "conflict",
        eventId,
        existingHash: entry?.contentHash ?? cachedEventIdForSeq,
        incomingHash,
        errorReason: `Integrity conflict: sequence collision in session ${sessionId} at sequence ${sequence}: existing event ${cachedEventIdForSeq} vs incoming ${eventId}`,
      };
    }

    // 3. If DB connection is available, check persistent database
    if (this.dbConnection) {
      try {
        const existingRow = this.dbConnection.get<{
          event_id: string;
          payload_json: string;
          sequence: number;
        }>(
          "SELECT event_id, payload_json, sequence FROM normalized_events WHERE event_id = ? OR (session_id = ? AND sequence = ?);",
          [eventId, sessionId, sequence],
        );

        if (existingRow) {
          let existingEvent: NormalizedSessionEvent | null = null;
          try {
            existingEvent = JSON.parse(existingRow.payload_json);
          } catch {
            // Unparseable payload in DB
          }

          const existingDigest = existingEvent
            ? this.computeContentHash(existingEvent)
            : "unknown_db_digest";

          if (existingRow.event_id === eventId && existingDigest === incomingHash) {
            // Cache it
            this.recordEvent(event, incomingHash);
            this.stats.duplicateCount++;
            return {
              status: "duplicate",
              eventId,
              contentHash: incomingHash,
            };
          }

          this.stats.conflictCount++;
          return {
            status: "conflict",
            eventId,
            existingHash: existingDigest,
            incomingHash,
            errorReason: `Integrity conflict against persisted DB event ${existingRow.event_id} in session ${sessionId} sequence ${sequence}`,
          };
        }
      } catch {
        // If DB query fails, proceed with in-memory result
      }
    }

    this.stats.newCount++;
    return {
      status: "new",
      eventId,
      contentHash: incomingHash,
    };
  }

  /**
   * Records a validated new event into the deduplicator cache.
   */
  recordEvent(event: NormalizedSessionEvent, precomputedHash?: string): void {
    const eventId = event.eventId;
    const sessionId = event.sessionId;
    const sequence = event.causalRef?.causalSequence ?? 0;
    const contentHash = precomputedHash ?? this.computeContentHash(event);
    const sessionSeqKey = `${sessionId}:${sequence}`;

    // Evict oldest entries if capacity reached
    if (this.eventIdCache.size >= this.maxCacheSize) {
      const oldestKey = this.eventIdCache.keys().next().value;
      if (oldestKey) {
        const oldEntry = this.eventIdCache.get(oldestKey);
        if (oldEntry) {
          this.sessionSequenceMap.delete(`${oldEntry.sessionId}:${oldEntry.sequence}`);
        }
        this.eventIdCache.delete(oldestKey);
      }
    }

    const entry: CachedEventEntry = {
      eventId,
      sessionId,
      sequence,
      contentHash,
      timestamp: Date.now(),
    };

    this.eventIdCache.set(eventId, entry);
    this.sessionSequenceMap.set(sessionSeqKey, eventId);
  }

  /**
   * Returns current deduplicator statistics.
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.eventIdCache.size,
    };
  }

  /**
   * Clears the in-memory cache and resets statistics.
   */
  clear(): void {
    this.eventIdCache.clear();
    this.sessionSequenceMap.clear();
    this.stats = {
      seenCount: 0,
      newCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
    };
  }
}
