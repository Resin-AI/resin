import { DEVICE_SYNC_PUBLICATION_MAX_AGE_MS, type DeviceSyncResponse } from "@resin/protocol";

/** One consolidated device sync answer, as the daemon's sync loop received it. */
export interface DeviceSyncSnapshot {
  readonly sync: DeviceSyncResponse;
  /** When the read that produced this answer started, in epoch milliseconds. */
  readonly requestedAt: number;
}

/** Receives every answer, and null when answers stop (consumers then poll for themselves). */
export type DeviceSyncListener = (snapshot: DeviceSyncSnapshot | null) => void | Promise<void>;

/**
 * In-process fan-out of the daemon's consolidated device sync.
 *
 * The control-plane module owns the one sync loop and publishes every answer here; other daemon
 * modules subscribe and fetch their own bodies only when their token changes. While nothing is
 * published (the cloud does not offer device sync, or the loop stopped or fell back), `current`
 * answers null and every consumer keeps its own polling.
 */
export class DeviceSyncSignal {
  private latest: DeviceSyncSnapshot | null = null;
  private readonly listeners = new Set<DeviceSyncListener>();
  private readonly clock: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.clock = options.now ?? (() => Date.now());
  }

  /** The latest answer while it is recent enough to stand in for a consumer's own polling. */
  current(): DeviceSyncSnapshot | null {
    const latest = this.latest;
    if (!latest) return null;
    const age = this.clock() - latest.requestedAt;
    return age >= 0 && age <= DEVICE_SYNC_PUBLICATION_MAX_AGE_MS ? latest : null;
  }

  publish(snapshot: DeviceSyncSnapshot): void {
    this.latest = snapshot;
    this.notify(snapshot);
  }

  /** Withdraws the latest answer, returning every consumer to its own polling. */
  clear(): void {
    if (this.latest === null) return;
    this.latest = null;
    this.notify(null);
  }

  subscribe(listener: DeviceSyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(snapshot: DeviceSyncSnapshot | null): void {
    for (const listener of this.listeners) {
      try {
        // A consumer's failure is its own; it never interrupts the sync loop or other consumers.
        void Promise.resolve(listener(snapshot)).catch(() => undefined);
      } catch {
        // Same as above, for a synchronous throw.
      }
    }
  }
}
