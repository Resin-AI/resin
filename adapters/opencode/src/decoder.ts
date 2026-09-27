import {
  type ProviderReportedUsage,
  RESIN_ASSISTANT_STOP_REASON_METADATA_KEY,
} from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { OPENCODE_HARNESS_ID, type OpencodeRecordPayload } from "./source.js";
import type { OpencodeMessageInfo, OpencodePart } from "./store.js";

export const OPENCODE_DECODER_VERSION = "1.0.0";
export const OPENCODE_ACCOUNTING_VERSION = "opencode-message-tokens-v1";

/**
 * Built-in OpenCode tools. Any other tool name is `<mcpServer>_<tool>` (OpenCode joins the
 * sanitized server key and tool name with `_`) or a plugin/custom tool.
 */
export const OPENCODE_BUILTIN_TOOLS: readonly string[] = [
  "bash",
  "read",
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
  "glob",
  "grep",
  "list",
  "task",
  "webfetch",
  "websearch",
  "codesearch",
  "todowrite",
  "todoread",
  "skill",
  "question",
  "lsp",
  "invalid",
  "plan_enter",
  "plan_exit",
];

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function iso(value: unknown, fallback: string): string {
  return typeof value === "number" && value > 0 ? new Date(value).toISOString() : fallback;
}

function isPayload(value: unknown): value is OpencodeRecordPayload {
  const kind = obj(value)?.kind;
  return (
    kind === "session" ||
    kind === "user_text" ||
    kind === "assistant_message" ||
    kind === "reasoning" ||
    kind === "tool_call" ||
    kind === "tool_result" ||
    kind === "compaction"
  );
}

/**
 * Provider usage for one finished assistant message. OpenCode records one model step per
 * assistant message; `tokens.input` excludes cache reads, `tokens.total` is the provider total.
 */
export function extractOpencodeUsage(
  message: OpencodeMessageInfo,
): ProviderReportedUsage | undefined {
  const tokens = obj(message.tokens);
  if (!tokens) return undefined;
  const cache = obj(tokens.cache);
  const input = int(tokens.input);
  const output = int(tokens.output);
  const reasoning = int(tokens.reasoning);
  const cacheRead = int(cache?.read);
  const total = int(tokens.total);
  if ([input, output, reasoning, cacheRead, total].every((value) => value === undefined)) {
    return undefined;
  }
  const usage: ProviderReportedUsage = {
    provider: str(message.providerID) ?? "opencode",
    accountingVersion: OPENCODE_ACCOUNTING_VERSION,
    availability: total !== undefined ? "complete" : "partial",
  };
  const model = str(message.modelID);
  if (model) usage.model = model;
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (cacheRead !== undefined) usage.cachedInputTokens = cacheRead;
  if (total !== undefined) usage.totalTokens = total;
  const cost = typeof message.cost === "number" && message.cost >= 0 ? message.cost : undefined;
  if (cost !== undefined) {
    usage.costMicroUsd = Math.round(cost * 1_000_000);
    usage.costProvenance = "harness_estimate";
  }
  const created = int(message.time?.created);
  const completed = int(message.time?.completed);
  if (created !== undefined && completed !== undefined && completed >= created) {
    usage.durationMs = completed - created;
  }
  return usage;
}

function toMetadata(value: unknown): DecoderMetadataRecord {
  // SAFETY: OpenCode tool inputs are JSON-decoded objects, a subset of DecoderMetadataRecord.
  return (obj(value) ?? {}) as DecoderMetadataRecord;
}

export interface OpencodeRecordDecoderOptions {
  /** MCP server keys from OpenCode's `mcp` config, used to attribute `<server>_<tool>` calls. */
  mcpServers?: readonly string[];
}

