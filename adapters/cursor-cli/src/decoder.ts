import { createHash } from "node:crypto";
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
const MCP_TOOL_PREFIX = "MCP:";

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

/** Hook `duration` is fractional milliseconds (`175.144`); events carry whole milliseconds. */
function durationMillis(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The catalog model behind a cursor-agent model id. Hook payloads carry Cursor's picker ids
 * (`cursor-grok-4.5-high-fast`, `claude-opus-5-thinking-high`, `gemini-3.7-flash-low`): a
 * `cursor-` prefix and speed/effort/thinking suffixes around the model's own id (`grok-4.5`).
 * `default` is the requested `auto` router, not a model, so it names none.
 */
export function cursorCatalogModel(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "default" || raw === "auto") return undefined;
  let model = raw.replace(/^cursor-/, "");
  for (;;) {
    const next = model.replace(/-(?:fast|low|medium|high|xhigh|max|thinking)$/, "");
    if (next === model) return model;
    model = next;
  }
}

function modelField(payload: Record<string, unknown>): string | undefined {
  return cursorCatalogModel(stringField(payload, "model"));
}

/**
 * Turn usage as reported on `stop`. cursor-agent repeats the same numbers on the turn's
 * `afterAgentResponse` (same generation_id), which fires only for completed turns, so usage is
 * taken from `stop` alone to count each turn once. Never synthesizes totals.
 */
function usageFrom(payload: Record<string, unknown>): ProviderReportedUsage | undefined {
  const inputTokens = nonNegativeInt(payload.input_tokens);
  const outputTokens = nonNegativeInt(payload.output_tokens);
  const cachedInputTokens = nonNegativeInt(payload.cache_read_tokens);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
    return undefined;
  }
  return {
    provider: "cursor",
    model: modelField(payload) ?? null,
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

/**
 * The event call id for one tool record: `<tool_name>:<tool_use_id>`, since cursor-agent reports
 * one model edit as a Read and a Write sharing a tool_use_id. Real ids join two provider ids with
 * a newline (`call-…-3\nfc_…_0`), which event identifiers do not allow, so characters outside the
 * identifier alphabet become `_`; an id still over the 128-character limit is hashed.
 */
export function cursorCallId(toolName: string, toolUseId: string): string {
  const id = `${toolName}:${toolUseId}`.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (id.length <= 128) return id;
  return `${id.slice(0, 63)}:${createHash("sha256").update(id).digest("hex").slice(0, 64)}`;
}

type EventBase = BaseIntermediateEventFields & { metadata: DecoderMetadataRecord };
/** `step` separates the events one hook record produces (call, result, shell step). */
type EventBaseFactory = (suffix: string, step?: number) => EventBase;

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
    const base: EventBaseFactory = (suffix, step) => ({
      sessionId,
      timestamp,
      eventId: `${sessionId}:${record.sequenceNumber}:${suffix}`,
      causalRef: { causalSequence: record.sequenceNumber, ...(step ? { stepIndex: step } : {}) },
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
            model: modelField(payload),
          },
        ];
      case "afterAgentThought":
        return [
          {
            ...base("thought"),
            type: "model_reasoning",
            reasoningContent: payload.text as string,
            visibility: "visible",
            model: modelField(payload),
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
            model: modelField(payload),
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
            // The hook fires before compacting, so only the size going in is known.
            tokensBefore: nonNegativeInt(payload.context_tokens) ?? 0,
            tokensAfter: 0,
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
            // The task tool call that runs the subagent.
            ...(stringField(payload, "tool_call_id")
              ? { producedByCallId: stringField(payload, "tool_call_id") }
              : {}),
            lifecycleType: event === "subagentStart" ? "start" : "settle",
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
        // `stop` fires for every turn with its token usage (see usageFrom).
        const providerUsage = usageFrom(payload);
        // A completed turn settles everything the agent did since its prompt.
        if (status === "completed")
          return [
            {
              ...base("stop"),
              ...(providerUsage ? { providerUsage } : {}),
              type: "session_lifecycle",
              lifecycleType: "end",
              harnessName: CURSOR_HARNESS_ID,
              exitReason: "completed",
            },
          ];
        return [
          {
            ...base("stop"),
            type: "error",
            ...(providerUsage ? { providerUsage } : {}),
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
    const cursorToolName = payload.tool_name as string;
    // cursor-agent names an MCP call `MCP:<tool>` without its server (2026.09.26-dd393fe); the
    // tool is the callable's own name, as other adapters report MCP tools, so Resin's meta tools
    // (`MCP:manage_tools`) are recognized as such and never learned as user work.
    const toolName = cursorToolName.startsWith(MCP_TOOL_PREFIX)
      ? cursorToolName.slice(MCP_TOOL_PREFIX.length)
      : cursorToolName;
    // cursor-agent reports one model edit as a Read and a Write postToolUse sharing one
    // tool_use_id (observed with 2026.09.26-dd393fe), so the id alone is not unique per call.
    const toolCallId = cursorCallId(cursorToolName, payload.tool_use_id as string);
    const nativeToolUseId = payload.tool_use_id as string;
    const input = decodeMaybeJson(payload.tool_input);
    const output = decodeMaybeJson(payload.tool_output);
    const durationMs = durationMillis(payload.duration);
    // A shell call that ran but exited non-zero failed; its tool result is the one record of that.
    const exitCode =
      SHELL_TOOL_NAMES[toolName] && !failed ? shellOutcome(output).exitCode : undefined;
    const commandFailed = exitCode !== undefined && exitCode !== 0;
    const events: IntermediateSessionEvent[] = [
      {
        ...base("call"),
        type: "tool_call",
        callId: toolCallId,
        toolName,
        parameters: toMetadata(input) ?? {},
        rawInput: typeof payload.tool_input === "string" ? payload.tool_input : undefined,
        ...(toolName !== cursorToolName
          ? { metadata: { ...base("call").metadata, cursorToolName } }
          : {}),
      },
      {
        ...base("result", 1),
        type: "tool_result",
        callId: toolCallId,
        toolName,
        // A failed call's result is the error the agent was shown.
        result: failed ? (payload.error_message as string) : output,
        isError: failed || commandFailed,
        error: failed
          ? (payload.error_message as string)
          : commandFailed
            ? `exit code ${exitCode}`
            : undefined,
        executionDurationMs: durationMs ?? 0,
        metadata: {
          ...base("result", 1).metadata,
          failureType: stringField(payload, "failure_type"),
          toolUseId: nativeToolUseId,
          interrupted: payload.is_interrupt === true,
        },
      },
    ];
    return events;
  }
}
