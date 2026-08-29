import { z } from "zod";
import { CapabilityManifestSchema } from "./capabilities.js";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
} from "./common.js";

/**
 * Tool Scope boundary.
 */
export const ToolScopeSchema = z.enum(["workspace", "user", "global", "session"]);

export type ToolScope = z.infer<typeof ToolScopeSchema>;

/**
 * Tool JSON Parameter Schema definition (MCP-compatible).
 */
export const ToolParameterSchema = z.object({
  type: z.literal("object").default("object"),
  properties: z.record(z.record(z.unknown())).default({}),
  required: z.array(z.string()).default([]),
  additionalProperties: z.boolean().default(false),
  description: z.string().optional(),
});

export type ToolParameterSchema = z.infer<typeof ToolParameterSchema>;

/**
 * Tool Output Schema definition.
 */
export const ToolOutputSchema = z.object({
  type: z.string().default("object"),
  properties: z.record(z.record(z.unknown())).optional(),
  description: z.string().optional(),
  schema: z.record(z.unknown()).optional(),
});

export type ToolOutputSchema = z.infer<typeof ToolOutputSchema>;

/**
 * Tool Runtime Requirement specification.
 */
export const ToolRuntimeRequirementSchema = z.object({
  runtime: z.enum(["deno", "node", "python", "wasm", "shell", "builtin"]),
  minRuntimeVersion: z.string().optional(),
  memoryLimitMb: z.number().int().positive().default(128),
  timeoutMs: z.number().int().positive().default(30000),
  cpuLimitPercent: z.number().int().min(1).max(100).default(100),
  maxOutputSizeBytes: z.number().int().positive().default(1048576), // 1MB
});

export type ToolRuntimeRequirement = z.infer<typeof ToolRuntimeRequirementSchema>;

/**
 * Tool-specific limits configuration.
 */
export const ToolLimitConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(30000),
  maxOutputBytes: z.number().int().positive().default(1048576),
  maxMemoryBytes: z.number().int().positive().default(134217728), // 128MB
  maxConcurrentInvocations: z.number().int().positive().default(4),
});

export type ToolLimitConfig = z.infer<typeof ToolLimitConfigSchema>;

/**
 * Tool Manifest: Canonical definition of an evolved or built-in tool.
 */
export const ToolManifestSchema = z.object({
  id: IdentifierSchema,
  name: z.string().min(1).max(128),
  version: SchemaVersionSchema,
  description: z.string().min(1).max(4096),
  parameters: ToolParameterSchema,
  outputSchema: ToolOutputSchema.optional(),
  runtime: ToolRuntimeRequirementSchema,
  capabilities: CapabilityManifestSchema,
  limits: ToolLimitConfigSchema.default({}),
  scope: ToolScopeSchema.default("workspace"),
  digest: Sha256DigestSchema,
  metadata: z.record(z.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional(),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;
