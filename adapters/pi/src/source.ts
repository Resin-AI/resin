import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import type {
  HarnessSession,
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import { type PiSessionHeader, readPiSessionHeader } from "./discovery.js";
import { PI_HARNESS_ID } from "./paths.js";

/** Metadata the source attaches to every record so decoding needs no cross-record state. */
export interface PiRecordMetadata {
  transcriptPath: string;
  lineNumber: number;
  byteOffset: number;
  /** Header `version` of the file (1–3); entries are decoded as their version's format. */
  piSessionVersion: number;
  /** Id of the entry appended just before this one; a different `parentId` is a tree branch. */
  piPreviousEntryId: string | null;
}

export interface PiEventSourceOptions {
  pollIntervalMs?: number;
  maxBatchSize?: number;
}

const BACKSCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Synthesized id of a v1 (pre-tree) entry. Pi's own v1→v2 migration assigns random ids; line
 * numbers keep the ids stable across re-reads and resumes.
 */
export function piV1EntryId(lineNumber: number): string {
  return `v1-${lineNumber}`;
}

/** Reads the last complete line that ends at `endOffset` (exclusive), scanning backwards. */
async function readLineEndingAt(filePath: string, endOffset: number): Promise<string | null> {
  if (endOffset <= 0) return null;
  const handle = await fsp.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    // Skip the newline terminating the line itself.
    let position = endOffset - 1;
    while (position > 0) {
      const start = Math.max(0, position - BACKSCAN_CHUNK_BYTES);
      const buffer = Buffer.alloc(position - start);
      await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline !== -1) {
        chunks.unshift(buffer.subarray(newline + 1));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.unshift(buffer);
      position = start;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function entryIdOf(entry: Record<string, unknown>): string | null {
  return typeof entry.id === "string" ? entry.id : null;
}

function recordTypeOf(entry: Record<string, unknown>): RecordType {
  if (entry.type === "session") return "system";
  if (entry.type !== "message") return "custom";
  const message = entry.message;
  const role =
    message && typeof message === "object" && "role" in message ? message.role : undefined;
  if (role === "user") return "prompt";
  if (role === "assistant") return "completion";
  if (role === "toolResult") return "tool_result";
  if (role === "system") return "system";
  return "transcript_line";
}

/**
 * Tails one append-only Pi session file. The cursor's byte offset marks the end of the last
 * emitted complete line; a trailing partial line is left for the next read. Fork files start
 * with a verbatim copy of the parent branch (same ids, earlier timestamps); those entries were
 * recorded in the parent's transcript, so they only advance the cursor here.
 */
export class PiSessionEventSource implements SessionEventSource {
  readonly session: HarnessSession;
  private cursor: SourceCursor;
  private readonly listeners = new Set<RecordListener>();
  private readonly pollIntervalMs: number;
  private readonly maxBatchSize: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastInode: number | null = null;
  private header: PiSessionHeader | null = null;
  private previousEntryId: string | null | undefined;

  constructor(session: HarnessSession, cursor?: SourceCursor, options: PiEventSourceOptions = {}) {
    this.session = session;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxBatchSize = options.maxBatchSize ?? 200;
    this.cursor = cursor
      ? { ...cursor }
      : { offset: 0, line: 1, sequence: 0, timestamp: new Date().toISOString() };
  }

  getCursor(): SourceCursor {
    return { ...this.cursor };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
    this.previousEntryId = undefined;
  }

  private reset(): void {
    this.cursor = { offset: 0, line: 1, sequence: 0, timestamp: new Date().toISOString() };
    this.header = null;
    this.previousEntryId = undefined;
  }

  /** Recovers the id of the entry just before the cursor after a resume. */
  private async recoverPreviousEntryId(filePath: string): Promise<string | null> {
    if (this.cursor.offset === 0 || this.cursor.line <= 2) return null;
    if ((this.header?.version ?? 1) < 2) return piV1EntryId(this.cursor.line - 1);
    const line = await readLineEndingAt(filePath, this.cursor.offset);
    if (!line) return null;
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string"
        ? parsed.id
        : null;
    } catch {
      return null;
    }
  }

  async readNext(batchSize?: number): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];
    const filePath = this.session.transcriptPath;
    let stat: Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return [];
    }
    if (
      stat.size < this.cursor.offset ||
      (this.lastInode !== null && stat.ino !== this.lastInode)
    ) {
      this.reset();
    }
    this.lastInode = stat.ino;
    if (stat.size <= this.cursor.offset) return [];

    this.header ??= await readPiSessionHeader(filePath);
    if (this.previousEntryId === undefined) {
      this.previousEntryId = await this.recoverPreviousEntryId(filePath);
    }
    const version = this.header?.version ?? 1;
    const forkedAt = this.header?.parentSession ? Date.parse(this.header.timestamp) : Number.NaN;

    const length = stat.size - this.cursor.offset;
    const buffer = Buffer.alloc(length);
    const handle = await fsp.open(filePath, "r");
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, this.cursor.offset));
    } finally {
      await handle.close();
    }

    const limit = batchSize ?? this.maxBatchSize;
    const records: RawHarnessRecord[] = [];
    let lineStart = 0;
    while (records.length < limit) {
      const newline = buffer.indexOf(0x0a, lineStart);
      if (newline === -1 || newline >= bytesRead) break;
      const text = buffer.toString("utf8", lineStart, newline).trim();
      const lineNumber = this.cursor.line;
      this.cursor.offset += newline + 1 - lineStart;
      this.cursor.line += 1;
      this.cursor.timestamp = new Date().toISOString();
      lineStart = newline + 1;
      if (!text) continue;

      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        entry = { ...parsed };
      } catch {
        continue;
      }
      if (entry.type !== "session" && version < 2) {
        entry.id = piV1EntryId(lineNumber);
        entry.parentId = lineNumber > 2 ? piV1EntryId(lineNumber - 1) : null;
      }
      const previousEntryId = this.previousEntryId ?? null;
      if (entry.type !== "session") this.previousEntryId = entryIdOf(entry);

      const entryTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (entry.type !== "session" && entryTime < forkedAt) continue;

      this.cursor.sequence += 1;
      const metadata: PiRecordMetadata = {
        transcriptPath: filePath,
        lineNumber,
        byteOffset: this.cursor.offset,
        piSessionVersion: version,
        piPreviousEntryId: previousEntryId,
      };
      records.push({
        recordId: `${this.session.sessionId}-l${lineNumber}`,
        sessionId: this.session.sessionId,
        harnessId: PI_HARNESS_ID,
        sequenceNumber: this.cursor.sequence,
        timestamp: Number.isFinite(entryTime)
          ? new Date(entryTime).toISOString()
          : new Date().toISOString(),
        recordType: recordTypeOf(entry),
        rawPayload: entry,
        cursor: { ...this.cursor },
        metadata: { ...metadata },
      });
    }
    return records;
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    if (!this.pollTimer && !this.closed) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    }
    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private async poll(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    let records: RawHarnessRecord[];
    try {
      records = await this.readNext();
    } catch {
      return;
    }
    if (records.length === 0) return;
    for (const listener of [...this.listeners]) {
      try {
        await listener(records);
      } catch {
        // a failing listener does not stop tailing
      }
    }
  }

  async detectRotation(): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.session.transcriptPath);
      const rotated =
        (this.lastInode !== null && stat.ino !== this.lastInode) || stat.size < this.cursor.offset;
      this.lastInode = stat.ino;
      return rotated;
    } catch {
      return false;
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPolling();
    this.listeners.clear();
  }
}
