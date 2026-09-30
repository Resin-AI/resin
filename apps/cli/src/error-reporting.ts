import process from "node:process";
import {
  ErrorReporter,
  type ResinSurface,
  configureErrorReporting,
  installCrashHandlers,
} from "@resin/observer/error-reporting";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "login",
  "logout",
  "status",
  "service",
  "mcp",
  "privacy",
  "control",
  "doctor",
  "repair",
  "upgrade",
  "uninstall",
  "feedback",
  "version",
  "help",
]);

/** Sub-commands are fixed verbs; anything else after the command (paths, text) is never sent. */
const KNOWN_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  privacy: new Set(["status", "telemetry", "error-reporting", "export", "delete"]),
  service: new Set(["status", "start", "stop", "restart"]),
  control: new Set(["get", "set", "inventory", "help"]),
};

/**
 * The command path reported with CLI usage events, built only from known command and sub-command
 * names (e.g. `privacy telemetry`). Argument values never appear in it.
 */
export function describeCommandPath(argv: readonly string[]): string {
  const positional = argv.filter((argument) => !argument.startsWith("-"));
  if (argv.some((argument) => argument === "-V" || argument === "--version")) {
    if (positional.length === 0) return "version";
  }
  const command = positional[0];
  if (command === undefined) return "(none)";
  if (!KNOWN_COMMANDS.has(command)) return "(unknown)";
  const subcommands = KNOWN_SUBCOMMANDS[command];
  const subcommand = positional[1];
  if (subcommands && subcommand !== undefined && subcommands.has(subcommand)) {
    return `${command} ${subcommand}`;
  }
  return command;
}

export function commandSurface(argv: readonly string[]): ResinSurface {
  return argv.find((argument) => !argument.startsWith("-")) === "mcp" ? "mcp_shim" : "cli";
}

export interface CliReportingOptions {
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Crash handlers belong to the real process only, not to in-process callers such as tests. */
  readonly installCrashHandlers?: boolean;
}

/** Configures the process-wide reporter for a CLI invocation. Never throws. */
export function setupCliErrorReporting(
  argv: readonly string[],
  options: CliReportingOptions,
): ErrorReporter | undefined {
  try {
    const reporter = configureErrorReporting({
      surface: commandSurface(argv),
      version: options.version,
      env: options.env ?? process.env,
      home: options.home,
    });
    if (options.installCrashHandlers) installCrashHandlers(reporter);
    return reporter;
  } catch {
    return undefined;
  }
}

export interface UpdaterReportingOptions {
  readonly version: string;
  readonly resinHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * A reporter for the service supervisor's update timer only. It is not installed process-wide,
 * so the supervisor's other code paths report exactly as before. Never throws.
 */
export function createUpdaterErrorReporter(
  options: UpdaterReportingOptions,
): ErrorReporter | undefined {
  try {
    return new ErrorReporter({
      surface: "updater",
      version: options.version,
      env: options.env ?? process.env,
      resinHome: options.resinHome,
    });
  } catch {
    return undefined;
  }
}

/**
 * Configures the process-wide reporter for the out-of-service update worker, whose only job is
 * the update. Crash handlers stay off: a crash must not wait on reporting mid-cutover. Never throws.
 */
export function setupUpdaterErrorReporting(
  options: UpdaterReportingOptions,
): ErrorReporter | undefined {
  try {
    return configureErrorReporting({
      surface: "updater",
      version: options.version,
      env: options.env ?? process.env,
      resinHome: options.resinHome,
    });
  } catch {
    return undefined;
  }
}
