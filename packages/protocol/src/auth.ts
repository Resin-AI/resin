import { ISOTimestampSchema, IdentifierSchema, SchemaVersionSchema } from "@resin/contracts";
import { z } from "zod";

export const AuthEntityIdentifierSchema = IdentifierSchema.max(
  64,
  "Authentication identifier exceeds persistent storage limit of 64 characters",
);

/**
 * Standard Resin authorization scopes.
 */
export const AuthScopeSchema = z.enum([
  "device:connect",
  "observations:write",
  "catalog:read",
  "artifacts:read",
  "deployments:read",
  "deployments:write",
  "telemetry:write",
  "control:read",
  "control:write",
  "control:report",
  "privacy:read",
  "privacy:write",
  "privacy:delete",
  "admin:all",
]);

export type AuthScope = z.infer<typeof AuthScopeSchema>;

/**
 * Validated JWT / Token Claims representation.
 */
export const AuthClaimsSchema = z.object({
  accountId: AuthEntityIdentifierSchema,
  deviceId: AuthEntityIdentifierSchema,
  installationId: AuthEntityIdentifierSchema,
  workspaceId: AuthEntityIdentifierSchema,
  scopes: z.array(AuthScopeSchema).min(1).max(12),
  rawUploadConsent: z.boolean().default(false),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  tokenType: z.enum(["access", "refresh", "device_code"]).default("access"),
  subject: IdentifierSchema.optional(),
  userId: IdentifierSchema.optional(),
  actorType: z.enum(["user", "system", "device"]).default("user").optional(),
  familyId: AuthEntityIdentifierSchema.optional(),
  issuer: z.string().optional(),
  audience: z.string().optional(),
});

export type AuthClaims = z.infer<typeof AuthClaimsSchema>;

/**
 * Explicit user auth claims requiring a non-empty userId.
 */
export const UserAuthClaimsSchema = AuthClaimsSchema.extend({
  userId: IdentifierSchema,
});

export type UserAuthClaims = z.infer<typeof UserAuthClaimsSchema>;

export const DeviceApprovalClaimsSchema = z.object({
  userCode: z.string().min(1).max(16),
  accountId: AuthEntityIdentifierSchema,
  workspaceId: AuthEntityIdentifierSchema,
  userId: IdentifierSchema,
  deviceId: AuthEntityIdentifierSchema.optional(),
  installationId: AuthEntityIdentifierSchema.optional(),
  scopes: z.array(AuthScopeSchema).min(1).max(12),
  rawUploadConsent: z.boolean().default(false),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  tokenType: z.literal("device_approval"),
  issuer: z.string().min(1),
  audience: z.string().min(1),
});

export type DeviceApprovalClaims = z.infer<typeof DeviceApprovalClaimsSchema>;

/**
 * 1. Device Auth Bootstrap (Device Code flow start).
 * Endpoint: POST /v1/auth/device/code
 */
export const DeviceAuthBootstrapRequestSchema = z.object({
  deviceId: AuthEntityIdentifierSchema,
  installationId: AuthEntityIdentifierSchema,
  hostname: z.string().min(1).max(255),
  platform: z.enum(["darwin", "linux", "win32", "other"]),
  arch: z.enum(["arm64", "x64", "arm", "ia32", "other"]),
  clientVersion: SchemaVersionSchema,
  scopes: z
    .array(AuthScopeSchema)
    .max(12)
    .default([
      "device:connect",
      "observations:write",
      "catalog:read",
      "artifacts:read",
      "deployments:read",
      "telemetry:write",
      "privacy:read",
      "privacy:write",
      "control:read",
      "control:write",
      "control:report",
    ]),
});

export type DeviceAuthBootstrapRequest = z.infer<typeof DeviceAuthBootstrapRequestSchema>;

export const DeviceAuthBootstrapResponseSchema = z.object({
  deviceCode: z.string().min(16),
  userCode: z.string().min(6),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url().optional(),
  expiresIn: z.number().int().positive().default(900), // 15 minutes
  interval: z.number().int().positive().default(5), // 5 seconds polling interval
});

export type DeviceAuthBootstrapResponse = z.infer<typeof DeviceAuthBootstrapResponseSchema>;

/**
 * 2. Device Token Exchange.
 * Endpoint: POST /v1/auth/device/token
 */
