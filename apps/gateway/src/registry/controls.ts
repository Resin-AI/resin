import type { V1LockedToolEntry } from "@resin/contracts";
import type { ProjectLockManager } from "../project/lock-manager.js";
import type { UserControls } from "./types.js";

interface DbConnectionLike {
  run(sql: string, params?: unknown[]): unknown;
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
}

interface StateStoreLike {
  getConnection?(): DbConnectionLike;
  conn?: DbConnectionLike;
  db?: DbConnectionLike;
}

export interface UserControlsManagerOptions {
  lockManager?: ProjectLockManager | ((workspaceId: string) => ProjectLockManager | undefined);
  lockManagers?: Map<string, ProjectLockManager> | Record<string, ProjectLockManager>;
  onChange?: (workspaceId: string) => void;
}

export interface PinVersionOptions {
  entry?: V1LockedToolEntry;
  expectedArtifactDigest?: string;
}

export interface RollbackEntryOption {
  toolName: string;
  entry: V1LockedToolEntry;
  expectedArtifactDigest?: string;
}

/**
 * Extracts a usable SQLite connection interface from various DB wrappers or stores.
 */
function extractConnection(db: unknown): DbConnectionLike | null {
  if (!db || typeof db !== "object") {
    return null;
  }
  const store = db as StateStoreLike;
  if (typeof store.getConnection === "function") {
    return store.getConnection() ?? null;
  }
  if (store.conn && typeof store.conn.run === "function") {
    return store.conn;
  }
  if (store.db && typeof store.db.run === "function") {
    return store.db;
  }
  if ("run" in db && typeof (db as DbConnectionLike).run === "function") {
    return db as DbConnectionLike;
  }
  return null;
}

/**
 * Manages user preferences and controls: version pinning, tool disabling, and manual rollbacks.
 * When a ProjectLockManager is configured, the committed .resin/resin.lock file is the source of truth
 * for project tool lifecycles (active, pinned, disabled).
 * Preserves SQLite persistence for non-tool global controls and legacy unconfigured workspaces.
 */
export class UserControlsManager {
  private readonly conn: DbConnectionLike | null;
  private readonly memoryControls = new Map<string, UserControls>();
  private readonly lockManagers = new Map<string, ProjectLockManager>();
  private lockResolver?: (workspaceId: string) => ProjectLockManager | undefined;
  private onChange?: (workspaceId: string) => void;

  constructor(
    db?: unknown,
    options?:
      | UserControlsManagerOptions
      | ProjectLockManager
      | ((workspaceId: string) => ProjectLockManager | undefined),
  ) {
    this.conn = extractConnection(db);
    this.initDb();

    if (options) {
      if (typeof options === "function") {
        this.lockResolver = options;
      } else if ("lockPath" in options && "projectId" in options) {
        // Single lock manager instance passed directly
        const lm = options as ProjectLockManager;
        this.lockResolver = () => lm;
      } else if (typeof options === "object") {
        const opts = options as UserControlsManagerOptions;
        if (typeof opts.lockManager === "function") {
          this.lockResolver = opts.lockManager;
        } else if (opts.lockManager) {
          const lm = opts.lockManager;
          this.lockResolver = () => lm;
        }
        if (opts.lockManagers) {
          if (opts.lockManagers instanceof Map) {
            for (const [wsId, mgr] of opts.lockManagers.entries()) {
              this.lockManagers.set(wsId, mgr);
            }
          } else {
            for (const [wsId, mgr] of Object.entries(opts.lockManagers)) {
              this.lockManagers.set(wsId, mgr);
            }
          }
        }
        if (opts.onChange) {
          this.onChange = opts.onChange;
        }
      }
    }
  }

  /**
   * Sets a callback to be notified whenever user controls change for a workspace.
   */
  setOnChange(handler: (workspaceId: string) => void): void {
    this.onChange = handler;
  }
  private initDb(): void {
    if (!this.conn) {
      return;
    }
    try {
      this.conn.run(`
        CREATE TABLE IF NOT EXISTS user_tool_controls (
          workspace_id TEXT PRIMARY KEY,
          pinned_versions_json TEXT NOT NULL DEFAULT '{}',
          disabled_tools_json TEXT NOT NULL DEFAULT '[]',
          frozen_tools_json TEXT NOT NULL DEFAULT '[]',
          rollbacks_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        )
      `);
    } catch {
      // Table may already exist or DB is read-only
    }
  }

  /**
   * Binds a ProjectLockManager to a specific workspace.
   */
  bindLockManager(workspaceId: string, lockManager: ProjectLockManager): void {
    this.lockManagers.set(workspaceId, lockManager);
  }

