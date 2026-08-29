import { SAFETY_GATE_ERROR_CODES, UNSAFE_DEV_OVERRIDE_ENV_VAR } from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditTrailManager, DeploymentActivator, buildSanitizedEnv } from "../src/index.js";

describe("Observer Safety Gate Activator & Worker Environment Sanitization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR];
    delete process.env.RESIN_UNSAFE_DEV_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("WorkerSupervisor buildSanitizedEnv", () => {
    it("strictly strips RESIN_UNSAFE_* from inherited process environment", () => {
      process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR] = "true";
      process.env.RESIN_UNSAFE_DEBUG = "1";
      process.env.SAFE_CUSTOM_VAR = "hello";

      const env = buildSanitizedEnv({}, true);

      expect(env.SAFE_CUSTOM_VAR).toBe("hello");
      expect(env[UNSAFE_DEV_OVERRIDE_ENV_VAR]).toBeUndefined();
      expect(env.RESIN_UNSAFE_DEBUG).toBeUndefined();
    });

    it("strictly strips RESIN_UNSAFE_* passed in customEnv", () => {
      const customEnv = {
        NORMAL_PARAM: "valid",
        [UNSAFE_DEV_OVERRIDE_ENV_VAR]: "1",
        RESIN_UNSAFE_INJECT: "malicious",
      };

      const env = buildSanitizedEnv(customEnv, false);

      expect(env.NORMAL_PARAM).toBe("valid");
      expect(env[UNSAFE_DEV_OVERRIDE_ENV_VAR]).toBeUndefined();
      expect(env.RESIN_UNSAFE_INJECT).toBeUndefined();
    });
  });

  describe("DeploymentActivator Gate Enforcement & Tamper-Evident Audit Records", () => {
    it("blocks deployment activation when gate is fail-closed and emits tamper-evident audit record", async () => {
      const store = await createInMemoryStateStore();
      const auditTrail = new AuditTrailManager(store.conn);
      await auditTrail.initialize();

      const closedGate = {
        canExecuteTool: () => ({
          allowed: false,
          refusal: {
            isError: true as const,
            refusalCode: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
            refusalReason: "No production safety attestation found.",
            remediation: "Run 'resin doctor --repair' to generate a valid safety attestation.",
            unmetGates: [SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION],
            evaluatedAt: new Date().toISOString(),
            content: [{ type: "text" as const, text: "Safety gate closed" }],
          },
        }),
        isUnsafeOverrideActive: () => false,
      };

      const activator = new DeploymentActivator({
        conn: store.conn,
        toolRepo: store.tools,
        safetyGate: closedGate,
        auditTrail,
      });

      await expect(
        activator.activate({
          workspaceId: "ws_test_01",
          toolId: "generated_tool_abc",
          version: "1.0.0",
        }),
      ).rejects.toThrow(/Deployment activation blocked by fail-closed safety gate/);

      // Verify tamper-evident audit log was recorded
      const entries = await auditTrail.getEntries({ eventType: "safety_gate_refusal" });
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("denied");
      expect(entries[0].resourceId).toBe("generated_tool_abc");
      expect(entries[0].details.code).toBe(SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION);

      // Verify audit trail hash chain integrity
      const verifyRes = await auditTrail.verifyIntegrity();
      expect(verifyRes.valid).toBe(true);

      store.close();
    });

    it("allows deployment and logs audit warning when unsafe override is active", async () => {
      const store = await createInMemoryStateStore();
      const auditTrail = new AuditTrailManager(store.conn);
      await auditTrail.initialize();

      const overrideGate = {
        canExecuteTool: () => ({ allowed: true }),
        isUnsafeOverrideActive: () => true,
      };

      const activator = new DeploymentActivator({
        conn: store.conn,
        toolRepo: store.tools,
        safetyGate: overrideGate,
        auditTrail,
      });

      const res = await activator.activate({
        workspaceId: "ws_test_02",
        toolId: "generated_tool_override",
        version: "1.0.0",
      });

      expect(res.success).toBe(true);

      // Verify unsafe override audit record
      const overrideEntries = await auditTrail.getEntries({
        eventType: "safety_gate_unsafe_override",
      });
      expect(overrideEntries).toHaveLength(1);
      expect(overrideEntries[0].status).toBe("success");
      expect(overrideEntries[0].details.toolId).toBe("generated_tool_override");

      const verifyRes = await auditTrail.verifyIntegrity();
      expect(verifyRes.valid).toBe(true);

      store.close();
    });
  });
});