export const DeviceTokenExchangeRequestSchema = z.object({
  grantType: z
    .enum(["urn:ietf:params:oauth:grant-type:device_code", "device_code"])
    .default("urn:ietf:params:oauth:grant-type:device_code"),
  deviceCode: z.string().min(1).max(128),
  deviceId: AuthEntityIdentifierSchema,
  installationId: AuthEntityIdentifierSchema,
});

export type DeviceTokenExchangeRequest = z.infer<typeof DeviceTokenExchangeRequestSchema>;

export const DeviceTokenExchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer").default("Bearer"),
  expiresIn: z.number().int().positive().default(3600), // 1 hour
  refreshToken: z.string().min(1),
  claims: AuthClaimsSchema,
});

export type DeviceTokenExchangeResponse = z.infer<typeof DeviceTokenExchangeResponseSchema>;

/**
 * 3. Token Rotation / Refresh.
 * Endpoint: POST /v1/auth/token/refresh
 */
export const TokenRotationRequestSchema = z.object({
  grantType: z.literal("refresh_token").default("refresh_token"),
  refreshToken: z.string().min(1),
  deviceId: AuthEntityIdentifierSchema,
  installationId: AuthEntityIdentifierSchema,
});

export type TokenRotationRequest = z.infer<typeof TokenRotationRequestSchema>;

export const TokenRotationResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer").default("Bearer"),
  expiresIn: z.number().int().positive().default(3600),
  refreshToken: z.string().min(1), // Rotated new refresh token
  claims: AuthClaimsSchema,
});

export type TokenRotationResponse = z.infer<typeof TokenRotationResponseSchema>;

/**
 * 4. Device Revocation.
 * Endpoint: POST /v1/auth/device/revoke
 */
export const DeviceRevocationRequestSchema = z.object({
  deviceId: AuthEntityIdentifierSchema,
  installationId: AuthEntityIdentifierSchema.optional(),
  token: z.string().optional(),
  tokenTypeHint: z.enum(["access_token", "refresh_token", "device"]).default("device"),
  reason: z.string().min(1).max(512).default("user_initiated"),
});

export type DeviceRevocationRequest = z.infer<typeof DeviceRevocationRequestSchema>;

export const DeviceRevocationResponseSchema = z.object({
  revoked: z.literal(true),
  revokedAt: ISOTimestampSchema,
  deviceId: AuthEntityIdentifierSchema,
  message: z.string().default("Device and associated tokens successfully revoked"),
});

export type DeviceRevocationResponse = z.infer<typeof DeviceRevocationResponseSchema>;

/**
 * Token error codes taxonomy (RFC 6749 & RFC 8628 compliant).
 */
export const TokenErrorCodeSchema = z.enum([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "unsupported_grant_type",
  "revoked_device",
  "unauthorized_client",
]);

export type TokenErrorCode = z.infer<typeof TokenErrorCodeSchema>;

export const TokenErrorResponseSchema = z.object({
  error: TokenErrorCodeSchema,
  error_description: z.string().optional(),
  error_uri: z.string().url().optional(),
  interval: z.number().int().positive().optional(),
});

export type TokenErrorResponse = z.infer<typeof TokenErrorResponseSchema>;

/**
 * Helper to check if claims have expired.
 */
export function areClaimsExpired(claims: AuthClaims, now = Date.now()): boolean {
  return new Date(claims.expiresAt).getTime() <= now;
}

/**
 * Helper to verify that claims contain a required scope or admin:all.
 */
export function hasRequiredScope(claims: AuthClaims, requiredScope: AuthScope): boolean {
  return claims.scopes.includes("admin:all") || claims.scopes.includes(requiredScope);
}

/**
 * Helper to check if claims have a valid user identity bound.
 */
export function isUserAuthClaims(claims: AuthClaims): claims is UserAuthClaims {
  return claims.userId !== undefined && claims.userId !== null && claims.userId.trim().length > 0;
}

/**
 * Asserts that the claims contain a valid user identity, throwing if missing.
 */
export function assertUserClaims(claims: AuthClaims): asserts claims is UserAuthClaims {
  if (!claims.userId || claims.userId.trim().length === 0) {
    throw new Error("User authentication token requires a valid userId");
  }
}
