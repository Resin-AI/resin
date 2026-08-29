import type { CatalogChangeSummary, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  generateClaudeContextNotice,
  getClaudeRefreshCapability,
  notifyClaudeCatalogRefresh,
} from "../src/refresh.js";

describe("Claude Code Refresh Signaling & Context Nudge", () => {
  const mockWorkspace: HarnessWorkspace = {
    workspaceId: "ws-1",
    name: "project",
    rootPath: "/workspace",
    harnessId: "claude-code",
    configPath: "/workspace/.claude.json",
    metadata: {},
  };

  it("reports Tier-2 refresh capability profile", () => {
    const capability = getClaudeRefreshCapability();

    expect(capability.supportsNativeListChange).toBe(false);
    expect(capability.supportsContextNudge).toBe(true);
    expect(capability.requiresSessionRestart).toBe(false);
    expect(capability.description).toContain("context notice prompt nudge");
  });

  it("generates formatted markdown context notice for catalog updates", () => {
    const summary: CatalogChangeSummary = {
      addedToolIds: ["tool_web_search", "tool_github_pr"],
      updatedToolIds: ["tool_sql_query"],
      removedToolIds: ["tool_legacy_exec"],
      catalogVersion: "2.1.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    const notice = generateClaudeContextNotice(summary);

    expect(notice).toContain("Tool Catalog Update (v2.1.0)");
    expect(notice).toContain("- `tool_web_search`");
    expect(notice).toContain("- `tool_github_pr`");
    expect(notice).toContain("- `tool_sql_query`");
    expect(notice).toContain("- `tool_legacy_exec`");
  });

  it("handles empty change sets gracefully in context notice", () => {
    const summary: CatalogChangeSummary = {
      addedToolIds: [],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "1.0.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    const notice = generateClaudeContextNotice(summary);

    expect(notice).toContain("Tool Catalog Update (v1.0.0)");
    expect(notice).toContain("### Added Tools\n- (none)");
    expect(notice).toContain("### Updated Tools\n- (none)");
    expect(notice).toContain("### Removed Tools\n- (none)");
  });

  it("notifies catalog refresh and constructs valid RefreshResult", async () => {
    const summary: CatalogChangeSummary = {
      addedToolIds: ["tool_a"],
      updatedToolIds: ["tool_b"],
      removedToolIds: [],
      catalogVersion: "3.0.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    };

    const result = await notifyClaudeCatalogRefresh(mockWorkspace, summary);

    expect(result.outcome).toBe("context_nudge");
    expect(result.catalogVersion).toBe("3.0.0");
    expect(result.appliedAt).toBe("2026-08-17T12:00:00.000Z");
    expect(result.affectedToolCount).toBe(2);
    expect(result.requiresRestart).toBe(false);
    expect(result.message).toContain("Tool Catalog Update (v3.0.0)");
  });
});
