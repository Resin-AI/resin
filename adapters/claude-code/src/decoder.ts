import {
  type CausalRef,
  type DiscoveredToolEntry,
  type MessageContentPart,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
  ProviderUsageRequestIdSchema,
  RESIN_ASSISTANT_STOP_REASON_METADATA_KEY,
  RESIN_CODEX_COMMAND_METADATA_KEY,
  RESIN_MODEL_REQUEST_ID_METADATA_KEY,
  RESIN_TASK_ID_METADATA_KEY,
  type RedactionMeta,
  ResinTaskIdSchema,
  isResinGatewayToolCall,
  readResinInvocationReceipts,
  resinInvocationReceiptMetadata,
} from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  DecoderMetadataValue,
  HarnessRecordDecoder,
  IntermediateBranchForkEvent,
  IntermediateCommandExecEvent,
  IntermediateCompactionEvent,
  IntermediateErrorEvent,
  IntermediateFileEditEvent,
  IntermediateMessageEvent,
  IntermediateModelReasoningEvent,
  IntermediateSessionEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateSubagentLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolDiscoveryEvent,
  IntermediateToolResultEvent,
  IntermediateUnknownPassthroughEvent,
  RawHarnessRecord,
  RecordDecoderContext,
} from "@resin/harness-contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { z } from "zod";
import { claudeFileEdit } from "./file-change.js";

export const CLAUDE_PROVIDER = "anthropic";
export const CLAUDE_ACCOUNTING_VERSION = "claude-code-transcript-v1";

export type ClaudeTranscriptValue = DecoderMetadataValue;
export type ClaudeTranscriptPayload = DecoderMetadataRecord;
export const ClaudeTranscriptValueSchema: z.ZodType<ClaudeTranscriptValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.record(ClaudeTranscriptValueSchema),
    z.array(ClaudeTranscriptValueSchema),
  ]),
);

export const ClaudeTranscriptPayloadSchema: z.ZodType<ClaudeTranscriptPayload> = z.lazy(() =>
  z.record(ClaudeTranscriptValueSchema),
);

export function asString(value: ClaudeTranscriptValue): string | undefined {
  return value !== undefined && value !== null && String(value) === value ? value : undefined;
}

export function asNumber(value: ClaudeTranscriptValue): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value)
    ? Number(value)
    : undefined;
}

function isClaudeTranscriptPayload(value: ClaudeTranscriptValue): value is ClaudeTranscriptPayload {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function asObject(value: ClaudeTranscriptValue): ClaudeTranscriptPayload | undefined {
  return isClaudeTranscriptPayload(value) ? value : undefined;
}

export function asArray(value: ClaudeTranscriptValue): ClaudeTranscriptValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Safely converts a transcript value to a non-negative integer.
 * Returns undefined for non-integers, negative numbers, floats, booleans, or unparseable values.
 */
function toNonNegativeInteger(value: ClaudeTranscriptValue): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === false) return undefined;

  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    return undefined;
  }
  return num;
}

/**
 * Normalizes and extracts model name from payload or usage objects.
 */
function extractModelName(
  payload: ClaudeTranscriptPayload,
  rawUsage?: ClaudeTranscriptPayload,
): string | undefined {
  const rootModel = asString(payload.model)?.trim();
  if (rootModel) return rootModel;

  const messageModel = asString(asObject(payload.message)?.model)?.trim();
  if (messageModel) return messageModel;

  const responseModel = asString(asObject(payload.response)?.model)?.trim();
  if (responseModel) return responseModel;

  const usageModel = asString(rawUsage?.model)?.trim();
  if (usageModel) return usageModel;

  return undefined;
}

/**
 * Extracts normalized ProviderReportedUsage from Claude Code transcript payloads.
 *
 * Requirements:
 * - Only authoritative provider metrics are preserved.
 * - If no metrics exist, returns undefined (never fabricates zero-token objects).
 * - Converts cost and duration to canonical schema units (micro-USD, milliseconds).
 *
 * With `requestId`, the record is request-scoped and reads Anthropic's disjoint categories (see
 * `claudeRequestUsage`). Without it, the legacy record keeps its old meaning: complete only when
 * the source reports a total, and cache writes are not reported.
 */
