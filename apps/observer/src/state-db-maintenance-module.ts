import {
  type LocalDatabaseConnection,
  type StateDbMaintenanceResult,
  runStateDbMaintenance,
} from "@resin/db";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";

/** First pass waits so daemon startup never pays for storage maintenance. */
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export interface StateDbMaintenanceModuleOptions {
  conn: LocalDatabaseConnection;
  initialDelayMs?: number;
  intervalMs?: number;
}

/**
 * Periodically reclaims state.db free pages and truncates its WAL (see runStateDbMaintenance).
 * Pruning deletes rows but SQLite keeps the pages; without this the file only grows.
 */
export class StateDbMaintenanceModule implements DaemonModule {
  readonly id = "state-db-maintenance";
  readonly name = "Local State Database Maintenance";
  readonly critical = false;

  private readonly conn: LocalDatabaseConnection;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private state: ModuleLifecycleState = "uninitialized";
  private logger?: Logger;
  private timer?: NodeJS.Timeout;
  private runs = 0;
  private lastResult?: StateDbMaintenanceResult;
  private lastError?: string;
  private deferredWarned = false;

  constructor(options: StateDbMaintenanceModuleOptions) {
    this.conn = options.conn;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(context: ModuleContext): Promise<void> {
    this.logger = context.logger;
    this.state = "starting";
    this.schedule(this.initialDelayMs);
    this.state = "ready";
  }

  async stop(): Promise<void> {
    this.state = "stopping";
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = "stopped";
  }

  async healthCheck(): Promise<ModuleHealth> {
    return {
      status: this.state === "ready" ? "ready" : "offline",
      message: `State database maintenance is ${this.state}`,
      details: await this.getDiagnostics(),
      lastCheckTime: Date.now(),
    };
  }

  async getDiagnostics(): Promise<JsonObject> {
    const last = this.lastResult;
    return {
      id: this.id,
      state: this.state,
      runs: this.runs,
      lastAction: last?.action ?? null,
      autoVacuum: last?.autoVacuumAfter ?? null,
      freelistPages: last?.freelistAfter ?? null,
      pageCount: last?.pageCountAfter ?? null,
      lastError: this.lastError ?? null,
    };
  }

  /** Runs one maintenance pass; the timer calls this, tests may call it directly. */
  runOnce(): StateDbMaintenanceResult | undefined {
    this.runs += 1;
    try {
      const result = runStateDbMaintenance(this.conn);
      this.lastResult = result;
      this.lastError = undefined;
      this.report(result);
      return result;
    } catch (error) {
      // Typically SQLITE_BUSY from another process holding state.db; the next pass retries.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger?.warn("State database maintenance failed", { error: this.lastError });
      return undefined;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.runOnce();
      if (this.state === "ready") this.schedule(this.intervalMs);
    }, delayMs);
    this.timer.unref();
  }

  private report(result: StateDbMaintenanceResult): void {
    const meta: JsonObject = {
      action: result.action,
      autoVacuum: result.autoVacuumAfter,
      pageSize: result.pageSize,
      pageCountBefore: result.pageCountBefore,
      pageCountAfter: result.pageCountAfter,
      freelistBefore: result.freelistBefore,
      freelistAfter: result.freelistAfter,
      walCheckpointBusy: result.walCheckpoint?.busy ?? null,
    };
    if (result.action === "vacuum" || result.action === "incremental_vacuum") {
      this.logger?.info("Reclaimed free space in state database", meta);
    } else if (result.action === "vacuum_deferred" && !this.deferredWarned) {
      this.deferredWarned = true;
      this.logger?.warn(
        "State database is mostly free pages but too large to rebuild online; stop the daemon and run VACUUM on state.db to reclaim it",
        meta,
      );
    } else {
      this.logger?.debug("State database maintenance pass", meta);
    }
  }
}
