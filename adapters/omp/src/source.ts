import type fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  HarnessSession,
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";

export interface OmpEventSourceOptions {
  pollIntervalMs?: number;
  maxBatchSize?: number;
  readChunkSize?: number;
}

const MAX_OMP_PROGRAM_ARTIFACT_BYTES = 1 * 1024 * 1024;
const MAX_OMP_PROGRAM_ARTIFACT_ID_LENGTH = 20;
const OMP_PROGRAM_ARTIFACT_SUFFIX = ".eval.log";
const OMP_PROGRAM_ARTIFACT_ID_RE = /^(?:0|[1-9]\d*)$/u;
/** Initial read window per readNext; widened only for a single line longer than it. */
const OMP_READ_CHUNK_BYTES = 64 * 1024;

export type OmpProgramObservation =
  | {
      callId: string;
      result: string;
      comparison?: "text-trim";
    }
  | {
      callId: string;
      unavailable: true;
    };

type OmpRecordObject = Record<string, unknown>;

/**
 * Canonical output is retained only for the lifetime of the source record object. The raw record's
 * enumerable payload and metadata intentionally stay exactly as emitted by the transcript reader.
 */
const ompProgramObservations = new WeakMap<RawHarnessRecord, OmpProgramObservation>();

export function getOmpProgramObservation(
  record: RawHarnessRecord,
): OmpProgramObservation | undefined {
  return ompProgramObservations.get(record);
}

