import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest, V1LockedToolEntry } from "@resin/contracts";
import { createInMemoryStateStore } from "@resin/db";
import { describe, expect, it } from "vitest";
import { ProjectLockManager } from "../../src/project/lock-manager.js";
import { UserControlsManager } from "../../src/registry/controls.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { computeManifestDigest } from "../../src/registry/validator.js";

const VALID_PROJECT_ID = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
const OTHER_PROJECT_ID = "f9e8d7c6-b5a4-4321-9876-543210abcdef";
const SAMPLE_TOOL_ID = "11111111-2222-4333-8444-555555555555";
const SAMPLE_TOOL_ID_2 = "22222222-3333-4444-8555-666666666666";

const SAMPLE_DIGEST_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAMPLE_DIGEST_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SAMPLE_DIGEST_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SAMPLE_DIGEST_D = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function makeLockedEntry(overrides?: Partial<V1LockedToolEntry>): V1LockedToolEntry {
  return {
    toolId: overrides?.toolId ?? SAMPLE_TOOL_ID,
    name: overrides?.name ?? "test_tool",
    version: overrides?.version ?? "1.0.0",
    manifestDigest: overrides?.manifestDigest ?? SAMPLE_DIGEST_A,
    artifactDigest: overrides?.artifactDigest ?? SAMPLE_DIGEST_B,
    status: overrides?.status ?? "active",
    envelopeDigest: overrides?.envelopeDigest,
    signatureIdentity: overrides?.signatureIdentity,
  };
}

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

