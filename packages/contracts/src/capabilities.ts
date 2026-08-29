import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";

/**
 * Filesystem access capability definition.
 */
export const FsCapabilitySchema = z.object({
  readPaths: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  allowWorkspaceRoot: z.boolean().default(true),
  allowTemp: z.boolean().default(true),
  denyPaths: z.array(z.string()).default([]),
  maxFileSizeBytes: z.number().int().positive().default(10485760), // 10MB
});

export type FsCapability = z.infer<typeof FsCapabilitySchema>;

/**
 * Network access capability definition.
 */
export const NetCapabilitySchema = z.object({
  allowOutbound: z.boolean().default(false),
  allowedDomains: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  allowedProtocols: z.array(z.enum(["http", "https", "ws", "wss"])).default(["https"]),
  allowLocalhost: z.boolean().default(false),
  denyPrivateRanges: z.boolean().default(true),
});

export type NetCapability = z.infer<typeof NetCapabilitySchema>;

/**
 * Command and subprocess execution capability definition.
 */
export const CommandCapabilitySchema = z.object({
  allowShellExecution: z.boolean().default(false),
  allowedCommands: z.array(z.string()).default([]),
  allowedBinaries: z.array(z.string()).default([]),
  forbiddenPatterns: z.array(z.string()).default([]),
  allowEnvPassthrough: z.array(z.string()).default([]),
});

export type CommandCapability = z.infer<typeof CommandCapabilitySchema>;

/**
 * Secrets and credentials access capability definition.
 */
export const SecretCapabilitySchema = z.object({
  allowedSecretNames: z.array(z.string()).default([]),
  allowedPrefixes: z.array(z.string()).default([]),
  denyDirectRead: z.boolean().default(true),
  injectAsEnv: z.boolean().default(true),
});

export type SecretCapability = z.infer<typeof SecretCapabilitySchema>;

/**
 * Resource execution limits.
 */
export const CapabilityLimitsSchema = z.object({
  maxConcurrentExecutions: z.number().int().positive().default(4),
  maxCpuUsagePercent: z.number().int().min(1).max(100).default(100),
  maxMemoryMb: z.number().int().positive().default(128),
  maxExecutionTimeMs: z.number().int().positive().default(30000),
  maxOutputSizeBytes: z.number().int().positive().default(1048576), // 1MB
});

export type CapabilityLimits = z.infer<typeof CapabilityLimitsSchema>;

/**
 * Capability manifest declared by a tool or requested by a candidate.
 */
export const CapabilityManifestSchema = z.object({
  manifestId: IdentifierSchema.optional(),
  fs: FsCapabilitySchema.default({}),
  net: NetCapabilitySchema.default({}),
  command: CommandCapabilitySchema.default({}),
  secrets: SecretCapabilitySchema.default({}),
  limits: CapabilityLimitsSchema.default({}),
});

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/**
 * Capability Grant representing an authorized grant of capabilities to a tool.
 */
export const CapabilityGrantSchema = z.object({
  grantId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  grantedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema.optional(),
  grantType: z.enum(["implicit", "explicit", "policy"]),
  capabilities: CapabilityManifestSchema,
  actor: z.object({
    type: z.enum(["user", "admin", "policy_engine", "default"]),
    id: z.string(),
  }),
  reason: z.string().optional(),
});

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/**
 * Capability Envelope defining the upper bounds of pre-authorized capabilities for a workspace.
 */
export const CapabilityEnvelopeSchema = z.object({
  envelopeId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  version: SchemaVersionSchema,
  fs: FsCapabilitySchema.default({}),
  net: NetCapabilitySchema.default({}),
  command: CommandCapabilitySchema.default({}),
  secrets: SecretCapabilitySchema.default({}),
  limits: CapabilityLimitsSchema.default({}),
  isFrozen: z.boolean().default(false),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional(),
});

export type CapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;
