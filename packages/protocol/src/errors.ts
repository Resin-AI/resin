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

export type ProtocolErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProtocolErrorDetailRecord
  | ProtocolErrorDetailValue[];

export interface ProtocolErrorDetailRecord {
  [key: string]: ProtocolErrorDetailValue;
}

/**
 * Detailed error context payload schema.
 */
export const ProtocolErrorDetailsSchema = z.object({
  code: ProtocolErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().optional(),
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

export interface ProtocolErrorOptions {
  status?: number;
  details?: ProtocolErrorDetailRecord;
  retryAfterMs?: number;
  traceId?: string;
  cause?: unknown;
}

export type ProtocolSubclassOptions = Omit<ProtocolErrorOptions, "status">;

export interface RateLimitedErrorOptions extends ProtocolSubclassOptions {
  rateLimitReset?: string;
}

/**
 * Base class for all Resin protocol errors.
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly status: number;
  readonly details?: ProtocolErrorDetailRecord;
  readonly retryAfterMs?: number;
  readonly traceId?: string;

  constructor(code: ProtocolErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = `ProtocolError[${code}]`;
    this.code = code;
    this.status = options.status ?? defaultHttpStatusForCode(code);
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.traceId = options.traceId;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): ProtocolErrorResponse {
    const timestamp = new Date().toISOString();
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.code === "retryable" || this.code === "rate_limited",
        details: this.details,
        retryAfterMs: this.retryAfterMs,
        traceId: this.traceId,
      },
      status: this.status,
      timestamp,
    };
  }
  toResponse(): ProtocolErrorResponse {
    return this.toJSON();
  }
}

/**
 * Specific typed ProtocolError subclasses for domain-specific ergonomics.
 */

export class RetryableError extends ProtocolError {
  constructor(message: string, options: ProtocolSubclassOptions = {}) {
    super("retryable", message, { status: 503, ...options });
  }
}

export class UpgradeRequiredError extends ProtocolError {
  readonly minSupportedVersion: string;
  constructor(message: string, minSupportedVersion: string, options: ProtocolSubclassOptions = {}) {
    super("upgrade_required", message, {
      status: 426,
      ...options,
      details: { minSupportedVersion, ...options.details },
    });
    this.minSupportedVersion = minSupportedVersion;
  }
}

export class PermissionDeniedError extends ProtocolError {
  constructor(message: string, options: ProtocolSubclassOptions = {}) {
    super("permission_denied", message, { status: 403, ...options });
  }
}

export class ValidationError extends ProtocolError {
  constructor(message: string, options: ProtocolSubclassOptions = {}) {
    super("validation", message, { status: 400, ...options });
  }
}

export class TerminalError extends ProtocolError {
  constructor(message: string, options: ProtocolSubclassOptions = {}) {
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
    options: ProtocolSubclassOptions = {},
  ) {
    super("clock_skew", message, {
      status: 400,
      ...options,
      details: { serverTimestamp, clientTimestamp, clockSkewMs, ...options.details },
    });
    this.serverTimestamp = serverTimestamp;
    this.clientTimestamp = clientTimestamp;
    this.clockSkewMs = clockSkewMs;
  }
}

export class RateLimitedError extends ProtocolError {
  readonly rateLimitReset?: string;

  constructor(message: string, options: RateLimitedErrorOptions = {}) {
    super("rate_limited", message, { status: 429, ...options });
    this.rateLimitReset = options.rateLimitReset;
  }
}

export class DeviceRevokedError extends ProtocolError {
  readonly deviceId: string;
  constructor(
    deviceId: string,
    message = "Device authorization has been revoked",
    options: ProtocolSubclassOptions = {},
  ) {
    super("device_revoked", message, {
      status: 401,
      ...options,
      details: { deviceId, ...options.details },
    });
    this.deviceId = deviceId;
  }
}

export class TokenExpiredError extends ProtocolError {
  constructor(message = "Authentication token has expired", options: ProtocolSubclassOptions = {}) {
    super("token_expired", message, { status: 401, ...options });
  }
}

export class ChecksumMismatchError extends ProtocolError {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(
    expectedDigest: string,
    actualDigest: string,
    message = "Payload checksum mismatch",
    options: ProtocolSubclassOptions = {},
  ) {
    super("checksum_mismatch", message, {
      status: 400,
      ...options,
      details: { expectedDigest, actualDigest, ...options.details },
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
    options: ProtocolSubclassOptions = {},
  ) {
    super("out_of_order", message, {
      status: 400,
      ...options,
      details: { expectedSequence, receivedSequence, ...options.details },
    });
    this.expectedSequence = expectedSequence;
    this.receivedSequence = receivedSequence;
  }
}

export class InvalidGrantError extends ProtocolError {
  constructor(message = "Invalid authentication grant", options: ProtocolSubclassOptions = {}) {
    super("invalid_grant", message, { status: 401, ...options });
  }
}

export class UnauthorizedError extends ProtocolError {
  constructor(message = "Unauthorized request", options: ProtocolSubclassOptions = {}) {
    super("unauthorized", message, { status: 401, ...options });
  }
}

export class NotFoundError extends ProtocolError {
  constructor(message = "Requested resource not found", options: ProtocolSubclassOptions = {}) {
    super("not_found", message, { status: 404, ...options });
  }
}

export class ConflictError extends ProtocolError {
  constructor(message = "Resource state conflict", options: ProtocolSubclassOptions = {}) {
    super("conflict", message, { status: 409, ...options });
  }
}

export class ResyncRequiredError extends ProtocolError {
  constructor(
    message = "Full state resynchronization required",
    options: ProtocolSubclassOptions = {},
  ) {
    super("resync_required", message, { status: 409, ...options });
  }
}

export class InternalProtocolError extends ProtocolError {
  constructor(
    message = "Internal protocol processing failure",
    options: ProtocolSubclassOptions = {},
  ) {
    super("internal_error", message, { status: 500, ...options });
  }
}

export class PayloadTooLargeError extends ProtocolError {
  readonly maxSize: number;
  readonly actualSize: number;

  constructor(
    maxSize: number,
    actualSize: number,
    message = "Payload exceeds maximum allowed size",
    options: ProtocolSubclassOptions = {},
  ) {
    super("payload_too_large", message, {
      status: 413,
      ...options,
      details: { maxSize, actualSize, ...options.details },
    });
    this.maxSize = maxSize;
    this.actualSize = actualSize;
  }
}

export class DecompressionBombError extends ProtocolError {
  readonly declaredSize: number;
  readonly maxAllowedSize: number;

  constructor(
    declaredSize: number,
    maxAllowedSize: number,
    message = "Decompressed artifact exceeds maximum allowable size limit",
    options: ProtocolSubclassOptions = {},
  ) {
    super("decompression_bomb", message, {
      status: 413,
      ...options,
      details: { declaredSize, maxAllowedSize, ...options.details },
    });
    this.declaredSize = declaredSize;
    this.maxAllowedSize = maxAllowedSize;
  }
}

export class OutOfOrderError extends ProtocolError {
  readonly expectedSeq: number;
  readonly receivedSeq: number;

  constructor(
    expectedSeq: number,
    receivedSeq: number,
    message = "Message received out of order",
    options: ProtocolSubclassOptions = {},
  ) {
    super("out_of_order", message, {
      status: 400,
      ...options,
      details: { expectedSeq, receivedSeq, ...options.details },
    });
    this.expectedSeq = expectedSeq;
    this.receivedSeq = receivedSeq;
  }
}

export class DuplicateMessageError extends ProtocolError {
  readonly messageId: string;

  constructor(
    messageId: string,
    message = "Duplicate message detected",
    options: ProtocolSubclassOptions = {},
  ) {
    super("duplicate_message", message, {
      status: 409,
      ...options,
      details: { messageId, ...options.details },
    });
    this.messageId = messageId;
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
    case "duplicate_message":
      return 409;
    case "checksum_mismatch":
      return 422;
    case "payload_too_large":
    case "decompression_bomb":
      return 413;
    case "out_of_order":
      return 400;
    case "resync_required":
      return 409;
    default:
      return 500;
  }
}
/**
 * Type guard to test if a value is a ProtocolError.
 */
export function isProtocolError(error: Error | null | undefined): error is ProtocolError {
  return error instanceof ProtocolError;
}

/**
 * Helper to test if a caught error represents a retryable condition.
 */
export function isRetryableProtocolError(error: Error | null | undefined): boolean {
  if (isProtocolError(error)) {
    return (
      error.code === "retryable" ||
      error.code === "rate_limited" ||
      (error.retryAfterMs !== undefined && error.retryAfterMs > 0)
    );
  }
  return false;
}
