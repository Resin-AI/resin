import {
  AuditRecordSchema,
  CapabilityEnvelopeSchema,
  CapabilityGrantSchema,
  CatalogSnapshotSchema,
  DeadLetterRecordSchema,
  DeploymentRecordSchema,
  DeviceRecordSchema,
  InstallationRecordSchema,
  InvocationRecordSchema,
  NormalizedBranchForkEventSchema,
  NormalizedCommandExecEventSchema,
  NormalizedCompactionEventSchema,
  NormalizedErrorEventSchema,
  NormalizedFileEditEventSchema,
  NormalizedMessageEventSchema,
  NormalizedModelReasoningEventSchema,
  NormalizedSessionEventSchema,
  NormalizedSessionLifecycleEventSchema,
  NormalizedSubagentLifecycleEventSchema,
  NormalizedToolCallEventSchema,
  NormalizedToolDiscoveryEventSchema,
  NormalizedToolResultEventSchema,
  NormalizedUnknownPassthroughEventSchema,
  SyncCursorSchema,
  TelemetryRecordSchema,
  ToolManifestSchema,
  ToolVersionSchema,
  WorkspaceRecordSchema,
} from "@resin/contracts";
import {
  AdapterCapabilitiesSchema,
  CatalogChangeSummarySchema,
  ConfigBackupSchema,
  ConfigMutationPlanSchema,
  HarnessInstallationSchema,
  HarnessSessionSchema,
  HarnessWorkspaceSchema,
  RawHarnessRecordSchema,
  RefreshResultSchema,
  SourceCursorSchema,
} from "@resin/harness-contracts";
import {
  ArtifactDownloadMetadataSchema,
  ArtifactDownloadRequestSchema,
  CatalogSnapshotRequestSchema,
  CatalogSnapshotResponseSchema,
  DeploymentStatusReportRequestSchema,
  DeploymentStatusReportResponseSchema,
  DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponseSchema,
  DeviceRevocationRequestSchema,
  DeviceRevocationResponseSchema,
  DeviceTokenExchangeRequestSchema,
  DeviceTokenExchangeResponseSchema,
  HealthNegotiateRequestSchema,
  HealthNegotiateResponseSchema,
  InstallationRegisterRequestSchema,
  InstallationRegisterResponseSchema,
  ObservationBatchRequestSchema,
  ObservationBatchResponseSchema,
  ProtocolErrorResponseSchema,
  ProtocolMessageEnvelopeSchema,
  StreamAckSchema,
  StreamClientHeartbeatSchema,
  StreamMessageSchema,
  StreamResyncRequestSchema,
  StreamServerHeartbeatAckSchema,
  TelemetryBatchRequestSchema,
  TelemetryBatchResponseSchema,
  TokenRotationRequestSchema,
  TokenRotationResponseSchema,
  WorkspaceRegisterRequestSchema,
  WorkspaceRegisterResponseSchema,
} from "@resin/protocol";
import type { ZodError, ZodIssue, z } from "zod";
import * as goldenDomain from "./golden/domain.js";
import * as goldenHarness from "./golden/harness.js";
import * as goldenProtocol from "./golden/protocol.js";

/**
 * Conformance & Contract Validation Engine
 *
 * Validates domain payloads, protocol HTTP/stream envelopes, and harness adapter contracts.
 * Exposes API runner and CLI executable runner.
 */

// ============================================================================
// Types & Schema Registry
// ============================================================================

export interface ValidationErrorDetail {
  path: string;
  message: string;
  code: string;
  received?: unknown;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  contractType: string;
  data?: T;
  errors?: ValidationErrorDetail[];
}

export interface ConformanceTestCaseResult {
  name: string;
  contractType: string;
  category: "domain" | "protocol" | "harness";
  expectedValid: boolean;
  passed: boolean;
  durationMs: number;
  errors?: ValidationErrorDetail[];
}

export interface ConformanceSuiteReport {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
  results: ConformanceTestCaseResult[];
  categories: {
    domain: { total: number; passed: number; failed: number };
    protocol: { total: number; passed: number; failed: number };
    harness: { total: number; passed: number; failed: number };
  };
}

