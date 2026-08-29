import { randomUUID } from "node:crypto";
import type {
  CausalRef,
  DiscoveredToolEntry,
  FileDiffStats,
  MessageContentPart,
  NormalizedBranchForkEvent,
  NormalizedCommandExecEvent,
  NormalizedCompactionEvent,
  NormalizedErrorEvent,
  NormalizedFileEditEvent,
  NormalizedMessageEvent,
  NormalizedModelReasoningEvent,
  NormalizedSessionEvent,
  NormalizedSessionLifecycleEvent,
  NormalizedSubagentLifecycleEvent,
  NormalizedToolCallEvent,
  NormalizedToolDiscoveryEvent,
  NormalizedToolResultEvent,
  NormalizedUnknownPassthroughEvent,
  ProviderReportedUsage,
  RedactionMeta,
} from "@resin/contracts";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import type {
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
  RecordDecoderContext,
} from "@resin/harness-contracts";
export const DEFAULT_SCHEMA_VERSION = "1.0.0";

/**
 * Options for configuring the Codex session decoder.
 */
export interface CodexDecoderOptions {
  sessionId?: string;
  initialSequence?: number;
  workspaceId?: string;
}

/**
 * Helper to generate unique event IDs.
 */
function generateEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Parses and normalizes timestamps into strict ISO 8601 UTC strings.
 */
function parseTimestamp(rawTs?: unknown): string {
  if (typeof rawTs === "string") {
    const d = new Date(rawTs);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } else if (typeof rawTs === "number") {
    // Check if seconds vs milliseconds
    const ms = rawTs < 1e11 ? rawTs * 1000 : rawTs;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Normalizes tool call parameters to Record<string, unknown>.
 */
function parseToolParameters(rawParams: unknown): Record<string, unknown> {
  if (typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)) {
    return rawParams as Record<string, unknown>;
  }
  if (typeof rawParams === "string") {
    try {
      const parsed = JSON.parse(rawParams);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: rawParams };
    }
  }
  return {};
}

/**
 * Parses a non-negative integer or returns undefined.
 */
function parseNonNegativeInt(val: unknown): number | undefined {
  if (typeof val === "number") {
    if (Number.isFinite(val) && Number.isInteger(val) && val >= 0) {
      return val;
    }
    return undefined;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num >= 0) {
        return num;
      }
    }
  }
  return undefined;
}

/**
 * Parses cost into micro USD (integer >= 0) or returns undefined.
 */
function parseCostMicroUsd(raw: Record<string, unknown>): number | undefined {
  const directMicro = raw.costMicroUsd ?? raw.cost_micro_usd;
  const parsedMicro = parseNonNegativeInt(directMicro);
  if (parsedMicro !== undefined) {
    return parsedMicro;
  }

  const directUsd = raw.costUsd ?? raw.cost_usd ?? raw.cost;
  if (typeof directUsd === "number" && Number.isFinite(directUsd) && directUsd >= 0) {
    return Math.round(directUsd * 1_000_000);
  }
  if (typeof directUsd === "string") {
    const trimmed = directUsd.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num >= 0) {
        return Math.round(num * 1_000_000);
      }
    }
  }

  const directCents = raw.costCents ?? raw.cost_cents;
  if (typeof directCents === "number" && Number.isFinite(directCents) && directCents >= 0) {
    return Math.round(directCents * 10_000);
  }

  return undefined;
}

/**
 * Parses duration in milliseconds or returns undefined.
 */
function parseDurationMs(raw: Record<string, unknown>): number | undefined {
  const directMs = raw.durationMs ?? raw.duration_ms;
  return parseNonNegativeInt(directMs);
}

/**
 * Extracts exact token components without inference or substitution.
 */
