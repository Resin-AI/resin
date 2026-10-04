import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
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
import { V1_SUPPORT_MATRIX } from "../platform/platform.js";
import {
  CRASH_WINDOW_MS,
  INITIAL_RESTART_DELAY_MS,
  MAX_CRASHES_IN_WINDOW,
  type RecordCrashInput,
  type RecoveryState,
  RecoveryStateTracker,
  sanitizeCrashDiagnostic,
} from "./recovery-state.js";
import {
  WINDOWS_TASK_NAME_ENV,
  WindowsTaskBackend,
  type WindowsTaskBackendOptions,
  buildServiceHostArguments,
  buildWindowsTaskXml,
  serviceStopRequestPath,
} from "./windows-task.js";

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
        windowsHide: true,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: unknown) {
      let stdout = "";
      let stderr = String(err);
      let exitCode = 1;
      if (err instanceof Error) {
        stderr = err.message;
        if ("stdout" in err && String(err.stdout) === err.stdout) {
          stdout = err.stdout;
        }
        if ("stderr" in err && String(err.stderr) === err.stderr) {
          stderr = err.stderr;
        }
        if ("code" in err && Number.isSafeInteger(err.code)) {
          exitCode = Number(err.code);
        }
      }
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
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
  /**
   * Starts resident automatic updates. Injected by the CLI entrypoint so the
   * service layer does not depend on the update engine.
   */
  autoUpdateFactory?: (options: { resinHome: string }) => { stop(): void } | undefined;
  /**
   * Watches for an out-of-band stop request. Windows has no SIGTERM to deliver
   * to the task's processes, so `resin service stop` writes a request file that
   * this watcher reports. Defaults to polling `<resinHome>/run/service-stop.request`
   * on win32 and to no watcher elsewhere.
   */
  stopRequestWatcher?: (onRequest: () => void) => { close(): void };
  /**
   * Asks the running daemon to drain and exit (e.g. over IPC) before the
   * supervisor kills it. Resolves true when the request was accepted.
   */
  requestChildShutdown?: () => Promise<boolean>;
  /** How long a daemon that accepted a shutdown request may take to exit. */
  childShutdownGraceMs?: number;
  platform?: NodeJS.Platform;
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
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Ctrl+Break in a console, the only other stop signal Windows delivers.
    process.once("SIGBREAK", requestShutdown);
  }
  let stopRequestWatch: { close(): void } | undefined;
  try {
    const watcherFactory =
      options.stopRequestWatcher ??
      (platform === "win32" ? createStopRequestFileWatcher(resinHome) : undefined);
    stopRequestWatch = watcherFactory?.(requestShutdown);
  } catch (error: unknown) {
    report(
      `stop-request watcher unavailable: ${sanitizeCrashDiagnostic(error instanceof Error ? error.message : String(error))}`,
    );
  }

  let harnessHealthScheduler: HarnessHealthScheduler | undefined;
  if (!process.env.VITEST || options.harnessHealthSchedulerFactory) {
    try {
      const schedulerFactory = options.harnessHealthSchedulerFactory ?? startHarnessHealthScheduler;
      harnessHealthScheduler = schedulerFactory({ resinHome });
    } catch {
      // Health automation cannot disrupt the resident service or its supervised child.
    }
  }

  let autoUpdate: { stop(): void } | undefined;
  try {
    autoUpdate = options.autoUpdateFactory?.({ resinHome });
  } catch (error: unknown) {
    report(
      `automatic updates unavailable: ${sanitizeCrashDiagnostic(error instanceof Error ? error.message : String(error))}`,
    );
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
        platform,
        requestChildShutdown: options.requestChildShutdown,
        childShutdownGraceMs: options.childShutdownGraceMs ?? 15_000,
        graceWait: options.stabilityWait ?? waitForSupervisorDelay,
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
      const crashRecord: RecordCrashInput = {
        error: diagnostic,
      };
      if (childExit.exitCode !== null) {
        crashRecord.exitCode = childExit.exitCode;
      }
      const decision = await tracker.recordCrash(crashRecord);

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
    process.removeListener("SIGBREAK", requestShutdown);
    requestedSignal?.removeEventListener("abort", requestShutdown);
    try {
      stopRequestWatch?.close();
    } catch {
      // Watcher cleanup is best-effort during supervisor shutdown.
    }
    try {
      harnessHealthScheduler?.stop();
    } catch {
      // Scheduler cleanup is best-effort during supervisor shutdown.
    }
    try {
      autoUpdate?.stop();
    } catch {
      // Update automation cleanup is best-effort during supervisor shutdown.
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
  platform: NodeJS.Platform;
  requestChildShutdown?: () => Promise<boolean>;
  childShutdownGraceMs: number;
  graceWait: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const STOP_REQUEST_POLL_INTERVAL_MS = 1_000;

/**
 * Polls for the stop-request file written by the Windows service manager. A
 * request left over from before this supervisor started is discarded.
 */
function createStopRequestFileWatcher(
  resinHome: string,
): (onRequest: () => void) => { close(): void } {
  return (onRequest) => {
    const requestPath = serviceStopRequestPath(resinHome);
    try {
      fsSync.rmSync(requestPath, { force: true });
    } catch {
      // A stale request that cannot be removed is reported below as a real one.
    }
    const timer = setInterval(() => {
      if (fsSync.existsSync(requestPath)) {
        clearInterval(timer);
        try {
          fsSync.rmSync(requestPath, { force: true });
        } catch {
          // The manager also clears it once the task has stopped.
        }
        onRequest();
      }
    }, STOP_REQUEST_POLL_INTERVAL_MS);
    timer.unref();
    return { close: () => clearInterval(timer) };
  };
}

/** Kills a child and, on Windows, every process it started. */
function killChildTree(child: ChildProcess, platform: NodeJS.Platform): void {
  // A child that failed to spawn has no pid; kill() on it would signal an arbitrary process.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const taskkill = spawn(
      path.win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    taskkill.once("error", () => {
      child.kill();
    });
    taskkill.once("exit", (code) => {
      if (code !== 0) {
        child.kill();
      }
    });
    return;
  }
  child.kill("SIGTERM");
}

async function runSupervisedChild(
  options: RunSupervisedChildOptions,
): Promise<SupervisedChildExit> {
  const child = spawn(options.command, options.args, {
    env: options.environment,
    stdio: ["ignore", "inherit", "pipe"],
    windowsHide: true,
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

  const graceController = new AbortController();
  const stopChild = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    // POSIX delivers SIGTERM so the daemon drains itself. Windows has no such
    // signal: ask the daemon to drain (IPC) and kill the tree after the grace period.
    if (options.platform !== "win32" || options.requestChildShutdown === undefined) {
      killChildTree(child, options.platform);
      return;
    }
    void options
      .requestChildShutdown()
      .catch(() => false)
      .then(async (accepted) => {
        if (accepted) {
          await options.graceWait(options.childShutdownGraceMs, graceController.signal);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!graceController.signal.aborted) {
          killChildTree(child, options.platform);
        }
      });
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
      const exitResult: SupervisedChildExit = {
        exitCode,
        signal,
        stderr: capturedStderr,
      };
      if (spawnError) {
        exitResult.spawnError = spawnError;
      }
      resolve(exitResult);
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
          (error: Error | string | { name?: string }) => ({
            kind: "stability-error" as const,
            error,
          }),
        ),
      ]);
      if (firstResult.kind === "exit") {
        stabilityController.abort();
        await stabilityTask.catch((error: Error | string | { name?: string }) => {
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
    graceController.abort();
    options.shutdownSignal.removeEventListener("abort", stopChild);
  }
}

async function waitForSupervisorDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await waitForTimeout(delayMs, undefined, { signal });
}

function isAbortError(cause: unknown): boolean {
  if (cause instanceof Error) {
    return cause.name === "AbortError";
  }
  if (cause !== null && cause !== undefined && cause instanceof Object && "name" in cause) {
    return cause.name === "AbortError";
  }
  return false;
}

export function resolveSupervisorEntryPath(resinHome: string, explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitPath;
  }

  const currentEntry = path.join(resinHome, "current", "apps", "cli", "dist", "index.js");
  const currentLink = path.join(resinHome, "current");
  const versionsDir = path.join(resinHome, "versions");

  const normalizedDefault = path.resolve(SERVICE_SUPERVISOR_ENTRY_PATH);
  const normalizedVersions = path.resolve(versionsDir);

  if (
    normalizedDefault.startsWith(normalizedVersions + path.sep) ||
    normalizedDefault.includes(`${path.sep}versions${path.sep}`)
  ) {
    return currentEntry;
  }

  try {
    if (
      fsSync.existsSync(currentEntry) ||
      fsSync.existsSync(currentLink) ||
      fsSync.existsSync(versionsDir)
    ) {
      return currentEntry;
    }
  } catch {
    // Fall back to default
  }

  return SERVICE_SUPERVISOR_ENTRY_PATH;
}

