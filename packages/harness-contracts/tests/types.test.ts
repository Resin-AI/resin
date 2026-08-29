import { describe, expect, it } from "vitest";
import {
  AdapterCapabilitiesSchema,
  AdapterDiagnosticSchema,
  CatalogChangeSummarySchema,
  ConfigBackupSchema,
  ConfigMutationPlanSchema,
  HarnessInstallationSchema,
  HarnessSessionSchema,
  HarnessWorkspaceSchema,
  ObservationFidelitySchema,
  RawHarnessRecordSchema,
  RefreshCapabilitySchema,
  SourceCursorSchema,
} from "../src/types.js";

describe("Harness Contracts - Types & Zod Schemas", () => {
  it("validates HarnessInstallationSchema", () => {
    const valid = {
      harnessId: "omp",
      displayName: "Oh My Pi",
      version: "0.1.0",
      executablePath: "/usr/local/bin/omp",
      configPath: "/home/user/.omp/config.json",
      homePath: "/home/user/.omp",
      isInstalled: true,
      status: "ready",
      detectedAt: new Date().toISOString(),
      metadata: { os: "linux" },
    };

    expect(() => HarnessInstallationSchema.parse(valid)).not.toThrow();
    const parsed = HarnessInstallationSchema.parse(valid);
    expect(parsed.harnessId).toBe("omp");
    expect(parsed.status).toBe("ready");

    expect(() =>
      HarnessInstallationSchema.parse({
        ...valid,
        status: "invalid_status",
      }),
    ).toThrow();
  });

  it("validates HarnessWorkspaceSchema", () => {
    const valid = {
      workspaceId: "ws_01j4k5l6",
      rootPath: "/workspaces/my-project",
      name: "my-project",
      harnessId: "claude-code",
      configPath: "/workspaces/my-project/.claude/config.json",
      mcpConfigPath: "/workspaces/my-project/.claude/mcp.json",
      activeSessionId: "sess_active_123",
      metadata: {},
    };

    const parsed = HarnessWorkspaceSchema.parse(valid);
    expect(parsed.workspaceId).toBe("ws_01j4k5l6");
    expect(parsed.activeSessionId).toBe("sess_active_123");

    expect(() =>
      HarnessWorkspaceSchema.parse({
        ...valid,
        rootPath: "", // Must not be empty
      }),
    ).toThrow();
  });

  it("validates HarnessSessionSchema", () => {
    const valid = {
      sessionId: "sess_01j4k5l6",
      workspaceId: "ws_01j4k5l6",
      harnessId: "codex-cli",
      transcriptPath: "/home/user/.codex/sessions/sess_01j4k5l6.jsonl",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { threadCount: 2 },
    };

    const parsed = HarnessSessionSchema.parse(valid);
    expect(parsed.sessionId).toBe("sess_01j4k5l6");
    expect(parsed.status).toBe("active");
  });

  it("validates SourceCursorSchema", () => {
    const valid = {
      offset: 1024,
      line: 42,
      sequence: 15,
      checkpoint: "a".repeat(64),
      timestamp: new Date().toISOString(),
    };

    const parsed = SourceCursorSchema.parse(valid);
    expect(parsed.offset).toBe(1024);
    expect(parsed.line).toBe(42);
    expect(parsed.sequence).toBe(15);

    expect(() =>
      SourceCursorSchema.parse({
        ...valid,
        offset: -1, // Non-negative
      }),
    ).toThrow();
  });

  it("validates RawHarnessRecordSchema", () => {
    const valid = {
      recordId: "rec_01j4k5l6",
      sessionId: "sess_01j4k5l6",
      harnessId: "omp",
      sequenceNumber: 3,
      timestamp: new Date().toISOString(),
      recordType: "tool_call",
      rawPayload: { tool: "grep", args: { pattern: "test" } },
      cursor: {
        offset: 256,
        line: 4,
        sequence: 3,
        timestamp: new Date().toISOString(),
      },
      metadata: {},
    };

    const parsed = RawHarnessRecordSchema.parse(valid);
    expect(parsed.recordType).toBe("tool_call");
    expect(parsed.sequenceNumber).toBe(3);
  });

  it("validates AdapterDiagnosticSchema", () => {
    const valid = {
      code: "DIAG_ENV_WARN",
      severity: "warning",
      message: "Node version higher than recommended",
      path: "/usr/local/bin/node",
      timestamp: new Date().toISOString(),
      details: { version: "23.0.0" },
    };

    const parsed = AdapterDiagnosticSchema.parse(valid);
    expect(parsed.severity).toBe("warning");
  });

  it("validates ConfigMutationPlanSchema and ConfigBackupSchema", () => {
    const plan = {
      planId: "plan_01j4k5l6",
      harnessId: "omp",
      targetPath: "/home/user/.omp/config.json",
      preconditionHash: "a".repeat(64),
      plannedContent: '{"mcp": true}',
      backupPath: "/home/user/.omp/config.json.backup",
      description: "Attach gateway MCP",
      diffSummary: "+ mcp",
      createdAt: new Date().toISOString(),
      metadata: {},
    };

    const parsedPlan = ConfigMutationPlanSchema.parse(plan);
    expect(parsedPlan.planId).toBe("plan_01j4k5l6");

    const backup = {
      backupId: "bkp_01j4k5l6",
      targetPath: "/home/user/.omp/config.json",
      backupPath: "/home/user/.omp/config.json.backup",
      contentHash: "b".repeat(64),
      originalContent: '{"mcp": false}',
      createdAt: new Date().toISOString(),
      restored: false,
    };

    const parsedBackup = ConfigBackupSchema.parse(backup);
    expect(parsedBackup.restored).toBe(false);
  });

  it("validates RefreshCapabilitySchema and ObservationFidelitySchema", () => {
    const refresh = {
      supportsNativeListChange: true,
      supportsContextNudge: true,
      requiresSessionRestart: false,
      description: "Dynamic reload",
    };
    expect(RefreshCapabilitySchema.parse(refresh).supportsNativeListChange).toBe(true);

    const fidelity = {
      transcriptAvailability: "stream",
      toolCallVisibility: "full",
      toolResultVisibility: "full",
      subagentVisibility: "full",
      mcpListChange: "supported",
      contextNudge: "supported",
      overallScore: 100,
      notes: "Full fidelity",
    };
    expect(ObservationFidelitySchema.parse(fidelity).overallScore).toBe(100);

    const capabilities = {
      refresh,
      fidelity,
      supportedTransports: ["stdio", "sse"],
      supportsMultiWorkspace: true,
      supportsConcurrentSessions: true,
      features: { subagents: true },
    };
    const parsedCaps = AdapterCapabilitiesSchema.parse(capabilities);
    expect(parsedCaps.supportedTransports).toContain("sse");
  });

  it("validates CatalogChangeSummarySchema", () => {
    const summary = {
      addedToolIds: ["tool_a", "tool_b"],
      updatedToolIds: ["tool_c"],
      removedToolIds: [],
      catalogVersion: "1.2.0",
      timestamp: new Date().toISOString(),
    };

    const parsed = CatalogChangeSummarySchema.parse(summary);
    expect(parsed.addedToolIds).toHaveLength(2);
    expect(parsed.catalogVersion).toBe("1.2.0");
  });
});
