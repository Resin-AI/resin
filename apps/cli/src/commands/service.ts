import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type ServiceStatusInfo,
  type UserServiceManager,
  createUserServiceManager,
} from "../service/manager.js";

export type ServiceAction = "status" | "start" | "stop" | "restart";

export interface ServiceCommandFlags {
  action?: ServiceAction;
  json?: boolean;
  home?: string;
  help?: boolean;
  error?: string;
}

const ACTIONS: ReadonlySet<string> = new Set<ServiceAction>(["status", "start", "stop", "restart"]);

function isServiceAction(value: string): value is ServiceAction {
  return ACTIONS.has(value);
}

export function parseServiceFlags(args: readonly string[]): ServiceCommandFlags {
  const flags: ServiceCommandFlags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--home" && index + 1 < args.length) {
      flags.home = args[++index];
    } else if (arg.startsWith("--home=")) {
      flags.home = arg.slice("--home=".length);
    } else if (flags.action === undefined && isServiceAction(arg)) {
      flags.action = arg;
    } else {
      flags.error = `Unknown argument: ${arg}`;
    }
  }
  return flags;
}

export function printServiceHelp(out: { write(chunk: string): unknown } = process.stdout): void {
  out.write(`Usage:
  resin service <status|start|stop|restart> [options]

Controls the Resin background service for this user: the systemd user unit
(Linux), the launchd agent (macOS), the WSL supervisor, or the per-user
scheduled task (native Windows). \`resin init\` installs it; \`resin uninstall\`
removes it.

Options:
  --json          Output the service status as JSON.
  --home <path>   Custom home directory (Resin home is <path>/.resin).
  -h, --help      Show this help message.
`);
}

export interface ServiceCommandOptions {
  env?: NodeJS.ProcessEnv;
  serviceManager?: UserServiceManager;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

interface ServiceCommandOutput {
  success: boolean;
  action: ServiceAction;
  platform: string;
  serviceName: string;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  state: string;
  pid: number | null;
  error?: string;
}

function describe(
  action: ServiceAction,
  manager: UserServiceManager,
  status: ServiceStatusInfo,
): ServiceCommandOutput {
  return {
    success: true,
    action,
    platform: manager.platform,
    serviceName: status.serviceName,
    installed: status.installed,
    active: status.active,
    enabled: status.enabled,
    state: status.state ?? (status.active ? "active" : "inactive"),
    pid: status.pid ?? null,
  };
}

export async function serviceCommand(
  args: string[],
  options: ServiceCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const flags = parseServiceFlags(args);
  if (flags.help) {
    printServiceHelp(stdout);
    return 0;
  }
  if (flags.error !== undefined || flags.action === undefined) {
    stderr.write(`${flags.error ?? "Missing service action"}\n`);
    printServiceHelp(stderr);
    return 2;
  }
  const action = flags.action;
  const env = options.env ?? process.env;
  const homeDir = flags.home ? path.resolve(flags.home) : os.homedir();
  const resinHome =
    flags.home === undefined && env.RESIN_HOME ? env.RESIN_HOME : path.join(homeDir, ".resin");
  const manager =
    options.serviceManager ??
    createUserServiceManager({
      homeDir,
      resinHome,
      env: env.RESIN_NO_SERVICE === "1" ? { RESIN_NO_SERVICE: "1" } : undefined,
    });

  try {
    if (action !== "status") {
      if (!(await manager.isInstalled())) {
        throw new Error("The Resin service is not installed; run `resin init` first.");
      }
      if (action === "start") await manager.start();
      if (action === "stop") await manager.stop();
      if (action === "restart") await manager.restart();
    }
    const output = describe(action, manager, await manager.status());
    if (flags.json) {
      stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      stdout.write(
        `Service ${output.serviceName} (${output.platform}): ${
          output.installed ? (output.active ? "running" : "stopped") : "not installed"
        }${output.state && output.installed ? ` [${output.state}]` : ""}${
          output.pid === null ? "" : `, PID ${output.pid}`
        }\n`,
      );
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) {
      stdout.write(`${JSON.stringify({ success: false, action, error: message }, null, 2)}\n`);
    } else {
      stderr.write(`resin service ${action} failed: ${message}\n`);
    }
    return 1;
  }
}
