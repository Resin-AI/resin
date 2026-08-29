import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest, V1LockedToolEntry } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { UserControlsManager } from "../../src/registry/controls.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

const VALID_PROJECT_ID = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
const SAMPLE_DIGEST_V1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const SAMPLE_DIGEST_V2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const SAMPLE_DIGEST_M1 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function makeManifest(overrides?: Partial<ToolManifest>): ToolManifest {
  const base = {
    id: overrides?.id ?? overrides?.name ?? "tool_1",
    name: overrides?.name ?? overrides?.id ?? "test_tool",
    version: overrides?.version ?? "1.0.0",
    description: overrides?.description ?? "Test tool description",
    parameters: overrides?.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    runtime: overrides?.runtime ?? {
      runtime: "node" as const,
      memoryLimitMb: 128,
      timeoutMs: 30000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: overrides?.capabilities ?? {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowOutbound: false,
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https" as const],
        allowLocalhost: false,
        denyPrivateRanges: true,
      },
      command: {
        allowShellExecution: false,
        allowedCommands: [],
        allowedBinaries: [],
        forbiddenPatterns: [],
        allowEnvPassthrough: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: overrides?.limits ?? {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 4,
    },
    scope: overrides?.scope ?? ("workspace" as const),
    metadata: overrides?.metadata ?? {},
    createdAt: overrides?.createdAt ?? "2026-08-17T12:00:00.000Z",
  };

  const digest = overrides?.digest ?? computeManifestDigest(base);
  return {
    ...base,
    digest,
  };
}

describe("Catalog Rollback & Version-Locked Rollback Invariants", () => {
  it("rolls back catalog to a previous monotonic revision", async () => {
    const registry = new ToolRegistry();

    const manifestV1 = makeManifest({ name: "tool_formatter", version: "1.0.0" });
    await registry.stageToolVersion(manifestV1);
    await registry.activateToolVersion("tool_formatter", "1.0.0", "ws-rollback");

    const snap1 = await registry.resolveCatalog("ws-rollback");
    const rev1 = snap1.revision;
    expect(snap1.tools.tool_formatter.version).toBe("1.0.0");

    const manifestV2 = makeManifest({ name: "tool_formatter", version: "2.0.0" });
    await registry.stageToolVersion(manifestV2);
    await registry.activateToolVersion("tool_formatter", "2.0.0", "ws-rollback");

    const snap2 = await registry.resolveCatalog("ws-rollback");
    const rev2 = snap2.revision;
    expect(snap2.tools.tool_formatter.version).toBe("2.0.0");
    expect(rev2).toBeGreaterThan(rev1);

    const rolledBackSnapshot = await registry.rollbackCatalog("ws-rollback", rev1);

    expect(rolledBackSnapshot.tools.tool_formatter.version).toBe("1.0.0");
    expect(registry.getRevision("ws-rollback")).toBeGreaterThan(rev2);
  });

  it("rolls back catalog across multiple tool updates correctly", async () => {
    const registry = new ToolRegistry();

    const manifestA = makeManifest({ name: "tool_formatter", version: "1.0.0" });
    await registry.stageToolVersion(manifestA);
    await registry.activateToolVersion("tool_formatter", "1.0.0", "ws-rollback");
    const rev1 = registry.getRevision("ws-rollback");

    const manifestB = makeManifest({ name: "tool_linter", version: "1.0.0" });
    await registry.stageToolVersion(manifestB);
    await registry.activateToolVersion("tool_linter", "1.0.0", "ws-rollback");

    const manifestA2 = makeManifest({ name: "tool_formatter", version: "2.0.0" });
    await registry.stageToolVersion(manifestA2);
    await registry.activateToolVersion("tool_formatter", "2.0.0", "ws-rollback");

    const rolledBackSnapshot = await registry.rollbackCatalog("ws-rollback", rev1);

    expect(rolledBackSnapshot.tools.tool_formatter.version).toBe("1.0.0");
    expect(rolledBackSnapshot.tools.tool_linter).toBeUndefined();
    expect(registry.getRevision("ws-rollback")).toBeGreaterThan(rev1);
  });

  it("rolls back to a historical snapshot by snapshotId", async () => {
    const registry = new ToolRegistry();

    const manifest = makeManifest({ name: "tool_test", version: "1.0.0" });
    await registry.stageToolVersion(manifest);
    await registry.activateToolVersion("tool_test", "1.0.0", "ws-snap-rollback");

    const snap1 = await registry.resolveCatalog("ws-snap-rollback");

    const manifest2 = makeManifest({ name: "tool_test", version: "2.0.0" });
    await registry.stageToolVersion(manifest2);
    await registry.activateToolVersion("tool_test", "2.0.0", "ws-snap-rollback");

    const rolledBack = await registry.rollbackCatalog("ws-snap-rollback", snap1.snapshotId);
    expect(rolledBack.tools.tool_test.version).toBe("1.0.0");
  });

  it("throws a descriptive error when target rollback revision does not exist", async () => {
    const registry = new ToolRegistry();
    await expect(registry.rollbackCatalog("ws-nonexistent", 999)).rejects.toThrow(
      /Rollback failed: target revision\/snapshot '999' not found/,
    );
  });

  it("performs atomic rollback in ProjectLockManager using exact V1 entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-rollback-test-"));
    try {
      const lockManager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entryV1: V1LockedToolEntry = {
        toolId: "11111111-2222-4333-8444-555555555555",
        name: "rollback_tool",
        version: "1.0.0",
        manifestDigest: SAMPLE_DIGEST_M1,
        artifactDigest: SAMPLE_DIGEST_V1,
        status: "active",
      };

      const entryV2: V1LockedToolEntry = {
        ...entryV1,
        version: "2.0.0",
        artifactDigest: SAMPLE_DIGEST_V2,
      };

      // 1. Initial lock at v1
      lockManager.reconcileQualified(entryV1);
      expect(lockManager.read().tools.rollback_tool.version).toBe("1.0.0");

      // 2. Upgrade to v2
      lockManager.updateExact("rollback_tool", entryV2, SAMPLE_DIGEST_V1);
      expect(lockManager.read().tools.rollback_tool.version).toBe("2.0.0");

      // 3. Roll back to v1 via UserControlsManager
      const controls = new UserControlsManager(undefined, lockManager);
      await controls.recordRollback("ws-rollback-test", 1, "snap-v1", {
        toolName: "rollback_tool",
        entry: entryV1,
        expectedArtifactDigest: SAMPLE_DIGEST_V2,
      });

      // Verify lockfile on disk is back at v1
      const lockAfter = lockManager.read();
      expect(lockAfter.tools.rollback_tool.version).toBe("1.0.0");
      expect(lockAfter.tools.rollback_tool.artifactDigest).toBe(SAMPLE_DIGEST_V1);

      // Verify rollback history was preserved
      const rollbacks = await controls.getRollbacks("ws-rollback-test");
      expect(rollbacks).toHaveLength(1);
      expect(rollbacks[0].restoredSnapshotId).toBe("snap-v1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails rollback when expected artifact digest does not match (optimistic conflict)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-rollback-test-"));
    try {
      const lockManager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entryV1: V1LockedToolEntry = {
        toolId: "11111111-2222-4333-8444-555555555555",
        name: "rollback_conflict_tool",
        version: "1.0.0",
        manifestDigest: SAMPLE_DIGEST_M1,
        artifactDigest: SAMPLE_DIGEST_V1,
        status: "active",
      };

      lockManager.reconcileQualified(entryV1);

      const controls = new UserControlsManager(undefined, lockManager);
      await expect(
        controls.recordRollback("ws-conflict", 1, undefined, {
          toolName: "rollback_conflict_tool",
          entry: entryV1,
          expectedArtifactDigest:
            "sha256:wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrong",
        }),
      ).rejects.toThrow(/Optimistic lock conflict/);

      // Verify committed lock remains intact
      expect(lockManager.read().tools.rollback_conflict_tool.version).toBe("1.0.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
