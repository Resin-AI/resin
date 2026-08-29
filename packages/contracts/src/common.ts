import { z } from "zod";

/**
 * Standard Semantic Version schema (SemVer 2.0.0 compliant regex).
 */
export const SchemaVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    "Invalid semantic version string",
  );

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

/**
 * UUIDv4 schema matching standard 8-4-4-4-12 hex format.
 */
export const UUIDSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Invalid UUID string",
  );

export type UUID = z.infer<typeof UUIDSchema>;

/**
 * ULID schema matching Crockford's Base32 26-character format.
 */
export const ULIDSchema = z
  .string()
  .regex(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i, "Invalid ULID string");

export type ULID = z.infer<typeof ULIDSchema>;

/**
 * General identifier schema accepting UUIDs, ULIDs, and prefixed alphanumeric IDs (e.g. 'evt_01J...').
 */
export const IdentifierSchema = z
  .string()
  .min(1, "Identifier cannot be empty")
  .max(128, "Identifier exceeds maximum length of 128 characters")
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}$/, "Identifier contains invalid characters");

export type Identifier = z.infer<typeof IdentifierSchema>;

/**
 * ISO 8601 UTC timestamp schema.
 */
export const ISOTimestampSchema = z
  .string()
  .datetime({ offset: true, message: "Invalid ISO 8601 timestamp string" });

export type ISOTimestamp = z.infer<typeof ISOTimestampSchema>;

/**
 * Milliseconds since Unix epoch timestamp schema.
 */
export const EpochMsSchema = z
  .number()
  .int("Epoch timestamp must be an integer")
  .nonnegative("Epoch timestamp must be non-negative");

export type EpochMs = z.infer<typeof EpochMsSchema>;

/**
 * Canonical timestamp schema defaulting to ISO 8601 string.
 */
export const TimestampSchema = ISOTimestampSchema;
export type Timestamp = ISOTimestamp;

/**
 * SHA-256 Digest schema (with optional 'sha256:' prefix).
 */
export const Sha256DigestSchema = z
  .string()
  .regex(
    /^(sha256:)?[a-f0-9]{64}$/i,
    "Invalid SHA-256 digest format (expected 64 hex characters or sha256:<hex>)",
  );

export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

/**
 * Strict prefixed SHA-256 Digest schema ('sha256:<64-hex>').
 */
export const PrefixedSha256DigestSchema = z
  .string()
  .regex(
    /^sha256:[a-f0-9]{64}$/i,
    "Invalid prefixed SHA-256 digest format (expected sha256:<64-hex>)",
  );

export type PrefixedSha256Digest = z.infer<typeof PrefixedSha256DigestSchema>;

/**
 * Causal reference for ordering, lineage, and distributed tracing.
 */
export const CausalRefSchema = z.object({
  parentId: IdentifierSchema.nullable().optional(),
  rootId: IdentifierSchema.nullable().optional(),
  causalSequence: z
    .number()
    .int("Causal sequence must be an integer")
    .nonnegative("Causal sequence must be non-negative"),
  turnIndex: z
    .number()
    .int("Turn index must be an integer")
    .nonnegative("Turn index must be non-negative")
    .optional(),
  stepIndex: z
    .number()
    .int("Step index must be an integer")
    .nonnegative("Step index must be non-negative")
    .optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
});

export type CausalRef = z.infer<typeof CausalRefSchema>;

/**
 * Redaction metadata documenting privacy transformations applied to a payload.
 */
export const RedactionStrategySchema = z.enum(["mask", "tokenize", "drop", "synthetic", "none"]);

export type RedactionStrategy = z.infer<typeof RedactionStrategySchema>;

export const RedactionMetaSchema = z.object({
  isRedacted: z.boolean(),
  redactedFields: z.array(z.string()).default([]),
  redactionStrategy: RedactionStrategySchema.default("none"),
  scrubbedPatterns: z.array(z.string()).default([]),
  redactedAt: ISOTimestampSchema.optional(),
});

export type RedactionMeta = z.infer<typeof RedactionMetaSchema>;

/**
 * Helper to return current UTC timestamp in ISO 8601 format.
 */
export function nowIso(): ISOTimestamp {
  return new Date().toISOString();
}

/**
 * Validates whether a string is a 64-character hex or sha256:<hex> string.
 */
export function isValidSha256(digest: string): boolean {
  return /^(sha256:)?[a-f0-9]{64}$/i.test(digest);
}

/**
 * Normalizes a SHA-256 digest to lowercase, with or without prefix.
 */
export function normalizeSha256(digest: string, prefix = false): string {
  const cleanHex = digest.toLowerCase().replace(/^sha256:/, "");
  if (cleanHex.length !== 64 || !/^[a-f0-9]{64}$/.test(cleanHex)) {
    throw new Error(`Invalid SHA-256 digest: ${digest}`);
  }
  return prefix ? `sha256:${cleanHex}` : cleanHex;
}
