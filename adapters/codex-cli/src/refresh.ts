import type {
  CatalogChangeSummary,
  HarnessWorkspace,
  RefreshCapability,
  RefreshResult,
} from "@resin/harness-contracts";
import { createRefreshResult, determineRefreshOutcome } from "@resin/harness-contracts";

/**
 * Standard refresh capability profile for Codex CLI.
 * By default, Codex CLI reloads MCP tools on session start / restart without needing configuration rewrites.
 */
export const CODEX_DEFAULT_REFRESH_CAPABILITY: RefreshCapability = Object.freeze({
  supportsNativeListChange: false,
  supportsContextNudge: false,
  requiresSessionRestart: true,
  description:
    "Codex CLI loads MCP tools at session startup; catalog updates take effect on the next session without modifying config files.",
});

/**
 * Options for configuring catalog refresh behavior.
 */
export interface CodexRefreshHandlerOptions {
  capability?: RefreshCapability;
  customMessageHandler?: (changeSummary: CatalogChangeSummary) => string;
}

/**
 * Handler for catalog refresh notifications targeting Codex CLI.
 */
export class CodexRefreshHandler {
  private readonly capability: RefreshCapability;
  private readonly customMessageHandler?: (changeSummary: CatalogChangeSummary) => string;

  constructor(options?: CodexRefreshHandlerOptions) {
    this.capability = options?.capability ?? CODEX_DEFAULT_REFRESH_CAPABILITY;
    this.customMessageHandler = options?.customMessageHandler;
  }

  /**
   * Returns the refresh capability descriptor.
   */
  getCapability(): RefreshCapability {
    return this.capability;
  }

  /**
   * Processes a catalog change summary and determines the appropriate refresh outcome.
   */
  async notifyCatalogRefresh(
    workspace: HarnessWorkspace,
    changeSummary: CatalogChangeSummary,
  ): Promise<RefreshResult> {
    const outcome = determineRefreshOutcome(this.capability);

    const affectedTools = [
      ...changeSummary.addedToolIds,
      ...changeSummary.updatedToolIds,
      ...changeSummary.removedToolIds,
    ];

    let message: string;
    if (this.customMessageHandler) {
      message = this.customMessageHandler(changeSummary);
    } else if (outcome === "native_list_change") {
      message = `Dynamic MCP list change dispatched to workspace ${workspace.workspaceId}.`;
    } else if (outcome === "next_session_required") {
      message = `Tool catalog updated (${affectedTools.length} tool(s) affected). Changes will take effect on next Codex session without configuration file mutation.`;
    } else if (outcome === "context_nudge") {
      message = "Tool catalog update communicated via in-context nudge.";
    } else {
      message = "Harness does not support dynamic tool catalog refresh.";
    }

    return createRefreshResult(outcome, {
      catalogVersion: changeSummary.catalogVersion,
      affectedToolCount: affectedTools.length,
      message,
      requiresRestart: outcome === "next_session_required",
      details: {
        affectedTools,
      },
    });
  }
}

/**
 * Convenience function to handle catalog refresh for Codex CLI.
 */
export async function handleCodexCatalogRefresh(
  workspace: HarnessWorkspace,
  changeSummary: CatalogChangeSummary,
  capability: RefreshCapability = CODEX_DEFAULT_REFRESH_CAPABILITY,
): Promise<RefreshResult> {
  const handler = new CodexRefreshHandler({ capability });
  return handler.notifyCatalogRefresh(workspace, changeSummary);
}
