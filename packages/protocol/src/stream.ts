import { randomUUID } from "node:crypto";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  ToolManifestSchema,
} from "@resin/contracts";
import { z } from "zod";

/**
 * -------------------------------------------------------------------------
 * Client-to-Server Stream Messages
 * -------------------------------------------------------------------------
 */

export const StreamClientHeartbeatSchema = z.object({
  type: z.literal("client.heartbeat"),
  timestamp: ISOTimestampSchema,
  sequence: z.number().int().nonnegative(),
  uptimeMs: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative().optional(),
});

export type StreamClientHeartbeat = z.infer<typeof StreamClientHeartbeatSchema>;

export const StreamDeviceStatusReportSchema = z.object({
  type: z.literal("client.device_status"),
  deviceId: IdentifierSchema,
  cpuUsagePercent: z.number().min(0).max(100),
  memoryUsageBytes: z.number().int().nonnegative(),
  activeWorkers: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  timestamp: ISOTimestampSchema,
});

export type StreamDeviceStatusReport = z.infer<typeof StreamDeviceStatusReportSchema>;

export const StreamAckSchema = z.object({
  type: z.literal("client.ack"),
  ackSequence: z.number().int().nonnegative(),
  messageId: IdentifierSchema,
  status: z.enum(["processed", "failed"]),
  error: z.string().optional(),
  timestamp: ISOTimestampSchema,
});

export type StreamAck = z.infer<typeof StreamAckSchema>;

export const StreamResyncRequestSchema = z.object({
  type: z.literal("client.resync_request"),
  reason: z.enum(["gap_detected", "reconnect", "server_requested", "initial_sync"]),
  lastKnownServerSequence: z.number().int().nonnegative(),
  workspaceId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
});

export type StreamResyncRequest = z.infer<typeof StreamResyncRequestSchema>;

export const StreamInvocationMetricsSchema = z.object({
  type: z.literal("client.invocation_metrics"),
  toolId: IdentifierSchema,
  deploymentId: IdentifierSchema,
  durationMs: z.number().nonnegative(),
  success: z.boolean(),
  errorCode: z.string().optional(),
  timestamp: ISOTimestampSchema,
});

export type StreamInvocationMetrics = z.infer<typeof StreamInvocationMetricsSchema>;

export const ClientStreamMessagePayloadSchema = z.discriminatedUnion("type", [
  StreamClientHeartbeatSchema,
  StreamDeviceStatusReportSchema,
  StreamAckSchema,
  StreamResyncRequestSchema,
  StreamInvocationMetricsSchema,
]);

export type ClientStreamMessagePayload = z.infer<typeof ClientStreamMessagePayloadSchema>;

/**
 * -------------------------------------------------------------------------
 * Server-to-Client Stream Messages
 * -------------------------------------------------------------------------
 */

export const StreamServerHeartbeatAckSchema = z.object({
  type: z.literal("server.heartbeat_ack"),
  timestamp: ISOTimestampSchema,
  sequence: z.number().int().nonnegative(),
  serverTime: ISOTimestampSchema,
});

export type StreamServerHeartbeatAck = z.infer<typeof StreamServerHeartbeatAckSchema>;

export const StreamDeploymentCommandSchema = z.object({
  type: z.literal("server.deployment_command"),
  commandId: IdentifierSchema,
  commandType: z.enum(["activate", "canary", "rollback", "suspend"]),
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  canaryWeight: z.number().int().min(0).max(100).optional(),
  reason: z.string().optional(),
  timestamp: ISOTimestampSchema,
});

export type StreamDeploymentCommand = z.infer<typeof StreamDeploymentCommandSchema>;

export const StreamCatalogInvalidationSchema = z.object({
  type: z.literal("server.catalog_invalidation"),
  workspaceId: IdentifierSchema,
  toolIds: z.array(IdentifierSchema),
  reason: z.enum([
    "version_published",
    "tool_deprecated",
    "emergency_revocation",
    "config_changed",
  ]),
  timestamp: ISOTimestampSchema,
});

export type StreamCatalogInvalidation = z.infer<typeof StreamCatalogInvalidationSchema>;

export const StreamCloudToolCatalogChangeSchema = z.object({
  type: z.literal("server.tool_catalog_change"),
  changeType: z.enum(["added", "updated", "removed"]),
  toolId: IdentifierSchema,
  manifest: ToolManifestSchema.optional(),
  version: SchemaVersionSchema.optional(),
  timestamp: ISOTimestampSchema,
});

