import {
  type NormalizedCommandExecEvent,
  type NormalizedErrorEvent,
  type NormalizedSessionEvent,
  type NormalizedToolResultEvent,
  hashCanonicalContent,
} from "@resin/contracts";
import type {
  Episode,
  EpisodeMetrics,
  OpportunityDataValue,
  SegmenterOptions,
} from "./types.js";

const DEFAULT_IDLE_GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MIN_EVENTS = 1;
const DEFAULT_MAX_EVENTS = 256; // preserve large single-turn workflows without unbounded clustering

export interface EventTokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache; already counted in `totalTokens`. */
  cachedInputTokens: number;
  totalTokens: number;
  /** Source-reported or harness-estimated spend, never inferred from token counts. */
  costUsd?: number;
  costSource: "reported" | "estimated" | "unknown";
  /** Whether this event needs cost accounting (assistant turn or captured usage). */
  hasUsage: boolean;
}

export interface EpisodeUsageSummary {
  totalTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  costSource: "reported" | "estimated" | "unknown";
}

type ExtendedSessionEvent = NormalizedSessionEvent & {
  payload?: Record<string, OpportunityDataValue>;
  metadata?: Record<string, OpportunityDataValue>;
  sessionMetadata?: Record<string, OpportunityDataValue>;
  parameters?: Record<string, OpportunityDataValue>;
  params?: Record<string, OpportunityDataValue>;
  context?: Record<string, OpportunityDataValue>;
  tags?: Record<string, OpportunityDataValue>;
  scenarioId?: string;
  scenario_id?: string;
  scenario?: string;
  scenarioName?: string;
  scenario_name?: string;
  sequenceNum?: number;
  branchId?: string;
  durationMs?: number;
  duration?: number;
  accountId?: string;
  workspaceId?: string;
  toolName?: string;
  name?: string;
  command?: string;
  status?: string;
};

/**
 * Parses timestamp string or number into epoch milliseconds.
 */
export function parseTimestampMs(ts: string | number | undefined): number {
  if (!ts) return Date.now();
  if (Number.isFinite(ts)) return Number(ts);
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Extracts token usage from an event if available in payload or metadata.
 */
export function extractEventTokens(event: NormalizedSessionEvent): EventTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let totalTokens = 0;
  let costUsd: number | undefined;
  let costSource: EventTokenUsage["costSource"] = "unknown";

  const anyEvt = event as ExtendedSessionEvent;
  const payload =
    anyEvt.payload && Object.prototype.toString.call(anyEvt.payload) === "[object Object]"
      ? anyEvt.payload
      : undefined;
  const metadata =
    anyEvt.metadata && Object.prototype.toString.call(anyEvt.metadata) === "[object Object]"
      ? anyEvt.metadata
      : undefined;

  // Prefer provider-reported usage; fall back to harness-payload usage records.
  const provUsage = event.providerUsage as OpportunityDataValue | undefined;
  const rawUsage = payload?.usage ?? metadata?.usage ?? provUsage;
  if (rawUsage && Object.prototype.toString.call(rawUsage) === "[object Object]") {
    const usage = rawUsage as Record<string, OpportunityDataValue>;
    const inTok = usage.inputTokens ?? usage.promptTokens;
    inputTokens = Number.isFinite(inTok) ? Number(inTok) : 0;

    const outTok = usage.outputTokens ?? usage.completionTokens;
    outputTokens = Number.isFinite(outTok) ? Number(outTok) : 0;

    const cachedTok = usage.cachedInputTokens ?? usage.cachedTokens ?? usage.cacheReadInputTokens;
    cachedInputTokens = Number.isFinite(cachedTok) ? Number(cachedTok) : 0;

    // The per-turn context re-send is what a tool saves, so a provider total that
    // includes cache reads is the number we want; only fall back to the visible
    // input/output split when the provider reported no total.
    const totTok = usage.totalTokens;
    totalTokens = Number.isFinite(totTok)
      ? Number(totTok)
      : inputTokens + outputTokens + cachedInputTokens;

    const micro = usage.costMicroUsd;
    const direct = usage.costUsd;
    if (Number.isFinite(micro) && Number(micro) >= 0) {
      costUsd = Number(micro) / 1_000_000;
    } else if (Number.isFinite(direct) && Number(direct) >= 0) {
      costUsd = Number(direct);
    }
    if (costUsd !== undefined) {
      costSource = usage.costProvenance === "harness_estimate" ? "estimated" : "reported";
    }
  } else {
    const pTok = payload?.tokens;
    if (Number.isFinite(pTok)) totalTokens = Number(pTok);
    const mTok = metadata?.tokens;
    if (Number.isFinite(mTok)) totalTokens = Number(mTok);
    const pTotal = payload?.totalTokens;
    if (Number.isFinite(pTotal)) totalTokens = Number(pTotal);
    const mTotal = metadata?.totalTokens;
    if (Number.isFinite(mTotal)) totalTokens = Number(mTotal);
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    costSource,
    hasUsage:
      rawUsage !== undefined ||
      totalTokens > 0 ||
      (event.type === "message" && event.role === "assistant"),
  };
}

