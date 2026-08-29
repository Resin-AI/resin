import { z } from "zod";
import { canonicalJsonStringify, hashCanonicalContent } from "./canonical.js";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  UUIDSchema,
  normalizeSha256,
} from "./common.js";
import { type SignatureMetadata, SignatureMetadataSchema } from "./versions.js";

/**
 * Standard literal version string for v1 contracts.
 */
export const CURRENT_V1_CONTRACTS_VERSION = "1.0.0";
export const V1_SCHEMA_VERSION = "1.0.0";

/**
 * Standard Schema Kind Literals for V1.
 */
export const V1_SCHEMA_KINDS = {
  OWNER_AUTHORIZATION: "owner_authorization",
  PROJECT_METADATA: "project_metadata",
  TOOL_LOCK: "tool_lock",
  ACTIVATION_CERTIFICATE: "activation_certificate",
  REVOCATION_METADATA: "revocation_metadata",
  SAVINGS_EVIDENCE: "savings_evidence",
} as const;

export type V1SchemaKind = (typeof V1_SCHEMA_KINDS)[keyof typeof V1_SCHEMA_KINDS];

// ============================================================================
// Error Definitions
// ============================================================================

/**
 * Thrown when an unsupported schema version is encountered.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly schemaKind: string,
    public readonly receivedVersion: unknown,
    message?: string,
  ) {
    super(
      message ??
        `Unsupported schema version '${String(receivedVersion)}' for kind '${schemaKind}'. Supported version is '${V1_SCHEMA_VERSION}'.`,
    );
    this.name = "UnsupportedSchemaVersionError";
  }
}

/**
 * Thrown when deterministic migration between schema versions fails.
 */
export class SchemaMigrationError extends Error {
  constructor(
    public readonly schemaKind: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`Migration failed for schema kind '${schemaKind}': ${message}`);
    this.name = "SchemaMigrationError";
  }
}

/**
 * Thrown when committed metadata contains absolute paths, credentials, tokens, or executable payloads.
 */
export class CommittedMetadataSecurityError extends Error {
  constructor(
    message: string,
    public readonly violationPath?: string,
  ) {
    super(`Committed metadata security violation: ${message}`);
    this.name = "CommittedMetadataSecurityError";
  }
}

/**
 * Thrown when offline revocation lease has expired, clock rollback is detected, or sequence numbers regress.
 */
export class RevocationFreshnessError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "EXPIRED_LEASE"
      | "CLOCK_ROLLBACK"
      | "SEQUENCE_ROLLBACK"
      | "LEASE_WINDOW_EXCEEDED",
  ) {
    super(`Revocation freshness check failed (${code}): ${message}`);
    this.name = "RevocationFreshnessError";
  }
}

// ============================================================================
// Normalized SHA-256 & Exact SemVer Schemas
// ============================================================================

/**
 * Normalized SHA-256 Digest Schema.
 * Accepts lowercase or uppercase 64-hex strings (with optional 'sha256:' prefix) and transforms to 64-hex lowercase.
 */
export const V1Sha256DigestSchema = z
  .string()
  .regex(
    /^(sha256:)?[a-f0-9]{64}$/i,
    "Invalid SHA-256 digest format (expected 64 hex characters with optional sha256: prefix)",
  )
  .transform((val) => normalizeSha256(val, false));

/**
 * Exact Semantic Version Schema (SemVer 2.0.0).
 * Rejects version range specifiers and wildcards (^, ~, *, >, <, =).
 */
export const V1ExactSemVerSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    "Invalid semantic version string",
  )
  .refine((val) => !/[*^~><=]/.test(val), {
    message: "Version ranges and wildcards (^, ~, *, >, <) are prohibited in exact pinned versions",
  });

export type V1ExactSemVer = z.infer<typeof V1ExactSemVerSchema>;

// ============================================================================
// Safe Committed Metadata Restrictions
// ============================================================================

const FORBIDDEN_KEY_PATTERNS = [
  /^password$/i,
  /^secret$/i,
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^private[_-]?key$/i,
  /^authorization$/i,
  /^credentials$/i,
  /^session[_-]?token$/i,
  /^oauth[_-]?token$/i,
  /^cookies?$/i,
];

