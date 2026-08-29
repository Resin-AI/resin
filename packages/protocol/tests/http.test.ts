import { describe, expect, it } from "vitest";
import {
  ArtifactDownloadMetadataSchema,
  ArtifactDownloadRequestSchema,
  CatalogSnapshotRequestSchema,
  CatalogSnapshotResponseSchema,
  DeadLetterClassificationSchema,
  DeploymentStatusItemSchema,
  DeploymentStatusReportRequestSchema,
  DeploymentStatusReportResponseSchema,
  DeploymentSyncCommandSchema,
  HealthNegotiateRequestSchema,
  HealthNegotiateResponseSchema,
  InstallationRegisterRequestSchema,
  InstallationRegisterResponseSchema,
  OPENAPI_V1_SPEC,
  ObservationBatchRequestSchema,
  ObservationBatchResponseSchema,
  PartialBatchErrorSchema,
  TelemetryBatchRequestSchema,
  TelemetryBatchResponseSchema,
  TelemetryMetricSchema,
  WorkspaceRegisterRequestSchema,
  WorkspaceRegisterResponseSchema,
} from "../src/index.js";

describe("HTTP OpenAPI & Request/Response Contracts", () => {
  it("defines a valid and complete OpenAPI 3.1 specification", () => {
    expect(OPENAPI_V1_SPEC.openapi).toBe("3.1.0");
    expect(OPENAPI_V1_SPEC.info.title).toContain("Resin");

    // Check all required endpoints are documented
    const paths = Object.keys(OPENAPI_V1_SPEC.paths);
    expect(paths).toContain("/v1/auth/device/code");
    expect(paths).toContain("/v1/auth/device/token");
    expect(paths).toContain("/v1/auth/token/refresh");
    expect(paths).toContain("/v1/auth/device/revoke");
    expect(paths).toContain("/v1/installations/register");
    expect(paths).toContain("/v1/workspaces/register");
    expect(paths).toContain("/v1/observations/batch");
    expect(paths).toContain("/v1/catalog/snapshot");
    expect(paths).toContain("/v1/artifacts/{digest}/download");
    expect(paths).toContain("/v1/deployments/status");
    expect(paths).toContain("/v1/telemetry/batch");
    expect(paths).toContain("/v1/health/negotiate");

    // Check security schemes
    expect(OPENAPI_V1_SPEC.components.securitySchemes.BearerAuth).toBeDefined();
    expect(OPENAPI_V1_SPEC.components.securitySchemes.DeviceAuth).toBeDefined();
  });

  it("validates installation and workspace registration schemas", () => {
    const installReq = {
      installationId: "inst-001",
      deviceId: "dev-001",
      appVersion: "1.0.0",
      daemonVersion: "1.0.0",
      harnesses: ["claude-code", "omp"],
      installedAt: new Date().toISOString(),
    };
    expect(InstallationRegisterRequestSchema.parse(installReq).installationId).toBe("inst-001");

    const installRes = {
      installationId: "inst-001",
      status: "registered" as const,
      registeredAt: new Date().toISOString(),
    };
    expect(InstallationRegisterResponseSchema.parse(installRes).status).toBe("registered");

    const workspaceReq = {
      workspaceId: "ws-001",
      installationId: "inst-001",
      deviceId: "dev-001",
      name: "resin-monorepo",
      rootPath: "/home/user/project",
      capabilityEnvelope: {
        envelopeId: "env-001",
        workspaceId: "ws-001",
        fs: {
          readPaths: ["."],
          writePaths: ["dist"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [".git"],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: false,
          allowedDomains: [],
          allowedHosts: [],
          allowedPorts: [],
          allowedProtocols: ["https" as const],
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
          maxConcurrentExecutions: 4,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 256,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
        status: "active" as const,
        version: "1.0.0",
        createdAt: new Date().toISOString(),
      },
    };
    expect(WorkspaceRegisterRequestSchema.parse(workspaceReq).workspaceId).toBe("ws-001");

    const workspaceRes = {
      workspaceId: "ws-001",
      status: "registered" as const,
      registeredAt: new Date().toISOString(),
    };
    expect(WorkspaceRegisterResponseSchema.parse(workspaceRes).status).toBe("registered");
  });

  it("validates observation batch ingestion, partial errors, and dead-letter classification", () => {
    const batchReq = {
      batchId: "batch-001",
      workspaceId: "ws-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      cursor: "cursor-token-abc",
      compressed: false,
      compression: "none" as const,
      observations: [
        {
          eventId: "evt-001",
          schemaVersion: "1.0.0",
          sessionId: "sess-001",
          timestamp: new Date().toISOString(),
          causalRef: { causalSequence: 1 },
          redaction: {
            isRedacted: false,
            redactedFields: [],
            redactionStrategy: "none",
            scrubbedPatterns: [],
          },
          type: "session_lifecycle" as const,
          lifecycleType: "start" as const,
          harnessName: "claude-code",
        },
      ],
    };

    const parsedBatchReq = ObservationBatchRequestSchema.parse(batchReq);
    expect(parsedBatchReq.batchId).toBe("batch-001");
    expect(parsedBatchReq.observations.length).toBe(1);

    const batchRes = {
      batchId: "batch-001",
      status: "partial" as const,
      acceptedCount: 1,
      rejectedCount: 1,
      cursorAck: "cursor-token-abc",
      errors: [
        {
          index: 1,
          eventId: "evt-corrupt-002",
          errorCode: "validation" as const,
          message: "Schema validation failure on payload",
          retryable: false,
        },
      ],
      deadLetters: [
        {
          eventId: "evt-corrupt-002",
          reason: "Schema validation failure",
          permanent: true,
          suggestedAction: "discard" as const,
        },
      ],
    };

    const parsedBatchRes = ObservationBatchResponseSchema.parse(batchRes);
    expect(parsedBatchRes.status).toBe("partial");
    expect(parsedBatchRes.errors[0].errorCode).toBe("validation");
    expect(parsedBatchRes.deadLetters[0].suggestedAction).toBe("discard");
  });

  it("validates catalog snapshot and artifact download contracts", () => {
    const snapshotReq = {
      workspaceId: "ws-001",
      deviceId: "dev-001",
      currentVersion: "v0.9.0",
    };
    expect(CatalogSnapshotRequestSchema.parse(snapshotReq).workspaceId).toBe("ws-001");

    const snapshotRes = {
      snapshotVersion: "v1.0.0",
      generatedAt: new Date().toISOString(),
      checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tools: [],
      activeDeployments: [],
    };
    expect(CatalogSnapshotResponseSchema.parse(snapshotRes).snapshotVersion).toBe("v1.0.0");

    const artifactReq = {
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      workspaceId: "ws-001",
    };
    expect(ArtifactDownloadRequestSchema.parse(artifactReq).digest).toBeDefined();

    const artifactMeta = {
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 1024,
      contentType: "application/javascript",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      maxAllowedSizeBytes: 52428800,
      compression: "none" as const,
    };
    expect(ArtifactDownloadMetadataSchema.parse(artifactMeta).sizeBytes).toBe(1024);
  });

  it("validates deployment status reports and sync commands", () => {
    const reportReq = {
      workspaceId: "ws-001",
      deviceId: "dev-001",
      reportedAt: new Date().toISOString(),
      deployments: [
        {
          deploymentId: "dep-001",
          toolId: "tool-git-commit",
          version: "1.0.0",
          state: "canary" as const,
          healthScore: 0.95,
          invocationCount: 100,
          errorCount: 2,
        },
      ],
    };

    const parsedReport = DeploymentStatusReportRequestSchema.parse(reportReq);
    expect(parsedReport.deployments[0].state).toBe("canary");

    const reportRes = {
      acknowledged: true,
      syncCommands: [
        {
          deploymentId: "dep-001",
          action: "promote" as const,
          targetState: "promoted" as const,
          reason: "Canary health score exceeded threshold",
        },
      ],
    };

    const parsedRes = DeploymentStatusReportResponseSchema.parse(reportRes);
    expect(parsedRes.syncCommands[0].action).toBe("promote");
  });

  it("validates telemetry batch and health negotiation schemas", () => {
    const teleReq = {
      batchId: "batch-tele-001",
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      timestamp: new Date().toISOString(),
      invocations: [],
      metrics: [
        {
          metricName: "daemon.cpu.usage",
          value: 12.5,
          unit: "percent",
          tags: { host: "dev-machine" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const parsedTele = TelemetryBatchRequestSchema.parse(teleReq);
    expect(parsedTele.metrics[0].metricName).toBe("daemon.cpu.usage");

    const healthReq = {
      clientVersion: "1.0.0",
      protocolVersion: "1.0.0",
      capabilities: ["observations", "catalog"],
      clientTime: new Date().toISOString(),
    };

    const parsedHealthReq = HealthNegotiateRequestSchema.parse(healthReq);
    expect(parsedHealthReq.clientVersion).toBe("1.0.0");

    const healthRes = {
      status: "healthy" as const,
      serverVersion: "1.0.0",
      protocolVersion: "1.0.0",
      minSupportedProtocolVersion: "1.0.0",
      supportedCapabilities: ["observations", "catalog", "deployments", "telemetry"],
      serverTime: new Date().toISOString(),
      clockSkewMs: 12,
    };

    const parsedHealthRes = HealthNegotiateResponseSchema.parse(healthRes);
    expect(parsedHealthRes.status).toBe("healthy");
    expect(parsedHealthRes.clockSkewMs).toBe(12);
  });
});
