/**
 * Standalone Bootstrap Installer Entrypoint for Resin
 *
 * Provides a self-contained, cryptographically verified installer core
 * that composes platform detection, signature/digest verification,
 * hardened transport, atomic version installation, symlink switching,
 * and bounded health-check rollback.
 */

import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";

import {
  type PlatformInfo,
  UnsupportedPlatformError,
  detectPlatform,
} from "../platform/platform.js";
import {
  type DownloadedAssetResult,
  type VersionInstallResult,
  downloadAndVerifyAsset,
  getActiveVersion,
  installReleaseVersion,
  rollbackActiveVersion,
  switchActiveVersion,
} from "./asset-downloader.js";
import {
  type ManifestAsset,
  REVOKED_RELEASE_KEY_IDS,
  type TrustedReleaseKey,
} from "./channel-verifier.js";
import {
  DEFAULT_PRODUCTION_CHANNEL_URL,
  fetchBytes,
  parseBundledReleaseTrust,
  parseTrustedKeysJsonOverride,
  resolveProductionRelease,
} from "./release-client.js";

/**
 * Production Trust Root Record
 * Key ID: resin-release-2026a
 * Ed25519 Public Key Hex: f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851
 * Fingerprint (SHA-256): a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359
 */
export const PRODUCTION_RELEASE_TRUST_RECORD = Object.freeze({
  schemaVersion: "2.0.0",
  trustDomain: "production",
  trustedKeys: Object.freeze([
    Object.freeze({
      keyId: "resin-release-2026a",
      algorithm: "Ed25519",
      trustDomain: "production",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9ZI1qv+S+txsMLDf1WylTCionlq7H6V6t9XqaD1geFE=\n-----END PUBLIC KEY-----\n",
      publicKeyHex: "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
      publicKeyFingerprintSha256:
        "a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359",
    }),
  ]),
});

export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 15_000;
export const DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB
export const MAX_RELEASE_ASSET_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export interface HealthCheckResult {
  readonly passed: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  readonly outputOverflow?: boolean;
  readonly checkedPath?: string;
}

export interface HealthCheckRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string | undefined>;
}

export type HealthCheckRunner = (
  cliPath: string,
  args?: string[],
  options?: HealthCheckRunnerOptions,
) => Promise<HealthCheckResult>;

export interface OnboardingResult {
  readonly attempted: boolean;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly success?: boolean;
  readonly exitCode?: number;
  readonly error?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface OnboardingRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string | undefined>;
  readonly interactive?: boolean;
  readonly stdio?: child_process.StdioOptions;
  readonly logger?: (message: string) => void;
}

export type OnboardingRunner = (
  cliPath: string,
  args?: string[],
  options?: OnboardingRunnerOptions,
) => Promise<OnboardingResult>;

export const DEFAULT_ONBOARDING_TIMEOUT_MS = 300_000;
export const DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ShellPathConfigResult {
  readonly attempted: boolean;
  readonly updated: boolean;
  readonly alreadyConfigured: boolean;
  readonly profilePath?: string;
  readonly profileName?: string;
  readonly shell?: string;
  readonly binDir: string;
  readonly pathLine?: string;
  readonly reloadCommand?: string;
  readonly error?: string;
  readonly reason?: string;
}

export interface ShellPathConfigOptions {
  readonly resinHome: string;
  readonly homeDir?: string;
  readonly shell?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fsBridge?: ConfigFsBridge;
  readonly logger?: (message: string) => void;
  readonly isPosix?: boolean;
}

export interface BootstrapInstallOptions {
  readonly channel?: string;
  readonly channelUrl?: string;
  readonly allowOverrides?: boolean;
  readonly allowInsecureHttpForTests?: boolean;
  readonly trustedReleaseKeys?: readonly TrustedReleaseKey[];
  readonly trustedKeysJson?: string;
  readonly resinHome?: string;
  readonly customHome?: string;
  readonly platform?: PlatformInfo | { os: string; arch: string; isWsl?: boolean };
  readonly fetchImpl?: typeof fetch;
  readonly dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  readonly fsBridge?: ConfigFsBridge;
  readonly healthCheckRunner?: HealthCheckRunner;
  readonly healthCheckTimeoutMs?: number;
  readonly healthCheckMaxOutputBytes?: number;
  readonly skipOnboarding?: boolean;
  readonly autoOnboard?: boolean;
  readonly isInteractive?: boolean;
  readonly localOnly?: boolean;
  readonly verbose?: boolean;
  readonly skipPathSetup?: boolean;
  readonly shell?: string;
  readonly onboardingRunner?: OnboardingRunner;
  readonly onboardingTimeoutMs?: number;
  readonly onboardingArgs?: readonly string[];
  readonly logger?: (message: string) => void;
  readonly env?: Record<string, string | undefined>;
  readonly sourceAssetBuffer?: Buffer;
  readonly sourceDenoBuffer?: Buffer;
  readonly now?: Date | string | number;
}

