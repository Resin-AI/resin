import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import {
  HarnessHealthCoordinator,
  type HarnessHealthRunner,
  runBoundedHarnessHealthCheck,
  saveHarnessHealthSettings,
} from "../installer/harness-health.js";
import {
  InstallationError,
  type InstallationPairingSummary,
  type InstallationSummary,
  type InstallerOptions,
  type InstallerPairingMutation,
  ResinInstaller,
} from "../installer/installer.js";
import { DEFAULT_CLOUD_URL, validateCloudUrl } from "../service/auth-bootstrap.js";
import type { ServiceCommandRunner } from "../service/manager.js";
import { type BrowserLauncher, performPairing } from "./login.js";
export interface InitCommandFlags {
  dryRun?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  autoApprove?: boolean;
  harness?: string;
  workspace?: string;
  capabilitiesFile?: string;
  privacyConfig?: string;
  rollbackInstall?: boolean;
  gatewayUrl?: string;
  home?: string;
  localOnly?: boolean;
  cloudUrl?: string;
  help?: boolean;
  autoRepair?: boolean;
}

export interface InitCommandOptions {
  customFsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  serviceRunner?: ServiceCommandRunner;
  pairing?: () => Promise<InstallerPairingMutation>;
  promptFn?: (question: string) => Promise<boolean>;
  authPromptFn?: (question: string) => Promise<boolean>;
  logger?: (msg: string) => void;
  releaseMode?: "production" | "local-test";
  setupService?: boolean;
  autoStartService?: boolean;
  readinessVerifier?: InstallerOptions["readinessVerifier"];
  readinessTimeoutMs?: number;
  readinessRetryIntervalMs?: number;
  harnessHealthCoordinator?: HarnessHealthRunner;
  harnessAutoRepair?: boolean;
  harnessHealthDeadlineMs?: number;
  authorizationTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export function parseInitFlags(args: string[]): InitCommandFlags {
  const flags: InitCommandFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--non-interactive") {
      flags.nonInteractive = true;
    } else if (arg === "--auto-approve" || arg === "-y" || arg === "--yes") {
      flags.autoApprove = true;
    } else if (arg === "--rollback-install") {
      flags.rollbackInstall = true;
    } else if (arg === "--local-only") {
      flags.localOnly = true;
    } else if (arg === "--auto-repair") {
      flags.autoRepair = true;
    } else if (arg === "--no-auto-repair") {
      flags.autoRepair = false;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--harness=")) {
      flags.harness = arg.slice(10);
    } else if (arg === "--harness" && i + 1 < args.length) {
      flags.harness = args[++i];
    } else if (arg.startsWith("--workspace=")) {
      flags.workspace = arg.slice(12);
    } else if (arg === "--workspace" && i + 1 < args.length) {
      flags.workspace = args[++i];
    } else if (arg.startsWith("--capabilities-file=")) {
      flags.capabilitiesFile = arg.slice(20);
    } else if (arg === "--capabilities-file" && i + 1 < args.length) {
      flags.capabilitiesFile = args[++i];
    } else if (arg.startsWith("--privacy-config=")) {
      flags.privacyConfig = arg.slice(17);
    } else if (arg === "--privacy-config" && i + 1 < args.length) {
      flags.privacyConfig = args[++i];
    } else if (arg.startsWith("--gateway-url=")) {
      flags.gatewayUrl = arg.slice(14);
    } else if (arg === "--gateway-url" && i + 1 < args.length) {
      flags.gatewayUrl = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice(7);
    } else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (arg.startsWith("--cloud-url=")) {
      flags.cloudUrl = arg.slice(12);
    } else if (arg === "--cloud-url" && i + 1 < args.length) {
      flags.cloudUrl = args[++i];
    }
  }

  return flags;
}

