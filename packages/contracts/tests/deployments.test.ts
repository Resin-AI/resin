import { describe, expect, it } from "vitest";
import { validDeploymentRecord } from "../fixtures/index.js";
import {
  CanaryConfigSchema,
  DeploymentError,
  DeploymentRecordSchema,
  type DeploymentState,
  DeploymentStateSchema,
  VALID_DEPLOYMENT_TRANSITIONS,
  assertValidDeploymentTransition,
  validateDeploymentTransition,
} from "../src/deployments.js";

describe("deployments contracts and state machine", () => {
  const allStates: DeploymentState[] = [
    "drafted",
    "validating",
    "rejected",
    "replaying",
    "eligible",
    "canary",
    "promoted",
    "suspended",
    "rolling_back",
    "rolled_back",
    "retired",
  ];

  describe("DeploymentStateSchema", () => {
    it.each(allStates)("accepts valid state '%s'", (state) => {
      expect(DeploymentStateSchema.parse(state)).toBe(state);
    });

    it("rejects unknown state", () => {
      expect(() => DeploymentStateSchema.parse("in_flight")).toThrow();
    });
  });

  describe("validateDeploymentTransition & State Machine", () => {
    const stateKeys: readonly DeploymentState[] = [
      "drafted",
      "validating",
      "replaying",
      "eligible",
      "canary",
      "promoted",
      "suspended",
      "rolling_back",
      "rolled_back",
      "rejected",
      "retired",
    ];
    for (const currentState of stateKeys) {
      const allowedTargets = VALID_DEPLOYMENT_TRANSITIONS[currentState];
      for (const targetState of allowedTargets) {
        it(`permits valid transition: ${currentState} -> ${targetState}`, () => {
          const result = validateDeploymentTransition(currentState, targetState);
          expect(result.valid).toBe(true);
          expect(() => assertValidDeploymentTransition(currentState, targetState)).not.toThrow();
        });
      }
    }

    // Test illegal transitions
    it("rejects illegal transitions with structured DeploymentError", () => {
      const illegalPairs: Array<[DeploymentState, DeploymentState]> = [
        ["drafted", "promoted"],
        ["drafted", "canary"],
        ["drafted", "rolled_back"],
        ["validating", "promoted"],
        ["replaying", "promoted"],
        ["canary", "eligible"],
        ["promoted", "drafted"],
        ["promoted", "validating"],
        ["retired", "canary"],
        ["retired", "promoted"],
        ["retired", "drafted"],
        ["rolling_back", "promoted"],
      ];

      for (const [from, to] of illegalPairs) {
        const result = validateDeploymentTransition(from, to);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toBeInstanceOf(DeploymentError);
          expect(result.error.code).toBe("INVALID_TRANSITION");
          expect(result.error.currentState).toBe(from);
          expect(result.error.targetState).toBe(to);
        }

        expect(() => assertValidDeploymentTransition(from, to)).toThrow(DeploymentError);
      }
    });
  });

  describe("CanaryConfigSchema & DeploymentRecordSchema", () => {
    it("parses valid canary config", () => {
      const config = CanaryConfigSchema.parse({
        strategy: "shadow",
        trafficPercentage: 20,
        durationMinutes: 45,
        maxShadowWorkers: 3,
        autoRollbackThresholds: {
          maxErrorRate: 0.02,
          maxLatencyP95Ms: 2500,
        },
      });
      expect(config.strategy).toBe("shadow");
      expect(config.trafficPercentage).toBe(20);
      expect(config.autoRollbackThresholds.maxErrorRate).toBe(0.02);
    });

    it("parses valid deployment record fixture", () => {
      const parsed = DeploymentRecordSchema.parse(validDeploymentRecord);
      expect(parsed.deploymentId).toBe("dep_001");
      expect(parsed.state).toBe("canary");
      expect(parsed.history).toHaveLength(4);
    });
  });
});
