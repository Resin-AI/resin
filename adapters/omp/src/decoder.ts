import {
  type DiscoveredToolEntry,
  type FileDiffStats,
  type MessageContentPart,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
} from "@resin/contracts";
import type {
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

/**
 * Safely parses a non-negative integer from a number or numeric string.
 */
function parseNonNegativeInt(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isInteger(val) && val >= 0) {
    return val;
  }
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    const num = Number.parseInt(val.trim(), 10);
    if (!Number.isNaN(num) && num >= 0) {
      return num;
    }
  }
  return undefined;
}

/**
 * Locates the raw usage record within an OMP event payload or metadata.
 */
function findRawUsage(
  obj: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // 1. Explicit providerUsage / provider_usage
  for (const key of ["providerUsage", "provider_usage"]) {
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
  }

  // 2. Standard usage containers
  for (const key of [
    "usage",
    "token_usage",
    "tokenUsage",
    "usageMetadata",
    "usage_metadata",
    "modelUsage",
    "model_usage",
    "rawUsage",
    "raw_usage",
    "tokens",
    "token_counts",
    "tokenCounts",
  ]) {
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
  }

  // 3. Nested in metrics or response
  if (typeof obj.metrics === "object" && obj.metrics !== null && !Array.isArray(obj.metrics)) {
    const metrics = obj.metrics as Record<string, unknown>;
    if (
      typeof metrics.usage === "object" &&
      metrics.usage !== null &&
      !Array.isArray(metrics.usage)
    ) {
      return metrics.usage as Record<string, unknown>;
    }
    if (
      "inputTokens" in metrics ||
      "input_tokens" in metrics ||
      "prompt_tokens" in metrics ||
      "outputTokens" in metrics ||
      "completion_tokens" in metrics ||
      "totalTokens" in metrics ||
      "total_tokens" in metrics
    ) {
      return metrics;
    }
  }

  if (typeof obj.response === "object" && obj.response !== null && !Array.isArray(obj.response)) {
    const resp = obj.response as Record<string, unknown>;
    if (typeof resp.usage === "object" && resp.usage !== null && !Array.isArray(resp.usage)) {
      return resp.usage as Record<string, unknown>;
    }
  }

  // 4. Metadata usage
  if (
    metadata &&
    typeof metadata.usage === "object" &&
    metadata.usage !== null &&
    !Array.isArray(metadata.usage)
  ) {
    return metadata.usage as Record<string, unknown>;
  }

  // 5. Check if obj itself has token fields at top level (excluding tokenCount which is reasoning-only)
  if (
    "tokens" in obj ||
    "inputTokens" in obj ||
    "promptTokens" in obj ||
    "prompt_tokens" in obj ||
    "outputTokens" in obj ||
    "output_tokens" in obj ||
    "completionTokens" in obj ||
    "completion_tokens" in obj ||
    "cachedInputTokens" in obj ||
    "cached_input_tokens" in obj ||
    "cachedTokens" in obj ||
    "cached_tokens" in obj ||
    "reasoningTokens" in obj ||
    "reasoning_tokens" in obj ||
    "thinkingTokens" in obj ||
    "thinking_tokens" in obj ||
    "totalTokens" in obj ||
    "total_tokens" in obj
  ) {
    return obj;
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

function extractTokenComponents(raw: Record<string, unknown>): ExtractedTokens {
  const promptDetails =
    typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : typeof raw.promptTokensDetails === "object" && raw.promptTokensDetails !== null
        ? (raw.promptTokensDetails as Record<string, unknown>)
        : undefined;

  const completionDetails =
    typeof raw.completion_tokens_details === "object" && raw.completion_tokens_details !== null
      ? (raw.completion_tokens_details as Record<string, unknown>)
      : typeof raw.completionTokensDetails === "object" && raw.completionTokensDetails !== null
        ? (raw.completionTokensDetails as Record<string, unknown>)
        : undefined;

  const tokensObj =
    typeof raw.tokens === "object" && raw.tokens !== null
      ? (raw.tokens as Record<string, unknown>)
      : undefined;

  const inputTokens =
    parseNonNegativeInt(raw.input_tokens) ??
    parseNonNegativeInt(raw.inputTokens) ??
    parseNonNegativeInt(raw.prompt_tokens) ??
    parseNonNegativeInt(raw.promptTokens) ??
    parseNonNegativeInt(raw.input) ??
    parseNonNegativeInt(raw.prompt) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.input) ?? parseNonNegativeInt(tokensObj.prompt))
      : undefined);

  const outputTokens =
    parseNonNegativeInt(raw.output_tokens) ??
    parseNonNegativeInt(raw.outputTokens) ??
    parseNonNegativeInt(raw.completion_tokens) ??
    parseNonNegativeInt(raw.completionTokens) ??
    parseNonNegativeInt(raw.output) ??
    parseNonNegativeInt(raw.completion) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.output) ?? parseNonNegativeInt(tokensObj.completion))
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
    parseNonNegativeInt(raw.reasoning) ??
    parseNonNegativeInt(raw.thinking) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.reasoning) ?? parseNonNegativeInt(tokensObj.thinking))
      : undefined);

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
    parseNonNegativeInt(raw.cache_creation_input_tokens) ??
    parseNonNegativeInt(raw.cacheCreationInputTokens) ??
    parseNonNegativeInt(raw.cache_read_tokens) ??
    parseNonNegativeInt(raw.cacheReadTokens) ??
    parseNonNegativeInt(raw.cached) ??
    parseNonNegativeInt(raw.cache_read) ??
    (tokensObj
      ? (parseNonNegativeInt(tokensObj.cached) ?? parseNonNegativeInt(tokensObj.cache_read))
      : undefined);

  const totalTokens =
    parseNonNegativeInt(raw.total_tokens) ??
    parseNonNegativeInt(raw.totalTokens) ??
    parseNonNegativeInt(raw.total) ??
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