/**
 * Sums captured usage only when every usage-bearing event has a known cost.
 * A harness estimate remains an estimate; missing accounting never becomes a
 * partial authoritative total or a token-priced dollar fallback.
 */
export function summarizeEpisodeUsage(
  events: readonly NormalizedSessionEvent[],
): EpisodeUsageSummary {
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let reportedCostUsd = 0;
  let reported = false;
  let complete = true;
  let estimated = false;
  for (const event of events) {
    const tokens = extractEventTokens(event);
    totalTokens += tokens.totalTokens;
    cachedInputTokens += tokens.cachedInputTokens;
    if (tokens.costUsd !== undefined) {
      reported = true;
      reportedCostUsd += tokens.costUsd;
      estimated ||= tokens.costSource === "estimated";
    } else if (tokens.hasUsage) {
      complete = false;
    }
  }
  const known = reported && complete && Number.isFinite(reportedCostUsd);
  return {
    totalTokens,
    cachedInputTokens,
    costUsd: known ? reportedCostUsd : null,
    costSource: known ? (estimated ? "estimated" : "reported") : "unknown",
  };
}

/**
 * Detects if an event signifies a tool/command failure or error.
 */
export function isErrorEvent(event: NormalizedSessionEvent): boolean {
  if (event.type === "error") return true;

  if (event.type === "tool_result") {
    const res = event as NormalizedToolResultEvent & { isError?: boolean; status?: string };
    if (res.isError === true || res.status === "error" || res.status === "failed") return true;
  }

  if (event.type === "command_exec") {
    const cmd = event as NormalizedCommandExecEvent;
    if (Number.isFinite(cmd.exitCode) && cmd.exitCode !== 0) return true;
  }

  return false;
}

/**
 * Checks if an event is an actionable workflow step.
 */
export function isActionableStep(event: NormalizedSessionEvent): boolean {
  return (
    event.type === "tool_call" ||
    event.type === "command_exec" ||
    event.type === "file_edit" ||
    event.type === "subagent_lifecycle"
  );
}

/**
 * Extracts scenario ID from normalized session events if present in metadata, payload, or event properties.
 */
export function extractScenarioId(events: NormalizedSessionEvent[]): string | undefined {
  for (const evt of events) {
    if (!evt) continue;
    const anyEvt = evt as ExtendedSessionEvent;

    // Direct properties
    const direct =
      anyEvt.scenarioId ??
      anyEvt.scenario_id ??
      anyEvt.scenario ??
      anyEvt.scenarioName ??
      anyEvt.scenario_name;
    if (Object.prototype.toString.call(direct) === "[object String]") {
      const str = String(direct).trim();
      if (str.length > 0) return str;
    }

    const checkRecord = (rec: OpportunityDataValue | undefined): string | undefined => {
      if (!rec) return undefined;
      let value: OpportunityDataValue = rec;
      if (Object.prototype.toString.call(value) === "[object String]") {
        try {
          value = JSON.parse(String(value));
        } catch {
          return undefined;
        }
      }
      if (!value || Object.prototype.toString.call(value) !== "[object Object]") return undefined;
      const r = value as Record<string, OpportunityDataValue>;
      const val =
        r.scenarioId ??
        r.scenario_id ??
        r.scenario ??
        r.scenarioName ??
        r.scenario_name ??
        r.testScenario ??
        r.test_scenario;
      if (Object.prototype.toString.call(val) === "[object String]") {
        const str = String(val).trim();
        if (str.length > 0) return str;
      }
      if (r.metadata && Object.prototype.toString.call(r.metadata) === "[object Object]") {
        const nested = checkRecord(r.metadata as OpportunityDataValue);
        if (nested) return nested;
      }
      return undefined;
    };

    const fromMeta = checkRecord(anyEvt.metadata);
    if (fromMeta) return fromMeta;

    const fromPayload = checkRecord(anyEvt.payload);
    if (fromPayload) return fromPayload;

    const fromSessionMeta = checkRecord(anyEvt.sessionMetadata);
    if (fromSessionMeta) return fromSessionMeta;

    const fromParams = checkRecord(anyEvt.parameters ?? anyEvt.params);
    if (fromParams) return fromParams;

    const fromContext = checkRecord(anyEvt.context);
    if (fromContext) return fromContext;

    const fromTags = checkRecord(anyEvt.tags);
    if (fromTags) return fromTags;
  }
  return undefined;
}

