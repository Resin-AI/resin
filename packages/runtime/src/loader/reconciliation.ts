import fs from "node:fs";
import path from "node:path";
import type { ArtifactCache } from "./cache.js";
import type { QuarantineManager } from "./quarantine.js";

export interface ReconciliationReport {
  cleanedStagingDirs: number;
  verifiedArtifacts: number;
  healthyArtifacts: string[];
  corruptedArtifacts: string[];
  reconciledAt: string;
}

export interface ReconciliationOptions {
  verifyAll?: boolean;
  quarantineCorrupted?: boolean;
}

/**
 * Performs startup cache reconciliation:
 * 1. Cleans incomplete staging directories leftover from crashes or abrupt terminations.
 * 2. Verifies integrity of all referenced active/canary/pinned/cached artifacts.
 * 3. Quarantines corrupted or tampered artifacts.
 */
export async function reconcileCache(
  cache: ArtifactCache,
  quarantine?: QuarantineManager,
  options: ReconciliationOptions = {},
): Promise<ReconciliationReport> {
  await cache.ensureDirectories();

  const report: ReconciliationReport = {
    cleanedStagingDirs: 0,
    verifiedArtifacts: 0,
    healthyArtifacts: [],
    corruptedArtifacts: [],
    reconciledAt: new Date().toISOString(),
  };

  // 1. Clean staging directories
  if (fs.existsSync(cache.stagingDir)) {
    const stagingEntries = await fs.promises.readdir(cache.stagingDir, { withFileTypes: true });
    for (const entry of stagingEntries) {
      const fullPath = path.join(cache.stagingDir, entry.name);
      try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        report.cleanedStagingDirs++;
      } catch {
        // Continue cleaning
      }
    }
  }

  // Also clean any .staging_* directories in root cacheDir
  if (fs.existsSync(cache.cacheDir)) {
    const rootEntries = await fs.promises.readdir(cache.cacheDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isDirectory() && entry.name.startsWith(".staging")) {
        const fullPath = path.join(cache.cacheDir, entry.name);
        try {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          report.cleanedStagingDirs++;
        } catch {
          // Continue
        }
      }
    }
  }

  // 2. Discover and verify artifacts
  const allRefs = await cache.getAllReferences();
  const referencedDigests = new Set(Object.keys(allRefs));

  if (fs.existsSync(cache.cacheDir)) {
    const entries = await fs.promises.readdir(cache.cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".staging" || entry.name === "quarantine" || entry.name.startsWith(".")) {
        continue;
      }

      const digest = entry.name;
      const isReferenced = referencedDigests.has(digest);

      // Verify if requested or if actively referenced
      if (options.verifyAll || isReferenced) {
        report.verifiedArtifacts++;
        const isValid = await cache.verifyArtifactIntegrity(digest);

        if (isValid) {
          report.healthyArtifacts.push(digest);
        } else {
          report.corruptedArtifacts.push(digest);
          if (options.quarantineCorrupted !== false && quarantine) {
            const artifactPath = cache.getArtifactPath(digest);
            await quarantine.quarantineDirectory(
              artifactPath,
              "corrupted_archive",
              { reason: "Startup reconciliation failed integrity check", digest },
              digest,
              "reconciliation",
            );
          }
        }
      }
    }
  }

  return report;
}
