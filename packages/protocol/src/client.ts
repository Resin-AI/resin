import { createHash, randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type DeploymentRecord,
  type InvocationRecord,
  type NormalizedSessionEvent,
  type ToolManifest,
  hashCanonicalContent,
  normalizeSha256,
} from "@resin/contracts";
import type {
  AuthClaims,
  AuthScope,
  DeviceAuthBootstrapResponse,
  DeviceRevocationResponse,
  DeviceTokenExchangeResponse,
  TokenRotationResponse,
} from "./auth.js";
import {
  type ProtocolMessageEnvelope,
  assertEnvelopeClockSkew,
  createProtocolEnvelope,
  verifyPayloadDigest,
} from "./envelope.js";
import {
  ChecksumMismatchError,
  ClockSkewError,
  DecompressionBombError,
  DeviceRevokedError,
  ProtocolError,
  TokenExpiredError,
  ValidationError,
} from "./errors.js";
import type {
  ArtifactDownloadMetadata,
  CatalogSnapshotResponse,
  DeploymentStatusItem,
  DeploymentStatusReportResponse,
  HealthNegotiateResponse,
  InstallationRegisterResponse,
  ObservationBatchResponse,
  TelemetryBatchResponse,
  TelemetryMetric,
  WorkspaceRegisterResponse,
} from "./http.js";
import { MockProtocolServer } from "./mock.js";
import {
  ClientStreamMessagePayload,
  ExponentialBackoff,
  ReplayBuffer,
  ServerStreamMessagePayload,
  type StreamAck,
  type StreamClientHeartbeat,
  StreamDeadLetterQueue,
  type StreamDeviceStatusReport,
  type StreamInvocationMetrics,
  type StreamMessage,
  type StreamResyncRequest,
  StreamSequencer,
  createStreamMessage,
} from "./stream.js";

export interface ProtocolClientOptions {
  deviceId: string;
  installationId: string;
  workspaceId: string;
  baseUrl?: string;
  clientVersion?: string;
  protocolVersion?: string;
  maxArtifactSizeBytes?: number;
  maxClockSkewMs?: number;
  mockServer?: MockProtocolServer;
}

/**
 * ProtocolClient: Local daemon client for interacting with Cloud Control Plane.
 */
export class ProtocolClient {
  readonly deviceId: string;
  readonly installationId: string;
  readonly workspaceId: string;
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly protocolVersion: string;
  readonly maxArtifactSizeBytes: number;
  readonly maxClockSkewMs: number;

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private claims: AuthClaims | null = null;
  private sequence = 0;

  // Stream state managers
  readonly sequencer: StreamSequencer;
  readonly replayBuffer: ReplayBuffer;
  readonly deadLetterQueue: StreamDeadLetterQueue;
  readonly backoff: ExponentialBackoff;

  private mockServer: MockProtocolServer;

  constructor(options: ProtocolClientOptions) {
    this.deviceId = options.deviceId;
    this.installationId = options.installationId;
    this.workspaceId = options.workspaceId;
    this.baseUrl = options.baseUrl ?? "https://api.resin.sh";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.protocolVersion = options.protocolVersion ?? "1.0.0";
    this.maxArtifactSizeBytes = options.maxArtifactSizeBytes ?? 52428800; // 50MB
    this.maxClockSkewMs = options.maxClockSkewMs ?? 300_000; // 5 minutes

    this.mockServer = options.mockServer ?? new MockProtocolServer();
    this.sequencer = new StreamSequencer();
    this.replayBuffer = new ReplayBuffer();
    this.deadLetterQueue = new StreamDeadLetterQueue();
    this.backoff = new ExponentialBackoff();
  }

  setMockServer(server: MockProtocolServer): void {
    this.mockServer = server;
  }

  getMockServer(): MockProtocolServer {
    return this.mockServer;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getClaims(): AuthClaims | null {
    return this.claims;
  }

  setTokens(accessToken: string, refreshToken: string, claims: AuthClaims): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.claims = claims;
  }

  // --- 1. Authentication ---

  bootstrapDeviceAuth(
    options: {
      hostname?: string;
      platform?: "darwin" | "linux" | "win32" | "other";
      arch?: "arm64" | "x64" | "arm" | "ia32" | "other";
      scopes?: AuthScope[];
    } = {},
  ): DeviceAuthBootstrapResponse {
    return this.mockServer.handleDeviceAuthBootstrap({
      deviceId: this.deviceId,
      installationId: this.installationId,
      hostname: options.hostname ?? "localhost",
      platform: options.platform ?? "linux",
      arch: options.arch ?? "arm64",
      clientVersion: this.clientVersion,
      scopes: options.scopes ?? [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "deployments:read",
        "deployments:write",
        "telemetry:write",
      ],
    });
  }

