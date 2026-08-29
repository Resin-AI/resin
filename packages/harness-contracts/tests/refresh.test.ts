import { describe, expect, it } from "vitest";
import {
  RefreshOutcomeSchema,
  RefreshResultSchema,
  createRefreshResult,
  determineRefreshOutcome,
} from "../src/refresh.js";
import type { RefreshCapability } from "../src/types.js";

describe("Catalog Refresh Outcomes & Capability Mapping", () => {
  it("validates all 5 RefreshOutcome variants", () => {
    const outcomes = [
      "native_list_change",
      "context_nudge",
      "next_session_required",
      "unsupported",
      "failed",
    ] as const;

    for (const outcome of outcomes) {
      expect(RefreshOutcomeSchema.parse(outcome)).toBe(outcome);
    }

    expect(() => RefreshOutcomeSchema.parse("unknown_outcome")).toThrow();
  });

  it("constructs valid RefreshResult via createRefreshResult", () => {
    const result = createRefreshResult("native_list_change", {
      message: "Dynamic reload acknowledged by harness",
      catalogVersion: "1.0.0",
      affectedToolCount: 4,
      details: { rpcId: "123" },
    });

    expect(result.outcome).toBe("native_list_change");
    expect(result.affectedToolCount).toBe(4);
    expect(result.requiresRestart).toBe(false);
    expect(RefreshResultSchema.parse(result)).toEqual(result);

    // next_session_required automatically sets requiresRestart to true if omitted
    const restartResult = createRefreshResult("next_session_required", {
      message: "Session restart needed for tool registration",
      catalogVersion: "1.0.0",
    });
    expect(restartResult.requiresRestart).toBe(true);
  });

  it("evaluates capability matrix in determineRefreshOutcome", () => {
    // 1. Native list change takes highest precedence
    const nativeCap: RefreshCapability = {
      supportsNativeListChange: true,
      supportsContextNudge: true,
      requiresSessionRestart: false,
    };
    expect(determineRefreshOutcome(nativeCap)).toBe("native_list_change");

    // 2. Context nudge with active session
    const nudgeCap: RefreshCapability = {
      supportsNativeListChange: false,
      supportsContextNudge: true,
      requiresSessionRestart: false,
    };
    expect(determineRefreshOutcome(nudgeCap, { hasActiveSession: true })).toBe("context_nudge");

    // 3. Requires restart
    const restartCap: RefreshCapability = {
      supportsNativeListChange: false,
      supportsContextNudge: false,
      requiresSessionRestart: true,
    };
    expect(determineRefreshOutcome(restartCap)).toBe("next_session_required");

    // 4. Unsupported
    const unsupportedCap: RefreshCapability = {
      supportsNativeListChange: false,
      supportsContextNudge: false,
      requiresSessionRestart: false,
    };
    expect(determineRefreshOutcome(unsupportedCap)).toBe("unsupported");
  });
});
