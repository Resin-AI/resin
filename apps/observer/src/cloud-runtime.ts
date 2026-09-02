import { randomUUID } from "node:crypto";
import {
  ISOTimestampSchema,
  IdentifierSchema,
  type InvocationRecord,
  type NormalizedSessionEvent,
  Sha256DigestSchema,
} from "@resin/contracts";
import type { AuditRepository } from "@resin/db";
import {
  type ArtifactDownloadOptions,
  type DownloadedArtifact,
  type JobExecutionResult,
  type JobPollOptions,
  type JobStatusResponse,
  type ObservationBatchRequest,
  ObservationBatchRequestSchema,
  type ObservationBatchResponse,
  ObservationBatchResponseSchema,
  PROTOCOL_VERSION,
  ProtocolError,
  type ProtocolErrorDetailRecord,
  type ProtocolErrorDetailValue,
  RateLimitedError,
  type TelemetryBatchRequest,
  TelemetryBatchRequestSchema,
  type TelemetryBatchResponse,
  TelemetryBatchResponseSchema,
  type TelemetryMetric,
} from "@resin/protocol";
import { z } from "zod";
import {
  AUTH_RECOVERY_REMEDIATION,
  type AuthRecoveryCategory,
  AuthRecoveryController,
  type AuthRecoverySnapshot,
  classifyAuthError,
  classifyAuthResponse,
} from "./auth-recovery.js";
import {
  type CloudCredentialLoadResult,
  CloudCredentialStore,
  type CloudRequestIdentity,
} from "./cloud-credentials.js";
import type { JsonObject } from "./normalization/redaction.js";

const ProtocolErrorDetailValueSchema: z.ZodType<ProtocolErrorDetailValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.record(ProtocolErrorDetailValueSchema),
    z.array(ProtocolErrorDetailValueSchema),
  ]),
);

const ProtocolErrorDetailRecordSchema: z.ZodType<ProtocolErrorDetailRecord> = z.record(
  ProtocolErrorDetailValueSchema,
);
export {
  AUTH_RECOVERY_REMEDIATION,
  AuthRecoveryController,
  classifyAuthResponse,
  classifyAuthError,
};
export type { AuthRecoveryCategory, AuthRecoverySnapshot };
export {
  AuthRecoveryError,
  type AuthRecoveryControllerOptions,
  type AuthRecoveryStatus,
} from "./auth-recovery.js";
import { InvocationTelemetryUploader } from "./analytics/invocation-telemetry-uploader.js";
import { CloudJobClient, parseRetryAfterHeader } from "./cloud-job-client.js";
import type { DaemonConfig } from "./config.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";

export interface SendObservationBatchInput {
  batchId: string;
  observations: NormalizedSessionEvent[];
  cursor?: string;
  compressed?: boolean;
  compression?: "none" | "gzip" | "zstd" | "deflate";
  workspaceId?: string;
  deviceId?: string;
  installationId?: string;
}

/**
 * Provider-reported usage availability status.
 * - complete: provider returned all required usage fields (totalTokens mandatory).
 * - partial: provider returned some usage fields, but some were missing or null.
 * - unavailable: provider does not report token accounting; usage is never inferred.
 */
export const ProviderUsageAvailabilitySchema = z.enum(["complete", "partial", "unavailable"]);
export type ProviderUsageAvailability = z.infer<typeof ProviderUsageAvailabilitySchema>;

/**
 * Provider-reported usage metrics for a single model execution.
 * Explicit input/output/reasoning/cache components are recorded.
 * Unsupported provider fields remain null/undefined and are NEVER synthesized or inferred.
 */
export const TrajectoryUsageSchema = z
  .object({
    availability: ProviderUsageAvailabilitySchema,
    inputTokens: z.number().int().nonnegative().nullish(),
    outputTokens: z.number().int().nonnegative().nullish(),
    reasoningTokens: z.number().int().nonnegative().nullish(),
    cachedInputTokens: z.number().int().nonnegative().nullish(),
    totalTokens: z.number().int().nonnegative().nullish(),
    costMicroUsd: z.number().int().nonnegative().nullish(),
    durationMs: z.number().int().nonnegative().nullish(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.availability === "complete") {
      if (val.totalTokens === undefined || val.totalTokens === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Complete provider usage requires totalTokens to be present",
          path: ["totalTokens"],
        });
      }
    }
  });
