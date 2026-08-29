import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "@resin/contracts";
import { z } from "zod";

/**
 * Cloud-backed control-plane target. Workspace state is inherited by every device;
 * device state is an explicit per-device overlay and never implies a global mutation.
 */
export const ControlPlaneTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("workspace") }).strict(),
  z.object({ scope: z.literal("device"), deviceId: IdentifierSchema }).strict(),
]);
export type ControlPlaneTarget = z.infer<typeof ControlPlaneTargetSchema>;

export const ControlPlaneSourceSchema = z.enum(["api", "cli", "web"]);
export type ControlPlaneSource = z.infer<typeof ControlPlaneSourceSchema>;

export const ControlPlanePrivacyStateSchema = z
  .object({
    metadataTelemetryEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();
export type ControlPlanePrivacyState = z.infer<typeof ControlPlanePrivacyStateSchema>;

export const ControlPlaneConfigurationStateSchema = z
  .object({
    telemetryEnabled: z.boolean().optional(),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
    heartbeatIntervalMs: z.number().int().min(1_000).max(300_000).optional(),
  })
  .strict();
export type ControlPlaneConfigurationState = z.infer<typeof ControlPlaneConfigurationStateSchema>;

export const ControlPlaneHarnessIdSchema = z.enum(["claude-code", "codex-cli", "omp"]);
export type ControlPlaneHarnessId = z.infer<typeof ControlPlaneHarnessIdSchema>;

export const ControlPlaneHarnessStateSchema = z
  .object({
    enabled: z.boolean(),
    autoRepair: z.boolean().optional(),
  })
  .strict();
export type ControlPlaneHarnessState = z.infer<typeof ControlPlaneHarnessStateSchema>;

export const ControlPlaneToolStateSchema = z
  .object({
    enabled: z.boolean(),
    pinnedVersion: SchemaVersionSchema.nullable().optional(),
    updatePolicy: z.enum(["inherit", "automatic", "manual"]).optional(),
  })
  .strict();
export type ControlPlaneToolState = z.infer<typeof ControlPlaneToolStateSchema>;

export const ControlPlaneMaintenanceWindowSchema = z
  .object({
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    durationMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    timeZone: z.string().min(1).max(128),
  })
  .strict();
export type ControlPlaneMaintenanceWindow = z.infer<typeof ControlPlaneMaintenanceWindowSchema>;

export const ControlPlaneUpdateStateSchema = z
  .object({
    channel: z.enum(["stable", "beta", "nightly"]).optional(),
    autoApply: z.boolean().optional(),
    checkIntervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
    maintenanceWindow: ControlPlaneMaintenanceWindowSchema.nullable().optional(),
  })
  .strict();
export type ControlPlaneUpdateState = z.infer<typeof ControlPlaneUpdateStateSchema>;

export const ControlPlaneRecoveryStateSchema = z
  .object({
    autoRepairHarnesses: z.boolean().optional(),
    restartOnFailure: z.boolean().optional(),
    diagnosticsEnabled: z.boolean().optional(),
  })
  .strict();
export type ControlPlaneRecoveryState = z.infer<typeof ControlPlaneRecoveryStateSchema>;

/**
 * Desired state intentionally excludes credentials, tokens, filesystem paths, raw
 * transcripts, deletion requests, and other destructive or secret-bearing values.
 */
export const ControlPlaneDesiredStateSchema = z
  .object({
    privacy: ControlPlanePrivacyStateSchema.optional(),
    configuration: ControlPlaneConfigurationStateSchema.optional(),
    harnesses: z.record(ControlPlaneHarnessIdSchema, ControlPlaneHarnessStateSchema).optional(),
    tools: z.record(IdentifierSchema, ControlPlaneToolStateSchema).optional(),
    updates: ControlPlaneUpdateStateSchema.optional(),
    recovery: ControlPlaneRecoveryStateSchema.optional(),
  })
  .strict();
export type ControlPlaneDesiredState = z.infer<typeof ControlPlaneDesiredStateSchema>;

export const ControlPlaneRevisionVectorSchema = z
  .object({
    workspace: z.number().int().nonnegative(),
    device: z.number().int().nonnegative(),
  })
  .strict();
export type ControlPlaneRevisionVector = z.infer<typeof ControlPlaneRevisionVectorSchema>;

export const ControlPlaneDesiredDocumentSchema = z
  .object({
    target: ControlPlaneTargetSchema,
    revision: z.number().int().positive(),
    desiredState: ControlPlaneDesiredStateSchema,
    updatedAt: ISOTimestampSchema,
    updatedBy: IdentifierSchema,
    source: ControlPlaneSourceSchema,
  })
  .strict();
export type ControlPlaneDesiredDocument = z.infer<typeof ControlPlaneDesiredDocumentSchema>;

export const ControlPlaneMutationRequestSchema = z
  .object({
    target: ControlPlaneTargetSchema,
    desiredState: ControlPlaneDesiredStateSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(8).max(256),
    source: ControlPlaneSourceSchema,
  })
  .strict();
export type ControlPlaneMutationRequest = z.infer<typeof ControlPlaneMutationRequestSchema>;

export const ControlPlaneMutationResponseSchema = z
  .object({
    desired: ControlPlaneDesiredDocumentSchema,
    idempotentReplay: z.boolean(),
  })
  .strict();
export type ControlPlaneMutationResponse = z.infer<typeof ControlPlaneMutationResponseSchema>;

export const ControlPlaneFieldApplyStatusSchema = z.enum([
  "applied",
  "pending",
  "unsupported",
  "error",
]);
export type ControlPlaneFieldApplyStatus = z.infer<typeof ControlPlaneFieldApplyStatusSchema>;

export const ControlPlaneAppliedFieldSchema = z
  .object({
    status: ControlPlaneFieldApplyStatusSchema,
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    message: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ControlPlaneAppliedField = z.infer<typeof ControlPlaneAppliedFieldSchema>;

export const ControlPlaneDeviceReportSchema = z
  .object({
    deviceId: IdentifierSchema,
    revisions: ControlPlaneRevisionVectorSchema,
    revisionToken: z.string().regex(/^w:\d+:d:\d+$/),
    status: z.enum(["applied", "degraded", "error"]),
    fields: z.record(z.string().min(1).max(192), ControlPlaneAppliedFieldSchema),
    observedAt: ISOTimestampSchema,
    appliedAt: ISOTimestampSchema.nullable(),
  })
  .strict();
export type ControlPlaneDeviceReport = z.infer<typeof ControlPlaneDeviceReportSchema>;

export const ControlPlaneReportRequestSchema = z
  .object({
    report: ControlPlaneDeviceReportSchema,
  })
  .strict();
export type ControlPlaneReportRequest = z.infer<typeof ControlPlaneReportRequestSchema>;

export const ControlPlaneConnectivitySchema = z.enum(["online", "stale", "never_reported"]);
export type ControlPlaneConnectivity = z.infer<typeof ControlPlaneConnectivitySchema>;

export const ControlPlaneStateResponseSchema = z
  .object({
    desired: ControlPlaneDesiredDocumentSchema.nullable(),
    report: ControlPlaneDeviceReportSchema.nullable(),
    connectivity: ControlPlaneConnectivitySchema,
  })
  .strict();
export type ControlPlaneStateResponse = z.infer<typeof ControlPlaneStateResponseSchema>;

export const ControlPlaneEffectiveStateResponseSchema = z
  .object({
    deviceId: IdentifierSchema,
    workspace: ControlPlaneDesiredDocumentSchema.nullable(),
    device: ControlPlaneDesiredDocumentSchema.nullable(),
    desiredState: ControlPlaneDesiredStateSchema,
    revisions: ControlPlaneRevisionVectorSchema,
    revisionToken: z.string().regex(/^w:\d+:d:\d+$/),
    report: ControlPlaneDeviceReportSchema.nullable(),
    connectivity: ControlPlaneConnectivitySchema,
  })
  .strict();
export type ControlPlaneEffectiveStateResponse = z.infer<
  typeof ControlPlaneEffectiveStateResponseSchema
>;

export const ControlPlaneFieldLocalitySchema = z.enum(["cloud", "device"]);
export type ControlPlaneFieldLocality = z.infer<typeof ControlPlaneFieldLocalitySchema>;

export const ControlPlaneFieldDescriptorSchema = z
  .object({
    path: z.string().min(1),
    locality: ControlPlaneFieldLocalitySchema,
    targets: z.array(z.enum(["workspace", "device"])).min(1),
    destructive: z.literal(false),
    description: z.string().min(1),
  })
  .strict();
export type ControlPlaneFieldDescriptor = z.infer<typeof ControlPlaneFieldDescriptorSchema>;

/** Machine-readable parity inventory used by CLI agents and the Web console. */
export const CONTROL_PLANE_FIELD_INVENTORY = [
  {
    path: "configuration.telemetryEnabled",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Local daemon telemetry capture switch.",
  },
  {
    path: "configuration.logLevel",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Local daemon logging level without secret-bearing logger configuration.",
  },
  {
    path: "configuration.heartbeatIntervalMs",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Local daemon heartbeat cadence.",
  },
  {
    path: "harnesses.<harnessId>",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Explicit registration and auto-repair intent for a supported local harness.",
  },
  {
    path: "tools.<toolId>",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Per-tool enablement, immutable version pin, and update policy intent.",
  },
  {
    path: "updates",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Local update channel, policy, check cadence, and maintenance window.",
  },
  {
    path: "recovery",
    locality: "device",
    targets: ["workspace", "device"],
    destructive: false,
    description: "Non-destructive local recovery and diagnostics policy.",
  },
] as const;

export const ControlPlaneInventoryResponseSchema = z
  .object({ fields: z.array(ControlPlaneFieldDescriptorSchema) })
  .strict();
export type ControlPlaneInventoryResponse = z.infer<typeof ControlPlaneInventoryResponseSchema>;

export function controlPlaneRevisionToken(revisions: ControlPlaneRevisionVector): string {
  return `w:${revisions.workspace}:d:${revisions.device}`;
}
