import {
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type DeploymentRecord,
  DeploymentRecordSchema,
  type DeploymentState,
  DeploymentStateSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  type InstallationRecord,
  InstallationRecordSchema,
  type NormalizedSessionEvent,
  NormalizedSessionEventSchema,
  type RedactionMeta,
  RedactionMetaSchema,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  UUIDSchema,
  type V1ActivationCertificate,
  V1ActivationCertificateSchema,
  type V1LockedToolEntry,
  V1LockedToolEntrySchema,
  type V1RevocationMetadata,
  V1RevocationMetadataSchema,
  type V1ToolLock,
  V1ToolLockSchema,
} from "@resin/contracts";
import { z } from "zod";

/**
 * Supported deployment command types.
 */
export const DeploymentCommandTypeSchema = z.enum([
  "deploy",
  "activate",
  "canary",
  "rollback",
  "suspend",
  "resume",
  "retire",
]);

export type DeploymentCommandType = z.infer<typeof DeploymentCommandTypeSchema>;

/**
 * Wire/Stream message for a deployment control command.
 */
export const DeploymentCommandMessageSchema = z.object({
  commandId: IdentifierSchema,
  commandType: DeploymentCommandTypeSchema,
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  workspaceId: IdentifierSchema.optional(),
  projectId: IdentifierSchema.optional(),
  targetDigest: Sha256DigestSchema.optional(),
  canaryWeight: z.number().int().min(0).max(100).optional(),
  rollbackToVersion: SchemaVersionSchema.optional(),
  rollbackToSnapshotId: IdentifierSchema.optional(),
  reason: z.string().optional(),
  timestamp: ISOTimestampSchema,
  bundleUrl: z.string().optional(),
  artifactUri: z.string().optional(),
  manifest: ToolManifestSchema.optional(),
  signature: z.record(z.unknown()).optional(),
  lockedEntry: V1LockedToolEntrySchema.optional(),
  certificate: V1ActivationCertificateSchema.optional(),
  trustVerification: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type DeploymentCommandMessage = z.infer<typeof DeploymentCommandMessageSchema>;

/**
 * Local deployment lifecycle states.
 */
export const LocalDeploymentStateSchema = z.enum([
  "staged",
  "activating",
  "active",
  "canary",
  "suspended",
  "rolling_back",
  "rolled_back",
  "retired",
  "rejected",
  "broken",
  "failed",
]);

export type LocalDeploymentState = z.infer<typeof LocalDeploymentStateSchema>;

/**
 * Status report of deployment synchronization sent back to cloud control stream.
 */
export const DeploymentSyncStatusReportSchema = z.object({
  reportId: IdentifierSchema,
  commandId: IdentifierSchema.optional(),
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  workspaceId: IdentifierSchema,
  status: LocalDeploymentStateSchema,
  previousStatus: LocalDeploymentStateSchema.optional(),
  activeTrafficPercentage: z.number().min(0).max(100).default(0),
  appliedAt: ISOTimestampSchema,
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.unknown()).default({}),
  catalogRevision: z.number().int().nonnegative().optional(),
  catalogDigest: Sha256DigestSchema.optional(),
});

export type DeploymentSyncStatusReport = z.infer<typeof DeploymentSyncStatusReportSchema>;

/**
 * Tool override record for local user pin/disable controls.
 */
export const ToolOverrideRecordSchema = z.object({
  overrideId: IdentifierSchema.optional(),
  toolId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  action: z.enum(["disable", "pin", "allow", "custom"]),
  pinnedVersion: SchemaVersionSchema.optional(),
  isEnabled: z.boolean().default(true),
  createdAt: ISOTimestampSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type ToolOverrideRecord = z.infer<typeof ToolOverrideRecordSchema>;

/**
 * User controls interface for pin/disable management.
 */
export interface UserControls {
  workspaceId: string;
  pinnedVersions: Record<string, string>;
  disabledTools: string[];
  frozenTools?: string[];
  rollbacks?: Array<{
    targetRevision: number | string;
    timestamp: string;
    restoredSnapshotId?: string;
    toolId?: string;
  }>;
}

/**
 * Types of actions taken during sync reconciliation.
 */
export const SyncReconciliationActionTypeSchema = z.enum([
  "activated",
  "suspended",
  "resumed",
  "rolled_back",
  "downloaded",
  "staged",
  "rejected",
  "skipped",
  "uninstalled",
  "retired",
]);

export type SyncReconciliationActionType = z.infer<typeof SyncReconciliationActionTypeSchema>;

/**
 * Single reconciliation action result.
 */
export const SyncReconciliationActionSchema = z.object({
  toolId: IdentifierSchema,
  deploymentId: IdentifierSchema.optional(),
  version: SchemaVersionSchema.optional(),
  action: SyncReconciliationActionTypeSchema,
  reason: z.string(),
  status: z.enum(["success", "failure", "skipped"]),
  error: z.string().optional(),
});

export type SyncReconciliationAction = z.infer<typeof SyncReconciliationActionSchema>;

/**
 * Result summary of a desired vs actual state reconciliation run.
 */
export const SyncReconciliationResultSchema = z.object({
  workspaceId: IdentifierSchema,
  reconciledAt: ISOTimestampSchema,
  actions: z.array(SyncReconciliationActionSchema).default([]),
  activeTools: z.record(SchemaVersionSchema).default({}),
  suspendedTools: z.array(IdentifierSchema).default([]),
  rolledBackTools: z.array(IdentifierSchema).default([]),
  pendingActionsCount: z.number().int().nonnegative().default(0),
  appliedActionsCount: z.number().int().nonnegative().default(0),
  errorCount: z.number().int().nonnegative().default(0),
  errors: z
    .array(
      z.object({
        toolId: IdentifierSchema.optional(),
        error: z.string(),
      }),
    )
    .default([]),
});

export type SyncReconciliationResult = z.infer<typeof SyncReconciliationResultSchema>;

/**
 * Catalog change notification event payload (TE-018 compatible).
 */
export interface CatalogChangeEvent {
  workspaceId: string;
  sessionId?: string;
  revision: number;
  snapshot: CatalogSnapshot;
  changedToolIds: string[];
  timestamp: string;
}

/**
 * Preactivation violation detail.
 */
export interface PreactivationViolation {
  code: string;
  subsystem:
    | "fs"
    | "net"
    | "command"
    | "secrets"
    | "limits"
    | "override"
    | "runtime"
    | "security"
    | "manifest"
    | "lock"
    | "certificate"
    | "trust"
    | "capability";
  message: string;
  field?: string;
  requestedValue?: unknown;
}

/**
 * Possible outcomes for a preactivation check.
 */
export type PreactivationCheckOutcome =
  | "eligible"
  | "blocked_by_capability"
  | "rejected"
  | "untrusted"
  | "mismatch";

/**
 * Preactivation inspection and constraint check result.
 */
export interface PreactivationCheckResult {
  eligible: boolean;
  outcome?: PreactivationCheckOutcome;
  violations: PreactivationViolation[];
  warnings: string[];
  metadata: Record<string, unknown>;
}

/**
 * Data-only trust verification result (no runtime dependencies).
 */
export interface TrustVerificationResult {
  trusted: boolean;
  certificate?: V1ActivationCertificate;
  revocationMetadata?: V1RevocationMetadata;
  reason?: string;
  errorCode?: string;
}

/**
 * Inspection file entry within a downloaded artifact.
 */
export interface ArtifactFileEntry {
  path: string;
  sizeBytes: number;
  digest: string;
}

/**
 * Non-executing loader inspection result for a downloaded artifact.
 */
export interface ArtifactInspectionResult {
  manifest: ToolManifest;
  bundleDigest: string;
  manifestDigest?: string;
  artifactDigest?: string;
  qualificationEvidenceDigest?: string;
  files: ArtifactFileEntry[];
  rawSignature?: Record<string, unknown>;
  signature?: {
    keyId: string;
    algorithm: string;
    valid: boolean;
    trustLevel: string;
    error?: string;
  };
  attestation?: SafetyAttestationRecord;
  rawAttestation?: Record<string, unknown>;
}

/**
 * Context passed to preactivation check.
 */
export interface PreactivationContext {
  manifest: ToolManifest;
  workspaceId: string;
  projectId?: string;
  envelope?: CapabilityEnvelope | null;
  overrides?: ToolOverrideRecord[] | null;
  inspection?: ArtifactInspectionResult | null;
  targetVersion?: string;
  targetDigest?: string;
  workspaceRoot?: string;
  lockedEntry?: V1LockedToolEntry | null;
  certificate?: V1ActivationCertificate | null;
  trustVerification?: TrustVerificationResult | null;
}

/**
 * Key store entry for trust chain verification.
 */
export interface SigningKeyEntry {
  keyId: string;
  algorithm: "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa-pss" | "rsa-sha256";
  publicKeyPem: string;
  trustLevel: "production" | "development" | "revoked";
  description?: string;
  expiresAt?: string;
  createdAt: string;
}

/**
 * Key store interface for artifact signature verification.
 */
export interface SigningKeyStore {
  getKey(keyId: string): Promise<SigningKeyEntry | null>;
  hasKey(keyId: string): Promise<boolean>;
  isTrusted(keyId: string, allowDevKeys?: boolean): Promise<boolean>;
  addKey(entry: SigningKeyEntry): Promise<void>;
  revokeKey(keyId: string): Promise<void>;
}

/**
 * Brand symbol for cryptographically and structurally validated sanitized observations.
 */
export const SanitizedObservationBrandSymbol = Symbol.for("resin.sanitized.observation");

export interface SanitizedObservationBrand {
  readonly [SanitizedObservationBrandSymbol]: true;
}

/**
 * Branded, validated Sanitized Observation DTO.
 * Guaranteed to have passed local redaction/sanitization and to contain zero raw transcript,
 * source code, unredacted prompts, secrets, or local database pointers.
 */
export type SanitizedObservationDto = NormalizedSessionEvent & SanitizedObservationBrand;

/**
 * Branded, validated batch of sanitized observations for network transmission.
 */
export interface SanitizedObservationBatchDto {
  readonly [SanitizedObservationBrandSymbol]: true;
  readonly batchId: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly clientTimestamp: string;
  readonly observations: readonly SanitizedObservationDto[];
  readonly cursor?: string;
}

/**
 * Prohibited raw data keys that must never appear anywhere in sync observation structures.
 */
export const PROHIBITED_RAW_DATA_KEYS: readonly string[] = Object.freeze([
  "rawTranscript",
  "transcript",
  "transcripts",
  "rawSession",
  "rawSessions",
  "rawRecords",
  "rawRecordRefs",
  "rawRecord",
  "rawPrompt",
  "unredactedPrompt",
  "unredacted_prompt",
  "sourceCode",
  "source_code",
  "sourceFiles",
  "source_files",
  "fileContent",
  "file_content",
  "fileDiff",
  "file_diff",
  "rawInput",
  "rawOutput",
  "raw_input",
  "raw_output",
  "secret",
  "secrets",
  "apiKey",
  "api_key",
  "bearerToken",
  "bearer_token",
  "privateKey",
  "private_key",
  "sessionRepository",
  "localDatabase",
  "dbConnection",
  "sqliteConnection",
  "rawPayload",
  "raw_payload",
  "systemPrompt",
  "system_prompt",
  "userPrompt",
  "user_prompt",
  "conversationHistory",
]);

/**
 * Secret pattern detectors for fail-closed checks on observation payloads.
 */
export const SENSITIVE_PATTERN_REGEXES: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:sk|ghp|gho|ghu|ghs|xox[baprs]|secp|xkeysib)[-_][a-zA-Z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  /\bpassword\s*[:=]\s*["']?[^\s"']{6,}/i,
]);

/**
 * Error thrown when raw transcript, unredacted secret, or local-only repository
 * is detected attempting to cross the network privacy boundary.
 */
export class RawDataExfiltrationError extends Error {
  readonly code = "ERR_RAW_DATA_EXFILTRATION";
  constructor(
    message: string,
    readonly prohibitedField?: string,
  ) {
    super(message);
    this.name = "RawDataExfiltrationError";
  }
}

/**
 * Error thrown when an observation payload fails schema validation or lacks proper redaction metadata.
 */
export class InvalidSanitizedObservationError extends Error {
  readonly code = "ERR_INVALID_SANITIZED_OBSERVATION";
  constructor(
    message: string,
    readonly validationErrors?: unknown,
  ) {
    super(message);
    this.name = "InvalidSanitizedObservationError";
  }
}

/**
 * Error thrown when an attempt is made to enable raw uploads or bypass local sanitization.
 */
export class RawUploadProhibitedError extends Error {
  readonly code = "ERR_RAW_UPLOAD_PROHIBITED";
  constructor(
    message = "V1 policy strictly prohibits raw transcript, source, and credential uploads; no raw upload path or opt-in exists",
  ) {
    super(message);
    this.name = "RawUploadProhibitedError";
  }
}

/**
 * Recursively inspects any object, array, or primitive for prohibited raw fields,
 * unredacted secrets, or raw session/repository references.
 * Fails closed if any prohibited content or pattern is discovered.
 */
export function assertNoProhibitedRawData(value: unknown, path = ""): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    for (const pattern of SENSITIVE_PATTERN_REGEXES) {
      if (pattern.test(value)) {
        throw new RawDataExfiltrationError(
          `Detected prohibited sensitive pattern in observation data at '${path || "<root>"}': matches ${pattern.toString()}`,
          path,
        );
      }
    }
    return;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return;
  }

  if (typeof value === "function") {
    throw new RawDataExfiltrationError(
      `Functions/methods are strictly prohibited in observation payloads at '${path || "<root>"}'`,
      path,
    );
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoProhibitedRawData(value[i], `${path}[${i}]`);
    }
    return;
  }

  if (typeof value === "object") {
    const constructorName = value.constructor?.name ?? "";
    if (
      constructorName.includes("Repository") ||
      constructorName.includes("Database") ||
      constructorName.includes("Connection") ||
      constructorName.includes("Session")
    ) {
      if (constructorName !== "Object") {
        throw new RawDataExfiltrationError(
          `Local repository or database instance '${constructorName}' cannot be passed as observation data at '${path || "<root>"}'`,
          path,
        );
      }
    }

    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      for (const prohibited of PROHIBITED_RAW_DATA_KEYS) {
        if (lowerKey === prohibited.toLowerCase() || lowerKey.includes(prohibited.toLowerCase())) {
          throw new RawDataExfiltrationError(
            `Prohibited raw/sensitive property '${key}' detected at '${path ? `${path}.${key}` : key}'. Raw data cannot cross the privacy boundary.`,
            key,
          );
        }
      }
      assertNoProhibitedRawData(val, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Validates and brands a single sanitized observation event.
 * Rejects raw repositories, raw transcripts, unredacted secrets, and invalid event schemas.
 */
export function createSanitizedObservationDto(rawInput: unknown): SanitizedObservationDto {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new InvalidSanitizedObservationError("Sanitized observation must be a non-null object");
  }

  // 1. Assert no prohibited raw data, repository pointers, or secret patterns
  assertNoProhibitedRawData(rawInput);

  // 2. Validate against NormalizedSessionEventSchema
  const parseResult = NormalizedSessionEventSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new InvalidSanitizedObservationError(
      `Observation does not conform to NormalizedSessionEventSchema: ${parseResult.error.message}`,
      parseResult.error.errors,
    );
  }

  const validatedEvent = parseResult.data;

  // 3. Ensure redaction metadata exists and marks redaction complete
  if (!validatedEvent.redaction || typeof validatedEvent.redaction !== "object") {
    throw new InvalidSanitizedObservationError(
      "Observation must contain explicit redaction metadata",
    );
  }

  // 4. Create and freeze branded sanitized observation DTO
  const dto = Object.assign(
    { ...validatedEvent },
    {
      [SanitizedObservationBrandSymbol]: true as const,
    },
  );

  return Object.freeze(dto) as SanitizedObservationDto;
}