export type TrajectoryUsage = z.infer<typeof TrajectoryUsageSchema>;

export const TrajectoryRoleSchema = z.enum(["baseline", "candidate"]);
export type TrajectoryRole = z.infer<typeof TrajectoryRoleSchema>;

export const TrajectoryStatusSchema = z.enum(["success", "failure", "timeout", "error"]);
export type TrajectoryStatus = z.infer<typeof TrajectoryStatusSchema>;

/**
 * Trajectory Observation Schema.
 * Captures structured provider-reported model usage at the outer agent trajectory boundary.
 */
export const TrajectoryObservationSchema = z
  .object({
    observationId: IdentifierSchema,
    accountId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    ownerUserId: IdentifierSchema,
    projectId: IdentifierSchema,
    candidateId: IdentifierSchema,
    toolId: IdentifierSchema,
    toolVersion: z.string().min(1),
    workloadId: z.string().min(1),
    trajectoryId: z.string().min(1),
    parentTrajectoryId: z.string().min(1).nullish(),
    provider: z.string().min(1),
    model: z.string().min(1),
    runtimeVersion: z.string().min(1),
    role: TrajectoryRoleSchema,
    status: TrajectoryStatusSchema,
    isEquivalent: z.boolean(),
    catalogExposureTokens: z.number().int().nonnegative().default(0),
    usage: TrajectoryUsageSchema,
    canonicalPayload: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    observedAt: ISOTimestampSchema,
    digest: Sha256DigestSchema,
    createdAt: ISOTimestampSchema.optional(),
  })
  .strict();
export type TrajectoryObservation = z.infer<typeof TrajectoryObservationSchema>;

/**
 * Ingestion batch for trajectory observations.
 */
export const TrajectoryObservationBatchRequestSchema = z
  .object({
    observations: z.array(TrajectoryObservationSchema).min(1).max(1000),
  })
  .strict();
export type TrajectoryObservationBatchRequest = z.infer<
  typeof TrajectoryObservationBatchRequestSchema
>;

export const TrajectoryObservationBatchResponseSchema = z
  .object({
    received: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    errors: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          reason: z.string(),
        }),
      )
      .optional(),
  })
  .strict();
export type TrajectoryObservationBatchResponse = z.infer<
  typeof TrajectoryObservationBatchResponseSchema
>;

export type SendTrajectoryObservationBatchInput =
  | TrajectoryObservationBatchRequest
  | { observations: TrajectoryObservation[] }
  | TrajectoryObservation[];

export interface SendTelemetryBatchInput {
  workspaceId: string;
  invocations: InvocationRecord[];
  metrics?: TelemetryMetric[];
  deviceId?: string;
  installationId?: string;
}

export interface CloudObservationClientOptions {
  credentialStore?: CloudCredentialStore;
  identityProvider?: (options?: { forceRefresh?: boolean }) => Promise<CloudRequestIdentity | null>;
  authRecoveryController?: AuthRecoveryController;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Production observation client that sends batches of normalized session events
 * to /v1/observations/batch using validated tenant credentials.
 * Raw transcripts are never accepted or transmitted.
 */
export class CloudObservationClient {
  private readonly identityProvider: (options?: {
    forceRefresh?: boolean;
  }) => Promise<CloudRequestIdentity | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly jobClient: CloudJobClient;
  private readonly authRecovery: AuthRecoveryController;
  private readonly credentialStore?: CloudCredentialStore;

