import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";
import {
  type DaemonConfig,
  DaemonConfigSchema,
  type DaemonPaths,
  resolvePaths,
} from "@resin/observer";

export const resolveDaemonPaths = resolvePaths;
import type { ServiceCommandRunner } from "../service/manager.js";
import {
  type DaemonReadinessResult,
  type DaemonReadinessVerifier,
  verifyDaemonReadiness,
} from "../service/verification.js";
import {
  type VersionSwitchResult,
  downloadAndVerifyAsset,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  switchActiveVersion,
} from "./asset-downloader.js";
import {
  type AssetManifest,
  type AssetVerificationResult,
  discoverAndVerifyAssets,
} from "./assets.js";
import {
  type AuthorizationPlan,
  type AuthorizationPromptFn,
  createAuthorizationPlan,
  formatAuthPlanForDisplay,
  formatCompactAuthPlan,
  validateAuthorization,
} from "./auth-plan.js";
import { type VerbosityLevel, resolveVerbosity } from "../output.js";
import {
  type ChannelMetadata,
  type ChannelVerificationResult,
  type ManifestAsset,
  type ReleaseChannel,
  type SignedManifest,
  type TrustedReleaseKey,
  selectPlatformAsset,
  verifyChannelMetadata,
} from "./channel-verifier.js";
import {
  HarnessConfigOrchestrator,
  type HarnessConfigResult,
  type SupportedHarnessId,
} from "./harness-config.js";
import { InstallationJournal, type JournalData, type JournalDetails } from "./journal.js";
import { type PlatformInfo, detectPlatform, validatePlatform } from "./platform.js";
import {
  type ReleaseProvenance,
  type ResolvedProductionRelease,
  resolveProductionRelease,
} from "./release-client.js";
import { type SetupDaemonServiceResult, setupAndStartDaemonService } from "./user-service.js";

export interface InstallationPairingSummary {
  paired: boolean;
  localOnly: boolean;
  reused?: boolean;
  accountId?: string;
  workspaceId?: string;
  deviceId?: string;
  userId?: string;
  cloudUrl?: string;
}

export interface InstallerPairingMutation extends InstallationPairingSummary {
  rollback?: () => Promise<void>;
}

export interface InstallerOptions {
  dryRun?: boolean;
  json?: boolean;
  nonInteractive?: boolean;
  autoApprove?: boolean;
  harness?: string | string[];
  workspace?: string;
  capabilitiesFile?: string;
  privacyConfig?: string;
  rollbackInstall?: boolean;
  customHome?: string;
  denoExecutable?: string;
  assetManifest?: AssetManifest;
  channel?: ReleaseChannel;
  channelMetadata?: ChannelMetadata;
  signedManifest?: SignedManifest;
  assetTarball?: string | Buffer;
  targetVersion?: string;
  releaseMode?: "production" | "local-test";
  releaseChannelUrl?: string;
  trustedReleaseKeys?: TrustedReleaseKey[];
  fetchImpl?: typeof fetch;
  allowInsecureReleaseTransportForTests?: boolean;
  pairing?: () => Promise<InstallerPairingMutation>;
  promptFn?: AuthorizationPromptFn;
  authPromptFn?: AuthorizationPromptFn;
  setupService?: boolean;
  autoStartService?: boolean;
  serviceRunner?: ServiceCommandRunner;
  readinessVerifier?: DaemonReadinessVerifier;
  readinessTimeoutMs?: number;
  readinessRetryIntervalMs?: number;
  abortSignal?: AbortSignal;
  gatewayUrl?: string;
  logger?: (msg: string) => void;
  fsBridge?: ConfigFsBridge;
  verbosity?: VerbosityLevel;
  verbose?: boolean;
  quiet?: boolean;
}

export interface InstallationSummary {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly platform: PlatformInfo;
  readonly assets: AssetVerificationResult;
  readonly authPlan: AuthorizationPlan;
  readonly pairing?: InstallationPairingSummary;
  readonly harnesses: HarnessConfigResult[];
  readonly daemonConfig?: DaemonConfig;
  readonly journal: JournalData;
  readonly versionSwitch?: VersionSwitchResult;
  readonly serviceSetup?: SetupDaemonServiceResult;
  readonly daemonReadiness?: DaemonReadinessResult;
  readonly error?: string;
}

