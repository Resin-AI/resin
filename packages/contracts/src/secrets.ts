import { z } from "zod";
import { ISOTimestampSchema, IdentifierSchema } from "./common.js";

/**
 * Supported mediation modes for injecting secrets without disclosing raw values.
 */
export const SecretMediationModeSchema = z.enum([
  "header_template",
  "bearer_token",
  "query_template",
  "command_stdin",
  "command_env",
]);

export type SecretMediationMode = z.infer<typeof SecretMediationModeSchema>;

/**
 * All valid mediation modes as a constant array.
 */
export const ALL_SECRET_MEDIATION_MODES: readonly SecretMediationMode[] = [
  "header_template",
  "bearer_token",
  "query_template",
  "command_stdin",
  "command_env",
] as const;

/**
 * Schema for an opaque, non-disclosing secret reference.
 * Allows generated tools and workers to refer to credentials without ever
 * observing, receiving, or serializing plaintext secret bytes.
 */
export const SecretReferenceSchema = z.object({
  kind: z.literal("secret_reference").default("secret_reference"),
  /** Secret alias/name in the store (e.g. "GITHUB_TOKEN", "DATABASE_KEY") */
  name: z.string().min(1),
  /** Opaque reference identifier / handle */
  ref: z.string().min(1),
  /** Workspace boundary where this reference is valid */
  workspaceId: z.string().min(1).default("default"),
  /** Permitted mediation modes for this reference */
  permittedModes: z
    .array(SecretMediationModeSchema)
    .default(["header_template", "bearer_token", "query_template", "command_stdin", "command_env"]),
  /** Optional tool ID bound to this reference */
  toolId: z.string().optional(),
  /** Optional account ID bound to this reference */
  accountId: z.string().optional(),
  /** Optional installation ID bound to this reference */
  installationId: z.string().optional(),
  /** Optional grant ID bound to this reference */
  grantId: z.string().optional(),
  /** Optional expiration timestamp (ISO 8601) */
  expiresAt: ISOTimestampSchema.optional(),
  /** Non-sensitive metadata (never contains secret values) */
  metadata: z.record(z.unknown()).default({}),
});

export type SecretReference = z.infer<typeof SecretReferenceSchema>;

/**
 * Alias for SecretReference emphasizing opacity and non-disclosure.
 */
export type OpaqueSecretRef = SecretReference;

/**
 * Options for creating an opaque secret reference.
 */
export interface CreateSecretReferenceOptions {
  name: string;
  ref?: string;
  workspaceId?: string;
  permittedModes?: SecretMediationMode[];
  toolId?: string;
  accountId?: string;
  installationId?: string;
  grantId?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Creates an opaque secret reference object.
 */
export function createSecretReference(options: CreateSecretReferenceOptions): SecretReference {
  const refHandle =
    options.ref ??
    `sec_ref_${options.name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_${Math.random().toString(36).substring(2, 10)}`;

  return SecretReferenceSchema.parse({
    kind: "secret_reference",
    name: options.name,
    ref: refHandle,
    workspaceId: options.workspaceId ?? "default",
    permittedModes: options.permittedModes ?? [
      "header_template",
      "bearer_token",
      "query_template",
      "command_stdin",
      "command_env",
    ],
    toolId: options.toolId,
    accountId: options.accountId,
    installationId: options.installationId,
    grantId: options.grantId,
    expiresAt: options.expiresAt,
    metadata: options.metadata ?? {},
  });
}

/**
 * Alias for createSecretReference.
 */
export const createOpaqueSecretRef = createSecretReference;

/**
 * Type guard to verify if an object is a valid SecretReference.
 */
export function isSecretReference(value: unknown): value is SecretReference {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "secret_reference" &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.ref === "string" &&
    candidate.ref.length > 0
  );
}

/**
 * Validation context for verifying secret reference scope and lifetime.
 */
export interface SecretReferenceValidationContext {
  workspaceId?: string;
  toolId?: string;
  accountId?: string;
  installationId?: string;
  grantId?: string;
  currentTimestamp?: number;
}