const MINIMUM_SERVICE_NODE_MAJOR = Number.parseInt(V1_SUPPORT_MATRIX.toolchain.node.minimum, 10);

/**
 * Whether a Node executable can still run the supervisor: an absolute, executable path whose
 * `--version` reports a supported major. Only consulted when a unit's runtime differs from the
 * caller's, so the version probe is rare.
 */
export function isUsableServiceNodeRuntime(runtimePath: string): boolean {
  if (!path.isAbsolute(runtimePath)) return false;
  try {
    fsSync.accessSync(runtimePath, fsSync.constants.X_OK);
    const probe = spawnSync(runtimePath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const major = /^v(\d+)\./.exec(probe.stdout?.trim() ?? "")?.[1];
    return probe.status === 0 && major !== undefined && Number(major) >= MINIMUM_SERVICE_NODE_MAJOR;
  } catch {
    return false;
  }
}

interface UnitRuntime {
  /** The runtime argument exactly as the unit format spells it. */
  readonly token: string;
  readonly path: string;
}

function parseSystemdRuntime(execStart: string): UnitRuntime | null {
  const token = /^("(?:[^"\\]|\\.)*"|\S+)/.exec(execStart.trim())?.[1];
  if (!token) return null;
  const unquoted = token.startsWith('"')
    ? token
        .slice(1, -1)
        .replace(/\\(.)/g, (_match, escaped: string) =>
          escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped,
        )
    : token;
  return { token, path: unquoted.replaceAll("%%", "%") };
}

