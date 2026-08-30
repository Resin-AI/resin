import type {
  DeploymentRecord,
  ToolManifest,
  ToolOutputSchema,
  ToolParameterSchema,
} from "@resin/contracts";
import type { CatalogSnapshotResponse } from "@resin/protocol";

export type CloudToolAvailability = "fresh" | "stale" | "expired" | "unavailable";

export interface CachedCloudTool {
  toolId: string;
  name: string;
  version: string;
  manifest: ToolManifest;
  deploymentRecord?: DeploymentRecord;
  fetchedAt: number;
  softExpiresAt: number;
  hardExpiresAt: number;
  availability: CloudToolAvailability;
  exposedName: string;
  description?: string;
  parameters?: ToolParameterSchema;
  outputSchema?: ToolOutputSchema;
  source: "cloud";
  staleReason?: string;
  workspaceId?: string;
}

export interface ToolAvailabilityResult {
  availability: CloudToolAvailability;
  tool?: CachedCloudTool;
  reason?: string;
}

export interface CloudCatalogCacheOptions {
  /**
   * Soft TTL in milliseconds after which cached entries are considered stale.
   * Default: 5 minutes (300,000 ms).
   */
  freshTtlMs?: number;
  /**
   * Hard TTL in milliseconds after which cached entries are expired and execution is blocked.
   * Default: 1 hour (3,600,000 ms).
   */
  hardExpiryMs?: number;
  /**
   * Maximum number of snapshots cached per workspace.
   */
  maxEntries?: number;
}

export class CloudCatalogCache {
  private readonly freshTtlMs: number;
  private readonly hardExpiryMs: number;
  private readonly maxEntries: number;

  // Workspace ID -> Snapshot
  private readonly snapshots = new Map<string, CatalogSnapshotResponse>();
  // Workspace ID -> (ToolId/Name -> CachedCloudTool)
  private readonly toolIndex = new Map<string, Map<string, CachedCloudTool>>();
  // Fallback global tools: ToolId/Name -> CachedCloudTool
  private readonly globalTools = new Map<string, CachedCloudTool>();

  constructor(options: CloudCatalogCacheOptions = {}) {
    this.freshTtlMs = options.freshTtlMs ?? 5 * 60 * 1000;
    this.hardExpiryMs = options.hardExpiryMs ?? 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
  }

  /**
   * Ingests and caches a validated catalog snapshot response.
   */
  setSnapshot(
    snapshot: CatalogSnapshotResponse,
    options: { freshTtlMs?: number; hardExpiryMs?: number; workspaceId?: string } = {},
  ): void {
    const wsId = options.workspaceId || "default";
    const now = Date.now();
    const softTtl = options.freshTtlMs ?? this.freshTtlMs;
    const hardTtl = options.hardExpiryMs ?? this.hardExpiryMs;

    this.snapshots.set(wsId, snapshot);

    let wsTools = this.toolIndex.get(wsId);
    if (!wsTools) {
      wsTools = new Map();
      this.toolIndex.set(wsId, wsTools);
    }

    // Build deployment lookup
    const deploymentByToolId = new Map<string, DeploymentRecord>();
    for (const dep of snapshot.activeDeployments || []) {
      deploymentByToolId.set(dep.toolId, dep);
    }

    // Index all tools
    for (const manifest of snapshot.tools) {
      const dep = deploymentByToolId.get(manifest.id);
      const cached: CachedCloudTool = {
        toolId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifest,
        deploymentRecord: dep,
        fetchedAt: now,
        softExpiresAt: now + softTtl,
        hardExpiresAt: now + hardTtl,
        availability: "fresh",
        exposedName: manifest.name,
        description: manifest.description,
        parameters: manifest.parameters,
        outputSchema: manifest.outputSchema,
        source: "cloud",
        workspaceId: wsId,
      };

      wsTools.set(manifest.id, cached);
      wsTools.set(manifest.name, cached);
      this.globalTools.set(manifest.id, cached);
      this.globalTools.set(manifest.name, cached);
    }

    this.enforceLimits();
  }

  /**
   * Retrieves the current cached snapshot for a workspace.
   */
  getSnapshot(workspaceId = "default"): CatalogSnapshotResponse | null {
    return this.snapshots.get(workspaceId) ?? null;
  }

  /**
   * Retrieves a cached tool by ID or exposed name.
   */
  getTool(toolIdOrName: string, workspaceId = "default"): CachedCloudTool | null {
    const wsTools = this.toolIndex.get(workspaceId);
    const candidate = wsTools?.get(toolIdOrName) ?? this.globalTools.get(toolIdOrName);
    if (!candidate) {
      return null;
    }
    // Update live availability state based on time
    this.refreshToolAvailability(candidate);
    return candidate;
  }

  /**
   * Lists all cached tools for a workspace.
   */
  listTools(workspaceId = "default"): CachedCloudTool[] {
    const wsTools = this.toolIndex.get(workspaceId);
    const sourceMap = wsTools ?? this.globalTools;
    const distinctTools = new Map<string, CachedCloudTool>();

    for (const tool of sourceMap.values()) {
      this.refreshToolAvailability(tool);
      distinctTools.set(tool.toolId, tool);
    }

    return Array.from(distinctTools.values());
  }

