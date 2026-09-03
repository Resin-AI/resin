#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { z } from "zod";
import { controlCommand } from "../commands/control.js";
import { doctorCommand, repairCommand } from "../commands/doctor.js";
import { type InitCommandOptions, initCommand } from "../commands/init.js";
import { type BrowserLauncher, loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/logout.js";
import { privacyCommand } from "../commands/privacy.js";
import { statusCommand } from "../commands/status.js";
import { uninstallCommand } from "../commands/uninstall.js";
import { upgradeCommand } from "../commands/upgrade.js";
import {
  type HarnessHealthRunner,
  runHarnessHealthStartupCheck,
} from "../installer/harness-health.js";
import { type VerbosityLevel, resolveVerbosity } from "../output.js";
import {
  DEFAULT_CLOUD_URL,
  DeviceAuthClient,
  isReusableCredentialRecord,
  validateCloudUrl,
} from "../service/auth-bootstrap.js";

const PackageJsonSchema = z.object({
  version: z.string().min(1),
});

function resolveVersion(): string {
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = PackageJsonSchema.safeParse(
        JSON.parse(fs.readFileSync(fileURLToPath(candidate), "utf8")),
      );
      if (parsed.success) {
        return parsed.data.version;
      }
    } catch {
      // Continue to the next enclosing package candidate.
    }
  }
  return "0.1.0";
}

const VERSION = process.env.RESIN_RELEASE_VERSION ?? resolveVersion();

export interface InteractiveEnvironmentOptions {
  getuid?: () => number | undefined;
  isRoot?: boolean;
}

export interface ShouldOnboardOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: { isTTY?: boolean };
  stdout?: { isTTY?: boolean; write?: (chunk: string) => boolean | undefined };
  home?: string;
  cloudUrl?: string;
  customFetch?: typeof fetch;
  fsBridge?: ConfigFsBridge;
  isInteractive?: boolean;
  isInitialized?: boolean;
  autoOnboard?: boolean;
  isRoot?: boolean;
  getuid?: () => number | undefined;
}

export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CI ||
      env.CONTINUOUS_INTEGRATION ||
      env.BUILD_NUMBER ||
      env.RUN_ID ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.TRAVIS ||
      env.CIRCLECI ||
      env.JENKINS_URL ||
      env.DEBIAN_FRONTEND === "noninteractive" ||
      env.RESIN_NON_INTERACTIVE === "1" ||
      env.RESIN_NON_INTERACTIVE === "true",
  );
}

export function isRootUser(
  env: NodeJS.ProcessEnv = process.env,
  getuid?: () => number | undefined,
): boolean {
  if (env.RESIN_ALLOW_ROOT === "1" || env.RESIN_ALLOW_ROOT === "true") {
    return false;
  }
  const uid = getuid ? getuid() : process.getuid instanceof Function ? process.getuid() : undefined;
  if (uid === 0) {
    return true;
  }
  return false;
}

