import {
  type DiscoveredToolEntry,
  type FileDiffStats,
  type MessageContentPart,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
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

export const OMP_PROVIDER = "omp";
export const OMP_ACCOUNTING_VERSION = "omp-v1";

export type OmpTranscriptValue = DecoderMetadataValue;

export interface OmpTranscriptPayload extends DecoderMetadataRecord {
  [key: string]: OmpTranscriptValue;
}
export interface CausalRefInput {
  causalSequence: number;
  parentId?: string | null;
  rootId?: string | null;
}

export function asString(value: OmpTranscriptValue | undefined | null): string | undefined {
  return value !== undefined && value !== null && String(value) === value ? value : undefined;
}

export function asNumber(value: OmpTranscriptValue | undefined | null): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value)
    ? Number(value)
    : undefined;
}

function isOmpTranscriptPayload(
  value: OmpTranscriptValue | undefined | null,
): value is OmpTranscriptPayload {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function asObject(
  value: OmpTranscriptValue | undefined | null,
): OmpTranscriptPayload | undefined {
  return isOmpTranscriptPayload(value) ? value : undefined;
}

export function asArray(
  value: OmpTranscriptValue | undefined | null,
): OmpTranscriptValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Safely parses a non-negative integer from string or number.
 */
function parseNonNegativeInt(val: OmpTranscriptValue | undefined | null): number | undefined {
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
 * Finds raw usage container within an OMP record or payload.
 */
function findRawUsage(
  rawPayload: OmpTranscriptPayload,
  recordMetadata?: OmpTranscriptPayload,
): OmpTranscriptPayload | undefined {
  const usageKeys = [
    "usage",
    "providerUsage",
    "provider_usage",
    "tokenUsage",
    "token_usage",
    "metrics",
    "stats",
  ];

  for (const key of usageKeys) {
    const val = asObject(rawPayload[key]);
    if (val) return val;
  }

  const containerKeys = ["response", "result", "message", "step", "metadata"];
  for (const parentKey of containerKeys) {
    const parent = asObject(rawPayload[parentKey]);
    if (parent) {
      for (const key of usageKeys) {
        const val = asObject(parent[key]);
        if (val) return val;
      }
    }
  }

  if (recordMetadata) {
    for (const key of usageKeys) {
      const val = asObject(recordMetadata[key]);
      if (val) return val;
    }
  }

  const tokens = asObject(rawPayload.tokens);
  if (tokens) return tokens;

  if (
    "tokens" in rawPayload ||
    "inputTokens" in rawPayload ||
    "promptTokens" in rawPayload ||
    "prompt_tokens" in rawPayload ||
    "outputTokens" in rawPayload ||
    "output_tokens" in rawPayload ||
    "completionTokens" in rawPayload ||
    "completion_tokens" in rawPayload ||
    "cachedInputTokens" in rawPayload ||
    "cached_input_tokens" in rawPayload ||
    "cachedTokens" in rawPayload ||
    "cached_tokens" in rawPayload ||
    "reasoningTokens" in rawPayload ||
    "reasoning_tokens" in rawPayload ||
    "thinkingTokens" in rawPayload ||
    "thinking_tokens" in rawPayload ||
    "totalTokens" in rawPayload ||
    "total_tokens" in rawPayload
  ) {
    return rawPayload;
  }

  return undefined;
}

interface ExtractedTokens {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  hasAnyMetrics: boolean;
}

/**
 * Extracts and maps token count components from various OMP and upstream naming conventions.
 */
function extractTokenComponents(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
): ExtractedTokens {
  const promptDetails =
    asObject(rawUsage.prompt_tokens_details) ??
    asObject(rawUsage.promptTokensDetails) ??
    asObject(rawUsage.input_tokens_details) ??
    asObject(rawUsage.inputTokensDetails) ??
    asObject(rawPayload.prompt_tokens_details) ??
    asObject(rawPayload.promptTokensDetails);

  const completionDetails =
    asObject(rawUsage.completion_tokens_details) ??
    asObject(rawUsage.completionTokensDetails) ??
    asObject(rawUsage.output_tokens_details) ??
    asObject(rawUsage.outputTokensDetails) ??
    asObject(rawPayload.completion_tokens_details) ??
    asObject(rawPayload.completionTokensDetails);

  const tokensObj = asObject(rawUsage.tokens) ?? asObject(rawPayload.tokens);

  const inputTokens =
    parseNonNegativeInt(rawUsage.input_tokens) ??
    parseNonNegativeInt(rawUsage.inputTokens) ??
    parseNonNegativeInt(rawUsage.prompt_tokens) ??
    parseNonNegativeInt(rawUsage.promptTokens) ??
    parseNonNegativeInt(rawUsage.input) ??
    parseNonNegativeInt(rawPayload.input_tokens) ??
    parseNonNegativeInt(rawPayload.inputTokens) ??
    parseNonNegativeInt(rawPayload.prompt_tokens) ??
    parseNonNegativeInt(rawPayload.promptTokens) ??
    parseNonNegativeInt(tokensObj?.input_tokens) ??
    parseNonNegativeInt(tokensObj?.inputTokens) ??
    parseNonNegativeInt(tokensObj?.prompt_tokens);

  const outputTokens =
    parseNonNegativeInt(rawUsage.output_tokens) ??
    parseNonNegativeInt(rawUsage.outputTokens) ??
    parseNonNegativeInt(rawUsage.completion_tokens) ??
    parseNonNegativeInt(rawUsage.completionTokens) ??
    parseNonNegativeInt(rawUsage.output) ??
    parseNonNegativeInt(rawPayload.output_tokens) ??
    parseNonNegativeInt(rawPayload.outputTokens) ??
    parseNonNegativeInt(rawPayload.completion_tokens) ??
    parseNonNegativeInt(rawPayload.completionTokens) ??
    parseNonNegativeInt(tokensObj?.output_tokens) ??
    parseNonNegativeInt(tokensObj?.outputTokens) ??
    parseNonNegativeInt(tokensObj?.completion_tokens);

  const reasoningTokens =
    parseNonNegativeInt(rawUsage.reasoning_tokens) ??
    parseNonNegativeInt(rawUsage.reasoningTokens) ??
    parseNonNegativeInt(rawUsage.thinking_tokens) ??
    parseNonNegativeInt(rawUsage.thinkingTokens) ??
    parseNonNegativeInt(rawUsage.reasoning) ??
    parseNonNegativeInt(rawPayload.reasoning_tokens) ??
    parseNonNegativeInt(rawPayload.reasoningTokens) ??
    parseNonNegativeInt(rawPayload.thinking_tokens) ??
    parseNonNegativeInt(completionDetails?.reasoning_tokens) ??
    parseNonNegativeInt(completionDetails?.reasoningTokens) ??
    parseNonNegativeInt(completionDetails?.thinking_tokens);

  const cachedInputTokens =
    parseNonNegativeInt(rawUsage.cached_input_tokens) ??
    parseNonNegativeInt(rawUsage.cachedInputTokens) ??
    parseNonNegativeInt(rawUsage.cache_read_input_tokens) ??
    parseNonNegativeInt(rawUsage.cacheReadInputTokens) ??
    parseNonNegativeInt(rawUsage.cached_tokens) ??
    parseNonNegativeInt(rawUsage.cachedTokens) ??
    parseNonNegativeInt(rawUsage.cache_read_tokens) ??
    parseNonNegativeInt(rawUsage.cached) ??
    parseNonNegativeInt(rawPayload.cached_input_tokens) ??
    parseNonNegativeInt(rawPayload.cachedInputTokens) ??
    parseNonNegativeInt(rawPayload.cached_tokens) ??
    parseNonNegativeInt(promptDetails?.cached_tokens) ??
    parseNonNegativeInt(promptDetails?.cachedTokens) ??
    parseNonNegativeInt(promptDetails?.cache_read_input_tokens) ??
    parseNonNegativeInt(promptDetails?.cache_read_tokens) ??
    parseNonNegativeInt(promptDetails?.cached);

  const totalTokens =
    parseNonNegativeInt(rawUsage.total_tokens) ??
    parseNonNegativeInt(rawUsage.totalTokens) ??
    parseNonNegativeInt(rawUsage.total) ??
    parseNonNegativeInt(rawPayload.total_tokens) ??
    parseNonNegativeInt(rawPayload.totalTokens) ??
    parseNonNegativeInt(rawPayload.total) ??
    parseNonNegativeInt(tokensObj?.total_tokens) ??
    parseNonNegativeInt(tokensObj?.totalTokens);

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
interface ExtractedCostAndDuration {
  costMicroUsd?: number;
  durationMs?: number;
}

interface ExtractedProviderAndModel {
  provider: string;
  model?: string;
}

/**
 * Extracts and converts cost and duration to canonical schema units.
 */
function extractCostAndDuration(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
): ExtractedCostAndDuration {
  let costMicroUsd: number | undefined;

  const directMicro =
    parseNonNegativeInt(rawUsage.costMicroUsd) ??
    parseNonNegativeInt(rawUsage.cost_micro_usd) ??
    parseNonNegativeInt(rawUsage.costMicros) ??
    parseNonNegativeInt(rawUsage.cost_micros) ??
    parseNonNegativeInt(rawPayload.costMicroUsd) ??
    parseNonNegativeInt(rawPayload.cost_micro_usd) ??
    parseNonNegativeInt(rawPayload.costMicros) ??
    parseNonNegativeInt(rawPayload.cost_micros);

  if (directMicro !== undefined) {
    costMicroUsd = directMicro;
  } else {
    const rawCostUsd =
      asNumber(rawUsage.cost_usd) ??
      asNumber(rawUsage.costUsd) ??
      asNumber(rawUsage.cost) ??
      asNumber(rawPayload.cost_usd) ??
      asNumber(rawPayload.costUsd) ??
      asNumber(rawPayload.cost);

    if (rawCostUsd !== undefined && rawCostUsd >= 0) {
      costMicroUsd = Math.round(rawCostUsd * 1_000_000);
    } else {
      const rawCostStr =
        asString(rawUsage.cost_usd) ??
        asString(rawUsage.costUsd) ??
        asString(rawUsage.cost) ??
        asString(rawPayload.cost_usd) ??
        asString(rawPayload.costUsd);

      if (rawCostStr !== undefined) {
        const trimmed = rawCostStr.trim().replace(/^\$/, "");
        const num = Number(trimmed);
        if (Number.isFinite(num) && num >= 0) {
          costMicroUsd = Math.round(num * 1_000_000);
        }
      }
    }
  }

  let durationMs: number | undefined;

  const directMs =
    parseNonNegativeInt(rawUsage.duration_ms) ??
    parseNonNegativeInt(rawUsage.durationMs) ??
    parseNonNegativeInt(rawUsage.executionDurationMs) ??
    parseNonNegativeInt(rawUsage.execution_duration_ms) ??
    parseNonNegativeInt(rawPayload.duration_ms) ??
    parseNonNegativeInt(rawPayload.durationMs) ??
    parseNonNegativeInt(rawPayload.executionDurationMs);

  if (directMs !== undefined) {
    durationMs = directMs;
  } else {
    const rawDurationSec =
      asNumber(rawUsage.duration_seconds) ??
      asNumber(rawUsage.durationSeconds) ??
      asNumber(rawUsage.duration) ??
      asNumber(rawPayload.duration_seconds) ??
      asNumber(rawPayload.durationSeconds);

    if (rawDurationSec !== undefined && rawDurationSec >= 0) {
      durationMs = Math.round(rawDurationSec * 1000);
    } else {
      const rawDurStr =
        asString(rawUsage.duration_seconds) ??
        asString(rawUsage.durationSeconds) ??
        asString(rawUsage.duration) ??
        asString(rawPayload.duration_seconds);

      if (rawDurStr !== undefined) {
        const trimmed = rawDurStr.trim().replace(/s$/i, "");
        const num = Number(trimmed);
        if (Number.isFinite(num) && num >= 0) {
          durationMs = Math.round(num * 1000);
        }
      }
    }
  }

  return { costMicroUsd, durationMs };
}

/**
 * Resolves provider and model names from payload and usage metadata.
 */
function extractProviderAndModel(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
  fallbackProvider = OMP_PROVIDER,
  fallbackModel?: string,
): ExtractedProviderAndModel {
  const rawProvider =
    asString(rawUsage.provider)?.trim() ||
    asString(rawPayload.provider)?.trim() ||
    asString(rawUsage.provider_name)?.trim() ||
    asString(rawPayload.provider_name)?.trim() ||
    asString(rawUsage.providerName)?.trim() ||
    asString(rawPayload.providerName)?.trim() ||
    asString(rawUsage.vendor)?.trim() ||
    asString(rawPayload.vendor)?.trim() ||
    (fallbackProvider && fallbackProvider.trim() ? fallbackProvider.trim() : undefined);
  const provider = rawProvider || OMP_PROVIDER;

  const rawModel =
    asString(rawUsage.model)?.trim() ||
    asString(rawPayload.model)?.trim() ||
    asString(rawUsage.model_id)?.trim() ||
    asString(rawPayload.model_id)?.trim() ||
    asString(rawUsage.modelId)?.trim() ||
    asString(rawPayload.modelId)?.trim() ||
    asString(rawUsage.model_name)?.trim() ||
    asString(rawPayload.model_name)?.trim() ||
    asString(rawUsage.modelName)?.trim() ||
    asString(rawPayload.modelName)?.trim() ||
    (fallbackModel && fallbackModel.trim() ? fallbackModel.trim() : undefined);

  const model = rawModel || undefined;

  return { provider, model };
}

/**
 * Resolves accounting version string.
 */
function extractAccountingVersion(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
  fallbackAccountingVersion = OMP_ACCOUNTING_VERSION,
): string {
  const version =
    asString(rawUsage.accounting_version)?.trim() ||
    asString(rawUsage.accountingVersion)?.trim() ||
    asString(rawPayload.accounting_version)?.trim() ||
    asString(rawPayload.accountingVersion)?.trim() ||
    asString(rawUsage.schema_version)?.trim() ||
    asString(rawUsage.schemaVersion)?.trim() ||
    asString(rawPayload.schema_version)?.trim() ||
    asString(rawPayload.schemaVersion)?.trim();

  return version || fallbackAccountingVersion;
}

/**
 * Builds and validates canonical ProviderReportedUsage.
 */
function buildProviderUsage(
  rawUsageCandidate: OmpTranscriptPayload | undefined,
  rawPayload: OmpTranscriptPayload,
  fallbackProvider = OMP_PROVIDER,
  fallbackModel?: string,
  fallbackAccountingVersion = OMP_ACCOUNTING_VERSION,
): ProviderReportedUsage | undefined {
  const rawUsage = rawUsageCandidate ?? {};

  const { provider, model } = extractProviderAndModel(
    rawUsage,
    rawPayload,
    fallbackProvider,
    fallbackModel,
  );
  const accountingVersion = extractAccountingVersion(
    rawUsage,
    rawPayload,
    fallbackAccountingVersion,
  );

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
    hasAnyMetrics: hasTokenMetrics,
  } = extractTokenComponents(rawUsage, rawPayload);

  const { costMicroUsd, durationMs } = extractCostAndDuration(rawUsage, rawPayload);

  const hasMetrics = hasTokenMetrics || costMicroUsd !== undefined || durationMs !== undefined;

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
      : explicitAvailability === "complete" && totalTokens !== undefined
        ? "complete"
        : totalTokens !== undefined && !explicitAvailability
          ? "complete"
          : "partial";

  const usageObj: ProviderReportedUsage = {
    provider,
    accountingVersion,
    availability,
  };
  if (model) usageObj.model = model;
  if (inputTokens !== undefined) usageObj.inputTokens = inputTokens;
  if (outputTokens !== undefined) usageObj.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usageObj.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) usageObj.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usageObj.totalTokens = totalTokens;
  if (costMicroUsd !== undefined) usageObj.costMicroUsd = costMicroUsd;
  if (durationMs !== undefined) usageObj.durationMs = durationMs;

  const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
  return parsed.success ? parsed.data : undefined;
}

/**
 * High-fidelity record decoder for Oh My Pi transcripts and structured records.
 */
export class OmpRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "omp";
  readonly decoderVersion = "1.0.0";

  canDecode(record: RawHarnessRecord): boolean {
    if (!record) return false;
    if (record.harnessId === "omp" || record.harnessId === "*") {
      return true;
    }

    const payload = this.extractPayload(record);
    const obj = asObject(payload);
    if (!obj) {
      return false;
    }

    return (
      obj.harness === "omp" ||
      obj.harnessName === "omp" ||
      asString(obj.type) !== undefined ||
      asString(obj.event) !== undefined ||
      asString(obj.role) !== undefined ||
      asString(obj.customType) !== undefined ||
      asString(obj.custom_type) !== undefined ||
      asObject(obj.message) !== undefined
    );
  }

  decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ): IntermediateSessionEvent | IntermediateSessionEvent[] | null {
    if (!record) {
      return null;
    }

    const payload = this.extractPayload(record);
    const obj = asObject(payload);
    if (!obj) {
      const rawText = asString(payload) ?? JSON.stringify(payload);
      return {
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        schemaVersion: "1.0.0",
        causalRef: {
          causalSequence: record.sequenceNumber,
          parentId: context?.parentEventId ?? null,
        },
        type: "unknown_passthrough",
        rawEventType: "unparseable",
        rawPayload: { text: rawText },
      };
    }

    const sessionId = record.sessionId || asString(obj.sessionId) || "unknown-session";
    const timestamp = record.timestamp || asString(obj.timestamp) || new Date().toISOString();
    const causalSequence = record.sequenceNumber || 1;
    const parentId = context?.parentEventId ?? null;
    const causalRef: CausalRefInput = {
      causalSequence,
      parentId,
    };
    // SAFETY: Record metadata is an arbitrary JSON dictionary normalized into an OmpTranscriptValue object.
    const rawMeta = record.metadata as OmpTranscriptValue;
    const metadata = asObject(rawMeta) ?? {};

    const rawRole = asString(obj.role)?.toLowerCase();
    const rawType = String(
      asString(obj.type) ?? asString(obj.event) ?? asString(obj.kind) ?? asString(obj.action) ?? "",
    ).toLowerCase();

    // 0. Pre-dispatch handling for OMP v18 wrappers
    const customType = String(
      asString(obj.customType) ?? asString(obj.custom_type) ?? "",
    ).toLowerCase();
    if (
      (rawType === "custom" &&
        (customType === "tool_execution_start" ||
          customType === "tool_start" ||
          customType === "toolexecutionstart")) ||
      rawType === "tool_execution_start"
    ) {
      const dataObj = asObject(obj.data) ?? {};
      const toolCallPayload: OmpTranscriptPayload = { ...obj, ...dataObj };
      return this.normalizeToolCall(toolCallPayload, sessionId, timestamp, causalRef, metadata);
    }

    const nestedMsg = asObject(obj.message);
    if (nestedMsg) {
      const nestedRole = asString(nestedMsg.role)?.toLowerCase().trim();
      const mergedPayload: OmpTranscriptPayload = { ...obj, ...nestedMsg };

      if (nestedRole === "user") {
        return this.normalizeMessage(
          mergedPayload,
          "user",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "assistant") {
        return this.normalizeMessage(
          mergedPayload,
          "assistant",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "system") {
        return this.normalizeMessage(
          mergedPayload,
          "system",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "toolresult" || nestedRole === "tool_result" || nestedRole === "tool") {
        return this.normalizeToolResult(mergedPayload, sessionId, timestamp, causalRef, metadata);
      }
    }

    // 1. Session Lifecycle Events
    if (
      rawType === "session_start" ||
      rawType === "session_init" ||
      rawType === "session_end" ||
      rawType === "session_completed" ||
      rawType === "session_terminate" ||
      rawType === "session_lifecycle" ||
      rawType === "lifecycle"
    ) {
      return this.normalizeLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 2. User Message / Prompt Events
    if (
      rawRole === "user" ||
      rawType === "prompt" ||
      rawType === "user" ||
      rawType === "user_message" ||
      rawType === "query"
    ) {
      return this.normalizeMessage(obj, "user", sessionId, timestamp, causalRef, metadata);
    }

    // 3. Model Reasoning / Thought Events
    if (
      rawType === "model_reasoning" ||
      rawType === "thought" ||
      rawType === "thinking" ||
      rawType === "reasoning"
    ) {
      return this.normalizeReasoning(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 4. Tool Discovery Events
    if (
      rawType === "tool_discovery" ||
      rawType === "tools_discovered" ||
      rawType === "tools_registered" ||
      rawType === "mcp_tools" ||
      (Array.isArray(obj.tools) && rawType === "tools")
    ) {
      return this.normalizeToolDiscovery(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 5. Tool Call Events
    if (
      rawType === "tool_call" ||
      rawType === "tool_use" ||
      rawType === "tool_invocation" ||
      rawType === "call" ||
      rawType === "function_call" ||
      rawRole === "tool_call" ||
      asObject(obj.toolCall) !== undefined ||
      asObject(obj.tool_call) !== undefined
    ) {
      return this.normalizeToolCall(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 6. Tool Result Events
    if (
      rawType === "tool_result" ||
      rawType === "tool_response" ||
      rawType === "tool_output" ||
      rawType === "result" ||
      rawType === "function_result" ||
      rawRole === "tool" ||
      rawRole === "tool_result" ||
      asObject(obj.toolResult) !== undefined ||
      asObject(obj.tool_result) !== undefined
    ) {
      return this.normalizeToolResult(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 7. Command Execution Events
    if (
      rawType === "command_exec" ||
      rawType === "bash" ||
      rawType === "exec" ||
      rawType === "sh"
    ) {
      return this.normalizeCommandExec(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 8. File Edit Events
    if (
      rawType === "file_edit" ||
      rawType === "patch_applied" ||
      rawType === "edit" ||
      rawType === "write" ||
      rawType === "file_write"
    ) {
      return this.normalizeFileEdit(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 9. Subagent Lifecycle Events
    if (
      rawType === "subagent_lifecycle" ||
      rawType === "subagent" ||
      rawType === "subagent_spawn" ||
      rawType === "subagent_start" ||
      rawType === "subagent_end" ||
      rawType === "subagent_complete" ||
      rawType === "subagent_settle"
    ) {
      return this.normalizeSubagent(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 10. Compaction Events
    if (
      rawType === "compaction" ||
      rawType === "compact" ||
      rawType === "context_compaction" ||
      rawType === "prune"
    ) {
      return this.normalizeCompaction(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 11. Branch Fork Events
    if (rawType === "branch_fork" || rawType === "fork" || rawType === "branch") {
      return this.normalizeBranchFork(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 12. Error Events
    if (rawType === "error" || rawType === "exception" || rawType === "crash") {
      return this.normalizeError(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 13. Assistant Message Events
    if (
      rawRole === "assistant" ||
      rawType === "assistant" ||
      rawType === "assistant_message" ||
      rawType === "completion"
    ) {
      return this.normalizeMessage(obj, "assistant", sessionId, timestamp, causalRef, metadata);
    }

    // 14. System Message Events
    if (rawRole === "system" || rawType === "system" || rawType === "system_message") {
      return this.normalizeMessage(obj, "system", sessionId, timestamp, causalRef, metadata);
    }

    // Fallback: Pass through as unknown event
    const fallback: IntermediateUnknownPassthroughEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "unknown_passthrough",
      rawEventType: rawType || "unknown",
      rawPayload: obj,
    };
    return fallback;
  }

  private extractPayload(record: RawHarnessRecord): OmpTranscriptValue {
    // SAFETY: Record rawPayload is decoded as an OmpTranscriptValue JSON value.
    const raw = record.rawPayload as OmpTranscriptValue;
    const str = asString(raw);
    if (str !== undefined) {
      try {
        // SAFETY: Parsed JSON string produces an arbitrary OmpTranscriptValue before normalization.
        const parsed = JSON.parse(str) as OmpTranscriptValue;
        return asObject(parsed) ?? (Array.isArray(parsed) ? parsed : undefined) ?? { text: str };
      } catch {
        return { text: str };
      }
    }
    return raw;
  }

  private extractProviderUsage(
    obj: OmpTranscriptPayload,
    recordMetadata?: OmpTranscriptPayload,
    fallbackModel?: string,
  ): ProviderReportedUsage | undefined {
    const rawUsage = findRawUsage(obj, asObject(recordMetadata));
    if (!rawUsage) {
      if (obj.unavailable === true || obj.availability === "unavailable") {
        return buildProviderUsage({}, obj, OMP_PROVIDER, fallbackModel, OMP_ACCOUNTING_VERSION);
      }
      return undefined;
    }
    return buildProviderUsage(rawUsage, obj, OMP_PROVIDER, fallbackModel, OMP_ACCOUNTING_VERSION);
  }

  private normalizeLifecycle(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSessionLifecycleEvent {
    const rawAction = String(
      asString(obj.lifecycleType) ??
        asString(obj.action) ??
        asString(obj.type) ??
        asString(obj.event) ??
        "",
    ).toLowerCase();

    const isStart =
      rawAction === "start" ||
      rawAction === "session_start" ||
      rawAction === "session_init" ||
      rawAction === "init";
    const isSuspend = rawAction === "suspend" || rawAction === "pause";
    const isResume = rawAction === "resume";

    const lifecycleType: "start" | "end" | "pause" | "resume" = isStart
      ? "start"
      : isSuspend
        ? "pause"
        : isResume
          ? "resume"
          : "end";

    const exitReason =
      asString(obj.exitReason) ?? asString(obj.reason) ?? asString(obj.exit_reason);
    const harnessName = asString(obj.harnessName) ?? asString(obj.harness) ?? "omp";
    const workspaceId = asString(obj.workspaceId) ?? asString(obj.workspace);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateSessionLifecycleEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "session_lifecycle",
      lifecycleType,
      exitReason,
      harnessName,
      workspaceId,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeMessage(
    obj: OmpTranscriptPayload,
    role: "user" | "assistant" | "system",
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateMessageEvent {
    let content = "";
    let contentParts: MessageContentPart[] | undefined;

    const strContent = asString(obj.content);
    const strText = asString(obj.text);
    const strPrompt = asString(obj.prompt);
    const strMessage = asString(obj.message);

    if (strContent !== undefined) {
      content = strContent;
    } else if (strText !== undefined) {
      content = strText;
    } else if (strPrompt !== undefined) {
      content = strPrompt;
    } else if (strMessage !== undefined) {
      content = strMessage;
    } else {
      const partsArray = asArray(obj.content) ?? asArray(obj.parts);
      if (partsArray) {
        content = partsArray.map((part) => asString(asObject(part)?.text) ?? "").join("\n");
      } else {
        const msgObj = asObject(obj.message);
        if (msgObj) {
          content = asString(msgObj.content) ?? asString(msgObj.text) ?? JSON.stringify(msgObj);
        }
      }
    }

    const model = asString(obj.model) ?? asString(obj.modelId) ?? asString(obj.model_id);
    const stopReason = asString(obj.stopReason) ?? asString(obj.stop_reason);
    const providerUsage = this.extractProviderUsage(obj, metadata, model);
    if (stopReason) {
      metadata.stopReason = stopReason;
    }

    const evt: IntermediateMessageEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "message",
      role,
      content,
      contentParts,
      model,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeReasoning(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateModelReasoningEvent {
    const reasoningContent =
      asString(obj.reasoningContent) ??
      asString(obj.thought) ??
      asString(obj.thinking) ??
      asString(obj.content) ??
      asString(obj.text) ??
      "";

    const signature = asString(obj.signature);
    const model = asString(obj.model);
    const tokenCount =
      asNumber(obj.tokenCount) ?? asNumber(obj.token_count) ?? asNumber(obj.tokens);
    const durationMs = asNumber(obj.durationMs) ?? asNumber(obj.duration_ms);

    const providerUsage = this.extractProviderUsage(obj, metadata, model);

    const evt: IntermediateModelReasoningEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "model_reasoning",
      reasoningContent,
      reasoningText: reasoningContent,
      signature,
      model,
      tokenCount,
      durationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeToolCall(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolCallEvent {
    const toolCallObj = asObject(obj.toolCall) ?? asObject(obj.tool_call) ?? obj;
    const toolName = String(
      asString(toolCallObj.toolName) ??
        asString(toolCallObj.tool_name) ??
        asString(toolCallObj.name) ??
        asString(toolCallObj.tool) ??
        "unknown_tool",
    );

    const callId = String(
      asString(toolCallObj.callId) ??
        asString(toolCallObj.call_id) ??
        asString(toolCallObj.toolCallId) ??
        asString(toolCallObj.tool_call_id) ??
        asString(toolCallObj.id) ??
        `call_${causalRef.causalSequence}`,
    );

    const rawParams =
      toolCallObj.parameters ??
      toolCallObj.params ??
      toolCallObj.input ??
      toolCallObj.arguments ??
      toolCallObj.args ??
      {};

    let rawParamsObj = asObject(rawParams);
    if (!rawParamsObj && typeof rawParams === "string") {
      try {
        rawParamsObj = asObject(JSON.parse(rawParams));
      } catch {
        // ignore JSON parse failure
      }
    }
    const parameters = rawParamsObj ?? {};

    if (toolCallObj.intent !== undefined && metadata.intent === undefined) {
      metadata.intent = toolCallObj.intent;
    }

    const providerUsage = this.extractProviderUsage(obj, metadata);
    const evt: IntermediateToolCallEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "tool_call",
      toolName,
      callId,
      toolCallId: callId,
      parameters,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeToolResult(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolResultEvent {
    const toolResultObj = asObject(obj.toolResult) ?? asObject(obj.tool_result) ?? obj;

    const toolName = String(
      asString(toolResultObj.toolName) ??
        asString(toolResultObj.tool_name) ??
        asString(toolResultObj.name) ??
        asString(toolResultObj.tool) ??
        "unknown_tool",
    );

    const callId = String(
      asString(toolResultObj.callId) ??
        asString(toolResultObj.call_id) ??
        asString(toolResultObj.toolCallId) ??
        asString(toolResultObj.tool_call_id) ??
        asString(toolResultObj.id) ??
        `call_${causalRef.causalSequence}`,
    );

    let rawResult =
      toolResultObj.result ??
      toolResultObj.output ??
      toolResultObj.content ??
      toolResultObj.data ??
      toolResultObj.response;

    if (Array.isArray(rawResult)) {
      const allText = rawResult
        .map((p) => asString(asObject(p)?.text) ?? asString(asObject(p)?.content) ?? "")
        .filter((t) => t.length > 0);
      if (allText.length > 0 && allText.length === rawResult.length) {
        rawResult = allText.join("\n");
      }
    }

    const isError = Boolean(
      toolResultObj.isError ||
        toolResultObj.is_error ||
        toolResultObj.error ||
        asString(toolResultObj.status)?.toLowerCase() === "error",
    );

    const errorStr =
      asString(toolResultObj.error) ??
      asString(toolResultObj.errorMessage) ??
      asString(toolResultObj.error_message) ??
      (isError && typeof rawResult === "string" ? rawResult : undefined);

    const executionDurationMs =
      asNumber(toolResultObj.executionDurationMs) ??
      asNumber(toolResultObj.execution_duration_ms) ??
      asNumber(toolResultObj.durationMs) ??
      asNumber(toolResultObj.duration_ms);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateToolResultEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "tool_result",
      toolName,
      callId,
      toolCallId: callId,
      result: rawResult,
      isError,
      error: isError ? errorStr : undefined,
      executionDurationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeCommandExec(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateCommandExecEvent {
    const command = String(asString(obj.command) ?? asString(obj.cmd) ?? "");
    const argsArray = asArray(obj.args);
    const args = argsArray ? argsArray.map((a) => asString(a) ?? String(a)) : undefined;
    const workingDirectory = asString(obj.workingDirectory) ?? asString(obj.cwd);
    const exitCode = asNumber(obj.exitCode) ?? asNumber(obj.exit_code) ?? 0;
    const stdout = asString(obj.stdout) ?? asString(obj.output);
    const stderr = asString(obj.stderr);
    const durationMs =
      asNumber(obj.durationMs) ??
      asNumber(obj.duration_ms) ??
      asNumber(obj.executionDurationMs) ??
      0;

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateCommandExecEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "command_exec",
      command,
      args,
      workingDirectory,
      exitCode,
      stdout,
      stderr,
      durationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeFileEdit(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateFileEditEvent {
    const filePath = String(
      asString(obj.filePath) ??
        asString(obj.file_path) ??
        asString(obj.path) ??
        asString(obj.file) ??
        "",
    );

    const rawOp = String(asString(obj.operation) ?? asString(obj.op) ?? "patch").toLowerCase();
    const operation: "create" | "update" | "delete" | "patch" | "read" =
      rawOp === "create" || rawOp === "delete" || rawOp === "patch" || rawOp === "read"
        ? rawOp
        : rawOp === "modify" || rawOp === "update"
          ? "update"
          : "patch";

    const patch = asString(obj.patch) ?? asString(obj.diff);
    const beforeHash = asString(obj.beforeHash) ?? asString(obj.before_hash);
    const afterHash = asString(obj.afterHash) ?? asString(obj.after_hash);

    const rawDiffStats = asObject(obj.diffStats) ?? asObject(obj.diff_stats);
    // SAFETY: Raw diff stats are preserved as FileDiffStats record on intermediate event.
    const diffStats = rawDiffStats as FileDiffStats | undefined;

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateFileEditEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "file_edit",
      filePath,
      operation,
      patch,
      beforeHash,
      afterHash,
      diffStats,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeSubagent(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSubagentLifecycleEvent {
    const subagentId = String(
      asString(obj.subagentId) ??
        asString(obj.subagent_id) ??
        asString(obj.id) ??
        `subagent_${causalRef.causalSequence}`,
    );

    const rawLType = String(
      asString(obj.lifecycleType) ??
        asString(obj.action) ??
        asString(obj.type) ??
        asString(obj.event) ??
        "spawn",
    ).toLowerCase();

    const lifecycleType:
      | "spawn"
      | "start"
      | "pause"
      | "resume"
      | "terminate"
      | "settle"
      | "end"
      | "crash" =
      rawLType === "spawn" || rawLType === "subagent_spawn"
        ? "spawn"
        : rawLType === "start" || rawLType === "subagent_start"
          ? "start"
          : rawLType === "settle" ||
              rawLType === "subagent_settle" ||
              rawLType === "complete" ||
              rawLType === "subagent_complete"
            ? "settle"
            : rawLType === "pause" || rawLType === "subagent_pause"
              ? "pause"
              : rawLType === "resume" || rawLType === "subagent_resume"
                ? "resume"
                : rawLType === "crash" || rawLType === "subagent_crash"
                  ? "crash"
                  : rawLType === "terminate" ||
                      rawLType === "subagent_terminate" ||
                      rawLType === "subagent_end" ||
                      rawLType === "end"
                    ? "terminate"
                    : "spawn";

    const parentId =
      asString(obj.parentId) ??
      asString(obj.parent_id) ??
      asString(obj.parentSessionId) ??
      asString(obj.parent_session_id) ??
      sessionId;

    const role = asString(obj.role);
    const reason =
      asString(obj.reason) ?? asString(obj.resultSummary) ?? asString(obj.result_summary);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateSubagentLifecycleEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "subagent_lifecycle",
      subagentId,
      lifecycleType,
      parentId,
      role,
      reason,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeCompaction(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateCompactionEvent {
    const rawReason = String(
      asString(obj.triggerReason) ?? asString(obj.reason) ?? "context_limit",
    ).toLowerCase();
    const triggerReason: "context_limit" | "manual" | "scheduled" =
      rawReason === "manual" || rawReason === "scheduled" ? rawReason : "context_limit";

    const tokensBefore =
      asNumber(obj.tokensBefore) ??
      asNumber(obj.tokens_before) ??
      asNumber(obj.originalTokenCount) ??
      0;

    const tokensAfter =
      asNumber(obj.tokensAfter) ??
      asNumber(obj.tokens_after) ??
      asNumber(obj.compactedTokenCount) ??
      0;

    const preservedContextSummary =
      asString(obj.preservedContextSummary) ?? asString(obj.summary) ?? asString(obj.text);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateCompactionEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "compaction",
      triggerReason,
      tokensBefore,
      tokensAfter,
      preservedContextSummary,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeBranchFork(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateBranchForkEvent {
    const sourceSessionId =
      asString(obj.sourceSessionId) ?? asString(obj.source_session_id) ?? sessionId;

    const branchName = asString(obj.branchName) ?? asString(obj.branch_name);
    const branchPointEventId =
      asString(obj.branchPointEventId) ?? asString(obj.branch_point_event_id);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateBranchForkEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "branch_fork",
      sourceSessionId,
      branchName,
      branchPointEventId,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeError(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateErrorEvent {
    const errorType = String(
      asString(obj.errorType) ??
        asString(obj.error_type) ??
        asString(obj.name) ??
        asString(obj.errorCode) ??
        "OmpRuntimeError",
    );

    const message = String(
      asString(obj.message) ??
        asString(obj.errorMessage) ??
        asString(obj.error) ??
        "Unknown runtime error",
    );

    const stack = asString(obj.stack);
    const recoverable = Boolean(obj.recoverable ?? true);
    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateErrorEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "error",
      errorType,
      message,
      stack,
      recoverable,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeToolDiscovery(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolDiscoveryEvent {
    const rawTools = asArray(obj.tools) ?? asArray(obj.tool_list) ?? [];
    const tools: DiscoveredToolEntry[] = rawTools.map((t: OmpTranscriptValue) => {
      const item = asObject(t) ?? {};
      const paramsObj = asObject(item.parameters) ?? asObject(item.inputSchema) ?? {};
      return {
        name: String(asString(item.name) || asString(item.id) || "unknown_tool"),
        description: asString(item.description),
        inputSchema: paramsObj,
        provider: asString(item.provider) || OMP_PROVIDER,
      };
    });

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const rawSource = asString(obj.source);
    const source: "mcp" | "builtin" | "dynamic" | "harness" =
      rawSource === "mcp" ||
      rawSource === "builtin" ||
      rawSource === "dynamic" ||
      rawSource === "harness"
        ? rawSource
        : "harness";

    const evt: IntermediateToolDiscoveryEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "tool_discovery",
      tools,
      provider: asString(obj.provider),
      source,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }
}
