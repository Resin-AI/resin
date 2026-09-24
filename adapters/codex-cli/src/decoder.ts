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
type NativeOutcome = "completed" | "failed" | "unknown" | "running" | "truncated";

interface NativeShellOutput {
  result: CodexTranscriptValue;
  exitCode?: number;
  durationMs?: number;
  outcome: NativeOutcome;
}

function parseNativeShellOutput(
  rawOutput: CodexTranscriptValue | undefined,
  rawRecord: CodexTranscriptPayload,
): NativeShellOutput {
  const outputObject = asObject(rawOutput);
  const recordMetadata = asObject(rawRecord.metadata);
  const nestedMetadata = asObject(outputObject?.metadata) ?? recordMetadata;
  const exitValue =
    outputObject?.exit_code ??
    outputObject?.exitCode ??
    outputObject?.code ??
    rawRecord.exit_code ??
    rawRecord.exitCode ??
    nestedMetadata?.exit_code ??
    nestedMetadata?.exitCode ??
    recordMetadata?.exit_code ??
    recordMetadata?.exitCode;
  const exitCode = asNumber(exitValue);
  const durationSource: CodexTranscriptPayload = {
    ...rawRecord,
    ...(outputObject ?? {}),
    ...(nestedMetadata ? { metadata: nestedMetadata } : {}),
  };
  const durationMs =
    parseDurationMs(durationSource) ??
    (nestedMetadata ? parseDurationMs(nestedMetadata) : undefined) ??
    (recordMetadata && recordMetadata !== nestedMetadata
      ? parseDurationMs(recordMetadata)
      : undefined);
  const status = (
    asString(outputObject?.status) ??
    asString(outputObject?.state) ??
    asString(rawRecord.status) ??
    asString(rawRecord.state) ??
    asString(recordMetadata?.status) ??
    asString(recordMetadata?.state) ??
    ""
  ).toLowerCase();
  const isTruncated =
    outputObject?.truncated === true ||
    outputObject?.is_truncated === true ||
    outputObject?.output_truncated === true ||
    rawRecord.truncated === true ||
    rawRecord.is_truncated === true ||
    rawRecord.output_truncated === true ||
    nestedMetadata?.truncated === true ||
    nestedMetadata?.is_truncated === true ||
    nestedMetadata?.output_truncated === true ||
    recordMetadata?.truncated === true ||
    recordMetadata?.is_truncated === true ||
    recordMetadata?.output_truncated === true;
  const statusOutcome: NativeOutcome | undefined =
    isTruncated || status === "truncated" || status === "incomplete" || status === "partial"
      ? "truncated"
      : status === "failed" ||
          status === "error" ||
          status === "cancelled" ||
          status === "canceled" ||
          outputObject?.is_error === true ||
          outputObject?.isError === true ||
          outputObject?.success === false ||
          rawRecord.is_error === true ||
          rawRecord.isError === true ||
          rawRecord.success === false ||
          (outputObject?.error !== undefined && outputObject.error !== null) ||
          (rawRecord.error !== undefined && rawRecord.error !== null)
        ? "failed"
        : status === "running" ||
            status === "in_progress" ||
            status === "in-progress" ||
            status === "pending"
          ? "running"
          : status === "unknown" ||
              status === "uncertain" ||
              outputObject?.completed === false ||
              rawRecord.completed === false
            ? "unknown"
            : status === "completed" ||
                status === "complete" ||
                status === "success" ||
                status === "succeeded" ||
                outputObject?.completed === true ||
                rawRecord.completed === true
              ? "completed"
              : undefined;
  let result: CodexTranscriptValue = rawOutput ?? null;
  if (outputObject) {
    const stdout = asString(outputObject.stdout);
    const stderr = asString(outputObject.stderr);
    const body = outputObject.output ?? outputObject.result ?? outputObject.content;
    if (stdout !== undefined || stderr !== undefined) {
      result =
        stderr !== undefined && stderr.length > 0
          ? { stdout: stdout ?? "", stderr }
          : (stdout ?? "");
    } else if (body !== undefined) {
      result = body;
    }
  }

  const formatted = asString(rawOutput);
  if (formatted !== undefined) {
    const unified = formatted.match(
      /^Chunk ID: [A-Za-z0-9_-]+\r?\nWall time: (\d+(?:\.\d+)?(?:s| seconds?)?)\r?\nProcess exited with code (-?\d+)\r?\nFinal output:\r?\n([\s\S]*)$/,
    );
    if (unified) {
      const wallTimeMs = parseWallTimeMs(unified[1]);
      const formattedExitCode = Number(unified[2]);
      return {
        result: unified[3] ?? "",
        exitCode: formattedExitCode,
        durationMs: wallTimeMs ?? durationMs,
        outcome: statusOutcome ?? (formattedExitCode === 0 ? "completed" : "failed"),
      };
    }

    const running = formatted.match(
      /^Chunk ID: [A-Za-z0-9_-]+\r?\nWall time: (\d+(?:\.\d+)?(?:s| seconds?)?)\r?\nProcess running with session ID:?[ \t]*[A-Za-z0-9_-]+(?:\r?\nFinal output:\r?\n([\s\S]*))?(?:\r?\n)?$/,
    );
    if (running) {
      return {
        result: running[2] ?? "",
        durationMs: parseWallTimeMs(running[1]) ?? durationMs,
        outcome: statusOutcome ?? "running",
      };
    }

    const shellCommand = formatted.match(
      /^Exit code: (-?\d+)\r?\nWall time: (\d+(?:\.\d+)?(?:s| seconds?)?)\r?\nOutput:\r?\n([\s\S]*)$/,
    );
    if (shellCommand) {
      const formattedExitCode = Number(shellCommand[1]);
      return {
        result: shellCommand[3] ?? "",
        exitCode: formattedExitCode,
        durationMs: parseWallTimeMs(shellCommand[2]) ?? durationMs,
        outcome: statusOutcome ?? (formattedExitCode === 0 ? "completed" : "failed"),
      };
    }
  }

  const outcome =
    statusOutcome ?? (exitCode === undefined ? "unknown" : exitCode === 0 ? "completed" : "failed");

  return {
    result,
    exitCode,
    durationMs,
    outcome,
  };
}

function parseWallTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value.replace(/(?: seconds?|s)$/i, ""));
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 1000) : undefined;
}

function isNativeTerminalTool(toolName: string): boolean {
  return (
    toolName === "exec_command" ||
    toolName === "write_stdin" ||
    toolName === "shell_command" ||
    toolName === "terminal"
  );
}

function stableNativeItemKey(item: CodexTranscriptPayload): string {
  const itemType = asString(item.type) ?? "unknown";
  const callId = asString(item.call_id) ?? asString(item.callId);
  const itemId = asString(item.id);
  if (callId || itemId) {
    return `${itemType}:${itemId ?? ""}:${callId ?? ""}`;
  }
  return `${itemType}:${JSON.stringify(item)}`;
}

function sumUsageRecords(records: readonly CodexTranscriptPayload[]): CodexTranscriptPayload {
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const;
  const totals: CodexTranscriptPayload = {};
  for (const key of keys) {
    let sum = 0;
    let seen = false;
    for (const record of records) {
      const value = parseNonNegativeInt(record[key]);
      if (value !== undefined) {
        sum += value;
        seen = true;
      }
    }
    if (seen && Number.isSafeInteger(sum)) totals[key] = sum;
  }
  return totals;
}
interface CodexExtractedTokens {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  hasAnyMetrics: boolean;
}

function nativeContentText(value: CodexTranscriptValue | undefined): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const parts = asArray(value);
  if (!parts) return undefined;
  const text = parts
    .map((part) => {
      if (asString(part) !== undefined) return asString(part);
      const item = asObject(part);
      return asString(item?.text) ?? asString(item?.output_text) ?? "";
    })
    .filter((part) => part !== "")
    .join("\n");
  return text || undefined;
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
    parseNonNegativeInt(raw.reasoning_output_tokens) ??
    parseNonNegativeInt(raw.reasoningOutputTokens) ??
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

/** Native context scoped to one thread within a rollout. */
interface CodexNativeThreadContext {
  threadId?: string;
  rootThreadId?: string;
  nativeSessionId?: string;
  turnId?: string;
  rootTurnId?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  effort?: string;
  contextWindow?: number;
}

interface CodexNativeThreadUsage {
  turnId?: string;
  turnUsage?: CodexTranscriptPayload;
  lastTokenUsage?: CodexTranscriptPayload;
  responseUsage: CodexTranscriptPayload[];
  responseIds: Set<string>;
  cumulativeUsage?: CodexTranscriptPayload;
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
  private callMap = new Map<
    string,
    {
      toolName: string;
      toolCallId: string;
      eventId: string;
      connection?: string;
      metadata?: CodexTranscriptPayload;
      callEvent?: NormalizedToolCallEvent;
    }
  >();
  private hasEmittedTurnUsage = false;
  private lastCumulativeUsage?: {
    rawUsage: CodexTranscriptPayload;
    rawPayload: CodexTranscriptPayload;
  };
  private currentMetadata?: CodexTranscriptPayload;
  private nativeContexts = new Map<string, CodexNativeThreadContext>();
  private currentNativeContext?: CodexNativeThreadContext;
  private currentNativeThreadId?: string;
  private seenNativeItems = new Set<string>();
  private seenNativeItemOrder: string[] = [];
  private seenNativeAssistantMessages = new Set<string>();
  private seenNativeMessageKeys = new Map<
    string,
    { responseItem: number; itemCompleted: number }
  >();
  private nativeUsageByThread = new Map<string, CodexNativeThreadUsage>();
  private nativeStartedThreads = new Set<string>();
  private seenNativeTerminalTurns = new Set<string>();

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

  private nativeCallMapKey(callId: string, metadata = this.currentMetadata): string {
    const nativeMetadata = asObject(metadata?.codexNative);
    const threadId = asString(nativeMetadata?.threadId) ?? this.currentNativeThreadId;
    return threadId ? `native:${threadId}:${callId}` : callId;
  }

  private nativeUsageState(threadId = this.currentNativeThreadId): CodexNativeThreadUsage {
    const key = threadId ?? this.sessionId;
    let state = this.nativeUsageByThread.get(key);
    if (!state) {
      state = { responseUsage: [], responseIds: new Set<string>() };
      this.nativeUsageByThread.set(key, state);
    }
    return state;
  }

  private resetNativeTurnUsage(threadId = this.currentNativeThreadId, turnId?: string): void {
    const state = this.nativeUsageState(threadId);
    state.turnId = turnId;
    state.turnUsage = undefined;
    state.lastTokenUsage = undefined;
    state.responseUsage = [];
    state.responseIds.clear();
    state.cumulativeUsage = undefined;
  }

