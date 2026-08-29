import { describe, expect, it } from "vitest";
import {
  ClientStreamMessagePayloadSchema,
  ExponentialBackoff,
  ReplayBuffer,
  ServerStreamMessagePayloadSchema,
  StreamAckSchema,
  StreamCatalogInvalidationSchema,
  StreamClientHeartbeatSchema,
  StreamCloudToolCatalogChangeSchema,
  StreamDeadLetterQueue,
  StreamDeploymentCommandSchema,
  StreamDeviceStatusReportSchema,
  StreamForceResyncSchema,
  StreamInvocationMetricsSchema,
  StreamMessageSchema,
  StreamResyncRequestSchema,
  StreamSequencer,
  StreamServerHeartbeatAckSchema,
  createStreamMessage,
} from "../src/index.js";

describe("Control Stream Protocol & Sequencing", () => {
  it("validates all client-to-server stream message schemas", () => {
    const heartbeat = {
      type: "client.heartbeat" as const,
      timestamp: new Date().toISOString(),
      sequence: 1,
      uptimeMs: 12000,
      activeSessions: 2,
    };
    expect(StreamClientHeartbeatSchema.parse(heartbeat).type).toBe("client.heartbeat");

    const statusReport = {
      type: "client.device_status" as const,
      deviceId: "dev-001",
      cpuUsagePercent: 35.2,
      memoryUsageBytes: 524288000,
      activeWorkers: 3,
      activeSessions: 2,
      timestamp: new Date().toISOString(),
    };
    expect(StreamDeviceStatusReportSchema.parse(statusReport).cpuUsagePercent).toBe(35.2);

    const ack = {
      type: "client.ack" as const,
      ackSequence: 4,
      messageId: "msg-004",
      status: "processed" as const,
      timestamp: new Date().toISOString(),
    };
    expect(StreamAckSchema.parse(ack).status).toBe("processed");

    const resync = {
      type: "client.resync_request" as const,
      reason: "gap_detected" as const,
      lastKnownServerSequence: 2,
      workspaceId: "ws-001",
      timestamp: new Date().toISOString(),
    };
    expect(StreamResyncRequestSchema.parse(resync).reason).toBe("gap_detected");

    const metrics = {
      type: "client.invocation_metrics" as const,
      toolId: "tool-git-commit",
      deploymentId: "dep-001",
      durationMs: 145.6,
      success: true,
      timestamp: new Date().toISOString(),
    };
    expect(StreamInvocationMetricsSchema.parse(metrics).toolId).toBe("tool-git-commit");

    expect(ClientStreamMessagePayloadSchema.parse(heartbeat).type).toBe("client.heartbeat");
    expect(ClientStreamMessagePayloadSchema.parse(metrics).type).toBe("client.invocation_metrics");
  });

  it("validates all server-to-client stream message schemas", () => {
    const heartbeatAck = {
      type: "server.heartbeat_ack" as const,
      timestamp: new Date().toISOString(),
      sequence: 1,
      serverTime: new Date().toISOString(),
    };
    expect(StreamServerHeartbeatAckSchema.parse(heartbeatAck).type).toBe("server.heartbeat_ack");

    const deployCmd = {
      type: "server.deployment_command" as const,
      commandId: "cmd-001",
      commandType: "canary" as const,
      deploymentId: "dep-001",
      toolId: "tool-git-commit",
      version: "1.0.0",
      canaryWeight: 20,
      timestamp: new Date().toISOString(),
    };
    expect(StreamDeploymentCommandSchema.parse(deployCmd).canaryWeight).toBe(20);

    const catInval = {
      type: "server.catalog_invalidation" as const,
      workspaceId: "ws-001",
      toolIds: ["tool-git-commit"],
      reason: "version_published" as const,
      timestamp: new Date().toISOString(),
    };
    expect(StreamCatalogInvalidationSchema.parse(catInval).toolIds).toHaveLength(1);

    const toolChange = {
      type: "server.tool_catalog_change" as const,
      changeType: "added" as const,
      toolId: "tool-git-commit",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    };
    expect(StreamCloudToolCatalogChangeSchema.parse(toolChange).changeType).toBe("added");

    const forceResync = {
      type: "server.force_resync" as const,
      workspaceId: "ws-001",
      reason: "Sequence desynchronization detected",
      targetSequence: 10,
      timestamp: new Date().toISOString(),
    };
    expect(StreamForceResyncSchema.parse(forceResync).targetSequence).toBe(10);

    expect(ServerStreamMessagePayloadSchema.parse(deployCmd).type).toBe(
      "server.deployment_command",
    );
  });

  it("sequencer handles in-order processing, duplicate detection, and out-of-order gap reassembly", () => {
    const sequencer = new StreamSequencer();
    expect(sequencer.getExpectedSequence()).toBe(0);

    const msg0 = createStreamMessage(0, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 0,
      uptimeMs: 1000,
    });
    const msg1 = createStreamMessage(1, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 1,
      uptimeMs: 2000,
    });
    const msg2 = createStreamMessage(2, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 2,
      uptimeMs: 3000,
    });
    const msg3 = createStreamMessage(3, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 3,
      uptimeMs: 4000,
    });

    // 1. In-order msg0
    const res0 = sequencer.processInbound(msg0);
    expect(res0.status).toBe("ok");
    expect(sequencer.getExpectedSequence()).toBe(1);

    // 2. Duplicate msg0
    const dupRes = sequencer.processInbound(msg0);
    expect(dupRes.status).toBe("duplicate");
    expect(sequencer.getExpectedSequence()).toBe(1);

    // 3. Gap: deliver msg2 and msg3 before msg1
    const gap2 = sequencer.processInbound(msg2);
    expect(gap2.status).toBe("gap");
    expect(gap2.gapSize).toBe(1);
    expect(gap2.bufferedCount).toBe(1);

    const gap3 = sequencer.processInbound(msg3);
    expect(gap3.status).toBe("gap");
    expect(gap3.bufferedCount).toBe(2);
    expect(sequencer.getExpectedSequence()).toBe(1); // Still waiting for 1

    // 4. Deliver missing msg1
    const res1 = sequencer.processInbound(msg1);
    expect(res1.status).toBe("ok");
    expect(sequencer.getExpectedSequence()).toBe(2);

    // 5. Flush buffered messages: msg2 and msg3 should now be flushed in order
    const flushed = sequencer.flushBuffered();
    expect(flushed).toHaveLength(2);
    expect(flushed[0].sequence).toBe(2);
    expect(flushed[1].sequence).toBe(3);
    expect(sequencer.getExpectedSequence()).toBe(4);
  });

  it("replay buffer stores unacknowledged messages and trims upon acknowledgment", () => {
    const replayBuffer = new ReplayBuffer();

    const msg1 = createStreamMessage(1, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 1,
      uptimeMs: 100,
    });
    const msg2 = createStreamMessage(2, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 2,
      uptimeMs: 200,
    });
    const msg3 = createStreamMessage(3, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 3,
      uptimeMs: 300,
    });

    replayBuffer.add(msg1);
    replayBuffer.add(msg2);
    replayBuffer.add(msg3);

    expect(replayBuffer.size()).toBe(3);
    expect(replayBuffer.getUnacknowledged()).toHaveLength(3);
    expect(replayBuffer.getMessagesSince(1)).toHaveLength(2); // msg2, msg3

    // Acknowledge up to sequence 2
    const acked = replayBuffer.acknowledge(2);
    expect(acked).toBe(2);
    expect(replayBuffer.size()).toBe(1);
    expect(replayBuffer.getUnacknowledged()[0].sequence).toBe(3);
  });

  it("exponential backoff scales with attempts and respects max delay", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 100,
      maxDelayMs: 1000,
      factor: 2,
      jitter: 0,
    });

    expect(backoff.nextDelay()).toBe(100);
    expect(backoff.nextDelay()).toBe(200);
    expect(backoff.nextDelay()).toBe(400);
    expect(backoff.nextDelay()).toBe(800);
    expect(backoff.nextDelay()).toBe(1000); // capped at maxDelayMs
    expect(backoff.nextDelay()).toBe(1000);

    expect(backoff.getAttempts()).toBe(6);
    backoff.reset();
    expect(backoff.getAttempts()).toBe(0);
    expect(backoff.nextDelay()).toBe(100);
  });

  it("dead letter queue manages permanently failed stream messages", () => {
    const dlq = new StreamDeadLetterQueue({ maxSize: 2 });
    const msg = createStreamMessage(1, {
      type: "client.heartbeat",
      timestamp: new Date().toISOString(),
      sequence: 1,
      uptimeMs: 100,
    });

    dlq.enqueue(msg, "Max retries exceeded", 5);
    expect(dlq.size()).toBe(1);
    expect(dlq.getDeadLetters()[0].error).toBe("Max retries exceeded");

    dlq.enqueue(msg, "Second error", 5);
    dlq.enqueue(msg, "Third error", 5); // Should evict first item due to maxSize: 2
    expect(dlq.size()).toBe(2);
    expect(dlq.getDeadLetters()[1].error).toBe("Third error");

    dlq.clear();
    expect(dlq.size()).toBe(0);
  });
});
