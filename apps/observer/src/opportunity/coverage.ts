import type { CoverageResult, CoverageStatus, ToolManifest } from "@resin/contracts";
import type { WorkflowCluster } from "./types.js";

/**
 * Calculates string similarity using Dice coefficient on bigrams.
 */
function computeStringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const strA = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const strB = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (strA === strB) return 1.0;
  if (strA.length < 2 || strB.length < 2) return 0.0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < strA.length - 1; i++) {
    const bigram = strA.slice(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < strB.length - 1; i++) {
    const bigram = strB.slice(i, i + 2);
    const count = bigramsA.get(bigram) || 0;
    if (count > 0) {
      bigramsA.set(bigram, count - 1);
      intersection++;
    }
  }

  return (2.0 * intersection) / (strA.length - 1 + strB.length - 1);
}

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
    const toolClasses = cluster.representativeSignature.toolClasses;
    const commandPatterns = cluster.representativeSignature.commandPatterns;

    let bestMatch: {
      tool: ToolManifest;
      similarity: number;
      overlapRatio: number;
      reason: string;
    } | null = null;

    for (const tool of existingTools) {
      const match = this.compareClusterToTool(cluster, tool, ops, toolClasses, commandPatterns);
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
  private compareClusterToTool(
    cluster: WorkflowCluster,
    tool: ToolManifest,
    ops: string[],
    toolClasses: string[],
    commandPatterns: string[],
  ): ClusterToolComparison {
    const toolNameNorm = tool.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const toolIdNorm = tool.id.toLowerCase().replace(/[^a-z0-9]/g, "_");

    // 1. Check operation coverage (what fraction of operations in the workflow match the tool)
    let matchingOpsCount = 0;
    for (const op of ops) {
      const cleanOp = op.replace(/^tool:|^command:|^edit:/, "").toLowerCase();
      if (
        cleanOp.includes(toolNameNorm) ||
        toolNameNorm.includes(cleanOp) ||
        cleanOp.includes(toolIdNorm)
      ) {
        matchingOpsCount++;
      } else {
        const sim = computeStringSimilarity(cleanOp, toolNameNorm);
        if (sim >= 0.75) matchingOpsCount++;
      }
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