  /**
   * Retrieves the ProjectLockManager bound to a workspace, if any.
   */
  getLockManager(workspaceId: string): ProjectLockManager | undefined {
    return this.lockManagers.get(workspaceId) ?? this.lockResolver?.(workspaceId);
  }

  /**
   * Retrieves user controls for a workspace.
   * If a ProjectLockManager is configured, extracts tool lifecycle state from the committed lockfile.
   */
  async getControls(workspaceId: string): Promise<UserControls> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      const pinnedVersions: Record<string, string> = {};
      const disabledTools: string[] = [];
      const frozenTools: string[] = [];

      try {
        const lock = lockManager.read();
        for (const [name, entry] of Object.entries(lock.tools)) {
          pinnedVersions[name] = entry.version;
          pinnedVersions[entry.toolId] = entry.version;

          if (entry.status === "disabled") {
            disabledTools.push(name);
            disabledTools.push(entry.toolId);
          } else if (entry.status === "pinned") {
            frozenTools.push(name);
            frozenTools.push(entry.toolId);
          }
        }
      } catch (err: unknown) {
        // If lockfile is missing, treat as empty until initialized
        if (err instanceof Error && !err.message.includes("Lockfile not found")) {
          // Re-throw security violations or project ID mismatches
          if (
            err.message.includes("Security violation") ||
            err.message.includes("Project ID mismatch")
          ) {
            throw err;
          }
        }
      }
      // Preserve non-tool metadata such as rollbacks and explicit user disabled tools from SQLite/memory
      const nonToolControls = await this.getNonToolControls(workspaceId);
      for (const disabled of nonToolControls.disabledTools ?? []) {
        if (!disabledTools.includes(disabled)) {
          disabledTools.push(disabled);
        }
      }

