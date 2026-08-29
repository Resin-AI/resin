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
  type RecordDecoderContext,
};

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
    if (typeof rawPayload === "object" && rawPayload !== null) {
      const p = rawPayload as Record<string, unknown>;
      if (typeof p.type === "string" && KNOWN_EVENT_TYPES.has(p.type)) {
        return this.normalizeTypedObject(p, sessionId, timestamp, sequence);
      }
    }

    // 2. Map based on recordType
    switch (record.recordType) {
      case "transcript_line": {
        if (typeof rawPayload === "string") {
          try {
            const parsed = JSON.parse(rawPayload);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              typeof parsed.type === "string" &&
              KNOWN_EVENT_TYPES.has(parsed.type)
            ) {
              return this.normalizeTypedObject(parsed, sessionId, timestamp, sequence);
            }
          } catch {
            // Not a JSON string, treat as text message
          }
          return {
            type: "message",
            role: "user",
            content: rawPayload,
            sessionId,
            timestamp,
            causalRef: { causalSequence: sequence },
          };
        }

        if (typeof rawPayload === "object" && rawPayload !== null) {
          const payload = rawPayload as Record<string, unknown>;
          return {
            type: "message",
            role: (payload.role as "user" | "assistant" | "system" | "tool") || "user",
            content:
              typeof payload.content === "string"
                ? payload.content
                : typeof payload.text === "string"
                  ? payload.text
                  : JSON.stringify(payload),
            contentParts: Array.isArray(payload.contentParts)
              ? (payload.contentParts as MessageContentPart[])
              : undefined,
            model: typeof payload.model === "string" ? payload.model : undefined,
            sessionId,
            timestamp,
            causalRef: { causalSequence: sequence },
          };
        }

        return {
          type: "message",
          role: "user",
          content: String(rawPayload ?? ""),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "prompt": {
        let content = "";
        let role: "user" | "system" = "user";
        if (typeof rawPayload === "string") {
          content = rawPayload;
        } else if (typeof rawPayload === "object" && rawPayload !== null) {
          const p = rawPayload as Record<string, unknown>;
          content = String(p.content ?? p.prompt ?? p.text ?? JSON.stringify(p));
          if (p.role === "system") {
            role = "system";
          }
        }
        return {
          type: "message",
          role,
          content,
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "completion": {
        if (typeof rawPayload === "object" && rawPayload !== null) {
          const p = rawPayload as Record<string, unknown>;
          let providerUsage: ProviderReportedUsage | undefined;
          const candidateUsage = p.providerUsage ?? p.usage;
          if (typeof candidateUsage === "object" && candidateUsage !== null) {
            const parsed = ProviderReportedUsageSchema.safeParse(candidateUsage);
            if (parsed.success) {
              providerUsage = parsed.data;
            }
          }

          const reasoning =
            typeof p.reasoningContent === "string"
              ? p.reasoningContent
              : typeof p.reasoning === "string"
                ? p.reasoning
                : typeof p.thought === "string"
                  ? p.thought
                  : undefined;
          if (reasoning) {
            return {
              type: "model_reasoning",
              reasoningContent: reasoning,
              model: typeof p.model === "string" ? p.model : undefined,
              signature: typeof p.signature === "string" ? p.signature : undefined,
              tokenCount: typeof p.tokenCount === "number" ? p.tokenCount : undefined,
              durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
              sessionId,
              timestamp,
              causalRef: { causalSequence: sequence },
              ...(providerUsage ? { providerUsage } : {}),
            };
          }

          return {
            type: "message",
            role: "assistant",
            content: String(p.content ?? p.text ?? p.completion ?? JSON.stringify(p)),
            model: typeof p.model === "string" ? p.model : undefined,
            sessionId,
            timestamp,
            causalRef: { causalSequence: sequence },
            ...(providerUsage ? { providerUsage } : {}),
          };
        }

        return {
          type: "message",
          role: "assistant",
          content: String(rawPayload ?? ""),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "tool_call": {
        if (typeof rawPayload !== "object" || rawPayload === null) {
          throw new DecodeError("Malformed tool_call payload: expected object", {
            recordId: record.recordId,
            recordType: record.recordType,
          });
        }
        const p = rawPayload as Record<string, unknown>;
        const rawArgs = p.parameters ?? p.arguments ?? p.params;
        const parameters =
          typeof rawArgs === "object" && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {};
        return {
          type: "tool_call",
          toolName: String(p.toolName ?? p.tool_name ?? p.name ?? "unknown_tool"),
          callId: String(p.callId ?? p.call_id ?? p.id ?? `call_${record.recordId}`),
          parameters,
          candidateRef: typeof p.candidateRef === "string" ? p.candidateRef : undefined,
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "tool_result": {
        if (typeof rawPayload !== "object" || rawPayload === null) {
          throw new DecodeError("Malformed tool_result payload: expected object", {
            recordId: record.recordId,
            recordType: record.recordType,
          });
        }
        const p = rawPayload as Record<string, unknown>;
        return {
          type: "tool_result",
          toolName: String(p.toolName ?? p.tool_name ?? p.name ?? "unknown_tool"),
          callId: String(p.callId ?? p.call_id ?? p.id ?? `call_${record.recordId}`),
          result: p.result !== undefined ? p.result : p.output,
          isError: Boolean(p.isError ?? p.is_error ?? p.error),
          executionDurationMs:
            typeof p.executionDurationMs === "number"
              ? p.executionDurationMs
              : typeof p.durationMs === "number"
                ? p.durationMs
                : 0,
          outputSizeBytes: typeof p.outputSizeBytes === "number" ? p.outputSizeBytes : undefined,
          isShadow: Boolean(p.isShadow ?? false),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }

      case "system": {
        if (typeof rawPayload === "object" && rawPayload !== null) {
          const p = rawPayload as Record<string, unknown>;
          const action = p.lifecycleType ?? p.action;
          if (action && ["start", "pause", "resume", "end", "crash"].includes(String(action))) {
            return {
              type: "session_lifecycle",
              lifecycleType: action as "start" | "pause" | "resume" | "end" | "crash",
              exitReason:
                typeof p.exitReason === "string"
                  ? p.exitReason
                  : typeof p.endReason === "string"
                    ? p.endReason
                    : undefined,
              harnessName: typeof p.harnessName === "string" ? p.harnessName : undefined,
              workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
              sessionId,
              timestamp,
              causalRef: { causalSequence: sequence },
            };
          }
        }
        return {
          type: "message",
          role: "system",
          content: typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload),
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }
      default: {
        const payloadObj =
          typeof rawPayload === "object" && rawPayload !== null
            ? (rawPayload as Record<string, unknown>)
            : { value: rawPayload };

        return {
          type: "unknown_passthrough",
          rawEventType: String(payloadObj.rawEventType ?? record.recordType ?? "custom"),
          rawPayload: payloadObj,
          sessionId,
          timestamp,
          causalRef: { causalSequence: sequence },
        };
      }
    }
  }

  private normalizeTypedObject(
    p: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    sequence: number,
  ): IntermediateSessionEvent {
    let providerUsage: ProviderReportedUsage | undefined;
    const candidateUsage = p.providerUsage ?? p.usage;
    if (typeof candidateUsage === "object" && candidateUsage !== null) {
      const parsed = ProviderReportedUsageSchema.safeParse(candidateUsage);
      if (parsed.success) {
        providerUsage = parsed.data;
      }
    }

    const baseFields = {
      sessionId: String(p.sessionId ?? sessionId),
      timestamp: String(p.timestamp ?? timestamp),
      causalRef: (p.causalRef as CausalRef) ?? { causalSequence: sequence },
      metadata:
        typeof p.metadata === "object" && p.metadata !== null
          ? (p.metadata as Record<string, unknown>)
          : undefined,
      ...(providerUsage ? { providerUsage } : {}),
    };

    switch (p.type) {
      case "message":
        return {
          ...baseFields,
          type: "message",
          role: (p.role as "user" | "assistant" | "system" | "tool") || "user",
          content: String(p.content ?? ""),
          contentParts: Array.isArray(p.contentParts)
            ? (p.contentParts as MessageContentPart[])
            : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
        };

      case "model_reasoning":
        return {
          ...baseFields,
          type: "model_reasoning",
          reasoningContent: String(p.reasoningContent ?? p.reasoning ?? p.thought ?? ""),
          signature: typeof p.signature === "string" ? p.signature : undefined,
          tokenCount: typeof p.tokenCount === "number" ? p.tokenCount : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
        };

      case "tool_discovery": {
        const rawTools = Array.isArray(p.tools)
          ? p.tools
          : Array.isArray(p.discoveredTools)
            ? p.discoveredTools
            : [];
        const tools: DiscoveredToolEntry[] = rawTools.map((t: Record<string, unknown>) => ({
          name: String(t.name ?? t.toolId ?? "unknown_tool"),
          description: typeof t.description === "string" ? t.description : undefined,
          inputSchema: (typeof t.inputSchema === "object" && t.inputSchema !== null
            ? t.inputSchema
            : typeof t.schema === "object" && t.schema !== null
              ? t.schema
              : {}) as Record<string, unknown>,
          provider: typeof t.provider === "string" ? t.provider : undefined,
        }));
        return {
          ...baseFields,
          type: "tool_discovery",
          tools,
          provider: typeof p.provider === "string" ? p.provider : undefined,
          source: (["mcp", "builtin", "dynamic", "harness"].includes(String(p.source))
            ? p.source
            : "mcp") as "mcp" | "builtin" | "dynamic" | "harness",
        };
      }

      case "tool_call": {
        const rawArgs = p.parameters ?? p.arguments ?? p.params;
        const parameters =
          typeof rawArgs === "object" && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {};
        return {
          ...baseFields,
          type: "tool_call",
          toolName: String(p.toolName ?? p.tool_name ?? p.name ?? "unknown_tool"),
          callId: String(p.callId ?? p.call_id ?? p.id ?? `call_${sequence}`),
          parameters,
          candidateRef: typeof p.candidateRef === "string" ? p.candidateRef : undefined,
        };
      }

      case "tool_result":
        return {
          ...baseFields,
          type: "tool_result",
          toolName: String(p.toolName ?? p.tool_name ?? p.name ?? "unknown_tool"),
          callId: String(p.callId ?? p.call_id ?? p.id ?? `call_${sequence}`),
          result: p.result !== undefined ? p.result : p.output,
          isError: Boolean(p.isError ?? p.is_error ?? p.error),
          executionDurationMs:
            typeof p.executionDurationMs === "number"
              ? p.executionDurationMs
              : typeof p.durationMs === "number"
                ? p.durationMs
                : 0,
          outputSizeBytes: typeof p.outputSizeBytes === "number" ? p.outputSizeBytes : undefined,
          isShadow: Boolean(p.isShadow ?? false),
        };

      case "command_exec":
        return {
          ...baseFields,
          type: "command_exec",
          command: String(p.command ?? ""),
          args: Array.isArray(p.args) ? p.args.map(String) : [],
          cwd:
            typeof p.cwd === "string"
              ? p.cwd
              : typeof p.workingDirectory === "string"
                ? p.workingDirectory
                : undefined,
          exitCode: typeof p.exitCode === "number" ? p.exitCode : 0,
          stdout: typeof p.stdout === "string" ? p.stdout : undefined,
          stderr: typeof p.stderr === "string" ? p.stderr : undefined,
          durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
        };

      case "file_edit":
        return {
          ...baseFields,
          type: "file_edit",
          filePath: String(p.filePath ?? p.path ?? ""),
          operation: (["create", "update", "delete", "patch"].includes(String(p.operation))
            ? p.operation
            : "update") as "create" | "update" | "delete" | "patch",
          patch:
            typeof p.patch === "string" ? p.patch : typeof p.diff === "string" ? p.diff : undefined,
          beforeHash: typeof p.beforeHash === "string" ? p.beforeHash : undefined,
          afterHash: typeof p.afterHash === "string" ? p.afterHash : undefined,
          diffStats:
            typeof p.diffStats === "object" && p.diffStats !== null
              ? (p.diffStats as FileDiffStats)
              : undefined,
        };

      case "error":
        return {
          ...baseFields,
          type: "error",
          errorType: String(p.errorType ?? "Error"),
          message: String(p.message ?? "Unknown error"),
          stackTrace: typeof p.stackTrace === "string" ? p.stackTrace : undefined,
          recoverable:
            p.recoverable !== undefined
              ? Boolean(p.recoverable)
              : p.isFatal !== undefined
                ? !p.isFatal
                : true,
        };

      case "compaction": {
        const triggerReason = ["context_limit", "manual", "scheduled", "turn_threshold"].includes(
          String(p.triggerReason ?? p.reason),
        )
          ? (p.triggerReason ?? p.reason)
          : "context_limit";
        return {
          ...baseFields,
          type: "compaction",
          triggerReason: triggerReason as
            | "context_limit"
            | "manual"
            | "scheduled"
            | "turn_threshold",
          tokensBefore:
            typeof p.tokensBefore === "number"
              ? p.tokensBefore
              : typeof p.originalEventCount === "number"
                ? p.originalEventCount
                : 1000,
          tokensAfter:
            typeof p.tokensAfter === "number"
              ? p.tokensAfter
              : typeof p.compactedEventCount === "number"
                ? p.compactedEventCount
                : 100,
          preservedContextSummary:
            typeof p.preservedContextSummary === "string"
              ? p.preservedContextSummary
              : typeof p.summary === "string"
                ? p.summary
                : undefined,
        };
      }

      case "branch_fork":
        return {
          ...baseFields,
          type: "branch_fork",
          sourceSessionId: String(p.sourceSessionId ?? p.parentSessionId ?? sessionId),
          branchPointEventId: String(
            p.branchPointEventId ?? p.branchSessionId ?? `evt_branch_${sequence}`,
          ),
          forkReason:
            typeof p.forkReason === "string"
              ? p.forkReason
              : typeof p.reason === "string"
                ? p.reason
                : undefined,
          branchName: typeof p.branchName === "string" ? p.branchName : undefined,
        };

      case "subagent_lifecycle": {
        const lifecycleType = ["spawn", "start", "pause", "resume", "terminate", "settle"].includes(
          String(p.lifecycleType ?? p.action),
        )
          ? (p.lifecycleType ?? p.action)
          : "spawn";
        return {
          ...baseFields,
          type: "subagent_lifecycle",
          subagentId: String(p.subagentId ?? `sub_${sequence}`),
          lifecycleType: lifecycleType as
            | "spawn"
            | "start"
            | "pause"
            | "resume"
            | "terminate"
            | "settle",
          parentId:
            typeof p.parentId === "string"
              ? p.parentId
              : typeof p.parentAgentId === "string"
                ? p.parentAgentId
                : undefined,
          role:
            typeof p.role === "string"
              ? p.role
              : typeof p.agentType === "string"
                ? p.agentType
                : undefined,
          reason:
            typeof p.reason === "string"
              ? p.reason
              : typeof p.resultSummary === "string"
                ? p.resultSummary
                : undefined,
        };
      }

      case "session_lifecycle": {
        const lifecycleType = ["start", "pause", "resume", "end", "crash"].includes(
          String(p.lifecycleType ?? p.action),
        )
          ? (p.lifecycleType ?? p.action)
          : "start";
        return {
          ...baseFields,
          type: "session_lifecycle",
          lifecycleType: lifecycleType as "start" | "pause" | "resume" | "end" | "crash",
          exitReason:
            typeof p.exitReason === "string"
              ? p.exitReason
              : typeof p.endReason === "string"
                ? p.endReason
                : undefined,
          harnessName: typeof p.harnessName === "string" ? p.harnessName : undefined,
          workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : undefined,
        };
      }
      default:
        return {
          ...baseFields,
          type: "unknown_passthrough",
          rawEventType: String(p.rawEventType ?? p.originalRecordType ?? p.type ?? "unknown"),
          rawPayload:
            typeof p.rawPayload === "object" && p.rawPayload !== null
              ? (p.rawPayload as Record<string, unknown>)
              : { value: p.rawPayload },
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

  register(decoder: HarnessRecordDecoder): void {
    this.decoders.set(decoder.harnessId, decoder);
  }

  getDecoder(harnessId: string): HarnessRecordDecoder | undefined {
    return this.decoders.get(harnessId);
  }

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
