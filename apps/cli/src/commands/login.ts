import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { resolvePaths } from "@resin/observer/client";
import type { InstallerPairingMutation } from "../installer/installer.js";
import { isWslEnvironment } from "../platform/platform.js";
import {
  DEFAULT_CLOUD_URL,
  DeviceAuthClient,
  isReusableCredentialRecord,
  validateCloudUrl,
} from "../service/auth-bootstrap.js";
import {
  type ServiceStatusInfo,
  type UserServiceManager,
  createUserServiceManager,
  isStaleSupervisorUnitContent,
} from "../service/manager.js";
import {
  type DaemonReadinessResult,
  type DaemonReadinessVerifier,
  verifyDaemonReadiness,
} from "../service/verification.js";

export { validateCloudUrl, isReusableCredentialRecord } from "../service/auth-bootstrap.js";

export type BrowserLauncher = (url: string) => Promise<boolean> | boolean;

export type DaemonRefreshStatus = "refreshed" | "not_running" | "externally_managed" | "failed";

export type DaemonRefreshFailureStage = "status" | "restart" | "readiness";

export interface DaemonRefreshResult {
  status: DaemonRefreshStatus;
  stage?: DaemonRefreshFailureStage;
  message: string;
}
function runBrowserLauncher(command: string, args: string[]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      resolve(false);
      try {
        child.kill("SIGKILL");
      } catch {
        // Dispatch remains best-effort even if the launcher cannot be killed.
      }
    }, 10_000);
    const done = (success: boolean) => {
      clearTimeout(timeout);
      resolve(success);
    };
    child.once("error", () => done(false));
    // Starting a process is not evidence that the OS accepted the URL.
    child.once("close", (code, signal) => done(code === 0 && signal === null));
  } catch {
    resolve(false);
  }
  return promise;
}

export async function defaultOpenBrowser(url: string): Promise<boolean> {
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;

    const platform = process.platform;
    const isWsl = platform === "linux" && isWslEnvironment();
    if (platform === "win32" || isWsl) {
      // Keep the URL out of PowerShell syntax (and away from cmd.exe's
      // metacharacter expansion). Only base64 data enters this fixed script.
      const encodedUrl = Buffer.from(url, "utf8").toString("base64");
      const script = `$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}')); try { Start-Process -FilePath $url -ErrorAction Stop; exit 0 } catch { exit 1 }`;
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ];
      const commands = ["powershell.exe"];
      if (isWsl) {
        // WSL can disable appending the Windows PATH without disabling interop.
        commands.push("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
      } else if (process.env.SystemRoot) {
        commands.push(
          path.win32.join(
            process.env.SystemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
        );
      }
      for (const command of commands) {
        if (await runBrowserLauncher(command, args)) return true;
      }
      if (!isWsl) return false;
    }

    return await runBrowserLauncher(platform === "darwin" ? "open" : "xdg-open", [url]);
  } catch {
    return false;
  }
}

export interface LoginCommandFlags {
  cloudUrl?: string;
  deviceId?: string;
  installationId?: string;
  accountId?: string;
  workspaceId?: string;
  home?: string;
  resinHome?: string;
  tokenFile?: string;
  noBrowser?: boolean;
  json?: boolean;
  force?: boolean;
  help?: boolean;
}

export interface LoginSuccessResult {
  type: "success";
  success: true;
  deviceId: string;
  workspaceId: string;
  accountId?: string;
  userId?: string;
  storedInSecretStore: boolean;
  tokenFilePath?: string;
  daemonRefresh: DaemonRefreshResult;
}

export interface LoginCommandOptions {
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  fsBridge?: ConfigFsBridge;
  serviceManager?: UserServiceManager;
  readinessVerifier?: DaemonReadinessVerifier;
}