function parseLaunchdRuntime(programArguments: string): UnitRuntime | null {
  const match = /<string>([^<]*)<\/string>/.exec(programArguments);
  if (!match) return null;
  const runtimePath = match[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
  return { token: match[0], path: runtimePath };
}

function parseShellRuntime(command: string): UnitRuntime | null {
  const token = /^'(?:[^']|'"'"')*'/.exec(command.trim())?.[0];
  if (!token) return null;
  return { token, path: token.slice(1, -1).replaceAll(`'"'"'`, "'") };
}

/**
 * Rewrites the on-disk command to the expected runtime when the only difference is which
 * usable Node runs it. The unit's runtime comes from whichever shell installed it, so a caller
 * with another `node` on PATH must not see the unit as stale. The runtime is replaced as a whole
 * whitespace-delimited argument, which also covers a Node-run daemon child command.
 */
function withExpectedRuntime(
  onDiskCommand: string,
  expectedCommand: string,
  parse: (command: string) => UnitRuntime | null,
  isUsableRuntime: (runtimePath: string) => boolean,
): string {
  const onDisk = parse(onDiskCommand);
  const expected = parse(expectedCommand);
  if (!onDisk || !expected || onDisk.path === expected.path || !isUsableRuntime(onDisk.path)) {
    return onDiskCommand;
  }
  const escapedToken = onDisk.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return onDiskCommand.replace(
    new RegExp(`(^|\\s)${escapedToken}(?=\\s|$)`, "g"),
    (_match, leading: string) => `${leading}${expected.token}`,
  );
}

export interface SupervisorUnitComparisonOptions {
  /** Decides whether the on-disk unit's Node runtime can still run the supervisor. */
  readonly isUsableRuntime?: (runtimePath: string) => boolean;
}