  constructor(options: CloudObservationClientOptions = {}) {
    const credentialStore =
      options.credentialStore ??
      (options.identityProvider ? undefined : new CloudCredentialStore());
    this.credentialStore = options.identityProvider ? undefined : credentialStore;
    if (options.identityProvider) {
      this.identityProvider = options.identityProvider;
    } else if (credentialStore) {
      this.identityProvider = (opts) => credentialStore.getRequestIdentity(opts);
    } else {
      throw new Error("Cloud observation client requires an identity provider");
    }

    const recoveryCredentialStore = this.credentialStore;
    this.authRecovery =
      options.authRecoveryController ??
      new AuthRecoveryController(
        recoveryCredentialStore
          ? { getRefreshFailure: () => recoveryCredentialStore.getLastRefreshFailure() }
          : {},
      );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.jobClient = new CloudJobClient({
      credentialStore,
      identityProvider: this.identityProvider,
      fetchImpl: this.fetchImpl,
      baseUrl: options.baseUrl,
    });
  }

  getJobClient(): CloudJobClient {
    return this.jobClient;
  }

  getAuthRecoverySnapshot(): AuthRecoverySnapshot {
    return this.authRecovery.getSnapshot();
  }

  dispose(): void {
    this.authRecovery.dispose();
  }

  synchronizeCredentialState(loadResult: CloudCredentialLoadResult): void {
    if (loadResult.status === "valid") {
      const credentials = loadResult.credentials;
      if (credentials && this.authRecovery.getSnapshot().status !== "REFRESHING") {
        this.authRecovery.acceptIdentity(credentials);
      }
    } else if (loadResult.status === "offline") {
      this.authRecovery.setDegraded("REFRESH_UNAVAILABLE");
    } else if (loadResult.status === "revoked") {
      this.authRecovery.setDegraded("REFRESH_REVOKED");
    } else {
      this.authRecovery.setUnauthenticated();
    }
  }

  async refreshAuthentication(): Promise<boolean> {
    let currentIdentity: { accessToken: string } | undefined;
    if (this.credentialStore) {
      const credentialState = await this.credentialStore.load();
      if (credentialState.credentials) {
        currentIdentity = { accessToken: credentialState.credentials.accessToken };
      }
    }

    const identity = await this.authRecovery.recover("TOKEN_EXPIRED", currentIdentity, () =>
      this.identityProvider({ forceRefresh: true }),
    );
    return identity !== null;
  }

  private async requireIdentity(
    purpose: "observations" | "trajectory observations" | "telemetry",
  ): Promise<CloudRequestIdentity> {
    if (this.credentialStore) {
      const credentialState = await this.credentialStore.load();
      const credentials = credentialState.credentials;
      if (
        credentials &&
        this.authRecovery.getSnapshot().status === "DEGRADED_OFFLINE" &&
        !this.authRecovery.acceptIdentity(credentials)
      ) {
        throw this.authRecovery.createError();
      }
      const expiresAtMs = credentials
        ? new Date(credentials.claims.expiresAt).getTime()
        : Number.POSITIVE_INFINITY;
      const shouldRefresh =
        credentialState.status === "expired" ||
        (credentialState.status === "valid" &&
          Boolean(credentials?.refreshToken) &&
          Date.now() >= expiresAtMs - 60_000);
      if (shouldRefresh) {
        const refreshedIdentity = await this.authRecovery.recover(
          "TOKEN_EXPIRED",
          credentials ? { accessToken: credentials.accessToken } : undefined,
          () => this.identityProvider({ forceRefresh: true }),
        );
        if (refreshedIdentity) {
          return refreshedIdentity;
        }
        throw this.authRecovery.createError();
      }
    }

    const identity = await this.identityProvider();
    if (identity) {
      if (!this.authRecovery.acceptIdentity(identity)) {
        throw this.authRecovery.createError();
      }
      return identity;
    }

    const snapshot = this.authRecovery.getSnapshot();
    if (snapshot.status === "DEGRADED_OFFLINE") {
      throw this.authRecovery.createError();
    }

    this.authRecovery.setDegraded("UNAUTHORIZED");
    throw this.authRecovery.createError("UNAUTHORIZED", {
      status: 401,
      message:
        `Cannot send ${purpose}: no valid cloud credentials or identity available. ` +
        `Observations remain queued locally. ${AUTH_RECOVERY_REMEDIATION}`,
    });
  }