export type StreamCloudToolCatalogChange = z.infer<typeof StreamCloudToolCatalogChangeSchema>;

export const StreamForceResyncSchema = z.object({
  type: z.literal("server.force_resync"),
  workspaceId: IdentifierSchema,
  reason: z.string().min(1),
  targetSequence: z.number().int().nonnegative(),
  timestamp: ISOTimestampSchema,
});

export type StreamForceResync = z.infer<typeof StreamForceResyncSchema>;

export const ServerStreamMessagePayloadSchema = z.discriminatedUnion("type", [
  StreamServerHeartbeatAckSchema,
  StreamDeploymentCommandSchema,
  StreamCatalogInvalidationSchema,
  StreamCloudToolCatalogChangeSchema,
  StreamForceResyncSchema,
]);

export type ServerStreamMessagePayload = z.infer<typeof ServerStreamMessagePayloadSchema>;

/**
 * Combined stream message envelope schema.
 */
export const StreamMessageSchema = z.object({
  messageId: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: ISOTimestampSchema,
  payload: z.union([ClientStreamMessagePayloadSchema, ServerStreamMessagePayloadSchema]),
});

export type StreamMessage<T = ClientStreamMessagePayload | ServerStreamMessagePayload> = {
  messageId: string;
  sequence: number;
  timestamp: string;
  payload: T;
};

/**
 * Creates a sequenced stream message.
 */
export function createStreamMessage<
  T extends ClientStreamMessagePayload | ServerStreamMessagePayload,
>(
  sequence: number,
  payload: T,
  messageId = randomUUID(),
  timestamp = new Date().toISOString(),
): StreamMessage<T> {
  return {
    messageId,
    sequence,
    timestamp,
    payload,
  };
}

/**
 * -------------------------------------------------------------------------
 * Stream Sequencing & In-Order Reassembly
 * -------------------------------------------------------------------------
 */

export interface SequencerProcessResult<T> {
  status: "ok" | "duplicate" | "gap";
  expected: number;
  received: number;
  message?: StreamMessage<T>;
  gapSize?: number;
  bufferedCount?: number;
}

export class StreamSequencer<
  T extends ClientStreamMessagePayload | ServerStreamMessagePayload =
    | ClientStreamMessagePayload
    | ServerStreamMessagePayload,
> {
  private expectedSequence: number;
  private outboundSequence: number;
  private readonly buffer: Map<number, StreamMessage<T>> = new Map();
  private readonly maxBufferSize: number;

  constructor(
    options: {
      initialInboundSequence?: number;
      initialOutboundSequence?: number;
      maxBufferSize?: number;
    } = {},
  ) {
    this.expectedSequence = options.initialInboundSequence ?? 0;
    this.outboundSequence = options.initialOutboundSequence ?? 0;
    this.maxBufferSize = options.maxBufferSize ?? 500;
  }

  getExpectedSequence(): number {
    return this.expectedSequence;
  }

  getOutboundSequence(): number {
    return this.outboundSequence;
  }

  nextOutboundSequence(): number {
    const seq = this.outboundSequence;
    this.outboundSequence += 1;
    return seq;
  }

  processInbound(message: StreamMessage<T>): SequencerProcessResult<T> {
    if (message.sequence === this.expectedSequence) {
      this.expectedSequence += 1;
      return {
        status: "ok",
        expected: this.expectedSequence,
        received: message.sequence,
        message,
        bufferedCount: this.buffer.size,
      };
    }

    if (message.sequence < this.expectedSequence) {
      return {
        status: "duplicate",
        expected: this.expectedSequence,
        received: message.sequence,
        message,
        bufferedCount: this.buffer.size,
      };
    }

    // Gap detected: sequence > expectedSequence
    if (this.buffer.size >= this.maxBufferSize) {
      // Buffer full, drop or throw
      const lowestKey = Math.min(...this.buffer.keys());
      this.buffer.delete(lowestKey);
    }
    this.buffer.set(message.sequence, message);

    return {
      status: "gap",
      expected: this.expectedSequence,
      received: message.sequence,
      gapSize: message.sequence - this.expectedSequence,
      bufferedCount: this.buffer.size,
    };
  }

  flushBuffered(): StreamMessage<T>[] {
    const ready: StreamMessage<T>[] = [];
    while (this.buffer.has(this.expectedSequence)) {
      const msg = this.buffer.get(this.expectedSequence);
      if (msg) {
        this.buffer.delete(this.expectedSequence);
        this.expectedSequence += 1;
        ready.push(msg);
      }
    }
    return ready;
  }

  reset(targetInboundSequence = 0, targetOutboundSequence = 0): void {
    this.expectedSequence = targetInboundSequence;
    this.outboundSequence = targetOutboundSequence;
    this.buffer.clear();
  }
}

