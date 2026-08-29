import {
  type CatalogChangeSummary,
  type HarnessWorkspace,
  type RefreshCapability,
  type RefreshResult,
  createRefreshResult,
} from "@resin/harness-contracts";

/**
 * Returns the refresh capability descriptor for Claude Code.
 */
export function getClaudeRefreshCapability(): RefreshCapability {
  return {
    supportsNativeListChange: false,
    supportsContextNudge: true,
    requiresSessionRestart: false,
    description:
      "Claude Code requires a context notice prompt nudge when MCP tool catalog updates occur during an active session.",
  };
}

/**
 * Generates a structured markdown context notice informing Claude of tool catalog updates.
 */
export function generateClaudeContextNotice(changeSummary: CatalogChangeSummary): string {
  const added =
    changeSummary.addedToolIds.length > 0
      ? changeSummary.addedToolIds.map((id) => `- \`${id}\``).join("\n")
      : "- (none)";

  const updated =
    changeSummary.updatedToolIds.length > 0
      ? changeSummary.updatedToolIds.map((id) => `- \`${id}\``).join("\n")
      : "- (none)";

  const removed =
    changeSummary.removedToolIds.length > 0
      ? changeSummary.removedToolIds.map((id) => `- \`${id}\``).join("\n")
      : "- (none)";

  return [
    `# [Resin] Tool Catalog Update (v${changeSummary.catalogVersion})`,
    "",
    "The available MCP tool catalog for this workspace has been updated:",
    "",
    "### Added Tools",
    added,
    "",
    "### Updated Tools",
    updated,
    "",
    "### Removed Tools",
    removed,
    "",
    "Please inspect newly added and updated tools before performing subsequent operations.",
  ].join("\n");
}

/**
 * Notifies Claude Code of tool catalog changes via context notice generation.
 */
export async function notifyClaudeCatalogRefresh(
  _workspace: HarnessWorkspace,
  changeSummary: CatalogChangeSummary,
): Promise<RefreshResult> {
  const notice = generateClaudeContextNotice(changeSummary);

  const affectedToolCount =
    changeSummary.addedToolIds.length +
    changeSummary.updatedToolIds.length +
    changeSummary.removedToolIds.length;

  return createRefreshResult("context_nudge", {
    message: notice,
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
