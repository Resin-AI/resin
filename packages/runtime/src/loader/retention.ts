import fs from "node:fs";
import path from "node:path";
import type { ArtifactCache } from "./cache.js";

export interface GarbageCollectionOptions {
  activeDigests?: Iterable<string>;
  canaryDigests?: Iterable<string>;
  pinnedDigests?: Iterable<string>;
  rollbackTargetDigests?: Iterable<string>;
  minAgeMs?: number;
  dryRun?: boolean;
}

export interface GarbageCollectionResult {
  scannedCount: number;
  deletedCount: number;
  freedBytes: number;
  preservedDigests: string[];
  deletedDigests: string[];
  dryRun: boolean;
}

/**
 * Calculates total size of a directory recursively.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stats = await fs.promises.stat(fullPath);
        size += stats.size;
      } catch {
        // Ignore stat errors
      }
    }
  }
  return size;
}

/**
 * Normalizes digest string for set comparison.
 */
function normalizeDigest(digest: string): string {
  return digest.replace(/^sha256:/i, "").toLowerCase();
}

/**
 * Executes retention and garbage collection on the artifact cache.
 *
 * Guaranteed Invariants:
 * - Active versions are ALWAYS preserved.
 * - Canary versions are ALWAYS preserved.
 * - Pinned versions are ALWAYS preserved.
 * - Rollback targets are ALWAYS preserved.
 * - Artifacts with active reference count > 0 are preserved.
 * - Only unreferenced artifacts exceeding minAgeMs are removed.
 */
export async function collectGarbage(
  cache: ArtifactCache,
  options: GarbageCollectionOptions = {},
): Promise<GarbageCollectionResult> {
  await cache.ensureDirectories();

  const protectedDigests = new Set<string>();

  // Add active digests
  if (options.activeDigests) {
    for (const d of options.activeDigests) {
      protectedDigests.add(normalizeDigest(d));
    }
  }

  // Add canary digests
  if (options.canaryDigests) {
    for (const d of options.canaryDigests) {
      protectedDigests.add(normalizeDigest(d));
    }
  }

  // Add pinned digests
  if (options.pinnedDigests) {
    for (const d of options.pinnedDigests) {
      protectedDigests.add(normalizeDigest(d));
    }
  }

  // Add rollback target digests
  if (options.rollbackTargetDigests) {
    for (const d of options.rollbackTargetDigests) {
      protectedDigests.add(normalizeDigest(d));
    }
  }

  // Add all digests with registered references
  const allRefs = await cache.getAllReferences();
  for (const [refDigest, refList] of Object.entries(allRefs)) {
    if (refList.length > 0) {
      protectedDigests.add(normalizeDigest(refDigest));
    }
  }

  const result: GarbageCollectionResult = {
    scannedCount: 0,
    deletedCount: 0,
    freedBytes: 0,
    preservedDigests: [],
    deletedDigests: [],
    dryRun: Boolean(options.dryRun),
  };

  if (!fs.existsSync(cache.cacheDir)) {
    return result;
  }

  const entries = await fs.promises.readdir(cache.cacheDir, { withFileTypes: true });
  const now = Date.now();
  const minAgeMs = options.minAgeMs ?? 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".staging" || entry.name === "quarantine" || entry.name.startsWith(".")) {
      continue;
    }

    const digest = normalizeDigest(entry.name);
    result.scannedCount++;

    const isProtected = protectedDigests.has(digest);

    if (isProtected) {
      result.preservedDigests.push(digest);
      continue;
    }

    const artifactPath = path.join(cache.cacheDir, entry.name);
    try {
      const stats = await fs.promises.stat(artifactPath);
      const ageMs = Math.max(0, now - stats.mtimeMs);

      if (minAgeMs > 0 && ageMs < minAgeMs) {
        // Still within grace period
        result.preservedDigests.push(digest);
        continue;
      }

      const dirSize = await getDirectorySize(artifactPath);

      if (!options.dryRun) {
        await fs.promises.rm(artifactPath, { recursive: true, force: true });
      }

      result.deletedCount++;
      result.freedBytes += dirSize;
      result.deletedDigests.push(digest);
    } catch {
      // If error occurs, keep in preserved
      result.preservedDigests.push(digest);
    }
  }

  return result;
}
