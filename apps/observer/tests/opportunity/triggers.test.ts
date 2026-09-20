import { ProvenPatternDtoSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { TriggerEvaluator } from "../../src/opportunity/triggers.js";
import type { WorkflowCluster } from "../../src/opportunity/types.js";

const timestamp = "2026-09-20T00:00:00.000Z";

function fractionalCluster(): WorkflowCluster {
  return {
    clusterId: "cluster_fractional_steps",
    workspaceId: "workspace_fractional_steps",
    version: "1.0.0",
    structuralHash: "fractional_steps",
    representativeSignature: {
      signatureId: "signature_fractional_steps",
      structuralHash: "fractional_steps",
      operations: ["tool:read", "tool:write"],
      commandPatterns: [],
      toolClasses: ["read", "write"],
      normalizedPaths: [],
      argumentSchemaHashes: [],
      stepCount: 2,
      durationMs: 1000,
      tokenCount: 100,
      retryCount: 0,
      estimatedCostUsd: null,
    },
    episodes: [],
    episodeCount: 2,
    distinctSessionIds: ["session_one", "session_two"],
    completedOccurrences: 2,
    metrics: {
      totalDurationMs: 2000,
      avgDurationMs: 1000,
      totalTokens: 200,
      avgTokens: 100,
      totalCostUsd: null,
      totalRetries: 0,
      totalStepCount: 5,
      avgStepCount: 2.5,
    },
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    evidenceEventIds: [],
  };
}

describe("TriggerEvaluator", () => {
  it("emits an integer step count for a cluster with a fractional average", () => {
    const result = new TriggerEvaluator().evaluateCluster(fractionalCluster());

    expect(result.metrics.stepCount).toBe(3);
    expect(() =>
      ProvenPatternDtoSchema.shape.localVerdicts.shape.trigger.parse(result),
    ).not.toThrow();
  });
});