export class InstallationError extends Error {
  readonly journal: JournalData;
  readonly stepName: string;
  readonly causeError?: Error;

  constructor(message: string, journal: JournalData, stepName: string, causeError?: Error) {
    super(message);
    this.name = "InstallationError";
    this.journal = journal;
    this.stepName = stepName;
    this.causeError = causeError;
  }
}

/**
 * Main Resin Installer responsible for executing the single-command `init` workflow
 * with full transactional safety, pre-mutation authorization, atomic version pointer switching,
 * non-root user service management, and atomic rollback.
 */
export class ResinInstaller {
  private fsBridge: ConfigFsBridge;
  private readonly journal: InstallationJournal;
  private logger: (msg: string) => void;
  private promptFn?: AuthorizationPromptFn;
  private verbosity: VerbosityLevel = "default";

  constructor(
    options: {
      fsBridge?: ConfigFsBridge;
      logger?: (msg: string) => void;
      promptFn?: AuthorizationPromptFn;
      authPromptFn?: AuthorizationPromptFn;
      verbosity?: VerbosityLevel;
      verbose?: boolean;
      quiet?: boolean;
    } = {},
  ) {
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.journal = new InstallationJournal();
    this.logger = options.logger ?? ((msg: string) => process.stdout.write(`${msg}\n`));
    this.promptFn = options.promptFn ?? options.authPromptFn;
    this.verbosity =
      options.verbosity ??
      resolveVerbosity({
        flags: { quiet: options.quiet, verbose: options.verbose },
        env: process.env,
      });
  }