export interface ConformanceSuiteOptions {
  categories?: Array<"domain" | "protocol" | "harness">;
  includeNegativeTests?: boolean;
  verbose?: boolean;
}

// Master schema registry
interface ContractSchemaRegistry {
  [contractType: string]: z.ZodTypeAny;
}

export const CONTRACT_SCHEMA_REGISTRY: ContractSchemaRegistry = {
  // Domain - Events
  NormalizedSessionEvent: NormalizedSessionEventSchema,
  NormalizedMessageEvent: NormalizedMessageEventSchema,
  NormalizedModelReasoningEvent: NormalizedModelReasoningEventSchema,
  NormalizedToolDiscoveryEvent: NormalizedToolDiscoveryEventSchema,
  NormalizedToolCallEvent: NormalizedToolCallEventSchema,
  NormalizedToolResultEvent: NormalizedToolResultEventSchema,
  NormalizedCommandExecEvent: NormalizedCommandExecEventSchema,
  NormalizedFileEditEvent: NormalizedFileEditEventSchema,
  NormalizedErrorEvent: NormalizedErrorEventSchema,
  NormalizedCompactionEvent: NormalizedCompactionEventSchema,
  NormalizedBranchForkEvent: NormalizedBranchForkEventSchema,
  NormalizedSubagentLifecycleEvent: NormalizedSubagentLifecycleEventSchema,
  NormalizedSessionLifecycleEvent: NormalizedSessionLifecycleEventSchema,
  NormalizedUnknownPassthroughEvent: NormalizedUnknownPassthroughEventSchema,

  // Domain - Tools & Artifacts
  ToolManifest: ToolManifestSchema,
  ToolVersion: ToolVersionSchema,
  CatalogSnapshot: CatalogSnapshotSchema,

  // Domain - Capabilities & Grants
  CapabilityGrant: CapabilityGrantSchema,
  CapabilityEnvelope: CapabilityEnvelopeSchema,

  // Domain - Deployment
  DeploymentRecord: DeploymentRecordSchema,

  // Domain - Records
  WorkspaceRecord: WorkspaceRecordSchema,
  DeviceRecord: DeviceRecordSchema,
  InstallationRecord: InstallationRecordSchema,
  InvocationRecord: InvocationRecordSchema,
  TelemetryRecord: TelemetryRecordSchema,
  AuditRecord: AuditRecordSchema,
  DeadLetterRecord: DeadLetterRecordSchema,
  SyncCursor: SyncCursorSchema,

  // Protocol - Envelopes & Auth
  ProtocolMessageEnvelope: ProtocolMessageEnvelopeSchema,
  ProtocolErrorResponse: ProtocolErrorResponseSchema,
  DeviceAuthBootstrapRequest: DeviceAuthBootstrapRequestSchema,
  DeviceAuthBootstrapResponse: DeviceAuthBootstrapResponseSchema,
  DeviceTokenExchangeRequest: DeviceTokenExchangeRequestSchema,
  DeviceTokenExchangeResponse: DeviceTokenExchangeResponseSchema,
  TokenRotationRequest: TokenRotationRequestSchema,
  TokenRotationResponse: TokenRotationResponseSchema,
  DeviceRevocationRequest: DeviceRevocationRequestSchema,
  DeviceRevocationResponse: DeviceRevocationResponseSchema,

  // Protocol - HTTP Payloads
  InstallationRegisterRequest: InstallationRegisterRequestSchema,
  InstallationRegisterResponse: InstallationRegisterResponseSchema,
  WorkspaceRegisterRequest: WorkspaceRegisterRequestSchema,
  WorkspaceRegisterResponse: WorkspaceRegisterResponseSchema,
  ObservationBatchRequest: ObservationBatchRequestSchema,
  ObservationBatchResponse: ObservationBatchResponseSchema,
  CatalogSnapshotRequest: CatalogSnapshotRequestSchema,
  CatalogSnapshotResponse: CatalogSnapshotResponseSchema,
  ArtifactDownloadRequest: ArtifactDownloadRequestSchema,
  ArtifactDownloadMetadata: ArtifactDownloadMetadataSchema,
  DeploymentStatusReportRequest: DeploymentStatusReportRequestSchema,
  DeploymentStatusReportResponse: DeploymentStatusReportResponseSchema,
  TelemetryBatchRequest: TelemetryBatchRequestSchema,
  TelemetryBatchResponse: TelemetryBatchResponseSchema,
  HealthNegotiateRequest: HealthNegotiateRequestSchema,
  HealthNegotiateResponse: HealthNegotiateResponseSchema,

  // Protocol - Stream Messages
  StreamMessage: StreamMessageSchema,
  StreamClientHeartbeat: StreamClientHeartbeatSchema,
  StreamAck: StreamAckSchema,
  StreamResyncRequest: StreamResyncRequestSchema,
  StreamServerHeartbeatAck: StreamServerHeartbeatAckSchema,

  // Harness - Adapter & Config
  HarnessInstallation: HarnessInstallationSchema,
  HarnessSession: HarnessSessionSchema,
  HarnessWorkspace: HarnessWorkspaceSchema,
  RawHarnessRecord: RawHarnessRecordSchema,
  SourceCursor: SourceCursorSchema,
  ConfigBackup: ConfigBackupSchema,
  ConfigMutationPlan: ConfigMutationPlanSchema,
  CatalogChangeSummary: CatalogChangeSummarySchema,
  AdapterCapabilities: AdapterCapabilitiesSchema,
  RefreshResult: RefreshResultSchema,
};

