import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import type { ConfigFsBridge, HarnessInstallation } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessConfigOrchestrator,
  type OrchestrationResult,
} from "../../src/installer/harness-config.js";
import {
  HarnessReconciler,
  ReconciliationNodeFsBridge,
} from "../../src/installer/harness-reconciler.js";
import type {
  HarnessInstallationProbe,
  HarnessReconcileFsBridge,
} from "../../src/installer/harness-reconciler.js";

const HOME = "/home/developer";
const WORKSPACE = "/home/developer/projects/resin-app";
const GATEWAY_URL = "http://127.0.0.1:9400/mcp/sse";
const NO_INSTALLATION_PROBE = async () => null;

class AppliedWriteFailureBridge implements HarnessReconcileFsBridge {
  private failTargetWrite = true;

  constructor(
    private readonly delegate: ConfigFsBridge,
    private readonly targetPath: string,
  ) {}

  readFile(filePath: string): Promise<string | null> {
    return this.delegate.readFile(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (filePath === this.targetPath && this.failTargetWrite) {
      this.failTargetWrite = false;
      await this.delegate.writeFile(filePath, content);
      const error = Object.assign(new Error(`EACCES: permission denied writing ${filePath}`), {
        code: "EACCES",
      });
      throw error;
    }
    await this.delegate.writeFile(filePath, content);
  }

  exists(filePath: string): Promise<boolean> {
    return this.delegate.exists(filePath);
  }

  mkdirp(directoryPath: string): Promise<void> {
    return this.delegate.mkdirp(directoryPath);
  }

  copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this.delegate.copyFile(sourcePath, destinationPath);
  }

  unlink(filePath: string): Promise<void> {
    return this.delegate.unlink(filePath);
  }
}

class HookedWriteBridge implements HarnessReconcileFsBridge {
  constructor(
    protected readonly delegate: InMemoryConfigFsBridge,
    private readonly hook: (
      filePath: string,
      content: string,
      delegate: InMemoryConfigFsBridge,
    ) => Promise<boolean>,
  ) {}

  readFile(filePath: string): Promise<string | null> {
    return this.delegate.readFile(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (!(await this.hook(filePath, content, this.delegate))) {
      await this.delegate.writeFile(filePath, content);
    }
  }

  exists(filePath: string): Promise<boolean> {
    return this.delegate.exists(filePath);
  }

  mkdirp(directoryPath: string): Promise<void> {
    return this.delegate.mkdirp(directoryPath);
  }

  copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this.delegate.copyFile(sourcePath, destinationPath);
  }

  unlink(filePath: string): Promise<void> {
    return this.delegate.unlink(filePath);
  }
}

class OneBackupCollisionBridge extends HookedWriteBridge {
  private collide = true;

  async writeFileExclusive(filePath: string, content: string): Promise<boolean> {
    if (filePath.endsWith(".bak") && this.collide) {
      this.collide = false;
      return false;
    }
    if (await this.delegate.exists(filePath)) {
      return false;
    }
    await this.delegate.writeFile(filePath, content);
    return true;
  }
}

class FinalBoundaryWriterBridge extends ReconciliationNodeFsBridge {
  private injected = false;

  constructor(
    private readonly targetPath: string,
    private readonly concurrentContent: string,
    private readonly phase: "before-install" | "after-install",
  ) {
    super();
  }

  protected override async linkTransactionFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    const isTargetInstall =
      !this.injected &&
      destinationPath === this.targetPath &&
      path.basename(sourcePath) === "planned";
    if (!isTargetInstall) {
      await super.linkTransactionFile(sourcePath, destinationPath);
      return;
    }

    this.injected = true;
    if (this.phase === "before-install") {
      await fs.writeFile(destinationPath, this.concurrentContent, { flag: "wx", mode: 0o600 });
      await super.linkTransactionFile(sourcePath, destinationPath);
      return;
    }

    await super.linkTransactionFile(sourcePath, destinationPath);
    const concurrentPath = `${destinationPath}.concurrent-${process.pid}`;
    await fs.writeFile(concurrentPath, this.concurrentContent, { flag: "wx", mode: 0o600 });
    await fs.rename(concurrentPath, destinationPath);
  }
}

