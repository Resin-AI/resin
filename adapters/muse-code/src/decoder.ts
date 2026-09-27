import type { DiscoveredToolEntry, ProviderReportedUsage } from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  IntermediateToolCallEvent,
  RawHarnessRecord,
  RecordDecoderContext,
} from "@resin/harness-contracts";
import { MUSE_HARNESS_ID } from "./discovery.js";
import { museRecordTimestamp } from "./source.js";

export const MUSE_DECODER_VERSION = "muse-code-decoder/1";
const MUSE_ACCOUNTING_VERSION = "muse-code-usage/1";

/**
 * What a tool call's side effect is known to have done.
 *
 * `unknown` covers every call whose effect may have partially or fully applied without a
 * recorded completion: cancelled mid-flight, or in flight when the process died (muse later
 * reports "The outcome is unknown"). Such calls surface as errors (`isError: true`, with
 * `museOutcome: "unknown"`) so they are never treated as successful demonstrations.
 */
export type MuseToolOutcome = "succeeded" | "failed" | "unknown";

/** Result text muse synthesizes on resume for a call whose process died mid-flight. */
const UNKNOWN_OUTCOME_PREFIX = "The previous process terminated while this tool call was in flight";

const FILE_WRITE_TOOLS: Record<string, "update" | "create"> = {
  edit_file: "update",
  write_file: "create",
};

interface CallState {
  toolName: string;
  connection?: string;
  parameters: DecoderMetadataRecord;
  /** When the call was committed; its result's timestamp minus this is the execution time. */
  calledAt: string;
}

