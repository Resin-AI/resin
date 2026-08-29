import { describe, expect, it } from "vitest";
import {
  CURRENT_SAFETY_GATE_VERSION,
  ProductionSafetyGateStatusSchema,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  REQUIRED_SAFETY_CHECKS,
  SAFETY_GATE_ERROR_CODES,
  SAFETY_GATE_VERSIONS,
  SYSTEM_ALLOWED_TOOLS,
  SafetyAttestationRecordSchema,
  SafetyGateRefusalSchema,
  UNSAFE_DEV_OVERRIDE_ENV_VAR,
  UNSAFE_ENV_PREFIX,
  isSafetyGateBypassTool,
} from "../src/index.js";

describe("Safety Gate Contracts & Schemas", () => {
  it("exports expected version constants and error codes", () => {
    expect(CURRENT_SAFETY_GATE_VERSION).toBe("1.0.0");
    expect(REQUIRED_RUNTIME_VERSION).toBe("0.1.0");
    expect(REQUIRED_BROKER_PROTOCOL_VERSION).toBe("1.0.0");
    expect(REQUIRED_BUNDLE_VERIFIER_VERSION).toBe("1.0.0");
    expect(REQUIRED_POLICY_VERSION).toBe("1.0.0");

    expect(SAFETY_GATE_VERSIONS).toEqual({
      runtimeVersion: "0.1.0",
      brokerProtocolVersion: "1.0.0",
      bundleVerifierVersion: "1.0.0",
      policyVersion: "1.0.0",
    });

    expect(SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION).toBe("MISSING_ATTESTATION");
    expect(SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION).toBe("EXPIRED_ATTESTATION");
    expect(SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION).toBe("INCOMPATIBLE_VERSION");
    expect(SAFETY_GATE_ERROR_CODES.GATE_FAIL_CLOSED).toBe("GATE_FAIL_CLOSED");

    expect(UNSAFE_DEV_OVERRIDE_ENV_VAR).toBe("RESIN_UNSAFE_ALLOW_AUTONOMOUS");
    expect(UNSAFE_ENV_PREFIX).toBe("RESIN_UNSAFE_");
    expect(REQUIRED_SAFETY_CHECKS).toContain("sandboxIsolation");
    expect(SYSTEM_ALLOWED_TOOLS).toContain("search_tools");
  });

  it("identifies safety gate bypass tools correctly", () => {
    expect(isSafetyGateBypassTool("search_tools")).toBe(true);
    expect(isSafetyGateBypassTool("get_tool_schema")).toBe(true);
    expect(isSafetyGateBypassTool("invoke_tool")).toBe(true);
    expect(isSafetyGateBypassTool("manage_tools")).toBe(true);
    expect(isSafetyGateBypassTool("builtin_status")).toBe(true);
    expect(isSafetyGateBypassTool("system_audit")).toBe(true);
    expect(isSafetyGateBypassTool("doctor")).toBe(true);
    expect(isSafetyGateBypassTool("status")).toBe(true);

    expect(isSafetyGateBypassTool("my_generated_tool")).toBe(false);
    expect(isSafetyGateBypassTool("tool_12345")).toBe(false);
    expect(isSafetyGateBypassTool("")).toBe(false);
  });

  it("validates valid SafetyAttestationRecord", () => {
    const validRecord = {
      attestationId: "att_01HXYZ1234567890ABCDEF",
      schemaVersion: "1.0.0",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      environment: "production",
      compatibility: {
        runtimeVersion: "0.1.0",
        brokerProtocolVersion: "1.0.0",
        bundleVerifierVersion: "1.0.0",
        policyVersion: "1.0.0",
      },
      checks: {
        sandboxIsolation: true,
        networkIsolation: true,
        filesystemMediation: true,
        secretRedaction: true,
        signatureVerification: true,
      },
      metadata: {
        issuer: "ci-safety-pipeline",
      },
      signature: {
        keyId: "key-prod-01",
        algorithm: "ed25519",
        signature: "sig_abc123",
        signedAt: new Date().toISOString(),
      },
    };

    const parsed = SafetyAttestationRecordSchema.parse(validRecord);
    expect(parsed.attestationId).toBe("att_01HXYZ1234567890ABCDEF");
    expect(parsed.environment).toBe("production");
    expect(parsed.checks.sandboxIsolation).toBe(true);
  });

  it("rejects invalid SafetyAttestationRecord with invalid dates or versions", () => {
    const invalidRecord = {
      attestationId: "",
      schemaVersion: "invalid-semver",
      issuedAt: "not-a-date",
      expiresAt: "not-a-date",
      compatibility: {
        runtimeVersion: "bad",
      },
      checks: "not-an-object",
    };

    const result = SafetyAttestationRecordSchema.safeParse(invalidRecord);
    expect(result.success).toBe(false);
  });

  it("validates ProductionSafetyGateStatusSchema", () => {
    const status = {
      isOpen: false,
      status: "failed",
      evaluatedAt: new Date().toISOString(),
      versions: {
        runtimeVersion: "0.1.0",
        brokerProtocolVersion: "1.0.0",
        bundleVerifierVersion: "1.0.0",
        policyVersion: "1.0.0",
      },
      reasons: ["Missing safety attestation record."],
      unmetRequirements: [
        {
          code: "MISSING_ATTESTATION",
          message: "No production safety attestation found.",
          remediation: "Run 'resin doctor --repair' to generate a valid attestation.",
        },
      ],
      unsafeOverrideActive: false,
    };

    const parsed = ProductionSafetyGateStatusSchema.parse(status);
    expect(parsed.isOpen).toBe(false);
    expect(parsed.status).toBe("failed");
    expect(parsed.unmetRequirements).toHaveLength(1);
    expect(parsed.unmetRequirements[0].code).toBe("MISSING_ATTESTATION");
  });

  it("validates SafetyGateRefusalSchema", () => {
    const refusal = {
      isError: true,
      refusalCode: "GATE_FAIL_CLOSED",
      refusalReason: "Autonomous tool execution is blocked by the production safety gate.",
      remediation: "Run 'resin doctor --repair' or install a valid safety attestation.",
      unmetGates: ["MISSING_ATTESTATION"],
      evaluatedAt: new Date().toISOString(),
      content: [
        {
          type: "text",
          text: "Refusal: Safety gate closed (MISSING_ATTESTATION)",
        },
      ],
      details: {
        toolName: "custom_generated_tool",
      },
    };

    const parsed = SafetyGateRefusalSchema.parse(refusal);
    expect(parsed.isError).toBe(true);
    expect(parsed.refusalCode).toBe("GATE_FAIL_CLOSED");
    expect(parsed.unmetGates).toEqual(["MISSING_ATTESTATION"]);
    expect(parsed.content[0].text).toContain("Refusal");
  });
});