const FORBIDDEN_STRING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^[a-zA-Z]:[/\\]/,
    reason: "Absolute Windows drive path prohibited in committed metadata",
  },
  { pattern: /^\\\\/, reason: "UNC network path prohibited in committed metadata" },
  { pattern: /^\/[a-zA-Z0-9_-]+/, reason: "Absolute Unix path prohibited in committed metadata" },
  { pattern: /^file:\/\//i, reason: "file:// URI scheme prohibited in committed metadata" },
  {
    pattern: /\/(?:Users|home|root|etc|var|tmp|private)\//i,
    reason: "Machine-specific system directory path prohibited",
  },
  {
    pattern: /[a-zA-Z]:\\(?:Users|Documents and Settings|Program Files|Windows)/i,
    reason: "Machine-specific Windows directory path prohibited",
  },
  {
    pattern: /(?:^|[/\\])\.\.(?:[/\\]|$)/,
    reason: "Path traversal ('..') prohibited in committed metadata",
  },
  { pattern: /^~[/\\]/, reason: "Home directory shortcut ('~') prohibited in committed metadata" },
  { pattern: /sk-[a-zA-Z0-9_-]{20,}/, reason: "API key pattern detected" },
  { pattern: /bearer\s+[a-zA-Z0-9._~+/-]{16,}/i, reason: "Bearer access token detected" },
  { pattern: /gh[pousr]_[a-zA-Z0-9]{20,}/, reason: "GitHub token detected" },
  { pattern: /xox[baprs]-[a-zA-Z0-9-]+/, reason: "Slack token detected" },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    reason: "Cryptographic private key detected",
  },
  { pattern: /^ssh-(?:rsa|ed25519)\s+AAAA/, reason: "SSH key payload detected" },
  { pattern: /<script\b/i, reason: "Executable HTML/script payload detected" },
  { pattern: /eval\s*\(/i, reason: "Executable eval call detected" },
  { pattern: /^#!\/(?:usr\/)?bin\//, reason: "Executable shebang script payload detected" },
  { pattern: /process\.exit\s*\(/, reason: "Executable process control payload detected" },
  {
    pattern: /(?:child_process|execSync|spawnSync)\b/,
    reason: "Executable child process invocation detected",
  },
];

/**
 * Asserts that a JavaScript data structure contains no absolute paths, credentials,
 * access tokens, path traversal, or executable payloads.
 */
export function assertSafeCommittedMetadata(data: unknown, currentPath = "root"): void {
  if (data === null || data === undefined) {
    return;
  }

  if (typeof data === "string") {
    for (const { pattern, reason } of FORBIDDEN_STRING_PATTERNS) {
      if (pattern.test(data)) {
        throw new CommittedMetadataSecurityError(`${reason} at '${currentPath}'`, currentPath);
      }
    }
    return;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertSafeCommittedMetadata(data[i], `${currentPath}[${i}]`);
    }
    return;
  }

  if (typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      for (const pattern of FORBIDDEN_KEY_PATTERNS) {
        if (pattern.test(key)) {
          throw new CommittedMetadataSecurityError(
            `Forbidden credential/secret field '${key}' detected at '${currentPath}.${key}'`,
            `${currentPath}.${key}`,
          );
        }
      }
      assertSafeCommittedMetadata(value, `${currentPath}.${key}`);
    }
    return;
  }

  throw new CommittedMetadataSecurityError(
    `Unsupported data type '${typeof data}' in committed metadata at '${currentPath}'`,
    currentPath,
  );
}

const V1_PROHIBITED_PROPERTY_KEYS: Record<string, true> = {
  prompt: true,
  prompts: true,
  rawprompt: true,
  rawprompts: true,
  userprompt: true,
  userprompts: true,
  systemprompt: true,
  systemprompts: true,
  completion: true,
  completions: true,
  rawcompletion: true,
  rawcompletions: true,
  transcript: true,
  transcripts: true,
  rawtranscript: true,
  rawtranscripts: true,
  source: true,
  rawsource: true,
  sourcecode: true,
  sessioncontent: true,
  sessionlog: true,
  chatlog: true,
  historylog: true,
  message: true,
  messages: true,
  usermessage: true,
  assistantmessage: true,
  rawresponse: true,
  rawrequest: true,
};

