import type { CapabilityManifest, ToolManifest } from "@resin/contracts";
import { z } from "zod";

/**
 * Protocol version for daemon-to-worker RPC communications.
 */
export const WORKER_PROTOCOL_VERSION = "1.0.0";

/**
 * Standard worker RPC message types.
 */
export const WorkerMessageTypeSchema = z.enum([
  "initialize",
  "invoke",
  "broker_request",
  "broker_response",
  "progress",
  "log",
  "result",
  "error",
  "cancel",
  "heartbeat",
  "shutdown",
]);

export type WorkerMessageType = z.infer<typeof WorkerMessageTypeSchema>;

/**
 * Base fields present on every worker protocol message.
 */
export const BaseWorkerMessageSchema = z.object({
  id: z.string().min(1),
  type: WorkerMessageTypeSchema,
  timestamp: z.number().nonnegative(),
  version: z.string().default(WORKER_PROTOCOL_VERSION),
});

/**
 * 1. Initialize Message (Host -> Worker)
 */
export const InitializeMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("initialize"),
  manifest: z.record(z.unknown()), // ToolManifest representation
  bundleEntrypoint: z.string().min(1),
  workspaceRoot: z.string().optional(),
  scratchDir: z.string().optional(),
  capabilities: z.record(z.unknown()).optional(), // CapabilityManifest representation
  environment: z.record(z.string()).default({}),
  limits: z
    .object({
      timeoutMs: z.number().positive().default(30000),
      memoryLimitMb: z.number().positive().default(128),
      maxOutputSizeBytes: z.number().positive().default(1048576),
    })
    .default({}),
});
export type InitializeMessage = z.infer<typeof InitializeMessageSchema>;

/**
 * 2. Invoke Message (Host -> Worker)
 */
export const InvokeMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("invoke"),
  invocationId: z.string().min(1),
  input: z.unknown(),
  context: z
    .object({
      sessionId: z.string().optional(),
      workspaceId: z.string().optional(),
      toolId: z.string().optional(),
      toolVersion: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});
export type InvokeMessage = z.infer<typeof InvokeMessageSchema>;

/**
 * 3. Broker Request Message (Worker -> Host)
 */
export const BrokerRequestMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("broker_request"),
  requestId: z.string().min(1),
  service: z.enum(["fs", "net", "cmd", "secret"]),
  action: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});
export type BrokerRequestMessage = z.infer<typeof BrokerRequestMessageSchema>;

/**
 * 4. Broker Response Message (Host -> Worker)
 */
export const BrokerResponseMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("broker_response"),
  requestId: z.string().min(1),
  success: z.boolean(),
  payload: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});
export type BrokerResponseMessage = z.infer<typeof BrokerResponseMessageSchema>;

/**
 * 5. Progress Message (Worker -> Host)
 */
export const ProgressMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("progress"),
  invocationId: z.string().min(1),
  percentage: z.number().min(0).max(100),
  message: z.string().optional(),
  stage: z.string().optional(),
});
export type ProgressMessage = z.infer<typeof ProgressMessageSchema>;

/**
 * 6. Log Message (Worker -> Host)
 */
export const LogMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("log"),
  invocationId: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  data: z.unknown().optional(),
});
export type LogMessage = z.infer<typeof LogMessageSchema>;

/**
 * 7. Result Message (Worker -> Host)
 */
export const ResultMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("result"),
  invocationId: z.string().min(1),
  status: z.literal("success").default("success"),
  output: z.unknown(),
  durationMs: z.number().nonnegative(),
  resourceUsage: z
    .object({
      cpuTimeMs: z.number().nonnegative().optional(),
      memoryBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type ResultMessage = z.infer<typeof ResultMessageSchema>;

/**
 * 8. Error Message (Worker -> Host or Host -> Worker)
 */
export const ErrorMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("error"),
  invocationId: z.string().optional(),
  errorType: z.enum([
    "validation_error",
    "execution_error",
    "timeout",
    "permission_denied",
    "fatal",
    "cancelled",
  ]),
  message: z.string(),
  stack: z.string().optional(),
  details: z.unknown().optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

/**
 * 9. Cancel Message (Host -> Worker)
 */
export const CancelMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("cancel"),
  invocationId: z.string().min(1),
  reason: z.string().optional(),
});
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

/**
 * 10. Heartbeat Message (Bi-directional)
 */
export const HeartbeatMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("heartbeat"),
  kind: z.enum(["ping", "pong"]),
  sequence: z.number().int().nonnegative(),
});
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