export function printInitHelp(): void {
  const text = `
Usage:
  npx resin init [options]

One-command install: verify the signed release, present the capability and
privacy plan, pair this device with Resin Cloud (unless --local-only), write
owner-only cloud credentials, register detected harnesses at the gateway URL,
and install/start/health-check the non-root user service.

Pairing opens the complete verification URL in a browser and always prints
that URL plus the user code. Sign in or create an account, then review the
identity and workspace in the Console before approving. Cloud credentials
are stored at ~/.resin/state/device-token.json (mode 0600) with an ancillary
vault copy. They are distinct from the local IPC token. Failed pairing does
not leave a partial credential replacement. If a user service is already
running, pairing restarts it so the daemon reloads credentials.

The first Git workspace the gateway sees creates stable .resin/project.json
and .resin/resin.lock files. Local MCP (search_tools, get_tool_schema,
invoke_tool, manage_tools) keeps working after logout or when the cloud is
unreachable.

Options:
  --dry-run                  Simulate installation without writing files or mutating the system.
  --json                     Output installation progress and summary as JSON.
  --non-interactive          Disable prompts. Requires valid pre-provisioned credentials
                             or --local-only; never silently claims cloud connectivity.
  --auto-approve, -y, --yes  Approve the capability and privacy plan without a prompt.
                             Does not skip pairing.
  --local-only               Skip cloud pairing and install for local MCP use only.
  --cloud-url <url>          Resin Cloud origin (default: https://api.resin.sh).
  --harness <name>           Limit harness registration to one of: claude-code, codex-cli, omp.
  --workspace <dir>          Target project workspace directory.
  --capabilities-file <path> Pre-approved capabilities grant file.
  --privacy-config <path>    Pre-approved privacy configuration file.
  --gateway-url <url>        MCP gateway URL written into harness configs.
                             Default when omitted: http://127.0.0.1:9400/mcp/sse.
  --home <path>              Custom home directory (credentials under <home>/.resin).
  --auto-repair             Enable automatic harness repair for startup/hourly checks.
  --no-auto-repair          Persistently disable automatic repair while retaining detection.
  --rollback-install         Roll back the previous installation using the saved journal.
  -h, --help                 Show this help message.

Non-interactive local-only example:
  npx resin init --non-interactive --local-only --auto-approve
`;
  process.stdout.write(text.trimStart());
}

/**
 * Executes the `init` command with the provided options.
 */
export async function runInit(
  options: InstallerOptions,
  customFsBridge?: ConfigFsBridge,
): Promise<InstallationSummary> {
  const installer = new ResinInstaller({
    fsBridge: customFsBridge,
    logger: options.json ? () => {} : options.logger,
  });

  return await installer.run(options);
}
function isConfigFsBridge(value: ConfigFsBridge | InitCommandOptions): value is ConfigFsBridge {
  return "readFile" in value && value.readFile instanceof Function;
}

function resolveReleaseMode(envMode: string | undefined): "production" | "local-test" | undefined {
  if (envMode === "production" || envMode === "local-test") {
    return envMode;
  }
  return undefined;
}

/**
 * Command entry point for `resin init`.
 */