export interface PerformPairingOptions {
  cloudUrl?: string;
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
  accountId?: string;
  workspaceId?: string;
  deviceId?: string;
  installationId?: string;
  json?: boolean;
  nonInteractive?: boolean;
  noBrowser?: boolean;
  force?: boolean;
  restartService?: boolean;
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  fsBridge?: ConfigFsBridge;
  serviceManager?: UserServiceManager;
  readinessVerifier?: DaemonReadinessVerifier;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  stdout?: { write(chunk: string): boolean | undefined };
}

interface ResolvedLoginPaths {
  home: string;
  resinHome: string;
  tokenFilePath: string;
  daemonTokenFilePath: string;
}

function resolveLoginPaths(options: {
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
}): ResolvedLoginPaths {
  const home = options.home
    ? path.resolve(options.home)
    : path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir());
  const paths = resolvePaths({
    home: options.home ? home : undefined,
    resinHome: options.resinHome,
    env: process.env,
  });
  const daemonTokenFilePath = path.join(paths.stateDir, "device-token.json");
  return {
    home,
    resinHome: paths.homeDir,
    tokenFilePath: options.tokenFilePath
      ? path.resolve(options.tokenFilePath)
      : daemonTokenFilePath,
    daemonTokenFilePath,
  };
}

function failedDaemonRefresh(
  stage: DaemonRefreshFailureStage,
  message: string,
): DaemonRefreshResult {
  return { status: "failed", stage, message };
}

const EXTERNAL_DAEMON_REFRESH_MESSAGE =
  "Credentials were saved, but daemon service management is external. Restart the foreground daemon through your supervisor, then verify it with `resin status`.";

async function refreshDaemonAfterCredentials(options: {
  home: string;
  resinHome: string;
  tokenFilePath: string;
  daemonTokenFilePath: string;
  cloudIdentity: {
    cloudUrl: string;
    accountId: string;
    workspaceId: string;
    deviceId: string;
    userId?: string;
  };
  fsBridge?: ConfigFsBridge;
  serviceManager?: UserServiceManager;
  readinessVerifier?: DaemonReadinessVerifier;
}): Promise<DaemonRefreshResult> {
  if (process.env.RESIN_NO_SERVICE === "1") {
    return { status: "externally_managed", message: EXTERNAL_DAEMON_REFRESH_MESSAGE };
  }

  let serviceManager: UserServiceManager;
  try {
    serviceManager =
      options.serviceManager ??
      createUserServiceManager({
        homeDir: options.home,
        resinHome: options.resinHome,
        fsBridge: options.fsBridge,
      });
  } catch {
    return failedDaemonRefresh(
      "status",
      "Credentials were saved, but the daemon service could not be inspected. Restart it through your service supervisor, then verify it with `resin status`.",
    );
  }

  if (serviceManager.platform === "external") {
    return { status: "externally_managed", message: EXTERNAL_DAEMON_REFRESH_MESSAGE };
  }

  let status: ServiceStatusInfo;
  try {
    status = await serviceManager.status();
  } catch {
    return failedDaemonRefresh(
      "status",
      "Credentials were saved, but the daemon service status could not be checked. Restart it through your service supervisor, then verify it with `resin status`.",
    );
  }

  if (status.state === "externally_managed") {
    return { status: "externally_managed", message: EXTERNAL_DAEMON_REFRESH_MESSAGE };
  }

  if (!status.installed || !(status.active || status.state === "running")) {
    return {
      status: "not_running",
      message:
        "Credentials were saved, but no installed active Resin daemon service was found. Start the daemon through your service supervisor, then verify it with `resin status`.",
    };
  }

  if (path.resolve(options.tokenFilePath) !== path.resolve(options.daemonTokenFilePath)) {
    return failedDaemonRefresh(
      "readiness",
      "Credentials were saved outside the daemon's configured credential path, so daemon refresh was not verified. Configure the daemon to use that credential path, then restart it through your service supervisor.",
    );
  }
  if (status.unitPath) {
    try {
      const fsBridge = options.fsBridge ?? defaultFsBridge;
      const onDiskUnit = await fsBridge.readFile(status.unitPath);
      const expectedUnit = serviceManager.getUnitDefinition({
        homeDir: options.home,
        resinHome: options.resinHome,
      });
      if (isStaleSupervisorUnitContent(onDiskUnit, expectedUnit)) {
        return failedDaemonRefresh(
          "status",
          "Credentials were saved, but the installed daemon service configuration does not match this Resin installation. Check the selected Resin home and service configuration before retrying `resin login`.",
        );
      }
    } catch {
      return failedDaemonRefresh(
        "status",
        "Credentials were saved, but the daemon service configuration could not be inspected safely. Check service file permissions and the selected Resin home before retrying `resin login`.",
      );
    }
  }

  const startedAfter = Date.now();
  try {
    await serviceManager.restart();
  } catch {
    return failedDaemonRefresh(
      "restart",
      "Credentials were saved, but the active Resin daemon could not be restarted. Restart it through your service supervisor, then verify it with `resin status`.",
    );
  }

  let readiness: DaemonReadinessResult;
  try {
    const readinessVerifier = options.readinessVerifier ?? verifyDaemonReadiness;
    readiness = await readinessVerifier({
      homeDir: options.home,
      resinHome: options.resinHome,
      fsBridge: options.fsBridge,
      cloudRequired: true,
      expectedCloudIdentity: options.cloudIdentity,
      startedAfter,
    });
  } catch {
    return failedDaemonRefresh(
      "readiness",
      "The Resin daemon was restarted, but readiness could not be verified with the saved Cloud credentials. Upgrade or restart the daemon, then retry `resin login` and check `resin status`.",
    );
  }

  if (!readiness.ready) {
    return failedDaemonRefresh(
      "readiness",
      "The Resin daemon was restarted, but it did not become ready with the saved Cloud credentials. Upgrade or restart the daemon, then retry `resin login` and check `resin status`.",
    );
  }

  return {
    status: "refreshed",
    message: "The Resin daemon was restarted and verified with the saved Cloud credentials.",
  };
}
/**
 * 1. Checks and reuses valid pre-provisioned credentials if not forcing fresh auth.
 * 2. In non-interactive mode without reusable credentials, fails truthfully.
 * 3. In interactive mode, attempts to open verification URI in browser first,
 *    prints safe instructions (never printing tokens), and polls for approval.
 * 4. Snapshots prior credentials so rollback can restore or purge safely.
 */
