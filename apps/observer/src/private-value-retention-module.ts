import path from "node:path";
import {
  type PrivateValueSweepResult,
  collectPrivateValueReferences,
  sweepPrivateValues,
} from "./analytics/private-value-retention.js";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";

export const PRIVATE_VALUE_RETENTION_MODULE_ID = "private-value-retention";
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export interface PrivateValueRetentionModuleOptions {
  /** The data directory whose `private-values` store is swept. */
  dataDir: string;
  /**
   * Directories whose files may name references that must stay. The daemon passes the stored tool
   * artifacts, recorded workflows and its state directory (validation ask ledger, tool catalog).
   */
  referenceRoots: readonly string[];
  logger?: Logger;
  initialDelayMs?: number;
  intervalMs?: number;
  minAgeMs?: number;
  maxEntriesPerPass?: number;
}

/** The roots a daemon with these paths marks references from. */
export function daemonPrivateValueReferenceRoots(paths: {
  dataDir: string;
  stateDir: string;
}): string[] {
  return [
    path.join(paths.dataDir, "artifacts"),
    path.join(paths.dataDir, "recorded-workflows"),
    paths.stateDir,
  ];
}

/**
 * Periodically removes private values nothing names any more (see `sweepPrivateValues`). Each pass
 * marks first; a pass whose mark fails deletes nothing. Passes examine a bounded number of entries
 * and continue where the previous one stopped, so a large store is worked down across passes.
 */
export class PrivateValueRetentionModule implements DaemonModule {
  readonly id = PRIVATE_VALUE_RETENTION_MODULE_ID;
  readonly name = "Private Value Retention";
  readonly critical = false;

  private state: ModuleLifecycleState = "uninitialized";
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<PrivateValueSweepResult | undefined> | undefined;
  private nextShard = 0;
  private lastResult: PrivateValueSweepResult | undefined;
  private lastRunAtMs: number | undefined;
  private lastError: string | null = null;

  constructor(private readonly options: PrivateValueRetentionModuleOptions) {}

  getState(): ModuleLifecycleState {
    return this.state;
  }

  async start(_context: ModuleContext): Promise<void> {
    this.state = "starting";
    this.schedule(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.state = "ready";
  }

  async stop(_context: ModuleContext): Promise<void> {
    this.state = "stopping";
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    this.state = "stopped";
  }

  /** Runs one mark-and-sweep pass now, or joins the one in progress. */
  runOnce(): Promise<PrivateValueSweepResult | undefined> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (this.state === "ready") {
          this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
        }
      });
    }, delayMs);
    this.timer.unref();
  }

  private async pass(): Promise<PrivateValueSweepResult | undefined> {
    this.lastRunAtMs = Date.now();
    try {
      const keep = await collectPrivateValueReferences(this.options.referenceRoots);
      const result = await sweepPrivateValues({
        dataDir: this.options.dataDir,
        keep,
        startShard: this.nextShard,
        ...(this.options.minAgeMs === undefined ? {} : { minAgeMs: this.options.minAgeMs }),
        ...(this.options.maxEntriesPerPass === undefined
          ? {}
          : { maxEntries: this.options.maxEntriesPerPass }),
      });
      this.nextShard = result.nextShard;
      this.lastResult = result;
      this.lastError = null;
      if (result.deleted > 0 || result.migrated > 0 || result.indexDeleted > 0) {
        this.options.logger?.info("Private value retention pass", {
          scanned: result.scanned,
          deleted: result.deleted,
          indexDeleted: result.indexDeleted,
          migrated: result.migrated,
          referenced: keep.size,
        });
      }
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("Private value retention pass skipped", {
        reason: this.lastError,
      });
      return undefined;
    }
  }

  async healthCheck(): Promise<ModuleHealth> {
    return this.lastError === null
      ? { status: "ready", lastCheckTime: Date.now() }
      : { status: "degraded", message: this.lastError, lastCheckTime: Date.now() };
  }

  async getDiagnostics(): Promise<JsonObject> {
    return {
      lastRunAtMs: this.lastRunAtMs ?? null,
      lastError: this.lastError,
      scanned: this.lastResult?.scanned ?? null,
      deleted: this.lastResult?.deleted ?? null,
      indexDeleted: this.lastResult?.indexDeleted ?? null,
      migrated: this.lastResult?.migrated ?? null,
      nextShard: this.nextShard,
    };
  }
}
