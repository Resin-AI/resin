import type { CatalogSnapshotRecord } from "./types.js";

export interface CatalogCacheOptions {
  maxSize?: number;
}

const DEFAULT_CACHE_SIZE = 100;

/**
 * LRU Cache for resolved catalog snapshots, indexed by workspace, session, and revision.
 */
export class CatalogCache {
  private readonly maxSize: number;
  private readonly cache = new Map<string, CatalogSnapshotRecord>();

  constructor(options?: CatalogCacheOptions) {
    this.maxSize = options?.maxSize && options.maxSize > 0 ? options.maxSize : DEFAULT_CACHE_SIZE;
  }

  private makeKey(workspaceId: string, sessionId?: string, revision?: number): string {
    const sId = sessionId ? sessionId.trim() : "*";
    if (revision !== undefined) {
      return `${workspaceId}:${sId}:r${revision}`;
    }
    return `${workspaceId}:${sId}:latest`;
  }

  /**
   * Retrieves the latest cached snapshot for the workspace and session.
   */
  get(workspaceId: string, sessionId?: string): CatalogSnapshotRecord | undefined {
    const key = this.makeKey(workspaceId, sessionId);
    const item = this.cache.get(key);
    if (!item) {
      return undefined;
    }
    // Refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, item);
    return item;
  }

  /**
   * Caches a snapshot as the latest for the workspace and session, and under its revision.
   */
  set(workspaceId: string, sessionId: string | undefined, snapshot: CatalogSnapshotRecord): void {
    const latestKey = this.makeKey(workspaceId, sessionId);
    const revisionKey = this.makeKey(workspaceId, sessionId, snapshot.revision);

    this.cache.delete(latestKey);
    this.cache.set(latestKey, snapshot);

    this.cache.delete(revisionKey);
    this.cache.set(revisionKey, snapshot);

    this.prune();
  }

  /**
   * Retrieves a snapshot by exact revision.
   */
  getByRevision(
    workspaceId: string,
    revision: number,
    sessionId?: string,
  ): CatalogSnapshotRecord | undefined {
    const key = this.makeKey(workspaceId, sessionId, revision);
    const item = this.cache.get(key);
    if (!item) {
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item;
  }

  /**
   * Invalidates all cache entries for a specific workspace.
   */
  invalidateWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidates all cache entries for a specific session within a workspace.
   */
  invalidateSession(workspaceId: string, sessionId: string): void {
    const prefix = `${workspaceId}:${sessionId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clears the entire cache.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Current number of cached snapshots.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Returns true if a cached entry exists for the given workspace and session.
   */
  has(workspaceId: string, sessionId?: string): boolean {
    return this.cache.has(this.makeKey(workspaceId, sessionId));
  }

  /**
   * Prunes entries exceeding maxSize in FIFO order.
   */
  private prune(): void {
    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      } else {
        break;
      }
    }
  }
}
