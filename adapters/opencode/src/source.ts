import type {
  HarnessSession,
  RawHarnessRecord,
  RecordListener,
  RecordType,
  SessionEventSource,
  SourceCursor,
} from "@resin/harness-contracts";
import type {
  OpencodeMessageInfo,
  OpencodePart,
  OpencodeSessionInfo,
  OpencodeStore,
  OpencodeStoredEvent,
} from "./store.js";

export const OPENCODE_HARNESS_ID = "opencode";

/**
 * Raw record payloads the OpenCode source emits. OpenCode rewrites parts in place (a tool part
 * moves pending → running → completed), so the source turns entity snapshots into
 * append-only records: each record is emitted exactly once, when the entity reaches the state
 * it describes.
 */
export type OpencodeRecordPayload =
  | { kind: "session"; session: OpencodeSessionInfo }
  | { kind: "user_text"; message: OpencodeMessageInfo; part: OpencodePart }
  | {
      /** A finished assistant message (one model step) with its text parts and usage. */
      kind: "assistant_message";
      message: OpencodeMessageInfo;
      texts: OpencodePart[];
    }
  | { kind: "reasoning"; message: OpencodeMessageInfo; part: OpencodePart }
  | { kind: "tool_call"; message: OpencodeMessageInfo; part: OpencodePart }
  | {
      kind: "tool_result";
      message: OpencodeMessageInfo;
      part: OpencodePart;
      callPart: OpencodePart;
    }
  | { kind: "compaction"; message: OpencodeMessageInfo; part: OpencodePart };

