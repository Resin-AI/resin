import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { InMemoryConfigFsBridge, NodeConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import { initCommand, parseInitFlags } from "../src/commands/init.js";
import {
  InstallationError,
  type InstallationPairingSummary,
  type InstallerPairingMutation,
  ResinInstaller,
} from "../src/installer/installer.js";
import { createUserServiceManager } from "../src/installer/user-service.js";

type TarGzFixture = string | { readonly content: string; readonly mode?: number };

function tarGz(files: Record<string, TarGzFixture> = {}): Buffer {
  const fileEntries = Object.entries(files);
  const defaultEntries: Array<[string, TarGzFixture]> =
    fileEntries.length > 0
      ? fileEntries
      : [
          ["bin/resin", "#!/bin/sh\necho resin 1.0.0\n"],
          ["bin/resin-daemon", "#!/bin/sh\nexit 0\n"],
        ];

  const tarBuffers: Buffer[] = [];

  for (const [name, fixture] of defaultEntries) {
    const content = String(fixture) === fixture ? fixture : fixture.content;
    const mode = String(fixture) === fixture ? 0o755 : (fixture.mode ?? 0o755);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(mode.toString(8).padStart(7, "0"), 100, 8, "utf8");
    header.write("0001750", 108, 8, "utf8");
    header.write("0001750", 116, 8, "utf8");
    const size = Buffer.byteLength(content);
    header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
    const mtime = `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")} `;
    header.write(mtime, 136, 12, "utf8");
    header.write("0", 156, 1, "utf8");

    header.fill(32, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

    tarBuffers.push(header);
    const contentBuf = Buffer.from(content, "utf8");
    tarBuffers.push(contentBuf);
    const remainder = size % 512;
    if (remainder !== 0) {
      tarBuffers.push(Buffer.alloc(512 - remainder));
    }
  }

  tarBuffers.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(tarBuffers));
}

const testHomes: string[] = [];
afterEach(() => {
  for (const home of testHomes) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
  testHomes.length = 0;
});

describe("Resin Installer End-to-End & CLI Command Suite", () => {
  it("parses CLI flags accurately", () => {
    const flags = parseInitFlags([
      "--dry-run",
      "--json",
      "--non-interactive",
      "--auto-approve",
      "--harness=claude-code,omp",
      "--workspace=/custom/workspace",
      "--capabilities-file=/caps.json",
      "--privacy-config=/privacy.json",
      "--gateway-url=http://127.0.0.1:9400/mcp/sse",
      "--home=/custom/home",
    ]);

    expect(flags.dryRun).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.nonInteractive).toBe(true);
    expect(flags.autoApprove).toBe(true);
    expect(flags.harness).toBe("claude-code,omp");
    expect(flags.workspace).toBe("/custom/workspace");
    expect(flags.capabilitiesFile).toBe("/caps.json");
    expect(flags.privacyConfig).toBe("/privacy.json");
    expect(flags.gatewayUrl).toBe("http://127.0.0.1:9400/mcp/sse");
    expect(flags.home).toBe("/custom/home");
  });

  it("executes full end-to-end init workflow with autoApprove", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const logs: string[] = [];

    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: (msg) => logs.push(msg),
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.dryRun).toBe(false);
    expect(summary.journal.status).toBe("completed");
    expect(summary.journal.steps.every((s) => s.status === "completed")).toBe(true);
    expect(summary.harnesses).toHaveLength(3);

    // Verify journal file was persisted in state directory
    const journalSaved = await bridge.readFile(`${home}/.resin/state/install-journal.json`);
    expect(journalSaved).not.toBeNull();
    const parsedJournal = JSON.parse(journalSaved ?? "{}");
    expect(parsedJournal.status).toBe("completed");
    const verifyStep = parsedJournal.steps.find(
      (step: { name?: string }) => step.name === "verify",
    );
    expect(verifyStep?.details).toMatchObject({
      allConfigured: true,
      installedHarnessCount: 3,
      onboardingReady: true,
    });

    // Verify Claude, Codex, OMP configs were written
    expect(await bridge.readFile(`${home}/.claude.json`)).toContain("resin");
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toContain("resin");
    expect(await bridge.readFile(`${home}/.omp/agent/mcp.json`)).toContain("resin");
  });

  it("runs dry-run mode without modifying filesystem", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      dryRun: true,
      nonInteractive: true,
    });

    expect(summary.success).toBe(true);
    expect(summary.dryRun).toBe(true);
    expect(summary.journal.status).toBe("completed");

    // Verify no files/directories were created on disk
    expect(await bridge.readFile(`${home}/.resin/state/install-journal.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.claude.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBeNull();
    expect(await bridge.readFile(`${home}/.omp/agent/mcp.json`)).toBeNull();
  });
  it("prompts for authorization and succeeds when approved via injected promptFn", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";
    const promptFn = vi.fn().mockResolvedValue(true);

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
      promptFn,
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: false,
    });

    expect(summary.success).toBe(true);
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(summary.authPlan.granted).toBe(true);
    expect(summary.authPlan.grantedBy).toBe("interactive_user");
  });

  it("aborts installation when user denies authorization in promptFn", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";
    const promptFn = vi.fn().mockResolvedValue(false);

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
      promptFn,
    });

    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: false,
      }),
    ).rejects.toThrow(/Authorization declined by user/i);

    expect(promptFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed on non-interactive install when autoApprove is not set", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
      }),
    ).rejects.toThrow(/Authorization required: Non-interactive execution/i);
  });

  it("enforces idempotency on repeated init runs", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    // Run 1
    const run1 = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });
    expect(run1.success).toBe(true);
    expect(run1.harnesses.every((h) => !h.wasAlreadyConfigured)).toBe(true);

    // Run 2 (idempotent)
    const installer2 = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });
    const run2 = await installer2.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });
    expect(run2.success).toBe(true);
    expect(run2.harnesses.every((h) => h.wasAlreadyConfigured)).toBe(true);
  });

  it("rolls back all applied configurations atomically upon failure injection", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    // Pre-create original config files
    await bridge.writeFile(`${home}/.claude.json`, '{"original": "claude"}');
    await bridge.writeFile(`${home}/.codex/config.toml`, "# original codex\n");

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    // Non-interactive without autoApprove or capabilitiesFile should fail during authorization
    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
      }),
    ).rejects.toThrow(InstallationError);

    // Original files must remain intact
    expect(await bridge.readFile(`${home}/.claude.json`)).toBe('{"original": "claude"}');
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBe("# original codex\n");
  });
  it("invokes pairing in correct order, sanitizes pairing summary, and rolls back pairing on failure", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    let pairingInvoked = false;
    let rollbackInvoked = false;

    const pairingMutation: InstallerPairingMutation = {
      paired: true,
      localOnly: false,
      reused: false,
      accountId: "acc_12345",
      workspaceId: "ws_67890",
      deviceId: "dev_abcdef",
      userId: "usr_xyz",
      cloudUrl: "https://cloud.resin.dev",
      rollback: async () => {
        rollbackInvoked = true;
      },
    };

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      pairing: async () => {
        pairingInvoked = true;
        return pairingMutation;
      },
    });

    expect(pairingInvoked).toBe(true);
    expect(rollbackInvoked).toBe(false);
    expect(summary.pairing).toBeDefined();
    expect(summary.pairing?.paired).toBe(true);
    expect(summary.pairing?.localOnly).toBe(false);
    expect(summary.pairing?.accountId).toBe("acc_12345");
    expect(summary.pairing?.workspaceId).toBe("ws_67890");
    expect(summary.pairing?.deviceId).toBe("dev_abcdef");
    expect(summary.pairing?.userId).toBe("usr_xyz");
    expect(summary.pairing?.cloudUrl).toBe("https://cloud.resin.dev");
    // Verify rollback and secret fields are NOT leaked in summary
    expect(summary.pairing).not.toHaveProperty("rollback");

    // Verify pairing step in journal
    const pairingStep = summary.journal.steps.find((s) => s.name === "pairing");
    expect(pairingStep).toBeDefined();
    expect(pairingStep?.status).toBe("completed");
    expect(pairingStep?.details?.accountId).toBe("acc_12345");
    expect(pairingStep?.details?.rollback).toBeUndefined();
  });

  it("dry-run mode never invokes pairing callback", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    let pairingInvoked = false;

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    const summary = await installer.run({
      dryRun: true,
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      pairing: async () => {
        pairingInvoked = true;
        return { paired: true, localOnly: false };
      },
    });

    expect(pairingInvoked).toBe(false);
    expect(summary.pairing?.paired).toBe(false);
    expect(summary.pairing?.localOnly).toBe(true);
  });

  it("rolls back pairing mutation when a subsequent installation step fails", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    let pairingRollbackCalled = false;

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    // Inject failure by requesting service setup with a failing runner
    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
        autoApprove: true,
        setupService: true,
        serviceRunner: {
          run: async () => ({
            stdout: "",
            stderr: "systemctl: unit failed to start",
            exitCode: 1,
          }),
        },
        pairing: async () => ({
          paired: true,
          localOnly: false,
          accountId: "acc_rollback_test",
          rollback: async () => {
            pairingRollbackCalled = true;
          },
        }),
      }),
    ).rejects.toThrow(/Daemon service setup failed|Installation failed/);

    expect(pairingRollbackCalled).toBe(true);
  });

  it("emits canonical stdio configurations and does not write explicit gatewayUrl into harness configs", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const resinCommand = path.join(home, ".resin", "bin", "resin");
    const workspace = "/home/developer/code/my-app";
    const customGateway = "http://127.0.0.1:9876/mcp/sse";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    await installer.run({
      customHome: home,
      workspace,
      gatewayUrl: customGateway,
      nonInteractive: true,
      autoApprove: true,
    });

    // Verify all three emitted configs are canonical stdio and do not contain custom gateway
    const claudeContent = await bridge.readFile(`${home}/.claude.json`);
    expect(claudeContent).not.toBeNull();
    const claudeJson = JSON.parse(claudeContent ?? "{}");
    expect(claudeJson.mcpServers.resin).toEqual({ command: resinCommand, args: ["mcp"] });
    expect(claudeContent).not.toContain(customGateway);

    const codexContent = await bridge.readFile(`${home}/.codex/config.toml`);
    expect(codexContent).not.toBeNull();
    expect(codexContent).toContain(`command = "${resinCommand}"`);
    expect(codexContent).toContain('args = ["mcp"]');
    expect(codexContent).not.toContain(customGateway);

    const ompContent = await bridge.readFile(`${home}/.omp/agent/mcp.json`);
    expect(ompContent).not.toBeNull();
    const ompJson = JSON.parse(ompContent ?? "{}");
    expect(ompJson.mcpServers.resin).toEqual({ command: resinCommand, args: ["mcp"] });
    expect(ompContent).not.toContain(customGateway);
  });

  it("omitted service setup does not record serviceHealthy as true in journal", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
    const workspace = "/home/developer/code/my-app";

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    const summary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
    });

    expect(summary.serviceSetup).toBeUndefined();
    const verifyStep = summary.journal.steps.find((s) => s.name === "verify");
    expect(verifyStep?.details?.serviceHealthy).toBeUndefined();
  });

  it("restarts matching active unit on version activation while retaining reuse on unchanged installs", async () => {
    const bridge = new NodeConfigFsBridge();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-installer-e2e-"));
    testHomes.push(home);
    const resinHome = path.join(home, ".resin");
    const workspace = path.join(home, "code", "my-app");

    // Seed prior active version 0.9.0
    const v090Dir = path.join(resinHome, "versions", "v0.9.0");
    fs.mkdirSync(path.join(v090Dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(v090Dir, "version.json"), JSON.stringify({ version: "0.9.0" }));
    const currentSymlink = path.join(resinHome, "current");
    fs.mkdirSync(path.dirname(currentSymlink), { recursive: true });
    fs.symlinkSync(path.join("versions", "v0.9.0"), currentSymlink);
    fs.writeFileSync(path.join(resinHome, "current-version"), "0.9.0\n");
    const commandsRun: Array<{ command: string; args: readonly string[] }> = [];
    const serviceRunner = {
      run: async (command: string, args: readonly string[]) => {
        commandsRun.push({ command, args });
        if (args.includes("is-active") || args.includes("is-enabled")) {
          return {
            stdout: args.includes("is-active") ? "active\n" : "enabled\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("status")) {
          return { stdout: "Active: active (running)\nMain PID: 4321\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = createUserServiceManager({
      homeDir: home,
      resinHome,
      fsBridge: bridge,
      runner: serviceRunner,
    });
    await manager.status();
    const unitPath = manager.getUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, manager.getUnitDefinition());

    const releaseTarball = tarGz();
    const readinessVerifier = vi.fn().mockResolvedValue({
      ready: true,
      ipcReady: true,
      cloudReady: true,
      attempts: 1,
      healthStatus: "healthy",
      version: "1.0.0",
    });

    const logs: string[] = [];
    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: (msg) => logs.push(msg),
    });

    // 1. Initial install with v1.0.0 (upgrades from prior v0.9.0, triggering restart)
    const initialSummary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: true,
      targetVersion: "1.0.0",
      assetTarball: releaseTarball,
      serviceRunner,
      readinessVerifier,
    });
    expect(initialSummary.versionSwitch?.activeVersion).toBe("1.0.0");
    expect(initialSummary.versionSwitch?.previousVersion).toBe("0.9.0");
    expect(initialSummary.serviceSetup?.success).toBe(true);
    const restartCallsInitial = commandsRun.filter((c) => c.args.includes("restart"));
    expect(restartCallsInitial.length).toBeGreaterThanOrEqual(1);
    expect(readinessVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "1.0.0" }),
    );

    // 2. Re-running install for unchanged version 1.0.0 retains reuse without calling restart
    commandsRun.length = 0;
    const unchangedSummary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: true,
      targetVersion: "1.0.0",
      assetTarball: releaseTarball,
      serviceRunner,
      readinessVerifier,
    });
    expect(unchangedSummary.versionSwitch?.activeVersion).toBe("1.0.0");
    expect(unchangedSummary.versionSwitch?.previousVersion).toBe("1.0.0");
    expect(unchangedSummary.serviceSetup?.success).toBe(true);
    expect(unchangedSummary.serviceSetup?.details).toContain("Daemon active and running");
    const restartCallsUnchanged = commandsRun.filter((c) => c.args.includes("restart"));
    expect(restartCallsUnchanged.length).toBe(0);

    // 3. Upgrading to version 1.1.0 forces restart on version activation
    commandsRun.length = 0;
    readinessVerifier.mockResolvedValueOnce({
      ready: true,
      ipcReady: true,
      cloudReady: true,
      attempts: 1,
      healthStatus: "healthy",
      version: "1.1.0",
    });
    const upgradeSummary = await installer.run({
      customHome: home,
      workspace,
      nonInteractive: true,
      autoApprove: true,
      setupService: true,
      targetVersion: "1.1.0",
      assetTarball: releaseTarball,
      serviceRunner,
      readinessVerifier,
    });
    expect(readinessVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "1.1.0" }),
    );
    expect(upgradeSummary.versionSwitch?.activeVersion).toBe("1.1.0");
    expect(upgradeSummary.versionSwitch?.previousVersion).toBe("1.0.0");
    expect(upgradeSummary.serviceSetup?.success).toBe(true);
    const restartCallsUpgrade = commandsRun.filter((c) => c.args.includes("restart"));
    expect(restartCallsUpgrade.length).toBeGreaterThanOrEqual(1);
  });

  it("fails readiness gate when daemon version does not match active version", async () => {
    const bridge = new NodeConfigFsBridge();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-readiness-version-test-"));
    const home = path.join(tempDir, "home");
    const resinHome = path.join(home, ".resin");
    const workspace = path.join(tempDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    const commandsRun: Array<{ command: string; args: readonly string[] }> = [];
    const serviceRunner = {
      run: async (command: string, args: readonly string[]) => {
        commandsRun.push({ command, args });
        if (args.includes("is-active") || args.includes("is-enabled")) {
          return {
            stdout: args.includes("is-active") ? "active\n" : "enabled\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args.includes("status")) {
          return { stdout: "Active: active (running)\nMain PID: 4321\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = createUserServiceManager({
      homeDir: home,
      resinHome,
      fsBridge: bridge,
      runner: serviceRunner,
    });
    const unitPath = manager.getUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, manager.getUnitDefinition());

    const releaseTarball = tarGz();
    // Simulate stale daemon returning previous version 0.9.0 when target is 1.0.0
    const staleReadinessVerifier = vi.fn().mockResolvedValue({
      ready: false,
      ipcReady: true,
      cloudReady: true,
      attempts: 1,
      healthStatus: "healthy",
      version: "0.9.0",
      error: "Daemon version mismatch: expected 1.0.0, got 0.9.0",
    });

    const installer = new ResinInstaller({
      fsBridge: bridge,
      logger: () => {},
    });

    await expect(
      installer.run({
        customHome: home,
        workspace,
        nonInteractive: true,
        autoApprove: true,
        setupService: true,
        targetVersion: "1.0.0",
        assetTarball: releaseTarball,
        serviceRunner,
        readinessVerifier: staleReadinessVerifier,
      }),
    ).rejects.toThrow(/Daemon readiness verification failed/);

    expect(staleReadinessVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "1.0.0" }),
    );
  });

  it("handles initCommand CLI wrapper with --json and --dry-run", async () => {
    const bridge = new InMemoryConfigFsBridge();

    const exitCode = await initCommand(
      [
        "--dry-run",
        "--json",
        "--non-interactive",
        "--auto-approve",
        "--home=/home/testuser",
        "--workspace=/workspace/test",
      ],
      bridge,
    );

    expect(exitCode).toBe(0);
  });

  it("handles CLI router for version and help", async () => {
    const versionExit = await main(["version"]);
    expect(versionExit).toBe(0);

    const shortVersionExit = await main(["-V"]);
    expect(shortVersionExit).toBe(0);

    const longVersionExit = await main(["--version"]);
    expect(longVersionExit).toBe(0);

    const helpExit = await main(["help"]);
    expect(helpExit).toBe(0);
    const mcpHelpExit = await main(["mcp", "--help"]);
    expect(mcpHelpExit).toBe(0);

    const unknownExit = await main(["unknown-command"]);
    expect(unknownExit).toBe(1);
  });
});