export interface BootstrapInstallResult {
  readonly success: boolean;
  readonly version: string;
  readonly previousVersion: string | null;
  readonly activePath: string;
  readonly resinHome: string;
  readonly platform: PlatformInfo | { os: string; arch: string; isWsl?: boolean };
  readonly release: {
    readonly channel: string;
    readonly version: string;
    readonly manifestSha256: string;
    readonly releaseAssetSha256: string;
    readonly signingKeyIds: readonly string[];
  };
  readonly healthCheck: HealthCheckResult;
  readonly pathConfig?: ShellPathConfigResult;
  readonly onboarding?: OnboardingResult;
  readonly reinstalled?: boolean;
  readonly rollback?: {
    readonly attempted: boolean;
    readonly restoredVersion?: string | null;
    readonly error?: string;
  };
}
/**
 * Default process-level health check executing `resin version`.
 * Enforces strict timeout (15s), maximum output cap (64 KiB), and catches process errors.
 */
export async function defaultHealthCheckRunner(
  cliPath: string,
  args: string[] = ["version"],
  options: HealthCheckRunnerOptions = {},
): Promise<HealthCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES;

  let child: child_process.ChildProcess;
  try {
    child = child_process.spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
    });
  } catch (err) {
    return {
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to spawn health check process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`,
      checkedPath: cliPath,
    };
  }

  let stdout = "";
  let stderr = "";
  let totalBytes = 0;
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  return new Promise<HealthCheckResult>((resolve) => {
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (result: HealthCheckResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({
        passed: false,
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: stderr
          ? `${stderr.trim()}\nHealth check timed out after ${timeoutMs}ms`
          : `Health check timed out after ${timeoutMs}ms`,
        timedOut: true,
        checkedPath: cliPath,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (totalBytes > maxOutputBytes) {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish({
          passed: false,
          exitCode: 1,
          stdout: stdout.slice(0, maxOutputBytes).trim(),
          stderr: `Health check output exceeded maximum size of ${maxOutputBytes} bytes`,
          outputOverflow: true,
          checkedPath: cliPath,
        });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (totalBytes > maxOutputBytes) {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish({
          passed: false,
          exitCode: 1,
          stdout: stdout.slice(0, maxOutputBytes).trim(),
          stderr: `Health check output exceeded maximum size of ${maxOutputBytes} bytes`,
          outputOverflow: true,
          checkedPath: cliPath,
        });
      }
    });

    child.on("error", (err) => {
      finish({
        passed: false,
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: err instanceof Error ? err.message : String(err),
        checkedPath: cliPath,
      });
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      finish({
        passed: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        checkedPath: cliPath,
      });
    });
  });
}
/**
 * Detects whether Resin is already initialized and configured on this machine.
 * Checks for existing device tokens, install journals, and credential stores.
 */
export async function isAlreadyInitialized(
  resinHome: string,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<boolean> {
  const candidatePaths = [
    path.join(resinHome, "state", "device-token.json"),
    path.join(resinHome, "state", "install-journal.json"),
    path.join(resinHome, "journal.json"),
  ];

  for (const candidate of candidatePaths) {
    try {
      if (await fsBridge.exists(candidate)) {
        return true;
      }
    } catch {
      // Ignore error probing candidate
    }
  }

  return false;
}

export interface DetectOnboardingSkipReasonOptions {
  readonly resinHome: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly env?: Record<string, string | undefined>;
  readonly isInteractive?: boolean;
  readonly skipOnboarding?: boolean;
  readonly autoOnboard?: boolean;
  readonly localOnly?: boolean;
  readonly platform?: PlatformInfo | { os: string; arch: string; isWsl?: boolean };
  readonly isRoot?: boolean;
  readonly getuid?: () => number | undefined;
}

/**
 * Evaluates whether automatic post-install onboarding should be skipped.
 * Returns a human-readable skip reason string, or null if onboarding should proceed.
 */
export async function detectOnboardingSkipReason(
  options: DetectOnboardingSkipReasonOptions,
): Promise<string | null> {
  if (options.skipOnboarding) {
    return "Explicitly skipped via skipOnboarding option";
  }
  if (options.autoOnboard === false) {
    return "Explicitly disabled via autoOnboard option";
  }

  const env = options.env ?? process.env;
  if (env.RESIN_NO_ONBOARD === "1" || env.RESIN_NO_ONBOARD === "true") {
    return "Disabled via RESIN_NO_ONBOARD environment variable";
  }
  if (env.RESIN_SKIP_ONBOARDING === "1" || env.RESIN_SKIP_ONBOARDING === "true") {
    return "Disabled via RESIN_SKIP_ONBOARDING environment variable";
  }
  if (options.isInteractive === false) {
    return "Explicitly marked non-interactive";
  }

  const ciVariables = [
    env.CI,
    env.CONTINUOUS_INTEGRATION,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.TRAVIS,
    env.CIRCLECI,
    env.JENKINS_URL,
  ];
  if (
    ciVariables.some(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value !== "0" &&
        value.toLowerCase() !== "false",
    )
  ) {
    return "CI environment detected";
  }
  if (
    env.DEBIAN_FRONTEND === "noninteractive" ||
    env.RESIN_NON_INTERACTIVE === "1" ||
    env.RESIN_NON_INTERACTIVE === "true"
  ) {
    return "Non-interactive environment detected";
  }

  const allowRoot = env.RESIN_ALLOW_ROOT === "1" || env.RESIN_ALLOW_ROOT === "true";
  const isRoot =
    options.isRoot ??
    (options.getuid !== undefined
      ? options.getuid() === 0
      : typeof process.getuid === "function"
        ? process.getuid() === 0
        : false);
  if (isRoot && !allowRoot) {
    return "Running in root/sudo context (avoiding root-owned browser launch or user config)";
  }

  // A missing TTY is a supported headless install, not a reason to stop. The child
  // init process prints its URL/code and polls until the browser approval completes.
  return null;
}

/**
 * Default process-level runner for invoking the newly installed Resin CLI's init/onboarding flow.
 */
export async function defaultOnboardingRunner(
  cliPath: string,
  args: string[] = ["init", "--auto-approve"],
  options: OnboardingRunnerOptions = {},
): Promise<OnboardingResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES;
  const interactive = options.interactive ?? Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
  const stdio: child_process.StdioOptions =
    options.stdio ?? (interactive ? "inherit" : ["ignore", "pipe", "pipe"]);

  let child: child_process.ChildProcess;
  try {
    child = child_process.spawn(cliPath, args, {
      stdio,
      env: { ...process.env, ...(options.env || {}) },
    });
  } catch (err) {
    return {
      attempted: true,
      skipped: false,
      success: false,
      exitCode: 1,
      error: `Failed to spawn onboarding process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  return new Promise<OnboardingResult>((resolve) => {
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (result: OnboardingResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 2000).unref();
        } catch {}

        finish({
          attempted: true,
          skipped: false,
          success: false,
          exitCode: 124,
          error: `Onboarding process timed out after ${timeoutMs}ms`,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const remainingBytes = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout));
        if (remainingBytes > 0) {
          stdout += Buffer.from(text).subarray(0, remainingBytes).toString("utf8");
        }
        if (text.length > 0) {
          options.logger?.(text.replace(/\n$/, ""));
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const remainingBytes = Math.max(0, maxOutputBytes - Buffer.byteLength(stderr));
        if (remainingBytes > 0) {
          stderr += Buffer.from(text).subarray(0, remainingBytes).toString("utf8");
        }
        if (text.length > 0) {
          options.logger?.(text.replace(/\n$/, ""));
        }
      });
    }

    child.on("error", (err) => {
      finish({
        attempted: true,
        skipped: false,
        success: false,
        exitCode: 1,
        error: `Failed to spawn onboarding process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      finish({
        attempted: true,
        skipped: false,
        success: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: exitCode === 0 ? undefined : `Onboarding process exited with code ${exitCode}`,
      });
    });
  });
}

/**
 * Resolves trusted release keys. Rejects ambient environment overrides;
 * custom release keys require explicit programmatic injection and opt-in.
 */
export function resolveTrustedReleaseKeys(options: BootstrapInstallOptions): TrustedReleaseKey[] {
  const isTestMode = Boolean(options.allowInsecureHttpForTests);
  const isOverrideAllowed = isTestMode || Boolean(options.allowOverrides);

  // If explicitly passed in programmatic options
  if (options.trustedReleaseKeys && options.trustedReleaseKeys.length > 0) {
    for (const key of options.trustedReleaseKeys) {
      if (REVOKED_RELEASE_KEY_IDS.includes(key.keyId)) {
        throw new Error(`Trusted release key '${key.keyId}' is revoked.`);
      }
    }
    if (!isOverrideAllowed) {
      throw new Error("Custom trusted release keys require explicit programmatic override opt-in.");
    }
    return [...options.trustedReleaseKeys];
  }

  // If passed as programmatic JSON override string
  const jsonOverride = options.trustedKeysJson;
  if (jsonOverride && jsonOverride.trim().length > 0) {
    if (!isOverrideAllowed) {
      throw new Error(
        "Custom trusted release keys JSON requires explicit programmatic override opt-in.",
      );
    }
    return parseTrustedKeysJsonOverride(jsonOverride.trim());
  }

  // Default to embedded production trust record
  return parseBundledReleaseTrust(PRODUCTION_RELEASE_TRUST_RECORD);
}

/**
 * Validates the release channel URL ensuring strict transport and override rules.
 */
export function validateChannelUrl(
  channelUrl: string,
  allowInsecureHttpForTests = false,
  isOverrideAllowed = false,
): string {
  let parsed: URL;
  try {
    parsed = new URL(channelUrl);
  } catch (err) {
    throw new Error(
      `Invalid release channel URL '${channelUrl}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isDefaultUrl = channelUrl === DEFAULT_PRODUCTION_CHANNEL_URL;
  if (!isDefaultUrl && !isOverrideAllowed) {
    throw new Error(
      `Custom release channel URL '${channelUrl}' requires explicit override opt-in.`,
    );
  }

  if (parsed.protocol === "http:") {
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("127.");

    if (!allowInsecureHttpForTests || !isLoopback) {
      throw new Error(
        `Insecure HTTP channel URL '${channelUrl}' is prohibited. HTTP is only permitted for local loopback test endpoints.`,
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol '${parsed.protocol}' in channel URL '${channelUrl}'. Expected https: (or http: for loopback tests).`,
    );
  }

  return channelUrl;
}

interface BootstrapActivationRollbackResult {
  restoredVersion: string | null;
  error?: string;
}

async function rollbackBootstrapActivation(options: {
  resinHome: string;
  previousActiveVersion: string | null;
  installedVersion: string;
  fsBridge: ConfigFsBridge;
  logger: (message: string) => void;
}): Promise<BootstrapActivationRollbackResult> {
  const { resinHome, previousActiveVersion, installedVersion, fsBridge, logger } = options;

  if (previousActiveVersion) {
    if (previousActiveVersion !== installedVersion) {
      try {
        await rollbackActiveVersion({
          resinHome,
          targetVersion: previousActiveVersion,
          fsBridge,
          logger,
        });
      } catch (error: unknown) {
        return {
          restoredVersion: getActiveVersion(resinHome),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const restoredVersion = getActiveVersion(resinHome);
    return restoredVersion === previousActiveVersion
      ? { restoredVersion }
      : {
          restoredVersion,
          error: `Rollback verification failed: expected v${previousActiveVersion}, found ${restoredVersion ? `v${restoredVersion}` : "no active version"}`,
        };
  }

  try {
    for (const candidate of [
      path.join(resinHome, "current"),
      path.join(resinHome, "current-version"),
      path.join(resinHome, "version-state.json"),
      path.join(resinHome, "bin", "resin"),
      path.join(resinHome, "bin", "resin-daemon"),
      path.join(resinHome, "bin", "resin-mcp"),
    ]) {
      if (await fsBridge.exists(candidate)) {
        await fsBridge.unlink(candidate);
      }
    }
  } catch (error: unknown) {
    return {
      restoredVersion: getActiveVersion(resinHome),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const restoredVersion = getActiveVersion(resinHome);
  return restoredVersion === null
    ? { restoredVersion }
    : {
        restoredVersion,
        error: `Fresh install rollback verification failed: active version remains v${restoredVersion}`,
      };
}

/**
 * Resolves candidate shell profile filenames and default profile based on shell name.
 */
export function resolveCandidateProfiles(shellName?: string): {
  candidates: readonly string[];
  defaultProfile: string;
} {
  const normShell = (shellName || "").toLowerCase();
  if (normShell === "zsh") {
    return {
      candidates: [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".profile"],
      defaultProfile: ".zshrc",
    };
  }
  if (normShell === "bash") {
    return {
      candidates: [".bashrc", ".bash_profile", ".bash_login", ".profile"],
      defaultProfile: ".bashrc",
    };
  }
  return {
    candidates: [".profile", ".bashrc", ".zshrc"],
    defaultProfile: ".profile",
  };
}

/**
 * Safely and idempotently configures ~/.resin/bin in the user's shell profile for POSIX environments.
 */
export async function configureShellPath(
  options: ShellPathConfigOptions,
): Promise<ShellPathConfigResult> {
  const env = options.env ?? process.env;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const isPosix = options.isPosix ?? process.platform !== "win32";
  const resinHome = path.resolve(options.resinHome);
  const binDir = path.join(resinHome, "bin");
  const homeDir = path.resolve(options.homeDir ?? env.HOME ?? os.homedir());

  if (!isPosix) {
    return {
      attempted: false,
      updated: false,
      alreadyConfigured: false,
      binDir,
      reason: "non-posix",
    };
  }

  const shellRaw = options.shell ?? env.SHELL ?? "";
  const shellName = path.basename(shellRaw).toLowerCase();
  const { candidates, defaultProfile } = resolveCandidateProfiles(shellName);

  // Format the PATH line
  let pathLine: string;
  const defaultResinHome = path.join(homeDir, ".resin");
  if (resinHome === defaultResinHome) {
    pathLine = 'export PATH="$HOME/.resin/bin:$PATH"';
  } else if (resinHome.startsWith(homeDir + path.sep)) {
    const rel = path.relative(homeDir, binDir).split(path.sep).join("/");
    pathLine = `export PATH="$HOME/${rel}:$PATH"`;
  } else {
    pathLine = `export PATH="${binDir}:$PATH"`;
  }

  // Check if any candidate profile already contains Resin PATH configuration
  for (const candidate of candidates) {
    const fullCandidatePath = path.join(homeDir, candidate);
    try {
      if (await fsBridge.exists(fullCandidatePath)) {
        const content = await fsBridge.readFile(fullCandidatePath);
        if (
          content !== null &&
          (content.includes(".resin/bin") || content.includes(binDir) || content.includes(pathLine))
        ) {
          const profileName = `~/${candidate}`;
          return {
            attempted: true,
            updated: false,
            alreadyConfigured: true,
            profilePath: fullCandidatePath,
            profileName,
            shell: shellName || undefined,
            binDir,
            pathLine,
            reloadCommand: `source ${profileName}`,
          };
        }
      }
    } catch {
      // Ignore read errors on non-critical candidates and continue
    }
  }

  // Determine target profile: first existing candidate, or defaultProfile if none exist
  let targetFile: string | undefined;
  for (const candidate of candidates) {
    const fullCandidatePath = path.join(homeDir, candidate);
    try {
      if (await fsBridge.exists(fullCandidatePath)) {
        targetFile = candidate;
        break;
      }
    } catch {
      // Ignore
    }
  }

  if (!targetFile) {
    targetFile = defaultProfile;
  }

  const targetFullPath = path.join(homeDir, targetFile);
  const profileName = `~/${targetFile}`;
  const reloadCommand = `source ${profileName}`;

  try {
    let newContent = "";
    if (await fsBridge.exists(targetFullPath)) {
      const existing = await fsBridge.readFile(targetFullPath);
      if (
        existing !== null &&
        (existing.includes(".resin/bin") ||
          existing.includes(binDir) ||
          existing.includes(pathLine))
      ) {
        return {
          attempted: true,
          updated: false,
          alreadyConfigured: true,
          profilePath: targetFullPath,
          profileName,
          shell: shellName || undefined,
          binDir,
          pathLine,
          reloadCommand,
        };
      }
      const existingContent = existing ?? "";
      const needsNewline = existingContent.length > 0 && !existingContent.endsWith("\n");
      newContent = `${existingContent + (needsNewline ? "\n" : "") + pathLine}\n`;
    } else {
      newContent = `${pathLine}\n`;
    }

    await fsBridge.writeFile(targetFullPath, newContent);

    return {
      attempted: true,
      updated: true,
      alreadyConfigured: false,
      profilePath: targetFullPath,
      profileName,
      shell: shellName || undefined,
      binDir,
      pathLine,
      reloadCommand,
    };
  } catch (error) {
    return {
      attempted: true,
      updated: false,
      alreadyConfigured: false,
      profilePath: targetFullPath,
      profileName,
      shell: shellName || undefined,
      binDir,
      pathLine,
      reloadCommand,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Executes standalone bootstrap installation.
 */
export async function bootstrapInstall(
  options: BootstrapInstallOptions = {},
): Promise<BootstrapInstallResult> {
  const env = options.env ?? process.env;
  const log = options.logger ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const fsBridge = options.fsBridge ?? defaultFsBridge;

  const isVerbose = Boolean(
    options.verbose || env.RESIN_VERBOSE === "1" || env.RESIN_VERBOSE === "true",
  );
  const logVerbose = (msg: string) => {
    if (isVerbose) log(msg);
  };

  const isTestMode = Boolean(options.allowInsecureHttpForTests);
  const isOverrideAllowed = isTestMode || Boolean(options.allowOverrides);

  // Step 1: Detect and validate platform BEFORE ANY filesystem mutation
  logVerbose("==> Detecting and validating target platform...");
  let platformInfo: PlatformInfo;
  if (
    options.platform &&
    "isSupported" in options.platform &&
    typeof options.platform.isSupported === "boolean"
  ) {
    platformInfo = options.platform;
  } else if (options.platform) {
    const p = options.platform;
    const normalizedArch = p.arch === "x86_64" ? "x64" : p.arch === "aarch64" ? "arm64" : p.arch;
    const isWslRequested = Boolean(p.isWsl) || p.os === "wsl";
    platformInfo = detectPlatform({
      platform: (p.os === "wsl" ? "linux" : p.os) as NodeJS.Platform,
      arch: normalizedArch,
      env: options.env
        ? {
            ...process.env,
            ...options.env,
            RESIN_IS_WSL: isWslRequested ? "1" : options.env.RESIN_IS_WSL,
          }
        : process.env,
    });
  } else {
    platformInfo = detectPlatform();
  }

  if (!platformInfo.isSupported) {
    throw new UnsupportedPlatformError(platformInfo.platform, {
      arch: platformInfo.arch,
      nodeVersion: platformInfo.nodeVersion,
      isWsl: platformInfo.isWsl,
    });
  }

  const homeDir = options.customHome ?? env.HOME ?? os.homedir();
  const resinHome = options.resinHome ?? env.RESIN_HOME ?? path.join(homeDir, ".resin");
  const downloadsDir = path.join(resinHome, "downloads");
  const previousActiveVersion = getActiveVersion(resinHome);

  // Step 2: Resolve release metadata via channel document and pinned trust root
  const channel = options.channel ?? "stable";
  const channelUrl = validateChannelUrl(
    options.channelUrl ?? DEFAULT_PRODUCTION_CHANNEL_URL,
    isTestMode,
    isOverrideAllowed,
  );

  const trustedReleaseKeys = resolveTrustedReleaseKeys(options);

  logVerbose(`==> Resolving release metadata from channel '${channel}' via ${channelUrl}...`);
  const release = await resolveProductionRelease({
    platform: platformInfo,
    channel,
    channelUrl,
    trustedReleaseKeys,
    allowInsecureHttpForTests: isTestMode,
    fetchImpl: options.fetchImpl,
    dnsLookup: options.dnsLookup,
    currentInstalledVersion: previousActiveVersion ?? undefined,
    currentActiveVersion: previousActiveVersion ?? undefined,
    now: options.now,
  });

  logVerbose(
    `Resolved release version v${release.version} (asset: ${release.releaseAsset.filename})`,
  );

  // Step 4: Fetch bytes using hardened pinned transport for release asset with strict size caps
  logVerbose(`==> Fetching release asset from ${release.releaseAssetUrl}...`);
  let releaseBuffer: Buffer;
  if (options.sourceAssetBuffer) {
    releaseBuffer = options.sourceAssetBuffer;
  } else {
    releaseBuffer = await fetchBytes(release.releaseAssetUrl, {
      fetchImpl: options.fetchImpl,
      dnsLookup: options.dnsLookup,
      allowInsecureHttpForTests: isTestMode,
      exactSizeBytes: release.releaseAsset.sizeBytes,
      maxSizeBytes: release.releaseAsset.sizeBytes ?? MAX_RELEASE_ASSET_HARD_CAP_BYTES,
    });
  }

  // Download & verify release asset (size and SHA-256 digest)
  logVerbose(`==> Verifying release asset '${release.releaseAsset.filename}'...`);
  const downloadedRelease = await downloadAndVerifyAsset({
    asset: release.releaseAsset,
    downloadDir: downloadsDir,
    sourceBuffer: releaseBuffer,
    fsBridge,
    logger: isVerbose ? log : undefined,
  });
  // Verify size explicitly if declared in asset
  if (release.releaseAsset.sizeBytes !== undefined) {
    if (downloadedRelease.sizeBytes !== release.releaseAsset.sizeBytes) {
      throw new Error(
        `Release asset size mismatch: expected ${release.releaseAsset.sizeBytes} bytes, got ${downloadedRelease.sizeBytes} bytes.`,
      );
    }
  }

  // Step 5: Deno runtime asset fetch & verification if required
  let downloadedDeno: DownloadedAssetResult | undefined;
  if (release.denoAsset) {
    logVerbose(`==> Fetching required Deno runtime (${release.denoAsset.version})...`);
    let denoBuffer: Buffer;
    if (options.sourceDenoBuffer) {
      denoBuffer = options.sourceDenoBuffer;
    } else {
      denoBuffer = await fetchBytes(release.denoAsset.url, {
        fetchImpl: options.fetchImpl,
        dnsLookup: options.dnsLookup,
        allowInsecureHttpForTests: isTestMode,
        exactSizeBytes: release.denoAsset.sizeBytes,
        maxSizeBytes: release.denoAsset.sizeBytes ?? 64 * 1024 * 1024,
      });
    }

    const denoFilename =
      release.denoAsset.filename || path.basename(new URL(release.denoAsset.url).pathname);
    const denoAssetObj: ManifestAsset = {
      filename: denoFilename,
      platform: platformInfo.os,
      arch: platformInfo.arch,
      isWsl: platformInfo.isWsl,
      sizeBytes: release.denoAsset.sizeBytes,
      sha256: release.denoAsset.sha256,
      path: denoFilename,
      url: release.denoAsset.url,
    };

    logVerbose(`==> Verifying Deno runtime package '${denoAssetObj.filename}'...`);
    downloadedDeno = await downloadAndVerifyAsset({
      asset: denoAssetObj,
      downloadDir: downloadsDir,
      sourceBuffer: denoBuffer,
      fsBridge,
      logger: isVerbose ? log : undefined,
    });
  }

  // Step 6: Atomic version extraction & installation into versioned tree
  logVerbose(`==> Installing release v${release.version} into ${resinHome}...`);
  const installResult: VersionInstallResult = await installReleaseVersion({
    resinHome,
    version: release.version,
    tarballPathOrBuffer: downloadedRelease.path,
    denoRuntime:
      downloadedDeno && release.denoAsset
        ? {
            archivePathOrBuffer: downloadedDeno.path,
            version: release.denoAsset.version,
            sha256: release.denoAsset.sha256,
            executable: release.denoAsset.executable,
          }
        : undefined,
    provenance: release.provenance,
    fsBridge,
    logger: isVerbose ? log : undefined,
  });
  // Step 7: Atomic version switch
  logVerbose(`==> Activating version v${release.version}...`);
  const switchResult = await switchActiveVersion({
    resinHome,
    targetVersion: release.version,
    fsBridge,
    logger: isVerbose ? log : undefined,
  });
  // Step 8: Run health check on newly installed version via public bin path
  logVerbose("==> Running health check on active version via public bin path...");
  const publicBinPath = path.join(resinHome, "bin", "resin");
  const checkPath = (await fsBridge.exists(publicBinPath))
    ? publicBinPath
    : installResult.entryPoints.cli;

  const healthRunner = options.healthCheckRunner ?? defaultHealthCheckRunner;
  let healthCheck: HealthCheckResult;
  try {
    healthCheck = await healthRunner(checkPath, ["version"], {
      timeoutMs: options.healthCheckTimeoutMs,
      maxOutputBytes: options.healthCheckMaxOutputBytes,
      env: options.env,
    });
  } catch (error) {
    healthCheck = {
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: `Health check threw exception: ${error instanceof Error ? error.message : String(error)}`,
      checkedPath: checkPath,
    };
  }

  // Step 9: Verify health check or execute transactional rollback
  if (!healthCheck.passed) {
    log(
      `✖ Health check failed: ${healthCheck.stderr || healthCheck.stdout || `exit code ${healthCheck.exitCode ?? 1}`}. Initiating rollback transaction...`,
    );
    const rollback = await rollbackBootstrapActivation({
      resinHome,
      previousActiveVersion,
      installedVersion: release.version,
      fsBridge,
      logger: log,
    });
    const failureReason = healthCheck.timedOut
      ? "health check timed out"
      : healthCheck.outputOverflow
        ? "health check output overflowed"
        : `health check exited with code ${healthCheck.exitCode ?? 1}`;
    const rollbackDetail = rollback.error ? ` Rollback error: ${rollback.error}.` : "";

    throw new Error(
      `Installation health check failed (${failureReason}): ${healthCheck.stderr || healthCheck.stdout || "unknown error"}. Active version rolled back to ${rollback.restoredVersion ?? "none"}.${rollbackDetail}`,
    );
  }

  log(`✔ Verified Resin v${release.version} for ${platformInfo.platform}`);
  log(`✔ Installed Resin v${release.version} (${checkPath})`);

  // Step 9.5: Shell PATH configuration for POSIX environments
  let pathConfig: ShellPathConfigResult | undefined;
  if (!options.skipPathSetup) {
    pathConfig = await configureShellPath({
      resinHome,
      homeDir: options.customHome,
      shell: options.shell,
      env,
      fsBridge,
      logger: log,
    });
    if (pathConfig.updated) {
      const displayHome = path.resolve(options.customHome ?? env.HOME ?? os.homedir());
      const displayBin =
        resinHome === path.join(displayHome, ".resin")
          ? "~/.resin/bin"
          : path.join(resinHome, "bin");
      log(`✔ Added ${displayBin} to PATH in ${pathConfig.profileName}`);
    } else if (pathConfig.alreadyConfigured && isVerbose) {
      log(`ℹ PATH is already configured (${pathConfig.profileName || "active environment"})`);
    } else if (pathConfig.error) {
      log(`⚠ Could not update ${pathConfig.profileName}: ${pathConfig.error}`);
    }
  }

  // Step 10: Automatic Browser Authorization, Harness Setup, and Daemon Verification
  let onboardingResult: OnboardingResult | undefined;
  const localOnly =
    options.localOnly || env.RESIN_LOCAL_ONLY === "1" || env.RESIN_LOCAL_ONLY === "true";
  const skipReason = await detectOnboardingSkipReason({
    resinHome,
    fsBridge,
    env,
    isInteractive: options.isInteractive,
    skipOnboarding: options.skipOnboarding,
    autoOnboard: options.autoOnboard,
  });

  if (skipReason) {
    logVerbose(`ℹ Skipping automatic onboarding: ${skipReason}`);
    onboardingResult = {
      attempted: false,
      skipped: true,
      skipReason,
    };
  } else {
    logVerbose("==> Authorizing this device, configuring detected editors, and starting Resin...");
    const onboardingRunner = options.onboardingRunner ?? defaultOnboardingRunner;
    const onboardingArgs = options.onboardingArgs
      ? [...options.onboardingArgs]
      : ["init", "--auto-approve", ...(localOnly ? ["--local-only"] : [])];

    try {
      onboardingResult = await onboardingRunner(checkPath, onboardingArgs, {
        timeoutMs: options.onboardingTimeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS,
        env: options.env,
        interactive: options.isInteractive,
        logger: isVerbose ? log : undefined,
      });
    } catch (error: unknown) {
      onboardingResult = {
        attempted: true,
        skipped: false,
        success: false,
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!onboardingResult.success) {
      const detail =
        onboardingResult.error ||
        onboardingResult.stderr ||
        `exit code ${onboardingResult.exitCode ?? 1}`;
      log(`✖ Automatic onboarding did not complete (${detail}). Rolling back activation...`);
      const rollback = await rollbackBootstrapActivation({
        resinHome,
        previousActiveVersion,
        installedVersion: release.version,
        fsBridge,
        logger: log,
      });
      const rollbackDetail = rollback.error ? ` Rollback error: ${rollback.error}.` : "";
      throw new Error(
        `Automatic onboarding failed: ${detail}. Active version restored to ${rollback.restoredVersion ?? "none"}.${rollbackDetail} Rerun the same installer to resume; no separate Resin command is required.`,
      );
    }

    log("✔ Device authorization, editor configuration, and daemon verification completed.");
  }

  // Completion guidance
  if (pathConfig?.updated && pathConfig.reloadCommand) {
    log(`\nTo get started, reload your shell or run:\n  ${pathConfig.reloadCommand}\n  resin`);
  } else {
    log("\nRun 'resin' to get started.");
  }

  return {
    success: true,
    version: release.version,
    previousVersion: previousActiveVersion,
    activePath: switchResult.activePath,
    resinHome,
    platform: platformInfo,
    release: {
      channel,
      version: release.version,
      manifestSha256: release.provenance.manifestSha256,
      releaseAssetSha256: release.provenance.releaseAssetSha256,
      signingKeyIds: release.provenance.signingKeyIds,
    },
    healthCheck,
    pathConfig,
    onboarding: onboardingResult,
    reinstalled: installResult.installedFiles.length === 0,
  };
}

/**
 * Checks whether the current module was executed directly as the main CLI entrypoint.
 * Uses canonical pathToFileURL comparison to correctly handle spaces, unicode, and URL-escaped paths.
 */
export function isMainModule(metaUrl: string = import.meta.url, argv1?: string): boolean {
  const targetPath =
    argv1 ?? (typeof process !== "undefined" && process.argv ? process.argv[1] : undefined);
  if (!targetPath) return false;
  try {
    const resolvedPath = path.resolve(targetPath);
    const expectedUrl = pathToFileURL(resolvedPath).href;
    return metaUrl === expectedUrl;
  } catch {
    return false;
  }
}

/**
 * CLI Runner for standalone invocation.
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  let channel: string | undefined;
  let channelUrl: string | undefined;
  let resinHome: string | undefined;
  let allowInsecureLoopback = false;
  let skipOnboarding = false;
  let autoOnboard: boolean | undefined;
  let localOnly = false;
  let isInteractive: boolean | undefined;
  let verbose = false;
  let skipPathSetup = false;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--no-path-update" || arg === "--skip-path-setup") {
      skipPathSetup = true;
    } else if (arg === "--channel") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for argument: --channel");
      }
      channel = argv[++i];
    } else if (arg.startsWith("--channel=")) {
      const val = arg.slice("--channel=".length);
      if (!val) throw new Error("Missing value for argument: --channel");
      channel = val;
    } else if (arg === "--channel-url") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for argument: --channel-url");
      }
      channelUrl = argv[++i];
    } else if (arg.startsWith("--channel-url=")) {
      const val = arg.slice("--channel-url=".length);
      if (!val) throw new Error("Missing value for argument: --channel-url");
      channelUrl = val;
    } else if (arg === "--resin-home" || arg === "--home") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(`Missing value for argument: ${arg}`);
      }
      resinHome = argv[++i];
    } else if (arg.startsWith("--resin-home=")) {
      const val = arg.slice("--resin-home=".length);
      if (!val) throw new Error("Missing value for argument: --resin-home");
      resinHome = val;
    } else if (arg.startsWith("--home=")) {
      const val = arg.slice("--home=".length);
      if (!val) throw new Error("Missing value for argument: --home");
      resinHome = val;
    } else if (arg === "--no-onboarding" || arg === "--skip-onboarding") {
      skipOnboarding = true;
    } else if (arg === "--auto-onboard") {
      autoOnboard = true;
    } else if (arg === "--local-only") {
      localOnly = true;
    } else if (arg === "--non-interactive") {
      isInteractive = false;
    } else if (arg === "--allow-insecure-loopback") {
      allowInsecureLoopback = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (help) {
    process.stderr.write(`Resin Standalone Bootstrap Installer
Usage:
  node install-helper-v1.mjs [options]

Options:
  --channel <name>           Release channel to install (default: stable)
  --channel-url <url>        Custom channel metadata URL (for staging or air-gapped testing)
  --resin-home, --home <dir> Custom Resin installation directory (default: ~/.resin)
  -v, --verbose              Enable detailed progress logs
  --no-path-update           Do not configure PATH in shell profiles
  --json                     Output structured JSON result on stdout
  --no-onboarding            Skip automatic onboarding and device linking
  --auto-onboard             Explicitly enable onboarding (CI safety checks still apply)
  --local-only               Skip cloud pairing and configure local-only MCP
  --non-interactive          Disable interactive prompts and onboarding
  --allow-insecure-loopback  Allow HTTP on loopback for testing
  --help, -h                 Show this help message
`);
    process.exit(0);
  }

  try {
    const result = await bootstrapInstall({
      channel,
      channelUrl,
      resinHome,
      skipOnboarding,
      autoOnboard,
      localOnly,
      isInteractive,
      verbose,
      skipPathSetup,
      allowInsecureHttpForTests: allowInsecureLoopback,
      allowOverrides: channelUrl !== undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Installation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1] &&
  isMainModule(import.meta.url, process.argv[1])
) {
  runCli().catch((err) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
