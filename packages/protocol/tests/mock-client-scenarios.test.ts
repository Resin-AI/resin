import { describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  ClockSkewError,
  DecompressionBombError,
  DeviceRevokedError,
  MockProtocolServer,
  ProtocolClient,
  RateLimitedError,
  RetryableError,
  UpgradeRequiredError,
  ValidationError,
} from "../src/index.js";

describe("ProtocolClient & MockProtocolServer Scenarios", () => {
  function createTestClient(mockServer = new MockProtocolServer()) {
    return new ProtocolClient({
      deviceId: "dev-test-001",
      installationId: "inst-test-001",
      workspaceId: "ws-test-001",
      mockServer,
    });
  }

  it("scenario: healthy - executes complete end-to-end lifecycle smoothly", () => {
    const mockServer = new MockProtocolServer("healthy");
    const client = createTestClient(mockServer);

    // 1. Device Auth Bootstrap
    const bootstrap = client.bootstrapDeviceAuth({
      hostname: "test-box",
      platform: "linux",
      arch: "arm64",
    });
    expect(bootstrap.deviceCode).toBeDefined();
    expect(bootstrap.userCode).toBeDefined();

    // 2. Token Exchange
    const tokenRes = client.exchangeDeviceToken(bootstrap.deviceCode);
    expect(tokenRes.accessToken).toBeDefined();
    expect(client.getAccessToken()).toBe(tokenRes.accessToken);
    expect(client.getClaims()?.deviceId).toBe("dev-test-001");

    // 3. Register Installation & Workspace
    const instRes = client.registerInstallation(["claude-code", "omp"]);
    expect(instRes.status).toBe("registered");

    const wsRes = client.registerWorkspace("test-workspace", "/path/to/ws", {
      envelopeId: "env-001",
      workspaceId: "ws-test-001",
      fs: {
        readPaths: ["."],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
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
        maxConcurrentExecutions: 2,
        maxCpuUsagePercent: 80,
        maxMemoryMb: 256,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
      status: "active",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
    });
    expect(wsRes.status).toBe("registered");

    // 4. Send Observation Batch
    const { envelope, response: batchRes } = client.sendObservationBatch(
      [
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
          type: "session_lifecycle",
          lifecycleType: "start",
          harnessName: "claude-code",
        },
      ],
      "cursor-1",
    );
    expect(envelope.payloadDigest).toBeDefined();
    expect(batchRes.status).toBe("accepted");
    expect(batchRes.acceptedCount).toBe(1);
    expect(batchRes.cursorAck).toBe("cursor-1");

    // 5. Fetch Catalog Snapshot & Verify Checksum
    const snapshot = client.getCatalogSnapshot();
    expect(snapshot.tools.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.checksum).toBeDefined();

    // 6. Download Artifact & Verify Checksum
    const sampleDigest = Array.from(mockServer.artifactStore.keys())[0];
    const artifact = client.downloadArtifact(sampleDigest);
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
    expect(artifact.metadata.digest).toBe(sampleDigest);

    // 7. Report Deployment Status
    const depReport = client.reportDeploymentStatus([
      {
        deploymentId: "dep-001",
        toolId: "tool-git-commit",
        version: "1.0.0",
        state: "promoted",
        healthScore: 1.0,
        invocationCount: 50,
        errorCount: 0,
      },
    ]);
    expect(depReport.acknowledged).toBe(true);

    // 8. Send Telemetry Batch
    const teleRes = client.sendTelemetryBatch(
      [],
      [
        {
          metricName: "worker.cpu",
          value: 45.0,
          unit: "percent",
          tags: { env: "test" },
          timestamp: new Date().toISOString(),
        },
      ],
    );
    expect(teleRes.status).toBe("accepted");
    expect(teleRes.processedCount).toBe(1);

    // 9. Negotiate Health
    const health = client.negotiateHealth();
    expect(health.status).toBe("healthy");
    expect(health.clockSkewMs).toBe(0);

    // 10. Stream Messaging & Replay Buffer
    const heartbeat = client.createClientHeartbeat(5000);
    expect(heartbeat.sequence).toBe(0);
    expect(client.replayBuffer.size()).toBe(1);

    const ackMsg = client.createStreamAck(0, heartbeat.messageId, "processed");
    expect(ackMsg.sequence).toBe(1);
    expect(client.replayBuffer.size()).toBe(2);

    client.replayBuffer.acknowledge(1);
    expect(client.replayBuffer.size()).toBe(0);
  });

  it("scenario: offline - throws RetryableError on network disconnection", () => {
    const mockServer = new MockProtocolServer("offline");
    const client = createTestClient(mockServer);

    expect(() => client.bootstrapDeviceAuth()).toThrow(RetryableError);
    expect(() => client.negotiateHealth()).toThrow(RetryableError);
  });

  it("scenario: duplicate - accepts duplicate observation batch idempotently", () => {
    const mockServer = new MockProtocolServer("healthy");
    const client = createTestClient(mockServer);

    const observations = [
      {
        eventId: "evt-dup-001",
        schemaVersion: "1.0.0" as const,
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
    ];

    // First transmission
    const res1 = client.sendObservationBatch(observations, "cursor-dup");
    expect(res1.response.status).toBe("accepted");

    // Replay identical batch through mock server directly to simulate exact duplicate batchId
    const res2 = mockServer.handleObservationBatch({
      batchId: res1.envelope.idempotencyKey!,
      workspaceId: "ws-test-001",
      deviceId: "dev-test-001",
      installationId: "inst-test-001",
      cursor: "cursor-dup",
      compressed: false,
      compression: "none",
      observations,
    });

    expect(res2.status).toBe("accepted");
    expect(res2.acceptedCount).toBe(1);
  });

  it("scenario: out_of_order - sequencer detects gap, buffers out-of-order messages, and reassembles in order", () => {
    const mockServer = new MockProtocolServer("out_of_order");
    const client = createTestClient(mockServer);

    const messages = mockServer.generateServerStreamMessages(4);
    // Messages sequences: [0, 2, 1, 3] due to out_of_order simulation

    const r0 = client.sequencer.processInbound(messages[0]); // seq 0
    expect(r0.status).toBe("ok");

    const r1 = client.sequencer.processInbound(messages[1]); // seq 2 (gap!)
    expect(r1.status).toBe("gap");
    expect(r1.gapSize).toBe(1);

    const r2 = client.sequencer.processInbound(messages[2]); // seq 1 (missing piece arrives!)
    expect(r2.status).toBe("ok");

    // Flush now that missing message arrived
    const flushed = client.sequencer.flushBuffered();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].sequence).toBe(2);

    const r3 = client.sequencer.processInbound(messages[3]); // seq 3
    expect(r3.status).toBe("ok");
    expect(client.sequencer.getExpectedSequence()).toBe(4);
  });

  it("scenario: revoked_device - server rejects operations for revoked device and client cleans state", () => {
    const mockServer = new MockProtocolServer("healthy");
    const client = createTestClient(mockServer);

    // Initial auth
    const bootstrap = client.bootstrapDeviceAuth();
    client.exchangeDeviceToken(bootstrap.deviceCode);
    expect(client.getAccessToken()).toBeDefined();

    // Revoke device
    const revokeRes = client.revokeDevice("Device compromised");
    expect(revokeRes.revoked).toBe(true);
    expect(client.getAccessToken()).toBeNull();
    expect(client.getClaims()).toBeNull();

    // Next token exchange should throw DeviceRevokedError
    expect(() => client.exchangeDeviceToken(bootstrap.deviceCode)).toThrow(DeviceRevokedError);
  });

  it("scenario: expired_token & token rotation - token rotation issues new access & refresh tokens", () => {
    const mockServer = new MockProtocolServer("healthy");
    const client = createTestClient(mockServer);

    // Initial auth
    const bootstrap = client.bootstrapDeviceAuth();
    const tokenRes = client.exchangeDeviceToken(bootstrap.deviceCode);
    const oldAccessToken = tokenRes.accessToken;
    const oldRefreshToken = tokenRes.refreshToken;

    // Rotate token
    const rotated = client.rotateToken();
    expect(rotated.accessToken).not.toBe(oldAccessToken);
    expect(rotated.refreshToken).not.toBe(oldRefreshToken);
    expect(client.getAccessToken()).toBe(rotated.accessToken);

    // Attempting to reuse old refresh token should fail
    expect(() =>
      mockServer.handleTokenRotation({
        grantType: "refresh_token",
        refreshToken: oldRefreshToken,
        deviceId: "dev-test-001",
        installationId: "inst-test-001",
      }),
    ).toThrow(ValidationError);
  });

  it("scenario: corrupt_artifact - detects checksum mismatch when artifact bytes are corrupted", () => {
    const mockServer = new MockProtocolServer("corrupt_artifact");
    const client = createTestClient(mockServer);

    const dummyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(() => client.downloadArtifact(dummyDigest)).toThrow(ChecksumMismatchError);
  });

  it("scenario: decompression_bomb - prevents oversized artifact downloads", () => {
    const mockServer = new MockProtocolServer("decompression_bomb");
    const client = createTestClient(mockServer);

    const dummyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(() => client.downloadArtifact(dummyDigest)).toThrow(DecompressionBombError);
  });

  it("scenario: rate_limited - server returns 429 RateLimitedError with retryAfterMs", () => {
    const mockServer = new MockProtocolServer("rate_limited");
    const client = createTestClient(mockServer);

    expect(() => client.bootstrapDeviceAuth()).toThrow(RateLimitedError);
  });

  it("scenario: clock_skew - health negotiation throws ClockSkewError when skew exceeds tolerance", () => {
    const mockServer = new MockProtocolServer("clock_skew");
    const client = createTestClient(mockServer);

    expect(() => client.negotiateHealth()).toThrow(ClockSkewError);
  });

  it("scenario: upgrade_required - throws UpgradeRequiredError when protocol version is deprecated", () => {
    const mockServer = new MockProtocolServer("upgrade_required");
    const client = createTestClient(mockServer);

    expect(() => client.bootstrapDeviceAuth()).toThrow(UpgradeRequiredError);
  });

  it("scenario: partial_batch_failure - classifies failed observation items and generates dead-letter records", () => {
    const mockServer = new MockProtocolServer("partial_batch_failure");
    const client = createTestClient(mockServer);

    const obs1 = {
      eventId: "evt-good-001",
      schemaVersion: "1.0.0" as const,
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
    };

    const obs2 = {
      eventId: "evt-bad-002",
      schemaVersion: "1.0.0" as const,
      sessionId: "sess-001",
      timestamp: new Date().toISOString(),
      causalRef: { causalSequence: 2 },
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
      },
      type: "session_lifecycle" as const,
      lifecycleType: "end" as const,
      harnessName: "claude-code",
    };

    const { response } = client.sendObservationBatch([obs1, obs2], "cursor-part-1");
    expect(response.status).toBe("partial");
    expect(response.acceptedCount).toBe(1);
    expect(response.rejectedCount).toBe(1);
    expect(response.errors).toHaveLength(1);
    expect(response.errors[0].eventId).toBe("evt-bad-002");
    expect(response.deadLetters).toHaveLength(1);
    expect(response.deadLetters[0].suggestedAction).toBe("discard");
  });
});