function extractTokenComponents(raw: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  hasAnyMetrics: boolean;
} {
  const promptDetails =
    typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : typeof raw.promptTokensDetails === "object" && raw.promptTokensDetails !== null
        ? (raw.promptTokensDetails as Record<string, unknown>)
        : typeof raw.input_tokens_details === "object" && raw.input_tokens_details !== null
          ? (raw.input_tokens_details as Record<string, unknown>)
          : typeof raw.inputTokensDetails === "object" && raw.inputTokensDetails !== null
            ? (raw.inputTokensDetails as Record<string, unknown>)
            : undefined;

  const completionDetails =
    typeof raw.completion_tokens_details === "object" && raw.completion_tokens_details !== null
      ? (raw.completion_tokens_details as Record<string, unknown>)
      : typeof raw.completionTokensDetails === "object" && raw.completionTokensDetails !== null
        ? (raw.completionTokensDetails as Record<string, unknown>)
        : typeof raw.output_tokens_details === "object" && raw.output_tokens_details !== null
          ? (raw.output_tokens_details as Record<string, unknown>)
          : typeof raw.outputTokensDetails === "object" && raw.outputTokensDetails !== null
            ? (raw.outputTokensDetails as Record<string, unknown>)
            : undefined;

  const tokensObj =
    typeof raw.tokens === "object" && raw.tokens !== null
      ? (raw.tokens as Record<string, unknown>)
      : undefined;

  const inputTokens =
    parseNonNegativeInt(raw.prompt_tokens) ??
    parseNonNegativeInt(raw.promptTokens) ??
    parseNonNegativeInt(raw.input_tokens) ??
    parseNonNegativeInt(raw.inputTokens) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.prompt) ?? parseNonNegativeInt(tokensObj.input))
      : undefined);

  const outputTokens =
    parseNonNegativeInt(raw.completion_tokens) ??
    parseNonNegativeInt(raw.completionTokens) ??
    parseNonNegativeInt(raw.output_tokens) ??
    parseNonNegativeInt(raw.outputTokens) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.completion) ?? parseNonNegativeInt(tokensObj.output))
      : undefined);

  const reasoningTokens =
    (completionDetails
      ? (parseNonNegativeInt(completionDetails.reasoning_tokens) ??
        parseNonNegativeInt(completionDetails.reasoningTokens))
      : undefined) ??
    parseNonNegativeInt(raw.reasoning_tokens) ??
    parseNonNegativeInt(raw.reasoningTokens) ??
    parseNonNegativeInt(raw.thinking_tokens) ??
    parseNonNegativeInt(raw.thinkingTokens) ??
    (tokensObj ? parseNonNegativeInt(tokensObj.reasoning) : undefined);

  const cachedInputTokens =
    (promptDetails
      ? (parseNonNegativeInt(promptDetails.cached_tokens) ??
        parseNonNegativeInt(promptDetails.cachedTokens) ??
        parseNonNegativeInt(promptDetails.cache_read_input_tokens))
      : undefined) ??
    parseNonNegativeInt(raw.cached_tokens) ??
    parseNonNegativeInt(raw.cachedTokens) ??
    parseNonNegativeInt(raw.cached_input_tokens) ??
    parseNonNegativeInt(raw.cachedInputTokens) ??
    parseNonNegativeInt(raw.cache_read_input_tokens) ??
    parseNonNegativeInt(raw.cacheReadInputTokens) ??
    (tokensObj ? parseNonNegativeInt(tokensObj.cached) : undefined);

  const totalTokens =
    parseNonNegativeInt(raw.total_tokens) ??
    parseNonNegativeInt(raw.totalTokens) ??
    (tokensObj ? parseNonNegativeInt(tokensObj.total) : undefined);

  const hasAnyMetrics =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningTokens !== undefined ||
    cachedInputTokens !== undefined ||
    totalTokens !== undefined;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    hasAnyMetrics,
  };
}

/**
 * Checks whether an object or record represents a cumulative session total.
 */
function isCumulativeObject(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  if (rec.is_cumulative === true || rec.isCumulative === true || rec.cumulative === true)
    return true;
  if (rec.scope === "session" || rec.scope === "cumulative" || rec.scope === "total") return true;
  if (rec.accounting === "cumulative") return true;
  if (
    rec.type === "session_usage" ||
    rec.type === "cumulative_usage" ||
    rec.type === "session_total"
  )
    return true;
  return false;
}

/**
 * Finds per-turn / last-token usage in a raw payload.
 */
function getTurnUsageRecord(p: Record<string, unknown>): Record<string, unknown> | undefined {
  // 1. Explicit turn / delta usage fields
  if (typeof p.turn_usage === "object" && p.turn_usage !== null && !Array.isArray(p.turn_usage)) {
    return p.turn_usage as Record<string, unknown>;
  }
  if (typeof p.turnUsage === "object" && p.turnUsage !== null && !Array.isArray(p.turnUsage)) {
    return p.turnUsage as Record<string, unknown>;
  }
  if (
    typeof p.last_turn_usage === "object" &&
    p.last_turn_usage !== null &&
    !Array.isArray(p.last_turn_usage)
  ) {
    return p.last_turn_usage as Record<string, unknown>;
  }
  if (
    typeof p.lastTurnUsage === "object" &&
    p.lastTurnUsage !== null &&
    !Array.isArray(p.lastTurnUsage)
  ) {
    return p.lastTurnUsage as Record<string, unknown>;
  }
  if (typeof p.last_turn === "object" && p.last_turn !== null && !Array.isArray(p.last_turn)) {
    return p.last_turn as Record<string, unknown>;
  }

  // If payload itself is marked cumulative, it is not a per-turn record
  if (isCumulativeObject(p)) {
    return undefined;
  }

  // 2. usage / token_usage / provider_usage / usage_metadata if NOT cumulative
  for (const key of [
    "usage",
    "token_usage",
    "tokenUsage",
    "provider_usage",
    "providerUsage",
    "usage_metadata",
    "usageMetadata",
  ]) {
    const val = p[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      if (!isCumulativeObject(val)) {
        return val as Record<string, unknown>;
      }
    }
  }

  // 3. Nested in response / message / raw
  for (const parentKey of ["response", "message", "raw"]) {
    const parent = p[parentKey];
    if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
      const parentRec = parent as Record<string, unknown>;
      for (const key of ["usage", "token_usage", "tokenUsage", "provider_usage", "providerUsage"]) {
        const val = parentRec[key];
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          if (!isCumulativeObject(val)) {
            return val as Record<string, unknown>;
          }
        }
      }
    }
  }

  // 4. Top-level on p itself if p has prompt_tokens / input_tokens / completion_tokens etc. and is not cumulative
  const { hasAnyMetrics } = extractTokenComponents(p);
  if (hasAnyMetrics) {
    return p;
  }

  return undefined;
}

/**
 * Finds cumulative session usage in a raw payload.
 */
