import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as waitForTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";
import {
  type HarnessHealthScheduler,
  type HarnessHealthSchedulerOptions,
  startHarnessHealthScheduler,
} from "../installer/harness-health.js";
import { detectPlatform } from "../installer/platform.js";
import {
  CRASH_WINDOW_MS,
  INITIAL_RESTART_DELAY_MS,
  MAX_CRASHES_IN_WINDOW,
  type RecoveryState,
  RecoveryStateTracker,
  sanitizeCrashDiagnostic,
} from "./recovery-state.js";

const execFileAsync = promisify(execFile);

export const SERVICE_SUPERVISOR_COMMAND = "__service-supervisor";

const SERVICE_SUPERVISOR_ENTRY_PATH = fileURLToPath(new URL("../index.js", import.meta.url));
const MAX_CAPTURED_CHILD_STDERR_LENGTH = 8_192;

export interface ServiceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ServiceCommandRunner {
  run(cmd: string, args: string[]): Promise<ServiceCommandResult>;
}

export const defaultServiceCommandRunner: ServiceCommandRunner = {
  async run(cmd: string, args: string[]): Promise<ServiceCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        encoding: "utf8",
        timeout: 10000,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: (error.stdout ?? "").trim(),
        stderr: (error.stderr ?? error.message ?? String(err)).trim(),
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }
  },
};

export interface ServiceSupervisorOptions {
  command: string;
  args?: readonly string[];
  resinHome?: string;
  env?: NodeJS.ProcessEnv;
  tracker?: RecoveryStateTracker;
  signal?: AbortSignal;
  stabilityWindowMs?: number;
  stabilityWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  report?: (message: string) => void;
  harnessHealthSchedulerFactory?: (
    options: HarnessHealthSchedulerOptions,
  ) => HarnessHealthScheduler;
}

export interface ServiceSupervisorResult {
  reason: "TRIPPED" | "SHUTDOWN";
  childExitCount: number;
  state: RecoveryState;
}

interface SupervisedChildExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: Error;
}

export async function runServiceSupervisor(
  options: ServiceSupervisorOptions,
): Promise<ServiceSupervisorResult> {
  if (options.command.length === 0) {
    throw new Error("Service supervisor requires a child command");
  }

  const resinHome =
    options.resinHome ?? process.env.RESIN_HOME ?? path.join(os.homedir(), ".resin");
  const tracker = options.tracker ?? new RecoveryStateTracker({ resinHome });
  const wait = options.wait ?? waitForSupervisorDelay;
  const stabilityWindowMs = options.stabilityWindowMs ?? CRASH_WINDOW_MS;
  const stabilityWait = options.stabilityWait ?? waitForSupervisorDelay;
  if (!Number.isSafeInteger(stabilityWindowMs) || stabilityWindowMs < 0) {
    throw new RangeError("Supervisor stability window must be a non-negative safe integer");
  }

  const report =
    options.report ??
    ((message: string): void => {
      process.stderr.write(`[resin recovery] ${message}\n`);
    });
  const childArguments = [...(options.args ?? [])];
  const childEnvironment = {
    ...process.env,
    ...options.env,
    RESIN_HOME: resinHome,
  };
  const shutdownController = new AbortController();
  const requestShutdown = (): void => {
    shutdownController.abort();
  };
  const requestedSignal = options.signal;
  if (requestedSignal?.aborted) {
    requestShutdown();
  } else {
    requestedSignal?.addEventListener("abort", requestShutdown, { once: true });
  }
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  let harnessHealthScheduler: HarnessHealthScheduler | undefined;
  if (!process.env.VITEST || options.harnessHealthSchedulerFactory) {
    try {
      const schedulerFactory = options.harnessHealthSchedulerFactory ?? startHarnessHealthScheduler;
      harnessHealthScheduler = schedulerFactory({ resinHome });
    } catch {
      // Health automation cannot disrupt the resident service or its supervised child.
    }
  }

  let childExitCount = 0;
  try {
    while (!shutdownController.signal.aborted) {
      const currentState = await tracker.getState();
      if (currentState.status === "TRIPPED") {
        return { reason: "TRIPPED", childExitCount, state: currentState };
      }

      const childExit = await runSupervisedChild({
        command: options.command,
        args: childArguments,
        environment: childEnvironment,
        tracker,
        recoveryState: currentState,
        stabilityWindowMs,
        stabilityWait,
        shutdownSignal: shutdownController.signal,
      });
      if (shutdownController.signal.aborted) {
        return {
          reason: "SHUTDOWN",
          childExitCount,
          state: await tracker.getState(),
        };
      }

      childExitCount += 1;
      if (
        childExit.exitCode === 0 &&
        childExit.signal === null &&
        childExit.spawnError === undefined
      ) {
        return {
          reason: "SHUTDOWN",
          childExitCount,
          state: await tracker.getState(),
        };
      }

      const diagnostic = {
        message: childExit.spawnError
          ? `Daemon process could not start: ${childExit.spawnError.message}`
          : `Daemon process exited${
              childExit.exitCode === null ? "" : ` with code ${childExit.exitCode}`
            }${childExit.signal === null ? "" : ` after signal ${childExit.signal}`}`,
        stderr: childExit.stderr,
        command: options.command,
      };
      const decision = await tracker.recordCrash({
        error: diagnostic,
        ...(childExit.exitCode === null ? {} : { exitCode: childExit.exitCode }),
      });

      if (!decision.shouldRestart) {
        report(
          `circuit breaker TRIPPED after ${decision.crashCount} child exits; diagnostics: ${tracker.crashLogPath}`,
        );
        return {
          reason: "TRIPPED",
          childExitCount,
          state: decision.state,
        };
      }

      const delayMs = decision.delayMs;
      if (delayMs === undefined) {
        throw new Error("Recovery tracker omitted a restart delay");
      }
      report(`child exited; restart ${decision.state.restartCount} scheduled in ${delayMs}ms`);
      try {
        await wait(delayMs, shutdownController.signal);
      } catch (error: unknown) {
        if (!isAbortError(error) || !shutdownController.signal.aborted) {
          throw error;
        }
      }
    }

    return {
      reason: "SHUTDOWN",
      childExitCount,
      state: await tracker.getState(),
    };
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    requestedSignal?.removeEventListener("abort", requestShutdown);
    try {
      harnessHealthScheduler?.stop();
    } catch {
      // Scheduler cleanup is best-effort during supervisor shutdown.
    }
  }
}

