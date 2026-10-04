import fs from "node:fs";
import path from "node:path";
import { LocalDatabaseConnection } from "@resin/db";
import { type HarnessVersionStats, readHarnessVersionStats } from "@resin/observer";

/** Why the custom tool count could not be established. */
export type ServedCatalogUnavailableReason =
  | "state_db_missing"
  | "state_db_unreadable"
  | "no_workspace"
  | "no_snapshot"
  | "snapshot_unreadable";

/** The catalog the MCP gateway last served for a workspace, as recorded in the local state store. */
export type ServedCatalogReading =
  | {
      available: true;
      workspaceId: string;
      /** Non-system tools in the snapshot: what an agent in this workspace is offered. */
      customToolsCount: number;
      /** When the gateway resolved the snapshot. */
      asOf: string;
    }
  | {
      available: false;
      reason: ServedCatalogUnavailableReason;
      workspaceId: string | null;
    };

/**
 * Read-only view of the daemon's local state store for `resin status`. It never migrates,
 * creates, or writes the store, and never throws: an unreadable store reads as "no evidence".
 */
export interface LocalStateReader {
  servedCatalog(cwd: string): Promise<ServedCatalogReading>;
  harnessVersionStats(harnessId: string, version: string): HarnessVersionStats | null;
  close(): void;
}

interface SnapshotRow {
  tools_json: string;
  timestamp: string;
}

function openReadOnly(stateDbPath: string): LocalDatabaseConnection | null {
  // `open()` creates missing directories, which a status probe must never do.
  if (!fs.existsSync(stateDbPath)) return null;
  try {
    return new LocalDatabaseConnection({ path: stateDbPath, readOnly: true }).open();
  } catch {
    return null;
  }
}

/**
 * Resolves the workspace `cwd` belongs to exactly as the MCP gateway does, without bootstrapping
 * (creating) any project metadata.
 */
async function resolveWorkspaceId(cwd: string): Promise<{
  workspaceId: string;
  isSystemMetaTool: (toolId: string) => boolean;
} | null> {
  try {
    // Lazy: keeps @resin/gateway off every status path that has no catalog to read.
    const gateway = await import("@resin/gateway");
    const context = gateway.resolveWorkspaceContext({ cwd, disableBootstrap: true });
    // The gateway serves excluded roots ($HOME, the Resin home) as unbootstrapped workspaces.
    const workspaceId = gateway.isExcludedProjectRoot(context.projectRoot)
      ? context.workspaceId
      : gateway.bootstrapProject(context.projectRoot, { readOnly: true }).projectId;
    return { workspaceId, isSystemMetaTool: gateway.isSystemMetaTool };
  } catch {
    return null;
  }
}

/**
 * Opens the daemon's state store read-only. `<dataDir>/state.db` is where the MCP gateway
 * persists every catalog snapshot it resolves (`catalog_snapshots`) and where the observer keeps
 * per-harness-version decode stats.
 */
export function openLocalStateReader(options: { dataDir: string }): LocalStateReader {
  const stateDbPath = path.join(options.dataDir, "state.db");
  const conn = openReadOnly(stateDbPath);

  return {
    async servedCatalog(cwd) {
      if (conn === null) {
        return {
          available: false,
          reason: fs.existsSync(stateDbPath) ? "state_db_unreadable" : "state_db_missing",
          workspaceId: null,
        };
      }
      const workspace = await resolveWorkspaceId(cwd);
      if (workspace === null) {
        return { available: false, reason: "no_workspace", workspaceId: null };
      }
      let row: SnapshotRow | null;
      try {
        row = conn.get<SnapshotRow>(
          `SELECT tools_json, timestamp FROM catalog_snapshots
             WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT 1`,
          [workspace.workspaceId],
        );
      } catch {
        return {
          available: false,
          reason: "state_db_unreadable",
          workspaceId: workspace.workspaceId,
        };
      }
      if (row === null) {
        return { available: false, reason: "no_snapshot", workspaceId: workspace.workspaceId };
      }
      try {
        const tools: unknown = JSON.parse(row.tools_json);
        if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
          throw new Error("catalog snapshot tools are not an object");
        }
        let customToolsCount = 0;
        for (const [toolId, summary] of Object.entries(tools)) {
          const status = (summary as { status?: unknown } | null)?.status;
          if (status === "active" && !workspace.isSystemMetaTool(toolId)) customToolsCount += 1;
        }
        return {
          available: true,
          workspaceId: workspace.workspaceId,
          customToolsCount,
          asOf: row.timestamp,
        };
      } catch {
        return {
          available: false,
          reason: "snapshot_unreadable",
          workspaceId: workspace.workspaceId,
        };
      }
    },
    harnessVersionStats(harnessId, version) {
      return conn === null ? null : readHarnessVersionStats(conn, harnessId, version);
    },
    close() {
      conn?.close();
    },
  };
}
