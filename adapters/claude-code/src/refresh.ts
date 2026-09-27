import {
  type CatalogChangeSummary,
  type HarnessWorkspace,
  type RefreshCapability,
  type RefreshResult,
  createRefreshResult,
} from "@resin/harness-contracts";

/**
 * Claude Code 2.1.283 re-lists an MCP server's tools when it sends `notifications/tools/list_changed`
 * and announces the new names to the model mid-session (a `deferred_tools_delta` attachment; see
 * the recorded `cf4ec19a-…` fixture), so a catalog change needs no nudge or restart.
 */
export function getClaudeRefreshCapability(): RefreshCapability {
  return {
    supportsNativeListChange: true,
    supportsContextNudge: false,
    requiresSessionRestart: false,
    description:
      "Claude Code refreshes MCP tools on notifications/tools/list_changed during an active session.",
  };
}

/** Reports the native refresh Resin's gateway performs by emitting `tools/list_changed`. */
export async function notifyClaudeCatalogRefresh(
  _workspace: HarnessWorkspace,
  changeSummary: CatalogChangeSummary,
): Promise<RefreshResult> {
  return createRefreshResult("native_list_change", {
    message: "Claude Code re-lists Resin's tools when the gateway sends tools/list_changed.",
    catalogVersion: changeSummary.catalogVersion,
    appliedAt: changeSummary.timestamp,
    affectedToolCount:
      changeSummary.addedToolIds.length +
      changeSummary.updatedToolIds.length +
      changeSummary.removedToolIds.length,
    details: {
      addedToolIds: changeSummary.addedToolIds,
      updatedToolIds: changeSummary.updatedToolIds,
      removedToolIds: changeSummary.removedToolIds,
    },
  });
}
