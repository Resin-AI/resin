import { randomUUID } from "node:crypto";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  hashCanonicalContent,
  normalizeSha256,
} from "@resin/contracts";
import { z } from "zod";
import {
  ChecksumMismatchError,
  ClockSkewError,
  UpgradeRequiredError,
  ValidationError,
} from "./errors.js";

/**
 * Protocol version constants and supported version vectors.
 */
export const PROTOCOL_VERSION = "1.0.0" as const;
export const SUPPORTED_PROTOCOL_MAJOR_VERSIONS = [1] as const;

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Checks if a SemVer string belongs to a supported protocol major version.
 */
export function isSupportedProtocolVersion(version: string): boolean {
  if (Object.prototype.toString.call(version) !== "[object String]") return false;
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return false;
  const major = Number.parseInt(match[1], 10);
  return SUPPORTED_PROTOCOL_MAJOR_VERSIONS.some((v) => v === major);
}

/**
 * Asserts that a protocol version is present, valid SemVer 2.0.0, and supported.
 * Throws ValidationError for missing/malformed versions and UpgradeRequiredError for unsupported/downgraded major versions.
 */
export function assertSupportedProtocolVersion(
  version: string | null | undefined,
  context = "message",
): asserts version is string {
  if (!version || version.trim() === "") {
    throw new ValidationError(
      `Missing explicit schema version in ${context}: wire protocol requires a valid SemVer version`,
      { details: { receivedVersion: version ?? "", context, isTerminal: true } },
    );
  }
  const trimmed = version.trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) {
    throw new ValidationError(
      `Invalid protocol schema version format '${trimmed}' in ${context}: must be valid SemVer 2.0.0`,
      { details: { receivedVersion: trimmed, context, isTerminal: true } },
    );
  }
  const major = Number.parseInt(match[1], 10);
  if (!SUPPORTED_PROTOCOL_MAJOR_VERSIONS.some((v) => v === major)) {
    throw new UpgradeRequiredError(
      `Unsupported protocol version '${trimmed}' in ${context}. Client/cloud upgrade required (supported major versions: ${SUPPORTED_PROTOCOL_MAJOR_VERSIONS.join(", ")})`,
      `${SUPPORTED_PROTOCOL_MAJOR_VERSIONS[0]}.0.0`,
      {
        details: {
          receivedVersion: trimmed,
          supportedMajorVersions: [...SUPPORTED_PROTOCOL_MAJOR_VERSIONS],
          context,
        },
      },
    );
  }
}

/**
 * Zod schema enforcing supported SemVer protocol versions.
 * Rejects missing versions, invalid formats, and unsupported major versions.
 */
export const SupportedProtocolVersionSchema = SchemaVersionSchema.superRefine((val, ctx) => {
  const match = SEMVER_PATTERN.exec(val);
  if (!match) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid semantic version string: '${val}'`,
    });
    return;
  }
  const major = Number.parseInt(match[1], 10);
  if (!SUPPORTED_PROTOCOL_MAJOR_VERSIONS.some((v) => v === major)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported protocol version '${val}': supported major versions are [${SUPPORTED_PROTOCOL_MAJOR_VERSIONS.join(", ")}]`,
    });
  }
});

const FORBIDDEN_PRIVATE_PROPERTY_KEYS = {
  AttributeUpdates: true,
  KeySchema: true,
  TableName: true,
  ConsumedCapacity: true,
  ExclusiveStartKey: true,
  ReceiptHandle: true,
  MD5OfBody: true,
  MD5OfMessageAttributes: true,
  _cloudInternal: true,
  _rawEvolutionCandidate: true,
  _privateKey: true,
  _dynamoItem: true,
  _s3BucketPrivate: true,
  candidateInternalState: true,
  evaluationSandboxId: true,
} as const;

const DYNAMODB_ATTRIBUTE_DESCRIPTOR_KEYS = {
  S: true,
  N: true,
  B: true,
  SS: true,
  NS: true,
  BS: true,
  M: true,
  L: true,
  NULL: true,
  BOOL: true,
} as const;

export type ProtocolPayloadValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProtocolPayloadRecord
  | ProtocolPayloadValue[];

export interface ProtocolPayloadRecord {
  [key: string]: ProtocolPayloadValue;
}

