import { z } from "zod";
import { ProviderUsageRequestIdSchema } from "./events.js";

/**
 * Model-request link contract.
 *
 * Decoders put these identifiers on normalized session event metadata so the observer and the cloud
 * can join a tool call, its result, the model request that issued it, the user task it belongs to
 * and the Resin invocation the gateway recorded for it, without guessing from timing or names:
 * - `modelRequestId`: the issuing request's `ProviderReportedUsage.requestId`, on every event a
 *   model response produced (assistant message, reasoning, tool call) and on tool results whose
 *   issuing request the decoder knows.
 * - `modelRequestPurpose`: on the usage event of an auxiliary request the harness made outside the
 *   conversation (a judge, title or cache-warm call). Such requests are real model requests and
 *   count like any other; their provider and model may differ from the session's.
 * - `taskId`: the source's own id for the preceding user prompt record, on that prompt and on every
 *   later event of the session until the next prompt. Unknown (absent) rather than guessed.
 * - `resinInvocationId` / `resinInvocationIds`: copied from a validated Resin invocation receipt
 *   on the result of a Resin tool call.
 * - `benchmarkId`: an explicit benchmark run classification on any task event, independent of
 *   invocation receipts. It does not authorize a request or establish task/invocation identity.
 * - `delegatedModelUsage`: on the result of a tool call that started subagents, the aggregate usage
 *   the harness reported for them, as evidence of usage counted in other sessions.
 */

/** Metadata key: the `requestId` of the model request that issued the event. */
export const RESIN_MODEL_REQUEST_ID_METADATA_KEY = "modelRequestId" as const;
/** Metadata key: the source id of the user prompt that started the event's task. */
export const RESIN_TASK_ID_METADATA_KEY = "taskId" as const;
/** Metadata key: the one Resin invocation a tool result reports. */
export const RESIN_INVOCATION_ID_METADATA_KEY = "resinInvocationId" as const;
/** Metadata key: the Resin invocations, in order, of a tool result that reports several runs. */
export const RESIN_INVOCATION_IDS_METADATA_KEY = "resinInvocationIds" as const;
/** Metadata key: the explicitly labeled benchmark run an event belongs to, without requiring a receipt. */
export const RESIN_BENCHMARK_ID_METADATA_KEY = "benchmarkId" as const;
/**
 * Metadata key: why the harness made an auxiliary model request outside the conversation (for
 * example OMP's `auto-thinking` judge or `cache-warm`). Absent on the conversation's own requests.
 */
export const RESIN_MODEL_REQUEST_PURPOSE_METADATA_KEY = "modelRequestPurpose" as const;

/** Most receipts one tool result may report (one per recorded run). */
export const RESIN_INVOCATION_RECEIPTS_MAX = 64;

/** Task ids are opaque source record ids with the same bounds as request ids. */
export const ResinTaskIdSchema = ProviderUsageRequestIdSchema;
export const ResinInvocationIdSchema = z.string().regex(/^inv_[0-9a-f]{32}$/);
export const ResinBenchmarkIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
/** A harness's own short label for an auxiliary request's purpose. */
export const ResinModelRequestPurposeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);

const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Metadata key: model usage a harness reports for subagents a tool call delegated work to. */
export const RESIN_DELEGATED_MODEL_USAGE_METADATA_KEY = "delegatedModelUsage" as const;
export const DELEGATED_MODEL_USAGE_VERSION = 1 as const;

/**
 * The harness's own aggregate of the model usage spent by the subagents one tool call started (for
 * example OMP's `task` result `details.usage`), with request-category meaning: uncached input,
 * cache reads, cache writes, output including reasoning. It is evidence only, never a request:
 * it is never added to request sums. Each subagent's requests are counted in its own captured
 * session, which names this session as its parent; when those sessions were not captured, this
 * record is the explicit gap that keeps the parent's coverage partial.
 */
export const DelegatedModelUsageSchema = z
  .object({
    version: z.literal(DELEGATED_MODEL_USAGE_VERSION),
    inputTokens: TokenCountSchema.optional(),
    cachedInputTokens: TokenCountSchema.optional(),
    cacheWriteTokens: TokenCountSchema.optional(),
    outputTokens: TokenCountSchema.optional(),
    reasoningTokens: TokenCountSchema.optional(),
    totalTokens: TokenCountSchema.optional(),
    costMicroUsd: TokenCountSchema.optional(),
    costProvenance: z.enum(["source_reported", "harness_estimate", "unpriced"]).optional(),
  })
  .strict();
export type DelegatedModelUsage = z.infer<typeof DelegatedModelUsageSchema>;

/** `_meta` key under which the gateway reports the invocation a single-run result recorded. */
export const RESIN_INVOCATION_RECEIPT_META_KEY = "resin/invocation" as const;
export const RESIN_INVOCATION_RECEIPT_VERSION = 1 as const;

