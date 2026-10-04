import { type InvocationFailureReason, InvocationFailureReasonSchema } from "@resin/contracts";
import { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpProtocolError } from "../protocol/errors.js";
import type { CallToolResult } from "../protocol/types.js";

/**
 * `_meta` key on a failed `CallToolResult` naming why it failed. Executors set it where they know
 * the cause; the invocation record carries it to the cloud as `errorDetails.reason`.
 */
export const FAILURE_REASON_META_KEY = "resinFailureReason";

/** A failed result whose cause is known to the code that produced it. */
export function failedToolResult(reason: InvocationFailureReason, text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
    _meta: { [FAILURE_REASON_META_KEY]: reason },
  };
}

/** Why a failed result failed: its executor's stated reason, else a tool-reported failure. */
export function failureReasonOfResult(result: CallToolResult): InvocationFailureReason {
  if (result._meta?.refusal) return "capability_rejected";
  const stated = InvocationFailureReasonSchema.safeParse(result._meta?.[FAILURE_REASON_META_KEY]);
  return stated.success ? stated.data : "tool_error";
}

/** Why a thrown invocation failed, from the protocol error code the routing layer raised. */
export function failureReasonOfError(error: unknown): InvocationFailureReason {
  if (!(error instanceof McpProtocolError)) return "tool_error";
  switch (error.code) {
    case MCP_ERROR_CODES.REQUEST_TIMEOUT:
      return "timeout";
    case MCP_ERROR_CODES.CANCELLED:
      return "cancelled";
    case JSON_RPC_ERROR_CODES.INVALID_PARAMS:
      return "validation_error";
    case MCP_ERROR_CODES.TOOL_NOT_FOUND:
    case MCP_ERROR_CODES.RESOURCE_NOT_FOUND:
      return "tool_unavailable";
    case MCP_ERROR_CODES.CONNECTION_CLOSED:
    case MCP_ERROR_CODES.UNAUTHORIZED:
    case MCP_ERROR_CODES.RATE_LIMITED:
    case MCP_ERROR_CODES.CONCURRENCY_LIMIT_EXCEEDED:
      return "runtime_unavailable";
    default:
      return "tool_error";
  }
}

/** The record status a failure reason implies; `rejected_capability` and `timeout` keep their own. */
export function invocationStatusFor(
  reason: InvocationFailureReason,
): "error" | "timeout" | "rejected_capability" {
  if (reason === "timeout") return "timeout";
  if (reason === "capability_rejected") return "rejected_capability";
  return "error";
}
