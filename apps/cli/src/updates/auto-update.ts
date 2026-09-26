import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type ServiceCommandRunner, defaultServiceCommandRunner } from "../service/manager.js";
import {
  type AutoUpdateNotificationState,
  type AutoUpdateOutcome,
  type AutoUpdateState,
  createAutoUpdateState,
  publishAutoUpdateNotification,
  readAutoUpdateState,
  schedulerStateFrom,
  truncateAutoUpdateError,
  writeAutoUpdateNotice,
  writeAutoUpdateState,
} from "./auto-update-state.js";
import {
  UpdateEngine,
  type UpdateEngineOptions,
  type UpdateEngineResult,
  type UpdateStatusSnapshot,
  readUpdateStatusSnapshot,
} from "./engine.js";
import { type UpdatePolicy, parseUpdatePolicy } from "./policy.js";
import {
  type SchedulerTimerHandle,
  type UpdateCheckOutcome,
  UpdateScheduler,
  type UpdateSchedulerDecision,
  isWithinUpdateMaintenanceWindow,
} from "./scheduler.js";

export const UPDATE_WORKER_COMMAND = "__update-worker";
export const DEFAULT_AUTO_UPDATE_STARTUP_DELAY_MS = 60_000;
export const DEFAULT_AUTO_UPDATE_POLICY_REFRESH_MS = 5 * 60_000;
export const DEFAULT_AUTO_UPDATE_ACTIVATION_RETRY_MS = 15 * 60_000;

const UPDATE_WORKER_ENTRY_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

/**
 * Environment forwarded to the out-of-service update worker. Only path, runtime
 * and public release-trust settings are passed; credentials never are.
 */
const FORWARDED_WORKER_ENVIRONMENT = [
  "HOME",
  "PATH",
  "NODE_ENV",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "RESIN_HOME",
  "RESIN_CONFIG_DIR",
  "RESIN_CONFIG_FILE",
  "RESIN_DATA_DIR",
  "RESIN_STATE_DIR",
  "RESIN_LOG_DIR",
  "RESIN_SOCKET_PATH",
  "RESIN_LOCK_FILE",
  "RESIN_PID_FILE",
  "RESIN_RELEASE_CHANNEL_URL",
  "RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES",
  "RESIN_TRUSTED_RELEASE_PUBLIC_KEYS",
] as const;

type UpdateChecker = Pick<UpdateEngine, "checkForUpdate" | "readPolicy">;

export interface AutoUpdateAutomation {
  stop(): void;
}

export interface AutoUpdateAutomationOptions {
  readonly resinHome: string;
  readonly homeDir?: string;
  readonly checker?: UpdateChecker;
  readonly launchWorker?: () => Promise<void>;
  readonly readJournal?: () => Promise<UpdateStatusSnapshot | null>;
  readonly publishNotification?: (state: AutoUpdateNotificationState) => Promise<void>;
  readonly readState?: () => Promise<AutoUpdateState | null>;
  readonly writeState?: (state: AutoUpdateState) => Promise<void>;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => SchedulerTimerHandle;
  readonly cancelTimer?: (handle: SchedulerTimerHandle) => void;
  readonly startupDelayMs?: number;
  readonly policyRefreshMs?: number;
  readonly activationRetryMs?: number;
  readonly report?: (message: string) => void;
}

/**
 * Returns true only for installs managed by the versioned release layout. Source
 * checkouts and package-manager installs are updated by their own tooling.
 */
export function isManagedReleaseInstall(
  resinHome: string,
  entryPath: string = UPDATE_WORKER_ENTRY_PATH,
): boolean {
  try {
    const versionsDir = fsSync.realpathSync(path.join(resinHome, "versions"));
    const realEntry = fsSync.realpathSync(entryPath);
    return realEntry.startsWith(`${versionsDir}${path.sep}`);
  } catch {
    return false;
  }
}

