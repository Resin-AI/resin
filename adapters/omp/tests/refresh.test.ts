import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogChangeSummary, HarnessWorkspace } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { getOmpRefreshCapability, handleOmpCatalogRefresh } from "../src/refresh.js";

describe("OMP Refresh Handler & Capability Reporting", () => {
  it("reports full refresh capability profile without requiring session restart", () => {
    const capability = getOmpRefreshCapability();
    expect(capability.supportsNativeListChange).toBe(true);
    expect(capability.supportsContextNudge).toBe(true);
    expect(capability.requiresSessionRestart).toBe(false);
    expect(capability.description).toContain("Oh My Pi");
  });

  it("handles catalog refresh and writes notification marker when .omp exists", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-refresh-test-"));
    try {
      const ompDir = path.join(tmpDir, ".omp");
      await fsp.mkdir(ompDir, { recursive: true });

      const workspace: HarnessWorkspace = {
        workspaceId: "ws-refresh-1",
        rootPath: tmpDir,
        name: "test-workspace",
        harnessId: "omp",
        configPath: path.join(ompDir, "config.json"),
        metadata: {},
      };

      const changeSummary: CatalogChangeSummary = {
        addedToolIds: ["tool-auth-login", "tool-auth-logout"],
        updatedToolIds: ["tool-db-query"],
        removedToolIds: ["tool-legacy-v1"],
        catalogVersion: "1.2.0",
        timestamp: "2026-08-17T14:00:00.000Z",
      };

      const result = await handleOmpCatalogRefresh(workspace, changeSummary);

      expect(result.outcome).toBe("native_list_change");
      expect(result.appliedAt).toBeDefined();
      expect(result.details?.addedCount).toBe(2);
      expect(result.details?.updatedCount).toBe(1);
      expect(result.details?.removedCount).toBe(1);
      expect(result.catalogVersion).toBe("1.2.0");

      // Verify written marker file
      const markerPath = path.join(ompDir, "catalog-change.json");
      const markerContent = await fsp.readFile(markerPath, "utf8");
      const parsedMarker = JSON.parse(markerContent);
      expect(parsedMarker.addedToolIds).toEqual(["tool-auth-login", "tool-auth-logout"]);
      expect(parsedMarker.catalogVersion).toBe("1.2.0");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports forced context nudge outcome when requested", async () => {
    const workspace: HarnessWorkspace = {
      workspaceId: "ws-refresh-2",
      rootPath: "/nonexistent/workspace",
      name: "workspace-2",
      harnessId: "omp",
      configPath: "/nonexistent/workspace/.omp/config.json",
      metadata: {},
    };

    const changeSummary: CatalogChangeSummary = {
      addedToolIds: ["tool-1"],
      updatedToolIds: [],
      removedToolIds: [],
      catalogVersion: "1.0.1",
      timestamp: new Date().toISOString(),
    };

    const result = await handleOmpCatalogRefresh(workspace, changeSummary, {
      forceContextNudge: true,
    });
    expect(result.outcome).toBe("context_nudge");
    expect(result.affectedToolCount).toBe(1);
  });
});
