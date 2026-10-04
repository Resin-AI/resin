import fs from "node:fs";
import path from "node:path";

/** Leftovers younger than this stay: they may still explain a recent restart. */
export const STALE_STATE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const QUARANTINED_LOCK_PREFIX = "daemon.lock.stale.";
const TEMPORARY_FILE_SUFFIX = ".tmp";

/**
 * Deletes leftovers directly in `stateDir` whose modification time is older than `maxAgeMs`:
 * daemon locks quarantined by stale-lock recovery (`daemon.lock.stale.*`) and temporary files an
 * interrupted atomic write never renamed (`*.tmp`). Only regular files with those exact name
 * shapes are touched; directories, symlinks and every other file stay. Never throws; returns the
 * names removed.
 */
export async function pruneStaleStateFiles(
  stateDir: string,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? STALE_STATE_FILE_MAX_AGE_MS);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const isLeftover =
      (entry.name.startsWith(QUARANTINED_LOCK_PREFIX) &&
        entry.name.length > QUARANTINED_LOCK_PREFIX.length) ||
      (entry.name.endsWith(TEMPORARY_FILE_SUFFIX) &&
        entry.name.length > TEMPORARY_FILE_SUFFIX.length);
    if (!entry.isFile() || !isLeftover) continue;
    const filePath = path.join(stateDir, entry.name);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      await fs.promises.unlink(filePath);
      removed.push(entry.name);
    } catch {
      // Another process may have removed or replaced it; leftovers are retried next start.
    }
  }
  return removed;
}
