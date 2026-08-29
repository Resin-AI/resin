import { PROTOCOL_VERSION, ProtocolError, RateLimitedError } from "@resin/protocol";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { CloudRequestIdentity } from "../src/cloud-credentials.js";
import { CloudObservationClient, type TrajectoryObservation } from "../src/cloud-runtime.js";

function makeTestIdentity(overrides: Partial<CloudRequestIdentity> = {}): CloudRequestIdentity {
  return {
    accountId: "acc-test-1",
    workspaceId: "ws-test-1",
    deviceId: "dev-test-1",
    installationId: "inst-test-1",
    userId: "user-test-1",
    accessToken: "jwt-test-token-valid",
    cloudUrl: "https://api.resin.local",
    ...overrides,
  };
}

function makeValidObservation(
  overrides: Partial<TrajectoryObservation> = {},
): TrajectoryObservation {
  return {
    observationId: "obs-12345",
    accountId: "acc-test-1",
    workspaceId: "ws-test-1",
    ownerUserId: "usr-test-1",
    projectId: "prj-test-1",
    candidateId: "cand-test-1",
    toolId: "tool-test-1",
    toolVersion: "1.0.0",
    workloadId: "wl-test-1",
    trajectoryId: "traj-test-1",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    runtimeVersion: "1.0.0",
    role: "candidate",
    status: "success",
    isEquivalent: true,
    catalogExposureTokens: 100,
    usage: {
      availability: "complete",
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cachedInputTokens: 300,
      totalTokens: 1200,
      costMicroUsd: 4500,
      durationMs: 1500,
    },
    observedAt: "2026-08-27T10:00:00.000Z",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  };
}

