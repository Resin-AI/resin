import os from "node:os";
import path from "node:path";
import process from "node:process";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import {
  type LaunchdUserServiceManager,
  type ServiceCommandResult,
  type ServiceCommandRunner,
  type ServiceInstallOptions,
  type ServiceInstallResult,
  type ServiceStatusInfo,
  type ServiceUninstallResult,
  type SystemdUserServiceManager,
  type UserServiceManager,
  type UserServiceManagerOptions,
  type WslUserServiceManager,
  createUserServiceManager,
  defaultServiceCommandRunner,
  isStaleSupervisorUnitContent,
} from "../service/manager.js";
import {
  type DaemonReadinessResult,
  type DaemonReadinessVerifier,
  verifyDaemonReadiness,
} from "../service/verification.js";

export { createUserServiceManager, defaultServiceCommandRunner };
export type {
  UserServiceManager,
  UserServiceManagerOptions,
  SystemdUserServiceManager,
  LaunchdUserServiceManager,
  WslUserServiceManager,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceInstallOptions,
  ServiceInstallResult,
  ServiceStatusInfo,
  ServiceUninstallResult,
};

export type ServiceType = "systemd" | "launchd" | "wsl" | string;

export interface SetupDaemonServiceOptions {
  readonly homeDir?: string;
  readonly resinHome?: string;
  readonly daemonPath?: string;
  readonly nodePath?: string;
  readonly supervisorEntryPath?: string;
  readonly env?: Record<string, string>;
  readonly fsBridge?: ConfigFsBridge;
  readonly runner?: ServiceCommandRunner;
  readonly autoStart?: boolean;
  readonly maxHealthRetries?: number;
  readonly healthRetryIntervalMs?: number;
  readonly logger?: (msg: string) => void;
  readonly expectedVersion?: string;
  readonly daemonVerifier?: DaemonReadinessVerifier;
  readonly readinessVerifier?: DaemonReadinessVerifier;
  readonly forceRestart?: boolean;
}

export interface SetupDaemonServiceResult {
  readonly success: boolean;
  readonly serviceType: string;
  readonly installed: boolean;
  readonly started: boolean;
  readonly healthy: boolean;
  readonly reused?: boolean;
  readonly unitPath?: string;
  readonly pid?: number;
  readonly details?: string;
  readonly error?: string;
  readonly rollback?: () => Promise<void>;
}

export interface HealthCheckDaemonOptions {
  readonly homeDir?: string;
  readonly resinHome?: string;
  readonly fsBridge?: ConfigFsBridge;
  readonly runner?: ServiceCommandRunner;
  readonly maxRetries?: number;
  readonly retryIntervalMs?: number;
}

