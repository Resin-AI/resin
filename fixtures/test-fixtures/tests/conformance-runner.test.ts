import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMA_REGISTRY,
  runConformanceCli,
  runConformanceSuite,
  validateContractPayload,
  validateDomainPayload,
  validateHarnessPayload,
  validateProtocolPayload,
} from "../src/conformance-runner.js";
import {
  allValidDomainEvents,
  invalidDomainFixtures,
  validAuditRecord,
  validCapabilityEnvelope,
  validCapabilityGrant,
  validCatalogSnapshot,
  validDeadLetterRecord,
  validDeploymentRecord,
  validDeviceRecord,
  validInstallationRecord,
  validInvocationRecord,
  validMessageEvent,
  validSyncCursor,
  validTelemetryRecord,
  validToolManifest,
  validToolVersion,
  validWorkspaceRecord,
} from "../src/golden/domain.js";
import {
  invalidHarnessFixtures,
  validAdapterCapabilities,
  validCatalogChangeSummary,
  validConfigBackup,
  validConfigMutationPlan,
  validHarnessInstallation,
  validHarnessSession,
  validHarnessWorkspace,
  validRawHarnessRecord,
  validRefreshResult,
  validSourceCursor,
} from "../src/golden/harness.js";
import {
  allValidStreamMessages,
  invalidProtocolFixtures,
  validArtifactDownloadMetadata,
  validArtifactDownloadRequest,
  validCatalogSnapshotRequest,
  validCatalogSnapshotResponse,
  validDeploymentStatusReportRequest,
  validDeploymentStatusReportResponse,
  validDeviceAuthBootstrapRequest,
  validDeviceAuthBootstrapResponse,
  validDeviceRevocationRequest,
  validDeviceRevocationResponse,
  validDeviceTokenExchangeRequest,
  validDeviceTokenExchangeResponse,
  validHealthNegotiateRequest,
  validHealthNegotiateResponse,
  validInstallationRegisterRequest,
  validInstallationRegisterResponse,
  validObservationBatchRequest,
  validObservationBatchResponse,
  validProtocolEnvelope,
  validProtocolErrorResponse,
  validStreamAckMessage,
  validStreamHeartbeatMessage,
  validStreamResyncMessage,
  validStreamServerHeartbeatAckMessage,
  validTelemetryBatchRequest,
  validTelemetryBatchResponse,
  validTokenRotationRequest,
  validTokenRotationResponse,
  validWorkspaceRegisterRequest,
  validWorkspaceRegisterResponse,
} from "../src/golden/protocol.js";