export function extractClaudeProviderUsage(
  payload: ClaudeTranscriptPayload,
  requestId?: string,
): ProviderReportedUsage | undefined {
  // 1. Locate usage container: payload.usage, payload.message.usage, or payload directly
  const rawUsage: ClaudeTranscriptPayload | undefined =
    asObject(payload.usage) ??
    asObject(asObject(payload.message)?.usage) ??
    asObject(asObject(payload.response)?.usage) ??
    asObject(payload.rawUsage) ??
    (payload.input_tokens !== undefined ||
    payload.output_tokens !== undefined ||
    payload.prompt_tokens !== undefined ||
    payload.total_tokens !== undefined
      ? payload
      : undefined);

  if (!rawUsage) {
    return undefined;
  }

  const scope = requestId === undefined ? {} : { usageScope: "request" as const, requestId };

  // Check explicit unavailable state
  if (asString(rawUsage.availability) === "unavailable") {
    const model = extractModelName(payload, rawUsage);
    const unavailableUsage: ProviderReportedUsage = {
      provider: CLAUDE_PROVIDER,
      accountingVersion: CLAUDE_ACCOUNTING_VERSION,
      availability: "unavailable",
      ...scope,
    };
    if (model) {
      unavailableUsage.model = model;
    }
    const parsed = ProviderReportedUsageSchema.safeParse(unavailableUsage);
    return parsed.success ? parsed.data : undefined;
  }

  if (requestId !== undefined) {
    return claudeRequestUsage(payload, rawUsage, requestId);
  }

  // Extract explicit token counts
  const rawInputTokens =
    toNonNegativeInteger(rawUsage.input_tokens) ??
    toNonNegativeInteger(rawUsage.inputTokens) ??
    toNonNegativeInteger(rawUsage.prompt_tokens) ??
    toNonNegativeInteger(rawUsage.promptTokens);
  const rawOutputTokens =
    toNonNegativeInteger(rawUsage.output_tokens) ??
    toNonNegativeInteger(rawUsage.outputTokens) ??
    toNonNegativeInteger(rawUsage.completion_tokens) ??
    toNonNegativeInteger(rawUsage.completionTokens);
  const rawReasoningTokens =
    toNonNegativeInteger(rawUsage.reasoning_tokens) ??
    toNonNegativeInteger(rawUsage.reasoningTokens) ??
    toNonNegativeInteger(rawUsage.thinking_tokens) ??
    toNonNegativeInteger(rawUsage.thinkingTokens);
  const rawCacheRead =
    toNonNegativeInteger(rawUsage.cache_read_input_tokens) ??
    toNonNegativeInteger(rawUsage.cacheReadInputTokens) ??
    toNonNegativeInteger(rawUsage.cache_read_tokens) ??
    toNonNegativeInteger(rawUsage.cached_input_tokens) ??
    toNonNegativeInteger(rawUsage.cachedInputTokens) ??
    toNonNegativeInteger(rawUsage.cached_tokens) ??
    toNonNegativeInteger(rawUsage.cachedTokens);
  const rawTotalTokens =
    toNonNegativeInteger(rawUsage.total_tokens) ?? toNonNegativeInteger(rawUsage.totalTokens);

  const cachedInputTokens = rawCacheRead;
  const inputTokens = rawInputTokens;
  const outputTokens = rawOutputTokens;
  const reasoningTokens = rawReasoningTokens;
  const costMicroUsd = claudeCostMicroUsd(rawUsage);
  const durationMs = claudeDurationMs(payload, rawUsage);

  // Check if we have at least one genuine metric
  const hasAnyMetric =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningTokens !== undefined ||
    cachedInputTokens !== undefined ||
    rawTotalTokens !== undefined ||
    costMicroUsd !== undefined ||
    durationMs !== undefined;

  if (!hasAnyMetric) {
    return undefined;
  }

  const model = extractModelName(payload, rawUsage);
  const availability = rawTotalTokens !== undefined ? "complete" : "partial";

  const usage: ProviderReportedUsage = {
    provider: CLAUDE_PROVIDER,
    accountingVersion: CLAUDE_ACCOUNTING_VERSION,
    availability,
  };
  if (model) usage.model = model;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (rawTotalTokens !== undefined) {
    usage.totalTokens = rawTotalTokens;
  }
  if (costMicroUsd !== undefined) usage.costMicroUsd = costMicroUsd;
  if (durationMs !== undefined) usage.durationMs = durationMs;

  const parseResult = ProviderReportedUsageSchema.safeParse(usage);
  if (!parseResult.success) {
    return undefined;
  }

  return parseResult.data;
}

/**
 * Request-scoped usage of one Anthropic Messages response. Anthropic reports disjoint categories:
 * `input_tokens` excludes cache reads and writes, so it is already the uncached input;
 * `cache_creation_input_tokens` is every cache write (its `cache_creation` TTL fields subdivide it
 * and are never added); `output_tokens` includes thinking, and
 * `output_tokens_details.thinking_tokens` is the thinking part of it. Anthropic reports no total, so
 * a complete record's total is the sum of the four categories. A missing category stays unknown and
 * makes the record partial.
 */
function claudeRequestUsage(
  payload: ClaudeTranscriptPayload,
  rawUsage: ClaudeTranscriptPayload,
  requestId: string,
): ProviderReportedUsage | undefined {
  const inputTokens = toNonNegativeInteger(rawUsage.input_tokens);
  const cachedInputTokens = toNonNegativeInteger(rawUsage.cache_read_input_tokens);
  const cacheWriteTokens = toNonNegativeInteger(rawUsage.cache_creation_input_tokens);
  const outputTokens = toNonNegativeInteger(rawUsage.output_tokens);
  const reasoningTokens = toNonNegativeInteger(
    asObject(rawUsage.output_tokens_details)?.thinking_tokens,
  );
  const sourceTotal = toNonNegativeInteger(rawUsage.total_tokens);
  const costMicroUsd = claudeCostMicroUsd(rawUsage);
  const durationMs = claudeDurationMs(payload, rawUsage);

  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheWriteTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    sourceTotal === undefined &&
    costMicroUsd === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }

  const sum =
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheWriteTokens !== undefined &&
    outputTokens !== undefined
      ? inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
      : undefined;
  const complete =
    sum !== undefined &&
    (reasoningTokens === undefined ||
      outputTokens === undefined ||
      reasoningTokens <= outputTokens) &&
    (sourceTotal === undefined || sourceTotal === sum);

  const usage: ProviderReportedUsage = {
    provider: CLAUDE_PROVIDER,
    accountingVersion: CLAUDE_ACCOUNTING_VERSION,
    availability: complete ? "complete" : "partial",
    usageScope: "request",
    requestId,
  };
  const model = extractModelName(payload, rawUsage);
  if (model) usage.model = model;
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  const totalTokens = complete ? sum : sourceTotal;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  // A cost in the transcript's own usage record is a source monetary field, not a Resin estimate.
  if (costMicroUsd !== undefined) {
    usage.costMicroUsd = costMicroUsd;
    usage.costProvenance = "source_reported";
  }
  if (durationMs !== undefined) usage.durationMs = durationMs;

  const parsed = ProviderReportedUsageSchema.safeParse(usage);
  return parsed.success ? parsed.data : undefined;
}

/** Reported cost in integer micro-USD, from a micro-USD field or a USD amount. */
function claudeCostMicroUsd(rawUsage: ClaudeTranscriptPayload): number | undefined {
  const rawCostMicro =
    toNonNegativeInteger(rawUsage.cost_micro_usd) ??
    toNonNegativeInteger(rawUsage.costMicroUsd) ??
    toNonNegativeInteger(rawUsage.cost_micros) ??
    toNonNegativeInteger(rawUsage.costMicros);
  if (rawCostMicro !== undefined) return rawCostMicro;
  const rawCostUsd =
    asNumber(rawUsage.cost_usd) ??
    asNumber(rawUsage.costUsd) ??
    asNumber(rawUsage.cost) ??
    asNumber(rawUsage.total_cost);
  return rawCostUsd !== undefined && rawCostUsd >= 0
    ? Math.round(rawCostUsd * 1_000_000)
    : undefined;
}

