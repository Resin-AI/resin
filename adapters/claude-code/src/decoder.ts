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
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
  RecordDecoderContext,
} from "@resin/harness-contracts";

export const CLAUDE_PROVIDER = "anthropic";
export const CLAUDE_ACCOUNTING_VERSION = "claude-code-transcript-v1";

/**
 * Safely converts an unknown value to a non-negative integer.
 * Returns undefined for non-integers, negative numbers, floats, booleans, or unparseable values.
 */
function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Extracts raw model string from payload or raw usage candidate.
 */
function extractModelName(
  payload: Record<string, unknown>,
  rawUsage?: Record<string, unknown>,
): string | undefined {
  const candidate =
    (typeof payload.model === "string" && payload.model.trim()) ||
    (typeof (payload.message as Record<string, unknown>)?.model === "string" &&
      ((payload.message as Record<string, unknown>).model as string).trim()) ||
    (typeof (payload.response as Record<string, unknown>)?.model === "string" &&
      ((payload.response as Record<string, unknown>).model as string).trim()) ||
    (typeof rawUsage?.model === "string" && (rawUsage.model as string).trim()) ||
    undefined;

  return candidate && candidate.length > 0 ? candidate : undefined;
}

/**
 * Extracts and validates authoritative provider-reported usage from Claude Code raw records.
 */
export function extractClaudeProviderUsage(
  payload: Record<string, unknown>,
): ProviderReportedUsage | undefined {
  // Only extract usage from authoritative raw usage objects
  const rawUsageCandidate =
    payload.usage ??
    (payload.message as Record<string, unknown>)?.usage ??
    (payload.response as Record<string, unknown>)?.usage ??
    payload.rawUsage;

  if (
    typeof rawUsageCandidate !== "object" ||
    rawUsageCandidate === null ||
    Array.isArray(rawUsageCandidate)
  ) {
    return undefined;
  }

  const rawUsage = rawUsageCandidate as Record<string, unknown>;

  // Check explicit unavailable state
  if (rawUsage.availability === "unavailable") {
    const model = extractModelName(payload, rawUsage);
    const unavailableUsage: ProviderReportedUsage = {
      provider: CLAUDE_PROVIDER,
      accountingVersion: CLAUDE_ACCOUNTING_VERSION,
      availability: "unavailable",
      ...(model ? { model } : {}),
    };
    const parsed = ProviderReportedUsageSchema.safeParse(unavailableUsage);
    return parsed.success ? parsed.data : undefined;
  }

  const inputTokens = toNonNegativeInteger(
    rawUsage.input_tokens ??
      rawUsage.inputTokens ??
      rawUsage.prompt_tokens ??
      rawUsage.promptTokens,
  );

  const outputTokens = toNonNegativeInteger(
    rawUsage.output_tokens ??
      rawUsage.outputTokens ??
      rawUsage.completion_tokens ??
      rawUsage.completionTokens,
  );

  const reasoningTokens = toNonNegativeInteger(
    rawUsage.reasoning_tokens ??
      rawUsage.reasoningTokens ??
      rawUsage.thinking_tokens ??
      rawUsage.thinkingTokens,
  );

  // Exact cache-read tokens only.
  // Cache creation (e.g. cache_creation_input_tokens) is NOT supported in shared contract and MUST NOT be merged.
  const cachedInputTokens = toNonNegativeInteger(
    rawUsage.cache_read_input_tokens ??
      rawUsage.cacheReadInputTokens ??
      rawUsage.cache_read_tokens ??
      rawUsage.cached_input_tokens ??
      rawUsage.cachedInputTokens,
  );

  // Use raw total only when explicitly reported; never infer or sum totalTokens.
  const rawTotalTokens = toNonNegativeInteger(rawUsage.total_tokens ?? rawUsage.totalTokens);

  // Cost extraction (micro USD)
  let costMicroUsd = toNonNegativeInteger(
    rawUsage.cost_micro_usd ?? rawUsage.costMicroUsd ?? rawUsage.cost_micros ?? rawUsage.costMicros,
  );
  if (costMicroUsd === undefined) {
    const costUsd = rawUsage.cost_usd ?? rawUsage.costUsd ?? rawUsage.cost;
    if (typeof costUsd === "number" && !Number.isNaN(costUsd) && costUsd >= 0) {
      costMicroUsd = Math.round(costUsd * 1_000_000);
    }
  }

  // Duration extraction (milliseconds)
  let durationMs = toNonNegativeInteger(
    rawUsage.duration_ms ?? rawUsage.durationMs ?? rawUsage.latency_ms ?? rawUsage.latencyMs,
  );
  if (durationMs === undefined) {
    const durSec = rawUsage.duration_s ?? rawUsage.duration_seconds ?? rawUsage.durationSeconds;
    if (typeof durSec === "number" && !Number.isNaN(durSec) && durSec >= 0) {
      durationMs = Math.round(durSec * 1000);
    }
  }

  // Check if any metrics or total was reported
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

  const usageCandidate: Record<string, unknown> = {
    provider: CLAUDE_PROVIDER,
    accountingVersion: CLAUDE_ACCOUNTING_VERSION,
    availability,
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(rawTotalTokens !== undefined ? { totalTokens: rawTotalTokens } : {}),
    ...(costMicroUsd !== undefined ? { costMicroUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };

  const validation = ProviderReportedUsageSchema.safeParse(usageCandidate);
  if (!validation.success) {
    return undefined;
  }

  return validation.data;
}
/**
 * Parses raw input payload into a structured JSON record object.
 */
function parseRawPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? parsed : { text: payload };
    } catch {
      return { text: payload };
    }
  }
  if (typeof payload === "object" && payload !== null) {
    return payload as Record<string, unknown>;
  }
  return null;
}

