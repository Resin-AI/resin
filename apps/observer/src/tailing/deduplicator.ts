import { createHash } from "node:crypto";
import { canonicalJson } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";

/**
 * Options for configuring RecordDeduplicator.
 */
export interface DeduplicatorOptions {
  /**
   * Maximum number of record entries to maintain in the LRU deduplication cache.
   * Defaults to 10,000.
   */
  maxCacheSize?: number;
}

/**
 * Deduplication statistics.
 */
export interface DeduplicatorStats {
  seenCount: number;
  duplicateCount: number;
  cacheSize: number;
}

/**
 * Content-hash, record-ID, and offset-based deduplicator preventing double-emission
 * of raw harness records on restarts, seeking, or overlapping read intervals.
 */
export class RecordDeduplicator {
  private readonly maxCacheSize: number;
  private readonly seenRecordIds = new Set<string>();
  private readonly seenPayloadHashes = new Set<string>();
  private readonly seenSessionOffsets = new Set<string>();
  private readonly lruOrder: string[] = [];

  private seenCount = 0;
  private duplicateCount = 0;

  constructor(options: DeduplicatorOptions = {}) {
    this.maxCacheSize = options.maxCacheSize ?? 10_000;
  }

  /**
   * Computes a deterministic SHA-256 content digest for a raw record's payload.
   */
  computePayloadHash(record: RawHarnessRecord): string {
    const raw =
      typeof record.rawPayload === "string" ? record.rawPayload : canonicalJson(record.rawPayload);
    return createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Computes composite key for offset and sequence within a session.
   */
  private computeOffsetKey(record: RawHarnessRecord): string {
    const offset = record.cursor.offset;
    const seq = record.sequenceNumber ?? record.cursor.sequence;
    return `${record.sessionId}:${offset}:${seq}`;
  }

  /**
   * Checks if a record has already been seen without recording it.
   */
  isDuplicate(record: RawHarnessRecord): boolean {
    if (record.recordId && this.seenRecordIds.has(record.recordId)) {
      return true;
    }

    const offsetKey = this.computeOffsetKey(record);
    if (this.seenSessionOffsets.has(offsetKey)) {
      return true;
    }

    const payloadHash = this.computePayloadHash(record);
    const sessionPayloadKey = `${record.sessionId}:${payloadHash}`;
    if (this.seenPayloadHashes.has(sessionPayloadKey)) {
      return true;
    }

    return false;
  }

  /**
   * Evaluates if a record is new. If new, records it in the deduplication cache and returns true.
   * If duplicate, increments duplicate counter and returns false.
   */
  record(record: RawHarnessRecord): boolean {
    this.seenCount++;

    if (this.isDuplicate(record)) {
      this.duplicateCount++;
      return false;
    }

    const payloadHash = this.computePayloadHash(record);
    const sessionPayloadKey = `${record.sessionId}:${payloadHash}`;
    const offsetKey = this.computeOffsetKey(record);

    if (record.recordId) {
      this.seenRecordIds.add(record.recordId);
      this.pushLru(`id:${record.recordId}`);
    }

    this.seenSessionOffsets.add(offsetKey);
    this.pushLru(`offset:${offsetKey}`);

    this.seenPayloadHashes.add(sessionPayloadKey);
    this.pushLru(`hash:${sessionPayloadKey}`);

    this.pruneCache();
    return true;
  }

  /**
   * Filters an array of raw records, returning only those that are not duplicates.
   */
  filterNew(records: RawHarnessRecord[]): RawHarnessRecord[] {
    const newRecords: RawHarnessRecord[] = [];
    for (const record of records) {
      if (this.record(record)) {
        newRecords.push(record);
      }
    }
    return newRecords;
  }

  /**
   * Adds an entry to the LRU tracking queue.
   */
  private pushLru(key: string): void {
    this.lruOrder.push(key);
  }

  /**
   * Prunes oldest entries when cache exceeds capacity.
   */
  private pruneCache(): void {
    while (this.lruOrder.length > this.maxCacheSize * 3) {
      const oldest = this.lruOrder.shift();
      if (!oldest) break;

      if (oldest.startsWith("id:")) {
        this.seenRecordIds.delete(oldest.slice(3));
      } else if (oldest.startsWith("offset:")) {
        this.seenSessionOffsets.delete(oldest.slice(7));
      } else if (oldest.startsWith("hash:")) {
        this.seenPayloadHashes.delete(oldest.slice(5));
      }
    }
  }

  /**
   * Clears the deduplication cache.
   */
  clear(): void {
    this.seenRecordIds.clear();
    this.seenPayloadHashes.clear();
    this.seenSessionOffsets.clear();
    this.lruOrder.length = 0;
  }

  /**
   * Returns current deduplication metrics.
   */
  getStats(): DeduplicatorStats {
    return {
      seenCount: this.seenCount,
      duplicateCount: this.duplicateCount,
      cacheSize:
        this.seenRecordIds.size + this.seenPayloadHashes.size + this.seenSessionOffsets.size,
    };
  }
}
