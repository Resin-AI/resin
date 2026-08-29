import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { main } from "../../src/bin/cli.js";
import { repairState, runDiagnostics } from "../../src/commands/doctor.js";
import { initCommand } from "../../src/commands/init.js";
import {
  type SupportedHarnessId,
  resolveHarnessConfigPath,
} from "../../src/installer/harness-config.js";
import {
  HARNESS_HEALTH_CHECK_INTERVAL_MS,
  HARNESS_HEALTH_SETTINGS_FORMAT,
  type HarnessConfigFileStat,
  HarnessHealthCoordinator,
  type HarnessHealthReconciler,
  loadHarnessHealthSettings,
  loadHarnessHealthSnapshot,
  resolveHarnessHealthSettingsPath,
  resolveHarnessHealthStatePath,
  runBoundedHarnessHealthCheck,
  saveHarnessHealthSettings,
  startHarnessHealthScheduler,
} from "../../src/installer/harness-health.js";
import {
  type HarnessInstallationProbe,
  type HarnessReconcileFsBridge,
  HarnessReconciler,
  type HarnessReconciliationReport,
} from "../../src/installer/harness-reconciler.js";
import { runServiceSupervisor } from "../../src/service/manager.js";
import type { RecoveryStateTracker } from "../../src/service/recovery-state.js";

const HOME = "/home/harness-health";
const WORKSPACE = "/workspaces/resin";
const START_MS = Date.parse("2026-08-28T12:00:00.000Z");

class MtimeMemoryBridge extends InMemoryConfigFsBridge implements HarnessReconcileFsBridge {
  private readonly mtimes = new Map<string, number>();
  private nextMtime = 1;

  override async writeFile(filePath: string, content: string): Promise<void> {
    await super.writeFile(filePath, content);
    this.mtimes.set(path.normalize(filePath), this.nextMtime++);
  }

  override async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    await super.copyFile(sourcePath, destinationPath);
    this.mtimes.set(path.normalize(destinationPath), this.nextMtime++);
  }

  override async unlink(filePath: string): Promise<void> {
    await super.unlink(filePath);
    this.mtimes.delete(path.normalize(filePath));
  }

  async statFile(filePath: string): Promise<HarnessConfigFileStat | null> {
    const mtimeMs = this.mtimes.get(path.normalize(filePath));
    return mtimeMs === undefined ? null : { mtimeMs };
  }

  touch(filePath: string): void {
    this.mtimes.set(path.normalize(filePath), this.nextMtime++);
  }
}

class SettingsReadErrorBridge extends MtimeMemoryBridge {
  settingsReadError: NodeJS.ErrnoException | null = null;

  constructor(private readonly settingsPath: string) {
    super();
  }

  override async readFile(filePath: string): Promise<string | null> {
    const readError = this.settingsReadError;
    if (readError !== null && path.normalize(filePath) === path.normalize(this.settingsPath)) {
      throw readError;
    }
    return super.readFile(filePath);
  }
}

function createInstalledProbe(
  isInstalled: () => boolean,
  installedHarness: SupportedHarnessId = "claude-code",
): HarnessInstallationProbe {
  return async ({ harnessId, targetPath, customHome }) => {
    if (harnessId !== installedHarness || !isInstalled()) {
      return null;
    }
    return {
      harnessId,
      displayName: harnessId,
      version: "test",
      isInstalled: true,
      status: "ready",
      configPath: targetPath,
      homePath: customHome,
      detectedAt: "2026-08-28T12:00:00.000Z",
      metadata: {},
    };
  };
}

function createCoordinator(options: {
  bridge: MtimeMemoryBridge;
  now: () => Date;
  probeHarness?: HarnessInstallationProbe;
  autoRepair?: boolean;
  reconciler?: HarnessHealthReconciler;
}): HarnessHealthCoordinator {
  return new HarnessHealthCoordinator({
    home: HOME,
    workspacePath: WORKSPACE,
    harnesses: ["claude-code"],
    fsBridge: options.bridge,
    statFile: options.bridge.statFile.bind(options.bridge),
    now: options.now,
    probeHarness: options.probeHarness,
    autoRepair: options.autoRepair,
    reconciler: options.reconciler,
  });
}

