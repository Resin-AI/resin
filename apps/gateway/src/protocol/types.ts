import { z } from "zod";
import type { JsonRpcErrorObject } from "./errors.js";
export type { JsonRpcErrorObject };

/**
 * Standard MCP Protocol Versions.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2024-10-07", "0.1.0"] as const;

export const LATEST_PROTOCOL_VERSION = "2024-11-05";

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] | string;

/**
 * JSON-RPC 2.0 Request ID.
 */
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/**
 * JSON-RPC 2.0 Base Request.
 */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
export type JsonRpcRequest<TParams = Record<string, unknown>> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
};

/**
 * JSON-RPC 2.0 Notification (no ID).
 */
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
export type JsonRpcNotification<TParams = Record<string, unknown>> = {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
};

/**
 * JSON-RPC 2.0 Response.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
  error?: never;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
  result?: never;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * Client and Server Info.
 */
export const McpImplementationInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
});
export type McpImplementationInfo = z.infer<typeof McpImplementationInfoSchema>;
export type McpClientInfo = McpImplementationInfo;
export type McpServerInfo = McpImplementationInfo;

/**
 * Client capabilities.
 */
export const McpClientCapabilitiesSchema = z.object({
  roots: z
    .object({
      listChanged: z.boolean().optional(),
    })
    .optional(),
  tools: z
    .object({
      listChanged: z.boolean().optional(),
    })
    .optional(),
  sampling: z.record(z.unknown()).optional(),
  experimental: z.record(z.unknown()).optional(),
});
export type McpClientCapabilities = z.infer<typeof McpClientCapabilitiesSchema>;

/**
 * Server capabilities.
 */
export const McpServerCapabilitiesSchema = z.object({
  tools: z
    .object({
      listChanged: z.boolean().optional(),
    })
    .optional(),
  logging: z.record(z.unknown()).optional(),
  resources: z
    .object({
      subscribe: z.boolean().optional(),
      listChanged: z.boolean().optional(),
    })
    .optional(),
  prompts: z
    .object({
      listChanged: z.boolean().optional(),
    })
    .optional(),
  experimental: z.record(z.unknown()).optional(),
});
export type McpServerCapabilities = z.infer<typeof McpServerCapabilitiesSchema>;

/**
 * Initialize params & result.
 */
export const InitializeParamsSchema = z.object({
  protocolVersion: z.string(),
  capabilities: McpClientCapabilitiesSchema.default({}),
  clientInfo: McpImplementationInfoSchema,
  rootUri: z.string().optional(),
  rootPath: z.string().optional(),
  workspaceFolders: z
    .array(
      z.object({
        uri: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

export interface InitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpImplementationInfo;
  instructions?: string;
}

/**
 * Tool Definition Schema (MCP compliant).
 */
export const McpToolInputSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  description: z.string().optional(),
});
export type McpToolInput = z.infer<typeof McpToolInputSchema>;

export const McpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: McpToolInputSchema,
});
export type McpTool = z.infer<typeof McpToolSchema>;

/**
 * Tool Content blocks.
 */
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

/**
 * Tool Call params and result.
 */
export const CallToolParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  _meta: z
    .object({
      progressToken: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});
export type CallToolParams = z.infer<typeof CallToolParamsSchema>;

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * List Tools params and result.
 */
export const ListToolsParamsSchema = z.object({
  cursor: z.string().optional(),
});
export type ListToolsParams = z.infer<typeof ListToolsParamsSchema>;

export interface ListToolsResult {
  tools: McpTool[];
  nextCursor?: string;
}

/**
 * Progress Notification.
 */
export interface ProgressNotificationParams {
  progressToken: string | number;
  progress: number;
  total?: number;
}

/**
 * Logging Set Level.
 */
export const LoggingLevelSchema = z.enum([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);
export type LoggingLevel = z.infer<typeof LoggingLevelSchema>;

export const LoggingSetLevelParamsSchema = z.object({
  level: LoggingLevelSchema,
});
export type LoggingSetLevelParams = z.infer<typeof LoggingSetLevelParamsSchema>;

/**
 * Cancel Request Params.
 */
export const CancelRequestParamsSchema = z.object({
  requestId: JsonRpcIdSchema,
  reason: z.string().optional(),
});
export type CancelRequestParams = z.infer<typeof CancelRequestParamsSchema>;

/**
 * Roots List Result.
 */
export interface McpRoot {
  uri: string;
  name?: string;
}

export interface ListRootsResult {
  roots: McpRoot[];
}