const RECORD_TYPE: Record<OpencodeRecordPayload["kind"], RecordType> = {
  session: "system",
  user_text: "prompt",
  assistant_message: "completion",
  reasoning: "completion",
  tool_call: "tool_call",
  tool_result: "tool_result",
  compaction: "system",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `value[key]` when `value` is a JSON object. */
function prop(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

/**
 * Turns successive entity snapshots into once-only record payloads. Feeding the same history
 * twice yields nothing new, so it doubles as the replay state when resuming from a cursor.
 */
export class OpencodeRecordPlanner {
  private sessionEmitted = false;
  private readonly messages = new Map<string, OpencodeMessageInfo>();
  private readonly finishedMessages = new Set<string>();
  private readonly assistantTexts = new Map<string, Map<string, OpencodePart>>();
  private readonly emittedParts = new Set<string>();
  private readonly toolCalls = new Map<string, OpencodePart>();
  private readonly toolResults = new Set<string>();

  session(info: OpencodeSessionInfo): OpencodeRecordPayload[] {
    if (this.sessionEmitted) return [];
    this.sessionEmitted = true;
    return [{ kind: "session", session: info }];
  }

  /** Records a message's role and model without emitting anything. */
  track(info: OpencodeMessageInfo): void {
    this.messages.set(info.id, info);
  }

  message(info: OpencodeMessageInfo): OpencodeRecordPayload[] {
    this.messages.set(info.id, info);
    if (info.role !== "assistant" || this.finishedMessages.has(info.id)) return [];
    if (info.time?.completed === undefined && info.error === undefined) return [];
    this.finishedMessages.add(info.id);
    const texts = [...(this.assistantTexts.get(info.id)?.values() ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return [{ kind: "assistant_message", message: info, texts }];
  }

  part(part: OpencodePart): OpencodeRecordPayload[] {
    const message = this.messages.get(part.messageID) ?? {
      id: part.messageID,
      sessionID: part.sessionID,
      role: "assistant",
      time: { created: 0 },
    };
    switch (part.type) {
      case "text": {
        if (message.role === "user") {
          if (this.emittedParts.has(part.id)) return [];
          this.emittedParts.add(part.id);
          return [{ kind: "user_text", message, part }];
        }
        const texts = this.assistantTexts.get(part.messageID) ?? new Map<string, OpencodePart>();
        texts.set(part.id, part);
        this.assistantTexts.set(part.messageID, texts);
        return [];
      }
      case "reasoning": {
        if (prop(part.time, "end") === undefined || this.emittedParts.has(part.id)) return [];
        this.emittedParts.add(part.id);
        return [{ kind: "reasoning", message, part }];
      }
      case "compaction": {
        if (this.emittedParts.has(part.id)) return [];
        this.emittedParts.add(part.id);
        return [{ kind: "compaction", message, part }];
      }
      case "tool": {
        const status = prop(part.state, "status");
        const out: OpencodeRecordPayload[] = [];
        if (status === undefined || status === "pending") return out;
        if (!this.toolCalls.has(part.id)) {
          this.toolCalls.set(part.id, part);
          out.push({ kind: "tool_call", message, part });
        }
        if ((status === "completed" || status === "error") && !this.toolResults.has(part.id)) {
          this.toolResults.add(part.id);
          out.push({ kind: "tool_result", message, part, callPart: this.toolCalls.get(part.id)! });
        }
        return out;
      }
      default:
        return [];
    }
  }

  /** Applies one entry of OpenCode's `event` log. */
  event(event: OpencodeStoredEvent): OpencodeRecordPayload[] {
    const name = event.type.replace(/\.\d+$/, "");
    const data = event.data;
    if ((name === "session.created" || name === "session.updated") && isObject(data.info)) {
      return this.session(data.info as OpencodeSessionInfo);
    }
    if (name === "message.updated" && isObject(data.info)) {
      return this.message(data.info as OpencodeMessageInfo);
    }
    if (name === "message.part.updated" && isObject(data.part)) {
      return this.part(data.part as OpencodePart);
    }
    return [];
  }
}

function payloadTime(payload: OpencodeRecordPayload): number | undefined {
  const pick = (value: unknown): number | undefined =>
    typeof value === "number" && value > 0 ? value : undefined;
  switch (payload.kind) {
    case "session":
      return pick(payload.session.time?.created);
    case "assistant_message":
      return pick(payload.message.time?.completed) ?? pick(payload.message.time?.created);
    case "tool_call":
    case "tool_result": {
      const time = prop(payload.part.state, "time");
      return payload.kind === "tool_result"
        ? (pick(prop(time, "end")) ?? pick(prop(time, "start")))
        : pick(prop(time, "start"));
    }
    default: {
      const time = payload.part.time;
      return (
        pick(prop(time, "end")) ?? pick(prop(time, "start")) ?? pick(payload.message.time?.created)
      );
    }
  }
}

function payloadEntityId(payload: OpencodeRecordPayload): string {
  switch (payload.kind) {
    case "session":
      return payload.session.id;
    case "assistant_message":
      return payload.message.id;
    default:
      return payload.part.id;
  }
}

export interface OpencodeSessionEventSourceOptions {
  pollingIntervalMs?: number;
}

/**
 * Tails one OpenCode session from its store.
 *
 * SQLite stores with an `event` log are read incrementally: `cursor.offset` is the last
 * applied event `seq`, and resuming replays earlier events through the planner without
 * emitting them. Stores without an event log (legacy JSON tree) are re-read as snapshots in
 * id order; `cursor.offset` then counts emitted records.
 */
export class OpencodeSessionEventSource implements SessionEventSource {
  readonly harnessId = OPENCODE_HARNESS_ID;
  readonly sessionId: string;

  private readonly planner = new OpencodeRecordPlanner();
  private readonly pending: RawHarnessRecord[] = [];
  private readonly listeners = new Set<RecordListener>();
  private readonly pollingIntervalMs: number;
  private cursor: SourceCursor | null;
  /** `events`: incremental over the event log; `snapshot`: re-read session state. */
  private mode: "events" | "snapshot" | undefined;
  /** Records up to this offset were delivered before the source was (re)opened. */
  private readonly resumeOffset: number;
  private eventSeq = -1;
  private emitted = 0;
  private skipped = 0;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: OpencodeStore,
    session: HarnessSession,
    initialCursor?: SourceCursor,
    options?: OpencodeSessionEventSourceOptions,
  ) {
    this.sessionId = session.sessionId;
    this.pollingIntervalMs = options?.pollingIntervalMs ?? 500;
    this.cursor = initialCursor ? { ...initialCursor } : null;
    this.emitted = initialCursor?.sequence ?? 0;
    this.resumeOffset = initialCursor ? initialCursor.offset : -1;
  }

  async readNext(batchSize = 50): Promise<RawHarnessRecord[]> {
    if (this.closed) return [];
    if (this.pending.length < batchSize) this.poll();
    return this.pending.splice(0, batchSize);
  }

  onRecords(callback: RecordListener): () => void {
    this.listeners.add(callback);
    this.ensureTimer();
    return () => {
      this.listeners.delete(callback);
    };
  }

  async checkpoint(cursor: SourceCursor): Promise<void> {
    this.cursor = { ...cursor };
  }

  getCursor(): SourceCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  async detectRotation(): Promise<boolean> {
    return this.store.readSession(this.sessionId) === null;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.flushToListeners();
    }, this.pollingIntervalMs);
    this.timer.unref?.();
  }

  private async flushToListeners(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    this.poll();
    const records = this.pending.splice(0);
    if (records.length === 0) return;
    for (const listener of this.listeners) {
      await listener(records);
    }
  }

  private poll(): void {
    if (this.mode === "events") {
      this.applyEvents(this.store.readEvents(this.sessionId, this.eventSeq) ?? []);
      return;
    }
    if (this.mode === "snapshot") {
      this.pollSnapshot();
      return;
    }
    const events = this.store.readEvents(this.sessionId, -1);
    if (events !== null && events.length > 0) {
      this.mode = "events";
      this.applyEvents(events);
      return;
    }
    const snapshot = this.store.readSession(this.sessionId);
    if (snapshot && (events === null || snapshot.messages.length > 0)) {
      this.mode = "snapshot";
      this.pollSnapshot();
    }
  }

  private applyEvents(events: OpencodeStoredEvent[]): void {
    for (const event of events) {
      const payloads = this.planner.event(event);
      this.eventSeq = event.seq;
      if (event.seq <= this.resumeOffset) continue;
      for (const payload of payloads) this.push(payload, event.seq);
    }
  }

  private pollSnapshot(): void {
    const snapshot = this.store.readSession(this.sessionId);
    if (!snapshot) return;
    const payloads = [...this.planner.session(snapshot.session)];
    for (const { info, parts } of snapshot.messages) {
      // Parts before the message so a finished message carries its text parts.
      this.planner.track(info);
      for (const part of parts) payloads.push(...this.planner.part(part));
      payloads.push(...this.planner.message(info));
    }
    for (const payload of payloads) {
      if (this.skipped < this.resumeOffset) {
        this.skipped++;
        continue;
      }
      this.push(payload, this.emitted + 1);
    }
  }

  private push(payload: OpencodeRecordPayload, offset: number): void {
    this.emitted++;
    const timestamp = new Date(payloadTime(payload) ?? Date.now()).toISOString();
    const cursor: SourceCursor = {
      offset,
      line: this.emitted,
      sequence: this.emitted,
      timestamp,
    };
    this.cursor = cursor;
    this.pending.push({
      recordId: `${this.sessionId}:${payload.kind}:${payloadEntityId(payload)}`.slice(0, 128),
      sessionId: this.sessionId,
      harnessId: OPENCODE_HARNESS_ID,
      sequenceNumber: this.emitted,
      timestamp,
      recordType: RECORD_TYPE[payload.kind],
      rawPayload: payload,
      cursor,
      metadata: { store: this.store.kind, location: this.store.location },
    });
  }
}
