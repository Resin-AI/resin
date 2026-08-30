import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLATFORMS,
  RELEASE_VERSION,
  WORKSPACE_PACKAGES,
  canonicalJson,
  createDeterministicTar,
  generateChannelMetadata,
  generateCycloneDxSbom,
  generatePackageDigests,
  generateSignedManifest,
  gzipDeterministic,
  packageRelease,
  resolveVulnerabilityScanEvidence,
  sha256Hex,
} from "./package-release.mjs";
import {
  CHANNELS_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  createUploadPlan,
  freeze,
  mirrorRuntimes,
  promote,
  publishImmutable,
  recordSmoke,
  runPostReleaseSmokeTests,
  validatePromotionApproval,
  verifyCandidate,
  verifyPublic,
} from "./publish-public-release.mjs";
import {
  REVOKED_RELEASE_KEY_IDS,
  assertProductionKey,
  createReleaseSigningKey,
  createSignedFreezeNotice,
  createSignedRevocationNotice,
  createSignedRollbackPlan,
  createTestReleaseSigningKey,
  isManifestExpired,
  isTestOnlyKey,
  loadReleaseSigningKeyFromEnv,
  loadTrustedReleaseKeysFromEnv,
  signReleasePayload,
  trustedKeysFromSigningKey,
  verifyReleaseManifestExpiry,
  verifyReleasePayloadSignature,
  verifySignedFreezeNotice,
  verifySignedRevocationNotice,
  verifySignedRollbackPlan,
} from "./release-trust.mjs";
import {
  ALLOWED_RELEASE_BINARIES,
  ALLOWED_TOP_LEVEL_ENTRIES,
  APPROVED_LICENSES,
  FORBIDDEN_LICENSES,
  PROPRIETARY_CLOUD_IDENTIFIERS,
  isForbiddenTarballPath,
  loadBoundaryManifest,
  verifyAssetDigests,
  verifyChannelMetadata,
  verifyDocumentation,
  verifyLicensePolicy,
  verifyManifestSignatures,
  verifyPackageDigests,
  verifyRelease,
  verifyReleaseFiles,
  verifySbom,
  verifyTarballEntries,
  verifyVulnerabilityPolicy,
} from "./verify-release.mjs";