/** Reported duration in milliseconds, from a millisecond or a seconds field. */
function claudeDurationMs(
  payload: ClaudeTranscriptPayload,
  rawUsage: ClaudeTranscriptPayload,
): number | undefined {
  const durationMs =
    toNonNegativeInteger(rawUsage.duration_ms) ??
    toNonNegativeInteger(rawUsage.durationMs) ??
    toNonNegativeInteger(rawUsage.latency_ms) ??
    toNonNegativeInteger(rawUsage.latencyMs) ??
    toNonNegativeInteger(payload.duration_ms) ??
    toNonNegativeInteger(payload.durationMs);
  if (durationMs !== undefined) return durationMs;
  const durSec =
    asNumber(rawUsage.duration_s) ??
    asNumber(rawUsage.duration_seconds) ??
    asNumber(rawUsage.durationSeconds);
  return durSec !== undefined && durSec >= 0 ? Math.round(durSec * 1000) : undefined;
}

/**
 * Safely parses raw JSON or payload object into a dictionary.
 */
function parseRawPayload(
  payload: string | ClaudeTranscriptPayload,
): ClaudeTranscriptPayload | null {
  const str = asString(payload);
  if (str !== undefined) {
    try {
      const parsed: ClaudeTranscriptValue = JSON.parse(str);
      const obj = asObject(parsed);
      return obj ?? { text: str };
    } catch {
      return { text: str };
    }
  }
  const obj = asObject(payload);
  if (obj !== undefined) {
    return obj;
  }
  return null;
}

/**
 * Base helper to attach causalRef and common fields to intermediate events.
 */
function withBaseFields<T extends IntermediateSessionEvent>(
  event: T,
  sessionId: string,
  timestamp: string,
  causalSequence = 0,
): T {
  const finalSessionId = event.sessionId || sessionId;
  const finalTimestamp = event.timestamp || timestamp;
  const causalRef = event.causalRef ?? {
    causalSequence,
    predecessorIds: [],
  };

  return {
    ...event,
    sessionId: finalSessionId,
    timestamp: finalTimestamp,
    causalRef,
  };
}

/** A `tool_use` seen earlier in the transcript, awaiting the `tool_result` that answers it. */
export interface PendingClaudeToolCall {
  toolName: string;
  /** Absent for a call restored from a resume snapshot: its result's duration is unknown. */
  timestamp?: string;
  /** A built-in `Bash` call run in the foreground: its result without an error means exit 0. */
  foregroundShell?: true;
  /** The model request whose response issued the call. */
  modelRequestId?: string;
}

/** Tool calls awaiting their results, keyed by Claude's `tool_use` id. */
export type PendingClaudeToolCalls = Map<string, PendingClaudeToolCall>;

/**
 * The last usage snapshot an event carried for each request id. Claude writes one content block per
 * line, each repeating its message's usage (earlier lines may carry a smaller streaming output
 * count), so a line reports usage only when it differs from the last snapshot of its request;
 * consumers keep the latest snapshot per request id. Bounded: a message's lines arrive together.
 */
export type ClaudeUsageSnapshots = Map<string, string>;

/**
 * The `uuid` of each session's latest genuine user prompt: the task its later events belong to.
 * Unknown after a restart until the next prompt.
 */
export type ClaudeSessionTasks = Map<string, string>;

const MAX_TRACKED_ENTRIES = 4096;