export type ConformancePayloadValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ConformancePayloadRecord
  | ConformancePayloadValue[];

export interface ConformancePayloadRecord {
  [key: string]: ConformancePayloadValue;
}
// ============================================================================
// Core Validation Functions
// ============================================================================

function mapZodIssues(issues: ZodIssue[]): ValidationErrorDetail[] {
  return issues.map((i) => ({
    path: i.path.join(".") || "$",
    message: i.message,
    code: i.code,
    received: "received" in i ? i.received : undefined,
  }));
}

/**
 * Validate any payload against a registered contract type name.
 */
export function validateContractPayload<
  T = ConformancePayloadValue,
  TPayload = ConformancePayloadValue,
>(contractType: string, payload: TPayload): ValidationResult<T> {
  const schema = CONTRACT_SCHEMA_REGISTRY[contractType];
  if (!schema) {
    return {
      valid: false,
      contractType,
      errors: [
        {
          path: "$",
          message: `Unknown contract type: "${contractType}"`,
          code: "UNKNOWN_CONTRACT_TYPE",
        },
      ],
    };
  }

  const parseResult = schema.safeParse(payload);
  if (parseResult.success) {
    return {
      valid: true,
      contractType,
      // SAFETY: Validated schema output is cast to expected contract type T.
      data: parseResult.data as T,
    };
  }

  return {
    valid: false,
    contractType,
    errors: mapZodIssues(parseResult.error.issues),
  };
}

/**
 * Validate a domain contract payload (TE-003).
 */
export function validateDomainPayload<
  T = ConformancePayloadValue,
  TPayload = ConformancePayloadValue,
>(contractType: string, payload: TPayload): ValidationResult<T> {
  return validateContractPayload<T, TPayload>(contractType, payload);
}

/**
 * Validate a protocol HTTP or stream envelope payload (TE-004).
 */
export function validateProtocolPayload<
  T = ConformancePayloadValue,
  TPayload = ConformancePayloadValue,
>(contractType: string, payload: TPayload): ValidationResult<T> {
  return validateContractPayload<T, TPayload>(contractType, payload);
}

/**
 * Validate a harness adapter contract payload (TE-005).
 */
export function validateHarnessPayload<
  T = ConformancePayloadValue,
  TPayload = ConformancePayloadValue,
>(contractType: string, payload: TPayload): ValidationResult<T> {
  return validateContractPayload<T, TPayload>(contractType, payload);
}

// ============================================================================
// Conformance Test Suite Runner
// ============================================================================

interface TestCaseDef {
  name: string;
  contractType: string;
  category: "domain" | "protocol" | "harness";
  payload: unknown;
  expectedValid: boolean;
}