  private async recoverFromAuthResponse(
    response: Response,
    rejectedIdentity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<CloudRequestIdentity | null> {
    const category = await classifyAuthResponse(response);
    if (!category) {
      this.authRecovery.setAuthenticated();
      return null;
    }
    return this.recoverAfterAuthFailure(category, response.status, rejectedIdentity, isRetry);
  }

  private async recoverFromAuthError<E>(
    error: E,
    rejectedIdentity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<CloudRequestIdentity | null> {
    const category = classifyAuthError(error);
    if (!category) {
      return null;
    }

    let status = category === "FORBIDDEN" ? 403 : 401;
    if (error instanceof ProtocolError) {
      status = error.status;
    } else {
      const parsedStatus = z.object({ status: z.number() }).safeParse(error);
      if (parsedStatus.success) {
        status = parsedStatus.data.status;
      }
    }
    return this.recoverAfterAuthFailure(category, status, rejectedIdentity, isRetry);
  }

  private async recoverAfterAuthFailure(
    category: AuthRecoveryCategory,
    status: number,
    rejectedIdentity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<CloudRequestIdentity> {
    if (isRetry) {
      this.authRecovery.setDegraded(category, rejectedIdentity);
      throw this.authRecovery.createError(category, {
        status,
        afterRefresh: true,
      });
    }

    const refreshedIdentity = await this.authRecovery.recover(category, rejectedIdentity, () =>
      this.identityProvider({ forceRefresh: true }),
    );
    if (!refreshedIdentity) {
      const degradedCategory = this.authRecovery.getSnapshot().category ?? category;
      throw this.authRecovery.createError(degradedCategory, { status });
    }
    return refreshedIdentity;
  }

  /**
   * Transmits a validated batch of normalized events to the paired Resin Cloud origin.
   */
  async sendObservationBatch(
    input: ObservationBatchRequest | SendObservationBatchInput,
  ): Promise<ObservationBatchResponse> {
    const identity = await this.requireIdentity("observations");
    return this.executeSendBatch(input, identity, false);
  }

  private async executeSendBatch(
    input: ObservationBatchRequest | SendObservationBatchInput,
    identity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<ObservationBatchResponse> {
    const workspaceId = input.workspaceId ?? identity.workspaceId;
    const deviceId = input.deviceId ?? identity.deviceId;
    const installationId = input.installationId ?? identity.installationId;

    const requestPayload: ObservationBatchRequest = {
      batchId: input.batchId,
      workspaceId,
      deviceId,
      installationId,
      cursor: input.cursor,
      compressed: input.compressed ?? false,
      compression: input.compression ?? "none",
      observations: input.observations,
    };

    // Strictly validate against the wire schema before sending
    ObservationBatchRequestSchema.parse(requestPayload);

    const endpoint = `${identity.cloudUrl.replace(/\/+$/, "")}/v1/observations/batch`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.accessToken}`,
          "x-account-id": identity.accountId,
          "x-workspace-id": identity.workspaceId,
          "x-device-id": identity.deviceId,
          "x-installation-id": identity.installationId,
          "x-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      const refreshedIdentity = await this.recoverFromAuthError(error, identity, isRetry);
      if (refreshedIdentity) {
        return this.executeSendBatch(input, refreshedIdentity, true);
      }
      throw new ProtocolError(
        "retryable",
        "Failed to transmit observation batch: cloud origin unreachable",
      );
    }

    const refreshedIdentity = await this.recoverFromAuthResponse(response, identity, isRetry);
    if (refreshedIdentity) {
      return this.executeSendBatch(input, refreshedIdentity, true);
    }

    if (!response.ok) {
      throw new ProtocolError(
        response.status >= 500 ? "retryable" : "validation",
        `Observation batch request failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      throw new ProtocolError("validation", "Failed to parse observation response JSON");
    }

    return ObservationBatchResponseSchema.parse(responseJson);
  }

  /**
   * Transmits a validated batch of trajectory observations to the paired Resin Cloud origin
   * at /v1/analytics/trajectories/batch.
   *
   * Enforces strict request schema locally so raw/unknown fields fail closed.
   */
  async sendTrajectoryObservationBatch(
    input: SendTrajectoryObservationBatchInput,
  ): Promise<TrajectoryObservationBatchResponse> {
    const identity = await this.requireIdentity("trajectory observations");
    return this.executeSendTrajectoryBatch(input, identity, false);
  }

  private async executeSendTrajectoryBatch(
    input: SendTrajectoryObservationBatchInput,
    identity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<TrajectoryObservationBatchResponse> {
    const rawPayload = Array.isArray(input) ? { observations: input } : input;

    // Strictly validate against the wire schema before sending (fails closed on unknown fields)
    const requestPayload = TrajectoryObservationBatchRequestSchema.parse(rawPayload);

    const endpoint = `${identity.cloudUrl.replace(/\/+$/, "")}/v1/analytics/trajectories/batch`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.accessToken}`,
          "x-account-id": identity.accountId,
          "x-workspace-id": identity.workspaceId,
          "x-device-id": identity.deviceId,
          "x-installation-id": identity.installationId,
          "x-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      const refreshedIdentity = await this.recoverFromAuthError(error, identity, isRetry);
      if (refreshedIdentity) {
        return this.executeSendTrajectoryBatch(input, refreshedIdentity, true);
      }
      throw new ProtocolError(
        "retryable",
        "Failed to transmit trajectory observation batch: cloud origin unreachable",
      );
    }

    const refreshedIdentity = await this.recoverFromAuthResponse(response, identity, isRetry);
    if (refreshedIdentity) {
      return this.executeSendTrajectoryBatch(input, refreshedIdentity, true);
    }

    // Handle 429 Rate Limited with Retry-After header parsing
    if (response.status === 429) {
      const retryAfterHeader =
        response.headers.get("retry-after") ?? response.headers.get("Retry-After");
      const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
      throw new RateLimitedError("Trajectory observation batch rate limited (429)", {
        retryAfterMs,
      });
    }

    if (!response.ok) {
      throw new ProtocolError(
        response.status >= 500 ? "retryable" : "validation",
        `Trajectory observation batch request failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      throw new ProtocolError("validation", "Failed to parse trajectory observation response JSON");
    }

    return TrajectoryObservationBatchResponseSchema.parse(responseJson);
  }

  /**
   * Transmits a validated batch of invocation records and performance telemetry
   * to the paired Resin Cloud origin at /v1/telemetry/batch.
   */
  async sendTelemetryBatch(input: SendTelemetryBatchInput): Promise<TelemetryBatchResponse> {
    const identity = await this.requireIdentity("telemetry");
    return this.executeSendTelemetryBatch(input, identity, false);
  }

  private async executeSendTelemetryBatch(
    input: SendTelemetryBatchInput,
    identity: CloudRequestIdentity,
    isRetry: boolean,
  ): Promise<TelemetryBatchResponse> {
    const workspaceId = input.workspaceId ?? identity.workspaceId;
    const deviceId = input.deviceId ?? identity.deviceId;
    const installationId = input.installationId ?? identity.installationId;
    const batchId = `tb_${randomUUID()}`;
    const timestamp = new Date().toISOString();

    const requestPayload: TelemetryBatchRequest = {
      batchId,
      deviceId,
      installationId,
      workspaceId,
      timestamp,
      invocations: input.invocations,
      metrics: input.metrics ?? [],
    };

    // Strictly validate against wire schema before sending
    TelemetryBatchRequestSchema.parse(requestPayload);

    const endpoint = `${identity.cloudUrl.replace(/\/+$/, "")}/v1/telemetry/batch`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.accessToken}`,
          "x-account-id": identity.accountId,
          "x-workspace-id": identity.workspaceId,
          "x-device-id": identity.deviceId,
          "x-installation-id": identity.installationId,
          "x-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      const refreshedIdentity = await this.recoverFromAuthError(error, identity, isRetry);
      if (refreshedIdentity) {
        return this.executeSendTelemetryBatch(input, refreshedIdentity, true);
      }
      throw new ProtocolError(
        "retryable",
        "Failed to transmit telemetry batch: cloud origin unreachable",
      );
    }

    const refreshedIdentity = await this.recoverFromAuthResponse(response, identity, isRetry);
    if (refreshedIdentity) {
      return this.executeSendTelemetryBatch(input, refreshedIdentity, true);
    }

    if (!response.ok) {
      throw new ProtocolError(
        response.status >= 500 ? "retryable" : "validation",
        `Telemetry batch request failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      throw new ProtocolError("validation", "Failed to parse telemetry response JSON");
    }

