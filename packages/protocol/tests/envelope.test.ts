import { hashCanonicalContent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  ClockSkewError,
  ProtocolMessageEnvelopeSchema,
  assertEnvelopeClockSkew,
  createProtocolEnvelope,
  isEnvelopeExpired,
  validateProtocolEnvelope,
  verifyPayloadDigest,
} from "../src/index.js";

describe("ProtocolMessageEnvelope", () => {
  const samplePayload = {
    eventType: "tool_execution",
    sessionId: "sess-123",
    toolId: "tool-git-commit",
    args: { message: "Initial commit" },
  };

  it("creates a valid protocol envelope with canonical payload digest and defaults", () => {
    const envelope = createProtocolEnvelope({
      payloadType: "tool_execution",
      payload: samplePayload,
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 1,
    });

    expect(envelope.version).toBe("1.0.0");
    expect(envelope.messageId).toBeDefined();
    expect(envelope.deviceId).toBe("dev-001");
    expect(envelope.installationId).toBe("inst-001");
    expect(envelope.workspaceId).toBe("ws-001");
    expect(envelope.sequence).toBe(1);
    expect(envelope.compression).toBe("none");
    expect(envelope.payloadType).toBe("tool_execution");
    expect(envelope.payloadDigest).toBe(hashCanonicalContent(samplePayload));
    expect(envelope.payload).toEqual(samplePayload);
    expect(new Date(envelope.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("verifies matching payload digest correctly", () => {
    const envelope = createProtocolEnvelope({
      payloadType: "test",
      payload: { count: 42, name: "test" },
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 0,
    });

    expect(verifyPayloadDigest(envelope)).toBe(true);
  });

  it("throws ChecksumMismatchError when payload has been tampered with", () => {
    const envelope = createProtocolEnvelope({
      payloadType: "test",
      payload: { count: 42 },
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 0,
    });

    // Tamper with payload after envelope creation
    const tampered = { ...envelope, payload: { count: 999 } };

    expect(() => verifyPayloadDigest(tampered)).toThrow(ChecksumMismatchError);
  });

  it("validates envelope structure against Zod schema", () => {
    const envelope = createProtocolEnvelope({
      payloadType: "test",
      payload: { hello: "world" },
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 5,
      causationId: "msg-000",
      correlationId: "corr-999",
      idempotencyKey: "idem-key-1",
      traceContext: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
      },
    });

    const parsed = validateProtocolEnvelope(envelope);
    expect(parsed.messageId).toBe(envelope.messageId);
    expect(parsed.causationId).toBe("msg-000");
    expect(parsed.correlationId).toBe("corr-999");
    expect(parsed.idempotencyKey).toBe("idem-key-1");
    expect(parsed.traceContext?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("detects expired envelopes based on expiresAt", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    const expiredEnvelope = createProtocolEnvelope({
      payloadType: "test",
      payload: {},
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 0,
      expiresAt: pastDate,
    });

    const validEnvelope = createProtocolEnvelope({
      payloadType: "test",
      payload: {},
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 0,
      expiresAt: futureDate,
    });

    expect(isEnvelopeExpired(expiredEnvelope)).toBe(true);
    expect(isEnvelopeExpired(validEnvelope)).toBe(false);
  });

  it("asserts clock skew and throws ClockSkewError when skew exceeds tolerance", () => {
    const skewedPastTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10m ago

    const skewedEnvelope = createProtocolEnvelope({
      payloadType: "test",
      payload: {},
      deviceId: "dev-001",
      installationId: "inst-001",
      workspaceId: "ws-001",
      sequence: 0,
      createdAt: skewedPastTime,
    });

    expect(() => assertEnvelopeClockSkew(skewedEnvelope, { maxSkewMs: 300_000 })).toThrow(
      ClockSkewError,
    );

    // Should not throw within tolerance
    expect(() =>
      assertEnvelopeClockSkew(skewedEnvelope, { maxSkewMs: 15 * 60 * 1000 }),
    ).not.toThrow();
  });
});