interface RunSupervisedChildOptions {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  tracker: RecoveryStateTracker;
  recoveryState: RecoveryState;
  stabilityWindowMs: number;
  stabilityWait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  shutdownSignal: AbortSignal;
}

async function runSupervisedChild(
  options: RunSupervisedChildOptions,
): Promise<SupervisedChildExit> {
  const child = spawn(options.command, options.args, {
    env: options.environment,
    stdio: ["ignore", "inherit", "pipe"],
  });
  let capturedStderr = "";
  let pendingStderr = "";
  let spawnError: Error | undefined;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    capturedStderr = `${capturedStderr}${chunk}`.slice(-MAX_CAPTURED_CHILD_STDERR_LENGTH);
    pendingStderr += chunk;
    let newlineIndex = pendingStderr.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = pendingStderr.slice(0, newlineIndex);
      process.stderr.write(line.length === 0 ? "\n" : `${sanitizeCrashDiagnostic(line)}\n`);
      pendingStderr = pendingStderr.slice(newlineIndex + 1);
      newlineIndex = pendingStderr.indexOf("\n");
    }
    if (pendingStderr.length > MAX_CAPTURED_CHILD_STDERR_LENGTH) {
      pendingStderr = pendingStderr.slice(-MAX_CAPTURED_CHILD_STDERR_LENGTH);
    }
  });

  const stopChild = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  };
  if (options.shutdownSignal.aborted) {
    stopChild();
  } else {
    options.shutdownSignal.addEventListener("abort", stopChild, { once: true });
  }

  const childExited = new Promise<SupervisedChildExit>((resolve) => {
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (pendingStderr.length > 0) {
        process.stderr.write(`${sanitizeCrashDiagnostic(pendingStderr)}\n`);
      }
      resolve({
        exitCode,
        signal,
        stderr: capturedStderr,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });

  const stabilityController = new AbortController();
  const stabilityTask =
    options.recoveryState.status === "DEGRADED"
      ? options
          .stabilityWait(options.stabilityWindowMs, stabilityController.signal)
          .then(async () => {
            if (!stabilityController.signal.aborted) {
              await options.tracker.recordStableRuntime();
            }
          })
      : undefined;

  try {
    if (stabilityTask) {
      const firstResult = await Promise.race([
        childExited.then((exit) => ({ kind: "exit" as const, exit })),
        stabilityTask.then(
          () => ({ kind: "stable" as const }),
          (error: unknown) => ({ kind: "stability-error" as const, error }),
        ),
      ]);
      if (firstResult.kind === "exit") {
        stabilityController.abort();
        await stabilityTask.catch((error: unknown) => {
          if (!isAbortError(error)) {
            throw error;
          }
        });
        return firstResult.exit;
      }
      if (firstResult.kind === "stability-error") {
        stopChild();
        await childExited;
        throw firstResult.error;
      }
    }
    return await childExited;
  } finally {
    stabilityController.abort();
    options.shutdownSignal.removeEventListener("abort", stopChild);
  }
}

async function waitForSupervisorDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await waitForTimeout(delayMs, undefined, { signal });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function createSupervisorProgramArguments(
  daemonPath: string,
  resinHome: string,
  nodePath: string,
): string[] {
  const childCommand = daemonPath.endsWith(".js")
    ? [nodePath, daemonPath, "--foreground"]
    : [daemonPath, "--foreground"];
  return [
    nodePath,
    SERVICE_SUPERVISOR_ENTRY_PATH,
    SERVICE_SUPERVISOR_COMMAND,
    "--resin-home",
    resinHome,
    "--",
    ...childCommand,
  ];
}

function quoteSystemdArgument(argument: string): string {
  const escaped = argument
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("%", "%%");
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function formatSystemdEnvironment(name: string, value: string): string {
  return `Environment=${quoteSystemdArgument(`${name}=${value}`)}`;
}

function quoteShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", "'\"'\"'")}'`;
}

