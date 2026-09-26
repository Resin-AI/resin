import type { DiscoveredToolEntry, ProviderReportedUsage } from "@resin/contracts";
import { ProviderReportedUsageSchema } from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  DecoderMetadataValue,
  HarnessRecordDecoder,
  IntermediateSessionEvent,
  RawHarnessRecord,
} from "@resin/harness-contracts";
import { parsePiMcpToolName } from "./extension.js";
import { piSessionIdFromPath, toPiSessionId } from "./discovery.js";
import { PI_HARNESS_ID } from "./paths.js";

export const PI_ACCOUNTING_VERSION = "pi-v1";
const SCHEMA_VERSION = "1.0.0";
/** Events one entry may produce before the next entry's causal sequence range starts. */
const EVENTS_PER_RECORD = 64;

type Json = DecoderMetadataValue;
type JsonRecord = DecoderMetadataRecord;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Converts a parsed JSON value into the decoder's metadata value space. */
function toJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJson(entry);
    return out;
  }
  return null;
}

/** Text of a Pi `string | (TextContent | ImageContent)[]` content value. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" ? (str(part.text) ?? "") : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Maps Pi's usage `{ input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost }`.
 * `input` excludes cache reads, `reasoning` is already part of `output`, and `cost` is Pi's own
 * estimate from its model catalog, not provider billing.
 */
export function piProviderUsage(
  usage: unknown,
  provider: string | undefined,
  model: string | undefined,
): ProviderReportedUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const totalTokens = nonNegativeInt(usage.totalTokens);
  const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
  const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  const candidate: ProviderReportedUsage = {
    provider: provider || PI_HARNESS_ID,
    accountingVersion: PI_ACCOUNTING_VERSION,
    availability: totalTokens === undefined ? "partial" : "complete",
    costProvenance: costUsd === undefined ? "unpriced" : "harness_estimate",
    ...(model ? { model } : {}),
    ...(nonNegativeInt(usage.input) === undefined ? {} : { inputTokens: nonNegativeInt(usage.input) }),
    ...(nonNegativeInt(usage.output) === undefined
      ? {}
      : { outputTokens: nonNegativeInt(usage.output) }),
    ...(nonNegativeInt(usage.reasoning) === undefined
      ? {}
      : { reasoningTokens: nonNegativeInt(usage.reasoning) }),
    ...(nonNegativeInt(usage.cacheRead) === undefined
      ? {}
      : { cachedInputTokens: nonNegativeInt(usage.cacheRead) }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costMicroUsd: Math.round(costUsd * 1_000_000) }),
  };
  const parsed = ProviderReportedUsageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Unified-diff-like text for Pi `edit` arguments `{ path, edits: [{ oldText, newText }] }`. */
function editDiff(filePath: string, edits: unknown): { diff: string; added: number; removed: number } {
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  let added = 0;
  let removed = 0;
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!isRecord(edit)) continue;
    const oldLines = (str(edit.oldText) ?? "").split("\n");
    const newLines = (str(edit.newText) ?? "").split("\n");
    lines.push("@@");
    for (const line of oldLines) lines.push(`-${line}`);
    for (const line of newLines) lines.push(`+${line}`);
    removed += oldLines.length;
    added += newLines.length;
  }
  return { diff: lines.join("\n"), added, removed };
}

/**
 * Resin call id for a Pi tool call id. Pi keeps provider ids verbatim (OpenAI Responses ids look
 * like `call_…|fc_…`), and Resin identifiers allow only `[A-Za-z0-9_.:-]`, so other characters
 * become `_`; the original id stays in `toolCallId`.
 */
export function piCallId(toolCallId: string): string {
  const sanitized = toolCallId.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const safe = /^[a-zA-Z0-9_-]/.test(sanitized) ? sanitized : `_${sanitized}`;
  return safe.length > 0 ? safe.slice(0, 128) : "_";
}

/** Exit code of a Pi `bash` tool result, from the status line Pi appends on failure. */
function bashExitCode(output: string, isError: boolean): number {
  if (!isError) return 0;
  const exited = /Command exited with code (\d+)\s*$/.exec(output);
  if (exited) return Number(exited[1]);
  // Aborted or signal-terminated commands have no exit code; use the shell's SIGINT convention.
  return /Command (aborted|terminated without an exit code)\s*$/.test(output) ? 130 : 1;
}

interface EntryContext {
  sessionId: string;
  timestamp: string;
  metadata: JsonRecord;
  nextSequence: () => number;
}

