import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "./common.js";
import { SignatureMetadataSchema } from "./versions.js";

/**
 * Default version specifications for the production safety gate.
 */
export const CURRENT_SAFETY_GATE_VERSION = "1.0.0";
export const REQUIRED_RUNTIME_VERSION = "0.1.0";
export const REQUIRED_BROKER_PROTOCOL_VERSION = "1.0.0";
export const REQUIRED_BUNDLE_VERIFIER_VERSION = "1.0.0";
export const REQUIRED_POLICY_VERSION = "1.0.0";

export const SAFETY_GATE_VERSIONS = {
  runtimeVersion: REQUIRED_RUNTIME_VERSION,
  brokerProtocolVersion: REQUIRED_BROKER_PROTOCOL_VERSION,
  bundleVerifierVersion: REQUIRED_BUNDLE_VERIFIER_VERSION,
  policyVersion: REQUIRED_POLICY_VERSION,
} as const;

/**
 * Standard error codes for safety gate evaluations and refusals.
 */
export const SAFETY_GATE_ERROR_CODES = {
  MISSING_ATTESTATION: "MISSING_ATTESTATION",
  EXPIRED_ATTESTATION: "EXPIRED_ATTESTATION",
  INCOMPATIBLE_VERSION: "INCOMPATIBLE_VERSION",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  CORRUPTED_ATTESTATION: "CORRUPTED_ATTESTATION",
  UNMET_SAFETY_CHECK: "UNMET_SAFETY_CHECK",
  UNSAFE_OVERRIDE_ACTIVE: "UNSAFE_OVERRIDE_ACTIVE",
  GATE_FAIL_CLOSED: "GATE_FAIL_CLOSED",
  DOWNGRADED_ATTESTATION: "DOWNGRADED_ATTESTATION",
  FORBIDDEN_ENVIRONMENT: "FORBIDDEN_ENVIRONMENT",
} as const;

export type SafetyGateErrorCode =
  (typeof SAFETY_GATE_ERROR_CODES)[keyof typeof SAFETY_GATE_ERROR_CODES];

/**
 * Environment variable and prefix used for unsafe local development bypass.
 */
export const UNSAFE_DEV_OVERRIDE_ENV_VAR = "RESIN_UNSAFE_ALLOW_AUTONOMOUS";
export const UNSAFE_ENV_PREFIX = "RESIN_UNSAFE_";

/**
 * Minimum required safety checks that must pass in a valid attestation.
 */
export const REQUIRED_SAFETY_CHECKS = [
  "sandboxIsolation",
  "networkIsolation",
  "filesystemMediation",
  "secretRedaction",
  "secretNonDisclosure",
  "signatureVerification",
  "commandIdentity",
  "resourceLimits",
] as const;

export type RequiredSafetyCheck = (typeof REQUIRED_SAFETY_CHECKS)[number];

/**
 * Built-in and invariant meta-tools that bypass the safety gate.
 */
export const SYSTEM_ALLOWED_TOOLS = [
  "search_tools",
  "get_tool_schema",
  "invoke_tool",
  "manage_tools",
] as const;

/**
 * Checks if a tool identifier or name is a system tool that always bypasses the gate.
 */
export function isSafetyGateBypassTool(toolIdOrName: string): boolean {
  if (!toolIdOrName) return false;
  const normalized = toolIdOrName.trim();
  if (SYSTEM_ALLOWED_TOOLS.includes(normalized as (typeof SYSTEM_ALLOWED_TOOLS)[number])) {
    return true;
  }
  return (
    normalized.startsWith("builtin_") ||
    normalized.startsWith("system_") ||
    normalized === "doctor" ||
    normalized === "status" ||
    normalized === "audit"
  );
}

/**
 * Schema for an immutable Safety Attestation Record.
 */
export const SafetyAttestationRecordSchema = z.object({
  attestationId: IdentifierSchema,
  schemaVersion: SchemaVersionSchema.default(CURRENT_SAFETY_GATE_VERSION),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  environment: z.enum(["production", "staging", "development", "test"]).default("production"),
  compatibility: z.object({
    runtimeVersion: SchemaVersionSchema,
    brokerProtocolVersion: SchemaVersionSchema,
    bundleVerifierVersion: SchemaVersionSchema,
    policyVersion: SchemaVersionSchema,
  }),
  checks: z.record(z.boolean()),
  metadata: z.record(z.unknown()).optional(),
  signature: SignatureMetadataSchema.optional(),
});

export type SafetyAttestationRecord = z.infer<typeof SafetyAttestationRecordSchema>;

/**
 * Schema for an unmet requirement in the safety gate status.
 */
export const UnmetRequirementSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  remediation: z.string().min(1),
});

export type UnmetRequirement = z.infer<typeof UnmetRequirementSchema>;

/**
 * Schema for the overall Production Readiness Safety Gate status.
 */
export const ProductionSafetyGateStatusSchema = z.object({
  isOpen: z.boolean(),
  status: z.enum(["passed", "failed", "unsafe_override", "uninitialized"]),
  evaluatedAt: ISOTimestampSchema,
  versions: z.object({
    runtimeVersion: SchemaVersionSchema,
    brokerProtocolVersion: SchemaVersionSchema,
    bundleVerifierVersion: SchemaVersionSchema,
    policyVersion: SchemaVersionSchema,
  }),
  reasons: z.array(z.string()),
  unmetRequirements: z.array(UnmetRequirementSchema),
  attestation: SafetyAttestationRecordSchema.optional(),
  unsafeOverrideActive: z.boolean().default(false),
});

export type ProductionSafetyGateStatus = z.infer<typeof ProductionSafetyGateStatusSchema>;

/**
 * Schema for structured refusals returned when the safety gate blocks tool execution.
 */
export const SafetyGateRefusalSchema = z.object({
  isError: z.literal(true),
  refusalCode: z.string().min(1),
  refusalReason: z.string().min(1),
  remediation: z.string().min(1),
  unmetGates: z.array(z.string()),
  evaluatedAt: ISOTimestampSchema,
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  ),
  details: z.record(z.unknown()).optional(),
});

export type SafetyGateRefusal = z.infer<typeof SafetyGateRefusalSchema>;
