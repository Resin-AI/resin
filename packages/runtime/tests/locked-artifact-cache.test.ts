import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ToolManifest,
  ToolManifestSchema,
  type V1LockedToolEntry,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildToolBundle, computeSha256, encodeDeterministicTar } from "../src/bundle/builder.js";
import { InMemoryKeyStore, generateBundleKeyPair } from "../src/bundle/signature.js";
import { ArtifactCache } from "../src/loader/cache.js";
import { QuarantineManager } from "../src/loader/quarantine.js";

describe("Locked Artifact Cache", () => {
  let tempRoot: string;
  let cacheDir: string;
  let quarantineDir: string;
  let keyStore: InMemoryKeyStore;
  let keyPair: { keyId: string; publicKeyPem: string; privateKeyPem: string; algorithm: "ed25519" };

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "locked-artifact-cache-test-"));
    cacheDir = path.join(tempRoot, "artifacts");
    quarantineDir = path.join(cacheDir, "quarantine");
    keyStore = new InMemoryKeyStore();
    keyPair = generateBundleKeyPair("ed25519", "prod-key-1");
    await keyStore.addKey({
      keyId: keyPair.keyId,
      publicKeyPem: keyPair.publicKeyPem,
      algorithm: "ed25519",
      status: "active",
      trustedSince: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    if (fs.existsSync(tempRoot)) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  function createManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
    return {
      id: "a0000000-0000-4000-8000-000000000001",
      name: "test_calc",
      version: "1.0.0",
      description: "Deterministic test calculator tool",
      parameters: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
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
        description: "Calculator test tool caps",
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
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      metadata: {},
      createdAt: "2026-08-20T00:00:00.000Z",
      ...overrides,
    };
  }

  async function createValidBundle(manifestOverrides: Partial<ToolManifest> = {}) {
    const manifest = createManifest(manifestOverrides);
    const sourceCode = "export function calculate(a: number) { return a * 2; }";
    const built = await buildToolBundle({
      manifest,
      files: [{ path: "src/index.ts", content: sourceCode }],
      signOptions: {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    });

    const validatedManifest = ToolManifestSchema.parse(manifest);
    const manifestDigest = normalizeSha256(computeSha256(canonicalJson(validatedManifest)), false);
    const artifactDigest = normalizeSha256(computeSha256(built.archiveBuffer), false);

    const lockedEntry: V1LockedToolEntry = {
      toolId: validatedManifest.id,
      name: validatedManifest.name,
      version: validatedManifest.version,
      manifestDigest,
      artifactDigest,
      status: "active",
      signatureIdentity: {
        keyId: keyPair.keyId,
        algorithm: "ed25519",
      },
    };

    return { manifest: validatedManifest, built, lockedEntry, sourceCode };
  }

  it("installs and reuses a verified locked artifact across calls (deduplication)", async () => {
    const { built, lockedEntry } = await createValidBundle();
    const cache = new ArtifactCache({ cacheDir, keyStore });

    // Initial install
    const installedPath = await cache.installLockedArtifact(lockedEntry, built.archiveBuffer, {
      reference: {
        refId: "project-1-ref",
        refType: "active",
        metadata: { projectId: "p-0001", accountId: "acc-1" },
      },
    });

    expect(installedPath).toBe(cache.getArtifactPath(lockedEntry.artifactDigest));
    expect(fs.existsSync(installedPath)).toBe(true);

    // Verify manifest and .extracted files exist
    const manifestOnDisk = JSON.parse(
      fs.readFileSync(path.join(installedPath, "manifest.json"), "utf8"),
    );
    expect(manifestOnDisk.id).toBe(lockedEntry.toolId);
    expect(manifestOnDisk.version).toBe(lockedEntry.version);

    const metaOnDisk = JSON.parse(fs.readFileSync(path.join(installedPath, ".extracted"), "utf8"));
    expect(metaOnDisk.verified).toBe(true);
    expect(metaOnDisk.digest).toBe(normalizeSha256(lockedEntry.artifactDigest, false));

    // Cache hit check
    expect(cache.isArtifactCached(lockedEntry.artifactDigest)).toBe(true);
    expect(await cache.isLockedArtifactCached(lockedEntry)).toBe(true);
    expect(await cache.getVerifiedLockedArtifact(lockedEntry)).toBe(installedPath);

    // Re-install must reuse existing without error and record secondary reference
    const reusedPath = await cache.installLockedArtifact(lockedEntry, built.archiveBuffer, {
      reference: {
        refId: "project-2-ref",
        refType: "pinned",
        metadata: { projectId: "p-0002", accountId: "acc-2" },
      },
    });

    expect(reusedPath).toBe(installedPath);

    const refs = await cache.getReferences(lockedEntry.artifactDigest);
    expect(refs.length).toBe(2);
    expect(refs.map((r) => r.refId)).toEqual(["project-1-ref", "project-2-ref"]);
  });

  it("converges concurrent installations for the same digest atomically", async () => {
    const { built, lockedEntry } = await createValidBundle();
    const cache = new ArtifactCache({ cacheDir, keyStore });

    // Launch 5 concurrent install operations
    const promises = Array.from({ length: 5 }).map((_, idx) =>
      cache.installLockedArtifact(lockedEntry, built.archiveBuffer, {
        reference: {
          refId: `concurrent-ref-${idx}`,
          metadata: { projectId: `proj-${idx}` },
        },
      }),
    );

    const results = await Promise.all(promises);
    const expectedPath = cache.getArtifactPath(lockedEntry.artifactDigest);

    for (const res of results) {
      expect(res).toBe(expectedPath);
    }

    const refs = await cache.getReferences(lockedEntry.artifactDigest);
    expect(refs.length).toBe(5);
  });

  it("handles different versions and projects with complete reference isolation", async () => {
    const bundleV1 = await createValidBundle({ version: "1.0.0" });
    const bundleV2 = await createValidBundle({ version: "2.0.0" });
    const cache = new ArtifactCache({ cacheDir, keyStore });

    const pathV1 = await cache.installLockedArtifact(
      bundleV1.lockedEntry,
      bundleV1.built.archiveBuffer,
      {
        reference: {
          refId: "proj-1-v1-ref",
          metadata: { projectId: "proj-1" },
        },
      },
    );

    const pathV2 = await cache.installLockedArtifact(
      bundleV2.lockedEntry,
      bundleV2.built.archiveBuffer,
      {
        reference: {
          refId: "proj-2-v2-ref",
          metadata: { projectId: "proj-2" },
        },
      },
    );

    expect(pathV1).not.toBe(pathV2);
    expect(fs.existsSync(pathV1)).toBe(true);
    expect(fs.existsSync(pathV2)).toBe(true);

    expect(await cache.getVerifiedLockedArtifact(bundleV1.lockedEntry)).toBe(pathV1);
    expect(await cache.getVerifiedLockedArtifact(bundleV2.lockedEntry)).toBe(pathV2);

    // Remove reference from proj-1
    await cache.removeReference(bundleV1.lockedEntry.artifactDigest, "proj-1-v1-ref");
    expect(await cache.hasReferences(bundleV1.lockedEntry.artifactDigest)).toBe(false);
    expect(await cache.hasReferences(bundleV2.lockedEntry.artifactDigest)).toBe(true);
  });

  it("rejects and quarantines malicious path traversal in tarball archive", async () => {
    const { manifest, lockedEntry } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // Create tar with path traversal
    const evilTar = encodeDeterministicTar([
      { path: "manifest.json", content: Buffer.from(canonicalJson(manifest)) },
      { path: "../escape.txt", content: Buffer.from("malicious content") },
      { path: "src/index.ts", content: Buffer.from("export const a = 1;") },
    ]);
    const evilArchiveDigest = normalizeSha256(computeSha256(evilTar.archive), false);

    const evilEntry: V1LockedToolEntry = {
      ...lockedEntry,
      artifactDigest: evilArchiveDigest,
    };

    await expect(cache.installLockedArtifact(evilEntry, evilTar.archive)).rejects.toThrow();

    // Cache directory must not contain the evil artifact
    expect(fs.existsSync(cache.getArtifactPath(evilArchiveDigest))).toBe(false);

    // Quarantine must record the incident
    const records = await quarantine.listQuarantined();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const travRecord = records.find((r) => r.reason === "path_traversal");
    expect(travRecord).toBeDefined();
  });

  it("rejects and quarantines malicious symlink escaping artifact root", async () => {
    const { manifest, lockedEntry } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // Create a staging directory with symlink escape using a custom extractor
    const evilExtractor = async (stagingDir: string) => {
      await fs.promises.mkdir(path.join(stagingDir, "src"), { recursive: true });
      await fs.promises.writeFile(path.join(stagingDir, "manifest.json"), canonicalJson(manifest));
      await fs.promises.writeFile(path.join(stagingDir, "src/index.ts"), "export const test = 1;");
      // Create symlink pointing outside stagingDir
      await fs.promises.symlink("/etc/passwd", path.join(stagingDir, "evil-link"));
    };

    await expect(cache.installLockedArtifact(lockedEntry, evilExtractor)).rejects.toThrow();

    expect(fs.existsSync(cache.getArtifactPath(lockedEntry.artifactDigest))).toBe(false);

    const records = await quarantine.listQuarantined();
    const symRecord = records.find((r) => r.reason === "symlink_escape");
    expect(symRecord).toBeDefined();
  });

  it("rejects and quarantines artifact buffer digest mismatch", async () => {
    const { built, lockedEntry } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // Modify locked entry with different expected digest
    const wrongDigestEntry: V1LockedToolEntry = {
      ...lockedEntry,
      artifactDigest: "e".repeat(64),
    };

    await expect(
      cache.installLockedArtifact(wrongDigestEntry, built.archiveBuffer),
    ).rejects.toThrow();

    const records = await quarantine.listQuarantined();
    const digestRecord = records.find((r) => r.reason === "digest_mismatch");
    expect(digestRecord).toBeDefined();
  });

  it("rejects and quarantines manifest identity/version/digest mismatches", async () => {
    const { manifest, built, lockedEntry } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // 1. ToolId mismatch
    const wrongToolIdEntry: V1LockedToolEntry = {
      ...lockedEntry,
      toolId: "b0000000-0000-4000-8000-000000000002",
    };
    await expect(
      cache.installLockedArtifact(wrongToolIdEntry, built.archiveBuffer),
    ).rejects.toThrow();

    // 2. Version mismatch
    const wrongVersionEntry: V1LockedToolEntry = {
      ...lockedEntry,
      version: "9.9.9",
    };
    await expect(
      cache.installLockedArtifact(wrongVersionEntry, built.archiveBuffer),
    ).rejects.toThrow();

    // 3. Manifest digest mismatch
    const wrongManifestDigestEntry: V1LockedToolEntry = {
      ...lockedEntry,
      manifestDigest: "f".repeat(64),
    };
    await expect(
      cache.installLockedArtifact(wrongManifestDigestEntry, built.archiveBuffer),
    ).rejects.toThrow();
  });

  it("rejects and quarantines signature mismatch", async () => {
    const { manifest } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // Build signed bundle with an untrusted rogue key
    const rogueKeyPair = generateBundleKeyPair("ed25519", "rogue-key");
    const rogueBuilt = await buildToolBundle({
      manifest,
      files: [{ path: "src/index.ts", content: "export const rogue = true;" }],
      signOptions: {
        keyId: rogueKeyPair.keyId,
        privateKeyPem: rogueKeyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    });

    const rogueArchiveDigest = normalizeSha256(computeSha256(rogueBuilt.archiveBuffer), false);
    const rogueManifestDigest = normalizeSha256(computeSha256(canonicalJson(manifest)), false);

    const rogueEntry: V1LockedToolEntry = {
      toolId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifestDigest: rogueManifestDigest,
      artifactDigest: rogueArchiveDigest,
      status: "active",
      signatureIdentity: {
        keyId: keyPair.keyId, // Claims prod keyId, but signed with rogue key
        algorithm: "ed25519",
      },
    };

    await expect(
      cache.installLockedArtifact(rogueEntry, rogueBuilt.archiveBuffer),
    ).rejects.toThrow();

    const records = await quarantine.listQuarantined();
    const sigRecord = records.find((r) => r.reason === "signature_mismatch");
    expect(sigRecord).toBeDefined();
  });

  it("detects corrupted existing target, isolates to quarantine, and never treats as cache hit", async () => {
    const { lockedEntry, built } = await createValidBundle();
    const quarantine = new QuarantineManager({ quarantineDir });
    const cache = new ArtifactCache({ cacheDir, quarantineManager: quarantine, keyStore });

    // Pre-create corrupted target in cacheDir (e.g. corrupted files, missing manifest)
    const targetDir = cache.getArtifactPath(lockedEntry.artifactDigest);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "garbage.bin"), Buffer.from([0x00, 0xff, 0xee]));

    // Check that it's NOT considered cached
    expect(cache.isArtifactCached(lockedEntry.artifactDigest)).toBe(false);
    expect(await cache.isLockedArtifactCached(lockedEntry)).toBe(false);

    // Verification must detect corruption and quarantine it
    const verified = await cache.getVerifiedLockedArtifact(lockedEntry);
    expect(verified).toBeNull();
    expect(fs.existsSync(targetDir)).toBe(false);

    const records = await quarantine.listQuarantined();
    expect(records.length).toBeGreaterThanOrEqual(1);

    // Now a proper install can succeed cleanly
    const installed = await cache.installLockedArtifact(lockedEntry, built.archiveBuffer);
    expect(installed).toBe(targetDir);
    expect(cache.isArtifactCached(lockedEntry.artifactDigest)).toBe(true);
  });

  it("ensures private metadata does not leak into shared blob extraction metadata", async () => {
    const { built, lockedEntry } = await createValidBundle();
    const cache = new ArtifactCache({ cacheDir, keyStore });

    const privateMetadata = {
      projectId: "proj-secret-123",
      userId: "user-super-private",
      accountId: "acc-confidential-789",
      token: "secret-token-value",
    };

    const installedPath = await cache.installLockedArtifact(lockedEntry, built.archiveBuffer, {
      reference: {
        refId: "private-ref-1",
        refType: "active",
        metadata: privateMetadata,
      },
    });

    // Inspect files in artifact directory
    const extractedContent = fs.readFileSync(path.join(installedPath, ".extracted"), "utf8");
    const manifestContent = fs.readFileSync(path.join(installedPath, "manifest.json"), "utf8");

    // Must NOT contain private metadata
    expect(extractedContent).not.toContain("proj-secret-123");
    expect(extractedContent).not.toContain("user-super-private");
    expect(extractedContent).not.toContain("secret-token-value");

    expect(manifestContent).not.toContain("proj-secret-123");
    expect(manifestContent).not.toContain("user-super-private");

    // Private metadata must be in refs.json only
    const refs = await cache.getReferences(lockedEntry.artifactDigest);
    expect(refs[0]?.metadata).toEqual(privateMetadata);
  });

  it("preserves prior good bytes when a subsequent install fails", async () => {
    const goodBundle = await createValidBundle({ name: "good_tool" });
    const cache = new ArtifactCache({ cacheDir, keyStore });

    // Install good artifact
    const goodPath = await cache.installLockedArtifact(
      goodBundle.lockedEntry,
      goodBundle.built.archiveBuffer,
    );
    expect(fs.existsSync(goodPath)).toBe(true);
    expect(await cache.isLockedArtifactCached(goodBundle.lockedEntry)).toBe(true);

    // Attempt to install bad artifact
    const badTar = encodeDeterministicTar([
      { path: "manifest.json", content: Buffer.from("bad json") },
    ]);
    const badArchiveDigest = normalizeSha256(computeSha256(badTar.archive), false);
    const badEntry: V1LockedToolEntry = {
      toolId: "c0000000-0000-4000-8000-000000000003",
      name: "bad_tool",
      version: "1.0.0",
      manifestDigest: "a".repeat(64),
      artifactDigest: badArchiveDigest,
      status: "active",
    };

    await expect(cache.installLockedArtifact(badEntry, badTar.archive)).rejects.toThrow();

    // Prior good artifact must be completely intact
    expect(fs.existsSync(goodPath)).toBe(true);
    expect(await cache.isLockedArtifactCached(goodBundle.lockedEntry)).toBe(true);
  });

  it("stores all artifacts in user cache without writing to project directories", async () => {
    const projectDir = path.join(tempRoot, "my-test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const { built, lockedEntry } = await createValidBundle();
    const cache = new ArtifactCache({ cacheDir, keyStore });

    const installed = await cache.installLockedArtifact(lockedEntry, built.archiveBuffer, {
      reference: {
        refId: "project-local-ref",
        metadata: { projectPath: projectDir },
      },
    });

    // Installed path must be inside cacheDir, not projectDir
    expect(installed.startsWith(cacheDir)).toBe(true);
    expect(installed.startsWith(projectDir)).toBe(false);

    // Project directory must have no artifacts created in it
    const projectFiles = fs.readdirSync(projectDir);
    expect(projectFiles.length).toBe(0);
  });
});
