import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { AuthClaims } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCredentialStore, isAllowedOrigin } from "../src/cloud-credentials.js";
import { CloudObservationClient, CloudRuntimeModule } from "../src/cloud-runtime.js";
import type { DaemonConfig } from "../src/config.js";
import type { ModuleContext } from "../src/lifecycle.js";
import type { JsonObject } from "../src/normalization/redaction.js";
import type { DaemonPaths } from "../src/paths.js";

function makeJwt(payload: JsonObject): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.mock-signature`;
}

function makeValidClaims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    accountId: "acc_test123",
    workspaceId: "ws_test123",
    deviceId: "dev_test123",
    installationId: "inst_test123",
    userId: "usr_test123",
    actorType: "user",
    tokenType: "access",
    rawUploadConsent: false,
    scopes: ["device:connect", "observations:write", "catalog:read"],
    issuedAt: new Date(Date.now() - 10_000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function createMockContext(homeDir: string, stateDir: string): ModuleContext {
  const config: DaemonConfig = {
    version: "0.1.0",
    port: 3100,
    logLevel: "info",
    lockStaleThresholdMs: 30_000,
    heartbeatIntervalMs: 5_000,
    shutdownTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    healthCheckIntervalMs: 15_000,
    maxRestarts: 5,
    restartWindowMs: 60_000,
  };
  const paths: DaemonPaths = {
    homeDir,
    configDir: path.join(homeDir, "config"),
    dataDir: path.join(homeDir, "data"),
    stateDir,
    logDir: path.join(homeDir, "logs"),
    socketPath: path.join(stateDir, "daemon.sock"),
    lockFilePath: path.join(stateDir, "daemon.lock"),
    pidFilePath: path.join(stateDir, "daemon.pid"),
    tokenFilePath: path.join(stateDir, "auth.token"),
    configFile: path.join(homeDir, "config", "config.json"),
  };
  return {
    config,
    paths,
    getModule: () => undefined,
  };
}

describe("CloudCredentialStore", () => {
  let tempDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-cred-test-"));
    tokenFilePath = path.join(tempDir, "state", "device-token.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("enforces mode 0600 and atomic replacement on persist", async () => {
    const store = new CloudCredentialStore({ tokenFilePath });
    const claims = makeValidClaims();
    const token = makeJwt(claims);

    const saved = await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: token,
      refreshToken: "refresh-token-123",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    expect(saved.accessToken).toBe(token);
    expect(saved.refreshToken).toBe("refresh-token-123");

    const stat = await fs.stat(tokenFilePath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // Atomic update
    const updatedClaims = makeValidClaims({
      expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    });
    const updatedToken = makeJwt(updatedClaims);

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: updatedToken,
      refreshToken: "refresh-token-456",
      claims: updatedClaims,
      deviceId: updatedClaims.deviceId,
      workspaceId: updatedClaims.workspaceId,
    });

    const loaded = await store.load();
    expect(loaded.status).toBe("valid");
    expect(loaded.credentials?.accessToken).toBe(updatedToken);
    expect(loaded.credentials?.refreshToken).toBe("refresh-token-456");
  });

  it("handles missing credentials gracefully without throwing", async () => {
    const store = new CloudCredentialStore({ tokenFilePath });
    const result = await store.load();
    expect(result.status).toBe("missing");
    expect(result.credentials).toBeUndefined();

    const identity = await store.getRequestIdentity();
    expect(identity).toBeNull();
  });

  it("strictly validates malformed and expired claims", async () => {
    const store = new CloudCredentialStore({ tokenFilePath });

    // 1. Corrupted file content
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, "NOT_JSON", "utf8");
    const corruptedResult = await store.load();
    expect(corruptedResult.status).toBe("invalid");
    expect(corruptedResult.reason).toContain("invalid JSON");

    // 2. Missing required claims (no userId)
    const claimsNoUser = makeValidClaims();
    // SAFETY: Type assertion in test fixture/mock verified by test context.
    delete (claimsNoUser as { userId?: string }).userId;
    const credsNoUser = {
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claimsNoUser),
      claims: claimsNoUser,
      deviceId: claimsNoUser.deviceId,
      workspaceId: claimsNoUser.workspaceId,
      storedAt: new Date().toISOString(),
    };
    await fs.writeFile(tokenFilePath, JSON.stringify(credsNoUser), "utf8");
    const noUserResult = await store.load();
    expect(noUserResult.status).toBe("invalid");

    // 3. Expired claims
    const expiredClaims = makeValidClaims({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expiredCreds = {
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(expiredClaims),
      refreshToken: "valid-refresh-token",
      claims: expiredClaims,
      deviceId: expiredClaims.deviceId,
      workspaceId: expiredClaims.workspaceId,
      storedAt: new Date().toISOString(),
    };
    await fs.writeFile(tokenFilePath, JSON.stringify(expiredCreds), "utf8");
    const expiredResult = await store.load();
    expect(expiredResult.status).toBe("expired");
    expect(expiredResult.credentials?.refreshToken).toBe("valid-refresh-token");
  });

  it("validates origin allowing HTTPS and loopback HTTP only", () => {
    expect(isAllowedOrigin("https://cloud.resin.dev")).toBe(true);
    expect(isAllowedOrigin("https://api.internal.org:8443")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:9000")).toBe(true);

    // Disallowed
    expect(isAllowedOrigin("http://cloud.resin.dev")).toBe(false);
    expect(isAllowedOrigin("http://insecure-host.com")).toBe(false);
    expect(isAllowedOrigin("ftp://example.com")).toBe(false);
    expect(isAllowedOrigin("not-a-url")).toBe(false);
  });

  it("deduplicates concurrent refresh requests", async () => {
    let fetchCallCount = 0;
    const claims = makeValidClaims({
      expiresAt: new Date(Date.now() - 5000).toISOString(), // expired
    });
    const rotatedClaims = makeValidClaims({
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const rotatedAccessToken = makeJwt(rotatedClaims);

    const { promise: delayPromise, resolve: unlockFetch } = Promise.withResolvers<void>();

    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      await delayPromise;
      return new Response(
        JSON.stringify({
          accessToken: rotatedAccessToken,
          tokenType: "Bearer",
          expiresIn: 3600,
          refreshToken: "rotated-refresh-token-999",
          claims: rotatedClaims,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claims),
      refreshToken: "original-refresh-token",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // Fire 3 simultaneous getRequestIdentity requests
    const refreshTasks = Promise.all([
      store.getRequestIdentity({ forceRefresh: true }),
      store.getRequestIdentity({ forceRefresh: true }),
      store.getRequestIdentity({ forceRefresh: true }),
    ]);

    // Unlock the fetch resolver
    unlockFetch();

    const [id1, id2, id3] = await refreshTasks;

    expect(fetchCallCount).toBe(1);
    expect(id1?.accessToken).toBe(rotatedAccessToken);
    expect(id2?.accessToken).toBe(rotatedAccessToken);
    expect(id3?.accessToken).toBe(rotatedAccessToken);
    expect(id1?.workspaceId).toBe(claims.workspaceId);
  });

  it("rejects token refresh with mismatched/rebound tenant claims", async () => {
    const claims = makeValidClaims({
      accountId: "acc_original",
      workspaceId: "ws_original",
      deviceId: "dev_original",
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });

    // Server attempts to return claims bound to a different workspace
    const maliciousReboundClaims = makeValidClaims({
      accountId: "acc_original",
      workspaceId: "ws_DIFFERENT_ATTACKER",
      deviceId: "dev_original",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          accessToken: makeJwt(maliciousReboundClaims),
          tokenType: "Bearer",
          expiresIn: 3600,
          refreshToken: "new-refresh-token",
          claims: maliciousReboundClaims,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claims),
      refreshToken: "refresh-token-1",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    await expect(store.getRequestIdentity({ forceRefresh: true })).rejects.toThrow(
      /do not match original tenant\/device binding/,
    );

    // Verify credentials were deleted/purged on rebinding violation
    const loadAfter = await store.load();
    expect(loadAfter.status).toBe("missing");
  });

  it("purges credentials when refresh is rejected (401/revoked)", async () => {
    const claims = makeValidClaims({
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });

    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claims),
      refreshToken: "revoked-token",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const identity = await store.getRequestIdentity({ forceRefresh: true });
    expect(identity).toBeNull();

    const loadAfter = await store.load();
    expect(loadAfter.status).toBe("missing");
  });

  it("retains credentials during transient offline outage without purging", async () => {
    const claims = makeValidClaims({
      expiresAt: new Date(Date.now() + 600_000).toISOString(), // Not hard-expired
    });

    const mockFetch = vi.fn(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claims),
      refreshToken: "valid-refresh-token",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // Proactive refresh fails due to network outage
    const identity = await store.getRequestIdentity({ forceRefresh: true });
    // Still returns existing valid identity in offline mode
    expect(identity).not.toBeNull();
    expect(identity?.accessToken).toBe(makeJwt(claims));

    // File was NOT purged
    const loadAfter = await store.load();
    expect(loadAfter.status).toBe("valid");
  });

  it("supports snapshot and restore for installer rollback", async () => {
    const store = new CloudCredentialStore({ tokenFilePath });
    const claims = makeValidClaims();

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: makeJwt(claims),
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const snapshot = await store.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.deviceId).toBe(claims.deviceId);

    // Mutate store
    await store.purge();
    expect((await store.load()).status).toBe("missing");

    // Restore snapshot
    await store.restore(snapshot);
    const restored = await store.load();
    expect(restored.status).toBe("valid");
    expect(restored.credentials?.deviceId).toBe(claims.deviceId);

    // Restore null (purge)
    await store.restore(null);
    expect((await store.load()).status).toBe("missing");
  });

  it("restarts and reloads stored credentials idempotently", async () => {
    const claims = makeValidClaims();
    const token = makeJwt(claims);

    const store1 = new CloudCredentialStore({ tokenFilePath });
    await store1.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: token,
      refreshToken: "refresh-123",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    // New instance simulating daemon restart
    const store2 = new CloudCredentialStore({ tokenFilePath });
    const loadResult = await store2.load();
    expect(loadResult.status).toBe("valid");
    expect(loadResult.credentials?.accessToken).toBe(token);
    expect(loadResult.credentials?.deviceId).toBe(claims.deviceId);
  });
});

describe("CloudRuntimeModule & CloudObservationClient", () => {
  let tempDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-runtime-test-"));
    tokenFilePath = path.join(tempDir, "state", "device-token.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("never includes tokens or secrets in diagnostics and health check", async () => {
    const claims = makeValidClaims();
    const token = makeJwt(claims);
    const store = new CloudCredentialStore({ tokenFilePath });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: token,
      refreshToken: "super-secret-refresh-token",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const module = new CloudRuntimeModule({ credentialStore: store });
    const context = createMockContext(tempDir, path.dirname(tokenFilePath));
    await module.start(context);

    const diagnostics = await module.getDiagnostics();
    const diagnosticsStr = JSON.stringify(diagnostics);
    expect(diagnosticsStr).not.toContain(token);
    expect(diagnosticsStr).not.toContain("super-secret-refresh-token");
    expect(diagnostics.paired).toBe(true);
    expect(diagnostics.workspaceId).toBe(claims.workspaceId);

    const health = await module.healthCheck();
    const healthStr = JSON.stringify(health);
    expect(healthStr).not.toContain(token);
    expect(healthStr).not.toContain("super-secret-refresh-token");
    expect(health.status).toBe("ready");

    await module.stop(context);
  });

  it("starts in local-only mode when credentials are absent without failure", async () => {
    const store = new CloudCredentialStore({ tokenFilePath });
    const module = new CloudRuntimeModule({ credentialStore: store });
    const context = createMockContext(tempDir, path.dirname(tokenFilePath));

    await module.start(context);

    expect(module.getState()).toBe("ready");

    const health = await module.healthCheck();
    expect(health.status).toBe("ready");
    expect(health.message).toContain("local-only");
    expect(health.details?.paired).toBe(false);

    await module.stop(context);
  });

  it("sends observation batches with tenant headers and handles 401 retry", async () => {
    const claims = makeValidClaims();
    const initialToken = makeJwt(claims);
    const refreshedClaims = makeValidClaims({ issuedAt: new Date().toISOString() });
    const refreshedToken = makeJwt(refreshedClaims);

    let requestCount = 0;
    const capturedHeaders: HeadersInit[] = [];

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/auth/token/refresh")) {
        return new Response(
          JSON.stringify({
            accessToken: refreshedToken,
            tokenType: "Bearer",
            expiresIn: 3600,
            refreshToken: "rotated-refresh-token",
            claims: refreshedClaims,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/v1/observations/batch")) {
        requestCount++;
        // SAFETY: Type assertion in test fixture/mock verified by test context.
        capturedHeaders.push(init?.headers as HeadersInit);
        if (requestCount === 1) {
          // First attempt fails with 401
          return new Response(JSON.stringify({ error: "token_expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            batchId: "batch-test-1",
            status: "accepted",
            acceptedCount: 1,
            rejectedCount: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    await store.persist({
      cloudUrl: "https://cloud.resin.dev",
      accessToken: initialToken,
      refreshToken: "refresh-token-123",
      claims,
      deviceId: claims.deviceId,
      workspaceId: claims.workspaceId,
    });

    const client = new CloudObservationClient({
      credentialStore: store,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: mockFetch as typeof fetch,
    });

    const batchResponse = await client.sendObservationBatch({
      batchId: "batch-test-1",
      observations: [
        {
          eventId: "evt-test-1",
          schemaVersion: "1.0.0",
          sessionId: "sess-1",
          timestamp: new Date().toISOString(),
          causalRef: {
            causalSequence: 1,
          },
          redaction: {
            isRedacted: false,
          },
          type: "session_lifecycle",
          lifecycleType: "start",
        },
      ],
    });
    expect(batchResponse.status).toBe("accepted");
    expect(batchResponse.acceptedCount).toBe(1);
    expect(requestCount).toBe(2); // Initial attempt + 1 retry after 401

    // Check headers of the retried request
    // SAFETY: Type assertion in test fixture/mock verified by test context.
    const retryHeaders = capturedHeaders[1] as Record<string, string>;
    expect(retryHeaders.Authorization).toBe(`Bearer ${refreshedToken}`);
    expect(retryHeaders["x-account-id"]).toBe(claims.accountId);
    expect(retryHeaders["x-workspace-id"]).toBe(claims.workspaceId);
    expect(retryHeaders["x-device-id"]).toBe(claims.deviceId);
  });
});
