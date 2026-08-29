import { createHash, randomUUID } from "node:crypto";
import {
  type CapabilityEnvelope,
  type DeploymentRecord,
  type NormalizedSessionEvent,
  type ToolManifest,
  hashCanonicalContent,
} from "@resin/contracts";
import type {
  AuthClaims,
  DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapResponse,
  DeviceRevocationRequest,
  DeviceRevocationResponse,
  DeviceTokenExchangeRequest,
  DeviceTokenExchangeResponse,
  TokenRotationRequest,
  TokenRotationResponse,
} from "./auth.js";
import {
  type CreateProtocolEnvelopeOptions,
  type ProtocolMessageEnvelope,
  createProtocolEnvelope,
} from "./envelope.js";
import {
  ChecksumMismatchError,
  ClockSkewError,
  DecompressionBombError,
  DeviceRevokedError,
  type ProtocolErrorCode,
  ProtocolErrorResponse,
  RateLimitedError,
  RetryableError,
  TokenExpiredError,
  UpgradeRequiredError,
  ValidationError,
} from "./errors.js";
import type {
  ArtifactDownloadMetadata,
  ArtifactDownloadRequest,
  CatalogSnapshotRequest,
  CatalogSnapshotResponse,
  DeploymentStatusItem,
  DeploymentStatusReportRequest,
  DeploymentStatusReportResponse,
  HealthNegotiateRequest,
  HealthNegotiateResponse,
  InstallationRegisterRequest,
  InstallationRegisterResponse,
  ObservationBatchRequest,
  ObservationBatchResponse,
  TelemetryBatchRequest,
  TelemetryBatchResponse,
  WorkspaceRegisterRequest,
  WorkspaceRegisterResponse,
} from "./http.js";
import type {
  ClientStreamMessagePayload,
  ServerStreamMessagePayload,
  StreamMessage,
} from "./stream.js";

export interface MockArtifactDownloadResult {
  bytes: Uint8Array;
  metadata: ArtifactDownloadMetadata;
}

/**
 * Mock scenario modes supported by MockProtocolServer.
 */
export type MockScenario =
  | "healthy"
  | "offline"
  | "duplicate"
  | "out_of_order"
  | "revoked_device"
  | "expired_token"
  | "corrupt_artifact"
  | "decompression_bomb"
  | "rate_limited"
  | "clock_skew"
  | "upgrade_required"
  | "partial_batch_failure";

/**
 * In-memory Mock Protocol Server for comprehensive local-to-cloud integration testing.
 */
export class MockProtocolServer {
  private scenario: MockScenario = "healthy";
  private activeTokens: Map<string, AuthClaims> = new Map();
  private refreshTokens: Map<string, string> = new Map(); // refreshToken -> accessToken
  private revokedDevices: Set<string> = new Set();
  private receivedBatches: Map<string, ObservationBatchRequest> = new Map();
  private receivedTelemetry: Map<string, TelemetryBatchRequest> = new Map();
  private catalogTools: Map<string, ToolManifest> = new Map();
  private activeDeployments: Map<string, DeploymentRecord> = new Map();
  private artifactStore: Map<string, { bytes: Uint8Array; metadata: ArtifactDownloadMetadata }> =
    new Map();
  private serverSequence = 0;
  private clientSequence = 0;

  constructor(initialScenario: MockScenario = "healthy") {
    this.scenario = initialScenario;
    this.seedDefaultFixtures();
  }

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  getScenario(): MockScenario {
    return this.scenario;
  }

  reset(): void {
    this.activeTokens.clear();
    this.refreshTokens.clear();
    this.revokedDevices.clear();
    this.receivedBatches.clear();
    this.receivedTelemetry.clear();
    this.catalogTools.clear();
    this.activeDeployments.clear();
    this.artifactStore.clear();
    this.serverSequence = 0;
    this.clientSequence = 0;
    this.seedDefaultFixtures();
  }