/**
 * Base helper to attach causalRef and common fields to intermediate events.
 */
function withBaseFields(
  event: Record<string, unknown>,
  sessionId: string,
  timestamp: string,
  causalSequence = 0,
): IntermediateSessionEvent {
  const finalSessionId =
    typeof event.sessionId === "string" && event.sessionId ? event.sessionId : sessionId;
  const finalTimestamp =
    typeof event.timestamp === "string" && event.timestamp ? event.timestamp : timestamp;

  return {
    ...event,
    sessionId: finalSessionId,
    timestamp: finalTimestamp,
    causalRef: { causalSequence },
  } as IntermediateSessionEvent;
}

/**
 * Decodes a Claude Code transcript line or JSON object into a list of intermediate events.
 */
export function decodeClaudeTranscriptLine(
  lineOrPayload: string | Record<string, unknown>,
  sessionId: string,
  sequenceNumber = 0,
  timestamp = new Date().toISOString(),
): IntermediateSessionEvent[] {
  const payload =
    typeof lineOrPayload === "string" ? parseRawPayload(lineOrPayload) : lineOrPayload;
  if (!payload) {
    return [
      withBaseFields(
        {
          type: "unknown_passthrough",
          rawEventType: "empty_payload",
          rawPayload: {},
        },
        sessionId,
        timestamp,
        sequenceNumber,
      ),
    ];
  }

  const recordTime =
    (typeof payload.timestamp === "string" ? payload.timestamp : timestamp) || timestamp;
  const events: IntermediateSessionEvent[] = [];

  // 1. If payload already matches a fully typed intermediate event
  if (
    (payload.type === "message" &&
      typeof payload.role === "string" &&
      typeof payload.content === "string") ||
    (payload.type === "model_reasoning" && typeof payload.thought === "string") ||
    (payload.type === "tool_call" &&
      typeof payload.toolCallId === "string" &&
      typeof payload.toolName === "string") ||
    (payload.type === "tool_result" && typeof payload.toolCallId === "string") ||
    (payload.type === "command_exec" && typeof payload.command === "string") ||
    (payload.type === "file_edit" &&
      typeof payload.filePath === "string" &&
      typeof payload.editType === "string") ||
    (payload.type === "error" &&
      typeof payload.errorCode === "string" &&
      typeof payload.fatal === "boolean") ||
    (payload.type === "compaction" &&
      typeof payload.originalTokenCount === "number" &&
      typeof payload.compactedTokenCount === "number") ||
    (payload.type === "branch_fork" && typeof payload.branchPointEventId === "string") ||
    (payload.type === "subagent_lifecycle" &&
      typeof payload.subagentId === "string" &&
      typeof payload.lifecycleType === "string") ||
    (payload.type === "session_lifecycle" && typeof payload.lifecycleType === "string")
  ) {
    events.push(withBaseFields(payload, sessionId, recordTime, sequenceNumber));
    return events;
  }

  const rawType = String(payload.type || payload.event || payload.role || "");

  // 2. Session Lifecycle Events
  if (rawType === "session_start" || rawType === "session_init" || rawType === "start") {
    events.push(
      withBaseFields(
        {
          type: "session_lifecycle",
          lifecycleType: "start",
          harnessName: String(payload.harness || "claude-code"),
          workspaceId: payload.workspaceId ? String(payload.workspaceId) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (
    rawType === "session_end" ||
    rawType === "session_exit" ||
    rawType === "end" ||
    rawType === "exit"
  ) {
    events.push(
      withBaseFields(
        {
          type: "session_lifecycle",
          lifecycleType: "end",
          exitReason: payload.exitReason ? String(payload.exitReason) : "normal",
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 3. Subagent & Branch Events
  if (rawType === "subagent" || rawType === "subagent_spawn" || rawType === "subagent_lifecycle") {
    events.push(
      withBaseFields(
        {
          type: "subagent_lifecycle",
          subagentId: String(payload.subagentId || payload.id || "subagent-1"),
          lifecycleType:
            (payload.lifecycleType as
              | "spawn"
              | "start"
              | "pause"
              | "resume"
              | "terminate"
              | "settle") || "spawn",
          parentId: payload.parentId ? String(payload.parentId) : undefined,
          role: payload.role ? String(payload.role) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  if (rawType === "branch_fork" || rawType === "fork") {
    events.push(
      withBaseFields(
        {
          type: "branch_fork",
          sourceSessionId: String(payload.sourceSessionId || sessionId),
          branchPointEventId: String(payload.branchPointEventId || "root"),
          forkReason: payload.forkReason ? String(payload.forkReason) : undefined,
          branchName: payload.branchName ? String(payload.branchName) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 4. Compaction & Summarization Events
  if (
    rawType === "compaction" ||
    rawType === "context_compaction" ||
    rawType === "summary" ||
    payload.action === "compact"
  ) {
    events.push(
      withBaseFields(
        {
          type: "compaction",
          originalTokenCount: Number(payload.originalTokenCount || payload.originalTokens || 0),
          compactedTokenCount: Number(payload.compactedTokenCount || payload.compactedTokens || 0),
          summary: payload.summary
            ? String(payload.summary)
            : payload.text
              ? String(payload.text)
              : undefined,
          compactedRangeStart: payload.rangeStart ? String(payload.rangeStart) : undefined,
          compactedRangeEnd: payload.rangeEnd ? String(payload.rangeEnd) : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 5. Error Events
  if (rawType === "error" || rawType === "rate_limit" || payload.is_error === true) {
    events.push(
      withBaseFields(
        {
          type: "error",
          errorCode: String(payload.code || payload.errorCode || "CLAUDE_ERROR"),
          message: String(payload.message || payload.error || "Claude Code execution error"),
          fatal: Boolean(payload.fatal),
          details:
            typeof payload.details === "object" && payload.details !== null
              ? (payload.details as Record<string, unknown>)
              : undefined,
          stackTrace: payload.stack
            ? String(payload.stack)
            : payload.stackTrace
              ? String(payload.stackTrace)
              : undefined,
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 6. User Messages & Tool Results
  if (rawType === "user" || rawType === "user_message" || payload.role === "user") {
    const rawContent =
      (payload.message as Record<string, unknown>)?.content ??
      payload.content ??
      payload.text ??
      "";

    if (typeof rawContent === "string") {
      events.push(
        withBaseFields(
          {
            type: "message",
            role: "user",
            content: rawContent,
            model: payload.model ? String(payload.model) : undefined,
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (typeof part === "object" && part !== null) {
          const block = part as Record<string, unknown>;
          if (block.type === "tool_result") {
            const toolCallId = String(block.tool_use_id || block.id || "tool-call-1");
            const toolName = String(block.tool_name || block.name || "unknown");
            const output = block.content ?? block.output ?? "";
            const isError = Boolean(block.is_error);

            events.push(
              withBaseFields(
                {
                  type: "tool_result",
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
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push(
              withBaseFields(
                {
                  type: "message",
                  role: "user",
                  content: block.text,
                  model: payload.model ? String(payload.model) : undefined,
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
    if (events.length > 0) return events;
  }

  // 7. Assistant Messages, Reasoning & Tool Calls
  if (rawType === "assistant" || rawType === "assistant_message" || payload.role === "assistant") {
    const providerUsage = extractClaudeProviderUsage(payload);
    const rawContent =
      (payload.message as Record<string, unknown>)?.content ??
      payload.content ??
      payload.text ??
      "";

    if (typeof rawContent === "string") {
      events.push(
        withBaseFields(
          {
            type: "message",
            role: "assistant",
            content: rawContent,
            model: payload.model ? String(payload.model) : undefined,
            ...(providerUsage ? { providerUsage } : {}),
          },
          sessionId,
          recordTime,
          sequenceNumber,
        ),
      );
    } else if (Array.isArray(rawContent)) {
      const assistantTurnEvents: IntermediateSessionEvent[] = [];

      for (const part of rawContent) {
        if (typeof part === "object" && part !== null) {
          const block = part as Record<string, unknown>;

          if (block.type === "text" && typeof block.text === "string") {
            assistantTurnEvents.push(
              withBaseFields(
                {
                  type: "message",
                  role: "assistant",
                  content: block.text,
                  model: payload.model ? String(payload.model) : undefined,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (block.type === "thinking" || block.type === "thought") {
            const thought = String(block.thinking || block.thought || "");
            assistantTurnEvents.push(
              withBaseFields(
                {
                  type: "model_reasoning",
                  thought,
                  signature: block.signature ? String(block.signature) : undefined,
                  model: payload.model ? String(payload.model) : undefined,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );
          } else if (block.type === "tool_use") {
            const toolCallId = String(block.id || `call_${sequenceNumber}`);
            const toolName = String(block.name || "unknown");
            const input = (
              typeof block.input === "object" && block.input !== null ? block.input : {}
            ) as Record<string, unknown>;

            assistantTurnEvents.push(
              withBaseFields(
                {
                  type: "tool_call",
                  toolCallId,
                  toolName,
                  input,
                },
                sessionId,
                recordTime,
                sequenceNumber,
              ),
            );

            // Specialization for Bash command tool (synthetic tool record - do NOT attach providerUsage)
            if (toolName.toLowerCase() === "bash" && typeof input.command === "string") {
              assistantTurnEvents.push(
                withBaseFields(
                  {
                    type: "command_exec",
                    command: input.command,
                    workingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
                    metadata: { toolCallId },
                  },
                  sessionId,
                  recordTime,
                  sequenceNumber,
                ),
              );
            }

            // Specialization for Edit/Write tools (synthetic tool record - do NOT attach providerUsage)
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
              const filePath = String(input.file_path || input.path || "unknown");
              let editType: "create" | "modify" | "delete" | "rename" = "modify";
              if (
                lowerName === "write" ||
                input.command === "create" ||
                input.command === "write"
              ) {
                editType = "create";
              } else if (input.command === "delete") {
                editType = "delete";
              } else if (input.command === "rename") {
                editType = "rename";
              }

              let diff: string | undefined;
              if (typeof input.diff === "string") {
                diff = input.diff;
              } else if (input.old_str !== undefined && input.new_str !== undefined) {
                diff = `--- old\n+++ new\n@@ -1 +1 @@\n-${String(input.old_str)}\n+${String(input.new_str)}`;
              }

              const diffStats: FileDiffStats = {
                linesAdded:
                  typeof input.linesAdded === "number"
                    ? input.linesAdded
                    : typeof input.additions === "number"
                      ? input.additions
                      : 0,
                linesRemoved:
                  typeof input.linesRemoved === "number"
                    ? input.linesRemoved
                    : typeof input.deletions === "number"
                      ? input.deletions
                      : 0,
              };

              assistantTurnEvents.push(
                withBaseFields(
                  {
                    type: "file_edit",
                    filePath,
                    editType,
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

      // Attach providerUsage to the primary model execution event in this turn
      if (providerUsage && assistantTurnEvents.length > 0) {
        let targetEvent = assistantTurnEvents.find(
          (e) =>
            e.type === "message" && (e as unknown as Record<string, unknown>).role === "assistant",
        );
        if (!targetEvent) {
          targetEvent = assistantTurnEvents.find((e) => e.type === "model_reasoning");
        }
        if (!targetEvent) {
          targetEvent = assistantTurnEvents.find((e) => e.type === "tool_call");
        }
        if (targetEvent) {
          (targetEvent as unknown as Record<string, unknown>).providerUsage = providerUsage;
        }
      }
      events.push(...assistantTurnEvents);
    }
    if (events.length > 0) return events;
  }

  // 8. Standalone Tool Use & Result Records
  if (rawType === "tool_use") {
    const providerUsage = extractClaudeProviderUsage(payload);
    const toolCallId = String(payload.id || `call_${sequenceNumber}`);
    const toolName = String(payload.name || "unknown");
    const input = (
      typeof payload.input === "object" && payload.input !== null ? payload.input : {}
    ) as Record<string, unknown>;

    events.push(
      withBaseFields(
        {
          type: "tool_call",
          toolCallId,
          toolName,
          input,
          ...(providerUsage ? { providerUsage } : {}),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );

    if (toolName.toLowerCase() === "bash" && typeof input.command === "string") {
      events.push(
        withBaseFields(
          {
            type: "command_exec",
            command: input.command,
            workingDirectory: typeof input.cwd === "string" ? input.cwd : undefined,
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

  if (rawType === "tool_result") {
    events.push(
      withBaseFields(
        {
          type: "tool_result",
          toolCallId: String(payload.tool_use_id || payload.id || "tool-call-1"),
          toolName: String(payload.name || payload.tool_name || "unknown"),
          output: payload.content ?? payload.output ?? "",
          isError: Boolean(payload.is_error),
        },
        sessionId,
        recordTime,
        sequenceNumber,
      ),
    );
    return events;
  }

  // 9. Passthrough for Unrecognized Events
  events.push(
    withBaseFields(
      {
        type: "unknown_passthrough",
        rawEventType: rawType || "unknown",
        rawPayload: payload,
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
  readonly decoderVersion = "1.0.0";

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === "claude-code" || record.harnessId === "claude";
  }

  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    const sessionId = record.sessionId || context?.sessionId || "session-1";
    const sequenceNumber = record.sequenceNumber ?? record.cursor?.sequence ?? 0;
    const timestamp = record.timestamp || new Date().toISOString();

    return decodeClaudeTranscriptLine(
      record.rawPayload as string | Record<string, unknown>,
      sessionId,
      sequenceNumber,
      timestamp,
    );
  }
}