/**
 * 11. Shutdown Message (Host -> Worker or Worker -> Host)
 */
export const ShutdownMessageSchema = BaseWorkerMessageSchema.extend({
  type: z.literal("shutdown"),
  reason: z.string().optional(),
  graceful: z.boolean().default(true),
});
export type ShutdownMessage = z.infer<typeof ShutdownMessageSchema>;

/**
 * Unified WorkerMessage Discriminated Union
 */
export const WorkerMessageSchema = z.discriminatedUnion("type", [
  InitializeMessageSchema,
  InvokeMessageSchema,
  BrokerRequestMessageSchema,
  BrokerResponseMessageSchema,
  ProgressMessageSchema,
  LogMessageSchema,
  ResultMessageSchema,
  ErrorMessageSchema,
  CancelMessageSchema,
  HeartbeatMessageSchema,
  ShutdownMessageSchema,
]);

export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

/**
 * Helper to generate random UUIDs for message IDs.
 */
function generateMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Factory functions for creating typed messages

export function createInitializeMessage(params: {
  manifest: ToolManifest | Record<string, unknown>;
  bundleEntrypoint: string;
  workspaceRoot?: string;
  scratchDir?: string;
  capabilities?: CapabilityManifest | Record<string, unknown>;
  environment?: Record<string, string>;
  limits?: { timeoutMs?: number; memoryLimitMb?: number; maxOutputSizeBytes?: number };
}): InitializeMessage {
  return {
    id: generateMessageId(),
    type: "initialize",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    manifest: params.manifest as Record<string, unknown>,
    bundleEntrypoint: params.bundleEntrypoint,
    workspaceRoot: params.workspaceRoot,
    scratchDir: params.scratchDir,
    capabilities: params.capabilities as Record<string, unknown> | undefined,
    environment: params.environment ?? {},
    limits: {
      timeoutMs: params.limits?.timeoutMs ?? 30000,
      memoryLimitMb: params.limits?.memoryLimitMb ?? 128,
      maxOutputSizeBytes: params.limits?.maxOutputSizeBytes ?? 1048576,
    },
  };
}

export function createInvokeMessage(params: {
  invocationId: string;
  input: unknown;
  context?: {
    sessionId?: string;
    workspaceId?: string;
    toolId?: string;
    toolVersion?: string;
    metadata?: Record<string, unknown>;
  };
}): InvokeMessage {
  return {
    id: generateMessageId(),
    type: "invoke",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    input: params.input,
    context: params.context,
  };
}

export function createBrokerRequestMessage(params: {
  requestId?: string;
  service: "fs" | "net" | "cmd" | "secret";
  action: string;
  payload: Record<string, unknown>;
}): BrokerRequestMessage {
  return {
    id: generateMessageId(),
    type: "broker_request",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    requestId: params.requestId ?? generateMessageId(),
    service: params.service,
    action: params.action,
    payload: params.payload,
  };
}

export function createBrokerResponseMessage(params: {
  requestId: string;
  success: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}): BrokerResponseMessage {
  return {
    id: generateMessageId(),
    type: "broker_response",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    requestId: params.requestId,
    success: params.success,
    payload: params.payload,
    error: params.error,
  };
}

export function createProgressMessage(params: {
  invocationId: string;
  percentage: number;
  message?: string;
  stage?: string;
}): ProgressMessage {
  return {
    id: generateMessageId(),
    type: "progress",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    percentage: Math.max(0, Math.min(100, params.percentage)),
    message: params.message,
    stage: params.stage,
  };
}

export function createLogMessage(params: {
  invocationId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}): LogMessage {
  return {
    id: generateMessageId(),
    type: "log",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    level: params.level,
    message: params.message,
    data: params.data,
  };
}

export function createResultMessage(params: {
  invocationId: string;
  output: unknown;
  durationMs: number;
  resourceUsage?: { cpuTimeMs?: number; memoryBytes?: number };
}): ResultMessage {
  return {
    id: generateMessageId(),
    type: "result",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    status: "success",
    output: params.output,
    durationMs: params.durationMs,
    resourceUsage: params.resourceUsage,
  };
}

export function createErrorMessage(params: {
  invocationId?: string;
  errorType:
    | "validation_error"
    | "execution_error"
    | "timeout"
    | "permission_denied"
    | "fatal"
    | "cancelled";
  message: string;
  stack?: string;
  details?: unknown;
}): ErrorMessage {
  return {
    id: generateMessageId(),
    type: "error",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    errorType: params.errorType,
    message: params.message,
    stack: params.stack,
    details: params.details,
  };
}

