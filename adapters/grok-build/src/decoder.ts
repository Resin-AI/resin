import type { ProviderReportedUsage } from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { GROK_HARNESS_ID } from "./paths.js";

/**
 * Decodes Grok `updates.jsonl` lines (ACP `session/update` notifications plus Grok's
 * `_x.ai/session/update` extensions) into intermediate session events.
 *
 * - `tool_call` opens a call; only the terminal `tool_call_update` (`status` completed/failed)
 *   becomes its result. Intermediate updates only carry display detail.
 * - MCP tools are hidden behind Grok's `use_tool` meta-tool (`tool_name: "<server>__<tool>"`);
 *   the decoder reports the MCP tool itself with `connection` set to the server.
 * - `rewind_marker` is appended when `/rewind` (or ACP `_x.ai/rewind/execute`) drops prompts
 *   `target_prompt_index..`: it becomes a `branch_fork`, so the replacement turns are ordered after
 *   the abandoned ones instead of silently replacing them.
 * - `turn_completed` carries the turn's provider usage.
 */
export const GROK_DECODER_VERSION = "grok-build-updates-v1";
const GROK_ACCOUNTING_VERSION = "grok-build-turn-usage-v1";

/** Built-in tools whose results carry shell execution details. */
const SHELL_TOOLS: Record<string, true> = { run_terminal_command: true };

/** Foreign-session resume skills: `/resume-claude <id>` continues a Claude Code session. */
const FOREIGN_RESUME_HARNESS: Record<string, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  cursor: "cursor-cli",
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toMetadata(value: unknown): DecoderMetadataRecord | undefined {
  const record = asRecord(value);
  return record ? (JSON.parse(JSON.stringify(record)) as DecoderMetadataRecord) : undefined;
}

function contentText(content: unknown): string {
  const block = asRecord(content);
  return block?.type === "text" ? (asString(block.text) ?? "") : "";
}

interface OpenCall {
  readonly toolName: string;
  readonly builtinName: string;
  readonly input?: DecoderMetadataRecord;
}

interface SessionState {
  readonly calls: Map<string, OpenCall>;
  modelId?: string;
}

function resolveCall(update: Json): OpenCall & { connection?: string } {
  const meta = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
  const builtinName = asString(meta?.name) ?? asString(update.title) ?? "unknown";
  const rawInput = asRecord(update.rawInput);
  if (builtinName === "use_tool") {
    const target = asString(rawInput?.tool_name);
    if (target) {
      const separator = target.indexOf("__");
      return {
        toolName: target,
        builtinName,
        input: toMetadata(rawInput?.tool_input) ?? {},
        ...(separator > 0 ? { connection: target.slice(0, separator) } : {}),
      };
    }
  }
  const separator = builtinName.indexOf("__");
  const isMcp = meta?.namespace !== "grok_build" && separator > 0;
  return {
    toolName: builtinName,
    builtinName,
    input: toMetadata(rawInput),
    ...(isMcp ? { connection: builtinName.slice(0, separator) } : {}),
  };
}

function resultText(update: Json): string | undefined {
  const texts = (Array.isArray(update.content) ? update.content : [])
    .map((item) => {
      const entry = asRecord(item);
      return entry?.type === "content" ? contentText(entry.content) : "";
    })
    .filter((text) => text.length > 0);
  if (texts.length > 0) return texts.join("\n");
  const raw = asRecord(update.rawOutput);
  const output = asRecord(raw?.output);
  return (
    asString(output?.OkayOutput) ??
    asString(output?.ErrorOutput) ??
    asString(raw?.output_for_prompt) ??
    asString(raw?.text) ??
    asString(asRecord(raw?.Result)?.output) ??
    (raw ? JSON.stringify(raw) : undefined)
  );
}

