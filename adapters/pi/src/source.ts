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
import { type PiSessionHeader, parsePiSessionHeader } from "./discovery.js";
import { PI_HARNESS_ID } from "./paths.js";

/** The call a tool result answers, as the source saw it earlier in the same file. */
export interface PiRecordedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** When the assistant entry requesting the call was written (ISO). */
  startedAt: string;
}

/** Metadata the source attaches to records so decoding needs no cross-record state. */
export interface PiRecordMetadata {
  transcriptPath: string;
  lineNumber: number;
  byteOffset: number;
  /** Header `version` of the file (1–3); entries are decoded as their version's format. */
  piSessionVersion: number;
  /** Id of the entry appended just before this one; a different `parentId` is a tree branch. */
  piPreviousEntryId: string | null;
  /** On tool results: the call being answered, when it was recorded in this file. */
  piToolCall?: PiRecordedToolCall;
  /** On the first entry a fork adds: the copied parent entry it continues from. */
  piForkedFromEntryId?: string;
  piParentSessionPath?: string;
}

export interface PiEventSourceOptions {
  pollIntervalMs?: number;
  maxBatchSize?: number;
}

/**
 * Synthesized id of a v1 (pre-tree) entry. Pi's own v1→v2 migration assigns random ids; line
 * numbers keep the ids stable across re-reads and resumes.
 */
export function piV1EntryId(lineNumber: number): string {
  return `v1-${lineNumber}`;
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

function parseEntry(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Per-file state that makes each record self-describing: the previously appended entry (tree
 * branches), calls still awaiting results (tool results carry only the call id), and the fork
 * boundary. It is rebuilt from the file prefix when a source resumes from a cursor.
 */
class PiFileState {
  header: PiSessionHeader | null = null;
  previousEntryId: string | null = null;
  private readonly pendingCalls = new Map<string, PiRecordedToolCall>();
  private lastInheritedEntryId: string | null = null;
  private forkBoundaryPending = false;

  /** Updates state for one line; returns the record metadata, or null when not emitted. */
  observe(
    entry: Record<string, unknown>,
    lineNumber: number,
  ): Omit<PiRecordMetadata, "transcriptPath" | "lineNumber" | "byteOffset"> | null {
    if (entry.type === "session") {
      this.header = parsePiSessionHeader(JSON.stringify(entry));
      this.forkBoundaryPending = this.header?.parentSession !== undefined;
      return { piSessionVersion: this.header?.version ?? 1, piPreviousEntryId: null };
    }
    const version = this.header?.version ?? 1;
    if (version < 2) {
      entry.id = piV1EntryId(lineNumber);
      entry.parentId = lineNumber > 2 ? piV1EntryId(lineNumber - 1) : null;
    }
    const entryId = typeof entry.id === "string" ? entry.id : null;
    const previousEntryId = this.previousEntryId;
    this.previousEntryId = entryId;

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const message =
      entry.type === "message" && entry.message && typeof entry.message === "object"
        ? entry.message
        : undefined;
    let toolCall: PiRecordedToolCall | undefined;
    if (message && "role" in message && message.role === "assistant" && "content" in message) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && typeof part.id === "string") {
          this.pendingCalls.set(part.id, {
            name: typeof part.name === "string" ? part.name : "unknown",
            arguments:
              part.arguments && typeof part.arguments === "object" ? { ...part.arguments } : {},
            startedAt: timestamp,
          });
        }
      }
    } else if (
      message &&
      "role" in message &&
      message.role === "toolResult" &&
      "toolCallId" in message &&
      typeof message.toolCallId === "string"
    ) {
      toolCall = this.pendingCalls.get(message.toolCallId);
      this.pendingCalls.delete(message.toolCallId);
    }

    // Fork files begin with a verbatim copy of the parent branch (same ids, timestamps before
    // the header's); those entries were recorded in the parent transcript.
    const forkedAt = this.header?.parentSession ? Date.parse(this.header.timestamp) : Number.NaN;
    if (Date.parse(timestamp) < forkedAt) {
      this.lastInheritedEntryId = entryId;
      return null;
    }
    const metadata: Omit<PiRecordMetadata, "transcriptPath" | "lineNumber" | "byteOffset"> = {
      piSessionVersion: version,
      piPreviousEntryId: previousEntryId,
      ...(toolCall ? { piToolCall: toolCall } : {}),
    };
    if (this.forkBoundaryPending) {
      this.forkBoundaryPending = false;
      if (this.header?.parentSession) metadata.piParentSessionPath = this.header.parentSession;
      if (this.lastInheritedEntryId) metadata.piForkedFromEntryId = this.lastInheritedEntryId;
    }
    return metadata;
  }
}

function forEachLine(text: string, visit: (line: string, bytes: number) => boolean): void {
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) return;
    const line = text.slice(start, newline);
    start = newline + 1;
    if (!visit(line, Buffer.byteLength(line, "utf8") + 1)) return;
  }
}

/**
 * Tails one append-only Pi session file. The cursor's byte offset marks the end of the last
 * consumed complete line; a trailing partial line is left for the next read.
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
  private state: PiFileState | null = null;

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
    this.state = null;
  }

  /** Replays the file up to the cursor so records after it decode as if read in one pass. */
  private async rebuildState(filePath: string): Promise<PiFileState> {
    const state = new PiFileState();
    if (this.cursor.offset === 0) return state;
    const handle = await fsp.open(filePath, "r");
    let prefix: string;
    try {
      const buffer = Buffer.alloc(this.cursor.offset);
      const { bytesRead } = await handle.read(buffer, 0, this.cursor.offset, 0);
      prefix = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
    let lineNumber = 1;
    forEachLine(prefix, (line) => {
      const entry = line.trim() ? parseEntry(line.trim()) : null;
      if (entry) state.observe(entry, lineNumber);
      lineNumber += 1;
      return true;
    });
    return state;
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
      this.cursor = { offset: 0, line: 1, sequence: 0, timestamp: new Date().toISOString() };
      this.state = null;
    }
    this.lastInode = stat.ino;
    if (stat.size <= this.cursor.offset) return [];
    this.state ??= await this.rebuildState(filePath);
    const state = this.state;

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
    forEachLine(buffer.toString("utf8", 0, bytesRead), (line, bytes) => {
      const lineNumber = this.cursor.line;
      this.cursor.offset += bytes;
      this.cursor.line += 1;
      this.cursor.timestamp = new Date().toISOString();
      const entry = line.trim() ? parseEntry(line.trim()) : null;
      const observed = entry ? state.observe(entry, lineNumber) : null;
      if (!entry || !observed) return true;

      this.cursor.sequence += 1;
      const entryTime =
        typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      const metadata: PiRecordMetadata = {
        transcriptPath: filePath,
        lineNumber,
        byteOffset: this.cursor.offset,
        ...observed,
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
      return records.length < limit;
    });
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