export function createCancelMessage(params: {
  invocationId: string;
  reason?: string;
}): CancelMessage {
  return {
    id: generateMessageId(),
    type: "cancel",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    invocationId: params.invocationId,
    reason: params.reason,
  };
}

export function createHeartbeatMessage(params: {
  kind: "ping" | "pong";
  sequence: number;
}): HeartbeatMessage {
  return {
    id: generateMessageId(),
    type: "heartbeat",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    kind: params.kind,
    sequence: params.sequence,
  };
}

export function createShutdownMessage(params: {
  reason?: string;
  graceful?: boolean;
}): ShutdownMessage {
  return {
    id: generateMessageId(),
    type: "shutdown",
    timestamp: Date.now(),
    version: WORKER_PROTOCOL_VERSION,
    reason: params.reason,
    graceful: params.graceful ?? true,
  };
}

/**
 * Worker Framing Format
 */
export type WorkerFrameFormat = "ndjson" | "length-prefixed";

export class WorkerFrameEncoder {
  /**
   * Encodes a message as newline-delimited JSON (NDJSON).
   */
  static encodeNDJSON(message: WorkerMessage): string {
    return `${JSON.stringify(message)}\n`;
  }

  /**
   * Encodes a message with a 4-byte big-endian length prefix.
   */
  static encodeLengthPrefixed(message: WorkerMessage): Buffer {
    const jsonStr = JSON.stringify(message);
    const payload = Buffer.from(jsonStr, "utf-8");
    const buffer = Buffer.alloc(4 + payload.length);
    buffer.writeUInt32BE(payload.length, 0);
    payload.copy(buffer, 4);
    return buffer;
  }
}

export interface WorkerFrameDecoderOptions {
  format?: WorkerFrameFormat;
  maxMessageSizeBytes?: number;
}

const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB

/**
 * Worker Frame Decoder for processing incoming streaming data (stdio chunks or buffers).
 */
export class WorkerFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private textBuffer = "";
  private readonly format: WorkerFrameFormat;
  private readonly maxMessageSize: number;

  constructor(options: WorkerFrameDecoderOptions = {}) {
    this.format = options.format ?? "ndjson";
    this.maxMessageSize = options.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;
  }

  /**
   * Push chunk data (string or Buffer) and extract all complete messages decoded so far.
   */
  push(chunk: Buffer | string): WorkerMessage[] {
    if (this.format === "ndjson") {
      return this.pushNDJSON(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    }
    return this.pushLengthPrefixed(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
  }

  private pushNDJSON(text: string): WorkerMessage[] {
    this.textBuffer += text;
    const messages: WorkerMessage[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.textBuffer.indexOf("\n")) !== -1) {
      const line = this.textBuffer.slice(0, newlineIndex).trim();
      this.textBuffer = this.textBuffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      if (Buffer.byteLength(line, "utf-8") > this.maxMessageSize) {
        throw new Error(
          `Message size exceeds maximum allowed limit (${this.maxMessageSize} bytes)`,
        );
      }

      try {
        const parsed = JSON.parse(line);
        const validated = WorkerMessageSchema.parse(parsed);
        messages.push(validated);
      } catch (err: unknown) {
        throw new Error(
          `Failed to decode worker frame: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return messages;
  }

  private pushLengthPrefixed(chunk: Buffer): WorkerMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: WorkerMessage[] = [];

    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32BE(0);

      if (payloadLength > this.maxMessageSize) {
        throw new Error(
          `Message payload size (${payloadLength} bytes) exceeds limit (${this.maxMessageSize} bytes)`,
        );
      }

      if (this.buffer.length < 4 + payloadLength) {
        // Incomplete message, wait for more data
        break;
      }

      const payloadBuf = this.buffer.subarray(4, 4 + payloadLength);
      this.buffer = this.buffer.subarray(4 + payloadLength);

      try {
        const jsonStr = payloadBuf.toString("utf-8");
        const parsed = JSON.parse(jsonStr);
        const validated = WorkerMessageSchema.parse(parsed);
        messages.push(validated);
      } catch (err: unknown) {
        throw new Error(
          `Failed to decode length-prefixed worker frame: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return messages;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.textBuffer = "";
  }
}

/**
 * Promise.withResolvers helper for ES2022 compatibility.
 */
export interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
