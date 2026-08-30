import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { z } from "zod";
import type { VerificationReport } from "../service/verification.js";
import {
  UpdateEngine,
  type UpdateEngineOptions,
  type UpdateEngineResult,
  type UpdateEngineRunRequest,
  type UpdateRunStatus,
} from "../updates/engine.js";

export const CURRENT_VERSION = "0.1.0";

export interface UpgradeCommandFlags {
  targetVersion?: string;
  channel?: string;
  rollback?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  noRollback?: boolean;
  home?: string;
  help?: boolean;
  signal?: AbortSignal;
}

export interface UpgradeResult {
  success: boolean;
  dryRun: boolean;
  status: UpdateRunStatus | "dry-run";
  channel?: string;
  currentVersion: string;
  activeVersion: string;
  targetVersion: string;
  pendingVersion?: string;
  backupPath?: string;
  healthGatePassed: boolean;
  rolledBack?: boolean;
  deferred?: boolean;
  verificationReport?: VerificationReport;
  error?: string;
  stepsCompleted: string[];
}

export function parseUpgradeFlags(args: string[]): UpgradeCommandFlags {
  const flags: UpgradeCommandFlags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--rollback") flags.rollback = true;
    else if (arg === "--no-rollback") flags.noRollback = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--target-version" && i + 1 < args.length) flags.targetVersion = args[++i];
    else if (arg?.startsWith("--target-version=")) flags.targetVersion = arg.slice(17);
    else if (arg === "--channel" && i + 1 < args.length) flags.channel = args[++i];
    else if (arg?.startsWith("--channel=")) flags.channel = arg.slice(10);
    else if (arg === "--home" && i + 1 < args.length) flags.home = args[++i];
    else if (arg?.startsWith("--home=")) flags.home = arg.slice(7);
  }
  if (flags.rollback && flags.targetVersion !== undefined) {
    throw new Error("--rollback cannot be combined with --target-version.");
  }
  return flags;
}

export function printUpgradeHelp(): void {
  process.stdout.write(
    `Usage:\n  resin upgrade [options]\n\nStages and activates only releases authenticated by a signed release channel.\n\nOptions:\n  --target-version <v>  Require the signed channel to resolve to this exact version.\n  --channel <channel>   Override the configured channel (stable, beta, nightly).\n  --rollback            Activate the recorded previous known-good version; cannot be combined with --target-version.\n  --dry-run             Simulate without network or filesystem mutation.\n  --force               Reinstall even if the exact signed version is active.\n  --no-rollback         Disable automatic rollback if the health gate fails.\n  --json                Output structured JSON.\n  --home <path>         Custom Resin home.\n  -h, --help            Show help.\n`,
  );
}

type UpgradeEngineRunner = Pick<UpdateEngine, "run">;

export class UpgradeOrchestrator {
  private readonly resinHome: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly engine: UpgradeEngineRunner;

  constructor(
    options: {
      homeDir?: string;
      resinHome?: string;
      fsBridge?: ConfigFsBridge;
      customFetch?: typeof fetch;
      engine?: UpgradeEngineRunner;
      engineOptions?: Omit<
        UpdateEngineOptions,
        "homeDir" | "resinHome" | "fsBridge" | "customFetch" | "currentVersionFallback"
      >;
    } = {},
  ) {
    const homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(homeDir, ".resin");
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.engine =
      options.engine ??
      new UpdateEngine({
        ...options.engineOptions,
        homeDir,
        resinHome: this.resinHome,
        fsBridge: this.fsBridge,
        customFetch: options.customFetch,
        currentVersionFallback: CURRENT_VERSION,
      });
  }

  async runUpgrade(flags: UpgradeCommandFlags = {}): Promise<UpgradeResult> {
    if (flags.rollback && flags.targetVersion !== undefined) {
      throw new Error("--rollback cannot be combined with --target-version.");
    }
    const currentVersion = await this.readCurrentVersion();
    if (flags.dryRun) {
      return {
        success: true,
        dryRun: true,
        status: "dry-run",
        channel: flags.channel,
        currentVersion,
        activeVersion: currentVersion,
        targetVersion: flags.targetVersion ?? currentVersion,
        healthGatePassed: true,
        stepsCompleted: ["preflight", "dry_run_simulation"],
      };
    }

    const runRequest: UpdateEngineRunRequest = {
      mode: "manual",
      rollbackOnFailure: !flags.noRollback,
      channel: flags.channel,
      targetVersion: flags.targetVersion,
      force: flags.force,
      rollback: flags.rollback,
      signal: flags.signal,
    };
    const result = await this.engine.run(runRequest);
    return this.mapEngineResult(result);
  }

  private async readCurrentVersion(): Promise<string> {
    const raw = await this.fsBridge.readFile(path.join(this.resinHome, "version.json"));
    if (raw === null) return CURRENT_VERSION;
    try {
      const parsed = z.object({ version: z.string() }).safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data.version.replace(/^v/, "");
      }
    } catch {}
    return CURRENT_VERSION;
  }

  private mapEngineResult(result: UpdateEngineResult): UpgradeResult {
    return {
      success: result.success,
      dryRun: false,
      status: result.status,
      channel: result.channel,
      currentVersion: result.currentVersion,
      activeVersion: result.activeVersion,
      targetVersion: result.targetVersion ?? result.currentVersion,
      pendingVersion: result.pendingVersion,
      backupPath: result.backupPath,
      healthGatePassed: result.healthGatePassed,
      rolledBack: result.rolledBack,
      deferred: result.status === "activation-deferred" || result.status === "offline",
      verificationReport: result.verificationReport,
      error: result.error,
      stepsCompleted: result.stepsCompleted,
    };
  }
}

export async function upgradeCommand(
  args: string[],
  options: {
    fsBridge?: ConfigFsBridge;
    customFetch?: typeof fetch;
    engine?: UpgradeEngineRunner;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  let flags: UpgradeCommandFlags;
  try {
    flags = parseUpgradeFlags(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ success: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nFatal error during upgrade: ${message}\n`);
    }
    return 1;
  }
  if (flags.help) {
    printUpgradeHelp();
    return 0;
  }
  const customHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const orchestrator = new UpgradeOrchestrator({
    homeDir: customHome,
    resinHome: path.join(customHome, ".resin"),
    fsBridge: options.fsBridge,
    customFetch: options.customFetch,
    engine: options.engine,
  });
  try {
    const upgradeFlags: UpgradeCommandFlags = { ...flags };
    if (options.signal !== undefined) {
      upgradeFlags.signal = options.signal;
    }
    const result = await orchestrator.runUpgrade(upgradeFlags);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.status === "activation-deferred") {
      process.stdout.write(
        `\nResin v${result.targetVersion} is staged; activation is deferred until active sessions finish.\n`,
      );
    } else if (result.success && result.status === "rolled-back") {
      process.stdout.write(`\nResin rollback complete: v${result.activeVersion}\n`);
    } else if (result.success) {
      process.stdout.write(`\nResin upgrade complete: v${result.activeVersion}\n`);
    } else {
      process.stderr.write(`\nUpgrade failed: ${result.error ?? result.status}\n`);
    }
    return result.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ success: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nFatal error during upgrade: ${message}\n`);
    }
    return 1;
  }
}
