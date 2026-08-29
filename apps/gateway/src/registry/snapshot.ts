import {
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type CatalogToolSummary,
  CatalogToolSummarySchema,
  type ToolScope,
  hashCanonicalContent,
} from "@resin/contracts";
import type { CatalogEntry, CatalogSnapshotRecord, ToolScopeHierarchy } from "./types.js";

function normalizeScope(scope: ToolScopeHierarchy | ToolScope): ToolScope {
  if (scope === "system") {
    return "global";
  }
  if (scope === "account") {
    return "user";
  }
  return scope;
}

/**
 * Creates a CatalogToolSummary from a CatalogEntry.
 */
export function createCatalogToolSummary(entry: CatalogEntry): CatalogToolSummary {
  return CatalogToolSummarySchema.parse({
    toolId: entry.toolId,
    version: entry.version,
    manifestDigest: entry.manifestDigest,
    scope: normalizeScope(entry.scope),
    status: entry.status,
  });
}

/**
 * Computes a deterministic SHA-256 canonical digest for a catalog tools mapping.
 */
export function computeCatalogDigest(tools: Record<string, CatalogToolSummary>): string {
  return hashCanonicalContent(tools);
}

export interface BuildCatalogSnapshotOptions {
  workspaceId: string;
  revision: number;
  entries: CatalogEntry[] | Record<string, CatalogEntry>;
  sessionId?: string;
  timestamp?: string;
  previousSnapshotId?: string;
  previousDigest?: string;
}

/**
 * Builds an immutable, canonically digested CatalogSnapshotRecord.
 */
export function buildCatalogSnapshot(options: BuildCatalogSnapshotOptions): CatalogSnapshotRecord {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const safeWorkspace = options.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const randSuffix = Math.random().toString(36).slice(2, 8);
  const snapshotId = `snap_${safeWorkspace}_r${options.revision}_${randSuffix}`;

  const entryMap: Record<string, CatalogEntry> = {};
  const tools: Record<string, CatalogToolSummary> = {};

  if (Array.isArray(options.entries)) {
    for (const entry of options.entries) {
      entryMap[entry.toolId] = entry;
      tools[entry.toolId] = createCatalogToolSummary(entry);
    }
  } else {
    for (const [toolId, entry] of Object.entries(options.entries)) {
      entryMap[toolId] = entry;
      tools[toolId] = createCatalogToolSummary(entry);
    }
  }

  const digest = computeCatalogDigest(tools);

  const snapshot: CatalogSnapshotRecord = {
    snapshotId,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    revision: options.revision,
    timestamp,
    tools,
    entries: entryMap,
    digest,
    previousSnapshotId: options.previousSnapshotId,
    previousDigest: options.previousDigest,
  };

  // Validate conformance against CatalogSnapshotSchema
  CatalogSnapshotSchema.parse(snapshot);

  // Freeze top-level and tools for immutability
  Object.freeze(snapshot.tools);
  if (snapshot.entries) {
    Object.freeze(snapshot.entries);
  }
  return Object.freeze(snapshot);
}

/**
 * Compares two snapshots by digest to determine if active tools changed.
 */
export function isCatalogSnapshotEqual(
  a?: CatalogSnapshot | null,
  b?: CatalogSnapshot | null,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.digest === b.digest && a.workspaceId === b.workspaceId;
}
