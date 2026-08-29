import { describe, expect, it } from "vitest";
import {
  validAuditRecord,
  validCatalogSnapshot,
  validDeadLetterRecord,
  validDeviceRecord,
  validInstallationRecord,
  validInvocationRecord,
  validSyncCursor,
  validTelemetryRecord,
  validWorkspaceRecord,
} from "../fixtures/index.js";
import {
  AuditRecordSchema,
  CatalogSnapshotSchema,
  DeadLetterRecordSchema,
  DeviceRecordSchema,
  EvidenceSetRecordSchema,
  InstallationRecordSchema,
  InvocationRecordSchema,
  PersonalEvidenceSetRecordSchema,
  PersonalSessionRecordSchema,
  RecordOwnershipSchema,
  SessionRecordSchema,
  SyncCursorSchema,
  TelemetryRecordSchema,
  WorkspaceEvidenceSetRecordSchema,
  WorkspaceRecordSchema,
  WorkspaceSessionRecordSchema,
} from "../src/records.js";

describe("records contracts", () => {
  describe("WorkspaceRecordSchema & DeviceRecordSchema", () => {
    it("parses valid workspace record fixture", () => {
      const parsed = WorkspaceRecordSchema.parse(validWorkspaceRecord);
      expect(parsed.workspaceId).toBe("ws_dev_primary_01");
      expect(parsed.activeTools.fast_ast_grep).toBe("1.0.0");
    });

    it("parses valid device record fixture", () => {
      const parsed = DeviceRecordSchema.parse(validDeviceRecord);
      expect(parsed.deviceId).toBe("dev_01JABCDEF");
      expect(parsed.platform).toBe("darwin");
      expect(parsed.arch).toBe("arm64");
    });

    it("rejects device with negative cpu cores", () => {
      expect(() =>
        DeviceRecordSchema.parse({
          ...validDeviceRecord,
          cpuCores: -4,
        }),
      ).toThrow();
    });
  });

  describe("InstallationRecordSchema & CatalogSnapshotSchema", () => {
    it("parses valid installation record fixture", () => {
      const parsed = InstallationRecordSchema.parse(validInstallationRecord);
      expect(parsed.installationId).toBe("inst_001");
      expect(parsed.state).toBe("active");
    });

    it("parses valid catalog snapshot fixture", () => {
      const parsed = CatalogSnapshotSchema.parse(validCatalogSnapshot);
      expect(parsed.snapshotId).toBe("cat_snap_001");
      expect(parsed.tools.fast_ast_grep.status).toBe("active");
    });
  });

  describe("InvocationRecordSchema & AuditRecordSchema", () => {
    it("parses valid invocation record fixture", () => {
      const parsed = InvocationRecordSchema.parse(validInvocationRecord);
      expect(parsed.invocationId).toBe("inv_001");
      expect(parsed.status).toBe("success");
      expect(parsed.durationMs).toBe(14.5);
    });

    it("parses valid audit record fixture", () => {
      const parsed = AuditRecordSchema.parse(validAuditRecord);
      expect(parsed.auditId).toBe("aud_001");
      expect(parsed.action).toBe("promote_to_active");
      expect(parsed.actor.type).toBe("user");
    });
  });

  describe("TelemetryRecordSchema, SyncCursorSchema & DeadLetterRecordSchema", () => {
    it("parses valid telemetry record fixture", () => {
      const parsed = TelemetryRecordSchema.parse(validTelemetryRecord);
      expect(parsed.metricName).toBe("gateway.tool_invocation.duration_ms");
      expect(parsed.metricType).toBe("histogram");
    });

    it("parses valid sync cursor fixture", () => {
      const parsed = SyncCursorSchema.parse(validSyncCursor);
      expect(parsed.cursorId).toBe("cur_001");
      expect(parsed.lastSyncedSequence).toBe(42);
    });

    it("parses valid dead letter record fixture", () => {
      const parsed = DeadLetterRecordSchema.parse(validDeadLetterRecord);
      expect(parsed.deadLetterId).toBe("dlq_001");
      expect(parsed.status).toBe("exhausted");
      expect(parsed.retryCount).toBe(3);
    });

    it("rejects dead letter record with negative retryCount", () => {
      expect(() =>
        DeadLetterRecordSchema.parse({
          ...validDeadLetterRecord,
          retryCount: -1,
        }),
      ).toThrow();
    });
  });
  describe("SessionRecordSchema, EvidenceSetRecordSchema & Ownership Invariants", () => {
    const validPersonalSession = {
      id: "sess_01JABCDEF01234567890123456",
      accountId: "acc_01JABCDEF01234567890123456",
      workspaceId: "ws_01JABCDEF01234567890123456",
      ownerUserId: "usr_01JABCDEF01234567890123456",
      visibility: "personal" as const,
      harnessType: "default",
      status: "active" as const,
      fidelity: "full" as const,
      startedAt: "2026-08-24T12:00:00.000Z",
      eventCount: 5,
      summaryByKind: { message: 5 },
      metadata: {},
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
    };

    const validWorkspaceSession = {
      id: "sess_01JABCDEF01234567890123456",
      accountId: "acc_01JABCDEF01234567890123456",
      workspaceId: "ws_01JABCDEF01234567890123456",
      ownerUserId: null,
      visibility: "workspace" as const,
      harnessType: "default",
      status: "active" as const,
      fidelity: "full" as const,
      startedAt: "2026-08-24T12:00:00.000Z",
      eventCount: 0,
      summaryByKind: {},
      metadata: {},
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
    };

    const validPersonalEvidenceSet = {
      id: "es_01JABCDEF01234567890123456",
      accountId: "acc_01JABCDEF01234567890123456",
      workspaceId: "ws_01JABCDEF01234567890123456",
      ownerUserId: "usr_01JABCDEF01234567890123456",
      visibility: "personal" as const,
      sessionId: "sess_01JABCDEF01234567890123456",
      name: "Personal Session Evidence",
      description: "Evidence snapshot for personal debugging",
      revision: 1,
      rootDigest: "a".repeat(64),
      memberCount: 2,
      metadata: {},
      createdAt: "2026-08-24T12:00:00.000Z",
    };

    const validWorkspaceEvidenceSet = {
      id: "es_01JABCDEF01234567890123456",
      accountId: "acc_01JABCDEF01234567890123456",
      workspaceId: "ws_01JABCDEF01234567890123456",
      ownerUserId: null,
      visibility: "workspace" as const,
      sessionId: null,
      name: "Shared Regression Evidence",
      description: "Workspace-wide shared benchmark",
      revision: 1,
      rootDigest: "b".repeat(64),
      memberCount: 10,
      metadata: {},
      createdAt: "2026-08-24T12:00:00.000Z",
    };

    it("parses valid personal session record with owner identity", () => {
      const parsed = SessionRecordSchema.parse(validPersonalSession);
      expect(parsed.visibility).toBe("personal");
      expect(parsed.ownerUserId).toBe("usr_01JABCDEF01234567890123456");
    });

    it("parses valid workspace session record with null owner", () => {
      const parsed = SessionRecordSchema.parse(validWorkspaceSession);
      expect(parsed.visibility).toBe("workspace");
      expect(parsed.ownerUserId).toBeNull();
    });

    it("parses valid workspace session record with specified owner", () => {
      const parsed = SessionRecordSchema.parse({
        ...validWorkspaceSession,
        ownerUserId: "usr_01JABCDEF01234567890123456",
      });
      expect(parsed.visibility).toBe("workspace");
      expect(parsed.ownerUserId).toBe("usr_01JABCDEF01234567890123456");
    });

    it("rejects personal session record without owner identity", () => {
      expect(() =>
        PersonalSessionRecordSchema.parse({
          ...validPersonalSession,
          ownerUserId: null,
        }),
      ).toThrow();

      expect(() =>
        SessionRecordSchema.parse({
          ...validPersonalSession,
          ownerUserId: null,
        }),
      ).toThrow();
    });

    it("parses valid personal evidence set record with owner identity", () => {
      const parsed = EvidenceSetRecordSchema.parse(validPersonalEvidenceSet);
      expect(parsed.visibility).toBe("personal");
      expect(parsed.ownerUserId).toBe("usr_01JABCDEF01234567890123456");
    });

    it("parses valid workspace evidence set record with null owner", () => {
      const parsed = EvidenceSetRecordSchema.parse(validWorkspaceEvidenceSet);
      expect(parsed.visibility).toBe("workspace");
      expect(parsed.ownerUserId).toBeNull();
    });

    it("rejects personal evidence set record without owner identity", () => {
      expect(() =>
        PersonalEvidenceSetRecordSchema.parse({
          ...validPersonalEvidenceSet,
          ownerUserId: null,
        }),
      ).toThrow();

      expect(() =>
        EvidenceSetRecordSchema.parse({
          ...validPersonalEvidenceSet,
          ownerUserId: null,
        }),
      ).toThrow();
    });

    it("validates generic RecordOwnershipSchema", () => {
      const personalOwnership = RecordOwnershipSchema.parse({
        visibility: "personal",
        ownerUserId: "usr_01JABCDEF01234567890123456",
      });
      expect(personalOwnership.visibility).toBe("personal");

      const workspaceOwnership = RecordOwnershipSchema.parse({
        visibility: "workspace",
      });
      expect(workspaceOwnership.visibility).toBe("workspace");

      expect(() =>
        RecordOwnershipSchema.parse({
          visibility: "personal",
          ownerUserId: null,
        }),
      ).toThrow();
    });
  });
});