export const ResinInvocationReceiptMetaSchema = z
  .object({
    version: z.literal(RESIN_INVOCATION_RECEIPT_VERSION),
    invocationId: ResinInvocationIdSchema,
    benchmarkId: ResinBenchmarkIdSchema.optional(),
  })
  .strict();
export type ResinInvocationReceiptMeta = z.infer<typeof ResinInvocationReceiptMetaSchema>;

const ResinInvocationReceiptTextSchema = z
  .object({
    resinInvocationId: ResinInvocationIdSchema,
    benchmarkId: ResinBenchmarkIdSchema.optional(),
  })
  .strict();

/** One recorded Resin invocation, as a gateway receipt reports it. */
export interface ResinInvocationReceipt {
  invocationId: string;
  benchmarkId?: string;
}

/**
 * The compact text part the gateway appends after a result's content for each recorded run, so
 * harnesses that keep only text still carry it: `{"resinInvocationId":…,"benchmarkId"?:…}`.
 */
export function formatResinInvocationReceiptText(receipt: ResinInvocationReceipt): string {
  return JSON.stringify(
    receipt.benchmarkId === undefined
      ? { resinInvocationId: receipt.invocationId }
      : { resinInvocationId: receipt.invocationId, benchmarkId: receipt.benchmarkId },
  );
}

/** The `_meta[RESIN_INVOCATION_RECEIPT_META_KEY]` value of a single-run result. */
export function resinInvocationReceiptMeta(
  receipt: ResinInvocationReceipt,
): ResinInvocationReceiptMeta {
  return receipt.benchmarkId === undefined
    ? { version: RESIN_INVOCATION_RECEIPT_VERSION, invocationId: receipt.invocationId }
    : {
        version: RESIN_INVOCATION_RECEIPT_VERSION,
        invocationId: receipt.invocationId,
        benchmarkId: receipt.benchmarkId,
      };
}

/**
 * Parses one receipt text part. Only the exact canonical text counts: anything else, including the
 * same fields with other spacing or key order, is ordinary output and yields undefined.
 */
export function parseResinInvocationReceiptText(text: string): ResinInvocationReceipt | undefined {
  if (!text.startsWith('{"resinInvocationId":')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ResinInvocationReceiptTextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const receipt: ResinInvocationReceipt =
    parsed.data.benchmarkId === undefined
      ? { invocationId: parsed.data.resinInvocationId }
      : { invocationId: parsed.data.resinInvocationId, benchmarkId: parsed.data.benchmarkId };
  return formatResinInvocationReceiptText(receipt) === text ? receipt : undefined;
}

/** A `{type:"text", text}` content part; other part kinds are never receipts. */
const TextContentPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();

/** An MCP tool result as harnesses record it: content parts and optional protocol `_meta`. */
const RecordedToolResultSchema = z
  .object({ content: z.array(z.unknown()), _meta: z.record(z.unknown()).optional() })
  .passthrough();

const MetadataRecordSchema = z.record(z.unknown());

function textPartOf(part: unknown): string | undefined {
  const parsed = TextContentPartSchema.safeParse(part);
  return parsed.success ? parsed.data.text : undefined;
}

/** Receipts of the trailing contiguous receipt parts of a content list, in content order. */
function trailingReceipts(texts: readonly (string | undefined)[]): ResinInvocationReceipt[] {
  const receipts: ResinInvocationReceipt[] = [];
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index];
    const receipt = text === undefined ? undefined : parseResinInvocationReceiptText(text);
    if (receipt === undefined) break;
    receipts.push(receipt);
    if (receipts.length > RESIN_INVOCATION_RECEIPTS_MAX) return [];
  }
  return receipts.reverse();
}

/**
 * Every Resin invocation a tool result reports, in run order. A caller must already know the result
 * belongs to a Resin tool call; this never searches ordinary output for receipts.
 *
 * `result` is the result as the harness recorded it: an MCP result (`{content, _meta?}`), its
 * content part list, or, for harnesses that keep only text, the joined text, whose trailing lines
 * stand in for the trailing parts. Receipts are the trailing contiguous parts whose whole text is a
 * canonical receipt. When `_meta` reports an invocation, exactly one such part must agree with it.
 * Disagreeing or malformed receipts yield none: an unknown link is safer than a wrong one.
 */
