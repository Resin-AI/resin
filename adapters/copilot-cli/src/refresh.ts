import {
  type CatalogChangeSummary,
  type RefreshCapability,
  type RefreshResult,
  createRefreshResult,
} from "@resin/harness-contracts";

/**
 * Copilot CLI 1.0.88 re-lists an MCP server's tools on `notifications/tools/list_changed` and
 * sends the new list with the very next model request, even inside the same user turn. Recorded
 * in tests/fixtures/recorded/1.0.88 (session 96d45076…): the fixture server's `learn_tool`
 * registers `count_chars` and emits list_changed; the model calls `fixture-count_chars` in the
 * following assistant step of the same `copilot -p` prompt. The "applied one user turn late"
 * behaviour reported in github/copilot-cli#3125 therefore does not reproduce on 1.0.88; at worst a
 * tool learned mid-turn is usable from the next user turn, so no restart or nudge is needed.
 */
export function getCopilotRefreshCapability(): RefreshCapability {
  return {
    supportsNativeListChange: true,
    supportsContextNudge: false,
    requiresSessionRestart: false,
    description:
      "Copilot CLI applies MCP tools/list_changed on its next model request (verified on 1.0.88: same user turn).",
  };
}

export function notifyCopilotCatalogRefresh(changeSummary: CatalogChangeSummary): RefreshResult {
  const affectedToolCount =
    changeSummary.addedToolIds.length +
    changeSummary.updatedToolIds.length +
    changeSummary.removedToolIds.length;
  return createRefreshResult("native_list_change", {
    message:
      "Resin's MCP server emits tools/list_changed; Copilot CLI re-lists tools before its next model request.",
    catalogVersion: changeSummary.catalogVersion,
    appliedAt: changeSummary.timestamp,
    affectedToolCount,
    details: {
      addedToolIds: changeSummary.addedToolIds,
      updatedToolIds: changeSummary.updatedToolIds,
      removedToolIds: changeSummary.removedToolIds,
    },
  });
}
