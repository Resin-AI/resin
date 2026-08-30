import {
  type CausalRef,
  type DiscoveredToolEntry,
  type FileDiffStats,
  type MessageContentPart,
  type NormalizedBranchForkEvent,
  type NormalizedCommandExecEvent,
  type NormalizedCompactionEvent,
  type NormalizedErrorEvent,
  type NormalizedFileEditEvent,
  type NormalizedMessageEvent,
  type NormalizedModelReasoningEvent,
  type NormalizedSessionEvent,
  type NormalizedSessionLifecycleEvent,
  type NormalizedSubagentLifecycleEvent,
  type NormalizedToolCallEvent,
  type NormalizedToolDiscoveryEvent,
  type NormalizedToolResultEvent,
  type NormalizedUnknownPassthroughEvent,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
  type RedactionMeta,
  type SessionEventType,
} from "@resin/contracts";
import {
  type BaseIntermediateEventFields,
  DecodeError,
  type HarnessRecordDecoder,
  type IntermediateBranchForkEvent,
  type IntermediateCommandExecEvent,
  type IntermediateCompactionEvent,
  type IntermediateErrorEvent,
  type IntermediateFileEditEvent,
  type IntermediateMessageEvent,
  type IntermediateModelReasoningEvent,
  type IntermediateSessionEvent,
  type IntermediateSessionLifecycleEvent,
  type IntermediateSubagentLifecycleEvent,
  type IntermediateToolCallEvent,
  type IntermediateToolDiscoveryEvent,
  type IntermediateToolResultEvent,
  type IntermediateUnknownPassthroughEvent,
  type RawHarnessRecord,
  type RecordDecoderContext,
} from "@resin/harness-contracts";
import { z } from "zod";
import type { JsonObject, JsonValue } from "./redaction.js";

export {
  type BaseIntermediateEventFields,
  DecodeError,
  type HarnessRecordDecoder,
  type IntermediateBranchForkEvent,
  type IntermediateCommandExecEvent,
  type IntermediateCompactionEvent,
  type IntermediateErrorEvent,
  type IntermediateFileEditEvent,
  type IntermediateMessageEvent,
  type IntermediateModelReasoningEvent,
  type IntermediateSessionEvent,
  type IntermediateSessionLifecycleEvent,
  type IntermediateSubagentLifecycleEvent,
  type IntermediateToolCallEvent,
  type IntermediateToolDiscoveryEvent,
  type IntermediateToolResultEvent,
  type IntermediateUnknownPassthroughEvent,
  type RawHarnessRecord,
  type RecordDecoderContext,
};

function asString<T>(val: T): string | undefined {
  return z.string().safeParse(val).data;
}

function asNumber<T>(val: T): number | undefined {
  return z.number().safeParse(val).data;
}

function asRecord<T>(val: T): JsonObject | undefined {
  const parsed = z.record(z.unknown()).safeParse(val);
  // SAFETY: z.record validates val is a non-null object record dictionary compatible with JsonObject.
  return parsed.success ? (parsed.data as JsonObject) : undefined;
}

function asRole<T>(val: T): "user" | "assistant" | "system" | "tool" {
  const s = asString(val);
  if (s === "assistant" || s === "system" || s === "tool") return s;
  return "user";
}

function asSessionAction<T>(val: T): "start" | "pause" | "resume" | "end" | "crash" {
  const s = asString(val);
  if (s === "start" || s === "pause" || s === "resume" || s === "crash") return s;
  return "end";
}

function asToolSource<T>(val: T): "mcp" | "builtin" | "dynamic" | "harness" {
  const s = asString(val);
  if (s === "mcp" || s === "builtin" || s === "dynamic") return s;
  return "harness";
}

function asFileOperation<T>(val: T): "create" | "update" | "delete" | "patch" {
  const s = asString(val);
  if (s === "create" || s === "update" || s === "delete") return s;
  return "patch";
}

