import { ISOTimestampSchema, IdentifierSchema } from "@resin/contracts";
import { z } from "zod";

/**
 * Standard protocol error code taxonomy.
 */
export const ProtocolErrorCodeSchema = z.enum([
  "retryable",
  "upgrade_required",
  "permission_denied",
  "validation",
  "terminal",
  "clock_skew",
  "rate_limited",
  "device_revoked",
  "token_expired",
  "invalid_grant",
  "unauthorized",
  "not_found",
  "conflict",
  "checksum_mismatch",
  "payload_too_large",
  "decompression_bomb",
  "out_of_order",
  "duplicate_message",
  "resync_required",
  "internal_error",
]);

export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

/**
 * Detailed error context payload schema.
 */
export const ProtocolErrorDetailsSchema = z.object({
  code: ProtocolErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  minSupportedVersion: z.string().optional(),
  maxSupportedVersion: z.string().optional(),
  expectedSequence: z.number().int().nonnegative().optional(),
  receivedSequence: z.number().int().nonnegative().optional(),
  serverTimestamp: ISOTimestampSchema.optional(),
  clientTimestamp: ISOTimestampSchema.optional(),
  clockSkewMs: z.number().optional(),
  rateLimitReset: ISOTimestampSchema.optional(),
  traceId: z.string().optional(),
  causationId: IdentifierSchema.optional(),
});

export type ProtocolErrorDetails = z.infer<typeof ProtocolErrorDetailsSchema>;

/**
 * Protocol error response wire representation.
 */
export const ProtocolErrorResponseSchema = z.object({
  error: ProtocolErrorDetailsSchema,
  status: z.number().int().min(400).max(599).default(400),
  timestamp: ISOTimestampSchema,
});

export type ProtocolErrorResponse = z.infer<typeof ProtocolErrorResponseSchema>;

/**
 * Base class for all Resin protocol errors.
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;
  readonly traceId?: string;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      retryAfterMs?: number;
      traceId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = `ProtocolError[${code}]`;
    this.code = code;
    this.status = options.status ?? defaultHttpStatusForCode(code);
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.traceId = options.traceId;
  }

  toResponse(timestamp = new Date().toISOString()): ProtocolErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        retryAfterMs: this.retryAfterMs,
        traceId: this.traceId,
      },
      status: this.status,
      timestamp,
    };
  }
}

/**
 * Specific typed ProtocolError subclasses for domain-specific ergonomics.
 */

export class RetryableError extends ProtocolError {
  constructor(
    message: string,
    options: { retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super("retryable", message, { status: 503, ...options });
  }
}

export class UpgradeRequiredError extends ProtocolError {
  readonly minSupportedVersion: string;
  constructor(
    message: string,
    minSupportedVersion: string,
    options: { details?: Record<string, unknown> } = {},
  ) {
    super("upgrade_required", message, {
      status: 426,
      details: { minSupportedVersion, ...options.details },
    });
    this.minSupportedVersion = minSupportedVersion;
  }
}

export class PermissionDeniedError extends ProtocolError {
  constructor(message: string, options: { details?: Record<string, unknown> } = {}) {
    super("permission_denied", message, { status: 403, ...options });
  }
}

export class ValidationError extends ProtocolError {
  constructor(message: string, options: { details?: Record<string, unknown> } = {}) {
    super("validation", message, { status: 400, ...options });
  }
}

export class TerminalError extends ProtocolError {
  constructor(
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super("terminal", message, { status: 500, ...options });
  }
}

export class ClockSkewError extends ProtocolError {
  readonly serverTimestamp: string;
  readonly clientTimestamp: string;
  readonly clockSkewMs: number;

  constructor(
    message: string,
    serverTimestamp: string,
    clientTimestamp: string,
    clockSkewMs: number,
    options: { details?: Record<string, unknown> } = {},
  ) {
    super("clock_skew", message, {
      status: 400,
      details: { serverTimestamp, clientTimestamp, clockSkewMs, ...options.details },
    });
    this.serverTimestamp = serverTimestamp;
    this.clientTimestamp = clientTimestamp;
    this.clockSkewMs = clockSkewMs;
  }
}

export class RateLimitedError extends ProtocolError {
  constructor(
    message: string,
    options: { retryAfterMs?: number; details?: Record<string, unknown> } = {},
  ) {
    super("rate_limited", message, { status: 429, ...options });
  }
}

export class DeviceRevokedError extends ProtocolError {
  readonly deviceId: string;
  constructor(deviceId: string, message = "Device authorization has been revoked") {
    super("device_revoked", message, { status: 401, details: { deviceId } });
    this.deviceId = deviceId;
  }
}

export class TokenExpiredError extends ProtocolError {
  constructor(
    message = "Authentication token has expired",
    options: { details?: Record<string, unknown> } = {},
  ) {
    super("token_expired", message, { status: 401, ...options });
  }
}

export class ChecksumMismatchError extends ProtocolError {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(expectedDigest: string, actualDigest: string, message = "Payload checksum mismatch") {
    super("checksum_mismatch", message, {
      status: 400,
      details: { expectedDigest, actualDigest },
    });
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

export class SequenceError extends ProtocolError {
  readonly expectedSequence: number;
  readonly receivedSequence: number;

  constructor(
    expectedSequence: number,
    receivedSequence: number,
    message = "Stream sequence out of order",
  ) {
    super("out_of_order", message, {
      status: 409,
      details: { expectedSequence, receivedSequence },
    });
    this.expectedSequence = expectedSequence;
    this.receivedSequence = receivedSequence;
  }
}

export class DecompressionBombError extends ProtocolError {
  readonly declaredSize: number;
  readonly maxAllowedSize: number;

  constructor(
    declaredSize: number,
    maxAllowedSize: number,
    message = "Decompressed artifact exceeds maximum allowable size limit",
  ) {
    super("decompression_bomb", message, {
      status: 413,
      details: { declaredSize, maxAllowedSize },
    });
    this.declaredSize = declaredSize;
    this.maxAllowedSize = maxAllowedSize;
  }
}

/**
 * Maps error code to HTTP status code.
 */
export function defaultHttpStatusForCode(code: ProtocolErrorCode): number {
  switch (code) {
    case "retryable":
      return 503;
    case "upgrade_required":
      return 426;
    case "permission_denied":
      return 430;
    case "validation":
      return 400;
    case "terminal":
    case "internal_error":
      return 500;
    case "clock_skew":
      return 400;
    case "rate_limited":
      return 429;
    case "device_revoked":
    case "token_expired":
    case "invalid_grant":
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
    case "out_of_order":
    case "duplicate_message":
    case "resync_required":
      return 409;
    case "checksum_mismatch":
      return 400;
    case "payload_too_large":
    case "decompression_bomb":
      return 413;
    default:
      return 400;
  }
}

/**
 * Type guard for ProtocolError.
 */
export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

/**
 * Checks if a ProtocolError or generic error is retryable.
 */
export function isRetryableProtocolError(error: unknown): boolean {
  if (isProtocolError(error)) {
    return (
      error.code === "retryable" ||
      error.code === "rate_limited" ||
      error.status === 503 ||
      error.status === 429
    );
  }
  return false;
}
