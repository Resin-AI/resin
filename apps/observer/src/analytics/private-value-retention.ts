/**
 * On-disk retention for immutable V2 private values. The recorder keeps one entry file per
 * (session, call, slot) it observes and nothing ever removed them, so the store grew with every
 * recorded call. Retention marks every reference something on this device still names and sweeps
 * entries that are both unnamed and older than an age floor; it never reads or logs a value.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory } from "../private-fs.js";
import {
  privateValueEntriesDir,
  privateValueEntryName,
  privateValueEntryPath,
} from "./private-value-store.js";

/**
 * Entries younger than this always stay, named or not: a recent call may still be asked about by a
 * validation request, or named by a tool the cloud is still generating from its upload.
 */
export const PRIVATE_VALUE_RETENTION_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Entry files one sweep pass examines at most, so a pass stays short on a large store. */
export const PRIVATE_VALUE_SWEEP_MAX_ENTRIES = 20_000;

const SHARD_COUNT = 256;
const REFERENCE_PATTERN = /private:v2:[a-z]+:[0-9a-f]{64}/g;
const ENTRY_NAME = /^[0-9a-f]{64}\.json$/;

/**
 * Every V2 reference named by a file under `roots` (stored tool artifacts, recorded workflows,
 * daemon state such as the validation ask ledger and the cached tool catalog). Symlinks are not
 * followed. A root or file that vanishes is skipped; any other read failure throws, because an
 * incomplete mark must never drive a sweep.
 */
export async function collectPrivateValueReferences(
  roots: readonly string[],
): Promise<Set<string>> {
  const references = new Set<string>();
  const visit = async (target: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(target, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      let text: string;
      try {
        text = await fs.promises.readFile(child, "latin1");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const match of text.matchAll(REFERENCE_PATTERN)) references.add(match[0]);
    }
  };
  for (const root of roots) await visit(root);
  return references;
}

export interface PrivateValueSweepResult {
  /** Entry and leftover temporary files examined. */
  scanned: number;
  deleted: number;
  /** Flat pre-sharding entries moved into their shard. */
  migrated: number;
  /** The shard the next pass starts at. */
  nextShard: number;
}

/**
 * Deletes V2 entries under `dataDir` that no reference in `keep` names and whose modification time
 * is at least `minAgeMs` old, along with temporary files an interrupted write left that old. Flat
 * entries written before sharding are swept first and every one kept is moved into its shard
 * (hard link then unlink, so its age and a concurrent winner are preserved); shards follow, from
 * `startShard`, until about `maxEntries` files were examined.
 */
export async function sweepPrivateValues(options: {
  dataDir: string;
  keep: ReadonlySet<string>;
  now?: number;
  minAgeMs?: number;
  maxEntries?: number;
  startShard?: number;
}): Promise<PrivateValueSweepResult> {
  const entriesDir = privateValueEntriesDir(options.dataDir);
  const cutoff =
    (options.now ?? Date.now()) - (options.minAgeMs ?? PRIVATE_VALUE_RETENTION_MIN_AGE_MS);
  const budget = options.maxEntries ?? PRIVATE_VALUE_SWEEP_MAX_ENTRIES;
  const keepNames = new Set([...options.keep].map(privateValueEntryName));
  const result: PrivateValueSweepResult = {
    scanned: 0,
    deleted: 0,
    migrated: 0,
    nextShard: (options.startShard ?? 0) % SHARD_COUNT,
  };

  /**
   * Deletes an expired entry or leftover temporary file. True when the file is gone afterwards or
   * was never a candidate; false for an entry that stays.
   */
  const expire = async (directory: string, name: string): Promise<boolean> => {
    const file = path.join(directory, name);
    const isEntry = ENTRY_NAME.test(name);
    if (!isEntry && !name.endsWith(".tmp")) return true;
    result.scanned++;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!stat.isFile()) return true;
    if (stat.mtimeMs < cutoff && !(isEntry && keepNames.has(name))) {
      await fs.promises.rm(file, { force: true });
      result.deleted++;
      return true;
    }
    return !isEntry;
  };

  let flat: fs.Dir;
  try {
    flat = await fs.promises.opendir(entriesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for await (const entry of flat) {
    if (result.scanned >= budget) return result;
    if (!entry.isFile() || (await expire(entriesDir, entry.name))) continue;
    // A kept flat entry: move it into its shard.
    const source = path.join(entriesDir, entry.name);
    const target = privateValueEntryPath(entriesDir, entry.name);
    await ensurePrivateDirectory(path.dirname(target));
    try {
      await fs.promises.link(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "EEXIST") throw error;
      // A writer already published the sharded copy, which reads prefer; drop an identical flat
      // one and leave a differing one for inspection.
      const [current, legacy] = await Promise.all([
        fs.promises.readFile(target),
        fs.promises.readFile(source),
      ]);
      if (!current.equals(legacy)) continue;
    }
    await fs.promises.rm(source, { force: true });
    result.migrated++;
  }

  for (let visited = 0; visited < SHARD_COUNT && result.scanned < budget; visited++) {
    const shard = path.join(entriesDir, result.nextShard.toString(16).padStart(2, "0"));
    result.nextShard = (result.nextShard + 1) % SHARD_COUNT;
    let names: string[];
    try {
      names = await fs.promises.readdir(shard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) await expire(shard, name);
  }
  return result;
}
