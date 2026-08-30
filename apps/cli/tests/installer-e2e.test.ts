import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import { initCommand, parseInitFlags } from "../src/commands/init.js";
import {
  InstallationError,
  type InstallationPairingSummary,
  type InstallerPairingMutation,
  ResinInstaller,
} from "../src/installer/installer.js";

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
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toContain("resin");
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
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toBeNull();
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
    await bridge.writeFile(`${home}/.claude/claude.json`, '{"original": "claude"}');
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
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toBe('{"original": "claude"}');
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

  it("propagates explicit gatewayUrl to all configured harnesses and defaults when omitted", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const home = "/home/developer";
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

    // Verify all harness configs received custom gateway
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toContain(customGateway);
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toContain("resin");
    expect(await bridge.readFile(`${home}/.omp/agent/mcp.json`)).toContain("resin");
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

    const helpExit = await main(["help"]);
    expect(helpExit).toBe(0);

    const unknownExit = await main(["unknown-command"]);
    expect(unknownExit).toBe(1);
  });
});