/**
 * Workflow episode segmenter breaking normalized event streams into cohesive episodes.
 */
export class EpisodeSegmenter {
  private readonly idleGapThresholdMs: number;
  private readonly minEventsPerEpisode: number;
  private readonly maxEventsPerEpisode: number;

  constructor(options: SegmenterOptions = {}) {
    this.idleGapThresholdMs = options.idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS;
    this.minEventsPerEpisode = options.minEventsPerEpisode ?? DEFAULT_MIN_EVENTS;
    this.maxEventsPerEpisode = options.maxEventsPerEpisode ?? DEFAULT_MAX_EVENTS;
  }

  /**
   * Segments a chronological sequence of session events into distinct workflow episodes.
   */
  segmentEvents(events: NormalizedSessionEvent[]): Episode[] {
    if (!events || events.length === 0) {
      return [];
    }

    // Sort events by timestamp and sequence number if present
    const sorted = [...events].sort((a, b) => {
      const tsA = parseTimestampMs(a.timestamp);
      const tsB = parseTimestampMs(b.timestamp);
      if (tsA !== tsB) return tsA - tsB;
      const anyA = a as ExtendedSessionEvent;
      const anyB = b as ExtendedSessionEvent;
      const seqA = Number.isFinite(anyA.sequenceNum) ? Number(anyA.sequenceNum) : 0;
      const seqB = Number.isFinite(anyB.sequenceNum) ? Number(anyB.sequenceNum) : 0;
      return seqA - seqB;
    });

    const episodes: Episode[] = [];
    let currentBatch: NormalizedSessionEvent[] = [];
    let currentSessionId = sorted[0].sessionId;
    let currentBranchId = (sorted[0] as ExtendedSessionEvent).branchId;
    let turnIndex = 0;

    const flushBatch = () => {
      if (currentBatch.length >= this.minEventsPerEpisode) {
        const episode = this.buildEpisode(
          currentBatch,
          currentSessionId,
          currentBranchId,
          turnIndex,
        );
        episodes.push(episode);
        turnIndex++;
      }
      currentBatch = [];
    };

    for (let i = 0; i < sorted.length; i++) {
      const evt = sorted[i];
      const prevEvt = sorted[i - 1];
      const evtBranchId = (evt as ExtendedSessionEvent).branchId;

      // 1. Session Boundary
      if (evt.sessionId !== currentSessionId) {
        flushBatch();
        currentSessionId = evt.sessionId;
        currentBranchId = evtBranchId;
        turnIndex = 0;
      }
      // 2. Branch Boundary
      else if (evtBranchId && evtBranchId !== currentBranchId) {
        flushBatch();
        currentBranchId = evtBranchId;
      }
      // 3. User Turn Boundary (e.g. user_message or role="user")
      else if (
        this.isUserTurnBoundary(evt) &&
        currentBatch.length > 0 &&
        this.hasActionableContent(currentBatch)
      ) {
        flushBatch();
      }
      // 4. Idle Gap Boundary
      else if (prevEvt) {
        const gapMs = parseTimestampMs(evt.timestamp) - parseTimestampMs(prevEvt.timestamp);
        if (gapMs > this.idleGapThresholdMs && currentBatch.length > 0) {
          flushBatch();
        }
      }
      // 5. Max Events per Episode Boundary
      else if (currentBatch.length >= this.maxEventsPerEpisode) {
        flushBatch();
      }

      currentBatch.push(evt);

      // If event is a branch_fork or session completion, flush immediately after adding
      if (
        evt.type === "branch_fork" ||
        (evt.type === "session_lifecycle" && this.isTerminalLifecycle(evt))
      ) {
        flushBatch();
      }
    }

    flushBatch();
    return episodes;
  }

  /**
   * Checks if an event marks the start of a new user turn.
   */
  private isUserTurnBoundary(event: NormalizedSessionEvent): boolean {
    if (event.type === "message" && event.role === "user") {
      return true;
    }
    return false;
  }