function buildTestCases(includeNegative = true): TestCaseDef[] {
  const cases: TestCaseDef[] = [
    // --- Domain Valid Tests ---
    {
      name: "valid_message_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validMessageEvent,
      expectedValid: true,
    },
    {
      name: "valid_model_reasoning_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validModelReasoningEvent,
      expectedValid: true,
    },
    {
      name: "valid_tool_discovery_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validToolDiscoveryEvent,
      expectedValid: true,
    },
    {
      name: "valid_tool_call_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validToolCallEvent,
      expectedValid: true,
    },
    {
      name: "valid_tool_result_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validToolResultEvent,
      expectedValid: true,
    },
    {
      name: "valid_command_exec_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validCommandExecEvent,
      expectedValid: true,
    },
    {
      name: "valid_file_edit_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validFileEditEvent,
      expectedValid: true,
    },
    {
      name: "valid_error_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validErrorEvent,
      expectedValid: true,
    },
    {
      name: "valid_compaction_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validCompactionEvent,
      expectedValid: true,
    },
    {
      name: "valid_branch_fork_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validBranchForkEvent,
      expectedValid: true,
    },
    {
      name: "valid_subagent_lifecycle_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validSubagentLifecycleEvent,
      expectedValid: true,
    },
    {
      name: "valid_session_lifecycle_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validSessionLifecycleEvent,
      expectedValid: true,
    },
    {
      name: "valid_unknown_passthrough_event",
      contractType: "NormalizedSessionEvent",
      category: "domain",
      payload: goldenDomain.validUnknownPassthroughEvent,
      expectedValid: true,
    },
    {
      name: "valid_tool_manifest",
      contractType: "ToolManifest",
      category: "domain",
      payload: goldenDomain.validToolManifest,
      expectedValid: true,
    },
    {
      name: "valid_tool_version",
      contractType: "ToolVersion",
      category: "domain",
      payload: goldenDomain.validToolVersion,
      expectedValid: true,
    },
    {
      name: "valid_catalog_snapshot",
      contractType: "CatalogSnapshot",
      category: "domain",
      payload: goldenDomain.validCatalogSnapshot,
      expectedValid: true,
    },
    {
      name: "valid_capability_envelope",
      contractType: "CapabilityEnvelope",
      category: "domain",
      payload: goldenDomain.validCapabilityEnvelope,
      expectedValid: true,
    },
    {
      name: "valid_deployment_record",
      contractType: "DeploymentRecord",
      category: "domain",
      payload: goldenDomain.validDeploymentRecord,
      expectedValid: true,
    },
    {
      name: "valid_workspace_record",
      contractType: "WorkspaceRecord",
      category: "domain",
      payload: goldenDomain.validWorkspaceRecord,
      expectedValid: true,
    },
    {
      name: "valid_device_record",
      contractType: "DeviceRecord",
      category: "domain",
      payload: goldenDomain.validDeviceRecord,
      expectedValid: true,
    },
    {
      name: "valid_installation_record",
      contractType: "InstallationRecord",
      category: "domain",
      payload: goldenDomain.validInstallationRecord,
      expectedValid: true,
    },
    {
      name: "valid_invocation_record",
      contractType: "InvocationRecord",
      category: "domain",
      payload: goldenDomain.validInvocationRecord,
      expectedValid: true,
    },
    {
      name: "valid_telemetry_record",
      contractType: "TelemetryRecord",
      category: "domain",
      payload: goldenDomain.validTelemetryRecord,
      expectedValid: true,
    },
    {
      name: "valid_audit_record",
      contractType: "AuditRecord",
      category: "domain",
      payload: goldenDomain.validAuditRecord,
      expectedValid: true,
    },
    {
      name: "valid_dead_letter_record",
      contractType: "DeadLetterRecord",
      category: "domain",
      payload: goldenDomain.validDeadLetterRecord,
      expectedValid: true,
    },
    {
      name: "valid_sync_cursor",
      contractType: "SyncCursor",
      category: "domain",
      payload: goldenDomain.validSyncCursor,
      expectedValid: true,
    },

    // --- Protocol Valid Tests ---
    {
      name: "valid_protocol_envelope",
      contractType: "ProtocolMessageEnvelope",
      category: "protocol",
      payload: goldenProtocol.validProtocolEnvelope,
      expectedValid: true,
    },
    {
      name: "valid_device_auth_bootstrap_request",
      contractType: "DeviceAuthBootstrapRequest",
      category: "protocol",
      payload: goldenProtocol.validDeviceAuthBootstrapRequest,
      expectedValid: true,
    },
    {
      name: "valid_device_auth_bootstrap_response",
      contractType: "DeviceAuthBootstrapResponse",
      category: "protocol",
      payload: goldenProtocol.validDeviceAuthBootstrapResponse,
      expectedValid: true,
    },
    {
      name: "valid_device_token_exchange_request",
      contractType: "DeviceTokenExchangeRequest",
      category: "protocol",
      payload: goldenProtocol.validDeviceTokenExchangeRequest,
      expectedValid: true,
    },
    {
      name: "valid_device_token_exchange_response",
      contractType: "DeviceTokenExchangeResponse",
      category: "protocol",
      payload: goldenProtocol.validDeviceTokenExchangeResponse,
      expectedValid: true,
    },
    {
      name: "valid_token_rotation_request",
      contractType: "TokenRotationRequest",
      category: "protocol",
      payload: goldenProtocol.validTokenRotationRequest,
      expectedValid: true,
    },
    {
      name: "valid_token_rotation_response",
      contractType: "TokenRotationResponse",
      category: "protocol",
      payload: goldenProtocol.validTokenRotationResponse,
      expectedValid: true,
    },
    {
      name: "valid_device_revocation_request",
      contractType: "DeviceRevocationRequest",
      category: "protocol",
      payload: goldenProtocol.validDeviceRevocationRequest,
      expectedValid: true,
    },
    {
      name: "valid_device_revocation_response",
      contractType: "DeviceRevocationResponse",
      category: "protocol",
      payload: goldenProtocol.validDeviceRevocationResponse,
      expectedValid: true,
    },
    {
      name: "valid_installation_register_request",
      contractType: "InstallationRegisterRequest",
      category: "protocol",
      payload: goldenProtocol.validInstallationRegisterRequest,
      expectedValid: true,
    },
    {
      name: "valid_installation_register_response",
      contractType: "InstallationRegisterResponse",
      category: "protocol",
      payload: goldenProtocol.validInstallationRegisterResponse,
      expectedValid: true,
    },
    {
      name: "valid_workspace_register_request",
      contractType: "WorkspaceRegisterRequest",
      category: "protocol",
      payload: goldenProtocol.validWorkspaceRegisterRequest,
      expectedValid: true,
    },
    {
      name: "valid_workspace_register_response",
      contractType: "WorkspaceRegisterResponse",
      category: "protocol",
      payload: goldenProtocol.validWorkspaceRegisterResponse,
      expectedValid: true,
    },
    {
      name: "valid_observation_batch_request",
      contractType: "ObservationBatchRequest",
      category: "protocol",
      payload: goldenProtocol.validObservationBatchRequest,
      expectedValid: true,
    },
    {
      name: "valid_observation_batch_response",
      contractType: "ObservationBatchResponse",
      category: "protocol",
      payload: goldenProtocol.validObservationBatchResponse,
      expectedValid: true,
    },
    {
      name: "valid_catalog_snapshot_request",
      contractType: "CatalogSnapshotRequest",
      category: "protocol",
      payload: goldenProtocol.validCatalogSnapshotRequest,
      expectedValid: true,
    },
    {
      name: "valid_catalog_snapshot_response",
      contractType: "CatalogSnapshotResponse",
      category: "protocol",
      payload: goldenProtocol.validCatalogSnapshotResponse,
      expectedValid: true,
    },
    {
      name: "valid_artifact_download_request",
      contractType: "ArtifactDownloadRequest",
      category: "protocol",
      payload: goldenProtocol.validArtifactDownloadRequest,
      expectedValid: true,
    },
    {
      name: "valid_artifact_download_metadata",
      contractType: "ArtifactDownloadMetadata",
      category: "protocol",
      payload: goldenProtocol.validArtifactDownloadMetadata,
      expectedValid: true,
    },
    {
      name: "valid_deployment_status_report_request",
      contractType: "DeploymentStatusReportRequest",
      category: "protocol",
      payload: goldenProtocol.validDeploymentStatusReportRequest,
      expectedValid: true,
    },
    {
      name: "valid_deployment_status_report_response",
      contractType: "DeploymentStatusReportResponse",
      category: "protocol",
      payload: goldenProtocol.validDeploymentStatusReportResponse,
      expectedValid: true,
    },
    {
      name: "valid_telemetry_batch_request",
      contractType: "TelemetryBatchRequest",
      category: "protocol",
      payload: goldenProtocol.validTelemetryBatchRequest,
      expectedValid: true,
    },
    {
      name: "valid_telemetry_batch_response",
      contractType: "TelemetryBatchResponse",
      category: "protocol",
      payload: goldenProtocol.validTelemetryBatchResponse,
      expectedValid: true,
    },
    {
      name: "valid_health_negotiate_request",
      contractType: "HealthNegotiateRequest",
      category: "protocol",
      payload: goldenProtocol.validHealthNegotiateRequest,
      expectedValid: true,
    },
    {
      name: "valid_health_negotiate_response",
      contractType: "HealthNegotiateResponse",
      category: "protocol",
      payload: goldenProtocol.validHealthNegotiateResponse,
      expectedValid: true,
    },
    {
      name: "valid_stream_heartbeat_message",
      contractType: "StreamMessage",
      category: "protocol",
      payload: goldenProtocol.validStreamHeartbeatMessage,
      expectedValid: true,
    },
    {
      name: "valid_stream_ack_message",
      contractType: "StreamMessage",
      category: "protocol",
      payload: goldenProtocol.validStreamAckMessage,
      expectedValid: true,
    },
    {
      name: "valid_stream_resync_message",
      contractType: "StreamMessage",
      category: "protocol",
      payload: goldenProtocol.validStreamResyncMessage,
      expectedValid: true,
    },
    {
      name: "valid_stream_server_hb_ack_message",
      contractType: "StreamMessage",
      category: "protocol",
      payload: goldenProtocol.validStreamServerHeartbeatAckMessage,
      expectedValid: true,
    },

    // --- Harness Valid Tests ---
    {
      name: "valid_harness_installation",
      contractType: "HarnessInstallation",
      category: "harness",
      payload: goldenHarness.validHarnessInstallation,
      expectedValid: true,
    },
    {
      name: "valid_harness_session",
      contractType: "HarnessSession",
      category: "harness",
      payload: goldenHarness.validHarnessSession,
      expectedValid: true,
    },
    {
      name: "valid_harness_workspace",
      contractType: "HarnessWorkspace",
      category: "harness",
      payload: goldenHarness.validHarnessWorkspace,
      expectedValid: true,
    },
    {
      name: "valid_raw_harness_record",
      contractType: "RawHarnessRecord",
      category: "harness",
      payload: goldenHarness.validRawHarnessRecord,
      expectedValid: true,
    },
    {
      name: "valid_source_cursor",
      contractType: "SourceCursor",
      category: "harness",
      payload: goldenHarness.validSourceCursor,
      expectedValid: true,
    },
    {
      name: "valid_config_backup",
      contractType: "ConfigBackup",
      category: "harness",
      payload: goldenHarness.validConfigBackup,
      expectedValid: true,
    },
    {
      name: "valid_config_mutation_plan",
      contractType: "ConfigMutationPlan",
      category: "harness",
      payload: goldenHarness.validConfigMutationPlan,
      expectedValid: true,
    },
    {
      name: "valid_catalog_change_summary",
      contractType: "CatalogChangeSummary",
      category: "harness",
      payload: goldenHarness.validCatalogChangeSummary,
      expectedValid: true,
    },
    {
      name: "valid_adapter_capabilities",
      contractType: "AdapterCapabilities",
      category: "harness",
      payload: goldenHarness.validAdapterCapabilities,
      expectedValid: true,
    },
    {
      name: "valid_refresh_result",
      contractType: "RefreshResult",
      category: "harness",
      payload: goldenHarness.validRefreshResult,
      expectedValid: true,
    },
  ];

  if (includeNegative) {
    // --- Domain Invalid Negative Tests ---
    cases.push(
      {
        name: "invalid_missing_event_type",
        contractType: "NormalizedSessionEvent",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.missingEventType,
        expectedValid: false,
      },
      {
        name: "invalid_timestamp_format",
        contractType: "NormalizedSessionEvent",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidTimestamp,
        expectedValid: false,
      },
      {
        name: "invalid_tool_call_missing_call_id",
        contractType: "NormalizedSessionEvent",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidToolCallMissingCallId,
        expectedValid: false,
      },
      {
        name: "invalid_tool_manifest_semver",
        contractType: "ToolManifest",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidToolManifestVersion,
        expectedValid: false,
      },
      {
        name: "invalid_tool_manifest_empty_id",
        contractType: "ToolManifest",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidToolManifestEmptyId,
        expectedValid: false,
      },
      {
        name: "invalid_deployment_bad_state",
        contractType: "DeploymentRecord",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidDeploymentBadState,
        expectedValid: false,
      },
      {
        name: "invalid_workspace_missing_path",
        contractType: "WorkspaceRecord",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidWorkspaceMissingPath,
        expectedValid: false,
      },
      {
        name: "invalid_digest_wrong_length",
        contractType: "ToolVersion",
        category: "domain",
        payload: goldenDomain.invalidDomainFixtures.invalidDigestWrongLength,
        expectedValid: false,
      },
    );

    // --- Protocol Invalid Negative Tests ---
    cases.push(
      {
        name: "invalid_envelope_missing_payload_type",
        contractType: "ProtocolMessageEnvelope",
        category: "protocol",
        payload: goldenProtocol.invalidProtocolFixtures.missingPayloadTypeEnvelope,
        expectedValid: false,
      },
      {
        name: "invalid_stream_msg_negative_seq",
        contractType: "StreamMessage",
        category: "protocol",
        payload: goldenProtocol.invalidProtocolFixtures.negativeSequenceStreamMessage,
        expectedValid: false,
      },
      {
        name: "invalid_stream_msg_unknown_type",
        contractType: "StreamMessage",
        category: "protocol",
        payload: goldenProtocol.invalidProtocolFixtures.unknownStreamMessageType,
        expectedValid: false,
      },
      {
        name: "invalid_auth_request_bad_platform",
        contractType: "DeviceAuthBootstrapRequest",
        category: "protocol",
        payload: goldenProtocol.invalidProtocolFixtures.invalidAuthRequestBadPlatform,
        expectedValid: false,
      },
      {
        name: "invalid_obs_batch_bad_event",
        contractType: "ObservationBatchRequest",
        category: "protocol",
        payload: goldenProtocol.invalidProtocolFixtures.invalidObservationBatchBadEvent,
        expectedValid: false,
      },
    );

    // --- Harness Invalid Negative Tests ---
    cases.push(
      {
        name: "invalid_installation_bad_status",
        contractType: "HarnessInstallation",
        category: "harness",
        payload: goldenHarness.invalidHarnessFixtures.invalidInstallationBadStatus,
        expectedValid: false,
      },
      {
        name: "invalid_session_missing_harness",
        contractType: "HarnessSession",
        category: "harness",
        payload: goldenHarness.invalidHarnessFixtures.invalidSessionMissingHarness,
        expectedValid: false,
      },
      {
        name: "invalid_raw_rec_negative_sequence",
        contractType: "RawHarnessRecord",
        category: "harness",
        payload: goldenHarness.invalidHarnessFixtures.invalidRawRecordNegativeSequence,
        expectedValid: false,
      },
      {
        name: "invalid_adapter_bad_fidelity",
        contractType: "AdapterCapabilities",
        category: "harness",
        payload: goldenHarness.invalidHarnessFixtures.invalidAdapterBadFidelity,
        expectedValid: false,
      },
    );
  }

  return cases;
}