function turnUsage(update: Json): ProviderReportedUsage | undefined {
  const usage = asRecord(update.usage);
  if (!usage) return undefined;
  const models = Object.keys(asRecord(usage.modelUsage) ?? {});
  const inputTokens = asCount(usage.inputTokens);
  const outputTokens = asCount(usage.outputTokens);
  const totalTokens =
    asCount(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  // Grok reports cost in "ticks" of 1e-10 USD (`total_cost_usd_ticks` = `total_cost_usd` * 1e10).
  const ticks = asCount(usage.costUsdTicks);
  return {
    provider: "xai",
    model: models.length === 1 ? models[0] : null,
    accountingVersion: GROK_ACCOUNTING_VERSION,
    availability: totalTokens !== undefined ? "complete" : "partial",
    inputTokens,
    outputTokens,
    reasoningTokens: asCount(usage.reasoningTokens),
    cachedInputTokens: asCount(usage.cachedReadTokens),
    totalTokens,
    costMicroUsd: ticks !== undefined ? Math.round(ticks / 10_000) : undefined,
    costProvenance: ticks !== undefined ? "source_reported" : "unpriced",
    durationMs: asCount(update.elapsed_ms) ?? asCount(usage.apiDurationMs),
  };
}

export class GrokRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = GROK_HARNESS_ID;
  readonly decoderVersion = GROK_DECODER_VERSION;
  private readonly sessions = new Map<string, SessionState>();

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === GROK_HARNESS_ID && asRecord(record.rawPayload) !== undefined;
  }

  decode(record: RawHarnessRecord): IntermediateSessionEvent[] | null {
    const payload = asRecord(record.rawPayload);
    if (!payload) return null;
    const sessionId = record.sessionId;
    const base = { sessionId, timestamp: record.timestamp };
    const params = asRecord(payload.params);

    if (payload.method === "resin/grok-fork") {
      const parentSessionId = asString(params?.parentSessionId);
      return parentSessionId
        ? [
            {
              ...base,
              type: "branch_fork",
              branchId: sessionId,
              parentBranchId: parentSessionId,
              sourceSessionId: parentSessionId,
              forkReason: "fork_session",
            },
          ]
        : null;
    }

    const update = asRecord(params?.update);
    if (!update) return null;
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { calls: new Map() };
      this.sessions.set(sessionId, state);
    }

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const meta = asRecord(update._meta);
        state.modelId = asString(meta?.modelId) ?? state.modelId;
        const content = contentText(update.content);
        const metadata: DecoderMetadataRecord = {};
        if (meta?.hostTurn === true) metadata.hostTurn = true;
        if (asCount(meta?.promptIndex) !== undefined) metadata.promptIndex = meta?.promptIndex as number;
        const resume = /^\/resume-(claude|codex|cursor)\s+(\S+)/.exec(content.trim());
        const foreignHarness = resume ? FOREIGN_RESUME_HARNESS[resume[1] ?? ""] : undefined;
        if (resume && foreignHarness) {
          // The foreign transcript stays with its own harness adapter; this session only records
          // Grok's new work after the resume request.
          metadata.foreignResume = { harnessId: foreignHarness, nativeSessionId: resume[2] ?? null };
        }
        return [
          {
            ...base,
            type: "message",
            role: "user",
            content,
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          },
        ];
      }
      case "agent_message_chunk":
        return [
          {
            ...base,
            type: "message",
            role: "assistant",
            content: contentText(update.content),
            ...(state.modelId ? { model: state.modelId } : {}),
          },
        ];
      case "agent_thought_chunk":
        return [
          {
            ...base,
            type: "model_reasoning",
            reasoningText: contentText(update.content),
            visibility: "visible",
            ...(state.modelId ? { model: state.modelId } : {}),
          },
        ];
      case "tool_call": {
        const toolCallId = asString(update.toolCallId);
        if (!toolCallId) return null;
        const call = resolveCall(update);
        state.calls.set(toolCallId, call);
        return [
          {
            ...base,
            type: "tool_call",
            toolCallId,
            toolName: call.toolName,
            ...(call.connection ? { connection: call.connection } : {}),
            ...(call.input ? { input: call.input } : {}),
          },
        ];
      }
      case "tool_call_update":
        return this.decodeToolUpdate(update, state, base);
      case "turn_completed": {
        const providerUsage = turnUsage(update);
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "pause",
            exitReason: asString(update.stop_reason) ?? "turn_completed",
            harnessName: GROK_HARNESS_ID,
            ...(providerUsage ? { providerUsage } : {}),
            metadata: { promptId: asString(update.prompt_id) ?? null },
          },
        ];
      }
      case "rewind_marker": {
        const target = asCount(update.target_prompt_index);
        return [
          {
            ...base,
            type: "branch_fork",
            branchId: `${sessionId}#rewind@${record.sequenceNumber}`,
            parentBranchId: sessionId,
            sourceSessionId: sessionId,
            forkReason: "rewind",
            ...(target !== undefined ? { divergenceSequence: target } : {}),
            metadata: { targetPromptIndex: target ?? null },
          },
        ];
      }
      case "auto_compact_completed":
        return [
          {
            ...base,
            type: "compaction",
            tokensBefore: asCount(update.tokens_before),
            tokensAfter: asCount(update.tokens_after),
            ...(asString(update.summary_preview) ? { summary: asString(update.summary_preview) } : {}),
          },
        ];
      case "subagent_spawned":
      case "subagent_finished": {
        const subagentId = asString(update.child_session_id) ?? asString(update.subagent_id);
        if (!subagentId) return null;
        const spawned = update.sessionUpdate === "subagent_spawned";
        return [
          {
            ...base,
            type: "subagent_lifecycle",
            subagentId,
            lifecycleType: spawned ? "spawn" : update.status === "completed" ? "end" : "crash",
            parentId: sessionId,
            ...(asString(update.subagent_type) ? { role: asString(update.subagent_type) } : {}),
            ...(asString(update.status) ? { reason: asString(update.status) } : {}),
          },
        ];
      }
      default:
        return null;
    }
  }

  private decodeToolUpdate(
    update: Json,
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] | null {
    const status = update.status;
    const toolCallId = asString(update.toolCallId);
    if ((status !== "completed" && status !== "failed") || !toolCallId) return null;
    const call = state.calls.get(toolCallId);
    state.calls.delete(toolCallId);
    const isError = status === "failed";
    const output = resultText(update);
    const events: IntermediateSessionEvent[] = [
      {
        ...base,
        type: "tool_result",
        toolCallId,
        ...(call ? { toolName: call.toolName } : {}),
        ...(output !== undefined ? { output } : {}),
        isError,
      },
    ];
    const raw = asRecord(update.rawOutput);
    if (call && SHELL_TOOLS[call.builtinName] && raw?.type === "Bash") {
      const command = asString(raw.command) ?? asString(call.input?.command);
      if (command) {
        events.push({
          ...base,
          type: "command_exec",
          command,
          ...(asString(raw.current_dir) ? { cwd: asString(raw.current_dir) } : {}),
          ...(asCount(raw.exit_code) !== undefined ? { exitCode: asCount(raw.exit_code) } : {}),
          ...(asString(raw.output_for_prompt) ? { stdout: asString(raw.output_for_prompt) } : {}),
        });
      }
    }
    if (!isError) {
      for (const item of Array.isArray(update.content) ? update.content : []) {
        const diff = asRecord(item);
        const filePath = asString(diff?.path);
        if (diff?.type !== "diff" || !filePath) continue;
        const oldText = asString(diff.oldText) ?? "";
        const newText = asString(diff.newText) ?? "";
        const created = /has been created/.test(output ?? "");
        events.push({
          ...base,
          type: "file_edit",
          filePath,
          operation: created ? "create" : "update",
          linesAdded: newText ? newText.split("\n").filter(Boolean).length : 0,
          linesRemoved: oldText ? oldText.split("\n").filter(Boolean).length : 0,
        });
      }
    }
    return events;
  }
}
