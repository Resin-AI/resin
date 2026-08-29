import { z } from "zod";
import { CapabilityEnvelopeSchema } from "./capabilities.js";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  UUIDSchema,
} from "./common.js";
import { ToolScopeSchema } from "./tools.js";
import { SignatureMetadataSchema } from "./versions.js";

/**
 * 1. WorkspaceRecord: Persistent registration of a local workspace root.
 */
export const WorkspaceRecordSchema = z.object({
  workspaceId: IdentifierSchema,
  rootPath: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  capabilityEnvelope: CapabilityEnvelopeSchema,
  activeTools: z.record(SchemaVersionSchema).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional(),
});

export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;

/**
 * 2. DeviceRecord: Registration of a developer workstation / device.
 */
export const DeviceRecordSchema = z.object({
  deviceId: IdentifierSchema,
  hostname: z.string().min(1),
  platform: z.enum(["darwin", "linux", "win32", "other"]),
  arch: z.enum(["arm64", "x64", "arm", "ia32", "other"]),
  osVersion: z.string(),
  cpuCores: z.number().int().positive(),
  totalMemoryMb: z.number().int().positive(),
  daemonVersion: SchemaVersionSchema,
  registeredAt: ISOTimestampSchema,
  lastSeenAt: ISOTimestampSchema,
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/**
 * 3. InstallationRecord: Local activation of a specific tool version in a workspace.
 */
export const InstallationRecordSchema = z.object({
  installationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  deploymentId: IdentifierSchema,
  installedAt: ISOTimestampSchema,
  state: z.enum(["active", "inactive", "broken", "uninstalled"]),
  configOverrides: z.record(z.unknown()).default({}),
});

export type InstallationRecord = z.infer<typeof InstallationRecordSchema>;

/**
 * Summary of a tool in a catalog snapshot.
 */
export const CatalogToolSummarySchema = z.object({
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  manifestDigest: Sha256DigestSchema,
  scope: ToolScopeSchema,
  status: z.enum(["active", "draft", "deprecated", "revoked"]),
});

export type CatalogToolSummary = z.infer<typeof CatalogToolSummarySchema>;

/**
 * 4. CatalogSnapshot: Point-in-time snapshot of the tool catalog available to a workspace.
 */
export const CatalogSnapshotSchema = z.object({
  snapshotId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  tools: z.record(CatalogToolSummarySchema).default({}),
  digest: Sha256DigestSchema,
});

export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

/**
 * Resource usage telemetry for an invocation.
 */
export const InvocationResourceUsageSchema = z.object({
  cpuTimeMs: z.number().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  shadowRun: z.boolean().default(false),
});

export type InvocationResourceUsage = z.infer<typeof InvocationResourceUsageSchema>;

/**
 * Error details for a failed invocation.
 */
export const InvocationErrorDetailsSchema = z.object({
  errorType: z.string().min(1),
  message: z.string(),
  stack: z.string().optional(),
});

export type InvocationErrorDetails = z.infer<typeof InvocationErrorDetailsSchema>;

/**
 * 5. InvocationRecord: Execution log for a single tool call through the gateway.
 */
export const InvocationRecordSchema = z.object({
  invocationId: IdentifierSchema,
  sessionId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  startedAt: ISOTimestampSchema,
  completedAt: ISOTimestampSchema,
  durationMs: z.number().nonnegative(),
  status: z.enum(["success", "error", "timeout", "rejected_capability"]),
  inputDigest: Sha256DigestSchema,
  outputDigest: Sha256DigestSchema.optional(),
  errorDetails: InvocationErrorDetailsSchema.optional(),
  resourceUsage: InvocationResourceUsageSchema.optional(),
});

export type InvocationRecord = z.infer<typeof InvocationRecordSchema>;

/**
 * Actor performing an audited action.
 */
export const AuditActorSchema = z.object({
  type: z.enum(["user", "daemon", "agent", "system", "policy_engine"]),
  id: z.string().min(1),
});

export type AuditActor = z.infer<typeof AuditActorSchema>;

/**
 * 6. AuditRecord: Tamper-evident log entry for security and configuration changes.
 */
export const AuditRecordSchema = z.object({
  auditId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  eventType: z.string().min(1),
  actor: AuditActorSchema,
  workspaceId: IdentifierSchema.optional(),
  resourceType: z.enum([
    "tool",
    "deployment",
    "candidate",
    "workspace",
    "capability",
    "session",
    "device",
    "config",
  ]),
  resourceId: z.string().min(1),
  action: z.string().min(1),
  status: z.enum(["success", "failure", "denied"]),
  details: z.record(z.unknown()).default({}),
  clientIp: z.string().optional(),
});

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/**
 * 7. TelemetryRecord: Operational metric sample.
 */
export const TelemetryRecordSchema = z.object({
  telemetryId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  deviceId: IdentifierSchema,
  workspaceId: IdentifierSchema.optional(),
  metricName: z.string().min(1),
  metricType: z.enum(["counter", "gauge", "histogram"]),
  value: z.number(),
  tags: z.record(z.string()).default({}),
});

export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>;

/**
 * 8. SyncCursor: Cursor tracking synchronization progress with cloud tier.
 */
export const SyncCursorSchema = z.object({
  cursorId: IdentifierSchema,
  deviceId: IdentifierSchema,
  workspaceId: IdentifierSchema.optional(),
  entityType: z.string().min(1),
  lastSyncedSequence: z.number().int().nonnegative(),
  lastSyncedTimestamp: ISOTimestampSchema,
  syncToken: z.string().min(1),
});

export type SyncCursor = z.infer<typeof SyncCursorSchema>;

/**
 * 9. DeadLetterRecord: Unprocessable event or record preserved for diagnostics.
 */
export const DeadLetterRecordSchema = z.object({
  deadLetterId: IdentifierSchema,
  originalEventType: z.string().min(1),
  payload: z.record(z.unknown()),
  errorReason: z.string().min(1),
  failedAt: ISOTimestampSchema,
  retryCount: z.number().int().nonnegative().default(0),
  nextRetryAt: ISOTimestampSchema.optional(),
  status: z.enum(["pending", "exhausted", "resolved", "discarded"]).default("pending"),
});

export type DeadLetterRecord = z.infer<typeof DeadLetterRecordSchema>;

/**
 * 10. VerificationEvidenceRecord: Content-addressed candidate verification evidence.
 */
export const VerificationDigestsSchema = z.object({
  sourceDigest: Sha256DigestSchema,
  manifestDigest: Sha256DigestSchema,
  testsDigest: Sha256DigestSchema,
  sdkDigest: Sha256DigestSchema,
  runtimeDigest: Sha256DigestSchema,
  policyDigest: Sha256DigestSchema,
  denoDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  compositeEvidenceDigest: Sha256DigestSchema,
});

export type VerificationDigests = z.infer<typeof VerificationDigestsSchema>;

export const VerificationChecksSchema = z.object({
  compilationAndTypeCheck: z.boolean(),
  staticAnalysis: z.boolean(),
  schemaValidation: z.boolean(),
  unitTests: z.boolean(),
  securityProbes: z.boolean(),
  deterministicPackaging: z.boolean(),
});

export type VerificationChecks = z.infer<typeof VerificationChecksSchema>;

export const ProbeResultEntrySchema = z.object({
  probeId: z.string().min(1),
  name: z.string().min(1),
  passed: z.boolean(),
  details: z.string().optional(),
});

export type ProbeResultEntry = z.infer<typeof ProbeResultEntrySchema>;

export const VerificationEvidenceRecordSchema = z.object({
  evidenceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  status: z.enum(["passed", "failed"]),
  verifiedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  digests: VerificationDigestsSchema,
  checks: VerificationChecksSchema,
  probeResults: z.array(ProbeResultEntrySchema).default([]),
  metadata: z.record(z.unknown()).optional(),
  signature: SignatureMetadataSchema.optional(),
});

export type VerificationEvidenceRecord = z.infer<typeof VerificationEvidenceRecordSchema>;

/**
 * Record visibility enum schema.
 */
export const RecordVisibilitySchema = z.enum(["personal", "workspace"]);

export type RecordVisibility = z.infer<typeof RecordVisibilitySchema>;

/**
 * Base ownership schemas enforcing strict personal vs workspace invariants.
 */
export const PersonalOwnershipRecordSchema = z.object({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]),
  visibility: z.literal("personal"),
});

