import type { CatalogChangeSummary, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { getClaudeRefreshCapability, notifyClaudeCatalogRefresh } from "../src/refresh.js";

describe("Claude Code catalog refresh", () => {
  const workspace: HarnessWorkspace = {
    workspaceId: "ws-1",
    name: "project",
    rootPath: "/workspace",
    harnessId: "claude-code",
    configPath: "/workspace/.claude.json",
    metadata: {},
  };

  it("relies on MCP tools/list_changed, which Claude handles mid-session", () => {
    const capability = getClaudeRefreshCapability();
    expect(capability.supportsNativeListChange).toBe(true);
    expect(capability.supportsContextNudge).toBe(false);
    expect(capability.requiresSessionRestart).toBe(false);
  });

  it("reports a native refresh counting every changed tool", async () => {
    const summary: CatalogChangeSummary = {
      addedToolIds: ["tool_a"],
      updatedToolIds: ["tool_b"],
      removedToolIds: ["tool_c"],
      catalogVersion: "3.0.0",
      timestamp: "2026-08-17T12:00:00.000Z",
    };
    const result = await notifyClaudeCatalogRefresh(workspace, summary);
    expect(result.outcome).toBe("native_list_change");
    expect(result.affectedToolCount).toBe(3);
    expect(result.requiresRestart).toBe(false);
  });
});
