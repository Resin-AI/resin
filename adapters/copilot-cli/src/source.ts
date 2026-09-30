import * as fs from "node:fs/promises";
import {
  type HarnessSession,
  type RawHarnessRecord,
  type RecordListener,
  type SessionEventSource,
  type SourceCursor,
  computeConfigHash,
} from "@resin/harness-contracts";
import { COPILOT_HARNESS_ID } from "./discovery.js";
import { CopilotAgentRouter, mayCarryAgentId, primeCopilotAgentRouter } from "./subagents.js";

export interface CopilotSessionEventSourceOptions {
  pollingIntervalMs?: number;
}

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Tails `session-state/<id>/events.jsonl`. Copilot appends one JSON event per line and never
 * rewrites earlier lines (a `--resume` run appends `session.resume` to the same file), so a byte
 * offset is a stable cursor. A partial trailing line is left unread until its newline lands.
 */
export class CopilotSessionEventSource implements SessionEventSource {
  readonly sessionId: string;
  readonly transcriptPath: string;

  private cursor: SourceCursor | null = null;
  private offset = 0;
  private line = 0;
  private sequence = 0;
  private readonly listeners = new Set<RecordListener>();
  private readonly pollingIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private reading: Promise<RawHarnessRecord[]> | null = null;
  private closed = false;
  /** `undefined` for a main-agent session; a subagent session owns that agent's lines. */
  private readonly agentId: string | undefined;
  private router = new CopilotAgentRouter();
  private primed = false;

  constructor(
    session: HarnessSession,
    initialCursor?: SourceCursor,
    options?: CopilotSessionEventSourceOptions,
  ) {
    this.sessionId = session.sessionId;
    this.transcriptPath = session.transcriptPath;
    const agentId = session.metadata.copilotAgentId;
    this.agentId = typeof agentId === "string" ? agentId : undefined;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 250;
    if (initialCursor) {
      this.cursor = { ...initialCursor };
      this.offset = initialCursor.offset;
      this.line = initialCursor.line;
      this.sequence = initialCursor.sequence;
    }
  }

  async readNext(batchSize = 200): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];
    // Serialize reads so a poll and an explicit readNext never emit the same line twice.
    while (this.reading) await this.reading;
    this.reading = this.readRecords(batchSize);
    try {
      return await this.reading;
    } finally {
      this.reading = null;
    }
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    if (!this.pollTimer && !this.closed) {
      this.pollTimer = setInterval(() => void this.poll(), this.pollingIntervalMs);
    }
    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
    this.offset = cursor.offset;
    this.line = cursor.line;
    this.sequence = cursor.sequence;
  }

  getCursor(): SourceCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  async detectRotation(): Promise<boolean> {
    try {
      return (await fs.stat(this.transcriptPath)).size < this.offset;
    } catch {
      return this.offset > 0;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPolling();
    this.listeners.clear();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    const records = await this.readNext();
    if (records.length === 0) return;
    for (const listener of this.listeners) {
      await listener(records);
    }
  }

  private async readRecords(batchSize: number): Promise<RawHarnessRecord[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.transcriptPath, "r");
    } catch {
      return [];
    }
    const records: RawHarnessRecord[] = [];
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Truncated or replaced: start over from the beginning of the new file.
        this.offset = 0;
        this.line = 0;
        this.router = new CopilotAgentRouter();
      } else if (this.offset > 0 && !this.primed) {
        // Resuming mid-file: learn which subagent ran each task call before this point.
        await primeCopilotAgentRouter(this.router, this.transcriptPath, this.offset);
      }
      this.primed = true;
      let pending = Buffer.alloc(0);
      let position = this.offset;
      while (records.length < batchSize && position < size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

        let newline = pending.indexOf(0x0a);
        while (newline !== -1 && records.length < batchSize) {
          const lineBytes = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          this.offset += newline + 1;
          this.line += 1;
          const text = lineBytes.toString("utf8");
          if (text.trim().length > 0) {
            const record = this.toRecord(text);
            if (record) records.push(record);
          }
          newline = pending.indexOf(0x0a);
        }
      }
    } finally {
      await handle.close();
    }
    return records;
  }

  /** The record for one line, or null when another session (main agent or subagent) owns it. */
  private toRecord(text: string): RawHarnessRecord | null {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { type: "copilot.unparseable_line", text };
    }
    const event = payload as { id?: unknown; timestamp?: unknown };
    const timestamp =
      typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp))
        ? new Date(event.timestamp).toISOString()
        : new Date().toISOString();
    // Sequence and cursor follow the file line by line, owned or not, so a session's sequence
    // numbers do not depend on which other sessions share the file.
    this.sequence += 1;
    const cursor: SourceCursor = {
      offset: this.offset,
      line: this.line,
      sequence: this.sequence,
      checkpoint: computeConfigHash(text),
      timestamp,
    };
    this.cursor = cursor;
    const owner = mayCarryAgentId(text)
      ? this.router.route(payload as Record<string, unknown>)
      : undefined;
    // A subagent's completion line belongs to its spawner, but it is also where the subagent's own
    // session ends: without it that session never receives a closing event, and its last turn stays
    // unsettled forever. Its own source therefore takes the line too, marked as its end.
    const record = payload as { type?: unknown; agentId?: unknown };
    const ownEnd =
      this.agentId !== undefined &&
      record.agentId === this.agentId &&
      (record.type === "subagent.completed" || record.type === "subagent.failed");
    if (owner !== this.agentId && !ownEnd) return null;
    const recordId =
      typeof event.id === "string" && /^[A-Za-z0-9_-]+$/.test(event.id)
        ? event.id
        : `${this.sessionId}-line-${this.line}`;
    return {
      recordId: ownEnd ? `${recordId}-end` : recordId,
      sessionId: this.sessionId,
      harnessId: COPILOT_HARNESS_ID,
      sequenceNumber: this.sequence,
      timestamp,
      recordType: "transcript_line",
      rawPayload: payload,
      cursor,
      metadata: {
        transcriptPath: this.transcriptPath,
        line: this.line,
        ...(ownEnd ? { subagentEnd: true } : {}),
      },
    };
  }
}