function extractCostAndDuration(
  rawUsage: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
): { costMicroUsd?: number; durationMs?: number } {
  let costMicroUsd =
    parseNonNegativeInt(rawUsage.costMicroUsd) ??
    parseNonNegativeInt(rawUsage.cost_micro_usd) ??
    parseNonNegativeInt(rawUsage.costMicros) ??
    parseNonNegativeInt(rawUsage.cost_micros) ??
    parseNonNegativeInt(rawPayload.costMicroUsd) ??
    parseNonNegativeInt(rawPayload.cost_micro_usd) ??
    parseNonNegativeInt(rawPayload.costMicros) ??
    parseNonNegativeInt(rawPayload.cost_micros);

  if (costMicroUsd === undefined) {
    const rawCostUsd =
      typeof rawUsage.costUsd === "number" && rawUsage.costUsd >= 0
        ? rawUsage.costUsd
        : typeof rawUsage.cost_usd === "number" && rawUsage.cost_usd >= 0
          ? rawUsage.cost_usd
          : typeof rawPayload.costUsd === "number" && rawPayload.costUsd >= 0
            ? rawPayload.costUsd
            : typeof rawPayload.cost_usd === "number" && rawPayload.cost_usd >= 0
              ? rawPayload.cost_usd
              : undefined;

    if (rawCostUsd !== undefined) {
      costMicroUsd = Math.round(rawCostUsd * 1_000_000);
    }
  }

  const durationMs =
    parseNonNegativeInt(rawUsage.durationMs) ??
    parseNonNegativeInt(rawUsage.duration_ms) ??
    parseNonNegativeInt(rawUsage.latencyMs) ??
    parseNonNegativeInt(rawUsage.latency_ms) ??
    parseNonNegativeInt(rawUsage.elapsedMs) ??
    parseNonNegativeInt(rawUsage.elapsed_ms) ??
    (typeof rawUsage.duration === "number" && rawUsage.duration >= 0
      ? Math.round(rawUsage.duration)
      : undefined) ??
    parseNonNegativeInt(rawPayload.durationMs) ??
    parseNonNegativeInt(rawPayload.duration_ms) ??
    parseNonNegativeInt(rawPayload.latencyMs) ??
    parseNonNegativeInt(rawPayload.latency_ms) ??
    parseNonNegativeInt(rawPayload.elapsedMs) ??
    parseNonNegativeInt(rawPayload.elapsed_ms);

  return { costMicroUsd, durationMs };
}

