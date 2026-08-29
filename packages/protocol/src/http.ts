import {
  CapabilityEnvelopeSchema,
  DeploymentRecordSchema,
  DeploymentStateSchema,
  ISOTimestampSchema,
  IdentifierSchema,
  InvocationRecordSchema,
  NormalizedSessionEventSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  ToolManifestSchema,
} from "@resin/contracts";
import { z } from "zod";
import {
  AuthScopeSchema,
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
} from "./auth.js";
import { ProtocolCompressionSchema } from "./envelope.js";
import { ProtocolErrorCodeSchema, ProtocolErrorResponseSchema } from "./errors.js";

/**
 * 1. Installation Registration.
 * Endpoint: POST /v1/installations/register
 */
export const InstallationRegisterRequestSchema = z.object({
  installationId: IdentifierSchema,
  deviceId: IdentifierSchema,
  appVersion: SchemaVersionSchema,
  daemonVersion: SchemaVersionSchema,
  harnesses: z.array(z.string()).default([]),
  installedAt: ISOTimestampSchema,
  metadata: z.record(z.unknown()).optional(),
});

export type InstallationRegisterRequest = z.infer<typeof InstallationRegisterRequestSchema>;

export const InstallationRegisterResponseSchema = z.object({
  installationId: IdentifierSchema,
  status: z.enum(["registered", "updated", "active"]),
  registeredAt: ISOTimestampSchema,
});

export type InstallationRegisterResponse = z.infer<typeof InstallationRegisterResponseSchema>;

/**
 * 2. Workspace Registration.
 * Endpoint: POST /v1/workspaces/register
 */
export const WorkspaceRegisterRequestSchema = z.object({
  workspaceId: IdentifierSchema,
  installationId: IdentifierSchema,
  deviceId: IdentifierSchema,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  capabilityEnvelope: CapabilityEnvelopeSchema,
  activeTools: z.record(SchemaVersionSchema).default({}),
});

export type WorkspaceRegisterRequest = z.infer<typeof WorkspaceRegisterRequestSchema>;

export const WorkspaceRegisterResponseSchema = z.object({
  workspaceId: IdentifierSchema,
  status: z.enum(["registered", "updated", "active"]),
  registeredAt: ISOTimestampSchema,
});

export type WorkspaceRegisterResponse = z.infer<typeof WorkspaceRegisterResponseSchema>;

/**
 * 3. Observations Batch Ingestion.
 * Endpoint: POST /v1/observations/batch
 */
export const PartialBatchErrorSchema = z.object({
  index: z.number().int().nonnegative(),
  eventId: IdentifierSchema,
  errorCode: ProtocolErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});

export type PartialBatchError = z.infer<typeof PartialBatchErrorSchema>;

export const DeadLetterClassificationSchema = z.object({
  eventId: IdentifierSchema,
  reason: z.string().min(1),
  permanent: z.boolean(),
  suggestedAction: z.enum(["discard", "quarantine", "retry_later"]),
});

export type DeadLetterClassification = z.infer<typeof DeadLetterClassificationSchema>;

export const ObservationBatchRequestSchema = z.object({
  batchId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  deviceId: IdentifierSchema,
  installationId: IdentifierSchema,
  cursor: z.string().min(1).optional(),
  compressed: z.boolean().default(false),
  compression: ProtocolCompressionSchema,
  observations: z.array(NormalizedSessionEventSchema),
});

export type ObservationBatchRequest = z.infer<typeof ObservationBatchRequestSchema>;

export const ObservationBatchResponseSchema = z.object({
  batchId: IdentifierSchema,
  status: z.enum(["accepted", "partial", "rejected"]),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  cursorAck: z.string().optional(),
  errors: z.array(PartialBatchErrorSchema).default([]),
  deadLetters: z.array(DeadLetterClassificationSchema).default([]),
  jobId: IdentifierSchema.optional(),
  statusUrl: z.string().optional(),
});

export type ObservationBatchResponse = z.infer<typeof ObservationBatchResponseSchema>;

/**
 * 4. Catalog Snapshot.
 * Endpoint: GET /v1/catalog/snapshot
 */
export const CatalogSnapshotRequestSchema = z.object({
  workspaceId: IdentifierSchema,
  deviceId: IdentifierSchema,
  currentVersion: z.string().optional(),
  filterScopes: z.array(z.string()).optional(),
});

export type CatalogSnapshotRequest = z.infer<typeof CatalogSnapshotRequestSchema>;

export const CatalogSnapshotResponseSchema = z.object({
  snapshotVersion: z.string().min(1),
  generatedAt: ISOTimestampSchema,
  checksum: Sha256DigestSchema,
  tools: z.array(ToolManifestSchema),
  activeDeployments: z.array(DeploymentRecordSchema),
});

export type CatalogSnapshotResponse = z.infer<typeof CatalogSnapshotResponseSchema>;

/**
 * 5. Artifact Download & Verification.
 * Endpoint: GET /v1/artifacts/:digest/download
 */
export const ArtifactDownloadRequestSchema = z.object({
  digest: Sha256DigestSchema,
  workspaceId: IdentifierSchema,
  expectedSizeLimitBytes: z.number().int().positive().optional(),
});

