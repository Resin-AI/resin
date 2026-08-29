import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { buildToolBundle } from "../src/bundle/builder.js";
import { ArtifactCache } from "../src/loader/cache.js";
import { ToolBundleLoader } from "../src/loader/loader.js";
import { QuarantineManager } from "../src/loader/quarantine.js";
import { reconcileCache } from "../src/loader/reconciliation.js";
import { collectGarbage } from "../src/loader/retention.js";

const sampleManifest: ToolManifest = {
  id: "test-tool-reconciliation",
  name: "reconciliation-tool",
  version: "1.0.0",
  description: "Tool for testing reconciliation and retention",
  parameters: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  },
  runtime: {
    runtime: "deno",
    memoryLimitMb: 128,
    timeoutMs: 5000,
    cpuLimitPercent: 100,
    maxOutputSizeBytes: 1048576,
  },
  capabilities: {
    version: "1.0.0",
    description: "Reconciliation tool caps",
    fs: { read: [], write: [] },
    net: { allowedHosts: [], allowDns: false },
    exec: { allowedCommands: [], allowPipes: false },
    harness: { allowRegistration: false, allowTelemetry: false },
  },
  limits: {
    timeoutMs: 5000,
    maxOutputBytes: 1048576,
    maxMemoryBytes: 134217728,
    maxConcurrentInvocations: 1,
  },
  scope: "workspace",
  digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  metadata: {},
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("cache reconciliation and retention", () => {
  it("cleans abandoned staging directories and identifies healthy artifacts", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, development: true });

      // Create a valid cached artifact
      const built = await buildToolBundle({
        manifest: sampleManifest,
        files: [{ path: "src/index.ts", content: "export const ok = true;" }],
      });
      await loader.loadBundle(built.archiveBuffer);

      // Simulate abandoned staging directory from a crashed process
      const orphanStaging = await cache.createStagingDirectory("orphan-staging");
      fs.writeFileSync(path.join(orphanStaging, "temp.bin"), "incomplete payload");

      const report = await reconcileCache(cache, quarantine, { verifyAll: true });

      expect(report.cleanedStagingDirs).toBeGreaterThanOrEqual(1);
      expect(report.healthyArtifacts.includes(built.bundleDigest)).toBe(true);
      expect(report.corruptedArtifacts.length).toBe(0);
      expect(fs.existsSync(orphanStaging)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects and quarantines corrupted artifacts during reconciliation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-corrupt-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });

      // Create a fake corrupted artifact dir missing manifest
      const corruptDigest = "corrupted00000000000000000000000000000000000000000000000000000000";
      const corruptDir = cache.getArtifactPath(corruptDigest);
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, "garbage.txt"), "corrupted content");

      // Register reference so reconciliation checks it
      await cache.acquireReference(corruptDigest, {
        refId: "ref-corrupt",
        refType: "active",
        createdAt: new Date().toISOString(),
      });

      const report = await reconcileCache(cache, quarantine, { verifyAll: true });

      expect(report.corruptedArtifacts).toContain(corruptDigest);

      // Corrupted artifact should be removed from cache and quarantined
      const quarantined = await quarantine.listQuarantined();
      expect(quarantined.some((q) => q.digest === corruptDigest)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("garbage collection preserves active, canary, pinned, and rollback versions while removing unreferenced artifacts", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });
      const loader = new ToolBundleLoader({ cache, quarantine, development: true });

      // Create 4 distinct bundles
      const bundleActive = await buildToolBundle({
        manifest: { ...sampleManifest, id: "tool-active" },
        files: [{ path: "src/index.ts", content: "active" }],
      });
      const bundleCanary = await buildToolBundle({
        manifest: { ...sampleManifest, id: "tool-canary" },
        files: [{ path: "src/index.ts", content: "canary" }],
      });
      const bundlePinned = await buildToolBundle({
        manifest: { ...sampleManifest, id: "tool-pinned" },
        files: [{ path: "src/index.ts", content: "pinned" }],
      });
      const bundleOrphan = await buildToolBundle({
        manifest: { ...sampleManifest, id: "tool-orphan" },
        files: [{ path: "src/index.ts", content: "orphan" }],
      });

      await loader.loadBundle(bundleActive.archiveBuffer);
      await loader.loadBundle(bundleCanary.archiveBuffer);
      await loader.loadBundle(bundlePinned.archiveBuffer);
      await loader.loadBundle(bundleOrphan.archiveBuffer);
      // A zero grace period must collect artifacts even if filesystem mtime is slightly ahead.
      const futureMtime = new Date(Date.now() + 1_000);
      fs.utimesSync(cache.getArtifactPath(bundleOrphan.bundleDigest), futureMtime, futureMtime);

      expect(cache.hasArtifact(bundleActive.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundleCanary.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundlePinned.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundleOrphan.bundleDigest)).toBe(true);

      const gcResult = await collectGarbage(cache, {
        activeDigests: [bundleActive.bundleDigest],
        canaryDigests: [bundleCanary.bundleDigest],
        pinnedDigests: [bundlePinned.bundleDigest],
        minAgeMs: 0,
      });

      expect(gcResult.scannedCount).toBe(4);
      expect(gcResult.deletedCount).toBe(1);
      expect(gcResult.deletedDigests).toContain(bundleOrphan.bundleDigest);

      expect(gcResult.preservedDigests).toContain(bundleActive.bundleDigest);
      expect(gcResult.preservedDigests).toContain(bundleCanary.bundleDigest);
      expect(gcResult.preservedDigests).toContain(bundlePinned.bundleDigest);

      // Verify filesystem state
      expect(cache.hasArtifact(bundleActive.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundleCanary.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundlePinned.bundleDigest)).toBe(true);
      expect(cache.hasArtifact(bundleOrphan.bundleDigest)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("development reconciliation remains explicit development mode", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dev-mode-test-"));
    try {
      const cacheDir = path.join(tempRoot, "artifacts");
      const quarantineDir = path.join(tempRoot, "quarantine");

      const cache = new ArtifactCache({ cacheDir });
      const quarantine = new QuarantineManager({ quarantineDir });

      // Development loader accepts bundles without qualification.json
      const devLoader = new ToolBundleLoader({ cache, quarantine, development: true });
      const prodLoader = new ToolBundleLoader({ cache, quarantine, development: false });

      const built = await buildToolBundle({
        manifest: sampleManifest,
        files: [{ path: "src/index.ts", content: "export const dev = true;" }],
      });

      // Dev loader loads successfully with isApproved: false
      const loadedDev = await devLoader.loadBundle(built.archiveBuffer);
      expect(loadedDev.isApproved).toBe(false);
      expect(loadedDev.approval).toBeUndefined();
      expect(loadedDev.effectProfile).toBeUndefined();

      // Prod loader rejects unapproved candidate
      await expect(
        prodLoader.loadBundle(built.archiveBuffer, { forceReExtract: true }),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