  /**
   * Evaluates availability of a tool for invocation.
   */
  getToolAvailability(toolIdOrName: string, workspaceId = "default"): ToolAvailabilityResult {
    const tool = this.getTool(toolIdOrName, workspaceId);
    if (!tool) {
      return {
        availability: "unavailable",
        reason: `Tool '${toolIdOrName}' not found in cloud catalog cache`,
      };
    }

    this.refreshToolAvailability(tool);

    if (tool.availability === "expired") {
      return {
        availability: "expired",
        tool,
        reason: `Cloud tool '${tool.name}' has expired past hard expiry (${new Date(tool.hardExpiresAt).toISOString()})`,
      };
    }

    if (tool.availability === "stale") {
      return {
        availability: "stale",
        tool,
        reason: tool.staleReason || `Cloud tool '${tool.name}' is stale (cached past soft TTL)`,
      };
    }

    return {
      availability: "fresh",
      tool,
    };
  }

  /**
   * Checks whether a tool is hard expired.
   */
  isHardExpired(tool: CachedCloudTool): boolean {
    return Date.now() > tool.hardExpiresAt;
  }

  /**
   * Invalidates specific tools from the cache.
   */
  invalidateTools(toolIds: string[], workspaceId?: string, reason?: string): void {
    const targets = workspaceId ? [workspaceId] : Array.from(this.toolIndex.keys());

    for (const wsId of targets) {
      const wsTools = this.toolIndex.get(wsId);
      if (wsTools) {
        for (const toolId of toolIds) {
          const tool = wsTools.get(toolId);
          if (tool) {
            wsTools.delete(tool.toolId);
            wsTools.delete(tool.name);
            wsTools.delete(tool.exposedName);
          }
        }
      }
    }

    for (const toolId of toolIds) {
      const tool = this.globalTools.get(toolId);
      if (tool) {
        this.globalTools.delete(tool.toolId);
        this.globalTools.delete(tool.name);
        this.globalTools.delete(tool.exposedName);
      }
    }
  }

  /**
   * Marks all cached tools as stale (e.g. when network is disconnected or server offline).
   */
  markAllStale(reason = "Network disconnected / offline mode active", workspaceId?: string): void {
    const targets = workspaceId
      ? [this.toolIndex.get(workspaceId)]
      : Array.from(this.toolIndex.values());

    for (const wsTools of targets) {
      if (wsTools) {
        for (const tool of wsTools.values()) {
          if (Date.now() > tool.hardExpiresAt) {
            tool.availability = "expired";
          } else {
            tool.availability = "stale";
          }
          tool.staleReason = reason;
        }
      }
    }

    for (const tool of this.globalTools.values()) {
      if (Date.now() > tool.hardExpiresAt) {
        tool.availability = "expired";
      } else {
        tool.availability = "stale";
      }
      tool.staleReason = reason;
    }
  }

  /**
   * Marks tools as online / clears forced stale flags when cloud connection restored.
   */
  markOnline(workspaceId?: string): void {
    const targets = workspaceId
      ? [this.toolIndex.get(workspaceId)]
      : Array.from(this.toolIndex.values());

    for (const wsTools of targets) {
      if (wsTools) {
        for (const tool of wsTools.values()) {
          this.refreshToolAvailability(tool);
          if (tool.availability !== "expired" && tool.availability !== "stale") {
            tool.staleReason = undefined;
          }
        }
      }
    }

    for (const tool of this.globalTools.values()) {
      this.refreshToolAvailability(tool);
      if (tool.availability !== "expired" && tool.availability !== "stale") {
        tool.staleReason = undefined;
      }
    }
  }

  /**
   * Clears the entire cache.
   */
  clear(): void {
    this.snapshots.clear();
    this.toolIndex.clear();
    this.globalTools.clear();
  }

  /**
   * Prunes hard-expired entries.
   */
  pruneExpired(): void {
    const now = Date.now();
    for (const [wsId, wsTools] of this.toolIndex.entries()) {
      for (const [key, tool] of wsTools.entries()) {
        if (now > tool.hardExpiresAt) {
          wsTools.delete(key);
        }
      }
      if (wsTools.size === 0) {
        this.toolIndex.delete(wsId);
        this.snapshots.delete(wsId);
      }
    }

    for (const [key, tool] of this.globalTools.entries()) {
      if (now > tool.hardExpiresAt) {
        this.globalTools.delete(key);
      }
    }
  }

  private refreshToolAvailability(tool: CachedCloudTool): void {
    const now = Date.now();
    if (now > tool.hardExpiresAt) {
      tool.availability = "expired";
      tool.staleReason = `Hard expiry exceeded (${new Date(tool.hardExpiresAt).toISOString()})`;
    } else if (now > tool.softExpiresAt) {
      if (tool.availability === "fresh") {
        tool.availability = "stale";
        tool.staleReason = `Soft TTL expired (${new Date(tool.softExpiresAt).toISOString()})`;
      }
    }
  }

  private enforceLimits(): void {
    if (this.snapshots.size > this.maxEntries) {
      const oldestWs = this.snapshots.keys().next().value;
      if (oldestWs) {
        this.snapshots.delete(oldestWs);
        this.toolIndex.delete(oldestWs);
      }
    }
  }
}