export async function performPairing(
  options: PerformPairingOptions = {},
): Promise<InstallerPairingMutation & { daemonRefresh?: DaemonRefreshResult }> {
  const cloudUrl = validateCloudUrl(
    options.cloudUrl ?? process.env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL,
  );
  const resolvedPaths = resolveLoginPaths({
    home: options.home,
    resinHome: options.resinHome,
    tokenFilePath: options.tokenFilePath,
  });
  const { home, resinHome, tokenFilePath, daemonTokenFilePath } = resolvedPaths;

  const authClient = new DeviceAuthClient({
    cloudUrl,
    customFetch: options.customFetch,
    home,
    resinHome,
    tokenFilePath,
  });

  const priorSnapshot = await authClient.snapshotCredentials();

  if (!options.force && isReusableCredentialRecord(priorSnapshot, cloudUrl)) {
    const claims = priorSnapshot.claims;
    // Requested IDs are pairing hints, never authority for the authenticated identity.
    const accountId = claims.accountId;
    const workspaceId = claims.workspaceId;
    const deviceId = claims.deviceId;
    const userId = claims.userId ?? claims.subject;

    return {
      paired: true,
      localOnly: false,
      reused: true,
      accountId,
      workspaceId,
      deviceId,
      userId,
      cloudUrl,
      rollback: async () => {
        if (priorSnapshot) {
          await authClient.restoreCredentials(priorSnapshot);
        } else {
          await authClient.purgeCredentials();
        }
      },
    };
  }

  if (options.nonInteractive) {
    throw new Error(
      "Non-interactive init requires valid pre-provisioned credentials or --local-only",
    );
  }

  const openBrowserFn = options.openBrowser ?? defaultOpenBrowser;

  const result = await authClient.bootstrap({
    interactive: true,
    deviceId: options.deviceId,
    installationId: options.installationId,
    workspaceId: options.workspaceId,
    onUserCodeReceived: async (info) => {
      if (options.json) {
        writeJson({
          type: "verification",
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          verificationUriComplete: info.verificationUriComplete,
          expiresIn: info.expiresIn,
        });
        return;
      }

      const targetUrl = info.verificationUriComplete || info.verificationUri;
      let browserOpened = false;
      if (!options.noBrowser) {
        try {
          browserOpened = await openBrowserFn(targetUrl);
        } catch {
          // Browser launch is best-effort; the URL and code below are authoritative.
        }
      }

      const stdout = options.stdout ?? process.stdout;
      stdout.write(
        browserOpened
          ? "\nA browser window was opened for Resin authorization.\n"
          : "\nA browser could not be opened automatically. Continue on any browser:\n",
      );
      stdout.write(`1. Navigate to: ${targetUrl}\n`);
      stdout.write(`2. Enter code:   ${info.userCode}\n\n`);
      stdout.write(
        "Keep this installer open. Setup continues automatically after authorization.\n",
      );
    },
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal,
  });

  if (!result.success) {
    throw new Error(result.error ?? "Device authentication bootstrap failed");
  }

  const accountId = result.claims.accountId;
  const workspaceId = result.claims.workspaceId;
  const deviceId = result.claims.deviceId;
  const userId = result.claims.userId ?? result.claims.subject;
  let daemonRefresh: DaemonRefreshResult | undefined;
  if (options.restartService !== false) {
    try {
      daemonRefresh = await refreshDaemonAfterCredentials({
        home,
        resinHome,
        tokenFilePath,
        daemonTokenFilePath,
        cloudIdentity: {
          cloudUrl,
          accountId,
          workspaceId,
          deviceId,
          userId,
        },
        fsBridge: options.fsBridge,
        serviceManager: options.serviceManager,
        readinessVerifier: options.readinessVerifier,
      });
    } catch {
      daemonRefresh = failedDaemonRefresh(
        "status",
        "Credentials were saved, but daemon refresh could not be completed. Restart it through your service supervisor, then verify it with `resin status`.",
      );
    }

    if (daemonRefresh.status === "failed") {
      if (options.json) {
        writeJson({
          type: "error",
          success: false,
          authenticationSucceeded: true,
          error: daemonRefresh.message,
          daemonRefresh,
        });
      } else {
        (options.stdout ?? process.stderr).write(
          `\nDaemon refresh failed (${daemonRefresh.stage ?? "unknown"}): ${daemonRefresh.message}\n`,
        );
      }
    }
  }

  return {
    paired: true,
    localOnly: false,
    reused: false,
    accountId,
    workspaceId,
    deviceId,
    userId,
    cloudUrl,
    rollback: async () => {
      try {
        await authClient.revokeToken({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          claims: result.claims,
          cloudUrl,
          deviceId: result.deviceId,
        });
      } catch {
        // Best-effort remote revocation must not block local restore/purge
      }

      if (priorSnapshot) {
        await authClient.restoreCredentials(priorSnapshot);
      } else {
        await authClient.purgeCredentials();
      }
    },
    daemonRefresh,
  };
}

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseLoginFlags(args: string[]): LoginCommandFlags {
  const flags: LoginCommandFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--no-browser") {
      flags.noBrowser = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--cloud-url") {
      flags.cloudUrl = requireOptionValue(args, i, "--cloud-url");
      i++;
    } else if (arg.startsWith("--cloud-url=")) {
      const value = arg.slice("--cloud-url=".length);
      if (!value) throw new Error("--cloud-url requires a value");
      flags.cloudUrl = value;
    } else if (arg === "--home") {
      flags.home = requireOptionValue(args, i, "--home");
      i++;
    } else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value) throw new Error("--home requires a value");
      flags.home = value;
    } else if (arg === "--resin-home") {
      flags.resinHome = requireOptionValue(args, i, "--resin-home");
      i++;
    } else if (arg.startsWith("--resin-home=")) {
      const value = arg.slice("--resin-home=".length);
      if (!value) throw new Error("--resin-home requires a value");
      flags.resinHome = value;
    } else if (arg === "--token-file") {
      flags.tokenFile = requireOptionValue(args, i, "--token-file");
      i++;
    } else if (arg.startsWith("--token-file=")) {
      const value = arg.slice("--token-file=".length);
      if (!value) throw new Error("--token-file requires a value");
      flags.tokenFile = value;
    } else if (arg === "--account" || arg === "--account-id") {
      flags.accountId = requireOptionValue(args, i, arg);
      i++;
    } else if (arg.startsWith("--account=")) {
      const value = arg.slice("--account=".length);
      if (!value) throw new Error("--account requires a value");
      flags.accountId = value;
    } else if (arg.startsWith("--account-id=")) {
      const value = arg.slice("--account-id=".length);
      if (!value) throw new Error("--account-id requires a value");
      flags.accountId = value;
    } else if (arg === "--workspace" || arg === "--workspace-id") {
      flags.workspaceId = requireOptionValue(args, i, arg);
      i++;
    } else if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      if (!value) throw new Error("--workspace requires a value");
      flags.workspaceId = value;
    } else if (arg.startsWith("--workspace-id=")) {
      const value = arg.slice("--workspace-id=".length);
      if (!value) throw new Error("--workspace-id requires a value");
      flags.workspaceId = value;
    } else if (arg === "--device-id") {
      flags.deviceId = requireOptionValue(args, i, "--device-id");
      i++;
    } else if (arg.startsWith("--device-id=")) {
      const value = arg.slice("--device-id=".length);
      if (!value) throw new Error("--device-id requires a value");
      flags.deviceId = value;
    } else if (arg === "--installation-id") {
      flags.installationId = requireOptionValue(args, i, "--installation-id");
      i++;
    } else if (arg.startsWith("--installation-id=")) {
      const value = arg.slice("--installation-id=".length);
      if (!value) throw new Error("--installation-id requires a value");
      flags.installationId = value;
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }

  return flags;
}