export function isInteractiveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
  options: InteractiveEnvironmentOptions = {},
): boolean {
  if (isCiEnvironment(env)) {
    return false;
  }
  const isRoot =
    options.isRoot ?? (options.getuid !== undefined ? options.getuid() === 0 : isRootUser(env));
  if (isRoot) {
    return false;
  }
  if (env.RESIN_LOCAL_ONLY === "1" || env.RESIN_LOCAL_ONLY === "true") {
    return false;
  }
  if (
    env.RESIN_SKIP_ONBOARDING === "1" ||
    env.RESIN_SKIP_ONBOARDING === "true" ||
    env.RESIN_SKIP_POSTINSTALL === "1" ||
    env.RESIN_SKIP_POSTINSTALL === "true"
  ) {
    return false;
  }
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

export async function isMachineInitialized(
  options: {
    home?: string;
    cloudUrl?: string;
    customFetch?: typeof fetch;
    fsBridge?: ConfigFsBridge;
  } = {},
): Promise<boolean> {
  const home = options.home ? path.resolve(options.home) : os.homedir();
  const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
  const journalPath = path.join(home, ".resin", "state", "install-journal.json");
  const expectedCloudUrl = options.cloudUrl ?? process.env.RESIN_CLOUD_URL;
  const bridge = options.fsBridge;

  // 1. Check if reusable credentials exist in store
  try {
    const authClient = new DeviceAuthClient({
      cloudUrl: expectedCloudUrl ? validateCloudUrl(expectedCloudUrl) : DEFAULT_CLOUD_URL,
      home,
      tokenFilePath,
      customFetch: options.customFetch,
    });
    const creds = await authClient.snapshotCredentials();
    if (
      isReusableCredentialRecord(
        creds,
        expectedCloudUrl ? validateCloudUrl(expectedCloudUrl) : undefined,
      )
    ) {
      return true;
    }
  } catch {
    // Ignore and check alternative indicators
  }

  // 2. Check token file directly if fsBridge provided or on disk
  try {
    const tokenExists = bridge ? await bridge.exists(tokenFilePath) : fs.existsSync(tokenFilePath);
    if (tokenExists) {
      const content = bridge
        ? await bridge.readFile(tokenFilePath)
        : fs.readFileSync(tokenFilePath, "utf8");
      if (content) {
        const parsed = JSON.parse(content);
        if (
          isReusableCredentialRecord(
            parsed,
            expectedCloudUrl ? validateCloudUrl(expectedCloudUrl) : undefined,
          )
        ) {
          return true;
        }
      }
    }
  } catch {
    // Ignore and check install journal
  }

  // 3. Check install journal for prior completed installation
  try {
    const journalExists = bridge ? await bridge.exists(journalPath) : fs.existsSync(journalPath);
    if (journalExists) {
      const content = bridge
        ? await bridge.readFile(journalPath)
        : fs.readFileSync(journalPath, "utf8");
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed.status === "completed") {
          return true;
        }
      }
    }
  } catch {
    // Treat as uninitialized
  }

  return false;
}

export async function shouldEnterFirstRunOnboarding(
  options: ShouldOnboardOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  if (
    env.RESIN_NO_ONBOARD === "1" ||
    env.RESIN_NO_ONBOARD === "true" ||
    env.RESIN_SKIP_ONBOARDING === "1" ||
    env.RESIN_SKIP_ONBOARDING === "true" ||
    env.RESIN_SKIP_POSTINSTALL === "1" ||
    env.RESIN_SKIP_POSTINSTALL === "true" ||
    env.RESIN_LOCAL_ONLY === "1" ||
    env.RESIN_LOCAL_ONLY === "true"
  ) {
    return false;
  }

  const interactive =
    options.isInteractive !== undefined
      ? options.isInteractive
      : isInteractiveEnvironment(env, stdin, stdout, {
          getuid: options.getuid,
          isRoot: options.isRoot,
        });

  if (!interactive && !options.autoOnboard) {
    return false;
  }

  if (options.isInitialized !== undefined) {
    return !options.isInitialized;
  }

  const initialized = await isMachineInitialized({
    home: options.home ?? env.RESIN_HOME,
    cloudUrl: options.cloudUrl ?? env.RESIN_CLOUD_URL,
    customFetch: options.customFetch,
    fsBridge: options.fsBridge,
  });

  return !initialized;
}

function printGlobalHelp(
  outStream: { write: (chunk: string) => boolean | undefined } = process.stdout,
): void {
  const text = `
Resin CLI (v${VERSION})

Usage:
  resin <command> [options]

Commands:
  init         Install, authorize, and configure AI agent harnesses for Resin.
  login        Authenticate this installation with Resin Cloud.
  status       Display live status and health of the daemon, tools, and harnesses.
  mcp          Connect AI harnesses to Resin Gateway over Model Context Protocol (MCP).
  privacy      Inspect and manage device and cloud privacy controls.
  control      Inspect or mutate revisioned Cloud desired state noninteractively.
  doctor       Diagnose platform, filesystem, service, IPC, database, and harness state.
  repair       Automatically remediate detected issues and restore healthy service state.
  upgrade      Atomic in-place release upgrade with health gate and auto-rollback.
  uninstall    Safely stop services and remove Resin integration from harnesses.
  version      Display Resin CLI version.
  help         Display this help message.

Global Options:
  -V, --version  Display Resin CLI version.
  -v, --verbose  Enable verbose diagnostic logging.
  -q, --quiet    Suppress non-error standard output.
  -h, --help     Display this help message.

Run "resin <command> --help" for detailed information on a specific command.
`;
  outStream.write(text.trimStart());
}

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: { isTTY?: boolean };
  stdout?: { isTTY?: boolean; write?: (chunk: string) => boolean | undefined };
  stderr?: { write?: (chunk: string) => boolean | undefined };
  home?: string;
  cloudUrl?: string;
  customFetch?: typeof fetch;
  openBrowser?: BrowserLauncher;
  fsBridge?: ConfigFsBridge;
  isInteractive?: boolean;
  isInitialized?: boolean;
  autoOnboard?: boolean;
  initOptions?: Pick<
    InitCommandOptions,
    "releaseMode" | "localSourceRoot" | "setupService" | "autoStartService"
  >;
  harnessHealthRunner?: HarnessHealthRunner;
  harnessHealthDeadlineMs?: number;
  verbosity?: VerbosityLevel;
  verbose?: boolean;
  quiet?: boolean;
}