describe("HarnessHealthCoordinator", () => {
  it("detects a harness installed after init on the next hourly check", async () => {
    const bridge = new MtimeMemoryBridge();
    let nowMs = START_MS;
    let installed = false;
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(nowMs),
      probeHarness: createInstalledProbe(() => installed),
    });

    const initial = await coordinator.run({ trigger: "init" });
    expect(initial.status).toBe("checked");
    expect(initial.snapshot?.harnesses[0]?.installed).toBe(false);

    installed = true;
    nowMs += HARNESS_HEALTH_CHECK_INTERVAL_MS + 1;
    const discovered = await coordinator.run({ trigger: "scheduled" });
    const harness = discovered.snapshot?.harnesses[0];

    expect(discovered.status).toBe("checked");
    expect(harness).toMatchObject({
      harnessId: "claude-code",
      installed: true,
      configured: true,
      status: "reconciled",
    });
    expect(harness?.recentAction?.kind).toBe("reconciled");
    expect(await bridge.exists(resolveHarnessConfigPath("claude-code", HOME))).toBe(true);
  });

  it("reconciles deleted and reverted configs immediately when presence or mtime changes", async () => {
    const bridge = new MtimeMemoryBridge();
    let nowMs = START_MS;
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(nowMs),
      probeHarness: createInstalledProbe(() => true),
    });
    const configPath = resolveHarnessConfigPath("claude-code", HOME);

    await coordinator.run({ trigger: "init" });
    await bridge.unlink(configPath);
    nowMs += 60_000;

    const afterDeletion = await coordinator.run({ trigger: "scheduled" });
    expect(afterDeletion.status).toBe("checked");
    expect(afterDeletion.snapshot?.harnesses[0]?.recentAction?.kind).toBe("reconciled");
    expect(await bridge.exists(configPath)).toBe(true);

    await bridge.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { user_server: { url: "x" } } }),
    );
    nowMs += 60_000;
    const afterRevert = await coordinator.run({ trigger: "scheduled" });
    const repairedContent = await bridge.readFile(configPath);

    expect(afterRevert.status).toBe("checked");
    expect(afterRevert.snapshot?.harnesses[0]?.status).toBe("reconciled");
    expect(repairedContent).toContain("user_server");
    expect(repairedContent).toContain("resin");
  });

  it("uses config mtime changes to bypass the hourly debounce", async () => {
    const bridge = new MtimeMemoryBridge();
    let nowMs = START_MS;
    const reconciler = new HarnessReconciler();
    const reconcileSpy = vi.spyOn(reconciler, "reconcile");
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(nowMs),
      probeHarness: createInstalledProbe(() => true),
      reconciler,
    });
    const configPath = resolveHarnessConfigPath("claude-code", HOME);

    await coordinator.run({ trigger: "init" });
    bridge.touch(configPath);
    nowMs += 1_000;
    const result = await coordinator.run({ trigger: "scheduled" });

    expect(result.status).toBe("checked");
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });

  it("debounces unchanged checks until one hour has elapsed", async () => {
    const bridge = new MtimeMemoryBridge();
    let nowMs = START_MS;
    const reconciler = new HarnessReconciler();
    const reconcileSpy = vi.spyOn(reconciler, "reconcile");
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(nowMs),
      probeHarness: createInstalledProbe(() => true),
      reconciler,
    });

    await coordinator.run({ trigger: "init" });
    nowMs += HARNESS_HEALTH_CHECK_INTERVAL_MS - 1;
    const debounced = await coordinator.run({ trigger: "scheduled" });

    expect(debounced.status).toBe("debounced");
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    nowMs += 1;
    const hourly = await coordinator.run({ trigger: "scheduled" });
    expect(hourly.status).toBe("checked");
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });

  it("treats a cached future timestamp as due after wall-clock rollback", async () => {
    const bridge = new MtimeMemoryBridge();
    let nowMs = START_MS;
    const reconciler = new HarnessReconciler();
    const reconcileSpy = vi.spyOn(reconciler, "reconcile");
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(nowMs),
      probeHarness: createInstalledProbe(() => true),
      reconciler,
    });

    await coordinator.run({ trigger: "startup" });
    nowMs -= 60_000;
    const rolledBack = await coordinator.run({ trigger: "scheduled" });

    expect(rolledBack.status).toBe("checked");
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });

  it("loads persistent auto-repair policy across processes and rechecks policy changes", async () => {
    const bridge = new MtimeMemoryBridge();
    const reconciler = new HarnessReconciler();
    const reconcileSpy = vi.spyOn(reconciler, "reconcile");
    const coordinatorOptions = {
      bridge,
      now: () => new Date(START_MS),
      probeHarness: createInstalledProbe(() => true),
      reconciler,
    };

    await saveHarnessHealthSettings(false, { home: HOME, fsBridge: bridge });
    const firstProcess = createCoordinator(coordinatorOptions);
    const optedOut = await firstProcess.run({ trigger: "startup", force: true });
    const secondProcess = createCoordinator(coordinatorOptions);
    const unchanged = await secondProcess.run({ trigger: "startup" });

    expect(optedOut.snapshot?.autoRepair).toBe(false);
    expect(unchanged.status).toBe("debounced");
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy.mock.calls[0]?.[0]?.autoRepair).toBe(false);

    await saveHarnessHealthSettings(true, { home: HOME, fsBridge: bridge });
    const thirdProcess = createCoordinator(coordinatorOptions);
    const enabled = await thirdProcess.run({ trigger: "startup" });

    expect(enabled.status).toBe("checked");
    expect(enabled.snapshot?.autoRepair).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    expect(reconcileSpy.mock.calls[1]?.[0]?.autoRepair).toBe(true);
    expect((await loadHarnessHealthSettings({ home: HOME, fsBridge: bridge })).autoRepair).toBe(
      true,
    );
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "schema-invalid JSON",
      JSON.stringify({
        format: HARNESS_HEALTH_SETTINGS_FORMAT,
        autoRepair: false,
        unexpected: true,
      }),
    ],
  ])(
    "fails closed across processes without writing harness config for %s settings",
    async (_case, invalidSettings) => {
      const bridge = new MtimeMemoryBridge();
      const coordinatorOptions = {
        bridge,
        now: () => new Date(START_MS),
        probeHarness: createInstalledProbe(() => true),
      };
      const settingsPath = resolveHarnessHealthSettingsPath(HOME);
      const configPath = resolveHarnessConfigPath("claude-code", HOME);

      await saveHarnessHealthSettings(false, { home: HOME, fsBridge: bridge });
      const firstProcess = createCoordinator(coordinatorOptions);
      const optedOut = await firstProcess.run({ trigger: "startup", force: true });
      expect(optedOut.snapshot?.autoRepair).toBe(false);

      await bridge.writeFile(settingsPath, invalidSettings);
      const writeSpy = vi.spyOn(bridge, "writeFile");
      const secondProcess = createCoordinator(coordinatorOptions);
      const failedClosed = await secondProcess.run({ trigger: "startup" });

      expect(failedClosed.status).toBe("checked");
      expect(failedClosed.snapshot).toMatchObject({
        autoRepair: false,
        settingsDiagnostic: "settings_invalid",
        hasDrift: true,
      });
      expect(failedClosed.snapshot?.harnesses[0]).toMatchObject({
        installed: true,
        configured: false,
        condition: "missing",
      });
      expect(await bridge.readFile(settingsPath)).toBe(invalidSettings);
      expect(await bridge.exists(configPath)).toBe(false);
      expect(
        writeSpy.mock.calls.filter(
          ([writtenPath]) => path.normalize(writtenPath) === path.normalize(configPath),
        ),
      ).toHaveLength(0);
      expect(
        (await loadHarnessHealthSnapshot({ home: HOME, fsBridge: bridge }))?.settingsDiagnostic,
      ).toBe("settings_invalid");
    },
  );

  it("fails closed across processes when an opt-out becomes unreadable", async () => {
    const settingsPath = resolveHarnessHealthSettingsPath(HOME);
    const bridge = new SettingsReadErrorBridge(settingsPath);
    const coordinatorOptions = {
      bridge,
      now: () => new Date(START_MS),
      probeHarness: createInstalledProbe(() => true),
    };
    const configPath = resolveHarnessConfigPath("claude-code", HOME);

    await saveHarnessHealthSettings(false, { home: HOME, fsBridge: bridge });
    const originalSettings = await bridge.readFile(settingsPath);
    const firstProcess = createCoordinator(coordinatorOptions);
    const optedOut = await firstProcess.run({ trigger: "startup", force: true });
    expect(optedOut.snapshot?.autoRepair).toBe(false);

    const permissionError = new Error(
      `EACCES: permission denied, open '${settingsPath}'`,
    ) as NodeJS.ErrnoException;
    permissionError.code = "EACCES";
    bridge.settingsReadError = permissionError;
    const writeSpy = vi.spyOn(bridge, "writeFile");
    const secondProcess = createCoordinator(coordinatorOptions);
    const failedClosed = await secondProcess.run({ trigger: "startup" });

    expect(failedClosed.status).toBe("checked");
    expect(failedClosed.snapshot).toMatchObject({
      autoRepair: false,
      settingsDiagnostic: "settings_unreadable",
      hasDrift: true,
    });
    expect(await bridge.exists(configPath)).toBe(false);
    expect(
      writeSpy.mock.calls.filter(
        ([writtenPath]) => path.normalize(writtenPath) === path.normalize(configPath),
      ),
    ).toHaveLength(0);

    const persisted = await loadHarnessHealthSnapshot({ home: HOME, fsBridge: bridge });
    expect(persisted?.settingsDiagnostic).toBe("settings_unreadable");
    expect(JSON.stringify(persisted)).not.toContain("permission denied");
    expect(JSON.stringify(persisted)).not.toContain(settingsPath);

    bridge.settingsReadError = null;
    expect(await bridge.readFile(settingsPath)).toBe(originalSettings);
  });

  it.runIf(process.platform !== "win32")(
    "rejects policy writes through symlinks and surfaces fail-closed doctor remediation",
    async () => {
      const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resin-harness-health-"));
      const home = path.join(temporaryRoot, "home");
      const workspacePath = path.join(temporaryRoot, "workspace");
      const settingsPath = resolveHarnessHealthSettingsPath(home);
      const linkedSourcePath = path.join(temporaryRoot, "linked-settings.json");
      const linkedSettings = `${JSON.stringify(
        {
          format: HARNESS_HEALTH_SETTINGS_FORMAT,
          autoRepair: true,
        },
        null,
        2,
      )}\n`;

      try {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.writeFile(linkedSourcePath, linkedSettings);
        await fs.symlink(linkedSourcePath, settingsPath);
        await expect(saveHarnessHealthSettings(false, { home })).rejects.toThrow(
          "Harness health settings path is unsafe",
        );
        expect((await fs.lstat(settingsPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(linkedSourcePath, "utf8")).toBe(linkedSettings);

        const coordinator = new HarnessHealthCoordinator({
          home,
          workspacePath,
          harnesses: ["claude-code"],
          probeHarness: createInstalledProbe(() => true),
          now: () => new Date(START_MS),
        });
        const failedClosed = await coordinator.run({
          trigger: "scheduled",
          force: true,
        });
        const configPath = resolveHarnessConfigPath("claude-code", home);

        expect(failedClosed.status).toBe("checked");
        expect(failedClosed.snapshot).toMatchObject({
          autoRepair: false,
          settingsDiagnostic: "settings_unsafe",
          hasDrift: true,
        });
        expect((await loadHarnessHealthSnapshot({ home }))?.settingsDiagnostic).toBe(
          "settings_unsafe",
        );
        const diagnostics = await runDiagnostics({
          home,
          harnessHealthCoordinator: coordinator,
        });
        const policyDiagnostic = diagnostics.find(
          (diagnostic) => diagnostic.id === "harness_health_settings",
        );
        expect(policyDiagnostic).toMatchObject({
          status: "warn",
          message: expect.stringContaining("failed closed"),
          remediation: expect.stringContaining("Remove the link"),
          fixable: false,
        });
        expect(JSON.stringify(policyDiagnostic)).not.toContain(settingsPath);
        expect(JSON.stringify(policyDiagnostic)).not.toContain(linkedSourcePath);
        expect((await fs.lstat(settingsPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(linkedSourcePath, "utf8")).toBe(linkedSettings);
        await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it("honors autoRepair false while persisting detected drift", async () => {
    const bridge = new MtimeMemoryBridge();
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(START_MS),
      probeHarness: createInstalledProbe(() => true),
      autoRepair: false,
    });
    const configPath = resolveHarnessConfigPath("claude-code", HOME);

    const result = await coordinator.run({ trigger: "scheduled" });

    expect(result.snapshot?.autoRepair).toBe(false);
    expect(result.snapshot?.harnesses[0]).toMatchObject({
      installed: true,
      configured: false,
      status: "unregistered",
      condition: "missing",
    });
    expect(await bridge.exists(configPath)).toBe(false);
  });

  it("contains reconciliation failures without rejecting the caller", async () => {
    const bridge = new MtimeMemoryBridge();
    const reconciler: HarnessHealthReconciler = {
      async reconcile(): Promise<HarnessReconciliationReport> {
        throw new Error("private-token=/home/alice/.config/secret");
      },
    };
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(START_MS),
      reconciler,
    });

    const result = await coordinator.run({ trigger: "scheduled", force: true });
    const rawState = await bridge.readFile(resolveHarnessHealthStatePath(HOME));

    expect(result.status).toBe("failed");
    expect(result.snapshot?.lastFailure?.code).toBe("check_failed");
    expect(rawState ?? "").not.toContain("private-token");
    expect(rawState ?? "").not.toContain("/home/alice");
  });

  it("persists only sanitized per-harness status and recent actions", async () => {
    const bridge = new MtimeMemoryBridge();
    const reconciler: HarnessHealthReconciler = {
      async reconcile(): Promise<HarnessReconciliationReport> {
        return {
          success: false,
          autoRepair: true,
          checkedAt: "2026-08-28T12:00:00.000Z",
          hasDrift: true,
          results: [
            {
              harnessId: "claude-code",
              displayName: "secret display name",
              installed: true,
              targetPath: "/home/alice/private-config.json",
              status: "drift_detected",
              condition: "drifted",
              configured: false,
              changed: false,
              diagnostic: "authorization=secret-value",
              error: "failed near /home/alice/private-config.json",
            },
          ],
        };
      },
    };
    const coordinator = createCoordinator({
      bridge,
      now: () => new Date(START_MS),
      reconciler,
    });

    await coordinator.run({ trigger: "scheduled", force: true });
    const statePath = resolveHarnessHealthStatePath(HOME);
    const rawState = await bridge.readFile(statePath);
    const snapshot = await loadHarnessHealthSnapshot({ fsBridge: bridge, statePath });

    expect(snapshot?.harnesses[0]).toMatchObject({
      harnessId: "claude-code",
      displayName: "Claude Code CLI",
      status: "drift_detected",
      recentAction: { kind: "repair_failed" },
    });
    expect(rawState ?? "").not.toContain("secret-value");
    expect(rawState ?? "").not.toContain("/home/alice");
    expect(rawState ?? "").not.toContain("targetPath");
    expect(rawState ?? "").not.toContain("diagnostic");
    expect(rawState ?? "").not.toContain('"error"');
  });
});

describe("harness health production triggers", () => {
  it("bounds a stalled health check and schedules startup plus hourly runs", async () => {
    const stalledRunner = {
      run: vi.fn(() => new Promise<never>(() => {})),
    };
    const bounded = await runBoundedHarnessHealthCheck({
      runner: stalledRunner,
      trigger: "startup",
      deadlineMs: 5,
    });
    expect(bounded.status).toBe("timed_out");

    vi.useFakeTimers();
    try {
      const runner = {
        run: vi.fn().mockResolvedValue({ status: "failed" as const, snapshot: null }),
      };
      const scheduler = startHarnessHealthScheduler({
        runner,
        intervalMs: 1_000,
        deadlineMs: 100,
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(runner.run).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ trigger: "startup" }),
        );

        await vi.advanceTimersByTimeAsync(1_000);
        expect(runner.run).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ trigger: "scheduled" }),
        );
      } finally {
        scheduler.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps scoped init completion independent from a stalled post-init check", async () => {
    const bridge = new MtimeMemoryBridge();
    const run = vi.fn(() => new Promise<never>(() => {}));
    const exitCode = await initCommand(
      [
        "--local-only",
        "--non-interactive",
        "--auto-approve",
        "--home",
        HOME,
        "--workspace",
        WORKSPACE,
        "--harness",
        "claude-code",
        "--no-auto-repair",
      ],
      {
        customFsBridge: bridge,
        releaseMode: "local-test",
        setupService: false,
        autoStartService: false,
        harnessHealthCoordinator: { run },
        harnessHealthDeadlineMs: 5,
        logger: () => {},
      },
    );

    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "init",
        force: true,
        autoRepair: false,
        harnesses: ["claude-code"],
      }),
    );
    expect((await loadHarnessHealthSettings({ home: HOME, fsBridge: bridge })).autoRepair).toBe(
      false,
    );
  });

  it("invokes bounded startup health from the real CLI main entrypoint", async () => {
    const run = vi.fn(() => new Promise<never>(() => {}));
    const stdout = vi.fn();
    const exitCode = await main(["version"], {
      isInitialized: true,
      harnessHealthRunner: { run },
      harnessHealthDeadlineMs: 5,
      stdout: { write: stdout },
    });

    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ trigger: "startup" }));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("resin v"));
  });

  it("starts and stops the hourly scheduler with the resident supervisor", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const stop = vi.fn();
    const schedulerFactory = vi.fn(() => ({ stop }));
    const state = {
      version: 1 as const,
      status: "HEALTHY" as const,
      restartCount: 0,
      crashTimestamps: [],
    };
    const tracker = {
      getState: vi.fn().mockResolvedValue(state),
    } as unknown as RecoveryStateTracker;
    const resinHome = path.join(HOME, ".resin");

    const result = await runServiceSupervisor({
      command: "unused",
      resinHome,
      tracker,
      signal: shutdown.signal,
      harnessHealthSchedulerFactory: schedulerFactory,
    });

    expect(result.reason).toBe("SHUTDOWN");
    expect(schedulerFactory).toHaveBeenCalledWith({ resinHome });
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("doctor repair harness integration", () => {
  it("repairs harness registration through HarnessHealthCoordinator", async () => {
    const bridge = new MtimeMemoryBridge();
    const coordinator = new HarnessHealthCoordinator({
      home: HOME,
      workspacePath: WORKSPACE,
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      fsBridge: bridge,
      statFile: bridge.statFile.bind(bridge),
      now: () => new Date(START_MS),
    });
    const configPath = resolveHarnessConfigPath("claude-code", HOME);

    const actions = await repairState({
      home: HOME,
      fsBridge: bridge,
      harnessHealthCoordinator: coordinator,
      safetyCertification: {
        probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
      },
    });

    expect(actions).toContain("Reconciled Resin MCP registration for Claude Code CLI");
    expect(await bridge.readFile(configPath)).toContain("resin");
  });
});
