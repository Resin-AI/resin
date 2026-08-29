import type { CatalogChangeSummary, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  CODEX_DEFAULT_REFRESH_CAPABILITY,
  CodexRefreshHandler,
  handleCodexCatalogRefresh,
} from "../src/refresh.js";

describe("Codex CLI Refresh Handling", () => {
  const dummyWorkspace: HarnessWorkspace = {
    workspaceId: "ws_codex_test",
    harnessId: "codex-cli",
    name: "Test Workspace",
    rootPath: "/home/user/project",
    configPath: "/home/user/.codex/config.toml",
    metadata: {
      sessionRoot: "/home/user/.codex/sessions",
    },
  };

  const sampleChangeSummary: CatalogChangeSummary = {
    addedToolIds: ["tool_calc_01"],
    updatedToolIds: ["tool_fetch_02"],
    removedToolIds: [],
    catalogVersion: "1.2.0",
    timestamp: "2026-08-17T12:00:00.000Z",
  };

  it("reports default capabilities indicating session restart required without file mutations", () => {
    expect(CODEX_DEFAULT_REFRESH_CAPABILITY.requiresSessionRestart).toBe(true);
    expect(CODEX_DEFAULT_REFRESH_CAPABILITY.supportsNativeListChange).toBe(false);
    expect(CODEX_DEFAULT_REFRESH_CAPABILITY.supportsContextNudge).toBe(false);
  });

  it("returns next_session_required outcome with requiresRestart=true on catalog refresh", async () => {
    const result = await handleCodexCatalogRefresh(dummyWorkspace, sampleChangeSummary);

    expect(result.outcome).toBe("next_session_required");
    expect(result.requiresRestart).toBe(true);
    expect(result.catalogVersion).toBe("1.2.0");
    expect(result.affectedToolCount).toBe(2);
    expect(result.details.affectedTools).toEqual(["tool_calc_01", "tool_fetch_02"]);
    expect(result.message).toContain("next Codex session without configuration file mutation");
  });

  it("supports dynamic list change when configured with dynamic MCP capability", async () => {
    const handler = new CodexRefreshHandler({
      capability: {
        supportsNativeListChange: true,
        supportsContextNudge: false,
        requiresSessionRestart: false,
      },
    });

    const result = await handler.notifyCatalogRefresh(dummyWorkspace, sampleChangeSummary);
    expect(result.outcome).toBe("native_list_change");
    expect(result.requiresRestart).toBe(false);
    expect(result.message).toContain("Dynamic MCP list change dispatched");
  });

  it("supports context nudge when configured with nudge capability", async () => {
    const handler = new CodexRefreshHandler({
      capability: {
        supportsNativeListChange: false,
        supportsContextNudge: true,
        requiresSessionRestart: false,
      },
    });

    const result = await handler.notifyCatalogRefresh(dummyWorkspace, sampleChangeSummary);
    expect(result.outcome).toBe("context_nudge");
    expect(result.requiresRestart).toBe(false);
  });

  it("returns unsupported when no refresh mechanism is enabled", async () => {
    const handler = new CodexRefreshHandler({
      capability: {
        supportsNativeListChange: false,
        supportsContextNudge: false,
        requiresSessionRestart: false,
      },
    });

    const result = await handler.notifyCatalogRefresh(dummyWorkspace, sampleChangeSummary);
    expect(result.outcome).toBe("unsupported");
    expect(result.requiresRestart).toBe(false);
  });
});