/**
 * Stateless decoder for Pi session JSONL entries (format versions 1–3). Everything a record
 * needs arrives on the record: {@link PiSessionEventSource} synthesizes v1 tree ids and attaches
 * the previously appended entry, the call each tool result answers, and the fork boundary, so
 * decoding resumes correctly from any cursor.
 *
 * Tree semantics: Pi appends every entry, so file order is chronological and each branch's
 * entries are contiguous. An entry whose `parentId` is not the previous entry starts a new
 * branch (a `/tree` rewind); it is announced with a `branch_fork` before its own events, so calls
 * from abandoned and new branches never interleave.
 */
export class PiRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = PI_HARNESS_ID;
  readonly decoderVersion = "1.0.0";

  canDecode(record: RawHarnessRecord): boolean {
    return record.harnessId === PI_HARNESS_ID && isRecord(record.rawPayload);
  }

  decode(record: RawHarnessRecord): IntermediateSessionEvent[] | null {
    const entry = record.rawPayload;
    if (!isRecord(entry)) return null;
    let sequence = record.sequenceNumber * EVENTS_PER_RECORD;
    const entryId = str(entry.id);
    const parentId = entry.parentId === null ? null : str(entry.parentId);
    const recordMeta = isRecord(record.metadata) ? record.metadata : {};
    const previousEntryId = str(recordMeta.piPreviousEntryId) ?? null;
    const ctx: EntryContext = {
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      metadata: {
        piEntryType: str(entry.type) ?? "unknown",
        ...(entryId ? { piEntryId: entryId } : {}),
        ...(parentId !== undefined ? { piParentEntryId: parentId } : {}),
        ...(typeof recordMeta.lineNumber === "number" ? { lineNumber: recordMeta.lineNumber } : {}),
      },
      nextSequence: () => sequence++,
    };

    const events: IntermediateSessionEvent[] = [];
    const parentSessionPath = str(recordMeta.piParentSessionPath);
    if (parentSessionPath) {
      const parentFileId = piSessionIdFromPath(parentSessionPath);
      events.push({
        ...this.base(ctx, { parentSessionPath }),
        type: "branch_fork",
        forkReason: "session_fork",
        sourceSessionId: parentFileId ? toPiSessionId(parentFileId) : ctx.sessionId,
        branchPointEventId: str(recordMeta.piForkedFromEntryId) ?? "root",
      });
    }
    const isBranch =
      entry.type !== "session" &&
      entry.type !== "branch_summary" &&
      previousEntryId !== null &&
      parentId !== undefined &&
      parentId !== previousEntryId;
    if (isBranch) {
      events.push({
        ...this.base(ctx, { abandonedLeafEntryId: previousEntryId }),
        type: "branch_fork",
        forkReason: "tree_navigation",
        sourceSessionId: ctx.sessionId,
        branchPointEventId: parentId ?? "root",
        parentBranchId: previousEntryId,
      });
    }
    events.push(...this.decodeEntry(entry, ctx, recordMeta));
    return events.length > 0 ? events : null;
  }

  private base(ctx: EntryContext, extra: JsonRecord = {}) {
    return {
      sessionId: ctx.sessionId,
      timestamp: ctx.timestamp,
      schemaVersion: SCHEMA_VERSION,
      causalRef: { causalSequence: ctx.nextSequence() },
      metadata: { ...ctx.metadata, ...extra },
    };
  }

  private decodeEntry(
    entry: JsonRecord,
    ctx: EntryContext,
    recordMeta: JsonRecord,
  ): IntermediateSessionEvent[] {
    switch (entry.type) {
      case "session":
        return [
          {
            ...this.base(ctx, {
              sessionFormatVersion: typeof entry.version === "number" ? entry.version : 1,
              ...(str(entry.cwd) ? { cwd: str(entry.cwd) } : {}),
              ...(str(entry.parentSession) ? { parentSessionPath: str(entry.parentSession) } : {}),
            }),
            type: "session_lifecycle",
            lifecycleType: "start",
            harnessName: PI_HARNESS_ID,
          },
        ];
      case "message":
        return isRecord(entry.message) ? this.decodeMessage(entry.message, ctx, recordMeta) : [];
      case "compaction":
        return [
          {
            ...this.base(ctx, {
              ...(str(entry.firstKeptEntryId)
                ? { firstKeptEntryId: str(entry.firstKeptEntryId) }
                : {}),
              fromHook: entry.fromHook === true,
              // Pi records the context size before compaction only.
              tokensAfterUnknown: true,
              ...(entry.details === undefined ? {} : { details: toJson(entry.details) }),
            }),
            type: "compaction",
            triggerReason: "context_limit",
            tokensBefore: nonNegativeInt(entry.tokensBefore) ?? 0,
            tokensAfter: 0,
            ...(str(entry.summary) === undefined
              ? {}
              : { preservedContextSummary: str(entry.summary) }),
            ...this.usageField(entry.usage, undefined, undefined),
          },
        ];
      case "branch_summary":
        return [
          {
            ...this.base(ctx, {
              ...(str(entry.fromId) ? { abandonedLeafEntryId: str(entry.fromId) } : {}),
              ...(str(entry.summary) === undefined ? {} : { summary: str(entry.summary) }),
            }),
            type: "branch_fork",
            forkReason: "tree_navigation_summary",
            sourceSessionId: ctx.sessionId,
            branchPointEventId: str(entry.parentId) ?? "root",
            ...(str(entry.fromId) ? { parentBranchId: str(entry.fromId) } : {}),
            ...this.usageField(entry.usage, undefined, undefined),
          },
        ];
      case "custom_message":
        return [
          {
            ...this.base(ctx, { customType: str(entry.customType) ?? null }),
            type: "message",
            role: "user",
            content: contentText(entry.content),
          },
        ];
      case "usage":
        return [
          {
            ...this.base(ctx, { usageKind: str(entry.kind) ?? "unknown" }),
            type: "unknown_passthrough",
            rawEventType: "usage",
            rawPayload: { kind: str(entry.kind) ?? null },
            ...this.usageField(entry.usage, str(entry.provider), str(entry.model)),
          },
        ];
      case "model_change":
      case "thinking_level_change":
      case "context_edit":
      case "session_info": {
        const { type: rawType, id: _id, parentId: _parent, timestamp: _ts, ...payload } = entry;
        return [
          {
            ...this.base(ctx),
            type: "unknown_passthrough",
            rawEventType: String(rawType),
            rawPayload: payload,
          },
        ];
      }
      default:
        // `custom` (extension state) and `label` do not reach the model; unknown types are
        // future additions Pi's own readers also ignore.
        return [];
    }
  }

  private usageField(
    usage: unknown,
    provider: string | undefined,
    model: string | undefined,
  ): { providerUsage?: ProviderReportedUsage } {
    const providerUsage = piProviderUsage(usage, provider, model);
    return providerUsage ? { providerUsage } : {};
  }

  private decodeMessage(
    message: JsonRecord,
    ctx: EntryContext,
    recordMeta: JsonRecord,
  ): IntermediateSessionEvent[] {
    switch (message.role) {
      case "system":
        return this.decodeSystem(message, ctx);
      case "user":
        return [
          { ...this.base(ctx), type: "message", role: "user", content: contentText(message.content) },
        ];
      case "assistant":
        return this.decodeAssistant(message, ctx);
      case "toolResult":
        return this.decodeToolResult(message, ctx, recordMeta);
      case "bashExecution": {
        const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
        return [
          {
            ...this.base(ctx, {
              userShell: true,
              cancelled: message.cancelled === true,
              excludeFromContext: message.excludeFromContext === true,
              ...(exitCode === undefined ? { exitCodeUnknown: true } : {}),
            }),
            type: "command_exec",
            command: str(message.command) ?? "",
            ...(str(message.output) === undefined ? {} : { stdout: str(message.output) }),
            exitCode: exitCode ?? (message.cancelled === true ? 130 : 1),
            // Pi does not record how long user shell commands ran.
            durationMs: 0,
          },
        ];
      }
      // v2 files may still carry the pre-v3 `hookMessage` role; Pi renames it to `custom`.
      case "custom":
      case "hookMessage":
        return [
          {
            ...this.base(ctx, { customType: str(message.customType) ?? null }),
            type: "message",
            role: "user",
            content: contentText(message.content),
          },
        ];
      default:
        return [];
    }
  }

  private decodeSystem(message: JsonRecord, ctx: EntryContext): IntermediateSessionEvent[] {
    const added = Array.isArray(message.toolsAdded) ? message.toolsAdded : [];
    const removed = Array.isArray(message.toolsRemoved)
      ? message.toolsRemoved.flatMap((tool) =>
          isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
        )
      : [];
    const tools: DiscoveredToolEntry[] = added.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) return [];
      const mcp = parsePiMcpToolName(tool.name);
      return [
        {
          name: tool.name,
          ...(str(tool.description) === undefined ? {} : { description: str(tool.description) }),
          ...(isRecord(tool.parameters) ? { inputSchema: tool.parameters } : {}),
          ...(mcp ? { provider: mcp.server } : {}),
        },
      ];
    });
    if (tools.length === 0 && removed.length === 0) return [];
    return [
      {
        ...this.base(ctx, {
          ...(removed.length > 0 ? { toolsRemoved: removed } : {}),
          replace: message.replace === true,
        }),
        type: "tool_discovery",
        tools,
        source: "harness",
      },
    ];
  }

  private decodeAssistant(message: JsonRecord, ctx: EntryContext): IntermediateSessionEvent[] {
    const model = str(message.model);
    const provider = str(message.provider);
    const events: IntermediateSessionEvent[] = [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!isRecord(part)) continue;
      if (part.type === "text") {
        events.push({
          ...this.base(ctx),
          type: "message",
          role: "assistant",
          content: str(part.text) ?? "",
          ...(model ? { model } : {}),
        });
      } else if (part.type === "thinking") {
        events.push({
          ...this.base(ctx),
          type: "model_reasoning",
          reasoningContent: str(part.thinking) ?? "",
          visibility: "visible",
          redacted: part.redacted === true,
          ...(model ? { model } : {}),
        });
      } else if (part.type === "toolCall") {
        const toolCallId = str(part.id) ?? "";
        const toolName = str(part.name) || "unknown";
        const mcp = parsePiMcpToolName(toolName);
        events.push({
          ...this.base(ctx, { toolCallId }),
          type: "tool_call",
          callId: piCallId(toolCallId),
          toolCallId,
          toolName,
          parameters: isRecord(part.arguments) ? part.arguments : {},
          ...(mcp ? { connection: mcp.server } : {}),
        });
      }
    }
    const stopReason = str(message.stopReason);
    if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
      events.push({
        ...this.base(ctx),
        type: "error",
        errorType: stopReason === "length" ? "max_tokens" : stopReason,
        message: str(message.errorMessage) ?? stopReason,
        recoverable: true,
      });
    }
    const providerUsage = piProviderUsage(message.usage, provider, model);
    const usageTarget =
      events.find((event) => event.type === "message") ??
      events.find((event) => event.type === "model_reasoning") ??
      events.find((event) => event.type === "tool_call") ??
      events[0];
    if (providerUsage && usageTarget) usageTarget.providerUsage = providerUsage;
    for (const event of events) {
      event.metadata = {
        ...event.metadata,
        ...(stopReason ? { stopReason } : {}),
        ...(provider ? { provider } : {}),
      };
    }
    return events;
  }

  /**
   * A tool result, plus the side effect it confirms: `bash` becomes a `command_exec` with the
   * real exit status, and a successful `edit`/`write` becomes a `file_edit`. The call arguments
   * come from the source, which saw the call earlier in the file.
   */
  private decodeToolResult(
    message: JsonRecord,
    ctx: EntryContext,
    recordMeta: JsonRecord,
  ): IntermediateSessionEvent[] {
    const output = contentText(message.content);
    const toolCallId = str(message.toolCallId) ?? "";
    const call = isRecord(recordMeta.piToolCall) ? recordMeta.piToolCall : undefined;
    const toolName = str(message.toolName) || str(call?.name) || "unknown";
    const details = isRecord(message.details) ? message.details : undefined;
    const isError = message.isError === true;
    const startedAt = Date.parse(str(call?.startedAt) ?? "");
    const durationMs = Math.max(0, Date.parse(ctx.timestamp) - startedAt) || 0;
    const args = isRecord(call?.arguments) ? call.arguments : undefined;

    const events: IntermediateSessionEvent[] = [
      {
        ...this.base(ctx, {
          toolCallId,
          ...(Number.isFinite(startedAt) ? {} : { executionDurationUnknown: true }),
          ...(details?.mcpServer ? { mcpServer: toJson(details.mcpServer) } : {}),
          ...(details?.mcpTool ? { mcpTool: toJson(details.mcpTool) } : {}),
        }),
        type: "tool_result",
        callId: piCallId(toolCallId),
        toolCallId,
        toolName,
        result: output,
        isError,
        ...(isError ? { error: output } : {}),
        executionDurationMs: durationMs,
        outputSizeBytes: Buffer.byteLength(output, "utf8"),
        ...this.usageField(message.usage, undefined, undefined),
      },
    ];

    const filePath = str(args?.path);
    if (toolName === "bash" && args && str(args.command) !== undefined) {
      events.push({
        ...this.base(ctx, { toolCallId }),
        type: "command_exec",
        command: str(args.command) ?? "",
        stdout: output,
        exitCode: bashExitCode(output, isError),
        durationMs,
      });
    } else if (toolName === "edit" && filePath && !isError) {
      const constructed = editDiff(filePath, args?.edits);
      const piDiff = str(details?.diff);
      events.push({
        ...this.base(ctx, { toolCallId }),
        type: "file_edit",
        filePath,
        operation: "update",
        patch: piDiff ?? constructed.diff,
        diffStats: { linesAdded: constructed.added, linesRemoved: constructed.removed },
      });
    } else if (toolName === "write" && filePath && !isError) {
      const content = str(args?.content) ?? "";
      events.push({
        ...this.base(ctx, { toolCallId, bytesWritten: Buffer.byteLength(content, "utf8") }),
        type: "file_edit",
        filePath,
        operation: "create",
        diffStats: {
          linesAdded: content.length === 0 ? 0 : content.split("\n").length,
          linesRemoved: 0,
        },
      });
    }
    return events;
  }
}
