import { describe, expect, it } from "vitest";
import {
  AuthClaimsSchema,
  AuthScopeSchema,
  DeviceApprovalClaimsSchema,
  DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponseSchema,
  DeviceRevocationRequestSchema,
  DeviceRevocationResponseSchema,
  DeviceTokenExchangeRequestSchema,
  DeviceTokenExchangeResponseSchema,
  TokenErrorCodeSchema,
  TokenErrorResponseSchema,
  TokenRotationRequestSchema,
  TokenRotationResponseSchema,
  UserAuthClaimsSchema,
  areClaimsExpired,
  assertUserClaims,
  hasRequiredScope,
  isUserAuthClaims,
} from "../src/index.js";

describe("Device Authentication & Token Protocols", () => {
  it("validates DeviceAuthBootstrapRequest and Response schemas", () => {
    const validRequest = {
      deviceId: "dev-001",
      installationId: "inst-001",
      hostname: "macbook-pro.local",
      platform: "darwin" as const,
      arch: "arm64" as const,
      clientVersion: "1.0.0",
      scopes: ["device:connect" as const, "observations:write" as const],
    };

    const parsedRequest = DeviceAuthBootstrapRequestSchema.parse(validRequest);
    expect(parsedRequest.deviceId).toBe("dev-001");
    expect(parsedRequest.platform).toBe("darwin");

    const validResponse = {
      deviceCode: "dcode_abcdef1234567890",
      userCode: "UC-XYZ123",
      verificationUri: "https://auth.resin.sh/activate",
      verificationUriComplete: "https://auth.resin.sh/activate?user_code=UC-XYZ123",
      expiresIn: 900,
      interval: 5,
    };

    const parsedResponse = DeviceAuthBootstrapResponseSchema.parse(validResponse);
    expect(parsedResponse.userCode).toBe("UC-XYZ123");
    expect(parsedResponse.interval).toBe(5);
  });

  it("bounds persisted device bootstrap fields", () => {
    const baseRequest = {
      deviceId: "dev-001",
      installationId: "inst-001",
      hostname: "workstation",
      platform: "linux" as const,
      arch: "x64" as const,
      clientVersion: "1.0.0",
    };

    expect(
      DeviceAuthBootstrapRequestSchema.safeParse({
        ...baseRequest,
        hostname: "x".repeat(256),
      }).success,
    ).toBe(false);
    expect(
      DeviceAuthBootstrapRequestSchema.safeParse({
        ...baseRequest,
        scopes: Array.from({ length: 13 }, () => "device:connect"),
      }).success,
    ).toBe(false);
    expect(
      DeviceAuthBootstrapRequestSchema.safeParse({
        ...baseRequest,
        deviceId: "d".repeat(65),
      }).success,
    ).toBe(false);
  });

  it("validates DeviceTokenExchange and Claims schemas", () => {
    const request = {
      grantType: "urn:ietf:params:oauth:grant-type:device_code" as const,
      deviceCode: "dcode_abcdef1234567890",
      deviceId: "dev-001",
      installationId: "inst-001",
    };

    const parsedRequest = DeviceTokenExchangeRequestSchema.parse(request);
    expect(parsedRequest.deviceCode).toBe("dcode_abcdef1234567890");

    const claims = {
      accountId: "acc-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      scopes: ["device:connect" as const, "observations:write" as const, "catalog:read" as const],
      rawUploadConsent: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: "access" as const,
    };

    const response = {
      accessToken: "atk_sample_token",
      tokenType: "Bearer" as const,
      expiresIn: 3600,
      refreshToken: "rtk_sample_refresh",
      claims,
    };

    const parsedResponse = DeviceTokenExchangeResponseSchema.parse(response);
    expect(parsedResponse.accessToken).toBe("atk_sample_token");
    expect(parsedResponse.claims.scopes).toContain("observations:write");
  });

  it("validates TokenRotationRequest and TokenRotationResponse schemas", () => {
    const rotationRequest = {
      grantType: "refresh_token" as const,
      refreshToken: "rtk_old_refresh",
      deviceId: "dev-001",
      installationId: "inst-001",
    };

    const parsedRequest = TokenRotationRequestSchema.parse(rotationRequest);
    expect(parsedRequest.refreshToken).toBe("rtk_old_refresh");

    const rotationResponse = {
      accessToken: "atk_new_access",
      tokenType: "Bearer" as const,
      expiresIn: 3600,
      refreshToken: "rtk_new_refresh",
      claims: {
        accountId: "acc-001",
        deviceId: "dev-001",
        installationId: "inst-001",
        workspaceId: "ws-001",
        scopes: ["device:connect" as const, "observations:write" as const],
        rawUploadConsent: true,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        tokenType: "access" as const,
      },
    };

    const parsedResponse = TokenRotationResponseSchema.parse(rotationResponse);
    expect(parsedResponse.refreshToken).toBe("rtk_new_refresh");
  });

  it("validates DeviceRevocationRequest and DeviceRevocationResponse schemas", () => {
    const revokeRequest = {
      deviceId: "dev-001",
      installationId: "inst-001",
      reason: "security_compromise",
    };

    const parsedRequest = DeviceRevocationRequestSchema.parse(revokeRequest);
    expect(parsedRequest.deviceId).toBe("dev-001");
    expect(parsedRequest.tokenTypeHint).toBe("device");

    const revokeResponse = {
      revoked: true as const,
      revokedAt: new Date().toISOString(),
      deviceId: "dev-001",
      message: "Device successfully revoked",
    };

    const parsedResponse = DeviceRevocationResponseSchema.parse(revokeResponse);
    expect(parsedResponse.revoked).toBe(true);
  });

  it("evaluates claims helpers: hasRequiredScope and areClaimsExpired", () => {
    const validClaims = {
      accountId: "acc-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      scopes: ["observations:write" as const, "catalog:read" as const],
      rawUploadConsent: false,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
      tokenType: "access" as const,
    };

    expect(hasRequiredScope(validClaims, "observations:write")).toBe(true);
    expect(hasRequiredScope(validClaims, "deployments:write")).toBe(false);
    expect(areClaimsExpired(validClaims)).toBe(false);

    // Admin all scope grant
    const adminClaims = {
      ...validClaims,
      scopes: ["admin:all" as const],
    };
    expect(hasRequiredScope(adminClaims, "deployments:write")).toBe(true);
    expect(hasRequiredScope(adminClaims, "telemetry:write")).toBe(true);

    // Expired claims
    const expiredClaims = {
      ...validClaims,
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    };
    expect(areClaimsExpired(expiredClaims)).toBe(true);
  });

  it("validates dedicated privacy scopes with least-privilege authorization", () => {
    const privacyScopes = ["privacy:read", "privacy:write", "privacy:delete"] as const;
    const baseClaims = {
      accountId: "acc-privacy-1",
      deviceId: "dev-privacy-1",
      installationId: "inst-privacy-1",
      workspaceId: "ws-privacy-1",
      rawUploadConsent: false,
      issuedAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-08-28T01:00:00.000Z",
      tokenType: "access" as const,
    };

    for (const scope of privacyScopes) {
      expect(AuthScopeSchema.parse(scope)).toBe(scope);
    }

    const privacyClaims = AuthClaimsSchema.parse({
      ...baseClaims,
      scopes: privacyScopes,
    });
    expect(privacyClaims.scopes).toEqual(privacyScopes);

    const readOnlyClaims = AuthClaimsSchema.parse({
      ...baseClaims,
      scopes: ["privacy:read"],
    });
    expect(hasRequiredScope(readOnlyClaims, "privacy:read")).toBe(true);
    expect(hasRequiredScope(readOnlyClaims, "privacy:write")).toBe(false);
    expect(hasRequiredScope(readOnlyClaims, "privacy:delete")).toBe(false);

    const deviceOnlyClaims = AuthClaimsSchema.parse({
      ...baseClaims,
      scopes: ["device:connect"],
      actorType: "device",
    });
    for (const scope of privacyScopes) {
      expect(hasRequiredScope(deviceOnlyClaims, scope)).toBe(false);
    }

    const deviceBootstrap = DeviceAuthBootstrapRequestSchema.parse({
      deviceId: "dev-privacy-1",
      installationId: "inst-privacy-1",
      hostname: "privacy-device",
      platform: "linux",
      arch: "arm64",
      clientVersion: "1.0.0",
    });
    expect(deviceBootstrap.scopes).toEqual(
      expect.arrayContaining([
        "privacy:read",
        "privacy:write",
        "control:read",
        "control:write",
        "control:report",
      ]),
    );
    expect(deviceBootstrap.scopes).not.toContain("privacy:delete");

    const adminClaims = AuthClaimsSchema.parse({
      ...baseClaims,
      scopes: ["admin:all"],
    });
    for (const scope of privacyScopes) {
      expect(hasRequiredScope(adminClaims, scope)).toBe(true);
    }
  });

  it("validates TokenError taxonomy and response schemas", () => {
    const errorResponse = {
      error: "authorization_pending" as const,
      error_description:
        "The authorization request is still pending as the user has not yet entered the code.",
      interval: 5,
    };

    const parsed = TokenErrorResponseSchema.parse(errorResponse);
    expect(parsed.error).toBe("authorization_pending");
    expect(parsed.interval).toBe(5);

    expect(TokenErrorCodeSchema.safeParse("revoked_device").success).toBe(true);
    expect(TokenErrorCodeSchema.safeParse("slow_down").success).toBe(true);
    expect(TokenErrorCodeSchema.safeParse("invalid_scope").success).toBe(true);
  });

  it("round-trips userId in AuthClaimsSchema and enforces required userId in UserAuthClaimsSchema", () => {
    const baseClaims = {
      accountId: "acc-resin-1",
      deviceId: "dev-resin-1",
      installationId: "inst-resin-1",
      workspaceId: "ws-resin-1",
      userId: "usr-resin-100",
      actorType: "user" as const,
      scopes: ["device:connect" as const, "catalog:read" as const],
      rawUploadConsent: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: "access" as const,
    };

    // AuthClaimsSchema round-trips userId
    const parsedAuthClaims = AuthClaimsSchema.parse(baseClaims);
    expect(parsedAuthClaims.userId).toBe("usr-resin-100");
    expect(parsedAuthClaims.actorType).toBe("user");
    expect(isUserAuthClaims(parsedAuthClaims)).toBe(true);
    expect(() => assertUserClaims(parsedAuthClaims)).not.toThrow();

    // UserAuthClaimsSchema passes when userId is present
    const parsedUserClaims = UserAuthClaimsSchema.parse(baseClaims);
    expect(parsedUserClaims.userId).toBe("usr-resin-100");

    // UserAuthClaimsSchema rejects missing userId
    const { userId: _removed, ...missingUserClaims } = baseClaims;
    expect(UserAuthClaimsSchema.safeParse(missingUserClaims).success).toBe(false);

    const parsedAnonymous = AuthClaimsSchema.parse(missingUserClaims);
    expect(parsedAnonymous.userId).toBeUndefined();
    expect(isUserAuthClaims(parsedAnonymous)).toBe(false);
    expect(() => assertUserClaims(parsedAnonymous)).toThrow(
      "User authentication token requires a valid userId",
    );
  });

  it("binds userId, accountId, workspaceId, and device attributes in DeviceApprovalClaimsSchema", () => {
    const approvalClaims = {
      userCode: "UC-TEST-88",
      accountId: "acc-bound-1",
      workspaceId: "ws-bound-1",
      userId: "usr-bound-99",
      deviceId: "dev-bound-1",
      installationId: "inst-bound-1",
      scopes: ["device:connect" as const],
      rawUploadConsent: false,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      tokenType: "device_approval" as const,
      issuer: "https://auth.resin.test",
      audience: "resin-cloud",
    };

    const parsed = DeviceApprovalClaimsSchema.parse(approvalClaims);
    expect(parsed.userId).toBe("usr-bound-99");
    expect(parsed.accountId).toBe("acc-bound-1");
    expect(parsed.workspaceId).toBe("ws-bound-1");
    expect(parsed.deviceId).toBe("dev-bound-1");
    expect(parsed.installationId).toBe("inst-bound-1");
  });
});