export type ArtifactDownloadRequest = z.infer<typeof ArtifactDownloadRequestSchema>;

export const ArtifactDownloadMetadataSchema = z.object({
  digest: Sha256DigestSchema,
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().default("application/octet-stream"),
  sha256: Sha256DigestSchema,
  downloadUrl: z.string().url().optional(),
  maxAllowedSizeBytes: z.number().int().positive().default(52428800), // 50MB max default
  compression: ProtocolCompressionSchema,
});

export type ArtifactDownloadMetadata = z.infer<typeof ArtifactDownloadMetadataSchema>;

/**
 * 6. Deployment Status Report & Sync.
 * Endpoint: POST /v1/deployments/status
 */
export const DeploymentStatusItemSchema = z.object({
  deploymentId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  state: DeploymentStateSchema,
  healthScore: z.number().min(0).max(1).default(1),
  invocationCount: z.number().int().nonnegative().default(0),
  errorCount: z.number().int().nonnegative().default(0),
  lastInvokedAt: ISOTimestampSchema.optional(),
});

export type DeploymentStatusItem = z.infer<typeof DeploymentStatusItemSchema>;

export const DeploymentStatusReportRequestSchema = z.object({
  workspaceId: IdentifierSchema,
  deviceId: IdentifierSchema,
  deployments: z.array(DeploymentStatusItemSchema),
  reportedAt: ISOTimestampSchema,
});

export type DeploymentStatusReportRequest = z.infer<typeof DeploymentStatusReportRequestSchema>;

export const DeploymentSyncCommandSchema = z.object({
  deploymentId: IdentifierSchema,
  action: z.enum(["continue", "suspend", "rollback", "promote"]),
  targetState: DeploymentStateSchema.optional(),
  reason: z.string().optional(),
});

export type DeploymentSyncCommand = z.infer<typeof DeploymentSyncCommandSchema>;

export const DeploymentStatusReportResponseSchema = z.object({
  acknowledged: z.boolean().default(true),
  syncCommands: z.array(DeploymentSyncCommandSchema).default([]),
});

export type DeploymentStatusReportResponse = z.infer<typeof DeploymentStatusReportResponseSchema>;

/**
 * 7. Telemetry Ingestion Batch.
 * Endpoint: POST /v1/telemetry/batch
 */
export const TelemetryMetricSchema = z.object({
  metricName: z.string().min(1),
  value: z.number(),
  unit: z.string().optional(),
  tags: z.record(z.string()).default({}),
  timestamp: ISOTimestampSchema,
});

export type TelemetryMetric = z.infer<typeof TelemetryMetricSchema>;

export const TelemetryBatchRequestSchema = z.object({
  batchId: IdentifierSchema,
  deviceId: IdentifierSchema,
  installationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  invocations: z.array(InvocationRecordSchema).default([]),
  metrics: z.array(TelemetryMetricSchema).default([]),
});

export type TelemetryBatchRequest = z.infer<typeof TelemetryBatchRequestSchema>;

export const TelemetryBatchResponseSchema = z.object({
  batchId: IdentifierSchema,
  status: z.enum(["accepted", "partial", "rejected"]).default("accepted"),
  processedCount: z.number().int().nonnegative(),
});

export type TelemetryBatchResponse = z.infer<typeof TelemetryBatchResponseSchema>;
/**
 * 8. Health & Protocol Version Negotiation.
 * Endpoint: POST /v1/health/negotiate
 */
export const HealthNegotiateRequestSchema = z.object({
  clientVersion: SchemaVersionSchema,
  protocolVersion: SchemaVersionSchema,
  capabilities: z.array(z.string()).default([]),
  clientTime: ISOTimestampSchema,
});

export type HealthNegotiateRequest = z.infer<typeof HealthNegotiateRequestSchema>;

export const HealthNegotiateResponseSchema = z.object({
  status: z.enum(["healthy", "upgrade_required", "degraded"]),
  serverVersion: SchemaVersionSchema,
  protocolVersion: SchemaVersionSchema,
  minSupportedProtocolVersion: SchemaVersionSchema,
  supportedCapabilities: z.array(z.string()),
  serverTime: ISOTimestampSchema,
  clockSkewMs: z.number(),
});

export type HealthNegotiateResponse = z.infer<typeof HealthNegotiateResponseSchema>;

/**
 * Complete OpenAPI 3.1 Specification Definition for Local-to-Cloud Wire Protocols.
 */