/**
 * Enforces the V1 evidence boundary: raw prompts, transcripts, source, and model
 * messages must never enter committed or Cloud-hosted evidence envelopes.
 */
export function assertV1NoProhibitedProperties(data: unknown, currentPath = "root"): void {
  assertSafeCommittedMetadata(data, currentPath);

  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${path}[${index}]`);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (V1_PROHIBITED_PROPERTY_KEYS[key.toLowerCase().replace(/[^a-z0-9]/g, "")]) {
        throw new CommittedMetadataSecurityError(
          `Prohibited raw evidence field '${key}' detected at '${childPath}'`,
          childPath,
        );
      }
      visit(child, childPath);
    }
  };

  visit(data, currentPath);
}

// ============================================================================
// Area 1: Owner & Scope Authorization
// ============================================================================

export const V1OwnerTypeSchema = z.enum(["user", "workspace", "account", "organization"]);
export type V1OwnerType = z.infer<typeof V1OwnerTypeSchema>;

export const V1RoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type V1Role = z.infer<typeof V1RoleSchema>;

export const V1OwnerReferenceSchema = z
  .object({
    ownerType: V1OwnerTypeSchema,
    ownerId: UUIDSchema,
    accountId: UUIDSchema,
  })
  .strict();

export type V1OwnerReference = z.infer<typeof V1OwnerReferenceSchema>;

export const V1PersonalScopeSchema = z
  .object({
    scopeType: z.literal("personal"),
    userId: UUIDSchema,
    accountId: UUIDSchema,
  })
  .strict();

export const V1WorkspaceScopeSchema = z
  .object({
    scopeType: z.literal("workspace"),
    workspaceId: UUIDSchema,
    accountId: UUIDSchema,
  })
  .strict();

export const V1AccountScopeSchema = z
  .object({
    scopeType: z.literal("account"),
    accountId: UUIDSchema,
  })
  .strict();

export const V1OrganizationScopeSchema = z
  .object({
    scopeType: z.literal("organization"),
    organizationId: UUIDSchema,
    accountId: UUIDSchema,
  })
  .strict();

export const V1AuthorizationScopeSchema = z.discriminatedUnion("scopeType", [
  V1PersonalScopeSchema,
  V1WorkspaceScopeSchema,
  V1AccountScopeSchema,
  V1OrganizationScopeSchema,
]);

export type V1AuthorizationScope = z.infer<typeof V1AuthorizationScopeSchema>;
export type V1ScopeType = V1AuthorizationScope["scopeType"];

export const V1SubjectTypeSchema = z.enum(["user", "service_account", "device", "mcp_client"]);
export type V1SubjectType = z.infer<typeof V1SubjectTypeSchema>;

export const V1OwnerAuthorizationSchema = z
  .object({
    schemaKind: z.literal(V1_SCHEMA_KINDS.OWNER_AUTHORIZATION),
    schemaVersion: z.literal(V1_SCHEMA_VERSION),
    authorizationId: UUIDSchema,
    subjectId: UUIDSchema,
    subjectType: V1SubjectTypeSchema,
    owner: V1OwnerReferenceSchema,
    scope: V1AuthorizationScopeSchema,
    roles: z.array(V1RoleSchema).min(1),
    permissions: z.array(z.string().min(1)),
    issuedAt: ISOTimestampSchema,
    expiresAt: ISOTimestampSchema.optional(),
  })
  .strict();

export type V1OwnerAuthorization = z.infer<typeof V1OwnerAuthorizationSchema>;

// ============================================================================
// Area 2: .resin/project.json (Project Metadata)
// ============================================================================

export const V1ProjectSettingsSchema = z
  .object({
    defaultRuntimeVersion: V1ExactSemVerSchema.optional(),
    environment: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
  })
  .strict();

export type V1ProjectSettings = z.infer<typeof V1ProjectSettingsSchema>;

export const V1ProjectMetadataSchema = z
  .object({
    schemaKind: z.literal(V1_SCHEMA_KINDS.PROJECT_METADATA),
    schemaVersion: z.literal(V1_SCHEMA_VERSION),
    projectId: UUIDSchema,
    name: z.string().min(1).max(128),
    settings: V1ProjectSettingsSchema.optional(),
    createdAt: ISOTimestampSchema,
    updatedAt: ISOTimestampSchema.optional(),
  })
  .strict();

export type V1ProjectMetadata = z.infer<typeof V1ProjectMetadataSchema>;

/**
 * Validates project metadata and enforces committed metadata security restrictions.
 */
export function validateV1ProjectMetadata(data: unknown): V1ProjectMetadata {
  assertSafeCommittedMetadata(data, "project.json");
  return V1ProjectMetadataSchema.parse(data);
}

// ============================================================================
// Area 3: .resin/resin.lock (Tool Lock)
// ============================================================================

export const V1LockSignatureIdentitySchema = z
  .object({
    keyId: z.string().min(1),
    algorithm: z.enum(["ed25519", "ecdsa_p256_sha256", "rsa_pss_sha256"]),
    signer: z.string().min(1).optional(),
  })
  .strict();

export type V1LockSignatureIdentity = z.infer<typeof V1LockSignatureIdentitySchema>;

export const V1LockedToolEntrySchema = z
  .object({
    toolId: UUIDSchema,
    name: IdentifierSchema,
    version: V1ExactSemVerSchema,
    manifestDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    envelopeDigest: Sha256DigestSchema.optional(),
    signatureIdentity: V1LockSignatureIdentitySchema.optional(),
    status: z.enum(["active", "pinned", "disabled"]).default("active"),
  })
  .strict();

export type V1LockedToolEntry = z.infer<typeof V1LockedToolEntrySchema>;

export const V1ToolLockSchema = z
  .object({
    schemaKind: z.literal(V1_SCHEMA_KINDS.TOOL_LOCK),
    schemaVersion: z.literal(V1_SCHEMA_VERSION),
    projectId: UUIDSchema,
    updatedAt: ISOTimestampSchema,
    tools: z.record(IdentifierSchema, V1LockedToolEntrySchema),
  })
  .strict();

export type V1ToolLock = z.infer<typeof V1ToolLockSchema>;

/**
 * Validates tool lockfile and enforces committed metadata security restrictions and key/name parity.
 */
export function validateV1ToolLock(data: unknown): V1ToolLock {
  assertSafeCommittedMetadata(data, "resin.lock");
  const parsed = V1ToolLockSchema.parse(data);
  for (const [key, entry] of Object.entries(parsed.tools)) {
    if (key !== entry.name) {
      throw new Error(
        `Tool entry key mismatch in lockfile: record key '${key}' does not match entry.name '${entry.name}'`,
      );
    }
  }
  return parsed;
}

// ============================================================================
// Area 4: Signed Activation Certificates
// ============================================================================

export const V1CertificateSubjectSchema = z
  .object({
    userId: UUIDSchema,
    accountId: UUIDSchema,
    deviceId: UUIDSchema.optional(),
  })
  .strict();

export type V1CertificateSubject = z.infer<typeof V1CertificateSubjectSchema>;

export const V1ActivationCertificateSchema = z
  .object({
    schemaKind: z.literal(V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE),
    schemaVersion: z.literal(V1_SCHEMA_VERSION),
    certificateId: UUIDSchema,
    subject: V1CertificateSubjectSchema,
    projectId: UUIDSchema,
    toolId: UUIDSchema,
    toolName: IdentifierSchema,
    version: V1ExactSemVerSchema,
    manifestDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    capabilityEnvelopeDigest: Sha256DigestSchema,
    qualificationEvidenceDigest: Sha256DigestSchema,
    counter: z.number().int().nonnegative(),
    nonce: z.string().min(8),
    issuedAt: ISOTimestampSchema,
    notBefore: ISOTimestampSchema,
    expiresAt: ISOTimestampSchema,
    status: z.enum(["active", "suspended", "revoked"]).default("active"),
    signature: SignatureMetadataSchema,
  })
  .strict()
  .refine(
    (data) => {
      const issued = new Date(data.issuedAt).getTime();
      const notBefore = new Date(data.notBefore).getTime();
      const expires = new Date(data.expiresAt).getTime();
      return (
        !Number.isNaN(issued) &&
        !Number.isNaN(notBefore) &&
        !Number.isNaN(expires) &&
        notBefore <= expires &&
        issued <= expires
      );
    },
    {
      message:
        "Certificate validity window invalid: issuedAt and notBefore must be before or equal to expiresAt",
    },
  );

export type V1ActivationCertificate = z.infer<typeof V1ActivationCertificateSchema>;

/**
 * Projects a signable representation of an Activation Certificate (omitting the signature field).
 */
export function projectSignableActivationCertificate(
  cert: V1ActivationCertificate | unknown,
): Record<string, unknown> {
  const parsed = V1ActivationCertificateSchema.parse(cert);
  const { signature: _sig, ...signable } = parsed;
  return signable;
}

/**
 * Validates an Activation Certificate.
 */
export function validateV1ActivationCertificate(data: unknown): V1ActivationCertificate {
  return V1ActivationCertificateSchema.parse(data);
}

// ============================================================================
// Area 5: Signed Revocation & Offline Freshness
// ============================================================================

export const V1RevokedToolEntrySchema = z
  .object({
    toolId: UUIDSchema,
    version: V1ExactSemVerSchema.optional(),
    revokedAt: ISOTimestampSchema,
    reason: z.string().min(1),
  })
  .strict();

export type V1RevokedToolEntry = z.infer<typeof V1RevokedToolEntrySchema>;

export const V1RevokedCertificateEntrySchema = z
  .object({
    certificateId: UUIDSchema,
    revokedAt: ISOTimestampSchema,
    reason: z.string().min(1),
  })
  .strict();

export type V1RevokedCertificateEntry = z.infer<typeof V1RevokedCertificateEntrySchema>;

export const V1RevocationMetadataSchema = z
  .object({
    schemaKind: z.literal(V1_SCHEMA_KINDS.REVOCATION_METADATA),
    schemaVersion: z.literal(V1_SCHEMA_VERSION),
    revocationListId: UUIDSchema,
    authorityId: z.string().min(1),
    accountId: UUIDSchema,
    sequenceNumber: z.number().int().nonnegative(),
    issuedAt: ISOTimestampSchema,
    expiresAt: ISOTimestampSchema,
    revokedTools: z.array(V1RevokedToolEntrySchema).default([]),
    revokedCertificates: z.array(V1RevokedCertificateEntrySchema).default([]),
    revokedKeys: z.array(z.string().min(1)).default([]),
    signature: SignatureMetadataSchema,
  })
  .strict()
  .refine(
    (data) => {
      const issued = new Date(data.issuedAt).getTime();
      const expires = new Date(data.expiresAt).getTime();
      return !Number.isNaN(issued) && !Number.isNaN(expires) && issued <= expires;
    },
    {
      message:
        "Revocation metadata timestamps invalid: issuedAt must be before or equal to expiresAt",
    },
  );

export type V1RevocationMetadata = z.infer<typeof V1RevocationMetadataSchema>;

/**
 * Projects a signable representation of Revocation Metadata (omitting the signature field).
 */
export function projectSignableRevocationMetadata(
  metadata: V1RevocationMetadata | unknown,
): Record<string, unknown> {
  const parsed = V1RevocationMetadataSchema.parse(metadata);
  const { signature: _sig, ...signable } = parsed;
  return signable;
}

/**
 * Validates Revocation Metadata.
 */
export function validateV1RevocationMetadata(data: unknown): V1RevocationMetadata {
  return V1RevocationMetadataSchema.parse(data);
}

export interface V1OfflineFreshnessVerificationOptions {
  currentDeviceTime?: string | Date;
  lastKnownSequenceNumber?: number;
  maxOfflineLeaseMs?: number;
}

/**
 * Verifies that offline revocation metadata is currently valid, within lease, and monotonic against replay.
 */
export function verifyOfflineRevocationFreshness(
  metadata: V1RevocationMetadata,
  options: V1OfflineFreshnessVerificationOptions = {},
): { valid: true } {
  const currentDeviceTime = options.currentDeviceTime
    ? new Date(options.currentDeviceTime).getTime()
    : Date.now();
  const issuedAt = new Date(metadata.issuedAt).getTime();
  const expiresAt = new Date(metadata.expiresAt).getTime();

  if (Number.isNaN(currentDeviceTime)) {
    throw new RevocationFreshnessError("Invalid currentDeviceTime provided", "CLOCK_ROLLBACK");
  }

  // Clock rollback detection
  if (currentDeviceTime < issuedAt) {
    throw new RevocationFreshnessError(
      `Clock rollback detected: current device time (${new Date(currentDeviceTime).toISOString()}) is before metadata issuedAt (${metadata.issuedAt})`,
      "CLOCK_ROLLBACK",
    );
  }

  // Lease expiry check
  if (currentDeviceTime > expiresAt) {
    throw new RevocationFreshnessError(
      `Offline lease expired: current device time (${new Date(currentDeviceTime).toISOString()}) is after metadata expiresAt (${metadata.expiresAt})`,
      "EXPIRED_LEASE",
    );
  }

  // Sequence anti-rollback check
  if (options.lastKnownSequenceNumber !== undefined) {
    if (metadata.sequenceNumber < options.lastKnownSequenceNumber) {
      throw new RevocationFreshnessError(
        `Sequence rollback detected: received sequence ${metadata.sequenceNumber} is lower than last known sequence ${options.lastKnownSequenceNumber}`,
        "SEQUENCE_ROLLBACK",
      );
    }
  }

  // Max offline lease window check
  if (options.maxOfflineLeaseMs !== undefined) {
    const leaseDuration = expiresAt - issuedAt;
    if (leaseDuration > options.maxOfflineLeaseMs) {
      throw new RevocationFreshnessError(
        `Lease duration (${leaseDuration}ms) exceeds maximum allowed offline window (${options.maxOfflineLeaseMs}ms)`,
        "LEASE_WINDOW_EXCEEDED",
      );
    }
  }

  return { valid: true };
}

// ============================================================================
// Signable Projections & Hash Computation
// ============================================================================

/**
 * Computes a deterministic SHA-256 hash of any canonical signable object.
 */
export function computeSignableHash(
  signablePayload: Record<string, unknown>,
  prefix = false,
): string {
  return hashCanonicalContent(signablePayload, { prefix });
}

// ============================================================================
// Deterministic Migration Hooks
// ============================================================================

/**
 * Migrates arbitrary project metadata payload to V1ProjectMetadata.
 */
export function migrateV1ProjectMetadata(raw: unknown): V1ProjectMetadata {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.PROJECT_METADATA,
      "Expected non-null object for project metadata migration",
    );
  }

  const record = raw as Record<string, unknown>;

  if (record.schemaVersion !== undefined && record.schemaVersion !== V1_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(V1_SCHEMA_KINDS.PROJECT_METADATA, record.schemaVersion);
  }

  if (record.schemaKind !== undefined && record.schemaKind !== V1_SCHEMA_KINDS.PROJECT_METADATA) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.PROJECT_METADATA,
      `Unexpected schemaKind '${String(record.schemaKind)}'`,
    );
  }

  const projectId = (record.projectId ?? record.id) as string;
  const name = record.name as string;
  const createdAt = (record.createdAt ?? new Date().toISOString()) as string;
  const updatedAt = record.updatedAt as string | undefined;
  const settings = record.settings as V1ProjectSettings | undefined;

  const candidate: V1ProjectMetadata = {
    schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
    schemaVersion: V1_SCHEMA_VERSION,
    projectId,
    name,
    ...(settings !== undefined ? { settings } : {}),
    createdAt,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };

  return validateV1ProjectMetadata(candidate);
}

/**
 * Migrates arbitrary tool lock payload to V1ToolLock.
 */
export function migrateV1ToolLock(raw: unknown): V1ToolLock {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.TOOL_LOCK,
      "Expected non-null object for tool lock migration",
    );
  }

  const record = raw as Record<string, unknown>;

  if (record.schemaVersion !== undefined && record.schemaVersion !== V1_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(V1_SCHEMA_KINDS.TOOL_LOCK, record.schemaVersion);
  }

  if (record.schemaKind !== undefined && record.schemaKind !== V1_SCHEMA_KINDS.TOOL_LOCK) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.TOOL_LOCK,
      `Unexpected schemaKind '${String(record.schemaKind)}'`,
    );
  }

  const projectId = (record.projectId ?? record.id) as string;
  const updatedAt = (record.updatedAt ?? new Date().toISOString()) as string;
  const rawTools = (record.tools ?? {}) as Record<string, Record<string, unknown>>;

  const tools: Record<string, V1LockedToolEntry> = {};
  for (const [key, toolEntry] of Object.entries(rawTools)) {
    const manifestDigest = normalizeSha256(
      (toolEntry.manifestDigest ?? toolEntry.digest) as string,
      false,
    );
    const artifactDigest = normalizeSha256(
      (toolEntry.artifactDigest ?? toolEntry.hash) as string,
      false,
    );
    const envelopeDigest = toolEntry.envelopeDigest
      ? normalizeSha256(toolEntry.envelopeDigest as string, false)
      : undefined;

    tools[key] = {
      toolId: (toolEntry.toolId ?? toolEntry.id) as string,
      name: (toolEntry.name ?? key) as string,
      version: toolEntry.version as string,
      manifestDigest,
      artifactDigest,
      ...(envelopeDigest ? { envelopeDigest } : {}),
      ...(toolEntry.signatureIdentity
        ? { signatureIdentity: toolEntry.signatureIdentity as V1LockSignatureIdentity }
        : {}),
      status: (toolEntry.status ?? "active") as "active" | "pinned" | "disabled",
    };
  }

  const candidate: V1ToolLock = {
    schemaKind: V1_SCHEMA_KINDS.TOOL_LOCK,
    schemaVersion: V1_SCHEMA_VERSION,
    projectId,
    updatedAt,
    tools,
  };

  return validateV1ToolLock(candidate);
}

/**
 * Migrates arbitrary activation certificate payload to V1ActivationCertificate.
 */
export function migrateV1ActivationCertificate(raw: unknown): V1ActivationCertificate {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
      "Expected non-null object for activation certificate migration",
    );
  }

  const record = raw as Record<string, unknown>;

  if (record.schemaVersion !== undefined && record.schemaVersion !== V1_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(
      V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
      record.schemaVersion,
    );
  }

  if (
    record.schemaKind !== undefined &&
    record.schemaKind !== V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE
  ) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE,
      `Unexpected schemaKind '${String(record.schemaKind)}'`,
    );
  }

  return validateV1ActivationCertificate(record);
}

/**
 * Migrates arbitrary revocation metadata payload to V1RevocationMetadata.
 */
export function migrateV1RevocationMetadata(raw: unknown): V1RevocationMetadata {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.REVOCATION_METADATA,
      "Expected non-null object for revocation metadata migration",
    );
  }

  const record = raw as Record<string, unknown>;

  if (record.schemaVersion !== undefined && record.schemaVersion !== V1_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(
      V1_SCHEMA_KINDS.REVOCATION_METADATA,
      record.schemaVersion,
    );
  }

  if (
    record.schemaKind !== undefined &&
    record.schemaKind !== V1_SCHEMA_KINDS.REVOCATION_METADATA
  ) {
    throw new SchemaMigrationError(
      V1_SCHEMA_KINDS.REVOCATION_METADATA,
      `Unexpected schemaKind '${String(record.schemaKind)}'`,
    );
  }

  return validateV1RevocationMetadata(record);
}
