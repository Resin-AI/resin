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
import { NormalizedSessionEventSchema, ProviderReportedUsageSchema } from "@resin/contracts";
import {
  type HarnessRecordDecoder,
  type IntermediateSessionEvent,
  type RawHarnessRecord,
  RawHarnessRecordSchema,
  type RecordDecoderContext,
} from "@resin/harness-contracts";
import { z } from "zod";

export const DEFAULT_SCHEMA_VERSION = "1.0.0";

export const CodexTranscriptValueSchema: z.ZodType<CodexTranscriptValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(CodexTranscriptValueSchema),
    z.record(CodexTranscriptValueSchema),
  ]),
);

export type CodexTranscriptValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CodexTranscriptValue[]
  | { [key: string]: CodexTranscriptValue };

export interface CodexTranscriptPayload {
  [key: string]: CodexTranscriptValue;
}

export const CodexTranscriptPayloadSchema: z.ZodType<CodexTranscriptPayload> = z.record(
  CodexTranscriptValueSchema,
);
export function asString(value: CodexTranscriptValue | undefined | null): string | undefined {
  return value !== undefined && value !== null && String(value) === value ? value : undefined;
}

export function asNumber(value: CodexTranscriptValue | undefined | null): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value)
    ? Number(value)
    : undefined;
}

export function isCodexTranscriptPayload(
  value: CodexTranscriptValue | undefined | null,
): value is CodexTranscriptPayload {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function asObject(
  value: CodexTranscriptValue | undefined | null,
): CodexTranscriptPayload | undefined {
  return isCodexTranscriptPayload(value) ? value : undefined;
}

export function asArray(
  value: CodexTranscriptValue | undefined | null,
): CodexTranscriptValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
/**
 * Options for configuring the Codex session decoder.
 */
export interface CodexDecoderOptions {
  sessionId?: string;
  initialSequence?: number;
  lastCausalSequence?: number;
  workspaceId?: string;
}
const CodexDecoderOptionsSchema: z.ZodType<CodexDecoderOptions> = z.object({
  sessionId: z.string().optional(),
  initialSequence: z.number().optional(),
  lastCausalSequence: z.number().optional(),
  workspaceId: z.string().optional(),
});

/**
 * Helper to generate unique event IDs.
 */
function generateEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Parses and normalizes timestamps into strict ISO 8601 UTC strings.
 */
function parseTimestamp(rawTs?: CodexTranscriptValue): string {
  const str = asString(rawTs);
  if (str !== undefined) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } else {
    const num = asNumber(rawTs);
    if (num !== undefined) {
      // Check if seconds vs milliseconds
      const ms = num < 1e11 ? num * 1000 : num;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
  }
  return new Date().toISOString();
}
/**
 * Normalizes tool call parameters to CodexTranscriptPayload.
 */
function parseToolParameters(
  rawParams: CodexTranscriptValue | undefined | null,
): CodexTranscriptPayload {
  const obj = asObject(rawParams);
  if (obj !== undefined) {
    return obj;
  }
  const str = asString(rawParams);
  if (str !== undefined) {
    try {
      // SAFETY: JSON.parse output is an arbitrary JSON value matching the CodexTranscriptValue union before asObject validation.
      const parsed = JSON.parse(str) as CodexTranscriptValue;
      const parsedObj = asObject(parsed);
      if (parsedObj !== undefined) {
        return parsedObj;
      }
    } catch {
      return { raw: rawParams ?? null };
    }
  }
  return {};
}

/**
 * Parses a non-negative integer or returns undefined.
 */
function parseNonNegativeInt(val: CodexTranscriptValue | undefined | null): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (Number.isInteger(val) && Number(val) >= 0) {
    return Number(val);
  }
  const str = asString(val);
  if (str !== undefined) {
    const trimmed = str.trim();
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
 * Normalizes cost strings or numbers into integer micro-USD ($0.000001 = 1 micro-USD).
 */
function parseCostMicroUsd(raw: CodexTranscriptPayload): number | undefined {
  const directMicro = parseNonNegativeInt(raw.cost_micro_usd ?? raw.costMicroUsd);
  if (directMicro !== undefined) {
    return directMicro;
  }

  const directUsd = raw.costUsd ?? raw.cost_usd ?? raw.cost;
  const numUsd = asNumber(directUsd);
  if (numUsd !== undefined && numUsd >= 0) {
    return Math.round(numUsd * 1_000_000);
  }
  const strUsd = asString(directUsd);
  if (strUsd !== undefined) {
    const trimmed = strUsd.trim().replace(/^\$/, "");
    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 0) {
      return Math.round(num * 1_000_000);
    }
  }

  const directCents = raw.cost_cents ?? raw.costCents;
  const numCents = asNumber(directCents);
  if (numCents !== undefined && numCents >= 0) {
    return Math.round(numCents * 10_000);
  }

  return undefined;
}

/**
 * Normalizes duration strings or numbers into integer milliseconds.
 */
function parseDurationMs(raw: CodexTranscriptPayload): number | undefined {
  const directMs = parseNonNegativeInt(
    raw.duration_ms ?? raw.durationMs ?? raw.executionDurationMs ?? raw.execution_duration_ms,
  );
  if (directMs !== undefined) {
    return directMs;
  }

  const directSeconds = raw.duration_seconds ?? raw.durationSeconds ?? raw.duration;
  const numSec = asNumber(directSeconds);
  if (numSec !== undefined && numSec >= 0) {
    return Math.round(numSec * 1000);
  }
  const strSec = asString(directSeconds);
  if (strSec !== undefined) {
    const trimmed = strSec.trim().replace(/s$/i, "");
    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 0) {
      return Math.round(num * 1000);
    }
  }

  return undefined;
}
interface CodexExtractedTokens {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  hasAnyMetrics: boolean;
}

/**
 * Extracts and maps token count components from various Codex naming conventions.
 */
