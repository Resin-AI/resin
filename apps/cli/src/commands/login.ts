import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import type {
  InstallationPairingSummary,
  InstallerPairingMutation,
} from "../installer/installer.js";
import {
  DEFAULT_CLOUD_URL,
  DeviceAuthClient,
  type StoredDeviceCredentials,
  isReusableCredentialRecord,
  validateCloudUrl,
} from "../service/auth-bootstrap.js";
import { createUserServiceManager } from "../service/manager.js";

export { validateCloudUrl, isReusableCredentialRecord } from "../service/auth-bootstrap.js";

export type BrowserLauncher = (url: string) => Promise<boolean> | boolean;

export async function defaultOpenBrowser(url: string): Promise<boolean> {
  try {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd.exe";
      args = ["/c", "start", '""', url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (result: boolean) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const proc = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });

      proc.once("error", () => done(false));
      proc.once("spawn", () => {
        proc.unref();
        done(true);
      });
    });
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
}

export interface LoginCommandOptions {
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  fsBridge?: ConfigFsBridge;
}

export interface PerformPairingOptions {
  cloudUrl?: string;
  home?: string;
  tokenFilePath?: string;
  accountId?: string;
  workspaceId?: string;
  deviceId?: string;
  installationId?: string;
  json?: boolean;
  nonInteractive?: boolean;
  noBrowser?: boolean;
  force?: boolean;
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  fsBridge?: ConfigFsBridge;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

async function restartActiveServiceIfRunning(
  homeDir?: string,
  fsBridge?: ConfigFsBridge,
): Promise<void> {
  try {
    const resinHome = homeDir ? path.join(homeDir, ".resin") : undefined;
    const serviceManager = createUserServiceManager({ homeDir, resinHome, fsBridge });
    const status = await serviceManager.status();
    if (status.installed && (status.active || status.state === "running")) {
      await serviceManager.restart();
    }
  } catch {
    // Best-effort restart
  }
}

/**
 * Reusable install-pairing workflow used by both `resin login` and `resin init`.
 *
 * 1. Checks and reuses valid pre-provisioned credentials if not forcing fresh auth.
 * 2. In non-interactive mode without reusable credentials, fails truthfully.
 * 3. In interactive mode, attempts to open verification URI in browser first,
 *    prints safe instructions (never printing tokens), and polls for approval.
 * 4. Snapshots prior credentials so rollback can restore or purge safely.
 */
export async function performPairing(
  options: PerformPairingOptions = {},
): Promise<InstallerPairingMutation> {
  const cloudUrl = validateCloudUrl(
    options.cloudUrl ?? process.env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL,
  );
  const home = options.home ? path.resolve(options.home) : os.homedir();
  const tokenFilePath =
    options.tokenFilePath ?? path.join(home, ".resin", "state", "device-token.json");

  const authClient = new DeviceAuthClient({
    cloudUrl,
    customFetch: options.customFetch,
    home,
    tokenFilePath,
  });

  const priorSnapshot = await authClient.snapshotCredentials();

  if (!options.force && isReusableCredentialRecord(priorSnapshot, cloudUrl)) {
    const claims = priorSnapshot.claims;
    const accountId = options.accountId || claims.accountId;
    const workspaceId = options.workspaceId || priorSnapshot.workspaceId || claims.workspaceId;
    const deviceId = options.deviceId || priorSnapshot.deviceId || claims.deviceId;
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
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal,
  });

  if (!result.success) {
    throw new Error(result.error ?? "Device authentication bootstrap failed");
  }

  const accountId = options.accountId || result.claims.accountId;
  const workspaceId = options.workspaceId || result.workspaceId || result.claims.workspaceId;
  const deviceId = options.deviceId || result.deviceId || result.claims.deviceId;
  const userId = result.claims.userId ?? result.claims.subject;

  // Detect active user service and reload/restart it through existing service APIs
  await restartActiveServiceIfRunning(home, options.fsBridge);

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
    "Credentials are written owner-only to ~/.resin/state/device-token.json",
    "(mode 0600) plus an ancillary vault. They are distinct from the local IPC",
    "token and never appear in harness config or project metadata.",
    "Valid cached credentials are reused unless --force.",
    "After a credential replacement, restart a running daemon so it reloads",
    "cloud credentials (`resin repair` starts an inactive user service;",
    "`resin init` pairing restarts a running service itself).",
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

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeError(message: string, isJson: boolean): void {
  if (isJson) {
    writeJson({ type: "error", success: false, error: message });
  } else {
    process.stderr.write(`\nError: ${message}\n`);
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

  const home = flags.home ? path.resolve(flags.home) : os.homedir();
  const tokenFilePath = flags.tokenFile
    ? path.resolve(flags.tokenFile)
    : path.join(home, ".resin", "state", "device-token.json");
  const authClient = new DeviceAuthClient({
    cloudUrl,
    customFetch: options.customFetch,
    tokenFilePath,
    home,
    resinHome: flags.resinHome,
  });

  const openBrowserFn = options.openBrowser ?? defaultOpenBrowser;

  try {
    if (!flags.force) {
      const priorSnapshot = await authClient.snapshotCredentials();
      if (isReusableCredentialRecord(priorSnapshot, cloudUrl)) {
        const claims = priorSnapshot.claims;
        const accountId = flags.accountId || claims.accountId;
        const workspaceId = flags.workspaceId || priorSnapshot.workspaceId || claims.workspaceId;
        const deviceId = flags.deviceId || priorSnapshot.deviceId || claims.deviceId;
        const userId = claims.userId ?? claims.subject;

        await restartActiveServiceIfRunning(home, options.fsBridge);

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
          };
          writeJson(successPayload);
        } else {
          process.stdout.write("\nAuthenticated successfully.\n");
          process.stdout.write(`  Account:      ${accountId}\n`);
          process.stdout.write(`  Workspace:    ${workspaceId}\n`);
          process.stdout.write(`  Device ID:    ${deviceId}\n`);
          if (userId) {
            process.stdout.write(`  User ID:      ${userId}\n`);
          }
          if (tokenFilePath) {
            process.stdout.write(`Credentials saved to ${tokenFilePath}.\n`);
          } else {
            process.stdout.write("Credentials saved to the secure credential store.\n");
          }
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

    await restartActiveServiceIfRunning(home, options.fsBridge);

    if (flags.json) {
      const successPayload: LoginSuccessResult = {
        type: "success",
        success: true,
        deviceId: result.deviceId,
        workspaceId: result.workspaceId,
        accountId: result.claims.accountId,
        userId: result.claims.userId ?? result.claims.subject,
        storedInSecretStore: result.storedInSecretStore,
        tokenFilePath: result.tokenFilePath,
      };
      writeJson(successPayload);
    } else {
      process.stdout.write("\nAuthenticated successfully.\n");
      process.stdout.write(`  Account:      ${result.claims.accountId}\n`);
      process.stdout.write(`  Workspace:    ${result.workspaceId}\n`);
      process.stdout.write(`  Device ID:    ${result.deviceId}\n`);
      if (result.claims.userId || result.claims.subject) {
        process.stdout.write(`  User ID:      ${result.claims.userId ?? result.claims.subject}\n`);
      }
      if (result.tokenFilePath) {
        process.stdout.write(`Credentials saved to ${result.tokenFilePath}.\n`);
      } else {
        process.stdout.write("Credentials saved to the secure credential store.\n");
      }
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(message, Boolean(flags.json));
    return 1;
  }
}