describe("Conformance Runner & Contract Validation Engine", () => {
  describe("Master Schema Registry", () => {
    it("registers all expected contract types", () => {
      expect(CONTRACT_SCHEMA_REGISTRY.NormalizedSessionEvent).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.ToolManifest).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.CapabilityEnvelope).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.DeploymentRecord).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.ProtocolMessageEnvelope).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.StreamMessage).toBeDefined();
      expect(CONTRACT_SCHEMA_REGISTRY.HarnessInstallation).toBeDefined();
    });

    it("returns an error for unregistered contract types", () => {
      const result = validateContractPayload("NonExistentContract", {});
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].code).toBe("UNKNOWN_CONTRACT_TYPE");
    });
  });

  describe("Domain Payloads Validation (TE-003)", () => {
    it("validates all normalized session events", () => {
      for (const event of allValidDomainEvents) {
        const res = validateDomainPayload("NormalizedSessionEvent", event);
        expect(res.valid, `Event ${event.type} should be valid`).toBe(true);
        expect(res.data).toBeDefined();
      }
    });

    it("validates individual domain record models", () => {
      expect(validateDomainPayload("ToolManifest", validToolManifest).valid).toBe(true);
      expect(validateDomainPayload("ToolVersion", validToolVersion).valid).toBe(true);
      expect(validateDomainPayload("CatalogSnapshot", validCatalogSnapshot).valid).toBe(true);
      expect(validateDomainPayload("CapabilityGrant", validCapabilityGrant).valid).toBe(true);
      expect(validateDomainPayload("CapabilityEnvelope", validCapabilityEnvelope).valid).toBe(true);
      expect(validateDomainPayload("DeploymentRecord", validDeploymentRecord).valid).toBe(true);
      expect(validateDomainPayload("WorkspaceRecord", validWorkspaceRecord).valid).toBe(true);
      expect(validateDomainPayload("DeviceRecord", validDeviceRecord).valid).toBe(true);
      expect(validateDomainPayload("InstallationRecord", validInstallationRecord).valid).toBe(true);
      expect(validateDomainPayload("InvocationRecord", validInvocationRecord).valid).toBe(true);
      expect(validateDomainPayload("TelemetryRecord", validTelemetryRecord).valid).toBe(true);
      expect(validateDomainPayload("AuditRecord", validAuditRecord).valid).toBe(true);
      expect(validateDomainPayload("DeadLetterRecord", validDeadLetterRecord).valid).toBe(true);
      expect(validateDomainPayload("SyncCursor", validSyncCursor).valid).toBe(true);
    });

    it("detects and reports errors on invalid domain payloads", () => {
      const missingType = validateDomainPayload(
        "NormalizedSessionEvent",
        invalidDomainFixtures.missingEventType,
      );
      expect(missingType.valid).toBe(false);
      expect(missingType.errors && missingType.errors.length > 0).toBe(true);

      const badManifest = validateDomainPayload(
        "ToolManifest",
        invalidDomainFixtures.invalidToolManifestVersion,
      );
      expect(badManifest.valid).toBe(false);
    });
  });

  describe("Protocol Payloads Validation (TE-004)", () => {
    it("validates protocol message envelope and error responses", () => {
      expect(validateProtocolPayload("ProtocolMessageEnvelope", validProtocolEnvelope).valid).toBe(
        true,
      );
      expect(
        validateProtocolPayload("ProtocolErrorResponse", validProtocolErrorResponse).valid,
      ).toBe(true);
    });

    it("validates auth endpoints and token lifecycle payloads", () => {
      expect(
        validateProtocolPayload("DeviceAuthBootstrapRequest", validDeviceAuthBootstrapRequest)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeviceAuthBootstrapResponse", validDeviceAuthBootstrapResponse)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeviceTokenExchangeRequest", validDeviceTokenExchangeRequest)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeviceTokenExchangeResponse", validDeviceTokenExchangeResponse)
          .valid,
      ).toBe(true);
      expect(validateProtocolPayload("TokenRotationRequest", validTokenRotationRequest).valid).toBe(
        true,
      );
      expect(
        validateProtocolPayload("TokenRotationResponse", validTokenRotationResponse).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeviceRevocationRequest", validDeviceRevocationRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeviceRevocationResponse", validDeviceRevocationResponse).valid,
      ).toBe(true);
    });

    it("validates HTTP API requests and responses", () => {
      expect(
        validateProtocolPayload("InstallationRegisterRequest", validInstallationRegisterRequest)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("InstallationRegisterResponse", validInstallationRegisterResponse)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("WorkspaceRegisterRequest", validWorkspaceRegisterRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("WorkspaceRegisterResponse", validWorkspaceRegisterResponse).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("ObservationBatchRequest", validObservationBatchRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("ObservationBatchResponse", validObservationBatchResponse).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("CatalogSnapshotRequest", validCatalogSnapshotRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("CatalogSnapshotResponse", validCatalogSnapshotResponse).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("ArtifactDownloadRequest", validArtifactDownloadRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("ArtifactDownloadMetadata", validArtifactDownloadMetadata).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("DeploymentStatusReportRequest", validDeploymentStatusReportRequest)
          .valid,
      ).toBe(true);
      expect(
        validateProtocolPayload(
          "DeploymentStatusReportResponse",
          validDeploymentStatusReportResponse,
        ).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("TelemetryBatchRequest", validTelemetryBatchRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("TelemetryBatchResponse", validTelemetryBatchResponse).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("HealthNegotiateRequest", validHealthNegotiateRequest).valid,
      ).toBe(true);
      expect(
        validateProtocolPayload("HealthNegotiateResponse", validHealthNegotiateResponse).valid,
      ).toBe(true);
    });

    it("validates control stream messages", () => {
      for (const msg of allValidStreamMessages) {
        expect(
          validateProtocolPayload("StreamMessage", msg).valid,
          `Message ${msg.messageId} should be valid`,
        ).toBe(true);
      }
    });

    it("detects and rejects invalid protocol payloads", () => {
      expect(
        validateProtocolPayload(
          "ProtocolMessageEnvelope",
          invalidProtocolFixtures.missingPayloadTypeEnvelope,
        ).valid,
      ).toBe(false);
      expect(
        validateProtocolPayload(
          "StreamMessage",
          invalidProtocolFixtures.negativeSequenceStreamMessage,
        ).valid,
      ).toBe(false);
      expect(
        validateProtocolPayload("StreamMessage", invalidProtocolFixtures.unknownStreamMessageType)
          .valid,
      ).toBe(false);
    });
  });

  describe("Harness Adapter Contracts Validation (TE-005)", () => {
    it("validates all harness adapter contract payloads", () => {
      expect(validateHarnessPayload("HarnessInstallation", validHarnessInstallation).valid).toBe(
        true,
      );
      expect(validateHarnessPayload("HarnessSession", validHarnessSession).valid).toBe(true);
      expect(validateHarnessPayload("HarnessWorkspace", validHarnessWorkspace).valid).toBe(true);
      expect(validateHarnessPayload("RawHarnessRecord", validRawHarnessRecord).valid).toBe(true);
      expect(validateHarnessPayload("SourceCursor", validSourceCursor).valid).toBe(true);
      expect(validateHarnessPayload("ConfigBackup", validConfigBackup).valid).toBe(true);
      expect(validateHarnessPayload("ConfigMutationPlan", validConfigMutationPlan).valid).toBe(
        true,
      );
      expect(validateHarnessPayload("CatalogChangeSummary", validCatalogChangeSummary).valid).toBe(
        true,
      );
      expect(validateHarnessPayload("AdapterCapabilities", validAdapterCapabilities).valid).toBe(
        true,
      );
      expect(validateHarnessPayload("RefreshResult", validRefreshResult).valid).toBe(true);
    });

    it("detects and rejects invalid harness payloads", () => {
      expect(
        validateHarnessPayload(
          "HarnessInstallation",
          invalidHarnessFixtures.invalidInstallationBadStatus,
        ).valid,
      ).toBe(false);
      expect(
        validateHarnessPayload(
          "HarnessSession",
          invalidHarnessFixtures.invalidSessionMissingHarness,
        ).valid,
      ).toBe(false);
      expect(
        validateHarnessPayload(
          "RawHarnessRecord",
          invalidHarnessFixtures.invalidRawRecordNegativeSequence,
        ).valid,
      ).toBe(false);
      expect(
        validateHarnessPayload(
          "AdapterCapabilities",
          invalidHarnessFixtures.invalidAdapterBadFidelity,
        ).valid,
      ).toBe(false);
    });
  });

  describe("Full Conformance Suite Execution", () => {
    it("runs complete suite and reports 100% pass", async () => {
      const report = await runConformanceSuite();
      expect(report.passed).toBe(true);
      expect(report.failedTests).toBe(0);
      expect(report.totalTests).toBeGreaterThan(40);
      expect(report.categories.domain.passed).toBe(report.categories.domain.total);
      expect(report.categories.protocol.passed).toBe(report.categories.protocol.total);
      expect(report.categories.harness.passed).toBe(report.categories.harness.total);
    });

    it("supports category filtering", async () => {
      const domainReport = await runConformanceSuite({ categories: ["domain"] });
      expect(domainReport.passed).toBe(true);
      expect(domainReport.categories.domain.total).toBeGreaterThan(0);
      expect(domainReport.categories.protocol.total).toBe(0);
      expect(domainReport.categories.harness.total).toBe(0);
    });

    it("executes CLI runner cleanly with exit code 0", async () => {
      const exitCode = await runConformanceCli(["--all", "--json"]);
      expect(exitCode).toBe(0);
    });
  });
});