function extractProviderAndModel(
  rawUsage: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
  fallbackModel?: string,
): { provider: string; model?: string } {
  const rawProvider =
    (typeof rawUsage.provider === "string" && rawUsage.provider.trim()
      ? rawUsage.provider.trim()
      : undefined) ??
    (typeof rawPayload.provider === "string" && rawPayload.provider.trim()
      ? rawPayload.provider.trim()
      : undefined) ??
    (typeof rawUsage.model_provider === "string" && rawUsage.model_provider.trim()
      ? rawUsage.model_provider.trim()
      : undefined) ??
    (typeof rawPayload.model_provider === "string" && rawPayload.model_provider.trim()
      ? rawPayload.model_provider.trim()
      : undefined) ??
    (typeof rawUsage.modelProvider === "string" && rawUsage.modelProvider.trim()
      ? rawUsage.modelProvider.trim()
      : undefined) ??
    (typeof rawPayload.modelProvider === "string" && rawPayload.modelProvider.trim()
      ? rawPayload.modelProvider.trim()
      : undefined);

  const provider = rawProvider ?? "omp";

  const rawModel =
    (typeof rawUsage.model === "string" && rawUsage.model.trim()
      ? rawUsage.model.trim()
      : undefined) ??
    (typeof rawPayload.model === "string" && rawPayload.model.trim()
      ? rawPayload.model.trim()
      : undefined) ??
    (typeof rawUsage.model_id === "string" && rawUsage.model_id.trim()
      ? rawUsage.model_id.trim()
      : undefined) ??
    (typeof rawPayload.model_id === "string" && rawPayload.model_id.trim()
      ? rawPayload.model_id.trim()
      : undefined) ??
    (typeof rawUsage.modelId === "string" && rawUsage.modelId.trim()
      ? rawUsage.modelId.trim()
      : undefined) ??
    (typeof rawPayload.modelId === "string" && rawPayload.modelId.trim()
      ? rawPayload.modelId.trim()
      : undefined) ??
    (typeof rawUsage.model_name === "string" && rawUsage.model_name.trim()
      ? rawUsage.model_name.trim()
      : undefined) ??
    (typeof rawPayload.model_name === "string" && rawPayload.model_name.trim()
      ? rawPayload.model_name.trim()
      : undefined) ??
    (typeof rawUsage.modelName === "string" && rawUsage.modelName.trim()
      ? rawUsage.modelName.trim()
      : undefined) ??
    (typeof rawPayload.modelName === "string" && rawPayload.modelName.trim()
      ? rawPayload.modelName.trim()
      : undefined) ??
    (fallbackModel && fallbackModel.trim() ? fallbackModel.trim() : undefined);

  return { provider, model: rawModel };
}

function extractAccountingVersion(
  rawUsage: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
): string {
  const version =
    (typeof rawUsage.accountingVersion === "string" && rawUsage.accountingVersion.trim()
      ? rawUsage.accountingVersion.trim()
      : undefined) ??
    (typeof rawUsage.accounting_version === "string" && rawUsage.accounting_version.trim()
      ? rawUsage.accounting_version.trim()
      : undefined) ??
    (typeof rawPayload.accountingVersion === "string" && rawPayload.accountingVersion.trim()
      ? rawPayload.accountingVersion.trim()
      : undefined) ??
    (typeof rawPayload.accounting_version === "string" && rawPayload.accounting_version.trim()
      ? rawPayload.accounting_version.trim()
      : undefined);

  return version ?? "omp-v1";
}