export function readResinInvocationReceipts(result: unknown): ResinInvocationReceipt[] {
  let texts: (string | undefined)[];
  let meta: unknown;
  if (typeof result === "string") {
    texts = result.split("\n");
  } else if (Array.isArray(result)) {
    texts = result.map(textPartOf);
  } else {
    const recorded = RecordedToolResultSchema.safeParse(result);
    if (!recorded.success) return [];
    texts = recorded.data.content.map(textPartOf);
    meta = recorded.data._meta?.[RESIN_INVOCATION_RECEIPT_META_KEY];
  }
  const receipts = trailingReceipts(texts);
  const benchmarkId = receipts[0]?.benchmarkId;
  if (receipts.some((receipt) => receipt.benchmarkId !== benchmarkId)) return [];
  if (meta === undefined) return receipts;
  const parsedMeta = ResinInvocationReceiptMetaSchema.safeParse(meta);
  const only = receipts.length === 1 ? receipts[0] : undefined;
  if (
    !parsedMeta.success ||
    only === undefined ||
    only.invocationId !== parsedMeta.data.invocationId ||
    only.benchmarkId !== parsedMeta.data.benchmarkId
  ) {
    return [];
  }
  return receipts;
}

/** The single Resin invocation a tool result reports, or undefined when it reports none or several. */
export function readResinInvocationReceipt(result: unknown): ResinInvocationReceipt | undefined {
  const receipts = readResinInvocationReceipts(result);
  return receipts.length === 1 ? receipts[0] : undefined;
}

/**
 * Request-link metadata an event may carry, keyed by the metadata keys above. Producers spread it
 * into event metadata; consumers read it back through `readRequestLinkMetadata`.
 */
export interface RequestLinkMetadata {
  modelRequestId?: string;
  modelRequestPurpose?: string;
  taskId?: string;
  resinInvocationId?: string;
  resinInvocationIds?: string[];
  benchmarkId?: string;
  delegatedModelUsage?: DelegatedModelUsage;
}

/**
 * Metadata for the Resin invocations a tool result reports: `resinInvocationId` for one run,
 * `resinInvocationIds` for several, and their shared `benchmarkId`. Empty when there are none.
 */
export function resinInvocationReceiptMetadata(
  receipts: readonly ResinInvocationReceipt[],
): RequestLinkMetadata {
  const first = receipts[0];
  if (first === undefined) return {};
  const metadata: RequestLinkMetadata =
    receipts.length === 1
      ? { resinInvocationId: first.invocationId }
      : { resinInvocationIds: receipts.map((receipt) => receipt.invocationId) };
  if (first.benchmarkId !== undefined) metadata.benchmarkId = first.benchmarkId;
  return metadata;
}

/**
 * Fail-closed reader for request-link metadata from untrusted event metadata: each identifier is kept
 * only when it matches its schema, and invocation ids only in one of their two valid shapes.
 */
export function readRequestLinkMetadata(value: unknown): RequestLinkMetadata {
  const record = MetadataRecordSchema.safeParse(value);
  if (!record.success) return {};
  const metadata = record.data;
  const link: RequestLinkMetadata = {};
  const modelRequestId = ProviderUsageRequestIdSchema.safeParse(
    metadata[RESIN_MODEL_REQUEST_ID_METADATA_KEY],
  );
  if (modelRequestId.success) link.modelRequestId = modelRequestId.data;
  const purpose = ResinModelRequestPurposeSchema.safeParse(
    metadata[RESIN_MODEL_REQUEST_PURPOSE_METADATA_KEY],
  );
  if (purpose.success) link.modelRequestPurpose = purpose.data;
  const taskId = ResinTaskIdSchema.safeParse(metadata[RESIN_TASK_ID_METADATA_KEY]);
  if (taskId.success) link.taskId = taskId.data;
  const benchmarkId = ResinBenchmarkIdSchema.safeParse(metadata[RESIN_BENCHMARK_ID_METADATA_KEY]);
  if (benchmarkId.success) link.benchmarkId = benchmarkId.data;
  const delegated = DelegatedModelUsageSchema.safeParse(
    metadata[RESIN_DELEGATED_MODEL_USAGE_METADATA_KEY],
  );
  if (delegated.success) link.delegatedModelUsage = { ...delegated.data };
  const invocationId = ResinInvocationIdSchema.safeParse(
    metadata[RESIN_INVOCATION_ID_METADATA_KEY],
  );
  const invocationIds = z
    .array(ResinInvocationIdSchema)
    .min(2)
    .max(RESIN_INVOCATION_RECEIPTS_MAX)
    .safeParse(metadata[RESIN_INVOCATION_IDS_METADATA_KEY]);
  // A result reports one run or several, never both shapes at once.
  if (invocationId.success !== invocationIds.success) {
    if (invocationId.success) link.resinInvocationId = invocationId.data;
    if (invocationIds.success) link.resinInvocationIds = [...invocationIds.data];
  }
  return link;
}

/**
 * Whether a tool call reaches Resin's gateway, however the harness names it: `mcp__resin__<tool>`
 * (Codex, Claude), `mcp__resin_<tool>` (OMP) or `resin__<tool>`, or any name over connection
 * `resin`. Only such results may carry an invocation receipt.
 */
export function isResinGatewayToolCall(toolName: string, connection?: string): boolean {
  return connection === "resin" || /^(?:mcp__resin_{1,2}|resin__)[A-Za-z0-9]/.test(toolName);
}
