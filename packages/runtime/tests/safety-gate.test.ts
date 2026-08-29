import {
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  SAFETY_GATE_ERROR_CODES,
  UNSAFE_DEV_OVERRIDE_ENV_VAR,
} from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AttestationVerifier,
  SafetyGateEvaluator,
  SafetyGateRefusalError,
  createSafetyAttestation,
} from "../src/index.js";

describe("Safety Gate Runtime Engine & Attestation Verification", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("AttestationVerifier", () => {
    const verifier = new AttestationVerifier();

    it("verifies a valid fresh attestation", () => {
      const attestation = createSafetyAttestation();
      const result = verifier.verify(attestation);

      expect(result.valid).toBe(true);
      expect(result.record).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("rejects null or non-object attestation", () => {
      const result = verifier.verify(null);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION);
    });

    it("rejects expired attestation", () => {
      const pastDate = new Date(Date.now() - 10000).toISOString();
      const attestation = createSafetyAttestation({
        expiresAt: pastDate,
      });

      const result = verifier.verify(attestation);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION);
      expect(result.error).toContain("expired");
    });

    it("rejects incompatible runtime version (downgrade or upgrade mismatch)", () => {
      const attestation = createSafetyAttestation({
        compatibility: {
          runtimeVersion: "99.0.0",
          brokerProtocolVersion: REQUIRED_BROKER_PROTOCOL_VERSION,
          bundleVerifierVersion: REQUIRED_BUNDLE_VERIFIER_VERSION,
          policyVersion: REQUIRED_POLICY_VERSION,
        },
      });

      const result = verifier.verify(attestation);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION);
      expect(result.error).toContain("Runtime version mismatch");
    });

    it("rejects incompatible broker protocol version", () => {
      const attestation = createSafetyAttestation({
        compatibility: {
          runtimeVersion: REQUIRED_RUNTIME_VERSION,
          brokerProtocolVersion: "0.0.1",
          bundleVerifierVersion: REQUIRED_BUNDLE_VERIFIER_VERSION,
          policyVersion: REQUIRED_POLICY_VERSION,
        },
      });

      const result = verifier.verify(attestation);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION);
      expect(result.error).toContain("Broker protocol mismatch");
    });

    it("rejects attestation with missing required safety check", () => {
      const attestation = createSafetyAttestation({
        checks: {
          sandboxIsolation: true,
          networkIsolation: false, // failed check
          filesystemMediation: true,
          secretRedaction: true,
          signatureVerification: true,
        },
      });

      const result = verifier.verify(attestation);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.UNMET_SAFETY_CHECK);
      expect(result.error).toContain("networkIsolation");
    });

    it("rejects corrupted attestation record", () => {
      const corrupted = {
        attestationId: "invalid",
        schemaVersion: "bad-ver",
      };

      const result = verifier.verify(corrupted);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION);
    });
  });

  describe("SafetyGateEvaluator", () => {
    it("fails closed on fresh install with missing attestation", () => {
      const evaluator = new SafetyGateEvaluator({ attestation: null });
      const status = evaluator.getStatus();

      expect(status.isOpen).toBe(false);
      expect(status.status).toBe("uninitialized");
      expect(status.unmetRequirements).toHaveLength(1);
      expect(status.unmetRequirements[0].code).toBe(SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION);

      // System tools are allowed
      expect(evaluator.canExecuteTool("search_tools", "search_tools").allowed).toBe(true);
      expect(evaluator.canExecuteTool("invoke_tool", "invoke_tool").allowed).toBe(true);
      expect(evaluator.canExecuteTool("manage_tools", "manage_tools").allowed).toBe(true);
      expect(evaluator.canExecuteTool("get_tool_schema", "get_tool_schema").allowed).toBe(true);

      // Generated tools are refused
      const genCheck = evaluator.canExecuteTool("custom_gen_tool_1", "custom_gen_tool");
      expect(genCheck.allowed).toBe(false);
      expect(genCheck.refusal).toBeDefined();
      expect(genCheck.refusal?.isError).toBe(true);
      expect(genCheck.refusal?.refusalCode).toBe(SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION);
      expect(genCheck.refusal?.content[0].text).toContain("[SAFETY GATE REFUSAL]");

      expect(() => {
        evaluator.assertCanExecuteTool("custom_gen_tool_1", "custom_gen_tool");
      }).toThrow(SafetyGateRefusalError);
    });

    it("allows execution when valid attestation is present", () => {
      const attestation = createSafetyAttestation();
      const evaluator = new SafetyGateEvaluator({ attestation });
      const status = evaluator.getStatus();

      expect(status.isOpen).toBe(true);
      expect(status.status).toBe("passed");
      expect(status.unmetRequirements).toHaveLength(0);

      const check = evaluator.canExecuteTool("custom_gen_tool_1", "custom_gen_tool");
      expect(check.allowed).toBe(true);
      expect(check.refusal).toBeUndefined();
    });

    it("blocks execution when attestation expires", () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const attestation = createSafetyAttestation({ expiresAt: pastDate });
      const evaluator = new SafetyGateEvaluator({ attestation });
      const status = evaluator.getStatus();

      expect(status.isOpen).toBe(false);
      expect(status.status).toBe("failed");
      expect(status.unmetRequirements[0].code).toBe(SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION);

      const check = evaluator.canExecuteTool("custom_gen_tool_1", "custom_gen_tool");
      expect(check.allowed).toBe(false);
      expect(check.refusal?.refusalCode).toBe(SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION);
    });

    it("permits execution in unsafe development override mode with warnings", () => {
      process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR] = "1";
      const evaluator = new SafetyGateEvaluator({ attestation: null });
      const status = evaluator.getStatus();

      expect(status.isOpen).toBe(true);
      expect(status.status).toBe("unsafe_override");
      expect(status.unsafeOverrideActive).toBe(true);
      expect(status.reasons[0]).toContain("Unsafe development override");

      const check = evaluator.canExecuteTool("custom_gen_tool_1", "custom_gen_tool");
      expect(check.allowed).toBe(true);
    });

    it("supports setting attestation dynamically", () => {
      const evaluator = new SafetyGateEvaluator({ attestation: null });
      expect(evaluator.getStatus().isOpen).toBe(false);

      const validAttestation = createSafetyAttestation();
      evaluator.setAttestation(validAttestation);
      expect(evaluator.getStatus().isOpen).toBe(true);

      evaluator.setAttestation(null);
      expect(evaluator.getStatus().isOpen).toBe(false);
    });

    it("verifies filesystem broker boundary invariant against production attestation", () => {
      const validAttestation = createSafetyAttestation();
      const evaluator = new SafetyGateEvaluator({ attestation: validAttestation });
      const boundaryCheck = evaluator.verifyFilesystemBrokerBoundary();

      expect(boundaryCheck.valid).toBe(true);
      expect(boundaryCheck.error).toBeUndefined();
    });

    it("fails filesystem broker boundary verification when attestation is missing or unmet", () => {
      const evaluator = new SafetyGateEvaluator({ attestation: null });
      const boundaryCheck = evaluator.verifyFilesystemBrokerBoundary();

      expect(boundaryCheck.valid).toBe(false);
      expect(boundaryCheck.error).toBeDefined();
    });

    it("verifies command broker boundary invariant against production attestation", () => {
      const validAttestation = createSafetyAttestation();
      const evaluator = new SafetyGateEvaluator({ attestation: validAttestation });
      const boundaryCheck = evaluator.verifyCommandBrokerBoundary();

      expect(boundaryCheck.valid).toBe(true);
      expect(boundaryCheck.error).toBeUndefined();

      const invalidEvaluator = new SafetyGateEvaluator({ attestation: null });
      expect(invalidEvaluator.verifyCommandBrokerBoundary().valid).toBe(false);
    });

    it("verifies strict environment policy invariant against production attestation", () => {
      const validAttestation = createSafetyAttestation();
      const evaluator = new SafetyGateEvaluator({ attestation: validAttestation });
      const envCheck = evaluator.verifyStrictEnvironmentPolicy();

      expect(envCheck.valid).toBe(true);
      expect(envCheck.error).toBeUndefined();

      const invalidEvaluator = new SafetyGateEvaluator({ attestation: null });
      expect(invalidEvaluator.verifyStrictEnvironmentPolicy().valid).toBe(false);
    });

    it("verifies comprehensive command execution invariants", () => {
      const validAttestation = createSafetyAttestation();
      const evaluator = new SafetyGateEvaluator({ attestation: validAttestation });
      const invariantCheck = evaluator.verifyCommandExecutionInvariants();

      expect(invariantCheck.valid).toBe(true);
      expect(invariantCheck.error).toBeUndefined();
    });
  });
});