/**
 * Starts the resident automatic-update loop. Checks are read-only; installing and
 * activating a release is delegated to a worker that runs outside the service so
 * that stopping the service during cutover cannot terminate the updater.
 */
export function startAutoUpdateAutomation(
  options: AutoUpdateAutomationOptions,
): AutoUpdateAutomation {
  const resinHome = options.resinHome;
  const homeDir = options.homeDir ?? os.homedir();
  const report =
    options.report ??
    ((message: string): void => {
      process.stderr.write(`[resin update] ${message}\n`);
    });
  const clock = options.clock ?? Date.now;
  const scheduleTimer =
    options.scheduleTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelTimer =
    options.cancelTimer ??
    ((handle: SchedulerTimerHandle) => {
      clearTimeout(handle as NodeJS.Timeout);
    });
  let checker: UpdateChecker | undefined = options.checker;
  const getChecker = (): UpdateChecker => {
    checker ??= new UpdateEngine({ homeDir, resinHome } satisfies UpdateEngineOptions);
    return checker;
  };
  const launchWorker = options.launchWorker ?? (() => launchUpdateWorker({ resinHome }));
  const readJournal =
    options.readJournal ?? (() => readUpdateStatusSnapshot({ resinHome }).catch(() => null));
  const publishNotification =
    options.publishNotification ??
    ((state: AutoUpdateNotificationState) => publishAutoUpdateNotification({ resinHome, state }));
  const readState = options.readState ?? (() => readAutoUpdateState({ resinHome }));
  const writeState =
    options.writeState ?? ((state: AutoUpdateState) => writeAutoUpdateState(resinHome, state));

  let stopped = false;
  let state: AutoUpdateState = createAutoUpdateState();
  let policy: UpdatePolicy = parseUpdatePolicy(undefined);
  let policyKey = JSON.stringify(policy);
  let scheduler: UpdateScheduler | undefined;
  const timers = new Set<SchedulerTimerHandle>();

  const arm = (callback: () => void, delayMs: number): void => {
    const handle = scheduleTimer(() => {
      timers.delete(handle);
      if (!stopped) callback();
    }, delayMs);
    timers.add(handle);
    if (handle instanceof Object && "unref" in handle && handle.unref instanceof Function) {
      handle.unref();
    }
  };

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (patch: Partial<AutoUpdateState>): void => {
    state = {
      ...state,
      ...patch,
      scheduler: scheduler ? scheduler.state : state.scheduler,
    };
    const snapshot = state;
    // Serialize writes so an older snapshot can never replace a newer one.
    writeChain = writeChain
      .then(() => writeState(snapshot))
      .catch((error: unknown) => {
        report(`could not persist automatic update state: ${describe(error)}`);
      });
  };

  const recordCheck = (
    outcome: AutoUpdateOutcome,
    targetVersion: string | undefined,
    error: string | undefined,
    extra: Partial<AutoUpdateState> = {},
  ): void => {
    persist({
      ...extra,
      lastCheck: {
        at: new Date(clock()).toISOString(),
        outcome,
        targetVersion: targetVersion ?? null,
        error: truncateAutoUpdateError(error),
      },
    });
  };

  const notify = (notificationState: AutoUpdateNotificationState): void => {
    publishNotification(notificationState).catch((error: unknown) => {
      report(`could not publish update notification: ${describe(error)}`);
    });
  };

  const tryLaunchWorker = async (
    reason: string,
  ): Promise<{ launched: true } | { launched: false; error: string }> => {
    try {
      await launchWorker();
      report(`started background update worker (${reason})`);
      return { launched: true };
    } catch (error) {
      const message = describe(error);
      report(`could not start background update worker: ${message}`);
      return { launched: false, error: message };
    }
  };

  const onCheck = async (
    _decision: Extract<UpdateSchedulerDecision, { kind: "check" }>,
    signal: AbortSignal,
  ): Promise<UpdateCheckOutcome> => {
    const result = await getChecker().checkForUpdate({ signal });
    if (result.policy) applyPolicy(result.policy);
    switch (result.status) {
      case "disabled":
        recordCheck("disabled", undefined, undefined);
        return "checked";
      case "offline":
        recordCheck("offline", result.targetVersion, result.error);
        report(`update check deferred; release endpoint unreachable: ${result.error ?? "offline"}`);
        return "offline";
      case "failed":
        recordCheck("failed", result.targetVersion, result.error);
        report(`update check failed: ${result.error ?? "unknown error"}`);
        notify("failed");
        return "checked";
      case "update-available": {
        const launch = await tryLaunchWorker(
          `v${result.currentVersion} -> v${result.targetVersion}`,
        );
        if (!launch.launched) {
          recordCheck("worker-launch-failed", result.targetVersion, launch.error);
          return "offline";
        }
        recordCheck("worker-launched", result.targetVersion, undefined, {
          lastWorkerLaunchAt: new Date(clock()).toISOString(),
        });
        return "checked";
      }
      default:
        recordCheck(result.status, result.targetVersion, undefined);
        if (result.status === "already-current") notify("clear");
        return "checked";
    }
  };

  const onDecision = (decision: UpdateSchedulerDecision): void => {
    const nextCheckAt =
      decision.kind === "disabled" ? null : new Date(decision.wakeAtMs).toISOString();
    const schedulerChanged =
      scheduler !== undefined &&
      JSON.stringify(scheduler.state) !== JSON.stringify(state.scheduler);
    if (nextCheckAt !== state.nextCheckAt || schedulerChanged) persist({ nextCheckAt });
  };

  function applyPolicy(next: UpdatePolicy): void {
    const nextKey = JSON.stringify(next);
    if (nextKey === policyKey) return;
    const wasEnabled = policy.autoUpdate;
    policy = next;
    policyKey = nextKey;
    if (wasEnabled !== next.autoUpdate) {
      report(`automatic updates ${next.autoUpdate ? "enabled" : "disabled"} by configuration`);
    }
    scheduler?.updatePolicy(next);
    if (!next.autoUpdate && state.nextCheckAt !== null) persist({ nextCheckAt: null });
  }

  const refreshPolicy = (): void => {
    getChecker()
      .readPolicy()
      .then(applyPolicy, (error: unknown) => {
        report(`keeping previous update policy; configuration is invalid: ${describe(error)}`);
      })
      .finally(() => {
        arm(refreshPolicy, options.policyRefreshMs ?? DEFAULT_AUTO_UPDATE_POLICY_REFRESH_MS);
      });
  };

  /** Retries a staged activation that was deferred while work was in flight. */
  const retryDeferredActivation = (): void => {
    void (async () => {
      const journal = await readJournal();
      const pending = journal?.lastResult === "activation-deferred" ? journal.pendingVersion : null;
      if (
        pending !== null &&
        pending !== undefined &&
        policy.autoUpdate &&
        (policy.maintenanceWindow === null ||
          isWithinUpdateMaintenanceWindow(clock(), policy.maintenanceWindow))
      ) {
        const launch = await tryLaunchWorker(`retry deferred activation of v${pending}`);
        recordCheck(
          launch.launched ? "activation-retry" : "worker-launch-failed",
          pending,
          launch.launched ? undefined : launch.error,
          launch.launched ? { lastWorkerLaunchAt: new Date(clock()).toISOString() } : {},
        );
      }
    })()
      .catch((error: unknown) => {
        report(`deferred activation retry failed: ${describe(error)}`);
      })
      .finally(() => {
        arm(
          retryDeferredActivation,
          options.activationRetryMs ?? DEFAULT_AUTO_UPDATE_ACTIVATION_RETRY_MS,
        );
      });
  };

  const begin = async (): Promise<void> => {
    try {
      state = (await readState()) ?? createAutoUpdateState();
    } catch (error) {
      report(`resetting unreadable automatic update state: ${describe(error)}`);
      state = createAutoUpdateState();
    }
    try {
      applyPolicy(await getChecker().readPolicy());
    } catch (error) {
      report(`using default update policy; configuration is invalid: ${describe(error)}`);
    }
    if (stopped) return;
    scheduler = new UpdateScheduler({
      policy,
      initialState: schedulerStateFrom(state),
      onCheck,
      onDecision,
      onError: (error: unknown) => {
        report(`update check error: ${describe(error)}`);
      },
      clock,
      random: options.random,
      scheduleTimer: options.scheduleTimer,
      cancelTimer: options.cancelTimer,
    });
    scheduler.start();
    arm(refreshPolicy, options.policyRefreshMs ?? DEFAULT_AUTO_UPDATE_POLICY_REFRESH_MS);
    arm(
      retryDeferredActivation,
      options.activationRetryMs ?? DEFAULT_AUTO_UPDATE_ACTIVATION_RETRY_MS,
    );
  };

  arm(() => {
    begin().catch((error: unknown) => {
      report(`automatic updates could not start: ${describe(error)}`);
    });
  }, options.startupDelayMs ?? DEFAULT_AUTO_UPDATE_STARTUP_DELAY_MS);

  return {
    stop(): void {
      stopped = true;
      scheduler?.stop();
      for (const handle of timers) cancelTimer(handle);
      timers.clear();
    },
  };
}