describe("HarnessReconciler", () => {
  it("registers harnesses discovered after init and is idempotent", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const reconciler = new HarnessReconciler();
    const probedHarnesses: string[] = [];
    const probeHarness: HarnessInstallationProbe = async ({
      harnessId,
      targetPath,
      customHome,
    }) => {
      probedHarnesses.push(harnessId);
      return {
        harnessId,
        displayName: harnessId,
        version: "test",
        isInstalled: true,
        status: "ready",
        configPath: targetPath,
        homePath: customHome,
        detectedAt: "2026-08-27T12:00:00.000Z",
        metadata: { discoveredBy: "probe" },
      };
    };
    const options = {
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness,
    };

    const first = await reconciler.reconcile(options);
    expect(probedHarnesses).toEqual(["claude-code", "codex-cli", "omp"]);
    expect(first.success).toBe(true);
    expect(first.autoRepair).toBe(true);
    expect(first.results.map((result) => result.status)).toEqual([
      "reconciled",
      "reconciled",
      "reconciled",
    ]);
    expect(JSON.parse((await bridge.readFile(`${HOME}/.claude/claude.json`)) ?? "")).toMatchObject({
      mcpServers: { resin: { type: "sse", url: GATEWAY_URL } },
    });
    expect(await bridge.readFile(`${HOME}/.codex/config.toml`)).toContain(
      `[mcp_servers.resin]\nurl = "${GATEWAY_URL}"`,
    );
    expect(JSON.parse((await bridge.readFile(`${HOME}/.omp/agent/mcp.json`)) ?? "")).toMatchObject({
      mcpServers: { resin: { type: "sse", url: GATEWAY_URL } },
    });

    const backupCount = Object.keys(bridge.dump()).filter(
      (filePath) => filePath.includes(".resin-backup.") && filePath.endsWith(".bak"),
    ).length;
    probedHarnesses.length = 0;
    const second = await reconciler.reconcile(options);
    expect(probedHarnesses).toEqual(["claude-code", "codex-cli", "omp"]);
    expect(second.results.map((result) => result.status)).toEqual([
      "registered",
      "registered",
      "registered",
    ]);
    expect(
      Object.keys(bridge.dump()).filter(
        (filePath) => filePath.includes(".resin-backup.") && filePath.endsWith(".bak"),
      ),
    ).toHaveLength(backupCount);
  });

  it("repairs missing and wrong Resin entries without changing user-owned data", async () => {
    const bridge = new InMemoryConfigFsBridge();
    await bridge.writeFile(
      `${HOME}/.claude/claude.json`,
      JSON.stringify({
        theme: "dark",
        env: { USER_TOKEN: "keep" },
        mcpServers: { user_server: { command: "user-mcp", env: { TOKEN: "keep" } } },
      }),
    );
    const codexOriginal = [
      'model = "gpt-5.6"',
      "",
      "[mcp_servers.user_server]",
      'command = "user-mcp"',
      'env.TOKEN = "keep"',
      "",
      "[mcp_servers.resin]",
      'url = "http://wrong.invalid/sse"',
      'env.RESIN_USER_TOKEN = "keep-owned-env"',
      "",
    ].join("\n");
    await bridge.writeFile(`${HOME}/.codex/config.toml`, codexOriginal);
    await bridge.writeFile(
      `${HOME}/.omp/agent/mcp.json`,
      JSON.stringify({
        settings: { compact: true },
        mcpServers: {
          user_server: { type: "stdio", command: "user-mcp", env: { TOKEN: "keep" } },
          resin: {
            type: "sse",
            url: "http://wrong.invalid/sse",
            env: { RESIN_USER_TOKEN: "keep-owned-env" },
          },
        },
      }),
    );

    const report = await new HarnessReconciler().reconcile({
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      installedHarnesses: ["claude-code", "codex-cli", "omp"],
      probeHarness: NO_INSTALLATION_PROBE,
    });

    expect(report.results.map((result) => [result.condition, result.status])).toEqual([
      ["missing", "reconciled"],
      ["drifted", "reconciled"],
      ["drifted", "reconciled"],
    ]);

    const claude = JSON.parse((await bridge.readFile(`${HOME}/.claude/claude.json`)) ?? "");
    expect(claude.theme).toBe("dark");
    expect(claude.env).toEqual({ USER_TOKEN: "keep" });
    expect(claude.mcpServers.user_server).toEqual({
      command: "user-mcp",
      env: { TOKEN: "keep" },
    });

    const codex = await bridge.readFile(`${HOME}/.codex/config.toml`);
    expect(codex).toContain('model = "gpt-5.6"');
    expect(codex).toContain("[mcp_servers.user_server]");
    expect(codex).toContain('env.TOKEN = "keep"');
    expect(codex).toContain('env.RESIN_USER_TOKEN = "keep-owned-env"');

    const omp = JSON.parse((await bridge.readFile(`${HOME}/.omp/agent/mcp.json`)) ?? "");
    expect(omp.settings).toEqual({ compact: true });
    expect(omp.mcpServers.user_server).toEqual({
      type: "stdio",
      command: "user-mcp",
      env: { TOKEN: "keep" },
    });
    expect(omp.mcpServers.resin.env).toEqual({
      RESIN_USER_TOKEN: "keep-owned-env",
    });
  });

  it("reports corrupt configuration without replacing or backing it up", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.claude/claude.json`;
    const corruptContent = '{"mcpServers":';
    await bridge.writeFile(targetPath, corruptContent);

    const report = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });

    expect(report.success).toBe(false);
    expect(report.results[0]).toMatchObject({
      status: "drift_detected",
      condition: "corrupt",
      configured: false,
      changed: false,
    });
    expect(await bridge.readFile(targetPath)).toBe(corruptContent);
    expect(
      Object.keys(bridge.dump()).filter(
        (filePath) => filePath.includes(".resin-backup.") && filePath.endsWith(".bak"),
      ),
    ).toEqual([]);
  });

  it("rolls back a partial permission failure from the timestamped backup", async () => {
    const delegate = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.claude/claude.json`;
    const original = JSON.stringify({
      settings: { theme: "dark" },
      mcpServers: { resin: { type: "sse", url: "http://wrong.invalid/sse" } },
    });
    await delegate.writeFile(targetPath, original);
    const bridge = new AppliedWriteFailureBridge(delegate, targetPath);

    const report = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });

    expect(report.success).toBe(false);
    expect(report.results[0]).toMatchObject({
      status: "drift_detected",
      changed: false,
      rolledBack: true,
    });
    expect(report.results[0]?.error).toContain("permission denied");
    expect(await delegate.readFile(targetPath)).toBe(original);
    const backupPaths = Object.keys(delegate.dump()).filter(
      (filePath) => filePath.includes(".resin-backup.") && filePath.endsWith(".bak"),
    );
    expect(backupPaths).toHaveLength(1);
    expect(await delegate.readFile(backupPaths[0]!)).toBe(original);
  });

  it("retains only the five newest backups", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.claude/claude.json`;
    await bridge.writeFile(
      targetPath,
      JSON.stringify({
        settings: { keep: true },
        mcpServers: { user_server: { command: "keep" } },
      }),
    );
    const manualBackup = `${targetPath}.bak.notes`;
    const lookalikeBackup = `${targetPath}.resin-backup.123.notes.bak`;
    await bridge.writeFile(manualBackup, "manual backup: do not delete");
    await bridge.writeFile(lookalikeBackup, "lookalike backup: do not delete");
    const reconciler = new HarnessReconciler();

    for (let index = 0; index < 7; index += 1) {
      const report = await reconciler.reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: HOME,
        workspacePath: WORKSPACE,
        gatewayUrl: `${GATEWAY_URL}?revision=${index}`,
        fsBridge: bridge,
        probeHarness: NO_INSTALLATION_PROBE,
        now: () => new Date("2026-08-27T12:00:00.000Z"),
      });
      expect(report.results[0]?.status).toBe("reconciled");
    }

    const backupPaths = Object.keys(bridge.dump()).filter(
      (filePath) =>
        filePath.startsWith(`${targetPath}.resin-backup.`) &&
        filePath.endsWith(".bak") &&
        filePath !== lookalikeBackup,
    );
    expect(backupPaths).toHaveLength(5);
    expect(await bridge.readFile(manualBackup)).toBe("manual backup: do not delete");
    expect(await bridge.readFile(lookalikeBackup)).toBe("lookalike backup: do not delete");
    const current = JSON.parse((await bridge.readFile(targetPath)) ?? "");
    expect(current.settings).toEqual({ keep: true });
    expect(current.mcpServers.user_server).toEqual({ command: "keep" });
  });

  it("honors auto-repair opt-out while still reporting drift", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.omp/agent/mcp.json`;
    const original = JSON.stringify({
      settings: { managedByDotfiles: true },
      mcpServers: { resin: { type: "sse", url: "http://wrong.invalid/sse" } },
    });
    await bridge.writeFile(targetPath, original);

    const report = await new HarnessReconciler().reconcile({
      harnesses: ["omp"],
      installedHarnesses: ["omp"],
      autoRepair: false,
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });

    expect(report.autoRepair).toBe(false);
    expect(report.success).toBe(true);
    expect(report.results[0]).toMatchObject({
      status: "drift_detected",
      condition: "drifted",
      changed: false,
    });
    expect(await bridge.readFile(targetPath)).toBe(original);
    expect(
      Object.keys(bridge.dump()).some(
        (filePath) => filePath.includes(".resin-backup.") && filePath.endsWith(".bak"),
      ),
    ).toBe(false);

    const missingTargetPath = `${HOME}/.claude/claude.json`;
    const userManagedConfig = JSON.stringify({
      mcpServers: { user_server: { command: "user-mcp" } },
    });
    await bridge.writeFile(missingTargetPath, userManagedConfig);
    const missingReport = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      autoRepair: false,
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });
    expect(missingReport.results[0]).toMatchObject({
      status: "unregistered",
      condition: "missing",
      changed: false,
    });
    expect(await bridge.readFile(missingTargetPath)).toBe(userManagedConfig);
  });

  it("creates private backups and preserves existing target permissions", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-reconcile-"));
    try {
      const targetPath = path.join(home, ".claude", "claude.json");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(
        targetPath,
        JSON.stringify({ mcpServers: { resin: { url: "http://wrong.invalid/sse" } } }),
        { mode: 0o640 },
      );

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: home,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.results[0]?.status).toBe("reconciled");
      const backupPath = report.results[0]?.backup?.backupPath;
      expect(backupPath).toBeDefined();
      expect((await fs.stat(backupPath!)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o640);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("repairs non-URL transport drift while preserving custom server fields", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.omp/agent/mcp.json`;
    await bridge.writeFile(
      targetPath,
      JSON.stringify({
        mcpServers: {
          resin: {
            type: "stdio",
            command: "/missing",
            args: ["--wrong"],
            url: GATEWAY_URL,
            env: { RESIN_TOKEN: "keep" },
          },
        },
      }),
    );
    const report = await new HarnessReconciler().reconcile({
      harnesses: ["omp"],
      installedHarnesses: ["omp"],
      customHome: HOME,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });
    expect(report.results[0]).toMatchObject({
      status: "reconciled",
      condition: "drifted",
      changed: true,
    });
    const repaired = JSON.parse((await bridge.readFile(targetPath)) ?? "");
    expect(repaired.mcpServers.resin).toEqual({
      type: "sse",
      url: GATEWAY_URL,
      env: { RESIN_TOKEN: "keep" },
    });
  });
  it("preserves symlink-managed configs and fails closed for locks or broken links", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-symlink-"));
    try {
      const managedPath = path.join(home, "dotfiles", "claude.json");
      const targetPath = path.join(home, ".claude", "claude.json");
      await fs.mkdir(path.dirname(managedPath), { recursive: true });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(
        managedPath,
        JSON.stringify({
          keep: "managed",
          mcpServers: { resin: { type: "stdio", command: "/old", url: "http://old" } },
        }),
      );
      await fs.symlink(path.relative(path.dirname(targetPath), managedPath), targetPath);

      const reconciler = new HarnessReconciler();
      const repaired = await reconciler.reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: home,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });
      expect(repaired.results[0]?.status).toBe("reconciled");
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await fs.readFile(managedPath, "utf8"))).toMatchObject({
        keep: "managed",
        mcpServers: { resin: { type: "sse", url: GATEWAY_URL } },
      });

      const externallyEdited = JSON.stringify({
        keep: "external",
        mcpServers: { resin: { type: "sse", url: "http://external" } },
      });
      await fs.writeFile(managedPath, externallyEdited);
      const lockPath = path.join(
        path.dirname(managedPath),
        `.${path.basename(managedPath)}.resin-reconcile.lock`,
      );
      await fs.writeFile(lockPath, "held by another process", { mode: 0o600 });
      const locked = await reconciler.reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: home,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });
      expect(locked.success).toBe(false);
      expect(locked.results[0]?.error).toContain("lock is already held");
      expect(await fs.readFile(managedPath, "utf8")).toBe(externallyEdited);
      expect(await fs.readFile(lockPath, "utf8")).toBe("held by another process");

      await fs.unlink(lockPath);
      await fs.unlink(managedPath);
      const broken = await reconciler.reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: home,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });
      expect(broken.success).toBe(false);
      expect(broken.results[0]?.error).toContain("broken symbolic link");
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(managedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to replace or delete concurrent writer content around writes and rollbacks", async () => {
    const targetPath = `${HOME}/.claude/claude.json`;
    const original = JSON.stringify({
      keep: "original",
      mcpServers: { resin: { type: "sse", url: "http://old" } },
    });
    const concurrentAfterBackup = JSON.stringify({
      keep: "writer-after-backup",
      mcpServers: { resin: { type: "sse", url: "http://writer" } },
    });
    const backupDelegate = new InMemoryConfigFsBridge();
    await backupDelegate.writeFile(targetPath, original);
    let racedBackup = false;
    const backupRaceBridge = new HookedWriteBridge(
      backupDelegate,
      async (filePath, content, delegate) => {
        if (!racedBackup && filePath.includes(".resin-backup.") && filePath.endsWith(".bak")) {
          racedBackup = true;
          await delegate.writeFile(filePath, content);
          await delegate.writeFile(targetPath, concurrentAfterBackup);
          return true;
        }
        return false;
      },
    );
    const backupRace = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: HOME,
      gatewayUrl: GATEWAY_URL,
      fsBridge: backupRaceBridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });
    expect(backupRace.success).toBe(false);
    expect(backupRace.results[0]?.error).toContain("changed after backup");
    expect(await backupDelegate.readFile(targetPath)).toBe(concurrentAfterBackup);

    for (const originalContent of [original, null]) {
      const delegate = new InMemoryConfigFsBridge();
      if (originalContent !== null) {
        await delegate.writeFile(targetPath, originalContent);
      }
      const concurrentDuringRollback = JSON.stringify({
        keep: originalContent === null ? "new-writer-file" : "writer-during-rollback",
        mcpServers: { resin: { type: "sse", url: "http://writer" } },
      });
      let interceptedTarget = false;
      const bridge = new HookedWriteBridge(delegate, async (filePath, content, inner) => {
        if (filePath === targetPath && !interceptedTarget) {
          interceptedTarget = true;
          await inner.writeFile(filePath, content);
          await inner.writeFile(filePath, concurrentDuringRollback);
          throw new Error("verification failed after concurrent write");
        }
        return false;
      });
      const report = await new HarnessReconciler().reconcile({
        harnesses: ["claude-code"],
        installedHarnesses: ["claude-code"],
        customHome: HOME,
        gatewayUrl: GATEWAY_URL,
        fsBridge: bridge,
        probeHarness: NO_INSTALLATION_PROBE,
      });
      expect(report.success).toBe(false);
      expect(report.results[0]).toMatchObject({ rolledBack: false, changed: false });
      expect(report.results[0]?.error).toContain("refusing to overwrite");
      expect(await delegate.readFile(targetPath)).toBe(concurrentDuringRollback);
    }
  });

  it("retries exclusive backup collisions and authenticates bytes before rollback", async () => {
    const targetPath = `${HOME}/.claude/claude.json`;
    const original = JSON.stringify({
      keep: true,
      mcpServers: { resin: { type: "sse", url: "http://old" } },
    });
    const collisionDelegate = new InMemoryConfigFsBridge();
    await collisionDelegate.writeFile(targetPath, original);
    const collisionBridge = new OneBackupCollisionBridge(collisionDelegate, async () => false);
    const collisionReport = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: HOME,
      gatewayUrl: GATEWAY_URL,
      fsBridge: collisionBridge,
      probeHarness: NO_INSTALLATION_PROBE,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });
    expect(collisionReport.results[0]?.status).toBe("reconciled");
    expect(collisionReport.results[0]?.backup?.backupPath).toContain(
      ".resin-backup.1787832000001.",
    );

    const tamperDelegate = new InMemoryConfigFsBridge();
    await tamperDelegate.writeFile(targetPath, original);
    let tampered = false;
    const tamperBridge = new HookedWriteBridge(
      tamperDelegate,
      async (filePath, content, delegate) => {
        if (filePath === targetPath && !tampered) {
          tampered = true;
          await delegate.writeFile(filePath, content);
          const backupPath = Object.keys(delegate.dump()).find(
            (candidate) => candidate.includes(".resin-backup.") && candidate.endsWith(".bak"),
          );
          expect(backupPath).toBeDefined();
          await delegate.writeFile(backupPath!, "attacker-replaced-backup");
          throw new Error("force rollback after backup tampering");
        }
        return false;
      },
    );
    const tamperReport = await new HarnessReconciler().reconcile({
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: HOME,
      gatewayUrl: GATEWAY_URL,
      fsBridge: tamperBridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });
    expect(tamperReport.success).toBe(false);
    expect(tamperReport.results[0]?.rolledBack).toBe(false);
    expect(tamperReport.results[0]?.error).toContain("does not authenticate");
    expect(await tamperDelegate.readFile(targetPath)).not.toBe("attacker-replaced-backup");
  });

  it("recovers a crash-stale process-incarnation lock without leaving a permanent lock", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-crash-lock-"));
    try {
      const targetPath = path.join(home, ".codex", "config.toml");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(
        targetPath,
        ["[mcp_servers.resin]", 'url = "http://wrong.invalid/sse"', ""].join("\n"),
        { mode: 0o600 },
      );
      const lockPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.resin-reconcile.lock`,
      );
      await fs.mkdir(lockPath, { mode: 0o700 });
      const staleToken = "00000000-0000-4000-8000-000000000001";
      await fs.writeFile(
        path.join(lockPath, `${staleToken}.claim`),
        JSON.stringify({
          format: "resin-harness-lock/v2",
          token: staleToken,
          fenceToken: `1:${staleToken}`,
          targetPath: await fs.realpath(targetPath),
          pid: 2_147_483_647,
          processStartIdentity: "proc:1",
          createdAt: 1,
          createdMonotonicNs: "1",
          leaseExpiresAt: 2,
          leaseExpiresMonotonicNs: "2",
        }),
        { mode: 0o600 },
      );

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["codex-cli"],
        installedHarnesses: ["codex-cli"],
        customHome: home,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.results[0]).toMatchObject({ status: "reconciled", changed: true });
      expect(await fs.readFile(targetPath, "utf8")).toContain(`url = "${GATEWAY_URL}"`);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic-link lock without touching its target or the harness config", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-lock-symlink-"));
    try {
      const targetPath = path.join(home, ".codex", "config.toml");
      const original = ["[mcp_servers.resin]", 'url = "http://wrong.invalid/sse"', ""].join("\n");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, original, { mode: 0o600 });
      const victimPath = path.join(home, "victim");
      await fs.writeFile(victimPath, "do not touch", { mode: 0o600 });
      const lockPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.resin-reconcile.lock`,
      );
      await fs.symlink(victimPath, lockPath);

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["codex-cli"],
        installedHarnesses: ["codex-cli"],
        customHome: home,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.success).toBe(false);
      expect(report.results[0]?.error).toContain("symbolic-link reconciliation lock");
      expect(await fs.readFile(targetPath, "utf8")).toBe(original);
      expect(await fs.readFile(victimPath, "utf8")).toBe("do not touch");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("inserts a missing Codex URL after an EOF table header", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.codex/config.toml`;
    await bridge.writeFile(targetPath, "[mcp_servers.resin]");

    const report = await new HarnessReconciler().reconcile({
      harnesses: ["codex-cli"],
      installedHarnesses: ["codex-cli"],
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });

    expect(report.results[0]).toMatchObject({ status: "reconciled", changed: true });
    expect(await bridge.readFile(targetPath)).toBe(`[mcp_servers.resin]\nurl = "${GATEWAY_URL}"\n`);
  });

  it("removes complete multiline owned Codex args while retaining adjacent user TOML", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = `${HOME}/.codex/config.toml`;
    await bridge.writeFile(
      targetPath,
      [
        "[mcp_servers.resin]",
        'url = "http://wrong.invalid/sse"',
        'command = "legacy-command"',
        "args = [",
        '  "--legacy",',
        '  "value#inside-string", # keep this comment inside the removed value',
        "]",
        'user_note = "preserve me"',
        "",
      ].join("\n"),
    );

    const report = await new HarnessReconciler().reconcile({
      harnesses: ["codex-cli"],
      installedHarnesses: ["codex-cli"],
      customHome: HOME,
      workspacePath: WORKSPACE,
      gatewayUrl: GATEWAY_URL,
      fsBridge: bridge,
      probeHarness: NO_INSTALLATION_PROBE,
    });
    const repaired = await bridge.readFile(targetPath);

    expect(report.results[0]).toMatchObject({ status: "reconciled", changed: true });
    expect(repaired).toContain(`url = "${GATEWAY_URL}"`);
    expect(repaired).toContain('user_note = "preserve me"');
    expect(repaired).not.toContain("legacy-command");
    expect(repaired).not.toContain("--legacy");
    expect(repaired).not.toContain("value#inside-string");
  });

  it("preserves concurrent bytes on both sides of the final atomic install boundary", async () => {
    for (const phase of ["before-install", "after-install"] as const) {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), `resin-harness-${phase}-`));
      try {
        const targetPath = path.join(home, ".claude", "claude.json");
        const original = JSON.stringify({
          keep: "original",
          mcpServers: { resin: { url: "http://wrong.invalid/sse" } },
        });
        const concurrent = JSON.stringify({ concurrentUserEdit: phase });
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, original, { mode: 0o600 });

        const report = await new HarnessReconciler().reconcile({
          harnesses: ["claude-code"],
          installedHarnesses: ["claude-code"],
          customHome: home,
          workspacePath: WORKSPACE,
          gatewayUrl: GATEWAY_URL,
          fsBridge: new FinalBoundaryWriterBridge(targetPath, concurrent, phase),
          probeHarness: NO_INSTALLATION_PROBE,
        });

        expect(report.success).toBe(false);
        expect(report.results[0]?.error).toMatch(/concurrent/i);
        expect(await fs.readFile(targetPath, "utf8")).toBe(concurrent);

        const transactionName = (await fs.readdir(path.dirname(targetPath))).find((entry) =>
          entry.startsWith(`.${path.basename(targetPath)}.resin-transaction-`),
        );
        expect(transactionName).toBeDefined();
        const transactionPath = path.join(path.dirname(targetPath), transactionName!);
        expect(await fs.readFile(path.join(transactionPath, "captured"), "utf8")).toBe(original);
        expect(await fs.readFile(path.join(transactionPath, "planned"), "utf8")).toContain(
          GATEWAY_URL,
        );
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  });

  it("discovers through the production orchestrator and uses its safe bridge by default", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-orchestrator-"));
    const targetPath = path.join(home, ".claude", "claude.json");
    const original = JSON.stringify({
      keep: "original",
      mcpServers: { resin: { type: "sse", url: "http://wrong.invalid/sse" } },
    });
    const concurrent = JSON.stringify({
      keep: "external",
      mcpServers: { user_server: { command: "keep-me" } },
    });

    try {
      let absentProbeCount = 0;
      const absent = await new HarnessConfigOrchestrator().configureHarnesses({
        harnesses: ["claude-code"],
        customHome: home,
        workspacePath: WORKSPACE,
        probeHarness: async () => {
          absentProbeCount += 1;
          return null;
        },
      });
      expect(absentProbeCount).toBe(1);
      expect(absent.results[0]).toMatchObject({ installed: false, configured: false });
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, original, { mode: 0o600 });
      const installation: HarnessInstallation = {
        harnessId: "claude-code",
        displayName: "Claude Code",
        version: "test",
        isInstalled: true,
        status: "ready",
        configPath: targetPath,
        homePath: home,
        detectedAt: "2026-08-28T00:00:00.000Z",
        metadata: { discoveredBy: "test-probe" },
      };
      const discovered: HarnessInstallation[] = [];
      const originalCompareAndSwap = ReconciliationNodeFsBridge.prototype.compareAndSwapFile;
      let externalWriteInjected = false;
      const compareAndSwap = vi
        .spyOn(ReconciliationNodeFsBridge.prototype, "compareAndSwapFile")
        .mockImplementation(async function (
          this: ReconciliationNodeFsBridge,
          filePath,
          expectedContent,
          content,
        ): Promise<boolean> {
          if (!externalWriteInjected && filePath === targetPath) {
            externalWriteInjected = true;
            await fs.writeFile(targetPath, concurrent, { mode: 0o600 });
          }
          return originalCompareAndSwap.call(this, filePath, expectedContent, content);
        });

      let conflicted: OrchestrationResult;
      try {
        conflicted = await new HarnessConfigOrchestrator().configureHarnesses({
          harnesses: ["claude-code"],
          customHome: home,
          workspacePath: WORKSPACE,
          gatewayUrl: GATEWAY_URL,
          probeHarness: async () => installation,
          onHarnessDiscovered: (harness) => discovered.push(harness),
        });
      } finally {
        compareAndSwap.mockRestore();
      }

      expect(externalWriteInjected).toBe(true);
      expect(discovered).toEqual([installation]);
      expect(conflicted.success).toBe(false);
      expect(await fs.readFile(targetPath, "utf8")).toBe(concurrent);

      const injectedBridge = new InMemoryConfigFsBridge();
      const injected = await new HarnessConfigOrchestrator().configureHarnesses({
        harnesses: ["claude-code"],
        customHome: HOME,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        fsBridge: injectedBridge,
        probeHarness: async () => installation,
      });
      expect(injected.success).toBe(true);
      expect(await injectedBridge.exists(`${HOME}/.claude/claude.json`)).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("fences and drains an in-flight heartbeat before removing its lock claim", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-heartbeat-"));
    const targetPath = path.join(home, "config.json");
    await fs.writeFile(targetPath, "{}", { mode: 0o600 });

    let enterAction!: () => void;
    const actionEntered = new Promise<void>((resolve) => {
      enterAction = resolve;
    });
    let finishAction!: () => void;
    const actionFinished = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    let enterRefreshRename!: () => void;
    const refreshRenameEntered = new Promise<void>((resolve) => {
      enterRefreshRename = resolve;
    });
    let allowRefreshRename!: () => void;
    const refreshRenameAllowed = new Promise<void>((resolve) => {
      allowRefreshRename = resolve;
    });
    let enterCleanupRename!: () => void;
    const cleanupRenameEntered = new Promise<void>((resolve) => {
      enterCleanupRename = resolve;
    });
    let allowCleanupRename!: () => void;
    const cleanupRenameAllowed = new Promise<void>((resolve) => {
      allowCleanupRename = resolve;
    });

    const bridge = new ReconciliationNodeFsBridge();
    type ActiveLockForTest = {
      readonly claimPath: string;
      readonly lockPath: string;
      readonly releaseStarted?: boolean;
    };
    interface ReconciliationFsBridgeInternals {
      readonly activeLocks: Map<string, ActiveLockForTest>;
      refreshLockLease(activeLock: ActiveLockForTest): Promise<void>;
    }
    // SAFETY: Access private activeLocks map and refreshLockLease method on ReconciliationNodeFsBridge instance in test.
    const internals = bridge as ReconciliationNodeFsBridge & ReconciliationFsBridgeInternals;
    let claimPath: string | undefined;
    const originalRename = fs.rename;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      const sourcePath = String(source);
      const destinationPath = String(destination);
      if (
        claimPath !== undefined &&
        sourcePath.startsWith(`${claimPath}.refresh-`) &&
        destinationPath === claimPath
      ) {
        enterRefreshRename();
        await refreshRenameAllowed;
      } else if (
        claimPath !== undefined &&
        sourcePath === claimPath &&
        destinationPath.startsWith(`${claimPath}.retired-`)
      ) {
        enterCleanupRename();
        await cleanupRenameAllowed;
      }
      await originalRename(source, destination);
    });

    try {
      const locked = bridge.withFileLock(targetPath, async () => {
        enterAction();
        await actionFinished;
      });
      await actionEntered;
      const activeLock = internals.activeLocks.get(path.resolve(targetPath));
      expect(activeLock).toBeDefined();
      claimPath = activeLock!.claimPath;
      const refresh = internals.refreshLockLease(activeLock!);
      await refreshRenameEntered;

      finishAction();
      for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve();
      }

      if (activeLock!.releaseStarted === true) {
        allowRefreshRename();
        await refresh;
        await cleanupRenameEntered;
        allowCleanupRename();
        await locked;
      } else {
        await cleanupRenameEntered;
        allowCleanupRename();
        await locked;
        allowRefreshRename();
        await refresh;
      }

      await expect(fs.access(activeLock!.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(bridge.withFileLock(targetPath, async () => "reacquired")).resolves.toBe(
        "reacquired",
      );
    } finally {
      allowRefreshRename();
      allowCleanupRename();
      rename.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  describe("legacy alias reconciliation and migration", () => {
    it("reconciles recognized legacy aliases to canonical resin key across all harnesses", async () => {
      const bridge = new InMemoryConfigFsBridge();

      // Claude Code with legacy alias
      await bridge.writeFile(
        `${HOME}/.claude/claude.json`,
        JSON.stringify({
          mcpServers: {
            resin_gateway: { type: "sse", url: GATEWAY_URL },
          },
        }),
      );

      // Codex CLI with legacy alias
      await bridge.writeFile(
        `${HOME}/.codex/config.toml`,
        `[mcp_servers.resin_gateway]\nurl = "${GATEWAY_URL}"\n`,
      );

      // OMP with legacy alias
      await bridge.writeFile(
        `${HOME}/.omp/agent/mcp.json`,
        JSON.stringify({
          mcpServers: {
            "resin-gateway": { type: "sse", url: GATEWAY_URL },
          },
        }),
      );

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["claude-code", "codex-cli", "omp"],
        installedHarnesses: ["claude-code", "codex-cli", "omp"],
        customHome: HOME,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        fsBridge: bridge,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.success).toBe(true);

      const claude = JSON.parse((await bridge.readFile(`${HOME}/.claude/claude.json`)) ?? "{}");
      expect(claude.mcpServers.resin).toEqual({ type: "sse", url: GATEWAY_URL });
      expect(claude.mcpServers.resin_gateway).toBeUndefined();

      const codex = await bridge.readFile(`${HOME}/.codex/config.toml`);
      expect(codex).toContain(`[mcp_servers.resin]\nurl = "${GATEWAY_URL}"`);
      expect(codex).not.toContain("[mcp_servers.resin_gateway]");

      const omp = JSON.parse((await bridge.readFile(`${HOME}/.omp/agent/mcp.json`)) ?? "{}");
      expect(omp.mcpServers.resin).toEqual({ type: "sse", url: GATEWAY_URL });
      expect(omp.mcpServers["resin-gateway"]).toBeUndefined();
    });

    it("preserves unrecognized same-named legacy alias during reconciliation", async () => {
      const bridge = new InMemoryConfigFsBridge();

      await bridge.writeFile(
        `${HOME}/.codex/config.toml`,
        `[mcp_servers.resin_gateway]\nurl = "http://unrecognized.custom/sse"\n`,
      );

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["codex-cli"],
        installedHarnesses: ["codex-cli"],
        customHome: HOME,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        fsBridge: bridge,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.success).toBe(true);
      const codex = await bridge.readFile(`${HOME}/.codex/config.toml`);
      expect(codex).toContain("[mcp_servers.resin]");
      expect(codex).toContain("[mcp_servers.resin_gateway]");
      expect(codex).toContain('url = "http://unrecognized.custom/sse"');
    });

    it("preserves custom user fields during migration without failing user-owned projection validation", async () => {
      const bridge = new InMemoryConfigFsBridge();

      // Codex TOML with user settings and legacy alias with custom env
      await bridge.writeFile(
        `${HOME}/.codex/config.toml`,
        [
          'model = "gpt-5.6"',
          "",
          "[mcp_servers.resin_gateway]",
          `url = "${GATEWAY_URL}"`,
          'env.CUSTOM_KEY = "custom-secret"',
          "",
          "[user_custom_table]",
          'foo = "bar"',
        ].join("\n"),
      );

      // OMP JSON with user settings and legacy alias with custom env
      await bridge.writeFile(
        `${HOME}/.omp/agent/mcp.json`,
        JSON.stringify({
          settings: { compact: true },
          mcpServers: {
            "resin-gateway": {
              type: "sse",
              url: GATEWAY_URL,
              env: { CUSTOM_VAR: "keep-me" },
            },
            user_srv: { command: "user-bin" },
          },
        }),
      );

      const report = await new HarnessReconciler().reconcile({
        harnesses: ["codex-cli", "omp"],
        installedHarnesses: ["codex-cli", "omp"],
        customHome: HOME,
        workspacePath: WORKSPACE,
        gatewayUrl: GATEWAY_URL,
        fsBridge: bridge,
        probeHarness: NO_INSTALLATION_PROBE,
      });

      expect(report.success).toBe(true);

      const codex = await bridge.readFile(`${HOME}/.codex/config.toml`);
      expect(codex).toContain('model = "gpt-5.6"');
      expect(codex).toContain("[user_custom_table]");
      expect(codex).toContain('foo = "bar"');
      expect(codex).toContain("[mcp_servers.resin]");

      const omp = JSON.parse((await bridge.readFile(`${HOME}/.omp/agent/mcp.json`)) ?? "{}");
      expect(omp.settings).toEqual({ compact: true });
      expect(omp.mcpServers.user_srv).toEqual({ command: "user-bin" });
      expect(omp.mcpServers.resin).toEqual({
        type: "sse",
        url: GATEWAY_URL,
        env: { CUSTOM_VAR: "keep-me" },
      });
      expect(omp.mcpServers["resin-gateway"]).toBeUndefined();
    });
  });
});