export const ProtocolPayloadValueSchema: z.ZodType<ProtocolPayloadValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(ProtocolPayloadValueSchema),
    z.record(ProtocolPayloadValueSchema),
  ]),
);
export type ProtocolPayload = Exclude<ProtocolPayloadValue, undefined>;

const ProtocolPayloadSchema: z.ZodType<ProtocolPayload, z.ZodTypeDef, ProtocolPayloadValue> =
  ProtocolPayloadValueSchema.refine((value): value is ProtocolPayload => value !== undefined);

const ProtocolScalarInspectionSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.undefined(),
]);
const ProtocolObjectInspectionSchema = z.record(z.unknown());

/**
 * Rejection filter ensuring raw private cloud implementation objects never cross the protocol boundary.
 */
export function assertNoPrivateImplementationObjects<T>(data: T, path = "$"): void {
  if (data === null || data === undefined) {
    return;
  }

  const dataTag = Object.prototype.toString.call(data);
  if (
    dataTag === "[object String]" ||
    dataTag === "[object Number]" ||
    dataTag === "[object Boolean]"
  ) {
    return;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertNoPrivateImplementationObjects(data[i], `${path}[${i}]`);
    }
    return;
  }

  if (dataTag !== "[object Object]") {
    throw new ValidationError(`Unsupported private implementation object at ${path}`, {
      details: { path, securityViolation: true },
    });
  }

  // SAFETY: Data tag confirms data is a non-null object record.
  const obj = data as ProtocolPayloadRecord;

  // Check prototype pollution attempt
  if (
    Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
    Object.prototype.hasOwnProperty.call(obj, "constructor")
  ) {
    const rawKeys = Object.getOwnPropertyNames(obj);
    if (rawKeys.includes("__proto__")) {
      throw new ValidationError(`Forbidden prototype pollution property '__proto__' at ${path}`, {
        details: { path, securityViolation: true },
      });
    }
  }

  for (const key of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(FORBIDDEN_PRIVATE_PROPERTY_KEYS, key)) {
      throw new ValidationError(`Forbidden private property '${key}' at ${path}`, {
        details: { path, forbiddenKey: key, securityViolation: true },
      });
    }
  }

  // Detect raw DynamoDB typed attribute descriptor maps
  const keys = Object.keys(obj);
  if (
    keys.length === 1 &&
    Object.prototype.hasOwnProperty.call(DYNAMODB_ATTRIBUTE_DESCRIPTOR_KEYS, keys[0])
  ) {
    const val = obj[keys[0]];
    const valTag = Object.prototype.toString.call(val);
    if (
      (keys[0] === "S" && valTag === "[object String]" && path.includes(".")) ||
      (keys[0] === "N" &&
        (valTag === "[object String]" || valTag === "[object Number]") &&
        path.includes(".")) ||
      (keys[0] === "BOOL" && valTag === "[object Boolean]")
    ) {
      throw new ValidationError(
        `Raw low-level database descriptor map { ${keys[0]}: ... } detected at ${path}`,
        {
          details: { path, detectedKey: keys[0], violation: "db_descriptor_leak" },
        },
      );
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    assertNoPrivateImplementationObjects(value, `${path}.${key}`);
  }
}
/**
 * Reusable strict parser helper.
 * Rejects private implementation objects and enforces schema validation.
 */
export function strictParse<T>(
  schema: z.ZodType<T>,
  data: ProtocolPayloadValue,
  context?: string,
): T {
  assertNoPrivateImplementationObjects(data, context ?? "$");
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    const formattedError = issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(
      `Strict wire validation failed for ${context ?? "payload"}: ${formattedError}`,
      {
        details: {
          context,
          issues: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
          isTerminal: true,
        },
      },
    );
  }
  return result.data;
}
export const ProtocolCompressionSchema = z
  .enum(["none", "gzip", "zstd", "deflate"])
  .default("none");
export type ProtocolCompression = z.infer<typeof ProtocolCompressionSchema>;

/**
 * OpenTelemetry-compatible W3C distributed trace context.
 */
export const TraceContextSchema = z
  .object({
    traceId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
    traceFlags: z.string().optional(),
    baggage: z.record(z.string()).optional(),
  })
  .strict();
export type TraceContext = z.infer<typeof TraceContextSchema>;

/**
 * Core protocol envelope wrapping all client-to-cloud and cloud-to-client messages.
 * Wire parsing strictly requires an explicit semantic version (no schema-level defaulting on incoming wire).
 */
