#!/usr/bin/env node

/**
 * Resin V1.0.0 Release Verification Tool
 *
 * Validates:
 * 1. Existence and integrity of all release artifacts in `dist/release/v1.0.0/`.
 * 2. SHA-256 digests of all platform tarballs and package definitions against `manifest.json`.
 * 3. Cryptographic validity of Ed25519 signatures in `manifest.json`.
 * 4. CycloneDX 1.5 SBOM format, component coverage, license tags, and digests in `sbom.json`.
 * 5. Release channel metadata, minSupportedVersion, and rollback references in `channels.json`.
 * 6. Markdown documentation cross-links across all docs Markdown files (0 broken links).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  PLATFORMS,
  RELEASE_VERSION,
  canonicalJson,
  extractTarEntries,
  fileSha256,
  isForbiddenReleasePath,
  packageRelease,
} from "./package-release.mjs";
import { loadTrustedReleaseKeysFromEnv, verifyReleasePayloadSignature } from "./release-trust.mjs";

export const REQUIRED_USER_DOCS = [
  "getting-started.md",
  "configuration.md",
  "meta-tools.md",
  "harness-guide.md",
  "doctor-and-repair.md",
  "security-and-privacy.md",
  "troubleshooting.md",
  "limitations.md",
];

export const REQUIRED_OPERATOR_DOCS = [
  "deployment.md",
  "operations.md",
  "runbooks.md",
  "backup-and-restore.md",
  "key-rotation.md",
  "telemetry-and-analytics.md",
];

export const REQUIRED_SECURITY_DOCS = [
  "threat-model.md",
  "privacy-inventory.md",
  "vulnerability-reporting.md",
  "support-policy.md",
];

export const REQUIRED_RELEASE_DOCS = [
  "v1.0.3-release-notes.md",
  "compatibility-matrix.md",
  "release-evidence.md",
  "rollback-procedure.md",
  "signing-trust.md",
];

export const PROPRIETARY_CLOUD_IDENTIFIERS = Object.freeze([
  "@resin/cloud",
  "@resin/web",
  "@resin/cloud-contracts",
  "CloudService",
  "createCloudService",
  "CLOUD_CONTRACTS_VERSION",
  "DynamoCandidateRepository",
  "DynamoLifecycleRepository",
  "DynamoOpportunityRepository",
  "DynamoRolloutRepository",
  "DynamoArtifactsRepository",
  "DynamoAnalytics",
  "DynamoTable",
  "SqsQueue",
  "SqsRecordHandler",
  "V1CalibrationRow",
  "EvolutionOrchestrator",
  "CandidateGenerator",
  "QualificationSandbox",
  "VirtualBroker",
  "StagingFaultInjector",
  "provisionSigningKey",
  "LambdaRunner",
]);

export const ALLOWED_RELEASE_BINARIES = Object.freeze([
  "resin/bin/resin",
  "resin/bin/resin.cmd",
  "resin/bin/resin.ps1",
  "resin/bin/resin-daemon",
  "resin/bin/resin-daemon.cmd",
  "resin/bin/resin-daemon.ps1",
  "resin/bin/resin-mcp",
  "resin/bin/resin-mcp.cmd",
  "resin/bin/resin-mcp.ps1",
  "resin/bin/resin-gateway",
  "resin/bin/resin-gateway.cmd",
  "resin/bin/resin-gateway.ps1",
  "resin/bin/cli.js",
  "resin/bin/daemon.js",
  "resin/bin/gateway.js",
  "resin/bin/resin-linux-x64",
  "resin/bin/resin-linux-arm64",
  "resin/bin/resin-darwin-x64",
  "resin/bin/resin-darwin-arm64",
  "resin/bin/resin-windows-x64.exe",
  "resin/bin/resin-wsl",
]);

export const ALLOWED_TOP_LEVEL_ENTRIES = Object.freeze([
  "resin/package.json",
  "resin/LICENSE",
  "resin/NOTICE",
  "resin/README.md",
  "resin/SECURITY.md",
  "resin/manifest.json",
  "resin/.resin-build-info.json",
  "resin/release-metadata.json",
]);

/**
 * Loads the canonical boundary manifest (resin-boundary.json).
 * @param {string} [rootDir]
 * @returns {object}
 */