/**
 * Result of secret reference scope validation.
 */
export interface SecretReferenceValidationResult {
  valid: boolean;
  code?: string;
  reason?: string;
}

/**
 * Validates that a secret reference is allowed in the given execution context.
 */
export function validateSecretReferenceScope(
  ref: SecretReference,
  context: SecretReferenceValidationContext = {},
): SecretReferenceValidationResult {
  // 1. Workspace scope check
  if (context.workspaceId && ref.workspaceId && ref.workspaceId !== "default") {
    if (ref.workspaceId !== context.workspaceId) {
      return {
        valid: false,
        code: "WORKSPACE_MISMATCH",
        reason: `Secret reference workspace '${ref.workspaceId}' does not match context workspace '${context.workspaceId}'`,
      };
    }
  }

  // 2. Tool scope check
  if (ref.toolId && context.toolId) {
    if (ref.toolId !== context.toolId) {
      return {
        valid: false,
        code: "TOOL_MISMATCH",
        reason: `Secret reference tool '${ref.toolId}' does not match context tool '${context.toolId}'`,
      };
    }
  }

  // 3. Account scope check
  if (ref.accountId && context.accountId) {
    if (ref.accountId !== context.accountId) {
      return {
        valid: false,
        code: "ACCOUNT_MISMATCH",
        reason: `Secret reference account '${ref.accountId}' does not match context account '${context.accountId}'`,
      };
    }
  }

  // 4. Installation scope check
  if (ref.installationId && context.installationId) {
    if (ref.installationId !== context.installationId) {
      return {
        valid: false,
        code: "INSTALLATION_MISMATCH",
        reason: `Secret reference installation '${ref.installationId}' does not match context installation '${context.installationId}'`,
      };
    }
  }

  // 5. Grant ID check
  if (ref.grantId && context.grantId) {
    if (ref.grantId !== context.grantId) {
      return {
        valid: false,
        code: "GRANT_MISMATCH",
        reason: `Secret reference grant '${ref.grantId}' does not match context grant '${context.grantId}'`,
      };
    }
  }

  // 6. Expiry check
  if (ref.expiresAt) {
    const expiresMs = Date.parse(ref.expiresAt);
    const nowMs = context.currentTimestamp ?? Date.now();
    if (!Number.isNaN(expiresMs) && nowMs > expiresMs) {
      return {
        valid: false,
        code: "GRANT_EXPIRED",
        reason: `Secret reference expired at ${ref.expiresAt}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Secret Mediation Request schema for host broker dispatch.
 * Encapsulates the reference, mediation mode, and optional execution context.
 * Does not accept or return raw secrets.
 */
export const SecretMediationRequestSchema = z.object({
  reference: z.union([SecretReferenceSchema, z.string().min(1)]),
  mode: SecretMediationModeSchema,
  template: z.string().optional(),
  targetKey: z.string().optional(),
  context: z
    .object({
      workspaceId: z.string().min(1).optional(),
      toolId: z.string().optional(),
      invocationId: z.string().optional(),
      accountId: z.string().optional(),
      installationId: z.string().optional(),
      grantId: z.string().optional(),
    })
    .optional(),
});

export type SecretMediationRequest = z.infer<typeof SecretMediationRequestSchema>;

/**
 * Non-disclosing secret mediation result schema.
 * Confirms that mediation was applied host-side without exposing plaintext value.
 */
export const SecretMediationResultSchema = z.object({
  success: z.boolean(),
  mode: SecretMediationModeSchema,
  secretName: z.string(),
  referenceId: z.string().optional(),
  appliedTo: z.string().optional(),
});

export type SecretMediationResult = z.infer<typeof SecretMediationResultSchema>;

/**
 * Formats a secret template string for network headers or URL parameters.
 */
export function formatSecretTemplate(secretNameOrRef: string | SecretReference): string {
  const name = typeof secretNameOrRef === "string" ? secretNameOrRef : secretNameOrRef.name;
  return `{{secret:${name}}}`;
}
