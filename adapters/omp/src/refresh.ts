import * as fsp from "node:fs/promises";
import path from "node:path";
import {
  type CatalogChangeSummary,
  type HarnessWorkspace,
  type RefreshCapability,
  type RefreshDetailRecord,
  type RefreshResult,
  createRefreshResult,
} from "@resin/harness-contracts";
import { applyOmpCatalogInstructions } from "./instructions.js";

export interface OmpRefreshOptions {
  customSocketPath?: string;
  notificationFilePath?: string;
  forceContextNudge?: boolean;
  /** Rendered catalog instructions markdown to inject into OMP's append-system-prompt file. */
  catalogMarkdown?: string;
  /** Evolved tool names for per-tool xd:// invocation snippets. */
  toolNames?: string[];
  /** MCP server name used in xd:// invocation paths (dashes become underscores). */
  serverName?: string;
  /** Override OMP home (defaults to resolveOmpHome()). */
  ompHome?: string;
}

/**
 * Returns the refresh capability profile for Oh My Pi harness.
 */
export function getOmpRefreshCapability(): RefreshCapability {
  return {
    supportsNativeListChange: true,
    supportsContextNudge: true,
    requiresSessionRestart: false,
    description:
      "Oh My Pi natively supports real-time MCP list_changed notifications and dynamic tool discovery without session restart.",
  };
}

/**
 * Handles notifying Oh My Pi of tool catalog additions, updates, and removals.
 */
export async function handleOmpCatalogRefresh(
  workspace: HarnessWorkspace,
  changeSummary: CatalogChangeSummary,
  options?: OmpRefreshOptions,
): Promise<RefreshResult> {
  const now = new Date().toISOString();
  const totalChanges =
    (changeSummary.addedToolIds?.length ?? 0) +
    (changeSummary.updatedToolIds?.length ?? 0) +
    (changeSummary.removedToolIds?.length ?? 0);

  try {
    // Write a workspace notification marker if .omp exists in workspace
    const ompDir = path.join(workspace.rootPath, ".omp");
    try {
      const stat = await fsp.stat(ompDir);
      if (stat.isDirectory()) {
        const markerFile =
          options?.notificationFilePath ?? path.join(ompDir, "catalog-change.json");

        const payload = {
          catalogVersion: changeSummary.catalogVersion,
          timestamp: changeSummary.timestamp ?? now,
          addedToolIds: changeSummary.addedToolIds ?? [],
          updatedToolIds: changeSummary.updatedToolIds ?? [],
          removedToolIds: changeSummary.removedToolIds ?? [],
          notifiedAt: now,
        };

        await fsp.writeFile(markerFile, JSON.stringify(payload, null, 2), "utf8");
      }
    } catch {
      // Workspace .omp directory not present or not writable; continue
    }

    // Inject catalog instructions into OMP's append-system-prompt file so
    // sessions learn about evolved tools and their xd:// invocation paths (D3).
    let instructionsAction: string | undefined;
    if (options?.catalogMarkdown !== undefined) {
      try {
        const applied = await applyOmpCatalogInstructions({
          markdown: options.catalogMarkdown,
          toolNames: options.toolNames,
          serverName: options.serverName,
          ompHome: options.ompHome,
        });
        instructionsAction = applied.action;
      } catch {
        // Append-system prompt injection is best-effort; do not fail refresh
      }
    }

    const outcome = options?.forceContextNudge ? "context_nudge" : "native_list_change";

    return createRefreshResult(outcome, {
      message: `Notified Oh My Pi of ${totalChanges} catalog changes`,
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount: totalChanges,
      requiresRestart: false,
      appliedAt: now,
      details: (() => {
        const d: RefreshDetailRecord = {
          addedCount: changeSummary.addedToolIds?.length ?? 0,
          updatedCount: changeSummary.updatedToolIds?.length ?? 0,
          removedCount: changeSummary.removedToolIds?.length ?? 0,
          workspaceId: workspace.workspaceId,
        };
        if (instructionsAction) {
          d.instructionsAction = instructionsAction;
        }
        return d;
      })(),
    });
  } catch (err: unknown) {
    return createRefreshResult("failed", {
      message: `Failed to notify Oh My Pi: ${err instanceof Error ? err.message : String(err)}`,
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount: 0,
      requiresRestart: false,
      appliedAt: now,
      details: {
        workspaceId: workspace.workspaceId,
      },
    });
  }
}