function extractTokenComponents(raw: CodexTranscriptPayload): CodexExtractedTokens {
  const promptDetails =
    asObject(raw.prompt_tokens_details) ??
    asObject(raw.promptTokensDetails) ??
    asObject(raw.input_tokens_details) ??
    asObject(raw.inputTokensDetails);

  const completionDetails =
    asObject(raw.completion_tokens_details) ??
    asObject(raw.completionTokensDetails) ??
    asObject(raw.output_tokens_details) ??
    asObject(raw.outputTokensDetails);

  const tokensObj = asObject(raw.tokens);

  const inputTokens =
    parseNonNegativeInt(raw.input_tokens) ??
    parseNonNegativeInt(raw.inputTokens) ??
    parseNonNegativeInt(raw.prompt_tokens) ??
    parseNonNegativeInt(raw.promptTokens) ??
    parseNonNegativeInt(raw.input) ??
    parseNonNegativeInt(tokensObj?.input_tokens) ??
    parseNonNegativeInt(tokensObj?.prompt_tokens);

  const outputTokens =
    parseNonNegativeInt(raw.output_tokens) ??
    parseNonNegativeInt(raw.outputTokens) ??
    parseNonNegativeInt(raw.completion_tokens) ??
    parseNonNegativeInt(raw.completionTokens) ??
    parseNonNegativeInt(raw.output) ??
    parseNonNegativeInt(tokensObj?.output_tokens) ??
    parseNonNegativeInt(tokensObj?.completion_tokens);

  const reasoningTokens =
    parseNonNegativeInt(raw.reasoning_tokens) ??
    parseNonNegativeInt(raw.reasoningTokens) ??
    parseNonNegativeInt(raw.reasoning) ??
    parseNonNegativeInt(completionDetails?.reasoning_tokens) ??
    parseNonNegativeInt(completionDetails?.reasoningTokens) ??
    parseNonNegativeInt(completionDetails?.reasoning);

  const cachedInputTokens =
    parseNonNegativeInt(raw.cached_input_tokens) ??
    parseNonNegativeInt(raw.cachedInputTokens) ??
    parseNonNegativeInt(raw.cached_tokens) ??
    parseNonNegativeInt(raw.cachedTokens) ??
    parseNonNegativeInt(raw.cached) ??
    parseNonNegativeInt(promptDetails?.cached_tokens) ??
    parseNonNegativeInt(promptDetails?.cachedTokens) ??
    parseNonNegativeInt(promptDetails?.cached);

  const totalTokens =
    parseNonNegativeInt(raw.total_tokens) ??
    parseNonNegativeInt(raw.totalTokens) ??
    parseNonNegativeInt(raw.total) ??
    parseNonNegativeInt(tokensObj?.total_tokens);

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
 * Checks if a payload or usage record explicitly claims to be cumulative.
 */
function isCumulativeObject(obj: CodexTranscriptValue | undefined | null): boolean {
  const rec = asObject(obj);
  if (!rec) return false;
  if (
    rec.is_cumulative === true ||
    rec.isCumulative === true ||
    rec.type === "cumulative_usage" ||
    rec.type === "cumulative" ||
    rec.kind === "cumulative" ||
    rec.accounting_mode === "cumulative" ||
    rec.mode === "cumulative"
  ) {
    return true;
  }
  return false;
}

/**
 * Finds per-turn / last-token usage in a raw payload.
 */
function getTurnUsageRecord(p: CodexTranscriptPayload): CodexTranscriptPayload | undefined {
  // 1. Explicit turn / delta usage fields
  const turnUsage = asObject(p.turn_usage) ?? asObject(p.turnUsage);
  if (turnUsage) return turnUsage;

  const lastTurnUsage = asObject(p.last_turn_usage) ?? asObject(p.lastTurnUsage);
  if (lastTurnUsage && !isCumulativeObject(lastTurnUsage)) return lastTurnUsage;

  const lastTurn = asObject(p.last_turn);
  if (lastTurn && !isCumulativeObject(lastTurn)) return lastTurn;

  // 2. Direct usage fields (only if not cumulative)
  const candidateKeys = [
    "usage",
    "token_usage",
    "tokenUsage",
    "response_usage",
    "responseUsage",
    "provider_usage",
    "providerUsage",
    "metrics",
  ];

  for (const key of candidateKeys) {
    const val = asObject(p[key]);
    if (val && !isCumulativeObject(val)) {
      return val;
    }
  }

  // 3. Nested container objects
  const parentKeys = ["response", "result", "payload", "data", "message", "step"];
  for (const parentKey of parentKeys) {
    const parent = asObject(p[parentKey]);
    if (parent) {
      for (const key of candidateKeys) {
        const val = asObject(parent[key]);
        if (val && !isCumulativeObject(val)) {
          return val;
        }
      }
    }
  }

  // 4. If payload itself has token fields and is not cumulative
  if (!isCumulativeObject(p)) {
    const components = extractTokenComponents(p);
    if (components.hasAnyMetrics) {
      return p;
    }
  }

  return undefined;
}

/**
 * Finds cumulative / session-wide usage in a raw payload.
 */
function getCumulativeUsageRecord(p: CodexTranscriptPayload): CodexTranscriptPayload | undefined {
  const candidateKeys = [
    "cumulative_usage",
    "cumulativeUsage",
    "total_usage",
    "totalUsage",
    "session_usage",
    "sessionUsage",
    "aggregate_usage",
    "aggregateUsage",
  ];

  for (const key of candidateKeys) {
    const val = asObject(p[key]);
    if (val) {
      return val;
    }
  }

  // Check if standard usage fields are explicitly flagged as cumulative
  const standardKeys = ["usage", "token_usage", "tokenUsage", "provider_usage", "providerUsage"];
  for (const key of standardKeys) {
    const val = asObject(p[key]);
    if (val && isCumulativeObject(val)) {
      return val;
    }
  }

  // If payload itself is explicitly cumulative
  if (isCumulativeObject(p)) {
    return p;
  }

  return undefined;
}

/**
 * Constructs an authoritative ProviderReportedUsage object.
 */
function buildProviderUsage(
  rawUsage: CodexTranscriptPayload,
  rawPayload: CodexTranscriptPayload,
  accountingVersion = "codex-cli-transcript-v1",
): ProviderReportedUsage | undefined {
  const rawProvider = asString(rawPayload.provider)?.trim() || asString(rawUsage.provider)?.trim();
  const provider = rawProvider || "openai";

  const rawModel =
    asString(rawPayload.model)?.trim() ||
    asString(rawUsage.model)?.trim() ||
    asString(rawPayload.model_id)?.trim() ||
    asString(rawPayload.modelId)?.trim() ||
    asString(rawUsage.model_id)?.trim() ||
    asString(rawUsage.modelId)?.trim();
  const model = rawModel || undefined;

  const costMicroUsd = parseCostMicroUsd(rawUsage) ?? parseCostMicroUsd(rawPayload);
  const durationMs = parseDurationMs(rawUsage) ?? parseDurationMs(rawPayload);

  const explicitAvailability =
    asString(rawUsage.availability) ??
    asString(rawPayload.availability) ??
    asString(rawUsage.provider_usage_availability) ??
    asString(rawPayload.provider_usage_availability);

  if (
    explicitAvailability === "unavailable" ||
    rawUsage.unavailable === true ||
    rawPayload.unavailable === true
  ) {
    const usageObj: ProviderReportedUsage = {
      provider,
      accountingVersion,
      availability: "unavailable",
    };
    if (model) usageObj.model = model;
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

  const payloadTokens = extractTokenComponents(rawPayload);

  const finalInputTokens = inputTokens ?? payloadTokens.inputTokens;
  const finalOutputTokens = outputTokens ?? payloadTokens.outputTokens;
  const finalReasoningTokens = reasoningTokens ?? payloadTokens.reasoningTokens;
  const finalCachedInputTokens = cachedInputTokens ?? payloadTokens.cachedInputTokens;
  const finalTotalTokens = totalTokens ?? payloadTokens.totalTokens;

  const hasMetrics =
    hasAnyMetrics ||
    payloadTokens.hasAnyMetrics ||
    costMicroUsd !== undefined ||
    durationMs !== undefined;

  if (!hasMetrics) {
    if (explicitAvailability === "complete" || explicitAvailability === "partial") {
      const usageObj: ProviderReportedUsage = {
        provider,
        accountingVersion,
        availability: explicitAvailability,
      };
      if (model) usageObj.model = model;
      const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
      return parsed.success ? parsed.data : undefined;
    }
    return undefined;
  }

  const availability: "complete" | "partial" =
    explicitAvailability === "partial"
      ? "partial"
      : explicitAvailability === "complete" || finalTotalTokens !== undefined
        ? "complete"
        : "partial";

  const usageObj: ProviderReportedUsage = {
    provider,
    accountingVersion,
    availability,
  };
  if (model) usageObj.model = model;
  if (finalInputTokens !== undefined) usageObj.inputTokens = finalInputTokens;
  if (finalOutputTokens !== undefined) usageObj.outputTokens = finalOutputTokens;
  if (finalReasoningTokens !== undefined) usageObj.reasoningTokens = finalReasoningTokens;
  if (finalCachedInputTokens !== undefined) usageObj.cachedInputTokens = finalCachedInputTokens;
  if (finalTotalTokens !== undefined) usageObj.totalTokens = finalTotalTokens;
  if (costMicroUsd !== undefined) usageObj.costMicroUsd = costMicroUsd;
  if (durationMs !== undefined) usageObj.durationMs = durationMs;

  const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
  return parsed.success ? parsed.data : undefined;
}

export interface BaseNormalizedEventHeader {
  eventId: string;
  sessionId: string;
  timestamp: string;
  schemaVersion: string;
  harnessId: string;
  workspaceId: string;
  causalRef: CausalRef;
  redaction: RedactionMeta;
  metadata?: CodexTranscriptPayload;
}

/**
 * Stateful session-level decoder for Codex CLI transcript events.
 */
export class CodexSessionDecoder {
  readonly sessionId: string;
  readonly workspaceId: string;
  private sequenceCounter: number;
  private lastEventId: string | null = null;
  private toolCallSeq = 0;
  private callMap = new Map<string, { toolName: string; toolCallId: string; eventId: string }>();
  private hasEmittedTurnUsage = false;
  private lastCumulativeUsage?: {
    rawUsage: CodexTranscriptPayload;
    rawPayload: CodexTranscriptPayload;
  };
  private currentMetadata?: CodexTranscriptPayload;

  constructor(options: CodexDecoderOptions = {}) {
    this.sessionId = options.sessionId || generateEventId("sess");
    this.workspaceId = options.workspaceId || "default";
    this.sequenceCounter =
      options.initialSequence !== undefined
        ? options.initialSequence - 1
        : (options.lastCausalSequence ?? 0);
  }

  private buildCausalRef(eventId: string): CausalRef {
    const causalSequence = ++this.sequenceCounter;
    const parentId = this.lastEventId;
    this.lastEventId = eventId;
    return {
      parentId,
      causalSequence,
    };
  }

  private emitHeader(
    type: NormalizedSessionEvent["type"],
    timestamp?: string,
    rawEventId?: string,
    metadataOverride?: CodexTranscriptPayload,
  ): BaseNormalizedEventHeader {
    const eventId = asString(rawEventId) ?? generateEventId("evt");
    const ts = parseTimestamp(timestamp);
    const meta = metadataOverride ?? this.currentMetadata;
    const header: BaseNormalizedEventHeader = {
      eventId,
      sessionId: this.sessionId,
      timestamp: ts,
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      harnessId: "codex-cli",
      workspaceId: this.workspaceId,
      causalRef: this.buildCausalRef(eventId),
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
      },
    };
    if (meta && Object.keys(meta).length > 0) {
      header.metadata = meta;
    }
    return header;
  }

  private nextHeader(timestamp?: string, rawEventId?: string): BaseNormalizedEventHeader {
    return this.emitHeader("message", timestamp, rawEventId);
  }

  decodeRecord(raw: string | CodexTranscriptPayload): NormalizedSessionEvent[] {
    let payload: CodexTranscriptPayload;
    const rawStr = asString(raw);
    if (rawStr !== undefined) {
      const trimmed = rawStr.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        const obj = asObject(parsed);
        if (!obj) return [];
        payload = obj;
      } catch {
        return [
          {
            ...this.emitHeader("unknown_passthrough"),
            type: "unknown_passthrough",
            rawEventType: "unparseable_json",
            rawPayload: { unparseable: trimmed },
          },
        ];
      }
    } else {
      const obj = asObject(raw);
      if (!obj) {
        return [
          {
            ...this.emitHeader("unknown_passthrough"),
            type: "unknown_passthrough",
            rawEventType: "invalid_payload_shape",
            rawPayload: { rawPayload: JSON.stringify(raw) },
          },
        ];
      }
      payload = obj;
    }
    return this.normalizePayload(payload);
  }

  decodeTranscript(
    transcript: string | Array<string | CodexTranscriptPayload>,
  ): NormalizedSessionEvent[] {
    const str = asString(transcript);
    if (str !== undefined) {
      const lines = str.split(/\r?\n/);
      const events: NormalizedSessionEvent[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        events.push(...this.decodeRecord(trimmed));
      }
      return events;
    }

    if (Array.isArray(transcript)) {
      const events: NormalizedSessionEvent[] = [];
      for (const item of transcript) {
        events.push(...this.decodeRecord(item));
      }
      return events;
    }

    return [];
  }

  private normalizePayload(p: CodexTranscriptPayload): NormalizedSessionEvent[] {
    const events: NormalizedSessionEvent[] = [];

    const metaObj = asObject(p.metadata);
    if (metaObj) {
      this.currentMetadata = metaObj;
    }

    const rawSessionId = asString(p.sessionId) ?? asString(p.session_id);

    const timestamp =
      asString(p.timestamp) ?? asString(p.created_at) ?? asString(p.time) ?? asString(p.datetime);

    const rawEventId = asString(p.eventId) ?? asString(p.event_id) ?? asString(p.id);

    const rawType = String(
      asString(p.type) ??
        asString(p.event) ??
        asString(p.role) ??
        asString(p.item_type) ??
        asString(p.kind) ??
        "",
    ).toLowerCase();

    const turnUsageRec = getTurnUsageRecord(p);
    const cumUsageRec = getCumulativeUsageRecord(p);

    // 1. Session Lifecycle Events
    if (
      rawType === "session_start" ||
      rawType === "session_init" ||
      rawType === "session_started" ||
      rawType === "session_end" ||
      rawType === "session_completed" ||
      rawType === "session_terminated" ||
      rawType === "session_stop" ||
      rawType === "session_crash" ||
      rawType === "session_lifecycle"
    ) {
      const rawLType = (asString(p.lifecycleType) ?? asString(p.lifecycle_type))?.toLowerCase();
      const isStart =
        rawType === "session_start" ||
        rawType === "session_init" ||
        rawType === "session_started" ||
        rawLType === "start";
      const isCrash = rawType === "session_crash" || rawLType === "crash";
      const lifecycleType: "start" | "pause" | "resume" | "end" | "crash" =
        rawLType === "start" ||
        rawLType === "pause" ||
        rawLType === "resume" ||
        rawLType === "end" ||
        rawLType === "crash"
          ? rawLType
          : isStart
            ? "start"
            : isCrash
              ? "crash"
              : "end";
      let lifecycleUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        lifecycleUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (lifecycleUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (!isStart) {
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

      const header = this.emitHeader("session_lifecycle", timestamp, rawEventId);
      const exitReason = asString(p.exitReason) ?? asString(p.reason);
      const harnessName = asString(p.harnessName) ?? "codex-cli";
      const workspaceId = asString(p.workspaceId) ?? this.workspaceId;

      const evt: NormalizedSessionLifecycleEvent = {
        ...header,
        type: "session_lifecycle",
        lifecycleType,
        harnessName,
        workspaceId,
      };
      if (exitReason !== undefined) {
        evt.exitReason = exitReason;
      }
      if (lifecycleUsage) {
        evt.providerUsage = lifecycleUsage;
      }
      events.push(evt);
      return events;
    }

    // 2. Model Reasoning / Thought Events
    if (
      rawType === "reasoning" ||
      rawType === "thinking" ||
      rawType === "thought" ||
      rawType === "model_reasoning"
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

      const thought =
        asString(p.reasoningContent) ??
        asString(p.reasoning_content) ??
        asString(p.content) ??
        asString(p.text) ??
        asString(p.thought) ??
        "";

      const header = this.emitHeader("model_reasoning", timestamp, rawEventId);
      const signature = asString(p.signature);
      const model = asString(p.model);
      const evt: NormalizedModelReasoningEvent = {
        ...header,
        type: "model_reasoning",
        reasoningContent: thought,
      };
      if (signature) {
        evt.signature = signature;
      }
      if (model) {
        evt.model = model;
      }
      if (reasoningUsage) {
        evt.providerUsage = reasoningUsage;
      }
      events.push(evt);
      return events;
    }

    // 3. User Message / Prompt Events
    if (
      rawType === "user_message" ||
      rawType === "user" ||
      rawType === "prompt" ||
      rawType === "query"
    ) {
      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      const strContent = asString(p.content);
      const strText = asString(p.text);
      const strPrompt = asString(p.prompt);
      const strQuery = asString(p.query);
      const strInput = asString(p.input);

      if (strContent !== undefined) {
        content = strContent;
      } else if (strText !== undefined) {
        content = strText;
      } else if (strPrompt !== undefined) {
        content = strPrompt;
      } else if (strQuery !== undefined) {
        content = strQuery;
      } else if (strInput !== undefined) {
        content = strInput;
      } else {
        const partsArray = asArray(p.content);
        if (partsArray) {
          content = partsArray.map((part) => asString(asObject(part)?.text) ?? "").join("\n");
        } else {
          const msgObj = asObject(p.message);
          if (msgObj) {
            content =
              asString(msgObj.content) ??
              asString(msgObj.text) ??
              asString(msgObj.prompt) ??
              JSON.stringify(msgObj);
          }
        }
      }

      const header = this.nextHeader(timestamp, rawEventId);
      const userModel = asString(p.model);
      const userEvt: NormalizedMessageEvent = {
        ...header,
        type: "message",
        role: "user",
        content,
      };
      if (contentParts) {
        userEvt.contentParts = contentParts;
      }
      if (userModel) {
        userEvt.model = userModel;
      }
      events.push(userEvt);
      return events;
    }
    // 4. Assistant Message / Completion Events
    if (rawType === "assistant_message" || rawType === "assistant" || rawType === "agent_turn") {
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

      const strContent = asString(p.content);
      const strText = asString(p.text);

      if (strContent !== undefined) {
        content = strContent;
      } else if (strText !== undefined) {
        content = strText;
      } else {
        const partsArray = asArray(p.content);
        if (partsArray) {
          content = partsArray.map((part) => asString(asObject(part)?.text) ?? "").join("\n");
        } else {
          const msgObj = asObject(p.message);
          if (msgObj) {
            content = asString(msgObj.content) ?? JSON.stringify(msgObj);
          }
        }
      }

      // Check for inline tool_calls array
      const toolCalls = asArray(p.tool_calls) ?? asArray(p.toolCalls);

      if (content || !toolCalls || toolCalls.length === 0) {
        const header = this.nextHeader(timestamp, rawEventId);
        const assistantModel = asString(p.model);
        const msgEvt: NormalizedMessageEvent = {
          ...header,
          type: "message",
          role: "assistant",
          content,
        };
        if (contentParts) {
          msgEvt.contentParts = contentParts;
        }
        if (assistantModel) {
          msgEvt.model = assistantModel;
        }
        if (assistantUsage) {
          msgEvt.providerUsage = assistantUsage;
        }
        events.push(msgEvt);
      }

      if (toolCalls && toolCalls.length > 0) {
        let isFirstEventInTurn = !content;
        for (const tc of toolCalls) {
          const tcObj = asObject(tc);
          if (!tcObj) continue;
          const fnObj = asObject(tcObj.function) ?? tcObj;

          const toolName = String(
            asString(fnObj.name) ??
              asString(tcObj.name) ??
              asString(tcObj.toolName) ??
              "unknown_tool",
          );
          const toolCallId = String(
            asString(tcObj.id) ??
              asString(tcObj.tool_call_id) ??
              asString(tcObj.call_id) ??
              generateEventId("call"),
          );
          const rawArgs = fnObj.arguments ?? fnObj.params ?? tcObj.input ?? {};
          const parameters = parseToolParameters(rawArgs);

          const header = this.emitHeader("tool_call", timestamp);
          this.callMap.set(toolCallId, {
            toolName,
            toolCallId,
            eventId: header.eventId,
          });

          const candidateRef = asString(tcObj.candidateRef);
          const toolCallEvt: NormalizedToolCallEvent = {
            ...header,
            type: "tool_call",
            callId: toolCallId,
            toolName,
            parameters,
            isShadow: false,
          };
          if (candidateRef) {
            toolCallEvt.candidateRef = candidateRef;
          }
          if (isFirstEventInTurn && assistantUsage) {
            toolCallEvt.providerUsage = assistantUsage;
          }
          events.push(toolCallEvt);
          isFirstEventInTurn = false;
        }
      }

      return events;
    }

    // 5. System Message Events
    if (rawType === "system_message" || rawType === "system" || rawType === "developer_message") {
      const rawRole = asString(p.role)?.toLowerCase();
      const role: "system" | "user" | "assistant" =
        rawRole === "user" || rawRole === "assistant" ? rawRole : "system";

      let content = "";
      let contentParts: MessageContentPart[] | undefined;

      const strContent = asString(p.content);
      if (strContent !== undefined) {
        content = strContent;
      } else {
        const partsArray = asArray(p.content);
        if (partsArray) {
          content = partsArray.map((part) => asString(asObject(part)?.text) ?? "").join("\n");
        } else {
          const msgObj = asObject(p.message);
          if (msgObj) {
            content = asString(msgObj.content) ?? JSON.stringify(msgObj);
          }
        }
      }

      const header = this.nextHeader(timestamp, rawEventId);
      const sysModel = asString(p.model);
      const sysEvt: NormalizedMessageEvent = {
        ...header,
        type: "message",
        role,
        content,
      };
      if (contentParts) {
        sysEvt.contentParts = contentParts;
      }
      if (sysModel) {
        sysEvt.model = sysModel;
      }
      events.push(sysEvt);
      return events;
    }

    // 6. Tool Discovery Events
    if (
      rawType === "tool_discovery" ||
      rawType === "tools_discovered" ||
      rawType === "tools_registered" ||
      rawType === "mcp_tools" ||
      (Array.isArray(p.tools) && rawType === "tools")
    ) {
      const rawTools = asArray(p.tools) ?? asArray(p.tool_list) ?? [];
      const tools: DiscoveredToolEntry[] = rawTools.map((t: CodexTranscriptValue) => {
        const item = asObject(t) ?? {};
        const paramsObj = asObject(item.parameters) ?? asObject(item.inputSchema) ?? {};
        return {
          name: String(asString(item.name) || asString(item.id) || "unknown_tool"),
          inputSchema: paramsObj,
          provider: asString(item.provider) || "codex-cli",
        };
      });
      const header = this.emitHeader("tool_discovery", timestamp, rawEventId);
      const provider = asString(p.provider) || "codex-cli";
      const rawSource = asString(p.source);
      const source: "mcp" | "builtin" | "dynamic" | "harness" =
        rawSource === "builtin" || rawSource === "dynamic" || rawSource === "harness"
          ? rawSource
          : "mcp";
      events.push({
        ...header,
        type: "tool_discovery",
        tools,
        provider,
        source,
      });
      return events;
    }

    // 7. Tool Call Events (standalone)
    if (
      rawType === "tool_call" ||
      rawType === "function_call" ||
      rawType === "action_call" ||
      rawType === "call"
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

      const fnObj = asObject(p.function) ?? p;
      const toolName = String(
        asString(fnObj.name) ??
          asString(p.name) ??
          asString(p.toolName) ??
          asString(p.tool_name) ??
          "unknown_tool",
      );
      const toolCallId = String(
        asString(p.callId) ??
          asString(p.call_id) ??
          asString(p.tool_call_id) ??
          asString(p.id) ??
          generateEventId("call"),
      );
      const rawArgs = fnObj.arguments ?? fnObj.params ?? p.input ?? p.args ?? {};
      const parameters = parseToolParameters(rawArgs);

      const header = this.emitHeader("tool_call", timestamp, rawEventId);
      this.callMap.set(toolCallId, {
        toolName,
        toolCallId,
        eventId: header.eventId,
      });

      const candidateRef = asString(p.candidateRef);
      const callEvt: NormalizedToolCallEvent = {
        ...header,
        type: "tool_call",
        callId: toolCallId,
        toolName,
        parameters,
        isShadow: false,
      };
      if (candidateRef) {
        callEvt.candidateRef = candidateRef;
      }
      if (callUsage) {
        callEvt.providerUsage = callUsage;
      }
      events.push(callEvt);
      return events;
    }

    // 8. Tool Result Events
    if (
      rawType === "tool_result" ||
      rawType === "function_result" ||
      rawType === "action_result" ||
      rawType === "tool_response" ||
      rawType === "result" ||
      rawType === "tool_error"
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
        asString(p.callId) ??
          asString(p.call_id) ??
          asString(p.tool_call_id) ??
          asString(p.id) ??
          generateEventId("call"),
      );
      const cached = this.callMap.get(callId);
      const toolName = String(
        asString(p.toolName) ??
          asString(p.tool_name) ??
          asString(p.name) ??
          cached?.toolName ??
          "unknown_tool",
      );

      const rawResult = p.result ?? p.output ?? p.content ?? p.data ?? p.response;
      const isError = Boolean(p.is_error || p.isError || p.error || rawType === "tool_error");
      const durationMs =
        asNumber(p.executionDurationMs) ?? asNumber(p.durationMs) ?? asNumber(p.duration_ms) ?? 0;

      const header = this.emitHeader("tool_result", timestamp, rawEventId);
      events.push({
        ...header,
        type: "tool_result",
        callId,
        toolName,
        result: rawResult ?? {},
        isError,
        executionDurationMs: durationMs,
        isShadow: false,
        providerUsage: resUsage,
      });
      return events;
    }

    // 9. Command Execution Events
    if (rawType === "command_exec" || rawType === "command" || rawType === "exec") {
      let cmdUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        cmdUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (cmdUsage) {
          this.hasEmittedTurnUsage = true;
        }
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const command = String(asString(p.command) ?? asString(p.cmd) ?? "");
      const argsArray = asArray(p.args);
      const args = argsArray ? argsArray.map((a) => asString(a) ?? String(a)) : [];
      const exitCode = asNumber(p.exitCode) ?? asNumber(p.exit_code) ?? 0;
      const stdout = asString(p.stdout) ?? asString(p.output);
      const stderr = asString(p.stderr);
      const durationMs = asNumber(p.durationMs) ?? asNumber(p.duration_ms) ?? 0;

      const header = this.emitHeader("command_exec", timestamp, rawEventId);
      events.push({
        ...header,
        type: "command_exec",
        command,
        args,
        cwd: asString(p.cwd),
        exitCode,
        stdout,
        stderr,
        durationMs,
        providerUsage: cmdUsage,
      });
      return events;
    }

    // 10. File Edit Events
    if (
      rawType === "file_edit" ||
      rawType === "patch_applied" ||
      rawType === "file_write" ||
      rawType === "file_created" ||
      rawType === "file_deleted"
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

      const filePath = String(
        asString(p.filePath) ?? asString(p.file_path) ?? asString(p.path) ?? asString(p.file) ?? "",
      );
      const rawOp = String(
        asString(p.operation) ?? asString(p.op) ?? asString(p.editType) ?? "update",
      ).toLowerCase();
      const operation: "create" | "update" | "delete" | "patch" =
        rawOp === "create" || rawOp === "delete" || rawOp === "patch" ? rawOp : "update";

      const patch = asString(p.patch) ?? asString(p.diff);
      const beforeHash = asString(p.beforeHash) ?? asString(p.before_hash);
      const afterHash = asString(p.afterHash) ?? asString(p.after_hash);
      const statsObj = asObject(p.diffStats) ?? asObject(p.diff_stats);
      const diffStats =
        statsObj &&
        asNumber(statsObj.linesAdded) !== undefined &&
        asNumber(statsObj.linesRemoved) !== undefined
          ? {
              linesAdded: asNumber(statsObj.linesAdded) || 0,
              linesRemoved: asNumber(statsObj.linesRemoved) || 0,
            }
          : undefined;

      const header = this.emitHeader("file_edit", timestamp, rawEventId);
      const editEvt: NormalizedFileEditEvent = {
        ...header,
        type: "file_edit",
        filePath,
        operation,
      };
      if (patch) {
        editEvt.patch = patch;
      }
      if (beforeHash) {
        editEvt.beforeHash = beforeHash;
      }
      if (afterHash) {
        editEvt.afterHash = afterHash;
      }
      if (diffStats) {
        editEvt.diffStats = diffStats;
      }
      if (editUsage) {
        editEvt.providerUsage = editUsage;
      }
      events.push(editEvt);
      return events;
    }

    if (rawType === "error" || rawType === "exception" || rawType === "runtime_error") {
      const errorType = String(
        asString(p.errorType) ??
          asString(p.error_type) ??
          asString(p.errorCode) ??
          asString(p.error_code) ??
          asString(p.code) ??
          "RUNTIME_ERROR",
      );
      const message = String(
        asString(p.errorMessage) ??
          asString(p.error_message) ??
          asString(p.message) ??
          asString(p.error) ??
          "Unknown error",
      );
      const recoverable = Boolean(p.recoverable ?? (p.fatal !== undefined ? !p.fatal : false));
      const stack = asString(p.stack);
      const details = asObject(p.details);

      const header = this.emitHeader("error", timestamp, rawEventId);
      const errEvt: NormalizedErrorEvent = {
        ...header,
        type: "error",
        errorType,
        message,
        recoverable,
      };
      if (stack) {
        errEvt.stack = stack;
      }
      if (details) {
        errEvt.details = details;
      }
      events.push(errEvt);
      return events;
    }

    if (rawType === "compaction" || rawType === "context_compaction" || rawType === "prune") {
      const rawReason =
        asString(p.triggerReason) ?? asString(p.trigger_reason) ?? asString(p.reason);
      const triggerReason: "context_limit" | "manual" | "scheduled" | "turn_threshold" =
        rawReason === "manual" || rawReason === "scheduled" || rawReason === "turn_threshold"
          ? rawReason
          : "context_limit";

      const tokensBefore =
        asNumber(p.tokensBefore) ??
        asNumber(p.tokens_before) ??
        asNumber(p.originalTokenCount) ??
        0;
      const tokensAfter =
        asNumber(p.tokensAfter) ?? asNumber(p.tokens_after) ?? asNumber(p.compactedTokenCount) ?? 0;
      const preservedContextSummary = asString(p.preservedContextSummary) ?? asString(p.summary);

      const header = this.emitHeader("compaction", timestamp, rawEventId);
      const compEvt: NormalizedCompactionEvent = {
        ...header,
        type: "compaction",
        triggerReason,
        tokensBefore,
        tokensAfter,
      };
      if (preservedContextSummary) {
        compEvt.preservedContextSummary = preservedContextSummary;
      }
      events.push(compEvt);
      return events;
    }

    // 13. Subagent Lifecycle Events
    if (
      rawType === "subagent_lifecycle" ||
      rawType === "subagent_spawn" ||
      rawType === "subagent_start" ||
      rawType === "subagent_end" ||
      rawType === "subagent_complete"
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
        asString(p.subagentId) ??
          asString(p.subagent_id) ??
          asString(p.agentId) ??
          generateEventId("subagent"),
      );

      const rawLType = String(
        asString(p.lifecycleType) ??
          asString(p.lifecycle_type) ??
          asString(p.action) ??
          (rawType.includes("spawn") ? "spawn" : rawType.includes("start") ? "start" : "settle"),
      ).toLowerCase();

      const lifecycleType: "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" =
        rawLType === "start" ||
        rawLType === "pause" ||
        rawLType === "resume" ||
        rawLType === "terminate" ||
        rawLType === "settle" ||
        rawLType === "spawn"
          ? rawLType
          : rawLType === "completed"
            ? "settle"
            : rawLType === "spawned"
              ? "spawn"
              : rawLType === "terminated" || rawLType === "failed"
                ? "terminate"
                : "spawn";

      const parentId =
        asString(p.parentId) ??
        asString(p.parent_id) ??
        asString(p.parentSessionId) ??
        asString(p.parent_session_id) ??
        this.sessionId;

      const header = this.emitHeader("subagent_lifecycle", timestamp, rawEventId);
      const subRole = asString(p.role);
      const subReason = asString(p.reason);
      const subEvt: NormalizedSubagentLifecycleEvent = {
        ...header,
        type: "subagent_lifecycle",
        subagentId,
        lifecycleType,
      };
      if (parentId) {
        subEvt.parentId = parentId;
      }
      if (subRole) {
        subEvt.role = subRole;
      }
      if (subReason) {
        subEvt.reason = subReason;
      }
      if (subUsage) {
        subEvt.providerUsage = subUsage;
      }
      events.push(subEvt);
      return events;
    }

    // 14. Branch Fork Events
    if (rawType === "branch_fork" || rawType === "fork" || rawType === "branch") {
      const branchPointEventId = String(
        asString(p.branchPointEventId) ??
          asString(p.branch_point_event_id) ??
          this.lastEventId ??
          "root",
      );
      const sourceSessionId = String(
        asString(p.sourceSessionId) ??
          asString(p.source_session_id) ??
          asString(p.branchSessionId) ??
          asString(p.branch_session_id) ??
          this.sessionId,
      );
      const forkReason = asString(p.forkReason) ?? asString(p.fork_reason);
      const branchName = asString(p.branchName) ?? asString(p.branch_name);

      const header = this.emitHeader("branch_fork", timestamp, rawEventId);
      const forkEvt: NormalizedBranchForkEvent = {
        ...header,
        type: "branch_fork",
        branchPointEventId,
        sourceSessionId,
      };
      if (forkReason) {
        forkEvt.forkReason = forkReason;
      }
      if (branchName) {
        forkEvt.branchName = branchName;
      }
      events.push(forkEvt);
      return events;
    }

    // 15. Fallback: Unknown Passthrough Event
    const header = this.emitHeader("unknown_passthrough", timestamp, rawEventId);
    events.push({
      ...header,
      type: "unknown_passthrough",
      rawEventType: rawType || "unknown_event",
      rawPayload: p,
    });
    return events;
  }
}

