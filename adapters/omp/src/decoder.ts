import {
  type DiscoveredToolEntry,
  type FileDiffStats,
  type MessageContentPart,
  type ProviderReportedUsage,
  ProviderReportedUsageSchema,
} from "@resin/contracts";
import type {
  DecoderMetadataRecord,
  DecoderMetadataValue,
  HarnessRecordDecoder,
  IntermediateBranchForkEvent,
  IntermediateCommandExecEvent,
  IntermediateCompactionEvent,
  IntermediateErrorEvent,
  IntermediateFileEditEvent,
  IntermediateMessageEvent,
  IntermediateModelReasoningEvent,
  IntermediateSessionEvent,
  IntermediateSessionLifecycleEvent,
  IntermediateSubagentLifecycleEvent,
  IntermediateToolCallEvent,
  IntermediateToolDiscoveryEvent,
  IntermediateToolResultEvent,
  IntermediateUnknownPassthroughEvent,
  RawHarnessRecord,
  RecordDecoderContext,
} from "@resin/harness-contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import {
  OMP_ASYNC_RESULT_CUSTOM_TYPE,
  type OmpJobCompletion,
  isOmpJobJoinCall,
  isOmpJobReportOnly,
  ompAsyncResultCompletions,
  ompBackgroundLaunchJobId,
  ompJobReportCompletions,
} from "./background-jobs.js";
import {
  OMP_DEVICE_SURFACE_PREFIX,
  OMP_DEVICE_SURFACE_READ_TOOL,
  OMP_DEVICE_SURFACE_WRITE_TOOL,
  type OmpDeviceSurfaceCall,
  resolveOmpDeviceSurfaceCall,
} from "./device-surface.js";
import { getOmpSessionExitReason } from "./session-exit.js";

export { getOmpSessionExitReason };

export const OMP_PROVIDER = "omp";
export const OMP_ACCOUNTING_VERSION = "omp-v1";

/** Local-only late arguments; the recorder consumes this and metadata projection always drops it. */
export const RESIN_LOCAL_OMP_NATIVE_CALL_KEY = "__resinLocalOmpNativeCallV1";

/**
 * URI schemes OMP's `read` tool resolves against the harness's own session or installation rather
 * than the workspace (OMP 18's internal URL handlers): `artifact://N` is the spill of an earlier tool
 * output too long to show inline; `history://`, `agent://`, `proc://` (`jobs://` before it) and
 * `attachment://` are this session's transcript, subagents, background jobs and attachments;
 * `local://` is session scratch space; `conflict://` is session-held merge state; `skill://`,
 * `rule://`, `memory://`, `omp://`, `cfg://` and `security://` are the harness's own context,
 * documentation, settings and findings.
 *
 * No later session can read the same value back from such a URI, so reading one is the agent paging
 * through context it already holds, never a step of the work: it is not recorded as a workflow call.
 * `xd://` is deliberately absent: a read of a device-surface path invokes the tool behind it (see
 * `device-surface.ts`) and keeps its own recording. Remote schemes (`pr://`, `issue://`, `mcp://`,
 * `ssh://`) and the file-backed `vault://` read data outside the session and are left as they are.
 */
export const OMP_HARNESS_INTERNAL_URI_SCHEMES = [
  "agent",
  "artifact",
  "attachment",
  "cfg",
  "conflict",
  "history",
  "jobs",
  "local",
  "memory",
  "omp",
  "proc",
  "rule",
  "security",
  "skill",
] as const;

/**
 * Whether `value` is a URI in one of {@link OMP_HARNESS_INTERNAL_URI_SCHEMES}, with or without a
 * read selector (`artifact://3:50-100`). The scheme is compared case-insensitively, as URL schemes
 * are; anything that is not a string, or names another scheme, is not harness-internal.
 */
export function isOmpHarnessInternalUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim())?.[1]?.toLowerCase();
  return (
    scheme !== undefined && (OMP_HARNESS_INTERNAL_URI_SCHEMES as readonly string[]).includes(scheme)
  );
}

/**
 * Whether a call is OMP's `read` of a harness-internal URI: the harness paging its own session
 * state, recorded neither as a call nor as its result.
 */
function isHarnessInternalRead(
  toolName: string | undefined,
  parameters: DecoderMetadataRecord | undefined,
): boolean {
  return toolName === OMP_DEVICE_SURFACE_READ_TOOL && isOmpHarnessInternalUri(parameters?.path);
}

function boundedNativeArguments(
  args: OmpTranscriptPayload | undefined,
): OmpTranscriptPayload | undefined {
  if (
    args === undefined ||
    typeof args.language !== "string" ||
    !["py", "python", "js", "javascript", "ts", "typescript"].includes(
      args.language.trim().toLowerCase(),
    ) ||
    typeof args.code !== "string" ||
    Buffer.byteLength(args.code, "utf8") > 65_536 ||
    (args.code.length === 0 && args.reset !== true)
  ) {
    return undefined;
  }
  return {
    language: args.language,
    code: args.code,
    ...(args.reset === true ? { reset: true } : {}),
  };
}

/** Decode the value returned by a confirmed MCP device-surface call. */
function deviceSurfaceResultValue(result: DecoderMetadataValue): DecoderMetadataValue {
  if (!Array.isArray(result) || result.length !== 1) return result;
  const part = asObject(result[0]);
  const text = asString(part?.text);
  if (part?.type !== "text" || text === undefined) return result;
  try {
    const parsed: DecoderMetadataValue = JSON.parse(text);
    return parsed;
  } catch {
    // A protocol tool that returned text returned these exact bytes, not normalized prose.
    return text;
  }
}

/** Recover target metadata from native edit syntax before content is redacted. */
function editTargetPaths(parameters: DecoderMetadataRecord): string[] {
  const input = asString(parameters.input) ?? asString(parameters.patch);
  if (!input) return [];
  const paths = new Set<string>();
  // Legacy replacement blocks put the path AFTER the closing replacement marker.
  for (const match of input.matchAll(/^>>>>\r?\npath:[ \t]*([^\r\n]+)(?:\r?\n|$)/gm)) {
    paths.add(match[1]!.trim());
  }
  if (input.startsWith("*** Begin Patch") && input.trimEnd().endsWith("*** End Patch")) {
    // Body rows are prefixed; never treat text inside a replacement as a target.
    for (const match of input.matchAll(/^\[([^\r\n#]+)#[0-9A-Fa-f]{4}\]\r?$/gm)) {
      paths.add(match[1]!.trim());
    }
    for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)\r?$/gm)) {
      paths.add(match[1]!.trim());
    }
  }
  return [...paths].filter(Boolean);
}
export type OmpTranscriptValue = DecoderMetadataValue;

export interface OmpTranscriptPayload extends DecoderMetadataRecord {
  [key: string]: OmpTranscriptValue;
}
export interface CausalRefInput {
  causalSequence: number;
  parentId?: string | null;
  rootId?: string | null;
  /** Disambiguates sibling events decoded from one source record; unset on the record's own event. */
  stepIndex?: number;
}

export function asString(value: OmpTranscriptValue | undefined | null): string | undefined {
  return value !== undefined && value !== null && String(value) === value ? value : undefined;
}
function normalizeCallId(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);
  if (/^[a-zA-Z0-9_-]/.test(normalized)) {
    return normalized;
  }
  return `_${normalized}`.slice(0, 128);
}

export function asNumber(value: OmpTranscriptValue | undefined | null): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value)
    ? Number(value)
    : undefined;
}

function isOmpTranscriptPayload(
  value: OmpTranscriptValue | undefined | null,
): value is OmpTranscriptPayload {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function asObject(
  value: OmpTranscriptValue | undefined | null,
): OmpTranscriptPayload | undefined {
  return isOmpTranscriptPayload(value) ? value : undefined;
}

export function asArray(
  value: OmpTranscriptValue | undefined | null,
): OmpTranscriptValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

const TOOL_CALL_BLOCK_TYPES: Record<string, true> = {
  toolcall: true,
  tool_call: true,
  tooluse: true,
  tool_use: true,
  function: true,
  function_call: true,
};

/** Source record that announced a session call: an assistant message or an execution record. */
type CallAnnouncementOrigin = "assistant_message" | "execution_record";

/** Assistant-embedded tool call request block, normalized without inventing identity or arguments. */
interface EmbeddedAssistantToolCall {
  rawCallId: string;
  toolName?: string;
  parameters?: OmpTranscriptPayload;
  /**
   * Ordinal among announce-valid blocks in this record, fixed before any deduplication, so retries
   * and re-ingests reproduce identical step indices regardless of which siblings were already seen.
   */
  stepIndex?: number;
}

/** Parses explicit tool arguments; absent, malformed, and non-object values are never invented. */
function parseToolArguments(
  value: OmpTranscriptValue | undefined | null,
): OmpTranscriptPayload | undefined {
  const direct = asObject(value);
  if (direct) return direct;
  const text = asString(value);
  if (text === undefined) return undefined;
  try {
    // SAFETY: JSON.parse returns an arbitrary JSON value before object normalization.
    return asObject(JSON.parse(text) as OmpTranscriptValue);
  } catch {
    return undefined;
  }
}

/**
 * Enumerates assistant-embedded tool call request blocks carried by content/parts/toolCalls arrays
 * and the singular toolCall/tool_call envelope. Blocks without an explicit call id are dropped:
 * a request identity is never invented for malformed or text-only content.
 */
function embeddedAssistantToolCalls(obj: OmpTranscriptPayload): EmbeddedAssistantToolCall[] {
  const nestedMsg = asObject(obj.message);
  const candidates: OmpTranscriptValue[] = [];
  const containers: Array<OmpTranscriptValue | undefined> = [
    obj.content,
    obj.parts,
    obj.toolCalls,
    obj.tool_calls,
    nestedMsg?.content,
    nestedMsg?.parts,
    nestedMsg?.toolCalls,
    nestedMsg?.tool_calls,
  ];
  for (const container of containers) {
    const arr = asArray(container);
    if (arr) candidates.push(...arr);
  }
  for (const single of [obj.toolCall, obj.tool_call, nestedMsg?.toolCall, nestedMsg?.tool_call]) {
    const block = asObject(single);
    if (block) candidates.push(block);
  }

  const calls: EmbeddedAssistantToolCall[] = [];
  let announceOrdinal = 0;
  for (const candidate of candidates) {
    const block = asObject(candidate);
    if (!block) continue;

    const rawCallId =
      asString(block.id) ??
      asString(block.callId) ??
      asString(block.call_id) ??
      asString(block.toolCallId) ??
      asString(block.tool_call_id);
    if (!rawCallId?.trim()) continue;

    const rawName =
      asString(block.name) ??
      asString(block.toolName) ??
      asString(block.tool_name) ??
      asString(block.tool);
    const toolName = rawName?.trim() && rawName !== "unknown_tool" ? rawName : undefined;
    const rawArgs =
      block.arguments ?? block.args ?? block.parameters ?? block.params ?? block.input;
    const blockType = asString(block.type)?.toLowerCase();
    const hasToolType = TOOL_CALL_BLOCK_TYPES[blockType ?? ""] === true;
    if (!hasToolType && rawArgs === undefined && toolName === undefined) continue;

    const parameters = parseToolArguments(rawArgs);
    if (
      toolName === undefined ||
      parameters === undefined ||
      (blockType !== undefined && !hasToolType)
    ) {
      calls.push({ rawCallId, toolName, parameters });
      continue;
    }
    announceOrdinal++;
    calls.push({ rawCallId, toolName, parameters, stepIndex: announceOrdinal });
  }
  return calls;
}

/**
 * Safely parses a non-negative integer from string or number.
 */
function parseNonNegativeInt(val: OmpTranscriptValue | undefined | null): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (Number.isInteger(val) && Number(val) >= 0) {
    return Number(val);
  }
  const str = asString(val);
  if (str !== undefined) {
    const trimmed = str.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num >= 0) {
        return num;
      }
    }
  }
  return undefined;
}

