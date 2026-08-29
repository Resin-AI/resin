import { describe, expect, it } from "vitest";
import {
  invalidFixtures,
  validAuditRecord,
  validBranchForkEvent,
  validCapabilityEnvelope,
  validCapabilityGrant,
  validCatalogSnapshot,
  validCommandExecEvent,
  validCompactionEvent,
  validDeadLetterRecord,
  validDeploymentRecord,
  validDeviceRecord,
  validErrorEvent,
  validFileEditEvent,
  validInstallationRecord,
  validInvocationRecord,
  validMessageEvent,
  validModelReasoningEvent,
  validSessionLifecycleEvent,
  validSubagentLifecycleEvent,
  validSyncCursor,
  validTelemetryRecord,
  validToolCallEvent,
  validToolDiscoveryEvent,
  validToolManifest,
  validToolResultEvent,
  validToolVersion,
  validUnknownPassthroughEvent,
  validWorkspaceRecord,
} from "../fixtures/index.js";
import {
  AuditRecordSchema,
  CapabilityEnvelopeSchema,
  CapabilityGrantSchema,
  CatalogSnapshotSchema,
  DeadLetterRecordSchema,
  DeploymentRecordSchema,
  DeviceRecordSchema,
  IdentifierSchema,
  InstallationRecordSchema,
  InvocationRecordSchema,
  NormalizedSessionEventSchema,
  SchemaVersionSchema,
  SyncCursorSchema,
  TelemetryRecordSchema,
  ToolManifestSchema,
  ToolVersionSchema,
  WorkspaceRecordSchema,
} from "../src/index.js";

describe("golden fixtures validation", () => {
  const validCases = [
    { name: "MessageEvent", schema: NormalizedSessionEventSchema, data: validMessageEvent },
    {
      name: "ModelReasoningEvent",
      schema: NormalizedSessionEventSchema,
      data: validModelReasoningEvent,
    },
    {
      name: "ToolDiscoveryEvent",
      schema: NormalizedSessionEventSchema,
      data: validToolDiscoveryEvent,
    },
    { name: "ToolCallEvent", schema: NormalizedSessionEventSchema, data: validToolCallEvent },
    {
      name: "ToolResultEvent",
      schema: NormalizedSessionEventSchema,
      data: validToolResultEvent,
    },
    {
      name: "CommandExecEvent",
      schema: NormalizedSessionEventSchema,
      data: validCommandExecEvent,
    },
    { name: "FileEditEvent", schema: NormalizedSessionEventSchema, data: validFileEditEvent },
    { name: "ErrorEvent", schema: NormalizedSessionEventSchema, data: validErrorEvent },
    {
      name: "CompactionEvent",
      schema: NormalizedSessionEventSchema,
      data: validCompactionEvent,
    },
    {
      name: "BranchForkEvent",
      schema: NormalizedSessionEventSchema,
      data: validBranchForkEvent,
    },
    {
      name: "SubagentLifecycleEvent",
      schema: NormalizedSessionEventSchema,
      data: validSubagentLifecycleEvent,
    },
    {
      name: "SessionLifecycleEvent",
      schema: NormalizedSessionEventSchema,
      data: validSessionLifecycleEvent,
    },
    {
      name: "UnknownPassthroughEvent",
      schema: NormalizedSessionEventSchema,
      data: validUnknownPassthroughEvent,
    },
    { name: "ToolManifest", schema: ToolManifestSchema, data: validToolManifest },
    { name: "CapabilityGrant", schema: CapabilityGrantSchema, data: validCapabilityGrant },
    {
      name: "CapabilityEnvelope",
      schema: CapabilityEnvelopeSchema,
      data: validCapabilityEnvelope,
    },
    { name: "ToolVersion", schema: ToolVersionSchema, data: validToolVersion },
    {
      name: "DeploymentRecord",
      schema: DeploymentRecordSchema,
      data: validDeploymentRecord,
    },
    {
      name: "WorkspaceRecord",
      schema: WorkspaceRecordSchema,
      data: validWorkspaceRecord,
    },
    { name: "DeviceRecord", schema: DeviceRecordSchema, data: validDeviceRecord },
    {
      name: "InstallationRecord",
      schema: InstallationRecordSchema,
      data: validInstallationRecord,
    },
    {
      name: "CatalogSnapshot",
      schema: CatalogSnapshotSchema,
      data: validCatalogSnapshot,
    },
    {
      name: "InvocationRecord",
      schema: InvocationRecordSchema,
      data: validInvocationRecord,
    },
    { name: "AuditRecord", schema: AuditRecordSchema, data: validAuditRecord },
    {
      name: "TelemetryRecord",
      schema: TelemetryRecordSchema,
      data: validTelemetryRecord,
    },
    { name: "SyncCursor", schema: SyncCursorSchema, data: validSyncCursor },
    {
      name: "DeadLetterRecord",
      schema: DeadLetterRecordSchema,
      data: validDeadLetterRecord,
    },
  ];

  it.each(validCases)("validates $name golden fixture cleanly", ({ schema, data }) => {
    expect(() => schema.parse(data)).not.toThrow();
  });

  it("fails validation for negative fixtures", () => {
    expect(() => IdentifierSchema.parse(invalidFixtures.emptyIdentifier)).toThrow();
    expect(() => SchemaVersionSchema.parse(invalidFixtures.invalidSemver)).toThrow();
  });
});
