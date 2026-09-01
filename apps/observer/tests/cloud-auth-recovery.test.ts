import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessSession, RawHarnessRecord } from "@resin/harness-contracts";
import { type AuthClaims, ProtocolError } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrajectoryCaptureCoordinator } from "../src/analytics/capture-coordinator.js";
import {
  AUTH_ERROR_BODY_LIMIT_BYTES,
  AuthRecoveryController,
  AuthRecoveryError,
  classifyAuthResponse,
} from "../src/auth-recovery.js";
import {
  CloudCredentialStore,
  type CloudRequestIdentity,
  isAllowedOrigin,
} from "../src/cloud-credentials.js";
import {
  CloudObservationClient,
  CloudRuntimeModule,
  type TrajectoryObservation,
} from "../src/cloud-runtime.js";
import type { DaemonConfig } from "../src/config.js";
import type { ModuleContext } from "../src/lifecycle.js";
import { NormalizationPipeline } from "../src/normalization/pipeline.js";
import type { JsonObject } from "../src/normalization/redaction.js";
import type { DaemonPaths } from "../src/paths.js";
import { SourceCursorManager } from "../src/tailing/cursor-manager.js";
import { TranscriptTailer } from "../src/tailing/tailer.js";
import { FakeSessionEventSource } from "./fake-harness.js";