  private rememberNativeItem(item: CodexTranscriptPayload, threadId?: string): boolean {
    const key = `${threadId ?? ""}:${stableNativeItemKey(item)}`;
    if (this.seenNativeItems.has(key)) return false;
    if (this.seenNativeItems.size >= 4096) {
      const oldest = this.seenNativeItemOrder.shift();
      if (oldest !== undefined) this.seenNativeItems.delete(oldest);
    }
    this.seenNativeItemOrder.push(key);
    this.seenNativeItems.add(key);
    return true;
  }

  private rememberNativeAssistantMessage(text: string, context: CodexNativeThreadContext): boolean {
    const key = `${context.threadId ?? ""}:${context.turnId ?? ""}:${text}`;
    if (this.seenNativeAssistantMessages.has(key)) return false;
    if (this.seenNativeAssistantMessages.size >= 4096) {
      const oldest = this.seenNativeAssistantMessages.values().next().value as string | undefined;
      if (oldest !== undefined) this.seenNativeAssistantMessages.delete(oldest);
    }
    this.seenNativeAssistantMessages.add(key);
    return true;
  }
  private rememberNativeMessage(
    role: "user" | "assistant",
    text: string,
    context: CodexNativeThreadContext,
    source?: "response_item" | "item_completed",
  ): boolean {
    if (!source) return true;
    const key = JSON.stringify([context.threadId, context.turnId, role, text]);
    let counts = this.seenNativeMessageKeys.get(key);
    if (!counts) {
      if (this.seenNativeMessageKeys.size >= 4096) {
        const oldest = this.seenNativeMessageKeys.keys().next().value as string | undefined;
        if (oldest !== undefined) this.seenNativeMessageKeys.delete(oldest);
      }
      counts = { responseItem: 0, itemCompleted: 0 };
      this.seenNativeMessageKeys.set(key, counts);
    }
    const ownCount = source === "response_item" ? counts.responseItem : counts.itemCompleted;
    const otherCount = source === "response_item" ? counts.itemCompleted : counts.responseItem;
    if (source === "response_item") counts.responseItem += 1;
    else counts.itemCompleted += 1;
    return otherCount <= ownCount;
  }

  private nativeMetadataWithOutcome(
    outcome: NativeOutcome,
    extra?: CodexTranscriptPayload,
  ): CodexTranscriptPayload {
    const metadata = { ...(this.currentMetadata ?? {}) };
    const native = { ...(asObject(metadata.codexNative) ?? {}), outcome, ...(extra ?? {}) };
    metadata.codexNative = native;
    this.currentMetadata = metadata;
    return metadata;
  }

