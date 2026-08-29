/**
 * @resin/cli
 *
 * Command-line interface and single-command installer for Resin.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { SERVICE_SUPERVISOR_COMMAND, runServiceSupervisor } from "./service/manager.js";
import { sanitizeCrashDiagnostic } from "./service/recovery-state.js";

// Legacy helper compatibility
export interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? true;
    }
  }
  return { command, flags };
}

export async function runCli(args: CliArgs): Promise<number> {
  switch (args.command) {
    case "help":
      return 0;
    case "version":
      return 0;
    default:
      return 1;
  }
}

export async function runServiceSupervisorCommand(argv: string[]): Promise<number> {
  if (argv[0] !== SERVICE_SUPERVISOR_COMMAND) {
    throw new Error("Invalid service supervisor invocation");
  }

  const separatorIndex = argv.indexOf("--", 1);
  if (separatorIndex < 0 || separatorIndex === argv.length - 1) {
    throw new Error("Service supervisor invocation requires a child command after `--`");
  }

  let resinHome: string | undefined;
  for (let index = 1; index < separatorIndex; index += 1) {
    if (argv[index] !== "--resin-home" || index + 1 >= separatorIndex) {
      throw new Error("Invalid service supervisor option");
    }
    resinHome = argv[index + 1];
    index += 1;
  }

  const command = argv[separatorIndex + 1];
  if (!command) {
    throw new Error("Service supervisor invocation has an empty child command");
  }
  await runServiceSupervisor({
    command,
    args: argv.slice(separatorIndex + 2),
    ...(resinHome === undefined ? {} : { resinHome }),
  });
  return 0;
}

function isDirectServiceSupervisorEntry(
  metaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) {
    return false;
  }
  return pathToFileURL(path.resolve(argv1)).href === metaUrl;
}

if (process.argv[2] === SERVICE_SUPERVISOR_COMMAND && isDirectServiceSupervisorEntry()) {
  void runServiceSupervisorCommand(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[resin recovery] supervisor failed: ${sanitizeCrashDiagnostic(error)}\n`,
      );
      process.exitCode = 1;
    });
}

// Platform Subsystem
export * from "./platform/index.js";
// Installer Engine
export * from "./installer/installer.js";
export * from "./installer/platform.js";
export * from "./installer/assets.js";
export * from "./installer/auth-plan.js";
export * from "./installer/harness-config.js";
export * from "./installer/harness-reconciler.js";
export * from "./installer/harness-health.js";
export * from "./installer/journal.js";
export * from "./installer/channel-verifier.js";
export * from "./installer/asset-downloader.js";
export * from "./installer/user-service.js";

// Update Policy & Scheduling
export * from "./updates/policy.js";
export * from "./updates/update-lock.js";
export * from "./updates/scheduler.js";
export * from "./updates/engine.js";

// Service & Auth
export * from "./service/manager.js";
export * from "./service/recovery-state.js";
export * from "./service/auth-bootstrap.js";
export * from "./service/verification.js";
export * from "./service/notifications.js";

// CLI Commands
export * from "./commands/init.js";
export * from "./commands/status.js";
export * from "./commands/privacy.js";
export * from "./commands/control.js";
export * from "./commands/doctor.js";
export * from "./commands/upgrade.js";
export * from "./commands/login.js";
export * from "./commands/logout.js";
export * from "./commands/uninstall.js";

// CLI Main & Onboarding Helpers
export {
  main,
  shouldEnterFirstRunOnboarding,
  isMachineInitialized,
  isInteractiveEnvironment,
  isCiEnvironment,
  isRootUser,
  type MainOptions,
  type ShouldOnboardOptions,
} from "./bin/cli.js";