      return {
        workspaceId,
        pinnedVersions,
        disabledTools,
        frozenTools,
        rollbacks: nonToolControls.rollbacks ?? [],
      };
    }
    return this.getNonToolControls(workspaceId);
  }

  private async getNonToolControls(workspaceId: string): Promise<UserControls> {
    const cached = this.memoryControls.get(workspaceId);
    if (cached) {
      return cached;
    }

    if (this.conn) {
      try {
        const row = this.conn.get<{
          workspace_id: string;
          pinned_versions_json: string;
          disabled_tools_json: string;
          frozen_tools_json: string;
          rollbacks_json: string;
        }>("SELECT * FROM user_tool_controls WHERE workspace_id = ?", [workspaceId]);

        if (row) {
          const controls: UserControls = {
            workspaceId: row.workspace_id,
            pinnedVersions: JSON.parse(row.pinned_versions_json || "{}"),
            disabledTools: JSON.parse(row.disabled_tools_json || "[]"),
            frozenTools: JSON.parse(row.frozen_tools_json || "[]"),
            rollbacks: JSON.parse(row.rollbacks_json || "[]"),
          };
          this.memoryControls.set(workspaceId, controls);
          return controls;
        }
      } catch {
        // Fallback to memory on read error
      }
    }

    const defaultControls: UserControls = {
      workspaceId,
      pinnedVersions: {},
      disabledTools: [],
      frozenTools: [],
      rollbacks: [],
    };
    this.memoryControls.set(workspaceId, defaultControls);
    return defaultControls;
  }

  /**
   * Persists non-tool controls for a workspace to DB and memory cache.
   */
  private async persistControls(controls: UserControls): Promise<void> {
    this.memoryControls.set(controls.workspaceId, controls);

    if (this.conn) {
      try {
        const now = new Date().toISOString();
        this.conn.run(
          `
          INSERT INTO user_tool_controls (
            workspace_id,
            pinned_versions_json,
            disabled_tools_json,
            frozen_tools_json,
            rollbacks_json,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            pinned_versions_json = excluded.pinned_versions_json,
            disabled_tools_json = excluded.disabled_tools_json,
            frozen_tools_json = excluded.frozen_tools_json,
            rollbacks_json = excluded.rollbacks_json,
            updated_at = excluded.updated_at
        `,
          [
            controls.workspaceId,
            JSON.stringify(controls.pinnedVersions),
            JSON.stringify(controls.disabledTools),
            JSON.stringify(controls.frozenTools ?? []),
            JSON.stringify(controls.rollbacks ?? []),
            now,
          ],
        );
      } catch {
        // Ignore DB persist error in memory-fallback mode
      }
    }
    this.onChange?.(controls.workspaceId);
  }

  /**
   * Pins a specific tool version in a workspace.
   * When ProjectLockManager is configured, changing versions requires an explicit exact V1 entry.
   */
  async pinToolVersion(
    workspaceId: string,
    toolId: string,
    version: string,
    options?: PinVersionOptions,
  ): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      if (options?.entry) {
        lockManager.updateExact(options.entry.name, options.entry, options.expectedArtifactDigest);
        this.onChange?.(workspaceId);
        return;
      }
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);

      if (!entry) {
        throw new Error(
          `Explicit exact V1 entry required to pin tool '${toolId}' in a workspace bound to ProjectLockManager`,
        );
      }

      // If version is changing, require explicit exact entry
      if (entry.version !== version) {
        throw new Error(
          `Explicit exact V1 entry required to pin tool '${toolId}' to version '${version}' in a workspace bound to ProjectLockManager`,
        );
      }

      // If existing entry already matches version, verify optimistic digest if provided
      if (
        options?.expectedArtifactDigest &&
        entry.artifactDigest !== options.expectedArtifactDigest
      ) {
        throw new Error(
          `Optimistic lock conflict: expected digest '${options.expectedArtifactDigest}' but found '${entry.artifactDigest}'`,
        );
      }
      return;
    }

    const controls = await this.getControls(workspaceId);
    controls.pinnedVersions[toolId] = version;
    await this.persistControls(controls);
  }

  /**
   * Alias for pinToolVersion.
   */
  async pinVersion(
    workspaceId: string,
    toolId: string,
    version: string,
    options?: PinVersionOptions,
  ): Promise<void> {
    return this.pinToolVersion(workspaceId, toolId, version, options);
  }

  /**
   * Unpins a tool version in a workspace.
   */
  async unpinToolVersion(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      if (entry) {
        // In locked workspace, entries are fixed in lockfile
        this.onChange?.(workspaceId);
      }
    }

    const controls = await this.getControls(workspaceId);
    delete controls.pinnedVersions[toolId];
    await this.persistControls(controls);
  }

  /**
   * Alias for unpinToolVersion.
   */
  async unpinVersion(workspaceId: string, toolId: string): Promise<void> {
    return this.unpinToolVersion(workspaceId, toolId);
  }

  /**
   * Disables a tool in a workspace.
   */
  async disableTool(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      if (entry) {
        lockManager.setStatus(entry.name, "disabled");
        return;
      }
      throw new Error(`Tool '${toolId}' not found in lockfile`);
    }

    const controls = await this.getControls(workspaceId);
    if (!controls.disabledTools.includes(toolId)) {
      controls.disabledTools.push(toolId);
      await this.persistControls(controls);
    }
  }

  /**
   * Alias for disableTool.
   */
  async disable(workspaceId: string, toolId: string): Promise<void> {
    return this.disableTool(workspaceId, toolId);
  }

  /**
   * Enables a previously disabled tool in a workspace.
   */
  async enableTool(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      if (entry) {
        lockManager.setStatus(entry.name, "active");
        return;
      }
      throw new Error(`Tool '${toolId}' not found in lockfile`);
    }

    const controls = await this.getControls(workspaceId);
    controls.disabledTools = controls.disabledTools.filter((id) => id !== toolId);
    await this.persistControls(controls);
  }

  /**
   * Alias for enableTool.
   */
  async enable(workspaceId: string, toolId: string): Promise<void> {
    return this.enableTool(workspaceId, toolId);
  }

  /**
   * Removes (uninstalls) a tool from a workspace lockfile or controls.
   */
  async removeTool(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);

    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      if (entry) {
        lockManager.remove(entry.name);
      }
      return;
    }

    const controls = await this.getControls(workspaceId);
    delete controls.pinnedVersions[toolId];
    controls.disabledTools = controls.disabledTools.filter((id) => id !== toolId);
    if (controls.frozenTools) {
      controls.frozenTools = controls.frozenTools.filter((id) => id !== toolId);
    }
    await this.persistControls(controls);
  }

  /**
   * Checks if a tool is disabled in a workspace.
   */
  async isToolDisabled(workspaceId: string, toolId: string): Promise<boolean> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      return entry?.status === "disabled";
    }

    const controls = await this.getControls(workspaceId);
    return controls.disabledTools.includes(toolId);
  }

  /**
   * Checks if a specific tool is pinned.
   */
  async isToolPinned(workspaceId: string, toolId: string): Promise<boolean> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      return entry !== undefined;
    }

    const controls = await this.getControls(workspaceId);
    return toolId in controls.pinnedVersions;
  }

  /**
   * Checks if a specific version of a tool is pinned.
   */
  async isVersionPinned(workspaceId: string, toolId: string): Promise<boolean> {
    return this.isToolPinned(workspaceId, toolId);
  }

  /**
   * Gets the pinned version for a tool, if any.
   */
  async getPinnedVersion(workspaceId: string, toolId: string): Promise<string | undefined> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ??
        Object.values(lock.tools).find((t) => t.toolId === toolId || t.name === toolId);
      return entry?.version;
    }

    const controls = await this.getControls(workspaceId);
    return controls.pinnedVersions[toolId];
  }

  /**
   * Returns all pinned versions for a workspace.
   */
  async getPinnedVersions(workspaceId: string): Promise<Record<string, string>> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const result: Record<string, string> = {};
      for (const [name, entry] of Object.entries(lock.tools)) {
        result[name] = entry.version;
      }
      return result;
    }

    const controls = await this.getControls(workspaceId);
    return { ...controls.pinnedVersions };
  }
  /**
   * Freezes a tool, preventing automatic updates.
   */
  async freezeTool(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ?? Object.values(lock.tools).find((t) => t.toolId === toolId);
      if (entry) {
        lockManager.setStatus(entry.name, "pinned");
        return;
      }
      throw new Error(`Tool '${toolId}' not found in lockfile`);
    }

    const controls = await this.getControls(workspaceId);
    if (!controls.frozenTools) {
      controls.frozenTools = [];
    }
    if (!controls.frozenTools.includes(toolId)) {
      controls.frozenTools.push(toolId);
      await this.persistControls(controls);
    }
  }

  /**
   * Unfreezes a previously frozen tool.
   */
  async unfreezeTool(workspaceId: string, toolId: string): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      const lock = lockManager.read();
      const entry =
        lock.tools[toolId] ?? Object.values(lock.tools).find((t) => t.toolId === toolId);
      if (entry) {
        lockManager.setStatus(entry.name, "active");
        return;
      }
      throw new Error(`Tool '${toolId}' not found in lockfile`);
    }

    const controls = await this.getControls(workspaceId);
    if (controls.frozenTools && controls.frozenTools.includes(toolId)) {
      controls.frozenTools = controls.frozenTools.filter((id) => id !== toolId);
      await this.persistControls(controls);
    }
  }

  /**
   * Checks if a tool is frozen in a workspace.
   */
  async isToolFrozen(workspaceId: string, toolId: string): Promise<boolean> {
    const controls = await this.getControls(workspaceId);
    return (controls.frozenTools ?? []).includes(toolId);
  }

  /**
   * Returns all disabled tools for a workspace.
   */
  async getDisabledTools(workspaceId: string): Promise<string[]> {
    const controls = await this.getControls(workspaceId);
    return [...controls.disabledTools];
  }

  /**
   * Returns all frozen tools for a workspace.
   */
  async getFrozenTools(workspaceId: string): Promise<string[]> {
    const controls = await this.getControls(workspaceId);
    return [...(controls.frozenTools ?? [])];
  }

  /**
   * Records a manual rollback event.
   * If a ProjectLockManager and rollbackEntry are provided, atomically updates the exact locked version in resin.lock.
   */
  async recordRollback(
    workspaceId: string,
    targetRevision: number | string,
    restoredSnapshotId?: string,
    rollbackEntry?: RollbackEntryOption,
  ): Promise<void> {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager && rollbackEntry) {
      lockManager.updateExact(
        rollbackEntry.toolName,
        rollbackEntry.entry,
        rollbackEntry.expectedArtifactDigest,
      );
    }

    const controls = await this.getNonToolControls(workspaceId);
    if (!controls.rollbacks) {
      controls.rollbacks = [];
    }
    controls.rollbacks.push({
      targetRevision,
      timestamp: new Date().toISOString(),
      restoredSnapshotId,
    });
    await this.persistControls(controls);
  }

  /**
   * Returns rollback history for a workspace.
   */
  async getRollbacks(workspaceId: string) {
    const controls = await this.getControls(workspaceId);
    return [...(controls.rollbacks ?? [])];
  }
  /**
   * Returns rollback history for a workspace (alias for getRollbacks).
   */
  async getRollbackHistory(workspaceId: string) {
    return this.getRollbacks(workspaceId);
  }

  /**
   * Repairs the project lockfile if a ProjectLockManager is configured.
   */
  repairLock(workspaceId: string) {
    const lockManager = this.getLockManager(workspaceId);
    if (lockManager) {
      return lockManager.repair();
    }
    return undefined;
  }
}
