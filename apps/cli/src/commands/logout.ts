import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import {
  CAPTURE_WATERMARK_FILE_NAME,
  IpcClient,
  resolvePaths,
  writeSignOutBoundary,
} from "@resin/observer";
import { DeviceAuthClient } from "../service/auth-bootstrap.js";

export interface LogoutCommandFlags {
  all?: boolean;
  force?: boolean;
  json?: boolean;
  home?: string;
  help?: boolean;
}

export interface LogoutResult {
  success: boolean;
  revokedRemotely: boolean;
  purgedLocalCredentials: boolean;
  purgedTokenFile: boolean;
  workspaceId?: string;
  /** A running daemon applied the logout's privacy boundary over IPC. */
  daemonBoundaryApplied: boolean;
}

export function parseLogoutFlags(args: string[]): LogoutCommandFlags {
  const flags: LogoutCommandFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      flags.all = true;
    } else if (arg === "-f" || arg === "--force") {
      flags.force = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--home") {
      flags.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice("--home=".length);
    } else if (arg === "-h" || arg === "--help") {
      flags.help = true;
    }
  }
  return flags;
}

export function printLogoutHelp(): void {
  const text = `
Usage:
  resin logout [options]

Revokes and purges local device authentication credentials from the secure
vault and token store. Leaves all local tools, database records, and harness
configurations intact.

Logout is a privacy boundary: nothing observed while you are signed out, or
still waiting to upload, is ever uploaded, including after a later \`resin login\`.

Options:
  --all            Revoke and purge all cached device tokens and sessions.
  -f, --force      Bypass confirmation and proceed immediately.
  --json           Output result in structured JSON format.
  --home <path>    Custom Resin home directory (overrides ~/.resin).
  -h, --help       Show this help message.
`;
  process.stdout.write(text.trimStart());
}

export interface LogoutCommandOptions {
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  /** Asks the daemon on `socketPath` to apply the logout boundary; resolves whether it did. */
  notifyDaemon?: (socketPath: string) => Promise<boolean>;
}

/** `resin logout` on a running daemon; false when no daemon is reachable or it refuses. */
async function requestDaemonSignOutBoundary(socketPath: string): Promise<boolean> {
  const client = new IpcClient({ socketPath, timeoutMs: 3_000 });
  try {
    await client.connect();
    return (await client.applySignOutBoundary()).applied;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function logoutCommand(
  args: string[],
  optionsOrBridge?: ConfigFsBridge | LogoutCommandOptions,
): Promise<number> {
  const flags = parseLogoutFlags(args);

  if (flags.help) {
    printLogoutHelp();
    return 0;
  }

  const options: LogoutCommandOptions =
    optionsOrBridge && "readFile" in optionsOrBridge
      ? { fsBridge: optionsOrBridge }
      : (optionsOrBridge ?? {});

  const customHome = flags.home ? path.resolve(flags.home) : undefined;
  const canonicalResinHome = customHome ? path.join(customHome, ".resin") : undefined;
  const canonicalTokenFilePath = customHome
    ? path.join(customHome, ".resin", "state", "device-token.json")
    : undefined;

  const authClient = new DeviceAuthClient({
    home: customHome,
    resinHome: canonicalResinHome,
    tokenFilePath: canonicalTokenFilePath,
    customFetch: options.customFetch,
  });
  try {
    const creds = await authClient.loadCredentials();
    let revoked = false;
    if (creds) {
      // Remote revocation with bound claims and origin
      revoked = await authClient.revokeToken(creds);
    }
    const purgeResult = await authClient.purgeCredentials();
    // A deliberate logout is a hard privacy boundary in every daemon mode. The durable marker
    // (written after the purge, so only a later login can satisfy it) makes any daemon that
    // verifies consent again move its cutoff past the signed-out window; without the capture
    // watermark no start catches the window up; and a running daemon drops what it deferred now.
    const daemonPaths = resolvePaths({ home: customHome, resinHome: canonicalResinHome });
    writeSignOutBoundary(daemonPaths.stateDir);
    fs.rmSync(path.join(daemonPaths.stateDir, CAPTURE_WATERMARK_FILE_NAME), { force: true });
    const daemonBoundaryApplied = await (options.notifyDaemon ?? requestDaemonSignOutBoundary)(
      daemonPaths.socketPath,
    );

    const result: LogoutResult = {
      success: true,
      revokedRemotely: revoked,
      purgedLocalCredentials: purgeResult.purgedSecrets,
      purgedTokenFile: purgeResult.purgedFile,
      workspaceId: creds?.workspaceId,
      daemonBoundaryApplied,
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write("\n✓ Successfully logged out of Resin Cloud.\n");
      process.stdout.write("  Local device credentials purged. Tools and database preserved.\n\n");
    }

    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, success: false }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nError during logout: ${msg}\n`);
    }
    return 1;
  }
}
