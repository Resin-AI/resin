import { HARNESS_IDS } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  ControlPlaneDesiredStateSchema,
  ControlPlaneHarnessIdSchema,
  ControlPlaneMutationRequestSchema,
} from "../src/control-plane.js";

describe("control-plane harness ids", () => {
  it("accepts every shared harness id", () => {
    for (const id of HARNESS_IDS) {
      expect(ControlPlaneHarnessIdSchema.safeParse(id).success).toBe(true);
    }
    expect(ControlPlaneHarnessIdSchema.safeParse("not-a-harness").success).toBe(false);
  });

  it("keeps desired state from a newer peer that knows harnesses this revision does not", () => {
    const desiredState = {
      harnesses: {
        omp: { enabled: true },
        "copilot-cli": { enabled: false },
        "harness-from-the-future": { enabled: true, autoRepair: false },
      },
    };
    expect(ControlPlaneDesiredStateSchema.parse(desiredState)).toEqual(desiredState);
    expect(
      ControlPlaneMutationRequestSchema.safeParse({
        target: { scope: "workspace" },
        desiredState,
        idempotencyKey: "mutation-0001",
        source: "cli",
      }).success,
    ).toBe(true);
  });

  it("still rejects harness keys that are not identifiers", () => {
    expect(
      ControlPlaneDesiredStateSchema.safeParse({ harnesses: { "": { enabled: true } } }).success,
    ).toBe(false);
  });
});