export const WorkspaceOwnershipRecordSchema = z.object({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: z.literal("workspace"),
});

export const RecordOwnershipSchema = z.discriminatedUnion("visibility", [
  PersonalOwnershipRecordSchema,
  WorkspaceOwnershipRecordSchema,
]);

export type RecordOwnership = z.infer<typeof RecordOwnershipSchema>;

/**
 * 11. SessionRecord: Persistent session metadata with strict ownership invariants.
 */
export const SessionRecordBaseSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  harnessType: z.string().min(1).default("default"),
  status: z
    .enum(["active", "idle", "completed", "failed", "archived", "terminated"])
    .default("active"),
  fidelity: z.enum(["full", "compact", "summary", "lossless"]).default("full"),
  startedAt: ISOTimestampSchema,
  endedAt: ISOTimestampSchema.nullable().optional(),
  cursor: z.string().nullable().optional(),
  eventCount: z.number().int().nonnegative().default(0),
  summaryByKind: z.record(z.number().int().nonnegative()).default({}),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
});

export const PersonalSessionRecordSchema = SessionRecordBaseSchema.extend({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]),
  visibility: z.literal("personal"),
});

export const WorkspaceSessionRecordSchema = SessionRecordBaseSchema.extend({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: z.literal("workspace"),
});

export const SessionRecordSchema = z.discriminatedUnion("visibility", [
  PersonalSessionRecordSchema,
  WorkspaceSessionRecordSchema,
]);

export type PersonalSessionRecord = z.infer<typeof PersonalSessionRecordSchema>;
export type WorkspaceSessionRecord = z.infer<typeof WorkspaceSessionRecordSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * 12. EvidenceSetRecord: Immutable evidence set snapshot with strict ownership invariants.
 */
export const EvidenceSetRecordBaseSchema = z.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable().optional(),
  name: z.string().min(1),
  description: z.string().default(""),
  revision: z.number().int().positive().default(1),
  rootDigest: Sha256DigestSchema,
  memberCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
});

export const PersonalEvidenceSetRecordSchema = EvidenceSetRecordBaseSchema.extend({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]),
  visibility: z.literal("personal"),
});

export const WorkspaceEvidenceSetRecordSchema = EvidenceSetRecordBaseSchema.extend({
  ownerUserId: z.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: z.literal("workspace"),
});

export const EvidenceSetRecordSchema = z.discriminatedUnion("visibility", [
  PersonalEvidenceSetRecordSchema,
  WorkspaceEvidenceSetRecordSchema,
]);

export type PersonalEvidenceSetRecord = z.infer<typeof PersonalEvidenceSetRecordSchema>;
export type WorkspaceEvidenceSetRecord = z.infer<typeof WorkspaceEvidenceSetRecordSchema>;
export type EvidenceSetRecord = z.infer<typeof EvidenceSetRecordSchema>;