/**
 * High-level record decoder implementing the unified HarnessRecordDecoder contract.
 */
export class CodexRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "codex-cli";
  readonly decoderVersion = "1.0.0";
  private sessionDecoders = new Map<string, CodexSessionDecoder>();

  canDecode(record: RawHarnessRecord): boolean {
    if (!record || !(record instanceof Object) || Array.isArray(record)) {
      return false;
    }
    const harnessId = asString(record.harnessId)?.toLowerCase();
    if (harnessId === "codex-cli" || harnessId === "codex" || harnessId === "*") {
      return true;
    }
    if (harnessId && harnessId !== "generic" && harnessId !== "unknown") {
      return false;
    }

    const rawParsed = CodexTranscriptValueSchema.safeParse(record.rawPayload);
    const rawPayload = rawParsed.success ? rawParsed.data : undefined;
    let obj: CodexTranscriptPayload | undefined;
    const strPayload = asString(rawPayload);
    if (strPayload !== undefined) {
      try {
        const parsedJson = JSON.parse(strPayload);
        const parsedObj = CodexTranscriptPayloadSchema.safeParse(parsedJson);
        obj = parsedObj.success ? parsedObj.data : undefined;
      } catch {
        return false;
      }
    } else {
      obj = asObject(rawPayload);
    }
    if (obj) {
      const payloadHarness =
        asString(obj.harness) ?? asString(obj.harnessName) ?? asString(obj.harness_name);
      if (
        payloadHarness &&
        (payloadHarness.toLowerCase() === "codex-cli" || payloadHarness.toLowerCase() === "codex")
      ) {
        return true;
      }
      if (!harnessId) {
        return (
          asString(obj.type) !== undefined ||
          asString(obj.event) !== undefined ||
          asString(obj.role) !== undefined ||
          asString(obj.item_type) !== undefined ||
          asString(obj.call_id) !== undefined ||
          asString(obj.tool_name) !== undefined ||
          asString(obj.response_id) !== undefined
        );
      }
    }
    return false;
  }

  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    if (!this.canDecode(record)) {
      return [];
    }

    const rawParsed = CodexTranscriptValueSchema.safeParse(record.rawPayload);
    const rawPayload = rawParsed.success ? rawParsed.data : undefined;
    const metaParsed = CodexTranscriptPayloadSchema.safeParse(record.metadata);
    const recordMetadata = metaParsed.success ? metaParsed.data : undefined;

    let payload: CodexTranscriptPayload;
    const rawStr = asString(rawPayload);
    if (rawStr !== undefined) {
      const trimmed = rawStr.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        const parsedObj = CodexTranscriptPayloadSchema.safeParse(parsed);
        const obj = parsedObj.success ? parsedObj.data : undefined;
        if (!obj) return [];
        payload = obj;
      } catch {
        const sessionId =
          asString(record.sessionId) ?? asString(context?.sessionId) ?? generateEventId("sess");
        const workspaceId =
          asString(recordMetadata?.workspaceId) ??
          asString(recordMetadata?.workspace_id) ??
          asString(context?.workspaceId) ??
          asString(context?.metadata?.workspaceId) ??
          "default";
        const header: BaseNormalizedEventHeader = {
          eventId: generateEventId("evt"),
          sessionId,
          timestamp: parseTimestamp(record.timestamp),
          schemaVersion: DEFAULT_SCHEMA_VERSION,
          harnessId: "codex-cli",
          workspaceId,
          causalRef: {
            parentId: asString(context?.parentEventId) ?? null,
            causalSequence: 1,
          },
          redaction: {
            isRedacted: false,
            redactedFields: [],
            redactionStrategy: "none",
            scrubbedPatterns: [],
          },
        };
        return [
          {
            ...header,
            type: "unknown_passthrough",
            rawEventType: "unparseable_json",
            rawPayload: { unparseable: trimmed },
          },
        ];
      }
    } else {
      const obj = asObject(rawPayload);
      if (!obj) {
        return [];
      }
      payload = obj;
    }

    const sessionId =
      asString(payload.sessionId) ??
      asString(payload.session_id) ??
      asString(record.sessionId) ??
      asString(context?.sessionId) ??
      generateEventId("sess");

    const workspaceId =
      asString(payload.workspaceId) ??
      asString(payload.workspace_id) ??
      asString(recordMetadata?.workspaceId) ??
      asString(recordMetadata?.workspace_id) ??
      asString(context?.workspaceId) ??
      asString(context?.metadata?.workspaceId);

    let sessionDecoder = this.sessionDecoders.get(sessionId);
    if (!sessionDecoder) {
      sessionDecoder = new CodexSessionDecoder({
        sessionId,
        workspaceId,
        lastCausalSequence: asNumber(context?.lastCausalSequence) ?? 0,
      });
      this.sessionDecoders.set(sessionId, sessionDecoder);
    }

    const timestamp =
      asString(record.timestamp) ?? asString(payload.timestamp) ?? new Date().toISOString();

    const mergedMetadata: CodexTranscriptPayload = {};
    const payloadMeta = asObject(payload.metadata);
    if (payloadMeta) {
      Object.assign(mergedMetadata, payloadMeta);
    }
    if (recordMetadata) {
      Object.assign(mergedMetadata, recordMetadata);
    }
    const contextMeta = asObject(context?.metadata);
    if (contextMeta) {
      Object.assign(mergedMetadata, contextMeta);
    }

    const effectivePayload: CodexTranscriptPayload = {
      ...payload,
    };
    if (timestamp && !payload.timestamp) {
      effectivePayload.timestamp = timestamp;
    }
    if (Object.keys(mergedMetadata).length > 0) {
      effectivePayload.metadata = mergedMetadata;
    }
    if (workspaceId && !payload.workspaceId) {
      effectivePayload.workspaceId = workspaceId;
    }

    const events = sessionDecoder.decodeRecord(effectivePayload);
    // SAFETY: NormalizedSessionEvent matches IntermediateSessionEvent structurally for decoder output.
    return events as IntermediateSessionEvent[];
  }
}