describe("CloudObservationClient.sendTrajectoryObservationBatch", () => {
  it("transmits batch with exact path, POST method, and json body", async () => {
    const identity = makeTestIdentity({ cloudUrl: "https://api.resin.local///" });
    const obs = makeValidObservation();

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body as string;

      return new Response(
        JSON.stringify({
          received: 1,
          accepted: 1,
          rejected: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Test passing { observations: [...] }
    const result = await client.sendTrajectoryObservationBatch({
      observations: [obs],
    });

    expect(result).toEqual({
      received: 1,
      accepted: 1,
      rejected: 0,
    });
    expect(capturedUrl).toBe("https://api.resin.local/v1/analytics/trajectories/batch");
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({
      observations: [obs],
    });

    // Test passing direct array [...]
    const arrayResult = await client.sendTrajectoryObservationBatch([obs]);
    expect(arrayResult.accepted).toBe(1);
    expect(JSON.parse(capturedBody)).toEqual({
      observations: [obs],
    });
  });

  it("includes all required auth identity headers and protocol version", async () => {
    const identity = makeTestIdentity({
      accountId: "acc-header-test",
      workspaceId: "ws-header-test",
      deviceId: "dev-header-test",
      installationId: "inst-header-test",
      accessToken: "token-header-secret",
    });
    const obs = makeValidObservation();

    let capturedHeaders: Record<string, string> = {};

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.sendTrajectoryObservationBatch([obs]);

    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders.Authorization).toBe("Bearer token-header-secret");
    expect(capturedHeaders["x-account-id"]).toBe("acc-header-test");
    expect(capturedHeaders["x-workspace-id"]).toBe("ws-header-test");
    expect(capturedHeaders["x-device-id"]).toBe("dev-header-test");
    expect(capturedHeaders["x-installation-id"]).toBe("inst-header-test");
    expect(capturedHeaders["x-protocol-version"]).toBe(PROTOCOL_VERSION);
  });

  it("performs single forced-refresh retry on 401 and succeeds with refreshed token", async () => {
    const initialIdentity = makeTestIdentity({ accessToken: "token-expired" });
    const refreshedIdentity = makeTestIdentity({ accessToken: "token-fresh-new" });

    let callCount = 0;
    const providerMock = vi.fn().mockImplementation(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) {
        return refreshedIdentity;
      }
      return initialIdentity;
    });

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const authHeader = (init?.headers as Record<string, string>)?.Authorization;

      if (callCount === 1) {
        expect(authHeader).toBe("Bearer token-expired");
        return new Response(JSON.stringify({ error: "UNAUTHORIZED", message: "Token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(authHeader).toBe("Bearer token-fresh-new");
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: providerMock,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sendTrajectoryObservationBatch([makeValidObservation()]);

    expect(result.accepted).toBe(1);
    expect(callCount).toBe(2);
    expect(providerMock).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("fails when 401 occurs and token refresh returns null", async () => {
    const initialIdentity = makeTestIdentity({ accessToken: "token-expired" });

    const providerMock = vi.fn().mockImplementation(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) {
        return null;
      }
      return initialIdentity;
    });

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: providerMock,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      /401 Unauthorized.*token refresh failed/i,
    );
  });

  it("does not loop infinitely if 401 occurs again on retry", async () => {
    const initialIdentity = makeTestIdentity({ accessToken: "token-bad-1" });
    const refreshedIdentity = makeTestIdentity({ accessToken: "token-bad-2" });

    let callCount = 0;
    const providerMock = vi.fn().mockImplementation(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) {
        return refreshedIdentity;
      }
      return initialIdentity;
    });

    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: providerMock,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      /HTTP 401/i,
    );
    expect(callCount).toBe(2);
  });

  it("handles 429 rate limiting with numeric seconds Retry-After header", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "15" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.sendTrajectoryObservationBatch([makeValidObservation()]);
      expect.unreachable("Should have thrown RateLimitedError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const rateErr = err as RateLimitedError;
      expect(rateErr.retryAfterMs).toBe(15000);
      expect(rateErr.status).toBe(429);
    }
  });

  it("handles 429 rate limiting with HTTP Date format Retry-After header", async () => {
    const identity = makeTestIdentity();
    const futureDate = new Date(Date.now() + 8000).toUTCString();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": futureDate },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.sendTrajectoryObservationBatch([makeValidObservation()]);
      expect.unreachable("Should have thrown RateLimitedError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const rateErr = err as RateLimitedError;
      expect(rateErr.retryAfterMs).toBeDefined();
      expect(rateErr.retryAfterMs).toBeGreaterThan(5000);
      expect(rateErr.retryAfterMs).toBeLessThanOrEqual(9000);
    }
  });

  it("handles 429 rate limiting without Retry-After header gracefully", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.sendTrajectoryObservationBatch([makeValidObservation()]);
      expect.unreachable("Should have thrown RateLimitedError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const rateErr = err as RateLimitedError;
      expect(rateErr.retryAfterMs).toBeUndefined();
    }
  });

  it("rejects request schema locally when raw/unknown top-level fields are present", async () => {
    const identity = makeTestIdentity();
    const fetchMock = vi.fn();

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const invalidInput = {
      observations: [makeValidObservation()],
      unknownField: "malicious_payload",
    } as unknown as { observations: TrajectoryObservation[] };

    await expect(client.sendTrajectoryObservationBatch(invalidInput)).rejects.toThrow(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects request schema locally when unknown fields are present on observation", async () => {
    const identity = makeTestIdentity();
    const fetchMock = vi.fn();

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const invalidObs = {
      ...makeValidObservation(),
      prompt: "SELECT * FROM users",
      rawTranscript: "user asked for credentials",
    } as unknown as TrajectoryObservation;

    await expect(client.sendTrajectoryObservationBatch([invalidObs])).rejects.toThrow(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects request schema locally when unknown fields are present in usage object", async () => {
    const identity = makeTestIdentity();
    const fetchMock = vi.fn();

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const invalidObs = makeValidObservation({
      usage: {
        availability: "complete",
        totalTokens: 100,
        unsupportedField: 42,
      } as unknown as TrajectoryObservation["usage"],
    });

    await expect(client.sendTrajectoryObservationBatch([invalidObs])).rejects.toThrow(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty observations batch before making network call", async () => {
    const identity = makeTestIdentity();
    const fetchMock = vi.fn();

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([])).rejects.toThrow(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects complete usage when totalTokens is missing", async () => {
    const identity = makeTestIdentity();
    const fetchMock = vi.fn();

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const invalidObs = makeValidObservation({
      usage: {
        availability: "complete",
        inputTokens: 100,
        outputTokens: 50,
      } as unknown as TrajectoryObservation["usage"],
    });

    await expect(client.sendTrajectoryObservationBatch([invalidObs])).rejects.toThrow(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates successful response with errors array", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          received: 2,
          accepted: 1,
          rejected: 1,
          errors: [{ index: 1, reason: "Duplicate observationId" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await client.sendTrajectoryObservationBatch([
      makeValidObservation({ observationId: "obs-1" }),
      makeValidObservation({ observationId: "obs-2" }),
    ]);

    expect(response).toEqual({
      received: 2,
      accepted: 1,
      rejected: 1,
      errors: [{ index: 1, reason: "Duplicate observationId" }],
    });
  });

  it("rejects response when server returns invalid schema (e.g. missing accepted count)", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          received: 1,
          // accepted missing
          rejected: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      ZodError,
    );
  });

  it("rejects response when server returns unknown fields due to strict response schema", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          received: 1,
          accepted: 1,
          rejected: 0,
          unexpectedExtraField: "should_fail",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      ZodError,
    );
  });

  it("throws ProtocolError on non-JSON response body", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      ProtocolError,
    );
  });

  it("handles 5xx retryable errors from cloud origin", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.sendTrajectoryObservationBatch([makeValidObservation()]);
      expect.unreachable("Should have thrown ProtocolError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ProtocolError);
      const protoErr = err as ProtocolError;
      expect(protoErr.code).toBe("retryable");
      expect(protoErr.status).toBe(500);
    }
  });

  it("handles network failure as retryable ProtocolError", async () => {
    const identity = makeTestIdentity();

    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new TypeError("Failed to fetch (ECONNREFUSED)");
    });

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.sendTrajectoryObservationBatch([makeValidObservation()]);
      expect.unreachable("Should have thrown ProtocolError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ProtocolError);
      const protoErr = err as ProtocolError;
      expect(protoErr.code).toBe("retryable");
      expect(protoErr.message).toContain("Failed to transmit trajectory observation batch");
    }
  });

  it("throws descriptive error when no identity or credentials available", async () => {
    const client = new CloudObservationClient({
      identityProvider: async () => null,
    });

    await expect(client.sendTrajectoryObservationBatch([makeValidObservation()])).rejects.toThrow(
      /Cannot send trajectory observations: no valid cloud credentials/i,
    );
  });
});
