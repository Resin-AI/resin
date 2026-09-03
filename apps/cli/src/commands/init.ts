import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { resolveInstalledResinMcpCommand } from "../installer/harness-config.js";
import {
  HarnessHealthCoordinator,
  type HarnessHealthRunner,
  resolveLocalSourceResinCommand,
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
import { type VerbosityLevel, resolveVerbosity } from "../output.js";
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
  verbose?: boolean;
  quiet?: boolean;
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
  localSourceRoot?: string;
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
  verbosity?: VerbosityLevel;
  verbose?: boolean;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): boolean | undefined; isTTY?: boolean };
  stderr?: { write(chunk: string): boolean | undefined };
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
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
    } else if (arg === "--quiet" || arg === "-q") {
      flags.quiet = true;
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
  -v, --verbose              Enable verbose diagnostic logging and full authorization plan display.
  -q, --quiet                Suppress non-error standard output.
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

export interface InitReleaseContext {
  readonly releaseMode: "production" | "local-test";
  readonly localSourceRoot?: string;
}

export function resolveInitReleaseContext(options: {
  readonly releaseMode?: "production" | "local-test";
  readonly localSourceRoot?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly entryPath?: string;
}): InitReleaseContext {
  if (options.releaseMode !== undefined) {
    const explicitSourceRoot = options.localSourceRoot?.trim();
    return {
      releaseMode: options.releaseMode,
      localSourceRoot:
        options.releaseMode === "local-test" && explicitSourceRoot
          ? path.resolve(explicitSourceRoot)
          : undefined,
    };
  }

  const requestedRoot = options.env.RESIN_LOCAL_SOURCE_ROOT?.trim();
  if (options.env.RESIN_RELEASE_MODE !== "local-test" || !requestedRoot) {
    return { releaseMode: "production" };
  }
  const sourceCommand = resolveLocalSourceResinCommand(options.env, options.entryPath);
  if (sourceCommand === undefined) return { releaseMode: "production" };
  return {
    releaseMode: "local-test",
    localSourceRoot: path.resolve(path.dirname(sourceCommand), "..", "..", ".."),
  };
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

  const env = options.env ?? process.env;
  const harnessHome = flags.home
    ? path.resolve(flags.home)
    : path.resolve(env.HOME ?? os.homedir());
  const harnessEnv = { ...env, HOME: harnessHome };
  const verbosity =
    options.verbosity ??
    resolveVerbosity({
      args: argv,
      flags: { quiet: flags.quiet ?? options.quiet, verbose: flags.verbose ?? options.verbose },
      env,
    });
  const isQuiet = verbosity === "quiet";
  const isVerbose = verbosity === "verbose";
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
      const cloudUrl = validateCloudUrl(flags.cloudUrl ?? env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL);
      const home = harnessHome;

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
          stdout: isQuiet || flags.nonInteractive ? { write: () => true } : options.stdout,
        });
      };
    }
  }

  const { releaseMode, localSourceRoot } = resolveInitReleaseContext({
    releaseMode: options.releaseMode,
    localSourceRoot: options.localSourceRoot,
    env,
  });

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
    env: harnessEnv,
    promptFn: options.promptFn ?? options.authPromptFn,
    logger: options.logger,
    fetchImpl: options.customFetch,
    verbosity,
    verbose: isVerbose,
    quiet: isQuiet,
    localSourceRoot,
    releaseMode,
    releaseChannelUrl: process.env.RESIN_RELEASE_CHANNEL_URL,
    allowInsecureReleaseTransportForTests:
      process.env.RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES === "1",
    fsBridge: options.customFsBridge,
    serviceRunner: options.serviceRunner,
    setupService: options.setupService ?? isRealInstall,
    autoStartService: options.autoStartService ?? isRealInstall,
    readinessVerifier: options.readinessVerifier,
    pairing: pairingCallback,
    abortSignal: cancellationController.signal,
  };

  try {
    const result = await runInit(installerOptions, options.customFsBridge);

    if (isRealInstall && result.success) {
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
            env: harnessEnv,
            workspacePath: flags.workspace,
            gatewayUrl: flags.gatewayUrl,
            fsBridge: options.customFsBridge,
            resinCommand: localSourceRoot
              ? path.join(localSourceRoot, "apps", "cli", "bin", "resin.mjs")
              : resolveInstalledResinMcpCommand(harnessHome),
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
      const stdoutWriter = options.stdout ?? process.stdout;
      stdoutWriter.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (!isQuiet) {
      const stdoutWriter = options.stdout ?? process.stdout;
      stdoutWriter.write("Resin initialization complete.\n");
    }

    return 0;
  } catch (err: unknown) {
    const journal = err instanceof InstallationError ? err.journal : undefined;
    if (flags.json) {
      const stepName = err instanceof InstallationError ? err.stepName : undefined;
      const errorJson = {
        success: false,
        stepName: stepName ?? "unknown",
        error: err instanceof Error ? err.message : String(err),
        journal,
      };
      const stdoutWriter = options.stdout ?? process.stdout;
      stdoutWriter.write(`${JSON.stringify(errorJson, null, 2)}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const stderrWriter = options.stderr ?? process.stderr;
      stderrWriter.write(`\nError: ${msg}\n`);
    }
    return 1;
  } finally {
    cleanupCancellation();
  }
}