interface SessionState {
  model?: string;
  calls: Map<string, CallState>;
  effectIdToCallId: Map<string, string>;
  outcomes: Map<string, MuseToolOutcome>;
  patches: Map<string, { added?: number; removed?: number }>;
  mcpTools: Map<string, { server: string; tool: string }>;
  pendingUsage?: ProviderReportedUsage;
  /** The current run already ended the session with its completed terminal. */
  ended?: boolean;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toMetadata(value: unknown): DecoderMetadataRecord {
  const record = asRecord(value);
  // SAFETY: JSON-parsed objects only contain JSON values, a subset of DecoderMetadataValue.
  return record ? (record as DecoderMetadataRecord) : {};
}

function parseArgs(raw: unknown): DecoderMetadataRecord {
  if (typeof raw !== "string") return toMetadata(raw);
  try {
    return toMetadata(JSON.parse(raw));
  } catch {
    return { raw };
  }
}

/**
 * Classifies a `tool_batch.effect.terminal` outcome. Only an explicit completion counts as
 * success; cancellation (the effect may have partially applied) and any unrecognised shape
 * are `unknown`.
 */
export function classifyMuseEffectOutcome(outcome: unknown): MuseToolOutcome {
  const record = asRecord(outcome);
  if (record?.kind !== "completed") return "unknown";
  const completion = asRecord(record.task_completion);
  if (completion?.kind === "complete") return "succeeded";
  if (completion?.kind === "terminal") {
    const terminal = asRecord(completion.terminal)?.kind;
    if (terminal === "completed") return "succeeded";
    if (terminal === "failed") return "failed";
  }
  return "unknown";
}

function elapsedMs(from: string, to: string): number {
  const elapsed = Date.parse(to) - Date.parse(from);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * Decodes muse `session.jsonl` records (the inner records of retained frames included) into
 * intermediate session events. State is kept per session id: tool calls are joined to their
 * effect outcomes and results, and each model call's usage is attached exactly once.
 */
export class MuseRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = MUSE_HARNESS_ID;
  readonly decoderVersion = MUSE_DECODER_VERSION;
  private readonly sessions = new Map<string, SessionState>();

  canDecode(record: RawHarnessRecord): boolean {
    if (record.harnessId !== this.harnessId) return false;
    const payload = asRecord(record.rawPayload);
    // A retained marker stands in for an ephemeral live-only record the log omitted; it decodes
    // to nothing rather than falling through to a generic passthrough.
    return (
      typeof payload?.payload_type === "string" || typeof payload?.retained_marker === "string"
    );
  }

  decode(record: RawHarnessRecord, context?: RecordDecoderContext): IntermediateSessionEvent[] {
    const raw = asRecord(record.rawPayload);
    if (!raw) return [];
    const sessionId = record.sessionId || context?.sessionId || "";
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        calls: new Map(),
        effectIdToCallId: new Map(),
        outcomes: new Map(),
        patches: new Map(),
        mcpTools: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    const timestamp = museRecordTimestamp(raw, record.timestamp);
    const nativeId = asString(raw.id) ?? record.recordId;
    const events = this.decodeRecord(raw, state, sessionId, timestamp);
    return events.map((event, index) => ({
      ...event,
      eventId: event.eventId ?? `muse_${nativeId}_${index}`,
      schemaVersion: "1.0.0",
      // Several events decoded from one record are distinct steps of that record.
      causalRef: {
        causalSequence: record.sequenceNumber,
        predecessorIds: [],
        ...(index > 0 ? { stepIndex: index } : {}),
      },
    }));
  }

  private decodeRecord(
    raw: Json,
    state: SessionState,
    sessionId: string,
    timestamp: string,
  ): IntermediateSessionEvent[] {
    const payloadType = asString(raw.payload_type) ?? "";
    const payload = asRecord(raw.payload) ?? {};
    const body = asRecord(payload.record);
    const base = { sessionId, timestamp };

    switch (payloadType) {
      case "runtime.session.metadata":
      case "run.model.configured":
        state.model = asString(body?.model_id) ?? state.model;
        return [];
      case "session.opened.observed":
        state.ended = false;
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: body?.resume === true ? "resume" : "start",
            harnessName: MUSE_HARNESS_ID,
          },
        ];
      case "session.resumed":
        state.ended = false;
        return [
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "resume",
            harnessName: MUSE_HARNESS_ID,
          },
        ];
      case "session.end":
        if (state.ended) return this.flushUsage(state, base);
        state.ended = true;
        return [
          ...this.flushUsage(state, base),
          {
            ...base,
            type: "session_lifecycle",
            lifecycleType: "end",
            harnessName: MUSE_HARNESS_ID,
            ...(asString(body?.exit_reason) ? { exitReason: asString(body?.exit_reason) } : {}),
          },
        ];
      case "runtime.mcp_tool_identity_catalog":
        return this.decodeToolCatalog(payload, state, base);
      case "tool_batch.effect.started": {
        const callId = asString(body?.call_id);
        const effectId = asString(body?.effect_id);
        if (callId && effectId) state.effectIdToCallId.set(effectId, callId);
        return [];
      }
      case "tool_batch.effect.terminal": {
        const callId = asString(body?.call_id);
        if (callId) state.outcomes.set(callId, classifyMuseEffectOutcome(body?.outcome));
        return [];
      }
      case "subagent.control.child_session_bound": {
        const child = asString(body?.child_session_id);
        if (!child) return [];
        return [
          {
            ...base,
            type: "subagent_lifecycle",
            subagentId: child,
            lifecycleType: "spawn",
            parentId: sessionId,
            role: "subagent",
            metadata: { museSubagentId: asString(body?.subagent_id) ?? null },
          },
        ];
      }
      case "subagent.control.result_ready": {
        const subagentId = asString(body?.subagent_id);
        if (!subagentId) return [];
        const errorKind = asString(body?.error_kind);
        return [
          {
            ...base,
            type: "subagent_lifecycle",
            subagentId,
            lifecycleType: errorKind ? "terminate" : "settle",
            parentId: sessionId,
            role: "subagent",
            ...(errorKind ? { reason: errorKind } : {}),
          },
        ];
      }
      case "runtime.session":
        return this.decodeRuntimeEvent(asRecord(payload.event), state, sessionId, base);
      default:
        return [];
    }
  }

  private decodeToolCatalog(
    payload: Json,
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    const tools: DiscoveredToolEntry[] = [];
    for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
      const item = asRecord(entry);
      const canonical = asString(item?.canonical_id);
      const server = asString(item?.server_name);
      const tool = asString(item?.raw_tool_name);
      if (!canonical || !server || !tool) continue;
      state.mcpTools.set(canonical, { server, tool });
      tools.push({ name: tool, provider: server });
    }
    return tools.length > 0 ? [{ ...base, type: "tool_discovery", tools, source: "mcp" }] : [];
  }

  private decodeRuntimeEvent(
    event: Json | undefined,
    state: SessionState,
    sessionId: string,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    if (!event) return [];
    switch (event.kind) {
      case "started": {
        const prompt = asString(event.prompt);
        return prompt ? [{ ...base, type: "message", role: "user", content: prompt }] : [];
      }
      case "model_completed":
        return this.recordUsage(event, state, base);
      case "assistant_message_committed": {
        const text = typeof event.text === "string" ? event.text : "";
        return [
          {
            ...base,
            type: "message",
            role: "assistant",
            content: text,
            ...(state.model ? { model: state.model } : {}),
            ...this.takeUsage(state),
          },
        ];
      }
      case "assistant_tool_calls_committed":
        return this.decodeToolCalls(event, state, base);
      case "tool_result_batch_committed":
        return this.decodeToolResults(event, state, base);
      case "tool_output_ref":
        this.recordPatch(event, state);
        return [];
      case "rejected": {
        // A call muse refused before running (unknown tool, bad arguments) had no side effect.
        const callId = asString(asRecord(event.origin)?.tool_call_id);
        if (callId) state.outcomes.set(callId, "failed");
        return [];
      }
      case "memory_reminder_child_session_linked": {
        const child = asString(event.child_session_id);
        if (!child) return [];
        const agent = asString(event.reminder_agent_id);
        return [
          {
            ...base,
            type: "subagent_lifecycle",
            subagentId: child,
            lifecycleType: "spawn",
            parentId: sessionId,
            role: agent ? `observer:${agent}` : "observer",
          },
        ];
      }
      case "terminal": {
        const flushed = this.flushUsage(state, base);
        if (event.terminal === "completed") {
          // A completed run settles the session; subagent and observer logs end here, without
          // the `session.end` the lead log writes afterwards.
          state.ended = true;
          return [
            ...flushed,
            {
              ...base,
              type: "session_lifecycle",
              lifecycleType: "end",
              exitReason: "completed",
              harnessName: MUSE_HARNESS_ID,
            },
          ];
        }
        if (event.terminal !== "failed") return flushed;
        return [
          ...flushed,
          {
            ...base,
            type: "error",
            errorType: "run_failed",
            message: asString(event.reason) ?? "muse run failed",
            recoverable: true,
          },
        ];
      }
      default:
        return [];
    }
  }

  private recordUsage(
    event: Json,
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    const usage = asRecord(event.usage);
    // A model call whose usage was never claimed by an assistant commit is still counted.
    const flushed = this.flushUsage(state, base);
    if (!usage) return flushed;
    const inputTokens = asCount(usage.input_tokens);
    const outputTokens = asCount(usage.output_tokens);
    const model = asString(event.model) ?? state.model;
    state.pendingUsage = {
      provider: "meta",
      ...(model ? { model } : {}),
      accountingVersion: MUSE_ACCOUNTING_VERSION,
      availability:
        inputTokens !== undefined && outputTokens !== undefined ? "complete" : "partial",
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      reasoningTokens: asCount(usage.reasoning_tokens) ?? null,
      cachedInputTokens: asCount(usage.cached_tokens) ?? asCount(usage.cache_read_tokens) ?? null,
      // Responses-API accounting: input includes cached tokens, output includes reasoning.
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : null,
      costProvenance: "unpriced",
      durationMs: asCount(event.duration_ms) ?? null,
    };
    return flushed;
  }

  private takeUsage(state: SessionState): { providerUsage?: ProviderReportedUsage } {
    const usage = state.pendingUsage;
    state.pendingUsage = undefined;
    return usage ? { providerUsage: usage } : {};
  }

  private flushUsage(
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    const { providerUsage } = this.takeUsage(state);
    if (!providerUsage) return [];
    return [
      {
        ...base,
        type: "unknown_passthrough",
        rawEventType: "muse.model_completed",
        rawPayload: {},
        providerUsage,
      },
    ];
  }

  private resolveTool(
    name: string,
    state: SessionState,
  ): { toolName: string; connection?: string } {
    const known = state.mcpTools.get(name);
    if (known) return { toolName: known.tool, connection: known.server };
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    return match?.[1] && match[2]
      ? { toolName: match[2], connection: match[1] }
      : { toolName: name };
  }

  private decodeToolCalls(
    event: Json,
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    const events: IntermediateToolCallEvent[] = [];
    for (const entry of Array.isArray(event.tool_calls) ? event.tool_calls : []) {
      const call = asRecord(entry);
      const callId = asString(call?.call_id);
      const name = asString(call?.name);
      if (!callId || !name) continue;
      const { toolName, connection } = this.resolveTool(name, state);
      const parameters = parseArgs(call?.args);
      state.calls.set(callId, { toolName, connection, parameters, calledAt: base.timestamp });
      events.push({
        ...base,
        type: "tool_call",
        callId,
        toolCallId: callId,
        toolName,
        ...(connection ? { connection } : {}),
        parameters,
        ...(events.length === 0 ? this.takeUsage(state) : {}),
      });
    }
    return events;
  }

  private recordPatch(event: Json, state: SessionState): void {
    const ref = asRecord(event.output_ref);
    const id = asString(ref?.id);
    const summary = asRecord(ref?.patch_summary);
    if (ref?.kind !== "tool_patch" || !id || !summary) return;
    // Patch ids are `tool_patch-<effect-id>-<call-id>`.
    for (const [effectId, callId] of state.effectIdToCallId) {
      if (!id.startsWith(`tool_patch-${effectId}-`)) continue;
      state.patches.set(callId, {
        added: asCount(summary.added),
        removed: asCount(summary.removed),
      });
      return;
    }
  }

  private decodeToolResults(
    event: Json,
    state: SessionState,
    base: { sessionId: string; timestamp: string },
  ): IntermediateSessionEvent[] {
    const events: IntermediateSessionEvent[] = [];
    for (const entry of Array.isArray(event.results) ? event.results : []) {
      const result = asRecord(entry);
      const callId = asString(result?.tool_call_id);
      if (!callId) continue;
      const text = typeof result?.text === "string" ? result.text : "";
      const call = state.calls.get(callId);
      const outcome: MuseToolOutcome | undefined = text.startsWith(UNKNOWN_OUTCOME_PREFIX)
        ? "unknown"
        : state.outcomes.get(callId);
      const executionDurationMs = call ? elapsedMs(call.calledAt, base.timestamp) : 0;
      events.push({
        ...base,
        type: "tool_result",
        callId,
        toolCallId: callId,
        ...(call ? { toolName: call.toolName } : {}),
        result: text,
        isError: outcome !== "succeeded",
        executionDurationMs,
        metadata: {
          museOutcome: outcome ?? "unknown",
          ...(call?.connection ? { connection: call.connection } : {}),
        },
      });
      if (!call || outcome === undefined || outcome === "unknown") continue;
      if (call.toolName === "bash" && !call.connection) {
        const exec = this.decodeShellResult(text, call);
        if (exec) events.push({ ...base, ...exec, durationMs: executionDurationMs });
      }
      const operation = FILE_WRITE_TOOLS[call.toolName];
      const filePath = asString(call.parameters.path);
      if (operation && filePath && outcome === "succeeded" && !call.connection) {
        const patch = state.patches.get(callId);
        events.push({
          ...base,
          type: "file_edit",
          filePath,
          operation,
          ...(patch?.added !== undefined ? { linesAdded: patch.added } : {}),
          ...(patch?.removed !== undefined ? { linesRemoved: patch.removed } : {}),
          metadata: { callId },
        });
      }
    }
    return events;
  }

  private decodeShellResult(
    text: string,
    call: CallState,
  ): Omit<
    Extract<IntermediateSessionEvent, { type: "command_exec" }>,
    "sessionId" | "timestamp"
  > | null {
    let parsed: Json | undefined;
    try {
      parsed = asRecord(JSON.parse(text));
    } catch {
      return null;
    }
    const exitCode = parsed?.exit_code;
    const command = asString(parsed?.command) ?? asString(call.parameters.command);
    if (!command || typeof exitCode !== "number") return null;
    return {
      type: "command_exec",
      command,
      exitCode,
      ...(typeof parsed?.output === "string" ? { stdout: parsed.output } : {}),
      ...(asString(call.parameters.workdir) ? { cwd: asString(call.parameters.workdir) } : {}),
    };
  }
}

export function createMuseRecordDecoder(): MuseRecordDecoder {
  return new MuseRecordDecoder();
}