function asRecord(value: unknown): OmpRecordObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OmpRecordObject)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeOmpCallId(rawCallId: string): string {
  const normalized = rawCallId.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);
  if (/^[a-zA-Z0-9_-]/u.test(normalized)) return normalized;
  return `_${normalized}`.slice(0, 128);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeRegularArtifactStat(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function remainsUnderRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validArtifactId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OMP_PROGRAM_ARTIFACT_ID_LENGTH &&
    OMP_PROGRAM_ARTIFACT_ID_RE.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

/**
 * Reads the source-owned output artifact without following links or trusting a caller-supplied path.
 * The repeated identity/size checks close the lstat/open/read race sufficiently for this bounded
 * local evidence path; any uncertainty fails closed.
 */
async function readOmpProgramArtifact(
  transcriptPath: string,
  artifactId: string,
): Promise<string | undefined> {
  if (!validArtifactId(artifactId)) return undefined;

  const transcriptName = path.basename(transcriptPath);
  if (!transcriptName.endsWith(".jsonl")) return undefined;
  const transcriptStem = transcriptName.slice(0, -".jsonl".length);
  if (!transcriptStem) return undefined;
  try {
    const transcriptStat = await fsp.lstat(transcriptPath);
    if (transcriptStat.isSymbolicLink() || !transcriptStat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  const artifactRootPath = path.join(path.dirname(transcriptPath), transcriptStem);
  let rootStat: fs.Stats;
  let canonicalRoot: string;
  try {
    rootStat = await fsp.lstat(artifactRootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return undefined;
    canonicalRoot = await fsp.realpath(artifactRootPath);
  } catch {
    return undefined;
  }

  const artifactPath = path.join(artifactRootPath, `${artifactId}${OMP_PROGRAM_ARTIFACT_SUFFIX}`);
  let pathStat: fs.Stats;
  let canonicalArtifact: string;
  try {
    pathStat = await fsp.lstat(artifactPath);
    if (!safeRegularArtifactStat(pathStat) || pathStat.size > MAX_OMP_PROGRAM_ARTIFACT_BYTES) {
      return undefined;
    }
    canonicalArtifact = await fsp.realpath(artifactPath);
  } catch {
    return undefined;
  }
  if (!remainsUnderRoot(canonicalRoot, canonicalArtifact)) return undefined;

  let file: fsp.FileHandle | undefined;
  try {
    file = await fsp.open(
      artifactPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const openedStat = await file.stat();
    if (
      !safeRegularArtifactStat(openedStat) ||
      !sameFileIdentity(pathStat, openedStat) ||
      openedStat.size !== pathStat.size ||
      openedStat.size > MAX_OMP_PROGRAM_ARTIFACT_BYTES
    ) {
      return undefined;
    }

    const buffer = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead <= 0) return undefined;
      offset += read.bytesRead;
    }

    const afterReadStat = await file.stat();
    const afterPathStat = await fsp.lstat(artifactPath);
    const afterRootStat = await fsp.lstat(artifactRootPath);
    const afterCanonicalArtifact = await fsp.realpath(artifactPath);
    if (
      !safeRegularArtifactStat(afterReadStat) ||
      !safeRegularArtifactStat(afterPathStat) ||
      !sameFileIdentity(openedStat, afterReadStat) ||
      !sameFileIdentity(pathStat, afterPathStat) ||
      afterReadStat.size !== openedStat.size ||
      afterPathStat.size !== pathStat.size ||
      afterReadStat.size > MAX_OMP_PROGRAM_ARTIFACT_BYTES ||
      afterRootStat.isSymbolicLink() ||
      !afterRootStat.isDirectory() ||
      !sameFileIdentity(rootStat, afterRootStat) ||
      afterCanonicalArtifact !== canonicalArtifact ||
      !remainsUnderRoot(canonicalRoot, afterCanonicalArtifact)
    ) {
      return undefined;
    }

    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

type NativeEvalLanguage = "python" | "javascript";

function nativeEvalPayload(value: unknown):
  | {
      callId: string;
      cell: OmpRecordObject;
      details: OmpRecordObject;
      language: NativeEvalLanguage;
    }
  | undefined {
  const outer = asRecord(value);
  if (!outer || outer.type !== "message") return undefined;
  const payload = asRecord(outer.message) ?? outer;
  const roleValue = payload.role ?? outer.role;
  const role = typeof roleValue === "string" ? roleValue.toLowerCase().trim() : "";
  if (role !== "toolresult" && role !== "tool_result" && role !== "tool") return undefined;

  const toolName = firstString(
    payload.toolName,
    payload.tool_name,
    payload.name,
    payload.tool,
    outer.toolName,
    outer.tool_name,
    outer.name,
    outer.tool,
  );
  if (toolName !== "eval" || (payload.isError ?? outer.isError) !== false) return undefined;

  const rawCallId = firstString(
    payload.toolCallId,
    payload.tool_call_id,
    payload.callId,
    payload.call_id,
    payload.id,
    outer.toolCallId,
    outer.tool_call_id,
    outer.callId,
    outer.call_id,
    outer.id,
  );
  if (!rawCallId || rawCallId.trim().length === 0) return undefined;

  const details = asRecord(payload.details) ?? asRecord(outer.details);
  if (!details || !Array.isArray(details.cells) || details.cells.length !== 1) return undefined;
  const cell = asRecord(details.cells[0]);
  const rawLanguage = typeof cell?.language === "string" ? cell.language.trim().toLowerCase() : "";
  const language =
    rawLanguage === "python"
      ? "python"
      : rawLanguage === "js" || rawLanguage === "javascript"
        ? "javascript"
        : undefined;
  if (!cell || language === undefined || cell.status !== "complete" || cell.exitCode !== 0) {
    return undefined;
  }
  return { callId: normalizeOmpCallId(rawCallId), cell, details, language };
}

async function populateOmpProgramObservation(
  record: RawHarnessRecord,
  parsedPayload: unknown,
  transcriptPath: string,
): Promise<void> {
  const native = nativeEvalPayload(parsedPayload);
  if (!native) return;

  const meta = asRecord(native.details.meta);
  const limits = asRecord(meta?.limits);
  const columnTruncated = limits?.columnTruncated;
  let unrecognizedTruncation = false;

  for (const [key, value] of Object.entries(native.details)) {
    if (key === "meta" || key === "cells" || !key.toLowerCase().includes("truncat")) continue;
    if (value !== undefined && value !== null && value !== false) {
      unrecognizedTruncation = true;
      break;
    }
  }
  if (!unrecognizedTruncation) {
    for (const [key, value] of Object.entries(native.cell)) {
      if (!key.toLowerCase().includes("truncat")) continue;
      if (value !== undefined && value !== null && value !== false) {
        unrecognizedTruncation = true;
        break;
      }
    }
  }
  if (!unrecognizedTruncation && meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (key === "limits" || key === "truncation" || !key.toLowerCase().includes("truncat")) {
        continue;
      }
      if (value !== undefined && value !== null && value !== false) {
        unrecognizedTruncation = true;
        break;
      }
    }
  }
  if (!unrecognizedTruncation && limits) {
    for (const [key, value] of Object.entries(limits)) {
      if (key === "columnTruncated" || !key.toLowerCase().includes("truncat")) continue;
      if (value !== undefined && value !== null && value !== false) {
        unrecognizedTruncation = true;
        break;
      }
    }
  }

  // OMP 18.x spills an eval's full output stream to `<session>/<artifactId>.eval.log` and records
  // the spill either as a byte truncation (`meta.truncation`) or as column truncation
  // (`meta.limits.columnTruncated`). Both name the same artifact; the display text is never the result.
  const truncation = meta?.truncation;
  const truncationDeclared =
    truncation !== undefined && truncation !== null && truncation !== false;
  const columnTruncationDeclared =
    columnTruncated !== undefined && columnTruncated !== null && columnTruncated !== false;
  if (unrecognizedTruncation) {
    ompProgramObservations.set(record, { callId: native.callId, unavailable: true });
    return;
  }
  if (truncationDeclared || columnTruncationDeclared) {
    const artifactIds = [
      ...(truncationDeclared ? [asRecord(truncation)?.artifactId] : []),
      ...(columnTruncationDeclared ? [asRecord(columnTruncated)?.artifactId] : []),
    ];
    const artifactId = artifactIds[0];
    if (!validArtifactId(artifactId) || artifactIds.some((candidate) => candidate !== artifactId)) {
      ompProgramObservations.set(record, { callId: native.callId, unavailable: true });
      return;
    }
    const result = await readOmpProgramArtifact(transcriptPath, artifactId);
    ompProgramObservations.set(
      record,
      result === undefined
        ? { callId: native.callId, unavailable: true }
        : { callId: native.callId, result },
    );
    return;
  }

  if (typeof native.cell.output !== "string") {
    ompProgramObservations.set(record, { callId: native.callId, unavailable: true });
    return;
  }
  const observation = { callId: native.callId, result: native.cell.output };
  if (native.language === "python") {
    ompProgramObservations.set(record, { ...observation, comparison: "text-trim" });
    return;
  }
  ompProgramObservations.set(record, observation);
}

const FORK_HEADER_SCAN_BYTES = 64 * 1024;
const FORK_HEADER_SCAN_LINES = 8;

/**
 * The start of a forked transcript, read from its session header: epoch ms when the header names a
 * parent session, null when the file is not a fork, undefined when the header is not written yet.
 */
async function readOmpForkStart(filePath: string): Promise<number | null | undefined> {
  let head: string;
  try {
    const fd = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(FORK_HEADER_SCAN_BYTES);
      const { bytesRead } = await fd.read(buffer, 0, FORK_HEADER_SCAN_BYTES, 0);
      head = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
  const lines = head.split("\n");
  // Only newline-terminated lines are complete; the header precedes every entry but a title.
  const complete = lines.slice(0, -1).slice(0, FORK_HEADER_SCAN_LINES);
  for (const line of complete) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!(entry instanceof Object) || Array.isArray(entry)) return null;
    const header = entry as { type?: unknown; parentSession?: unknown; timestamp?: unknown };
    if (header.type === "title") continue;
    if (header.type !== "session") return null;
    if (typeof header.parentSession !== "string" || header.parentSession.length === 0) return null;
    const at = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  }
  return complete.length >= FORK_HEADER_SCAN_LINES ? null : undefined;
}

/**
 * Event source tailing append-only JSONL transcript files produced by Oh My Pi.
 */
export class OmpSessionEventSource implements SessionEventSource {
  readonly session: HarnessSession;
  private currentCursor: SourceCursor;
  private listeners = new Set<RecordListener>();
  private pollIntervalMs: number;
  private maxBatchSize: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isClosed = false;
  private lastInode: number | null = null;
  private lastFileSize = 0;
  /** Tail of the serialized readNext chain. */
  private readQueue: Promise<void> = Promise.resolve();
  /**
   * When this transcript was forked from a parent session, the fork's own start: OMP copies the
   * parent's history into the new file verbatim (same entry ids, earlier timestamps), and those
   * calls were executed, and are recorded, by the parent. Null when the file is not a fork.
   */
  private forkedAt: number | null | undefined;

  constructor(
    session: HarnessSession,
    initialCursor?: SourceCursor,
    options?: OmpEventSourceOptions,
  ) {
    this.session = session;
    // Each attached session polls its transcript on its own timer; with dozens of sessions open a
    // 100 ms tick kept the daemon near 4% CPU while nothing was written. A second is prompt
    // enough for capture and costs a tenth of that.
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxBatchSize = options?.maxBatchSize ?? 50;

    this.currentCursor = initialCursor
      ? { ...initialCursor }
      : {
          offset: 0,
          line: 1,
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
  }

  getCursor(): SourceCursor {
    return { ...this.currentCursor };
  }

  /**
   * Commits a progress checkpoint.
   */
  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.currentCursor = { ...cursor };
  }

  /**
   * Alias for checkpoint.
   */
  async setCursor(cursor: SourceCursor): Promise<void> {
    return this.checkpoint(cursor);
  }

  /**
   * Pulls the next batch of raw harness records from the current cursor position in the JSONL file.
   * Calls run one at a time: the tailer both pulls batches and listens to this source's own poll,
   * and two reads from the same cursor would deliver the same lines twice.
   */
  readNext(batchSize?: number): Promise<RawHarnessRecord[]> {
    const read = this.readQueue.then(() => this.readNextFromCursor(batchSize));
    this.readQueue = read.then(
      () => undefined,
      () => undefined,
    );
    return read;
  }

  private async readNextFromCursor(batchSize?: number): Promise<RawHarnessRecord[]> {
    if (this.isClosed) {
      return [];
    }

    const limit = batchSize ?? this.maxBatchSize;
    const filePath = this.session.transcriptPath;

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return [];
    }

    this.lastInode = stat.ino;
    this.lastFileSize = stat.size;

    // Check if file is smaller than cursor (rotation/truncation)
    if (stat.size < this.currentCursor.offset) {
      this.currentCursor.offset = 0;
      this.currentCursor.line = 1;
      this.currentCursor.sequence = 0;
      this.forkedAt = undefined;
    }
    if (this.forkedAt === undefined) this.forkedAt = await readOmpForkStart(filePath);

    if (stat.size - this.currentCursor.offset <= 0) {
      return [];
    }

    const records: RawHarnessRecord[] = [];
    const fd = await fsp.open(filePath, "r");
    try {
      // Read only as far as the batch needs: a large backlog is walked one bounded chunk per
      // call instead of re-reading everything to EOF, and each line is decoded from its own
      // bytes so records never pin a whole-backlog string.
      let chunkBytes = OMP_READ_CHUNK_BYTES;
      while (records.length < limit) {
        const remaining = stat.size - this.currentCursor.offset;
        if (remaining <= 0) break;
        const toRead = Math.min(remaining, chunkBytes);
        const buffer = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await fd.read(buffer, 0, toRead, this.currentCursor.offset);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);

        let lineStart = 0;
        while (lineStart < chunk.length && records.length < limit) {
          const newlineIndex = chunk.indexOf(0x0a, lineStart);
          if (newlineIndex === -1) break;
          const line = chunk.toString("utf8", lineStart, newlineIndex);
          this.currentCursor.offset += newlineIndex + 1 - lineStart;
          lineStart = newlineIndex + 1;
          const record = await this.toRecord(line, filePath);
          if (record) records.push(record);
          this.currentCursor.line += 1;
        }

        if (lineStart === 0) {
          // No complete line in this chunk. A short read means the file ends here (it may have
          // shrunk since stat), so the line is incomplete: stop. Otherwise the line is longer
          // than the chunk, so widen the window until it fits.
          if (bytesRead < toRead || bytesRead === remaining) break;
          chunkBytes *= 2;
        }
      }
    } finally {
      await fd.close();
    }

    return records;
  }

  /** Builds the record for one complete transcript line, or null for blank/inherited lines. */
  private async toRecord(line: string, filePath: string): Promise<RawHarnessRecord | null> {
    this.currentCursor.sequence += 1;
    this.currentCursor.timestamp = new Date().toISOString();

    const trimmed = line.trim();
    if (trimmed.length === 0 || this.isInheritedEntry(trimmed)) {
      return null;
    }
    const recordId = `${this.session.sessionId}-rec-${this.currentCursor.sequence}`;
    let parsedPayload: unknown = trimmed;
    let timestamp = new Date().toISOString();
    let recordType: RecordType = "transcript_line";

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed instanceof Object && !Array.isArray(parsed)) {
        // SAFETY: Parsed JSON represents a structured transcript record object.
        const obj = parsed as {
          timestamp?: string | number;
          updatedAt?: string | number;
          time?: string | number;
          ts?: string | number;
          role?: string;
          type?: string;
          event?: string;
          kind?: string;
          toolCall?: object;
          tool_call?: object;
          toolResult?: object;
          tool_result?: object;
        };
        parsedPayload = parsed;
        const ts = obj.timestamp ?? obj.updatedAt ?? obj.time ?? obj.ts;
        if (ts !== undefined) {
          timestamp = String(ts);
        }
        recordType = this.classifyRecordType(obj);
      }
    } catch {
      parsedPayload = trimmed;
      recordType = "transcript_line";
    }
    const record: RawHarnessRecord = {
      recordId,
      sessionId: this.session.sessionId,
      harnessId: "omp",
      sequenceNumber: this.currentCursor.sequence,
      timestamp,
      cursor: { ...this.currentCursor },
      rawPayload: trimmed,
      recordType,
      metadata: {
        transcriptPath: filePath,
        lineNumber: this.currentCursor.line,
        byteOffset: this.currentCursor.offset,
      },
    };
    await populateOmpProgramObservation(record, parsedPayload, filePath);
    return record;
  }

  /** A copied parent entry: a non-header record timestamped before this fork began. */
  private isInheritedEntry(line: string): boolean {
    if (this.forkedAt === null || this.forkedAt === undefined) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return false;
    const entry = parsed as { type?: unknown; timestamp?: unknown };
    if (entry.type === "session" || entry.type === "title") return false;
    if (typeof entry.timestamp !== "string") return false;
    const at = Date.parse(entry.timestamp);
    return Number.isFinite(at) && at < this.forkedAt;
  }

  /**
   * Alias for readNext.
   */
  async readBatch(batchSize?: number): Promise<RawHarnessRecord[]> {
    return this.readNext(batchSize);
  }

  /**
   * Registers a push callback for real-time streaming of new records.
   */
  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);

    if (!this.pollTimer && !this.isClosed) {
      this.startPolling();
    }

    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  }

  /**
   * Alias for onRecords.
   */
  subscribe(listener: RecordListener): () => void {
    return this.onRecords(listener);
  }

  /**
   * Detects if the transcript file has undergone rotation, inode replacement, or truncation.
   */
  async detectRotation(): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.session.transcriptPath);

      const inodeChanged = this.lastInode !== null && stat.ino !== this.lastInode;
      const truncated = stat.size < this.currentCursor.offset;

      if (inodeChanged || truncated) {
        this.lastInode = stat.ino;
        this.lastFileSize = stat.size;
        return true;
      }

      this.lastInode = stat.ino;
      this.lastFileSize = stat.size;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Closes the event source and cleans up file polling/watchers.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private startPolling(): void {
    if (this.pollTimer || this.isClosed) {
      return;
    }

    // Skip a tick while the previous one is still reading, so a slow read (a large backlog)
    // does not queue another behind it every interval.
    let reading = false;
    this.pollTimer = setInterval(async () => {
      if (this.isClosed || this.listeners.size === 0) {
        this.stopPolling();
        return;
      }
      if (reading) return;
      reading = true;

      try {
        const records = await this.readNext();
        if (records.length > 0) {
          for (const listener of Array.from(this.listeners)) {
            try {
              await listener(records);
            } catch {
              // Listener errors do not stop polling
            }
          }
        }
      } catch {
        // Ignore read errors during background polling
      } finally {
        reading = false;
      }
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private classifyRecordType(obj: {
    role?: string;
    type?: string;
    event?: string;
    kind?: string;
    toolCall?: object;
    tool_call?: object;
    toolResult?: object;
    tool_result?: object;
  }): RecordType {
    const rawRole = String(obj.role ?? "").toLowerCase();
    const rawType = String(obj.type ?? obj.event ?? obj.kind ?? "").toLowerCase();

    if (rawRole === "user" || rawType === "user_message" || rawType === "prompt") {
      return "prompt";
    }

    if (rawRole === "assistant" || rawType === "assistant_message" || rawType === "completion") {
      return "completion";
    }

    if (rawRole === "system" || rawType === "system_message" || rawType === "system") {
      return "system";
    }

    if (
      rawType === "tool_call" ||
      rawType === "tool_use" ||
      rawType === "tool_invocation" ||
      rawType === "tool_execution_start" ||
      (obj.toolCall !== undefined && obj.toolCall instanceof Object) ||
      (obj.tool_call !== undefined && obj.tool_call instanceof Object)
    ) {
      return "tool_call";
    }

    if (
      rawType === "tool_result" ||
      rawType === "tool_response" ||
      rawType === "tool_output" ||
      rawType === "tool_execution_end" ||
      (obj.toolResult !== undefined && obj.toolResult instanceof Object) ||
      (obj.tool_result !== undefined && obj.tool_result instanceof Object)
    ) {
      return "tool_result";
    }

    return "transcript_line";
  }
}
