import fs from "node:fs";
import path from "node:path";
import type {
  DaemonModule,
  Logger,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "./lifecycle.js";
import type { JsonObject } from "./normalization/redaction.js";

export const AUTH_PENDING_RETENTION_MODULE_ID = "auth-pending-retention";
/** The tailer's durable auth-pending queue directory, under the daemon state directory. */
export const AUTH_PENDING_DIRECTORY_NAME = "auth-pending";
/** How long a deferred batch may wait for its session to re-attach before it is discarded. */
export const AUTH_PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Files the tailer's auth-pending queue writes: `<sha256(sessionId)>.json`, and the
 * `<that>.<pid>.<uuid>.tmp` it renames into place (left behind only by a crash mid-write).
 */
const AUTH_PENDING_FILE_PATTERN = /^[0-9a-f]{64}\.json(?:\.\d+\.[0-9a-f-]{36}\.tmp)?$/;

export interface AuthPendingSweepResult {
  scanned: number;
  deleted: number;
}

/**
 * Deletes auth-pending queue files whose last write is older than `maxAgeMs`. A queue rewrites
 * its file on every deferral and touches it when its session re-attaches, so only batches whose
 * session never came back (raw transcript records kept for nothing) age out. Symlinks, other
 * names and non-files are never touched.
 */
export async function sweepExpiredAuthPending(options: {
  directory: string;
  maxAgeMs?: number;
  nowMs?: number;
}): Promise<AuthPendingSweepResult> {
  const maxAgeMs = options.maxAgeMs ?? AUTH_PENDING_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  let names: string[];
  try {
    names = await fs.promises.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, deleted: 0 };
    }
    throw error;
  }
  let scanned = 0;
  let deleted = 0;
  for (const name of names) {
    if (!AUTH_PENDING_FILE_PATTERN.test(name)) {
      continue;
    }
    scanned += 1;
    const filePath = path.join(options.directory, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || nowMs - stat.mtimeMs <= maxAgeMs) {
      continue;
    }
    try {
      await fs.promises.unlink(filePath);
      deleted += 1;
    } catch {
      // Gone already or not removable: the next pass looks again.
    }
  }
  return { scanned, deleted };
}

export interface AuthPendingRetentionModuleOptions {
  /** The tailer's auth-pending directory (`<stateDir>/auth-pending`). */
  directory: string;
  logger?: Logger;
  maxAgeMs?: number;
  initialDelayMs?: number;
  intervalMs?: number;
}

/**
 * Local-only maintenance: periodically expires orphaned auth-pending queue files (see
 * `sweepExpiredAuthPending`). Runs signed in or not.
 */
export class AuthPendingRetentionModule implements DaemonModule {
  readonly id = AUTH_PENDING_RETENTION_MODULE_ID;
  readonly name = "Auth-Pending Retention";
  readonly critical = false;

  private state: ModuleLifecycleState = "uninitialized";
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<AuthPendingSweepResult | undefined> | undefined;
  private lastResult: AuthPendingSweepResult | undefined;
  private lastRunAtMs: number | undefined;
  private lastError: string | null = null;

  constructor(private readonly options: AuthPendingRetentionModuleOptions) {}

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

  /** Runs one sweep now, or joins the one in progress. */
  runOnce(): Promise<AuthPendingSweepResult | undefined> {
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

  private async pass(): Promise<AuthPendingSweepResult | undefined> {
    this.lastRunAtMs = Date.now();
    try {
      const result = await sweepExpiredAuthPending({
        directory: this.options.directory,
        ...(this.options.maxAgeMs === undefined ? {} : { maxAgeMs: this.options.maxAgeMs }),
      });
      this.lastResult = result;
      this.lastError = null;
      if (result.deleted > 0) {
        this.options.logger?.info("Expired orphaned auth-pending observation files", {
          scanned: result.scanned,
          deleted: result.deleted,
        });
      }
      return result;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("Auth-pending retention pass skipped", {
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
    };
  }
}
