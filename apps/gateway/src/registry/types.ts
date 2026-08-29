import type {
  CapabilityEnvelope,
  CatalogSnapshot,
  CatalogToolSummary,
  ToolArtifact,
  ToolManifest,
  ToolScope,
  V1LockedToolEntry,
  V1ToolLock,
} from "@resin/contracts";
import type { SafetyGateEvaluator } from "@resin/runtime";
import type { ToolInvocationRouter } from "../meta/router-contract.js";
import type { CallToolResult } from "../protocol/types.js";
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
  parameters?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler?: ToolHandler;
  sourceCode?: string;
  isPinned?: boolean;
  isDisabled?: boolean;
  metadata?: Record<string, unknown>;
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
  parameters?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  manifest: ToolManifest;
  artifact?: ToolArtifact;
  handler?: ToolHandler;
  sourceCode?: string;
  workspaceId?: string;
  sessionId?: string;
  isPinned?: boolean;
  isDisabled?: boolean;
  isSystem?: boolean;
  metadata?: Record<string, unknown>;
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
export interface ToolRegistryOptions {
  /**
   * Database connection, state store, or repository for persistence.
   */
  db?: unknown;
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
}