export const ProtocolMessageEnvelopeSchema = z
  .object({
    version: SupportedProtocolVersionSchema,
    messageId: IdentifierSchema,
    deviceId: IdentifierSchema,
    installationId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    causationId: IdentifierSchema.optional(),
    correlationId: IdentifierSchema.optional(),
    createdAt: ISOTimestampSchema,
    expiresAt: ISOTimestampSchema.optional(),
    idempotencyKey: z.string().min(1).optional(),
    compression: ProtocolCompressionSchema,
    payloadType: z.string().min(1),
    payloadDigest: Sha256DigestSchema,
    traceContext: TraceContextSchema.optional(),
    payload: ProtocolPayloadSchema,
    signature: z.string().optional(),
  })
  .strict();

export interface ProtocolMessageEnvelope<T = ProtocolPayloadValue> {
  version: string;
  messageId: string;
  deviceId: string;
  installationId: string;
  workspaceId: string;
  sequence: number;
  causationId?: string;
  correlationId?: string;
  createdAt: string;
  expiresAt?: string;
  idempotencyKey?: string;
  compression: ProtocolCompression;
  payloadType: string;
  payloadDigest: string;
  traceContext?: TraceContext;
  payload: T;
  signature?: string;
}

/**
 * Options for constructing a ProtocolMessageEnvelope.
 */
export interface CreateProtocolEnvelopeOptions<T = ProtocolPayloadValue> {
  payloadType: string;
  payload: T;
  deviceId: string;
  installationId: string;
  workspaceId: string;
  sequence: number;
  messageId?: string;
  version?: string;
  causationId?: string;
  correlationId?: string;
  createdAt?: string;
  expiresAt?: string;
  idempotencyKey?: string;
  compression?: ProtocolCompression;
  payloadDigest?: string;
  traceContext?: TraceContext;
  signature?: string;
}

/**
 * Creates a strongly-typed, canonical-digest-verified ProtocolMessageEnvelope.
 * Default version "1.0.0" is populated for producers if omitted in options.
 */
export function createProtocolEnvelope<T = ProtocolPayloadValue>(
  options: CreateProtocolEnvelopeOptions<T>,
): ProtocolMessageEnvelope<T> {
  const messageId = options.messageId ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const compression = options.compression ?? "none";
  const version = options.version ?? PROTOCOL_VERSION;
  assertNoPrivateImplementationObjects(options.payload, "payload");
  const canonicalPayload = ProtocolPayloadSchema.parse(options.payload);
  const payloadDigest = options.payloadDigest ?? hashCanonicalContent(canonicalPayload);

  assertSupportedProtocolVersion(version, "createProtocolEnvelope");

  const envelope: ProtocolMessageEnvelope<T> = {
    version,
    messageId,
    deviceId: options.deviceId,
    installationId: options.installationId,
    workspaceId: options.workspaceId,
    sequence: options.sequence,
    causationId: options.causationId,
    correlationId: options.correlationId,
    createdAt,
    expiresAt: options.expiresAt,
    idempotencyKey: options.idempotencyKey,
    compression,
    payloadType: options.payloadType,
    payloadDigest,
    traceContext: options.traceContext,
    payload: options.payload,
    signature: options.signature,
  };

  // SAFETY: Constructed envelope conforms to ProtocolMessageEnvelopeSchema and wraps typed payload T.
  return ProtocolMessageEnvelopeSchema.parse(envelope) as ProtocolMessageEnvelope<T>;
}

export interface ValidateProtocolEnvelopeOptions {
  maxSkewMs?: number;
  serverTime?: number;
  serverTimestamp?: string;
  allowExpired?: boolean;
  verifyDigest?: boolean;
  enforceVersion?: boolean;
  rejectPrivateObjects?: boolean;
}

/**
 * Validates a protocol message envelope structure and optionally parses payload against schema.
 * Rejects missing versions, unsupported major versions, unknown envelope fields, and private objects.
 */
