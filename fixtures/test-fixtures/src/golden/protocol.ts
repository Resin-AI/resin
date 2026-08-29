import type {
  ArtifactDownloadMetadata,
  ArtifactDownloadRequest,
  AuthClaims,
  CatalogSnapshotRequest,
  CatalogSnapshotResponse,
  DeploymentStatusReportRequest,
  DeploymentStatusReportResponse,
  DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapResponse,
  DeviceRevocationRequest,
  DeviceRevocationResponse,
  DeviceTokenExchangeRequest,
  DeviceTokenExchangeResponse,
  HealthNegotiateRequest,
  HealthNegotiateResponse,
  InstallationRegisterRequest,
  InstallationRegisterResponse,
  ObservationBatchRequest,
  ObservationBatchResponse,
  ProtocolErrorResponse,
  ProtocolMessageEnvelope,
  StreamMessage,
  TelemetryBatchRequest,
  TelemetryBatchResponse,
  TokenRotationRequest,
  TokenRotationResponse,
  WorkspaceRegisterRequest,
  WorkspaceRegisterResponse,
} from "@resin/protocol";
import {
  FIXTURE_DIGEST,
  FIXTURE_TIMESTAMP,
  FIXTURE_WORKSPACE_ID,
  validCapabilityEnvelope,
  validMessageEvent,
  validToolCallEvent,
  validToolManifest,
  validToolResultEvent,
} from "./domain.js";

// ============================================================================
// Envelopes & Signatures - Valid Fixtures
// ============================================================================

export const validProtocolEnvelope: ProtocolMessageEnvelope<{ test: string }> = {
  version: "1.0.0",
  messageId: "msg_01JABCDEF012345678901234",
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  sequence: 1,
  payloadType: "test_event",
  payloadDigest: FIXTURE_DIGEST,
  payload: { test: "data" },
  createdAt: FIXTURE_TIMESTAMP,
  compression: "none",
  traceContext: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
  },
};

// ============================================================================
// Device Authentication & Lifecycle - Valid Fixtures
// ============================================================================

export const validDeviceAuthBootstrapRequest: DeviceAuthBootstrapRequest = {
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  hostname: "macbook-pro.local",
  platform: "darwin",
  arch: "arm64",
  clientVersion: "0.1.0",
  scopes: ["device:connect", "observations:write", "catalog:read"],
};

export const validDeviceAuthBootstrapResponse: DeviceAuthBootstrapResponse = {
  deviceCode: "dev-code-abcdef1234567890",
  userCode: "WDJB-ABCD",
  verificationUri: "https://auth.resin.dev/device",
  expiresIn: 900,
  interval: 5,
};

export const validDeviceTokenExchangeRequest: DeviceTokenExchangeRequest = {
  grantType: "urn:ietf:params:oauth:grant-type:device_code",
  deviceCode: "dev-code-abcdef1234567890",
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
};

const defaultAuthClaims: AuthClaims = {
  accountId: "acc_01JABCDEF",
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  scopes: ["device:connect", "observations:write", "catalog:read"],
  rawUploadConsent: false,
  issuedAt: FIXTURE_TIMESTAMP,
  expiresAt: "2026-08-17T13:00:00.000Z",
  tokenType: "access",
};

export const validDeviceTokenExchangeResponse: DeviceTokenExchangeResponse = {
  tokenType: "Bearer",
  accessToken: "eyJhbGciOiJFZERTQSI...mock_token_content...",
  refreshToken: "eyJhbGciOiJFZERTQSI...mock_refresh_content...",
  expiresIn: 3600,
  claims: defaultAuthClaims,
};

export const validTokenRotationRequest: TokenRotationRequest = {
  grantType: "refresh_token",
  refreshToken: "eyJhbGciOiJFZERTQSI...mock_refresh_content...",
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
};

export const validTokenRotationResponse: TokenRotationResponse = {
  tokenType: "Bearer",
  accessToken: "eyJhbGciOiJFZERTQSI...mock_rotated_access...",
  refreshToken: "eyJhbGciOiJFZERTQSI...mock_rotated_refresh...",
  expiresIn: 3600,
  claims: defaultAuthClaims,
};

export const validDeviceRevocationRequest: DeviceRevocationRequest = {
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  tokenTypeHint: "device",
  reason: "device_decommissioned",
};