export const OPENAPI_V1_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Resin Cloud Control & Ingestion API",
    version: "1.0.0",
    description:
      "Versioned local-to-cloud protocol for device authentication, observation ingestion, catalog synchronization, deployment lifecycle, and telemetry.",
  },
  servers: [
    {
      url: "https://api.resin.sh",
      description: "Production Cloud Control Plane",
    },
    {
      url: "http://127.0.0.1:8787",
      description: "Local Development Mock Server",
    },
  ],
  paths: {
    "/v1/auth/device/code": {
      post: {
        summary: "Initiate Device Authorization Code flow",
        operationId: "bootstrapDeviceAuth",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeviceAuthBootstrapRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Device authorization initialized",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeviceAuthBootstrapResponse" },
              },
            },
          },
          "400": {
            description: "Invalid bootstrap request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProtocolErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/auth/device/token": {
      post: {
        summary: "Poll or exchange device code for access token",
        operationId: "exchangeDeviceToken",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeviceTokenExchangeRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Access token granted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeviceTokenExchangeResponse" },
              },
            },
          },
          "400": {
            description: "Token error or authorization pending",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/auth/token/refresh": {
      post: {
        summary: "Rotate and refresh device access token",
        operationId: "refreshToken",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TokenRotationRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Token refreshed and rotated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenRotationResponse" },
              },
            },
          },
          "401": {
            description: "Refresh token expired or invalid",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TokenErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/auth/device/revoke": {
      post: {
        summary: "Revoke device authorization and all active tokens",
        operationId: "revokeDevice",
        security: [{ BearerAuth: ["admin:all", "device:connect"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeviceRevocationRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Device successfully revoked",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeviceRevocationResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/installations/register": {
      post: {
        summary: "Register or update local installation record",
        operationId: "registerInstallation",
        security: [{ BearerAuth: ["device:connect"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InstallationRegisterRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Installation registered",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InstallationRegisterResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/workspaces/register": {
      post: {
        summary: "Register or update workspace capability envelope",
        operationId: "registerWorkspace",
        security: [{ BearerAuth: ["device:connect"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WorkspaceRegisterRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Workspace registered",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkspaceRegisterResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/observations/batch": {
      post: {
        summary: "Batch ingest normalized session observations",
        operationId: "ingestObservationBatch",
        security: [{ BearerAuth: ["observations:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ObservationBatchRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Batch processed (accepted or partial)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ObservationBatchResponse" },
              },
            },
          },
          "400": {
            description: "Batch rejection or validation failure",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProtocolErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/catalog/snapshot": {
      get: {
        summary: "Fetch tool catalog snapshot and active deployment records",
        operationId: "getCatalogSnapshot",
        security: [{ BearerAuth: ["catalog:read"] }],
        parameters: [
          { name: "workspaceId", in: "query", required: true, schema: { type: "string" } },
          { name: "deviceId", in: "query", required: true, schema: { type: "string" } },
          { name: "currentVersion", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Catalog snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CatalogSnapshotResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/artifacts/{digest}/download": {
      get: {
        summary: "Download compiled tool artifact package with checksum validation",
        operationId: "downloadArtifact",
        security: [{ BearerAuth: ["artifacts:read"] }],
        parameters: [
          { name: "digest", in: "path", required: true, schema: { type: "string" } },
          { name: "workspaceId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Artifact binary stream",
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "404": {
            description: "Artifact not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProtocolErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/deployments/status": {
      post: {
        summary: "Report local deployment status and receive sync directives",
        operationId: "reportDeploymentStatus",
        security: [{ BearerAuth: ["deployments:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeploymentStatusReportRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Status acknowledged and sync directives provided",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeploymentStatusReportResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/telemetry/batch": {
      post: {
        summary: "Ingest runtime invocation and performance telemetry batch",
        operationId: "ingestTelemetryBatch",
        security: [{ BearerAuth: ["telemetry:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TelemetryBatchRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Telemetry batch accepted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TelemetryBatchResponse" },
              },
            },
          },
        },
      },
    },
    "/v1/health/negotiate": {
      post: {
        summary: "Negotiate protocol version, supported capabilities, and clock synchronization",
        operationId: "negotiateHealth",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/HealthNegotiateRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Protocol negotiation result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthNegotiateResponse" },
              },
            },
          },
          "426": {
            description: "Upgrade required",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProtocolErrorResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      DeviceAuth: {
        type: "apiKey",
        in: "header",
        name: "X-Device-Id",
      },
    },
    schemas: {
      DeviceAuthBootstrapRequest: { type: "object" },
      DeviceAuthBootstrapResponse: { type: "object" },
      DeviceTokenExchangeRequest: { type: "object" },
      DeviceTokenExchangeResponse: { type: "object" },
      TokenRotationRequest: { type: "object" },
      TokenRotationResponse: { type: "object" },
      DeviceRevocationRequest: { type: "object" },
      DeviceRevocationResponse: { type: "object" },
      TokenErrorResponse: { type: "object" },
      InstallationRegisterRequest: { type: "object" },
      InstallationRegisterResponse: { type: "object" },
      WorkspaceRegisterRequest: { type: "object" },
      WorkspaceRegisterResponse: { type: "object" },
      ObservationBatchRequest: { type: "object" },
      ObservationBatchResponse: { type: "object" },
      CatalogSnapshotResponse: { type: "object" },
      DeploymentStatusReportRequest: { type: "object" },
      DeploymentStatusReportResponse: { type: "object" },
      TelemetryBatchRequest: { type: "object" },
      TelemetryBatchResponse: { type: "object" },
      HealthNegotiateRequest: { type: "object" },
      HealthNegotiateResponse: { type: "object" },
      ProtocolErrorResponse: { type: "object" },
    },
  },
} as const;
