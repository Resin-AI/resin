import { randomUUID } from "node:crypto";
import {
  RESIN_INVOCATION_RECEIPT_META_KEY,
  ResinBenchmarkIdSchema,
  type ResinInvocationReceipt,
  formatResinInvocationReceiptText,
  parseResinInvocationReceiptText,
  resinInvocationReceiptMeta,
} from "@resin/contracts";
import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcErrorData,
  McpProtocolError,
  isMcpProtocolError,
} from "../protocol/errors.js";
import type { CallToolResult, McpTextContent } from "../protocol/types.js";

/**
 * A recorded invocation's id. Generated once per call, before the result is returned, so the record
 * and the receipt the caller gets carry the same id.
 */
export function newInvocationId(): string {
  return `inv_${randomUUID().replace(/-/g, "")}`;
}

/** The benchmark id `value` names, trimmed, or undefined when it is not a valid one. */
export function benchmarkIdOf(value: unknown): string | undefined {
  const parsed = ResinBenchmarkIdSchema.safeParse(typeof value === "string" ? value.trim() : value);
  return parsed.success ? parsed.data : undefined;
}

export function invocationReceipt(
  invocationId: string,
  benchmarkId: string | undefined,
): ResinInvocationReceipt {
  return benchmarkId === undefined ? { invocationId } : { invocationId, benchmarkId };
}

/**
 * `result` as the caller receives it once recorded: its own content, `isError` and `_meta` kept, the
 * receipt added under `_meta` and as one compact text part after the content, for harnesses that
 * keep only text.
 */
export function withInvocationReceipt(
  result: CallToolResult,
  receipt: ResinInvocationReceipt,
): CallToolResult {
  return {
    ...result,
    content: [...result.content, { type: "text", text: formatResinInvocationReceiptText(receipt) }],
    _meta: {
      ...result._meta,
      [RESIN_INVOCATION_RECEIPT_META_KEY]: { ...resinInvocationReceiptMeta(receipt) },
    },
  };
}

/**
 * `result` without the receipt {@link withInvocationReceipt} added, and that receipt's text part.
 * A result without one, or whose last part does not match its `_meta` receipt, is returned as is.
 */
export function splitInvocationReceipt(result: CallToolResult): {
  result: CallToolResult;
  receiptPart?: McpTextContent;
} {
  const meta = result._meta?.[RESIN_INVOCATION_RECEIPT_META_KEY];
  const last = result.content[result.content.length - 1];
  if (meta === undefined || last?.type !== "text") return { result };
  const receipt = parseResinInvocationReceiptText(last.text);
  if (
    receipt === undefined ||
    JSON.stringify(resinInvocationReceiptMeta(receipt)) !== JSON.stringify(meta)
  ) {
    return { result };
  }
  const { [RESIN_INVOCATION_RECEIPT_META_KEY]: _receipt, ...otherMeta } = result._meta!;
  const { _meta: _dropped, ...rest } = result;
  return {
    result: {
      ...rest,
      content: result.content.slice(0, -1),
      ...(Object.keys(otherMeta).length > 0 ? { _meta: otherMeta } : {}),
    },
    receiptPart: last,
  };
}

/**
 * The error a recorded call that threw reaches the caller as: the same JSON-RPC code and message,
 * with the receipt's fields (`resinInvocationId`, `benchmarkId`) added to its `data`. Error data
 * that is not an object cannot take fields, so that error is returned unchanged.
 */
export function withErrorInvocationReceipt(
  error: unknown,
  receipt: ResinInvocationReceipt,
): unknown {
  const candidate = error instanceof Error ? error : String(error);
  const code = isMcpProtocolError(candidate) ? candidate.code : JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
  const message = candidate instanceof Error ? candidate.message : candidate;
  const data = isMcpProtocolError(candidate) ? candidate.data : undefined;
  if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
    return error;
  }
  const receiptData: JsonRpcErrorData = {
    ...(data as Record<string, string | number | boolean | null | undefined> | undefined),
    resinInvocationId: receipt.invocationId,
    ...(receipt.benchmarkId === undefined ? {} : { benchmarkId: receipt.benchmarkId }),
  };
  const receipted = new McpProtocolError(code, message, receiptData);
  if (error instanceof Error && error.stack !== undefined) receipted.stack = error.stack;
  return receipted;
}

/** The receipt text part {@link withErrorInvocationReceipt} put on a thrown error, if any. */
export function errorInvocationReceiptPart(error: unknown): McpTextContent | undefined {
  if (!(error instanceof McpProtocolError)) return undefined;
  const data = error.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { resinInvocationId, benchmarkId } = data as Record<string, unknown>;
  if (typeof resinInvocationId !== "string") return undefined;
  const text = formatResinInvocationReceiptText(
    invocationReceipt(resinInvocationId, typeof benchmarkId === "string" ? benchmarkId : undefined),
  );
  return parseResinInvocationReceiptText(text) === undefined ? undefined : { type: "text", text };
}
