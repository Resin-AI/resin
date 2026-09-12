import { ToolManifestSchema } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { CoverageEngine } from "../../src/opportunity/coverage.js";
import type { WorkflowCluster } from "../../src/opportunity/types.js";

const timestamp = "2026-09-12T00:00:00.000Z";
const tool = ToolManifestSchema.parse({
  id: "tool_status_probe",
  name: "inspect_git_repository",
  version: "1.0.0",
  description: "Reports the working-tree status of a Git repository.",
  parameters: {},
  runtime: { runtime: "node" },
  capabilities: { command: { allowedCommands: ["git status --short"] } },
  digest: "a".repeat(64),
  createdAt: timestamp,
});

function cluster(operations: string[], commandPatterns: string[] = []): WorkflowCluster {
  return {
    clusterId: "cluster_identity",
    workspaceId: "workspace_identity",
    version: "1.0.0",
    structuralHash: "identity",
    representativeSignature: {
      signatureId: "signature_identity",
      structuralHash: "identity",
      operations,
      commandPatterns,
      toolClasses: [],
      normalizedPaths: [],
      argumentSchemaHashes: [],
      stepCount: operations.length,
      durationMs: 1000,
      tokenCount: 100,
      retryCount: 0,
      estimatedCostUsd: null,
    },
    episodes: [],
    episodeCount: 1,
    distinctSessionIds: ["session_identity"],
    completedOccurrences: 1,
    metrics: {
      totalDurationMs: 1000,
      avgDurationMs: 1000,
      totalTokens: 100,
      avgTokens: 100,
      totalCostUsd: null,
      totalRetries: 0,
      totalStepCount: operations.length,
      avgStepCount: operations.length,
    },
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    evidenceEventIds: [],
  };
}

const engine = new CoverageEngine();

describe("coverage requires observed tool identity", () => {
  it("does not let a git-status wrapper suppress ancestry and diff analysis", () => {
    const workflow = cluster(
      ["command:git", "command:git"],
      ["git merge-base --is-ancestor $STR $STR", "git diff --numstat $STR $STR"],
    );
    expect(engine.evaluateCoverage(workflow, [tool]).status).toBe("net_new");
    const broadGrant = structuredClone(tool);
    broadGrant.capabilities.command.allowedBinaries = ["git"];
    broadGrant.capabilities.command.allowedCommands = ["git $STR"];
    expect(engine.evaluateCoverage(workflow, [broadGrant]).status).toBe("net_new");
  });

  it.each([
    "command:inspect_git_repository",
    "edit:inspect_git_repository",
    "tool:git",
    "tool:inspect_git_repositories",
    "tool:prefix_inspect_git_repository",
  ])("does not infer execution from resemblance: %s", (operation) => {
    expect(engine.evaluateCoverage(cluster([operation]), [tool]).status).toBe("net_new");
  });

  it.each([tool.name, tool.id])("recognizes exact observed identity %s", (identity) => {
    expect(engine.evaluateCoverage(cluster([`tool:${identity}`]), [tool])).toMatchObject({
      status: "duplicate",
      matchingToolId: tool.id,
      similarityScore: 1,
    });
  });

  it("preserves partial direct-tool coverage without claiming unrelated edits", () => {
    expect(
      engine.evaluateCoverage(cluster([`tool:${tool.name}`, "edit:another_file"]), [tool]).status,
    ).toBe("update_candidate");
  });
});