/**
 * -------------------------------------------------------------------------
 * Bounded In-Memory Replay Buffer
 * -------------------------------------------------------------------------
 */

export interface BufferedStreamItem<T> {
  message: StreamMessage<T>;
  enqueuedAt: number;
}

export class ReplayBuffer<
  T extends ClientStreamMessagePayload | ServerStreamMessagePayload =
    | ClientStreamMessagePayload
    | ServerStreamMessagePayload,
> {
  private readonly items: Map<number, BufferedStreamItem<T>> = new Map();
  private readonly maxBufferSize: number;
  private readonly ttlMs: number;

  constructor(options: { maxBufferSize?: number; ttlMs?: number } = {}) {
    this.maxBufferSize = options.maxBufferSize ?? 1000;
    this.ttlMs = options.ttlMs ?? 300_000; // 5 minutes default
  }

  add(message: StreamMessage<T>): void {
    this.purgeExpired();
    if (this.items.size >= this.maxBufferSize) {
      // Evict oldest sequence
      const oldestSeq = Math.min(...this.items.keys());
      this.items.delete(oldestSeq);
    }
    this.items.set(message.sequence, {
      message,
      enqueuedAt: Date.now(),
    });
  }

  acknowledge(ackSequence: number): number {
    let acknowledgedCount = 0;
    for (const seq of this.items.keys()) {
      if (seq <= ackSequence) {
        this.items.delete(seq);
        acknowledgedCount += 1;
      }
    }
    return acknowledgedCount;
  }

  getUnacknowledged(): StreamMessage<T>[] {
    this.purgeExpired();
    return Array.from(this.items.values())
      .map((item) => item.message)
      .sort((a, b) => a.sequence - b.sequence);
  }

  getMessagesSince(sequence: number): StreamMessage<T>[] {
    this.purgeExpired();
    return Array.from(this.items.values())
      .filter((item) => item.message.sequence > sequence)
      .map((item) => item.message)
      .sort((a, b) => a.sequence - b.sequence);
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [seq, item] of this.items.entries()) {
      if (now - item.enqueuedAt > this.ttlMs) {
        this.items.delete(seq);
      }
    }
  }
}

/**
 * -------------------------------------------------------------------------
 * Exponential Backoff with Jitter
 * -------------------------------------------------------------------------
 */

export interface ExponentialBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: number;
}

export class ExponentialBackoff {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private attempts = 0;

  constructor(options: ExponentialBackoffOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter ?? 0.2;
  }

  nextDelay(): number {
    const computed = this.baseDelayMs * this.factor ** this.attempts;
    const capped = Math.min(computed, this.maxDelayMs);
    this.attempts += 1;

    // Apply jitter: +/- jitter %
    const jitterFactor = 1 + (Math.random() * 2 - 1) * this.jitter;
    return Math.max(0, Math.floor(capped * jitterFactor));
  }

  reset(): void {
    this.attempts = 0;
  }

  getAttempts(): number {
    return this.attempts;
  }
}

/**
 * -------------------------------------------------------------------------
 * Stream Dead-Letter Queue Manager
 * -------------------------------------------------------------------------
 */

export interface DeadLetterItem<T> {
  id: string;
  message: StreamMessage<T>;
  error: string;
  attempts: number;
  failedAt: string;
}

export class StreamDeadLetterQueue<
  T extends ClientStreamMessagePayload | ServerStreamMessagePayload =
    | ClientStreamMessagePayload
    | ServerStreamMessagePayload,
> {
  private readonly items: DeadLetterItem<T>[] = [];
  private readonly maxSize: number;

  constructor(options: { maxSize?: number } = {}) {
    this.maxSize = options.maxSize ?? 500;
  }

  enqueue(message: StreamMessage<T>, error: string, attempts: number): DeadLetterItem<T> {
    if (this.items.length >= this.maxSize) {
      this.items.shift();
    }
    const item: DeadLetterItem<T> = {
      id: randomUUID(),
      message,
      error,
      attempts,
      failedAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  getDeadLetters(): readonly DeadLetterItem<T>[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