/** Sets `key` as the most recent entry, evicting the oldest past the bound. */
function rememberBounded(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Claude writes `<synthetic>` assistant messages locally, without a model request. */
const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * The provider request id of an assistant line: the Anthropic message id, else the API request id;
 * every line of one response shares both. Never the per-line `uuid`.
 */
function claudeRequestId(payload: ClaudeTranscriptPayload): string | undefined {
  const message = asObject(payload.message);
  for (const candidate of [message?.id, payload.requestId]) {
    const parsed = ProviderUsageRequestIdSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Canonical call id for a Claude `tool_use` id (`toolu_…`), constrained to identifier characters. */
/**
 * Claude Code names every MCP tool `mcp__<server>__<tool>`, so a call named exactly `Bash` with a
 * command is its built-in shell tool (bash; Git Bash on native Windows), and one named exactly
 * `PowerShell` with a command is its built-in PowerShell tool. Only this decoder proves that, with
 * the local-only marker the recorder trusts. The PowerShell tool runs `pwsh` when it is installed and
 * Windows PowerShell 5.1 otherwise, and the transcript does not say which.
 */
function claudeSourceInterface(
  toolName: string,
  input: ClaudeTranscriptPayload,
): { metadata: DecoderMetadataRecord } | Record<string, never> {
  if (typeof input.command !== "string") return {};
  return toolName === "Bash"
    ? { metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "claude-bash" } }
    : toolName === "PowerShell"
      ? { metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "claude-powershell" } }
      : {};
}

export function claudeCallId(toolCallId: string): string {
  const sanitized = toolCallId.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const safe = /^[a-zA-Z0-9_-]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return safe.length > 0 ? safe.slice(0, 128) : "_";
}

/**
 * Decodes a single Claude Code JSONL or memory transcript line into canonical intermediate events.
 * `pendingCalls` carries tool calls across lines so a result can name its tool, measure its
 * duration, report the shell command it completed, and link the model request that issued it;
 * `usageSnapshots` keeps a message split across lines from repeating an unchanged usage snapshot;
 * `sessionTasks` links each event to its session's latest user prompt.
 */
export function decodeClaudeTranscriptLine(
  lineOrPayload: string | ClaudeTranscriptPayload,
  sessionId: string,
  sequenceNumber = 0,
  timestamp = new Date().toISOString(),
  pendingCalls: PendingClaudeToolCalls = new Map(),
  usageSnapshots: ClaudeUsageSnapshots = new Map(),
  sessionTasks: ClaudeSessionTasks = new Map(),
): IntermediateSessionEvent[] {
  const events = decodeLineEvents(
    lineOrPayload,
    sessionId,
    sequenceNumber,
    timestamp,
    pendingCalls,
    usageSnapshots,
    sessionTasks,
  );
  // Every event of one line shares the line's sequence; its position within the line keeps each
  // one distinct (a tool result and the command it completed would otherwise collide).
  if (events.length > 1) {
    events.forEach((event, stepIndex) => {
      if (event.causalRef && event.causalRef.stepIndex === undefined) {
        event.causalRef = { ...event.causalRef, stepIndex };
      }
    });
  }
  return events;
}

function decodeLineEvents(
  lineOrPayload: string | ClaudeTranscriptPayload,
  sessionId: string,
  sequenceNumber: number,
  timestamp: string,
  pendingCalls: PendingClaudeToolCalls,
  usageSnapshots: ClaudeUsageSnapshots,
  sessionTasks: ClaudeSessionTasks,
): IntermediateSessionEvent[] {
  const payload = parseRawPayload(lineOrPayload);
  if (!payload) {
    return [
      withBaseFields<IntermediateUnknownPassthroughEvent>(
        {
          type: "unknown_passthrough",
          sessionId,
          timestamp,
          rawEventType: "empty_payload",
          rawPayload: {},
        },
        sessionId,
        timestamp,
        sequenceNumber,
      ),
    ];
  }

  const events: IntermediateSessionEvent[] = [];
  const rawType = (
    asString(payload.type) ||
    asString(payload.event) ||
    asString(payload.role) ||
    ""
  ).toLowerCase();
  const recordTime = asString(payload.timestamp) || timestamp;

  // Claude appends `cost-state` as its process exits (again after each resume): the session ended.
  if (rawType === "cost-state") {
    return [
      withBaseFields<IntermediateSessionLifecycleEvent>(
        {
          type: "session_lifecycle",
          sessionId,
          timestamp: recordTime,
          lifecycleType: "end",
          exitReason: "normal",
          harnessName: "claude-code",
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    ];
  }

  // 1. Session Lifecycle Events
  if (
    rawType === "session_start" ||
    rawType === "session_init" ||
    rawType === "session_end" ||
    rawType === "session_completed" ||
    rawType === "session_terminate" ||
    rawType === "session_lifecycle" ||
    rawType === "start" ||
    rawType === "end" ||
    rawType === "exit" ||
    (rawType === "" && asString(payload.lifecycleType) !== undefined)
  ) {
    const rawLifecycle = asString(payload.lifecycleType)?.toLowerCase();
    let lifecycleType: "start" | "end" | "pause" | "resume" | "crash" = "start";
    if (
      rawLifecycle === "start" ||
      rawLifecycle === "end" ||
      rawLifecycle === "pause" ||
      rawLifecycle === "resume" ||
      rawLifecycle === "crash"
    ) {
      lifecycleType = rawLifecycle;
    } else {
      const isStart = rawType.includes("start") || rawType.includes("init");
      lifecycleType = isStart ? "start" : "end";
    }

    events.push(
      withBaseFields<IntermediateSessionLifecycleEvent>(
        {
          type: "session_lifecycle",
          sessionId,
          timestamp: recordTime,
          lifecycleType,
          exitReason:
            asString(payload.exitReason) ||
            asString(payload.reason) ||
            (lifecycleType === "end" ? "normal" : undefined),
          harnessName: asString(payload.harness) || asString(payload.harnessName) || "claude-code",
          workspaceId: asString(payload.workspaceId) || asString(payload.workspace_id),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 2. Subagent & Branch Events
  if (
    rawType === "subagent" ||
    rawType === "subagent_spawn" ||
    rawType === "subagent_lifecycle" ||
    rawType === "subagent_start" ||
    rawType === "subagent_end" ||
    rawType === "subagent_stop" ||
    rawType === "subagent_terminate" ||
    asString(payload.subagentId) !== undefined
  ) {
    const rawLifecycle = asString(payload.lifecycleType)?.toLowerCase();
    let lifecycleType: "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" = "spawn";

    if (
      rawLifecycle === "spawn" ||
      rawLifecycle === "start" ||
      rawLifecycle === "pause" ||
      rawLifecycle === "resume" ||
      rawLifecycle === "terminate" ||
      rawLifecycle === "settle"
    ) {
      lifecycleType = rawLifecycle;
    } else if (rawLifecycle === "end") {
      lifecycleType = "settle";
    } else if (rawLifecycle === "crash") {
      lifecycleType = "terminate";
    } else if (rawType.includes("start")) {
      lifecycleType = "start";
    } else if (
      rawType.includes("end") ||
      rawType.includes("stop") ||
      rawType.includes("terminate")
    ) {
      lifecycleType = "terminate";
    }

    events.push(
      withBaseFields<IntermediateSubagentLifecycleEvent>(
        {
          type: "subagent_lifecycle",
          sessionId,
          timestamp: recordTime,
          subagentId: asString(payload.subagentId) || asString(payload.id) || "subagent-1",
          lifecycleType,
          parentId: asString(payload.parentId) || asString(payload.parent_id),
          role: asString(payload.role),
          reason: asString(payload.reason),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (
    rawType === "branch_fork" ||
    rawType === "fork" ||
    rawType === "branch" ||
    asString(payload.branchPointEventId) !== undefined
  ) {
    events.push(
      withBaseFields<IntermediateBranchForkEvent>(
        {
          type: "branch_fork",
          sessionId,
          timestamp: recordTime,
          sourceSessionId: asString(payload.sourceSessionId) || sessionId,
          branchPointEventId: asString(payload.branchPointEventId) || "root",
          branchId: asString(payload.branchId),
          parentBranchId: asString(payload.parentBranchId),
          divergenceSequence: asNumber(payload.divergenceSequence),
          forkReason: asString(payload.forkReason) || asString(payload.reason),
          branchName: asString(payload.branchName) || asString(payload.name),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // Claude Code 2.x marks a compaction with a `compact_boundary` system record.
  if (rawType === "system" && asString(payload.subtype) === "compact_boundary") {
    const compact = asObject(payload.compactMetadata);
    const trigger = asString(compact?.trigger);
    events.push(
      withBaseFields<IntermediateCompactionEvent>(
        {
          type: "compaction",
          sessionId,
          timestamp: recordTime,
          triggerReason: trigger === "manual" ? "manual" : "context_limit",
          // 2.1.x boundaries record only the pre-compaction size; an unrecorded size is 0.
          tokensBefore: asNumber(compact?.preTokens) ?? 0,
          tokensAfter: asNumber(compact?.postTokens) ?? 0,
          originalTokenCount: asNumber(compact?.preTokens) ?? 0,
          compactedTokenCount: asNumber(compact?.postTokens) ?? 0,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 3. Compaction & Summarization Events
  if (
    rawType === "compaction" ||
    rawType === "context_compaction" ||
    rawType === "summary" ||
    rawType === "context_summary" ||
    asString(payload.action) === "compact" ||
    (asNumber(payload.originalTokenCount) !== undefined &&
      asNumber(payload.compactedTokenCount) !== undefined)
  ) {
    events.push(
      withBaseFields<IntermediateCompactionEvent>(
        {
          type: "compaction",
          sessionId,
          timestamp: recordTime,
          originalTokenCount:
            asNumber(payload.originalTokenCount) ?? asNumber(payload.originalTokens) ?? 0,
          compactedTokenCount:
            asNumber(payload.compactedTokenCount) ?? asNumber(payload.compactedTokens) ?? 0,
          summary: asString(payload.summary) || asString(payload.text) || asString(payload.content),
          rangeStart: asNumber(payload.rangeStart) ?? asNumber(payload.compactedRangeStart),
          rangeEnd: asNumber(payload.rangeEnd) ?? asNumber(payload.compactedRangeEnd),
          preservedContextSummary: asString(payload.preservedContextSummary),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 4. Error Events
  if (
    rawType === "error" ||
    rawType === "rate_limit" ||
    rawType === "exception" ||
    rawType === "crash" ||
    payload.is_error === true ||
    payload.isError === true ||
    (asString(payload.errorType) !== undefined && asString(payload.message) !== undefined)
  ) {
    const errorType =
      asString(payload.errorType) ||
      asString(payload.errorCode) ||
      asString(payload.code) ||
      "CLAUDE_ERROR";
    const message =
      asString(payload.message) || asString(payload.error) || "Claude Code execution error";
    const stackTrace =
      asString(payload.stack) || asString(payload.stackTrace) || asString(payload.trace);
    const fatal = payload.fatal === true || payload.isFatal === true || rawType === "crash";

    events.push(
      withBaseFields<IntermediateErrorEvent>(
        {
          type: "error",
          sessionId,
          timestamp: recordTime,
          errorType,
          message,
          stackTrace,
          fatal,
          recoverable: payload.recoverable === true || !fatal,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 5. User Messages & Tool Results
  if (
    rawType === "user" ||
    rawType === "user_message" ||
    rawType === "prompt" ||
    asString(payload.role) === "user"
  ) {
    const rawContent =
      asObject(payload.message)?.content ?? payload.content ?? payload.text ?? payload.prompt;
    const recordedCwd = asString(payload.cwd);
    // A genuine user prompt starts a task named by the prompt record's own `uuid`; tool results
    // and harness-authored turns continue the current one. A prompt without a usable id leaves
    // the task unknown rather than reusing the previous one.
    const currentTaskId = sessionTasks.get(sessionId);
    const parsedPromptId = ResinTaskIdSchema.safeParse(payload.uuid);
    const promptTaskId = parsedPromptId.success ? parsedPromptId.data : undefined;
    const promptMetadata =
      promptTaskId === undefined ? undefined : { [RESIN_TASK_ID_METADATA_KEY]: promptTaskId };
    let startsTask = false;

    const strContent = asString(rawContent);
    if (strContent !== undefined) {
      // Claude writes its own turns as user records: compaction summaries, slash-command wrappers,
      // caveats, and background-task notifications. None of them is an instruction from the user.
      const harnessAuthored =
        payload.isCompactSummary === true ||
        payload.isMeta === true ||
        asObject(payload.origin) !== undefined ||
        /^<(command-name|local-command-[a-z]+|task-notification)>/u.test(strContent);
      startsTask = !harnessAuthored;
      events.push(
        withBaseFields<IntermediateMessageEvent>(
          {
            type: "message",
            sessionId,
            timestamp: recordTime,
            role: harnessAuthored ? "system" : "user",
            content: strContent,
            ...(startsTask && promptMetadata ? { metadata: promptMetadata } : {}),
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else {
      const toolResultIds: string[] = [];
      const contentParts = asArray(rawContent);
      if (contentParts) {
        for (const part of contentParts) {
          const block = asObject(part);
          if (!block) continue;

          const blockType = asString(block.type);
          if (blockType === "tool_result") {
            const toolCallId =
              asString(block.tool_use_id) ||
              asString(block.id) ||
              asString(block.toolCallId) ||
              "call-unknown";
            const pending = pendingCalls.get(toolCallId);
            pendingCalls.delete(toolCallId);
            const toolName =
              asString(block.name) ||
              asString(block.tool_name) ||
              asString(block.toolName) ||
              pending?.toolName ||
              "unknown";
            const rawOutput = block.content ?? block.output ?? "";
            const output =
              asString(rawOutput) ?? (rawOutput !== undefined ? JSON.stringify(rawOutput) : "");
            const isError = Boolean(block.is_error ?? block.isError ?? false);
            const startedAt = Date.parse(pending?.timestamp ?? "");
            const endedAt = Date.parse(recordTime);
            const durationKnown = Number.isFinite(startedAt) && Number.isFinite(endedAt);
            const durationMs = durationKnown ? Math.max(0, endedAt - startedAt) : 0;
            const metadata: DecoderMetadataRecord = {
              ...(durationKnown ? {} : { executionDurationUnknown: true }),
              // Claude reports a foreground `Bash` that exited non-zero as an error.
              ...(pending?.foregroundShell && !isError
                ? { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "shell-exited-0" }
                : {}),
              ...(pending?.modelRequestId === undefined
                ? {}
                : { [RESIN_MODEL_REQUEST_ID_METADATA_KEY]: pending.modelRequestId }),
              ...(currentTaskId === undefined
                ? {}
                : { [RESIN_TASK_ID_METADATA_KEY]: currentTaskId }),
              // Only a Resin gateway call's result may carry its invocation receipts.
              ...(isResinGatewayToolCall(toolName)
                ? resinInvocationReceiptMetadata(readResinInvocationReceipts(rawOutput))
                : {}),
            };

            events.push(
              withBaseFields<IntermediateToolResultEvent>(
                {
                  type: "tool_result",
                  sessionId,
                  timestamp: recordTime,
                  callId: claudeCallId(toolCallId),
                  toolCallId,
                  toolName,
                  result: output,
                  isError,
                  ...(isError ? { error: output } : {}),
                  executionDurationMs: durationMs,
                  outputSizeBytes: Buffer.byteLength(output, "utf8"),
                  ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
            toolResultIds.push(toolCallId);
          } else if (blockType === "text" || asString(block.text) !== undefined) {
            const text = asString(block.text) || asString(block.content) || "";
            // "[Request interrupted by user...]" is Claude's notice of an abort, not a request.
            const isPrompt = !/^\[Request interrupted by user/u.test(text);
            if (isPrompt) startsTask = true;
            events.push(
              withBaseFields<IntermediateMessageEvent>(
                {
                  type: "message",
                  sessionId,
                  timestamp: recordTime,
                  role: isPrompt ? "user" : "system",
                  content: text,
                  ...(isPrompt && promptMetadata ? { metadata: promptMetadata } : {}),
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          }
        }
      }
      // A successful Edit/Write records what it applied; that edit, restated as a patch, is the
      // step. It is named after its tool call so the workflow recorder can place it, but is a call
      // of its own (`apply_patch`), so it must not reuse the Edit/Write call's id.
      const edit = toolResultIds.length === 1 ? claudeFileEdit(payload.toolUseResult) : undefined;
      const toolUseId = toolResultIds[0];
      const nativeId = toolUseId === undefined ? undefined : `${toolUseId}-patch`;
      if (
        edit !== undefined &&
        nativeId !== undefined &&
        /^[A-Za-z0-9_-]{1,256}$/u.test(nativeId)
      ) {
        events.push(
          withBaseFields<IntermediateFileEditEvent>(
            {
              type: "file_edit",
              sessionId,
              timestamp: recordTime,
              filePath: edit.filePath,
              operation: edit.operation,
              action: edit.operation,
              patch: edit.patch,
              metadata: {
                [RESIN_CODEX_COMMAND_METADATA_KEY]: { version: 1, kind: "file-change", nativeId },
                ...(recordedCwd === undefined ? {} : { claudeNative: { cwd: recordedCwd } }),
              },
            },
            sessionId,
            recordTime,
            sequenceNumber,
          ),
        );
      }
    }

    if (startsTask) {
      if (promptTaskId === undefined) sessionTasks.delete(sessionId);
      else rememberBounded(sessionTasks, sessionId, promptTaskId);
    }

    if (events.length > 0) {
      return events;
    }
  }

  // 6. Assistant Messages, Reasoning & Tool Calls
  if (
    rawType === "assistant" ||
    rawType === "assistant_message" ||
    asString(payload.role) === "assistant"
  ) {
    // A synthetic message is not a model request: it reports no usage and links no request.
    const synthetic = asString(asObject(payload.message)?.model) === CLAUDE_SYNTHETIC_MODEL;
    const requestId = synthetic ? undefined : claudeRequestId(payload);
    const lineUsage = synthetic ? undefined : extractClaudeProviderUsage(payload, requestId);
    // A request's lines repeat its usage; only a changed snapshot is reported again.
    const usageSnapshot = lineUsage === undefined ? undefined : JSON.stringify(lineUsage);
    const providerUsage =
      requestId !== undefined && usageSnapshots.get(requestId) === usageSnapshot
        ? undefined
        : lineUsage;
    const rawContent = asObject(payload.message)?.content ?? payload.content ?? payload.text;

    const assistantTurnEvents: IntermediateSessionEvent[] = [];

    const strContent = asString(rawContent);
    if (strContent !== undefined) {
      assistantTurnEvents.push(
        withBaseFields<IntermediateMessageEvent>(
          {
            type: "message",
            sessionId,
            timestamp: recordTime,
            role: "assistant",
            content: strContent,
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else {
      const contentParts = asArray(rawContent);
      if (contentParts) {
        for (const part of contentParts) {
          const block = asObject(part);
          if (!block) continue;

          const blockType = asString(block.type);
          if (blockType === "text" || asString(block.text) !== undefined) {
            const text = asString(block.text) || asString(block.content) || "";
            assistantTurnEvents.push(
              withBaseFields<IntermediateMessageEvent>(
                {
                  type: "message",
                  sessionId,
                  timestamp: recordTime,
                  role: "assistant",
                  content: text,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (blockType === "thinking" || blockType === "thought") {
            const thought =
              asString(block.thinking) || asString(block.thought) || asString(block.content) || "";
            assistantTurnEvents.push(
              withBaseFields<IntermediateModelReasoningEvent>(
                {
                  type: "model_reasoning",
                  sessionId,
                  timestamp: recordTime,
                  reasoningText: thought,
                  reasoningContent: thought,
                  signature: asString(block.signature),
                  visibility: "visible",
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (blockType === "tool_use" || blockType === "tool_call") {
            const toolCallId =
              asString(block.id) || asString(block.toolCallId) || `call_${sequenceNumber}`;
            const toolName = asString(block.name) || asString(block.toolName) || "unknown";
            const rawInput = block.input;
            const inputRecord = asObject(rawInput) ?? {};

            assistantTurnEvents.push(
              withBaseFields<IntermediateToolCallEvent>(
                {
                  type: "tool_call",
                  sessionId,
                  timestamp: recordTime,
                  callId: claudeCallId(toolCallId),
                  toolCallId,
                  toolName,
                  parameters: inputRecord,
                  ...claudeSourceInterface(toolName, inputRecord),
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );

            pendingCalls.set(toolCallId, {
              toolName,
              timestamp: recordTime,
              ...(toolName === "Bash" &&
              "metadata" in claudeSourceInterface(toolName, inputRecord) &&
              inputRecord.run_in_background !== true
                ? { foregroundShell: true as const }
                : {}),
              ...(requestId === undefined ? {} : { modelRequestId: requestId }),
            });
          }
        }
      }
    }

    // Attach providerUsage to the primary model execution event of the line
    if (providerUsage && assistantTurnEvents.length > 0) {
      let targetEvent: IntermediateSessionEvent | undefined = assistantTurnEvents.find(
        (e): e is IntermediateMessageEvent => e.type === "message" && e.role === "assistant",
      );
      if (!targetEvent) {
        targetEvent = assistantTurnEvents.find((e) => e.type === "model_reasoning");
      }
      if (!targetEvent) {
        targetEvent = assistantTurnEvents.find((e) => e.type === "tool_call");
      }
      if (targetEvent) {
        targetEvent.providerUsage = providerUsage;
        if (requestId !== undefined && usageSnapshot !== undefined) {
          rememberBounded(usageSnapshots, requestId, usageSnapshot);
        }
      }
    }

    // Claude writes one content block per record, each repeating the message's stop reason; an
    // `end_turn` on the final block is what closes the turn.
    const stopReason = asString(asObject(payload.message)?.stop_reason);
    const taskId = sessionTasks.get(sessionId);
    const lineMetadata: DecoderMetadataRecord = {
      ...(stopReason ? { [RESIN_ASSISTANT_STOP_REASON_METADATA_KEY]: stopReason } : {}),
      ...(requestId === undefined ? {} : { [RESIN_MODEL_REQUEST_ID_METADATA_KEY]: requestId }),
      ...(taskId === undefined ? {} : { [RESIN_TASK_ID_METADATA_KEY]: taskId }),
    };
    if (Object.keys(lineMetadata).length > 0) {
      for (const event of assistantTurnEvents) {
        event.metadata = { ...event.metadata, ...lineMetadata };
      }
    }

    events.push(...assistantTurnEvents);
    if (events.length > 0) {
      return events;
    }
  }

  // 7. Standalone Tool Use & Tool Result Records
  if (rawType === "tool_use" || rawType === "tool_call") {
    const providerUsage = extractClaudeProviderUsage(payload);
    const toolCallId =
      asString(payload.id) || asString(payload.toolCallId) || `call_${sequenceNumber}`;
    const toolName = asString(payload.name) || asString(payload.toolName) || "unknown";
    const rawInput = payload.input ?? {};
    const inputRecord = asObject(rawInput) ?? {};
    const rawInputStr = asString(rawInput) ?? JSON.stringify(rawInput);

    const toolCallEvent: IntermediateToolCallEvent = {
      type: "tool_call",
      sessionId,
      timestamp: recordTime,
      toolCallId,
      toolName,
      input: inputRecord,
      rawInput: rawInputStr,
      ...claudeSourceInterface(toolName, inputRecord),
    };
    if (providerUsage) {
      toolCallEvent.providerUsage = providerUsage;
    }

    events.push(
      withBaseFields<IntermediateToolCallEvent>(
        toolCallEvent,
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (
    rawType === "tool_result" ||
    rawType === "tool_output" ||
    rawType === "tool_execution" ||
    asString(payload.role) === "tool"
  ) {
    const toolCallId =
      asString(payload.tool_use_id) ||
      asString(payload.toolCallId) ||
      asString(payload.id) ||
      "tool-call-1";
    const toolName =
      asString(payload.name) ||
      asString(payload.tool_name) ||
      asString(payload.toolName) ||
      "unknown";
    const rawResult = payload.content ?? payload.output ?? payload.result;
    const rawResultStr =
      asString(rawResult) ?? (rawResult !== undefined ? JSON.stringify(rawResult) : "");
    const isError = Boolean(payload.is_error ?? payload.isError ?? false);

    events.push(
      withBaseFields<IntermediateToolResultEvent>(
        {
          type: "tool_result",
          sessionId,
          timestamp: recordTime,
          toolCallId,
          toolName,
          output: rawResultStr,
          isError,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 8. Standalone Command Exec
  if (
    rawType === "command_exec" ||
    rawType === "command" ||
    rawType === "exec" ||
    rawType === "bash" ||
    rawType === "terminal"
  ) {
    events.push(
      withBaseFields<IntermediateCommandExecEvent>(
        {
          type: "command_exec",
          sessionId,
          timestamp: recordTime,
          command: asString(payload.command) || asString(payload.cmd) || "",
          workingDirectory: asString(payload.workingDirectory) || asString(payload.cwd),
          exitCode: asNumber(payload.exitCode) ?? asNumber(payload.exit_code),
          stdout: asString(payload.stdout),
          stderr: asString(payload.stderr),
          durationMs: asNumber(payload.durationMs) ?? asNumber(payload.duration_ms) ?? 0,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 9. Standalone File Edit
  if (rawType === "file_edit" || rawType === "edit" || rawType === "write") {
    const rawEditType =
      asString(payload.editType)?.toLowerCase() || asString(payload.operation)?.toLowerCase();
    const operation =
      rawEditType === "create" ||
      rawEditType === "update" ||
      rawEditType === "delete" ||
      rawEditType === "read" ||
      rawEditType === "patch"
        ? rawEditType
        : rawEditType === "modify"
          ? "update"
          : "update";

    const linesAdded = asNumber(payload.linesAdded) ?? asNumber(payload.additions);
    const linesRemoved = asNumber(payload.linesRemoved) ?? asNumber(payload.deletions);
    const diffStats =
      linesAdded !== undefined && linesRemoved !== undefined
        ? { linesAdded, linesRemoved }
        : undefined;

    events.push(
      withBaseFields<IntermediateFileEditEvent>(
        {
          type: "file_edit",
          sessionId,
          timestamp: recordTime,
          filePath:
            asString(payload.filePath) ||
            asString(payload.file_path) ||
            asString(payload.path) ||
            "unknown",
          operation,
          action: operation === "create" ? "create" : operation === "delete" ? "delete" : "update",
          diff: asString(payload.diff),
          diffStats,
          linesAdded,
          linesRemoved,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 10. Standalone Model Reasoning
  if (rawType === "model_reasoning" || rawType === "thinking" || rawType === "thought") {
    const thought =
      asString(payload.thought) ||
      asString(payload.thinking) ||
      asString(payload.reasoningText) ||
      asString(payload.reasoningContent) ||
      asString(payload.content) ||
      "";
    events.push(
      withBaseFields<IntermediateModelReasoningEvent>(
        {
          type: "model_reasoning",
          sessionId,
          timestamp: recordTime,
          reasoningText: thought,
          reasoningContent: thought,
          signature: asString(payload.signature),
          durationMs: asNumber(payload.durationMs) ?? asNumber(payload.duration_ms),
          visibility: "visible",
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 11. Fallback / Passthrough
  const rawPayloadRecord = asObject(payload) ?? {};

  events.push(
    withBaseFields<IntermediateUnknownPassthroughEvent>(
      {
        type: "unknown_passthrough",
        sessionId,
        timestamp: recordTime,
        rawEventType: rawType || "unknown",
        rawPayload: rawPayloadRecord,
      },
      sessionId,
      recordTime,
      sequenceNumber,
    ),
  );

  return events;
}

/**
 * Local-only record metadata a source attaches to the first record it emits after resuming
 * mid-transcript: the request-link state the transcript before its cursor established.
 */
export const CLAUDE_REQUEST_LINK_RESUME_KEY = "__resinClaudeRequestLinkResumeV1";

const ClaudeRequestLinkResumeSchema = z
  .object({
    version: z.literal(1),
    taskId: ResinTaskIdSchema.optional(),
    /** Unanswered calls: `[tool_use id, issuing model request id, tool name]`. */
    calls: z
      .array(
        z.tuple([
          z.string().min(1).max(1024),
          ProviderUsageRequestIdSchema,
          z.string().min(1).max(1024),
        ]),
      )
      .max(MAX_TRACKED_ENTRIES),
  })
  .strict();

/** Request-link state a resumed decoder would otherwise only learn from the transcript's prefix. */
export type ClaudeRequestLinkResume = z.infer<typeof ClaudeRequestLinkResumeSchema>;

/** Decodes a source record's payload: a raw JSONL line or its parsed object. */
function decodeClaudeRecordPayload(
  rawPayload: unknown,
  sessionId: string,
  sequenceNumber: number,
  timestamp: string,
  pendingCalls: PendingClaudeToolCalls,
  usageSnapshots: ClaudeUsageSnapshots,
  sessionTasks: ClaudeSessionTasks,
): IntermediateSessionEvent[] {
  if (String(rawPayload) === rawPayload) {
    return decodeClaudeTranscriptLine(
      rawPayload,
      sessionId,
      sequenceNumber,
      timestamp,
      pendingCalls,
      usageSnapshots,
      sessionTasks,
    );
  }
  if (
    rawPayload !== null &&
    rawPayload !== undefined &&
    !Array.isArray(rawPayload) &&
    Object.prototype.toString.call(rawPayload) === "[object Object]"
  ) {
    // SAFETY: Raw payload is a JSON object record conforming to Claude transcript lines.
    return decodeClaudeTranscriptLine(
      rawPayload as ClaudeTranscriptPayload,
      sessionId,
      sequenceNumber,
      timestamp,
      pendingCalls,
      usageSnapshots,
      sessionTasks,
    );
  }
  return [];
}

/**
 * Rebuilds a session's request-link state from the transcript before a resume point: decodes each
 * prefix record exactly as the live decoder would, with throwaway state, and discards the events.
 */
export class ClaudeRequestLinkPrimer {
  private readonly pendingCalls: PendingClaudeToolCalls = new Map();
  private readonly usageSnapshots: ClaudeUsageSnapshots = new Map();
  private readonly sessionTasks: ClaudeSessionTasks = new Map();

  constructor(private readonly sessionId: string) {}

  /** Observes one prefix record: the payload and sequence number the source would emit for it. */
  observe(rawPayload: unknown, sequenceNumber: number): void {
    decodeClaudeRecordPayload(
      rawPayload,
      this.sessionId,
      sequenceNumber,
      new Date().toISOString(),
      this.pendingCalls,
      this.usageSnapshots,
      this.sessionTasks,
    );
  }

  /** The session's task and its most recent unanswered calls that link an issuing request. */
  snapshot(): ClaudeRequestLinkResume {
    const calls: ClaudeRequestLinkResume["calls"] = [];
    for (const [toolCallId, call] of this.pendingCalls) {
      if (call.modelRequestId !== undefined) {
        calls.push([toolCallId, call.modelRequestId, call.toolName]);
      }
    }
    const taskId = this.sessionTasks.get(this.sessionId);
    return {
      version: 1,
      ...(taskId === undefined ? {} : { taskId }),
      calls: calls.slice(-MAX_TRACKED_ENTRIES),
    };
  }
}

/**
 * HarnessRecordDecoder implementation for Claude Code JSONL transcripts.
 */
export class ClaudeRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "claude-code";
  readonly decoderVersion = CLAUDE_ACCOUNTING_VERSION;
  /** Tool calls awaiting results; Claude `tool_use` ids are unique across sessions. */
  private readonly pendingCalls: PendingClaudeToolCalls = new Map();
  /** Last usage snapshot reported per request; Claude message ids are unique across sessions. */
  private readonly usageSnapshots: ClaudeUsageSnapshots = new Map();
  /** Each session's latest user prompt id. */
  private readonly sessionTasks: ClaudeSessionTasks = new Map();

  canDecode(record: RawHarnessRecord): boolean {
    if (!record) return false;
    if (
      record.harnessId &&
      record.harnessId !== this.harnessId &&
      record.harnessId !== "claude" &&
      record.harnessId !== "*"
    ) {
      return false;
    }
    return true;
  }

  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    if (!record) {
      return [];
    }

    const sessionId = record.sessionId || context?.sessionId || "session-1";
    const sequenceNumber = record.sequenceNumber ?? record.cursor?.sequence ?? 0;
    const timestamp = record.timestamp || new Date().toISOString();
    this.installRequestLinkResume(record, sessionId);

    return decodeClaudeRecordPayload(
      record.rawPayload,
      sessionId,
      sequenceNumber,
      timestamp,
      this.pendingCalls,
      this.usageSnapshots,
      this.sessionTasks,
    );
  }

  /**
   * Installs the link state a resuming source primed, without overriding state this decoder
   * already holds; the local-only key never reaches event metadata. Invalid values are ignored.
   */
  private installRequestLinkResume(record: RawHarnessRecord, sessionId: string): void {
    const metadata = record.metadata;
    if (metadata === undefined || !Object.hasOwn(metadata, CLAUDE_REQUEST_LINK_RESUME_KEY)) return;
    const parsed = ClaudeRequestLinkResumeSchema.safeParse(
      metadata[CLAUDE_REQUEST_LINK_RESUME_KEY],
    );
    delete metadata[CLAUDE_REQUEST_LINK_RESUME_KEY];
    if (!parsed.success) return;
    const { taskId, calls } = parsed.data;
    if (taskId !== undefined && !this.sessionTasks.has(sessionId)) {
      rememberBounded(this.sessionTasks, sessionId, taskId);
    }
    // A restored call keeps no start time (its duration is unknown) and no foreground-shell mark.
    for (const [toolCallId, modelRequestId, toolName] of calls) {
      if (!this.pendingCalls.has(toolCallId)) {
        this.pendingCalls.set(toolCallId, { toolName, modelRequestId });
      }
    }
  }
}
