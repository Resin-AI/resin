import { describe, expect, it } from "vitest";
import * as OmpModule from "../src/index.js";

describe("OMP Adapter Module Exports", () => {
  it("exports all public adapter classes and utilities", () => {
    expect(OmpModule.OmpHarnessAdapter).toBeDefined();
    expect(OmpModule.OmpAdapter).toBeDefined();
    expect(OmpModule.OmpRecordDecoder).toBeDefined();
    expect(OmpModule.OmpSessionEventSource).toBeDefined();
    expect(OmpModule.planOmpMcpConfig).toBeDefined();
    expect(OmpModule.applyOmpMcpConfig).toBeDefined();
    expect(OmpModule.verifyOmpMcpConfig).toBeDefined();
    expect(OmpModule.rollbackOmpMcpConfig).toBeDefined();
    expect(OmpModule.probeOmpInstallation).toBeDefined();
    expect(OmpModule.discoverOmpWorkspaces).toBeDefined();
    expect(OmpModule.discoverOmpSessions).toBeDefined();
    expect(OmpModule.inspectBreadcrumbs).toBeDefined();
    expect(OmpModule.getOmpRefreshCapability).toBeDefined();
    expect(OmpModule.handleOmpCatalogRefresh).toBeDefined();
  });
});
