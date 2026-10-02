import { describe, expect, it } from "vitest";
import {
  ArtifactDownloadMetadataSchema,
  ArtifactDownloadRequestSchema,
  CATALOG_CAPABILITIES_HEADER,
  CATALOG_CERTIFICATES_PATH,
  CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY,
  CatalogCertificatesResponseSchema,
  CatalogSnapshotRequestSchema,
  CatalogSnapshotResponseSchema,
  CatalogSnapshotResultSchema,
  CatalogSnapshotUnchangedResponseSchema,
  DeadLetterClassificationSchema,
  DeploymentStatusItemSchema,
  DeploymentStatusReportRequestSchema,
  DeploymentStatusReportResponseSchema,
  DeploymentSyncCommandSchema,
  HealthNegotiateRequestSchema,
  HealthNegotiateResponseSchema,
  InstallationRegisterRequestSchema,
  InstallationRegisterResponseSchema,
  MAX_CATALOG_CERTIFICATES,
  OPENAPI_V1_SPEC,
  ObservationBatchRequestSchema,
  ObservationBatchResponseSchema,
  PartialBatchErrorSchema,
  TelemetryBatchRequestSchema,
  TelemetryBatchResponseSchema,
  TelemetryMetricSchema,
  WorkspaceRegisterRequestSchema,
  WorkspaceRegisterResponseSchema,
  isCatalogSnapshotUnchanged,
  parseCatalogCapabilities,
} from "../src/index.js";

describe("Catalog snapshot unchanged contract", () => {
  const fullSnapshot = {
    snapshotVersion: "v7",
    generatedAt: "2026-09-01T00:00:00.000Z",
    checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    tools: [],
    activeDeployments: [],
  };

  it("names the capability header and token", () => {
    expect(CATALOG_CAPABILITIES_HEADER).toBe("x-resin-catalog-capabilities");
    expect(CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY).toBe("snapshot-unchanged-v1");
  });

  it("parses the capability list tolerantly", () => {
    expect(parseCatalogCapabilities(undefined).size).toBe(0);
    expect(parseCatalogCapabilities("").size).toBe(0);
    const tokens = parseCatalogCapabilities(" future-thing ,, SNAPSHOT-UNCHANGED-v1 ,");
    expect(tokens.has(CATALOG_SNAPSHOT_UNCHANGED_CAPABILITY)).toBe(true);
    expect(tokens.has("future-thing")).toBe(true);
    expect(tokens.has("")).toBe(false);
  });

  it("accepts exactly the unchanged marker", () => {
    const marker = { unchanged: true, snapshotVersion: "v7" };
    expect(CatalogSnapshotUnchangedResponseSchema.parse(marker)).toEqual(marker);
    expect(
      CatalogSnapshotUnchangedResponseSchema.safeParse({ ...marker, unchanged: false }).success,
    ).toBe(false);
    expect(
      CatalogSnapshotUnchangedResponseSchema.safeParse({ ...marker, snapshotVersion: "" }).success,
    ).toBe(false);
    expect(CatalogSnapshotUnchangedResponseSchema.safeParse({ ...marker, tools: [] }).success).toBe(
      false,
    );
    expect(CatalogSnapshotUnchangedResponseSchema.safeParse({ unchanged: true }).success).toBe(
      false,
    );
  });

  it("discriminates a full snapshot from the unchanged marker", () => {
    const unchanged = CatalogSnapshotResultSchema.parse({ unchanged: true, snapshotVersion: "v7" });
    expect(isCatalogSnapshotUnchanged(unchanged)).toBe(true);
    const full = CatalogSnapshotResultSchema.parse(fullSnapshot);
    expect(isCatalogSnapshotUnchanged(full)).toBe(false);
    expect(CatalogSnapshotResultSchema.safeParse({ snapshotVersion: "v7" }).success).toBe(false);
  });

  it("documents the header and the unchanged body on the snapshot route", () => {
    const route = OPENAPI_V1_SPEC.paths["/v1/catalog/snapshot"].get;
    expect(
      route.parameters.some((p) => p.name === CATALOG_CAPABILITIES_HEADER && p.in === "header"),
    ).toBe(true);
    const body = route.responses["200"].content["application/json"].schema;
    expect(JSON.stringify(body)).toContain("#/components/schemas/CatalogSnapshotUnchangedResponse");
    expect(OPENAPI_V1_SPEC.components.schemas.CatalogSnapshotUnchangedResponse.required).toEqual([
      "unchanged",
      "snapshotVersion",
    ]);
  });
});

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

describe("Catalog certificates contract", () => {
  const certificate = {
    schemaKind: "tool_certificate",
    schemaVersion: "1.0.0",
    certificateId: "0b9d2f0e-6a8b-4c39-9d43-5d0a3c1e7f21",
    accountId: "acc_123",
    workspaceId: "ws_456",
    toolId: "33333333-3333-4333-8333-333333333333",
    toolName: "calc_tool",
    version: "1.2.3",
    artifactDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    issuedAt: "2026-10-01T12:00:00.000Z",
    signature: {
      keyId: "production-tool-signing-2026-10",
      algorithm: "ed25519",
      signature: "c".repeat(128),
      signedAt: "2026-10-01T12:00:01.000Z",
    },
  };

  it("serves certificates from a dedicated, documented route", () => {
    expect(CATALOG_CERTIFICATES_PATH).toBe("/v1/catalog/certificates");
    const route = OPENAPI_V1_SPEC.paths[CATALOG_CERTIFICATES_PATH].get;
    expect(route.operationId).toBe("getCatalogCertificates");
    expect(Object.keys(route.responses)).toEqual(["200", "404"]);
  });

  it("parses a certificate list and rejects malformed or oversized lists", () => {
    expect(CatalogCertificatesResponseSchema.parse({ certificates: [certificate] })).toEqual({
      certificates: [certificate],
    });
    expect(CatalogCertificatesResponseSchema.parse({ certificates: [] }).certificates).toEqual([]);
    expect(
      CatalogCertificatesResponseSchema.safeParse({
        certificates: [{ ...certificate, signature: { ...certificate.signature, keyId: "" } }],
      }).success,
    ).toBe(false);
    expect(CatalogCertificatesResponseSchema.safeParse({}).success).toBe(false);
    expect(
      CatalogCertificatesResponseSchema.safeParse({
        certificates: Array.from({ length: MAX_CATALOG_CERTIFICATES + 1 }, () => certificate),
      }).success,
    ).toBe(false);
  });

  it("keeps the snapshot body tolerant of top-level fields a newer cloud adds", () => {
    const snapshot = {
      snapshotVersion: "v7",
      generatedAt: "2026-09-01T00:00:00.000Z",
      checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tools: [],
      activeDeployments: [],
    };
    const parsed = CatalogSnapshotResultSchema.parse({ ...snapshot, certificates: [certificate] });
    expect(parsed).toEqual(snapshot);
  });
});