export interface HealthCheckDaemonResult {
  readonly healthy: boolean;
  readonly running: boolean;
  readonly serviceType: string;
  readonly pid?: number;
  readonly details: string;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
function resolveHomeDirs(options: { homeDir?: string; resinHome?: string }): {
  homeDir: string;
  resinHome: string;
} {
  const homeDir =
    options.homeDir ??
    (options.resinHome
      ? path.basename(options.resinHome) === ".resin"
        ? path.dirname(options.resinHome)
        : options.resinHome
      : undefined) ??
    process.env.HOME ??
    os.homedir();
  const resinHome = options.resinHome ?? path.join(homeDir, ".resin");
  return { homeDir, resinHome };
}

/**
 * Sets up and starts the Resin daemon as a user-level service without root.
 */
export async function setupAndStartDaemonService(
  options: SetupDaemonServiceOptions = {},
): Promise<SetupDaemonServiceResult> {
  const log = options.logger ?? (() => {});
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const { homeDir, resinHome } = resolveHomeDirs(options);
  const manager = createUserServiceManager({
    homeDir,
    resinHome,
    daemonPath: options.daemonPath,
    nodePath: options.nodePath,
    supervisorEntryPath: options.supervisorEntryPath,
    env: options.env,
    fsBridge,
    runner: options.runner,
  });

  const serviceType = manager.name;
  log(`Setting up user-level daemon service using '${serviceType}' supervisor (non-root)...`);

  // 0. Capture prior state before any mutations
  let priorInstalled = false;
  let priorUnitContent: string | null = null;
  let priorActive = false;
  let priorEnabled = false;
  let priorPid: number | undefined;
  let unitPath = manager.getUnitPath();
  if (manager.platform === "wsl") {
    try {
      // WSL chooses systemd or its login-shell fallback asynchronously.
      // Resolve that choice before using synchronous path/definition methods.
      await manager.isInstalled();
      unitPath = manager.getUnitPath();
    } catch {
      // The regular installed-state probe below remains fail-closed.
    }
  }

  try {
    const unitExists = await fsBridge.exists(unitPath);
    if (unitExists) {
      priorInstalled = await manager.isInstalled();
    }
  } catch {
    priorInstalled = false;
  }

  if (priorInstalled) {
    try {
      priorUnitContent = await fsBridge.readFile(unitPath);
    } catch {
      priorUnitContent = null;
    }
    try {
      const priorStatus = await manager.status();
      priorActive = Boolean(priorStatus.active);
      priorEnabled = Boolean(priorStatus.enabled);
      priorPid = priorStatus.pid;
    } catch {
      priorActive = false;
      priorEnabled = false;
    }
  }

  let rollbackExecuted = false;
  const rollback = async (): Promise<void> => {
    if (rollbackExecuted) return;
    rollbackExecuted = true;
    log("Restoring previous daemon user service state...");
    try {
      if (!priorInstalled) {
        await manager.uninstall().catch(() => {});
      } else {
        if (priorUnitContent !== null) {
          await fsBridge.writeFile(unitPath, priorUnitContent).catch(() => {});
        }
        if (typeof manager.reload === "function") {
          await manager.reload().catch(() => {});
        }
        if (priorEnabled) {
          if (typeof manager.enable === "function") {
            await manager.enable().catch(() => {});
          }
        } else {
          if (typeof manager.disable === "function") {
            await manager.disable().catch(() => {});
          }
        }
        if (priorActive) {
          try {
            await manager.restart();
          } catch {
            await manager.start().catch(() => {});
          }
        } else {
          await manager.stop().catch(() => {});
        }
      }
    } catch {
      // Best-effort rollback
    }
  };

  try {
    const targetUnitDefinition = manager.getUnitDefinition({
      daemonPath: options.daemonPath,
      nodePath: options.nodePath,
      env: options.env,
    });

    // Check if valid existing service can be reused without destructive recreation
    const isMatchingUnit =
      priorInstalled &&
      priorUnitContent !== null &&
      !isStaleSupervisorUnitContent(priorUnitContent, targetUnitDefinition);

    if (isMatchingUnit && priorActive && !options.forceRestart) {
      const maxRetries = options.maxHealthRetries ?? 5;
      const retryInterval = options.healthRetryIntervalMs ?? 100;
      let healthy = false;
      let pid = priorPid;
      let healthDetails = "";

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const status = await manager.status();
        if (status.active) {
          healthy = true;
          pid = status.pid;
          healthDetails = `Daemon active and running (PID: ${pid || "unknown"}, state: ${status.state || "active"})`;
          break;
        }
        if (attempt < maxRetries) {
          await delay(retryInterval);
        }
      }

      if (healthy) {
        log(
          `Existing daemon service is valid and active (${unitPath}). Reusing without recreation.`,
        );
        return {
          success: true,
          serviceType,
          installed: true,
          started: true,
          healthy: true,
          reused: true,
          unitPath,
          pid,
          details: healthDetails,
          rollback,
        };
      }
    }

    // 1. Install user service definition
    const installResult = await manager.install({
      daemonPath: options.daemonPath,
      nodePath: options.nodePath,
      env: options.env,
    });

    if (!installResult.success) {
      await rollback();
      return {
        success: false,
        serviceType,
        installed: false,
        started: false,
        healthy: false,
        unitPath: installResult.unitPath,
        error: installResult.error ?? "Failed to install user service definition",
        rollback,
      };
    }

    log(`Service definition installed successfully (${installResult.unitPath || "supervisor"}).`);

    // 2. Start or restart daemon if requested
    let started = installResult.started;
    if (priorActive) {
      if (options.autoStart ?? true) {
        log("Restarting daemon service with updated unit definition...");
        try {
          await manager.restart();
          started = true;
        } catch (restartErr: unknown) {
          await rollback();
          const restartErrorMsg =
            restartErr instanceof Error ? restartErr.message : String(restartErr);
          return {
            success: false,
            serviceType,
            installed: true,
            started: false,
            healthy: false,
            unitPath: installResult.unitPath,
            error: `Failed to restart daemon service: ${restartErrorMsg}`,
            rollback,
          };
        }
      }
    } else if (!started && (options.autoStart ?? true)) {
      log("Starting daemon service...");
      try {
        await manager.start();
        started = true;
      } catch (startErr: unknown) {
        await rollback();
        const startErrorMsg = startErr instanceof Error ? startErr.message : String(startErr);
        return {
          success: false,
          serviceType,
          installed: true,
          started: false,
          healthy: false,
          unitPath: installResult.unitPath,
          error: `Failed to start daemon service: ${startErrorMsg}`,
          rollback,
        };
      }
    }

    // 3. Health check verification with retries
    const maxRetries = options.maxHealthRetries ?? 5;
    const retryInterval = options.healthRetryIntervalMs ?? 100;
    let healthy = false;
    let pid: number | undefined;
    let healthDetails = "";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const status = await manager.status();
      if (status.active) {
        healthy = true;
        pid = status.pid;
        healthDetails = `Daemon active and running (PID: ${pid || "unknown"}, state: ${status.state || "active"})`;
        break;
      }
      if (attempt < maxRetries) {
        await delay(retryInterval);
      }
    }