export const validDeviceRevocationResponse: DeviceRevocationResponse = {
  revoked: true,
  deviceId: "dev_01JABCDEF",
  revokedAt: FIXTURE_TIMESTAMP,
  message: "Device revoked successfully",
};
export const validInstallationRegisterRequest: InstallationRegisterRequest = {
  installationId: "inst_01JABCDEF",
  deviceId: "dev_01JABCDEF",
  appVersion: "0.1.0",
  daemonVersion: "0.1.0",
  harnesses: ["cline"],
  installedAt: FIXTURE_TIMESTAMP,
};

export const validInstallationRegisterResponse: InstallationRegisterResponse = {
  installationId: "inst_01JABCDEF",
  status: "registered",
  registeredAt: FIXTURE_TIMESTAMP,
};

export const validWorkspaceRegisterRequest: WorkspaceRegisterRequest = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  installationId: "inst_01JABCDEF",
  deviceId: "dev_01JABCDEF",
  name: "Resin",
  rootPath: "/workspaces/resin",
  capabilityEnvelope: validCapabilityEnvelope,
  activeTools: { fast_ast_grep: "1.0.0" },
};

export const validWorkspaceRegisterResponse: WorkspaceRegisterResponse = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  status: "registered",
  registeredAt: FIXTURE_TIMESTAMP,
};

export const validObservationBatchRequest: ObservationBatchRequest = {
  batchId: "batch_obs_001",
  workspaceId: FIXTURE_WORKSPACE_ID,
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  compressed: false,
  compression: "none",
  observations: [validMessageEvent, validToolCallEvent, validToolResultEvent],
};

export const validObservationBatchResponse: ObservationBatchResponse = {
  batchId: "batch_obs_001",
  status: "accepted",
  acceptedCount: 3,
  rejectedCount: 0,
  errors: [],
  deadLetters: [],
};

export const validCatalogSnapshotRequest: CatalogSnapshotRequest = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  deviceId: "dev_01JABCDEF",
  currentVersion: "1.0.0",
};

export const validCatalogSnapshotResponse: CatalogSnapshotResponse = {
  snapshotVersion: "1.0.0",
  generatedAt: FIXTURE_TIMESTAMP,
  checksum: FIXTURE_DIGEST,
  tools: [validToolManifest],
  activeDeployments: [],
};

export const validArtifactDownloadRequest: ArtifactDownloadRequest = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  digest: FIXTURE_DIGEST,
  expectedSizeLimitBytes: 52428800,
};
export const validArtifactDownloadMetadata: ArtifactDownloadMetadata = {
  digest: FIXTURE_DIGEST,
  sizeBytes: 1024,
  contentType: "application/tar+gzip",
  sha256: FIXTURE_DIGEST,
  downloadUrl: "https://artifacts.resin.dev/fast_ast_grep/1.0.0.tgz",
  maxAllowedSizeBytes: 52428800,
  compression: "gzip",
};

export const validDeploymentStatusReportRequest: DeploymentStatusReportRequest = {
  workspaceId: FIXTURE_WORKSPACE_ID,
  deviceId: "dev_01JABCDEF",
  deployments: [
    {
      deploymentId: "dep_001",
      toolId: "fast_ast_grep",
      version: "1.0.0",
      state: "canary",
      healthScore: 0.99,
      invocationCount: 15,
      errorCount: 0,
      lastInvokedAt: FIXTURE_TIMESTAMP,
    },
  ],
  reportedAt: FIXTURE_TIMESTAMP,
};

export const validDeploymentStatusReportResponse: DeploymentStatusReportResponse = {
  acknowledged: true,
  syncCommands: [
    {
      deploymentId: "dep_001",
      action: "continue",
    },
  ],
};

export const validTelemetryBatchRequest: TelemetryBatchRequest = {
  batchId: "tel_batch_001",
  deviceId: "dev_01JABCDEF",
  installationId: "inst_01JABCDEF",
  workspaceId: FIXTURE_WORKSPACE_ID,
  timestamp: FIXTURE_TIMESTAMP,
  invocations: [],
  metrics: [
    {
      metricName: "heartbeat",
      value: 1.0,
      unit: "count",
      tags: { host: "macbook-pro" },
      timestamp: FIXTURE_TIMESTAMP,
    },
  ],
};