  exchangeDeviceToken(deviceCode: string): DeviceTokenExchangeResponse {
    const res = this.mockServer.handleDeviceTokenExchange({
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode,
      deviceId: this.deviceId,
      installationId: this.installationId,
    });

    this.setTokens(res.accessToken, res.refreshToken, res.claims);
    return res;
  }

  rotateToken(): TokenRotationResponse {
    if (!this.refreshToken) {
      throw new ValidationError("No refresh token available to rotate");
    }

    const res = this.mockServer.handleTokenRotation({
      grantType: "refresh_token",
      refreshToken: this.refreshToken,
      deviceId: this.deviceId,
      installationId: this.installationId,
    });

    this.setTokens(res.accessToken, res.refreshToken, res.claims);
    return res;
  }

  revokeDevice(reason = "user_initiated"): DeviceRevocationResponse {
    const res = this.mockServer.handleDeviceRevocation({
      deviceId: this.deviceId,
      installationId: this.installationId,
      token: this.accessToken ?? undefined,
      tokenTypeHint: "device",
      reason,
    });

    this.accessToken = null;
    this.refreshToken = null;
    this.claims = null;
    return res;
  }

  // --- 2. Registration ---

  registerInstallation(
    harnesses: string[] = [],
    metadata?: Record<string, unknown>,
  ): InstallationRegisterResponse {
    return this.mockServer.handleInstallationRegister({
      installationId: this.installationId,
      deviceId: this.deviceId,
      appVersion: this.clientVersion,
      daemonVersion: this.clientVersion,
      harnesses,
      installedAt: new Date().toISOString(),
      metadata,
    });
  }

  registerWorkspace(
    name: string,
    rootPath: string,
    capabilityEnvelope: CapabilityEnvelope,
    activeTools: Record<string, string> = {},
  ): WorkspaceRegisterResponse {
    return this.mockServer.handleWorkspaceRegister({
      workspaceId: this.workspaceId,
      installationId: this.installationId,
      deviceId: this.deviceId,
      name,
      rootPath,
      capabilityEnvelope,
      activeTools,
    });
  }

  // --- 3. Observations Batch Ingestion ---

  sendObservationBatch(
    observations: NormalizedSessionEvent[],
    cursor?: string,
  ): {
    envelope: ProtocolMessageEnvelope<{ observations: NormalizedSessionEvent[]; cursor?: string }>;
    response: ObservationBatchResponse;
  } {
    const batchId = randomUUID();
    const payload = { observations, cursor };
    const envelope = createProtocolEnvelope({
      payloadType: "observations.batch",
      payload,
      deviceId: this.deviceId,
      installationId: this.installationId,
      workspaceId: this.workspaceId,
      sequence: this.sequence++,
      idempotencyKey: batchId,
    });

    // Verify digest before transmission
    verifyPayloadDigest(envelope);

    const response = this.mockServer.handleObservationBatch({
      batchId,
      workspaceId: this.workspaceId,
      deviceId: this.deviceId,
      installationId: this.installationId,
      cursor,
      compressed: false,
      compression: "none",
      observations,
    });

    return { envelope, response };
  }

  // --- 4. Catalog Snapshot ---

  getCatalogSnapshot(currentVersion?: string): CatalogSnapshotResponse {
    const response = this.mockServer.handleCatalogSnapshot({
      workspaceId: this.workspaceId,
      deviceId: this.deviceId,
      currentVersion,
    });

    // Verify canonical checksum
    const computedChecksum = hashCanonicalContent({
      tools: response.tools,
      activeDeployments: response.activeDeployments,
    });

    if (normalizeSha256(computedChecksum) !== normalizeSha256(response.checksum)) {
      throw new ChecksumMismatchError(response.checksum, computedChecksum);
    }

    return response;
  }

  // --- 5. Artifact Download & Verification ---

  downloadArtifact(digest: string): { bytes: Uint8Array; metadata: ArtifactDownloadMetadata } {
    const { bytes, metadata } = this.mockServer.handleArtifactDownload({
      digest,
      workspaceId: this.workspaceId,
      expectedSizeLimitBytes: this.maxArtifactSizeBytes,
    });

    // 1. Check size limit / decompression bomb protection
    if (metadata.sizeBytes > this.maxArtifactSizeBytes) {
      throw new DecompressionBombError(metadata.sizeBytes, this.maxArtifactSizeBytes);
    }

    // 2. Check byte length against metadata
    if (bytes.byteLength !== metadata.sizeBytes) {
      // If declared size mismatch
      if (metadata.compression === "none" && bytes.byteLength !== metadata.sizeBytes) {
        throw new ValidationError("Downloaded artifact byte length does not match metadata size");
      }
    }

    // 3. Verify SHA-256 digest
    const computedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (normalizeSha256(computedSha256) !== normalizeSha256(metadata.sha256)) {
      throw new ChecksumMismatchError(metadata.sha256, computedSha256);
    }

    return { bytes, metadata };
  }