function asCompactionTrigger<T>(
  val: T,
): "context_limit" | "manual" | "scheduled" | "turn_threshold" {
  const s = asString(val);
  if (s === "context_limit" || s === "manual" || s === "scheduled" || s === "turn_threshold") {
    return s;
  }
  if (s === "token_limit") return "context_limit";
  if (s === "turn_limit") return "turn_threshold";
  return "manual";
}

function asSubagentLifecycleType<T>(
  val: T,
): "spawn" | "start" | "pause" | "resume" | "terminate" | "settle" | "end" | "crash" {
  const s = asString(val);
  if (
    s === "spawn" ||
    s === "start" ||
    s === "pause" ||
    s === "resume" ||
    s === "terminate" ||
    s === "settle" ||
    s === "end" ||
    s === "crash"
  ) {
    return s;
  }
  if (s === "complete") return "settle";
  if (s === "error") return "crash";
  if (s === "kill") return "terminate";
  return "spawn";
}

function parseProviderUsage<T>(candidateUsage: T): ProviderReportedUsage | undefined {
  if (candidateUsage && z.record(z.unknown()).safeParse(candidateUsage).success) {
    const parsed = ProviderReportedUsageSchema.safeParse(candidateUsage);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

const KNOWN_EVENT_TYPES: Set<string> = new Set([
  "message",
  "model_reasoning",
  "tool_discovery",
  "tool_call",
  "tool_result",
  "command_exec",
  "file_edit",
  "error",
  "compaction",
  "branch_fork",
  "subagent_lifecycle",
  "session_lifecycle",
  "unknown_passthrough",
]);

/**
 * Universal decoder capable of decoding standard raw records and pre-normalized events.
 */
export class UniversalHarnessRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "*";
  readonly decoderVersion = "1.0.0";

  canDecode(_record: RawHarnessRecord): boolean {
    return true;
  }

  decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ): IntermediateSessionEvent | IntermediateSessionEvent[] | null {
    if (!record) {
      throw new DecodeError("Cannot decode null or undefined raw record");
    }

    const sessionId = record.sessionId || context?.sessionId;
    if (!sessionId) {
      throw new DecodeError("Record missing sessionId", {
        recordId: record.recordId,
        recordType: record.recordType,
      });
    }

    const timestamp = record.timestamp || new Date().toISOString();
    const rawPayload = record.rawPayload;
    const sequence = record.sequenceNumber ?? record.cursor?.sequence ?? 0;

    // 1. If rawPayload is already a typed intermediate or normalized event structure
    const pObj = asRecord(rawPayload);
    if (pObj) {
      const typeStr = asString(pObj.type);
      if (typeStr && KNOWN_EVENT_TYPES.has(typeStr)) {
        return this.normalizeTypedObject(pObj, sessionId, timestamp, sequence);
      }
    }

    // 2. Map based on recordType
    switch (record.recordType) {
      case "prompt":
      case "system":
      case "transcript_line": {
        const p = asRecord(rawPayload);
        if (p) {
          const role = record.recordType === "system" ? "system" : asRole(p.role);
          const contentStr = asString(p.content) ?? asString(p.text);
          // SAFETY: contentParts array is preserved as structured MessageContentPart items.
          const contentParts = Array.isArray(p.contentParts)
            ? (p.contentParts as MessageContentPart[])
            : undefined;
          const content = contentStr ?? String(p.content ?? "");
          const model = asString(p.model);

          return {
            type: "message",
            role,
            content,
            contentParts,
            model,
            sessionId,
            timestamp,
            causalRef: { causalSequence: sequence },
          };
        }

        const content = asString(rawPayload) ?? JSON.stringify(rawPayload);
        return {
          type: "message",
          role: record.recordType === "system" ? "system" : "user",
          content,
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "completion": {
        const p = asRecord(rawPayload);
        if (p) {
          const candidateUsage = asRecord(p.providerUsage) ?? asRecord(p.usage);
          const providerUsage = parseProviderUsage(candidateUsage);

          const reasoningContent =
            asString(p.reasoningContent) ?? asString(p.reasoning) ?? asString(p.thought);

          if (reasoningContent !== undefined) {
            const event: IntermediateModelReasoningEvent = {
              type: "model_reasoning",
              reasoningContent,
              model: asString(p.model),
              signature: asString(p.signature),
              tokenCount: asNumber(p.tokenCount),
              durationMs: asNumber(p.durationMs),
              sessionId,
              timestamp,
              causalRef: { causalSequence: sequence },
            };
            if (providerUsage) {
              event.providerUsage = providerUsage;
            }
            return event;
          }

          const event: IntermediateMessageEvent = {
            type: "message",
            role: "assistant",
            content: String(p.content ?? p.text ?? p.completion ?? JSON.stringify(p)),
            model: asString(p.model),
            sessionId,
            timestamp,
            causalRef: { causalSequence: sequence },
          };
          if (providerUsage) {
            event.providerUsage = providerUsage;
          }
          return event;
        }

        return {
          type: "message",
          role: "assistant",
          content: asString(rawPayload) ?? JSON.stringify(rawPayload),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "tool_call": {
        const p = asRecord(rawPayload);
        if (!p) {
          throw new DecodeError("Tool call payload must be an object", {
            recordId: record.recordId,
            recordType: record.recordType,
          });
        }

        const rawArgs = p.arguments ?? p.input ?? p.args ?? {};
        const argsObj = asRecord(rawArgs) ?? {};

        return {
          type: "tool_call",
          toolName: String(p.name ?? p.toolName ?? "unknown"),
          toolCallId: String(p.id ?? p.toolCallId ?? `call_${sequence}`),
          callId: String(p.id ?? p.toolCallId ?? p.callId ?? `call_${sequence}`),
          parameters: argsObj,
          input: argsObj,
          candidateRef: asString(p.candidateRef),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "tool_result": {
        const p = asRecord(rawPayload);
        if (!p) {
          throw new DecodeError("Tool result payload must be an object", {
            recordId: record.recordId,
            recordType: record.recordType,
          });
        }

        const isError = Boolean(p.isError ?? p.error);

        return {
          type: "tool_result",
          toolCallId: String(p.toolCallId ?? p.id ?? `call_${sequence}`),
          callId: String(p.toolCallId ?? p.id ?? p.callId ?? `call_${sequence}`),
          toolName: p.toolName ? String(p.toolName) : undefined,
          result: p.result ?? p.output ?? p.content ?? null,
          output: p.result ?? p.output ?? p.content ?? null,
          isError,
          executionDurationMs: asNumber(p.executionDurationMs) ?? asNumber(p.durationMs),
          outputSizeBytes: asNumber(p.outputSizeBytes),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }
      default: {
        const rawStr = asString(rawPayload);
        const content = rawStr ?? JSON.stringify(rawPayload);
        const payloadObj = asRecord(rawPayload) ?? { content };

        return {
          type: "unknown_passthrough",
          rawEventType: record.recordType,
          rawPayload: payloadObj,
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }
    }
  }

  private normalizeTypedObject(
    p: JsonObject,
    sessionId: string,
    timestamp: string,
    sequence: number,
  ): IntermediateSessionEvent {
    const candidateUsage = asRecord(p.providerUsage) ?? asRecord(p.usage);
    const providerUsage = parseProviderUsage(candidateUsage);

    // SAFETY: causalRef from payload is validated as object or falls back to new CausalRef.
    const causalRefRecord = asRecord(p.causalRef);
    // SAFETY: causalRef payload is an object matching CausalRef shape or defaults to sequence.
    const causalRefVal: CausalRef = causalRefRecord
      ? (causalRefRecord as CausalRef)
      : { causalSequence: sequence };
    const baseFields = {
      sessionId: String(p.sessionId ?? sessionId),
      timestamp: String(p.timestamp ?? timestamp),
      causalRef: causalRefVal,
      metadata: asRecord(p.metadata),
    };

    switch (p.type) {
      case "message": {
        // SAFETY: Passes role from raw payload to be validated by schema.
        const role = (p.role as "user" | "assistant" | "system" | "tool") || "user";
        // SAFETY: contentParts array is preserved as structured MessageContentPart items.
        const contentParts = Array.isArray(p.contentParts)
          ? (p.contentParts as MessageContentPart[])
          : undefined;
        // SAFETY: Content is passed through to schema validation.
        const content = asString(p.content) ?? "";
        const event: IntermediateMessageEvent = {
          ...baseFields,
          type: "message",
          role,
          content,
          contentParts,
          model: asString(p.model),
        };
        if (providerUsage) {
          event.providerUsage = providerUsage;
        }
        return event;
      }

      case "model_reasoning": {
        const reasoningContent =
          asString(p.reasoningContent) ?? asString(p.reasoning) ?? asString(p.thought) ?? "";
        const event: IntermediateModelReasoningEvent = {
          ...baseFields,
          type: "model_reasoning",
          reasoningContent,
          signature: asString(p.signature),
          tokenCount: asNumber(p.tokenCount),
          model: asString(p.model),
          durationMs: asNumber(p.durationMs),
        };
        if (providerUsage) {
          event.providerUsage = providerUsage;
        }
        return event;
      }

      case "tool_discovery": {
        const rawTools = Array.isArray(p.tools) ? p.tools : [];
        const tools: DiscoveredToolEntry[] = rawTools.map((rawTool) => {
          const t = asRecord(rawTool) ?? {};
          const schemaObj = asRecord(t.inputSchema) ?? asRecord(t.schema) ?? {};
          return {
            name: String(t.name ?? "unknown"),
            description: asString(t.description),
            inputSchema: schemaObj,
            provider: asString(t.provider),
          };
        });

        return {
          ...baseFields,
          type: "tool_discovery",
          tools,
          provider: asString(p.provider),
          source: asToolSource(p.source),
        };
      }

      case "tool_call": {
        const rawArgs = p.arguments ?? p.input ?? p.args ?? {};
        const argsObj = asRecord(rawArgs) ?? {};

        return {
          ...baseFields,
          type: "tool_call",
          toolCallId: String(p.toolCallId ?? p.id ?? `call_${sequence}`),
          callId: String(p.callId ?? p.toolCallId ?? p.id ?? `call_${sequence}`),
          toolName: String(p.toolName ?? p.name ?? "unknown"),
          parameters: argsObj,
          input: argsObj,
          candidateRef: asString(p.candidateRef),
          isShadow: Boolean(p.isShadow),
        };
      }
      case "tool_result":
        return {
          ...baseFields,
          type: "tool_result",
          toolName: String(p.toolName ?? p.tool_name ?? p.name ?? "unknown_tool"),
          callId: String(p.callId ?? p.toolCallId ?? p.id ?? `call_${sequence}`),
          result: p.result !== undefined ? p.result : p.output,
          isError: Boolean(p.isError ?? p.is_error ?? p.error),
          executionDurationMs: asNumber(p.executionDurationMs) ?? asNumber(p.durationMs) ?? 0,
          outputSizeBytes: asNumber(p.outputSizeBytes),
          isShadow: Boolean(p.isShadow ?? false),
        };
      case "command_exec":
        return {
          ...baseFields,
          type: "command_exec",
          command: String(p.command ?? ""),
          args: Array.isArray(p.args) ? p.args.map(String) : [],
          cwd: asString(p.cwd) ?? asString(p.workingDirectory) ?? undefined,
          exitCode: asNumber(p.exitCode) ?? 0,
          stdout: asString(p.stdout),
          stderr: asString(p.stderr),
          durationMs: asNumber(p.durationMs) ?? 0,
        };

      case "file_edit": {
        const diffStatsObj = asRecord(p.diffStats);
        // SAFETY: diffStats object matches FileDiffStats structure if provided.
        // SAFETY: diffStats object matches FileDiffStats structure if provided.
        const diffStats = diffStatsObj ? (diffStatsObj as FileDiffStats) : undefined;
        return {
          ...baseFields,
          type: "file_edit",
          filePath: String(p.filePath ?? p.path ?? ""),
          operation: asFileOperation(p.operation),
          patch: asString(p.patch) ?? asString(p.diff) ?? undefined,
          beforeHash: asString(p.beforeHash),
          afterHash: asString(p.afterHash),
          diffStats,
        };
      }

      case "error":
        return {
          ...baseFields,
          type: "error",
          errorType: String(p.errorType ?? p.name ?? "Error"),
          message: String(p.message ?? "Unknown error"),
          stackTrace: asString(p.stackTrace),
          isFatal: Boolean(p.isFatal),
          recoverable:
            p.recoverable !== undefined
              ? Boolean(p.recoverable)
              : p.isFatal !== undefined
                ? !p.isFatal
                : true,
        };

      case "compaction": {
        const triggerReason = asCompactionTrigger(p.triggerReason ?? p.trigger);

        return {
          ...baseFields,
          type: "compaction",
          triggerReason,
          tokensBefore: asNumber(p.tokensBefore) ?? asNumber(p.originalEventCount),
          tokensAfter: asNumber(p.tokensAfter) ?? asNumber(p.compactedEventCount),
          preservedContextSummary: asString(p.preservedContextSummary) ?? asString(p.summary),
        };
      }

      case "branch_fork": {
        return {
          ...baseFields,
          type: "branch_fork",
          sourceSessionId: String(
            p.sourceSessionId ?? p.parentSessionId ?? p.parentId ?? sessionId,
          ),
          branchPointEventId: String(
            p.branchPointEventId ??
              p.forkPointEventId ??
              p.branchSessionId ??
              `evt_branch_${sequence}`,
          ),
          forkReason: asString(p.forkReason) ?? asString(p.reason),
          branchName: asString(p.branchName),
        };
      }

      case "subagent_lifecycle": {
        const lifecycleType = asSubagentLifecycleType(p.lifecycleType ?? p.action ?? p.event);

        return {
          ...baseFields,
          type: "subagent_lifecycle",
          subagentId: String(p.subagentId ?? p.subagentSessionId ?? p.agentId ?? ""),
          lifecycleType,
          parentId: asString(p.parentId) ?? asString(p.parentSessionId),
          role: asString(p.role),
          reason: asString(p.reason),
        };
      }

      case "session_lifecycle": {
        const lifecycleType = asSessionAction(p.lifecycleType ?? p.action ?? p.event);

        return {
          ...baseFields,
          type: "session_lifecycle",
          lifecycleType,
          exitReason: asString(p.exitReason) ?? asString(p.endReason),
          harnessName: asString(p.harnessName),
          workspaceId: asString(p.workspaceId),
        };
      }

      default:
        return {
          ...baseFields,
          type: "unknown_passthrough",
          rawEventType: String(p.rawEventType ?? p.rawRecordType ?? p.type ?? "unknown"),
          rawPayload: asRecord(p.rawPayload) ?? { value: p.rawPayload },
        };
    }
  }
}

/**
 * Registry managing harness-specific and default decoders.
 */
export class DecoderRegistry {
  private readonly decoders = new Map<string, HarnessRecordDecoder>();
  private readonly defaultDecoder: HarnessRecordDecoder;

  constructor(defaultDecoder?: HarnessRecordDecoder) {
    this.defaultDecoder = defaultDecoder ?? new UniversalHarnessRecordDecoder();
  }

  /**
   * Registers a decoder for a specific harness type.
   */
  register(decoder: HarnessRecordDecoder): void {
    this.decoders.set(decoder.harnessId, decoder);
  }

  /**
   * Finds the best decoder for a given record.
   */
  findDecoder(record: RawHarnessRecord): HarnessRecordDecoder {
    if (record.harnessId && this.decoders.has(record.harnessId)) {
      const decoder = this.decoders.get(record.harnessId)!;
      if (decoder.canDecode(record)) {
        return decoder;
      }
    }

    for (const decoder of this.decoders.values()) {
      if (decoder.canDecode(record)) {
        return decoder;
      }
    }

    return this.defaultDecoder;
  }

  /**
   * Decodes a record using the appropriate registered or default decoder.
   */
  async decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ): Promise<IntermediateSessionEvent[]> {
    const decoder = this.findDecoder(record);
    const result = await decoder.decode(record, context);
    if (!result) {
      return [];
    }
    return Array.isArray(result) ? result : [result];
  }
}
