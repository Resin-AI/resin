import { describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  ClockSkewError,
  DecompressionBombError,
  DeviceRevokedError,
  PermissionDeniedError,
  ProtocolError,
  ProtocolErrorCodeSchema,
  ProtocolErrorResponseSchema,
  RateLimitedError,
  RetryableError,
  SequenceError,
  TerminalError,
  TokenExpiredError,
  UpgradeRequiredError,
  ValidationError,
  defaultHttpStatusForCode,
  isProtocolError,
  isRetryableProtocolError,
} from "../src/index.js";

describe("Protocol Error Taxonomy & Subclasses", () => {
  it("validates protocol error code taxonomy schema", () => {
    expect(ProtocolErrorCodeSchema.safeParse("retryable").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("upgrade_required").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("permission_denied").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("validation").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("terminal").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("clock_skew").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("rate_limited").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("device_revoked").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("decompression_bomb").success).toBe(true);
    expect(ProtocolErrorCodeSchema.safeParse("unknown_error_xyz").success).toBe(false);
  });

  it("formats ProtocolError into valid ProtocolErrorResponse", () => {
    const error = new ProtocolError("validation", "Field 'name' is required", {
      details: { field: "name" },
      traceId: "trace-abc-123",
    });

    expect(isProtocolError(error)).toBe(true);
    expect(error.code).toBe("validation");
    expect(error.status).toBe(400);

    const response = error.toResponse();
    const validated = ProtocolErrorResponseSchema.parse(response);
    expect(validated.error.code).toBe("validation");
    expect(validated.error.message).toBe("Field 'name' is required");
    expect(validated.error.traceId).toBe("trace-abc-123");
    expect(validated.status).toBe(400);
  });

  it("creates and asserts specific error subclasses", () => {
    const retryable = new RetryableError("Server busy", { retryAfterMs: 3000 });
    expect(retryable.code).toBe("retryable");
    expect(retryable.status).toBe(503);
    expect(retryable.retryAfterMs).toBe(3000);
    expect(isRetryableProtocolError(retryable)).toBe(true);

    const upgrade = new UpgradeRequiredError("Protocol v1 deprecated", "2.0.0");
    expect(upgrade.code).toBe("upgrade_required");
    expect(upgrade.status).toBe(426);
    expect(upgrade.minSupportedVersion).toBe("2.0.0");

    const denied = new PermissionDeniedError("Workspace access forbidden");
    expect(denied.code).toBe("permission_denied");

    const validation = new ValidationError("Invalid format");
    expect(validation.code).toBe("validation");
    expect(validation.status).toBe(400);

    const terminal = new TerminalError("Fatal system error");
    expect(terminal.code).toBe("terminal");
    expect(terminal.status).toBe(500);

    const clockSkew = new ClockSkewError(
      "Clock skew too large",
      new Date().toISOString(),
      new Date(Date.now() - 600000).toISOString(),
      600000,
    );
    expect(clockSkew.code).toBe("clock_skew");
    expect(clockSkew.clockSkewMs).toBe(600000);

    const rateLimited = new RateLimitedError("Rate limit exceeded", { retryAfterMs: 5000 });
    expect(rateLimited.code).toBe("rate_limited");
    expect(rateLimited.status).toBe(429);
    expect(isRetryableProtocolError(rateLimited)).toBe(true);

    const revoked = new DeviceRevokedError("dev-001");
    expect(revoked.code).toBe("device_revoked");
    expect(revoked.status).toBe(401);
    expect(revoked.deviceId).toBe("dev-001");

    const expired = new TokenExpiredError();
    expect(expired.code).toBe("token_expired");
    expect(expired.status).toBe(401);

    const checksum = new ChecksumMismatchError("expected-sha", "actual-sha");
    expect(checksum.code).toBe("checksum_mismatch");
    expect(checksum.expectedDigest).toBe("expected-sha");

    const seqError = new SequenceError(5, 7);
    expect(seqError.code).toBe("out_of_order");
    expect(seqError.expectedSequence).toBe(5);
    expect(seqError.receivedSequence).toBe(7);

    const bombError = new DecompressionBombError(100_000_000, 52_428_800);
    expect(bombError.code).toBe("decompression_bomb");
    expect(bombError.status).toBe(413);
    expect(bombError.declaredSize).toBe(100_000_000);
  });

  it("maps error codes to appropriate default HTTP status codes", () => {
    expect(defaultHttpStatusForCode("retryable")).toBe(503);
    expect(defaultHttpStatusForCode("upgrade_required")).toBe(426);
    expect(defaultHttpStatusForCode("validation")).toBe(400);
    expect(defaultHttpStatusForCode("terminal")).toBe(500);
    expect(defaultHttpStatusForCode("rate_limited")).toBe(429);
    expect(defaultHttpStatusForCode("device_revoked")).toBe(401);
    expect(defaultHttpStatusForCode("not_found")).toBe(404);
    expect(defaultHttpStatusForCode("decompression_bomb")).toBe(413);
  });
});
