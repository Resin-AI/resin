/**
 * Standard JSON-RPC 2.0 and MCP Error Taxonomy & Codes.
 */

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

export const MCP_ERROR_CODES = {
  REQUEST_TIMEOUT: -32000,
  CANCELLED: -32001,
  RESOURCE_NOT_FOUND: -32002,
  TOOL_NOT_FOUND: -32004,
  OVERSIZED_REQUEST: -32005,
  CONCURRENCY_LIMIT_EXCEEDED: -32006,
  RATE_LIMITED: -32029,
  UNAUTHORIZED: -32003,
  CONNECTION_CLOSED: -32007,
} as const;

export type McpErrorCode =
  | JsonRpcErrorCode
  | (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

export type JsonRpcErrorData =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean | null | undefined)[]
  | { readonly [key: string]: string | number | boolean | null | undefined };

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonRpcErrorData;
}

export type JsonRpcErrorCandidate =
  | Error
  | McpProtocolError
  | JsonRpcErrorObject
  | {
      readonly code?: number | string | null | undefined;
      readonly message?: string | null | undefined;
    }
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Custom error class for JSON-RPC and MCP protocol errors.
 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: JsonRpcErrorData;

  constructor(code: number, message: string, data?: JsonRpcErrorData) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, McpProtocolError.prototype);
  }

  toJsonRpcError(): JsonRpcErrorObject {
    const errorObj: JsonRpcErrorObject = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      errorObj.data = this.data;
    }
    return errorObj;
  }
}

export function createMcpError(
  code: number,
  message: string,
  data?: JsonRpcErrorData,
): McpProtocolError {
  return new McpProtocolError(code, message, data);
}

export function isMcpProtocolError(error: JsonRpcErrorCandidate): error is McpProtocolError {
  if (error instanceof McpProtocolError) {
    return true;
  }
  if (!error || !(error instanceof Object) || Array.isArray(error)) {
    return false;
  }
  if ("code" in error && "message" in error) {
    const candidateCode = error.code;
    const candidateMessage = error.message;
    return (
      Number.isFinite(candidateCode) &&
      Object.prototype.toString.call(candidateMessage) === "[object String]"
    );
  }
  return false;
}
