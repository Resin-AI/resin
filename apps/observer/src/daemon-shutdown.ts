import process from "node:process";
import type { Logger } from "./lifecycle.js";

/** The resources a foreground daemon releases on exit, in the order they are released. */
export interface DaemonShutdownResources {
  stopSupervisor(reason: string): Promise<void>;
  closeStateStore(): void;
  stopIpcServer(): Promise<void>;
  releaseLock(): Promise<void>;
  removePidFile(): Promise<void>;
  /** Records the stop and flushes error reporting over the network. */
  reportStopped(reason: string): Promise<void>;
}

export interface DaemonShutdownOptions {
  resources: DaemonShutdownResources;
  logger: Pick<Logger, "info">;
  exit: (code: number) => void;
  /** Where SIGINT/SIGTERM are delivered; the process unless a test supplies an emitter. */
  signals?: { on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown };
  onCleanupStart?: () => void;
}

export interface DaemonShutdown {
  cleanup(reason: string): Promise<void>;
  /** Releases every resource once, then exits 0. Repeated requests join the first one. */
  requestExit(reason: string): void;
}

async function ignoreFailure(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // Shutdown releases every remaining resource even when an earlier one fails.
  }
}

/**
 * Owns the daemon's exit path. Two properties keep a successor daemon from finding this one's
 * lock (and warning "Recovered stale lock") after an update drain:
 *
 * - The lock is released before the network flush. A drained daemon is restarted by its service
 *   manager while it is still cleaning up; nothing that can wait on the network may run first.
 * - Signal listeners stay installed for the whole cleanup. systemd signals every process in the
 *   unit and the service supervisor forwards its own SIGTERM, so the daemon gets several; with a
 *   one-shot listener the second one hits Node's default action and kills the process mid-cleanup.
 */
export function createDaemonShutdown(options: DaemonShutdownOptions): DaemonShutdown {
  const { resources, logger } = options;
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (reason: string): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    options.onCleanupStart?.();
    cleanupPromise = (async () => {
      logger.info("Cleaning up daemon resources...");
      await ignoreFailure(() => resources.stopSupervisor(reason));
      await ignoreFailure(() => resources.closeStateStore());
      await ignoreFailure(() => resources.stopIpcServer());
      await ignoreFailure(() => resources.releaseLock());
      await ignoreFailure(() => resources.removePidFile());
      await ignoreFailure(() => resources.reportStopped(reason));
    })();
    return cleanupPromise;
  };

  let exitRequested = false;
  const requestExit = (reason: string): void => {
    if (exitRequested) return;
    exitRequested = true;
    void cleanup(reason).finally(() => options.exit(0));
  };

  const signals = options.signals ?? process;
  signals.on("SIGINT", () => requestExit("SIGINT"));
  signals.on("SIGTERM", () => requestExit("SIGTERM"));

  return { cleanup, requestExit };
}
