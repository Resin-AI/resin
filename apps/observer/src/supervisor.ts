import process from "node:process";
import {
  type DaemonConfig,
  type RedactedDaemonConfig,
  loadDaemonConfig,
  redactConfig,
  validateConfigUpdate,
} from "./config.js";
import {
  type DaemonModule,
  type Logger,
  type ModuleContext,
  type ModuleHealth,
  type ModuleLifecycleState,
  RestartBudgetTracker,
  computeShutdownOrder,
  computeStartupOrder,
  withTimeout,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";
import { type DaemonPaths, resolvePaths } from "./paths.js";

export type DaemonHealthStatus =
  | "fully-ready"
  | "cloud-offline"
  | "adapter-degraded"
  | "runtime-degraded"
  | "upgrade-required"
  | "degraded"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed";

export interface DaemonHealthReport {
  status: DaemonHealthStatus;
  uptimeSeconds: number;
  startedAt: number;
  version: string;
  modules: Record<string, ModuleHealth>;
  timestamp: number;
}

export interface ModuleStatusReport {
  id: string;
  name: string;
  state: ModuleLifecycleState;
  critical: boolean;
  dependencies: string[];
  health?: ModuleHealth;
}

export interface ConfigReloadResult {
  success: boolean;
  reloadedModules: string[];
  errors: string[];
  config: RedactedDaemonConfig;
}

export interface DaemonDiagnosticsReport {
  pid: number;
  version: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptimeSeconds: number;
  memory: NodeJS.MemoryUsage;
  health: DaemonHealthReport;
  config: RedactedDaemonConfig;
  paths: DaemonPaths;
  modules: JsonObject;
}

export interface DaemonSupervisorOptions {
  config?: DaemonConfig;
  paths?: DaemonPaths;
  logger?: Logger;
  modules?: readonly DaemonModule[];
  enableSignalHandlers?: boolean;
}

export class DefaultLogger implements Logger {
  private logLevel: string;

  constructor(logLevel = "info") {
    this.logLevel = logLevel;
  }

  setLogLevel(level: string): void {
    this.logLevel = level;
  }

  debug(msg: string, meta?: JsonObject): void {
    if (this.logLevel === "debug") {
      console.debug(`[DEBUG] ${msg}`, meta ?? "");
    }
  }

  info(msg: string, meta?: JsonObject): void {
    if (this.logLevel === "debug" || this.logLevel === "info") {
      console.info(`[INFO] ${msg}`, meta ?? "");
    }
  }

  warn(msg: string, meta?: JsonObject): void {
    if (this.logLevel !== "silent" && this.logLevel !== "error") {
      console.warn(`[WARN] ${msg}`, meta ?? "");
    }
  }

  error(msg: string, meta?: JsonObject): void {
    if (this.logLevel !== "silent") {
      console.error(`[ERROR] ${msg}`, meta ?? "");
    }
  }
}

/**
 * Main supervisor orchestrating all daemon modules, signal handling,
 * health aggregation, and graceful teardown.
 */
export class DaemonSupervisor {
  private config: DaemonConfig;
  private paths: DaemonPaths;
  private logger: Logger;
  private modules = new Map<string, DaemonModule>();
  private moduleStates = new Map<string, ModuleLifecycleState>();
  private restartTracker = new RestartBudgetTracker();
  private state: ModuleLifecycleState = "uninitialized";
  private startedAt = 0;
  private enableSignalHandlers: boolean;
  private signalListeners: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  private stopPromise: Promise<void> | null = null;

  constructor(options: DaemonSupervisorOptions = {}) {
    this.config = options.config ?? loadDaemonConfig();
    this.paths = options.paths ?? resolvePaths({ socketPath: this.config.socketPath });
    this.logger = options.logger ?? new DefaultLogger(this.config.logLevel);
    this.enableSignalHandlers = options.enableSignalHandlers ?? false;

    if (options.modules) {
      for (const mod of options.modules) {
        this.registerModule(mod);
      }
    }
  }

  get currentState(): ModuleLifecycleState {
    return this.state;
  }

  getConfig(): DaemonConfig {
    return { ...this.config };
  }

  getPaths(): DaemonPaths {
    return this.paths;
  }

  registerModule(module: DaemonModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module with ID '${module.id}' is already registered`);
    }
    this.modules.set(module.id, module);
    this.moduleStates.set(module.id, module.getState());
  }

  getModule<T extends DaemonModule>(id: string): T | undefined {
    // SAFETY: Module registry stores DaemonModule implementations by ID.
    return this.modules.get(id) as T | undefined;
  }

  private createModuleContext(): ModuleContext {
    return {
      config: this.config,
      paths: this.paths,
      logger: this.logger,
      getModule: <T extends DaemonModule>(id: string) => this.getModule<T>(id),
    };
  }

  /**
   * Starts all registered modules in topological dependency order.
   */
  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "starting") {
      throw new Error("Daemon supervisor is already starting");
    }

    this.state = "starting";
    this.startedAt = Date.now();
    const moduleList = Array.from(this.modules.values());
    const startupOrder = computeStartupOrder(moduleList);
    const context = this.createModuleContext();

    this.logger.info("Starting daemon supervisor", {
      moduleCount: moduleList.length,
      startupOrder,
    });

    const startedModuleIds: string[] = [];

    for (const moduleId of startupOrder) {
      const mod = this.modules.get(moduleId);
      if (!mod) continue;
      const timeoutMs = mod.startupTimeoutMs ?? 5000;
      this.moduleStates.set(moduleId, "starting");
      this.logger.debug(`Starting module '${moduleId}'...`);

      try {
        await withTimeout(mod.start(context), timeoutMs, `start:${moduleId}`);
        this.moduleStates.set(moduleId, mod.getState());
        startedModuleIds.push(moduleId);
        this.logger.debug(`Module '${moduleId}' started in state '${mod.getState()}'`);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to start module '${moduleId}': ${errorMsg}`);
        this.moduleStates.set(moduleId, "failed");

        if (mod.critical) {
          this.state = "failed";
          // Rollback and stop already started modules in reverse order
          for (const rollbackId of startedModuleIds.reverse()) {
            try {
              const rollbackMod = this.modules.get(rollbackId);
              if (rollbackMod) {
                await withTimeout(rollbackMod.stop(context), 5000, `rollback:${rollbackId}`);
                this.moduleStates.set(rollbackId, "stopped");
              }
            } catch (rollbackErr) {
              const rollbackMsg =
                rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
              this.logger.error(`Error rolling back module '${rollbackId}': ${rollbackMsg}`);
            }
          }
          throw new Error(`Critical module '${moduleId}' failed to start: ${errorMsg}`);
        }
        this.moduleStates.set(moduleId, "degraded");
      }
    }
    // Determine final supervisor state
    const hasDegraded = Array.from(this.moduleStates.values()).some(
      (s) => s === "degraded" || s === "failed",
    );
    this.state = hasDegraded ? "degraded" : "ready";

    if (this.enableSignalHandlers) {
      this.setupSignalHandlers();
    }

    this.logger.info(`Daemon supervisor started successfully with state '${this.state}'`);
  }

  /**
   * Gracefully shuts down all modules in reverse topological order within timeout.
   */
  async stop(options: { timeoutMs?: number; reason?: string } = {}): Promise<void> {
    if (this.state === "stopped") return;
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.executeStop(options);
    return this.stopPromise;
  }

  private async executeStop(options: { timeoutMs?: number; reason?: string }): Promise<void> {
    this.state = "stopping";
    this.removeSignalHandlers();

    const timeoutMs = options.timeoutMs ?? this.config.shutdownTimeoutMs;
    this.logger.info(
      `Shutting down daemon supervisor (${options.reason ?? "normal shutdown"}, timeout: ${timeoutMs}ms)`,
    );

    const moduleList = Array.from(this.modules.values());
    const shutdownOrder = computeShutdownOrder(moduleList);
    const context = this.createModuleContext();

    const shutdownOperation = async () => {
      for (const moduleId of shutdownOrder) {
        const mod = this.modules.get(moduleId);
        if (!mod) continue;
        const currentState = this.moduleStates.get(moduleId);
        // Only stop modules that were started
        if (
          currentState === "ready" ||
          currentState === "degraded" ||
          currentState === "starting"
        ) {
          this.moduleStates.set(moduleId, "stopping");
          try {
            this.logger.debug(`Stopping module '${moduleId}'...`);
            await withTimeout(mod.stop(context), 5000, `stop:${moduleId}`);
            this.moduleStates.set(moduleId, "stopped");
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Error stopping module '${moduleId}': ${errorMsg}`);
            this.moduleStates.set(moduleId, "failed");
          }
        }
      }
    };

    try {
      await withTimeout(shutdownOperation(), timeoutMs, "daemon-shutdown");
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Daemon shutdown timed out or encountered errors: ${errorMsg}`);
    } finally {
      this.state = "stopped";
      this.logger.info("Daemon supervisor stopped");
    }
  }

  /**
   * Aggregates and returns the health status of the daemon and all registered modules.
   */
  async getHealth(): Promise<DaemonHealthReport> {
    const moduleHealthMap: Record<string, ModuleHealth> = {};
    let cloudOffline = false;
    let adapterDegraded = false;
    let runtimeDegraded = false;
    let upgradeRequired = false;
    let anyDegraded = false;
    let anyFailed = false;

    for (const [id, mod] of this.modules.entries()) {
      let health: ModuleHealth;
      if (mod.healthCheck) {
        try {
          health = await mod.healthCheck();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          health = {
            status: "failed",
            message: errorMsg,
            lastCheckTime: Date.now(),
          };
        }
      } else {
        const state = this.moduleStates.get(id) ?? mod.getState();
        health = {
          status: state === "ready" ? "ready" : state === "degraded" ? "degraded" : "failed",
          lastCheckTime: Date.now(),
        };
      }

      moduleHealthMap[id] = health;

      if (id.includes("cloud") && (health.status === "offline" || health.status === "degraded")) {
        cloudOffline = true;
      }
      if (id.includes("adapter") && health.status !== "ready") {
        adapterDegraded = true;
      }
      if ((id.includes("runtime") || id.includes("worker")) && health.status !== "ready") {
        runtimeDegraded = true;
      }
      if (health.details?.upgradeRequired || health.message?.includes("upgrade")) {
        upgradeRequired = true;
      }
      if (health.status === "degraded") {
        anyDegraded = true;
      }
      if (health.status === "failed") {
        anyFailed = true;
      }
    }

    let overallStatus: DaemonHealthStatus;

    if (this.state === "starting" || this.state === "stopping" || this.state === "stopped") {
      overallStatus = this.state;
    } else if (this.state === "uninitialized") {
      overallStatus = "stopped";
    } else if (this.state === "failed" || anyFailed) {
      overallStatus = "failed";
    } else if (upgradeRequired) {
      overallStatus = "upgrade-required";
    } else if (runtimeDegraded) {
      overallStatus = "runtime-degraded";
    } else if (adapterDegraded) {
      overallStatus = "adapter-degraded";
    } else if (cloudOffline) {
      overallStatus = "cloud-offline";
    } else if (anyDegraded || this.state === "degraded") {
      overallStatus = "degraded";
    } else {
      overallStatus = "fully-ready";
    }

    const uptimeSeconds = this.startedAt > 0 ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;

    return {
      status: overallStatus,
      uptimeSeconds,
      startedAt: this.startedAt,
      version: this.config.version,
      modules: moduleHealthMap,
      timestamp: Date.now(),
    };
  }

  /**
   * Returns status information for one or all registered modules.
   */
  getModuleStatus(moduleId?: string): ModuleStatusReport[] {
    const results: ModuleStatusReport[] = [];

    const modFound = moduleId ? this.modules.get(moduleId) : undefined;
    const targets = modFound ? [modFound] : moduleId ? [] : Array.from(this.modules.values());
    for (const mod of targets) {
      results.push({
        id: mod.id,
        name: mod.name,
        state: this.moduleStates.get(mod.id) ?? mod.getState(),
        critical: mod.critical ?? false,
        dependencies: mod.dependencies ? [...mod.dependencies] : [],
      });
    }

    return results;
  }

  /**
   * Reloads configuration at runtime and propagates to all modules supporting it.
   */
  async reloadConfig(newConfigUpdate?: Partial<DaemonConfig>): Promise<ConfigReloadResult> {
    const reloadedModules: string[] = [];
    const errors: string[] = [];

    if (newConfigUpdate) {
      const validation = validateConfigUpdate(this.config, newConfigUpdate);
      if (!validation.valid || !validation.updatedConfig) {
        return {
          success: false,
          reloadedModules: [],
          errors: validation.errors,
          config: redactConfig(this.config),
        };
      }
      this.config = validation.updatedConfig;
    } else {
      try {
        const freshConfig = loadDaemonConfig({ configPath: this.paths.configFile });
        const validation = validateConfigUpdate(this.config, freshConfig);
        if (!validation.valid || !validation.updatedConfig) {
          return {
            success: false,
            reloadedModules: [],
            errors: validation.errors,
            config: redactConfig(this.config),
          };
        }
        this.config = validation.updatedConfig;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(errorMsg);
        return {
          success: false,
          reloadedModules: [],
          errors,
          config: redactConfig(this.config),
        };
      }
    }

    for (const [id, mod] of this.modules.entries()) {
      if (mod.reloadConfig) {
        try {
          await mod.reloadConfig(this.config);
          reloadedModules.push(id);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Module '${id}' failed to reload config: ${errorMsg}`);
        }
      }
    }

    return {
      success: errors.length === 0,
      reloadedModules,
      errors,
      config: redactConfig(this.config),
    };
  }

  /**
   * Generates a comprehensive diagnostics report with secret redaction.
   */
  async getDiagnostics(): Promise<DaemonDiagnosticsReport> {
    const health = await this.getHealth();
    const moduleDiagnostics: JsonObject = {};
    for (const [id, mod] of this.modules.entries()) {
      if (mod.getDiagnostics) {
        try {
          moduleDiagnostics[id] = await mod.getDiagnostics();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          moduleDiagnostics[id] = { error: errorMsg };
        }
      }
    }

    const uptimeSeconds = this.startedAt > 0 ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;

    return {
      pid: process.pid,
      version: this.config.version,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds,
      memory: process.memoryUsage(),
      health,
      config: redactConfig(this.config),
      paths: this.paths,
      modules: moduleDiagnostics,
    };
  }

  private setupSignalHandlers(): void {
    const handleShutdown = (signal: NodeJS.Signals) => {
      this.logger.info(`Received ${signal}, initiating graceful shutdown`);
      void this.stop({ reason: signal });
    };

    const handleReload = () => {
      this.logger.info("Received SIGHUP, reloading configuration");
      void this.reloadConfig();
    };

    const sigintListener = () => handleShutdown("SIGINT");
    const sigtermListener = () => handleShutdown("SIGTERM");
    const sighupListener = () => handleReload();

    process.on("SIGINT", sigintListener);
    process.on("SIGTERM", sigtermListener);
    process.on("SIGHUP", sighupListener);

    this.signalListeners.push(
      { signal: "SIGINT", handler: sigintListener },
      { signal: "SIGTERM", handler: sigtermListener },
      { signal: "SIGHUP", handler: sighupListener },
    );
  }

  private removeSignalHandlers(): void {
    for (const { signal, handler } of this.signalListeners) {
      process.removeListener(signal, handler);
    }
    this.signalListeners = [];
  }
}
