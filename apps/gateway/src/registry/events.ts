import type { CatalogChangeEvent } from "./types.js";

interface PendingEvent {
  workspaceId: string;
  sessionId?: string;
  revision: number;
  snapshot: CatalogChangeEvent["snapshot"];
  changedToolIds: Set<string>;
  timestamp: string;
  timer: NodeJS.Timeout;
}

export interface CatalogEventsOptions {
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 50;

/**
 * Debounced event emitter for catalog change notifications.
 * Coalesces rapid updates for the same workspace/session scope to minimize downstream churn.
 */
export class CatalogChangeEventEmitter {
  private readonly debounceMs: number;
  private readonly globalListeners = new Set<(event: CatalogChangeEvent) => void>();
  private readonly workspaceListeners = new Map<string, Set<(event: CatalogChangeEvent) => void>>();
  private readonly pendingEvents = new Map<string, PendingEvent>();

  constructor(options?: CatalogEventsOptions) {
    this.debounceMs =
      options?.debounceMs !== undefined && options.debounceMs >= 0
        ? options.debounceMs
        : DEFAULT_DEBOUNCE_MS;
  }

  private makeScopeKey(workspaceId: string, sessionId?: string): string {
    return `${workspaceId}:${sessionId ?? "*"}`;
  }

  /**
   * Subscribes to all catalog change events across all workspaces.
   * @returns Unsubscribe function
   */
  onCatalogChanged(listener: (event: CatalogChangeEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Subscribes to catalog change events for a specific workspace.
   * @returns Unsubscribe function
   */
  onWorkspaceCatalogChanged(
    workspaceId: string,
    listener: (event: CatalogChangeEvent) => void,
  ): () => void {
    let listeners = this.workspaceListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.workspaceListeners.set(workspaceId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.workspaceListeners.get(workspaceId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.workspaceListeners.delete(workspaceId);
        }
      }
    };
  }

  /**
   * Emits a debounced catalog change event for a workspace/session scope.
   */
  emit(event: CatalogChangeEvent): void {
    if (this.debounceMs <= 0) {
      this.emitImmediate(event);
      return;
    }

    const scopeKey = this.makeScopeKey(event.workspaceId, event.sessionId);
    const existing = this.pendingEvents.get(scopeKey);

    if (existing) {
      clearTimeout(existing.timer);
      for (const id of event.changedToolIds) {
        existing.changedToolIds.add(id);
      }
      existing.revision = event.revision;
      existing.snapshot = event.snapshot;
      existing.timestamp = event.timestamp;
      existing.timer = setTimeout(() => {
        this.flushScope(scopeKey);
      }, this.debounceMs);
    } else {
      const changedToolIds = new Set(event.changedToolIds);
      const timer = setTimeout(() => {
        this.flushScope(scopeKey);
      }, this.debounceMs);

      this.pendingEvents.set(scopeKey, {
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        revision: event.revision,
        snapshot: event.snapshot,
        changedToolIds,
        timestamp: event.timestamp,
        timer,
      });
    }
  }

  /**
   * Dispatches a catalog change event immediately, bypassing debounce.
   */
  emitImmediate(event: CatalogChangeEvent): void {
    const scopeKey = this.makeScopeKey(event.workspaceId, event.sessionId);
    const existing = this.pendingEvents.get(scopeKey);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingEvents.delete(scopeKey);
      for (const id of existing.changedToolIds) {
        if (!event.changedToolIds.includes(id)) {
          event.changedToolIds.push(id);
        }
      }
    }

    this.dispatch(event);
  }

  private flushScope(scopeKey: string): void {
    const pending = this.pendingEvents.get(scopeKey);
    if (!pending) {
      return;
    }
    this.pendingEvents.delete(scopeKey);

    const event: CatalogChangeEvent = {
      workspaceId: pending.workspaceId,
      sessionId: pending.sessionId,
      revision: pending.revision,
      snapshot: pending.snapshot,
      changedToolIds: Array.from(pending.changedToolIds),
      timestamp: pending.timestamp,
    };

    this.dispatch(event);
  }

  private dispatch(event: CatalogChangeEvent): void {
    // Notify global listeners
    for (const listener of this.globalListeners) {
      try {
        listener(event);
      } catch {
        // Suppress listener errors
      }
    }

    // Notify workspace listeners
    const wsListeners = this.workspaceListeners.get(event.workspaceId);
    if (wsListeners) {
      for (const listener of wsListeners) {
        try {
          listener(event);
        } catch {
          // Suppress listener errors
        }
      }
    }
  }

  /**
   * Immediately dispatches all pending debounced events.
   */
  flush(): void {
    const keys = Array.from(this.pendingEvents.keys());
    for (const key of keys) {
      this.flushScope(key);
    }
  }

  /**
   * Destroys the emitter, canceling all timers and clearing listeners.
   */
  destroy(): void {
    for (const pending of this.pendingEvents.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingEvents.clear();
    this.globalListeners.clear();
    this.workspaceListeners.clear();
  }
}
