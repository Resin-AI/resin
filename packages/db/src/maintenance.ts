import type { LocalDatabaseConnection, WalCheckpointResult } from "./connection.js";

/** SQLite PRAGMA auto_vacuum values. */
const AUTO_VACUUM_MODES = ["none", "full", "incremental"] as const;
export type AutoVacuumMode = (typeof AUTO_VACUUM_MODES)[number];

export interface StateDbMaintenanceOptions {
  /** Upper bound on bytes released by one incremental_vacuum pass. Default 64 MiB. */
  incrementalVacuumMaxBytes?: number;
  /**
   * Largest live (non-free) data size a full VACUUM may rewrite. VACUUM is synchronous and its
   * cost scales with live data, so above this the conversion is deferred. Default 256 MiB.
   */
  vacuumMaxLiveBytes?: number;
  /** Free-page ratio above which a non-incremental database is VACUUMed. Default 0.5. */
  vacuumFreelistRatio?: number;
  /** Ignore free space below this many pages so tiny databases are not rewritten. Default 256. */
  vacuumMinFreelistPages?: number;
}

export interface StateDbMaintenanceResult {
  /**
   * `incremental_vacuum`: free pages were released from an incremental database.
   * `vacuum`: the database was rebuilt and converted to auto_vacuum=INCREMENTAL.
   * `vacuum_deferred`: a non-incremental database is mostly free pages but too large to rebuild online.
   * `checkpoint_only`: nothing to reclaim; the WAL was still checkpointed and truncated.
   * `skipped`: maintenance could not run on this connection (see `skippedReason`).
   */
  action: "incremental_vacuum" | "vacuum" | "vacuum_deferred" | "checkpoint_only" | "skipped";
  skippedReason?: "read_only" | "in_transaction";
  autoVacuumBefore: AutoVacuumMode;
  autoVacuumAfter: AutoVacuumMode;
  pageSize: number;
  pageCountBefore: number;
  pageCountAfter: number;
  freelistBefore: number;
  freelistAfter: number;
  walCheckpoint: WalCheckpointResult | null;
}

const DEFAULT_INCREMENTAL_VACUUM_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_VACUUM_MAX_LIVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_VACUUM_FREELIST_RATIO = 0.5;
const DEFAULT_VACUUM_MIN_FREELIST_PAGES = 256;

/**
 * Reclaims free pages and truncates the WAL of a local state database.
 *
 * - auto_vacuum=INCREMENTAL databases (all databases created by LocalDatabaseConnection) release
 *   at most `incrementalVacuumMaxBytes` of free pages per call.
 * - Older databases (auto_vacuum=NONE/FULL) are only rebuilt when more than
 *   `vacuumFreelistRatio` of their pages are free and their live data fits
 *   `vacuumMaxLiveBytes`; the VACUUM also converts them to INCREMENTAL so later passes stay
 *   bounded. A bloated database rewrites only its live pages, so the qualifying case is cheap.
 * - Every pass ends with wal_checkpoint(TRUNCATE) so space freed by earlier prunes leaves the WAL.
 *
 * Must not run inside a transaction: VACUUM is rejected there and incremental_vacuum would be
 * folded into the caller's transaction. Such calls are skipped and can be retried later.
 */
export function runStateDbMaintenance(
  conn: LocalDatabaseConnection,
  options: StateDbMaintenanceOptions = {},
): StateDbMaintenanceResult {
  const autoVacuumBefore = AUTO_VACUUM_MODES[conn.pragmaNumber("auto_vacuum")] ?? "none";
  const pageSize = conn.pragmaNumber("page_size");
  const pageCountBefore = conn.pragmaNumber("page_count");
  const freelistBefore = conn.pragmaNumber("freelist_count");
  const before = {
    autoVacuumBefore,
    pageSize,
    pageCountBefore,
    freelistBefore,
  };

  const skippedReason = conn.isReadOnly()
    ? "read_only"
    : conn.inTransaction()
      ? "in_transaction"
      : undefined;
  if (skippedReason) {
    return {
      ...before,
      action: "skipped",
      skippedReason,
      autoVacuumAfter: autoVacuumBefore,
      pageCountAfter: pageCountBefore,
      freelistAfter: freelistBefore,
      walCheckpoint: null,
    };
  }

  let action: StateDbMaintenanceResult["action"] = "checkpoint_only";
  if (autoVacuumBefore === "incremental") {
    if (freelistBefore > 0) {
      const maxBytes = options.incrementalVacuumMaxBytes ?? DEFAULT_INCREMENTAL_VACUUM_MAX_BYTES;
      const maxPages = Math.max(1, Math.floor(maxBytes / pageSize));
      // exec, not a prepared get(): each step of incremental_vacuum frees one page.
      conn.exec(`PRAGMA incremental_vacuum(${Math.min(freelistBefore, maxPages)});`);
      action = "incremental_vacuum";
    }
  } else {
    const ratio = options.vacuumFreelistRatio ?? DEFAULT_VACUUM_FREELIST_RATIO;
    const minPages = options.vacuumMinFreelistPages ?? DEFAULT_VACUUM_MIN_FREELIST_PAGES;
    const maxLiveBytes = options.vacuumMaxLiveBytes ?? DEFAULT_VACUUM_MAX_LIVE_BYTES;
    if (freelistBefore >= minPages && freelistBefore > pageCountBefore * ratio) {
      if ((pageCountBefore - freelistBefore) * pageSize <= maxLiveBytes) {
        conn.exec("PRAGMA auto_vacuum = INCREMENTAL;");
        conn.exec("VACUUM;");
        action = "vacuum";
      } else {
        action = "vacuum_deferred";
      }
    }
  }

  const walCheckpoint = conn.checkpoint("TRUNCATE");
  return {
    ...before,
    action,
    autoVacuumAfter: AUTO_VACUUM_MODES[conn.pragmaNumber("auto_vacuum")] ?? "none",
    pageCountAfter: conn.pragmaNumber("page_count"),
    freelistAfter: conn.pragmaNumber("freelist_count"),
    walCheckpoint,
  };
}
