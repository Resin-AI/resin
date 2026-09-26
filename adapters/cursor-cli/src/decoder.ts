import type { ProviderReportedUsage } from "@resin/contracts";
import type {
  BaseIntermediateEventFields,
  DecoderMetadataRecord,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { isRecord } from "./guards.js";
import {
  type CursorHookDriftIssue,
  inspectCursorHookPayload,
  parseSpoolLine,
} from "./hook-records.js";
import { CURSOR_HARNESS_ID } from "./paths.js";

export const CURSOR_DECODER_VERSION = "1.0.0";
export const CURSOR_USAGE_ACCOUNTING_VERSION = "cursor-hooks-v1";

/** cursor-agent's built-in shell tool name in hook payloads. */
const SHELL_TOOL_NAMES: Record<string, true> = { Shell: true, run_terminal_cmd: true };

export interface CursorDriftRecord extends CursorHookDriftIssue {
  readonly recordId: string;
}

/** JSON-decodes strings that hold JSON (cursor-agent stringifies tool input/output); else passthrough. */
function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toMetadata(value: unknown): DecoderMetadataRecord | undefined {
  return isRecord(value) ? (value as DecoderMetadataRecord) : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Usage reported on `afterAgentResponse`: one model generation. Never synthesizes totals. */
function usageFrom(payload: Record<string, unknown>): ProviderReportedUsage | undefined {
  const inputTokens = nonNegativeInt(payload.input_tokens);
  const outputTokens = nonNegativeInt(payload.output_tokens);
  const cachedInputTokens = nonNegativeInt(payload.cache_read_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
    return undefined;
  }
  return {
    provider: "cursor",
    model: stringField(payload, "model") ?? null,
    accountingVersion: CURSOR_USAGE_ACCOUNTING_VERSION,
    availability: "partial",
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cachedInputTokens: cachedInputTokens ?? null,
  };
}

/** Pulls stdout/exit code from a shell tool output without assuming one layout. */
function shellOutcome(output: unknown): { stdout?: string; stderr?: string; exitCode?: number } {
  if (typeof output === "string") return { stdout: output };
  if (!isRecord(output)) return {};
  const exit = [output.exitCode, output.exit_code, output.code].find(
    (value) => typeof value === "number" && Number.isInteger(value),
  );
  const stdout = [output.stdout, output.output].find((value) => typeof value === "string");
  return {
    stdout: stdout as string | undefined,
    stderr: typeof output.stderr === "string" ? output.stderr : undefined,
    exitCode: exit as number | undefined,
  };
}

type EventBase = BaseIntermediateEventFields & { metadata: DecoderMetadataRecord };
type EventBaseFactory = (suffix: string) => EventBase;

/**
 * Decodes Resin's Cursor hook spool records (one hook payload each) into intermediate events.
 * Unknown events and payloads that break the pinned field contract decode to nothing and are
 * recorded in {@link driftIssues}, so qualification fails instead of silently losing events.
 */
export class CursorRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = CURSOR_HARNESS_ID;
  readonly decoderVersion = CURSOR_DECODER_VERSION;
  readonly driftIssues: CursorDriftRecord[] = [];

  canDecode(record: RawHarnessRecord): boolean {
    return (
      record.harnessId === CURSOR_HARNESS_ID &&
      (isRecord(record.rawPayload) || typeof record.rawPayload === "string")
    );
  }

  decode(record: RawHarnessRecord): IntermediateSessionEvent[] | null {
    const raw = record.rawPayload;
    const payload = typeof raw === "string" ? parseSpoolLine(raw) : isRecord(raw) ? raw : null;
    const issues = inspectCursorHookPayload(payload);
    if (payload === null || issues.length > 0) {
      for (const issue of issues) this.driftIssues.push({ ...issue, recordId: record.recordId });
      return null;
    }
    const event = payload.hook_event_name as string;
    const sessionId = record.sessionId;
    const timestamp = (payload.resin_received_at as string) ?? record.timestamp;
    const base: EventBaseFactory = (suffix) => ({
      sessionId,
      timestamp,
      eventId: `${sessionId}:${record.sequenceNumber}:${suffix}`,
      causalRef: { causalSequence: record.sequenceNumber },
      metadata: {
        hookEvent: event,
        generationId: stringField(payload, "generation_id"),
        cursorVersion: stringField(payload, "cursor_version"),
      } satisfies DecoderMetadataRecord,
    });

    switch (event) {
      case "sessionStart":
        return [
          {
            ...base("session"),
            type: "session_lifecycle",
            lifecycleType: "start",
            harnessName: CURSOR_HARNESS_ID,
            metadata: {
              ...base("session").metadata,
              composerMode: stringField(payload, "composer_mode"),
              isBackgroundAgent: payload.is_background_agent === true,
            },
          },
        ];
      case "sessionEnd":
        return [
          {
            ...base("session"),
            type: "session_lifecycle",
            lifecycleType: "end",
            harnessName: CURSOR_HARNESS_ID,
            exitReason: stringField(payload, "reason") ?? stringField(payload, "final_status"),
          },
        ];
      case "beforeSubmitPrompt":
        return [
          {
            ...base("prompt"),
            type: "message",
            role: "user",
            content: payload.prompt as string,
            model: stringField(payload, "model"),
          },
        ];
      case "afterAgentThought":
        return [
          {
            ...base("thought"),
            type: "model_reasoning",
            reasoningText: payload.text as string,
            visibility: "visible",
            model: stringField(payload, "model"),
            durationMs: nonNegativeInt(payload.duration_ms),
          },
        ];
      case "afterAgentResponse":
        return [
          {
            ...base("response"),
            type: "message",
            role: "assistant",
            content: payload.text as string,
            model: stringField(payload, "model"),
            providerUsage: usageFrom(payload),
          },
        ];
      case "postToolUse":
      case "postToolUseFailure":
        return this.decodeTool(payload, event === "postToolUseFailure", base);
      case "afterFileEdit": {
        const edits = (payload.edits as unknown[]).filter(isRecord);
        const created = edits.length === 1 && edits[0]?.old_string === "";
        return [
          {
            ...base("edit"),
            type: "file_edit",
            filePath: payload.file_path as string,
            operation: created ? "create" : "patch",
            action: created ? "create" : "update",
            metadata: {
              ...base("edit").metadata,
              edits: edits.map((edit) => ({
                oldString: typeof edit.old_string === "string" ? edit.old_string : "",
                newString: typeof edit.new_string === "string" ? edit.new_string : "",
              })),
            },
          },
        ];
      }
      case "preCompact":
        return [
          {
            ...base("compaction"),
            type: "compaction",
            triggerReason: payload.trigger === "manual" ? "manual" : "context_limit",
            tokensBefore: nonNegativeInt(payload.context_tokens),
            metadata: {
              ...base("compaction").metadata,
              contextWindowSize: nonNegativeInt(payload.context_window_size),
              messagesToCompact: nonNegativeInt(payload.messages_to_compact),
            },
          },
        ];
      case "subagentStart":
      case "subagentStop": {
        const subagentId =
          stringField(payload, "subagent_id") ?? stringField(payload, "agent_id") ?? "unknown";
        return [
          {
            ...base("subagent"),
            type: "subagent_lifecycle",
            subagentId,
            lifecycleType: event === "subagentStart" ? "start" : "end",
            parentId: stringField(payload, "parent_conversation_id") ?? sessionId,
            role: stringField(payload, "subagent_type"),
            reason: stringField(payload, "task") ?? stringField(payload, "status"),
            metadata: {
              ...base("subagent").metadata,
              toolCallId: stringField(payload, "tool_call_id"),
              agentTranscriptPath: stringField(payload, "agent_transcript_path"),
            },
          },
        ];
      }
      case "stop": {
        const status = payload.status as string;
        if (status === "completed") return [];
        return [
          {
            ...base("stop"),
            type: "error",
            errorType: status === "aborted" ? "aborted" : "turn_error",
            message: status === "aborted" ? "Turn aborted" : `Turn ended with status ${status}`,
            recoverable: true,
          },
        ];
      }
      default:
        return null;
    }
  }

  private decodeTool(
    payload: Record<string, unknown>,
    failed: boolean,
    base: EventBaseFactory,
  ): IntermediateSessionEvent[] {
    const toolCallId = payload.tool_use_id as string;
    const toolName = payload.tool_name as string;
    const input = decodeMaybeJson(payload.tool_input);
    const output = decodeMaybeJson(payload.tool_output);
    const durationMs = nonNegativeInt(payload.duration);
    const events: IntermediateSessionEvent[] = [
      {
        ...base("call"),
        type: "tool_call",
        toolCallId,
        callId: toolCallId,
        toolName,
        input: toMetadata(input),
        rawInput: typeof payload.tool_input === "string" ? payload.tool_input : undefined,
      },
      {
        ...base("result"),
        type: "tool_result",
        toolCallId,
        callId: toolCallId,
        toolName,
        output: failed ? undefined : output,
        isError: failed,
        error: failed ? (payload.error_message as string) : undefined,
        durationMs,
        metadata: {
          ...base("result").metadata,
          failureType: stringField(payload, "failure_type"),
          interrupted: payload.is_interrupt === true,
        },
      },
    ];
    const command =
      isRecord(input) && typeof input.command === "string" ? input.command : undefined;
    if (SHELL_TOOL_NAMES[toolName] && command !== undefined) {
      const outcome = failed ? {} : shellOutcome(output);
      events.push({
        ...base("exec"),
        type: "command_exec",
        command,
        cwd:
          isRecord(input) && typeof input.working_directory === "string"
            ? input.working_directory
            : undefined,
        ...outcome,
        durationMs,
      });
    }
    return events;
  }
}
