import { describe, expect, it } from "vitest";
import * as ClaudeCodePkg from "../src/index.js";

describe("@resin/adapter-claude-code exports", () => {
  it("exports adapter, discovery, planner, decoder, source, and refresh components", () => {
    expect(ClaudeCodePkg.ClaudeHarnessAdapter).toBeDefined();
    expect(ClaudeCodePkg.ClaudeCodeAdapter).toBeDefined();
    expect(ClaudeCodePkg.ClaudeRecordDecoder).toBeDefined();
    expect(ClaudeCodePkg.decodeClaudeTranscriptLine).toBeDefined();
    expect(ClaudeCodePkg.planClaudeMcpConfig).toBeDefined();
    expect(ClaudeCodePkg.applyClaudeMcpConfig).toBeDefined();
    expect(ClaudeCodePkg.rollbackClaudeMcpConfig).toBeDefined();
    expect(ClaudeCodePkg.verifyClaudeMcpConfig).toBeDefined();
    expect(ClaudeCodePkg.probeClaudeInstallation).toBeDefined();
    expect(ClaudeCodePkg.detectClaudeWorkspaces).toBeDefined();
    expect(ClaudeCodePkg.ClaudeSessionEventSource).toBeDefined();
    expect(ClaudeCodePkg.getClaudeRefreshCapability).toBeDefined();
    expect(ClaudeCodePkg.generateClaudeContextNotice).toBeDefined();
    expect(ClaudeCodePkg.notifyClaudeCatalogRefresh).toBeDefined();
  });
});
