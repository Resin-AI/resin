import type {
  CapabilityEnvelope,
  CatalogSnapshot,
  CatalogToolSummary,
  InvocationRecord,
  ToolArtifact,
  ToolManifest,
  ToolOutputSchema,
  ToolParameterSchema,
  ToolScope,
  ToolVersion,
  V1LockedToolEntry,
  V1ToolLock,
} from "@resin/contracts";
import type { LocalDatabaseConnection } from "@resin/db";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { ToolInvocationRouter } from "../meta/router-contract.js";
import type { ProjectLockManager } from "../project/lock-manager.js";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

/**
 * Tool scope hierarchy levels from narrowest to broadest.
 * Resolution precedence: session > workspace > account > system.
 */
export type ToolScopeHierarchy = "session" | "workspace" | "account" | "system";

export const SCOPE_PRECEDENCE: readonly ToolScopeHierarchy[] = [
  "session",
  "workspace",
  "account",
  "system",
] as const;

/**
 * Status of a tool in the registry.
 */
export type ToolRegistryStatus =
  | "draft"
  | "staged"
  | "active"
  | "deprecated"
  | "revoked"
  | "disabled"
  | "blocked";

/**
 * In-memory representation of a tool registered with the gateway.
 */
export interface RegistryTool {
  toolId: string;
  name: string;
  version: string;
  manifest: ToolManifest;
  manifestDigest?: string;
  artifact?: ToolArtifact;
  artifactDigest?: string;
  envelope?: CapabilityEnvelope;
  envelopeDigest?: string;
  scope: ToolScopeHierarchy | ToolScope;
  status: ToolRegistryStatus;
  workspaceId?: string;
  sessionId?: string;
  accountId?: string;
  exposedName?: string;
  description?: string;
  parameters?: ToolParameterSchema | JsonRpcParams;
  outputSchema?: ToolOutputSchema | JsonRpcParams;
  handler?: ToolHandler;
  sourceCode?: string;
  isPinned?: boolean;
  isDisabled?: boolean;
  metadata?: JsonRpcParams;
  isSystem?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Catalog entry representing an active tool in a resolved catalog.
 */
export interface CatalogEntry {
  toolId: string;
  name: string;
  version: string;
  manifestDigest: string;
  artifactDigest?: string;
  envelope?: CapabilityEnvelope;
  envelopeDigest?: string;
  scope: ToolScopeHierarchy | ToolScope;
  status: ToolRegistryStatus;
  exposedName: string;
  description?: string;
  parameters?: JsonRpcParams;
  outputSchema?: JsonRpcParams;
  manifest: ToolManifest;
  artifact?: ToolArtifact;
  handler?: ToolHandler;
  sourceCode?: string;
  workspaceId?: string;
  sessionId?: string;
  isPinned?: boolean;
  isDisabled?: boolean;
  isSystem?: boolean;
  metadata?: JsonRpcParams;
}

/**
 * Extended snapshot record tracking monotonic revision and historical linkage.
 */
export interface CatalogSnapshotRecord extends CatalogSnapshot {
  revision: number;
  sessionId?: string;
  entries?: Record<string, CatalogEntry>;
  previousSnapshotId?: string;
  previousDigest?: string;
}

/**
 * Result of manifest and artifact validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifestDigest?: string;
  artifactDigest?: string;
}

/**
 * Persisted user controls for a specific workspace.
 */
export interface UserControls {
  workspaceId: string;
  pinnedVersions: Record<string, string>; // toolId -> pinned version
  disabledTools: string[]; // toolIds of disabled tools
  frozenTools?: string[]; // toolIds of frozen tools
  rollbacks?: Array<{
    targetRevision: number | string;
    timestamp: string;
    restoredSnapshotId?: string;
    toolId?: string;
  }>;
}

/**
 * Event emitted when the catalog changes for a scope.
 */
export interface CatalogChangeEvent {
  workspaceId: string;
  sessionId?: string;
  revision: number;
  snapshot: CatalogSnapshot;
  changedToolIds: string[];
  timestamp: string;
}

/**
 * Options for configuring ToolRegistry.
 */
export interface ToolRepoLike {
  saveManifest?(manifest: ToolManifest): Promise<void>;
  getManifest?(toolId: string, version?: string): Promise<ToolManifest | null>;
  listManifests?(options?: { scope?: string }): Promise<ToolManifest[]>;
  saveToolVersion?(version: ToolVersion): Promise<void>;
  getToolVersion?(toolId: string, version: string): Promise<ToolVersion | null>;
  listToolVersions?(toolId?: string): Promise<ToolVersion[]>;
  saveCatalogSnapshot?(snapshot: CatalogSnapshot): Promise<void>;
  getCatalogSnapshot?(snapshotDigest: string): Promise<CatalogSnapshot | null>;
  getLatestCatalogSnapshot?(workspaceId: string): Promise<CatalogSnapshot | null>;
  listCatalogSnapshots?(workspaceId?: string): Promise<CatalogSnapshot[]>;
  listDeployments?(options?: { workspaceId?: string; toolId?: string; state?: string }): Promise<
    unknown[]
  >;
  listInstallations?(workspaceId?: string): Promise<unknown[]>;
}

export interface StateStoreLike {
  getToolRepository?(): ToolRepoLike;
  tools?: ToolRepoLike;
  getConnection?(): DbConnectionLike | null;
  conn?: DbConnectionLike | LocalDatabaseConnection | null;
  db?: DbConnectionLike | LocalDatabaseConnection | null;
}

export interface DbConnectionLike {
  run(
    sql: string,
    params?: (string | number | boolean | null)[],
  ): { changes?: number; lastInsertRowid?: number | bigint } | undefined;
  get<T = Record<string, string | number | boolean | null>>(
    sql: string,
    params?: (string | number | boolean | null)[],
  ): T | undefined;
  all<T = Record<string, string | number | boolean | null>>(
    sql: string,
    params?: (string | number | boolean | null)[],
  ): T[];
}

export type ToolRegistryDatabaseOption =
  | ToolRepoLike
  | StateStoreLike
  | LocalDatabaseConnection
  | DbConnectionLike
  | null;

export type ControlsDatabaseSource = ToolRegistryDatabaseOption | undefined;

export interface ToolRegistryOptions {
  /**
   * Database connection, state store, or repository for persistence.
   */
  db?: ToolRegistryDatabaseOption;
  /**
   * Maximum entries in LRU cache (default: 100).
   */
  cacheSize?: number;
  /**
   * Debounce interval in milliseconds for catalog change events (default: 50ms).
   */
  debounceMs?: number;
  /**
   * Default capability envelope applied when validating tool manifests.
   */
  defaultEnvelope?: CapabilityEnvelope;
  /**
   * Initial set of registry tools to pre-populate.
   */
  initialTools?: RegistryTool[];
  /**
   * Optional invocation router for dispatching tool executions.
   */
  invocationRouter?: ToolInvocationRouter;
  /**
   * Optional Safety Gate evaluator for enforcing production readiness.
   */
  safetyGateEvaluator?: SafetyGateEvaluator;
  /**
   * Whether to automatically hydrate tools from the database on startup (default: true).
   */
  autoHydrate?: boolean;
  /**
   * Optional hook called when a tool invocation completes.
   */
  onInvocationRecorded?: (record: InvocationRecord) => Promise<void>;
  /**
   * Optional lock manager instance or resolver.
   */
  lockManager?: ProjectLockManager | ((workspaceId: string) => ProjectLockManager | undefined);
  /**
   * Optional mapping of workspace IDs to lock managers.
   */
  lockManagers?: Map<string, ProjectLockManager> | Record<string, ProjectLockManager>;
}