describe("Release Packaging & Verification Suite", () => {
  const rootDir = process.cwd();
  let tempReleaseDir = "";

  beforeAll(() => {
    tempReleaseDir = path.join(os.tmpdir(), `test-release-${Date.now()}`);
    fs.mkdirSync(tempReleaseDir, { recursive: true });
  });

  afterAll(() => {
    if (tempReleaseDir && fs.existsSync(tempReleaseDir)) {
      fs.rmSync(tempReleaseDir, { recursive: true, force: true });
    }
  });

  describe("Deterministic Tarball Generation", () => {
    it("generates identical tar bytes for identical inputs (reproducibility)", () => {
      const entries = [
        { path: "resin/package.json", content: '{"name":"resin","version":"1.0.0"}' },
        {
          path: "resin/bin/resin",
          content: "#!/usr/bin/env node\nconsole.log(1);",
          mode: 0o755,
        },
        { path: "resin/README.md", content: "# Release Readme" },
      ];

      const tar1 = createDeterministicTar(entries);
      const tar2 = createDeterministicTar(entries);

      expect(tar1.equals(tar2)).toBe(true);

      const gz1 = gzipDeterministic(tar1);
      const gz2 = gzipDeterministic(tar2);

      expect(gz1.equals(gz2)).toBe(true);
      expect(sha256Hex(gz1)).toBe(sha256Hex(gz2));
    });

    it("sorts entries deterministically regardless of input order", () => {
      const entriesA = [
        { path: "b.txt", content: "b" },
        { path: "a.txt", content: "a" },
        { path: "c.txt", content: "c" },
      ];
      const entriesB = [
        { path: "c.txt", content: "c" },
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ];

      const tarA = createDeterministicTar(entriesA);
      const tarB = createDeterministicTar(entriesB);

      expect(tarA.equals(tarB)).toBe(true);
    });
  });

  describe("Package Digest & Metadata Generation", () => {
    it("computes digests for public release packages", () => {
      const boundary = loadBoundaryManifest(rootDir);
      const digests = generatePackageDigests(rootDir);
      const packageNames = Object.keys(digests);

      expect(packageNames).toHaveLength(boundary.publicReleasePackages.length);
      for (const pkgName of boundary.publicReleasePackages) {
        expect(digests[pkgName]).toBeDefined();
        expect(digests[pkgName].version).toBeDefined();
        expect(digests[pkgName].packageSha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("Ed25519 Manifest Signing & Verification", () => {
    it("generates a cryptographically valid Ed25519 signature in manifest.json", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const mockAssets = {
        "linux-x64": { filename: "resin-v1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
      };

      const manifest = generateSignedManifest(packageDigests, mockAssets, { testOnly: true });

      expect(manifest.version).toBe(RELEASE_VERSION);
      expect(manifest.signatures).toHaveLength(1);
      expect(manifest.signatures[0].algorithm).toBe("Ed25519");
      expect(manifest.signatures[0].signatureHex).toMatch(/^[a-f0-9]{128}$/);

      const sig = manifest.signatures[0];
      const violations = verifyManifestSignatures(manifest, {
        trustedKeys: {
          [sig.keyId]: {
            keyId: sig.keyId,
            publicKeyPem: sig.publicKeyPem,
            publicKeyHex: sig.publicKeyHex,
            publicKeyFingerprintSha256: sig.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations).toHaveLength(0);
    });

    it("detects tampered manifest payload when signature is modified", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const mockAssets = {
        "linux-x64": { filename: "resin-v1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
      };

      const manifest = generateSignedManifest(packageDigests, mockAssets, { testOnly: true });
      manifest.version = "2.0.0-unauthorized";

      const sig = manifest.signatures[0];
      const violations = verifyManifestSignatures(manifest, {
        trustedKeys: {
          [sig.keyId]: {
            keyId: sig.keyId,
            publicKeyPem: sig.publicKeyPem,
            publicKeyHex: sig.publicKeyHex,
            publicKeyFingerprintSha256: sig.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].rule).toBe("SIGNATURE_VERIFICATION_FAILED");
    });
  });

  describe("Production release trust boundary", () => {
    it("fails closed without production signing credentials", () => {
      expect(() =>
        packageRelease({
          rootDir,
          distDir: path.join(tempReleaseDir, "no-credentials"),
          skipBuild: true,
          repository: "resin-ai/resin",
          ref: "refs/heads/main",
          workflowRunId: "1",
          workflowRunAttempt: "1",
          testOnly: false,
        }),
      ).toThrow(/private key|required|RESIN_RELEASE/i);
    });

    it("rejects asset mutation, changed commit binding, unknown key, missing signature, and stale evidence", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tamper-"));
      try {
        const packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        const baseline = () =>
          verifyRelease({
            rootDir,
            releaseDir: dir,
            allowTestEvidence: true,
            trustedKeys: packaged.trustedKeys,
            expectedCommitSha: packaged.releaseIdentity.commitSha,
          });
        expect(baseline().valid).toBe(true);

        const assetPath = path.join(dir, PLATFORMS[0].filename);
        const manifestPath = path.join(dir, "manifest.json");
        const evidencePath = path.join(dir, "release-evidence.json");
        const originalAsset = fs.readFileSync(assetPath);
        const originalManifest = fs.readFileSync(manifestPath);
        const originalEvidence = fs.readFileSync(evidencePath);

        fs.appendFileSync(assetPath, Buffer.from([0]));
        expect(baseline().violations.some((v) => v.rule === "ASSET_DIGEST_MISMATCH")).toBe(true);
        fs.writeFileSync(assetPath, originalAsset);

        let manifest = JSON.parse(originalManifest.toString("utf8"));
        manifest.releaseIdentity.commitSha = "f".repeat(40);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        expect(baseline().valid).toBe(false);
        fs.writeFileSync(manifestPath, originalManifest);

        manifest = JSON.parse(originalManifest.toString("utf8"));
        manifest.signatures[0].keyId = "unknown-key";
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        expect(baseline().violations.some((v) => v.rule === "UNKNOWN_SIGNING_KEY")).toBe(true);
        fs.writeFileSync(manifestPath, originalManifest);

        manifest = JSON.parse(originalManifest.toString("utf8"));
        manifest.signatures = [];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        expect(baseline().violations.some((v) => v.rule === "MISSING_SIGNATURE")).toBe(true);
        fs.writeFileSync(manifestPath, originalManifest);

        const evidence = JSON.parse(originalEvidence.toString("utf8"));
        evidence.commitSha = "e".repeat(40);
        fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        const stale = baseline();
        expect(
          stale.violations.some(
            (v) => v.rule === "EVIDENCE_COMMIT_MISMATCH" || v.rule === "EVIDENCE_DIGEST_MISMATCH",
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 90_000);
  });

  describe("CycloneDX SBOM Generation & Verification", () => {
    it("generates CycloneDX 1.5 JSON SBOM covering all packages and dependencies from actual inputs", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests, { testOnly: true });

      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.specVersion).toBe("1.5");
      expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-fA-F-]{36}$/);
      expect(sbom.metadata.timestamp).toBeDefined();
      expect(new Date(sbom.metadata.timestamp).toString()).not.toBe("Invalid Date");
      const boundary = loadBoundaryManifest(rootDir);
      expect(sbom.components.length).toBeGreaterThanOrEqual(boundary.publicReleasePackages.length);

      const componentNames = sbom.components.map((c) => c.name);
      for (const pkgName of boundary.publicReleasePackages) {
        expect(componentNames).toContain(pkgName);
      }
      expect(componentNames).not.toContain("@resin/cloud");
      expect(componentNames).not.toContain("@resin/web");
      expect(componentNames).not.toContain("@resin/cloud-contracts");

      expect(componentNames.some((n) => n === "typescript" || n === "zod" || n === "fastify")).toBe(
        true,
      );

      for (const component of sbom.components) {
        expect(component.name).toBeTruthy();
        expect(component.version).toBeTruthy();
        expect(component.purl).toBeTruthy();
        expect(component.licenses).toBeInstanceOf(Array);
        expect(component.licenses.length).toBeGreaterThan(0);
      }
    });

    it("verifies valid sbom.json file in release directory", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests, { testOnly: true });
      fs.writeFileSync(path.join(tempReleaseDir, "sbom.json"), JSON.stringify(sbom, null, 2));

      const violations = verifySbom(tempReleaseDir, { allowTestEvidence: true });
      expect(violations).toHaveLength(0);
    });

    it("rejects test-only SBOM in production verification without allowTestEvidence", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests, { testOnly: true });
      fs.writeFileSync(path.join(tempReleaseDir, "sbom.json"), JSON.stringify(sbom, null, 2));

      const violations = verifySbom(tempReleaseDir, { allowTestEvidence: false });
      expect(violations.some((v) => v.rule === "UNAUTHORIZED_TEST_EVIDENCE")).toBe(true);
    });
    it("requires retained vulnerability scan evidence for production packaging", () => {
      const releaseIdentity = { commitSha: "a".repeat(40) };
      expect(() =>
        resolveVulnerabilityScanEvidence(rootDir, releaseIdentity, { testOnly: false }),
      ).toThrow("requires retained vulnerability scan evidence");

      const evidence = resolveVulnerabilityScanEvidence(rootDir, releaseIdentity, {
        testOnly: false,
        vulnerabilityScanEvidence: {
          schemaVersion: "1.0.0",
          source: "pnpm-audit-and-container-scan",
          generatedAt: "2026-08-25T00:00:00.000Z",
          retentionUntil: "2027-08-25T00:00:00.000Z",
          commitSha: releaseIdentity.commitSha,
          dependencyScan: { status: "COMPLETED" },
          containerScan: { status: "NOT_APPLICABLE", reason: "No container artifact in this lane" },
          vulnerabilities: [],
        },
      });
      expect(evidence.dependencyScan.status).toBe("COMPLETED");
    });

    it("rejects a production SBOM without retained scan metadata", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests, { testOnly: false });
      fs.writeFileSync(path.join(tempReleaseDir, "sbom.json"), JSON.stringify(sbom, null, 2));
      const violations = verifySbom(tempReleaseDir, { allowTestEvidence: false });
      expect(violations.some((v) => v.rule === "MISSING_PRODUCTION_SCAN_EVIDENCE")).toBe(true);
    });
  });

  describe("License Policy Gate Enforcement", () => {
    it("approves permissive licenses and rejects forbidden copyleft licenses without exception", () => {
      const sbomWithForbidden = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          {
            name: "permissive-lib",
            version: "1.0.0",
            purl: "pkg:npm/permissive-lib@1.0.0",
            licenses: [{ license: { id: "MIT" } }],
          },
          {
            name: "forbidden-copyleft-lib",
            version: "2.0.0",
            purl: "pkg:npm/forbidden-copyleft-lib@2.0.0",
            licenses: [{ license: { id: "GPL-3.0" } }],
          },
        ],
      };

      const violations = verifyLicensePolicy(sbomWithForbidden);
      expect(violations.some((v) => v.rule === "FORBIDDEN_LICENSE")).toBe(true);
    });

    it("accepts forbidden license when explicit reviewed exception is supplied", () => {
      const sbomWithException = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        components: [
          {
            name: "forbidden-copyleft-lib",
            version: "2.0.0",
            purl: "pkg:npm/forbidden-copyleft-lib@2.0.0",
            licenses: [{ license: { id: "GPL-3.0" } }],
          },
        ],
      };

      const violations = verifyLicensePolicy(sbomWithException, {
        licenseExceptions: [
          {
            packageName: "forbidden-copyleft-lib",
            license: "GPL-3.0",
            rationale: "Isolated build tool, no link into distributed runtime.",
            reviewer: "security-auditor-42",
            approvedAt: "2026-08-25T00:00:00Z",
          },
        ],
      });

      expect(violations).toHaveLength(0);
    });
  });

  describe("Vulnerability Policy Gate Enforcement", () => {
    it("rejects unapproved Critical and High findings", () => {
      const sbomWithVulns = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        vulnerabilities: [
          {
            id: "CVE-2026-9999",
            ratings: [{ severity: "critical", score: 9.8 }],
            affects: [{ ref: "pkg:npm/vulnerable-pkg@1.0.0" }],
          },
          {
            id: "CVE-2026-8888",
            ratings: [{ severity: "high", score: 7.5 }],
            affects: [{ ref: "pkg:npm/vulnerable-pkg-2@1.0.0" }],
          },
          {
            id: "CVE-2026-1111",
            ratings: [{ severity: "low", score: 2.1 }],
            affects: [{ ref: "pkg:npm/low-pkg@1.0.0" }],
          },
        ],
      };

      const violations = verifyVulnerabilityPolicy(sbomWithVulns);
      expect(violations.some((v) => v.rule === "UNAPPROVED_CRITICAL_VULNERABILITY")).toBe(true);
      expect(violations.some((v) => v.rule === "UNAPPROVED_HIGH_VULNERABILITY")).toBe(true);
      expect(violations.some((v) => v.rule.includes("LOW"))).toBe(false);
    });

    it("accepts Critical and High findings when approved with reviewed exceptions", () => {
      const sbomWithVulns = {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        vulnerabilities: [
          {
            id: "CVE-2026-9999",
            ratings: [{ severity: "critical", score: 9.8 }],
            affects: [{ ref: "pkg:npm/vulnerable-pkg@1.0.0" }],
            analysis: {
              state: "not_affected",
              justification: "Vulnerable code path is not invoked in production CLI runtime.",
              reviewer: "sec-eng-lead",
              approvedBy: "sec-eng-lead",
              approvedAt: "2026-08-25T00:00:00Z",
            },
          },
        ],
      };

      const violations = verifyVulnerabilityPolicy(sbomWithVulns);
      expect(violations).toHaveLength(0);
    });
  });

  describe("Root and Artifact Legal Files Verification", () => {
    it("confirms root LICENSE, NOTICE, and SECURITY.md exist and are non-empty", () => {
      expect(fs.existsSync(path.join(rootDir, "LICENSE"))).toBe(true);
      expect(fs.readFileSync(path.join(rootDir, "LICENSE"), "utf8")).toContain("Apache License");
      expect(fs.existsSync(path.join(rootDir, "NOTICE"))).toBe(true);
      expect(fs.readFileSync(path.join(rootDir, "NOTICE"), "utf8")).toContain("Resin");
      expect(fs.existsSync(path.join(rootDir, "SECURITY.md"))).toBe(true);
      expect(fs.readFileSync(path.join(rootDir, "SECURITY.md"), "utf8")).toContain(
        "Reporting a Vulnerability",
      );
    });
  });

  describe("Release Channel Metadata", () => {
    it("generates valid channel metadata with stable and rollback definitions", () => {
      const channels = generateChannelMetadata("test-manifest-sha256", { testOnly: true });

      expect(channels.schemaVersion).toBe("2.0.0");
      expect(channels.channels.stable.version).toBe(RELEASE_VERSION);
      expect(channels.channels.stable.manifestDigest).toBe("test-manifest-sha256");
      expect(channels.minSupportedVersion).toBe("0.1.0");
      expect(channels.rollbackReferences.targetVersion).toBe("0.1.0");
    });

    it("verifies valid channels.json in release directory", () => {
      const channels = generateChannelMetadata("test-manifest-sha256", { testOnly: true });
      fs.writeFileSync(
        path.join(tempReleaseDir, "channels.json"),
        JSON.stringify(channels, null, 2),
      );

      const signature = channels.signatures[0];
      const violations = verifyChannelMetadata(tempReleaseDir, {
        trustedKeys: {
          [signature.keyId]: {
            keyId: signature.keyId,
            publicKeyPem: signature.publicKeyPem,
            publicKeyHex: signature.publicKeyHex,
            publicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("Documentation Completeness & Cross-Link Verification", () => {
    it("verifies all user, operator, security, release, and architecture docs have 0 broken links", () => {
      const violations = verifyDocumentation(rootDir);

      if (violations.length > 0) {
        console.error("Documentation link violations:", violations);
      }

      expect(violations).toHaveLength(0);
    });
  });

  describe("Full End-to-End Package & Verify Cycle", () => {
    it("packages and validates full release in isolated target directory", () => {
      const result = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
        testOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.packagesCount).toBe(loadBoundaryManifest(rootDir).publicReleasePackages.length);
      expect(result.assetsCount).toBe(PLATFORMS.length);

      const verifyResult = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
        allowTestEvidence: true,
        trustedKeys: result.trustedKeys,
        expectedCommitSha: result.releaseIdentity.commitSha,
      });

      if (!verifyResult.valid) {
        console.error("Release verification failed:", verifyResult.violations);
      }

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.violations).toHaveLength(0);
      expect(verifyResult.stats.platformsCount).toBe(5);
      expect(verifyResult.stats.packagesCount).toBe(
        loadBoundaryManifest(rootDir).publicReleasePackages.length,
      );
    }, 60_000);
  });

  describe("Release Trust, Key Separation, Expiry & Signed Freeze/Rollback Plans", () => {
    it("enforces production/test key separation and rejects test keys in production", () => {
      const testKey = createTestReleaseSigningKey();
      expect(isTestOnlyKey(testKey.keyId)).toBe(true);
      expect(() => assertProductionKey(testKey)).toThrow(/Test-only release key/);

      expect(() => {
        createReleaseSigningKey(
          {
            keyId: "test-only-abc",
            privateKeyPkcs8Pem: testKey.publicKeyPem, // just placeholder
            publicKeyPem: testKey.publicKeyPem,
          },
          { allowTestOnly: false },
        );
      }).toThrow(/Test-only release signing keys cannot be used/);

      expect(() => {
        loadTrustedReleaseKeysFromEnv(
          {
            RESIN_RELEASE_KEY_ID: "test-only-root",
            RESIN_RELEASE_PUBLIC_KEY_PEM: testKey.publicKeyPem,
          },
          { allowTestOnly: false },
        );
      }).toThrow(/Test-only release key/);
    });

    it("rejects revoked signing keys", () => {
      for (const revokedId of REVOKED_RELEASE_KEY_IDS) {
        expect(() => {
          createReleaseSigningKey({
            keyId: revokedId,
            privateKeyPkcs8Pem: "mock",
            publicKeyPem: "mock",
          });
        }).toThrow(/revoked/i);
      }
    });

    it("detects manifest expiry accurately", () => {
      const validManifest = {
        version: "1.0.0",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      expect(isManifestExpired(validManifest).expired).toBe(false);
      expect(verifyReleaseManifestExpiry(validManifest).valid).toBe(true);

      const expiredManifest = {
        version: "1.0.0",
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
      };
      expect(isManifestExpired(expiredManifest).expired).toBe(true);
      expect(verifyReleaseManifestExpiry(expiredManifest).valid).toBe(false);
    });

    it("creates and verifies signed freeze notices and rollback plans", () => {
      const key = createTestReleaseSigningKey();
      const trustedKeys = trustedKeysFromSigningKey(key);

      const freezeNotice = createSignedFreezeNotice(
        {
          targetVersion: "1.0.0",
          targetCommitSha: "a".repeat(40),
          reason: "Post-promotion smoke verification failed",
          rollbackTargetVersion: "0.1.0",
        },
        key,
      );

      expect(freezeNotice.type).toBe("RELEASE_FREEZE");
      expect(freezeNotice.action).toBe("FREEZE_AND_DEPRECATE");
      expect(freezeNotice.rebuildAllowed).toBe(false);
      const freezeVerify = verifySignedFreezeNotice(freezeNotice, trustedKeys);
      expect(freezeVerify.valid).toBe(true);

      const rollbackPlan = createSignedRollbackPlan(
        {
          failedVersion: "1.0.0",
          targetRollbackVersion: "0.1.0",
          reason: "Automated smoke failure rollback",
        },
        key,
      );

      expect(rollbackPlan.type).toBe("RELEASE_ROLLBACK");
      expect(rollbackPlan.action).toBe("RESTORE_PRIOR_IMMUTABLE_DIGEST");
      expect(rollbackPlan.rebuildAllowed).toBe(false);
      const rollbackVerify = verifySignedRollbackPlan(rollbackPlan, trustedKeys);
      expect(rollbackVerify.valid).toBe(true);
    });

    it("enforces independent approval requirements for production promotion", () => {
      const plan = createUploadPlan({ releaseDir: tempReleaseDir });

      // Rejects promotion without verification receipt
      const noReceipt = validatePromotionApproval({ uploadPlan: plan });
      expect(noReceipt.valid).toBe(false);
      expect(noReceipt.reason).toBe("missing_or_unverified_receipt");

      // Rejects unverified receipt
      const unverifiedReceipt = {
        phase: "verify-public",
        status: "failed",
        verifiedObjects: [],
      };
      const unverifiedResult = validatePromotionApproval({
        uploadPlan: plan,
        verificationReceipt: unverifiedReceipt,
      });
      expect(unverifiedResult.valid).toBe(false);
      expect(unverifiedResult.reason).toBe("missing_or_unverified_receipt");

      // Rejects receipt with missing objects or digest mismatch
      const incompleteReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: [
          {
            key: plan.immutableUploads[0].key,
            sha256: "0".repeat(64),
            sizeBytes: 100,
            verified: true,
          },
        ],
      };
      const incompleteResult = validatePromotionApproval({
        uploadPlan: plan,
        verificationReceipt: incompleteReceipt,
      });
      expect(incompleteResult.valid).toBe(false);
      expect(incompleteResult.reason).toBe("verification_receipt_incomplete");

      // Accepts fully verified receipt matching upload plan
      const validReceipt = {
        phase: "verify-public",
        status: "verified",
        verifiedObjects: plan.immutableUploads.map((item) => ({
          key: item.key,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
          verified: true,
        })),
      };
      const validResult = validatePromotionApproval({
        uploadPlan: plan,
        verificationReceipt: validReceipt,
      });
      expect(validResult.valid).toBe(true);
      expect(validResult.receipt).toBeDefined();
    });
    it("loads production-like runtime-generated Ed25519 signing key pair from environment", () => {
      const generated = crypto.generateKeyPairSync("ed25519");
      const privateKeyPkcs8Pem = generated.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
      const keyId = "resin-release-2026-prod-1";

      const key = loadReleaseSigningKeyFromEnv({
        RESIN_RELEASE_KEY_ID: keyId,
        RESIN_RELEASE_PRIVATE_KEY_PEM: privateKeyPkcs8Pem,
        RESIN_RELEASE_PUBLIC_KEY_PEM: publicKeyPem,
      });

      expect(key.keyId).toBe(keyId);
      expect(key.algorithm).toBe("Ed25519");
      expect(key.trustDomain).toBe("production");
      expect(key.isTestOnly).toBe(false);
      expect(key.publicKeyHex).toEqual(expect.any(String));
      expect(key.publicKeyHex).toHaveLength(64);
      expect(key.publicKeyFingerprintSha256).toEqual(expect.any(String));
      expect(key.publicKeyFingerprintSha256).toHaveLength(64);

      const payload = { version: "1.0.0", timestamp: Date.now() };
      const signature = signReleasePayload(payload, key);
      const trustedKeys = {
        [key.keyId]: {
          keyId: key.keyId,
          algorithm: key.algorithm,
          publicKeyPem: key.publicKeyPem,
          publicKeyHex: key.publicKeyHex,
          publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
        },
      };
      const verifyResult = verifyReleasePayloadSignature(payload, signature, trustedKeys);
      expect(verifyResult.valid).toBe(true);
    });

    it("rejects mismatched private and public key pairs during signing key construction and env loading", () => {
      const pairA = crypto.generateKeyPairSync("ed25519");
      const pairB = crypto.generateKeyPairSync("ed25519");

      const privPemA = pairA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const pubPemB = pairB.publicKey.export({ type: "spki", format: "pem" }).toString();

      expect(() =>
        createReleaseSigningKey({
          keyId: "resin-prod-mismatch-1",
          privateKeyPkcs8Pem: privPemA,
          publicKeyPem: pubPemB,
        }),
      ).toThrow(/does not match the configured private key pair/);

      expect(() =>
        loadReleaseSigningKeyFromEnv({
          RESIN_RELEASE_KEY_ID: "resin-prod-mismatch-2",
          RESIN_RELEASE_PRIVATE_KEY_PEM: privPemA,
          RESIN_RELEASE_PUBLIC_KEY_PEM: pubPemB,
        }),
      ).toThrow(/does not match the configured private key pair/);
    });

    it("rejects revoked and test-only key IDs when loading signing keys and trusted roots from environment", () => {
      const validPair = crypto.generateKeyPairSync("ed25519");
      const privPem = validPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const pubPem = validPair.publicKey.export({ type: "spki", format: "pem" }).toString();

      for (const revokedId of REVOKED_RELEASE_KEY_IDS) {
        expect(() =>
          loadReleaseSigningKeyFromEnv({
            RESIN_RELEASE_KEY_ID: revokedId,
            RESIN_RELEASE_PRIVATE_KEY_PEM: privPem,
            RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem,
          }),
        ).toThrow(/revoked/i);

        expect(() =>
          loadTrustedReleaseKeysFromEnv({
            RESIN_RELEASE_KEY_ID: revokedId,
            RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem,
          }),
        ).toThrow(/revoked/i);
      }

      const testKeyId = "test-only-ephemeral-key";
      expect(() =>
        loadReleaseSigningKeyFromEnv(
          {
            RESIN_RELEASE_KEY_ID: testKeyId,
            RESIN_RELEASE_PRIVATE_KEY_PEM: privPem,
            RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem,
          },
          { allowTestOnly: false },
        ),
      ).toThrow(/Test-only release signing keys cannot be used/);

      expect(() =>
        loadTrustedReleaseKeysFromEnv(
          {
            RESIN_RELEASE_KEY_ID: testKeyId,
            RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem,
          },
          { allowTestOnly: false },
        ),
      ).toThrow(/Test-only release key/);
    });

    it("creates, cryptographically signs, and verifies key revocation notices with tamper rejection", () => {
      const signerPair = crypto.generateKeyPairSync("ed25519");
      const key = createReleaseSigningKey({
        keyId: "resin-active-signer-2026",
        privateKeyPkcs8Pem: signerPair.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        publicKeyPem: signerPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });

      const trustedKeys = {
        [key.keyId]: {
          keyId: key.keyId,
          algorithm: "Ed25519",
          publicKeyPem: key.publicKeyPem,
          publicKeyHex: key.publicKeyHex,
          publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
        },
      };
      const notice = createSignedRevocationNotice(
        {
          keyId: "resin-retired-key-2025",
          reason: "Scheduled lifecycle retirement",
          supersededByKeyId: key.keyId,
        },
        key,
      );

      expect(notice.type).toBe("KEY_REVOCATION");
      expect(notice.keyId).toBe("resin-retired-key-2025");
      expect(notice.supersededByKeyId).toBe(key.keyId);
      expect(notice.signatures).toHaveLength(1);

      const verifyValid = verifySignedRevocationNotice(notice, trustedKeys);
      expect(verifyValid.valid).toBe(true);

      // Tamper with payload field
      const tamperedPayloadNotice = {
        ...notice,
        reason: "Compromised instead of scheduled retirement",
      };
      const verifyTamperedPayload = verifySignedRevocationNotice(
        tamperedPayloadNotice,
        trustedKeys,
      );
      expect(verifyTamperedPayload.valid).toBe(false);

      // Tamper with revoked keyId
      const tamperedKeyIdNotice = {
        ...notice,
        keyId: "resin-active-signer-2026",
      };
      const verifyTamperedKeyId = verifySignedRevocationNotice(tamperedKeyIdNotice, trustedKeys);
      expect(verifyTamperedKeyId.valid).toBe(false);

      // Tamper with signature hex
      const badSig = notice.signatures[0].signatureHex.replace(/[0-9a-f]/, (c) =>
        c === "0" ? "1" : "0",
      );
      const tamperedSigNotice = {
        ...notice,
        signatures: [{ ...notice.signatures[0], signatureHex: badSig }],
      };
      const verifyTamperedSig = verifySignedRevocationNotice(tamperedSigNotice, trustedKeys);
      expect(verifyTamperedSig.valid).toBe(false);

      // Untrusted signer
      const otherPair = crypto.generateKeyPairSync("ed25519");
      const otherKey = createReleaseSigningKey({
        keyId: "resin-untrusted-signer",
        privateKeyPkcs8Pem: otherPair.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        publicKeyPem: otherPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });
      const untrustedNotice = createSignedRevocationNotice(
        { keyId: "resin-retired-key-2025" },
        otherKey,
      );
      const verifyUntrusted = verifySignedRevocationNotice(untrustedNotice, trustedKeys);
      expect(verifyUntrusted.valid).toBe(false);
    });

    it("loads active-first bridge roots from additional trusted keys JSON and supports dual-root rotation verification", () => {
      const pairA = crypto.generateKeyPairSync("ed25519");
      const pairB = crypto.generateKeyPairSync("ed25519");

      const keyA = createReleaseSigningKey({
        keyId: "resin-prod-root-2026a",
        privateKeyPkcs8Pem: pairA.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: pairA.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });

      const keyB = createReleaseSigningKey({
        keyId: "resin-prod-root-2026b",
        privateKeyPkcs8Pem: pairB.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: pairB.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });

      const env = {
        RESIN_RELEASE_KEY_ID: keyA.keyId,
        RESIN_RELEASE_PUBLIC_KEY_PEM: keyA.publicKeyPem,
        RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
          { keyId: keyB.keyId, publicKeyPem: keyB.publicKeyPem },
        ]),
      };

      const trusted = loadTrustedReleaseKeysFromEnv(env);
      const keyIds = Object.keys(trusted);
      expect(keyIds).toEqual([keyA.keyId, keyB.keyId]);
      expect(trusted[keyA.keyId].publicKeyHex).toBe(keyA.publicKeyHex);
      expect(trusted[keyB.keyId].publicKeyHex).toBe(keyB.publicKeyHex);
      expect(trusted[keyA.keyId].trustDomain).toBe("production");
      expect(trusted[keyB.keyId].trustDomain).toBe("production");

      // Dual-root rotation verification: A signs payload, verifies under bridge trust
      const payloadA = { release: "1.0.0", builder: "rootA" };
      const sigA = signReleasePayload(payloadA, keyA);
      const verifyResultA = verifyReleasePayloadSignature(payloadA, sigA, trusted);
      expect(verifyResultA.valid).toBe(true);

      // B signs payload, verifies under bridge trust
      const payloadB = { release: "1.0.0", builder: "rootB" };
      const sigB = signReleasePayload(payloadB, keyB);
      const verifyResultB = verifyReleasePayloadSignature(payloadB, sigB, trusted);
      expect(verifyResultB.valid).toBe(true);
    });

    it("rejects malformed, duplicate, test-only, or revoked additional trusted keys in JSON environment config", () => {
      const pairA = crypto.generateKeyPairSync("ed25519");
      const pairB = crypto.generateKeyPairSync("ed25519");
      const pairC = crypto.generateKeyPairSync("ed25519");
      const rsaPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

      const pubPemA = pairA.publicKey.export({ type: "spki", format: "pem" }).toString();
      const pubPemB = pairB.publicKey.export({ type: "spki", format: "pem" }).toString();
      const pubPemC = pairC.publicKey.export({ type: "spki", format: "pem" }).toString();
      const rsaPubPem = rsaPair.publicKey.export({ type: "spki", format: "pem" }).toString();

      const baseEnv = {
        RESIN_RELEASE_KEY_ID: "resin-prod-root-active",
        RESIN_RELEASE_PUBLIC_KEY_PEM: pubPemA,
      };

      // Invalid JSON
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: "{not valid json",
        }),
      ).toThrow();

      // Non-array JSON
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify({
            keyId: "extra",
            publicKeyPem: pubPemB,
          }),
        }),
      ).toThrow();

      // Record missing publicKeyPem
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([{ keyId: "extra" }]),
        }),
      ).toThrow();

      // Record missing keyId
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([{ publicKeyPem: pubPemB }]),
        }),
      ).toThrow();

      // Malformed PEM
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "extra", publicKeyPem: "not-a-pem" },
          ]),
        }),
      ).toThrow();

      // Non-Ed25519 key (RSA)
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "extra", publicKeyPem: rsaPubPem },
          ]),
        }),
      ).toThrow(/Ed25519/i);

      // Revoked key in additional keys
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "resin-release-v1", publicKeyPem: pubPemB },
          ]),
        }),
      ).toThrow(/revoked/i);

      // Test-only key in additional keys for production
      expect(() =>
        loadTrustedReleaseKeysFromEnv(
          {
            ...baseEnv,
            RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
              { keyId: "test-only-additional-root", publicKeyPem: pubPemB },
            ]),
          },
          { allowTestOnly: false },
        ),
      ).toThrow(/test-only/i);

      // Duplicate key ID with active key
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "resin-prod-root-active", publicKeyPem: pubPemB },
          ]),
        }),
      ).toThrow(/duplicate/i);

      // Duplicate key ID within additional keys
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "resin-prod-root-dup", publicKeyPem: pubPemB },
            { keyId: "resin-prod-root-dup", publicKeyPem: pubPemC },
          ]),
        }),
      ).toThrow(/duplicate/i);

      // Duplicate public key material with different keyId
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          ...baseEnv,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "resin-prod-root-other-id", publicKeyPem: pubPemA },
          ]),
        }),
      ).toThrow(/duplicate/i);
    });

    it("rejects digit-only numeric key IDs in loadTrustedReleaseKeysFromEnv", () => {
      const pair10 = crypto.generateKeyPairSync("ed25519");
      const pair2 = crypto.generateKeyPairSync("ed25519");
      const pubPem10 = pair10.publicKey.export({ type: "spki", format: "pem" }).toString();
      const pubPem2 = pair2.publicKey.export({ type: "spki", format: "pem" }).toString();

      // Active digit-only key ID "10" is rejected
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          RESIN_RELEASE_KEY_ID: "10",
          RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem10,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "resin-prod-root-2", publicKeyPem: pubPem2 },
          ]),
        }),
      ).toThrow(/cannot be digit-only/i);

      // Additional digit-only key ID "10" is rejected
      expect(() =>
        loadTrustedReleaseKeysFromEnv({
          RESIN_RELEASE_KEY_ID: "resin-prod-root-2",
          RESIN_RELEASE_PUBLIC_KEY_PEM: pubPem2,
          RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON: JSON.stringify([
            { keyId: "10", publicKeyPem: pubPem10 },
          ]),
        }),
      ).toThrow(/cannot be digit-only/i);
    });

    it("rejects key-ID spoofing where payload is signed by untrusted key claiming a trusted keyId", () => {
      const pairA = crypto.generateKeyPairSync("ed25519");
      const untrustedPair = crypto.generateKeyPairSync("ed25519");

      const trustedKey = createReleaseSigningKey({
        keyId: "resin-prod-root-2026a",
        privateKeyPkcs8Pem: pairA.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: pairA.publicKey.export({ type: "spki", format: "pem" }).toString(),
      });

      const payload = { version: "1.0.0", action: "DEPLOY" };
      const canonical = canonicalJson(payload);
      const untrustedSig = crypto
        .sign(null, Buffer.from(canonical, "utf8"), untrustedPair.privateKey)
        .toString("hex");

      // Spoofed keyId with trusted publicKeyHex
      const spoofedSigEntry1 = {
        keyId: trustedKey.keyId,
        algorithm: "Ed25519",
        publicKeyHex: trustedKey.publicKeyHex,
        signatureHex: untrustedSig,
      };
      const result1 = verifyReleasePayloadSignature(payload, [spoofedSigEntry1], [trustedKey]);
      expect(result1.valid).toBe(false);

      // Spoofed keyId with untrusted publicKeyHex
      const untrustedHex = untrustedPair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex");
      const spoofedSigEntry2 = {
        keyId: trustedKey.keyId,
        algorithm: "Ed25519",
        publicKeyHex: untrustedHex,
        signatureHex: untrustedSig,
      };
      const result2 = verifyReleasePayloadSignature(payload, [spoofedSigEntry2], [trustedKey]);
      expect(result2.valid).toBe(false);
    });
    it("validates candidate upload plan targets version-qualified paths and immutable cache-control", () => {
      const plan = createUploadPlan({ releaseDir: tempReleaseDir });
      expect(plan).toBeDefined();
      expect(plan.version).toBe(RELEASE_VERSION);
      expect(plan.immutableUploads.length).toBeGreaterThanOrEqual(11);

      for (const upload of plan.immutableUploads) {
        expect(upload.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
        expect(upload.isImmutable).toBe(true);
        expect(upload.key).toMatch(/^releases\/v1\//);
      }

      expect(plan.mutableChannelUpload).toBeDefined();
      expect(plan.mutableChannelUpload.cacheControl).toBe(CHANNELS_CACHE_CONTROL);
      expect(plan.mutableChannelUpload.key).toBe("releases/v1/channels.json");
    });

    it("generates freeze and deprecation plan on failed post-promotion smoke", async () => {
      const key = createTestReleaseSigningKey();
      const trustedKeys = trustedKeysFromSigningKey(key);
      const smokeReceiptDir = path.join(tempReleaseDir, "smoke-failed-receipts");
      fs.mkdirSync(smokeReceiptDir, { recursive: true });

      const mockFailingFetch = async (url) => {
        if (url.includes("/channels.json")) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => Buffer.from(JSON.stringify({ channels: { stable: "1.0.0" } })),
          };
        }
        return { ok: false, status: 500 };
      };

      const smokeResult = await recordSmoke({
        testOnly: true,
        trustedKeys,
        fetch: mockFailingFetch,
        baseUrl: "https://dist.resin.sh",
        version: "1.0.0",
        outputDir: smokeReceiptDir,
        receiptDir: smokeReceiptDir,
      });

      expect(smokeResult.success).toBe(false);
      expect(smokeResult.smokeEvidence.status).toBe("FAILED");
      expect(fs.existsSync(path.join(smokeReceiptDir, "public-release-smoke.json"))).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "public-release-smoke.json"))).toBe(false);
      const freezeNotice = createSignedFreezeNotice(
        {
          frozenVersion: "1.0.0",
          reason: "Automated smoke failure trigger freeze",
          rebuildAllowed: false,
          action: "FREEZE_AND_DEPRECATE",
        },
        key,
      );
      expect(freezeNotice.action).toBe("FREEZE_AND_DEPRECATE");
      expect(freezeNotice.rebuildAllowed).toBe(false);
      const verifyFreeze = verifySignedFreezeNotice(freezeNotice, trustedKeys);
      expect(verifyFreeze.valid).toBe(true);

      const rollbackPlan = createSignedRollbackPlan(
        {
          failedVersion: "1.0.0",
          targetRollbackVersion: "0.1.0",
          reason: "Automated smoke failure rollback",
          rebuildAllowed: false,
        },
        key,
      );
      expect(rollbackPlan.targetRollbackVersion).toBe("0.1.0");
      expect(rollbackPlan.rebuildAllowed).toBe(false);
      const verifyRollback = verifySignedRollbackPlan(rollbackPlan, trustedKeys);
      expect(verifyRollback.valid).toBe(true);
    });
  });
  describe("Artifact-Level Verification & Canonical Boundary Compliance", () => {
    const boundary = loadBoundaryManifest(rootDir);

    it("loads authoritative boundary manifest and identifies public release packages", () => {
      expect(boundary).toBeDefined();
      expect(Array.isArray(boundary.publicReleasePackages)).toBe(true);
      expect(boundary.publicReleasePackages).toContain("resin");
      expect(boundary.publicReleasePackages).toContain("@resin/runtime");
      expect(boundary.publicReleasePackages).toContain("@resin/gateway");
      expect(boundary.publicReleasePackages).toContain("@resin/observer");
      expect(boundary.publicReleasePackages).not.toContain("@resin/cloud");
      expect(boundary.publicReleasePackages).not.toContain("@resin/web");
      expect(boundary.publicReleasePackages).not.toContain("@resin/cloud-contracts");

      expect(boundary.privatePackages).toContain("@resin/cloud");
      expect(boundary.privatePackages).toContain("@resin/web");
      expect(boundary.privatePackages).toContain("@resin/cloud-contracts");

      expect(boundary.cloudOnlyPaths).toContain("apps/cloud");
      expect(boundary.cloudOnlyPaths).toContain("apps/web");
      expect(boundary.cloudOnlyPaths).toContain("packages/cloud-contracts");
      expect(boundary.cloudOnlyPaths).toContain("infra/serverless");
    });

    it("verifyPackageDigests passes for valid public release packages and rejects forbidden or missing packages", () => {
      const validPackages = {};
      for (const name of boundary.publicReleasePackages) {
        validPackages[name] = {
          version: "1.0.3",
          packageSha256: "a".repeat(64),
        };
      }

      // Valid public packages pass
      const validManifest = { packages: validPackages };
      expect(verifyPackageDigests(validManifest, { boundary })).toEqual([]);

      // Injected forbidden private package fails with FORBIDDEN_PACKAGE_IN_MANIFEST
      const manifestWithCloud = {
        packages: {
          ...validPackages,
          "@resin/cloud": { version: "1.0.3", packageSha256: "b".repeat(64) },
        },
      };
      const cloudViolations = verifyPackageDigests(manifestWithCloud, { boundary });
      expect(cloudViolations.some((v) => v.rule === "FORBIDDEN_PACKAGE_IN_MANIFEST")).toBe(true);

      // Injected unallowlisted package fails with UNALLOWLISTED_PACKAGE_IN_MANIFEST
      const manifestWithExtra = {
        packages: {
          ...validPackages,
          "unexpected-third-party": { version: "1.0.0", packageSha256: "c".repeat(64) },
        },
      };
      const extraViolations = verifyPackageDigests(manifestWithExtra, { boundary });
      expect(extraViolations.some((v) => v.rule === "UNALLOWLISTED_PACKAGE_IN_MANIFEST")).toBe(
        true,
      );

      // Missing public release package fails with MISSING_PACKAGE_IN_MANIFEST
      const missingPackages = { ...validPackages };
      delete missingPackages["@resin/runtime"];
      const missingManifest = { packages: missingPackages };
      const missingViolations = verifyPackageDigests(missingManifest, { boundary });
      expect(missingViolations.some((v) => v.rule === "MISSING_PACKAGE_IN_MANIFEST")).toBe(true);
    });

    it("verifySbom detects and rejects forbidden private/cloud components and flags missing public components", () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-boundary-test-"));
      try {
        const validComponents = boundary.publicReleasePackages.map((name) => ({
          name,
          version: "1.0.3",
          purl: `pkg:npm/${name.replace("@", "%40")}@1.0.3`,
          licenses: [{ license: { id: "Apache-2.0" } }],
        }));

        const validSbom = {
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          serialNumber: "urn:uuid:12345678-1234-1234-1234-123456789abc",
          metadata: {
            timestamp: new Date().toISOString(),
            properties: [
              { name: "trustDomain", value: "test-only" },
              { name: "resin:test-only", value: "true" },
            ],
          },
          components: validComponents,
        };

        fs.writeFileSync(path.join(testDir, "sbom.json"), JSON.stringify(validSbom, null, 2));
        const validViolations = verifySbom(testDir, { boundary, allowTestEvidence: true });
        expect(validViolations).toEqual([]);

        // Injected forbidden cloud component in SBOM fails with FORBIDDEN_SBOM_COMPONENT
        const sbomWithCloud = {
          ...validSbom,
          components: [
            ...validComponents,
            {
              name: "@resin/cloud",
              version: "1.0.3",
              purl: "pkg:npm/%40resin/cloud@1.0.3",
              licenses: [{ license: { id: "Apache-2.0" } }],
            },
          ],
        };
        fs.writeFileSync(path.join(testDir, "sbom.json"), JSON.stringify(sbomWithCloud, null, 2));
        const cloudSbomViolations = verifySbom(testDir, { boundary, allowTestEvidence: true });
        expect(cloudSbomViolations.some((v) => v.rule === "FORBIDDEN_SBOM_COMPONENT")).toBe(true);

        // Missing public release component in SBOM fails with MISSING_SBOM_COMPONENT
        const sbomMissingPkg = {
          ...validSbom,
          components: validComponents.filter((c) => c.name !== "@resin/crypto"),
        };
        fs.writeFileSync(path.join(testDir, "sbom.json"), JSON.stringify(sbomMissingPkg, null, 2));
        const missingSbomViolations = verifySbom(testDir, { boundary, allowTestEvidence: true });
        expect(missingSbomViolations.some((v) => v.rule === "MISSING_SBOM_COMPONENT")).toBe(true);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("verifyTarballEntries enforces exact allowlisted paths, legal files, and expected binaries", () => {
      const validEntries = [
        {
          name: "resin/package.json",
          content: Buffer.from(JSON.stringify({ name: "resin", version: "1.0.3" })),
          size: 40,
        },
        {
          name: "resin/LICENSE",
          content: Buffer.from("Apache License\nVersion 2.0, January 2004\n"),
          size: 40,
        },
        {
          name: "resin/NOTICE",
          content: Buffer.from("Resin\nCopyright 2026\n"),
          size: 20,
        },
        {
          name: "resin/README.md",
          content: Buffer.from("# Resin\n"),
          size: 10,
        },
        {
          name: "resin/SECURITY.md",
          content: Buffer.from("# Security Policy\n"),
          size: 20,
        },
        {
          name: "resin/bin/resin",
          content: Buffer.from("#!/usr/bin/env node\n"),
          size: 20,
        },
        {
          name: "resin/bin/resin-daemon",
          content: Buffer.from("#!/usr/bin/env node\n"),
          size: 20,
        },
        {
          name: "resin/apps/cli/dist/bin/cli.js",
          content: Buffer.from("export function main() {}\n"),
          size: 30,
        },
        {
          name: "resin/packages/runtime/dist/index.js",
          content: Buffer.from("export const runtime = 1;\n"),
          size: 30,
        },
      ];

      // Valid entries pass with 0 violations
      const validViolations = verifyTarballEntries(validEntries, "test.tar.gz", { boundary });
      expect(validViolations).toEqual([]);

      // Outside canonical root fails with UNALLOWLISTED_TARBALL_PATH
      const outsideRootEntries = [
        ...validEntries,
        { name: "outside/payload.js", content: Buffer.from(""), size: 0 },
      ];
      const outsideViolations = verifyTarballEntries(outsideRootEntries, "test.tar.gz", {
        boundary,
      });
      expect(outsideViolations.some((v) => v.rule === "UNALLOWLISTED_TARBALL_PATH")).toBe(true);

      // Unexpected top-level file fails with UNALLOWLISTED_TARBALL_PATH
      const unexpectedTopEntries = [
        ...validEntries,
        { name: "resin/unexpected-secret.json", content: Buffer.from("{}"), size: 2 },
      ];
      const unexpViolations = verifyTarballEntries(unexpectedTopEntries, "test.tar.gz", {
        boundary,
      });
      expect(unexpViolations.some((v) => v.rule === "UNALLOWLISTED_TARBALL_PATH")).toBe(true);

      // Unexpected binary in resin/bin/ fails with UNEXPECTED_BINARY
      const unexpectedBinEntries = [
        ...validEntries,
        { name: "resin/bin/cloud-admin", content: Buffer.from("#!/usr/bin/env node\n"), size: 20 },
      ];
      const binViolations = verifyTarballEntries(unexpectedBinEntries, "test.tar.gz", { boundary });
      expect(binViolations.some((v) => v.rule === "UNEXPECTED_BINARY")).toBe(true);

      // Obsolete resin-mcp binary in resin/bin/ fails with UNEXPECTED_BINARY
      const mcpBinEntries = [
        ...validEntries,
        { name: "resin/bin/resin-mcp", content: Buffer.from("#!/usr/bin/env node\n"), size: 20 },
      ];
      const mcpBinViolations = verifyTarballEntries(mcpBinEntries, "test.tar.gz", { boundary });
      expect(mcpBinViolations.some((v) => v.rule === "UNEXPECTED_BINARY")).toBe(true);
      expect(ALLOWED_RELEASE_BINARIES).not.toContain("resin/bin/resin-mcp");
      expect(ALLOWED_RELEASE_BINARIES).not.toContain("resin/bin/resin-mcp.cmd");
      expect(ALLOWED_RELEASE_BINARIES).not.toContain("resin/bin/resin-mcp.ps1");

      // Missing legal file fails with MISSING_LEGAL_FILE
      const missingLicense = validEntries.filter((e) => e.name !== "resin/LICENSE");
      const missingLicViolations = verifyTarballEntries(missingLicense, "test.tar.gz", {
        boundary,
      });
      expect(missingLicViolations.some((v) => v.rule === "MISSING_LEGAL_FILE")).toBe(true);
    });

    it("verifyTarballEntries rejects injected forbidden cloud/web/serverless/map paths", () => {
      const baseValidEntries = [
        {
          name: "resin/package.json",
          content: Buffer.from(JSON.stringify({ name: "resin", version: "1.0.3" })),
          size: 40,
        },
        {
          name: "resin/LICENSE",
          content: Buffer.from("Apache License\nVersion 2.0, January 2004\n"),
          size: 40,
        },
        {
          name: "resin/NOTICE",
          content: Buffer.from("Resin\nCopyright 2026\n"),
          size: 20,
        },
        {
          name: "resin/bin/resin",
          content: Buffer.from("#!/usr/bin/env node\n"),
          size: 20,
        },
      ];

      const forbiddenTestPaths = [
        "resin/apps/cloud/dist/index.js",
        "resin/apps/web/dist/index.js",
        "resin/packages/cloud-contracts/dist/index.js",
        "resin/infra/serverless/template.yml",
        "resin/infra/aws/main.tf",
        "resin/.github/workflows/cloud-deploy.yml",
        "resin/apps/cli/dist/bin/cli.js.map",
        "resin/fixtures/private-eval/case.json",
        "resin/apps/gateway/dist/meta/utility-tools.js",
        "resin/apps/gateway/dist/proxy/mock-service.js",
        "resin/.env.production",
      ];

      for (const forbiddenPath of forbiddenTestPaths) {
        const testEntries = [
          ...baseValidEntries,
          { name: forbiddenPath, content: Buffer.from("data"), size: 4 },
        ];
        const violations = verifyTarballEntries(testEntries, "test.tar.gz", { boundary });
        expect(
          violations.some(
            (v) =>
              v.rule === "FORBIDDEN_RELEASE_ARTIFACT" || v.rule === "UNALLOWLISTED_TARBALL_PATH",
          ),
          `Expected violation for forbidden path '${forbiddenPath}'`,
        ).toBe(true);
      }
    });

    it("verifyTarballEntries scans text/code contents and rejects renamed cloud payload identifiers", () => {
      const baseValidEntries = [
        {
          name: "resin/package.json",
          content: Buffer.from(JSON.stringify({ name: "resin", version: "1.0.3" })),
          size: 40,
        },
        {
          name: "resin/LICENSE",
          content: Buffer.from("Apache License\nVersion 2.0, January 2004\n"),
          size: 40,
        },
        {
          name: "resin/NOTICE",
          content: Buffer.from("Resin\nCopyright 2026\n"),
          size: 20,
        },
        {
          name: "resin/bin/resin",
          content: Buffer.from("#!/usr/bin/env node\n"),
          size: 20,
        },
      ];

      // Test each proprietary cloud identifier disguised under an allowlisted path
      const testIdentifiers = [
        "DynamoCandidateRepository",
        "CloudService",
        "createCloudService",
        "CLOUD_CONTRACTS_VERSION",
        "DynamoTable",
        "SqsQueue",
        "SqsRecordHandler",
        "EvolutionOrchestrator",
        "CandidateGenerator",
        "QualificationSandbox",
        "VirtualBroker",
        "StagingFaultInjector",
        "provisionSigningKey",
        "LambdaRunner",
      ];

      for (const identifier of testIdentifiers) {
        const disguisedEntries = [
          ...baseValidEntries,
          {
            name: "resin/packages/runtime/dist/helper.js",
            content: Buffer.from(`// Disguised module\nexport class ${identifier} {}\n`),
            size: 50,
          },
        ];
        const violations = verifyTarballEntries(disguisedEntries, "test.tar.gz", { boundary });
        expect(
          violations.some((v) => v.rule === "PROPRIETARY_CLOUD_IDENTIFIER"),
          `Expected PROPRIETARY_CLOUD_IDENTIFIER violation for '${identifier}' in payload content`,
        ).toBe(true);
      }
    });
  });
});