  /**
   * Checks if an event is a terminal session lifecycle event.
   */
  private isTerminalLifecycle(event: NormalizedSessionEvent): boolean {
    const anyEvt = event as ExtendedSessionEvent;
    const payload =
      anyEvt.payload && Object.prototype.toString.call(anyEvt.payload) === "[object Object]"
        ? anyEvt.payload
        : undefined;
    const status = payload?.status ?? anyEvt.status;
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "terminated" ||
      status === "failed"
    );
  }

  /**
   * Checks if the batch contains more than just a user message.
   */
  private hasActionableContent(batch: NormalizedSessionEvent[]): boolean {
    return batch.some(
      (e) =>
        isActionableStep(e) ||
        (e.type === "message" && e.role === "assistant") ||
        e.type === "tool_result",
    );
  }

  /**
   * Builds an Episode from a grouped batch of events.
   */
  private buildEpisode(
    events: NormalizedSessionEvent[],
    sessionId: string,
    branchId: string | undefined,
    turnIndex: number,
  ): Episode {
    const first = events[0];
    const last = events[events.length - 1];

    const startedAt = first.timestamp;
    const endedAt = last.timestamp;

    const startMs = parseTimestampMs(startedAt);
    const endMs = parseTimestampMs(endedAt);
    const wallDurationMs = Math.max(0, endMs - startMs);

    // Compute metrics
    let stepCount = 0;
    let hasErrors = false;
    let accumulatedToolDurationMs = 0;

    // Detect retries
    let retryCount = 0;
    const recentActions: string[] = [];

    for (const evt of events) {
      if (isActionableStep(evt)) {
        stepCount++;
        const actionKey = this.getActionKey(evt);
        if (actionKey) {
          // If the same action key failed recently and is being repeated
          if (recentActions.includes(actionKey)) {
            retryCount++;
          }
          recentActions.push(actionKey);
        }
      }

      if (isErrorEvent(evt)) {
        hasErrors = true;
      }
      // Extract duration if present on tool/command events
      const anyEvt = evt as ExtendedSessionEvent;
      if (Number.isFinite(anyEvt.durationMs)) {
        accumulatedToolDurationMs += Number(anyEvt.durationMs);
      } else if (Number.isFinite(anyEvt.duration)) {
        accumulatedToolDurationMs += Number(anyEvt.duration);
      }
    }

    const totalDurationMs = Math.max(wallDurationMs, accumulatedToolDurationMs);
    const usage = summarizeEpisodeUsage(events);

    const metrics: EpisodeMetrics = {
      stepCount,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.cachedInputTokens,
      retryCount,
      estimatedCostUsd: usage.costUsd,
      costSource: usage.costSource,
      totalDurationMs,
    };

    // Determine completion status
    const isCompleted = !this.hasTerminalFatalError(events);
    // Extract tenant context from first event
    const anyFirst = first as ExtendedSessionEvent;
    const metaAcc = anyFirst.metadata?.accountId;
    const metaWs = anyFirst.metadata?.workspaceId;
    const accountId =
      anyFirst.accountId ||
      (Object.prototype.toString.call(metaAcc) === "[object String]"
        ? String(metaAcc)
        : undefined) ||
      "default-account";
    const workspaceId =
      anyFirst.workspaceId ||
      (Object.prototype.toString.call(metaWs) === "[object String]" ? String(metaWs) : undefined) ||
      "default-workspace";

    // Every session is its own scenario unless the client tagged one explicitly.
    const scenarioId = extractScenarioId(events) ?? sessionId;

    // Generate deterministic episode ID
    const eventIdsDigest = hashCanonicalContent(events.map((e) => e.eventId)).slice(0, 12);
    const id = `ep_${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}_t${turnIndex}_${eventIdsDigest}`;

    return {
      id,
      sessionId,
      branchId,
      accountId,
      workspaceId,
      events,
      startedAt,
      endedAt,
      durationMs: totalDurationMs,
      turnIndex,
      isCompleted,
      hasErrors,
      metrics,
      scenarioId,
    };
  }

  /**
   * Extracts action key for tracking retries.
   */
  private getActionKey(event: NormalizedSessionEvent): string {
    const anyEvt = event as ExtendedSessionEvent;
    if (event.type === "tool_call") {
      const payload =
        anyEvt.payload && Object.prototype.toString.call(anyEvt.payload) === "[object Object]"
          ? anyEvt.payload
          : undefined;
      const toolName = anyEvt.toolName || anyEvt.name || payload?.name;
      return `tool:${String(toolName ?? "")}`;
    }
    if (event.type === "command_exec") {
      const payload =
        anyEvt.payload && Object.prototype.toString.call(anyEvt.payload) === "[object Object]"
          ? anyEvt.payload
          : undefined;
      const cmd = anyEvt.command || payload?.command;
      return `cmd:${String(cmd ?? "")}`;
    }
    return event.type;
  }

  /**
   * Checks if the episode suffered an unrecoverable terminal error.
   */
  private hasTerminalFatalError(events: NormalizedSessionEvent[]): boolean {
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === "error") {
      const err = lastEvent as NormalizedErrorEvent & { isFatal?: boolean };
      return err.isFatal === true;
    }
    return false;
  }
}

/**
 * Convenience function to segment events.
 */
export function segmentSessionEvents(
  events: NormalizedSessionEvent[],
  options?: SegmenterOptions,
): Episode[] {
  const segmenter = new EpisodeSegmenter(options);
  return segmenter.segmentEvents(events);
}
