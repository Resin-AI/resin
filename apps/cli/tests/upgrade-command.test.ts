import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_VERSION,
  UpgradeOrchestrator,
  parseUpgradeFlags,
} from "../src/commands/upgrade.js";
import type {
  UpdateEngineResult,
  UpdateEngineRunRequest,
  UpdateStatusSnapshot,
} from "../src/updates/engine.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(dirPath: string): Promise<void> {
      files.set(dirPath, "dir");
    },
    async copyFile(src: string, dest: string): Promise<void> {
      const content = files.get(src);
      if (content !== undefined) files.set(dest, content);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
  };
}

function snapshot(overrides: Partial<UpdateStatusSnapshot> = {}): UpdateStatusSnapshot {
  return {
    schemaVersion: 1,
    channel: "stable",
    currentVersion: "1.1.0",
    targetVersion: "1.1.0",
    pendingVersion: null,
    lastCheckAt: "2026-08-28T00:00:00.000Z",
    lastResult: "activated",
    lastError: null,
    lastRollback: null,
    quarantine: [],
    ...overrides,
  };
}

function result(overrides: Partial<UpdateEngineResult> = {}): UpdateEngineResult {
  return {
    success: true,
    mode: "manual",
    status: "activated",
    channel: "stable",
    currentVersion: "1.0.0",
    activeVersion: "1.1.0",
    targetVersion: "1.1.0",
    staged: true,
    activated: true,
    healthGatePassed: true,
    stepsCompleted: ["preflight", "release_staged", "complete"],
    snapshot: snapshot(),
    ...overrides,
  };
}

describe("upgrade command", () => {
  const homeDir = "/home/testuser";
  const resinHome = path.join(homeDir, ".resin");
  const versionFilePath = path.join(resinHome, "version.json");

  it("parses target, channel, force, and output flags", () => {
    const flags = parseUpgradeFlags([
      "--target-version",
      "1.2.3",
      "--channel=beta",
      "--force",
      "--no-rollback",
      "--json",
    ]);

    expect(flags).toMatchObject({
      targetVersion: "1.2.3",
      channel: "beta",
      force: true,
      noRollback: true,
      json: true,
    });
  });

  it("rejects rollback combined with a target during flag parsing", () => {
    expect(() => parseUpgradeFlags(["--rollback", "--target-version", "0.9.0"])).toThrow(
      "--rollback cannot be combined with --target-version",
    );
  });

  it("keeps dry-run offline and mutation-free", async () => {
    const fsBridge = createMockFsBridge({
      [versionFilePath]: JSON.stringify({ version: "1.0.0" }),
    });
    const run = vi.fn();
    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      resinHome,
      fsBridge,
      engine: { run },
    });

    const upgrade = await orchestrator.runUpgrade({
      targetVersion: "1.1.0",
      channel: "nightly",
      dryRun: true,
    });

    expect(upgrade).toMatchObject({
      success: true,
      dryRun: true,
      status: "dry-run",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
    });
    expect(run).not.toHaveBeenCalled();
    expect(await fsBridge.readFile(versionFilePath)).toBe(JSON.stringify({ version: "1.0.0" }));
  });

  it("rejects an arbitrary target when rollback is requested", async () => {
    const run = vi.fn();
    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      resinHome,
      fsBridge: createMockFsBridge(),
      engine: { run },
    });

    await expect(
      orchestrator.runUpgrade({ rollback: true, targetVersion: "0.9.0" }),
    ).rejects.toThrow("--rollback cannot be combined with --target-version");
    expect(run).not.toHaveBeenCalled();
  });

  it("routes manual channel, rollback policy, and force through UpdateEngine", async () => {
    const requests: UpdateEngineRunRequest[] = [];
    const engine = {
      async run(request: UpdateEngineRunRequest): Promise<UpdateEngineResult> {
        requests.push(request);
        return result({
          status: "rolled-back",
          activeVersion: "0.9.0",
          targetVersion: "0.9.0",
          rolledBack: true,
          snapshot: snapshot({
            channel: "beta",
            currentVersion: "0.9.0",
            targetVersion: "0.9.0",
            lastResult: "rolled-back",
          }),
        });
      },
    };
    const orchestrator = new UpgradeOrchestrator({ homeDir, resinHome, engine });

    const upgrade = await orchestrator.runUpgrade({
      channel: "beta",
      rollback: true,
      force: true,
      noRollback: true,
    });

    expect(requests).toEqual([
      {
        mode: "manual",
        channel: "beta",
        force: true,
        rollback: true,
        rollbackOnFailure: false,
      },
    ]);
    expect(upgrade).toMatchObject({
      success: true,
      status: "rolled-back",
      activeVersion: "0.9.0",
      rolledBack: true,
    });
  });

  it("uses the committed current-version fallback when metadata is absent", async () => {
    const orchestrator = new UpgradeOrchestrator({
      homeDir,
      resinHome,
      fsBridge: createMockFsBridge(),
      engine: { run: async () => result() },
    });

    const upgrade = await orchestrator.runUpgrade({ dryRun: true });
    expect(upgrade.currentVersion).toBe(CURRENT_VERSION);
  });
});