describe("ProjectLockManager Lifecycle & Atomic Mutations", () => {
  it("adds once: reconcileQualified adds new tool and creates committed lockfile", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entry = makeLockedEntry();
      const result = manager.reconcileQualified(entry);

      expect(result.outcome).toBe("added");
      expect(result.lock.projectId).toBe(VALID_PROJECT_ID);
      expect(result.lock.tools.test_tool).toBeDefined();
      expect(result.lock.tools.test_tool.version).toBe("1.0.0");
      expect(result.lock.tools.test_tool.status).toBe("active");

      // Verify on-disk file
      const lockOnDisk = manager.read();
      expect(lockOnDisk.tools.test_tool.artifactDigest).toBe(SAMPLE_DIGEST_B);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("unchanged: reconcileQualified on identical entry returns unchanged without disk write", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entry = makeLockedEntry();
      const first = manager.reconcileQualified(entry);
      expect(first.outcome).toBe("added");

      const statBefore = fs.statSync(manager.lockPath);
      const second = manager.reconcileQualified(entry);

      expect(second.outcome).toBe("unchanged");
      expect(second.lock.tools.test_tool.version).toBe("1.0.0");

      const statAfter = fs.statSync(manager.lockPath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("newer_available without write: reconcileQualified with newer version does not rewrite lockfile", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const v1 = makeLockedEntry({ version: "1.0.0", artifactDigest: SAMPLE_DIGEST_B });
      manager.reconcileQualified(v1);

      const v2 = makeLockedEntry({ version: "1.1.0", artifactDigest: SAMPLE_DIGEST_C });
      const result = manager.reconcileQualified(v2);

      expect(result.outcome).toBe("newer_available");
      expect(result.lock.tools.test_tool.version).toBe("1.0.0");

      // Read directly from disk to ensure committed lock still pins 1.0.0
      const lockOnDisk = manager.read();
      expect(lockOnDisk.tools.test_tool.version).toBe("1.0.0");
      expect(lockOnDisk.tools.test_tool.artifactDigest).toBe(SAMPLE_DIGEST_B);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("explicit exact update: updates locked entry and updatedAt timestamp", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const v1 = makeLockedEntry({ version: "1.0.0", artifactDigest: SAMPLE_DIGEST_B });
      manager.reconcileQualified(v1);

      const v2 = makeLockedEntry({ version: "2.0.0", artifactDigest: SAMPLE_DIGEST_C });
      const updated = manager.updateExact("test_tool", v2, SAMPLE_DIGEST_B);

      expect(updated.tools.test_tool.version).toBe("2.0.0");
      expect(updated.tools.test_tool.artifactDigest).toBe(SAMPLE_DIGEST_C);

      const lockOnDisk = manager.read();
      expect(lockOnDisk.tools.test_tool.version).toBe("2.0.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("optimistic conflict: fails without overwriting when expected artifact digest is stale or missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const v1 = makeLockedEntry({ version: "1.0.0", artifactDigest: SAMPLE_DIGEST_B });
      manager.reconcileQualified(v1);

      const v2 = makeLockedEntry({ version: "2.0.0", artifactDigest: SAMPLE_DIGEST_C });

      // Pass wrong expected artifact digest
      expect(() => {
        manager.updateExact("test_tool", v2, SAMPLE_DIGEST_A);
      }).toThrow(/Optimistic lock conflict/);

      // Verify lockfile was NOT modified
      const lockOnDisk = manager.read();
      expect(lockOnDisk.tools.test_tool.version).toBe("1.0.0");
      expect(lockOnDisk.tools.test_tool.artifactDigest).toBe(SAMPLE_DIGEST_B);

      // Attempt update on non-existent tool with expected digest
      const other = makeLockedEntry({ name: "other_tool", toolId: SAMPLE_TOOL_ID_2 });
      expect(() => {
        manager.updateExact("other_tool", other, SAMPLE_DIGEST_A);
      }).toThrow(/Optimistic lock conflict/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disable, pinned, and active status transitions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entry = makeLockedEntry();
      manager.reconcileQualified(entry);

      // Disable
      manager.setStatus("test_tool", "disabled");
      expect(manager.read().tools.test_tool.status).toBe("disabled");

      // Pin
      manager.setStatus("test_tool", "pinned");
      expect(manager.read().tools.test_tool.status).toBe("pinned");

      // Activate
      manager.setStatus("test_tool", "active");
      expect(manager.read().tools.test_tool.status).toBe("active");

      // Non-existent tool throws
      expect(() => {
        manager.setStatus("unknown_tool", "disabled");
      }).toThrow(/Tool 'unknown_tool' not found/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("remove: removes tool from lockfile idempotently", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      manager.reconcileQualified(makeLockedEntry({ name: "tool_a" }));
      manager.reconcileQualified(makeLockedEntry({ name: "tool_b", toolId: SAMPLE_TOOL_ID_2 }));

      expect(Object.keys(manager.read().tools)).toHaveLength(2);

      manager.remove("tool_a");
      const lockAfter = manager.read();
      expect(lockAfter.tools.tool_a).toBeUndefined();
      expect(lockAfter.tools.tool_b).toBeDefined();

      // Idempotent remove
      manager.remove("tool_a");
      expect(manager.read().tools.tool_a).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repair: recovers missing lockfile and salvages valid entries from corrupted JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      // 1. Missing lockfile repair
      const repairedFresh = manager.repair();
      expect(repairedFresh.projectId).toBe(VALID_PROJECT_ID);
      expect(repairedFresh.tools).toEqual({});
      expect(manager.read().projectId).toBe(VALID_PROJECT_ID);

      // 2. Corrupted JSON with valid partial tool entry
      const corruptedData = {
        schemaKind: "tool_lock",
        schemaVersion: 1,
        projectId: VALID_PROJECT_ID,
        tools: {
          valid_tool: {
            toolId: SAMPLE_TOOL_ID,
            name: "valid_tool",
            version: "1.0.0",
            manifestDigest: SAMPLE_DIGEST_A,
            artifactDigest: SAMPLE_DIGEST_B,
            status: "active",
          },
          corrupt_tool: {
            name: "corrupt_tool",
            version: "invalid-semver",
          },
        },
      };
      fs.writeFileSync(manager.lockPath, JSON.stringify(corruptedData, null, 2));

      const repairedSalvaged = manager.repair();
      expect(repairedSalvaged.tools.valid_tool).toBeDefined();
      expect(repairedSalvaged.tools.corrupt_tool).toBeUndefined();
      expect(manager.read().tools.valid_tool.name).toBe("valid_tool");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("project mismatch: throws when lockfile belongs to a different project UUID", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager1 = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });
      manager1.reconcileQualified(makeLockedEntry());

      const managerOther = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: OTHER_PROJECT_ID,
      });

      expect(() => managerOther.read()).toThrow(/Project ID mismatch/);
      expect(() => managerOther.repair()).toThrow(/Project ID mismatch/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("concurrent mutations: serializes operations and prevents race conditions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const manager1 = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });
      const manager2 = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entry1 = makeLockedEntry({ name: "tool_concurrent_1", toolId: SAMPLE_TOOL_ID });
      const entry2 = makeLockedEntry({ name: "tool_concurrent_2", toolId: SAMPLE_TOOL_ID_2 });

      manager1.reconcileQualified(entry1);
      manager2.reconcileQualified(entry2);

      const finalLock = manager1.read();
      expect(finalLock.tools.tool_concurrent_1).toBeDefined();
      expect(finalLock.tools.tool_concurrent_2).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("UserControlsManager with ProjectLockManager & SQLite Fallback", () => {
  it("integrates with ProjectLockManager for lockfile-backed tool lifecycles", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-lock-test-"));
    try {
      const lockManager = new ProjectLockManager({
        lockPath: tmpDir,
        projectId: VALID_PROJECT_ID,
      });

      const entry = makeLockedEntry({ name: "tool_locked" });
      lockManager.reconcileQualified(entry);

      const controls = new UserControlsManager(undefined, lockManager);
      const userControls = await controls.getControls("ws-1");

      expect(userControls.pinnedVersions.tool_locked).toBe("1.0.0");
      expect(userControls.disabledTools).toHaveLength(0);

      // Disable tool via controls
      await controls.disableTool("ws-1", "tool_locked");
      expect(await controls.isToolDisabled("ws-1", "tool_locked")).toBe(true);
      expect(lockManager.read().tools.tool_locked.status).toBe("disabled");

      // Enable tool via controls
      await controls.enableTool("ws-1", "tool_locked");
      expect(await controls.isToolDisabled("ws-1", "tool_locked")).toBe(false);
      expect(lockManager.read().tools.tool_locked.status).toBe("active");

      // Pin requiring explicit exact entry
      await expect(controls.pinVersion("ws-1", "tool_locked", "2.0.0")).rejects.toThrow(
        /Explicit exact V1 entry required/,
      );

      const v2 = makeLockedEntry({
        name: "tool_locked",
        version: "2.0.0",
        artifactDigest: SAMPLE_DIGEST_C,
      });
      await controls.pinVersion("ws-1", "tool_locked", "2.0.0", {
        entry: v2,
        expectedArtifactDigest: SAMPLE_DIGEST_B,
      });

      expect(lockManager.read().tools.tool_locked.version).toBe("2.0.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pins and unpins a tool version without lock manager (in-memory / legacy)", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ name: "tool_pinned", version: "1.0.0" });
    await registry.stageToolVersion(manifest);
    await registry.activateToolVersion("tool_pinned", "1.0.0", "ws-pin");

    await registry.controls.pinVersion("ws-pin", "tool_pinned", "1.0.0");
    const controls = await registry.controls.getControls("ws-pin");
    expect(controls.pinnedVersions.tool_pinned).toBe("1.0.0");

    const manifestV2 = makeManifest({ name: "tool_pinned", version: "2.0.0" });
    await registry.stageToolVersion(manifestV2);
    await registry.activateToolVersion("tool_pinned", "2.0.0", "ws-pin");

    const catalog = await registry.resolveCatalog("ws-pin");
    expect(catalog.tools.tool_pinned.version).toBe("1.0.0");
  });

  it("omits disabled tools from resolved catalog and restores on enable", async () => {
    const registry = new ToolRegistry();
    const manifest = makeManifest({ name: "tool_disabled", version: "1.0.0" });
    await registry.stageToolVersion(manifest);
    await registry.activateToolVersion("tool_disabled", "1.0.0", "ws-disable");

    const catalogBefore = await registry.resolveCatalog("ws-disable");
    expect(catalogBefore.tools.tool_disabled).toBeDefined();

    await registry.controls.disableTool("ws-disable", "tool_disabled");
    const isDis = await registry.controls.isToolDisabled("ws-disable", "tool_disabled");
    expect(isDis).toBe(true);

    const catalogDisabled = await registry.resolveCatalog("ws-disable");
    expect(catalogDisabled.tools.tool_disabled).toBeUndefined();

    await registry.controls.enableTool("ws-disable", "tool_disabled");
    const catalogEnabled = await registry.resolveCatalog("ws-disable");
    expect(catalogEnabled.tools.tool_disabled).toBeDefined();
  });

  it("persists user pin and disable controls across gateway restart using @resin/db", async () => {
    const store = await createInMemoryStateStore();
    const conn = store.getConnection();

    const registry1 = new ToolRegistry({ db: conn });
    const manifest = makeManifest({ name: "tool_persist", version: "1.0.0" });
    await registry1.stageToolVersion(manifest);
    await registry1.activateToolVersion("tool_persist", "1.0.0", "ws-db");

    await registry1.controls.pinVersion("ws-db", "tool_persist", "1.0.0");
    await registry1.controls.disableTool("ws-db", "tool_other");

    // Simulate gateway restart with same database connection
    const registry2 = new ToolRegistry({ db: conn });
    await registry2.stageToolVersion(manifest);
    await registry2.activateToolVersion("tool_persist", "1.0.0", "ws-db");

    const reloadedControls = await registry2.controls.getControls("ws-db");
    expect(reloadedControls.pinnedVersions.tool_persist).toBe("1.0.0");
    expect(reloadedControls.disabledTools).toContain("tool_other");

    const reloadedCatalog = await registry2.resolveCatalog("ws-db");
    expect(reloadedCatalog.tools.tool_persist.version).toBe("1.0.0");
  });
});