  /**
   * Runs the complete installation workflow or handles rollback request.
   */
  async run(options: InstallerOptions = {}): Promise<InstallationSummary> {
    const customHome = options.customHome ?? process.env.HOME ?? os.homedir();
    const workspacePath = path.resolve(options.workspace ?? process.cwd());
    const dryRun = Boolean(options.dryRun);
    if (options.logger) {
      this.logger = options.logger;
    }
    if (options.verbosity !== undefined || options.verbose !== undefined || options.quiet !== undefined) {
      this.verbosity =
        options.verbosity ??
        resolveVerbosity({
          flags: { quiet: options.quiet, verbose: options.verbose },
          env: process.env,
        });
    }
    if (options.fsBridge) {
      this.fsBridge = options.fsBridge;
    }

    // Handle rollback-install request if requested
    if (options.rollbackInstall) {
      return await this.handleRollbackOnly(customHome);
    }

    try {
      // Step 1: Preflight check
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("preflight");
      this.log("==> Step 1/11: Running preflight environment checks...");
      this.runPreflightChecks();
      this.journal.completeStep("preflight", { nodeVersion: process.version });

      // Step 2: Platform detection & validation
      this.journal.startStep("platform");
      this.log("==> Step 2/11: Detecting platform and system architecture...");
      const platformInfo = validatePlatform(
        detectPlatform({
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
        }),
      );
      this.journal.completeStep("platform", {
        os: platformInfo.os,
        arch: platformInfo.arch,
      });

      // Step 3: Asset discovery & verification / Channel Metadata Verification
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("assets");
      this.log("==> Step 3/11: Verifying Resin binaries, runtime, and MCP shim...");

      let channelResult: ChannelVerificationResult | undefined;
      let selectedAsset: ManifestAsset | undefined;
      let productionRelease: ResolvedProductionRelease | undefined;
      let releaseTarball: string | Buffer | undefined = options.assetTarball;
      let denoRuntimeArchive: string | Buffer | undefined;
      const releaseMode = options.releaseMode ?? "local-test";
      const resinHome = path.join(customHome, ".resin");
      const downloadsDir = path.join(resinHome, "downloads");

      let assetResult: AssetVerificationResult;
      if (releaseMode === "production") {
        if (options.channelMetadata || options.signedManifest || options.assetTarball) {
          throw new Error(
            "Production installation rejects caller-authored channel, manifest, or tarball state; use the signed release channel.",
          );
        }
        productionRelease = await resolveProductionRelease({
          platform: platformInfo,
          channel: options.channel || "stable",
          channelUrl: options.releaseChannelUrl,
          trustedReleaseKeys: options.trustedReleaseKeys,
          fetchImpl: options.fetchImpl,
          env: process.env,
          allowInsecureHttpForTests: options.allowInsecureReleaseTransportForTests,
        });
        const downloadedRelease = await downloadAndVerifyAsset({
          asset: productionRelease.releaseAsset,
          downloadDir: downloadsDir,
          sourceUrlOrPath: productionRelease.releaseAssetUrl,
          fsBridge: this.fsBridge,
          fetchImpl: options.fetchImpl,
          logger: this.log.bind(this),
        });
        releaseTarball = downloadedRelease.path;
        const denoAsset = productionRelease.denoAsset;
        const downloadedDeno = await downloadAndVerifyAsset({
          asset: {
            filename: denoAsset.filename,
            platform: platformInfo.os,
            arch: platformInfo.arch,
            isWsl: platformInfo.isWsl,
            sizeBytes: 0,
            sha256: denoAsset.sha256,
            path: denoAsset.filename,
          },
          downloadDir: downloadsDir,
          sourceUrlOrPath: denoAsset.url,
          fsBridge: this.fsBridge,
          fetchImpl: options.fetchImpl,
          logger: this.log.bind(this),
        });
        denoRuntimeArchive = downloadedDeno.path;
        this.journal.metadata.releaseProvenance = productionRelease.provenance;
        assetResult = {
          allVerified: true,
          missingRequired: [],
          digestMismatches: [],
          assets: [
            {
              name: "daemon",
              version: productionRelease.version,
              path: downloadedRelease.path,
              expectedSha256: productionRelease.releaseAsset.sha256,
              actualSha256: downloadedRelease.sha256,
              required: true,
              verified: true,
            },
            {
              name: "runtime",
              version: productionRelease.version,
              path: downloadedRelease.path,
              expectedSha256: productionRelease.releaseAsset.sha256,
              actualSha256: downloadedRelease.sha256,
              required: true,
              verified: true,
            },
            {
              name: "mcp-shim",
              version: productionRelease.version,
              path: downloadedRelease.path,
              expectedSha256: productionRelease.releaseAsset.sha256,
              actualSha256: downloadedRelease.sha256,
              required: true,
              verified: true,
            },
            {
              name: "deno",
              version: productionRelease.provenance.deno.version,
              path: downloadedDeno.path,
              expectedSha256: productionRelease.provenance.deno.sha256,
              actualSha256: downloadedDeno.sha256,
              required: true,
              verified: true,
            },
          ],
        };
      } else {
        if (options.channelMetadata) {
          channelResult = verifyChannelMetadata(options.channelMetadata, {
            channel: options.channel || "stable",
            skipSignatureVerification: true,
          });
          if (!channelResult.valid) {
            throw new Error(`Channel verification failed: ${channelResult.errors.join("; ")}`);
          }
        }
        if (options.signedManifest)
          selectedAsset = selectPlatformAsset(options.signedManifest, platformInfo);
        if (selectedAsset && options.assetTarball) {
          await downloadAndVerifyAsset({
            asset: selectedAsset,
            downloadDir: downloadsDir,
            sourceBuffer: Buffer.isBuffer(options.assetTarball) ? options.assetTarball : undefined,
            sourceUrlOrPath:
              String(options.assetTarball) === options.assetTarball
                ? options.assetTarball
                : undefined,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }
        assetResult = await discoverAndVerifyAssets({
          fsBridge: this.fsBridge,
          manifest: options.assetManifest,
          denoExecutable: options.denoExecutable,
          allowMissingOptional: true,
        });
      }
      this.journal.completeStep("assets", {
        allVerified: assetResult.allVerified,
        assetCount: assetResult.assets.length,
      });

      // Step 4: Ensure directory tree & version directory layout
      this.journal.startStep("directories");
      this.log("==> Step 4/11: Creating Resin state and configuration directories...");
      const daemonPaths = resolvePaths({
        home: customHome,
        resinHome,
        env: process.env,
        platform: process.platform,
      });

      let versionSwitchResult: VersionSwitchResult | undefined;

      if (!dryRun) {
        await this.fsBridge.mkdirp(daemonPaths.configDir);
        await this.fsBridge.mkdirp(daemonPaths.dataDir);
        await this.fsBridge.mkdirp(daemonPaths.stateDir);
        await this.fsBridge.mkdirp(daemonPaths.logDir);

        for (const dir of [
          daemonPaths.configDir,
          daemonPaths.dataDir,
          daemonPaths.stateDir,
          daemonPaths.logDir,
        ]) {
          try {
            await fs.chmod(dir, 0o700);
          } catch {
            // Non-POSIX or in-memory fs bridge
          }
        }

        if (releaseTarball) {
          const installVersion =
            productionRelease?.version ||
            channelResult?.targetVersion ||
            options.targetVersion ||
            "1.0.0";
          const previousVersion = getActiveVersion(resinHome);
          const installed = await installReleaseVersion({
            version: installVersion,
            tarballPathOrBuffer: releaseTarball,
            resinHome,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
            provenance: productionRelease?.provenance,
            denoRuntime:
              productionRelease && denoRuntimeArchive
                ? {
                    archivePathOrBuffer: denoRuntimeArchive,
                    version: productionRelease.provenance.deno.version,
                    sha256: productionRelease.provenance.deno.sha256,
                    executable: productionRelease.denoAsset.executable,
                  }
                : undefined,
          });

          this.journal.addRollbackAction(
            "directories",
            `Restore exact prior release after failed activation of v${installVersion}`,
            async () => {
              if (previousVersion) {
                await switchActiveVersion({
                  resinHome,
                  targetVersion: previousVersion,
                  fsBridge: this.fsBridge,
                  logger: this.log.bind(this),
                });
              } else {
                await fs.rm(path.join(resinHome, "current"), { force: true }).catch(() => {});
                await fs
                  .rm(path.join(resinHome, "current-version"), { force: true })
                  .catch(() => {});
              }
              if (installVersion !== previousVersion) {
                await fs.rm(installed.versionDir, { recursive: true, force: true });
              }
            },
          );

          versionSwitchResult = await switchActiveVersion({
            resinHome,
            targetVersion: installVersion,
            fsBridge: this.fsBridge,
            logger: this.log.bind(this),
          });
        }
      }
      this.journal.completeStep("directories", {
        stateDir: daemonPaths.stateDir,
        activeVersion: versionSwitchResult?.activeVersion || options.targetVersion || "0.1.0",
      });

      // Step 5: Authorization plan creation & approval
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("authorization");
      this.log("==> Step 5/11: Inspecting workspace capabilities and privacy boundary...");
      const authPlan = await createAuthorizationPlan({
        workspacePath,
        capabilitiesFile: options.capabilitiesFile,
        privacyConfigFile: options.privacyConfig,
        fsBridge: this.fsBridge,
      });

      if (!options.json) {
        if (this.verbosity === "verbose") {
          this.logger(`\n${formatAuthPlanForDisplay(authPlan)}\n`);
        } else if (
          !options.autoApprove &&
          !options.dryRun &&
          !options.capabilitiesFile &&
          !options.nonInteractive &&
          this.verbosity !== "quiet"
        ) {
          this.logger(`\n${formatCompactAuthPlan(authPlan)}\n`);
        }
      }

      const promptFn = options.promptFn ?? options.authPromptFn ?? this.promptFn;

      const validation = await validateAuthorization(authPlan, {
        nonInteractive: Boolean(options.nonInteractive),
        autoApprove: Boolean(options.autoApprove || options.dryRun),
        capabilitiesFile: options.capabilitiesFile,
        promptFn,
      });
      if (!validation.granted) {
        throw new Error(
          "Installation aborted: Workspace capabilities and privacy authorization require approval.",
        );
      }
      this.journal.completeStep("authorization", {
        approved: validation.granted,
        planId: authPlan.planId,
      });

      // Step 6: Account & Device Pairing
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("pairing");
      let pairingSummary: InstallationPairingSummary | undefined;
      if (options.pairing && !dryRun) {
        this.log("==> Step 6/11: Pairing device with Resin Cloud account...");
        const pairingMutation = await options.pairing();
        if (pairingMutation.rollback) {
          this.journal.addRollbackAction(
            "pairing",
            "Roll back cloud device authorization and pairing credentials",
            async () => {
              await pairingMutation.rollback?.();
            },
          );
        }
        const summary: InstallationPairingSummary = {
          paired: Boolean(pairingMutation.paired),
          localOnly: Boolean(pairingMutation.localOnly),
        };
        if (pairingMutation.reused !== undefined) summary.reused = pairingMutation.reused;
        if (pairingMutation.accountId) summary.accountId = pairingMutation.accountId;
        if (pairingMutation.workspaceId) summary.workspaceId = pairingMutation.workspaceId;
        if (pairingMutation.deviceId) summary.deviceId = pairingMutation.deviceId;
        if (pairingMutation.userId) summary.userId = pairingMutation.userId;
        if (pairingMutation.cloudUrl) summary.cloudUrl = pairingMutation.cloudUrl;
        pairingSummary = summary;
        this.journal.completeStep("pairing", { ...pairingSummary });
      } else {
        pairingSummary = {
          paired: false,
          localOnly: true,
        };
        this.journal.completeStep("pairing", {
          paired: false,
          localOnly: true,
        });
      }

      // Step 7: Harness Discovery
      this.journal.startStep("harness_discovery");
      this.log("==> Step 7/11: Discovering AI coding harnesses in workspace...");
      const orchestrator = new HarnessConfigOrchestrator();
      let requestedHarnesses: SupportedHarnessId[] | undefined;
      if (options.harness) {
        const values = (Array.isArray(options.harness) ? options.harness : [options.harness])
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter(Boolean);
        const supportedHarnesses: readonly string[] = ["claude-code", "codex-cli", "omp"];
        const unsupported = values.find((value) => !supportedHarnesses.includes(value));
        if (unsupported) {
          throw new Error(`Unsupported harness '${unsupported}'`);
        }
        requestedHarnesses = values.filter(
          (h): h is SupportedHarnessId => h === "claude-code" || h === "codex-cli" || h === "omp",
        );
      }

      this.journal.completeStep("harness_discovery", {
        requestedHarnesses: requestedHarnesses || "all",
      });

      // Step 8: Config Planning
      this.journal.startStep("config_planning");
      this.log("==> Step 8/11: Formulating safe non-destructive configuration mutation plans...");
      this.journal.completeStep("config_planning");

      // Step 9: Apply configuration mutations
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("apply");
      this.log(
        `==> Step 9/11: ${dryRun ? "[DRY-RUN] Simulating" : "Applying"} harness MCP configuration updates...`,
      );

      const orchestrationResult = await orchestrator.configureHarnesses({
        workspacePath,
        customHome,
        gatewayUrl: options.gatewayUrl,
        fsBridge: this.fsBridge,
        dryRun,
        harnesses: requestedHarnesses,
      });

      if (!orchestrationResult.success) {
        throw new Error(orchestrationResult.error || "Failed to configure agent harnesses.");
      }

      // Record rollback action in journal
      this.journal.addRollbackAction(
        "apply",
        "Restore previous harness configurations from backups",
        async () => {
          await orchestrationResult.rollback();
        },
      );

      let effectiveTelemetryEnabled = authPlan.privacy.telemetryEnabled ?? true;
      if (options.privacyConfig === undefined) {
        const configFileExists = await this.fsBridge.exists(daemonPaths.configFile);
        if (configFileExists) {
          try {
            const previousConfigContent = await this.fsBridge.readFile(daemonPaths.configFile);
            if (previousConfigContent && previousConfigContent.trim().length > 0) {
              const parsed = JSON.parse(previousConfigContent);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if (parsed.telemetryEnabled === false) {
                  effectiveTelemetryEnabled = false;
                } else if (parsed.telemetryEnabled === true) {
                  effectiveTelemetryEnabled = true;
                }
              }
            }
          } catch {}
        }
      }

      // Persist daemon configuration (0600 mode) for telemetry and background service startup
      const daemonConfigPayload: DaemonConfig = DaemonConfigSchema.parse({
        version: options.targetVersion || "0.1.0",
        logLevel: "info",
        host: "127.0.0.1",
        port: 9400,
        cloudUrl: pairingSummary?.cloudUrl || options.gatewayUrl || "https://api.resin.sh",
        telemetryEnabled: effectiveTelemetryEnabled,
        storageDir: daemonPaths.dataDir,
        moduleConfigs: {},
        custom: {},
      });
      if (!dryRun) {
        const staleTokenCandidates = [
          path.join(resinHome, "auth.token"),
          path.join(resinHome, "daemon.token"),
          path.join(daemonPaths.stateDir, "auth.token"),
          path.join(daemonPaths.stateDir, "daemon.token"),
          path.join(daemonPaths.configDir, "auth.token"),
          path.join(daemonPaths.configDir, "daemon.token"),
        ];
        for (const tokenPath of staleTokenCandidates) {
          if (await this.fsBridge.exists(tokenPath)) {
            try {
              await this.fsBridge.unlink(tokenPath);
            } catch {}
          }
        }

        await this.fsBridge.mkdirp(daemonPaths.configDir);
        try {
          await fs.chmod(daemonPaths.configDir, 0o700);
        } catch {
          // Non-POSIX or in-memory bridge
        }

        const configFileExists = await this.fsBridge.exists(daemonPaths.configFile);
        const previousConfigContent = configFileExists
          ? await this.fsBridge.readFile(daemonPaths.configFile)
          : null;

        await this.fsBridge.writeFile(
          daemonPaths.configFile,
          JSON.stringify(daemonConfigPayload, null, 2),
        );

        try {
          await fs.chmod(daemonPaths.configFile, 0o600);
        } catch {
          // Non-POSIX or in-memory bridge
        }

        this.journal.addRollbackAction(
          "apply",
          "Restore or remove daemon configuration file",
          async () => {
            if (previousConfigContent !== null) {
              await this.fsBridge.writeFile(daemonPaths.configFile, previousConfigContent);
              try {
                await fs.chmod(daemonPaths.configFile, 0o600);
              } catch {}
            } else {
              try {
                await this.fsBridge.unlink(daemonPaths.configFile);
              } catch {}
            }
          },
        );
      }

      const configuredCount = orchestrationResult.results.filter((r) => r.configured).length;
      this.journal.completeStep("apply", {
        configuredCount,
        configFile: daemonPaths.configFile,
        telemetryEnabled: daemonConfigPayload.telemetryEnabled,
      });

      // Step 10: User-level Service Registration & End-to-End Readiness Verification
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("verify");
      let serviceSetupResult: SetupDaemonServiceResult | undefined;
      let daemonReadinessResult: DaemonReadinessResult | undefined;

      if (options.setupService) {
        this.log("==> Step 10/11: Registering and starting non-root user daemon service...");
        if (!dryRun) {
          serviceSetupResult = await setupAndStartDaemonService({
            homeDir: customHome,
            resinHome,
            autoStart: options.autoStartService ?? true,
            fsBridge: this.fsBridge,
            runner: options.serviceRunner,
            logger: this.log.bind(this),
          });

          if (serviceSetupResult.rollback) {
            this.journal.addRollbackAction(
              "verify",
              "Restore previous daemon user service state",
              async () => {
                await serviceSetupResult?.rollback?.();
              },
            );
          }

          if (
            !serviceSetupResult.success ||
            !serviceSetupResult.started ||
            !serviceSetupResult.healthy
          ) {
            throw new Error(
              `Daemon service setup failed: ${serviceSetupResult.error || serviceSetupResult.details || "Service failed health verification"}`,
            );
          }

          options.abortSignal?.throwIfAborted();
          this.log("Verifying daemon IPC and Resin Cloud readiness...");
          const readinessVerifier = options.readinessVerifier ?? verifyDaemonReadiness;
          daemonReadinessResult = await readinessVerifier({
            homeDir: customHome,
            resinHome,
            fsBridge: this.fsBridge,
            cloudRequired: pairingSummary?.localOnly !== true,
            timeoutMs: options.readinessTimeoutMs,
            retryIntervalMs: options.readinessRetryIntervalMs,
          });
          if (!daemonReadinessResult.ready) {
            throw new Error(
              `Daemon readiness verification failed: ${daemonReadinessResult.error || "IPC or Cloud runtime did not become ready"}`,
            );
          }
        }
      } else {
        this.log(
          "==> Step 10/11: Verifying harness configuration integrity and gateway registration...",
        );
      }

      const installedHarnesses = orchestrationResult.results.filter(
        (result: HarnessConfigResult) => result.installed,
      );
      const allConfigured = installedHarnesses.every(
        (result: HarnessConfigResult) => result.configured,
      );
      if (!allConfigured) {
        throw new Error("One or more detected editor harnesses are not ready for Resin.");
      }
      const verifyDetails: JournalDetails = {
        allConfigured,
        installedHarnessCount: installedHarnesses.length,
        onboardingReady:
          allConfigured &&
          (!options.setupService || dryRun || daemonReadinessResult?.ready === true),
      };
      if (serviceSetupResult) {
        verifyDetails.serviceHealthy = serviceSetupResult.healthy;
      }
      if (daemonReadinessResult) {
        verifyDetails.ipcReady = daemonReadinessResult.ipcReady;
        verifyDetails.cloudReady = daemonReadinessResult.cloudReady;
        verifyDetails.daemonHealthStatus = daemonReadinessResult.healthStatus;
      }
      this.journal.completeStep("verify", verifyDetails);

      // Step 11: Finalizing & recording journal
      options.abortSignal?.throwIfAborted();
      this.journal.startStep("complete");
      this.log("==> Step 11/11: Finalizing installation transaction and recording journal...");
      this.journal.finalize("completed");
      this.journal.completeStep("complete");

      const journalFilePath = path.join(daemonPaths.stateDir, "install-journal.json");
      if (!dryRun) {
        await this.journal.save(journalFilePath, this.fsBridge);
      }

      this.log("\n✔ Resin installation completed successfully!\n");

      return {
        success: true,
        dryRun,
        platform: platformInfo,
        assets: assetResult,
        authPlan,
        pairing: pairingSummary,
        harnesses: orchestrationResult.results,
        daemonConfig: daemonConfigPayload,
        journal: this.journal.toJSON(),
        versionSwitch: versionSwitchResult,
        serviceSetup: serviceSetupResult,
        daemonReadiness: daemonReadinessResult,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const activeStep =
        this.journal.toJSON().steps.find((s) => s.status === "running")?.name ?? "unknown";

      if (activeStep !== "unknown") {
        this.journal.failStep(activeStep, error);
      }

      if (!dryRun) {
        this.log("\n❌ Installation failed. Rolling back installation transaction...");
        try {
          await this.journal.rollback(this.fsBridge);
          this.log("✔ Installation rollback completed successfully.");
        } catch (rollbackErr: unknown) {
          this.log(`⚠️  Warning: Rollback encountered an error: ${String(rollbackErr)}`);
        }
        try {
          const failedStateDir = path.join(customHome, ".resin", "state");
          await this.fsBridge.mkdirp(failedStateDir);
          await this.journal.save(path.join(failedStateDir, "install-journal.json"), this.fsBridge);
        } catch {
          // A missing/unwritable home is itself recoverable from the thrown error.
        }
      }

      throw new InstallationError(
        `Resin installation failed during step "${activeStep}": ${error.message}`,
        this.journal.toJSON(),
        activeStep,
        error,
      );
    }
  }

  /**
   * Preflight environment sanity check.
   */
  private runPreflightChecks(): void {
    const nodeMajor = Number.parseInt(process.version.slice(1).split(".")[0] || "0", 10);
    if (nodeMajor < 22) {
      throw new Error(
        `Unsupported Node.js runtime: ${process.version}. Resin requires Node.js v22.0.0 or higher.`,
      );
    }
  }

  /**
   * Handles explicit rollback request.
   */
  private async handleRollbackOnly(customHome: string): Promise<InstallationSummary> {
    const resinHome = path.join(customHome, ".resin");
    this.log("==> Performing Resin configuration and version rollback...");

    const journalPath = path.join(resinHome, "state", "install-journal.json");
    let loadedJournal: InstallationJournal;

    if (await this.fsBridge.exists(journalPath)) {
      loadedJournal = await InstallationJournal.load(journalPath, this.fsBridge);
      await loadedJournal.rollback(this.fsBridge);
      if (this.verbosity !== "quiet") {
        this.logger("✔ Successfully rolled back configuration files to prior state.");
      }
    } else {
      loadedJournal = new InstallationJournal();
      if (this.verbosity !== "quiet") {
        this.logger("⚠️  No install journal found to roll back configurations from.");
      }
    }

    // Try version rollback if pointer exists
    try {
      await rollbackActiveVersion({
        resinHome,
        fsBridge: this.fsBridge,
        logger: this.log.bind(this),
      });
    } catch {}

    const platformInfo = detectPlatform({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    });

    return {
      success: true,
      dryRun: false,
      platform: platformInfo,
      assets: {
        allVerified: true,
        assets: [],
        missingRequired: [],
        digestMismatches: [],
      },
      authPlan: await createAuthorizationPlan({
        workspacePath: process.cwd(),
        fsBridge: this.fsBridge,
      }),
      harnesses: [],
      journal: loadedJournal.toJSON(),
    };
  }

  private log(message: string): void {
    if (this.verbosity === "verbose") {
      this.logger(message);
    }
  }
}