/**
 * Validates whether an object is a valid branded SanitizedObservationDto.
 */
export function isSanitizedObservationDto(value: unknown): value is SanitizedObservationDto {
  if (!value || typeof value !== "object") return false;
  return (
    (value as Record<string | symbol, unknown>)[SanitizedObservationBrandSymbol] === true &&
    NormalizedSessionEventSchema.safeParse(value).success
  );
}

/**
 * Validates whether an object is a valid branded SanitizedObservationBatchDto.
 */
export function isSanitizedObservationBatchDto(
  value: unknown,
): value is SanitizedObservationBatchDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string | symbol, unknown>;
  return (
    candidate[SanitizedObservationBrandSymbol] === true &&
    typeof candidate.batchId === "string" &&
    Array.isArray(candidate.observations)
  );
}

/**
 * Validates and brands a batch of sanitized observations.
 */
export function createSanitizedObservationBatchDto(input: {
  batchId: string;
  workspaceId?: string;
  projectId?: string;
  clientTimestamp?: string;
  observations: unknown[];
  cursor?: string;
}): SanitizedObservationBatchDto {
  if (!input || typeof input !== "object") {
    throw new InvalidSanitizedObservationError("Batch input must be an object");
  }

  assertNoProhibitedRawData(input);

  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new InvalidSanitizedObservationError("Batch must contain at least one observation");
  }

  const sanitizedObservations = input.observations.map((obs) => createSanitizedObservationDto(obs));

  const batchDto: SanitizedObservationBatchDto = Object.freeze({
    [SanitizedObservationBrandSymbol]: true as const,
    batchId: input.batchId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    clientTimestamp: input.clientTimestamp ?? new Date().toISOString(),
    observations: Object.freeze(sanitizedObservations),
    cursor: input.cursor,
  });

  return batchDto;
}

export type { NormalizedSessionEvent, RedactionMeta };
