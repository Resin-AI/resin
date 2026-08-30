import {
  type CausalRef,
  type DiscoveredToolEntry,
  type FileDiffStats,
  type MessageContentPart,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
  type RedactionMeta,
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
import { z } from "zod";

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
 * - If totalTokens is missing, marks availability as 'partial'.
 * - If no metrics exist, returns undefined (never fabricates zero-token objects).
 * - Converts cost and duration to canonical schema units (micro-USD, milliseconds).
 */
export function extractClaudeProviderUsage(
  payload: ClaudeTranscriptPayload,
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

  // Check explicit unavailable state
  if (asString(rawUsage.availability) === "unavailable") {
    const model = extractModelName(payload, rawUsage);
    const unavailableUsage: ProviderReportedUsage = {
      provider: CLAUDE_PROVIDER,
      accountingVersion: CLAUDE_ACCOUNTING_VERSION,
      availability: "unavailable",
    };
    if (model) {
      unavailableUsage.model = model;
    }
    const parsed = ProviderReportedUsageSchema.safeParse(unavailableUsage);
    return parsed.success ? parsed.data : undefined;
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

  // Extract Cost (normalize USD to integer micro-USD)
  let costMicroUsd: number | undefined;
  const rawCostMicro =
    toNonNegativeInteger(rawUsage.cost_micro_usd) ??
    toNonNegativeInteger(rawUsage.costMicroUsd) ??
    toNonNegativeInteger(rawUsage.cost_micros) ??
    toNonNegativeInteger(rawUsage.costMicros);
  if (rawCostMicro !== undefined) {
    costMicroUsd = rawCostMicro;
  } else {
    const rawCostUsd =
      asNumber(rawUsage.cost_usd) ??
      asNumber(rawUsage.costUsd) ??
      asNumber(rawUsage.cost) ??
      asNumber(rawUsage.total_cost);
    if (rawCostUsd !== undefined && rawCostUsd >= 0) {
      costMicroUsd = Math.round(rawCostUsd * 1_000_000);
    }
  }

  // Extract Duration
  let durationMs =
    toNonNegativeInteger(rawUsage.duration_ms) ??
    toNonNegativeInteger(rawUsage.durationMs) ??
    toNonNegativeInteger(rawUsage.latency_ms) ??
    toNonNegativeInteger(rawUsage.latencyMs) ??
    toNonNegativeInteger(payload.duration_ms) ??
    toNonNegativeInteger(payload.durationMs);
  if (durationMs === undefined) {
    const durSec =
      asNumber(rawUsage.duration_s) ??
      asNumber(rawUsage.duration_seconds) ??
      asNumber(rawUsage.durationSeconds);
    if (durSec !== undefined && durSec >= 0) {
      durationMs = Math.round(durSec * 1000);
    }
  }

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

/**
 * Decodes a single Claude Code JSONL or memory transcript line into canonical intermediate events.
 */
export function decodeClaudeTranscriptLine(
  lineOrPayload: string | ClaudeTranscriptPayload,
  sessionId: string,
  sequenceNumber = 0,
  timestamp = new Date().toISOString(),
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
    let lifecycleType:
      | "spawn"
      | "start"
      | "pause"
      | "resume"
      | "terminate"
      | "settle"
      | "end"
      | "crash" = "spawn";

    if (
      rawLifecycle === "spawn" ||
      rawLifecycle === "start" ||
      rawLifecycle === "pause" ||
      rawLifecycle === "resume" ||
      rawLifecycle === "terminate" ||
      rawLifecycle === "settle" ||
      rawLifecycle === "end" ||
      rawLifecycle === "crash"
    ) {
      lifecycleType = rawLifecycle;
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

    const strContent = asString(rawContent);
    if (strContent !== undefined) {
      events.push(
        withBaseFields<IntermediateMessageEvent>(
          {
            type: "message",
            sessionId,
            timestamp: recordTime,
            role: "user",
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
          if (blockType === "tool_result") {
            const toolCallId =
              asString(block.tool_use_id) ||
              asString(block.id) ||
              asString(block.toolCallId) ||
              "call-unknown";
            const toolName =
              asString(block.name) ||
              asString(block.tool_name) ||
              asString(block.toolName) ||
              "unknown";
            const rawOutput = block.content ?? block.output ?? "";
            const output =
              asString(rawOutput) ?? (rawOutput !== undefined ? JSON.stringify(rawOutput) : "");
            const isError = Boolean(block.is_error ?? block.isError ?? false);

            events.push(
              withBaseFields<IntermediateToolResultEvent>(
                {
                  type: "tool_result",
                  sessionId,
                  timestamp: recordTime,
                  toolCallId,
                  toolName,
                  output,
                  isError,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (blockType === "text" || asString(block.text) !== undefined) {
            const text = asString(block.text) || asString(block.content) || "";
            events.push(
              withBaseFields<IntermediateMessageEvent>(
                {
                  type: "message",
                  sessionId,
                  timestamp: recordTime,
                  role: "user",
                  content: text,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          }
        }
      }
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
    const providerUsage = extractClaudeProviderUsage(payload);
    const rawContent = asObject(payload.message)?.content ?? payload.content ?? payload.text;

    const assistantTurnEvents: IntermediateSessionEvent[] = [];

    const strContent = asString(rawContent);
    if (strContent !== undefined) {
      const msgEvent: IntermediateMessageEvent = {
        type: "message",
        sessionId,
        timestamp: recordTime,
        role: "assistant",
        content: strContent,
      };
      if (providerUsage) {
        msgEvent.providerUsage = providerUsage;
      }
      assistantTurnEvents.push(
        withBaseFields<IntermediateMessageEvent>(msgEvent, sessionId, recordTime, sequenceNumber),
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
            const rawInputStr = asString(rawInput) ?? JSON.stringify(rawInput ?? {});

            assistantTurnEvents.push(
              withBaseFields<IntermediateToolCallEvent>(
                {
                  type: "tool_call",
                  sessionId,
                  timestamp: recordTime,
                  toolCallId,
                  toolName,
                  input: inputRecord,
                  rawInput: rawInputStr,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );

            // Specialization for Bash command tool
            if (toolName.toLowerCase() === "bash" && asString(inputRecord.command)) {
              assistantTurnEvents.push(
                withBaseFields<IntermediateCommandExecEvent>(
                  {
                    type: "command_exec",
                    sessionId,
                    timestamp: recordTime,
                    command: asString(inputRecord.command)!,
                    workingDirectory: asString(inputRecord.cwd),
                    metadata: { toolCallId },
                  },
                  sessionId,
                  recordTime,
                  sequenceNumber,
                ),
              );
            }

            // Specialization for Edit/Write tools
            const lowerName = toolName.toLowerCase();
            if (
              [
                "edit",
                "write",
                "file_edit",
                "file_editor",
                "str_replace_editor",
                "strreplaceeditor",
                "multiedit",
              ].includes(lowerName)
            ) {
              const filePath =
                asString(inputRecord.file_path) || asString(inputRecord.path) || "unknown";
              let operation: "create" | "update" | "delete" | "read" | "patch" = "update";
              const cmd = asString(inputRecord.command)?.toLowerCase();
              if (lowerName === "write" || cmd === "create" || cmd === "write") {
                operation = "create";
              } else if (cmd === "delete") {
                operation = "delete";
              } else if (cmd === "patch") {
                operation = "patch";
              }

              let diff: string | undefined;
              if (asString(inputRecord.diff) !== undefined) {
                diff = asString(inputRecord.diff);
              } else if (inputRecord.old_str !== undefined && inputRecord.new_str !== undefined) {
                diff = `--- old\n+++ new\n@@ -1 +1 @@\n-${String(inputRecord.old_str)}\n+${String(inputRecord.new_str)}`;
              }

              const diffStats: FileDiffStats = {
                linesAdded:
                  asNumber(inputRecord.linesAdded) ?? asNumber(inputRecord.additions) ?? 0,
                linesRemoved:
                  asNumber(inputRecord.linesRemoved) ?? asNumber(inputRecord.deletions) ?? 0,
              };

              assistantTurnEvents.push(
                withBaseFields<IntermediateFileEditEvent>(
                  {
                    type: "file_edit",
                    sessionId,
                    timestamp: recordTime,
                    filePath,
                    operation,
                    action:
                      operation === "create"
                        ? "create"
                        : operation === "delete"
                          ? "delete"
                          : "update",
                    diff,
                    diffStats,
                  },
                  sessionId,
                  recordTime,
                  sequenceNumber,
                ),
              );
            }
          }
        }
      }
    }

    // Attach providerUsage to the primary model execution event in this turn
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

    if (toolName.toLowerCase() === "bash" && asString(inputRecord.command)) {
      events.push(
        withBaseFields<IntermediateCommandExecEvent>(
          {
            type: "command_exec",
            sessionId,
            timestamp: recordTime,
            command: asString(inputRecord.command)!,
            workingDirectory: asString(inputRecord.cwd),
            metadata: { toolCallId },
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    }
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
 * HarnessRecordDecoder implementation for Claude Code JSONL transcripts.
 */
export class ClaudeRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "claude-code";
  readonly decoderVersion = CLAUDE_ACCOUNTING_VERSION;

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

    const rawPayload = record.rawPayload;
    if (String(rawPayload) === rawPayload) {
      return decodeClaudeTranscriptLine(rawPayload, sessionId, sequenceNumber, timestamp);
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
      );
    }
    return [];
  }
}