/**
 * Finds raw usage container within an OMP record or payload.
 */
function findRawUsage(
  rawPayload: OmpTranscriptPayload,
  recordMetadata?: OmpTranscriptPayload,
): OmpTranscriptPayload | undefined {
  const usageKeys = [
    "usage",
    "providerUsage",
    "provider_usage",
    "tokenUsage",
    "token_usage",
    "metrics",
    "stats",
  ];

  for (const key of usageKeys) {
    const val = asObject(rawPayload[key]);
    if (val) return val;
  }

  const containerKeys = ["response", "result", "message", "step", "metadata"];
  for (const parentKey of containerKeys) {
    const parent = asObject(rawPayload[parentKey]);
    if (parent) {
      for (const key of usageKeys) {
        const val = asObject(parent[key]);
        if (val) return val;
      }
    }
  }

  if (recordMetadata) {
    for (const key of usageKeys) {
      const val = asObject(recordMetadata[key]);
      if (val) return val;
    }
  }

  const tokens = asObject(rawPayload.tokens);
  if (tokens) return tokens;

  if (
    "tokens" in rawPayload ||
    "inputTokens" in rawPayload ||
    "promptTokens" in rawPayload ||
    "prompt_tokens" in rawPayload ||
    "outputTokens" in rawPayload ||
    "output_tokens" in rawPayload ||
    "completionTokens" in rawPayload ||
    "completion_tokens" in rawPayload ||
    "cachedInputTokens" in rawPayload ||
    "cached_input_tokens" in rawPayload ||
    "cachedTokens" in rawPayload ||
    "cached_tokens" in rawPayload ||
    "reasoningTokens" in rawPayload ||
    "reasoning_tokens" in rawPayload ||
    "thinkingTokens" in rawPayload ||
    "thinking_tokens" in rawPayload ||
    "totalTokens" in rawPayload ||
    "total_tokens" in rawPayload ||
    "costMicroUsd" in rawPayload ||
    "cost_micro_usd" in rawPayload ||
    "costMicros" in rawPayload ||
    "cost_micros" in rawPayload ||
    "cost_usd" in rawPayload ||
    "costUsd" in rawPayload ||
    "cost" in rawPayload
  ) {
    return rawPayload;
  }

  return undefined;
}

interface ExtractedTokens {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  hasAnyMetrics: boolean;
}

/**
 * Extracts and maps token count components from various OMP and upstream naming conventions.
 */
function extractTokenComponents(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
): ExtractedTokens {
  const promptDetails =
    asObject(rawUsage.prompt_tokens_details) ??
    asObject(rawUsage.promptTokensDetails) ??
    asObject(rawUsage.input_tokens_details) ??
    asObject(rawUsage.inputTokensDetails) ??
    asObject(rawPayload.prompt_tokens_details) ??
    asObject(rawPayload.promptTokensDetails);

  const completionDetails =
    asObject(rawUsage.completion_tokens_details) ??
    asObject(rawUsage.completionTokensDetails) ??
    asObject(rawUsage.output_tokens_details) ??
    asObject(rawUsage.outputTokensDetails) ??
    asObject(rawPayload.completion_tokens_details) ??
    asObject(rawPayload.completionTokensDetails);

  const tokensObj = asObject(rawUsage.tokens) ?? asObject(rawPayload.tokens);

  const inputTokens =
    parseNonNegativeInt(rawUsage.input_tokens) ??
    parseNonNegativeInt(rawUsage.inputTokens) ??
    parseNonNegativeInt(rawUsage.prompt_tokens) ??
    parseNonNegativeInt(rawUsage.promptTokens) ??
    parseNonNegativeInt(rawUsage.input) ??
    parseNonNegativeInt(rawPayload.input_tokens) ??
    parseNonNegativeInt(rawPayload.inputTokens) ??
    parseNonNegativeInt(rawPayload.prompt_tokens) ??
    parseNonNegativeInt(rawPayload.promptTokens) ??
    parseNonNegativeInt(tokensObj?.input_tokens) ??
    parseNonNegativeInt(tokensObj?.inputTokens) ??
    parseNonNegativeInt(tokensObj?.prompt_tokens);

  const outputTokens =
    parseNonNegativeInt(rawUsage.output_tokens) ??
    parseNonNegativeInt(rawUsage.outputTokens) ??
    parseNonNegativeInt(rawUsage.completion_tokens) ??
    parseNonNegativeInt(rawUsage.completionTokens) ??
    parseNonNegativeInt(rawUsage.output) ??
    parseNonNegativeInt(rawPayload.output_tokens) ??
    parseNonNegativeInt(rawPayload.outputTokens) ??
    parseNonNegativeInt(rawPayload.completion_tokens) ??
    parseNonNegativeInt(rawPayload.completionTokens) ??
    parseNonNegativeInt(tokensObj?.output_tokens) ??
    parseNonNegativeInt(tokensObj?.outputTokens) ??
    parseNonNegativeInt(tokensObj?.completion_tokens);

  const reasoningTokens =
    parseNonNegativeInt(rawUsage.reasoning_tokens) ??
    parseNonNegativeInt(rawUsage.reasoningTokens) ??
    parseNonNegativeInt(rawUsage.thinking_tokens) ??
    parseNonNegativeInt(rawUsage.thinkingTokens) ??
    parseNonNegativeInt(rawUsage.reasoning) ??
    parseNonNegativeInt(rawPayload.reasoning_tokens) ??
    parseNonNegativeInt(rawPayload.reasoningTokens) ??
    parseNonNegativeInt(rawPayload.thinking_tokens) ??
    parseNonNegativeInt(completionDetails?.reasoning_tokens) ??
    parseNonNegativeInt(completionDetails?.reasoningTokens) ??
    parseNonNegativeInt(completionDetails?.thinking_tokens);

  const cachedInputTokens =
    parseNonNegativeInt(rawUsage.cached_input_tokens) ??
    parseNonNegativeInt(rawUsage.cachedInputTokens) ??
    parseNonNegativeInt(rawUsage.cache_read_input_tokens) ??
    parseNonNegativeInt(rawUsage.cacheReadInputTokens) ??
    parseNonNegativeInt(rawUsage.cached_tokens) ??
    parseNonNegativeInt(rawUsage.cachedTokens) ??
    parseNonNegativeInt(rawUsage.cache_read_tokens) ??
    // OMP's own session usage: `{ input, output, cacheRead, cacheWrite, totalTokens }`.
    parseNonNegativeInt(rawUsage.cacheRead) ??
    parseNonNegativeInt(rawUsage.cache_read) ??
    parseNonNegativeInt(rawUsage.cached) ??
    parseNonNegativeInt(rawPayload.cached_input_tokens) ??
    parseNonNegativeInt(rawPayload.cachedInputTokens) ??
    parseNonNegativeInt(rawPayload.cached_tokens) ??
    parseNonNegativeInt(promptDetails?.cached_tokens) ??
    parseNonNegativeInt(promptDetails?.cachedTokens) ??
    parseNonNegativeInt(promptDetails?.cache_read_input_tokens) ??
    parseNonNegativeInt(promptDetails?.cache_read_tokens) ??
    parseNonNegativeInt(promptDetails?.cached);

  const totalTokens =
    parseNonNegativeInt(rawUsage.total_tokens) ??
    parseNonNegativeInt(rawUsage.totalTokens) ??
    parseNonNegativeInt(rawUsage.total) ??
    parseNonNegativeInt(rawPayload.total_tokens) ??
    parseNonNegativeInt(rawPayload.totalTokens) ??
    parseNonNegativeInt(rawPayload.total) ??
    parseNonNegativeInt(tokensObj?.total_tokens) ??
    parseNonNegativeInt(tokensObj?.totalTokens);

  const hasAnyMetrics =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningTokens !== undefined ||
    cachedInputTokens !== undefined ||
    totalTokens !== undefined;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    hasAnyMetrics,
  };
}
interface ExtractedCostAndDuration {
  costMicroUsd?: number;
  costProvenance: NonNullable<ProviderReportedUsage["costProvenance"]>;
  durationMs?: number;
}

interface ExtractedProviderAndModel {
  provider: string;
  model?: string;
}