    return TelemetryBatchResponseSchema.parse(responseJson);
  }

  /**
   * Dispatches an observation batch and, if an async job is returned (jobId / statusUrl),
   * polls the job to completion and downloads verified result/tool artifacts.
   *
   * Invariant: Never executes or activates downloaded tool bytes and never persists presigned URLs.
   */
  async sendBatchAndFetchResult(
    input: SendObservationBatchInput,
    options: {
      pollOptions?: JobPollOptions;
      downloadOptions?: ArtifactDownloadOptions;
    } = {},
  ): Promise<JobExecutionResult> {
    const batchResponse = await this.sendObservationBatch(input);

    const targetUrlOrJobId = batchResponse.statusUrl ?? batchResponse.jobId;
    if (!targetUrlOrJobId) {
      return {
        jobId: batchResponse.batchId,
        status: batchResponse.status === "rejected" ? "failed" : "completed",
        statusResponse: {
          jobId: batchResponse.batchId,
          status: batchResponse.status === "rejected" ? "failed" : "completed",
          details: {
            acceptedCount: batchResponse.acceptedCount,
            rejectedCount: batchResponse.rejectedCount,
          },
        },
        metadata: { batchResponse },
      };
    }

    const statusResponse = await this.jobClient.pollJob(targetUrlOrJobId, options.pollOptions);
    const { resultArtifact, toolArtifact } = await this.jobClient.fetchJobArtifacts(
      statusResponse,
      options.downloadOptions,
    );

    return {
      jobId: statusResponse.jobId,
      status: statusResponse.status,
      statusResponse,
      resultBytes: resultArtifact?.bytes,
      resultSha256: resultArtifact?.sha256,
      toolBytes: toolArtifact?.bytes,
      toolSha256: toolArtifact?.sha256,
      toolDescriptor: statusResponse.tool,
      metadata: statusResponse.result?.metadata
        ? ProtocolErrorDetailRecordSchema.safeParse(statusResponse.result.metadata).data
        : undefined,
    };
  }