export function printLoginHelp(): void {
  const lines = [
    "Usage: resin login [options]",
    "",
    "Pair this device with a Resin Cloud workspace (RFC 8628 device flow).",
    "",
    "Opens the complete verification URL in a browser unless --no-browser.",
    "Always prints that URL and the user code as a fallback. Sign in or create",
    "an account, then review the identity and workspace in the Console before",
    "approving. Approving one identity cannot bind credentials to another.",
    "",
    "Credentials are written owner-only to the effective Resin home state path",
    "(mode 0600) plus an ancillary vault. They are distinct from the local IPC",
    "token and never appear in harness config or project metadata.",
    "Valid cached credentials are reused unless --force.",
    "After authentication, resin login automatically restarts only an installed",
    "active daemon service and verifies the new Cloud identity. Inactive or absent",
    "services are not started or installed. Externally managed daemons (including",
    "RESIN_NO_SERVICE=1) must be restarted manually through their supervisor.",
    "",
    "Default cloud origin: https://api.resin.sh (override with --cloud-url or",
    "RESIN_CLOUD_URL).",
    "",
    "Options:",
    "  --cloud-url <https-url>   Resin Cloud origin (default: https://api.resin.sh)",
    "  --device-id <id>          Explicit device identifier to register",
    "  --installation-id <id>    Explicit installation identifier to pair",
    "  --account, --account-id <id> Filter or select target account",
    "  --workspace, --workspace-id <id> Explicit workspace target",
    "  --home <dir>              Base user home directory (for testing)",
    "  --resin-home <dir>        Explicit resin home directory override",
    "  --token-file <path>       Explicit token storage path override",
    "  --no-browser              Do not open a browser; print the URL and code",
    "  --json                    Output JSON instead of human-readable text",
    "  --force                   Force a new device flow even if valid credentials exist",
    "  --help, -h                Show this help message",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
export interface LoginVerificationPayload {
  type: "verification";
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}
export interface LoginErrorPayload {
  type: "error";
  success: false;
  error: string;
  authenticationSucceeded?: boolean;
  daemonRefresh?: DaemonRefreshResult;
}

export type LoginJsonPayload =
  | LoginSuccessResult
  | LoginVerificationPayload
  | LoginErrorPayload
  | Record<
      string,
      | string
      | number
      | boolean
      | null
      | undefined
      | Record<string, string | number | boolean | null | undefined>
    >;

function writeJson(payload: LoginJsonPayload): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeError(message: string, isJson: boolean): void {
  if (isJson) {
    writeJson({ type: "error", success: false, error: message });
  } else {
    process.stderr.write(`\nError: ${message}\n`);
  }
}
function writeAuthenticatedHumanOutput(values: {
  accountId?: string;
  workspaceId: string;
  deviceId: string;
  userId?: string;
  tokenFilePath?: string;
  daemonRefresh: DaemonRefreshResult;
}): void {
  process.stdout.write("\nAuthenticated successfully.\n");
  if (values.accountId) {
    process.stdout.write(`  Account:      ${values.accountId}\n`);
  }
  process.stdout.write(`  Workspace:    ${values.workspaceId}\n`);
  process.stdout.write(`  Device ID:    ${values.deviceId}\n`);
  if (values.userId) {
    process.stdout.write(`  User ID:      ${values.userId}\n`);
  }
  if (values.tokenFilePath) {
    process.stdout.write(`Credentials saved to ${values.tokenFilePath}.\n`);
  } else {
    process.stdout.write("Credentials saved to the secure credential store.\n");
  }
  process.stdout.write(`Daemon refresh: ${values.daemonRefresh.message}\n`);
}

function writeAuthenticatedRefreshFailure(
  isJson: boolean,
  daemonRefresh: DaemonRefreshResult,
): void {
  if (isJson) {
    writeJson({
      type: "error",
      success: false,
      authenticationSucceeded: true,
      error: daemonRefresh.message,
      daemonRefresh,
    });
  } else {
    process.stdout.write("\nAuthentication succeeded and credentials were preserved.\n");
    process.stderr.write(
      `\nError: Daemon refresh failed (${daemonRefresh.stage ?? "unknown"}): ${daemonRefresh.message}\n`,
    );
  }
}

export async function loginCommand(
  argv: string[],
  options: LoginCommandOptions = {},
): Promise<number> {
  let flags: LoginCommandFlags;
  try {
    flags = parseLoginFlags(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(message, argv.includes("--json"));
    return 1;
  }

  if (flags.help) {
    printLoginHelp();
    return 0;
  }

  let cloudUrl: string;
  try {
    cloudUrl = validateCloudUrl(flags.cloudUrl ?? process.env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(message, Boolean(flags.json));
    return 1;
  }

  const resolvedPaths = resolveLoginPaths({
    home: flags.home,
    resinHome: flags.resinHome,
    tokenFilePath: flags.tokenFile,
  });
  const { home, resinHome, tokenFilePath, daemonTokenFilePath } = resolvedPaths;
  const authClient = new DeviceAuthClient({
    cloudUrl,
    customFetch: options.customFetch,
    tokenFilePath,
    home,
    resinHome,
  });

  const openBrowserFn = options.openBrowser ?? defaultOpenBrowser;
  const refreshDaemon = async (cloudIdentity: {
    cloudUrl: string;
    accountId: string;
    workspaceId: string;
    deviceId: string;
    userId?: string;
  }): Promise<DaemonRefreshResult> => {
    try {
      return await refreshDaemonAfterCredentials({
        home,
        resinHome,
        tokenFilePath,
        daemonTokenFilePath,
        cloudIdentity,
        fsBridge: options.fsBridge,
        serviceManager: options.serviceManager,
        readinessVerifier: options.readinessVerifier,
      });
    } catch {
      return failedDaemonRefresh(
        "status",
        "Credentials were saved, but daemon refresh could not be completed. Restart it through your service supervisor, then verify it with `resin status`.",
      );
    }
  };

  try {
    if (!flags.force) {
      const priorSnapshot = await authClient.snapshotCredentials();
      if (isReusableCredentialRecord(priorSnapshot, cloudUrl)) {
        const claims = priorSnapshot.claims;
        const accountId = claims.accountId;
        const workspaceId = claims.workspaceId;
        const deviceId = claims.deviceId;
        const userId = claims.userId ?? claims.subject;
        const daemonRefresh = await refreshDaemon({
          cloudUrl,
          accountId,
          workspaceId,
          deviceId,
          userId,
        });

        if (daemonRefresh.status === "failed") {
          writeAuthenticatedRefreshFailure(Boolean(flags.json), daemonRefresh);
          return 1;
        }

        if (flags.json) {
          const successPayload: LoginSuccessResult = {
            type: "success",
            success: true,
            deviceId,
            workspaceId,
            accountId,
            userId,
            storedInSecretStore: false,
            tokenFilePath,
            daemonRefresh,
          };
          writeJson(successPayload);
        } else {
          writeAuthenticatedHumanOutput({
            accountId,
            workspaceId,
            deviceId,
            userId,
            tokenFilePath,
            daemonRefresh,
          });
        }
        return 0;
      }
    }

    const result = await authClient.bootstrap({
      interactive: false,
      deviceId: flags.deviceId,
      installationId: flags.installationId,
      workspaceId: flags.workspaceId,
      onUserCodeReceived: async (info) => {
        if (flags.json) {
          writeJson({
            type: "verification",
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            verificationUriComplete: info.verificationUriComplete,
            expiresIn: info.expiresIn,
          });
          return;
        }

        const targetUrl = info.verificationUriComplete || info.verificationUri;
        let browserOpened = false;
        if (!flags.noBrowser) {
          try {
            browserOpened = await openBrowserFn(targetUrl);
          } catch {
            // Browser launch is best-effort; the URL and code below are authoritative.
          }
        }

        process.stdout.write(
          browserOpened
            ? "\nA browser window was opened for Resin authorization.\n"
            : "\nA browser could not be opened automatically. Continue on any browser:\n",
        );
        process.stdout.write(`1. Navigate to: ${targetUrl}\n`);
        process.stdout.write(`2. Enter code:   ${info.userCode}\n\n`);
        process.stdout.write(
          "Keep this installer open. Setup continues automatically after authorization.\n",
        );
      },
    });

    if (!result.success) {
      throw new Error(result.error ?? "Device authorization failed");
    }

    const accountId = result.claims.accountId;
    const workspaceId = result.workspaceId;
    const deviceId = result.deviceId;
    const userId = result.claims.userId ?? result.claims.subject;
    const daemonRefresh = await refreshDaemon({
      cloudUrl,
      accountId,
      workspaceId,
      deviceId,
      userId,
    });

    if (daemonRefresh.status === "failed") {
      writeAuthenticatedRefreshFailure(Boolean(flags.json), daemonRefresh);
      return 1;
    }

    if (flags.json) {
      const successPayload: LoginSuccessResult = {
        type: "success",
        success: true,
        deviceId,
        workspaceId,
        accountId,
        userId,
        storedInSecretStore: result.storedInSecretStore,
        tokenFilePath: result.tokenFilePath,
        daemonRefresh,
      };
      writeJson(successPayload);
    } else {
      writeAuthenticatedHumanOutput({
        accountId,
        workspaceId,
        deviceId,
        userId,
        tokenFilePath: result.tokenFilePath,
        daemonRefresh,
      });
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(message, Boolean(flags.json));
    return 1;
  }
}
