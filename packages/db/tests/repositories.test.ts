import type {
  AuditRecord,
  CapabilityEnvelope,
  CapabilityGrant,
  CatalogSnapshot,
  DeadLetterRecord,
  DeploymentRecord,
  InstallationRecord,
  InvocationRecord,
  NormalizedMessageEvent,
  ToolManifest,
  ToolVersion,
  WorkspaceRecord,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { createInMemoryStateStore } from "../src/store.js";

describe("Repositories End-to-End Round-Trip & Operations", () => {
  it("session repository round-trips workspaces, sessions, cursors, refs, and normalized events", async () => {
    const store = await createInMemoryStateStore();

    // 1. Workspace
    const workspace: WorkspaceRecord = {
      workspaceId: "ws_01j7db4n000000000000000001",
      rootPath: "/projects/resin",
      name: "Resin Core",
      config: { telemetry: true, maxTools: 50 },
      capabilityEnvelope: {
        envelopeId: "env_01j7db4n000000000000000001",
        workspaceId: "ws_01j7db4n000000000000000001",
        version: "1.0.0",
        fs: {
          readPaths: ["/projects/resin"],
          writePaths: ["/projects/resin/dist"],
          allowWorkspaceRoot: true,
          allowTemp: true,
          denyPaths: ["/etc"],
          maxFileSizeBytes: 10485760,
        },
        net: {
          allowOutbound: true,
          allowedDomains: [],
          allowedHosts: ["api.anthropic.com"],
          allowedPorts: [443],
          allowedProtocols: ["https"],
          allowLocalhost: false,
          denyPrivateRanges: true,
        },
        command: {
          allowShellExecution: false,
          allowedCommands: ["node", "git"],
          allowedBinaries: ["node", "git", "deno"],
          forbiddenPatterns: ["rm -rf", "sudo"],
          allowEnvPassthrough: ["NODE_ENV"],
        },
        secrets: {
          allowedSecretNames: ["ANTHROPIC_API_KEY"],
          allowedPrefixes: ["ANTHROPIC_"],
          denyDirectRead: true,
          injectAsEnv: true,
        },
        limits: {
          maxConcurrentExecutions: 4,
          maxCpuUsagePercent: 100,
          maxMemoryMb: 512,
          maxExecutionTimeMs: 30000,
          maxOutputSizeBytes: 1048576,
        },
        isFrozen: false,
        createdAt: "2026-08-17T12:00:00.000Z",
      },
      activeTools: { tool_git_diff: "1.0.0" },
      createdAt: "2026-08-17T12:00:00.000Z",
    };

    await store.sessions.saveWorkspace(workspace);
    const fetchedWs = await store.sessions.getWorkspace(workspace.workspaceId);
    expect(fetchedWs).toEqual(workspace);

    const allWorkspaces = await store.sessions.listWorkspaces();
    expect(allWorkspaces).toHaveLength(1);
    expect(allWorkspaces[0].workspaceId).toBe(workspace.workspaceId);

    // 2. Session
    await store.sessions.saveSession({
      sessionId: "ses_01j7db4n000000000000000001",
      workspaceId: workspace.workspaceId,
      harnessId: "omp",
      status: "active",
      startedAt: "2026-08-17T12:05:00.000Z",
      metadata: { user: "developer" },
      sourceIdentity: { pid: 12345 },
    });

    const fetchedSession = await store.sessions.getSession("ses_01j7db4n000000000000000001");
    expect(fetchedSession?.sessionId).toBe("ses_01j7db4n000000000000000001");
    expect(fetchedSession?.workspaceId).toBe(workspace.workspaceId);
    expect(fetchedSession?.status).toBe("active");

    const sessions = await store.sessions.listSessions({ workspaceId: workspace.workspaceId });
    expect(sessions).toHaveLength(1);

    // 3. Source Cursors
    await store.sessions.saveCursor({
      cursorId: "cur_01j7db4n000000000000000001",
      deviceId: "dev_01j7db4n000000000000000001",
      workspaceId: workspace.workspaceId,
      entityType: "session_events",
      lastSyncedSequence: 42,
      lastSyncedTimestamp: "2026-08-17T12:10:00.000Z",
      syncToken: "tok_sync_abc123",
    });

    const fetchedCursor = await store.sessions.getCursor("cur_01j7db4n000000000000000001");
    expect(fetchedCursor?.lastSyncedSequence).toBe(42);
    expect(fetchedCursor?.syncToken).toBe("tok_sync_abc123");

    // 4. Raw Record Ref
    await store.sessions.saveRawRecordRef({
      recordId: "rec_01j7db4n000000000000000001",
      sessionId: "ses_01j7db4n000000000000000001",
      sourceId: "omp_session_transcript",
      payloadHash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      storagePath: "/tmp/records/rec_01.json",
      byteSize: 1024,
      createdAt: "2026-08-17T12:15:00.000Z",
      metadata: { compression: "none" },
    });

    const fetchedRef = await store.sessions.getRawRecordRef("rec_01j7db4n000000000000000001");
    expect(fetchedRef?.byteSize).toBe(1024);
    expect(fetchedRef?.payloadHash).toContain("0123456789abcdef");

    // 5. Normalized Session Events & Idempotency
    const event1: NormalizedMessageEvent = {
      eventId: "evt_01j7db4n000000000000000001",
      schemaVersion: "0.1.0",
      sessionId: "ses_01j7db4n000000000000000001",
      timestamp: "2026-08-17T12:20:00.000Z",
      causalRef: {
        causalSequence: 1,
      },
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
      },
      type: "message",
      role: "user",
      content: "Hello, please generate a diff",
    };

    const insertedCount = await store.sessions.insertEvents([event1]);
    expect(insertedCount).toBe(1);

    // Duplicate insert should be ignored cleanly (idempotent)
    const duplicateCount = await store.sessions.insertEvents([event1]);
    expect(duplicateCount).toBe(0);

    const fetchedEvent = await store.sessions.getEventById(event1.eventId);
    expect(fetchedEvent).toEqual(event1);

    const eventsList = await store.sessions.getEvents("ses_01j7db4n000000000000000001");
    expect(eventsList).toHaveLength(1);
    expect(eventsList[0]).toEqual(event1);

    const latestSeq = await store.sessions.getLatestEventSequence("ses_01j7db4n000000000000000001");
    expect(latestSeq).toBe(1);

    store.close();
  });

  it("tool repository round-trips manifests, versions, snapshots, deployments, and installations", async () => {
    const store = await createInMemoryStateStore();

    // 1. Tool Manifest
    const manifest: ToolManifest = {
      id: "tool_git_diff",
      name: "git_diff",
      version: "1.0.0",
      description: "Generates diff patches for a git repository",
      parameters: {
        type: "object",
        properties: {
          staged: { type: "boolean", description: "Whether to diff staged changes" },
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          patch: { type: "string" },
        },
      },
      runtime: {
        runtime: "builtin",
        memoryLimitMb: 128,
        timeoutMs: 10000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 1048576,
      },
      capabilities: {
        fs: {
          readPaths: ["."],
          writePaths: [],
          allowWorkspaceRoot: true,
          allowTemp: false,
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
          allowedBinaries: ["git"],
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
      },
      limits: {
        timeoutMs: 10000,
        maxOutputBytes: 1048576,
        maxMemoryBytes: 134217728,
        maxConcurrentInvocations: 2,
      },
      scope: "workspace",
      digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      metadata: { author: "core-team" },
      createdAt: "2026-08-17T12:00:00.000Z",
    };

    await store.tools.saveManifest(manifest);
    const fetchedManifest = await store.tools.getManifest(manifest.id);
    expect(fetchedManifest).toEqual(manifest);

    // 2. Tool Version
    const toolVersion: ToolVersion = {
      toolId: manifest.id,
      version: "1.0.0",
      manifestDigest: manifest.digest,
      artifactDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      manifest,
      artifact: {
        artifactDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        bundleReference: {
          uri: "file:///tools/git_diff-1.0.0.bundle",
          hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          sizeBytes: 4096,
          format: "js_bundle",
        },
        entrypoint: "index.js",
        checksums: {
          "index.js": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
      },
      provenance: {
        synthesizedAt: "2026-08-17T12:00:00.000Z",
        synthesizerModel: "claude-3-7-sonnet",
        gitCommitSha: "a1b2c3d4e5f60123456789abcdef0123456789ab",
        deterministicBuildHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        environment: { runtime: "node22" },
      },
      status: "active",
      createdAt: "2026-08-17T12:00:00.000Z",
      createdBy: "agent-01",
    };

    await store.tools.saveToolVersion(toolVersion);
    const fetchedVersion = await store.tools.getToolVersion(manifest.id, "1.0.0");
    expect(fetchedVersion).toEqual(toolVersion);

    // 3. Catalog Snapshot
    const snapshot: CatalogSnapshot = {
      snapshotId: "snp_01j7db4n000000000000000001",
      workspaceId: "ws_01j7db4n000000000000000001",
      timestamp: "2026-08-17T12:30:00.000Z",
      tools: {
        git_diff: {
          toolId: manifest.id,
          version: "1.0.0",
          manifestDigest: manifest.digest,
          scope: "workspace",
          status: "active",
        },
      },
      digest: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };

    await store.tools.saveCatalogSnapshot(snapshot);
    const fetchedSnapshot = await store.tools.getCatalogSnapshot(snapshot.snapshotId);
    expect(fetchedSnapshot).toEqual(snapshot);

    // 4. Deployment Record
    const deployment: DeploymentRecord = {
      deploymentId: "dep_01j7db4n000000000000000001",
      workspaceId: "ws_01j7db4n000000000000000001",
      toolId: manifest.id,
      toolVersion: "1.0.0",
      state: "canary",
      canaryConfig: {
        strategy: "traffic_split",
        trafficPercentage: 10,
        durationMinutes: 60,
        maxShadowWorkers: 2,
        autoRollbackThresholds: {
          maxErrorRate: 0.05,
          maxLatencyP95Ms: 5000,
          maxSchemaMismatchRate: 0.01,
          consecutiveFailureThreshold: 3,
        },
      },
      history: [
        {
          fromState: "drafted",
          toState: "canary",
          timestamp: "2026-08-17T12:35:00.000Z",
          reason: "canary_started",
          actor: {
            type: "daemon",
            id: "daemon-01",
          },
          metadata: {},
        },
      ],
      activeTrafficPercentage: 10,
      createdAt: "2026-08-17T12:35:00.000Z",
    };

    await store.tools.saveDeployment(deployment);
    const fetchedDeploy = await store.tools.getDeployment(deployment.deploymentId);
    expect(fetchedDeploy).toEqual(deployment);

    // 5. Installation Record
    const installation: InstallationRecord = {
      installationId: "ins_01j7db4n000000000000000001",
      workspaceId: "ws_01j7db4n000000000000000001",
      toolId: manifest.id,
      toolVersion: "1.0.0",
      deploymentId: deployment.deploymentId,
      installedAt: "2026-08-17T12:40:00.000Z",
      state: "active",
      configOverrides: { maxDiffSize: 50000 },
    };

    await store.tools.saveInstallation(installation);
    const fetchedInstall = await store.tools.getInstallation(installation.installationId);
    expect(fetchedInstall).toEqual(installation);

    // 6. Harness Installation
    await store.tools.saveHarnessInstallation({
      harnessId: "omp",
      pluginId: "git_diff_adapter",
      version: "1.0.0",
      installedAt: "2026-08-17T12:45:00.000Z",
      state: "active",
      metadata: { channel: "stable" },
    });

    const fetchedHarness = await store.tools.getHarnessInstallation("omp", "git_diff_adapter");
    expect(fetchedHarness?.version).toBe("1.0.0");
    expect(fetchedHarness?.state).toBe("active");

    store.close();
  });

  it("capability repository round-trips envelopes and grants", async () => {
    const store = await createInMemoryStateStore();

    const envelope: CapabilityEnvelope = {
      envelopeId: "env_01j7db4n000000000000000002",
      workspaceId: "ws_01j7db4n000000000000000002",
      version: "1.0.0",
      fs: {
        readPaths: ["/app"],
        writePaths: ["/app/logs"],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: ["/app/secrets"],
        maxFileSizeBytes: 5242880,
      },
      net: {
        allowOutbound: true,
        allowedDomains: [],
        allowedHosts: ["api.openai.com"],
        allowedPorts: [443],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: ["node"],
        allowedBinaries: ["node"],
        forbiddenPatterns: ["rm"],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: ["OPENAI_API_KEY"],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 80,
        maxMemoryMb: 256,
        maxExecutionTimeMs: 15000,
        maxOutputSizeBytes: 524288,
      },
      isFrozen: true,
      createdAt: "2026-08-17T13:00:00.000Z",
    };

    await store.capabilities.saveEnvelope(envelope);
    const fetchedEnvelope = await store.capabilities.getEnvelope(envelope.workspaceId);
    expect(fetchedEnvelope).toEqual(envelope);

    const grant: CapabilityGrant = {
      grantId: "grt_01j7db4n000000000000000001",
      workspaceId: envelope.workspaceId,
      toolId: "tool_logger",
      grantedAt: "2026-08-17T13:05:00.000Z",
      grantType: "explicit",
      capabilities: {
        fs: {
          readPaths: ["/app/logs"],
          writePaths: ["/app/logs"],
          allowWorkspaceRoot: false,
          allowTemp: true,
          denyPaths: [],
          maxFileSizeBytes: 1048576,
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
          maxConcurrentExecutions: 1,
          maxCpuUsagePercent: 50,
          maxMemoryMb: 64,
          maxExecutionTimeMs: 5000,
          maxOutputSizeBytes: 104857,
        },
      },
      actor: {
        type: "user",
        id: "admin-user",
      },
      reason: "Grant logging permissions to tool_logger",
    };

    await store.capabilities.saveGrant(grant);
    const fetchedGrant = await store.capabilities.getGrant(grant.grantId);
    expect(fetchedGrant).toEqual(grant);

    const grantList = await store.capabilities.listGrants(envelope.workspaceId);
    expect(grantList).toHaveLength(1);
    expect(grantList[0]).toEqual(grant);

    store.close();
  });

  it("sync repository handles outbox, inbox, upload batches, acknowledgements, and dead letters", async () => {
    const store = await createInMemoryStateStore();

    // 1. Outbox Lifecycle
    const outboxId = await store.sync.enqueueOutbox({
      topic: "observations.events",
      payload: { eventCount: 10, batchId: "b_1" },
    });
    expect(outboxId).toBeDefined();

    const pendingOutbox = await store.sync.fetchPendingOutbox();
    expect(pendingOutbox).toHaveLength(1);
    expect(pendingOutbox[0].status).toBe("pending");
    expect(pendingOutbox[0].topic).toBe("observations.events");

    await store.sync.markOutboxDelivered(outboxId);
    const pendingAfterDelivered = await store.sync.fetchPendingOutbox();
    expect(pendingAfterDelivered).toHaveLength(0);

    // 2. Inbox Lifecycle
    const inboxId = await store.sync.enqueueInbox({
      source: "cloud_sync",
      messageId: "msg_12345",
      payload: { command: "refresh_catalog", workspaceId: "ws_1" },
    });
    expect(inboxId).toBeDefined();

    const pendingInbox = await store.sync.fetchPendingInbox();
    expect(pendingInbox).toHaveLength(1);
    expect(pendingInbox[0].source).toBe("cloud_sync");

    await store.sync.markInboxProcessed(inboxId);
    const pendingInboxAfter = await store.sync.fetchPendingInbox();
    expect(pendingInboxAfter).toHaveLength(0);

    // 3. Upload Batches & Acknowledgements
    await store.sync.saveUploadBatch({
      batchId: "bat_01j7db4n000000000000000001",
      workspaceId: "ws_01j7db4n000000000000000001",
      eventCount: 25,
      byteSize: 10240,
      status: "uploading",
      createdAt: "2026-08-17T13:20:00.000Z",
      retryCount: 0,
      checksum: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    const fetchedBatch = await store.sync.getUploadBatch("bat_01j7db4n000000000000000001");
    expect(fetchedBatch?.status).toBe("uploading");
    expect(fetchedBatch?.eventCount).toBe(25);

    await store.sync.updateUploadBatchStatus(
      "bat_01j7db4n000000000000000001",
      "acknowledged",
      "2026-08-17T13:25:00.000Z",
    );
    const batchAfterAck = await store.sync.getUploadBatch("bat_01j7db4n000000000000000001");
    expect(batchAfterAck?.status).toBe("acknowledged");
    expect(batchAfterAck?.uploadedAt).toBe("2026-08-17T13:25:00.000Z");

    await store.sync.saveUploadAcknowledgement({
      ackId: "ack_01j7db4n000000000000000001",
      batchId: "bat_01j7db4n000000000000000001",
      serverTimestamp: "2026-08-17T13:25:00.000Z",
      processedCount: 25,
      status: "accepted",
      receivedAt: "2026-08-17T13:25:01.000Z",
    });

    const fetchedAck = await store.sync.getUploadAcknowledgement("ack_01j7db4n000000000000000001");
    expect(fetchedAck?.processedCount).toBe(25);
    expect(fetchedAck?.status).toBe("accepted");

    // 4. Dead Letters
    const deadLetter: DeadLetterRecord = {
      deadLetterId: "dlt_01j7db4n000000000000000001",
      originalEventType: "tool_execution_event",
      payload: { rawEvent: "corrupt_data" },
      errorReason: "Schema validation failed on payload format",
      failedAt: "2026-08-17T13:30:00.000Z",
      retryCount: 3,
      status: "exhausted",
    };

    await store.sync.saveDeadLetter(deadLetter);
    const fetchedDl = await store.sync.getDeadLetter(deadLetter.deadLetterId);
    expect(fetchedDl).toEqual(deadLetter);

    const deadLettersList = await store.sync.listDeadLetters({ status: "exhausted" });
    expect(deadLettersList).toHaveLength(1);

    store.close();
  });

  it("audit repository round-trips invocation records and system audit events", async () => {
    const store = await createInMemoryStateStore();

    // Prepare session for foreign key
    await store.sessions.saveSession({
      sessionId: "ses_01j7db4n000000000000000003",
      harnessId: "omp",
      status: "active",
      startedAt: "2026-08-17T14:00:00.000Z",
    });

    // 1. Invocation Record
    const invocation: InvocationRecord = {
      invocationId: "inv_01j7db4n000000000000000001",
      sessionId: "ses_01j7db4n000000000000000003",
      workspaceId: "ws_01j7db4n000000000000000001",
      toolId: "tool_git_diff",
      toolVersion: "1.0.0",
      startedAt: "2026-08-17T14:05:00.000Z",
      completedAt: "2026-08-17T14:05:01.250Z",
      durationMs: 1250,
      status: "success",
      inputDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      outputDigest: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      resourceUsage: {
        cpuTimeMs: 120,
        memoryBytes: 33554432,
        shadowRun: false,
      },
    };

    await store.audit.recordInvocation(invocation);
    const fetchedInv = await store.audit.getInvocation(invocation.invocationId);
    expect(fetchedInv).toEqual(invocation);

    const invList = await store.audit.listInvocations({ toolId: "tool_git_diff" });
    expect(invList).toHaveLength(1);

    // 2. Audit Record
    const audit: AuditRecord = {
      auditId: "aud_01j7db4n000000000000000001",
      timestamp: "2026-08-17T14:10:00.000Z",
      eventType: "capability.grant_created",
      actor: {
        type: "user",
        id: "admin-1",
      },
      workspaceId: "ws_01j7db4n000000000000000001",
      resourceType: "capability",
      resourceId: "grt_01j7db4n000000000000000001",
      action: "grant",
      status: "success",
      details: { permissions: ["fs:read", "fs:write"] },
      clientIp: "127.0.0.1",
    };

    await store.audit.recordAudit(audit);
    const fetchedAudit = await store.audit.getAudit(audit.auditId);
    expect(fetchedAudit).toEqual(audit);

    const auditList = await store.audit.listAuditRecords({ eventType: "capability.grant_created" });
    expect(auditList).toHaveLength(1);
    expect(auditList[0]).toEqual(audit);

    store.close();
  });
});