  async getJobStatus(statusUrlOrJobId: string, signal?: AbortSignal): Promise<JobStatusResponse> {
    return this.jobClient.getJobStatus(statusUrlOrJobId, signal);
  }

  async pollJob(statusUrlOrJobId: string, options?: JobPollOptions): Promise<JobStatusResponse> {
    return this.jobClient.pollJob(statusUrlOrJobId, options);
  }

  async downloadArtifact(
    downloadUrl: string,
    options?: ArtifactDownloadOptions,
  ): Promise<DownloadedArtifact> {
    return this.jobClient.downloadArtifact(downloadUrl, options);
  }
}

export interface CloudRuntimeModuleOptions {
  credentialStore?: CloudCredentialStore;
  authRecoveryController?: AuthRecoveryController;
  fetchImpl?: typeof fetch;
  auditRepository?: AuditRepository;
  telemetryUploader?: InvocationTelemetryUploader;
  logger?: Logger;
}

/**
 * Credential-driven daemon module managing cloud identity, background refresh,
 * health status, and production observation transport.
 * Absent or expired credentials never prevent local daemon startup.
 */
export class CloudRuntimeModule implements DaemonModule {
  readonly id = "cloud-runtime";
  readonly name = "Cloud Runtime & Observation Service";
  readonly critical = false; // Never block local daemon bootstrap

