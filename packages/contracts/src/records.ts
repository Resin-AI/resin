import { z } from "zod";
import { descriptorSafeCanonicalJsonStringify } from "./canonical.js";
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
 * Canonical method tag for deterministic serialized UTF-8 tool-I/O estimation.
 */
export const TOOL_IO_UTF8_METHOD = "tool_io_utf8_v1" as const;

/**
 * Transparent estimated tool-I/O usage metrics for an invocation or tool event.
 * Represents serialized UTF-8 bytes / 4 rounded up for tool exchange payloads,
 * distinct from whole-session or provider-billed model context/reasoning.
 */
export const InvocationUsageEstimateSchema = z
  .object({
    method: z.literal(TOOL_IO_UTF8_METHOD),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    discoveryTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((val) => val.totalTokens === val.inputTokens + val.outputTokens + val.discoveryTokens, {
    message: "totalTokens must equal sum of inputTokens, outputTokens, and discoveryTokens",
  });

export type InvocationUsageEstimate = z.infer<typeof InvocationUsageEstimateSchema>;

/**
 * Estimates UTF-8 byte length of a serialized payload.
 * Returns undefined if payload is missing (undefined) or unserializable.
 * A literal JSON null is valid 4 UTF-8 bytes ("null").
 */
export function estimatePayloadBytes(payload: unknown): number | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  try {
    const serialized = descriptorSafeCanonicalJsonStringify(payload);
    if (serialized === "undefined" || serialized === undefined) {
      return undefined;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Converts a UTF-8 byte count to estimated tool-I/O tokens (bytes / 4 rounded up).
 * Rejects invalid inputs (negative, non-integer, non-finite, out of safe bounds) rather than faking zero.
 */
export function bytesToTokens(bytes: number): number {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(
      `Invalid byte count: expected finite non-negative safe integer, got ${String(bytes)}`,
    );
  }
  return Math.ceil(bytes / 4);
}

/**
 * Estimates tool-I/O tokens for a payload (bytes / 4 rounded up).
 * Returns undefined if payload is missing or unserializable.
 */
export function estimatePayloadTokens(payload: unknown): number | undefined {
  const bytes = estimatePayloadBytes(payload);
  if (bytes === undefined) {
    return undefined;
  }
  return bytesToTokens(bytes);
}

/**
 * Constructs an InvocationUsageEstimate from input, output, and discovery tokens.
 * Rejects invalid fractional tokens or out-of-safe-bound numbers rather than flooring them.
 * Returns undefined if either input or output tokens are undefined or invalid.
 */
export function createUsageEstimate(options: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  discoveryTokens?: number;
}): InvocationUsageEstimate | undefined {
  const { inputTokens, outputTokens, discoveryTokens = 0 } = options;
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(discoveryTokens) ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    discoveryTokens < 0
  ) {
    return undefined;
  }
  const totalTokens = inputTokens + outputTokens + discoveryTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return undefined;
  }

  return {
    method: TOOL_IO_UTF8_METHOD,
    inputTokens,
    outputTokens,
    discoveryTokens,
    totalTokens,
  };
}

/**
 * Creates a safely bounded tool-I/O token estimate for a normalized tool event.
 * Only the relevant component is nonzero (inputTokens for tool_call, outputTokens for tool_result).
 * Discovery tokens are 0 on raw events.
 * Missing/unserializable payload => absent (undefined), not fake zero.
 * Complete empty input counts serialized {} bytes (2 bytes => 1 token), not missing.
 * Explicitly excludes whole-session model context, reasoning, and provider billing.
 */
export function createEventTokenEstimate(
  type: "tool_call" | "tool_result",
  payload: unknown,
): InvocationUsageEstimate | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const tokens = estimatePayloadTokens(payload);
  if (tokens === undefined) {
    return undefined;
  }
  if (type === "tool_call") {
    return {
      method: TOOL_IO_UTF8_METHOD,
      inputTokens: tokens,
      outputTokens: 0,
      discoveryTokens: 0,
      totalTokens: tokens,
    };
  }
  return {
    method: TOOL_IO_UTF8_METHOD,
    inputTokens: 0,
    outputTokens: tokens,
    discoveryTokens: 0,
    totalTokens: tokens,
  };
}

/**
 * Annotates a normalized tool event with metadata.resinTokenEstimateV1 from its original payload
 * before privacy projection, preserving only validated numeric metadata.
 * Missing/unserializable payload leaves estimate absent.
 * Explicitly excludes model reasoning or whole-session context.
 */
export function annotateEventWithTokenEstimate<
  T extends {
    type: string;
    metadata?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    result?: unknown;
  },
>(event: T): T {
  const existing = event.metadata?.resinTokenEstimateV1;
  if (existing) {
    const parsed = InvocationUsageEstimateSchema.safeParse(existing);
    if (parsed.success) {
      return {
        ...event,
        metadata: {
          ...event.metadata,
          resinTokenEstimateV1: {
            method: parsed.data.method,
            inputTokens: parsed.data.inputTokens,
            outputTokens: parsed.data.outputTokens,
            discoveryTokens: parsed.data.discoveryTokens,
            totalTokens: parsed.data.totalTokens,
          },
        },
      };
    }
  }

  let estimate: InvocationUsageEstimate | undefined;
  if (event.type === "tool_call") {
    estimate = createEventTokenEstimate("tool_call", event.parameters);
  } else if (event.type === "tool_result") {
    estimate = createEventTokenEstimate("tool_result", event.result);
  }

  if (!estimate) {
    return event;
  }

  return {
    ...event,
    metadata: {
      ...event.metadata,
      resinTokenEstimateV1: estimate,
    },
  };
}
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
  usageEstimate: InvocationUsageEstimateSchema.optional(),
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