export interface ServiceInstallOptions {
  daemonPath?: string;
  homeDir?: string;
  resinHome?: string;
  nodePath?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  force?: boolean;
}

export interface ServiceInstallResult {
  success: boolean;
  unitPath: string;
  unitContent: string;
  serviceName: string;
  enabled: boolean;
  started: boolean;
  error?: string;
}

export interface ServiceUninstallResult {
  success: boolean;
  unitPath: string;
  stopped: boolean;
  disabled: boolean;
  removed: boolean;
  error?: string;
}

export interface ServiceStatusInfo {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  serviceName: string;
  unitPath: string;
  pid?: number;
  state?: string;
  rawStatus?: string;
}

export interface UserServiceManagerOptions {
  platform?: "linux" | "darwin" | "wsl" | "systemd" | "launchd";
  homeDir?: string;
  resinHome?: string;
  daemonPath?: string;
  nodePath?: string;
  fsBridge?: ConfigFsBridge;
  runner?: ServiceCommandRunner;
  env?: Record<string, string>;
}

export interface UserServiceManager {
  readonly name: string;
  readonly platform: "systemd" | "launchd" | "wsl";
  install(options?: ServiceInstallOptions): Promise<ServiceInstallResult>;
  uninstall(): Promise<ServiceUninstallResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatusInfo>;
  isInstalled(): Promise<boolean>;
  getUnitDefinition(options?: ServiceInstallOptions): string;
  getUnitPath(): string;
}

// -----------------------------------------------------------------------------
// Systemd User Service Manager (Linux & WSL with Systemd)
// -----------------------------------------------------------------------------

export class SystemdUserServiceManager implements UserServiceManager {
  readonly name = "systemd";
  readonly platform = "systemd" as const;
  readonly serviceName = "resin.service";