  private state: ModuleLifecycleState = "uninitialized";
  private readonly credentialStore: CloudCredentialStore;
  private readonly observationClient: CloudObservationClient;
  private readonly telemetryUploader?: InvocationTelemetryUploader;
  private refreshTimer: NodeJS.Timeout | null = null;
  private logger?: Logger;
  private lastLoadResult: CloudCredentialLoadResult = { status: "missing" };

  constructor(options: CloudRuntimeModuleOptions = {}) {
    this.credentialStore = options.credentialStore ?? new CloudCredentialStore();
    this.observationClient = new CloudObservationClient({
      credentialStore: this.credentialStore,
      authRecoveryController: options.authRecoveryController,
      fetchImpl: options.fetchImpl,
    });
    this.logger = options.logger;
    if (options.telemetryUploader) {
      this.telemetryUploader = options.telemetryUploader;
    } else if (options.auditRepository) {
      this.telemetryUploader = new InvocationTelemetryUploader({
        auditRepository: options.auditRepository,
        cloudClient: this.observationClient,
        logger: {
          debug: (msg, meta) => this.logger?.debug(msg, meta),
          info: (msg, meta) => this.logger?.info(msg, meta),
          warn: (msg, meta) => this.logger?.warn(msg, meta),
          error: (msg, meta) => this.logger?.error(msg, meta),
        },
      });
    }
  }

  getCredentialStore(): CloudCredentialStore {
    return this.credentialStore;
  }

  getObservationClient(): CloudObservationClient {
    return this.observationClient;
  }

  getJobClient(): CloudJobClient {
    return this.observationClient.getJobClient();
  }

  getAuthRecoverySnapshot(): AuthRecoverySnapshot {
    return this.observationClient.getAuthRecoverySnapshot();
  }

  getTelemetryUploader(): InvocationTelemetryUploader | undefined {
    return this.telemetryUploader;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.logger = context.logger;

    await this.refreshCredentialsState();
    this.scheduleProactiveRefresh();

    if (this.lastLoadResult.status === "valid") {
      this.telemetryUploader?.start();
    }

    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.telemetryUploader?.stop();
    this.observationClient.dispose();
    this.state = "stopped";
  }
  async reloadConfig(_newConfig: DaemonConfig): Promise<void> {
    await this.refreshCredentialsState();
    this.scheduleProactiveRefresh();
  }

  async healthCheck(): Promise<ModuleHealth> {
    await this.refreshCredentialsState(false);
    const status = this.lastLoadResult.status;
    const credentials = this.lastLoadResult.credentials;
    const authRecovery = this.getAuthRecoverySnapshot();

    if (authRecovery.status === "DEGRADED_OFFLINE") {
      return {
        status: "degraded",
        message: `Resin Cloud authentication degraded. ${authRecovery.remediation ?? AUTH_RECOVERY_REMEDIATION}`,
        details: {
          credentialStatus: status,
          authRecovery,
        },
        lastCheckTime: Date.now(),
      };
    }

    if (status === "valid" && credentials) {
      return {
        status: "ready",
        message: `Paired and authenticated with Resin Cloud (${credentials.cloudUrl})`,
        details: {
          paired: true,
          status: "valid",
          cloudUrl: credentials.cloudUrl,
          workspaceId: credentials.workspaceId,
          deviceId: credentials.deviceId,
          expiresAt: credentials.claims.expiresAt,
          authRecovery,
        },
        lastCheckTime: Date.now(),
      };
    }

    if (status === "missing") {
      return {
        status: "ready",
        message: "Running in local-only mode (unpaired)",
        details: {
          paired: false,
          status: "missing",
          cloudUrl: null,
          authRecovery,
        },
        lastCheckTime: Date.now(),
      };
    }

    if (status === "expired") {
      return {
        status: "degraded",
        message: `Cloud access token expired. ${AUTH_RECOVERY_REMEDIATION}`,
        details: {
          paired: true,
          status: "expired",
          cloudUrl: credentials?.cloudUrl ?? null,
          authRecovery,
        },
        lastCheckTime: Date.now(),
      };
    }

    if (status === "offline") {
      return {
        status: "offline",
        message: "Resin Cloud origin is unreachable (offline mode)",
        details: {
          paired: true,
          status: "offline",
          cloudUrl: credentials?.cloudUrl ?? null,
          authRecovery,
        },
        lastCheckTime: Date.now(),
      };
    }

    return {
      status: "degraded",
      message: `Cloud credentials are invalid. ${AUTH_RECOVERY_REMEDIATION}`,
      details: {
        paired: false,
        status: "invalid",
        reason: "Credential validation failed",
        authRecovery,
      },
      lastCheckTime: Date.now(),
    };
  }

