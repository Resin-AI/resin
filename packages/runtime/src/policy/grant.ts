import {
  type CapabilityManifest,
  CapabilityManifestSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  canonicalJson,
} from "@resin/contracts";
import { sha256 } from "@resin/crypto";
import { z } from "zod";

/**
 * Invocation grant actor schema.
 */
export const GrantActorSchema = z.object({
  type: z.enum(["user", "admin", "policy_engine", "default"]),
  id: z.string().min(1),
});

export type GrantActor = z.infer<typeof GrantActorSchema>;

/**
 * Runtime invocation grant schema.
 * Represents an immutable, cryptographically bound authorization token for a single tool invocation.
 */
export const InvocationGrantSchema = z.object({
  grantId: IdentifierSchema,
  invocationId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  workspaceId: IdentifierSchema,
  envelopeId: IdentifierSchema,
  policyVersion: SchemaVersionSchema,
  capabilities: CapabilityManifestSchema,
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  actor: GrantActorSchema,
  reason: z.string().optional(),
  digest: Sha256DigestSchema,
});

export type InvocationGrant = z.infer<typeof InvocationGrantSchema>;

/**
 * Payload fields of an invocation grant included in the integrity digest.
 */
export type InvocationGrantPayload = Omit<InvocationGrant, "digest">;

/**
 * Deep freezes an object recursively to ensure strict immutability.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Freeze properties first
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }

  return Object.freeze(obj);
}

/**
 * Computes the canonical SHA-256 integrity digest for an invocation grant payload.
 */
export function computeGrantDigest(payload: InvocationGrantPayload): string {
  const normalized = {
    grantId: payload.grantId,
    invocationId: payload.invocationId,
    toolId: payload.toolId,
    toolVersion: payload.toolVersion,
    workspaceId: payload.workspaceId,
    envelopeId: payload.envelopeId,
    policyVersion: payload.policyVersion,
    capabilities: payload.capabilities,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    actor: payload.actor,
    reason: payload.reason,
  };

  const canonicalStr = canonicalJson(normalized);
  return sha256(canonicalStr);
}

export interface CreateInvocationGrantParams {
  grantId?: string;
  invocationId: string;
  toolId: string;
  toolVersion: string;
  workspaceId: string;
  envelopeId: string;
  policyVersion?: string;
  capabilities: CapabilityManifest;
  issuedAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  actor?: GrantActor;
  reason?: string;
}

/**
 * Creates an immutable, cryptographically bound InvocationGrant.
 */
export function createInvocationGrant(params: CreateInvocationGrantParams): InvocationGrant {
  const now = Date.now();
  const issuedAt = params.issuedAt ?? new Date(now).toISOString();
  const ttlMs = params.ttlMs ?? 5 * 60 * 1000; // Default 5 minutes TTL
  const expiresAt = params.expiresAt ?? new Date(now + ttlMs).toISOString();

  const grantId =
    params.grantId ?? `grant_${params.invocationId}_${Math.random().toString(36).slice(2, 10)}`;

  const payload: InvocationGrantPayload = {
    grantId,
    invocationId: params.invocationId,
    toolId: params.toolId,
    toolVersion: params.toolVersion,
    workspaceId: params.workspaceId,
    envelopeId: params.envelopeId,
    policyVersion: params.policyVersion ?? "1.0.0",
    capabilities: CapabilityManifestSchema.parse(params.capabilities),
    issuedAt,
    expiresAt,
    actor: params.actor ?? { type: "policy_engine", id: "engine_v1" },
    reason: params.reason,
  };

  const digest = computeGrantDigest(payload);

  const grant: InvocationGrant = {
    ...payload,
    digest,
  };

  return deepFreeze(grant);
}

export interface VerifyGrantOptions {
  expectedInvocationId?: string;
  expectedToolId?: string;
  expectedToolVersion?: string;
  expectedWorkspaceId?: string;
  expectedEnvelopeId?: string;
  currentTimestamp?: number;
}

export interface GrantVerificationResult {
  valid: boolean;
  errorCode?:
    | "SCHEMA_INVALID"
    | "TAMPERED_DIGEST"
    | "EXPIRED"
    | "INVOCATION_MISMATCH"
    | "TOOL_MISMATCH"
    | "WORKSPACE_MISMATCH"
    | "ENVELOPE_MISMATCH";
  message?: string;
}

/**
 * Verifies an InvocationGrant for cryptographic integrity, expiration, and contextual binding.
 */
export function verifyInvocationGrant(
  grant: unknown,
  options: VerifyGrantOptions = {},
): GrantVerificationResult {
  const parseResult = InvocationGrantSchema.safeParse(grant);
  if (!parseResult.success) {
    return {
      valid: false,
      errorCode: "SCHEMA_INVALID",
      message: `Invalid grant schema: ${parseResult.error.message}`,
    };
  }

  const parsedGrant = parseResult.data;

  // 1. Verify cryptographic digest integrity
  const { digest, ...payload } = parsedGrant;
  const expectedDigest = computeGrantDigest(payload);
  if (digest !== expectedDigest) {
    return {
      valid: false,
      errorCode: "TAMPERED_DIGEST",
      message: `Grant digest mismatch: expected ${expectedDigest}, received ${digest}`,
    };
  }

  // 2. Check expiration timestamp
  const now = options.currentTimestamp ?? Date.now();
  const expiryTime = Date.parse(parsedGrant.expiresAt);
  if (Number.isNaN(expiryTime) || now > expiryTime) {
    return {
      valid: false,
      errorCode: "EXPIRED",
      message: `Grant expired at ${parsedGrant.expiresAt} (current: ${new Date(now).toISOString()})`,
    };
  }

  // 3. Check bound identifiers
  if (options.expectedInvocationId && parsedGrant.invocationId !== options.expectedInvocationId) {
    return {
      valid: false,
      errorCode: "INVOCATION_MISMATCH",
      message: `Invocation ID mismatch: expected ${options.expectedInvocationId}, grant has ${parsedGrant.invocationId}`,
    };
  }

  if (options.expectedToolId && parsedGrant.toolId !== options.expectedToolId) {
    return {
      valid: false,
      errorCode: "TOOL_MISMATCH",
      message: `Tool ID mismatch: expected ${options.expectedToolId}, grant has ${parsedGrant.toolId}`,
    };
  }

  if (options.expectedToolVersion && parsedGrant.toolVersion !== options.expectedToolVersion) {
    return {
      valid: false,
      errorCode: "TOOL_MISMATCH",
      message: `Tool version mismatch: expected ${options.expectedToolVersion}, grant has ${parsedGrant.toolVersion}`,
    };
  }

  if (options.expectedWorkspaceId && parsedGrant.workspaceId !== options.expectedWorkspaceId) {
    return {
      valid: false,
      errorCode: "WORKSPACE_MISMATCH",
      message: `Workspace ID mismatch: expected ${options.expectedWorkspaceId}, grant has ${parsedGrant.workspaceId}`,
    };
  }

  if (options.expectedEnvelopeId && parsedGrant.envelopeId !== options.expectedEnvelopeId) {
    return {
      valid: false,
      errorCode: "ENVELOPE_MISMATCH",
      message: `Envelope ID mismatch: expected ${options.expectedEnvelopeId}, grant has ${parsedGrant.envelopeId}`,
    };
  }

  return { valid: true };
}
