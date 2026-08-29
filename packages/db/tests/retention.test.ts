import type {
  CatalogSnapshot,
  DeploymentRecord,
  InstallationRecord,
  NormalizedMessageEvent,
  WorkspaceRecord,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/store.js";

describe("Retention & Compaction Engine", () => {
  it("compacts stale data while preserving active candidate and deployment evidence", async () => {
    const store = await createInMemoryStateStore();

    // 0. Create workspace first to satisfy foreign key constraints
    const workspace: WorkspaceRecord = {
      workspaceId: "ws_retention_01",
      rootPath: "/projects/test-retention",
      name: "Retention Test Workspace",
      config: {},
      capabilityEnvelope: {
        envelopeId: "env_retention_01",
        workspaceId: "ws_retention_01",
        version: "1.0.0",
        fs: {
          readPaths: [],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowedHosts: [],
          allowedPorts: [],
          allowLoopback: false,
          allowInbound: false,
          denyHosts: [],
        },
        command: {
          allowShellExecution: false,
          allowedCommands: [],
          allowedBinaries: [],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
        secrets: {
          allowedSecretNames: [],
          allowedPrefixes: [],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 2,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 128,
          maxExecutionTimeMs: 10000,
          maxOutputSizeBytes: 1048576,
        },
        isFrozen: false,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      activeTools: {},
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    await store.sessions.saveWorkspace(workspace);

    // 1. Create active deployment and installation (MUST BE PRESERVED)
    const deployment: DeploymentRecord = {
      deploymentId: "dep_active_01",
      workspaceId: "ws_retention_01",
      toolId: "tool_active_01",
      toolVersion: "1.0.0",
      state: "canary",
      history: [],
      activeTrafficPercentage: 25,
      createdAt: "2026-06-01T00:00:00.000Z", // old, but active
    };
    await store.tools.saveDeployment(deployment);

    const installation: InstallationRecord = {
      installationId: "ins_active_01",
      workspaceId: "ws_retention_01",
      toolId: "tool_active_01",
      toolVersion: "1.0.0",
      deploymentId: "dep_active_01",
      installedAt: "2026-06-01T00:00:00.000Z",
      state: "active",
      configOverrides: {},
    };
    await store.tools.saveInstallation(installation);

    // 2. Create closed session with old events and acknowledged upload batch (ELIGIBLE FOR PRUNING)
    await store.sessions.saveSession({
      sessionId: "ses_old_closed_01",
      workspaceId: "ws_retention_01",
      harnessId: "omp",
      status: "closed",
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T01:00:00.000Z",
    });

    const oldEvent: NormalizedMessageEvent = {
      eventId: "evt_old_01",
      schemaVersion: "0.1.0",
      sessionId: "ses_old_closed_01",
      timestamp: "2026-06-01T00:05:00.000Z",
      causalRef: { causalSequence: 1 },
      redaction: { isRedacted: false, redactionRulesApplied: [] },
      type: "message",
      role: "user",
      content: "Old message",
    };
    await store.sessions.insertEvent(oldEvent);

    await store.sync.saveUploadBatch({
      batchId: "bat_old_ack_01",
      workspaceId: "ws_retention_01",
      eventCount: 1,
      byteSize: 100,
      status: "acknowledged",
      createdAt: "2026-06-01T00:10:00.000Z",
      uploadedAt: "2026-06-01T00:10:05.000Z",
      retryCount: 0,
      checksum: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    // 3. Create active session with old events and pending upload batch (MUST NOT BE PRUNED)
    await store.sessions.saveSession({
      sessionId: "ses_active_pending_01",
      workspaceId: "ws_retention_01",
      harnessId: "omp",
      status: "active",
      startedAt: "2026-06-01T00:00:00.000Z",
    });

    const activeSessionEvent: NormalizedMessageEvent = {
      eventId: "evt_active_01",
      schemaVersion: "0.1.0",
      sessionId: "ses_active_pending_01",
      timestamp: "2026-06-01T00:05:00.000Z",
      causalRef: { causalSequence: 1 },
      redaction: { isRedacted: false, redactionRulesApplied: [] },
      type: "message",
      role: "user",
      content: "Active session event",
    };
    await store.sessions.insertEvent(activeSessionEvent);

    // 4. Create 3 catalog snapshots for ws_retention_01 (with keepCount: 2, oldest should be pruned)
    for (let i = 1; i <= 3; i++) {
      const snap: CatalogSnapshot = {
        snapshotId: `snp_0${i}`,
        workspaceId: "ws_retention_01",
        timestamp: `2026-08-1${i}T00:00:00.000Z`,
        tools: {},
        digest: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde${i}`,
      };
      await store.tools.saveCatalogSnapshot(snap);
    }

    // 5. Create old delivered outbox and old processed inbox
    const oldOutboxId = await store.sync.enqueueOutbox({
      outboxId: "out_old_01",
      topic: "old.topic",
      payload: { data: 1 },
    });
    await store.sync.markOutboxDelivered(oldOutboxId, "2026-06-01T00:00:00.000Z");
    // Force old created_at timestamp
    store
      .getConnection()
      .run("UPDATE local_outbox SET created_at = '2026-06-01T00:00:00.000Z' WHERE outbox_id = ?;", [
        oldOutboxId,
      ]);

    const oldInboxId = await store.sync.enqueueInbox({
      inboxId: "in_old_01",
      source: "old.source",
      messageId: "msg_old_01",
      payload: { data: 2 },
    });
    await store.sync.markInboxProcessed(oldInboxId, "2026-06-01T00:00:00.000Z");
    store
      .getConnection()
      .run("UPDATE local_inbox SET received_at = '2026-06-01T00:00:00.000Z' WHERE inbox_id = ?;", [
        oldInboxId,
      ]);

    // 6. Run compaction with 30-day retention and keepCount: 2
    const summary = await store.compact({
      acknowledgedBatchRetentionDays: 30,
      acknowledgedEventRetentionDays: 30,
      staleSnapshotKeepCount: 2,
      deliveredOutboxRetentionDays: 30,
      processedInboxRetentionDays: 30,
    });

    expect(summary.preservedActiveDeployments).toBe(1);
    expect(summary.preservedActiveInstallations).toBe(1);
    expect(summary.deletedBatches).toBe(1);
    expect(summary.deletedEvents).toBe(1);
    expect(summary.deletedSnapshots).toBe(1);
    expect(summary.deletedOutbox).toBe(1);
    expect(summary.deletedInbox).toBe(1);

    // Verify active deployment and installation still exist
    const preservedDeploy = await store.tools.getDeployment(deployment.deploymentId);
    expect(preservedDeploy).not.toBeNull();

    const preservedInstall = await store.tools.getInstallation(installation.installationId);
    expect(preservedInstall).not.toBeNull();

    // Verify unacknowledged / active session event was NOT deleted
    const preservedEvent = await store.sessions.getEventById(activeSessionEvent.eventId);
    expect(preservedEvent).not.toBeNull();

    // Verify old event from closed session was deleted
    const deletedEvent = await store.sessions.getEventById(oldEvent.eventId);
    expect(deletedEvent).toBeNull();

    // Verify latest 2 snapshots exist, oldest was pruned
    const snap1 = await store.tools.getCatalogSnapshot("snp_01");
    const snap2 = await store.tools.getCatalogSnapshot("snp_02");
    const snap3 = await store.tools.getCatalogSnapshot("snp_03");
    expect(snap1).toBeNull();
    expect(snap2).not.toBeNull();
    expect(snap3).not.toBeNull();

    store.close();
  });
});