function getCumulativeUsageRecord(p: Record<string, unknown>): Record<string, unknown> | undefined {
  // 1. Explicit cumulative / session usage fields
  for (const key of [
    "cumulative_usage",
    "cumulativeUsage",
    "session_usage",
    "sessionUsage",
    "total_usage",
    "totalUsage",
    "session_total_usage",
  ]) {
    const val = p[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
  }

  // 2. usage / token_usage that is flagged cumulative
  for (const key of [
    "usage",
    "token_usage",
    "tokenUsage",
    "provider_usage",
    "providerUsage",
    "usage_metadata",
    "usageMetadata",
  ]) {
    const val = p[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      if (isCumulativeObject(val)) {
        return val as Record<string, unknown>;
      }
    }
  }

  // 3. Payload itself is marked cumulative
  if (isCumulativeObject(p)) {
    const { hasAnyMetrics } = extractTokenComponents(p);
    if (hasAnyMetrics) {
      return p;
    }
  }

  return undefined;
}

/**
 * Builds and validates ProviderReportedUsage without inferring missing totals.
 */
function buildProviderUsage(
  rawUsage: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
  accountingVersion: string,
): ProviderReportedUsage | undefined {
  // Provider: explicit raw provider when present, otherwise adapter-known "openai"
  const rawProvider =
    (typeof rawPayload.provider === "string" && rawPayload.provider.trim()
      ? rawPayload.provider.trim()
      : undefined) ??
    (typeof rawUsage.provider === "string" && rawUsage.provider.trim()
      ? rawUsage.provider.trim()
      : undefined);
  const provider = rawProvider ?? "openai";

  // Model: raw model only when present (never infer/fabricate)
  const rawModel =
    (typeof rawPayload.model === "string" && rawPayload.model.trim()
      ? rawPayload.model.trim()
      : undefined) ??
    (typeof rawUsage.model === "string" && rawUsage.model.trim()
      ? rawUsage.model.trim()
      : undefined) ??
    (typeof rawPayload.model_id === "string" && rawPayload.model_id.trim()
      ? rawPayload.model_id.trim()
      : undefined) ??
    (typeof rawPayload.modelId === "string" && rawPayload.modelId.trim()
      ? rawPayload.modelId.trim()
      : undefined) ??
    (typeof rawUsage.model_id === "string" && rawUsage.model_id.trim()
      ? rawUsage.model_id.trim()
      : undefined) ??
    (typeof rawUsage.modelId === "string" && rawUsage.modelId.trim()
      ? rawUsage.modelId.trim()
      : undefined);
  const model = rawModel ?? undefined;

  const costMicroUsd = parseCostMicroUsd(rawUsage) ?? parseCostMicroUsd(rawPayload);
  const durationMs = parseDurationMs(rawUsage) ?? parseDurationMs(rawPayload);

  // Check explicit availability
  const explicitAvailability =
    typeof rawUsage.availability === "string"
      ? rawUsage.availability
      : typeof rawPayload.availability === "string"
        ? rawPayload.availability
        : undefined;

  if (
    explicitAvailability === "unavailable" ||
    rawUsage.unavailable === true ||
    rawPayload.unavailable === true
  ) {
    const usageObj = {
      provider,
      model,
      accountingVersion,
      availability: "unavailable" as const,
    };
    const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
    return parsed.success ? parsed.data : undefined;
  }

  const {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    hasAnyMetrics,
  } = extractTokenComponents(rawUsage);

  const hasMetrics = hasAnyMetrics || costMicroUsd !== undefined || durationMs !== undefined;

  if (!hasMetrics) {
    if (explicitAvailability === "unavailable") {
      const usageObj = {
        provider,
        model,
        accountingVersion,
        availability: "unavailable" as const,
      };
      const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
      return parsed.success ? parsed.data : undefined;
    }
    return undefined;
  }

  let availability: "complete" | "partial" = "partial";
  if (explicitAvailability === "complete") {
    availability = totalTokens !== undefined ? "complete" : "partial";
  } else if (explicitAvailability === "partial") {
    availability = "partial";
  } else {
    // Explicit totalTokens presence defines completeness
    availability = totalTokens !== undefined ? "complete" : "partial";
  }

  const usageObj: Record<string, unknown> = {
    provider,
    model,
    accountingVersion,
    availability,
  };

  if (inputTokens !== undefined) usageObj.inputTokens = inputTokens;
  if (outputTokens !== undefined) usageObj.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usageObj.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) usageObj.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usageObj.totalTokens = totalTokens;
  if (costMicroUsd !== undefined) usageObj.costMicroUsd = costMicroUsd;
  if (durationMs !== undefined) usageObj.durationMs = durationMs;

  const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
  if (parsed.success) {
    return parsed.data;
  }
  return undefined;
}

/**
 * State-preserving decoder for Codex CLI session rollouts and JSONL transcripts.
 */
export class CodexSessionDecoder {
  private sessionId: string;
  private sequence: number;
  private lastEventId?: string;
  private readonly callMap = new Map<string, { toolName: string; timestamp: string }>();
  private readonly workspaceId?: string;
  private hasEmittedTurnUsage = false;
  private lastCumulativeUsage?: {
    rawUsage: Record<string, unknown>;
    rawPayload: Record<string, unknown>;
  };
  private currentMetadata?: Record<string, unknown>;

  constructor(options?: CodexDecoderOptions) {
    this.sessionId = options?.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.sequence = options?.initialSequence ?? 1;
    this.workspaceId = options?.workspaceId;
  }

  /**
   * Resets the decoder sequence and session state.
   */
  reset(sessionId?: string): void {
    if (sessionId) {
      this.sessionId = sessionId;
    }
    this.sequence = 1;
    this.lastEventId = undefined;
    this.callMap.clear();
    this.hasEmittedTurnUsage = false;
    this.lastCumulativeUsage = undefined;
    this.currentMetadata = undefined;
  }