export function validateProtocolEnvelope<T>(
  raw: ProtocolPayloadValue | ProtocolMessageEnvelope<T>,
  payloadSchema?: z.ZodType<T>,
  options: ValidateProtocolEnvelopeOptions = {},
): ProtocolMessageEnvelope<T> {
  const {
    maxSkewMs,
    serverTime,
    serverTimestamp,
    allowExpired = false,
    verifyDigest = false,
    enforceVersion = true,
    rejectPrivateObjects = true,
  } = options;

  if (rejectPrivateObjects) {
    assertNoPrivateImplementationObjects(raw, "envelope");
  }

  // Parse envelope with strict schema validation
  const parsed = ProtocolMessageEnvelopeSchema.parse(raw);

  if (enforceVersion) {
    assertSupportedProtocolVersion(parsed.version, "ProtocolMessageEnvelope");
  }

  const effectiveServerTime =
    serverTime ?? (serverTimestamp ? new Date(serverTimestamp).getTime() : Date.now());

  if (!allowExpired && isEnvelopeExpired(parsed, effectiveServerTime)) {
    throw new ValidationError("Protocol message envelope has expired", {
      details: { messageId: parsed.messageId, expiresAt: parsed.expiresAt },
    });
  }

  if (maxSkewMs !== undefined) {
    assertEnvelopeClockSkew(parsed, {
      maxSkewMs,
      serverTime: effectiveServerTime,
    });
  }

  if (verifyDigest && !verifyPayloadDigest(parsed)) {
    throw new ChecksumMismatchError(
      parsed.payloadDigest,
      hashCanonicalContent(parsed.payload),
      `Payload digest mismatch for message ${parsed.messageId}`,
    );
  }

  if (payloadSchema) {
    const validatedPayload = payloadSchema.parse(parsed.payload);
    return {
      ...parsed,
      payload: validatedPayload,
    };
  }
  // SAFETY: Without an explicit payload schema, the parsed wire envelope payload is passed through to the caller.
  return {
    ...parsed,
    payload: parsed.payload as T,
  };
}

/**
 * Verifies that the canonical hash of the envelope payload matches payloadDigest.
 */
export function verifyPayloadDigest<TPayload>(envelope: {
  payload: TPayload;
  payloadDigest: string;
}): boolean {
  const canonicalPayload = ProtocolPayloadSchema.parse(envelope.payload);
  const computed = hashCanonicalContent(canonicalPayload);
  const normalizedExpected = normalizeSha256(envelope.payloadDigest);
  const normalizedComputed = normalizeSha256(computed);

  if (normalizedExpected !== normalizedComputed) {
    throw new ChecksumMismatchError(normalizedExpected, normalizedComputed);
  }
  return true;
}

/**
 * Asserts that raw value is a valid protocol message envelope.
 */
export function assertValidProtocolEnvelope<T>(
  raw: ProtocolPayloadValue | ProtocolMessageEnvelope<T>,
  payloadSchema?: z.ZodType<T>,
  options?: ValidateProtocolEnvelopeOptions,
): asserts raw is ProtocolMessageEnvelope<T> {
  validateProtocolEnvelope(raw, payloadSchema, options);
}

/**
 * Checks whether an envelope's optional expiration timestamp has passed.
 */
export function isEnvelopeExpired(
  envelope: { expiresAt?: string },
  currentTime = Date.now(),
): boolean {
  if (!envelope.expiresAt) return false;
  return new Date(envelope.expiresAt).getTime() <= currentTime;
}

/**
 * Asserts that the envelope createdAt timestamp is within maximum clock skew tolerance.
 */
export function assertEnvelopeClockSkew(
  envelope: { createdAt: string },
  options: { serverTimestamp?: string; serverTime?: number; maxSkewMs?: number } = {},
): void {
  const maxSkewMs = options.maxSkewMs ?? 300_000; // 5 minutes default
  const serverTime =
    options.serverTime ??
    (options.serverTimestamp ? new Date(options.serverTimestamp).getTime() : Date.now());
  const createdAtMs = new Date(envelope.createdAt).getTime();

  if (Number.isNaN(createdAtMs)) {
    throw new ValidationError("Envelope createdAt is not a valid ISO timestamp", {
      details: { createdAt: envelope.createdAt },
    });
  }

  const skew = Math.abs(serverTime - createdAtMs);
  if (skew > maxSkewMs) {
    throw new ClockSkewError(
      `Clock skew of ${skew}ms exceeds maximum tolerance of ${maxSkewMs}ms`,
      new Date(serverTime).toISOString(),
      envelope.createdAt,
      skew,
    );
  }
}
