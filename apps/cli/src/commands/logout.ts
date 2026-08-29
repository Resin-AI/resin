import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
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

    const result: LogoutResult = {
      success: true,
      revokedRemotely: revoked,
      purgedLocalCredentials: purgeResult.purgedSecrets,
      purgedTokenFile: purgeResult.purgedFile,
      workspaceId: creds?.workspaceId,
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