export function loadBoundaryManifest(rootDir = process.cwd()) {
  const boundaryPath = path.resolve(rootDir, "resin-boundary.json");
  if (fs.existsSync(boundaryPath)) {
    try {
      const raw = fs.readFileSync(boundaryPath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse boundary manifest at ${boundaryPath}: ${err.message}`);
    }
  }
  return {
    publicPackages: [
      "resin",
      "@resin/gateway",
      "@resin/observer",
      "@resin/runtime",
      "@resin/crypto",
      "@resin/protocol",
      "@resin/contracts",
      "@resin/harness-contracts",
      "@resin/db",
      "@resin/adapter-claude-code",
      "@resin/adapter-codex",
      "@resin/adapter-omp",
    ],
    privatePackages: ["@resin/cloud", "@resin/web", "@resin/cloud-contracts", "@resin/e2e"],
    publicReleasePackages: [
      "resin",
      "@resin/gateway",
      "@resin/observer",
      "@resin/runtime",
      "@resin/crypto",
      "@resin/protocol",
      "@resin/contracts",
      "@resin/harness-contracts",
      "@resin/db",
      "@resin/adapter-claude-code",
      "@resin/adapter-codex",
      "@resin/adapter-omp",
    ],
    cloudOnlyPaths: [
      "apps/cloud",
      "apps/web",
      "packages/cloud-contracts",
      "infra/aws",
      "infra/serverless",
      "deploy",
      "aws",
    ],
    publicDocumentationPaths: [
      "docs",
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "LICENSE",
      "NOTICE",
    ],
    publicTestFixturePaths: ["fixtures/test-fixtures"],
  };
}

/**
 * Tests whether a relative path inside a release artifact is forbidden.
 * @param {string} entryPath
 * @param {object} [boundary]
 * @returns {boolean}
 */
export function isForbiddenTarballPath(entryPath, boundary = null) {
  if (!entryPath || typeof entryPath !== "string") return false;
  const normalized = entryPath.replace(/\\/g, "/");

  if (typeof isForbiddenReleasePath === "function" && isForbiddenReleasePath(normalized)) {
    return true;
  }

  if (/\.(?:map|js\.map|ts\.map|d\.ts\.map)$/i.test(normalized)) {
    return true;
  }

  if (/(?:\.github|\/workflows|cloud-deploy)/i.test(normalized)) {
    return true;
  }

  if (/(?:^\.env|\/\.env|\.aws|\/credentials|\.resin\/secrets)/i.test(normalized)) {
    return true;
  }

  if (/(?:fixtures\/(?!test-fixtures)|eval\/|prompts\/|__tests__|__mocks__)/i.test(normalized)) {
    return true;
  }

  if (/\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts|map)$/i.test(normalized)) {
    return true;
  }

  const cloudPaths = boundary?.cloudOnlyPaths || [
    "apps/cloud",
    "apps/web",
    "packages/cloud-contracts",
    "infra/aws",
    "infra/serverless",
    "deploy",
    "aws",
  ];
  for (const cp of cloudPaths) {
    const cpNorm = cp.replace(/\\/g, "/");
    if (
      normalized === cpNorm ||
      normalized.startsWith(`${cpNorm}/`) ||
      normalized === `resin/${cpNorm}` ||
      normalized.startsWith(`resin/${cpNorm}/`) ||
      normalized.includes(`/${cpNorm}/`) ||
      normalized.endsWith(`/${cpNorm}`)
    ) {
      return true;
    }
  }

  const privatePkgs = boundary?.privatePackages || [
    "@resin/cloud",
    "@resin/web",
    "@resin/cloud-contracts",
    "@resin/e2e",
  ];
  for (const pkg of privatePkgs) {
    const pkgClean = pkg.replace(/^@resin\//, "");
    if (
      normalized.includes(`apps/${pkgClean}`) ||
      normalized.includes(`packages/${pkgClean}`) ||
      normalized.includes(`node_modules/${pkg}`)
    ) {
      return true;
    }
  }

  return false;
}

function isTextOrCodeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    [
      ".js",
      ".mjs",
      ".cjs",
      ".ts",
      ".mts",
      ".cts",
      ".d.ts",
      ".json",
      ".md",
      ".txt",
      ".sh",
      ".ps1",
      ".yaml",
      ".yml",
      ".html",
    ].includes(ext) ||
    filePath.endsWith("resin/bin/resin") ||
    filePath.endsWith("resin/bin/resin-daemon") ||
    filePath.endsWith("resin/bin/resin-mcp")
  );
}

/**
 * Validates entries of an extracted platform release tarball.
 * @param {Array<{ name: string, content?: Buffer, size?: number }>} entries
 * @param {string} [filename]
 * @param {object} [options]
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyTarballEntries(entries, filename = "tarball", options = {}) {
  const violations = [];
  const rootDir = options.rootDir || process.cwd();
  const boundary = options.boundary || loadBoundaryManifest(rootDir);
  const entryMap = new Map(entries.map((e) => [e.name, e]));

  const licenseEntry = entryMap.get("resin/LICENSE");
  if (!licenseEntry || licenseEntry.size === 0) {
    violations.push({
      rule: "MISSING_LEGAL_FILE",
      file: filename,
      message: `Platform release tarball ${filename} is missing non-empty resin/LICENSE.`,
    });
  } else {
    const licenseText = (licenseEntry.content || "").toString("utf8");
    if (!licenseText.includes("Apache License") || !licenseText.includes("Version 2.0")) {
      violations.push({
        rule: "MALFORMED_LEGAL_FILE",
        file: filename,
        message: `Platform release tarball ${filename} contains incomplete/malformed resin/LICENSE.`,
      });
    }
  }

  const noticeEntry = entryMap.get("resin/NOTICE");
  if (!noticeEntry || noticeEntry.size === 0) {
    violations.push({
      rule: "MISSING_LEGAL_FILE",
      file: filename,
      message: `Platform release tarball ${filename} is missing non-empty resin/NOTICE.`,
    });
  }

  const allowedTopLevel = new Set(ALLOWED_TOP_LEVEL_ENTRIES);
  const allowedBins = new Set(ALLOWED_RELEASE_BINARIES);
  const allowedAppDirs = new Set(["cli", "gateway", "observer"]);
  const allowedPkgDirs = new Set([
    "runtime",
    "crypto",
    "protocol",
    "contracts",
    "harness-contracts",
    "db",
  ]);
  const allowedAdapterDirs = new Set(["claude-code", "codex-cli", "omp"]);
  const allowedFixtureDirs = new Set(["test-fixtures"]);

  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, "/");

    if (!normalized.startsWith("resin/")) {
      violations.push({
        rule: "UNALLOWLISTED_TARBALL_PATH",
        file: filename,
        message: `Platform release tarball ${filename} contains entry outside canonical 'resin/' root: '${normalized}'.`,
      });
      continue;
    }

    if (isForbiddenTarballPath(normalized, boundary)) {
      violations.push({
        rule: "FORBIDDEN_RELEASE_ARTIFACT",
        file: filename,
        message: `Platform release tarball ${filename} contains forbidden path: '${normalized}'.`,
      });
      continue;
    }

    const relToResin = normalized.slice("resin/".length);
    const topSegment = relToResin.split("/")[0];

    if (!relToResin.includes("/")) {
      if (!allowedTopLevel.has(normalized)) {
        violations.push({
          rule: "UNALLOWLISTED_TARBALL_PATH",
          file: filename,
          message: `Platform release tarball ${filename} contains unexpected top-level file: '${normalized}'.`,
        });
      }
    } else if (topSegment === "bin") {
      const isAllowedBin =
        allowedBins.has(normalized) ||
        PLATFORMS.some(
          (p) =>
            normalized === `resin/bin/resin-${p.id}` ||
            normalized === `resin/bin/resin-${p.id}.exe`,
        );
      if (!isAllowedBin) {
        violations.push({
          rule: "UNEXPECTED_BINARY",
          file: filename,
          message: `Platform release tarball ${filename} contains unexpected binary: '${normalized}'.`,
        });
      }
    } else if (topSegment === "vendor") {
      // Vendor binaries/files allowed
    } else if (topSegment === "apps") {
      const appName = relToResin.split("/")[1];
      if (!allowedAppDirs.has(appName)) {
        violations.push({
          rule: "UNALLOWLISTED_TARBALL_PATH",
          file: filename,
          message: `Platform release tarball ${filename} contains unallowlisted app directory: 'resin/apps/${appName}'.`,
        });
      }
    } else if (topSegment === "packages") {
      const pkgName = relToResin.split("/")[1];
      if (!allowedPkgDirs.has(pkgName)) {
        violations.push({
          rule: "UNALLOWLISTED_TARBALL_PATH",
          file: filename,
          message: `Platform release tarball ${filename} contains unallowlisted package directory: 'resin/packages/${pkgName}'.`,
        });
      }
    } else if (topSegment === "adapters") {
      const adapterName = relToResin.split("/")[1];
      if (!allowedAdapterDirs.has(adapterName)) {
        violations.push({
          rule: "UNALLOWLISTED_TARBALL_PATH",
          file: filename,
          message: `Platform release tarball ${filename} contains unallowlisted adapter directory: 'resin/adapters/${adapterName}'.`,
        });
      }
    } else if (topSegment === "fixtures") {
      const fixtureName = relToResin.split("/")[1];
      if (!allowedFixtureDirs.has(fixtureName)) {
        violations.push({
          rule: "UNALLOWLISTED_TARBALL_PATH",
          file: filename,
          message: `Platform release tarball ${filename} contains unallowlisted fixtures directory: 'resin/fixtures/${fixtureName}'.`,
        });
      }
    } else if (topSegment === "node_modules") {
      // Node modules dependencies allowed
    } else {
      violations.push({
        rule: "UNALLOWLISTED_TARBALL_PATH",
        file: filename,
        message: `Platform release tarball ${filename} contains unexpected directory or path: '${normalized}'.`,
      });
    }

    if (entry.content && entry.content.length > 0 && isTextOrCodeFile(normalized)) {
      const contentStr = entry.content.toString("utf8");
      for (const identifier of PROPRIETARY_CLOUD_IDENTIFIERS) {
        if (contentStr.includes(identifier)) {
          violations.push({
            rule: "PROPRIETARY_CLOUD_IDENTIFIER",
            file: filename,
            message: `Platform release tarball ${filename} entry '${normalized}' contains proprietary cloud identifier '${identifier}'.`,
          });
          break;
        }
      }
    }
  }

  return violations;
}
/**
 * Validates existence of all required release artifact files and legal notices.
 * @param {string} releaseDir
 * @param {object} options
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyReleaseFiles(releaseDir, options = {}) {
  const violations = [];
  const rootDir = options.rootDir || path.resolve(releaseDir, "../../..") || process.cwd();
  const boundary = options.boundary || loadBoundaryManifest(rootDir);

  if (!fs.existsSync(releaseDir)) {
    violations.push({
      rule: "RELEASE_DIR",
      file: releaseDir,
      message: `Release directory does not exist: ${releaseDir}`,
    });
    return violations;
  }

  for (const legalFile of ["LICENSE", "NOTICE", "SECURITY.md"]) {
    const legalPath = path.join(rootDir, legalFile);
    if (!fs.existsSync(legalPath) || fs.statSync(legalPath).size === 0) {
      violations.push({
        rule: "MISSING_ROOT_LEGAL_FILE",
        file: legalFile,
        message: `Required root legal/security documentation file is missing or empty: ${legalFile}`,
      });
    }
  }

  const requiredFiles = [
    "manifest.json",
    "sbom.json",
    "vulnerability-scan-evidence.json",
    "channels.json",
    "release-evidence.json",
    "RELEASE-EVIDENCE.md",
    "release-trust.json",
  ];

  for (const f of requiredFiles) {
    const full = path.join(releaseDir, f);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_ARTIFACT",
        file: f,
        message: `Required release artifact is missing: ${f}`,
      });
    } else if (fs.statSync(full).size === 0) {
      violations.push({
        rule: "EMPTY_ARTIFACT",
        file: f,
        message: `Required release artifact is empty (0 bytes): ${f}`,
      });
    }
  }

  for (const platform of PLATFORMS) {
    const full = path.join(releaseDir, platform.filename);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_PLATFORM_TARBALL",
        file: platform.filename,
        message: `Platform release tarball is missing: ${platform.filename}`,
      });
    } else {
      const stats = fs.statSync(full);
      if (stats.size === 0) {
        violations.push({
          rule: "EMPTY_TARBALL",
          file: platform.filename,
          message: `Platform release tarball is empty (0 bytes): ${platform.filename}`,
        });
      } else {
        try {
          const tarBuffer = fs.readFileSync(full);
          const entries = extractTarEntries(tarBuffer);
          const tarViolations = verifyTarballEntries(entries, platform.filename, {
            rootDir,
            boundary,
            ...options,
          });
          violations.push(...tarViolations);
        } catch (err) {
          violations.push({
            rule: "CORRUPT_TARBALL",
            file: platform.filename,
            message: `Failed to inspect tarball ${platform.filename}: ${err.message}`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Validates the existence and contents of release-evidence.json and RELEASE-EVIDENCE.md.
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyReleaseEvidence(releaseDir, options = {}) {
  const violations = [];
  const evidenceJsonPath = path.join(releaseDir, "release-evidence.json");
  const evidenceMdPath = path.join(releaseDir, "RELEASE-EVIDENCE.md");
  if (!fs.existsSync(evidenceJsonPath)) {
    return [
      {
        rule: "MISSING_EVIDENCE_JSON",
        file: "release-evidence.json",
        message: "release-evidence.json is missing.",
      },
    ];
  }
  if (!fs.existsSync(evidenceMdPath)) {
    violations.push({
      rule: "MISSING_EVIDENCE_MD",
      file: "RELEASE-EVIDENCE.md",
      message: "RELEASE-EVIDENCE.md is missing.",
    });
  }

  try {
    const evidence = JSON.parse(fs.readFileSync(evidenceJsonPath, "utf8"));
    if (evidence.release !== RELEASE_VERSION) {
      violations.push({
        rule: "INVALID_EVIDENCE_VERSION",
        file: "release-evidence.json",
        message: "Evidence release version mismatch.",
      });
    }
    if (evidence.mode === "test-only" && options.allowTestEvidence !== true) {
      violations.push({
        rule: "TEST_ONLY_EVIDENCE",
        file: "release-evidence.json",
        message: "Test-only release evidence cannot authorize a production release.",
      });
    } else if (evidence.mode !== "test-only" && evidence.status !== "VERIFIED") {
      violations.push({
        rule: "EVIDENCE_NOT_VERIFIED",
        file: "release-evidence.json",
        message: `Release evidence status is '${evidence.status}'.`,
      });
    }
    if (options.expectedCommitSha && evidence.commitSha !== options.expectedCommitSha) {
      violations.push({
        rule: "EVIDENCE_COMMIT_MISMATCH",
        file: "release-evidence.json",
        message: `Evidence commit '${evidence.commitSha}' does not match '${options.expectedCommitSha}'.`,
      });
    }
    if (!Array.isArray(evidence.milestones) || evidence.milestones.length !== 21) {
      violations.push({
        rule: "INCOMPLETE_EVIDENCE_MILESTONES",
        file: "release-evidence.json",
        message: "Release evidence must contain all 21 milestones.",
      });
    } else if (evidence.mode !== "test-only") {
      for (const milestone of evidence.milestones) {
        if (milestone.status !== "VERIFIED") {
          violations.push({
            rule: "UNVERIFIED_MILESTONE",
            file: "release-evidence.json",
            message: `Milestone ${milestone.id} is not verified.`,
          });
        }
        for (const suite of milestone.verificationSuites || []) {
          if (suite.status !== "PASSED" || !suite.runId) {
            violations.push({
              rule: "UNVERIFIED_SUITE",
              file: "release-evidence.json",
              message: `Suite ${suite.path} lacks a passing CI run binding.`,
            });
          }
        }
      }
    }
    if (!evidence.releaseIdentity || !evidence.verificationSource) {
      violations.push({
        rule: "MISSING_EVIDENCE_PROVENANCE",
        file: "release-evidence.json",
        message: "Release evidence lacks build/workflow provenance.",
      });
    }
  } catch (error) {
    violations.push({
      rule: "CORRUPT_EVIDENCE_JSON",
      file: "release-evidence.json",
      message: `Failed to parse release evidence: ${error.message}`,
    });
  }

  if (fs.existsSync(evidenceMdPath)) {
    const md = fs.readFileSync(evidenceMdPath, "utf8");
    if (!md.includes("REM-001") || !md.includes("REM-020") || !md.includes("#22")) {
      violations.push({
        rule: "INCOMPLETE_EVIDENCE_MD",
        file: "RELEASE-EVIDENCE.md",
        message: "Evidence markdown is incomplete.",
      });
    }
  }
  return violations;
}

/**
 * Validates the manifest signature against an independently pinned trust root.
 */
export function verifyManifestSignatures(manifest, options = {}) {
  const violations = [];
  if (!Array.isArray(manifest?.signatures) || manifest.signatures.length === 0) {
    return [{ rule: "MISSING_SIGNATURE", message: "Release manifest is unsigned." }];
  }
  const signature = manifest.signatures[0];
  const payload = {
    schemaVersion: manifest.schemaVersion,
    ...(manifest.metadataVersion !== undefined
      ? { metadataVersion: manifest.metadataVersion }
      : {}),
    ...(manifest.expiresAt !== undefined ? { expiresAt: manifest.expiresAt } : {}),
    version: manifest.version,
    releaseDate: manifest.releaseDate,
    releaseIdentity: manifest.releaseIdentity,
    packages: manifest.packages,
    assets: manifest.assets,
    ...(manifest.runtimes ? { runtimes: manifest.runtimes } : {}),
    evidence: manifest.evidence,
  };
  const result = verifyReleasePayloadSignature(payload, signature, options.trustedKeys);
  if (!result.valid) {
    const rule =
      result.reason === "unknown_key"
        ? "UNKNOWN_SIGNING_KEY"
        : result.reason === "revoked_key"
          ? "REVOKED_SIGNING_KEY"
          : "SIGNATURE_VERIFICATION_FAILED";
    violations.push({
      rule,
      message: `Release manifest signature verification failed: ${result.reason}.`,
    });
  }
  return violations;
}

/**
 * Validates that all asset tarballs match the digests recorded in manifest.json.
 * @param {string} releaseDir
 * @param {object} manifest
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyAssetDigests(releaseDir, manifest) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];

  if (!manifest.assets || typeof manifest.assets !== "object") {
    violations.push({
      rule: "INVALID_MANIFEST_ASSETS",
      file: "manifest.json",
      message: "Manifest missing 'assets' object.",
    });
    return violations;
  }

  for (const platform of PLATFORMS) {
    const assetMeta = manifest.assets[platform.id];
    if (!assetMeta) {
      violations.push({
        rule: "MISSING_MANIFEST_ASSET_ENTRY",
        file: platform.filename,
        message: `Manifest assets does not contain entry for platform '${platform.id}'.`,
      });
      continue;
    }

    const tarballPath = path.join(releaseDir, platform.filename);
    if (!fs.existsSync(tarballPath)) continue;

    const actualSha256 = fileSha256(tarballPath);
    if (actualSha256 !== assetMeta.sha256) {
      violations.push({
        rule: "ASSET_DIGEST_MISMATCH",
        file: platform.filename,
        message: `Digest mismatch for ${platform.filename}: expected ${assetMeta.sha256}, calculated ${actualSha256}`,
      });
    }
  }

  return violations;
}

/**
 * Validates that all public release packages are recorded in manifest.json and no forbidden packages exist.
 * @param {object} manifest
 * @param {object} [options]
 * @returns {Array<{ rule: string, message: string }>}
 */
export function verifyPackageDigests(manifest, options = {}) {
  /** @type {Array<{ rule: string, message: string }>} */
  const violations = [];
  const rootDir = options.rootDir || process.cwd();
  const boundary = options.boundary || loadBoundaryManifest(rootDir);
  const expectedPackages =
    options.expectedPackages || boundary.publicReleasePackages || boundary.publicPackages || [];
  const privatePackages = new Set(boundary.privatePackages || []);
  const expectedSet = new Set(expectedPackages);

  if (!manifest.packages || typeof manifest.packages !== "object") {
    violations.push({
      rule: "INVALID_MANIFEST_PACKAGES",
      message: "Manifest missing 'packages' object.",
    });
    return violations;
  }

  for (const pkgName of expectedPackages) {
    const pkgMeta = manifest.packages[pkgName];
    if (!pkgMeta) {
      violations.push({
        rule: "MISSING_PACKAGE_IN_MANIFEST",
        message: `Manifest packages does not contain entry for '${pkgName}'.`,
      });
      continue;
    }

    if (!pkgMeta.packageSha256 || pkgMeta.packageSha256.length !== 64) {
      violations.push({
        rule: "INVALID_PACKAGE_DIGEST",
        message: `Package '${pkgName}' has invalid or missing packageSha256 digest.`,
      });
    }
  }

  for (const pkgName of Object.keys(manifest.packages)) {
    if (privatePackages.has(pkgName)) {
      violations.push({
        rule: "FORBIDDEN_PACKAGE_IN_MANIFEST",
        message: `Manifest packages contains forbidden private package '${pkgName}'.`,
      });
    } else if (!expectedSet.has(pkgName)) {
      violations.push({
        rule: "UNALLOWLISTED_PACKAGE_IN_MANIFEST",
        message: `Manifest packages contains unallowlisted package '${pkgName}'.`,
      });
    }
  }

  return violations;
}

export const APPROVED_LICENSES = Object.freeze({
  "Apache-2.0": true,
  MIT: true,
  ISC: true,
  "BSD-2-Clause": true,
  "BSD-3-Clause": true,
  "0BSD": true,
  "CC0-1.0": true,
  Unlicense: true,
  "Python-2.0": true,
  "BlueOak-1.0.0": true,
  JSON: true,
  Zlib: true,
});

export const FORBIDDEN_LICENSES = Object.freeze({
  "GPL-1.0": true,
  "GPL-1.0-only": true,
  "GPL-1.0-or-later": true,
  "GPL-2.0": true,
  "GPL-2.0-only": true,
  "GPL-2.0-or-later": true,
  "GPL-3.0": true,
  "GPL-3.0-only": true,
  "GPL-3.0-or-later": true,
  "AGPL-1.0": true,
  "AGPL-3.0": true,
  "AGPL-3.0-only": true,
  "AGPL-3.0-or-later": true,
  "SSPL-1.0": true,
  "LGPL-2.0": true,
  "LGPL-2.1": true,
  "LGPL-3.0": true,
  "EUPL-1.1": true,
  "EUPL-1.2": true,
  "CC-BY-NC-1.0": true,
  "CC-BY-NC-2.0": true,
  "CC-BY-NC-3.0": true,
  "CC-BY-NC-4.0": true,
  "Commons-Clause": true,
});
/**
 * Enforces license compliance policy on SBOM components.
 * @param {object} sbom
 * @param {object} options
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyLicensePolicy(sbom, options = {}) {
  const violations = [];
  const exceptions = [...(options.licenseExceptions || []), ...(sbom.licenseExceptions || [])];

  const components = Array.isArray(sbom?.components) ? sbom.components : [];
  for (const component of components) {
    const rawLicenses = component.licenses;
    if (!Array.isArray(rawLicenses) || rawLicenses.length === 0) {
      violations.push({
        rule: "MISSING_COMPONENT_LICENSE",
        file: "sbom.json",
        message: `SBOM component '${component.name}' is missing license declaration.`,
      });
      continue;
    }

    for (const lic of rawLicenses) {
      const licenseId = lic.license?.id || lic.license?.name || lic.expression;
      if (!licenseId) {
        violations.push({
          rule: "MALFORMED_COMPONENT_LICENSE",
          file: "sbom.json",
          message: `SBOM component '${component.name}' has malformed license object.`,
        });
        continue;
      }

      const isApproved =
        APPROVED_LICENSES[licenseId] === true ||
        licenseId.split(/\s+OR\s+/).some((part) => APPROVED_LICENSES[part.trim()] === true);
      const isForbidden =
        FORBIDDEN_LICENSES[licenseId] === true ||
        licenseId.split(/\s+AND\s+/).some((part) => FORBIDDEN_LICENSES[part.trim()] === true);

      if (!isApproved || isForbidden) {
        const hasReviewedException = exceptions.some(
          (ex) =>
            (ex.packageName === component.name || ex.purl === component.purl) &&
            (ex.license === licenseId || !ex.license) &&
            Boolean(ex.rationale) &&
            Boolean(ex.reviewer) &&
            Boolean(ex.approvedAt || ex.approvedDate),
        );

        if (!hasReviewedException) {
          violations.push({
            rule: isForbidden ? "FORBIDDEN_LICENSE" : "UNAPPROVED_LICENSE",
            file: "sbom.json",
            message: `SBOM component '${component.name}' has unapproved license '${licenseId}' without reviewed exception.`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Enforces zero unapproved Critical/High vulnerability policy gate.
 * @param {object} sbom
 * @param {object} options
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyVulnerabilityPolicy(sbom, options = {}) {
  const violations = [];
  const exceptions = [
    ...(options.vulnerabilityExceptions || []),
    ...(sbom.vulnerabilityExceptions || []),
  ];

  const vulnerabilities = Array.isArray(sbom?.vulnerabilities) ? sbom.vulnerabilities : [];
  for (const vuln of vulnerabilities) {
    const vulnId = vuln.id || vuln.name || "UNKNOWN_VULN";
    const ratings = Array.isArray(vuln.ratings) ? vuln.ratings : [];
    const severity = (
      ratings[0]?.severity ||
      vuln.severity ||
      (ratings[0]?.score >= 9.0 ? "critical" : ratings[0]?.score >= 7.0 ? "high" : "low")
    ).toLowerCase();

    if (severity === "critical" || severity === "high") {
      const analysis = vuln.analysis;
      const isAnalysisAccepted =
        analysis &&
        ["not_affected", "resolved_with_pedigree", "in_triage", "false_positive"].includes(
          analysis.state,
        ) &&
        Boolean(analysis.justification || analysis.detail) &&
        Boolean(analysis.reviewer || analysis.approvedBy);

      const hasReviewedException = exceptions.some(
        (ex) =>
          (ex.id === vulnId || ex.vulnerabilityId === vulnId) &&
          Boolean(ex.rationale || ex.justification) &&
          Boolean(ex.reviewer || ex.approvedBy) &&
          Boolean(ex.approvedAt || ex.approvedDate),
      );

      if (!isAnalysisAccepted && !hasReviewedException) {
        violations.push({
          rule:
            severity === "critical"
              ? "UNAPPROVED_CRITICAL_VULNERABILITY"
              : "UNAPPROVED_HIGH_VULNERABILITY",
          file: "sbom.json",
          message: `Unapproved ${severity.toUpperCase()} vulnerability '${vulnId}' affects component ${vuln.affects?.[0]?.ref || "unknown"}.`,
        });
      }
    }
  }

  return violations;
}

/**
 * Validates the CycloneDX 1.5 SBOM, licensing, and vulnerability security gates.
 * @param {string} releaseDir
 * @param {object} options
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifySbom(releaseDir, options = {}) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];
  const sbomPath = path.join(releaseDir, "sbom.json");
  const rootDir = options.rootDir || path.resolve(releaseDir, "../../..") || process.cwd();
  const boundary = options.boundary || loadBoundaryManifest(rootDir);
  if (!fs.existsSync(sbomPath)) {
    violations.push({
      rule: "MISSING_SBOM",
      file: "sbom.json",
      message: "SBOM file sbom.json is missing.",
    });
    return violations;
  }

  try {
    const raw = fs.readFileSync(sbomPath, "utf8");
    const sbom = JSON.parse(raw);

    if (sbom.bomFormat !== "CycloneDX") {
      violations.push({
        rule: "INVALID_SBOM_FORMAT",
        file: "sbom.json",
        message: `Invalid bomFormat: ${sbom.bomFormat} (expected CycloneDX).`,
      });
    }

    if (sbom.specVersion !== "1.5") {
      violations.push({
        rule: "INVALID_SBOM_VERSION",
        file: "sbom.json",
        message: `Invalid CycloneDX specVersion: ${sbom.specVersion} (expected 1.5).`,
      });
    }

    if (
      typeof sbom.serialNumber !== "string" ||
      !/^urn:uuid:[0-9a-fA-F-]{36}$/.test(sbom.serialNumber)
    ) {
      violations.push({
        rule: "INVALID_SBOM_SERIAL_NUMBER",
        file: "sbom.json",
        message: `Invalid or missing CycloneDX serialNumber: ${sbom.serialNumber}.`,
      });
    }

    if (!sbom.metadata || typeof sbom.metadata !== "object") {
      violations.push({
        rule: "MISSING_SBOM_METADATA",
        file: "sbom.json",
        message: "SBOM is missing metadata object.",
      });
    } else {
      if (!sbom.metadata.timestamp || Number.isNaN(Date.parse(sbom.metadata.timestamp))) {
        violations.push({
          rule: "INVALID_SBOM_TIMESTAMP",
          file: "sbom.json",
          message: `Invalid or missing SBOM metadata timestamp: ${sbom.metadata.timestamp}.`,
        });
      }
    }

    const expectedPublicPackages =
      options.expectedPackages || boundary.publicReleasePackages || boundary.publicPackages || [];
    const privatePackages = new Set(boundary.privatePackages || []);

    if (!Array.isArray(sbom.components) || sbom.components.length < expectedPublicPackages.length) {
      violations.push({
        rule: "INCOMPLETE_SBOM_COMPONENTS",
        file: "sbom.json",
        message: `SBOM components count (${sbom.components?.length}) is less than expected public release packages (${expectedPublicPackages.length}).`,
      });
    }

    const componentNames = new Set((sbom.components || []).map((c) => c.name));
    for (const pkgName of expectedPublicPackages) {
      if (!componentNames.has(pkgName)) {
        violations.push({
          rule: "MISSING_SBOM_COMPONENT",
          file: "sbom.json",
          message: `SBOM is missing component for public release package '${pkgName}'.`,
        });
      }
    }

    for (const component of sbom.components || []) {
      if (privatePackages.has(component.name)) {
        violations.push({
          rule: "FORBIDDEN_SBOM_COMPONENT",
          file: "sbom.json",
          message: `SBOM contains forbidden private package component '${component.name}'.`,
        });
      } else if (
        typeof component.purl === "string" &&
        (component.purl.includes("@resin/cloud") ||
          component.purl.includes("@resin/web") ||
          component.purl.includes("@resin/cloud-contracts") ||
          component.purl.includes("@resin/e2e"))
      ) {
        violations.push({
          rule: "FORBIDDEN_SBOM_COMPONENT",
          file: "sbom.json",
          message: `SBOM component '${component.name}' purl references forbidden private package: '${component.purl}'.`,
        });
      }
    }

    for (const component of sbom.components || []) {
      if (!component.name || typeof component.name !== "string") {
        violations.push({
          rule: "INVALID_COMPONENT_NAME",
          file: "sbom.json",
          message: "A component in sbom.json is missing a valid name.",
        });
      }
      if (!component.version || typeof component.version !== "string") {
        violations.push({
          rule: "INVALID_COMPONENT_VERSION",
          file: "sbom.json",
          message: `Component '${component.name}' is missing a valid version.`,
        });
      }
      if (!component.purl || typeof component.purl !== "string") {
        violations.push({
          rule: "INVALID_COMPONENT_PURL",
          file: "sbom.json",
          message: `Component '${component.name}' is missing a valid purl.`,
        });
      }
    }

    const properties = Array.isArray(sbom.metadata?.properties) ? sbom.metadata.properties : [];
    const isTestOnlySbom = properties.some(
      (p) =>
        (p.name === "resin:test-only" && p.value === "true") ||
        (p.name === "scanDomain" && p.value === "test-only"),
    );

    if (isTestOnlySbom && options.allowTestEvidence !== true) {
      violations.push({
        rule: "UNAUTHORIZED_TEST_EVIDENCE",
        file: "sbom.json",
        message: "SBOM contains test-only scan markings in production release verification.",
      });
    }

    if (options.allowTestEvidence !== true) {
      const propertyByName = Object.fromEntries(
        properties.map((property) => [property.name, property.value]),
      );
      const generatedAtMs = Date.parse(propertyByName["resin:scan-generated-at"]);
      const retentionUntilMs = Date.parse(propertyByName["resin:scan-retention-until"]);
      if (
        propertyByName["resin:dependency-scan-status"] !== "COMPLETED" ||
        !["COMPLETED", "NOT_APPLICABLE"].includes(propertyByName["resin:container-scan-status"]) ||
        Number.isNaN(generatedAtMs) ||
        Number.isNaN(retentionUntilMs) ||
        retentionUntilMs <= generatedAtMs
      ) {
        violations.push({
          rule: "MISSING_PRODUCTION_SCAN_EVIDENCE",
          file: "sbom.json",
          message: "Production SBOM lacks completed retained dependency/container scan evidence.",
        });
      }
    }

    const licenseViolations = verifyLicensePolicy(sbom, options);
    violations.push(...licenseViolations);

    const vulnViolations = verifyVulnerabilityPolicy(sbom, options);
    violations.push(...vulnViolations);
  } catch (err) {
    violations.push({
      rule: "INVALID_SBOM_JSON",
      file: "sbom.json",
      message: `Failed to parse sbom.json as valid JSON: ${err.message}`,
    });
  }

  return violations;
}

/**
 * Validates channels.json metadata.
 * @param {string} releaseDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyChannelMetadata(releaseDir, options = {}) {
  const violations = [];
  const channelsPath = path.join(releaseDir, "channels.json");
  if (!fs.existsSync(channelsPath)) {
    return [
      {
        rule: "MISSING_CHANNELS",
        file: "channels.json",
        message: "channels.json is missing.",
      },
    ];
  }
  try {
    const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
    const stable = channels.channels?.stable;
    if (!stable || stable.version !== RELEASE_VERSION) {
      violations.push({
        rule: "CHANNEL_VERSION_MISMATCH",
        file: "channels.json",
        message: "Stable release channel is missing or mismatched.",
      });
    }
    if (!channels.minSupportedVersion) {
      violations.push({
        rule: "MISSING_MIN_SUPPORTED_VERSION",
        file: "channels.json",
        message: "Channel metadata lacks minSupportedVersion.",
      });
    }
    if (!channels.rollbackReferences?.targetVersion) {
      violations.push({
        rule: "MISSING_ROLLBACK_REFERENCES",
        file: "channels.json",
        message: "Channel metadata lacks rollback references.",
      });
    }
    if (
      options.expectedCommitSha &&
      channels.releaseIdentity?.commitSha !== options.expectedCommitSha
    ) {
      violations.push({
        rule: "CHANNEL_COMMIT_MISMATCH",
        file: "channels.json",
        message: "Channel metadata is bound to a different commit.",
      });
    }
    if (
      options.expectedManifestDigest &&
      stable?.manifestDigest !== options.expectedManifestDigest
    ) {
      violations.push({
        rule: "CHANNEL_MANIFEST_DIGEST_MISMATCH",
        file: "channels.json",
        message: "Channel metadata references a different manifest digest.",
      });
    }
    if (!Array.isArray(channels.signatures) || channels.signatures.length === 0) {
      violations.push({
        rule: "MISSING_CHANNEL_SIGNATURE",
        file: "channels.json",
        message: "Channel metadata is unsigned.",
      });
    } else {
      const payload = { ...channels };
      delete payload.signatures;
      const verified = verifyReleasePayloadSignature(
        payload,
        channels.signatures[0],
        options.trustedKeys,
      );
      if (!verified.valid) {
        violations.push({
          rule:
            verified.reason === "unknown_key"
              ? "UNKNOWN_CHANNEL_SIGNING_KEY"
              : "CHANNEL_SIGNATURE_VERIFICATION_FAILED",
          file: "channels.json",
          message: `Channel signature failed: ${verified.reason}.`,
        });
      }
    }
  } catch (error) {
    violations.push({
      rule: "INVALID_CHANNELS_JSON",
      file: "channels.json",
      message: `Failed to parse channels.json: ${error.message}`,
    });
  }
  return violations;
}

/**
 * Recursively discovers all markdown files in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Validates documentation completeness and cross-links across all docs.
 * @param {string} rootDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyDocumentation(rootDir = process.cwd()) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];

  const docsDir = path.resolve(rootDir, "docs");
  if (!fs.existsSync(docsDir)) {
    violations.push({
      rule: "MISSING_DOCS_DIR",
      file: "docs",
      message: "docs/ directory does not exist.",
    });
    return violations;
  }

  // 1. Verify required user docs
  for (const doc of REQUIRED_USER_DOCS) {
    const full = path.join(docsDir, "user", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_USER_DOC",
        file: `docs/user/${doc}`,
        message: `Required user documentation is missing: docs/user/${doc}`,
      });
    }
  }

  // 2. Verify required operator docs
  for (const doc of REQUIRED_OPERATOR_DOCS) {
    const full = path.join(docsDir, "operator", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_OPERATOR_DOC",
        file: `docs/operator/${doc}`,
        message: `Required operator documentation is missing: docs/operator/${doc}`,
      });
    }
  }

  // 3. Verify required security docs
  for (const doc of REQUIRED_SECURITY_DOCS) {
    const full = path.join(docsDir, "security", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_SECURITY_DOC",
        file: `docs/security/${doc}`,
        message: `Required security documentation is missing: docs/security/${doc}`,
      });
    }
  }

  // 4. Verify required release docs
  for (const doc of REQUIRED_RELEASE_DOCS) {
    const full = path.join(docsDir, "release", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_RELEASE_DOC",
        file: `docs/release/${doc}`,
        message: `Required release documentation is missing: docs/release/${doc}`,
      });
    }
  }

  // 5. Verify all relative links across all markdown files in docs/
  const allDocFiles = findMarkdownFiles(docsDir);
  for (const filePath of allDocFiles) {
    const relPath = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let inFencedCodeBlock = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const rawLine = lines[lineNum];
      if (rawLine.trim().startsWith("```")) {
        inFencedCodeBlock = !inFencedCodeBlock;
        continue;
      }
      if (inFencedCodeBlock) continue;

      const lineWithoutCode = rawLine.replace(/`[^`]+`/g, "");
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

      let match;
      while (true) {
        match = linkRegex.exec(lineWithoutCode);
        if (match === null) break;
        const target = match[2].trim();

        if (
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:") ||
          target.startsWith("#")
        ) {
          continue;
        }

        const [targetPath] = target.split("#");
        if (targetPath) {
          const resolvedTarget = path.resolve(path.dirname(filePath), targetPath);
          if (!fs.existsSync(resolvedTarget)) {
            violations.push({
              rule: "BROKEN_LINK",
              file: relPath,
              message: `Broken link on line ${lineNum + 1}: "${target}" targets non-existent file "${path.relative(rootDir, resolvedTarget)}"`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Full release verification suite.
 * @param {object} options
 * @returns {{ valid: boolean, violations: Array<{ rule: string, file?: string, message: string }>, stats: object }}
 */
export function verifyRelease(options = {}) {
  let trustedKeys = options.trustedKeys;
  const allowTestEvidence = options.allowTestEvidence === true;
  if (!trustedKeys && !allowTestEvidence) {
    try {
      trustedKeys = loadTrustedReleaseKeysFromEnv(options.env || process.env);
    } catch {
      trustedKeys = undefined;
    }
  }
  const rootDir = options.rootDir || process.cwd();
  const boundary = options.boundary || loadBoundaryManifest(rootDir);
  const releaseDir =
    options.releaseDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  console.log(`🔍 Verifying Resin V${RELEASE_VERSION} Release Artifacts & Documentation...`);
  console.log(`📂 Release Directory: ${releaseDir}`);

  /** @type {Array<{ rule: string, file?: string, message: string }>} */
  const violations = [];
  // 1. Files existence & integrity
  const fileViolations = verifyReleaseFiles(releaseDir, {
    rootDir,
    boundary,
    ...options,
  });
  violations.push(...fileViolations);
  let manifest = null;
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      violations.push({
        rule: "INVALID_MANIFEST_JSON",
        file: "manifest.json",
        message: `Failed to parse manifest.json: ${err.message}`,
      });
    }
  }

  if (allowTestEvidence && !trustedKeys) {
    const trustPath = path.join(releaseDir, "release-trust.json");
    if (fs.existsSync(trustPath)) {
      const trust = JSON.parse(fs.readFileSync(trustPath, "utf8"));
      if (trust.trustDomain === "test-only" && trust.signingKey?.keyId) {
        trustedKeys = { [trust.signingKey.keyId]: trust.signingKey };
      }
    }
  }
  if (!trustedKeys) {
    violations.push({
      rule: "NO_TRUSTED_RELEASE_KEYS",
      message: "No independent trusted release public key is configured.",
    });
  }

  if (manifest) {
    if (
      options.expectedCommitSha &&
      manifest.releaseIdentity?.commitSha !== options.expectedCommitSha
    ) {
      violations.push({
        rule: "MANIFEST_COMMIT_MISMATCH",
        file: "manifest.json",
        message: "Manifest commit binding does not match the expected release commit.",
      });
    }
    // 2. Signatures
    const sigViolations = verifyManifestSignatures(manifest, { trustedKeys });
    violations.push(...sigViolations);

    // 3. Asset digests
    const assetViolations = verifyAssetDigests(releaseDir, manifest);
    violations.push(...assetViolations);

    // 4. Package digests
    const pkgViolations = verifyPackageDigests(manifest, { rootDir, boundary, ...options });
    violations.push(...pkgViolations);
  }

  // 5. SBOM verification
  const sbomViolations = verifySbom(releaseDir, {
    rootDir,
    boundary,
    allowTestEvidence,
    ...options,
  });
  violations.push(...sbomViolations);
  const manifestDigest = fs.existsSync(manifestPath) ? fileSha256(manifestPath) : undefined;
  const channelViolations = verifyChannelMetadata(releaseDir, {
    trustedKeys,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
    expectedManifestDigest: manifestDigest,
  });
  violations.push(...channelViolations);

  // 7. Documentation verification
  const docViolations = verifyDocumentation(rootDir);
  // 8. Release Evidence verification and signed digest binding
  const evidenceViolations = verifyReleaseEvidence(releaseDir, {
    allowTestEvidence,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
  });
  violations.push(...evidenceViolations);
  const evidencePath = path.join(releaseDir, "release-evidence.json");
  if (manifest?.evidence?.jsonSha256 && fs.existsSync(evidencePath)) {
    const actualEvidenceDigest = fileSha256(evidencePath);
    if (actualEvidenceDigest !== manifest.evidence.jsonSha256) {
      violations.push({
        rule: "EVIDENCE_DIGEST_MISMATCH",
        file: "release-evidence.json",
        message: "Release evidence does not match the digest signed by the manifest.",
      });
    }
  }

  violations.push(...docViolations);

  const valid = violations.length === 0;
  const allDocs = findMarkdownFiles(path.resolve(rootDir, "docs"));

  let sbomComponentsCount = 0;
  try {
    const sbom = JSON.parse(fs.readFileSync(path.join(releaseDir, "sbom.json"), "utf8"));
    sbomComponentsCount = Array.isArray(sbom.components) ? sbom.components.length : 0;
  } catch {
    // Verification violations already describe a missing or malformed SBOM.
  }
  const stats = {
    releaseVersion: RELEASE_VERSION,
    platformsCount: PLATFORMS.length,
    packagesCount: (boundary.publicReleasePackages || []).length,
    sbomComponentsCount,
    docFilesCount: allDocs.length,
    violationsCount: violations.length,
  };

  if (valid) {
    console.log(
      `\n✅ Release verification PASSED! All ${PLATFORMS.length} platform tarballs, signed manifest, SBOM, channel metadata, and ${allDocs.length} documentation files verified.`,
    );
  } else {
    console.error(`\n❌ Release verification FAILED with ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`   - [${v.rule}] ${v.file ? `${v.file}: ` : ""}${v.message}`);
    }
  }

  return { valid, violations, stats };
}

// CLI Execution
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const rootDir = process.cwd();
  const defaultReleaseDir = path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  if (!fs.existsSync(path.join(defaultReleaseDir, "manifest.json"))) {
    console.error(
      "❌ Release verification failed: release artifacts are missing; verifier will not mint replacements.",
    );
    process.exit(1);
  }
  const result = verifyRelease();
  if (!result.valid) {
    process.exit(1);
  }
}