  private nextHeader(
    timestamp?: unknown,
    rawEventId?: unknown,
    metadataOverride?: Record<string, unknown>,
  ): {
    eventId: string;
    schemaVersion: "1.0.0";
    sessionId: string;
    timestamp: string;
    causalRef: CausalRef;
    redaction: RedactionMeta;
    metadata?: Record<string, unknown>;
  } {
    const eventId = typeof rawEventId === "string" ? rawEventId : generateEventId("evt");
    const ts = parseTimestamp(timestamp);
    const causalSequence = this.sequence++;
    const meta = metadataOverride ?? this.currentMetadata;
    const header = {
      eventId,
      schemaVersion: "1.0.0" as const,
      sessionId: this.sessionId,
      timestamp: ts,
      causalRef: {
        parentId: this.lastEventId ?? null,
        causalSequence,
      },
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none" as const,
        scrubbedPatterns: [],
      },
      ...(meta && Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    };
    this.lastEventId = eventId;
    return header;
  }

  /**
   * Decodes a single raw record (string line or parsed object) into zero or more NormalizedSessionEvents.
   */
  decodeRecord(raw: string | Record<string, unknown>): NormalizedSessionEvent[] {
    if (!raw) {
      return [];
    }

    let payload: Record<string, unknown>;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) {
        return [];
      }
      try {
        payload = JSON.parse(trimmed);
      } catch {
        const header = this.nextHeader();
        const unk: NormalizedUnknownPassthroughEvent = {
          ...header,
          type: "unknown_passthrough",
          rawEventType: "unparseable_string",
          rawPayload: { raw: trimmed },
        };
        return [unk];
      }
    } else {
      payload = raw;
    }

    if (typeof payload !== "object" || payload === null) {
      return [];
    }

    return this.normalizePayload(payload);
  }

  /**
   * Decodes a full multi-line transcript or array of records.
   */
  decodeTranscript(
    transcript: string | Array<string | Record<string, unknown>>,
  ): NormalizedSessionEvent[] {
    const events: NormalizedSessionEvent[] = [];

    if (typeof transcript === "string") {
      const lines = transcript.split(/\r?\n/);
      for (const line of lines) {
        events.push(...this.decodeRecord(line));
      }
    } else if (Array.isArray(transcript)) {
      for (const item of transcript) {
        events.push(...this.decodeRecord(item));
      }
    }

    return events;
  }

  private normalizePayload(p: Record<string, unknown>): NormalizedSessionEvent[] {
    const rawType = String(p.type || p.event || p.role || "").toLowerCase();
    const timestamp = p.timestamp || p.created_at || p.createdAt || p.time;
    const rawEventId = p.eventId || p.event_id || p.id;
    this.currentMetadata =
      typeof p.metadata === "object" && p.metadata !== null
        ? (p.metadata as Record<string, unknown>)
        : undefined;
    // Detect session ID override if embedded
    if (typeof p.sessionId === "string") {
      this.sessionId = p.sessionId;
    } else if (typeof p.session_id === "string") {
      this.sessionId = p.session_id;
    }

    const turnUsageRec = getTurnUsageRecord(p);
    const cumUsageRec = getCumulativeUsageRecord(p);

    // 1. Session Lifecycle
    if (
      rawType === "session_lifecycle" ||
      rawType === "session_start" ||
      rawType === "session_end" ||
      rawType === "session_pause" ||
      rawType === "session_resume" ||
      rawType === "session_crash"
    ) {
      const lifecycleType = (p.lifecycleType ||
        (rawType === "session_start"
          ? "start"
          : rawType === "session_end"
            ? "end"
            : rawType === "session_pause"
              ? "pause"
              : rawType === "session_resume"
                ? "resume"
                : rawType === "session_crash"
                  ? "crash"
                  : "start")) as "start" | "pause" | "resume" | "end" | "crash";

      let lifecycleUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        lifecycleUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (lifecycleUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (lifecycleType === "end" || lifecycleType === "crash") {
        if (!this.hasEmittedTurnUsage) {
          const cumRec = cumUsageRec ?? this.lastCumulativeUsage?.rawUsage;
          const cumPayload = cumUsageRec ? p : (this.lastCumulativeUsage?.rawPayload ?? p);
          if (cumRec) {
            lifecycleUsage = buildProviderUsage(cumRec, cumPayload, "codex-cli-cumulative-v1");
          }
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedSessionLifecycleEvent = {
        ...header,
        type: "session_lifecycle",
        lifecycleType,
        exitReason:
          typeof p.exitReason === "string"
            ? p.exitReason
            : typeof p.reason === "string"
              ? p.reason
              : undefined,
        harnessName: typeof p.harnessName === "string" ? p.harnessName : "codex-cli",
        workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : this.workspaceId,
        providerUsage: lifecycleUsage,
      };
      return [evt];
    }

    // 2. Model Reasoning / Thought
    if (
      rawType === "model_reasoning" ||
      rawType === "reasoning" ||
      rawType === "thought" ||
      rawType === "chain_of_thought"
    ) {
      let reasoningUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        reasoningUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (reasoningUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const header = this.nextHeader(timestamp, rawEventId);
      const content =
        typeof p.reasoningContent === "string"
          ? p.reasoningContent
          : typeof p.content === "string"
            ? p.content
            : typeof p.text === "string"
              ? p.text
              : typeof p.thought === "string"
                ? p.thought
                : "";
      const evt: NormalizedModelReasoningEvent = {
        ...header,
        type: "model_reasoning",
        reasoningContent: content,
        model: typeof p.model === "string" ? p.model : undefined,
        providerUsage: reasoningUsage,
      };
      return [evt];
    }
    // 3. User Message
    if (rawType === "user_message" || rawType === "user" || rawType === "user_turn") {
      let userUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        userUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (userUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const header = this.nextHeader(timestamp, rawEventId);
      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      if (typeof p.content === "string") {
        content = p.content;
      } else if (typeof p.text === "string") {
        content = p.text;
      } else if (typeof p.prompt === "string") {
        content = p.prompt;
      } else if (typeof p.query === "string") {
        content = p.query;
      } else if (typeof p.input === "string") {
        content = p.input;
      } else if (Array.isArray(p.content)) {
        contentParts = p.content as MessageContentPart[];
        content = (p.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      } else if (typeof p.message === "object" && p.message !== null) {
        const msg = p.message as Record<string, unknown>;
        content =
          typeof msg.content === "string"
            ? msg.content
            : typeof msg.text === "string"
              ? msg.text
              : typeof msg.prompt === "string"
                ? msg.prompt
                : JSON.stringify(msg);
      }

      const evt: NormalizedMessageEvent = {
        ...header,
        type: "message",
        role: "user",
        content,
        contentParts,
        providerUsage: userUsage,
      };
      return [evt];
    }

    // 4. Assistant Message
    if (rawType === "assistant_message" || rawType === "assistant" || rawType === "agent_turn") {
      const events: NormalizedSessionEvent[] = [];

      let assistantUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        assistantUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (assistantUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      if (typeof p.content === "string") {
        content = p.content;
      } else if (typeof p.text === "string") {
        content = p.text;
      } else if (Array.isArray(p.content)) {
        contentParts = p.content as MessageContentPart[];
        content = (p.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      } else if (typeof p.message === "object" && p.message !== null) {
        const msg = p.message as Record<string, unknown>;
        content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg);
      }

      // Check for inline tool_calls array
      const toolCalls = Array.isArray(p.tool_calls)
        ? p.tool_calls
        : Array.isArray(p.toolCalls)
          ? p.toolCalls
          : undefined;

      if (content || !toolCalls || toolCalls.length === 0) {
        const header = this.nextHeader(timestamp, rawEventId);
        events.push({
          ...header,
          type: "message",
          role: "assistant",
          content,
          contentParts,
          model: typeof p.model === "string" ? p.model : undefined,
          providerUsage: assistantUsage,
        });
        assistantUsage = undefined;
      }

      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls as Array<Record<string, unknown>>) {
          const callId = String(tc.id || tc.call_id || generateEventId("call"));
          const fn = (
            typeof tc.function === "object" && tc.function !== null ? tc.function : tc
          ) as Record<string, unknown>;
          const toolName = String(fn.name || fn.tool_name || fn.tool || "unknown_tool");
          const parameters = parseToolParameters(fn.arguments || fn.parameters || fn.params);

          this.callMap.set(callId, {
            toolName,
            timestamp: parseTimestamp(timestamp),
          });

          const callHeader = this.nextHeader(timestamp);
          events.push({
            ...callHeader,
            type: "tool_call",
            callId,
            toolName,
            parameters,
            candidateRef: typeof tc.candidateRef === "string" ? tc.candidateRef : undefined,
            isShadow: Boolean(tc.isShadow ?? tc.is_shadow ?? false),
            providerUsage: assistantUsage,
          });
          assistantUsage = undefined;
        }
      }

      return events;
    }

    // 5. Generic Message
    if (rawType === "message") {
      let msgUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        msgUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (msgUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const role = (
        p.role === "user" || p.role === "assistant" || p.role === "system" || p.role === "tool"
          ? p.role
          : "assistant"
      ) as "user" | "assistant" | "system" | "tool";

      let content = "";
      let contentParts: MessageContentPart[] | undefined;
      if (typeof p.content === "string") {
        content = p.content;
      } else if (Array.isArray(p.content)) {
        contentParts = p.content as MessageContentPart[];
        content = (p.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      }

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedMessageEvent = {
        ...header,
        type: "message",
        role,
        content,
        contentParts,
        model: typeof p.model === "string" ? p.model : undefined,
        providerUsage: msgUsage,
      };
      return [evt];
    }

    // 6. Tool Discovery
    if (
      rawType === "tool_discovery" ||
      rawType === "tools_discovered" ||
      rawType === "tools_registered" ||
      rawType === "tool_manifest"
    ) {
      let discUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        discUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (discUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const rawTools = Array.isArray(p.tools)
        ? p.tools
        : Array.isArray(p.toolList)
          ? p.toolList
          : [];
      const tools: DiscoveredToolEntry[] = rawTools.map((t: unknown) => {
        const item = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
        return {
          name: String(item.name || "unnamed_tool"),
          description: typeof item.description === "string" ? item.description : undefined,
          inputSchema:
            typeof item.parameters === "object" && item.parameters !== null
              ? (item.parameters as Record<string, unknown>)
              : typeof item.inputSchema === "object" && item.inputSchema !== null
                ? (item.inputSchema as Record<string, unknown>)
                : undefined,
          provider: typeof item.provider === "string" ? item.provider : "codex-cli",
        };
      });

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolDiscoveryEvent = {
        ...header,
        type: "tool_discovery",
        tools,
        source: "mcp",
        providerUsage: discUsage,
      };
      return [evt];
    }

    // 7. Tool Call
    if (
      rawType === "tool_call" ||
      rawType === "call_tool" ||
      rawType === "function_call" ||
      rawType === "action"
    ) {
      let callUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        callUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (callUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const callId = String(p.callId || p.call_id || p.id || generateEventId("call"));
      const toolName = String(
        p.toolName || p.tool_name || p.name || p.tool || p.function || "unknown_tool",
      );
      const parameters = parseToolParameters(
        p.parameters || p.params || p.args || p.arguments || p.input,
      );

      this.callMap.set(callId, {
        toolName,
        timestamp: parseTimestamp(timestamp),
      });

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolCallEvent = {
        ...header,
        type: "tool_call",
        callId,
        toolName,
        parameters,
        candidateRef: typeof p.candidateRef === "string" ? p.candidateRef : undefined,
        isShadow: Boolean(p.isShadow ?? p.is_shadow ?? false),
        providerUsage: callUsage,
      };
      return [evt];
    }

    // 8. Tool Result
    if (
      rawType === "tool_result" ||
      rawType === "tool_response" ||
      rawType === "function_call_result" ||
      rawType === "action_result" ||
      rawType === "observation" ||
      rawType === "tool"
    ) {
      let resUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        resUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (resUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const callId = String(
        p.callId || p.call_id || p.tool_call_id || p.id || generateEventId("call"),
      );
      const cached = this.callMap.get(callId);
      const toolName = String(
        p.toolName || p.tool_name || p.name || cached?.toolName || "unknown_tool",
      );

      const result =
        p.result !== undefined
          ? p.result
          : p.output !== undefined
            ? p.output
            : p.content !== undefined
              ? p.content
              : null;
      const isError = Boolean(p.isError || p.is_error || p.error);
      const durationMs =
        typeof p.executionDurationMs === "number"
          ? p.executionDurationMs
          : typeof p.durationMs === "number"
            ? p.durationMs
            : typeof p.duration_ms === "number"
              ? p.duration_ms
              : 0;
      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedToolResultEvent = {
        ...header,
        type: "tool_result",
        callId,
        toolName,
        result,
        isError,
        executionDurationMs: durationMs,
        isShadow: Boolean(p.isShadow ?? p.is_shadow ?? false),
        providerUsage: resUsage,
      };
      return [evt];
    }

    // 9. Command Execution
    if (
      rawType === "command_exec" ||
      rawType === "command" ||
      rawType === "exec" ||
      rawType === "bash" ||
      rawType === "shell" ||
      rawType === "terminal" ||
      rawType === "run_command"
    ) {
      let cmdUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        cmdUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (cmdUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const command = String(p.command || p.cmd || p.exec || "");
      const args = Array.isArray(p.args) ? (p.args as string[]) : [];
      const exitCode =
        typeof p.exitCode === "number"
          ? p.exitCode
          : typeof p.exit_code === "number"
            ? p.exit_code
            : 0;
      const stdout =
        typeof p.stdout === "string"
          ? p.stdout
          : typeof p.output === "string"
            ? p.output
            : undefined;
      const stderr = typeof p.stderr === "string" ? p.stderr : undefined;
      const durationMs =
        typeof p.durationMs === "number"
          ? p.durationMs
          : typeof p.duration_ms === "number"
            ? p.duration_ms
            : 0;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedCommandExecEvent = {
        ...header,
        type: "command_exec",
        command,
        args,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        exitCode,
        stdout,
        stderr,
        durationMs,
        providerUsage: cmdUsage,
      };
      return [evt];
    }

    // 10. File Edit
    if (
      rawType === "file_edit" ||
      rawType === "edit_file" ||
      rawType === "write_file" ||
      rawType === "patch_file" ||
      rawType === "file_change"
    ) {
      let editUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        editUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (editUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const filePath = String(p.filePath || p.file_path || p.file || p.path || "unknown_file");
      const operation = (
        p.operation === "create" ||
        p.operation === "update" ||
        p.operation === "delete" ||
        p.operation === "patch"
          ? p.operation
          : "update"
      ) as "create" | "update" | "delete" | "patch";
      const patch = typeof p.patch === "string" ? p.patch : undefined;
      const diffStats: FileDiffStats | undefined =
        typeof p.diffStats === "object" && p.diffStats !== null
          ? (p.diffStats as FileDiffStats)
          : typeof p.diff_stats === "object" && p.diff_stats !== null
            ? (p.diff_stats as FileDiffStats)
            : undefined;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedFileEditEvent = {
        ...header,
        type: "file_edit",
        filePath,
        operation,
        patch,
        diffStats,
        providerUsage: editUsage,
      };
      return [evt];
    }

    // 11. Error
    if (
      rawType === "error" ||
      rawType === "exception" ||
      rawType === "failure" ||
      rawType === "warning"
    ) {
      let errUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        errUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (errUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const message = String(p.message || p.msg || p.error || "Unknown error");
      const errorType = String(p.errorType || p.error_type || p.name || "CodexCliError");
      const stack = typeof p.stack === "string" ? p.stack : undefined;
      const recoverable = Boolean(p.recoverable ?? false);

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedErrorEvent = {
        ...header,
        type: "error",
        errorType,
        message,
        stack,
        recoverable,
        providerUsage: errUsage,
      };
      return [evt];
    }

    // 12. Compaction / Context Prune
    if (
      rawType === "compaction" ||
      rawType === "context_pruning" ||
      rawType === "context_compact" ||
      rawType === "prune_context"
    ) {
      let compUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        compUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (compUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const triggerReason = (
        p.triggerReason === "manual" ||
        p.triggerReason === "scheduled" ||
        p.triggerReason === "turn_threshold"
          ? p.triggerReason
          : "context_limit"
      ) as "context_limit" | "manual" | "scheduled" | "turn_threshold";

      const tokensBefore =
        typeof p.tokensBefore === "number"
          ? p.tokensBefore
          : typeof p.tokens_before === "number"
            ? p.tokens_before
            : 0;
      const tokensAfter =
        typeof p.tokensAfter === "number"
          ? p.tokensAfter
          : typeof p.tokens_after === "number"
            ? p.tokens_after
            : 0;
      const preservedContextSummary =
        typeof p.preservedContextSummary === "string"
          ? p.preservedContextSummary
          : typeof p.summary === "string"
            ? p.summary
            : undefined;

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedCompactionEvent = {
        ...header,
        type: "compaction",
        triggerReason,
        tokensBefore,
        tokensAfter,
        preservedContextSummary,
        providerUsage: compUsage,
      };
      return [evt];
    }

    // 13. Subagent Lifecycle & Branch Fork
    if (
      rawType === "subagent_lifecycle" ||
      rawType === "subagent_spawn" ||
      rawType === "subagent_end" ||
      rawType === "subagent_crash" ||
      rawType === "subagent"
    ) {
      let subUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        subUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (subUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const subagentId = String(
        p.subagentId || p.subagent_id || p.agentId || generateEventId("sub"),
      );
      const lifecycleType = (
        p.lifecycleType === "spawn" ||
        p.lifecycleType === "start" ||
        p.lifecycleType === "pause" ||
        p.lifecycleType === "resume" ||
        p.lifecycleType === "terminate" ||
        p.lifecycleType === "settle"
          ? p.lifecycleType
          : rawType === "subagent_spawn"
            ? "spawn"
            : rawType === "subagent_end" || rawType === "subagent_crash"
              ? "terminate"
              : "start"
      ) as "spawn" | "start" | "pause" | "resume" | "terminate" | "settle";

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedSubagentLifecycleEvent = {
        ...header,
        type: "subagent_lifecycle",
        subagentId,
        lifecycleType,
        parentId:
          typeof p.parentId === "string"
            ? p.parentId
            : typeof p.parentEventId === "string"
              ? p.parentEventId
              : undefined,
        role: typeof p.role === "string" ? p.role : undefined,
        reason:
          typeof p.reason === "string" ? p.reason : typeof p.goal === "string" ? p.goal : undefined,
        providerUsage: subUsage,
      };
      return [evt];
    }

    if (rawType === "branch_fork" || rawType === "fork" || rawType === "branch") {
      let forkUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        forkUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (forkUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const sourceSessionId = String(
        p.sourceSessionId || p.source_session_id || p.sessionId || this.sessionId,
      );
      const branchPointEventId = String(
        p.branchPointEventId ||
          p.branch_point_event_id ||
          this.lastEventId ||
          generateEventId("evt"),
      );

      const header = this.nextHeader(timestamp, rawEventId);
      const evt: NormalizedBranchForkEvent = {
        ...header,
        type: "branch_fork",
        sourceSessionId,
        branchPointEventId,
        forkReason: typeof p.forkReason === "string" ? p.forkReason : undefined,
        branchName: typeof p.branchName === "string" ? p.branchName : undefined,
        providerUsage: forkUsage,
      };
      return [evt];
    }

    // 14. Unknown Passthrough Fallback / Generic Record
    let passthroughUsage: ProviderReportedUsage | undefined;
    if (turnUsageRec) {
      passthroughUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
      if (passthroughUsage) {
        this.hasEmittedTurnUsage = true;
      }
    } else if (cumUsageRec) {
      this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
    }

    const header = this.nextHeader(timestamp, rawEventId);
    const unknownEvt: NormalizedUnknownPassthroughEvent = {
      ...header,
      type: "unknown_passthrough",
      rawEventType: rawType || "unknown",
      rawPayload: p,
      providerUsage: passthroughUsage,
    };
    return [unknownEvt];
  }
}

/**
 * Convenience function to decode a single Codex record.
 */
export function decodeCodexRecord(
  raw: string | Record<string, unknown>,
  options?: CodexDecoderOptions,
): NormalizedSessionEvent[] {
  const decoder = new CodexSessionDecoder(options);
  return decoder.decodeRecord(raw);
}

/**
 * Convenience function to decode an entire transcript or file content.
 */
export function decodeCodexTranscript(
  transcript: string | Array<string | Record<string, unknown>>,
  options?: CodexDecoderOptions,
): NormalizedSessionEvent[] {
  const decoder = new CodexSessionDecoder(options);
  return decoder.decodeTranscript(transcript);
}

/**
 * HarnessRecordDecoder implementation for Codex CLI rollouts and streaming records.
 */
export class CodexRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "codex-cli";
  readonly decoderVersion = "1.0.0";
  private readonly sessions = new Map<string, CodexSessionDecoder>();

  /**
   * Returns true if this decoder can handle the given raw harness record.
   */
  canDecode(record: RawHarnessRecord): boolean {
    if (!record) {
      return false;
    }
    if (
      record.harnessId === "codex-cli" ||
      record.harnessId === "codex" ||
      record.harnessId === "*"
    ) {
      return true;
    }

    // Try inspecting payload structure
    let payload: unknown = record.rawPayload;
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          payload = JSON.parse(trimmed);
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }

    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      if (
        rec.harness === "codex-cli" ||
        rec.harness === "codex" ||
        rec.harnessName === "codex-cli" ||
        rec.harnessName === "codex" ||
        rec.harnessId === "codex-cli" ||
        rec.harnessId === "codex"
      ) {
        return true;
      }

      // If harnessId is explicitly set to another specific harness, do not claim it
      if (
        record.harnessId &&
        record.harnessId !== "codex-cli" &&
        record.harnessId !== "codex" &&
        record.harnessId !== "*" &&
        record.harnessId !== "generic" &&
        record.harnessId !== "unknown"
      ) {
        return false;
      }

      return (
        typeof rec.type === "string" ||
        typeof rec.event === "string" ||
        typeof rec.role === "string"
      );
    }

    return false;
  }
  /**
   * Extracts authoritative provider-reported usage from a Codex event payload or metadata.
   */
  extractProviderUsage(
    obj: Record<string, unknown>,
    fallbackModel?: string,
  ): ProviderReportedUsage | undefined {
    const turnUsage = getTurnUsageRecord(obj);
    if (turnUsage) {
      return buildProviderUsage(turnUsage, obj, fallbackModel ?? "codex-cli-transcript-v1");
    }
    const cumUsage = getCumulativeUsageRecord(obj);
    if (cumUsage) {
      return buildProviderUsage(cumUsage, obj, fallbackModel ?? "codex-cli-cumulative-v1");
    }
    return undefined;
  }

  /**
   * Resets or clears the decoder session state for a given sessionId, or all sessions.
   */
  resetSession(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.clear();
    }
  }

  /**
   * Decodes a single RawHarnessRecord into zero or more IntermediateSessionEvents.
   */
  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    if (!record) {
      return [];
    }

    let payload: Record<string, unknown>;
    if (typeof record.rawPayload === "string") {
      const trimmed = record.rawPayload.trim();
      if (!trimmed) {
        return [];
      }
      try {
        payload = JSON.parse(trimmed);
      } catch {
        const sessionId = record.sessionId || context?.sessionId || "session-1";
        const sequenceNumber = record.sequenceNumber ?? record.cursor?.sequence ?? 1;
        const timestamp = record.timestamp || new Date().toISOString();
        return [
          {
            schemaVersion: DEFAULT_SCHEMA_VERSION,
            sessionId,
            timestamp,
            causalRef: {
              parentId: (context?.parentEventId as string | undefined) ?? null,
              causalSequence: sequenceNumber,
            },
            redaction: {
              isRedacted: false,
              redactedFields: [],
              redactionStrategy: "none",
              scrubbedPatterns: [],
            },
            type: "unknown_passthrough",
            rawEventType: "unparseable_string",
            rawPayload: { raw: trimmed },
          },
        ];
      }
    } else if (typeof record.rawPayload === "object" && record.rawPayload !== null) {
      payload = record.rawPayload as Record<string, unknown>;
    } else {
      return [];
    }

    const sessionId =
      (typeof payload.sessionId === "string"
        ? payload.sessionId
        : typeof payload.session_id === "string"
          ? payload.session_id
          : undefined) ??
      record.sessionId ??
      context?.sessionId ??
      "session-1";

    const workspaceId =
      (typeof payload.workspaceId === "string"
        ? payload.workspaceId
        : typeof payload.workspace_id === "string"
          ? payload.workspace_id
          : undefined) ??
      (typeof record.metadata?.workspaceId === "string"
        ? (record.metadata.workspaceId as string)
        : typeof record.metadata?.workspace_id === "string"
          ? (record.metadata.workspace_id as string)
          : undefined) ??
      (typeof context?.workspaceId === "string"
        ? (context.workspaceId as string)
        : typeof context?.metadata?.workspaceId === "string"
          ? (context.metadata.workspaceId as string)
          : undefined);

    let sessionDecoder = this.sessions.get(sessionId);
    if (!sessionDecoder) {
      sessionDecoder = new CodexSessionDecoder({
        sessionId,
        workspaceId,
        initialSequence:
          record.sequenceNumber !== undefined && record.sequenceNumber > 0
            ? record.sequenceNumber
            : context?.lastCausalSequence !== undefined
              ? context.lastCausalSequence + 1
              : 1,
      });
      this.sessions.set(sessionId, sessionDecoder);
    }

    // Set fallback timestamp and metadata on payload if not present
    const timestamp =
      payload.timestamp ||
      payload.created_at ||
      payload.createdAt ||
      payload.time ||
      record.timestamp;

    const mergedMetadata: Record<string, unknown> = {
      ...(typeof payload.metadata === "object" && payload.metadata !== null
        ? (payload.metadata as Record<string, unknown>)
        : {}),
      ...(record.metadata ?? {}),
      ...(context?.metadata ?? {}),
    };

    const effectivePayload: Record<string, unknown> = {
      ...payload,
      ...(timestamp && !payload.timestamp ? { timestamp } : {}),
      ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
      ...(workspaceId && !payload.workspaceId ? { workspaceId } : {}),
    };

    const events = sessionDecoder.decodeRecord(effectivePayload);
    return events as IntermediateSessionEvent[];
  }
}
