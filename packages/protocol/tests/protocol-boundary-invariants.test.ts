import { hashCanonicalContent } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  AuthClaimsSchema,
  ChecksumMismatchError,
  ClockSkewError,
  PROTOCOL_VERSION,
  ProtocolMessageEnvelopeSchema,
  SupportedProtocolVersionSchema,
  TraceContextSchema,
  UpgradeRequiredError,
  ValidationError,
  assertNoPrivateImplementationObjects,
  assertSupportedProtocolVersion,
  createProtocolEnvelope,
  isSupportedProtocolVersion,
  strictParse,
  validateProtocolEnvelope,
} from "../src/index.js";

describe("Protocol Boundary & Schema Invariants (Phase 1)", () => {
  const validEnvelopeData = {
    version: "1.0.0",
    messageId: "msg-001",
    deviceId: "dev-001",
    installationId: "inst-001",
    workspaceId: "ws-001",
    sequence: 1,
    createdAt: new Date().toISOString(),
    compression: "none" as const,
    payloadType: "test.event",
    payloadDigest: hashCanonicalContent({ hello: "world" }),
    payload: { hello: "world" },
  };

  describe("Explicit Schema Versioning & SemVer Compatibility", () => {
    it("accepts valid SemVer 1.x protocol versions", () => {
      expect(isSupportedProtocolVersion("1.0.0")).toBe(true);
      expect(isSupportedProtocolVersion("1.1.0")).toBe(true);
      expect(isSupportedProtocolVersion("1.99.12")).toBe(true);
      expect(isSupportedProtocolVersion("1.0.0-rc.1")).toBe(true);

      expect(() => assertSupportedProtocolVersion("1.0.0")).not.toThrow();
      expect(() => assertSupportedProtocolVersion("1.2.3")).not.toThrow();
    });

    it("rejects missing version during wire parsing", () => {
      const missingVersionEnvelope = {
        ...validEnvelopeData,
        version: undefined,
      };

      expect(() => ProtocolMessageEnvelopeSchema.parse(missingVersionEnvelope)).toThrow();
      expect(() => validateProtocolEnvelope(missingVersionEnvelope)).toThrow();
      expect(() => assertSupportedProtocolVersion(undefined)).toThrow(ValidationError);
      expect(() => assertSupportedProtocolVersion("")).toThrow(ValidationError);
    });

    it("rejects malformed non-SemVer version strings", () => {
      const invalidVersions = ["v1.0.0", "1", "1.0", "latest", "alpha-1.0.0", "1.0.0.0"];
      for (const ver of invalidVersions) {
        expect(isSupportedProtocolVersion(ver)).toBe(false);
        expect(() => assertSupportedProtocolVersion(ver)).toThrow(ValidationError);
        expect(() => SupportedProtocolVersionSchema.parse(ver)).toThrow();
      }
    });

    it("rejects unsupported future major versions with UpgradeRequiredError", () => {
      const futureVersionEnvelope = {
        ...validEnvelopeData,
        version: "2.0.0",
      };

      expect(() => assertSupportedProtocolVersion("2.0.0")).toThrow(UpgradeRequiredError);
      expect(() => validateProtocolEnvelope(futureVersionEnvelope)).toThrow();
    });

    it("rejects downgraded/unsupported major versions", () => {
      expect(() => assertSupportedProtocolVersion("0.9.0")).toThrow(UpgradeRequiredError);
      expect(() => assertSupportedProtocolVersion("0.1.0")).toThrow(UpgradeRequiredError);
    });

    it("populates default version for envelope producers when omitted", () => {
      const envelope = createProtocolEnvelope({
        deviceId: "dev-001",
        installationId: "inst-001",
        workspaceId: "ws-001",
        sequence: 1,
        payloadType: "test.event",
        payload: { ok: true },
      });
      expect(envelope.version).toBe(PROTOCOL_VERSION);
    });
  });

  describe("Strict Schema Validation & Unknown-Field Rejection", () => {
    it("rejects unknown properties on ProtocolMessageEnvelope", () => {
      const pollutedEnvelope = {
        ...validEnvelopeData,
        unknownField: "malicious_injection",
        injectedParameter: 12345,
      };

      expect(() => ProtocolMessageEnvelopeSchema.parse(pollutedEnvelope)).toThrow();
      expect(() => validateProtocolEnvelope(pollutedEnvelope)).toThrow();
    });

    it("rejects unknown properties on TraceContext", () => {
      const pollutedTraceContext = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        unknownField: "probe",
      };

      expect(() => TraceContextSchema.parse(pollutedTraceContext)).toThrow();
    });

    it("rejects private implementation objects in envelope validation", () => {
      const envelopeWithPrivateData = {
        ...validEnvelopeData,
        payload: {
          _cloudInternal: { secret: true },
        },
      };

      expect(() => validateProtocolEnvelope(envelopeWithPrivateData)).toThrow(ValidationError);
    });
  });

  describe("Prohibition of Raw Private Implementation Objects", () => {
    it("rejects raw DynamoDB attribute descriptor structures", () => {
      const dynamoPayload = {
        Item: {
          id: { S: "ws-123" },
          count: { N: "42" },
        },
      };

      expect(() => assertNoPrivateImplementationObjects(dynamoPayload)).toThrow(ValidationError);
      expect(() =>
        createProtocolEnvelope({
          deviceId: "dev-001",
          installationId: "inst-001",
          workspaceId: "ws-001",
          sequence: 1,
          payloadType: "test.dynamo",
          payload: dynamoPayload,
        }),
      ).toThrow(ValidationError);
    });

    it("rejects private cloud internal fields and evaluation candidates", () => {
      const privateCloudPayload = {
        _cloudInternal: { executionContext: "sandbox-internal" },
        _rawEvolutionCandidate: { prompt: "eval" },
      };

      expect(() => assertNoPrivateImplementationObjects(privateCloudPayload)).toThrow(
        ValidationError,
      );
    });

    it("rejects AWS internal metadata properties", () => {
      const sqsPayload = {
        ReceiptHandle: "AQEB...receipt",
        MD5OfBody: "d41d8cd98f00b204e9800998ecf8427e",
      };

      expect(() => assertNoPrivateImplementationObjects(sqsPayload)).toThrow(ValidationError);
    });

    it("rejects prototype pollution attempts", () => {
      const protoObj = JSON.parse('{"__proto__": {"admin": true}, "validKey": "data"}');
      expect(() => assertNoPrivateImplementationObjects(protoObj)).toThrow(ValidationError);
    });
  });

  describe("Strict Parsing & Envelope Verification Helpers", () => {
    it("strictly parses valid schemas with strictParse helper", () => {
      const parsed = strictParse(
        AuthClaimsSchema,
        {
          accountId: "acc-001",
          deviceId: "dev-001",
          installationId: "inst-001",
          workspaceId: "ws-001",
          scopes: ["device:connect"],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        "AuthClaims",
      );

      expect(parsed.accountId).toBe("acc-001");
      expect(parsed.rawUploadConsent).toBe(false);
    });

    it("throws ValidationError with context on strictParse failure", () => {
      expect(() =>
        strictParse(
          AuthClaimsSchema,
          {
            accountId: "acc-001",
            // missing required fields
          },
          "AuthClaimsTest",
        ),
      ).toThrow(ValidationError);
    });

    it("validates protocol envelope with payload schema and digest verification", () => {
      const envelope = createProtocolEnvelope({
        deviceId: "dev-001",
        installationId: "inst-001",
        workspaceId: "ws-001",
        sequence: 1,
        payloadType: "test.event",
        payload: { count: 10 },
      });

      const validated = validateProtocolEnvelope(envelope, undefined, { verifyDigest: true });

      expect(validated.messageId).toBe(envelope.messageId);
      expect(validated.payloadDigest).toBe(envelope.payloadDigest);
    });

    it("throws ChecksumMismatchError when payload digest is tampered", () => {
      const envelope = createProtocolEnvelope({
        deviceId: "dev-001",
        installationId: "inst-001",
        workspaceId: "ws-001",
        sequence: 1,
        payloadType: "test.event",
        payload: { count: 10 },
      });

      const tampered = {
        ...envelope,
        payload: { count: 999 }, // modified payload without updating digest
      };

      expect(() => validateProtocolEnvelope(tampered, undefined, { verifyDigest: true })).toThrow(
        ChecksumMismatchError,
      );
    });
  });
});