  // --- 6. Deployment Status Report ---

  reportDeploymentStatus(deployments: DeploymentStatusItem[]): DeploymentStatusReportResponse {
    return this.mockServer.handleDeploymentStatusReport({
      workspaceId: this.workspaceId,
      deviceId: this.deviceId,
      deployments,
      reportedAt: new Date().toISOString(),
    });
  }

  // --- 7. Telemetry Ingestion ---

  sendTelemetryBatch(
    invocations: InvocationRecord[] = [],
    metrics: TelemetryMetric[] = [],
  ): TelemetryBatchResponse {
    const batchId = randomUUID();
    return this.mockServer.handleTelemetryBatch({
      batchId,
      deviceId: this.deviceId,
      installationId: this.installationId,
      workspaceId: this.workspaceId,
      timestamp: new Date().toISOString(),
      invocations,
      metrics,
    });
  }

  // --- 8. Health & Negotiation ---

  negotiateHealth(): HealthNegotiateResponse {
    const clientTime = new Date().toISOString();
    const res = this.mockServer.handleHealthNegotiate({
      clientVersion: this.clientVersion,
      protocolVersion: this.protocolVersion,
      capabilities: ["observations", "catalog", "deployments", "telemetry"],
      clientTime,
    });

    // Check clock skew
    const serverTimeMs = new Date(res.serverTime).getTime();
    const clientTimeMs = new Date(clientTime).getTime();
    const calculatedSkew = Math.abs(serverTimeMs - clientTimeMs);

    if (calculatedSkew > this.maxClockSkewMs) {
      throw new ClockSkewError(
        `Clock skew of ${calculatedSkew}ms exceeds maximum tolerance of ${this.maxClockSkewMs}ms`,
        res.serverTime,
        clientTime,
        calculatedSkew,
      );
    }

    return res;
  }

  // --- 9. Stream Simulation Helpers ---

  createClientHeartbeat(
    uptimeMs: number,
    activeSessions = 0,
  ): StreamMessage<StreamClientHeartbeat> {
    const seq = this.sequencer.nextOutboundSequence();
    const msg = createStreamMessage(seq, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: seq,
      uptimeMs,
      activeSessions,
    });
    this.replayBuffer.add(msg);
    return msg;
  }

  createDeviceStatusReport(
    cpuUsagePercent: number,
    memoryUsageBytes: number,
    activeWorkers: number,
    activeSessions: number,
  ): StreamMessage<StreamDeviceStatusReport> {
    const seq = this.sequencer.nextOutboundSequence();
    const msg = createStreamMessage(seq, {
      type: "client.device_status",
      deviceId: this.deviceId,
      cpuUsagePercent,
      memoryUsageBytes,
      activeWorkers,
      activeSessions,
      timestamp: new Date().toISOString(),
    });
    this.replayBuffer.add(msg);
    return msg;
  }

  createStreamAck(
    ackSequence: number,
    messageId: string,
    status: "processed" | "failed",
    error?: string,
  ): StreamMessage<StreamAck> {
    const seq = this.sequencer.nextOutboundSequence();
    const msg = createStreamMessage(seq, {
      type: "client.ack",
      ackSequence,
      messageId,
      status,
      error,
      timestamp: new Date().toISOString(),
    });
    this.replayBuffer.add(msg);
    return msg;
  }

  createResyncRequest(
    reason: "gap_detected" | "reconnect" | "server_requested" | "initial_sync",
    lastKnownServerSequence: number,
  ): StreamMessage<StreamResyncRequest> {
    const seq = this.sequencer.nextOutboundSequence();
    const msg = createStreamMessage(seq, {
      type: "client.resync_request",
      reason,
      lastKnownServerSequence,
      workspaceId: this.workspaceId,
      timestamp: new Date().toISOString(),
    });
    this.replayBuffer.add(msg);
    return msg;
  }

  createInvocationMetrics(
    toolId: string,
    deploymentId: string,
    durationMs: number,
    success: boolean,
    errorCode?: string,
  ): StreamMessage<StreamInvocationMetrics> {
    const seq = this.sequencer.nextOutboundSequence();
    const msg = createStreamMessage(seq, {
      type: "client.invocation_metrics",
      toolId,
      deploymentId,
      durationMs,
      success,
      errorCode,
      timestamp: new Date().toISOString(),
    });
    this.replayBuffer.add(msg);
    return msg;
  }
}