function buildProviderUsage(
  rawUsage: Record<string, unknown>,
  rawPayload: Record<string, unknown>,
  fallbackModel?: string,
): ProviderReportedUsage | undefined {
  const { provider, model } = extractProviderAndModel(rawUsage, rawPayload, fallbackModel);
  const accountingVersion = extractAccountingVersion(rawUsage, rawPayload);
  const { costMicroUsd, durationMs } = extractCostAndDuration(rawUsage, rawPayload);

  const explicitAvailability =
    typeof rawUsage.availability === "string"
      ? rawUsage.availability.toLowerCase()
      : typeof rawPayload.availability === "string"
        ? rawPayload.availability.toLowerCase()
        : undefined;

  const isExplicitUnavailable =
    explicitAvailability === "unavailable" ||
    rawUsage.unavailable === true ||
    rawPayload.unavailable === true;

  if (isExplicitUnavailable) {
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
    return undefined;
  }

  let availability: "complete" | "partial" = "partial";
  if (explicitAvailability === "complete") {
    availability = totalTokens !== undefined ? "complete" : "partial";
  } else if (explicitAvailability === "partial") {
    availability = "partial";
  } else {
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
 * Decoder mapping Oh My Pi raw records and JSONL log lines to typed intermediate session events.
 */
export class OmpRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "omp";
  readonly decoderVersion = "1.0.0";

  /**
   * Extracts authoritative provider-reported usage from an OMP event payload or metadata.
   */
  extractProviderUsage(
    obj: Record<string, unknown>,
    fallbackModel?: string,
  ): ProviderReportedUsage | undefined {
    const rawUsage = findRawUsage(obj);
    if (!rawUsage) {
      if (obj.unavailable === true || obj.availability === "unavailable") {
        return buildProviderUsage({}, obj, fallbackModel);
      }
      return undefined;
    }
    return buildProviderUsage(rawUsage, obj, fallbackModel);
  }

  canDecode(record: RawHarnessRecord): boolean {
    if (!record) {
      return false;
    }
    if (record.harnessId === "omp" || record.harnessId === "*") {
      return true;
    }

    // Try inspecting payload structure
    const payload = this.extractPayload(record);
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const rec = payload as Record<string, unknown>;
    return (
      rec.harness === "omp" ||
      rec.harnessName === "omp" ||
      typeof rec.type === "string" ||
      typeof rec.event === "string" ||
      typeof rec.role === "string"
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
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const obj = payload as Record<string, unknown>;
    const sessionId = String(
      obj.sessionId ?? obj.session_id ?? record.sessionId ?? context?.sessionId ?? "omp-session",
    );

    const timestamp = String(
      obj.timestamp ?? obj.time ?? obj.ts ?? record.timestamp ?? new Date().toISOString(),
    );

    const causalRef = {
      parentEventId: (obj.parentEventId ?? obj.parent_event_id ?? context?.parentEventId) as
        | string
        | undefined,
      causalSequence: (obj.causalSequence ?? obj.seq ?? context?.lastCausalSequence) as
        | number
        | undefined,
    };

    const metadata: Record<string, unknown> = {
      ...(typeof obj.metadata === "object" && obj.metadata !== null
        ? (obj.metadata as Record<string, unknown>)
        : {}),
      ...(record.metadata ?? {}),
      rawType: obj.type ?? obj.event ?? obj.kind,
    };

    const eventType = String(obj.type ?? obj.event ?? obj.kind ?? "").toLowerCase();

    // 1. Messages (user, assistant, system, tool)
    if (
      eventType === "message" ||
      eventType === "user_message" ||
      eventType === "assistant_message" ||
      eventType === "system_message" ||
      (typeof obj.role === "string" && typeof obj.content !== "undefined")
    ) {
      return this.decodeMessage(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 2. Model Reasoning / Thoughts
    if (
      eventType === "model_reasoning" ||
      eventType === "reasoning" ||
      eventType === "thought" ||
      eventType === "thinking"
    ) {
      return this.decodeReasoning(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 3. Tool Calls
    if (
      eventType === "tool_call" ||
      eventType === "tool_use" ||
      eventType === "tool_invocation" ||
      eventType === "call" ||
      (typeof obj.toolCall === "object" && obj.toolCall !== null) ||
      (typeof obj.tool_call === "object" && obj.tool_call !== null)
    ) {
      return this.decodeToolCall(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 4. Tool Results
    if (
      eventType === "tool_result" ||
      eventType === "tool_response" ||
      eventType === "tool_output" ||
      eventType === "result" ||
      (typeof obj.toolResult === "object" && obj.toolResult !== null) ||
      (typeof obj.tool_result === "object" && obj.tool_result !== null)
    ) {
      return this.decodeToolResult(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 5. Command Executions (bash / exec / command)
    if (
      eventType === "command_exec" ||
      eventType === "command" ||
      eventType === "bash" ||
      eventType === "exec" ||
      eventType === "shell"
    ) {
      return this.decodeCommandExec(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 6. File Edits (edit / patch / write / file_edit)
    if (
      eventType === "file_edit" ||
      eventType === "edit" ||
      eventType === "file_write" ||
      eventType === "write" ||
      eventType === "patch"
    ) {
      return this.decodeFileEdit(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 7. Subagent Lifecycle (spawn / delegate / settle / terminate)
    if (
      eventType === "subagent_lifecycle" ||
      eventType === "subagent" ||
      eventType === "task" ||
      eventType === "task_spawn" ||
      eventType === "delegate" ||
      eventType === "subagent_spawn"
    ) {
      return this.decodeSubagentLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 8. Context Compaction (compaction / summarize)
    if (
      eventType === "compaction" ||
      eventType === "context_compaction" ||
      eventType === "summarize" ||
      eventType === "context_compact"
    ) {
      return this.decodeCompaction(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 9. Branch Fork
    if (
      eventType === "branch_fork" ||
      eventType === "branch" ||
      eventType === "fork" ||
      eventType === "session_fork"
    ) {
      return this.decodeBranchFork(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 10. Errors
    if (
      eventType === "error" ||
      eventType === "exception" ||
      eventType === "fault" ||
      eventType === "crash"
    ) {
      return this.decodeError(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 11. Session Lifecycle
    if (
      eventType === "session_lifecycle" ||
      eventType === "lifecycle" ||
      eventType === "session_start" ||
      eventType === "session_end"
    ) {
      return this.decodeSessionLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 12. Tool Discovery
    if (
      eventType === "tool_discovery" ||
      eventType === "discovery" ||
      eventType === "tools_discovered"
    ) {
      return this.decodeToolDiscovery(obj, sessionId, timestamp, causalRef, metadata);
    }

    // Fallback passthrough
    const providerUsage = this.extractProviderUsage(obj);
    const fallback: IntermediateUnknownPassthroughEvent = {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "unknown_passthrough",
      rawEventType: eventType || "unknown",
      rawPayload: obj,
      ...(providerUsage ? { providerUsage } : {}),
    };
    return fallback;
  }

  private extractPayload(record: RawHarnessRecord): unknown {
    if (typeof record.rawPayload === "string") {
      try {
        return JSON.parse(record.rawPayload);
      } catch {
        return { text: record.rawPayload };
      }
    }
    return record.rawPayload;
  }

  private decodeMessage(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateMessageEvent {
    let role: "user" | "assistant" | "system" | "tool" = "user";
    const rawRole = String(obj.role ?? "").toLowerCase();
    if (rawRole === "assistant" || rawRole === "model") {
      role = "assistant";
    } else if (rawRole === "system") {
      role = "system";
    } else if (rawRole === "tool" || rawRole === "tool_response") {
      role = "tool";
    }

    let content = "";
    let contentParts: MessageContentPart[] | undefined;

    if (typeof obj.content === "string") {
      content = obj.content;
    } else if (Array.isArray(obj.content)) {
      contentParts = obj.content as MessageContentPart[];
      content = obj.content
        .map((part) =>
          typeof part === "string" ? part : (part?.text ?? part?.content ?? JSON.stringify(part)),
        )
        .join("\n");
    } else if (typeof obj.text === "string") {
      content = obj.text;
    } else if (typeof obj.message === "string") {
      content = obj.message;
    } else if (typeof obj.content !== "undefined") {
      content = JSON.stringify(obj.content);
    }

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "message",
      role,
      content,
      contentParts,
      model: typeof obj.model === "string" ? obj.model : undefined,
      ...(this.extractProviderUsage(obj, typeof obj.model === "string" ? obj.model : undefined)
        ? {
            providerUsage: this.extractProviderUsage(
              obj,
              typeof obj.model === "string" ? obj.model : undefined,
            ),
          }
        : {}),
    };
  }

  private decodeReasoning(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateModelReasoningEvent {
    const reasoningContent = String(
      obj.reasoningContent ?? obj.reasoning_content ?? obj.thought ?? obj.text ?? obj.content ?? "",
    );
    const model = typeof obj.model === "string" ? obj.model : undefined;
    const providerUsage = this.extractProviderUsage(obj, model);

    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "model_reasoning",
      reasoningContent,
      model,
      signature: typeof obj.signature === "string" ? obj.signature : undefined,
      tokenCount:
        typeof obj.tokenCount === "number"
          ? obj.tokenCount
          : (obj.token_count as number | undefined),
      durationMs:
        typeof obj.durationMs === "number"
          ? obj.durationMs
          : (obj.duration_ms as number | undefined),
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeToolCall(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolCallEvent {
    const nested = (obj.toolCall ?? obj.tool_call ?? {}) as Record<string, unknown>;

    const toolName = String(
      obj.toolName ??
        obj.tool_name ??
        obj.tool ??
        obj.name ??
        nested.name ??
        nested.toolName ??
        "unknown_tool",
    );

    const callId = String(
      obj.callId ??
        obj.call_id ??
        obj.id ??
        nested.id ??
        nested.callId ??
        `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );

    let parameters: Record<string, unknown> = {};
    const rawParams =
      obj.parameters ??
      obj.params ??
      obj.arguments ??
      obj.args ??
      obj.input ??
      nested.parameters ??
      nested.params ??
      nested.arguments ??
      nested.args ??
      nested.input;

    if (typeof rawParams === "string") {
      try {
        parameters = JSON.parse(rawParams) as Record<string, unknown>;
      } catch {
        parameters = { raw: rawParams };
      }
    } else if (typeof rawParams === "object" && rawParams !== null) {
      parameters = rawParams as Record<string, unknown>;
    }

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_call",
      toolName,
      callId,
      parameters,
      candidateRef: typeof obj.candidateRef === "string" ? obj.candidateRef : undefined,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeToolResult(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolResultEvent {
    const nested = (obj.toolResult ?? obj.tool_result ?? {}) as Record<string, unknown>;

    const toolName = String(
      obj.toolName ??
        obj.tool_name ??
        obj.tool ??
        obj.name ??
        nested.name ??
        nested.toolName ??
        "unknown_tool",
    );

    const callId = String(
      obj.callId ?? obj.call_id ?? obj.id ?? nested.id ?? nested.callId ?? `call_${Date.now()}`,
    );

    const result =
      obj.result ??
      obj.output ??
      obj.response ??
      obj.data ??
      nested.result ??
      nested.output ??
      nested.data ??
      null;

    const isError = Boolean(
      obj.isError ?? obj.is_error ?? obj.error ?? nested.isError ?? nested.is_error ?? nested.error,
    );

    const executionDurationMs =
      typeof obj.executionDurationMs === "number"
        ? obj.executionDurationMs
        : typeof obj.duration_ms === "number"
          ? obj.duration_ms
          : typeof obj.durationMs === "number"
            ? obj.durationMs
            : 0;

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_result",
      toolName,
      callId,
      result,
      isError,
      executionDurationMs,
      outputSizeBytes:
        typeof obj.outputSizeBytes === "number"
          ? obj.outputSizeBytes
          : typeof result === "string"
            ? Buffer.byteLength(result)
            : undefined,
      isShadow: Boolean(obj.isShadow ?? obj.is_shadow),
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeCommandExec(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateCommandExecEvent {
    const command = String(obj.command ?? obj.cmd ?? "");
    const args = Array.isArray(obj.args) ? (obj.args as string[]) : [];
    const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
    const exitCode =
      typeof obj.exitCode === "number" ? obj.exitCode : ((obj.exit_code as number) ?? 0);
    const stdout = typeof obj.stdout === "string" ? obj.stdout : undefined;
    const stderr = typeof obj.stderr === "string" ? obj.stderr : undefined;
    const durationMs =
      typeof obj.durationMs === "number"
        ? obj.durationMs
        : ((obj.duration_ms as number) ?? (obj.duration as number) ?? 0);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "command_exec",
      command,
      args,
      cwd,
      exitCode,
      stdout,
      stderr,
      durationMs,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeFileEdit(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateFileEditEvent {
    const filePath = String(
      obj.filePath ?? obj.file_path ?? obj.path ?? obj.file ?? "unknown_file",
    );
    let operation: "create" | "update" | "delete" | "patch" = "update";
    const rawOp = String(obj.operation ?? obj.action ?? obj.op ?? "").toLowerCase();

    if (rawOp === "create" || rawOp === "add" || rawOp === "new") {
      operation = "create";
    } else if (rawOp === "delete" || rawOp === "remove" || rawOp === "rm") {
      operation = "delete";
    } else if (rawOp === "patch") {
      operation = "patch";
    }

    const patch = typeof obj.patch === "string" ? obj.patch : (obj.diff as string | undefined);
    const beforeHash =
      typeof obj.beforeHash === "string" ? obj.beforeHash : (obj.before_hash as string | undefined);
    const afterHash =
      typeof obj.afterHash === "string" ? obj.afterHash : (obj.after_hash as string | undefined);
    const diffStats =
      typeof obj.diffStats === "object" ? (obj.diffStats as FileDiffStats) : undefined;

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "file_edit",
      filePath,
      operation,
      beforeHash,
      afterHash,
      patch,
      diffStats,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeSubagentLifecycle(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateSubagentLifecycleEvent {
    const subagentId = String(
      obj.subagentId ??
        obj.subagent_id ??
        obj.taskId ??
        obj.task_id ??
        obj.id ??
        `subagent-${Date.now()}`,
    );

    let lifecycleType: "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" = "spawn";
    const rawAction = String(
      obj.lifecycleType ?? obj.lifecycle_type ?? obj.action ?? obj.state ?? obj.event ?? "spawn",
    ).toLowerCase();

    if (rawAction === "spawn" || rawAction === "create" || rawAction === "delegated") {
      lifecycleType = "spawn";
    } else if (rawAction === "start" || rawAction === "running" || rawAction === "run") {
      lifecycleType = "start";
    } else if (rawAction === "pause" || rawAction === "park" || rawAction === "parked") {
      lifecycleType = "pause";
    } else if (rawAction === "resume" || rawAction === "wake") {
      lifecycleType = "resume";
    } else if (
      rawAction === "terminate" ||
      rawAction === "kill" ||
      rawAction === "cancel" ||
      rawAction === "aborted"
    ) {
      lifecycleType = "terminate";
    } else if (
      rawAction === "settle" ||
      rawAction === "complete" ||
      rawAction === "completed" ||
      rawAction === "done"
    ) {
      lifecycleType = "settle";
    }

    const parentId =
      typeof obj.parentId === "string" ? obj.parentId : (obj.parent_id as string | undefined);
    const role =
      typeof obj.role === "string"
        ? obj.role
        : ((obj.agent ?? obj.agentType ?? obj.agent_type) as string | undefined);
    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : ((obj.prompt ?? obj.description) as string | undefined);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "subagent_lifecycle",
      subagentId,
      lifecycleType,
      parentId,
      role,
      reason,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeCompaction(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateCompactionEvent {
    let triggerReason: "context_limit" | "manual" | "scheduled" | "turn_threshold" =
      "context_limit";
    const rawReason = String(
      obj.triggerReason ?? obj.trigger_reason ?? obj.reason ?? "",
    ).toLowerCase();

    if (rawReason === "manual") {
      triggerReason = "manual";
    } else if (rawReason === "scheduled") {
      triggerReason = "scheduled";
    } else if (rawReason === "turn_threshold" || rawReason === "turns") {
      triggerReason = "turn_threshold";
    }

    const tokensBefore =
      typeof obj.tokensBefore === "number"
        ? obj.tokensBefore
        : ((obj.tokens_before as number) ?? (obj.before_tokens as number) ?? 0);

    const tokensAfter =
      typeof obj.tokensAfter === "number"
        ? obj.tokensAfter
        : ((obj.tokens_after as number) ?? (obj.after_tokens as number) ?? 0);

    const preservedContextSummary =
      typeof obj.preservedContextSummary === "string"
        ? obj.preservedContextSummary
        : ((obj.summary ?? obj.preserved_summary) as string | undefined);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "compaction",
      triggerReason,
      tokensBefore,
      tokensAfter,
      preservedContextSummary,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeBranchFork(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateBranchForkEvent {
    const sourceSessionId = String(
      obj.sourceSessionId ??
        obj.source_session_id ??
        obj.parentSessionId ??
        obj.parent_session_id ??
        sessionId,
    );

    const branchPointEventId = String(
      obj.branchPointEventId ??
        obj.branch_point_event_id ??
        obj.forkPoint ??
        obj.fork_point ??
        "event-0",
    );

    const forkReason =
      typeof obj.forkReason === "string" ? obj.forkReason : (obj.reason as string | undefined);
    const branchName =
      typeof obj.branchName === "string"
        ? obj.branchName
        : ((obj.name ?? obj.branch) as string | undefined);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "branch_fork",
      sourceSessionId,
      branchPointEventId,
      forkReason,
      branchName,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeError(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateErrorEvent {
    const errorType = String(
      obj.errorType ??
        obj.error_type ??
        obj.name ??
        obj.errorClass ??
        obj.error_class ??
        "UnknownError",
    );

    const message = String(obj.message ?? obj.error ?? obj.description ?? "An error occurred");
    const stackTrace =
      typeof obj.stackTrace === "string" ? obj.stackTrace : (obj.stack as string | undefined);
    const recoverable = Boolean(obj.recoverable);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "error",
      errorType,
      message,
      stackTrace,
      recoverable,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeSessionLifecycle(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateSessionLifecycleEvent {
    let lifecycleType: "start" | "pause" | "resume" | "end" | "crash" = "start";
    const rawAction = String(
      obj.lifecycleType ?? obj.lifecycle_type ?? obj.action ?? obj.state ?? obj.event ?? "start",
    ).toLowerCase();

    if (rawAction === "start" || rawAction === "init" || rawAction === "begin") {
      lifecycleType = "start";
    } else if (rawAction === "pause" || rawAction === "suspend") {
      lifecycleType = "pause";
    } else if (rawAction === "resume") {
      lifecycleType = "resume";
    } else if (
      rawAction === "end" ||
      rawAction === "finish" ||
      rawAction === "completed" ||
      rawAction === "close"
    ) {
      lifecycleType = "end";
    } else if (rawAction === "crash" || rawAction === "error" || rawAction === "fatal") {
      lifecycleType = "crash";
    }

    const exitReason =
      typeof obj.exitReason === "string" ? obj.exitReason : (obj.reason as string | undefined);
    const harnessName = typeof obj.harnessName === "string" ? obj.harnessName : "omp";
    const workspaceId =
      typeof obj.workspaceId === "string"
        ? obj.workspaceId
        : (obj.workspace_id as string | undefined);

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "session_lifecycle",
      lifecycleType,
      exitReason,
      harnessName,
      workspaceId,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }

  private decodeToolDiscovery(
    obj: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    causalRef: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): IntermediateToolDiscoveryEvent {
    const rawTools = Array.isArray(obj.tools) ? (obj.tools as unknown[]) : [];
    const tools: DiscoveredToolEntry[] = rawTools.map((t) => {
      const toolObj = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
      return {
        name: String(toolObj.name ?? toolObj.toolName ?? toolObj.tool ?? "unknown_tool"),
        description: typeof toolObj.description === "string" ? toolObj.description : undefined,
        inputSchema:
          typeof toolObj.inputSchema === "object" && toolObj.inputSchema !== null
            ? (toolObj.inputSchema as Record<string, unknown>)
            : undefined,
      };
    });

    const providerUsage = this.extractProviderUsage(obj);
    return {
      sessionId,
      timestamp,
      causalRef,
      metadata,
      type: "tool_discovery",
      tools,
      provider: typeof obj.provider === "string" ? obj.provider : undefined,
      source: (obj.source as "mcp" | "builtin" | "dynamic" | "harness") ?? "harness",
      ...(providerUsage ? { providerUsage } : {}),
    };
  }
}