/**
 * Execute the complete conformance test suite.
 */
export async function runConformanceSuite(
  options: ConformanceSuiteOptions = {},
): Promise<ConformanceSuiteReport> {
  const startTime = Date.now();
  const allowedCategories = options.categories || ["domain", "protocol", "harness"];
  const categoryFilter: Record<string, true> = {};
  for (const c of allowedCategories) categoryFilter[c] = true;

  const testCases = buildTestCases(options.includeNegativeTests !== false).filter(
    (tc) => categoryFilter[tc.category],
  );

  const results: ConformanceTestCaseResult[] = [];
  const categoryCounts = {
    domain: { total: 0, passed: 0, failed: 0 },
    protocol: { total: 0, passed: 0, failed: 0 },
    harness: { total: 0, passed: 0, failed: 0 },
  };

  for (const testCase of testCases) {
    const t0 = performance.now();
    const validation = validateContractPayload(testCase.contractType, testCase.payload);
    const durationMs = performance.now() - t0;

    const passed = validation.valid === testCase.expectedValid;

    categoryCounts[testCase.category].total++;
    if (passed) {
      categoryCounts[testCase.category].passed++;
    } else {
      categoryCounts[testCase.category].failed++;
    }

    results.push({
      name: testCase.name,
      contractType: testCase.contractType,
      category: testCase.category,
      expectedValid: testCase.expectedValid,
      passed,
      durationMs,
      errors: validation.errors,
    });
  }

  const passedTests = results.filter((r) => r.passed).length;
  const failedTests = results.length - passedTests;
  const totalDuration = Date.now() - startTime;

  return {
    passed: failedTests === 0,
    totalTests: results.length,
    passedTests,
    failedTests,
    durationMs: totalDuration,
    results,
    categories: categoryCounts,
  };
}