/** Parses an explicit USD value without treating blank or invalid values as zero. */
function parseCostUsd(value: OmpTranscriptValue | undefined | null): number | undefined {
  const text = asString(value)?.trim().replace(/^\$/, "").trim();
  const amount = asNumber(value) ?? (text ? Number(text) : undefined);
  return amount !== undefined && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/**
 * Extracts and converts cost and duration to canonical schema units.
 */
function extractCostAndDuration(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
): ExtractedCostAndDuration {
  let costMicroUsd: number | undefined;
  let costProvenance: ExtractedCostAndDuration["costProvenance"] = "unpriced";

  const directMicro =
    parseNonNegativeInt(rawUsage.costMicroUsd) ??
    parseNonNegativeInt(rawUsage.cost_micro_usd) ??
    parseNonNegativeInt(rawUsage.costMicros) ??
    parseNonNegativeInt(rawUsage.cost_micros) ??
    parseNonNegativeInt(rawPayload.costMicroUsd) ??
    parseNonNegativeInt(rawPayload.cost_micro_usd) ??
    parseNonNegativeInt(rawPayload.costMicros) ??
    parseNonNegativeInt(rawPayload.cost_micros);

  if (directMicro !== undefined) {
    costMicroUsd = directMicro;
    costProvenance = "source_reported";
  } else {
    const sourceCostUsd =
      parseCostUsd(rawUsage.cost_usd) ??
      parseCostUsd(rawUsage.costUsd) ??
      parseCostUsd(rawUsage.cost) ??
      parseCostUsd(rawPayload.cost_usd) ??
      parseCostUsd(rawPayload.costUsd) ??
      parseCostUsd(rawPayload.cost);
    // OMP's `cost: { input, output, cacheRead, cacheWrite, total }` is a harness
    // estimate, not provider billing. Explicit scalar monetary fields take precedence.
    const harnessCostUsd = parseCostUsd(asObject(rawUsage.cost)?.total);
    const costUsd = sourceCostUsd ?? harnessCostUsd;
    if (costUsd !== undefined) {
      const converted = Math.round(costUsd * 1_000_000);
      if (Number.isFinite(converted)) {
        costMicroUsd = converted;
        costProvenance = sourceCostUsd !== undefined ? "source_reported" : "harness_estimate";
      }
    }
  }

  let durationMs: number | undefined;

  const directMs =
    parseNonNegativeInt(rawUsage.duration_ms) ??
    parseNonNegativeInt(rawUsage.durationMs) ??
    parseNonNegativeInt(rawUsage.executionDurationMs) ??
    parseNonNegativeInt(rawUsage.execution_duration_ms) ??
    parseNonNegativeInt(rawPayload.duration_ms) ??
    parseNonNegativeInt(rawPayload.durationMs) ??
    parseNonNegativeInt(rawPayload.executionDurationMs);

  if (directMs !== undefined) {
    durationMs = directMs;
  } else {
    const rawDurationSec =
      asNumber(rawUsage.duration_seconds) ??
      asNumber(rawUsage.durationSeconds) ??
      asNumber(rawUsage.duration) ??
      asNumber(rawPayload.duration_seconds) ??
      asNumber(rawPayload.durationSeconds);

    if (rawDurationSec !== undefined && rawDurationSec >= 0) {
      durationMs = Math.round(rawDurationSec * 1000);
    } else {
      const rawDurStr =
        asString(rawUsage.duration_seconds) ??
        asString(rawUsage.durationSeconds) ??
        asString(rawUsage.duration) ??
        asString(rawPayload.duration_seconds);

      if (rawDurStr !== undefined) {
        const trimmed = rawDurStr.trim().replace(/s$/i, "");
        const num = Number(trimmed);
        if (Number.isFinite(num) && num >= 0) {
          durationMs = Math.round(num * 1000);
        }
      }
    }
  }

  return { costMicroUsd, costProvenance, durationMs };
}

/**
 * Resolves provider and model names from payload and usage metadata.
 */
function extractProviderAndModel(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
  fallbackProvider = OMP_PROVIDER,
  fallbackModel?: string,
): ExtractedProviderAndModel {
  const rawProvider =
    asString(rawUsage.provider)?.trim() ||
    asString(rawPayload.provider)?.trim() ||
    asString(rawUsage.provider_name)?.trim() ||
    asString(rawPayload.provider_name)?.trim() ||
    asString(rawUsage.providerName)?.trim() ||
    asString(rawPayload.providerName)?.trim() ||
    asString(rawUsage.vendor)?.trim() ||
    asString(rawPayload.vendor)?.trim() ||
    (fallbackProvider && fallbackProvider.trim() ? fallbackProvider.trim() : undefined);
  const provider = rawProvider || OMP_PROVIDER;

  const rawModel =
    asString(rawUsage.model)?.trim() ||
    asString(rawPayload.model)?.trim() ||
    asString(rawUsage.model_id)?.trim() ||
    asString(rawPayload.model_id)?.trim() ||
    asString(rawUsage.modelId)?.trim() ||
    asString(rawPayload.modelId)?.trim() ||
    asString(rawUsage.model_name)?.trim() ||
    asString(rawPayload.model_name)?.trim() ||
    asString(rawUsage.modelName)?.trim() ||
    asString(rawPayload.modelName)?.trim() ||
    (fallbackModel && fallbackModel.trim() ? fallbackModel.trim() : undefined);

  const model = rawModel || undefined;

  return { provider, model };
}

/**
 * Resolves accounting version string.
 */
function extractAccountingVersion(
  rawUsage: OmpTranscriptPayload,
  rawPayload: OmpTranscriptPayload,
  fallbackAccountingVersion = OMP_ACCOUNTING_VERSION,
): string {
  const version =
    asString(rawUsage.accounting_version)?.trim() ||
    asString(rawUsage.accountingVersion)?.trim() ||
    asString(rawPayload.accounting_version)?.trim() ||
    asString(rawPayload.accountingVersion)?.trim() ||
    asString(rawUsage.schema_version)?.trim() ||
    asString(rawUsage.schemaVersion)?.trim() ||
    asString(rawPayload.schema_version)?.trim() ||
    asString(rawPayload.schemaVersion)?.trim();

  return version || fallbackAccountingVersion;
}

/**
 * Builds and validates canonical ProviderReportedUsage.
 */
function buildProviderUsage(
  rawUsageCandidate: OmpTranscriptPayload | undefined,
  rawPayload: OmpTranscriptPayload,
  fallbackProvider = OMP_PROVIDER,
  fallbackModel?: string,
  fallbackAccountingVersion = OMP_ACCOUNTING_VERSION,
): ProviderReportedUsage | undefined {
  const rawUsage = rawUsageCandidate ?? {};

  const { provider, model } = extractProviderAndModel(
    rawUsage,
    rawPayload,
    fallbackProvider,
    fallbackModel,
  );
  const accountingVersion = extractAccountingVersion(
    rawUsage,
    rawPayload,
    fallbackAccountingVersion,
  );

  const explicitAvailability =
    asString(rawUsage.availability) ??
    asString(rawPayload.availability) ??
    asString(rawUsage.provider_usage_availability) ??
    asString(rawPayload.provider_usage_availability);

  if (
    explicitAvailability === "unavailable" ||
    rawUsage.unavailable === true ||
    rawPayload.unavailable === true
  ) {
    const usageObj: ProviderReportedUsage = {
      provider,
      accountingVersion,
      availability: "unavailable",
      costProvenance: "unpriced",
    };
    if (model) usageObj.model = model;
    const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
    return parsed.success ? parsed.data : undefined;
  }

  const {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
    hasAnyMetrics: hasTokenMetrics,
  } = extractTokenComponents(rawUsage, rawPayload);

  const { costMicroUsd, costProvenance, durationMs } = extractCostAndDuration(rawUsage, rawPayload);

  const hasMetrics = hasTokenMetrics || costMicroUsd !== undefined || durationMs !== undefined;

  if (!hasMetrics) {
    if (explicitAvailability === "complete" || explicitAvailability === "partial") {
      const usageObj: ProviderReportedUsage = {
        provider,
        accountingVersion,
        availability: explicitAvailability,
        costProvenance,
      };
      if (model) usageObj.model = model;
      const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
      return parsed.success ? parsed.data : undefined;
    }
    return undefined;
  }

  const availability: "complete" | "partial" =
    explicitAvailability === "partial"
      ? "partial"
      : explicitAvailability === "complete" && totalTokens !== undefined
        ? "complete"
        : totalTokens !== undefined && !explicitAvailability
          ? "complete"
          : "partial";

  const usageObj: ProviderReportedUsage = {
    provider,
    accountingVersion,
    availability,
    costProvenance,
  };
  if (model) usageObj.model = model;
  if (inputTokens !== undefined) usageObj.inputTokens = inputTokens;
  if (outputTokens !== undefined) usageObj.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usageObj.reasoningTokens = reasoningTokens;
  if (cachedInputTokens !== undefined) usageObj.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usageObj.totalTokens = totalTokens;
  if (costMicroUsd !== undefined) usageObj.costMicroUsd = costMicroUsd;
  if (durationMs !== undefined) usageObj.durationMs = durationMs;

  const parsed = ProviderReportedUsageSchema.safeParse(usageObj);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Bounded session-scoped cache that maps (sessionId, callId) -> value without
 * key concatenation or prefix ambiguity, with global capacity bounding and FIFO eviction.
 */
class BoundedSessionCallMap<T> {
  private readonly maxEntries: number;
  private readonly sessions = new Map<string, Map<string, { value: T; sequence: number }>>();
  private readonly order = new Map<number, { sessionId: string; callId: string }>();
  private entryCount = 0;
  private nextSequence = 0;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  set(sessionId: string, callId: string, value: T): void {
    if (!sessionId || !callId || value === undefined) return;

    let calls = this.sessions.get(sessionId);
    if (!calls) {
      calls = new Map<string, { value: T; sequence: number }>();
      this.sessions.set(sessionId, calls);
    }

    const existing = calls.get(callId);
    if (existing) {
      existing.value = value;
      return;
    }

    while (this.entryCount >= this.maxEntries) {
      this.evictOldest();
    }

    const sequence = this.nextSequence++;
    calls.set(callId, { value, sequence });
    this.order.set(sequence, { sessionId, callId });
    this.entryCount++;
  }

  get(sessionId: string, callId: string): T | undefined {
    return this.sessions.get(sessionId)?.get(callId)?.value;
  }

  getAndClear(sessionId: string, callId: string): T | undefined {
    const calls = this.sessions.get(sessionId);
    const entry = calls?.get(callId);
    if (!calls || !entry) return undefined;

    calls.delete(callId);
    this.order.delete(entry.sequence);
    this.entryCount--;
    if (calls.size === 0) {
      this.sessions.delete(sessionId);
    }
    return entry.value;
  }

  clearSession(sessionId: string): void {
    const calls = this.sessions.get(sessionId);
    if (!calls) return;

    for (const entry of calls.values()) {
      this.order.delete(entry.sequence);
    }
    this.entryCount -= calls.size;
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.entryCount;
  }

  private evictOldest(): void {
    const oldest = this.order.entries().next().value;
    if (!oldest) return;

    const [sequence, location] = oldest;
    this.order.delete(sequence);
    const calls = this.sessions.get(location.sessionId);
    const entry = calls?.get(location.callId);
    if (!calls || !entry || entry.sequence !== sequence) return;

    calls.delete(location.callId);
    this.entryCount--;
    if (calls.size === 0) {
      this.sessions.delete(location.sessionId);
    }
  }
}

export interface OmpRecordDecoderOptions {
  /**
   * The MCP server names the harness itself is configured with (the `mcpServers` keys of its own
   * config). A device-surface path is resolved against this registry and nothing else: it is the
   * authority for which connection a callable was reached over, and a path that does not resolve
   * against it stays unresolved rather than guessed at.
   */
  deviceSurfaceServers?: () => readonly string[];
}

/**
 * High-fidelity record decoder for Oh My Pi transcripts and structured records.
 */
export class OmpRecordDecoder implements HarnessRecordDecoder {
  readonly harnessId = "omp";
  readonly decoderVersion = "1.0.0";
  private static readonly MAX_CALL_CACHE_ENTRIES = 5000;
  private readonly callToolNames = new BoundedSessionCallMap<string>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  private readonly callToolArguments = new BoundedSessionCallMap<OmpTranscriptPayload>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  /**
   * Device-surface invocations whose tool identity is known but whose arguments the record has not
   * carried yet: the surface's start marker names only the path, and the invocation's own
   * arguments arrive in the assistant record that follows.
   */
  private readonly pendingDeviceSurfaceCalls = new BoundedSessionCallMap<OmpDeviceSurfaceCall>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  /**
   * Calls whose start marker carried no arguments, held for the assistant record that carries
   * them. The value keeps the intent the marker recorded.
   */
  private readonly pendingArgumentlessCalls = new BoundedSessionCallMap<{
    intent: DecoderMetadataValue | undefined;
  }>(OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES);
  /** Confirmed device-surface calls awaiting their result payload. */
  private readonly deviceSurfaceResultCalls = new BoundedSessionCallMap<OmpDeviceSurfaceCall>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  /**
   * Reads of harness-internal URIs (see {@link OMP_HARNESS_INTERNAL_URI_SCHEMES}) seen in this
   * session, keyed by raw call id: neither the call nor its result is recorded.
   */
  private readonly harnessInternalReads = new BoundedSessionCallMap<true>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  /**
   * Job-joining calls (see {@link isOmpJobJoinCall}) announced but not yet answered, keyed by call
   * id. Whether one is a step of the work is known only from its result, so it is held until then:
   * a result that only reports background jobs drops it as harness bookkeeping, any other result
   * records it, with the call's own timestamp and position, just before that result.
   */
  private readonly heldJobJoinCalls = new BoundedSessionCallMap<IntermediateToolCallEvent>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  /**
   * Background bash jobs whose launch acknowledgement was held, keyed by job id and valued by the
   * call that launched them. The call's single result is the job's completion, whichever record
   * reports it first; a job never seen completing leaves its call without a result, as a call
   * still running is. A relaunch under a reused job id replaces the earlier entry.
   */
  private readonly backgroundJobs = new BoundedSessionCallMap<{ callId: string; toolName: string }>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );
  private readonly deviceSurfaceServers?: () => readonly string[];

  constructor(options: OmpRecordDecoderOptions = {}) {
    this.deviceSurfaceServers = options.deviceSurfaceServers;
  }

  /**
   * Session-scoped call identities already announced as tool_call events, keyed by raw call id and
   * valued by the announcing record kind.
   */
  private readonly announcedToolCalls = new BoundedSessionCallMap<CallAnnouncementOrigin>(
    OmpRecordDecoder.MAX_CALL_CACHE_ENTRIES,
  );

  private setToolCallName(sessionId: string, callId: string, toolName: string): void {
    if (!callId || !toolName || toolName === "unknown_tool") return;
    this.callToolNames.set(sessionId, callId, toolName);
  }

  private getAndClearToolCallName(sessionId: string, callId: string): string | undefined {
    return this.callToolNames.getAndClear(sessionId, callId);
  }

  private setToolCallArguments(
    sessionId: string,
    callId: string,
    args: OmpTranscriptPayload,
  ): void {
    if (!callId || !args) return;
    this.callToolArguments.set(sessionId, callId, args);
  }

  private getAndClearToolCallArguments(
    sessionId: string,
    callId: string,
  ): OmpTranscriptPayload | undefined {
    return this.callToolArguments.getAndClear(sessionId, callId);
  }

  private clearSessionToolCalls(sessionId: string): void {
    this.callToolNames.clearSession(sessionId);
    this.callToolArguments.clearSession(sessionId);
    this.announcedToolCalls.clearSession(sessionId);
    this.pendingDeviceSurfaceCalls.clearSession(sessionId);
    this.pendingArgumentlessCalls.clearSession(sessionId);
    this.deviceSurfaceResultCalls.clearSession(sessionId);
    this.harnessInternalReads.clearSession(sessionId);
    this.heldJobJoinCalls.clearSession(sessionId);
    this.backgroundJobs.clearSession(sessionId);
  }

  /**
   * Marks a harness-internal read so no record of it becomes a call: whichever record announces it
   * first marks it announced (so the other is deduplicated as usual), anything held for it is
   * released, and its result is dropped when it arrives.
   */
  private skipHarnessInternalRead(
    sessionId: string,
    rawCallId: string,
    origin: CallAnnouncementOrigin,
  ): void {
    this.harnessInternalReads.set(sessionId, rawCallId, true);
    if (this.announcedToolCalls.get(sessionId, rawCallId) === undefined) {
      this.announcedToolCalls.set(sessionId, rawCallId, origin);
    }
    this.pendingArgumentlessCalls.getAndClear(sessionId, rawCallId);
    this.pendingDeviceSurfaceCalls.getAndClear(sessionId, rawCallId);
  }

  /**
   * Whether a result answers a harness-internal read; if so, everything cached for that call is
   * released, since the result is not recorded either. The mark itself stays until the session
   * ends, so a second record of the same result (an execution end and the result message) is
   * dropped too.
   */
  private consumeHarnessInternalRead(
    sessionId: string,
    rawCallId: string | undefined,
    callId: string,
  ): boolean {
    const key = rawCallId ?? callId;
    if (this.harnessInternalReads.get(sessionId, key) === undefined) return false;
    this.callToolArguments.getAndClear(sessionId, key);
    this.callToolNames.getAndClear(sessionId, key);
    this.callToolNames.getAndClear(sessionId, callId);
    this.pendingArgumentlessCalls.getAndClear(sessionId, key);
    this.pendingDeviceSurfaceCalls.getAndClear(sessionId, key);
    this.deviceSurfaceResultCalls.getAndClear(sessionId, callId);
    return true;
  }

  /**
   * Holds a job-joining call until its result settles whether it is harness bookkeeping; any
   * other call passes through, and so does one that carries provider usage, which is never
   * dropped.
   */
  private holdJobJoinCall(sessionId: string, event: IntermediateToolCallEvent): boolean {
    const callId = event.callId;
    if (
      callId === undefined ||
      !isOmpJobJoinCall(event.toolName, event.parameters) ||
      event.providerUsage !== undefined
    ) {
      return false;
    }
    this.heldJobJoinCalls.set(sessionId, callId, event);
    return true;
  }

  /**
   * The results of the held background calls whose jobs a record reports finished: each launching
   * call's single terminal result, carrying the job's own output, positioned at the record that
   * reported it. A job only a job-joining report stated `completed` exited 0, and is marked as a
   * completed bash run like a foreground one; a completion read from a notice that states no status
   * is not. A job no held call launched (one already joined, or launched before this decoder saw
   * the session) is ignored.
   */
  private joinBackgroundJobs(
    completions: readonly OmpJobCompletion[],
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolResultEvent[] {
    const { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: _forged, ...unproven } = metadata;
    return completions.flatMap((completion) => {
      const launch = this.backgroundJobs.getAndClear(sessionId, completion.jobId);
      if (launch === undefined) return [];
      const exitedZero = completion.statusStated && !completion.failed;
      const result: IntermediateToolResultEvent = {
        sessionId,
        timestamp,
        schemaVersion: "1.0.0",
        causalRef,
        metadata: exitedZero
          ? { ...unproven, [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-bash-completed" }
          : { ...unproven },
        type: "tool_result",
        toolName: launch.toolName,
        callId: launch.callId,
        toolCallId: launch.callId,
        result: completion.output,
        isError: completion.failed,
        error: completion.failed ? completion.output : undefined,
        executionDurationMs: completion.durationMs ?? 0,
      };
      return [result];
    });
  }

  /**
   * The invocation a device-surface call carried, when the harness's own configured servers
   * resolve its path.
   *
   * The surface invokes a tool by writing JSON to the path, so the invocation's own arguments are
   * the payload; a callable that takes no arguments is reached by reading the path instead, so its
   * payload is empty. Either way the transport's envelope is not an argument of the tool.
   * `undefined` means the path is not one a configured server owns (or two own equally): the call
   * keeps the harness's own naming and no connection.
   */
  private deviceSurfaceCallOf(
    toolName: string,
    parameters: OmpTranscriptPayload,
  ): { identity: OmpDeviceSurfaceCall; arguments: OmpTranscriptPayload | undefined } | undefined {
    if (toolName !== OMP_DEVICE_SURFACE_WRITE_TOOL && toolName !== OMP_DEVICE_SURFACE_READ_TOOL) {
      return undefined;
    }
    const devicePath = asString(parameters.path);
    if (devicePath === undefined || !devicePath.startsWith(OMP_DEVICE_SURFACE_PREFIX)) {
      return undefined;
    }
    const identity = resolveOmpDeviceSurfaceCall(devicePath, this.deviceSurfaceServers?.() ?? []);
    if (identity === undefined) return undefined;
    const content = parameters.content;
    let payload = asObject(content);
    if (payload === undefined && typeof content === "string") {
      try {
        payload = asObject(JSON.parse(content));
      } catch {
        payload = undefined;
      }
    }
    return { identity, arguments: payload };
  }

  /**
   * Resin's management tool requires an action: reading its device path is documentation, not a
   * zero-argument invocation. Only its two read-only catalog actions are discovery when written.
   * Unknown arguments, mutations, and same-named tools on other connections remain executable work.
   */
  private isResinCatalogDiscovery(
    toolName: string,
    identity: OmpDeviceSurfaceCall,
    args: OmpTranscriptPayload | undefined,
  ): boolean {
    if (identity.connection !== "resin" || identity.tool !== "manage_tools") return false;
    return (
      (toolName === OMP_DEVICE_SURFACE_READ_TOOL && args === undefined) ||
      (toolName === OMP_DEVICE_SURFACE_WRITE_TOOL &&
        (args?.action === "list_versions" || args?.action === "status"))
    );
  }

  /**
   * Records a device-surface invocation as the tool the surface reached, over the connection the
   * harness's own registry resolved to: the tool's own name, that connection as a separate field,
   * and the invocation's own arguments, never the transport's envelope.
   */
  private asDeviceSurfaceCall(
    event: IntermediateToolCallEvent,
    identity: OmpDeviceSurfaceCall,
    args: OmpTranscriptPayload | undefined,
  ): IntermediateToolCallEvent {
    if (event.callId !== undefined) {
      this.deviceSurfaceResultCalls.set(event.sessionId, event.callId, identity);
    }
    return {
      ...event,
      toolName: identity.tool,
      connection: identity.connection,
      parameters: args ?? {},
    };
  }

  /**
   * The discovery a resolved device-surface call is recorded by: the tool it reached, over the
   * connection that owns its path. It travels on the record that announces the path, which carries
   * nothing else, so the connection is recorded where every other connection is.
   */
  private deviceSurfaceDiscovery(
    identity: OmpDeviceSurfaceCall,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolDiscoveryEvent {
    return {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "tool_discovery",
      tools: [{ name: identity.tool, provider: identity.connection }],
      source: "mcp",
    };
  }

  /**
   * Caches assistant-embedded call identities and arguments so later execution records correlate
   * without re-declaring them.
   */
  private cacheAssistantToolCalls(calls: EmbeddedAssistantToolCall[], sessionId: string): void {
    for (const call of calls) {
      if (call.toolName) {
        this.setToolCallName(sessionId, call.rawCallId, call.toolName);
      }
      if (call.parameters !== undefined) {
        this.setToolCallArguments(sessionId, call.rawCallId, call.parameters);
      }
    }
  }

  /** Recovers bounded edit target metadata before patch content is redacted. */
  private withEditTargets(
    toolName: string,
    parameters: OmpTranscriptPayload,
  ): OmpTranscriptPayload {
    if (toolName !== "edit" && toolName !== "apply_patch") return parameters;
    if (parameters.path || parameters.filePath || parameters.targetPaths) return parameters;
    const targetPaths = editTargetPaths(parameters);
    return targetPaths.length > 0 ? { ...parameters, targetPaths } : parameters;
  }
  /**
   * The arguments a call is recorded with. OMP's built-in tools take `i`, a one-line statement of
   * intent for the transcript: the harness's narration, not the call's data, so it is kept as the
   * call's intent and never as an argument a learned tool would ask its caller for.
   */
  private recordedArguments(
    toolName: string,
    parameters: OmpTranscriptPayload,
    metadata: OmpTranscriptPayload,
  ): { parameters: OmpTranscriptPayload; metadata: OmpTranscriptPayload } {
    const targeted = this.withEditTargets(toolName, parameters);
    if (typeof targeted.i !== "string" || toolName.startsWith("mcp__")) {
      return { parameters: targeted, metadata };
    }
    const { i: intent, ...rest } = targeted;
    return {
      parameters: rest,
      metadata: metadata.intent === undefined ? { ...metadata, intent } : metadata,
    };
  }
  private withEvalSourceInterface(
    toolName: string,
    parameters: DecoderMetadataRecord,
    metadata: OmpTranscriptPayload,
  ): OmpTranscriptPayload {
    const cleanMetadata = Object.hasOwn(metadata, RESIN_LOCAL_SOURCE_INTERFACE_KEY)
      ? { ...metadata }
      : metadata;
    if (cleanMetadata !== metadata) delete cleanMetadata[RESIN_LOCAL_SOURCE_INTERFACE_KEY];

    const language = asString(parameters.language)?.trim().toLowerCase();
    // Only the decoder proves the native interface; the recorder trusts this local-only key.
    const sourceInterface =
      toolName === "bash" && typeof parameters.command === "string"
        ? "omp-bash"
        : toolName !== "eval" || typeof parameters.code !== "string"
          ? undefined
          : language === "py" || language === "python"
            ? "python-eval"
            : language === "js" || language === "javascript"
              ? "javascript-eval"
              : undefined;
    return sourceInterface === undefined
      ? cleanMetadata
      : { ...cleanMetadata, [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: sourceInterface };
  }

  /**
   * Emits genuinely requested assistant-embedded tool calls exactly once per session-scoped call
   * identity, whatever announced them first. Provider usage stays on the owning assistant message
   * so accounting never doubles. Siblings keep the source record's sequence, timestamp, and parent,
   * and carry the stepIndex of their validated source block — including siblings already announced
   * earlier in the session.
   */
  private emitEmbeddedToolCalls(
    calls: EmbeddedAssistantToolCall[],
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSessionEvent[] {
    const events: IntermediateSessionEvent[] = [];
    for (const call of calls) {
      const toolName = call.toolName;
      const parameters = call.parameters;
      const stepIndex = call.stepIndex;
      if (toolName === undefined || parameters === undefined || stepIndex === undefined) continue;
      if (this.announcedToolCalls.get(sessionId, call.rawCallId) !== undefined) continue;
      this.announcedToolCalls.set(sessionId, call.rawCallId, "assistant_message");
      // The harness paging its own session state is not a step of the work.
      if (isHarnessInternalRead(toolName, parameters)) {
        this.skipHarnessInternalRead(sessionId, call.rawCallId, "assistant_message");
        continue;
      }

      const callId = normalizeCallId(call.rawCallId, call.rawCallId);
      const { parameters: recordedParameters, metadata: recordedMetadata } = this.recordedArguments(
        toolName,
        parameters,
        metadata,
      );
      // A call held at its argument-less start marker keeps the intent that marker recorded.
      const heldCall = this.pendingArgumentlessCalls.getAndClear(sessionId, call.rawCallId);
      const callMetadata =
        heldCall?.intent !== undefined && recordedMetadata.intent === undefined
          ? { ...recordedMetadata, intent: heldCall.intent }
          : recordedMetadata;
      const surface = this.deviceSurfaceCallOf(toolName, recordedParameters);
      // Results may only carry the sanitized identity, so keep the name resolvable under it too.
      this.setToolCallName(sessionId, callId, surface?.identity.tool ?? toolName);
      const pendingSurface = this.pendingDeviceSurfaceCalls.getAndClear(sessionId, call.rawCallId);
      if (
        surface !== undefined &&
        this.isResinCatalogDiscovery(toolName, surface.identity, surface.arguments)
      ) {
        // A path-only execution marker may already have announced this same discovery.
        if (pendingSurface === undefined) {
          events.push(
            this.deviceSurfaceDiscovery(
              surface.identity,
              sessionId,
              timestamp,
              { ...causalRef, stepIndex },
              metadata,
            ),
          );
        }
        continue;
      }
      const event: IntermediateToolCallEvent = {
        sessionId,
        timestamp,
        schemaVersion: "1.0.0",
        causalRef: { ...causalRef, stepIndex },
        metadata: this.withEvalSourceInterface(toolName, recordedParameters, callMetadata),
        type: "tool_call",
        toolName,
        callId,
        toolCallId: callId,
        parameters: recordedParameters,
      };
      // A wait on the harness's own background jobs is settled by its result.
      if (surface === undefined && this.holdJobJoinCall(sessionId, event)) continue;
      events.push(
        surface === undefined
          ? event
          : this.asDeviceSurfaceCall(event, surface.identity, surface.arguments),
      );
    }
    return events;
  }
  canDecode(record: RawHarnessRecord): boolean {
    if (!record) return false;
    if (record.harnessId === "omp" || record.harnessId === "*") {
      return true;
    }

    const payload = this.extractPayload(record);
    const obj = asObject(payload);
    if (!obj) {
      return false;
    }

    return (
      obj.harness === "omp" ||
      obj.harnessName === "omp" ||
      asString(obj.type) !== undefined ||
      asString(obj.event) !== undefined ||
      asString(obj.role) !== undefined ||
      asString(obj.customType) !== undefined ||
      asString(obj.custom_type) !== undefined ||
      asObject(obj.message) !== undefined
    );
  }

  decode(
    record: RawHarnessRecord,
    context?: RecordDecoderContext,
  ): IntermediateSessionEvent | IntermediateSessionEvent[] | null {
    if (!record) {
      return null;
    }

    const payload = this.extractPayload(record);
    const obj = asObject(payload);
    if (!obj) {
      const rawText = asString(payload) ?? JSON.stringify(payload);
      return {
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        schemaVersion: "1.0.0",
        causalRef: {
          causalSequence: record.sequenceNumber,
          parentId: context?.parentEventId ?? null,
        },
        type: "unknown_passthrough",
        rawEventType: "unparseable",
        rawPayload: { text: rawText },
      };
    }

    const sessionId = record.sessionId || asString(obj.sessionId) || "unknown-session";
    const timestamp = record.timestamp || asString(obj.timestamp) || new Date().toISOString();
    const causalSequence = record.sequenceNumber || 1;
    const parentId = context?.parentEventId ?? null;
    const causalRef: CausalRefInput = {
      causalSequence,
      parentId,
    };
    // SAFETY: Record metadata is an arbitrary JSON dictionary normalized into an OmpTranscriptValue object.
    const rawMeta = record.metadata as OmpTranscriptValue;
    const metadata = { ...(asObject(rawMeta) ?? {}) };
    // Only the decoder's own argument cache may create this private handoff.
    delete metadata[RESIN_LOCAL_OMP_NATIVE_CALL_KEY];
    delete metadata[RESIN_LOCAL_SOURCE_INTERFACE_KEY];

    const rawRole = asString(obj.role)?.toLowerCase();
    const rawType = String(
      asString(obj.type) ?? asString(obj.event) ?? asString(obj.kind) ?? asString(obj.action) ?? "",
    ).toLowerCase();
    const customType = String(
      asString(obj.customType) ?? asString(obj.custom_type) ?? "",
    ).toLowerCase();
    // 0. Filter out non-semantic streaming/delta/lifecycle progress events
    // In OMP v18.1.x, the stream includes fine-grained stream/chunk and progress events
    // that must NOT become unknown_passthrough workflow operations.
    if (
      rawType === "message_start" ||
      rawType === "message_update" ||
      rawType === "tool_execution_update" ||
      rawType === "tool_update" ||
      rawType === "turn_start" ||
      rawType === "turn_end" ||
      rawType === "advisor_cost_changed" ||
      rawType === "cost_changed" ||
      rawType === "cost_update"
    ) {
      return null;
    }

    // Bare advisor_yielded without subagent identity is an internal advisor lifecycle event
    if (
      (rawType === "advisor_yielded" || customType === "advisor_yielded") &&
      !obj.subagentId &&
      !obj.subagent_id &&
      !obj.parentId &&
      !obj.parent_id
    ) {
      return null;
    }

    // 1. Tool Execution Start & End (OMP v18.1 tool execution lifecycle)
    if (
      (rawType === "custom" &&
        (customType === "tool_execution_start" ||
          customType === "tool_start" ||
          customType === "toolexecutionstart")) ||
      rawType === "tool_execution_start"
    ) {
      const dataObj = asObject(obj.data) ?? {};
      const toolCallPayload: OmpTranscriptPayload = { ...obj, ...dataObj };
      return this.normalizeToolCall(toolCallPayload, sessionId, timestamp, causalRef, metadata);
    }

    if (
      (rawType === "custom" &&
        (customType === "tool_execution_end" ||
          customType === "tool_end" ||
          customType === "toolexecutionend")) ||
      rawType === "tool_execution_end"
    ) {
      const dataObj = asObject(obj.data) ?? {};
      const toolResultPayload: OmpTranscriptPayload = { ...obj, ...dataObj };
      return this.normalizeToolResult(toolResultPayload, sessionId, timestamp, causalRef, metadata);
    }

    // 2. Message End / Completed Messages (OMP v18.1 streaming message completion)
    if (rawType === "message_end") {
      const nestedMsg = asObject(obj.message);
      const mergedPayload: OmpTranscriptPayload = nestedMsg ? { ...obj, ...nestedMsg } : obj;
      const effectiveRole = asString(mergedPayload.role)?.toLowerCase().trim() ?? "assistant";
      if (
        effectiveRole === "reasoning" ||
        effectiveRole === "thought" ||
        effectiveRole === "thinking" ||
        mergedPayload.thinking !== undefined ||
        mergedPayload.reasoningContent !== undefined
      ) {
        return this.normalizeReasoning(mergedPayload, sessionId, timestamp, causalRef, metadata);
      }
      if (effectiveRole === "user") {
        return this.normalizeMessage(
          mergedPayload,
          "user",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (effectiveRole === "system") {
        return this.normalizeMessage(
          mergedPayload,
          "system",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (
        effectiveRole === "toolresult" ||
        effectiveRole === "tool_result" ||
        effectiveRole === "tool"
      ) {
        return this.normalizeToolResult(mergedPayload, sessionId, timestamp, causalRef, metadata);
      }
      return this.normalizeMessage(
        mergedPayload,
        "assistant",
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
    }

    // 3. Standalone nested message envelope
    const nestedMsg = asObject(obj.message);
    if (nestedMsg) {
      const nestedRole = asString(nestedMsg.role)?.toLowerCase().trim();
      const mergedPayload: OmpTranscriptPayload = { ...obj, ...nestedMsg };

      if (
        nestedRole === "reasoning" ||
        nestedRole === "thought" ||
        nestedRole === "thinking" ||
        mergedPayload.thinking !== undefined ||
        mergedPayload.reasoningContent !== undefined
      ) {
        return this.normalizeReasoning(mergedPayload, sessionId, timestamp, causalRef, metadata);
      }
      if (nestedRole === "user") {
        return this.normalizeMessage(
          mergedPayload,
          "user",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "assistant") {
        return this.normalizeMessage(
          mergedPayload,
          "assistant",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "system") {
        return this.normalizeMessage(
          mergedPayload,
          "system",
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      if (nestedRole === "toolresult" || nestedRole === "tool_result" || nestedRole === "tool") {
        return this.normalizeToolResult(mergedPayload, sessionId, timestamp, causalRef, metadata);
      }
    }

    // 4. Session Lifecycle & Agent Start / End
    const customExitReason = getOmpSessionExitReason(obj);
    if (customExitReason !== undefined) {
      return this.normalizeLifecycle(
        { ...obj, lifecycleType: "end", exitReason: customExitReason },
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
    }
    if (
      rawType === "session_start" ||
      rawType === "session_init" ||
      rawType === "session_end" ||
      rawType === "session_completed" ||
      rawType === "session_terminate" ||
      rawType === "session_lifecycle" ||
      rawType === "lifecycle"
    ) {
      return this.normalizeLifecycle(obj, sessionId, timestamp, causalRef, metadata);
    }

    if (rawType === "session") {
      const action = String(obj.lifecycleType ?? obj.action ?? obj.status ?? "").toLowerCase();
      const exitReasonStr = String(obj.exitReason ?? obj.reason ?? obj.error ?? "").toLowerCase();
      const isCrash =
        action === "crash" ||
        action === "error" ||
        action === "fatal" ||
        action === "failed" ||
        exitReasonStr === "error" ||
        exitReasonStr === "crash" ||
        exitReasonStr === "fatal" ||
        obj.error !== undefined ||
        obj.isError === true;
      const isTerminal =
        isCrash ||
        action === "end" ||
        action === "completed" ||
        action === "complete" ||
        action === "finished" ||
        action === "closed";
      if (isTerminal) {
        const lifecycleType = isCrash ? "crash" : "end";
        const exitReason =
          asString(obj.exitReason) ??
          asString(obj.reason) ??
          asString(obj.error) ??
          asString(obj.status) ??
          (isCrash ? "error" : "completed");
        return this.normalizeLifecycle(
          { ...obj, lifecycleType, exitReason },
          sessionId,
          timestamp,
          causalRef,
          metadata,
        );
      }
      return this.normalizeLifecycle(
        { ...obj, lifecycleType: "start" },
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
    }

    if (rawType === "agent_start") {
      const isSubagent =
        obj.subagentId !== undefined ||
        obj.subagent_id !== undefined ||
        obj.parentId !== undefined ||
        obj.parent_id !== undefined ||
        rawRole === "subagent" ||
        rawRole === "advisor";
      if (isSubagent) {
        return this.normalizeSubagent(obj, sessionId, timestamp, causalRef, metadata);
      }
      return this.normalizeLifecycle(
        { ...obj, lifecycleType: "start" },
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
    }

    if (
      rawType === "agent_end" ||
      rawType === "agent_complete" ||
      rawType === "agent_finish" ||
      rawType === "agent_terminated"
    ) {
      const isSubagent =
        obj.subagentId !== undefined ||
        obj.subagent_id !== undefined ||
        obj.parentId !== undefined ||
        obj.parent_id !== undefined ||
        rawRole === "subagent" ||
        rawRole === "advisor";
      if (isSubagent) {
        return this.normalizeSubagent(obj, sessionId, timestamp, causalRef, metadata);
      }
      const rawStatus = String(
        obj.status ?? obj.action ?? obj.lifecycleType ?? obj.exitReason ?? obj.reason ?? "",
      ).toLowerCase();
      const exitReasonStr = String(obj.exitReason ?? obj.reason ?? obj.error ?? "").toLowerCase();
      const isCrash =
        rawStatus === "crash" ||
        rawStatus === "error" ||
        rawStatus === "fatal" ||
        rawStatus === "failed" ||
        exitReasonStr === "error" ||
        exitReasonStr === "crash" ||
        exitReasonStr === "fatal" ||
        obj.error !== undefined ||
        obj.isError === true;
      const lifecycleType = isCrash ? "crash" : "end";
      const exitReason =
        asString(obj.exitReason) ??
        asString(obj.reason) ??
        asString(obj.error) ??
        asString(obj.status) ??
        (isCrash ? "error" : "completed");
      return this.normalizeLifecycle(
        { ...obj, lifecycleType, exitReason },
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
    }

    // 5. User Message / Prompt Events
    if (
      rawRole === "user" ||
      rawType === "prompt" ||
      rawType === "user" ||
      rawType === "user_message" ||
      rawType === "query"
    ) {
      return this.normalizeMessage(obj, "user", sessionId, timestamp, causalRef, metadata);
    }

    // 6. Model Reasoning / Thought Events
    if (
      rawType === "model_reasoning" ||
      rawType === "thought" ||
      rawType === "thinking" ||
      rawType === "reasoning"
    ) {
      return this.normalizeReasoning(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 7. Tool Discovery Events
    if (
      rawType === "tool_discovery" ||
      rawType === "tools_discovered" ||
      rawType === "tools_registered" ||
      rawType === "mcp_tools" ||
      (Array.isArray(obj.tools) && rawType === "tools")
    ) {
      return this.normalizeToolDiscovery(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 8. Tool Call Events
    if (
      rawType === "tool_call" ||
      rawType === "tool_use" ||
      rawType === "call" ||
      rawType === "function_call" ||
      rawRole === "tool_call" ||
      asObject(obj.toolCall) !== undefined ||
      asObject(obj.tool_call) !== undefined
    ) {
      return this.normalizeToolCall(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 9. Tool Result Events
    if (
      rawType === "tool_result" ||
      rawType === "tool_response" ||
      rawType === "tool_output" ||
      rawType === "result" ||
      rawType === "function_result" ||
      rawRole === "tool" ||
      rawRole === "tool_result" ||
      asObject(obj.toolResult) !== undefined ||
      asObject(obj.tool_result) !== undefined
    ) {
      return this.normalizeToolResult(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 10. Command Execution Events
    if (
      rawType === "command_exec" ||
      rawType === "exec" ||
      rawType === "command" ||
      rawType === "cmd" ||
      rawType === "bash" ||
      rawType === "sh"
    ) {
      return this.normalizeCommandExec(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 11. File Edit Events
    if (
      rawType === "file_edit" ||
      rawType === "patch_applied" ||
      rawType === "edit" ||
      rawType === "write" ||
      rawType === "file_write"
    ) {
      return this.normalizeFileEdit(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 12. Subagent Lifecycle Events
    if (
      rawType === "subagent_lifecycle" ||
      rawType === "subagent" ||
      rawType === "subagent_spawn" ||
      rawType === "subagent_start" ||
      rawType === "subagent_end" ||
      rawType === "subagent_complete" ||
      rawType === "subagent_settle" ||
      rawType === "advisor_yielded"
    ) {
      return this.normalizeSubagent(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 13. Compaction Events
    if (
      rawType === "compaction" ||
      rawType === "compact" ||
      rawType === "context_compaction" ||
      rawType === "context_compact" ||
      rawType === "prune" ||
      rawType === "pruned" ||
      rawType === "context_prune" ||
      rawType === "context_pruned"
    ) {
      return this.normalizeCompaction(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 14. Branch Fork Events
    if (rawType === "branch_fork" || rawType === "fork" || rawType === "branch") {
      return this.normalizeBranchFork(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 15. Error Events
    if (rawType === "error" || rawType === "exception" || rawType === "crash") {
      return this.normalizeError(obj, sessionId, timestamp, causalRef, metadata);
    }

    // 16. Assistant Message Events
    if (
      rawRole === "assistant" ||
      rawType === "assistant" ||
      rawType === "assistant_message" ||
      rawType === "response" ||
      rawType === "completion"
    ) {
      return this.normalizeMessage(obj, "assistant", sessionId, timestamp, causalRef, metadata);
    }

    // 17. System Message Events
    if (rawRole === "system" || rawType === "system" || rawType === "system_message") {
      return this.normalizeMessage(obj, "system", sessionId, timestamp, causalRef, metadata);
    }

    // Fallback: Pass through as unknown event
    const fallback: IntermediateUnknownPassthroughEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "unknown_passthrough",
      rawEventType: rawType || "unknown",
      rawPayload: obj,
    };
    // An auto-delivered background-job notice is also the result of each held bash launch it
    // reports finished; the notice itself passes through as it did.
    if (customType === OMP_ASYNC_RESULT_CUSTOM_TYPE) {
      const joined = this.joinBackgroundJobs(
        ompAsyncResultCompletions(obj.content, asObject(obj.details)),
        sessionId,
        timestamp,
        causalRef,
        metadata,
      );
      if (joined.length > 0) return [fallback, ...joined];
    }
    return fallback;
  }
  private extractPayload(record: RawHarnessRecord): OmpTranscriptValue {
    // SAFETY: Record rawPayload is decoded as an OmpTranscriptValue JSON value.
    const raw = record.rawPayload as OmpTranscriptValue;
    const str = asString(raw);
    if (str !== undefined) {
      try {
        // SAFETY: Parsed JSON string produces an arbitrary OmpTranscriptValue before normalization.
        const parsed = JSON.parse(str) as OmpTranscriptValue;
        return asObject(parsed) ?? (Array.isArray(parsed) ? parsed : undefined) ?? { text: str };
      } catch {
        return { text: str };
      }
    }
    return raw;
  }

  private extractProviderUsage(
    obj: OmpTranscriptPayload,
    recordMetadata?: OmpTranscriptPayload,
    fallbackModel?: string,
  ): ProviderReportedUsage | undefined {
    const rawUsage = findRawUsage(obj, asObject(recordMetadata));
    if (!rawUsage) {
      if (obj.unavailable === true || obj.availability === "unavailable") {
        return buildProviderUsage({}, obj, OMP_PROVIDER, fallbackModel, OMP_ACCOUNTING_VERSION);
      }
      return undefined;
    }
    return buildProviderUsage(rawUsage, obj, OMP_PROVIDER, fallbackModel, OMP_ACCOUNTING_VERSION);
  }

  private normalizeLifecycle(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSessionLifecycleEvent {
    const rawAction = String(
      asString(obj.lifecycleType) ??
        asString(obj.action) ??
        asString(obj.type) ??
        asString(obj.event) ??
        asString(obj.status) ??
        "",
    ).toLowerCase();

    const isCrash =
      rawAction === "crash" ||
      rawAction === "fatal" ||
      rawAction === "error" ||
      rawAction === "failed" ||
      obj.error !== undefined ||
      obj.isError === true;
    const isStart =
      !isCrash &&
      (rawAction === "start" ||
        rawAction === "session_start" ||
        rawAction === "session_init" ||
        rawAction === "agent_start" ||
        rawAction === "init" ||
        rawAction === "session");
    const isSuspend = !isCrash && (rawAction === "suspend" || rawAction === "pause");
    const isResume = !isCrash && rawAction === "resume";

    const lifecycleType: "start" | "end" | "pause" | "resume" | "crash" = isCrash
      ? "crash"
      : isStart
        ? "start"
        : isSuspend
          ? "pause"
          : isResume
            ? "resume"
            : "end";

    const exitReason =
      asString(obj.exitReason) ??
      asString(obj.reason) ??
      asString(obj.error) ??
      asString(obj.exit_reason) ??
      (lifecycleType === "crash"
        ? "error"
        : lifecycleType === "end"
          ? (asString(obj.status) ?? "completed")
          : undefined);
    const harnessName = asString(obj.harnessName) ?? asString(obj.harness) ?? "omp";
    const workspaceId = asString(obj.workspaceId) ?? asString(obj.workspace);

    if (lifecycleType === "end" || lifecycleType === "crash") {
      this.clearSessionToolCalls(sessionId);
    }

    const providerUsage = this.extractProviderUsage(obj, metadata);
    const evt: IntermediateSessionLifecycleEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "session_lifecycle",
      lifecycleType,
      exitReason,
      harnessName,
      workspaceId,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeMessage(
    obj: OmpTranscriptPayload,
    role: "user" | "assistant" | "system",
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSessionEvent | IntermediateSessionEvent[] {
    const embeddedCalls = role === "assistant" ? embeddedAssistantToolCalls(obj) : undefined;
    if (embeddedCalls) {
      this.cacheAssistantToolCalls(embeddedCalls, sessionId);
    }

    let content = "";
    let contentParts: MessageContentPart[] | undefined;

    const strContent = asString(obj.content);
    const strText = asString(obj.text);
    const strPrompt = asString(obj.prompt);
    const strMessage = asString(obj.message);

    if (strContent !== undefined) {
      content = strContent;
    } else if (strText !== undefined) {
      content = strText;
    } else if (strPrompt !== undefined) {
      content = strPrompt;
    } else if (strMessage !== undefined) {
      content = strMessage;
    } else {
      const partsArray = asArray(obj.content) ?? asArray(obj.parts);
      if (partsArray) {
        content = partsArray.map((part) => asString(asObject(part)?.text) ?? "").join("\n");
      } else {
        const msgObj = asObject(obj.message);
        if (msgObj) {
          content = asString(msgObj.content) ?? asString(msgObj.text) ?? JSON.stringify(msgObj);
        }
      }
    }

    const model = asString(obj.model) ?? asString(obj.modelId) ?? asString(obj.model_id);
    const stopReason = asString(obj.stopReason) ?? asString(obj.stop_reason);
    const providerUsage = this.extractProviderUsage(obj, metadata, model);
    if (stopReason) {
      metadata.stopReason = stopReason;
    }

    const evt: IntermediateMessageEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "message",
      role,
      content,
      contentParts,
      model,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }

    if (!embeddedCalls) {
      return evt;
    }
    const emittedCalls = this.emitEmbeddedToolCalls(
      embeddedCalls,
      sessionId,
      timestamp,
      causalRef,
      metadata,
    );
    return emittedCalls.length > 0 ? [evt, ...emittedCalls] : evt;
  }

  private normalizeReasoning(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateModelReasoningEvent {
    const reasoningContent =
      asString(obj.reasoningContent) ??
      asString(obj.thought) ??
      asString(obj.thinking) ??
      asString(obj.content) ??
      asString(obj.text) ??
      "";

    const signature = asString(obj.signature);
    const model = asString(obj.model);
    const tokenCount =
      asNumber(obj.tokenCount) ?? asNumber(obj.token_count) ?? asNumber(obj.tokens);
    const durationMs = asNumber(obj.durationMs) ?? asNumber(obj.duration_ms);

    const providerUsage = this.extractProviderUsage(obj, metadata, model);

    const evt: IntermediateModelReasoningEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "model_reasoning",
      reasoningContent,
      reasoningText: reasoningContent,
      signature,
      model,
      tokenCount,
      durationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeToolCall(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolCallEvent | IntermediateSessionEvent[] | null {
    const toolCallObj =
      asObject(obj.toolCall) ??
      asObject(obj.tool_call) ??
      (obj.data ? { ...obj, ...asObject(obj.data) } : obj);
    let toolName = String(
      asString(toolCallObj.toolName) ??
        asString(toolCallObj.tool_name) ??
        asString(toolCallObj.name) ??
        asString(toolCallObj.tool) ??
        "unknown_tool",
    );

    const rawCallId =
      asString(toolCallObj.callId) ??
      asString(toolCallObj.call_id) ??
      asString(toolCallObj.toolCallId) ??
      asString(toolCallObj.tool_call_id) ??
      asString(toolCallObj.id);
    const callId = normalizeCallId(rawCallId, `call_${causalRef.causalSequence}`);
    const cacheCallId = rawCallId ?? callId;

    // An assistant message already announced this exact request: the execution record must neither
    // duplicate the call nor consume the cached arguments the matching result still needs. Repeated
    // execution records for one call keep their own announcements.
    if (this.announcedToolCalls.get(sessionId, cacheCallId) === "assistant_message") {
      return null;
    }
    this.announcedToolCalls.set(sessionId, cacheCallId, "execution_record");

    const cachedName = cacheCallId
      ? this.getAndClearToolCallName(sessionId, cacheCallId)
      : undefined;

    if ((!toolName || toolName === "unknown_tool") && cachedName) {
      toolName = cachedName;
    }

    if (callId && toolName && toolName !== "unknown_tool") {
      this.setToolCallName(sessionId, callId, toolName);
    }

    const cachedArgs = cacheCallId
      ? this.getAndClearToolCallArguments(sessionId, cacheCallId)
      : undefined;

    const declaredParams =
      toolCallObj.parameters ??
      toolCallObj.params ??
      toolCallObj.input ??
      toolCallObj.arguments ??
      toolCallObj.args;

    // OMP can append a call's start marker before the assistant record and write it without the
    // call's arguments (an eval always does). Announcing the call here would record it with no
    // arguments and then deduplicate the assistant record that carries them, so the call is held
    // for that record, whatever the tool. Its result records it argument-less if no assistant
    // record comes.
    if (cachedArgs === undefined && declaredParams === undefined) {
      this.announcedToolCalls.getAndClear(sessionId, cacheCallId);
      this.pendingArgumentlessCalls.set(sessionId, cacheCallId, {
        intent: toolCallObj.intent,
      });
      return null;
    }

    let parameters: DecoderMetadataRecord;
    if (cachedArgs !== undefined) {
      parameters = cachedArgs;
    } else {
      const rawParams = declaredParams ?? {};

      let rawParamsObj = asObject(rawParams);
      if (!rawParamsObj && typeof rawParams === "string") {
        try {
          rawParamsObj = asObject(JSON.parse(rawParams));
        } catch {
          // ignore JSON parse failure
        }
      }
      parameters = rawParamsObj ?? {};
    }
    // The harness paging its own session state is not a step of the work.
    if (isHarnessInternalRead(toolName, parameters)) {
      this.skipHarnessInternalRead(sessionId, cacheCallId, "execution_record");
      return null;
    }
    const recorded = this.recordedArguments(toolName, parameters, metadata);
    parameters = recorded.parameters;
    if (recorded.metadata !== metadata) metadata.intent = recorded.metadata.intent;

    // A device-surface invocation is recorded as the tool it reached, over the connection the
    // harness's own registry resolved, not as the transport that carried it. The surface's start
    // marker names only the path; the invocation's own arguments arrive with the assistant record
    // that follows, so the call is held for it, and its result emits it if none comes. The
    // discovery goes out with this record, which carries nothing else.
    const surface = this.deviceSurfaceCallOf(toolName, parameters);
    if (
      surface !== undefined &&
      this.isResinCatalogDiscovery(toolName, surface.identity, surface.arguments)
    ) {
      return [
        this.deviceSurfaceDiscovery(surface.identity, sessionId, timestamp, causalRef, metadata),
      ];
    }
    if (surface !== undefined && surface.arguments === undefined) {
      this.announcedToolCalls.getAndClear(sessionId, cacheCallId);
      this.setToolCallName(sessionId, callId, surface.identity.tool);
      this.pendingDeviceSurfaceCalls.set(sessionId, cacheCallId, surface.identity);
      return [
        this.deviceSurfaceDiscovery(surface.identity, sessionId, timestamp, causalRef, metadata),
      ];
    }

    if (toolCallObj.intent !== undefined && metadata.intent === undefined) {
      metadata.intent = toolCallObj.intent;
    }

    const providerUsage = this.extractProviderUsage(obj, metadata);
    const evt: IntermediateToolCallEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata: this.withEvalSourceInterface(toolName, parameters, metadata),
      type: "tool_call",
      toolName,
      callId,
      toolCallId: callId,
      parameters,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    if (surface !== undefined) {
      return this.asDeviceSurfaceCall(evt, surface.identity, surface.arguments);
    }
    // A wait on the harness's own background jobs is settled by its result.
    return this.holdJobJoinCall(sessionId, evt) ? null : evt;
  }

  private normalizeToolResult(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolResultEvent | IntermediateSessionEvent[] | null {
    const toolResultObj = asObject(obj.toolResult) ?? asObject(obj.tool_result) ?? obj;

    const rawCallId =
      asString(toolResultObj.callId) ??
      asString(toolResultObj.call_id) ??
      asString(toolResultObj.toolCallId) ??
      asString(toolResultObj.tool_call_id) ??
      asString(toolResultObj.id);
    const callId = normalizeCallId(rawCallId, `call_${causalRef.causalSequence}`);
    // The result of a harness-internal read was never a call's result: recording it would leave an
    // orphan result for a call the session does not record.
    if (this.consumeHarnessInternalRead(sessionId, rawCallId, callId)) return null;
    const pendingSurface = rawCallId
      ? this.pendingDeviceSurfaceCalls.getAndClear(sessionId, rawCallId)
      : undefined;
    const heldCall = rawCallId
      ? this.pendingArgumentlessCalls.getAndClear(sessionId, rawCallId)
      : undefined;
    const resultSurface = this.deviceSurfaceResultCalls.getAndClear(sessionId, callId);
    // OMP may append the argument-less start marker before the assistant record. At result time,
    // consume those genuinely observed late arguments by RAW id (which can contain a pipe suffix).
    const lateArgs = rawCallId
      ? this.getAndClearToolCallArguments(sessionId, rawCallId)
      : undefined;
    const lateName = rawCallId ? this.getAndClearToolCallName(sessionId, rawCallId) : undefined;

    let toolName = String(
      asString(toolResultObj.toolName) ??
        asString(toolResultObj.tool_name) ??
        asString(toolResultObj.name) ??
        asString(toolResultObj.tool) ??
        "",
    );

    if (!toolName || toolName === "unknown_tool") {
      const correlated = lateName ?? this.getAndClearToolCallName(sessionId, callId);
      if (correlated) {
        toolName = correlated;
      } else {
        toolName = "unknown_tool";
      }
    } else {
      // A device-surface result names the transport that carried the call (a `write` or the `read`
      // that reaches a callable taking no arguments), not the tool the call reached: the name the
      // call itself recorded is the one to keep.
      if (
        (toolName === OMP_DEVICE_SURFACE_WRITE_TOOL || toolName === OMP_DEVICE_SURFACE_READ_TOOL) &&
        lateName !== undefined
      ) {
        toolName = lateName;
      }
      this.getAndClearToolCallName(sessionId, callId);
    }
    let rawResult =
      toolResultObj.result ??
      toolResultObj.output ??
      toolResultObj.content ??
      toolResultObj.data ??
      toolResultObj.response;
    if (resultSurface !== undefined) rawResult = deviceSurfaceResultValue(rawResult);

    if (Array.isArray(rawResult)) {
      const allText = rawResult
        .map((p) => asString(asObject(p)?.text) ?? asString(asObject(p)?.content) ?? "")
        .filter((t) => t.length > 0);
      if (allText.length > 0 && allText.length === rawResult.length) {
        rawResult = allText.join("\n");
      }
    }

    const isError = Boolean(
      toolResultObj.isError ||
        toolResultObj.is_error ||
        toolResultObj.error ||
        asString(toolResultObj.status)?.toLowerCase() === "error",
    );

    const errorStr =
      asString(toolResultObj.error) ??
      asString(toolResultObj.errorMessage) ??
      asString(toolResultObj.error_message) ??
      (isError && typeof rawResult === "string" ? rawResult : undefined);

    const details = asObject(toolResultObj.details);
    const executionDurationMs =
      asNumber(toolResultObj.executionDurationMs) ??
      asNumber(toolResultObj.execution_duration_ms) ??
      asNumber(toolResultObj.durationMs) ??
      asNumber(toolResultObj.duration_ms) ??
      asNumber(details?.wallTimeMs) ??
      asNumber(details?.durationMs) ??
      0;

    const providerUsage = this.extractProviderUsage(obj, metadata);
    // Only a bash run that finished in the foreground reported its exit status: OMP's bash tool
    // reports an error for any non-zero exit, but an async, auto-backgrounded, service or timed-out
    // run returns before the command finishes, with no error and no status.
    const completedBash =
      toolName === "bash" &&
      !isError &&
      details !== undefined &&
      !["async", "service", "timedOut", "background", "job", "daemon"].some((key) =>
        Object.hasOwn(details, key),
      );
    const nativeArguments =
      toolName === "eval" && lateName === "eval" ? boundedNativeArguments(lateArgs) : undefined;
    // Only the decoder proves a completed run; a key a record carried itself is dropped.
    const { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: _forged, ...unproven } = metadata;
    const resultMetadata = completedBash
      ? { ...unproven, [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-bash-completed" }
      : unproven;
    const eventMetadata =
      nativeArguments === undefined
        ? resultMetadata
        : {
            ...resultMetadata,
            [RESIN_LOCAL_OMP_NATIVE_CALL_KEY]: {
              callId,
              toolName,
              parameters: nativeArguments,
            },
          };

    const evt: IntermediateToolResultEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata: eventMetadata,
      type: "tool_result",
      toolName,
      callId,
      toolCallId: callId,
      result: rawResult,
      isError,
      error: isError ? errorStr : undefined,
      executionDurationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    // A device-surface call whose arguments never arrived is still recorded, when its result is:
    // an invocation that ran is not dropped because the record that carried its arguments did not.
    // A call held at its argument-less start marker whose assistant record never came is likewise
    // recorded when its result is, with the only arguments any record carried: none.
    const lateCall: IntermediateToolCallEvent | undefined =
      pendingSurface !== undefined
        ? this.asDeviceSurfaceCall(
            {
              sessionId,
              timestamp,
              schemaVersion: "1.0.0",
              causalRef,
              metadata: eventMetadata,
              type: "tool_call",
              toolName: OMP_DEVICE_SURFACE_WRITE_TOOL,
              callId,
              toolCallId: callId,
              parameters: {},
            },
            pendingSurface,
            undefined,
          )
        : heldCall !== undefined
          ? {
              sessionId,
              timestamp,
              schemaVersion: "1.0.0",
              causalRef,
              metadata:
                heldCall.intent !== undefined && unproven.intent === undefined
                  ? { ...unproven, intent: heldCall.intent }
                  : unproven,
              type: "tool_call",
              toolName,
              callId,
              toolCallId: callId,
              parameters: {},
            }
          : undefined;

    // Any record listing background jobs may report one finished (a `wait`, or a `hub` snapshot
    // or cancellation): the call that launched it gets its result here.
    const joined = this.joinBackgroundJobs(
      ompJobReportCompletions(details),
      sessionId,
      timestamp,
      causalRef,
      metadata,
    );
    const joinCall =
      this.heldJobJoinCalls.getAndClear(sessionId, callId) ??
      (lateCall !== undefined &&
      pendingSurface === undefined &&
      isOmpJobJoinCall(lateCall.toolName, lateCall.parameters)
        ? lateCall
        : undefined);
    // A wait that only reports background jobs is the harness's bookkeeping, not a step of the
    // work: neither it nor its result is recorded, and a repeated record of that result is dropped
    // too. The jobs it joined are recorded as their launching calls' results.
    if (joinCall !== undefined && isOmpJobReportOnly(details, isError) && !providerUsage) {
      this.harnessInternalReads.set(sessionId, rawCallId ?? callId, true);
      return joined.length > 0 ? joined : null;
    }
    // A background launch's acknowledgement is not its result: the job's completion is (see
    // `joinBackgroundJobs`), so it is held until a record reports the job finished.
    const launchedJobId = providerUsage
      ? undefined
      : ompBackgroundLaunchJobId(toolName, details, isError);
    if (launchedJobId !== undefined) {
      this.backgroundJobs.set(sessionId, launchedJobId, { callId, toolName });
    }
    const call = lateCall ?? joinCall;
    const events: IntermediateSessionEvent[] = [
      ...(call === undefined ? [] : [call]),
      ...(launchedJobId === undefined ? [evt] : []),
      ...joined,
    ];
    if (events.length === 0) return null;
    return events.length === 1 && events[0] === evt ? evt : events;
  }

  private normalizeCommandExec(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateCommandExecEvent {
    const command = String(asString(obj.command) ?? asString(obj.cmd) ?? "");
    const argsArray = asArray(obj.args);
    const args = argsArray ? argsArray.map((a) => asString(a) ?? String(a)) : undefined;
    const workingDirectory = asString(obj.workingDirectory) ?? asString(obj.cwd);
    const exitCode = asNumber(obj.exitCode) ?? asNumber(obj.exit_code) ?? 0;
    const stdout = asString(obj.stdout) ?? asString(obj.output);
    const stderr = asString(obj.stderr);
    const durationMs =
      asNumber(obj.durationMs) ??
      asNumber(obj.duration_ms) ??
      asNumber(obj.executionDurationMs) ??
      0;

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateCommandExecEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "command_exec",
      command,
      args,
      workingDirectory,
      exitCode,
      stdout,
      stderr,
      durationMs,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeFileEdit(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateFileEditEvent {
    const filePath = String(
      asString(obj.filePath) ??
        asString(obj.file_path) ??
        asString(obj.path) ??
        asString(obj.file) ??
        "",
    );

    const rawOp = String(asString(obj.operation) ?? asString(obj.op) ?? "patch").toLowerCase();
    const operation: "create" | "update" | "delete" | "patch" | "read" =
      rawOp === "create" || rawOp === "delete" || rawOp === "patch" || rawOp === "read"
        ? rawOp
        : rawOp === "modify" || rawOp === "update"
          ? "update"
          : "patch";

    const patch = asString(obj.patch) ?? asString(obj.diff);
    const beforeHash = asString(obj.beforeHash) ?? asString(obj.before_hash);
    const afterHash = asString(obj.afterHash) ?? asString(obj.after_hash);

    const rawDiffStats = asObject(obj.diffStats) ?? asObject(obj.diff_stats);
    // SAFETY: Raw diff stats are preserved as FileDiffStats record on intermediate event.
    const diffStats = rawDiffStats as FileDiffStats | undefined;

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateFileEditEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "file_edit",
      filePath,
      operation,
      patch,
      beforeHash,
      afterHash,
      diffStats,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeSubagent(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateSubagentLifecycleEvent {
    const subagentId = String(
      asString(obj.subagentId) ??
        asString(obj.subagent_id) ??
        asString(obj.id) ??
        `subagent_${causalRef.causalSequence}`,
    );

    const rawLType = String(
      asString(obj.lifecycleType) ??
        asString(obj.action) ??
        asString(obj.type) ??
        asString(obj.event) ??
        "spawn",
    ).toLowerCase();

    const lifecycleType:
      | "spawn"
      | "start"
      | "pause"
      | "resume"
      | "terminate"
      | "settle"
      | "end"
      | "crash" =
      rawLType === "spawn" || rawLType === "subagent_spawn"
        ? "spawn"
        : rawLType === "start" || rawLType === "subagent_start" || rawLType === "agent_start"
          ? "start"
          : rawLType === "settle" ||
              rawLType === "subagent_settle" ||
              rawLType === "complete" ||
              rawLType === "subagent_complete" ||
              rawLType === "advisor_yielded"
            ? "settle"
            : rawLType === "pause" || rawLType === "subagent_pause"
              ? "pause"
              : rawLType === "resume" || rawLType === "subagent_resume"
                ? "resume"
                : rawLType === "crash" ||
                    rawLType === "subagent_crash" ||
                    rawLType === "terminate" ||
                    rawLType === "subagent_terminate" ||
                    rawLType === "subagent_end" ||
                    rawLType === "agent_end" ||
                    rawLType === "end"
                  ? "terminate"
                  : "spawn";

    const parentId =
      asString(obj.parentId) ??
      asString(obj.parent_id) ??
      asString(obj.parentSessionId) ??
      asString(obj.parent_session_id) ??
      sessionId;
    const role = asString(obj.role);
    const reason =
      asString(obj.reason) ?? asString(obj.resultSummary) ?? asString(obj.result_summary);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateSubagentLifecycleEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "subagent_lifecycle",
      subagentId,
      lifecycleType,
      parentId,
      role,
      reason,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeCompaction(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateCompactionEvent {
    const rawReason = String(
      asString(obj.triggerReason) ?? asString(obj.reason) ?? "context_limit",
    ).toLowerCase();
    const triggerReason: "context_limit" | "manual" | "scheduled" =
      rawReason === "manual" || rawReason === "scheduled" ? rawReason : "context_limit";

    const tokensBefore =
      asNumber(obj.tokensBefore) ??
      asNumber(obj.tokens_before) ??
      asNumber(obj.originalTokenCount) ??
      0;

    const tokensAfter =
      asNumber(obj.tokensAfter) ??
      asNumber(obj.tokens_after) ??
      asNumber(obj.compactedTokenCount) ??
      0;

    const preservedContextSummary =
      asString(obj.preservedContextSummary) ?? asString(obj.summary) ?? asString(obj.text);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateCompactionEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "compaction",
      triggerReason,
      tokensBefore,
      tokensAfter,
      preservedContextSummary,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeBranchFork(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateBranchForkEvent {
    const sourceSessionId =
      asString(obj.sourceSessionId) ?? asString(obj.source_session_id) ?? sessionId;

    const branchName = asString(obj.branchName) ?? asString(obj.branch_name);
    const branchPointEventId =
      asString(obj.branchPointEventId) ?? asString(obj.branch_point_event_id);

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateBranchForkEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "branch_fork",
      sourceSessionId,
      branchName,
      branchPointEventId,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeError(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateErrorEvent {
    const errorType = String(
      asString(obj.errorType) ??
        asString(obj.error_type) ??
        asString(obj.name) ??
        asString(obj.errorCode) ??
        "OmpRuntimeError",
    );

    const message = String(
      asString(obj.message) ??
        asString(obj.errorMessage) ??
        asString(obj.error) ??
        "Unknown runtime error",
    );

    const stack = asString(obj.stack);
    const recoverable = Boolean(obj.recoverable ?? true);
    const providerUsage = this.extractProviderUsage(obj, metadata);

    const evt: IntermediateErrorEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "error",
      errorType,
      message,
      stack,
      recoverable,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }

  private normalizeToolDiscovery(
    obj: OmpTranscriptPayload,
    sessionId: string,
    timestamp: string,
    causalRef: CausalRefInput,
    metadata: OmpTranscriptPayload,
  ): IntermediateToolDiscoveryEvent {
    const rawTools = asArray(obj.tools) ?? asArray(obj.tool_list) ?? [];
    const tools: DiscoveredToolEntry[] = rawTools.map((t: OmpTranscriptValue) => {
      const item = asObject(t) ?? {};
      const paramsObj = asObject(item.parameters) ?? asObject(item.inputSchema) ?? {};
      return {
        name: String(asString(item.name) || asString(item.id) || "unknown_tool"),
        description: asString(item.description),
        inputSchema: paramsObj,
        // A tool's provider is the connection it was reached over. The harness id is not one: a
        // record that names no connection leaves the entry without one, never with a guess.
        provider: asString(item.provider),
      };
    });

    const providerUsage = this.extractProviderUsage(obj, metadata);

    const rawSource = asString(obj.source);
    const source: "mcp" | "builtin" | "dynamic" | "harness" =
      rawSource === "mcp" ||
      rawSource === "builtin" ||
      rawSource === "dynamic" ||
      rawSource === "harness"
        ? rawSource
        : "harness";

    const evt: IntermediateToolDiscoveryEvent = {
      sessionId,
      timestamp,
      schemaVersion: "1.0.0",
      causalRef,
      metadata,
      type: "tool_discovery",
      tools,
      provider: asString(obj.provider),
      source,
    };
    if (providerUsage) {
      evt.providerUsage = providerUsage;
    }
    return evt;
  }
}
