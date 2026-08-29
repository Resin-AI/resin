import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "@resin/contracts";
import { z } from "zod";
import { ProtocolError, type ProtocolErrorCode, ProtocolErrorCodeSchema } from "./errors.js";

/**
 * Standard asynchronous job execution lifecycle states.
 */
export const JobExecutionStatusSchema = z.enum([
  "accepted",
  "queued",
  "running",
  "completed",
  "failed",
]);

export type JobExecutionStatus = z.infer<typeof JobExecutionStatusSchema>;

/**
 * Backward-compatible alias for JobExecutionStatusSchema.
 */
export const AsyncJobStatusSchema = JobExecutionStatusSchema;
export type AsyncJobStatus = JobExecutionStatus;

/**
 * S3 payload/artifact object descriptor schema.
 * Matches DynamoDB and SQS storage metadata boundaries.
 */
export const S3ObjectDescriptorSchema = z.object({
  bucket: z.string().min(1).optional(),
  key: z.string().min(1),
  contentType: z.string().min(1).optional(),
  contentEncoding: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: Sha256DigestSchema,
  etag: z.string().optional(),
});

export type S3ObjectDescriptor = z.infer<typeof S3ObjectDescriptorSchema>;

/**
 * Descriptor for tool artifacts produced or referenced by async jobs.
 */
export const JobToolDescriptorSchema = z.object({
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  downloadUrl: z.string().min(1).optional(),
  expiresAt: ISOTimestampSchema.optional(),
  descriptor: S3ObjectDescriptorSchema.optional(),
  sha256: Sha256DigestSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  format: z.string().optional(),
});

export type JobToolDescriptor = z.infer<typeof JobToolDescriptorSchema>;

/**
 * Descriptor for job results payload and metadata.
 */