export const validTelemetryBatchResponse: TelemetryBatchResponse = {
  status: "accepted",
  batchId: "tel_batch_001",
  processedCount: 1,
};

export const validHealthNegotiateRequest: HealthNegotiateRequest = {
  clientVersion: "0.1.0",
  protocolVersion: "1.0.0",
  capabilities: ["batch_compression", "streaming"],
  clientTime: FIXTURE_TIMESTAMP,
};

export const validHealthNegotiateResponse: HealthNegotiateResponse = {
  status: "healthy",
  serverVersion: "0.1.0",
  protocolVersion: "1.0.0",
  minSupportedProtocolVersion: "0.1.0",
  supportedCapabilities: ["batch_compression", "streaming"],
  serverTime: FIXTURE_TIMESTAMP,
  clockSkewMs: 0,
};

export const validProtocolErrorResponse: ProtocolErrorResponse = {
  status: 401,
  error: {
    code: "unauthorized",
    message: "Device token expired or signature invalid",
    details: {
      deviceId: "dev_01JABCDEF",
    },
  },
  timestamp: FIXTURE_TIMESTAMP,
};

// ============================================================================
// Control Stream Messages - Valid Fixtures
// ============================================================================

export const validStreamHeartbeatMessage: StreamMessage = {
  messageId: "msg_hb_001",
  sequence: 1,
  timestamp: FIXTURE_TIMESTAMP,
  payload: {
    type: "client.heartbeat",
    timestamp: FIXTURE_TIMESTAMP,
    sequence: 1,
    uptimeMs: 60000,
    activeSessions: 1,
  },
};

export const validStreamAckMessage: StreamMessage = {
  messageId: "msg_ack_001",
  sequence: 2,
  timestamp: FIXTURE_TIMESTAMP,
  payload: {
    type: "client.ack",
    status: "processed",
    ackSequence: 1,
    messageId: "msg_srv_001",
    timestamp: FIXTURE_TIMESTAMP,
  },
};

export const validStreamResyncMessage: StreamMessage = {
  messageId: "msg_resync_001",
  sequence: 3,
  timestamp: FIXTURE_TIMESTAMP,
  payload: {
    type: "client.resync_request",
    reason: "gap_detected",
    lastKnownServerSequence: 1,
    workspaceId: FIXTURE_WORKSPACE_ID,
    timestamp: FIXTURE_TIMESTAMP,
  },
};

export const validStreamServerHeartbeatAckMessage: StreamMessage = {
  messageId: "msg_srv_hb_ack_001",
  sequence: 4,
  timestamp: FIXTURE_TIMESTAMP,
  payload: {
    type: "server.heartbeat_ack",
    sequence: 1,
    serverTime: FIXTURE_TIMESTAMP,
    timestamp: FIXTURE_TIMESTAMP,
  },
};

export const allValidStreamMessages: StreamMessage[] = [
  validStreamHeartbeatMessage,
  validStreamAckMessage,
  validStreamResyncMessage,
  validStreamServerHeartbeatAckMessage,
];

// ============================================================================
// Invalid Protocol Fixtures for Negative Testing
// ============================================================================

export const invalidProtocolFixtures = {
  missingPayloadTypeEnvelope: {
    envelopeId: "env_01JABCDEF",
    source: "daemon",
    destination: "cloud",
    schemaVersion: "1.0.0",
    payloadDigest: FIXTURE_DIGEST,
    payload: {},
    createdAt: FIXTURE_TIMESTAMP,
  },
  negativeSequenceStreamMessage: {
    ...validStreamHeartbeatMessage,
    sequence: -1,
  },
  unknownStreamMessageType: {
    messageId: "msg_unknown_001",
    sequence: 1,
    timestamp: FIXTURE_TIMESTAMP,
    payload: {
      type: "quantum_subspace_teleport",
    },
  },
  invalidAuthRequestBadPlatform: {
    ...validDeviceAuthBootstrapRequest,
    platform: "gameboy_color",
  },
  invalidObservationBatchBadEvent: {
    ...validObservationBatchRequest,
    observations: [{ invalid: "event" }],
  },
};