  protected readonly homeDir: string;
  protected readonly resinHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }

  getUnitPath(): string {
    return path.join(this.homeDir, ".config", "systemd", "user", this.serviceName);
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const nodePath = options.nodePath ?? this.nodePath;
    const inheritedPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    const servicePath = Array.from(
      new Set([path.dirname(nodePath), ...inheritedPath.split(path.delimiter)]),
    ).join(path.delimiter);
    const envVars = {
      PATH: servicePath,
      ...this.defaultEnv,
      ...(options.env ?? {}),
    };

    const execStart = createSupervisorProgramArguments(daemonPath, resinHome, nodePath)
      .map(quoteSystemdArgument)
      .join(" ");

    const envLines = [
      formatSystemdEnvironment("RESIN_HOME", resinHome),
      formatSystemdEnvironment("NODE_ENV", "production"),
      ...Object.entries(envVars).map(([name, value]) => formatSystemdEnvironment(name, value)),
    ];
    // Native recovery applies only if the supervisor itself fails; TRIPPED exits successfully.
    const systemdStartLimitBurst = MAX_CRASHES_IN_WINDOW + 1;

    return `[Unit]
Description=Resin Daemon
Documentation=https://github.com/Resin-AI/resin
After=network.target
StartLimitIntervalSec=${CRASH_WINDOW_MS / 1_000}s
StartLimitBurst=${systemdStartLimitBurst}

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=${INITIAL_RESTART_DELAY_MS / 1_000}s
${envLines.join("\n")}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  }

  async isInstalled(): Promise<boolean> {
    return this.fsBridge.exists(this.getUnitPath());
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const unitPath = this.getUnitPath();
    const unitContent = this.getUnitDefinition(options);
    const autoStart = options.autoStart ?? true;

    try {
      await this.fsBridge.mkdirp(path.dirname(unitPath));
      await this.fsBridge.writeFile(unitPath, unitContent);

      // Reload systemd daemon
      await this.runner.run("systemctl", ["--user", "daemon-reload"]);

      // Enable service
      const enableResult = await this.runner.run("systemctl", [
        "--user",
        "enable",
        this.serviceName,
      ]);
      const enabled = enableResult.exitCode === 0;

      let started = false;
      if (autoStart) {
        const startResult = await this.runner.run("systemctl", [
          "--user",
          "start",
          this.serviceName,
        ]);
        started = startResult.exitCode === 0;
      }

      return {
        success: true,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const unitPath = this.getUnitPath();
    let stopped = false;
    let disabled = false;
    let removed = false;

    try {
      // Stop service
      const stopResult = await this.runner.run("systemctl", ["--user", "stop", this.serviceName]);
      stopped = stopResult.exitCode === 0;

      // Disable service
      const disableResult = await this.runner.run("systemctl", [
        "--user",
        "disable",
        this.serviceName,
      ]);
      disabled = disableResult.exitCode === 0;

      // Remove unit file
      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
        removed = true;
      }

      // Reload daemon
      await this.runner.run("systemctl", ["--user", "daemon-reload"]);

      return {
        success: true,
        unitPath,
        stopped,
        disabled,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        stopped,
        disabled,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "start", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "stop", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    const res = await this.runner.run("systemctl", ["--user", "restart", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to restart systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async status(): Promise<ServiceStatusInfo> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getUnitPath(),
        state: "not_installed",
      };
    }

    const [activeRes, enabledRes, statusRes] = await Promise.all([
      this.runner.run("systemctl", ["--user", "is-active", this.serviceName]),
      this.runner.run("systemctl", ["--user", "is-enabled", this.serviceName]),
      this.runner.run("systemctl", ["--user", "status", this.serviceName]),
    ]);

    const active = activeRes.exitCode === 0 && activeRes.stdout.trim() === "active";
    const enabled = enabledRes.exitCode === 0 && enabledRes.stdout.trim() === "enabled";

    let pid: number | undefined;
    const pidMatch = statusRes.stdout.match(/Main PID:\s*(\d+)/i);
    if (pidMatch?.[1]) {
      pid = Number.parseInt(pidMatch[1], 10);
    }

    return {
      installed: true,
      active,
      enabled,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: statusRes.stdout || statusRes.stderr,
    };
  }
}

// -----------------------------------------------------------------------------
// Launchd User Service Manager (macOS LaunchAgents)
// -----------------------------------------------------------------------------

export class LaunchdUserServiceManager implements UserServiceManager {
  readonly name = "launchd";
  readonly platform = "launchd" as const;
  readonly serviceName = "com.resin.daemon";

  protected readonly homeDir: string;
  protected readonly resinHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }

  getUnitPath(): string {
    return path.join(this.homeDir, "Library", "LaunchAgents", `${this.serviceName}.plist`);
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const logDir = path.join(resinHome, "logs");
    const envVars = { ...this.defaultEnv, ...(options.env ?? {}) };

    const nodePath = options.nodePath ?? this.nodePath;
    const programArgs = createSupervisorProgramArguments(daemonPath, resinHome, nodePath);

    const argsXml = programArgs
      .map((arg) => `        <string>${this.escapeXml(arg)}</string>`)
      .join("\n");

    const envXml = [
      `        <key>RESIN_HOME</key>\n        <string>${this.escapeXml(resinHome)}</string>`,
      `        <key>NODE_ENV</key>\n        <string>production</string>`,
      ...Object.entries(envVars).map(
        ([k, v]) =>
          `        <key>${this.escapeXml(k)}</key>\n        <string>${this.escapeXml(v)}</string>`,
      ),
    ].join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${this.serviceName}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${this.escapeXml(path.join(logDir, "daemon.stdout.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${this.escapeXml(path.join(logDir, "daemon.stderr.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
</dict>
</plist>
`;
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async isInstalled(): Promise<boolean> {
    return this.fsBridge.exists(this.getUnitPath());
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const unitPath = this.getUnitPath();
    const unitContent = this.getUnitDefinition(options);
    const autoStart = options.autoStart ?? true;

    try {
      await this.fsBridge.mkdirp(path.dirname(unitPath));
      await this.fsBridge.writeFile(unitPath, unitContent);

      let started = false;
      if (autoStart) {
        // Unload first in case it's currently loaded
        await this.runner.run("launchctl", ["unload", "-w", unitPath]);
        const loadResult = await this.runner.run("launchctl", ["load", "-w", unitPath]);
        started = loadResult.exitCode === 0;
      }

      return {
        success: true,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: true,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const unitPath = this.getUnitPath();
    let stopped = false;
    let removed = false;

    try {
      const unloadRes = await this.runner.run("launchctl", ["unload", "-w", unitPath]);
      stopped = unloadRes.exitCode === 0;

      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
        removed = true;
      }

      return {
        success: true,
        unitPath,
        stopped,
        disabled: true,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath,
        stopped,
        disabled: false,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const unitPath = this.getUnitPath();
    const res = await this.runner.run("launchctl", ["load", "-w", unitPath]);
    if (res.exitCode !== 0) {
      // Try launchctl start if already loaded
      const startRes = await this.runner.run("launchctl", ["start", this.serviceName]);
      if (startRes.exitCode !== 0) {
        throw new Error(`Failed to start launchd service ${this.serviceName}: ${res.stderr}`);
      }
    }
  }

  async stop(): Promise<void> {
    const unitPath = this.getUnitPath();
    const res = await this.runner.run("launchctl", ["unload", "-w", unitPath]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop launchd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    await this.stop().catch(() => {});
    await this.start();
  }

  async status(): Promise<ServiceStatusInfo> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getUnitPath(),
        state: "not_installed",
      };
    }

    const listRes = await this.runner.run("launchctl", ["list", this.serviceName]);
    const active = listRes.exitCode === 0;

    let pid: number | undefined;
    if (active) {
      const pidMatch =
        listRes.stdout.match(/"PID"\s*=\s*(\d+)/i) ?? listRes.stdout.match(/^(\d+)\s+/m);
      if (pidMatch?.[1]) {
        pid = Number.parseInt(pidMatch[1], 10);
      }
    }

    return {
      installed: true,
      active,
      enabled: true,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: listRes.stdout || listRes.stderr,
    };
  }
}

// -----------------------------------------------------------------------------
// WSL User Service Manager (systemd when available, script fallback otherwise)
// -----------------------------------------------------------------------------

export class WslUserServiceManager implements UserServiceManager {
  readonly name = "wsl";
  readonly platform = "wsl" as const;
  readonly serviceName = "resin";

  private readonly systemdDelegate: SystemdUserServiceManager;
  private readonly homeDir: string;
  private readonly resinHome: string;
  private readonly defaultDaemonPath: string;
  private readonly nodePath: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly runner: ServiceCommandRunner;
  private readonly defaultEnv: Record<string, string>;
  private systemdAvailableCache?: boolean;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};

    this.systemdDelegate = new SystemdUserServiceManager(options);
  }

  async checkSystemdAvailable(): Promise<boolean> {
    if (this.systemdAvailableCache !== undefined) {
      return this.systemdAvailableCache;
    }

    try {
      const res = await this.runner.run("systemctl", ["--user", "is-system-running"]);
      // Return true if systemctl is usable (returns running, degraded, initializing, etc. with exit code 0 or 1 without command not found)
      this.systemdAvailableCache = res.exitCode === 0 || res.stdout.length > 0;
      return this.systemdAvailableCache;
    } catch {
      this.systemdAvailableCache = false;
      return false;
    }
  }

  getUnitPath(): string {
    return path.join(this.resinHome, "services", "wsl-service.json");
  }

  getFallbackScriptPath(): string {
    return path.join(this.resinHome, "bin", "resin-service.sh");
  }

  getPidPath(): string {
    return path.join(this.resinHome, "run", "daemon.pid");
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const nodePath = options.nodePath ?? this.nodePath;
    const logDir = path.join(resinHome, "logs");
    const runDir = path.join(resinHome, "run");

    const execCmd = createSupervisorProgramArguments(daemonPath, resinHome, nodePath)
      .map(quoteShellArgument)
      .join(" ");

    return `#!/bin/sh
# Resin Daemon WSL Service Fallback
export RESIN_HOME=${quoteShellArgument(resinHome)}
export NODE_ENV=production
mkdir -p ${quoteShellArgument(logDir)} ${quoteShellArgument(runDir)}
nohup ${execCmd} >> ${quoteShellArgument(path.join(logDir, "daemon.stdout.log"))} 2>> ${quoteShellArgument(path.join(logDir, "daemon.stderr.log"))} &
echo $! > ${quoteShellArgument(path.join(runDir, "daemon.pid"))}
`;
  }

  async isInstalled(): Promise<boolean> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.isInstalled();
    }
    return (
      (await this.fsBridge.exists(this.getFallbackScriptPath())) ||
      (await this.fsBridge.exists(this.getUnitPath()))
    );
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.install(options);
    }

    const scriptPath = this.getFallbackScriptPath();
    const scriptContent = this.getUnitDefinition(options);
    const unitPath = this.getUnitPath();

    try {
      await this.fsBridge.mkdirp(path.dirname(scriptPath));
      await this.fsBridge.mkdirp(path.dirname(unitPath));

      await this.fsBridge.writeFile(scriptPath, scriptContent);
      await this.fsBridge.writeFile(
        unitPath,
        JSON.stringify(
          {
            type: "wsl_fallback",
            installedAt: new Date().toISOString(),
            scriptPath,
            resinHome: this.resinHome,
          },
          null,
          2,
        ),
      );

      let started = false;
      if (options.autoStart ?? true) {
        await this.start();
        started = true;
      }

      return {
        success: true,
        unitPath: scriptPath,
        unitContent: scriptContent,
        serviceName: this.serviceName,
        enabled: true,
        started,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath: scriptPath,
        unitContent: scriptContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: msg,
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.uninstall();
    }

    let stopped = false;
    let removed = false;

    try {
      await this.stop().catch(() => {});
      stopped = true;

      const scriptPath = this.getFallbackScriptPath();
      const unitPath = this.getUnitPath();

      if (await this.fsBridge.exists(scriptPath)) {
        await this.fsBridge.unlink(scriptPath);
        removed = true;
      }
      if (await this.fsBridge.exists(unitPath)) {
        await this.fsBridge.unlink(unitPath);
      }

      return {
        success: true,
        unitPath: scriptPath,
        stopped,
        disabled: true,
        removed,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        unitPath: this.getFallbackScriptPath(),
        stopped,
        disabled: false,
        removed,
        error: msg,
      };
    }
  }

  async start(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.start();
    }

    const scriptPath = this.getFallbackScriptPath();
    const res = await this.runner.run("sh", [scriptPath]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start WSL fallback daemon service: ${res.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.stop();
    }

    const pidPath = this.getPidPath();
    const content = await this.fsBridge.readFile(pidPath);
    if (!content) {
      return;
    }

    const pid = Number.parseInt(content.trim(), 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process might already be dead
      }
    }
    await this.fsBridge.unlink(pidPath).catch(() => {});
  }

  async restart(): Promise<void> {
    await this.stop().catch(() => {});
    await this.start();
  }

  async status(): Promise<ServiceStatusInfo> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.status();
    }

    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        active: false,
        enabled: false,
        serviceName: this.serviceName,
        unitPath: this.getFallbackScriptPath(),
        state: "not_installed",
      };
    }

    const pidPath = this.getPidPath();
    const content = await this.fsBridge.readFile(pidPath);
    let active = false;
    let pid: number | undefined;

    if (content) {
      pid = Number.parseInt(content.trim(), 10);
      if (!Number.isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          active = true;
        } catch {
          active = false;
        }
      }
    }

    return {
      installed: true,
      active,
      enabled: true,
      serviceName: this.serviceName,
      unitPath: this.getFallbackScriptPath(),
      pid,
      state: active ? "active" : "inactive",
      rawStatus: active ? `Process running with PID ${pid}` : "Process not running",
    };
  }
}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

export function createUserServiceManager(
  options: UserServiceManagerOptions = {},
): UserServiceManager {
  if (options.platform) {
    if (options.platform === "wsl") {
      return new WslUserServiceManager(options);
    }
    if (options.platform === "darwin" || options.platform === "launchd") {
      return new LaunchdUserServiceManager(options);
    }
    return new SystemdUserServiceManager(options);
  }

  const detected = detectPlatform({
    platform: process.platform,
    env: process.env,
  });

  if (detected.isWsl) {
    return new WslUserServiceManager(options);
  }
  if (detected.os === "darwin") {
    return new LaunchdUserServiceManager(options);
  }
  return new SystemdUserServiceManager(options);
}
