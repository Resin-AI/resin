import type { V1LockedToolEntry, V1ProjectMetadata, V1ToolLock } from "@resin/contracts";

export type {
  V1LockedToolEntry,
  V1ProjectMetadata,
  V1ProjectSettings,
  V1ToolLock,
} from "@resin/contracts";

/**
 * Options for project bootstrap operations.
 */
export interface ProjectBootstrapOptions {
  /**
   * Timeout in milliseconds for acquiring the bootstrap concurrency lock.
   * Default: 5000ms.
   */
  lockTimeoutMs?: number;
  /**
   * Stale threshold in milliseconds after which an existing lock file is considered stale.
   * Default: 10000ms.
   */
  staleLockThresholdMs?: number;
  /**
   * Optional custom project name override (default is basename of project root).
   */
  projectName?: string;
  /**
   * Optional read-only flag. If true, bootstrap will validate and read existing
   * metadata without attempting to acquire locks or mutate the filesystem.
   */
  readOnly?: boolean;
}

/**
 * Indicates which half of the metadata state was deterministically recovered.
 */
export type ProjectMetadataRecoveryState = "project_recreated_lock" | "lock_recreated_project";

/**
 * Result of bootstrapping or loading a Resin project.
 */
export interface ProjectBootstrapResult {
  /**
   * Stable project UUID.
   */
  projectId: string;
  /**
   * Canonical filesystem path to the project root (Git root if present).
   */
  projectRoot: string;
  /**
   * Whether the project root or .resin metadata directory is read-only.
   */
  isReadOnly: boolean;
  /**
   * Path to the `.resin` metadata directory.
   */
  resinDir: string;
  /**
   * Path to the `.resin/project.json` file.
   */
  projectJsonPath: string;
  /**
   * Path to the `.resin/resin.lock` file.
   */
  lockPath: string;
  /**
   * Validated project metadata.
   */
  project: V1ProjectMetadata;
  /**
   * Validated tool lockfile.
   */
  lock: V1ToolLock;
  /**
   * Set if one of the metadata files was recovered from the other.
   */
  recoveredPartialState?: ProjectMetadataRecoveryState;
}

/**
 * Options for ProjectLockManager.
 */
export interface ProjectLockManagerOptions {
  /**
   * Path to the .resin/resin.lock file, or .resin directory, or project root.
   */
  lockPath: string;
  /**
   * Expected project UUID.
   */
  projectId?: string;
  /**
   * Timeout in milliseconds for acquiring concurrency lock on lockfile operations.
   * Default: 5000ms.
   */
  lockTimeoutMs?: number;
  /**
   * Stale threshold in milliseconds for lockfile concurrency lock.
   * Default: 10000ms.
   */
  staleLockThresholdMs?: number;
  /**
   * Optional read-only mode.
   */
  readOnly?: boolean;
}

/**
 * Outcome of reconciling a tool entry into the committed lockfile.
 */
export type ReconcileOutcome =
  | "added"
  | "updated"
  | "unchanged"
  | "revoked"
  | "superseded"
  | "conflict"
  | "newer_available";

/**
 * Result of reconciling a tool entry.
 */
export interface ReconcileResult {
  outcome: ReconcileOutcome;
  lock: V1ToolLock;
  previousEntry?: V1LockedToolEntry;
  currentEntry?: V1LockedToolEntry;
  details?: string;
}