    if (!healthy) {
      log(
        "Daemon service health check failed (service is not active). Rolling back service state...",
      );
      await rollback();
      return {
        success: false,
        serviceType,
        installed: true,
        started,
        healthy: false,
        unitPath: installResult.unitPath,
        details: "Daemon service failed health verification probe",
        error: "Daemon service started but failed health check (not active)",
        rollback,
      };
    }

    log(`✔ Daemon service started and verified healthy (PID: ${pid || "unknown"}).`);
    return {
      success: true,
      serviceType,
      installed: true,
      started,
      healthy: true,
      unitPath: installResult.unitPath,
      pid,
      details: healthDetails,
      rollback,
    };
  } catch (err: unknown) {
    await rollback();
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      serviceType,
      installed: false,
      started: false,
      healthy: false,
      error: errorMsg,
      rollback,
    };
  }
}

/**
 * Health checks the running daemon service.
 */
export async function healthCheckDaemonService(
  options: HealthCheckDaemonOptions = {},
): Promise<HealthCheckDaemonResult> {
  const { homeDir, resinHome } = resolveHomeDirs(options);
  const manager = createUserServiceManager({
    homeDir,
    resinHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });

  const status = await manager.status();

  return {
    healthy: status.active,
    running: status.active,
    serviceType: manager.name,
    pid: status.pid,
    details: status.active
      ? `Daemon running (PID: ${status.pid || "unknown"}, state: ${status.state || "active"})`
      : `Daemon inactive (state: ${status.state || "inactive"})`,
  };
}

/**
 * Stops the daemon service.
 */
export async function stopDaemonService(options: SetupDaemonServiceOptions = {}): Promise<void> {
  const { homeDir, resinHome } = resolveHomeDirs(options);
  const manager = createUserServiceManager({
    homeDir,
    resinHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  await manager.stop();
}

/**
 * Restarts the daemon service.
 */
export async function restartDaemonService(options: SetupDaemonServiceOptions = {}): Promise<void> {
  const { homeDir, resinHome } = resolveHomeDirs(options);
  const manager = createUserServiceManager({
    homeDir,
    resinHome,
    daemonPath: options.daemonPath,
    nodePath: options.nodePath,
    supervisorEntryPath: options.supervisorEntryPath,
    env: options.env,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  await manager.restart();
}

/**
 * Uninstalls the daemon service.
 */
export async function uninstallDaemonService(
  options: SetupDaemonServiceOptions = {},
): Promise<ServiceUninstallResult> {
  const { homeDir, resinHome } = resolveHomeDirs(options);
  const manager = createUserServiceManager({
    homeDir,
    resinHome,
    fsBridge: options.fsBridge,
    runner: options.runner,
  });
  return await manager.uninstall();
}
