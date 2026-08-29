import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { DaemonConfigSchema, loadDaemonConfig, resolvePaths } from "@resin/observer";
import { afterEach, describe, expect, it } from "vitest";
import {
  InstallationError,
  ResinInstaller,
  resolveDaemonPaths,
} from "../../src/installer/installer.js";

const testHomes: string[] = [];

function createTempTestHome(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resin-installer-config-test-"));
  testHomes.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const home of testHomes.splice(0)) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
});

describe("Daemon Configuration Persistence & Telemetry Integration", () => {
  it("exports resolveDaemonPaths compatible with observer path resolution", () => {
    expect(resolveDaemonPaths).toBe(resolvePaths);
  });

  it("persists 0600 daemon config with telemetry enabled and safe metadata defaults on fresh install", async () => {
    const home = createTempTestHome();
    const resinHome = path.join(home, ".resin");
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: false,
      targetVersion: "1.2.3",
      gatewayUrl: "https://custom-gateway.resin.sh",
    });

    expect(summary.success).toBe(true);

    const daemonPaths = resolvePaths({ home, resinHome });
    const configFilePath = daemonPaths.configFile;
    expect(fs.existsSync(configFilePath)).toBe(true);

    // Verify 0600 mode on disk
    const stats = fs.statSync(configFilePath);
    if (process.platform !== "win32") {
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Verify raw content and parsing
    const rawContent = fs.readFileSync(configFilePath, "utf8");
    const parsedJson = JSON.parse(rawContent);

    expect(parsedJson.version).toBe("1.2.3");
    expect(parsedJson.cloudUrl).toBe("https://custom-gateway.resin.sh");
    expect(parsedJson.telemetryEnabled).toBe(true);
    expect(parsedJson.storageDir).toBe(daemonPaths.dataDir);

    // Verify safe metadata-only defaults and absence of raw consent
    expect(parsedJson).not.toHaveProperty("rawTranscriptConsent");
    expect(parsedJson).not.toHaveProperty("transcriptConsent");
    expect(parsedJson).not.toHaveProperty("rawConsent");

    // Verify daemon config can be loaded by observer loadDaemonConfig
    const loaded = loadDaemonConfig({ configPath: configFilePath });
    expect(loaded.version).toBe("1.2.3");
    expect(loaded.cloudUrl).toBe("https://custom-gateway.resin.sh");
    expect(loaded.telemetryEnabled).toBe(true);
    expect(loaded.storageDir).toBe(daemonPaths.dataDir);
  });

  it("persists telemetryEnabled=false when privacy config disables telemetry", async () => {
    const home = createTempTestHome();
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const privacyFile = path.join(workspace, "privacy.json");
    fs.writeFileSync(
      privacyFile,
      JSON.stringify({
        telemetryEnabled: false,
        cloudSyncEnabled: false,
        localOnly: true,
      }),
    );

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      privacyConfig: privacyFile,
      nonInteractive: true,
      autoApprove: true,
      setupService: false,
    });

    expect(summary.success).toBe(true);
    expect(summary.authPlan.privacy.telemetryEnabled).toBe(false);

    const daemonPaths = resolvePaths({ home, resinHome: path.join(home, ".resin") });
    const loaded = loadDaemonConfig({ configPath: daemonPaths.configFile });
    expect(loaded.telemetryEnabled).toBe(false);
  });

  it("uses cloudUrl from pairing mutation when paired", async () => {
    const home = createTempTestHome();
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: false,
      pairing: async () => ({
        paired: true,
        localOnly: false,
        cloudUrl: "https://paired-cloud.resin.internal",
        deviceId: "dev_123",
      }),
    });

    expect(summary.success).toBe(true);
    const daemonPaths = resolvePaths({ home, resinHome: path.join(home, ".resin") });
    const loaded = loadDaemonConfig({ configPath: daemonPaths.configFile });
    expect(loaded.cloudUrl).toBe("https://paired-cloud.resin.internal");
  });

  it("rolls back and removes config.json when installation fails on fresh install", async () => {
    const home = createTempTestHome();
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const daemonPaths = resolvePaths({ home, resinHome: path.join(home, ".resin") });
    expect(fs.existsSync(daemonPaths.configFile)).toBe(false);

    // Fail during verify step by enabling service with failing runner
    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
        autoApprove: true,
        setupService: true,
        serviceRunner: {
          run: async () => {
            return { stdout: "", stderr: "mock service failure", exitCode: 1 };
          },
        },
      }),
    ).rejects.toThrow(InstallationError);

    // After rollback, config.json must be unlinked
    expect(fs.existsSync(daemonPaths.configFile)).toBe(false);
  });

  it("rolls back and restores previous config.json when pre-existing config was present", async () => {
    const home = createTempTestHome();
    const resinHome = path.join(home, ".resin");
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const daemonPaths = resolvePaths({ home, resinHome });
    fs.mkdirSync(daemonPaths.configDir, { recursive: true });

    const originalConfig = {
      version: "0.0.1-prev",
      cloudUrl: "https://previous.resin.sh",
      telemetryEnabled: false,
      storageDir: "/prev/storage",
    };
    fs.writeFileSync(daemonPaths.configFile, JSON.stringify(originalConfig, null, 2), {
      mode: 0o600,
    });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    // Run installation that fails in verify step
    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
        autoApprove: true,
        setupService: true,
        serviceRunner: {
          run: async () => {
            return { stdout: "", stderr: "service start error", exitCode: 1 };
          },
        },
      }),
    ).rejects.toThrow(InstallationError);

    // After rollback, original config must be restored
    expect(fs.existsSync(daemonPaths.configFile)).toBe(true);
    const restoredContent = JSON.parse(fs.readFileSync(daemonPaths.configFile, "utf8"));
    expect(restoredContent.version).toBe("0.0.1-prev");
    expect(restoredContent.cloudUrl).toBe("https://previous.resin.sh");
    expect(restoredContent.telemetryEnabled).toBe(false);
  });

  it("does not mutate filesystem or write config during dry-run", async () => {
    const home = createTempTestHome();
    const workspace = path.join(home, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const installer = new ResinInstaller({
      logger: () => {},
    });

    const summary = await installer.run({
      dryRun: true,
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: false,
    });

    expect(summary.success).toBe(true);
    expect(summary.dryRun).toBe(true);

    const daemonPaths = resolvePaths({ home, resinHome: path.join(home, ".resin") });
    expect(fs.existsSync(daemonPaths.configFile)).toBe(false);
  });
});