export const JobResultDescriptorSchema = z.object({
  downloadUrl: z.string().min(1).optional(),
  expiresAt: ISOTimestampSchema.optional(),
  descriptor: S3ObjectDescriptorSchema.optional(),
  sha256: Sha256DigestSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  tool: JobToolDescriptorSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type JobResultDescriptor = z.infer<typeof JobResultDescriptorSchema>;

/**
 * Standard GET /v1/jobs/:jobId response schema.
 * Strict, additive response for asynchronous cloud worker job polling.
 */
export const JobStatusResponseSchema = z.object({
  jobId: IdentifierSchema,
  status: JobExecutionStatusSchema,
  createdAt: ISOTimestampSchema.optional(),
  updatedAt: ISOTimestampSchema.optional(),
  completedAt: ISOTimestampSchema.optional(),
  error: z.string().optional(),
  errorCode: ProtocolErrorCodeSchema.optional(),
  details: z.record(z.unknown()).optional(),
  progress: z.number().min(0).max(100).optional(),
  result: JobResultDescriptorSchema.optional(),
  descriptor: S3ObjectDescriptorSchema.optional(),
  downloadUrl: z.string().min(1).optional(),
  tool: JobToolDescriptorSchema.optional(),
  sha256: Sha256DigestSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
});

export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

/**
 * Backward-compatible alias for JobStatusResponseSchema.
 */
export const AsyncJobStatusResponseSchema = JobStatusResponseSchema;
export type AsyncJobStatusResponse = JobStatusResponse;

/**
 * Error thrown when an async job reaches terminal 'failed' status.
 */
export class JobFailedError extends ProtocolError {
  readonly jobId: string;
  readonly failureReason?: string;

  constructor(
    jobId: string,
    message: string,
    options: {
      failureReason?: string;
      errorCode?: ProtocolErrorCode;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(options.errorCode ?? "terminal", `Job ${jobId} failed: ${message}`, {
      status: 500,
      details: { jobId, failureReason: options.failureReason ?? message, ...options.details },
      cause: options.cause,
    });
    this.name = "JobFailedError";
    this.jobId = jobId;
    this.failureReason = options.failureReason ?? message;
  }
}

/**
 * Error thrown when job polling exceeds the maximum configured wait duration.
 */
export class JobTimeoutError extends ProtocolError {
  readonly jobId: string;
  readonly elapsedMs: number;

  constructor(jobId: string, elapsedMs: number, message?: string) {
    super("retryable", message ?? `Job ${jobId} timed out after ${elapsedMs}ms`, {
      status: 504,
      details: { jobId, elapsedMs },
    });
    this.name = "JobTimeoutError";
    this.jobId = jobId;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Error thrown when polling or downloading is canceled via AbortSignal.
 */
export class JobAbortedError extends ProtocolError {
  readonly jobId?: string;

  constructor(message = "Job operation was aborted", jobId?: string) {
    super("terminal", message, {
      status: 499,
      details: { jobId },
    });
    this.name = "JobAbortedError";
    this.jobId = jobId;
  }
}

/**
 * Error thrown when a downloaded artifact fails exact SHA-256 verification.
 */
export class ArtifactIntegrityError extends ProtocolError {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(expectedDigest: string, actualDigest: string, message?: string) {
    super(
      "validation",
      message ??
        `Artifact integrity verification failed: expected ${expectedDigest}, got ${actualDigest}`,
      {
        status: 422,
        details: { expectedDigest, actualDigest },
      },
    );
    this.name = "ArtifactIntegrityError";
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

/**
 * Error thrown when a downloaded artifact exceeds the configured maximum allowed byte size.
 */
export class ArtifactSizeExceededError extends ProtocolError {
  readonly actualSizeBytes: number;
  readonly maxAllowedSizeBytes: number;

  constructor(actualSizeBytes: number, maxAllowedSizeBytes: number, message?: string) {
    super(
      "decompression_bomb",
      message ??
        `Artifact size ${actualSizeBytes} bytes exceeds maximum limit ${maxAllowedSizeBytes} bytes`,
      {
        status: 413,
        details: { actualSizeBytes, maxAllowedSizeBytes },
      },
    );
    this.name = "ArtifactSizeExceededError";
    this.actualSizeBytes = actualSizeBytes;
    this.maxAllowedSizeBytes = maxAllowedSizeBytes;
  }
}

/**
 * Error thrown when job status response is malformed or invalid according to schema.
 */
export class JobMalformedResponseError extends ProtocolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation", `Malformed job status response: ${message}`, {
      status: 502,
      details,
    });
    this.name = "JobMalformedResponseError";
  }
}

/**
 * Configuration options for async job polling.
 */
export interface JobPollOptions {
  /** Total maximum wait time in milliseconds (default: 60,000 ms). */
  maxWaitMs?: number;
  /** Initial polling interval in milliseconds (default: 500 ms). */
  initialIntervalMs?: number;
  /** Maximum polling interval in milliseconds (default: 5,000 ms). */
  maxIntervalMs?: number;
  /** Exponential backoff multiplier factor (default: 1.5). */
  backoffFactor?: number;
  /** Optional AbortSignal to cancel polling. */
  signal?: AbortSignal;
}

/**
 * Configuration options for downloading results or tools.
 */
export interface ArtifactDownloadOptions {
  /** Maximum allowed size in bytes (default: 50 MiB = 52,428,800 bytes). */
  maxSizeBytes?: number;
  /** Expected SHA-256 digest to verify against (hex or sha256: prefixed). */
  expectedSha256?: string;
  /** Expected Content-Type header. */
  expectedContentType?: string;
  /** Optional AbortSignal to cancel download. */
  signal?: AbortSignal;
}

/**
 * Verified downloaded artifact payload.
 * NEVER execute or activate tool bytes.
 */
export interface DownloadedArtifact {
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType?: string;
}

/**
 * End-to-end result of batch dispatch, async job polling, and verified payload retrieval.
 */
export interface JobExecutionResult {
  readonly jobId: string;
  readonly status: JobExecutionStatus;
  readonly statusResponse: JobStatusResponse;
  readonly resultBytes?: Uint8Array;
  readonly resultSha256?: string;
  readonly toolBytes?: Uint8Array;
  readonly toolSha256?: string;
  readonly toolDescriptor?: JobToolDescriptor;
  readonly metadata?: Record<string, unknown>;
}