  async getDiagnostics(): Promise<JsonObject> {
    const credentials = this.lastLoadResult.credentials;
    return {
      paired: this.lastLoadResult.status === "valid",
      status: this.lastLoadResult.status,
      cloudUrl: credentials?.cloudUrl ?? null,
      workspaceId: credentials?.workspaceId ?? null,
      deviceId: credentials?.deviceId ?? null,
      accountId: credentials?.claims.accountId ?? null,
      expiresAt: credentials?.claims.expiresAt ?? null,
      storedAt: credentials?.storedAt ?? null,
      authRecovery: this.getAuthRecoverySnapshot(),
    };
  }

  private async refreshCredentialsState(emitLogs = true): Promise<void> {
    try {
      this.lastLoadResult = await this.credentialStore.load();
      this.observationClient.synchronizeCredentialState(this.lastLoadResult);
      if (!emitLogs) {
        return;
      }

      if (this.lastLoadResult.status === "valid") {
        if (this.state === "ready" || this.state === "starting") {
          this.telemetryUploader?.start();
        }
        if (emitLogs) {
          this.logger?.info("Cloud credentials loaded successfully", {
            cloudUrl: this.lastLoadResult.credentials?.cloudUrl,
            workspaceId: this.lastLoadResult.credentials?.workspaceId,
          });
        }
      } else {
        this.telemetryUploader?.stop();
        if (!emitLogs) {
          return;
        }
        if (this.lastLoadResult.status === "missing") {
          this.logger?.info("No cloud credentials found; operating in local-only mode");
        } else {
          this.logger?.warn("Cloud credentials in non-ready state", {
            status: this.lastLoadResult.status,
          });
        }
      }
    } catch {
      this.telemetryUploader?.stop();
      this.lastLoadResult = {
        status: "invalid",
        reason: "Credential state could not be loaded",
      };
      this.observationClient.synchronizeCredentialState(this.lastLoadResult);
      if (emitLogs) {
        this.logger?.warn("Cloud credential state could not be loaded");
      }
    }
  }
  private scheduleProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.lastLoadResult.status !== "valid" || !this.lastLoadResult.credentials?.refreshToken) {
      return;
    }

    const expiresAtMs = new Date(this.lastLoadResult.credentials.claims.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs)) {
      return;
    }

    const refreshInMs = Math.max(10_000, expiresAtMs - Date.now() - 120_000);
    this.refreshTimer = setTimeout(async () => {
      try {
        const refreshed = await this.observationClient.refreshAuthentication();
        await this.refreshCredentialsState();
        if (!refreshed) {
          const recovery = this.getAuthRecoverySnapshot();
          this.logger?.warn(
            `Resin Cloud authentication degraded. ${recovery.remediation ?? AUTH_RECOVERY_REMEDIATION}`,
          );
          if (recovery.category === "REFRESH_UNAVAILABLE") {
            this.scheduleProactiveRefresh();
          }
          return;
        }
        this.scheduleProactiveRefresh();
      } catch {
        const recovery = this.getAuthRecoverySnapshot();
        this.logger?.warn(
          `Resin Cloud authentication degraded. ${recovery.remediation ?? AUTH_RECOVERY_REMEDIATION}`,
        );
        if (recovery.category === "REFRESH_UNAVAILABLE") {
          this.scheduleProactiveRefresh();
        }
      }
    }, refreshInMs);

    this.refreshTimer.unref();
  }
}

export function createCloudRuntimeModule(options?: CloudRuntimeModuleOptions): CloudRuntimeModule {
  return new CloudRuntimeModule(options);
}