  private prepareNativeRecord(
    wrapperType: string,
    envelope: CodexTranscriptPayload,
    payload: CodexTranscriptPayload,
  ): CodexTranscriptPayload {
    const priorMetadata = { ...(this.currentMetadata ?? {}) };
    delete priorMetadata.codexNative;
    const sourceMetadata = {
      ...priorMetadata,
      ...(asObject(payload.metadata) ?? {}),
      ...(asObject(envelope.metadata) ?? {}),
    };
    const priorNative = asObject(asObject(envelope.metadata)?.codexNative) ?? {};
    const currentThreadId =
      asString(payload.thread_id) ??
      asString(payload.threadId) ??
      asString(sourceMetadata.threadId) ??
      asString(priorNative.threadId) ??
      (wrapperType === "session_meta" ? asString(payload.id) : undefined) ??
      this.currentNativeThreadId;
    const contextKey = currentThreadId ?? this.sessionId;
    const previous = this.nativeContexts.get(contextKey) ?? {};
    const sessionId = asString(payload.session_id);
    const rootThreadId =
      asString(payload.root_thread_id) ??
      asString(payload.rootThreadId) ??
      asString(payload.root_id) ??
      asString(payload.rootId) ??
      asString(sourceMetadata.rootThreadId) ??
      asString(sourceMetadata.rootId) ??
      (wrapperType === "session_meta" ? sessionId : undefined);
    const turnId = asString(payload.turn_id) ?? asString(payload.turnId);
    const rootTurnId = asString(payload.root_turn_id) ?? asString(payload.rootTurnId);
    const context: CodexNativeThreadContext = {
      ...previous,
      ...(currentThreadId ? { threadId: currentThreadId } : {}),
      ...(rootTurnId ? { rootTurnId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(asString(payload.cwd) ? { cwd: asString(payload.cwd) } : {}),
      ...(asString(payload.model) ? { model: asString(payload.model) } : {}),
      ...(asString(payload.model_provider)
        ? { modelProvider: asString(payload.model_provider) }
        : {}),
      ...(asString(payload.effort) ? { effort: asString(payload.effort) } : {}),
      ...(asNumber(payload.context_window) !== undefined
        ? { contextWindow: asNumber(payload.context_window) }
        : {}),
      ...(wrapperType === "session_meta" && sessionId ? { nativeSessionId: sessionId } : {}),
      ...(rootThreadId ? { rootThreadId } : {}),
    };
    const newTurn = context.turnId !== previous.turnId && context.turnId !== undefined;
    if (newTurn) this.resetNativeTurnUsage(currentThreadId, context.turnId);
    this.nativeContexts.set(contextKey, context);
    this.currentNativeContext = context;
    this.currentNativeThreadId = context.threadId;

    const nativeMetadata: CodexTranscriptPayload = {
      ...priorNative,
      type: wrapperType,
      ...(asNumber(envelope.ordinal) !== undefined ? { ordinal: asNumber(envelope.ordinal) } : {}),
      ...(asString(payload.type) ? { eventType: asString(payload.type) } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      ...(context.rootThreadId ? { rootThreadId: context.rootThreadId } : {}),
      ...(context.nativeSessionId ? { nativeSessionId: context.nativeSessionId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.rootTurnId ? { rootTurnId: context.rootTurnId } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.model ? { model: context.model } : {}),
      ...(context.modelProvider ? { modelProvider: context.modelProvider } : {}),
      ...(context.effort ? { effort: context.effort } : {}),
      ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
    };
    const metadata: CodexTranscriptPayload = {
      ...sourceMetadata,
      codexNative: nativeMetadata,
    };
    this.currentMetadata = metadata;
    return metadata;
  }

  private saveNativeUsageRecord(payload: CodexTranscriptPayload): void {
    const threadId = asString(payload.thread_id) ?? this.currentNativeThreadId;
    let state = this.nativeUsageState(threadId);
    const turnId = asString(payload.turn_id);
    if (turnId && state.turnId !== turnId) {
      this.resetNativeTurnUsage(threadId, turnId);
      state = this.nativeUsageState(threadId);
    }
    const turnUsage = asObject(payload.turn_token_usage);
    const responseUsage = asObject(payload.usage);
    const cumulativeUsage = asObject(payload.thread_token_usage);
    const responseId = asString(payload.response_id);
    if (turnUsage) state.turnUsage = turnUsage;
    if (cumulativeUsage) state.cumulativeUsage = cumulativeUsage;
    if (responseUsage && (!responseId || !state.responseIds.has(responseId))) {
      if (responseId) state.responseIds.add(responseId);
      state.responseUsage.push(responseUsage);
    }
  }

  private nativeTurnUsage(
    state: CodexNativeThreadUsage,
  ): { rawUsage: CodexTranscriptPayload; isLastResponseSnapshot: boolean } | undefined {
    if (state.turnUsage) {
      return { rawUsage: state.turnUsage, isLastResponseSnapshot: false };
    }
    if (state.responseUsage.length > 0) {
      return {
        rawUsage: sumUsageRecords(state.responseUsage),
        isLastResponseSnapshot: false,
      };
    }
    if (state.lastTokenUsage) {
      return { rawUsage: state.lastTokenUsage, isLastResponseSnapshot: true };
    }
    return undefined;
  }

  private nativeProviderUsage(
    rawUsage: CodexTranscriptPayload,
    threadId: string | undefined,
    isLastResponseSnapshot: boolean,
  ): ProviderReportedUsage | undefined {
    const context =
      this.nativeContexts.get(threadId ?? this.sessionId) ?? this.currentNativeContext;
    const rawPayload: CodexTranscriptPayload = {
      ...(context?.modelProvider ? { provider: context.modelProvider } : {}),
      ...(context?.model ? { model: context.model } : {}),
    };
    const preserveUnavailable =
      asString(rawUsage.availability) === "unavailable" || rawUsage.unavailable === true;
    const usage =
      isLastResponseSnapshot && !preserveUnavailable
        ? { ...rawUsage, availability: "partial" }
        : rawUsage;
    return buildProviderUsage(usage, rawPayload, "codex-cli-native-rollout-v1");
  }

  private normalizeNativeItem(
    item: CodexTranscriptPayload,
    timestamp?: string,
    metadata = this.currentMetadata,
  ): NormalizedSessionEvent[] {
    const threadId =
      asString(asObject(metadata?.codexNative)?.threadId) ?? this.currentNativeThreadId;
    if (!this.rememberNativeItem(item, threadId)) return [];
    const itemType = asString(item.type)?.toLowerCase();
    const itemRole =
      itemType === "usermessage" || itemType === "user_message"
        ? "user"
        : itemType === "agentmessage" || itemType === "agent_message"
          ? "assistant"
          : itemType === "message"
            ? asString(item.role)?.toLowerCase()
            : undefined;
    const role = itemRole === "user" || itemRole === "assistant" ? itemRole : undefined;
    const itemTurnId =
      asString(item.turn_id) ??
      asString(asObject(item.internal_chat_message_metadata_passthrough)?.turn_id);
    const messageContext: CodexNativeThreadContext = {
      ...(this.currentNativeContext ?? {}),
      ...(threadId ? { threadId } : {}),
      ...(itemTurnId ? { turnId: itemTurnId } : {}),
    };
    const text = nativeContentText(item.content);
    const nativeType = asString(asObject(metadata?.codexNative)?.type);
    const nativeEventType = asString(asObject(metadata?.codexNative)?.eventType)?.toLowerCase();
    const messageSource =
      nativeType === "response_item"
        ? "response_item"
        : nativeType === "event_msg" && nativeEventType === "item_completed"
          ? "item_completed"
          : undefined;
    if (role && text !== undefined) {
      if (!this.rememberNativeMessage(role, text, messageContext, messageSource)) return [];
      if (role === "assistant") this.rememberNativeAssistantMessage(text, messageContext);
    }
    const isMessageAlias =
      itemType === "usermessage" ||
      itemType === "agentmessage" ||
      itemType === "user_message" ||
      itemType === "agent_message";
    const itemMetadata = asObject(item.metadata);
    const combinedMetadata =
      itemMetadata || metadata
        ? {
            ...(itemMetadata ?? {}),
            ...(metadata ?? {}),
            ...(itemMetadata?.codexNative || metadata?.codexNative
              ? {
                  codexNative: {
                    ...(asObject(itemMetadata?.codexNative) ?? {}),
                    ...(asObject(metadata?.codexNative) ?? {}),
                  },
                }
              : {}),
          }
        : undefined;
    const normalizedItem: CodexTranscriptPayload = {
      ...item,
      ...(isMessageAlias && role ? { type: "message", role } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(combinedMetadata ? { metadata: combinedMetadata } : {}),
    };
    if (normalizedItem.model === undefined && this.currentNativeContext?.model) {
      normalizedItem.model = this.currentNativeContext.model;
    }
    if (itemTurnId && combinedMetadata) {
      normalizedItem.metadata = {
        ...combinedMetadata,
        codexNative: {
          ...(asObject(combinedMetadata.codexNative) ?? {}),
          turnId: itemTurnId,
        },
      };
      this.currentMetadata = normalizedItem.metadata;
    }
    return this.normalizePayload(normalizedItem);
  }

  private nativeLifecycle(
    lifecycleType: "start" | "resume" | "end" | "crash",
    timestamp: string | undefined,
    rawEventId: string | undefined,
    outcome: NativeOutcome,
    exitReason?: string,
  ): NormalizedSessionLifecycleEvent {
    const isTerminal = lifecycleType === "end" || lifecycleType === "crash";
    const threadId = this.currentNativeThreadId;
    const state = this.nativeUsageState(threadId);
    const turnUsage = this.nativeTurnUsage(state);
    const rawUsage = turnUsage?.rawUsage;
    const usage =
      isTerminal && turnUsage
        ? this.nativeProviderUsage(turnUsage.rawUsage, threadId, turnUsage.isLastResponseSnapshot)
        : undefined;
    const cacheWriteInputTokens =
      rawUsage && parseNonNegativeInt(rawUsage.cache_write_input_tokens);
    const metadata = this.nativeMetadataWithOutcome(outcome, {
      lifecycle: asString(asObject(this.currentMetadata?.codexNative)?.eventType) ?? "unknown",
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
      ...(state.cumulativeUsage ? { threadTokenUsage: state.cumulativeUsage } : {}),
    });
    const header = this.emitHeader("session_lifecycle", timestamp, rawEventId, metadata);
    const event: NormalizedSessionLifecycleEvent = {
      ...header,
      type: "session_lifecycle",
      lifecycleType,
      harnessName: "codex-cli",
      workspaceId: this.workspaceId,
    };
    if (exitReason) event.exitReason = exitReason;
    if (usage) event.providerUsage = usage;
    if (isTerminal) this.resetNativeTurnUsage(threadId, this.currentNativeContext?.turnId);
    return event;
  }

  private normalizeNativeTaskStarted(
    payload: CodexTranscriptPayload,
    timestamp?: string,
  ): NormalizedSessionEvent[] {
    const turnId = asString(payload.turn_id);
    if (turnId && turnId !== this.currentNativeContext?.turnId) {
      this.currentNativeContext = { ...(this.currentNativeContext ?? {}), turnId };
    }
    const threadKey = this.currentNativeThreadId ?? this.sessionId;
    const lifecycleType = this.nativeStartedThreads.has(threadKey) ? "resume" : "start";
    this.nativeStartedThreads.add(threadKey);
    return [
      this.nativeLifecycle(
        lifecycleType,
        timestamp,
        asString(payload.id),
        "running",
        "turn_started",
      ),
    ];
  }

  private normalizeNativeTerminal(
    eventType: string,
    payload: CodexTranscriptPayload,
    timestamp?: string,
  ): NormalizedSessionEvent[] {
    const errorPayload = asObject(payload.error);
    const errorText =
      asString(errorPayload?.message) ??
      asString(payload.error) ??
      asString(payload.error_message) ??
      asString(payload.message) ??
      (errorPayload ? JSON.stringify(errorPayload) : undefined);
    const status = asString(payload.status)?.toLowerCase();
    const aborted =
      /abort|interrupt|cancel/.test(eventType) ||
      status === "aborted" ||
      status === "interrupted" ||
      status === "cancelled" ||
      status === "canceled";
    const failed =
      aborted ||
      /fail|error/.test(eventType) ||
      (payload.error !== undefined && payload.error !== null) ||
      errorText !== undefined ||
      payload.success === false ||
      payload.is_error === true ||
      status === "failed" ||
      status === "error";

    const context = this.currentNativeContext;
    const terminalKey = `${context?.threadId ?? this.sessionId}:${context?.turnId ?? eventType}`;
    if (this.seenNativeTerminalTurns.has(terminalKey)) return [];
    if (this.seenNativeTerminalTurns.size >= 4096) {
      const oldest = this.seenNativeTerminalTurns.values().next().value as string | undefined;
      if (oldest !== undefined) this.seenNativeTerminalTurns.delete(oldest);
    }
    this.seenNativeTerminalTurns.add(terminalKey);
    const outcome: NativeOutcome = failed ? "failed" : "completed";
    const events: NormalizedSessionEvent[] = [];

    const lastMessage = asString(payload.last_agent_message);
    if (
      !failed &&
      lastMessage &&
      context &&
      this.rememberNativeAssistantMessage(lastMessage, context)
    ) {
      events.push(
        ...this.normalizePayload({
          type: "assistant_message",
          content: lastMessage,
          timestamp,
          ...(context.model ? { model: context.model } : {}),
          ...(this.currentMetadata ? { metadata: this.currentMetadata } : {}),
        }),
      );
    }

    if (failed && !aborted) {
      const message = errorText ?? "Codex native turn failed";
      const errorMetadata = this.nativeMetadataWithOutcome(outcome, {
        termination: eventType,
        ...(asString(payload.id) ? { nativeEventId: asString(payload.id) } : {}),
      });
      const header = this.emitHeader("error", timestamp, undefined, errorMetadata);
      const errorEvent: NormalizedErrorEvent = {
        ...header,
        type: "error",
        errorType: asString(errorPayload?.code) ?? "CODEX_TURN_FAILED",
        message,
        recoverable: false,
      };
      events.push(errorEvent);
    }

    events.push(
      this.nativeLifecycle(
        failed ? "crash" : "end",
        timestamp,
        asString(payload.id),
        outcome,
        aborted ? (asString(payload.reason) ?? "aborted") : failed ? "failed" : "completed",
      ),
    );
    return events;
  }
  private normalizeNativeMcpEvent(
    eventType: string,
    payload: CodexTranscriptPayload,
    timestamp?: string,
  ): NormalizedSessionEvent[] {
    const invocation = asObject(payload.invocation);
    const callId = asString(payload.call_id);
    const toolName = asString(invocation?.tool);
    const connection = asString(invocation?.server);
    if (!invocation || !callId || !toolName || !connection) {
      return this.normalizePayload({
        ...payload,
        ...(timestamp ? { timestamp } : {}),
        ...(this.currentMetadata ? { metadata: this.currentMetadata } : {}),
        type: `native_${eventType}`,
      });
    }
    const callKey = this.nativeCallMapKey(callId);
    const cached = this.callMap.get(callKey);

    if (eventType === "mcp_tool_call_begin") {
      if (cached) {
        if (cached.callEvent) {
          cached.callEvent.connection = connection;
          const metadata = { ...(cached.callEvent.metadata ?? {}) };
          const existingCodexNative = CodexTranscriptValueSchema.safeParse(metadata.codexNative);
          metadata.codexNative = {
            ...(existingCodexNative.success ? (asObject(existingCodexNative.data) ?? {}) : {}),
            connection,
          };
          cached.callEvent.metadata = metadata;
        }
        return [];
      }
      const metadata = {
        ...(this.currentMetadata ?? {}),
        codexNative: {
          ...(asObject(this.currentMetadata?.codexNative) ?? {}),
          connection,
        },
      };
      this.currentMetadata = metadata;
      const header = this.emitHeader("tool_call", timestamp, asString(payload.id), metadata);
      const parameters = parseToolParameters(invocation.arguments);
      const callEvent: NormalizedToolCallEvent = {
        ...header,
        type: "tool_call",
        callId,
        toolName,
        connection,
        parameters,
        isShadow: false,
      };
      this.callMap.set(callKey, {
        toolName,
        toolCallId: callId,
        eventId: header.eventId,
        connection,
        metadata,
        callEvent,
      });
      return [callEvent];
    }

    if (eventType !== "mcp_tool_call_end") return [];
    const resultEnvelope = asObject(payload.result);
    const successResult =
      asObject(resultEnvelope?.Ok) ?? asObject(resultEnvelope?.ok) ?? resultEnvelope;
    const errorText =
      asString(resultEnvelope?.Err) ??
      asString(resultEnvelope?.err) ??
      asString(asObject(resultEnvelope?.Err)?.message);
    const content = asArray(successResult?.content);
    const textContent =
      content?.length && content.every((entry) => asString(asObject(entry)?.text) !== undefined)
        ? content.map((entry) => asString(asObject(entry)?.text) ?? "").join("\n")
        : undefined;
    const structuredContent = successResult?.structured_content ?? successResult?.structuredContent;
    const result =
      errorText ??
      textContent ??
      structuredContent ??
      successResult?.content ??
      successResult ??
      {};
    const isError =
      errorText !== undefined ||
      successResult?.is_error === true ||
      successResult?.isError === true ||
      (resultEnvelope?.Err !== undefined && resultEnvelope?.Err !== null);
    const outcome: NativeOutcome =
      payload.result === undefined || payload.result === null
        ? "unknown"
        : isError
          ? "failed"
          : "completed";
    const nativeMetadata = this.nativeMetadataWithOutcome(outcome, { connection });
    const header = this.emitHeader("tool_result", timestamp, asString(payload.id), nativeMetadata);
    const durationMs = parseDurationMs(payload) ?? 0;
    const event: NormalizedToolResultEvent = {
      ...header,
      type: "tool_result",
      callId,
      toolName: cached?.toolName ?? toolName,
      result,
      isError,
      executionDurationMs: durationMs,
      isShadow: false,
    };
    return [event];
  }

  private normalizeNativeEnvelope(
    wrapperType: string,
    envelope: CodexTranscriptPayload,
    payload: CodexTranscriptPayload,
  ): NormalizedSessionEvent[] {
    const metadata = this.prepareNativeRecord(wrapperType, envelope, payload);
    const timestamp =
      asString(envelope.timestamp) ?? asString(payload.timestamp) ?? asString(envelope.created_at);
    if (wrapperType === "session_meta" || wrapperType === "turn_context") return [];
    if (wrapperType === "token_usage_record") {
      this.saveNativeUsageRecord(payload);
      return [];
    }
    if (wrapperType === "response_item") {
      const itemType = asString(payload.type);
      const itemMetadata = {
        ...metadata,
        codexNative: {
          ...(asObject(metadata.codexNative) ?? {}),
          ...(itemType ? { itemType } : {}),
          ...(asString(payload.namespace) ? { namespace: asString(payload.namespace) } : {}),
        },
      };
      this.currentMetadata = itemMetadata;
      return this.normalizeNativeItem(payload, timestamp, itemMetadata);
    }
    if (wrapperType !== "event_msg") {
      return this.normalizePayload({
        ...payload,
        timestamp,
        metadata,
        type: wrapperType,
      });
    }

    const eventType = (asString(payload.type) ?? "").toLowerCase();
    if (eventType === "task_started") {
      return this.normalizeNativeTaskStarted(payload, timestamp);
    }
    if (
      eventType === "task_complete" ||
      eventType === "task_failed" ||
      eventType === "turn_failed" ||
      eventType === "task_aborted" ||
      eventType === "turn_aborted" ||
      eventType === "turn_interrupted"
    ) {
      return this.normalizeNativeTerminal(eventType, payload, timestamp);
    }
    if (eventType === "item_completed") {
      const item = asObject(payload.item);
      if (!item) return [];
      const itemMetadata = {
        ...metadata,
        codexNative: {
          ...(asObject(metadata.codexNative) ?? {}),
          ...(asString(item.type) ? { itemType: asString(item.type) } : {}),
        },
      };
      this.currentMetadata = itemMetadata;
      return this.normalizeNativeItem(item, timestamp, itemMetadata);
    }
    if (eventType === "token_count") {
      const state = this.nativeUsageState(this.currentNativeThreadId);
      const info = asObject(payload.info);
      const lastUsage = asObject(info?.last_token_usage);
      const totalUsage = asObject(info?.total_token_usage);
      if (lastUsage) state.lastTokenUsage = lastUsage;
      if (totalUsage) state.cumulativeUsage = totalUsage;
      return [];
    }
    if (eventType === "mcp_tool_call_begin" || eventType === "mcp_tool_call_end") {
      return this.normalizeNativeMcpEvent(eventType, payload, timestamp);
    }
    if (eventType === "error") {
      const error = asObject(payload.error);
      const message =
        asString(error?.message) ??
        asString(payload.message) ??
        asString(payload.error) ??
        "Codex native event error";
      const errorMetadata = this.nativeMetadataWithOutcome("failed", { termination: eventType });
      const header = this.emitHeader("error", timestamp, asString(payload.id), errorMetadata);
      const event: NormalizedErrorEvent = {
        ...header,
        type: "error",
        errorType: asString(error?.code) ?? "CODEX_EVENT_ERROR",
        message,
        recoverable: false,
      };
      return [event];
    }

    return this.normalizePayload({
      ...payload,
      timestamp,
      metadata,
      type: `native_${eventType || "event"}`,
    });
  }

  private normalizePayload(p: CodexTranscriptPayload): NormalizedSessionEvent[] {
    const envelopeType = asString(p.type)?.toLowerCase();
    const envelopePayload = asObject(p.payload);
    if (
      envelopePayload &&
      (envelopeType === "session_meta" ||
        envelopeType === "turn_context" ||
        envelopeType === "response_item" ||
        envelopeType === "event_msg" ||
        envelopeType === "token_usage_record" ||
        envelopeType === "world_state")
    ) {
      return this.normalizeNativeEnvelope(envelopeType, p, envelopePayload);
    }

    const events: NormalizedSessionEvent[] = [];

    const metaObj = asObject(p.metadata);
    if (metaObj) {
      this.currentMetadata = metaObj;
    }

    const rawSessionId = asString(p.sessionId) ?? asString(p.session_id);

    const timestamp =
      asString(p.timestamp) ?? asString(p.created_at) ?? asString(p.time) ?? asString(p.datetime);

    const rawEventId = asString(p.eventId) ?? asString(p.event_id) ?? asString(p.id);

    let rawType = String(
      asString(p.type) ??
        asString(p.event) ??
        asString(p.role) ??
        asString(p.item_type) ??
        asString(p.kind) ??
        "",
    ).toLowerCase();
    if (rawType === "message") {
      const role = asString(p.role)?.toLowerCase();
      rawType =
        role === "user"
          ? "user_message"
          : role === "assistant"
            ? "assistant_message"
            : role === "system" || role === "developer"
              ? "system_message"
              : rawType;
    } else if (rawType === "agent_message") {
      rawType = "assistant_message";
    }

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
          // A tool's provider is the connection it was reached over. The harness id is not one: a
          // record that names no connection leaves the entry without one, never with a guess.
          provider: asString(item.provider),
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
      rawType === "custom_tool_call" ||
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
      const codexNative = asObject(asObject(p.metadata)?.codexNative);
      const nativeCallId = asString(p.callId) ?? asString(p.call_id) ?? asString(p.tool_call_id);
      if (codexNative && !nativeCallId) {
        events.push({
          ...this.emitHeader("unknown_passthrough", timestamp, rawEventId),
          type: "unknown_passthrough",
          rawEventType: rawType,
          rawPayload: p,
        });
        return events;
      }
      const toolCallId = nativeCallId ?? asString(p.id) ?? generateEventId("call");
      const callKey = this.nativeCallMapKey(toolCallId, asObject(p.metadata));
      const existing = this.callMap.get(callKey);
      if (existing?.callEvent) {
        return events;
      }
      const rawArgs = fnObj.arguments ?? fnObj.params ?? p.input ?? p.args ?? {};
      const parameters = parseToolParameters(rawArgs);
      const connection = asString(p.connection) ?? asString(p.server);
      const nativeFields: CodexTranscriptPayload = {
        ...(connection ? { connection } : {}),
        ...(asString(p.namespace) ? { namespace: asString(p.namespace) } : {}),
      };
      const header = this.emitHeader("tool_call", timestamp, rawEventId);
      if (codexNative && Object.keys(nativeFields).length > 0) {
        const metadata = { ...(header.metadata ?? {}) };
        metadata.codexNative = {
          ...(asObject(metadata.codexNative) ?? {}),
          ...nativeFields,
        };
        header.metadata = metadata;
      }
      const candidateRef = asString(p.candidateRef);
      const callEvt: NormalizedToolCallEvent = {
        ...header,
        type: "tool_call",
        callId: toolCallId,
        toolName,
        parameters,
        isShadow: false,
      };
      if (connection) callEvt.connection = connection;
      if (candidateRef) callEvt.candidateRef = candidateRef;
      if (callUsage) callEvt.providerUsage = callUsage;
      this.callMap.set(callKey, {
        toolName,
        toolCallId,
        eventId: header.eventId,
        ...(connection ? { connection } : {}),
        ...(header.metadata ? { metadata: header.metadata } : {}),
        callEvent: callEvt,
      });
      events.push(callEvt);
      return events;
    }

    // 8. Tool Result Events
    if (
      rawType === "tool_result" ||
      rawType === "function_result" ||
      rawType === "function_call_output" ||
      rawType === "custom_tool_call_output" ||
      rawType === "action_result" ||
      rawType === "tool_response" ||
      rawType === "result" ||
      rawType === "tool_error"
    ) {
      let resUsage: ProviderReportedUsage | undefined;
      if (turnUsageRec) {
        resUsage = buildProviderUsage(turnUsageRec, p, "codex-cli-transcript-v1");
        if (resUsage) this.hasEmittedTurnUsage = true;
      } else if (cumUsageRec) {
        this.lastCumulativeUsage = { rawUsage: cumUsageRec, rawPayload: p };
      }

      const codexNative = asObject(asObject(p.metadata)?.codexNative);
      const nativeCallId = asString(p.callId) ?? asString(p.call_id) ?? asString(p.tool_call_id);
      if (codexNative && !nativeCallId) {
        events.push({
          ...this.emitHeader("unknown_passthrough", timestamp, rawEventId),
          type: "unknown_passthrough",
          rawEventType: rawType,
          rawPayload: p,
        });
        return events;
      }
      const callId = nativeCallId ?? asString(p.id) ?? generateEventId("call");
      const callKey = this.nativeCallMapKey(callId, asObject(p.metadata));
      const cached = this.callMap.get(callKey) ?? this.callMap.get(callId);
      const toolName = String(
        asString(p.toolName) ??
          asString(p.tool_name) ??
          asString(p.name) ??
          cached?.toolName ??
          "unknown_tool",
      );
      const rawResult = p.result ?? p.output ?? p.content ?? p.data ?? p.response;
      const terminalOutput =
        codexNative && isNativeTerminalTool(toolName)
          ? parseNativeShellOutput(rawResult, p)
          : undefined;
      const outputObject = asObject(rawResult);
      const status = (
        asString(p.status) ??
        asString(outputObject?.status) ??
        asString(outputObject?.state) ??
        ""
      ).toLowerCase();
      const isError = Boolean(
        p.is_error ||
          p.isError ||
          p.error ||
          rawType === "tool_error" ||
          p.success === false ||
          outputObject?.is_error === true ||
          outputObject?.isError === true ||
          outputObject?.success === false ||
          (outputObject?.error !== undefined && outputObject.error !== null) ||
          terminalOutput?.outcome === "failed" ||
          (terminalOutput?.exitCode !== undefined && terminalOutput.exitCode !== 0) ||
          status === "failed" ||
          status === "error" ||
          status === "cancelled" ||
          status === "canceled",
      );
      const outcome: NativeOutcome = isError
        ? "failed"
        : (terminalOutput?.outcome ??
          (status === "running" || status === "in_progress" || status === "pending"
            ? "running"
            : status === "truncated" || status === "incomplete" || status === "partial"
              ? "truncated"
              : status === "unknown" || status === "uncertain"
                ? "unknown"
                : codexNative && (rawResult === undefined || rawResult === null)
                  ? "unknown"
                  : "completed"));
      const resultMetadata = codexNative
        ? this.nativeMetadataWithOutcome(outcome, {
            ...(cached?.connection ? { connection: cached.connection } : {}),
          })
        : this.currentMetadata;
      const durationMs =
        terminalOutput?.durationMs ??
        asNumber(p.executionDurationMs) ??
        asNumber(p.durationMs) ??
        asNumber(p.duration_ms) ??
        0;

      const header = this.emitHeader("tool_result", timestamp, rawEventId, resultMetadata);
      events.push({
        ...header,
        type: "tool_result",
        callId,
        toolName,
        result: terminalOutput?.result ?? rawResult ?? {},
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
      const exitCode = asNumber(p.exitCode) ?? asNumber(p.exit_code) ?? -1;
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