/**
 * CLI execution entrypoint.
 */
export async function runConformanceCli(args: string[] = process.argv.slice(2)): Promise<number> {
  let jsonOutput = false;
  let verbose = false;
  const categories: Array<"domain" | "protocol" | "harness"> = [];

  for (const arg of args) {
    if (arg === "--json") jsonOutput = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--domain") categories.push("domain");
    else if (arg === "--protocol") categories.push("protocol");
    else if (arg === "--harness") categories.push("harness");
    else if (arg === "--help" || arg === "-h") {
      console.log(`
Resin Schema & Contract Conformance Runner

Usage:
  resin-conformance [options]

Options:
  --all            Run conformance tests for all categories (default)
  --domain         Run domain contract tests only
  --protocol       Run wire protocol contract tests only
  --harness        Run harness adapter contract tests only
  --json           Output results as JSON
  --verbose, -v    Show detailed test case results
  --help, -h       Display this help message
`);
      return 0;
    }
  }

  const report = await runConformanceSuite({
    categories: categories.length > 0 ? categories : ["domain", "protocol", "harness"],
    verbose,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }

  console.log("\n================================================================================");
  console.log(" Resin Contract Conformance Report");
  console.log("================================================================================");
  console.log(`Status: ${report.passed ? "PASSED" : "FAILED"}`);
  console.log(
    `Total: ${report.totalTests} | Passed: ${report.passedTests} | Failed: ${report.failedTests}`,
  );
  console.log(`Duration: ${report.durationMs}ms\n`);

  console.log("Category Breakdown:");
  console.log(
    `  - Domain:   ${report.categories.domain.passed}/${report.categories.domain.total} passed`,
  );
  console.log(
    `  - Protocol: ${report.categories.protocol.passed}/${report.categories.protocol.total} passed`,
  );
  console.log(
    `  - Harness:  ${report.categories.harness.passed}/${report.categories.harness.total} passed\n`,
  );

  if (verbose || !report.passed) {
    console.log("Test Results:");
    for (const r of report.results) {
      const mark = r.passed ? "✓" : "✗";
      console.log(
        `  ${mark} [${r.category.toUpperCase()}] ${r.name.padEnd(40)} (${r.durationMs.toFixed(2)}ms)`,
      );
      if (!r.passed && r.errors) {
        for (const e of r.errors) {
          console.log(`      Error at ${e.path}: ${e.message}`);
        }
      }
    }
    console.log("");
  }

  return report.passed ? 0 : 1;
}
