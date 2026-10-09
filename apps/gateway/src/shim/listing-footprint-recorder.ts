/**
 * Records, on this device only, what one `resin mcp` process served its harness: the listing
 * footprint (see `@resin/contracts` listing-footprint) of each distinct surface, with the harness
 * and directory it served and while it ran. The observer ties a harness session to the surface it
 * was served by these records (same harness, same directory, running at the session's first
 * prompt) and uploads only the footprint. Nothing is recorded for a harness Resin cannot name or
 * whose guidance block cannot be read: an unknown footprint stays unknown.
 */

import fs from "node:fs";
import path from "node:path";
import {
  type HarnessId,
  LISTING_FOOTPRINT_RECORD_MAX_SURFACES,
  type ListingFootprint,
  type ListingFootprintRecord,
  ListingFootprintRecordSchema,
  computeListingFootprint,
  isHarnessId,
} from "@resin/contracts";
import { defaultHarnessDetector } from "../gateway.js";
import { writePrivateFileAtomic } from "../suggest/index-file.js";
import type { ServedListingSurface } from "./tool-search-surface.js";

/** How long a closed record is kept for the observer to join a session's first prompt to it. */
export const LISTING_FOOTPRINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The harness ids the gateway's client-name detector reports under another name. */
const DETECTED_HARNESS_IDS: Record<string, HarnessId> = {
  codex: "codex-cli",
  cursor: "cursor-cli",
};

/** The harness an MCP client is, by its explicit `--harness` id or else its client name. */
function servedHarnessId(explicit: string | undefined, clientName: string | undefined) {
  if (explicit !== undefined) return isHarnessId(explicit) ? explicit : undefined;
  if (clientName === undefined) return undefined;
  const detected = defaultHarnessDetector({ name: clientName, version: "" });
  const id = DETECTED_HARNESS_IDS[detected] ?? detected;
  return isHarnessId(id) ? id : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Closes the records of gateways that exited without closing them (at their file's last write) and
 * deletes records closed longer ago than {@link LISTING_FOOTPRINT_RETENTION_MS}, and unreadable ones.
 */
export function pruneListingFootprintRecords(dir: string, now: Date = new Date()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      const parsed = ListingFootprintRecordSchema.safeParse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      if (!parsed.success) {
        if (now.getTime() - stat.mtimeMs > LISTING_FOOTPRINT_RETENTION_MS) fs.rmSync(file);
        continue;
      }
      const record = parsed.data;
      if (record.closedAt === undefined) {
        if (isProcessAlive(record.pid)) continue;
        writePrivateFileAtomic(
          file,
          JSON.stringify({ ...record, closedAt: stat.mtime.toISOString() }),
        );
      } else if (now.getTime() - Date.parse(record.closedAt) > LISTING_FOOTPRINT_RETENTION_MS) {
        fs.rmSync(file);
      }
    } catch {
      // A record another gateway is replacing, or one already removed: the next pass sees it.
    }
  }
}

export interface ListingFootprintRecorderOptions {
  /** `<Resin state dir>/listing-footprints`. */
  dir: string;
  /** The directory this gateway serves: its harness session's working directory. */
  cwd: string;
  /** The `--harness` id the gateway was started with, if any. */
  harnessId?: string;
  /**
   * The Resin guidance block installed for a harness, exactly as its context file holds it (markers
   * included), "" when none is installed, or undefined when it cannot be read.
   */
  guidanceBlock: (harnessId: HarnessId) => string | undefined;
  now?: () => Date;
}

export interface ListingFootprintRecorder {
  /** Records a served surface (a no-op when it equals the last one recorded). */
  served(surface: ServedListingSurface): void;
  /** Marks the record closed: the gateway stopped serving. */
  close(): void;
}

/** One record file per gateway process; nothing is written until a surface was served. */
export function createListingFootprintRecorder(
  options: ListingFootprintRecorderOptions,
): ListingFootprintRecorder {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const file = path.join(options.dir, `${process.pid}-${startedAt.getTime()}.json`);
  let record: ListingFootprintRecord | undefined;
  let pruned = false;
  const write = () => {
    if (record !== undefined) writePrivateFileAtomic(file, JSON.stringify(record));
  };
  return {
    served(surface) {
      const harnessId = servedHarnessId(options.harnessId, surface.clientName);
      if (harnessId === undefined) return;
      if (record !== undefined && record.harnessId !== harnessId) return;
      const guidance = options.guidanceBlock(harnessId);
      if (guidance === undefined) return;
      const footprint: ListingFootprint = computeListingFootprint({
        instructions: guidance === "" ? [surface.instructions] : [surface.instructions, guidance],
        tools: surface.tools,
        listedToolIds: surface.listedToolIds,
        capped: surface.capped,
      });
      const last = record?.surfaces.at(-1)?.footprint;
      if (last !== undefined && JSON.stringify(last) === JSON.stringify(footprint)) return;
      if (!pruned) {
        pruned = true;
        pruneListingFootprintRecords(options.dir, now());
      }
      const entry = { servedAt: now().toISOString(), footprint };
      record =
        record === undefined
          ? {
              version: 1,
              harnessId,
              cwd: path.resolve(options.cwd),
              pid: process.pid,
              startedAt: startedAt.toISOString(),
              surfaces: [entry],
            }
          : {
              ...record,
              surfaces: [...record.surfaces, entry].slice(-LISTING_FOOTPRINT_RECORD_MAX_SURFACES),
            };
      write();
    },
    close() {
      if (record === undefined || record.closedAt !== undefined) return;
      record = { ...record, closedAt: now().toISOString() };
      write();
    },
  };
}
