import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "@resin/contracts";
import { z } from "zod";

/**
 * Installation status for an AI harness.
 */
export const InstallationStatusSchema = z.enum([
  "ready",
  "unsupported_version",
  "missing_executable",
  "config_error",
  "corrupt",
  "unknown",
]);
export type InstallationStatus = z.infer<typeof InstallationStatusSchema>;

/**
 * 1. HarnessInstallation: Details of an installed harness discovered on the host workstation.
 */
export const HarnessInstallationSchema = z.object({
  harnessId: IdentifierSchema,
  displayName: z.string().min(1),
  version: SchemaVersionSchema,
  executablePath: z.string().optional(),
  configPath: z.string().optional(),
  homePath: z.string().optional(),
  isInstalled: z.boolean(),
  status: InstallationStatusSchema,
  detectedAt: ISOTimestampSchema,
  metadata: z.record(z.unknown()).default({}),
});
export type HarnessInstallation = z.infer<typeof HarnessInstallationSchema>;

/**
 * 2. HarnessWorkspace: A local workspace / repository associated with a specific harness.
 */
export const HarnessWorkspaceSchema = z.object({
  workspaceId: IdentifierSchema,
  rootPath: z.string().min(1),
  name: z.string().min(1),
  harnessId: IdentifierSchema,
  configPath: z.string().min(1),
  mcpConfigPath: z.string().optional(),
  activeSessionId: IdentifierSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type HarnessWorkspace = z.infer<typeof HarnessWorkspaceSchema>;

/**
 * Session lifecycle status.
 */
export const SessionStatusSchema = z.enum([
  "active",
  "idle",
  "completed",
  "interrupted",
  "failed",
  "unknown",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * 3. HarnessSession: An active or historical interaction session within a harness workspace.
 */
export const HarnessSessionSchema = z.object({
  sessionId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  harnessId: IdentifierSchema,
  transcriptPath: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
  metadata: z.record(z.unknown()).default({}),
});
export type HarnessSession = z.infer<typeof HarnessSessionSchema>;

/**
 * 4. SourceCursor: Position and checkpoint inside a transcript or event log.
 */
export const SourceCursorSchema = z.object({
  offset: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  checkpoint: Sha256DigestSchema.optional(),
  timestamp: ISOTimestampSchema,
});
export type SourceCursor = z.infer<typeof SourceCursorSchema>;

/**
 * Record types captured from harness transcript.
 */
export const RecordTypeSchema = z.enum([
  "transcript_line",
  "tool_call",
  "tool_result",
  "prompt",
  "completion",
  "system",
  "custom",
]);
export type RecordType = z.infer<typeof RecordTypeSchema>;

/**
 * 5. RawHarnessRecord: Unprocessed event or transcript line emitted by a harness.
 */
export const RawHarnessRecordSchema = z.object({
  recordId: IdentifierSchema,
  sessionId: IdentifierSchema,
  harnessId: IdentifierSchema,
  sequenceNumber: z.number().int().nonnegative(),
  timestamp: ISOTimestampSchema,
  recordType: RecordTypeSchema,
  rawPayload: z.unknown(),
  cursor: SourceCursorSchema,
  metadata: z.record(z.unknown()).default({}),
});
export type RawHarnessRecord = z.infer<typeof RawHarnessRecordSchema>;

/**
 * Diagnostic severity level.
 */
export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

/**
 * 6. AdapterDiagnostic: Structured diagnostic emitted by an adapter probe or lifecycle event.
 */
export const AdapterDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: DiagnosticSeveritySchema,
  message: z.string().min(1),
  path: z.string().optional(),
  timestamp: ISOTimestampSchema,
  details: z.record(z.unknown()).optional(),
});
export type AdapterDiagnostic = z.infer<typeof AdapterDiagnosticSchema>;

/**
 * 7. ConfigMutationPlan: Proposed atomic modification to a harness configuration file.
 */
export const ConfigMutationPlanSchema = z.object({
  planId: IdentifierSchema,
  harnessId: IdentifierSchema,
  targetPath: z.string().min(1),
  preconditionHash: z.string(),
  plannedContent: z.string(),
  backupPath: z.string().optional(),
  description: z.string().min(1),
  diffSummary: z.string().optional(),
  createdAt: ISOTimestampSchema,
  metadata: z.record(z.unknown()).default({}),
});
export type ConfigMutationPlan = z.infer<typeof ConfigMutationPlanSchema>;

/**
 * 8. ConfigBackup: Record of an existing config file saved before applying a mutation plan.
 */
export const ConfigBackupSchema = z.object({
  backupId: IdentifierSchema,
  targetPath: z.string().min(1),
  backupPath: z.string().min(1),
  contentHash: Sha256DigestSchema,
  originalContent: z.string(),
  createdAt: ISOTimestampSchema,
  restored: z.boolean().default(false),
  restoredAt: ISOTimestampSchema.optional(),
});
export type ConfigBackup = z.infer<typeof ConfigBackupSchema>;

/**
 * 9. RefreshCapability: Capabilities of the harness regarding tool catalog reload and discovery.
 */
export const RefreshCapabilitySchema = z.object({
  supportsNativeListChange: z.boolean(),
  supportsContextNudge: z.boolean(),
  requiresSessionRestart: z.boolean(),
  description: z.string().optional(),
});
export type RefreshCapability = z.infer<typeof RefreshCapabilitySchema>;

/**
 * Transcript availability mechanism.
 */
export const TranscriptAvailabilitySchema = z.enum([
  "none",
  "polling",
  "file_tail",
  "stream",
  "websocket",
]);
export type TranscriptAvailability = z.infer<typeof TranscriptAvailabilitySchema>;

/**
 * Tool call & result visibility level.
 */
export const VisibilityLevelSchema = z.enum(["none", "partial", "full", "sanitized"]);
export type VisibilityLevel = z.infer<typeof VisibilityLevelSchema>;

/**
 * Subagent / branch observation visibility.
 */
export const SubagentVisibilitySchema = z.enum(["none", "shallow", "full"]);
export type SubagentVisibility = z.infer<typeof SubagentVisibilitySchema>;

/**
 * MCP list_changed support.
 */
export const McpListChangeSupportSchema = z.enum(["supported", "unsupported", "requires_restart"]);
export type McpListChangeSupport = z.infer<typeof McpListChangeSupportSchema>;

/**
 * Context nudge support.
 */
export const ContextNudgeSupportSchema = z.enum([
  "supported",
  "unsupported",
  "via_file",
  "via_prompt",
]);
export type ContextNudgeSupport = z.infer<typeof ContextNudgeSupportSchema>;

/**
 * 10. ObservationFidelity: Fidelity rating of observability into a harness's internal lifecycle.
 */
export const ObservationFidelitySchema = z.object({
  transcriptAvailability: TranscriptAvailabilitySchema,
  toolCallVisibility: VisibilityLevelSchema,
  toolResultVisibility: VisibilityLevelSchema,
  subagentVisibility: SubagentVisibilitySchema,
  mcpListChange: McpListChangeSupportSchema,
  contextNudge: ContextNudgeSupportSchema,
  overallScore: z.number().min(0).max(100),
  notes: z.string().optional(),
});
export type ObservationFidelity = z.infer<typeof ObservationFidelitySchema>;

/**
 * 11. AdapterCapabilities: Complete capability profile of a harness adapter.
 */
export const AdapterCapabilitiesSchema = z.object({
  refresh: RefreshCapabilitySchema,
  fidelity: ObservationFidelitySchema,
  supportedTransports: z.array(z.enum(["stdio", "sse", "websocket", "http"])).default(["stdio"]),
  supportsMultiWorkspace: z.boolean().default(true),
  supportsConcurrentSessions: z.boolean().default(true),
  features: z.record(z.boolean()).default({}),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

/**
 * 12. CatalogChangeSummary: Summary of tool catalog updates passed to notifyCatalogRefresh.
 */
export const CatalogChangeSummarySchema = z.object({
  addedToolIds: z.array(IdentifierSchema).default([]),
  updatedToolIds: z.array(IdentifierSchema).default([]),
  removedToolIds: z.array(IdentifierSchema).default([]),
  catalogVersion: SchemaVersionSchema,
  timestamp: ISOTimestampSchema,
  /** Rendered catalog instructions markdown for harnesses that inject prompts. */
  instructionsMarkdown: z.string().optional(),
  /** Evolved tool names for per-tool invocation snippets. */
  evolvedToolNames: z.array(z.string()).optional(),
});
export type CatalogChangeSummary = z.infer<typeof CatalogChangeSummarySchema>;
