import type { CoverageResult, CoverageStatus, ToolManifest } from "@resin/contracts";
import type { WorkflowCluster } from "./types.js";

interface ClusterToolComparison {
  similarity: number;
  overlapRatio: number;
  reason: string;
}

/**
 * Existing tool coverage evaluation engine.
 * Prevents redundant tool generation by classifying workflows against the existing tool catalog.
 */
export class CoverageEngine {
  /**
   * Compares a workflow cluster against an array of existing tools.
   */
  evaluateCoverage(cluster: WorkflowCluster, existingTools: ToolManifest[] = []): CoverageResult {
    if (!existingTools || existingTools.length === 0) {
      return {
        status: "net_new",
        similarityScore: 0,
        overlapRatio: 0,
        reason: "No existing tools registered in workspace catalog.",
      };
    }

    const ops = cluster.representativeSignature.operations;

    let bestMatch: {
      tool: ToolManifest;
      similarity: number;
      overlapRatio: number;
      reason: string;
    } | null = null;

    for (const tool of existingTools) {
      const match = this.compareClusterToTool(tool, ops);
      if (!bestMatch || match.similarity > bestMatch.similarity) {
        bestMatch = {
          tool,
          similarity: match.similarity,
          overlapRatio: match.overlapRatio,
          reason: match.reason,
        };
      }
    }

    if (!bestMatch || bestMatch.similarity < 0.35) {
      return {
        status: "net_new",
        similarityScore: bestMatch ? Number(bestMatch.similarity.toFixed(3)) : 0,
        overlapRatio: bestMatch ? Number(bestMatch.overlapRatio.toFixed(3)) : 0,
        reason: "Workflow functionality does not match any existing tool in the catalog.",
      };
    }

    // Determine status based on similarity thresholds
    let status: CoverageStatus;
    const suggestedActions: string[] = [];

    if (bestMatch.similarity >= 0.9) {
      status = "duplicate";
      suggestedActions.push(
        `Reject candidate: Identical to existing tool '${bestMatch.tool.name}'`,
      );
    } else if (bestMatch.similarity >= 0.75) {
      status = "covered";
      suggestedActions.push(
        `Workflow is adequately handled by existing tool '${bestMatch.tool.name}'`,
      );
    } else {
      status = "update_candidate";
      suggestedActions.push(
        `Propose updating existing tool '${bestMatch.tool.name}' with new parameters or capabilities`,
      );
    }

    return {
      status,
      matchingToolId: bestMatch.tool.id,
      matchingToolName: bestMatch.tool.name,
      similarityScore: Number(bestMatch.similarity.toFixed(3)),
      overlapRatio: Number(bestMatch.overlapRatio.toFixed(3)),
      reason: bestMatch.reason,
      suggestedActions,
    };
  }

  /**
   * Compares a cluster with a single ToolManifest.
   */
  private compareClusterToTool(tool: ToolManifest, ops: string[]): ClusterToolComparison {
    const toolNameNorm = tool.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const toolIdNorm = tool.id.toLowerCase().replace(/[^a-z0-9]/g, "_");

    // Only an observed call to this tool proves identity. A command basename,
    // file path, similar name or capability ceiling is not execution evidence.
    let matchingOpsCount = 0;
    for (const op of ops) {
      if (!op.startsWith("tool:")) continue;
      const identity = op
        .slice("tool:".length)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      if (identity === toolNameNorm || identity === toolIdNorm) matchingOpsCount++;
    }
    const opCoverage = ops.length > 0 ? matchingOpsCount / ops.length : 0;

    // 2. Check parameter overlap
    let paramOverlap = 0;
    const toolParamKeys = tool.parameters?.properties
      ? Object.keys(tool.parameters.properties)
      : [];

    if (toolParamKeys.length > 0) {
      let matchedParams = 0;
      for (const param of toolParamKeys) {
        if (ops.some((op) => op.toLowerCase().includes(param.toLowerCase()))) {
          matchedParams++;
        }
      }
      paramOverlap = matchedParams / toolParamKeys.length;
    }

    // 3. Composite similarity
    const similarity =
      0.65 * opCoverage +
      0.35 * (paramOverlap > 0 ? paramOverlap : opCoverage >= 0.9 ? 1.0 : opCoverage);
    const overlapRatio = opCoverage;

    let reason = "";
    if (similarity >= 0.85 && opCoverage >= 0.85) {
      reason = `Direct match with existing tool '${tool.name}' (id: ${tool.id})`;
    } else if (similarity >= 0.7) {
      reason = `High overlap with existing tool '${tool.name}' covering core functionality`;
    } else if (similarity >= 0.35) {
      reason = `Partial functional overlap with existing tool '${tool.name}'`;
    } else {
      reason = "Low similarity";
    }

    return { similarity, overlapRatio, reason };
  }
}

/**
 * Convenience function to evaluate coverage.
 */
export function evaluateToolCoverage(
  cluster: WorkflowCluster,
  existingTools: ToolManifest[] = [],
): CoverageResult {
  const engine = new CoverageEngine();
  return engine.evaluateCoverage(cluster, existingTools);
}
