import type { ProviderReportedUsage } from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  DecoderMetadataValue,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { COPILOT_HARNESS_ID } from "./discovery.js";

export const COPILOT_DECODER_VERSION = "1.0.0";
export const COPILOT_PROVIDER = "github-copilot";
/**
 * Usage comes from `session.shutdown.modelMetrics`, which Copilot accumulates over the whole
 * session (resumed runs included). Each shutdown is decoded as the delta from the previous one.
 */
export const COPILOT_ACCOUNTING_VERSION = "copilot-cli-shutdown-delta-v1";

type Json = DecoderMetadataValue;
type JsonRecord = DecoderMetadataRecord;

interface CopilotEvent {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  data: JsonRecord;
}

interface ToolStart {
  toolName: string;
  arguments: Json;
  mcpServerName?: string;
  startedAt: number;
}

interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseEvent(payload: unknown): CopilotEvent | null {
  const record = asRecord(payload);
  const type = asString(record?.type);
  if (!record || !type) return null;
  return {
    type,
    id: asString(record.id),
    parentId: asString(record.parentId) ?? null,
    timestamp: asString(record.timestamp),
    data: asRecord(record.data) ?? {},
  };
}

/** Files touched by an `apply_patch` envelope (`*** Add|Update|Delete File: <path>`). */
export interface CopilotPatchFile {
  path: string;
  action: "create" | "update" | "delete";
  movedTo?: string;
  patch: string;
  linesAdded: number;
  linesRemoved: number;
}

export function parseCopilotApplyPatch(patch: string): CopilotPatchFile[] {
  const files: CopilotPatchFile[] = [];
  let current: CopilotPatchFile | null = null;
  const actionByVerb: Record<string, CopilotPatchFile["action"]> = {
    Add: "create",
    Update: "update",
    Delete: "delete",
  };
  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = {
        path: header[2]!.trim(),
        action: actionByVerb[header[1]!]!,
        patch: `${line}\n`,
        linesAdded: 0,
        linesRemoved: 0,
      };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith("*** End Patch")) continue;
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) current.movedTo = move[1]!.trim();
    current.patch += `${line}\n`;
    if (line.startsWith("+")) current.linesAdded += 1;
    else if (line.startsWith("-")) current.linesRemoved += 1;
  }
  return files;
}

/**
 * Decodes Copilot CLI `session-state/<id>/events.jsonl` records.
 *
 * State is kept per session id: tool results are joined to their `tool.execution_start`
 * (exact arguments, MCP server) and usage is the delta between successive `session.shutdown`
 * totals. Events from subagents carry `parentToolCallId` (the `task` tool call that spawned them),
 * which is surfaced as `metadata.parentToolCallId` and as the subagent id.
 */