function parseTopLevelArgv(argv: string[]) {
  const globalFlags = { quiet: false, verbose: false };
  let command: string | undefined;
  const commandArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!command) {
      if (arg === "-V" || arg === "--version" || arg === "version") {
        return { isVersion: true, isHelp: false, command: "version", commandArgs: [], globalFlags };
      }
      if (arg === "-h" || arg === "--help" || arg === "help") {
        return { isVersion: false, isHelp: true, command: "help", commandArgs: [], globalFlags };
      }
      if (arg === "-v" || arg === "--verbose") {
        globalFlags.verbose = true;
        continue;
      }
      if (arg === "-q" || arg === "--quiet") {
        globalFlags.quiet = true;
        continue;
      }
      command = arg;
    } else {
      commandArgs.push(arg);
    }
  }

  return { isVersion: false, isHelp: false, command, commandArgs, globalFlags };
}

export async function main(
  argv = process.argv.slice(2),
  options: MainOptions = {},
): Promise<number> {
  const parsed = parseTopLevelArgv(argv);
  const command = parsed.command;
  const args = parsed.commandArgs;
  const stdout =
    options.stdout?.write === undefined
      ? process.stdout
      : { isTTY: options.stdout.isTTY, write: options.stdout.write };
  const stderr =
    options.stderr?.write === undefined ? process.stderr : { write: options.stderr.write };
  if (command === "mcp") {
    // Lazy dynamic import: prevents eagerly loading @resin/gateway and node:sqlite on non-MCP CLI paths.
    const { mcpCommand } = await import("../commands/mcp.js");
    return mcpCommand(args, {
      stdin: options.stdin as NodeJS.ReadableStream | undefined,
      stdout,
      stderr,
      home: options.home,
      env: options.env,
    });
  }

  const env = options.env ?? process.env;
  const verbosity =
    options.verbosity ??
    resolveVerbosity({
      args: argv,
      flags: {
        quiet: (parsed.globalFlags.quiet || options.quiet) ?? undefined,
        verbose: (parsed.globalFlags.verbose || options.verbose) ?? undefined,
      },
      env,
    });
  const isQuiet = verbosity === "quiet";
  const isVerbose = verbosity === "verbose";

  let harnessHealthHome = options.home;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--home" && index + 1 < args.length) {
      harnessHealthHome = args[index + 1];
      break;
    }
    if (arg?.startsWith("--home=")) {
      harnessHealthHome = arg.slice(7);
      break;
    }
  }

  let harnessHealthEnabled = false;
  if (
    command !== "init" &&
    command !== "uninstall" &&
    !args.includes("--auto-repair") &&
    !args.includes("--no-auto-repair")
  ) {
    try {
      harnessHealthEnabled =
        options.isInitialized ??
        (await isMachineInitialized({
          home: harnessHealthHome,
          cloudUrl: options.cloudUrl,
          customFetch: options.customFetch,
          fsBridge: options.fsBridge,
        }));
      if (harnessHealthEnabled) {
        await runHarnessHealthStartupCheck({
          home: harnessHealthHome,
          fsBridge: options.fsBridge,
          runner: options.harnessHealthRunner,
          deadlineMs: options.harnessHealthDeadlineMs,
        });
      }
    } catch {
      // Harness self-healing is best-effort and must never prevent command dispatch.
    }
  }

  if (!command) {
    const shouldOnboard = await shouldEnterFirstRunOnboarding({
      env: options.env,
      stdin: options.stdin,
      stdout,
      home: options.home,
      cloudUrl: options.cloudUrl,
      customFetch: options.customFetch,
      fsBridge: options.fsBridge,
      isInteractive: options.isInteractive,
      isInitialized: options.isInitialized,
      autoOnboard: options.autoOnboard,
    });

    if (shouldOnboard) {
      const initArgs = ["--auto-approve"];
      if (options.home) {
        initArgs.push(`--home=${options.home}`);
      }
      const cloudUrl = options.cloudUrl ?? options.env?.RESIN_CLOUD_URL;
      if (cloudUrl) {
        initArgs.push(`--cloud-url=${cloudUrl}`);
      }
      if (isVerbose) {
        initArgs.push("--verbose");
      }
      if (isQuiet) {
        initArgs.push("--quiet");
      }
      return await initCommand(initArgs, {
        ...options.initOptions,
        customFetch: options.customFetch,
        openBrowser: options.openBrowser,
        customFsBridge: options.fsBridge,
        env,
        stdout,
        stderr,
        verbosity,
        verbose: isVerbose,
        quiet: isQuiet,
        logger: options.stdout?.write
          ? (msg: string) => options.stdout?.write?.(`${msg}\n`)
          : undefined,
      });
    }

    printGlobalHelp(stdout);
    return 0;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printGlobalHelp(stdout);
    return 0;
  }

  switch (command) {
    case "init":
      return initCommand(args, {
        ...options.initOptions,
        customFetch: options.customFetch,
        openBrowser: options.openBrowser,
        env,
        stdout,
        stderr,
        verbosity,
        verbose: isVerbose,
        quiet: isQuiet,
      });

    case "login":
      return loginCommand(args);

    case "status":
      return statusCommand(args);

    case "privacy":
      return privacyCommand(args, {
        home: options.home,
        env: options.env,
        customFetch: options.customFetch,
        stdinIsTTY: options.stdin?.isTTY,
        stdout: { write: (chunk) => stdout.write(chunk) },
        stderr: { write: (chunk) => stderr.write(chunk) },
      });

    case "control":
      return controlCommand(args, {
        home: options.home,
        customFetch: options.customFetch,
        output: { write: (chunk) => stdout.write(chunk) },
        errorOutput: { write: (chunk) => stderr.write(chunk) },
      });

    case "doctor":
      return doctorCommand(args);

    case "repair":
      return repairCommand(args);

    case "upgrade": {
      const exitCode = await upgradeCommand(args, {
        fsBridge: options.fsBridge,
        customFetch: options.customFetch,
        env,
        stdout,
        stderr,
        verbosity,
        verbose: isVerbose,
        quiet: isQuiet,
      });
      if (exitCode === 0 && harnessHealthEnabled) {
        try {
          await runHarnessHealthStartupCheck({
            home: harnessHealthHome,
            fsBridge: options.fsBridge,
            runner: options.harnessHealthRunner,
            deadlineMs: options.harnessHealthDeadlineMs,
            force: true,
          });
        } catch {
          // A successful upgrade is not coupled to best-effort harness reconciliation.
        }
      }
      return exitCode;
    }

    case "logout":
      return logoutCommand(args);

    case "uninstall":
      return uninstallCommand(args);

    case "version":
    case "--version":
    case "-V":
      stdout.write(`resin v${VERSION}\n`);
      return 0;

    default:
      stderr.write(`Unknown command "${command}". Run "resin help" for available commands.\n`);
      return 1;
  }
}
export function isMainModule(metaUrl: string = import.meta.url, argv1?: string): boolean {
  const targetPath = argv1 ?? (process?.argv ? process.argv[1] : undefined);
  if (!targetPath) return false;
  try {
    const resolvedPath = path.resolve(targetPath);
    const expectedUrl = pathToFileURL(resolvedPath).href;
    return metaUrl === expectedUrl;
  } catch {
    return false;
  }
}

if (process.argv[1] && isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