/** Decodes OpenCode source records into intermediate session events. */
export class OpencodeRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = OPENCODE_HARNESS_ID;
  readonly decoderVersion = OPENCODE_DECODER_VERSION;
  private readonly mcpServers: readonly string[];

  constructor(options?: OpencodeRecordDecoderOptions) {
    // Longest first so `resin_dev` wins over `resin` for `resin_dev_tool`.
    this.mcpServers = [...new Set(["resin", ...(options?.mcpServers ?? [])])]
      .map((name) => name.replace(/[^a-zA-Z0-9_-]/g, "_"))
      .sort((a, b) => b.length - a.length);
  }

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === OPENCODE_HARNESS_ID && isPayload(record.rawPayload);
  }

  /** MCP server that owns a tool name, if any. */
  resolveConnection(toolName: string): string | undefined {
    if (OPENCODE_BUILTIN_TOOLS.includes(toolName)) return undefined;
    return this.mcpServers.find((server) => toolName.startsWith(`${server}_`));
  }

  decode(record: RawHarnessRecord): IntermediateSessionEvent[] {
    if (!isPayload(record.rawPayload)) return [];
    const payload = record.rawPayload;
    const sessionId = record.sessionId;
    const fallbackTime = record.timestamp;
    switch (payload.kind) {
      case "session":
        return this.decodeSession(payload.session, sessionId, fallbackTime);
      case "user_text": {
        const text = str(payload.part.text) ?? "";
        return [
          {
            type: "message",
            sessionId,
            eventId: payload.part.id,
            timestamp: iso(payload.message.time?.created, fallbackTime),
            role: "user",
            content: text,
            metadata: {
              messageId: payload.message.id,
              agent: str(payload.message.agent),
              synthetic: payload.part.synthetic === true ? true : undefined,
            },
          },
        ];
      }
      case "reasoning":
        return [
          {
            type: "model_reasoning",
            sessionId,
            eventId: payload.part.id,
            timestamp: iso(obj(payload.part.time)?.end, fallbackTime),
            reasoningText: str(payload.part.text) ?? "",
            reasoningContent: str(payload.part.text) ?? "",
            visibility: "visible",
            model: str(payload.message.modelID),
            metadata: { messageId: payload.message.id },
          },
        ];
      case "assistant_message":
        return this.decodeAssistant(payload.message, payload.texts, sessionId, fallbackTime);
      case "compaction":
        return [
          {
            type: "compaction",
            sessionId,
            eventId: payload.part.id,
            timestamp: iso(payload.message.time?.created, fallbackTime),
            triggerReason: payload.part.auto === true ? "context_limit" : "manual",
            metadata: { messageId: payload.message.id },
          },
        ];
      case "tool_call":
        return this.decodeToolCall(payload.part, payload.message, sessionId, fallbackTime);
      case "tool_result":
        return this.decodeToolResult(
          payload.part,
          payload.callPart,
          payload.message,
          sessionId,
          fallbackTime,
        );
    }
  }

  private decodeSession(
    session: OpencodeMessageInfo | Obj,
    sessionId: string,
    fallbackTime: string,
  ): IntermediateSessionEvent[] {
    const info = session as Obj;
    const timestamp = iso(obj(info.time)?.created, fallbackTime);
    const parentId = str(info.parentID);
    const events: IntermediateSessionEvent[] = [
      {
        type: "session_lifecycle",
        sessionId,
        timestamp,
        lifecycleType: "start",
        harnessName: OPENCODE_HARNESS_ID,
        metadata: {
          directory: str(info.directory),
          title: str(info.title),
          harnessVersion: str(info.version),
          projectId: str(info.projectID),
          parentSessionId: parentId,
        },
      },
    ];
    if (parentId) {
      events.push({
        type: "subagent_lifecycle",
        sessionId,
        timestamp,
        subagentId: sessionId,
        parentId,
        lifecycleType: "start",
        role: str(info.agent),
      });
    }
    return events;
  }

  private decodeAssistant(
    message: OpencodeMessageInfo,
    texts: OpencodePart[],
    sessionId: string,
    fallbackTime: string,
  ): IntermediateSessionEvent[] {
    const timestamp = iso(message.time?.completed ?? message.time?.created, fallbackTime);
    const events: IntermediateSessionEvent[] = [];
    const content = texts
      .filter((part) => part.synthetic !== true)
      .map((part) => str(part.text) ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
    events.push({
      type: "message",
      sessionId,
      eventId: message.id,
      timestamp,
      role: "assistant",
      content,
      model: str(message.modelID),
      providerUsage: extractOpencodeUsage(message),
      parentEventId: str(message.parentID),
      metadata: {
        messageId: message.id,
        agent: str(message.agent),
        finish: str(message.finish),
        // OpenCode's finish reason ("stop", "tool-calls", ...) is the assistant stop reason.
        [RESIN_ASSISTANT_STOP_REASON_METADATA_KEY]: str(message.finish),
        compactionSummary: message.summary === true ? true : undefined,
      },
    });
    const error = obj(message.error);
    if (error) {
      const name = str(error.name) ?? "UnknownError";
      const message_ = str(obj(error.data)?.message) ?? name;
      events.push({
        type: "error",
        sessionId,
        timestamp,
        errorType: name,
        message: message_,
        recoverable: name === "MessageAbortedError",
        metadata: { messageId: message.id, aborted: name === "MessageAbortedError" },
      });
    }
    return events;
  }

  private decodeToolCall(
    part: OpencodePart,
    message: OpencodeMessageInfo,
    sessionId: string,
    fallbackTime: string,
  ): IntermediateSessionEvent[] {
    const tool = str(part.tool) ?? "unknown";
    const state = obj(part.state) ?? {};
    const input = toMetadata(state.input);
    const callId = str(part.callID) ?? part.id;
    const timestamp = iso(obj(state.time)?.start, fallbackTime);
    const events: IntermediateSessionEvent[] = [
      {
        type: "tool_call",
        sessionId,
        eventId: `${part.id}:call`,
        timestamp,
        toolCallId: callId,
        callId,
        toolName: tool,
        connection: this.resolveConnection(tool),
        input,
        parameters: input,
        metadata: { messageId: message.id, partId: part.id },
      },
    ];
    const childSession = str(obj(state.metadata)?.sessionId);
    if (tool === "task" && childSession) {
      events.push({
        type: "subagent_lifecycle",
        sessionId,
        timestamp,
        subagentId: childSession,
        parentId: sessionId,
        lifecycleType: "spawn",
        role: str(input.subagent_type),
        reason: str(input.description),
      });
    }
    return events;
  }

  private decodeToolResult(
    part: OpencodePart,
    callPart: OpencodePart,
    message: OpencodeMessageInfo,
    sessionId: string,
    fallbackTime: string,
  ): IntermediateSessionEvent[] {
    const tool = str(part.tool) ?? "unknown";
    const state = obj(part.state) ?? {};
    const metadata = obj(state.metadata) ?? {};
    const input = toMetadata(state.input);
    const callId = str(part.callID) ?? part.id;
    const time = obj(state.time);
    const start = int(time?.start);
    const end = int(time?.end);
    const timestamp = iso(end ?? start, fallbackTime);
    const durationMs =
      start !== undefined && end !== undefined && end >= start ? end - start : undefined;
    const toolFailed = state.status === "error";
    // A bash call that ran but exited non-zero failed; its tool result is the one record of that.
    const exitCode = tool === "bash" ? int(metadata.exit) : undefined;
    const commandFailed = !toolFailed && exitCode !== undefined && exitCode !== 0;
    const isError = toolFailed || commandFailed;
    const output = toolFailed ? undefined : str(state.output);
    const events: IntermediateSessionEvent[] = [
      {
        type: "tool_result",
        sessionId,
        eventId: `${part.id}:result`,
        timestamp,
        toolCallId: callId,
        callId,
        toolName: tool,
        result: output ?? null,
        output: output ?? null,
        isError,
        error: toolFailed
          ? (str(state.error) ?? "tool error")
          : commandFailed
            ? `exit code ${exitCode}`
            : undefined,
        durationMs,
        executionDurationMs: durationMs ?? 0,
        outputSizeBytes: output === undefined ? undefined : Buffer.byteLength(output, "utf8"),
        metadata: { messageId: message.id, partId: part.id, title: str(state.title) },
      },
    ];

    if (!isError && (tool === "edit" || tool === "write")) {
      const filePath = str(input.filePath) ?? str(metadata.filepath);
      if (filePath) {
        const filediff = obj(metadata.filediff);
        const additions = int(filediff?.additions);
        const deletions = int(filediff?.deletions);
        const created = tool === "write" && metadata.exists === false;
        events.push({
          type: "file_edit",
          sessionId,
          timestamp,
          filePath,
          operation: created ? "create" : "update",
          action: created ? "create" : "update",
          diff: str(metadata.diff),
          diffStats:
            additions !== undefined || deletions !== undefined
              ? { linesAdded: additions ?? 0, linesRemoved: deletions ?? 0 }
              : undefined,
          metadata: { toolCallId: callId },
        });
      }
    }

    const childSession = str(metadata.sessionId);
    if (tool === "task" && childSession) {
      if (!str(obj(obj(callPart.state)?.metadata)?.sessionId)) {
        events.push({
          type: "subagent_lifecycle",
          sessionId,
          timestamp: iso(start, timestamp),
          subagentId: childSession,
          parentId: sessionId,
          lifecycleType: "spawn",
          role: str(input.subagent_type),
          reason: str(input.description),
        });
      }
      events.push({
        type: "subagent_lifecycle",
        sessionId,
        timestamp,
        subagentId: childSession,
        parentId: sessionId,
        lifecycleType: isError ? "crash" : "end",
      });
    }
    return events;
  }
}