export interface LaunchUpdateWorkerOptions {
  readonly resinHome: string;
  readonly nodePath?: string;
  readonly entryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: ServiceCommandRunner;
  readonly spawnDetached?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly now?: () => number;
}

export type UpdateWorkerLaunchMethod = "systemd-run" | "detached";

/**
 * True when this process runs inside a systemd unit. Stopping that unit kills
 * every process in its control group, so the worker must get its own unit.
 */
export function isRunningUnderSystemd(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID?.trim());
}

export function buildUpdateWorkerArguments(options: {
  readonly nodePath: string;
  readonly entryPath: string;
  readonly resinHome: string;
}): string[] {
  return [
    options.nodePath,
    options.entryPath,
    UPDATE_WORKER_COMMAND,
    "--resin-home",
    options.resinHome,
  ];
}

export function buildSystemdRunArguments(options: {
  readonly unitName: string;
  readonly workerArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): string[] {
  const setenv = FORWARDED_WORKER_ENVIRONMENT.flatMap((name) => {
    const value = options.env[name];
    return value === undefined || value.includes("\n") ? [] : [`--setenv=${name}=${value}`];
  });
  return [
    "--user",
    "--collect",
    "--quiet",
    `--unit=${options.unitName}`,
    "--description=Resin background update",
    ...setenv,
    "--",
    ...options.workerArgs,
  ];
}

/** Starts the update worker in a process that survives stopping the resident service. */
export async function launchUpdateWorker(
  options: LaunchUpdateWorkerOptions,
): Promise<UpdateWorkerLaunchMethod> {
  const env = options.env ?? process.env;
  const workerArgs = buildUpdateWorkerArguments({
    nodePath: options.nodePath ?? process.execPath,
    entryPath: options.entryPath ?? realpathOrSelf(UPDATE_WORKER_ENTRY_PATH),
    resinHome: options.resinHome,
  });

  if (isRunningUnderSystemd(env)) {
    const unitName = `resin-update-${(options.now ?? Date.now)()}`;
    const result = await (options.runner ?? defaultServiceCommandRunner).run(
      "systemd-run",
      buildSystemdRunArguments({ unitName, workerArgs, env }),
    );
    if (result.exitCode !== 0) {
      // Never fall back to a child of this unit: the service stop would kill it mid-cutover.
      throw new Error(`systemd-run failed: ${result.stderr || result.stdout || result.exitCode}`);
    }
    return "systemd-run";
  }

  const logDir = path.join(options.resinHome, "logs");
  fsSync.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFd = fsSync.openSync(path.join(logDir, "update-worker.log"), "a", 0o600);
  try {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const name of FORWARDED_WORKER_ENVIRONMENT) {
      if (env[name] !== undefined) childEnv[name] = env[name];
    }
    const [command, ...args] = workerArgs;
    const child = (options.spawnDetached ?? spawn)(command, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.unref();
    return "detached";
  } finally {
    fsSync.closeSync(logFd);
  }
}

export interface UpdateWorkerOptions {
  readonly resinHome: string;
  readonly homeDir?: string;
  readonly currentVersionFallback?: string;
  readonly engine?: Pick<UpdateEngine, "run">;
  readonly publishNotification?: (state: AutoUpdateNotificationState) => Promise<void>;
  readonly writeNotice?: typeof writeAutoUpdateNotice;
  readonly report?: (message: string) => void;
  readonly clock?: () => number;
}

/** Runs one background update to completion outside the resident service. */
export async function runUpdateWorker(options: UpdateWorkerOptions): Promise<UpdateEngineResult> {
  const report =
    options.report ??
    ((message: string): void => {
      process.stdout.write(`[resin update] ${message}\n`);
    });
  const engine =
    options.engine ??
    new UpdateEngine({
      homeDir: options.homeDir ?? os.homedir(),
      resinHome: options.resinHome,
      currentVersionFallback: options.currentVersionFallback,
    });
  const result = await engine.run({ mode: "background" });
  report(describeWorkerResult(result));

  const publish =
    options.publishNotification ??
    ((state: AutoUpdateNotificationState) =>
      publishAutoUpdateNotification({ resinHome: options.resinHome, state }));
  const notification = notificationStateFor(result);
  if (notification !== null) {
    await publish(notification).catch((error: unknown) => {
      report(`could not publish update notification: ${describe(error)}`);
    });
  }
  if (result.status === "activated") {
    await (options.writeNotice ?? writeAutoUpdateNotice)(options.resinHome, {
      fromVersion: result.currentVersion,
      toVersion: result.activeVersion,
      activatedAt: new Date((options.clock ?? Date.now)()).toISOString(),
    }).catch((error: unknown) => {
      report(`could not record update notice: ${describe(error)}`);
    });
  }
  return result;
}

export async function runUpdateWorkerCommand(
  argv: readonly string[],
  options: Omit<UpdateWorkerOptions, "resinHome"> = {},
): Promise<number> {
  if (argv[0] !== UPDATE_WORKER_COMMAND) {
    throw new Error("Invalid update worker invocation");
  }
  if (argv.length !== 3 || argv[1] !== "--resin-home" || !argv[2]) {
    throw new Error("Update worker requires exactly `--resin-home <path>`");
  }
  const result = await runUpdateWorker({ ...options, resinHome: path.resolve(argv[2]) });
  return result.success ? 0 : 1;
}

function notificationStateFor(result: UpdateEngineResult): AutoUpdateNotificationState | null {
  if (result.rolledBack || result.status === "rolled-back") {
    return "rolled-back";
  }
  switch (result.status) {
    case "failed":
      return "failed";
    case "activated":
    case "already-current":
      return "clear";
    default:
      return null;
  }
}

function describeWorkerResult(result: UpdateEngineResult): string {
  const target = result.targetVersion ? ` v${result.targetVersion}` : "";
  switch (result.status) {
    case "activated":
      return `updated Resin v${result.currentVersion} -> v${result.activeVersion}`;
    case "activation-deferred":
      return `staged${target}; activation deferred: ${result.error ?? result.deferralReason ?? "service busy"}`;
    case "rolled-back":
      return `rolled back${target} to v${result.activeVersion}: ${result.error ?? "health gate failed"}`;
    case "locked":
      return "skipped; another update operation is running";
    default:
      return `background update ${result.status}${target}${result.error ? `: ${result.error}` : ""}`;
  }
}

function realpathOrSelf(filePath: string): string {
  try {
    return fsSync.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function describe(error: unknown): string {
  return (
    truncateAutoUpdateError(error instanceof Error ? error.message : String(error)) ?? "unknown"
  );
}