export class CopilotRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = COPILOT_HARNESS_ID;
  readonly decoderVersion = COPILOT_DECODER_VERSION;

  private readonly toolStarts = new Map<string, ToolStart>();
  /** `session.compaction_start.trigger` awaiting its `session.compaction_complete`, per session. */
  private readonly compactionTriggers = new Map<string, string>();
  private readonly previousTotalsBySession = new Map<string, Map<string, ModelUsageTotals>>();

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === COPILOT_HARNESS_ID && parseEvent(record.rawPayload) !== null;
  }

  decode(record: RawHarnessRecord): IntermediateSessionEvent[] {
    const event = parseEvent(record.rawPayload);
    if (!event) return [];
    // One line can yield several events (tool result + command/file edit); stepIndex keeps
    // their (sequence, step) identity unique for the observer's deduplicator.
    return this.decodeEvent(event, record.sessionId, record.sequenceNumber, record.timestamp).map(
      (decoded, stepIndex) => ({ ...decoded, causalRef: { ...decoded.causalRef, stepIndex } }),
    );
  }

  decodeEvent(
    event: CopilotEvent,
    sessionId: string,
    sequence: number,
    fallbackTimestamp: string,
  ): IntermediateSessionEvent[] {
    const data = event.data;
    const parentToolCallId = asString(data.parentToolCallId);
    const base = {
      sessionId,
      timestamp: event.timestamp ?? fallbackTimestamp,
      schemaVersion: COPILOT_DECODER_VERSION,
      eventId: event.id,
      causalRef: {
        causalSequence: sequence,
        ...(event.parentId ? { parentId: event.parentId } : {}),
      },
      metadata: {
        copilotEventType: event.type,
        ...(asString(data.turnId) !== undefined ? { turnId: asString(data.turnId) } : {}),
        ...(asString(data.interactionId) ? { interactionId: asString(data.interactionId) } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      } as JsonRecord,
    };

    switch (event.type) {
      case "session.start": {
        const context = asRecord(data.context);
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "start",
            harnessName: COPILOT_HARNESS_ID,
            metadata: {
              ...base.metadata,
              copilotVersion: asString(data.copilotVersion),
              cwd: asString(context?.cwd),
              gitRoot: asString(context?.gitRoot),
              branch: asString(context?.branch),
            },
          },
        ];
      }
      case "session.resume":
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "resume",
            harnessName: COPILOT_HARNESS_ID,
          },
        ];
      case "session.shutdown":
        return [this.decodeShutdown(base, data)];
      case "session.model_change":
      case "session.auto_mode_resolved":
        return [];
      case "user.message": {
        const content = asString(data.content) ?? "";
        // Subagent prompts are written as user messages with `source: "agent-<sessionId>"`.
        const fromAgent = asString(data.source)?.startsWith("agent-") ?? false;
        return [
          {
            ...base,
            type: "message",
            role: fromAgent ? "system" : "user",
            content,
            metadata: fromAgent
              ? { ...base.metadata, source: asString(data.source), subagentPrompt: true }
              : base.metadata,
          },
        ];
      }
      case "system.message":
        // The system prompt is harness boilerplate; its size is not transcript content.
        return [];
      case "assistant.message":
        return this.decodeAssistantMessage(base, data);
      case "tool.execution_start":
        return this.decodeToolStart(base, data);
      case "tool.execution_complete":
        return this.decodeToolComplete(base, data);
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed": {
        const lifecycleType =
          event.type === "subagent.started"
            ? "start"
            : event.type === "subagent.completed"
              ? "settle"
              : "terminate";
        return [
          {
            ...base,
            type: "subagent_lifecycle",
            subagentId: asString(data.toolCallId) ?? event.id ?? `subagent-${sequence}`,
            // The task tool call that runs the subagent.
            ...(asString(data.toolCallId) ? { producedByCallId: asString(data.toolCallId) } : {}),
            lifecycleType,
            role: asString(data.agentName),
            reason: asString(data.error) ?? asString(data.agentDescription),
            metadata: {
              ...base.metadata,
              agentDisplayName: asString(data.agentDisplayName),
              model: asString(data.model),
              ...(data.totalTokens !== undefined ? { totalTokens: asCount(data.totalTokens) } : {}),
              ...(data.totalToolCalls !== undefined
                ? { totalToolCalls: asCount(data.totalToolCalls) }
                : {}),
              ...(data.durationMs !== undefined ? { durationMs: asCount(data.durationMs) } : {}),
            },
          },
        ];
      }
      case "session.compaction_start":
        this.compactionTriggers.set(sessionId, asString(data.trigger) ?? "");
        return [];
      case "session.compaction_complete": {
        const trigger = this.compactionTriggers.get(sessionId);
        this.compactionTriggers.delete(sessionId);
        return [
          {
            ...base,
            type: "compaction",
            // `/compact` records "manual"; automatic compaction runs when the context fills up.
            triggerReason: trigger === "manual" ? "manual" : "context_limit",
            summary: asString(data.summaryContent),
            tokensBefore: asCount(data.preCompactionTokens),
            tokensAfter: asCount(data.postCompactionTokens),
            metadata: {
              ...base.metadata,
              success: data.success === true,
              messagesRemoved: asCount(data.messagesRemoved),
              ...(asString(data.error) ? { error: asString(data.error) } : {}),
              ...(trigger ? { trigger } : {}),
            },
          },
        ];
      }
      case "session.error":
        return [
          {
            ...base,
            type: "error",
            errorType: asString(data.errorType) ?? "session_error",
            message: asString(data.message) ?? "Copilot session error",
            stack: asString(data.stack),
            recoverable: true,
          },
        ];
      case "abort": {
        // Ctrl+C cancels in-flight tools without writing their tool.execution_complete.
        const prefix = `${sessionId}:`;
        const abortedToolCallIds = [...this.toolStarts.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length));
        for (const id of abortedToolCallIds) this.toolStarts.delete(`${prefix}${id}`);
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "pause",
            exitReason: `abort:${asString(data.reason) ?? "unknown"}`,
            harnessName: COPILOT_HARNESS_ID,
            metadata: { ...base.metadata, abortedToolCallIds },
          },
        ];
      }
      case "assistant.turn_start":
      case "assistant.turn_end":
      case "session.usage_checkpoint":
      case "subagent.selected":
      case "subagent.configured":
        return [];
      default:
        // `model.*` records are the compaction model call's raw request/response copies.
        if (event.type.startsWith("model.")) return [];
        return [
          {
            ...base,
            type: "unknown_passthrough",
            rawEventType: event.type,
            rawPayload: data,
          },
        ];
    }
  }

  private decodeAssistantMessage(base: BaseFields, data: JsonRecord): IntermediateSessionEvent[] {
    const events: IntermediateSessionEvent[] = [];
    const model = asString(data.model);
    const reasoning = asString(data.reasoningText);
    if (reasoning) {
      events.push({
        ...base,
        type: "model_reasoning",
        reasoningText: reasoning,
        reasoningContent: reasoning,
        model,
      });
    }
    const content = asString(data.content) ?? "";
    if (content.length > 0) {
      events.push({
        ...base,
        type: "message",
        role: "assistant",
        content,
        model,
        metadata: asString(data.phase)
          ? { ...base.metadata, phase: asString(data.phase) }
          : base.metadata,
      });
    }
    // Tool requests are decoded from tool.execution_start, which carries the same arguments
    // plus the resolved MCP server, and is also written for tools that never reach the model.
    return events;
  }

  private decodeToolStart(base: BaseFields, data: JsonRecord): IntermediateSessionEvent[] {
    const toolCallId = asString(data.toolCallId);
    const rawToolName = asString(data.toolName) ?? "unknown";
    const mcpServerName = asString(data.mcpServerName);
    const toolName = (mcpServerName && asString(data.mcpToolName)) || rawToolName;
    const args = data.arguments;
    if (toolCallId) {
      this.toolStarts.set(`${base.sessionId}:${toolCallId}`, {
        toolName,
        arguments: args,
        mcpServerName,
        startedAt: Date.parse(base.timestamp),
      });
    }
    const input = asRecord(args);
    return [
      {
        ...base,
        type: "tool_call",
        toolCallId,
        callId: toolCallId,
        toolName,
        ...(mcpServerName ? { connection: mcpServerName } : {}),
        // Freeform tools (apply_patch) take one raw string; it is kept verbatim under `raw`.
        parameters: input ?? (typeof args === "string" ? { raw: args } : {}),
        ...(input ? { input } : {}),
        ...(typeof args === "string" ? { rawInput: args } : {}),
        metadata: {
          ...base.metadata,
          copilotToolName: rawToolName,
          model: asString(data.model),
          // Copilot reports MCP tools with their server, so a serverless `bash` with a command is its
          // built-in shell; only this decoder proves that to the recorder, with a local-only marker.
          ...(!mcpServerName && rawToolName === "bash" && typeof input?.command === "string"
            ? { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "copilot-bash" }
            : {}),
          ...(mcpServerName
            ? {
                mcpServerName,
                mcpConfigServerName: asString(data.mcpConfigServerName),
                mcpTransport: asString(data.mcpTransport),
                mcpConfigSource: asString(data.mcpConfigSource),
              }
            : {}),
        },
      },
    ];
  }

  private decodeToolComplete(base: BaseFields, data: JsonRecord): IntermediateSessionEvent[] {
    const toolCallId = asString(data.toolCallId);
    const startKey = `${base.sessionId}:${toolCallId}`;
    const start = toolCallId ? this.toolStarts.get(startKey) : undefined;
    this.toolStarts.delete(startKey);
    const result = asRecord(data.result);
    const error = asRecord(data.error);
    // A shell call that ran but exited non-zero failed; its tool result is the one record of that.
    const exitCode = asRecord(data.shellExecution)?.exitCode;
    const commandFailed = data.success === true && typeof exitCode === "number" && exitCode !== 0;
    const success = data.success === true && !commandFailed;
    const output = asString(result?.content);
    const finishedAt = Date.parse(base.timestamp);
    // Both timestamps are Copilot's own; a completion without its start has no duration.
    const durationMs =
      start && Number.isFinite(start.startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, finishedAt - start.startedAt)
        : undefined;
    const errorMessage = commandFailed ? `exit code ${exitCode}` : asString(error?.message);
    const events: IntermediateSessionEvent[] = [
      {
        ...base,
        type: "tool_result",
        toolCallId,
        callId: toolCallId,
        toolName: start?.toolName,
        result: output ?? null,
        output: output ?? null,
        isError: !success,
        ...(durationMs !== undefined ? { executionDurationMs: durationMs, durationMs } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(output !== undefined ? { outputSizeBytes: Buffer.byteLength(output, "utf8") } : {}),
        metadata: {
          ...base.metadata,
          ...(start?.toolName === "bash" && !start.mcpServerName && exitCode === 0 && success
            ? { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "shell-exited-0" }
            : {}),
          ...(asString(result?.detailedContent) !== undefined
            ? { detailedContent: asString(result?.detailedContent) }
            : {}),
          ...(asString(error?.code) ? { errorCode: asString(error?.code) } : {}),
          ...(start?.mcpServerName ? { mcpServerName: start.mcpServerName } : {}),
        },
      },
    ];

    if (!start || !success) return events;

    if (start.toolName === "apply_patch" && typeof start.arguments === "string") {
      for (const file of parseCopilotApplyPatch(start.arguments)) {
        events.push({
          ...base,
          type: "file_edit",
          ...(toolCallId ? { producedByCallId: toolCallId } : {}),
          filePath: file.movedTo ?? file.path,
          operation: file.action === "update" ? "patch" : file.action,
          action: file.action,
          patch: file.patch,
          linesAdded: file.linesAdded,
          linesRemoved: file.linesRemoved,
          diffStats: { linesAdded: file.linesAdded, linesRemoved: file.linesRemoved },
          metadata: {
            ...base.metadata,
            toolCallId,
            ...(file.movedTo ? { movedFrom: file.path } : {}),
          },
        });
      }
    }
    return events;
  }

  /**
   * Usage for the process run that just ended. `tokenDetails` is the session-wide total (it also
   * counts compaction calls, which `modelMetrics` omits: the recorded /compact run added 9,585
   * input and 1,335 output tokens there while every model's usage stayed flat). `modelMetrics`
   * gives the per-model split and reasoning tokens; the usage names a model only when the whole
   * delta belongs to that one model.
   */
  private decodeShutdown(base: BaseFields, data: JsonRecord): IntermediateSessionEvent {
    const totals = new Map<string, ModelUsageTotals>();
    for (const [model, value] of Object.entries(asRecord(data.modelMetrics) ?? {})) {
      const usage = asRecord(asRecord(value)?.usage);
      if (!usage) continue;
      totals.set(model, {
        inputTokens: asCount(usage.inputTokens),
        outputTokens: asCount(usage.outputTokens),
        cacheReadTokens: asCount(usage.cacheReadTokens),
        cacheWriteTokens: asCount(usage.cacheWriteTokens),
        reasoningTokens: asCount(usage.reasoningTokens),
        requests: asCount(asRecord(asRecord(value)?.requests)?.count),
      });
    }
    const details = asRecord(data.tokenDetails);
    const tokenCount = (key: string) => asCount(asRecord(details?.[key])?.tokenCount);
    const sessionTotals: ModelUsageTotals | undefined = details
      ? {
          inputTokens: tokenCount("input") + tokenCount("cache_read") + tokenCount("cache_write"),
          outputTokens: tokenCount("output"),
          cacheReadTokens: tokenCount("cache_read"),
          cacheWriteTokens: tokenCount("cache_write"),
          reasoningTokens: [...totals.values()].reduce((sum, t) => sum + t.reasoningTokens, 0),
          requests: [...totals.values()].reduce((sum, t) => sum + t.requests, 0),
        }
      : undefined;

    const previousTotals =
      this.previousTotalsBySession.get(base.sessionId) ?? new Map<string, ModelUsageTotals>();
    const subtract = (
      current: ModelUsageTotals,
      previous?: ModelUsageTotals,
    ): ModelUsageTotals => ({
      inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
      outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0)),
      cacheReadTokens: Math.max(0, current.cacheReadTokens - (previous?.cacheReadTokens ?? 0)),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)),
      reasoningTokens: Math.max(0, current.reasoningTokens - (previous?.reasoningTokens ?? 0)),
      requests: Math.max(0, current.requests - (previous?.requests ?? 0)),
    });
    const deltas: Array<[string, ModelUsageTotals]> = [];
    for (const [model, current] of totals) {
      const delta = subtract(current, previousTotals.get(model));
      if (delta.inputTokens + delta.outputTokens + delta.requests > 0) deltas.push([model, delta]);
    }
    const modelSum = deltas.reduce<ModelUsageTotals>(
      (acc, [, d]) => ({
        inputTokens: acc.inputTokens + d.inputTokens,
        outputTokens: acc.outputTokens + d.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + d.cacheWriteTokens,
        reasoningTokens: acc.reasoningTokens + d.reasoningTokens,
        requests: acc.requests + d.requests,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requests: 0,
      },
    );
    const delta = sessionTotals
      ? subtract(sessionTotals, previousTotals.get(SESSION_TOTALS_KEY))
      : modelSum;

    // Totals only grow; a model missing from a later shutdown keeps its previous totals.
    const nextTotals = new Map([...previousTotals, ...totals]);
    if (sessionTotals) nextTotals.set(SESSION_TOTALS_KEY, sessionTotals);
    this.previousTotalsBySession.set(base.sessionId, nextTotals);

    let providerUsage: ProviderReportedUsage | undefined;
    if (delta.inputTokens + delta.outputTokens > 0) {
      const singleModel =
        deltas.length === 1 &&
        deltas[0]![1].inputTokens === delta.inputTokens &&
        deltas[0]![1].outputTokens === delta.outputTokens
          ? deltas[0]![0]
          : null;
      providerUsage = {
        provider: COPILOT_PROVIDER,
        model: singleModel,
        accountingVersion: COPILOT_ACCOUNTING_VERSION,
        availability: "complete",
        // Copilot's input totals include cache reads and cache writes.
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        reasoningTokens: delta.reasoningTokens,
        cachedInputTokens: delta.cacheReadTokens,
        totalTokens: delta.inputTokens + delta.outputTokens,
        costProvenance: "unpriced",
      };
    }

    const shutdownType = asString(data.shutdownType) ?? "routine";
    return {
      ...base,
      type: "session_lifecycle",
      lifecycleType: shutdownType === "error" ? "crash" : "end",
      exitReason: asString(data.errorReason) ?? shutdownType,
      harnessName: COPILOT_HARNESS_ID,
      ...(providerUsage ? { providerUsage } : {}),
      metadata: {
        ...base.metadata,
        currentModel: asString(data.currentModel),
        cacheWriteTokens: delta.cacheWriteTokens,
        totalPremiumRequests: asCount(data.totalPremiumRequests),
        totalNanoAiu: asCount(data.totalNanoAiu),
        modelUsageDelta: Object.fromEntries(
          deltas.map(([model, d]) => [model, { ...d }] as [string, JsonRecord]),
        ),
      },
    };
  }
}

/** Key under which a session's `tokenDetails` totals are remembered between shutdowns. */
const SESSION_TOTALS_KEY = "";

type BaseFields = {
  sessionId: string;
  timestamp: string;
  schemaVersion: string;
  eventId?: string;
  causalRef: { causalSequence: number; parentId?: string };
  metadata: JsonRecord;
};

export function createCopilotDecoder(): CopilotRecordDecoder {
  return new CopilotRecordDecoder();
}