export function isStaleSupervisorUnitContent(
  onDiskContent: string | null | undefined,
  expectedContent: string,
  options: SupervisorUnitComparisonOptions = {},
): boolean {
  if (!onDiskContent || onDiskContent.trim().length === 0) {
    return true;
  }
  const isUsableRuntime = options.isUsableRuntime ?? isUsableServiceNodeRuntime;

  // 1. Obsolete versioned supervisor paths are always stale
  if (
    /[\\/]versions[\\/]v[^\\/\s"'&]+[\\/]apps[\\/]cli[\\/]dist[\\/]index\.js/.test(onDiskContent) ||
    /[\\/]versions[\\/]v[^\\/\s"'&]+[\\/]bin[\\/]resin/.test(onDiskContent)
  ) {
    return true;
  }

  // 2. Systemd: compare ExecStart directive only (ignoring volatile PATH or environment changes)
  const onDiskExecMatch = onDiskContent.match(/^ExecStart=(.*)$/m);
  const expectedExecMatch = expectedContent.match(/^ExecStart=(.*)$/m);
  if (onDiskExecMatch && expectedExecMatch) {
    const expectedExec = expectedExecMatch[1].trim();
    const onDiskExec = withExpectedRuntime(
      onDiskExecMatch[1].trim(),
      expectedExec,
      parseSystemdRuntime,
      isUsableRuntime,
    );
    return onDiskExec !== expectedExec;
  }
  // 3. Launchd: compare ProgramArguments array only
  const onDiskArgsMatch = onDiskContent.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  const expectedArgsMatch = expectedContent.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (onDiskArgsMatch && expectedArgsMatch) {
    const normalizeArgs = (str: string) => str.replace(/\s+/g, " ").trim();
    const expectedArgs = normalizeArgs(expectedArgsMatch[1]);
    const onDiskArgs = withExpectedRuntime(
      normalizeArgs(onDiskArgsMatch[1]),
      expectedArgs,
      parseLaunchdRuntime,
      isUsableRuntime,
    );
    // Plists written before launchd agents carried PATH cannot start `#!/usr/bin/env node`.
    const pathKey = "<key>PATH</key>";
    return (
      onDiskArgs !== expectedArgs ||
      (expectedContent.includes(pathKey) && !onDiskContent.includes(pathKey))
    );
  }

  // 4. Windows task XML: compare the action's command and arguments
  const onDiskAction = onDiskContent.match(/<Exec>([\s\S]*?)<\/Exec>/);
  const expectedAction = expectedContent.match(/<Exec>([\s\S]*?)<\/Exec>/);
  if (onDiskAction?.[1] !== undefined && expectedAction?.[1] !== undefined) {
    const normalizeAction = (str: string) => str.replace(/\s+/g, " ").trim();
    return normalizeAction(onDiskAction[1]) !== normalizeAction(expectedAction[1]);
  }

  // 5. WSL fallback script: compare command invocation line
  const onDiskNohupMatch = onDiskContent.match(/^(?:nohup|exec)\s+(.*)$/m);
  const expectedNohupMatch = expectedContent.match(/^(?:nohup|exec)\s+(.*)$/m);
  if (onDiskNohupMatch && expectedNohupMatch) {
    const expectedNohup = expectedNohupMatch[1].trim();
    const onDiskNohup = withExpectedRuntime(
      onDiskNohupMatch[1].trim(),
      expectedNohup,
      parseShellRuntime,
      isUsableRuntime,
    );
    return onDiskNohup !== expectedNohup;
  }

  // Fallback: full trim comparison if specific directives are missing
  return onDiskContent.trim() !== expectedContent.trim();
}

/**
 * The daemon command the supervisor runs. Windows never goes through a shell:
 * `.cmd`/`.bat` launchers are refused, `.exe` runs directly, and anything else
 * (the `.mjs` launcher or a JS entry) runs under Node.
 */
function daemonChildCommand(daemonPath: string, nodePath: string, windows: boolean): string[] {
  if (!windows) {
    return daemonPath.endsWith(".js")
      ? [nodePath, daemonPath, "--foreground"]
      : [daemonPath, "--foreground"];
  }
  const extension = path.win32.extname(daemonPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    throw new Error(
      `The Windows service cannot run the daemon through a batch launcher (${daemonPath}); use the .mjs launcher.`,
    );
  }
  return extension === ".exe"
    ? [daemonPath, "--foreground"]
    : [nodePath, daemonPath, "--foreground"];
}

function createSupervisorProgramArguments(
  daemonPath: string,
  resinHome: string,
  nodePath: string,
  supervisorEntryPath?: string,
  windows = false,
): string[] {
  const resolvedSupervisorEntry = resolveSupervisorEntryPath(resinHome, supervisorEntryPath);
  const childCommand = daemonChildCommand(daemonPath, nodePath, windows);
  return [
    nodePath,
    resolvedSupervisorEntry,
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

function formatShellEnvironment(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid service environment variable name: ${name}`);
  }
  return `export ${name}=${quoteShellArgument(value)}`;
}

export interface ServiceInstallOptions {
  daemonPath?: string;
  homeDir?: string;
  resinHome?: string;
  nodePath?: string;
  supervisorEntryPath?: string;
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
  platform?: "linux" | "darwin" | "wsl" | "systemd" | "launchd" | "windows" | "windows-task";
  homeDir?: string;
  resinHome?: string;
  daemonPath?: string;
  nodePath?: string;
  supervisorEntryPath?: string;
  fsBridge?: ConfigFsBridge;
  runner?: ServiceCommandRunner;
  env?: Record<string, string>;
  /** Native Windows scheduled-task settings and test seams. */
  windowsTask?: WindowsTaskBackendOptions;
}

export interface UserServiceManager {
  readonly name: string;
  readonly platform: "systemd" | "launchd" | "wsl" | "windows-task" | "external";
  install(options?: ServiceInstallOptions): Promise<ServiceInstallResult>;
  uninstall(): Promise<ServiceUninstallResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  reload?(): Promise<void>;
  enable?(): Promise<void>;
  disable?(): Promise<void>;
  status(): Promise<ServiceStatusInfo>;
  isInstalled(): Promise<boolean>;
  getUnitDefinition(options?: ServiceInstallOptions): string;
  getUnitPath(): string;
}

// -----------------------------------------------------------------------------
// Systemd User Service Manager (Linux & WSL with Systemd)
// -----------------------------------------------------------------------------

/**
 * Service PATH: the directory of the Node that runs Resin first, then the installing shell's PATH
 * without entries under temporary directories. Those come from test fixtures or bootstrap
 * staging in the installing shell, vanish later, and must not shadow real tools for the service.
 */
function serviceSearchPath(nodePath: string): string {
  const inheritedPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const temporaryRoots = new Set(
    [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])].map((root) =>
      path.resolve(root),
    ),
  );
  const inheritedEntries = inheritedPath.split(path.delimiter).filter((entry) => {
    if (entry.length === 0) return false;
    const resolved = path.resolve(entry);
    for (const root of temporaryRoots) {
      if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return false;
    }
    return true;
  });
  return Array.from(new Set([path.dirname(nodePath), ...inheritedEntries])).join(path.delimiter);
}

/**
 * The Node runtime a (re)install writes: an explicit choice, else the installed unit's own runtime
 * while it stays usable, else the caller's. Without this, `resin repair` from a shell with another
 * `node` on PATH would swap the service's runtime.
 */
async function resolveInstallNodePath(input: {
  readonly explicitNodePath: string | undefined;
  readonly fallbackNodePath: string;
  readonly fsBridge: ConfigFsBridge;
  readonly definitionPath: string;
  readonly parseInstalledRuntime: (content: string) => UnitRuntime | null;
}): Promise<string> {
  if (input.explicitNodePath !== undefined) return input.explicitNodePath;
  let installed: string | null = null;
  try {
    installed = await input.fsBridge.readFile(input.definitionPath);
  } catch {
    installed = null;
  }
  const installedRuntime = installed ? input.parseInstalledRuntime(installed)?.path : undefined;
  return installedRuntime !== undefined &&
    installedRuntime !== input.fallbackNodePath &&
    isUsableServiceNodeRuntime(installedRuntime)
    ? installedRuntime
    : input.fallbackNodePath;
}

function parseInstalledSystemdRuntime(content: string): UnitRuntime | null {
  const execStart = /^ExecStart=(.*)$/m.exec(content)?.[1];
  return execStart === undefined ? null : parseSystemdRuntime(execStart);
}

export class SystemdUserServiceManager implements UserServiceManager {
  readonly name = "systemd";
  readonly platform = "systemd" as const;
  readonly serviceName = "resin.service";

  protected readonly homeDir: string;
  protected readonly resinHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly explicitNodePath?: string;
  protected readonly supervisorEntryPath?: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.explicitNodePath = options.nodePath;
    this.supervisorEntryPath = options.supervisorEntryPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }
  protected ensureLoginHomeForCommands(): void {
    if (
      this.runner === defaultServiceCommandRunner &&
      path.resolve(this.homeDir) !== path.resolve(os.homedir())
    ) {
      throw new Error(
        `Cannot issue login-session supervisor commands for custom home directory (${this.homeDir}) without an injected runner.`,
      );
    }
  }

  getUnitPath(): string {
    return path.join(this.homeDir, ".config", "systemd", "user", this.serviceName);
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const nodePath = options.nodePath ?? this.nodePath;
    const supervisorEntryPath = options.supervisorEntryPath ?? this.supervisorEntryPath;
    const envVars = {
      PATH: serviceSearchPath(nodePath),
      ...this.defaultEnv,
      ...(options.env ?? {}),
    };

    const execStart = createSupervisorProgramArguments(
      daemonPath,
      resinHome,
      nodePath,
      supervisorEntryPath,
    )
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
    const nodePath = await resolveInstallNodePath({
      explicitNodePath: options.nodePath ?? this.explicitNodePath,
      fallbackNodePath: this.nodePath,
      fsBridge: this.fsBridge,
      definitionPath: unitPath,
      parseInstalledRuntime: parseInstalledSystemdRuntime,
    });
    const unitContent = this.getUnitDefinition({ ...options, nodePath });
    const autoStart = options.autoStart ?? true;

    try {
      this.ensureLoginHomeForCommands();
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
      this.ensureLoginHomeForCommands();
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

  async enable(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "enable", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to enable systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async disable(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "disable", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to disable systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async start(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "start", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async stop(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "stop", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "restart", this.serviceName]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to restart systemd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async reload(): Promise<void> {
    this.ensureLoginHomeForCommands();
    const res = await this.runner.run("systemctl", ["--user", "daemon-reload"]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to reload systemd user daemon: ${res.stderr}`);
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
    this.ensureLoginHomeForCommands();
    const [activeRes, enabledRes, statusRes] = await Promise.all([
      this.runner.run("systemctl", ["--user", "is-active", this.serviceName]),
      this.runner.run("systemctl", ["--user", "is-enabled", this.serviceName]),
      this.runner.run("systemctl", ["--user", "status", this.serviceName]),
    ]);

    const activeState = activeRes.stdout.trim();
    const knownActiveStates: Record<string, true> = {
      active: true,
      inactive: true,
      failed: true,
      activating: true,
      deactivating: true,
    };
    if ((activeRes.exitCode !== 0 && activeRes.exitCode !== 3) || !knownActiveStates[activeState]) {
      const err =
        activeRes.stderr.trim() || activeRes.stdout.trim() || `exit code ${activeRes.exitCode}`;
      throw new Error(`Failed to determine systemd service state for ${this.serviceName}: ${err}`);
    }

    const active = activeState !== "inactive" && activeState !== "failed";
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
      state: activeState,
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
  protected readonly explicitNodePath?: string;
  protected readonly supervisorEntryPath?: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.explicitNodePath = options.nodePath;
    this.supervisorEntryPath = options.supervisorEntryPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
  }
  protected ensureLoginHomeForCommands(): void {
    if (
      this.runner === defaultServiceCommandRunner &&
      path.resolve(this.homeDir) !== path.resolve(os.homedir())
    ) {
      throw new Error(
        `Cannot issue login-session supervisor commands for custom home directory (${this.homeDir}) without an injected runner.`,
      );
    }
  }

  getUnitPath(): string {
    return path.join(this.homeDir, "Library", "LaunchAgents", `${this.serviceName}.plist`);
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const logDir = path.join(resinHome, "logs");
    const nodePath = options.nodePath ?? this.nodePath;
    // launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where `#!/usr/bin/env node`
    // cannot find a Homebrew, nvm or installer Node, so the daemon would exit 127 on every start.
    const envVars = {
      PATH: serviceSearchPath(nodePath),
      ...this.defaultEnv,
      ...(options.env ?? {}),
    };

    const supervisorEntryPath = options.supervisorEntryPath ?? this.supervisorEntryPath;
    const programArgs = createSupervisorProgramArguments(
      daemonPath,
      resinHome,
      nodePath,
      supervisorEntryPath,
    );
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
    const nodePath = await resolveInstallNodePath({
      explicitNodePath: options.nodePath ?? this.explicitNodePath,
      fallbackNodePath: this.nodePath,
      fsBridge: this.fsBridge,
      definitionPath: unitPath,
      parseInstalledRuntime: (content) => {
        const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
          content,
        )?.[1];
        return programArguments === undefined ? null : parseLaunchdRuntime(programArguments);
      },
    });
    const unitContent = this.getUnitDefinition({ ...options, nodePath });
    const autoStart = options.autoStart ?? true;

    try {
      this.ensureLoginHomeForCommands();
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
      this.ensureLoginHomeForCommands();
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
    this.ensureLoginHomeForCommands();
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
    this.ensureLoginHomeForCommands();
    const unitPath = this.getUnitPath();
    const res = await this.runner.run("launchctl", ["unload", "-w", unitPath]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to stop launchd service ${this.serviceName}: ${res.stderr}`);
    }
  }

  async restart(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.stop().catch(() => {});
    await this.start();
  }

  async reload(): Promise<void> {
    // launchd does not require an explicit daemon reload; configuration reloads on load/restart
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

    this.ensureLoginHomeForCommands();
    const listRes = await this.runner.run("launchctl", ["list", this.serviceName]);
    if (listRes.exitCode !== 0) {
      const combined = `${listRes.stderr}\n${listRes.stdout}`.toLowerCase();
      if (combined.includes("could not find service") || combined.includes("no such process")) {
        return {
          installed: true,
          active: false,
          enabled: true,
          serviceName: this.serviceName,
          unitPath: this.getUnitPath(),
          state: "inactive",
          rawStatus: listRes.stdout || listRes.stderr,
        };
      }
      const err = listRes.stderr.trim() || listRes.stdout.trim() || `exit code ${listRes.exitCode}`;
      throw new Error(`Failed to determine launchd service state for ${this.serviceName}: ${err}`);
    }

    const active = true;
    let pid: number | undefined;
    const pidMatch =
      listRes.stdout.match(/"PID"\s*=\s*(\d+)/i) ?? listRes.stdout.match(/^(\d+)\s+/m);
    if (pidMatch?.[1]) {
      pid = Number.parseInt(pidMatch[1], 10);
    }

    return {
      installed: true,
      active,
      enabled: true,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      pid,
      state: "active",
      rawStatus: listRes.stdout || listRes.stderr,
    };
  }
}

export class WslUserServiceManager implements UserServiceManager {
  readonly name = "wsl";
  readonly platform = "wsl" as const;
  readonly serviceName = "resin";

  private readonly systemdDelegate: SystemdUserServiceManager;
  private readonly homeDir: string;
  private readonly resinHome: string;
  private readonly defaultDaemonPath: string;
  private readonly nodePath: string;
  private readonly explicitNodePath?: string;
  private readonly supervisorEntryPath?: string;
  private readonly fsBridge: ConfigFsBridge;
  private readonly runner: ServiceCommandRunner;
  private readonly defaultEnv: Record<string, string>;
  private systemdAvailableCache?: boolean;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath = options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon");
    this.nodePath = options.nodePath ?? process.execPath;
    this.explicitNodePath = options.nodePath;
    this.supervisorEntryPath = options.supervisorEntryPath;
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
    return this.systemdAvailableCache === true
      ? this.systemdDelegate.getUnitPath()
      : path.join(this.resinHome, "services", "wsl-service.json");
  }

  getFallbackScriptPath(): string {
    return path.join(this.resinHome, "bin", "resin-service.sh");
  }

  getPidPath(): string {
    return path.join(this.resinHome, "run", "daemon.pid");
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    if (this.systemdAvailableCache === true) {
      return this.systemdDelegate.getUnitDefinition(options);
    }

    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const nodePath = options.nodePath ?? this.nodePath;
    const supervisorEntryPath = options.supervisorEntryPath ?? this.supervisorEntryPath;
    const logDir = path.join(resinHome, "logs");
    const runDir = path.join(resinHome, "run");
    const envLines = Object.entries({
      ...this.defaultEnv,
      ...(options.env ?? {}),
    }).map(([name, value]) => formatShellEnvironment(name, value));

    const execCmd = createSupervisorProgramArguments(
      daemonPath,
      resinHome,
      nodePath,
      supervisorEntryPath,
    )
      .map(quoteShellArgument)
      .join(" ");
    return `#!/bin/sh
# Resin Daemon WSL Service Fallback
export RESIN_HOME=${quoteShellArgument(resinHome)}
export NODE_ENV=production
${envLines.join("\n")}
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
    const nodePath = await resolveInstallNodePath({
      explicitNodePath: options.nodePath ?? this.explicitNodePath,
      fallbackNodePath: this.nodePath,
      fsBridge: this.fsBridge,
      definitionPath: scriptPath,
      parseInstalledRuntime: (content) => {
        const command = /^(?:nohup|exec)\s+(.*)$/m.exec(content)?.[1];
        return command === undefined ? null : parseShellRuntime(command);
      },
    });
    const scriptContent = this.getUnitDefinition({ ...options, nodePath });
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
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.restart();
    }
    await this.stop().catch(() => {});
    await this.start();
  }

  async reload(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.reload();
    }
  }

  async enable(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.enable?.();
    }
  }

  async disable(): Promise<void> {
    const hasSystemd = await this.checkSystemdAvailable();
    if (hasSystemd) {
      return this.systemdDelegate.disable?.();
    }
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
// Windows Scheduled Task User Service Manager (native Windows)
// -----------------------------------------------------------------------------

export class WindowsTaskUserServiceManager implements UserServiceManager {
  readonly name = "windows-task";
  readonly platform = "windows-task" as const;

  protected readonly homeDir: string;
  protected readonly resinHome: string;
  protected readonly defaultDaemonPath: string;
  protected readonly nodePath: string;
  protected readonly supervisorEntryPath?: string;
  protected readonly fsBridge: ConfigFsBridge;
  protected readonly runner: ServiceCommandRunner;
  protected readonly defaultEnv: Record<string, string>;
  readonly backend: WindowsTaskBackend;

  constructor(options: UserServiceManagerOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.resinHome = options.resinHome ?? path.join(this.homeDir, ".resin");
    this.defaultDaemonPath =
      options.daemonPath ?? path.join(this.resinHome, "bin", "resin-daemon.mjs");
    this.nodePath = options.nodePath ?? process.execPath;
    this.supervisorEntryPath = options.supervisorEntryPath;
    this.fsBridge = options.fsBridge ?? defaultFsBridge;
    this.runner = options.runner ?? defaultServiceCommandRunner;
    this.defaultEnv = options.env ?? {};
    this.backend = new WindowsTaskBackend(
      {
        homeDir: this.homeDir,
        resinHome: this.resinHome,
        runner: this.runner,
        fsBridge: this.fsBridge,
      },
      options.windowsTask,
    );
  }

  get serviceName(): string {
    return this.backend.taskName;
  }

  /**
   * A custom home needs an injected runner or an explicitly named task, so tests
   * never register or remove the default task by accident. Every task operation
   * also refuses a task whose action belongs to another Resin home.
   */
  protected ensureLoginHomeForCommands(): void {
    if (
      this.runner === defaultServiceCommandRunner &&
      !this.backend.explicitTaskName &&
      path.resolve(this.homeDir) !== path.resolve(os.homedir())
    ) {
      throw new Error(
        `Cannot issue login-session supervisor commands for custom home directory (${this.homeDir}) without an injected runner or an explicit ${WINDOWS_TASK_NAME_ENV}.`,
      );
    }
  }

  getUnitPath(): string {
    return this.backend.xmlPath;
  }

  getUnitDefinition(options: ServiceInstallOptions = {}): string {
    const daemonPath = options.daemonPath ?? this.defaultDaemonPath;
    const resinHome = options.resinHome ?? this.resinHome;
    const nodePath = options.nodePath ?? this.nodePath;
    const supervisorEntryPath = options.supervisorEntryPath ?? this.supervisorEntryPath;
    return buildWindowsTaskXml({
      userSid: this.backend.userSid(),
      hostPath: this.backend.hostPath,
      workingDirectory: resinHome,
      hostArguments: buildServiceHostArguments({
        resinHome,
        nodePath,
        env: { ...this.defaultEnv, ...(options.env ?? {}) },
        supervisorArguments: createSupervisorProgramArguments(
          daemonPath,
          resinHome,
          nodePath,
          supervisorEntryPath,
          true,
        ),
      }),
    });
  }

  async isInstalled(): Promise<boolean> {
    if (!(await this.fsBridge.exists(this.getUnitPath()))) {
      return false;
    }
    this.ensureLoginHomeForCommands();
    return (await this.backend.query()).installed;
  }

  private notInstalledStatus(): ServiceStatusInfo {
    return {
      installed: false,
      active: false,
      enabled: false,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      state: "not_installed",
    };
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceInstallResult> {
    const unitPath = this.getUnitPath();
    let unitContent = "";
    try {
      this.ensureLoginHomeForCommands();
      unitContent = this.getUnitDefinition(options);
      await this.backend.writeDefinition(unitContent);
      await this.backend.register();
      let started = false;
      if (options.autoStart ?? true) {
        await this.backend.run();
        started = true;
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
      return {
        success: false,
        unitPath,
        unitContent,
        serviceName: this.serviceName,
        enabled: false,
        started: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    const unitPath = this.getUnitPath();
    let stopped = false;
    let disabled = false;
    let removed = false;
    const errors: string[] = [];
    try {
      this.ensureLoginHomeForCommands();
    } catch (err: unknown) {
      return {
        success: false,
        unitPath,
        stopped,
        disabled,
        removed,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      await this.backend.stop();
      stopped = true;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    try {
      await this.backend.delete();
      disabled = true;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (disabled) {
      const leftovers = await this.backend.removeFiles();
      removed = leftovers.length === 0;
      if (leftovers.length > 0) {
        errors.push(`Could not remove (file in use?): ${leftovers.join(", ")}`);
      }
      await this.backend.clearStopRequest();
    }
    const result: ServiceUninstallResult = {
      success: errors.length === 0,
      unitPath,
      stopped,
      disabled,
      removed,
    };
    if (errors.length > 0) {
      result.error = errors.join("; ");
    }
    return result;
  }

  async start(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.backend.run();
  }

  async stop(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.backend.stop();
  }

  async restart(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.backend.stop();
    await this.backend.run();
  }

  /** Re-registers the task from the XML on disk (used after a rollback restores it). */
  async reload(): Promise<void> {
    this.ensureLoginHomeForCommands();
    if (await this.fsBridge.exists(this.getUnitPath())) {
      await this.backend.register();
    }
  }

  async enable(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.backend.setEnabled(true);
  }

  async disable(): Promise<void> {
    this.ensureLoginHomeForCommands();
    await this.backend.setEnabled(false);
  }

  async status(): Promise<ServiceStatusInfo> {
    if (!(await this.fsBridge.exists(this.getUnitPath()))) {
      return this.notInstalledStatus();
    }
    this.ensureLoginHomeForCommands();
    const task = await this.backend.query();
    if (!task.installed) {
      return this.notInstalledStatus();
    }
    const info: ServiceStatusInfo = {
      installed: true,
      active: task.running,
      enabled: task.enabled,
      serviceName: this.serviceName,
      unitPath: this.getUnitPath(),
      state: task.state,
      rawStatus: JSON.stringify(task),
    };
    if (task.pid !== undefined) {
      info.pid = task.pid;
    }
    return info;
  }
}

class ExternalUserServiceManager implements UserServiceManager {
  readonly name = "external";
  readonly platform = "external" as const;

  private unavailable(): never {
    throw new Error(
      "User service management is disabled by RESIN_NO_SERVICE=1. Run resin-daemon --foreground or manage the daemon externally.",
    );
  }

  async install(): Promise<ServiceInstallResult> {
    return this.unavailable();
  }

  async uninstall(): Promise<ServiceUninstallResult> {
    return this.unavailable();
  }

  async start(): Promise<void> {
    this.unavailable();
  }

  async stop(): Promise<void> {
    this.unavailable();
  }

  async restart(): Promise<void> {
    this.unavailable();
  }

  async reload(): Promise<void> {
    this.unavailable();
  }

  async enable(): Promise<void> {
    this.unavailable();
  }

  async disable(): Promise<void> {
    this.unavailable();
  }

  async status(): Promise<ServiceStatusInfo> {
    return {
      installed: false,
      active: false,
      enabled: false,
      serviceName: "externally-managed",
      unitPath: "",
      state: "externally_managed",
      rawStatus: "User service management disabled by RESIN_NO_SERVICE=1",
    };
  }

  async isInstalled(): Promise<boolean> {
    return false;
  }

  getUnitDefinition(): string {
    return this.unavailable();
  }

  getUnitPath(): string {
    return this.unavailable();
  }
}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

export function createUserServiceManager(
  options: UserServiceManagerOptions = {},
): UserServiceManager {
  if (process.env.RESIN_NO_SERVICE === "1" || options.env?.RESIN_NO_SERVICE === "1") {
    return new ExternalUserServiceManager();
  }
  if (options.platform) {
    if (options.platform === "windows" || options.platform === "windows-task") {
      return new WindowsTaskUserServiceManager(options);
    }
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

  if (detected.os === "windows") {
    return new WindowsTaskUserServiceManager(options);
  }
  if (detected.isWsl) {
    return new WslUserServiceManager(options);
  }
  if (detected.os === "darwin") {
    return new LaunchdUserServiceManager(options);
  }
  return new SystemdUserServiceManager(options);
}