  private seedDefaultFixtures(): void {
    // Seed sample tool manifest
    const sampleTool: ToolManifest = {
      id: "tool-git-commit",
      name: "git_commit_helper",
      version: "1.0.0",
      description: "Generates conventional commit messages",
      parameters: {
        type: "object",
        properties: {
          diff: { type: "string" },
        },
        required: ["diff"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      runtime: {
        runtime: "deno",
        memoryLimitMb: 128,
        timeoutMs: 30000,
        cpuLimitPercent: 80,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {
        fs: {
          readPaths: ["."],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: false,
          allowedCommands: ["git"],
          allowedBinaries: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: ["PATH"],
        },
        secrets: {
          allowedSecretNames: [],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 2,
          maxCpuUsagePercent: 80,
          maxMemoryMb: 256,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
      },
      limits: {
        timeoutMs: 30000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 4,
      },
      scope: "workspace",
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    this.catalogTools.set(sampleTool.id, sampleTool);

    // Seed sample artifact
    const artifactBytes = new TextEncoder().encode("console.log('mock artifact execution');");
    const digest = createHash("sha256").update(artifactBytes).digest("hex");
    this.artifactStore.set(digest, {
      bytes: artifactBytes,
      metadata: {
        digest,
        sizeBytes: artifactBytes.byteLength,
        contentType: "application/javascript",
        sha256: digest,
        maxAllowedSizeBytes: 52428800,
        compression: "none",
      },
    });
  }

  // --- Auth Handlers ---

  handleDeviceAuthBootstrap(request: DeviceAuthBootstrapRequest): DeviceAuthBootstrapResponse {
    this.checkScenarioExceptions(request.deviceId);

    const deviceCode = `dcode_${randomUUID().replace(/-/g, "")}`;
    const userCode = `UC-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    return {
      deviceCode,
      userCode,
      verificationUri: "https://auth.resin.sh/activate",
      verificationUriComplete: `https://auth.resin.sh/activate?user_code=${userCode}`,
      expiresIn: 900,
      interval: 5,
    };
  }

  handleDeviceTokenExchange(request: DeviceTokenExchangeRequest): DeviceTokenExchangeResponse {
    this.checkScenarioExceptions(request.deviceId);

    if (this.scenario === "revoked_device" || this.revokedDevices.has(request.deviceId)) {
      throw new DeviceRevokedError(request.deviceId);
    }

    const accessToken = `atk_${randomUUID()}`;
    const refreshToken = `rtk_${randomUUID()}`;
    const claims: AuthClaims = {
      accountId: "acc-default",
      deviceId: request.deviceId,
      installationId: request.installationId,
      workspaceId: "ws-default",
      scopes: [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "deployments:read",
        "deployments:write",
        "telemetry:write",
      ],
      rawUploadConsent: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: "access",
    };

    this.activeTokens.set(accessToken, claims);
    this.refreshTokens.set(refreshToken, accessToken);

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken,
      claims,
    };
  }

  handleTokenRotation(request: TokenRotationRequest): TokenRotationResponse {
    this.checkScenarioExceptions(request.deviceId);

    if (!this.refreshTokens.has(request.refreshToken)) {
      throw new ValidationError("Invalid or already consumed refresh token");
    }

    // Invalidate old tokens
    const oldAccessToken = this.refreshTokens.get(request.refreshToken);
    if (oldAccessToken) {
      this.activeTokens.delete(oldAccessToken);
    }
    this.refreshTokens.delete(request.refreshToken);

    const newAccessToken = `atk_${randomUUID()}`;
    const newRefreshToken = `rtk_${randomUUID()}`;
    const claims: AuthClaims = {
      accountId: "acc-default",
      deviceId: request.deviceId,
      installationId: request.installationId,
      workspaceId: "ws-default",
      scopes: [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "deployments:read",
        "deployments:write",
        "telemetry:write",
      ],
      rawUploadConsent: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: "access",
    };

    this.activeTokens.set(newAccessToken, claims);
    this.refreshTokens.set(newRefreshToken, newAccessToken);

    return {
      accessToken: newAccessToken,
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: newRefreshToken,
      claims,
    };
  }

  handleDeviceRevocation(request: DeviceRevocationRequest): DeviceRevocationResponse {
    this.revokedDevices.add(request.deviceId);
    return {
      revoked: true,
      revokedAt: new Date().toISOString(),
      deviceId: request.deviceId,
      message: `Device ${request.deviceId} authorization revoked`,
    };
  }

  // --- Registration Handlers ---

  handleInstallationRegister(request: InstallationRegisterRequest): InstallationRegisterResponse {
    this.checkScenarioExceptions(request.deviceId);
    return {
      installationId: request.installationId,
      status: "registered",
      registeredAt: new Date().toISOString(),
    };
  }

  handleWorkspaceRegister(request: WorkspaceRegisterRequest): WorkspaceRegisterResponse {
    this.checkScenarioExceptions(request.deviceId);
    return {
      workspaceId: request.workspaceId,
      status: "registered",
      registeredAt: new Date().toISOString(),
    };
  }

  // --- Observation Batch Ingestion Handler ---

  handleObservationBatch(request: ObservationBatchRequest): ObservationBatchResponse {
    this.checkScenarioExceptions(request.deviceId);

    if (this.receivedBatches.has(request.batchId)) {
      // Idempotent duplicate delivery
      const existing = this.receivedBatches.get(request.batchId)!;
      return {
        batchId: request.batchId,
        status: "accepted",
        acceptedCount: existing.observations.length,
        rejectedCount: 0,
        cursorAck: request.cursor,
        errors: [],
        deadLetters: [],
      };
    }

    if (this.scenario === "partial_batch_failure" && request.observations.length > 1) {
      this.receivedBatches.set(request.batchId, request);
      const failedIndex = request.observations.length - 1;
      const failedEvent = request.observations[failedIndex];
      return {
        batchId: request.batchId,
        status: "partial",
        acceptedCount: request.observations.length - 1,
        rejectedCount: 1,
        cursorAck: request.cursor,
        errors: [
          {
            index: failedIndex,
            eventId: failedEvent.eventId,
            errorCode: "validation",
            message: "Payload schema validation failed on element",
            retryable: false,
          },
        ],
        deadLetters: [
          {
            eventId: failedEvent.eventId,
            reason: "Non-retryable schema corruption",
            permanent: true,
            suggestedAction: "discard",
          },
        ],
      };
    }

    this.receivedBatches.set(request.batchId, request);
    return {
      batchId: request.batchId,
      status: "accepted",
      acceptedCount: request.observations.length,
      rejectedCount: 0,
      cursorAck: request.cursor,
      errors: [],
      deadLetters: [],
    };
  }

  // --- Catalog & Artifact Handlers ---

  handleCatalogSnapshot(request: CatalogSnapshotRequest): CatalogSnapshotResponse {
    this.checkScenarioExceptions(request.deviceId);

    const tools = Array.from(this.catalogTools.values());
    const activeDeployments = Array.from(this.activeDeployments.values());
    const snapshotVersion = "v1.0.0-snapshot";
    const checksum = hashCanonicalContent({ tools, activeDeployments });

    return {
      snapshotVersion,
      generatedAt: new Date().toISOString(),
      checksum,
      tools,
      activeDeployments,
    };
  }

  handleArtifactDownload(request: ArtifactDownloadRequest): MockArtifactDownloadResult {
    this.checkScenarioExceptions();

    if (this.scenario === "corrupt_artifact") {
      const badBytes = new TextEncoder().encode("tampered bytes not matching checksum");
      const metadata: ArtifactDownloadMetadata = {
        digest: request.digest,
        sizeBytes: badBytes.byteLength,
        contentType: "application/octet-stream",
        sha256: request.digest, // metadata declares request.digest, but badBytes won't match
        maxAllowedSizeBytes: 52428800,
        compression: "none",
      };
      return { bytes: badBytes, metadata };
    }

    if (this.scenario === "decompression_bomb") {
      const bombBytes = new Uint8Array(200);
      const metadata: ArtifactDownloadMetadata = {
        digest: request.digest,
        sizeBytes: 100_000_000, // 100MB declared
        contentType: "application/octet-stream",
        sha256: request.digest,
        maxAllowedSizeBytes: 52428800, // 50MB limit
        compression: "gzip",
      };
      return { bytes: bombBytes, metadata };
    }

    const entry = this.artifactStore.get(request.digest);
    if (!entry) {
      throw new ValidationError(`Artifact with digest ${request.digest} not found`);
    }

    return entry;
  }

  // --- Deployment & Telemetry Handlers ---

  handleDeploymentStatusReport(
    request: DeploymentStatusReportRequest,
  ): DeploymentStatusReportResponse {
    this.checkScenarioExceptions(request.deviceId);
    return {
      acknowledged: true,
      syncCommands: [],
    };
  }

  handleTelemetryBatch(request: TelemetryBatchRequest): TelemetryBatchResponse {
    this.checkScenarioExceptions(request.deviceId);
    this.receivedTelemetry.set(request.batchId, request);
    return {
      batchId: request.batchId,
      status: "accepted",
      processedCount: request.invocations.length + request.metrics.length,
    };
  }

  // --- Health Negotiation Handler ---

  handleHealthNegotiate(request: HealthNegotiateRequest): HealthNegotiateResponse {
    this.checkScenarioExceptions();

    if (this.scenario === "clock_skew") {
      const skewedServerTime = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes ahead
      return {
        status: "healthy",
        serverVersion: "1.0.0",
        protocolVersion: "1.0.0",
        minSupportedProtocolVersion: "1.0.0",
        supportedCapabilities: ["observations", "catalog", "deployments", "telemetry"],
        serverTime: skewedServerTime,
        clockSkewMs: 600_000,
      };
    }

    return {
      status: "healthy",
      serverVersion: "1.0.0",
      protocolVersion: "1.0.0",
      minSupportedProtocolVersion: "1.0.0",
      supportedCapabilities: ["observations", "catalog", "deployments", "telemetry"],
      serverTime: new Date().toISOString(),
      clockSkewMs: 0,
    };
  }

  // --- Stream Simulation ---

  generateServerStreamMessages(count = 5): StreamMessage<ServerStreamMessagePayload>[] {
    const messages: StreamMessage<ServerStreamMessagePayload>[] = [];

    for (let i = 0; i < count; i++) {
      let seq = this.serverSequence++;
      if (this.scenario === "out_of_order") {
        // Swap sequence numbers to simulate out of order delivery
        if (i === 1) seq += 1;
        else if (i === 2) seq -= 1;
      }

      messages.push({
        messageId: randomUUID(),
        sequence: seq,
        timestamp: new Date().toISOString(),
        payload: {
          type: "server.heartbeat_ack",
          timestamp: new Date().toISOString(),
          sequence: seq,
          serverTime: new Date().toISOString(),
        },
      });
    }

    return messages;
  }

  private checkScenarioExceptions(deviceId?: string): void {
    if (this.scenario === "offline") {
      throw new RetryableError("Network connection refused: server offline");
    }

    if (this.scenario === "rate_limited") {
      throw new RateLimitedError("Too many requests: rate limit exceeded", { retryAfterMs: 5000 });
    }

    if (this.scenario === "upgrade_required") {
      throw new UpgradeRequiredError("Client protocol version deprecated", "2.0.0");
    }

    if (deviceId && (this.scenario === "revoked_device" || this.revokedDevices.has(deviceId))) {
      throw new DeviceRevokedError(deviceId);
    }

    if (this.scenario === "expired_token") {
      throw new TokenExpiredError("Access token expired");
    }
  }
}