export async function initCommand(
  argv: string[],
  optionsOrBridge?: ConfigFsBridge | InitCommandOptions,
): Promise<number> {
  const flags = parseInitFlags(argv);

  if (flags.help) {
    printInitHelp();
    return 0;
  }

  const options: InitCommandOptions =
    optionsOrBridge !== undefined && isConfigFsBridge(optionsOrBridge)
      ? { customFsBridge: optionsOrBridge }
      : (optionsOrBridge ?? {});

  const isRealInstall = !flags.dryRun && !flags.rollbackInstall;
  const cancellationController = new AbortController();
  const cancelForSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (!cancellationController.signal.aborted) {
      cancellationController.abort(new Error(`Installation cancelled by ${signal}`));
    }
  };
  const handleSigint = () => cancelForSignal("SIGINT");
  const handleSigterm = () => cancelForSignal("SIGTERM");
  const handleExternalAbort = () => {
    if (!cancellationController.signal.aborted) {
      cancellationController.abort(
        options.abortSignal?.reason ?? new Error("Installation cancelled"),
      );
    }
  };
  if (isRealInstall) {
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    options.abortSignal?.addEventListener("abort", handleExternalAbort, { once: true });
    if (options.abortSignal?.aborted) {
      handleExternalAbort();
    }
  }
  const cleanupCancellation = () => {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    options.abortSignal?.removeEventListener("abort", handleExternalAbort);
  };

  let pairingCallback: (() => Promise<InstallerPairingMutation>) | undefined;
  if (options.pairing) {
    pairingCallback = options.pairing;
  } else if (isRealInstall) {
    if (flags.localOnly) {
      pairingCallback = async (): Promise<InstallerPairingMutation> => {
        return {
          paired: false,
          localOnly: true,
          rollback: async () => {},
        };
      };
    } else {
      const cloudUrl = validateCloudUrl(
        flags.cloudUrl ?? process.env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL,
      );
      const home = flags.home ? path.resolve(flags.home) : os.homedir();

      pairingCallback = async (): Promise<InstallerPairingMutation> => {
        return await performPairing({
          cloudUrl,
          home,
          workspaceId: flags.workspace,
          json: flags.json,
          nonInteractive: flags.nonInteractive,
          customFetch: options.customFetch,
          openBrowser: options.openBrowser,
          fsBridge: options.customFsBridge,
          timeoutMs: options.authorizationTimeoutMs,
          abortSignal: cancellationController.signal,
        });
      };
    }
  }

  const installerOptions: InstallerOptions = {
    dryRun: flags.dryRun,
    json: flags.json,
    nonInteractive: flags.nonInteractive,
    autoApprove: flags.autoApprove,
    harness: flags.harness,
    workspace: flags.workspace,
    capabilitiesFile: flags.capabilitiesFile,
    privacyConfig: flags.privacyConfig,
    rollbackInstall: flags.rollbackInstall,
    gatewayUrl: flags.gatewayUrl,
    customHome: flags.home,
    releaseMode:
      options.releaseMode ??
      (flags.dryRun
        ? "local-test"
        : (resolveReleaseMode(process.env.RESIN_RELEASE_MODE) ??
          (process.env.VITEST || process.env.NODE_ENV === "test" ? "local-test" : "production"))),
    releaseChannelUrl: process.env.RESIN_RELEASE_CHANNEL_URL,
    allowInsecureReleaseTransportForTests:
      process.env.RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    fsBridge: options.customFsBridge,
    serviceRunner: options.serviceRunner,
    setupService: options.setupService ?? (isRealInstall && !process.env.VITEST),
    autoStartService: options.autoStartService ?? (isRealInstall && !process.env.VITEST),
    readinessVerifier: options.readinessVerifier,
    readinessTimeoutMs: options.readinessTimeoutMs,
    readinessRetryIntervalMs: options.readinessRetryIntervalMs,
    pairing: pairingCallback,
    promptFn: options.promptFn ?? options.authPromptFn,
    logger: options.logger,
    abortSignal: cancellationController.signal,
  };

  try {
    const result = await runInit(installerOptions, options.customFsBridge);

    if (isRealInstall && result.success) {
      const harnessHome = flags.home ? path.resolve(flags.home) : os.homedir();
      const autoRepair = flags.autoRepair ?? options.harnessAutoRepair;
      if (autoRepair !== undefined) {
        await saveHarnessHealthSettings(autoRepair, {
          home: harnessHome,
          fsBridge: options.customFsBridge,
        });
      }

      const harnesses = result.harnesses.map((harness) => harness.harnessId);
      const installedHarnesses = result.harnesses
        .filter((harness) => harness.installed)
        .map((harness) => harness.harnessId);
      try {
        const harnessHealthCoordinator =
          options.harnessHealthCoordinator ??
          new HarnessHealthCoordinator({
            home: harnessHome,
            workspacePath: flags.workspace,
            gatewayUrl: flags.gatewayUrl,
            fsBridge: options.customFsBridge,
            harnesses,
            installedHarnesses,
          });
        await runBoundedHarnessHealthCheck({
          runner: harnessHealthCoordinator,
          trigger: "init",
          force: true,
          autoRepair,
          harnesses,
          installedHarnesses,
          deadlineMs: options.harnessHealthDeadlineMs,
        });
      } catch {
        // Installation succeeded; a bounded health snapshot remains best-effort.
      }
    }

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }

    return 0;
  } catch (err: unknown) {
    if (flags.json) {
      const journal = err instanceof InstallationError ? err.journal : undefined;
      const stepName = err instanceof InstallationError ? err.stepName : undefined;
      const errorJson = {
        success: false,
        stepName: stepName ?? "unknown",
        error: err instanceof Error ? err.message : String(err),
        journal,
      };
      process.stdout.write(`${JSON.stringify(errorJson, null, 2)}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nError: ${msg}\n`);
    }
    return 1;
  } finally {
    cleanupCancellation();
  }
}