function makeJwt(claims: AuthClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

function makeClaims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    accountId: "acc_recovery",
    workspaceId: "ws_recovery",
    deviceId: "dev_recovery",
    installationId: "inst_recovery",
    userId: "usr_recovery",
    actorType: "user",
    tokenType: "access",
    rawUploadConsent: false,
    scopes: ["device:connect", "observations:write"],
    issuedAt: new Date(Date.now() - 10_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeIdentity(accessToken: string): CloudRequestIdentity {
  return {
    cloudUrl: "https://cloud.resin.dev",
    accessToken,
    accountId: "acc_recovery",
    workspaceId: "ws_recovery",
    deviceId: "dev_recovery",
    installationId: "inst_recovery",
    userId: "usr_recovery",
  };
}

function makeObservation(): TrajectoryObservation {
  return {
    observationId: "obs_auth_recovery",
    accountId: "acc_recovery",
    workspaceId: "ws_recovery",
    ownerUserId: "usr_recovery",
    projectId: "prj_recovery",
    candidateId: "candidate_recovery",
    toolId: "tool_recovery",
    toolVersion: "1.0.0",
    workloadId: "workload_recovery",
    trajectoryId: "trajectory_recovery",
    provider: "anthropic",
    model: "claude-test",
    runtimeVersion: "1.0.0",
    role: "candidate",
    status: "success",
    isEquivalent: true,
    catalogExposureTokens: 0,
    usage: {
      availability: "complete",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    observedAt: "2026-08-27T10:00:00.000Z",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
}

async function seedCredentials(
  store: CloudCredentialStore,
  claims: AuthClaims,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await store.persist({
    cloudUrl: "https://cloud.resin.dev",
    accessToken,
    refreshToken,
    claims,
    deviceId: claims.deviceId,
    workspaceId: claims.workspaceId,
  });
}

function makeModuleContext(homeDir: string, stateDir: string): ModuleContext {
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

function makeCompletedSession(sessionId: string): HarnessSession {
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    workspaceId: "ws_recovery",
    harnessId: "open-code",
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    status: "completed",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

function makePromptRecord(sessionId: string, sequence = 1): RawHarnessRecord {
  const timestamp = new Date().toISOString();
  return {
    recordId: `record_auth_recovery_${sequence}`,
    sessionId,
    harnessId: "open-code",
    sequenceNumber: sequence,
    timestamp,
    recordType: "prompt",
    rawPayload: {
      role: "user",
      content: `private transcript payload ${sequence} that must never appear in auth status`,
    },
    cursor: {
      offset: sequence * 100,
      line: sequence,
      sequence,
      timestamp,
    },
    metadata: {},
  };
}

describe("cloud authentication recovery", () => {
  let tempDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-auth-recovery-"));
    tokenFilePath = path.join(tempDir, "state", "device-token.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects cloud origins containing embedded credentials", () => {
    expect(isAllowedOrigin("https://user:password@cloud.resin.dev")).toBe(false);
  });

  it("refreshes an expired access token once and retries the rejected request", async () => {
    const initialClaims = makeClaims();
    const rotatedClaims = makeClaims({ issuedAt: new Date().toISOString() });
    const initialToken = makeJwt(initialClaims);
    const rotatedToken = makeJwt(rotatedClaims);
    let refreshCalls = 0;
    let batchCalls = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/v1/auth/token/refresh")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            accessToken: rotatedToken,
            tokenType: "Bearer",
            expiresIn: 3_600,
            refreshToken: "refresh-rotated",
            claims: rotatedClaims,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      batchCalls += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      if (batchCalls === 1) {
        expect(authorization).toBe(`Bearer ${initialToken}`);
        return new Response(JSON.stringify({ error: "token_expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(authorization).toBe(`Bearer ${rotatedToken}`);
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await seedCredentials(store, initialClaims, initialToken, "refresh-initial");
    const client = new CloudObservationClient({
      credentialStore: store,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    const response = await client.sendTrajectoryObservationBatch([makeObservation()]);

    expect(response.accepted).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(batchCalls).toBe(2);
    const snapshot = client.getAuthRecoverySnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      status: "AUTHENTICATED",
      category: null,
      remediation: null,
      refreshAttempts: 1,
    });
  });

  it("refreshes a locally expired JWT before the outbound request", async () => {
    const expiredClaims = makeClaims({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const rotatedClaims = makeClaims({ issuedAt: new Date().toISOString() });
    const expiredToken = makeJwt(expiredClaims);
    const rotatedToken = makeJwt(rotatedClaims);
    let refreshCalls = 0;
    const batchAuthorizations: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/v1/auth/token/refresh")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            accessToken: rotatedToken,
            tokenType: "Bearer",
            expiresIn: 3_600,
            refreshToken: "refresh-after-expiry",
            claims: rotatedClaims,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      batchAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await seedCredentials(store, expiredClaims, expiredToken, "refresh-before-expiry");
    const client = new CloudObservationClient({
      credentialStore: store,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    const response = await client.sendTrajectoryObservationBatch([makeObservation()]);

    expect(response.accepted).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(batchAuthorizations).toEqual([`Bearer ${rotatedToken}`]);
    expect(client.getAuthRecoverySnapshot()).toMatchObject({
      status: "AUTHENTICATED",
      refreshAttempts: 1,
    });
  });

  it("does not repeat refresh for the same credentials after the retry is rejected", async () => {
    const initialClaims = makeClaims();
    const rotatedClaims = makeClaims({ issuedAt: new Date().toISOString() });
    const initialToken = makeJwt(initialClaims);
    const rotatedToken = makeJwt(rotatedClaims);
    let refreshCalls = 0;
    let batchCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/v1/auth/token/refresh")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            accessToken: rotatedToken,
            tokenType: "Bearer",
            expiresIn: 3_600,
            refreshToken: "refresh-rotated-rejected",
            claims: rotatedClaims,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      batchCalls += 1;
      return new Response(JSON.stringify({ error: "token_expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await seedCredentials(store, initialClaims, initialToken, "refresh-initial-rejected");
    const client = new CloudObservationClient({
      credentialStore: store,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(client.sendTrajectoryObservationBatch([makeObservation()])).rejects.toBeInstanceOf(
      AuthRecoveryError,
    );
    expect(refreshCalls).toBe(1);
    expect(batchCalls).toBe(2);

    await expect(client.sendTrajectoryObservationBatch([makeObservation()])).rejects.toBeInstanceOf(
      AuthRecoveryError,
    );
    expect(refreshCalls).toBe(1);
    expect(batchCalls).toBe(2);
    expect(client.getAuthRecoverySnapshot().status).toBe("DEGRADED_OFFLINE");
  });

  it("coalesces concurrent rejected requests onto one in-flight refresh", async () => {
    const initialIdentity = makeIdentity("access-stale");
    const refreshedIdentity = makeIdentity("access-refreshed");
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    const initialRequestsReady = Promise.withResolvers<void>();
    let forceRefreshCalls = 0;
    let initialRequestCount = 0;

    const identityProvider = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (!options?.forceRefresh) {
        return initialIdentity;
      }
      forceRefreshCalls += 1;
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return refreshedIdentity;
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer access-stale") {
        initialRequestCount += 1;
        if (initialRequestCount === 2) {
          initialRequestsReady.resolve();
        }
        return new Response(JSON.stringify({ error: "token_expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new CloudObservationClient({
      identityProvider,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    const sends = Promise.all([
      client.sendTrajectoryObservationBatch([makeObservation()]),
      client.sendTrajectoryObservationBatch([makeObservation()]),
    ]);
    await Promise.all([refreshStarted.promise, initialRequestsReady.promise]);

    expect(client.getAuthRecoverySnapshot()).toMatchObject({
      status: "REFRESHING",
      category: "TOKEN_EXPIRED",
      refreshAttempts: 1,
    });
    releaseRefresh.resolve();
    const results = await sends;

    expect(results).toHaveLength(2);
    expect(forceRefreshCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(client.getAuthRecoverySnapshot().status).toBe("AUTHENTICATED");
  });

  // SAFETY: Type assertion in test fixture/mock verified by test context.
  it("treats a 403 response as an auth failure and performs one refresh", async () => {
    const initialIdentity = makeIdentity("access-forbidden");
    const refreshedIdentity = makeIdentity("access-after-forbidden");
    let requestCalls = 0;
    const identityProvider = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? refreshedIdentity : initialIdentity,
    );
    const fetchMock = vi.fn(async () => {
      requestCalls += 1;
      if (requestCalls === 1) {
        return new Response(JSON.stringify({ error: "permission_denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new CloudObservationClient({
      identityProvider,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    const response = await client.sendTrajectoryObservationBatch([makeObservation()]);

    expect(response.accepted).toBe(1);
    expect(identityProvider).toHaveBeenCalledWith({ forceRefresh: true });
    expect(requestCalls).toBe(2);
  });

  it("recovers from a protocol token-expiry error without exposing it", async () => {
    const initialIdentity = makeIdentity("access-protocol-expired");
    const refreshedIdentity = makeIdentity("access-protocol-refreshed");
    let requestCalls = 0;
    const identityProvider = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? refreshedIdentity : initialIdentity,
    );
    const fetchMock = vi.fn(async () => {
      requestCalls += 1;
      if (requestCalls === 1) {
        throw new ProtocolError("token_expired", "Provider reported an expired access token");
      }
      return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new CloudObservationClient({
      identityProvider,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });

    const response = await client.sendTrajectoryObservationBatch([makeObservation()]);

    expect(response.accepted).toBe(1);
    expect(identityProvider).toHaveBeenCalledWith({ forceRefresh: true });
    expect(requestCalls).toBe(2);
    expect(client.getAuthRecoverySnapshot()).toMatchObject({
      status: "AUTHENTICATED",
      refreshAttempts: 1,
    });
  });

  it("keeps auth-pending records paused and durable across restart until login", async () => {
    const initialClaims = makeClaims();
    const initialToken = makeJwt(initialClaims);
    const reauthenticatedClaims = makeClaims({ issuedAt: new Date().toISOString() });
    const reauthenticatedToken = makeJwt(reauthenticatedClaims);
    const deliveredRecordIds: string[] = [];
    const uploadedSequences: number[] = [];
    const attemptedBatchIds: string[] = [];
    let observationRequestCalls = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/v1/auth/token/refresh")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      observationRequestCalls += 1;
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      const request = JSON.parse(String(init?.body)) as {
        batchId: string;
        observations: Array<{
          eventId: string;
          causalRef: { causalSequence: number };
        }>;
      };
      attemptedBatchIds.push(request.batchId);
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== `Bearer ${reauthenticatedToken}`) {
        return new Response(JSON.stringify({ error: "token_expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      uploadedSequences.push(
        ...request.observations.map((observation) => observation.causalRef.causalSequence),
      );
      return new Response(
        JSON.stringify({
          batchId: request.batchId,
          status: "accepted",
          acceptedCount: request.observations.length,
          rejectedCount: 0,
          errors: [],
          deadLetters: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await seedCredentials(store, initialClaims, initialToken, "refresh-revoked-sensitive");
    const runtime = new CloudRuntimeModule({
      credentialStore: store,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    const context = makeModuleContext(tempDir, path.dirname(tokenFilePath));
    await runtime.start(context);

    const cursorManager = new SourceCursorManager();
    const pendingStorageDirectory = path.join(tempDir, "auth-pending");
    const tailer = new TranscriptTailer({
      cursorManager,
      pendingStorageDirectory,
      defaultBatchSize: 1,
    });
    const normalizationPipeline = new NormalizationPipeline();
    const captureCoordinator = new TrajectoryCaptureCoordinator({
      pipeline: normalizationPipeline,
      observationClient: runtime.getObservationClient(),
    });
    const session = makeCompletedSession("session_auth_queue");
    const firstRecord = makePromptRecord(session.sessionId, 1);
    const secondRecord = makePromptRecord(session.sessionId, 2);
    const source = new FakeSessionEventSource(session.sessionId, [firstRecord]);
    const degraded = Promise.withResolvers<{ persisted: boolean }>();
    tailer.once("auth:degraded", (event: { persisted: boolean }) => degraded.resolve(event));
    tailer.onRecords(captureCoordinator.handleRecords);

    await tailer.attachSession(session, source, { maxBatchSize: 1 });
    expect(await degraded.promise).toMatchObject({ persisted: true });
    expect(runtime.getState()).toBe("ready");
    expect(runtime.getAuthRecoverySnapshot()).toMatchObject({
      status: "DEGRADED_OFFLINE",
      category: "REFRESH_REVOKED",
      remediation: "Run `resin login` to resume cloud sync.",
    });
    expect(await cursorManager.getCursor(session.sessionId)).toBeNull();

    source.appendRecords([secondRecord]);
    expect(tailer.getSessionStatus(session.sessionId)).toMatchObject({
      isPaused: true,
      isAuthDegraded: true,
      durablePendingCount: 2,
      deadLetterCount: 0,
      persistenceHealthy: true,
    });
    const health = await runtime.healthCheck();
    expect(health.status).toBe("degraded");
    const surfacedRecovery = JSON.stringify({
      health,
      snapshot: runtime.getAuthRecoverySnapshot(),
      tailer: tailer.getSessionStatus(session.sessionId),
    });
    expect(surfacedRecovery).not.toContain(initialToken);
    expect(surfacedRecovery).not.toContain("refresh-revoked-sensitive");
    expect(surfacedRecovery).not.toContain("private transcript payload");
    const pendingFiles = await fs.readdir(pendingStorageDirectory);
    expect(pendingFiles).toHaveLength(1);
    const pendingFilePath = path.join(pendingStorageDirectory, pendingFiles[0]!);
    const pendingContents = await fs.readFile(pendingFilePath, "utf8");
    if (process.platform !== "win32") {
      expect((await fs.stat(pendingFilePath)).mode & 0o777).toBe(0o600);
    }
    expect(pendingContents).not.toContain(initialToken);
    expect(pendingContents).not.toContain("refresh-revoked-sensitive");

    await tailer.close();
    await runtime.stop(context);
    expect(await fs.readFile(pendingFilePath, "utf8")).toBe(pendingContents);

    const restartedStore = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    expect((await restartedStore.load()).status).toBe("missing");
    const restartedRuntime = new CloudRuntimeModule({
      credentialStore: restartedStore,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await restartedRuntime.start(context);

    const restartedSource = new FakeSessionEventSource(session.sessionId, [
      firstRecord,
      secondRecord,
    ]);
    const restartedTailer = new TranscriptTailer({
      cursorManager,
      pendingStorageDirectory,
      defaultBatchSize: 2,
    });
    const restartedCaptureCoordinator = new TrajectoryCaptureCoordinator({
      pipeline: normalizationPipeline,
      observationClient: restartedRuntime.getObservationClient(),
    });
    const restartedDegraded = Promise.withResolvers<{ persisted: boolean }>();
    const replayed = Promise.withResolvers<void>();
    let restartedHandlerCalls = 0;
    restartedTailer.once("auth:degraded", (event: { persisted: boolean }) =>
      restartedDegraded.resolve(event),
    );
    restartedTailer.onRecords(async (handlerSession, records, ack) => {
      restartedHandlerCalls += 1;
      await restartedCaptureCoordinator.handleRecords(handlerSession, records, async () => {
        deliveredRecordIds.push(...records.map((record) => record.recordId));
        expect(deliveredRecordIds).toEqual([firstRecord.recordId, secondRecord.recordId]);
        expect(await cursorManager.getCursor(session.sessionId)).toBeNull();
        await ack();
        replayed.resolve();
      });
    });

    const outboundCallsBeforeProbe = observationRequestCalls;
    const networkCallsBeforeProbe = fetchMock.mock.calls.length;
    await restartedTailer.attachSession(session, restartedSource, { maxBatchSize: 2 });
    expect(await restartedDegraded.promise).toMatchObject({ persisted: true });

    expect(restartedHandlerCalls).toBe(1);
    expect(observationRequestCalls).toBe(outboundCallsBeforeProbe);
    expect(fetchMock.mock.calls).toHaveLength(networkCallsBeforeProbe);
    expect(await cursorManager.getCursor(session.sessionId)).toBeNull();
    expect(restartedSource.getCursor()).toBeNull();
    expect(restartedTailer.getSessionStatus(session.sessionId)).toMatchObject({
      isPaused: true,
      isAuthDegraded: true,
      durablePendingCount: 2,
      queueSize: 2,
      deadLetterCount: 0,
      latestCursor: null,
      ackedCursor: null,
      persistenceHealthy: true,
    });
    expect(restartedRuntime.getAuthRecoverySnapshot()).toMatchObject({
      status: "DEGRADED_OFFLINE",
      category: "UNAUTHORIZED",
      remediation: "Run `resin login` to resume cloud sync.",
    });
    expect(await fs.readdir(pendingStorageDirectory)).toEqual(pendingFiles);
    expect(await fs.readFile(pendingFilePath, "utf8")).toBe(pendingContents);

    await seedCredentials(
      restartedStore,
      reauthenticatedClaims,
      reauthenticatedToken,
      "refresh-after-login",
    );
    await restartedRuntime.healthCheck();
    await replayed.promise;

    expect(restartedHandlerCalls).toBe(2);
    expect(deliveredRecordIds).toEqual([firstRecord.recordId, secondRecord.recordId]);
    expect(uploadedSequences).toEqual([1, 2, 3]);
    expect(attemptedBatchIds).toHaveLength(2);
    expect(await cursorManager.getCursor(session.sessionId)).toMatchObject({ sequence: 2 });
    expect(restartedSource.getCursor()).toMatchObject({ sequence: 2 });
    expect(restartedTailer.getSessionStatus(session.sessionId)).toMatchObject({
      queueSize: 0,
      deadLetterCount: 0,
      durablePendingCount: 0,
      isAuthDegraded: false,
    });
    expect(await fs.readdir(pendingStorageDirectory)).toEqual([]);

    await restartedTailer.close();
    await restartedRuntime.stop(context);
  });

  it("automatically retries a transient refresh outage and replays without login", async () => {
    const initialClaims = makeClaims();
    const rotatedClaims = makeClaims({ issuedAt: new Date().toISOString() });
    const initialToken = makeJwt(initialClaims);
    const rotatedToken = makeJwt(rotatedClaims);
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = url.toString();
      if (requestUrl.endsWith("/v1/auth/token/refresh")) {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          throw new TypeError("temporary network outage");
        }
        return new Response(
          JSON.stringify({
            accessToken: rotatedToken,
            tokenType: "Bearer",
            expiresIn: 3_600,
            refreshToken: "refresh-after-outage",
            claims: rotatedClaims,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${rotatedToken}`) {
        return new Response(JSON.stringify({ received: 1, accepted: 1, rejected: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "token_expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = new CloudCredentialStore({
      tokenFilePath,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    await seedCredentials(store, initialClaims, initialToken, "refresh-before-outage");
    const authRecovery = new AuthRecoveryController({
      getRefreshFailure: () => store.getLastRefreshFailure(),
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 50,
    });
    const runtime = new CloudRuntimeModule({
      credentialStore: store,
      authRecoveryController: authRecovery,
      // SAFETY: Type assertion in test fixture/mock verified by test context.
      fetchImpl: fetchMock as typeof fetch,
    });
    const context = makeModuleContext(tempDir, path.dirname(tokenFilePath));
    await runtime.start(context);

    const cursorManager = new SourceCursorManager();
    const tailer = new TranscriptTailer({
      cursorManager,
      pendingStorageDirectory: path.join(tempDir, "transient-pending"),
    });
    const session = makeCompletedSession("session_transient_outage");
    const record = makePromptRecord(session.sessionId);
    const source = new FakeSessionEventSource(session.sessionId, [record]);
    const degraded = Promise.withResolvers<void>();
    const replayed = Promise.withResolvers<void>();
    tailer.once("auth:degraded", () => degraded.resolve());
    tailer.onRecords(async (_session, records, ack) => {
      await runtime.getObservationClient().sendTrajectoryObservationBatch(
        records.map((item) => ({
          ...makeObservation(),
          observationId: `obs_transient_${item.sequenceNumber}`,
        })),
      );
      await ack();
      replayed.resolve();
    });

    await tailer.attachSession(session, source, { maxBatchSize: 1 });
    await degraded.promise;
    expect(runtime.getAuthRecoverySnapshot()).toMatchObject({
      status: "DEGRADED_OFFLINE",
      category: "REFRESH_UNAVAILABLE",
    });
    expect(runtime.getAuthRecoverySnapshot().remediation).toContain("retry automatically");
    expect(await cursorManager.getCursor(session.sessionId)).toBeNull();

    await replayed.promise;
    expect(refreshCalls).toBe(2);
    expect(await cursorManager.getCursor(session.sessionId)).toMatchObject({ sequence: 1 });
    expect(tailer.getSessionStatus(session.sessionId)).toMatchObject({
      queueSize: 0,
      deadLetterCount: 0,
      durablePendingCount: 0,
      isAuthDegraded: false,
    });
    expect(runtime.getAuthRecoverySnapshot()).toMatchObject({
      status: "AUTHENTICATED",
      category: null,
      remediation: null,
    });

    await tailer.close();
    await runtime.stop(context);
  });

  it("caps and cancels streamed authentication error bodies before classification", async () => {
    let cancelled = false;
    let pulledBytes = 0;
    const chunkSize = Math.floor(AUTH_ERROR_BODY_LIMIT_BYTES / 2) + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new Uint8Array(chunkSize);
        chunk.fill(0x20);
        pulledBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

    await expect(classifyAuthResponse(response)).resolves.toBe("UNAUTHORIZED");
    expect(cancelled).toBe(true);
    expect(pulledBytes).toBeLessThanOrEqual(chunkSize * 3);
    expect(response.bodyUsed).toBe(true);
  });
});