function isRawHarnessRecord(
  raw: string | RawHarnessRecord | CodexTranscriptPayload,
): raw is RawHarnessRecord {
  return RawHarnessRecordSchema.safeParse(raw).success;
}

function isCodexDecoderOptions(
  options: string | CodexDecoderOptions | undefined,
): options is CodexDecoderOptions {
  return CodexDecoderOptionsSchema.safeParse(options).success;
}

/**
 * Decodes a raw Codex record or payload into normalized session events.
 */
export function decodeCodexRecord(
  raw: string | RawHarnessRecord | CodexTranscriptPayload,
  context?: RecordDecoderContext,
): NormalizedSessionEvent[] {
  if (!isRawHarnessRecord(raw)) {
    const sessionId = asString(context?.sessionId) ?? generateEventId("sess");
    const workspaceId = asString(context?.workspaceId) ?? "default";
    const decoder = new CodexSessionDecoder({
      sessionId,
      workspaceId,
      lastCausalSequence: asNumber(context?.lastCausalSequence),
    });
    return decoder.decodeRecord(raw);
  }
  const recordDecoder = new CodexRecordDecoder();
  const res = recordDecoder.decode(raw, context);
  if (!res) return [];
  const events = Array.isArray(res) ? res : [res];
  return events.map((event) => NormalizedSessionEventSchema.parse(event));
}

/**
 * Decodes an entire Codex transcript or JSONL content into normalized session events.
 */
export function decodeCodexTranscript(
  transcript: string | Array<string | CodexTranscriptPayload>,
  options?: string | CodexDecoderOptions,
): NormalizedSessionEvent[] {
  let decoderOptions: CodexDecoderOptions = {};
  if (isCodexDecoderOptions(options)) {
    decoderOptions = options;
  } else if (options !== undefined) {
    decoderOptions = { sessionId: options };
  }
  const decoder = new CodexSessionDecoder(decoderOptions);
  return decoder.decodeTranscript(transcript);
}
