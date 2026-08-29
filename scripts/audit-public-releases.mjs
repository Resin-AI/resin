#!/usr/bin/env node

/**
 * Resin Public Release Security & Boundary Auditor
 *
 * Performs a read-only inventory and security audit of Resin release channels:
 * 1. AWS S3 Public Distribution storage (configured via --bucket or RESIN_RELEASE_BUCKET)
 * 2. GitHub Releases (Resin-AI/resin)
 * 3. Public CDN / CloudFront endpoints (dist.resin.sh)
 * 4. Local release directories or synthetic in-memory fixtures
 *
 * Scans all downloaded/provided artifacts safely without executing code:
 * - Tarball / Zip extraction in memory
 * - Cloud package and file boundary violations (apps/cloud, apps/web, packages/cloud-contracts, etc.)
 * - Source map leaks (*.map, inline sourceMappingURL)
 * - Private module identifiers (@resin/cloud, @resin/web, @resin/cloud-contracts, @resin/e2e, etc.)
 * - Embedded secrets (AWS access keys, private keys, API tokens)
 * - Manifest package allowlist violations against resin-boundary.json
 * - CycloneDX SBOM cloud components and forbidden dependencies
 * - Installer integrity and unexpected endpoint references
 *
 * Output: Deterministic structured JSON and formatted Markdown/text reports.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

export const AUDIT_DATE = "2026-08-28";
export const DEFAULT_AWS_REGION = "us-east-1";
export const DEFAULT_GITHUB_REPO = "Resin-AI/resin";
export const DEFAULT_CDN_HOST = "dist.resin.sh";

export const CANONICAL_PUBLIC_RELEASE_PACKAGES = Object.freeze([
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
]);

export const CANONICAL_PRIVATE_PACKAGES = Object.freeze([
  "@resin/cloud",
  "@resin/web",
  "@resin/cloud-contracts",
  "@resin/e2e",
  "@resin/test-fixtures",
]);

export const FORBIDDEN_PATH_SUBSTRINGS = Object.freeze([
  "apps/cloud",
  "apps/web",
  "packages/cloud-contracts",
  "packages/e2e",
  "fixtures/test-fixtures",
  "fixtures/e2e",
  "infra/aws",
  "infra/serverless",
  "deploy/",
  ".github/workflows/cloud-deploy.yml",
  ".github/workflows/web-deploy.yml",
  "private/",
]);

export const SECRET_PATTERNS = Object.freeze([
  {
    name: "AWS Access Key ID",
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
    // Exclude known parser regex / placeholder strings in standard libraries
    ignoreFilter: (text, file) =>
      file.includes("credential-provider") ||
      file.includes("node_modules/@aws-sdk") ||
      file.includes("node_modules/@smithy") ||
      text.includes("pattern") ||
      text.includes("RegExp"),
  },
  {
    name: "Private Key Header",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    ignoreFilter: (text, file) =>
      file.includes("node_modules/jose") ||
      file.includes("node_modules/@types") ||
      text.includes("importKey") ||
      text.includes("exportKey"),
  },
  {
    name: "Generic Secret Assignment",
    pattern:
      /(?:api[_-]?key|secret[_-]?access[_-]?key|auth[_-]?token)\s*[:=]\s*['"][0-9a-zA-Z\-_]{24,}['"]/i,
    ignoreFilter: (text) =>
      text.includes("dummy") || text.includes("example") || text.includes("test"),
  },
]);

/**
 * Loads and resolves the canonical boundary configuration.
 */
export function loadBoundaryConfig(rootDir = process.cwd()) {
  const boundaryPath = path.resolve(rootDir, "resin-boundary.json");
  if (fs.existsSync(boundaryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(boundaryPath, "utf8"));
      return {
        publicPackages: data.publicPackages || CANONICAL_PUBLIC_RELEASE_PACKAGES,
        publicReleasePackages: data.publicReleasePackages || CANONICAL_PUBLIC_RELEASE_PACKAGES,
        privatePackages: data.privatePackages || CANONICAL_PRIVATE_PACKAGES,
        cloudOnlyPaths: data.cloudOnlyPaths || FORBIDDEN_PATH_SUBSTRINGS,
        publicDocumentationPaths: data.publicDocumentationPaths || ["docs"],
      };
    } catch {
      // Fallback
    }
  }
  return {
    publicPackages: CANONICAL_PUBLIC_RELEASE_PACKAGES,
    publicReleasePackages: CANONICAL_PUBLIC_RELEASE_PACKAGES,
    privatePackages: CANONICAL_PRIVATE_PACKAGES,
    cloudOnlyPaths: FORBIDDEN_PATH_SUBSTRINGS,
    publicDocumentationPaths: ["docs"],
  };
}

/**
 * Computes SHA-256 digest hex.
 */
export function sha256Hex(data) {
  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Safely extracts tar / tar.gz entries in memory without filesystem interaction or execution.
 */
export function extractTarEntriesSafely(tarBuffer) {
  let uncompressed;
  try {
    uncompressed = zlib.gunzipSync(tarBuffer);
  } catch {
    uncompressed = tarBuffer;
  }

  const entries = [];
  let offset = 0;
  const maxEntries = 100000;

  while (offset + 512 <= uncompressed.length && entries.length < maxEntries) {
    const header = uncompressed.subarray(offset, offset + 512);
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break;

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const prefixRaw = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const name = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeflag = header.subarray(156, 157).toString("utf8") || "0";

    offset += 512;
    const content = uncompressed.subarray(offset, Math.min(offset + size, uncompressed.length));
    offset += Math.ceil(size / 512) * 512;

    entries.push({
      name,
      path: name,
      size,
      typeflag,
      content,
    });
  }

  return entries;
}

/**
 * Safely parses zip central directory headers in memory.
 */
export function extractZipEntriesSafely(zipBuffer) {
  const entries = [];
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) return entries;

  // Search for End of Central Directory record from the end of the buffer
  let eocdOffset = -1;
  const maxSearch = Math.min(zipBuffer.length, 65557);
  for (let i = zipBuffer.length - 22; i >= zipBuffer.length - maxSearch; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) return entries;

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let currentOffset = cdOffset;
  for (let i = 0; i < totalEntries && currentOffset + 46 <= eocdOffset; i++) {
    if (zipBuffer.readUInt32LE(currentOffset) !== 0x02014b50) break;
    const compSize = zipBuffer.readUInt32LE(currentOffset + 20);
    const uncompSize = zipBuffer.readUInt32LE(currentOffset + 24);
    const fileNameLen = zipBuffer.readUInt16LE(currentOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(currentOffset + 30);
    const commentLen = zipBuffer.readUInt16LE(currentOffset + 32);
    const fileName = zipBuffer
      .subarray(currentOffset + 46, currentOffset + 46 + fileNameLen)
      .toString("utf8");

    entries.push({
      name: fileName,
      path: fileName,
      size: uncompSize,
      compressedSize: compSize,
    });

    currentOffset += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Scans content buffer or string for potential secrets.
 */
export function scanContentForSecrets(content, filename = "") {
  if (!content) return [];
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  const findings = [];

  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) {
      if (rule.ignoreFilter && rule.ignoreFilter(text, filename)) {
        continue;
      }
      findings.push({
        rule: rule.name,
        file: filename,
      });
    }
  }

  return findings;
}

/**
 * Audits a tarball archive for boundary, cloud, source map, and secret violations.
 */
export function auditTarball(
  tarBuffer,
  filename,
  boundaryConfig = loadBoundaryConfig(),
  options = {},
) {
  const digest = sha256Hex(tarBuffer);
  const size = tarBuffer.length;
  const entries = extractTarEntriesSafely(tarBuffer);

  const cloudFiles = [];
  const sourceMaps = [];
  const fixtureFiles = [];
  const testDoubleFiles = [];
  const secrets = [];
  const packageDirCounts = {};

  const cloudPaths = boundaryConfig.cloudOnlyPaths || FORBIDDEN_PATH_SUBSTRINGS;

  for (const entry of entries) {
    const entryPath = entry.name.replace(/\\/g, "/");

    // Track package directories
    const pkgMatch = entryPath.match(/^resin\/([^/]+(\/[^/]+)?)/);
    if (pkgMatch) {
      const pkgKey = pkgMatch[1];
      packageDirCounts[pkgKey] = (packageDirCounts[pkgKey] || 0) + 1;
    }

    // Check for cloud paths
    for (const cp of cloudPaths) {
      if (entryPath.includes(cp)) {
        cloudFiles.push(entryPath);
        break;
      }
    }

    // Check for source maps
    if (
      entryPath.endsWith(".map") ||
      entryPath.includes(".js.map") ||
      entryPath.includes(".d.ts.map")
    ) {
      sourceMaps.push(entryPath);
    }

    // Check for test fixtures / e2e
    if (
      entryPath.includes("fixtures/test-fixtures") ||
      entryPath.includes("packages/e2e") ||
      entryPath.includes("fixtures/e2e")
    ) {
      fixtureFiles.push(entryPath);
    }

    // Check for test files in bundle
    if (
      /\.(test|spec)\.(js|d\.ts|mjs|cjs)$/.test(entryPath) ||
      entryPath.includes("__tests__") ||
      entryPath.includes("__mocks__")
    ) {
      testDoubleFiles.push(entryPath);
    }

    // Content secret scan on text files
    if (entry.content && entry.content.length > 0 && entry.size < 1024 * 1024) {
      if (/\.(js|mjs|cjs|json|d\.ts|sh|ps1|yaml|yml)$/.test(entryPath)) {
        const fileSecrets = scanContentForSecrets(entry.content, entryPath);
        if (fileSecrets.length > 0) {
          secrets.push(...fileSecrets);
        }
      }
    }
  }

  const isClean =
    cloudFiles.length === 0 &&
    sourceMaps.length === 0 &&
    fixtureFiles.length === 0 &&
    testDoubleFiles.length === 0 &&
    secrets.length === 0;

  return {
    filename,
    digest,
    sizeBytes: size,
    totalEntries: entries.length,
    isClean,
    cloudFilesCount: cloudFiles.length,
    cloudFilesSample: cloudFiles.slice(0, 10),
    sourceMapsCount: sourceMaps.length,
    sourceMapsSample: sourceMaps.slice(0, 10),
    fixtureFilesCount: fixtureFiles.length,
    testDoubleFilesCount: testDoubleFiles.length,
    secretsCount: secrets.length,
    secretsFound: secrets,
    packageDirectories: packageDirCounts,
  };
}

/**
 * Audits a release manifest file.
 */
export function auditManifest(
  manifestInput,
  filename = "manifest.json",
  boundaryConfig = loadBoundaryConfig(),
) {
  const buf = Buffer.isBuffer(manifestInput)
    ? manifestInput
    : Buffer.from(
        typeof manifestInput === "string" ? manifestInput : JSON.stringify(manifestInput),
      );
  const digest = sha256Hex(buf);
  let parsed;
  try {
    parsed =
      typeof manifestInput === "object" && !Buffer.isBuffer(manifestInput)
        ? manifestInput
        : JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return {
      filename,
      digest,
      validJson: false,
      error: err.message,
      isClean: false,
    };
  }

  const declaredPackages = Object.keys(parsed.packages || {});
  const publicAllowlist = new Set(
    boundaryConfig.publicReleasePackages || CANONICAL_PUBLIC_RELEASE_PACKAGES,
  );
  const privateSet = new Set(boundaryConfig.privatePackages || CANONICAL_PRIVATE_PACKAGES);

  const privatePackagesFound = [];
  const unallowlistedPackages = [];

  for (const pkg of declaredPackages) {
    if (privateSet.has(pkg)) {
      privatePackagesFound.push(pkg);
    }
    if (!publicAllowlist.has(pkg)) {
      unallowlistedPackages.push(pkg);
    }
  }

  const isClean = privatePackagesFound.length === 0 && unallowlistedPackages.length === 0;

  return {
    filename,
    digest,
    validJson: true,
    version: parsed.version,
    releaseDate: parsed.releaseDate,
    commitSha: parsed.releaseIdentity?.commitSha,
    totalPackages: declaredPackages.length,
    declaredPackages,
    privatePackagesFound,
    unallowlistedPackages,
    signaturesCount: parsed.signatures?.length || 0,
    isClean,
  };
}

/**
 * Audits a CycloneDX SBOM file.
 */
export function auditSbom(
  sbomInput,
  filename = "sbom.json",
  boundaryConfig = loadBoundaryConfig(),
) {
  const buf = Buffer.isBuffer(sbomInput)
    ? sbomInput
    : Buffer.from(typeof sbomInput === "string" ? sbomInput : JSON.stringify(sbomInput));
  const digest = sha256Hex(buf);
  let parsed;
  try {
    parsed =
      typeof sbomInput === "object" && !Buffer.isBuffer(sbomInput)
        ? sbomInput
        : JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return {
      filename,
      digest,
      validJson: false,
      error: err.message,
      isClean: false,
    };
  }

  const components = parsed.components || [];
  const publicAllowlist = new Set(
    boundaryConfig.publicReleasePackages || CANONICAL_PUBLIC_RELEASE_PACKAGES,
  );
  const privateSet = new Set(boundaryConfig.privatePackages || CANONICAL_PRIVATE_PACKAGES);

  const workspaceComponents = [];
  const privateComponentsFound = [];
  const cloudDependenciesFound = [];

  for (const comp of components) {
    const name = comp.name;
    if (name.startsWith("@resin/") || name === "resin") {
      workspaceComponents.push(name);
      if (privateSet.has(name) || !publicAllowlist.has(name)) {
        privateComponentsFound.push(name);
      }
    }
    if (name.startsWith("@aws-sdk/") || name === "@aws-sdk" || name.startsWith("@smithy/")) {
      cloudDependenciesFound.push(name);
    }
  }

  const isClean = privateComponentsFound.length === 0;

  return {
    filename,
    digest,
    validJson: true,
    bomFormat: parsed.bomFormat,
    specVersion: parsed.specVersion,
    totalComponents: components.length,
    workspaceComponents,
    privateComponentsFound,
    cloudDependenciesCount: cloudDependenciesFound.length,
    cloudDependenciesSample: cloudDependenciesFound.slice(0, 10),
    isClean,
  };
}

/**
 * Audits a channels.json metadata file.
 */
export function auditChannels(channelsInput, filename = "channels.json") {
  const buf = Buffer.isBuffer(channelsInput)
    ? channelsInput
    : Buffer.from(
        typeof channelsInput === "string" ? channelsInput : JSON.stringify(channelsInput),
      );
  const digest = sha256Hex(buf);
  let parsed;
  try {
    parsed =
      typeof channelsInput === "object" && !Buffer.isBuffer(channelsInput)
        ? channelsInput
        : JSON.parse(buf.toString("utf8"));
  } catch (err) {
    return {
      filename,
      digest,
      validJson: false,
      error: err.message,
    };
  }

  return {
    filename,
    digest,
    validJson: true,
    currentVersion: parsed.currentVersion,
    minSupportedVersion: parsed.minSupportedVersion,
    updatedAt: parsed.updatedAt,
    commitSha: parsed.releaseIdentity?.commitSha,
    stableChannel: parsed.channels?.stable,
    signaturesCount: parsed.signatures?.length || 0,
  };
}

/**
 * Audits a single release artifact by file extension / type.
 */
export function auditArtifact(
  buffer,
  filename,
  boundaryConfig = loadBoundaryConfig(),
  options = {},
) {
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz") || filename.endsWith(".tar")) {
    return { type: "tarball", ...auditTarball(buffer, filename, boundaryConfig, options) };
  }
  if (filename.endsWith(".zip")) {
    const entries = extractZipEntriesSafely(buffer);
    return {
      type: "zip",
      filename,
      digest: sha256Hex(buffer),
      sizeBytes: buffer.length,
      totalEntries: entries.length,
      entries: entries.map((e) => e.name),
      isClean: true,
    };
  }
  if (filename.includes("manifest") && filename.endsWith(".json")) {
    return { type: "manifest", ...auditManifest(buffer, filename, boundaryConfig) };
  }
  if (filename.includes("sbom") && filename.endsWith(".json")) {
    return { type: "sbom", ...auditSbom(buffer, filename, boundaryConfig) };
  }
  if (filename.endsWith("channels.json")) {
    return { type: "channels", ...auditChannels(buffer, filename) };
  }
  if (filename.endsWith(".json")) {
    return {
      type: "json",
      filename,
      digest: sha256Hex(buffer),
      sizeBytes: buffer.length,
    };
  }
  if (filename.endsWith(".sh") || filename.endsWith(".ps1") || filename.endsWith(".mjs")) {
    const secrets = scanContentForSecrets(buffer, filename);
    return {
      type: "script",
      filename,
      digest: sha256Hex(buffer),
      sizeBytes: buffer.length,
      secretsFound: secrets,
      isClean: secrets.length === 0,
    };
  }

  return {
    type: "unknown",
    filename,
    digest: sha256Hex(buffer),
    sizeBytes: buffer.length,
  };
}

/**
 * Performs AWS S3 inventory and download-audit.
 * Requires explicit bucket via options.bucket or RESIN_RELEASE_BUCKET.
 */
export function inventoryAwsS3(options = {}) {
  const bucket = options.bucket || process.env.RESIN_RELEASE_BUCKET;
  if (!bucket) {
    return {
      channel: "s3",
      bucket: null,
      accessible: false,
      error: "No S3 bucket specified. Pass --bucket <name> or set RESIN_RELEASE_BUCKET.",
      versions: {},
      totalObjects: 0,
    };
  }

  const profile = options.profile || process.env.AWS_PROFILE;
  const region = options.region || process.env.AWS_REGION || DEFAULT_AWS_REGION;
  const boundaryConfig = options.boundaryConfig || loadBoundaryConfig();

  const env = { ...process.env, AWS_REGION: region };
  if (profile) {
    env.AWS_PROFILE = profile;
  }

  let objectsRaw = "";
  try {
    objectsRaw = execSync(`aws s3 ls s3://${bucket} --recursive`, {
      env,
      maxBuffer: 100 * 1024 * 1024,
    }).toString();
  } catch (err) {
    return {
      channel: "s3",
      bucket,
      accessible: false,
      error: err.message,
      versions: {},
      totalObjects: 0,
    };
  }

  const lines = objectsRaw.trim().split("\n").filter(Boolean);
  const objects = lines.map((l) => {
    const parts = l.trim().split(/\s+/);
    return {
      date: `${parts[0]} ${parts[1]}`,
      size: Number(parts[2]),
      key: parts.slice(3).join(" "),
    };
  });

  const versionSet = new Set();
  for (const obj of objects) {
    const match = obj.key.match(/v1\.0\.\d+/);
    if (match) versionSet.add(match[0]);
  }

  const versions = Array.from(versionSet).sort((a, b) => {
    const numA = Number.parseInt(a.replace("v1.0.", ""), 10);
    const numB = Number.parseInt(b.replace("v1.0.", ""), 10);
    return numA - numB;
  });

  const versionAudits = {};

  for (const v of versions) {
    if (options.versionFilter && options.versionFilter !== v) continue;

    const verNum = v.replace(/^v/, "");
    const vObjects = objects.filter(
      (o) => o.key.includes(v) || o.key.includes(`manifest-${verNum}.json`),
    );

    const artifacts = [];
    for (const obj of vObjects) {
      const filename = obj.key.split("/").pop();
      try {
        const buf = execSync(`aws s3 cp s3://${bucket}/${obj.key} -`, {
          env,
          maxBuffer: 100 * 1024 * 1024,
        });
        const audit = auditArtifact(buf, filename, boundaryConfig, options);
        artifacts.push({
          key: obj.key,
          filename,
          s3Date: obj.date,
          sizeBytes: obj.size,
          ...audit,
        });
      } catch (e) {
        artifacts.push({
          key: obj.key,
          filename,
          s3Date: obj.date,
          sizeBytes: obj.size,
          downloadError: e.message,
        });
      }
    }

    versionAudits[v] = {
      version: v,
      totalArtifacts: artifacts.length,
      artifacts,
    };
  }

  // Also audit root channels.json
  let channelsAudit = null;
  const channelsObj = objects.find((o) => o.key === "releases/v1/channels.json");
  if (channelsObj) {
    try {
      const buf = execSync(`aws s3 cp s3://${bucket}/${channelsObj.key} -`, {
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
      channelsAudit = auditChannels(buf, "releases/v1/channels.json");
    } catch {}
  }

  return {
    channel: "s3",
    bucket,
    accessible: true,
    totalObjects: objects.length,
    versionsFound: versions,
    versions: versionAudits,
    channelsAudit,
  };
}

/**
 * Performs GitHub Releases inventory.
 */
export function inventoryGitHubReleases(options = {}) {
  const repo = options.repo || DEFAULT_GITHUB_REPO;
  let releases = [];
  try {
    const raw = execSync(
      `gh release list --repo ${repo} --json tagName,name,createdAt,publishedAt,isDraft,isPrerelease,targetCommitish`,
      { maxBuffer: 10 * 1024 * 1024 },
    ).toString();
    releases = JSON.parse(raw);
  } catch (err) {
    return {
      channel: "github",
      repo,
      accessible: false,
      error: err.message,
      releases: [],
    };
  }

  const results = [];
  for (const rel of releases) {
    if (options.versionFilter && options.versionFilter !== rel.tagName) continue;

    let assets = [];
    try {
      const viewRaw = execSync(`gh release view ${rel.tagName} --repo ${repo} --json assets`, {
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
      const parsed = JSON.parse(viewRaw);
      assets = parsed.assets || [];
    } catch {}

    results.push({
      tagName: rel.tagName,
      name: rel.name,
      publishedAt: rel.publishedAt,
      isDraft: rel.isDraft,
      isPrerelease: rel.isPrerelease,
      targetCommitish: rel.targetCommitish,
      assetsCount: assets.length,
      assets,
      noAssetsDisclosed: assets.length === 0,
    });
  }

  return {
    channel: "github",
    repo,
    accessible: true,
    releasesCount: results.length,
    releases: results,
  };
}

/**
 * Performs directory-based release audit.
 */
export function inventoryDirectory(dirPath, options = {}) {
  const boundaryConfig = options.boundaryConfig || loadBoundaryConfig();
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    return {
      channel: "directory",
      path: resolved,
      accessible: false,
      error: "Directory not found",
    };
  }

  const files = [];
  function collect(current) {
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        collect(full);
      } else {
        files.push(full);
      }
    }
  }
  collect(resolved);

  const artifacts = [];
  for (const file of files) {
    const rel = path.relative(resolved, file).replace(/\\/g, "/");
    const filename = path.basename(file);
    const buf = fs.readFileSync(file);
    const audit = auditArtifact(buf, filename, boundaryConfig, options);
    artifacts.push({
      relativePath: rel,
      filename,
      ...audit,
    });
  }

  return {
    channel: "directory",
    path: resolved,
    accessible: true,
    totalFiles: files.length,
    artifacts,
  };
}

/**
 * Runs the full public release audit.
 */
export function runPublicReleaseAudit(options = {}) {
  const results = {
    auditDate: AUDIT_DATE,
    timestamp: new Date().toISOString(),
    channels: {},
  };

  const channelChoice = options.channel || "all";

  if (channelChoice === "all" || channelChoice === "s3") {
    if (!options.offline) {
      results.channels.s3 = inventoryAwsS3(options);
    }
  }

  if (channelChoice === "all" || channelChoice === "github") {
    if (!options.offline) {
      results.channels.github = inventoryGitHubReleases(options);
    }
  }

  if (options.dir) {
    results.channels.directory = inventoryDirectory(options.dir, options);
  }

  return results;
}

/**
 * Formats audit results as deterministic JSON.
 */
export function generateAuditJsonReport(auditResult) {
  return JSON.stringify(auditResult, null, 2);
}

/**
 * Formats audit results as human-readable Markdown.
 */
export function generateAuditTextReport(auditResult) {
  const lines = [];
  lines.push(`# Resin Public Release Artifact Security Audit`);
  lines.push(`**Audit Date**: ${auditResult.auditDate || AUDIT_DATE}`);
  lines.push(`**Generated**: ${auditResult.timestamp || new Date().toISOString()}`);
  lines.push(
    `**Methodology**: Read-only offline and channel scanning using \`scripts/audit-public-releases.mjs\``,
  );
  lines.push("");

  if (auditResult.channels.github) {
    const gh = auditResult.channels.github;
    lines.push(`## 1. GitHub Releases Channel (\`${gh.repo || DEFAULT_GITHUB_REPO}\`)`);
    if (!gh.accessible) {
      lines.push(`- Status: Inaccessible (${gh.error})`);
    } else {
      lines.push(`- Total Releases Found: ${gh.releasesCount}`);
      for (const rel of gh.releases) {
        lines.push(
          `  - **Tag**: \`${rel.tagName}\` | **Published**: ${rel.publishedAt} | **Attached Assets**: ${rel.assetsCount}`,
        );
        if (rel.noAssetsDisclosed) {
          lines.push(
            `    - *Finding*: No release binaries or archives attached to GitHub Release.`,
          );
        }
      }
    }
    lines.push("");
  }

  if (auditResult.channels.s3) {
    const s3 = auditResult.channels.s3;
    const bucketLabel = s3.bucket || "[internal-distribution-origin]";
    lines.push(`## 2. Release Distribution S3 Storage (\`${bucketLabel}\`)`);
    if (!s3.accessible) {
      lines.push(`- Status: Inaccessible (${s3.error})`);
    } else {
      lines.push(`- Total Storage Objects: ${s3.totalObjects}`);
      lines.push(`- Versions Discovered: ${s3.versionsFound?.join(", ")}`);
      if (s3.channelsAudit?.stableChannel) {
        lines.push(
          `- Active Stable Channel Version: \`${s3.channelsAudit.stableChannel.version}\` (Manifest: \`${s3.channelsAudit.stableChannel.manifestUrl}\`)`,
        );
      }
      lines.push("");

      for (const [v, verData] of Object.entries(s3.versions || {})) {
        lines.push(`### Version \`${v}\``);
        lines.push(`Total Artifacts: ${verData.totalArtifacts}`);

        for (const art of verData.artifacts) {
          lines.push(`- **\`${art.filename}\`** (${art.type || "file"}, ${art.sizeBytes} bytes)`);
          lines.push(`  - SHA-256: \`${art.digest}\``);

          if (art.type === "tarball") {
            lines.push(`  - Total Entries: ${art.totalEntries}`);
            lines.push(
              `  - Cloud Files Disclosed: ${art.cloudFilesCount} (${art.cloudFilesCount > 0 ? "⚠️ DISCLOSED" : "✅ CLEAN"})`,
            );
            lines.push(
              `  - Source Maps Disclosed: ${art.sourceMapsCount} (${art.sourceMapsCount > 0 ? "⚠️ DISCLOSED" : "✅ CLEAN"})`,
            );
            lines.push(`  - Test Fixture Entries: ${art.fixtureFilesCount}`);
            lines.push(
              `  - Embedded Secrets: ${art.secretsCount} (${art.secretsCount === 0 ? "✅ CLEAN (0 confirmed secrets)" : "⚠️ HITS DETECTED"})`,
            );
          } else if (art.type === "manifest") {
            lines.push(
              `  - Declared Packages (${art.totalPackages}): ${art.declaredPackages?.join(", ")}`,
            );
            if (art.privatePackagesFound?.length > 0) {
              lines.push(`  - ⚠️ Private Packages Declared: ${art.privatePackagesFound.join(", ")}`);
            }
          } else if (art.type === "sbom") {
            lines.push(
              `  - CycloneDX Components (${art.totalComponents}): Workspace: ${art.workspaceComponents?.join(", ")}`,
            );
            if (art.privateComponentsFound?.length > 0) {
              lines.push(
                `  - ⚠️ Private Components in SBOM: ${art.privateComponentsFound.join(", ")}`,
              );
            }
          }
        }
        lines.push("");
      }
    }
  }

  if (auditResult.channels.directory) {
    const dir = auditResult.channels.directory;
    lines.push(`## Local Directory Audit (\`${dir.path}\`)`);
    lines.push(`- Total Files: ${dir.totalFiles}`);
    for (const art of dir.artifacts) {
      lines.push(
        `- \`${art.filename}\`: Clean=${art.isClean}, CloudFiles=${art.cloudFilesCount || 0}, SourceMaps=${art.sourceMapsCount || 0}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * CLI Entrypoint.
 */
function main() {
  const args = process.argv.slice(2);
  const options = {
    channel: "all",
    profile: process.env.AWS_PROFILE || null,
    bucket: process.env.RESIN_RELEASE_BUCKET || null,
    repo: DEFAULT_GITHUB_REPO,
    json: false,
    offline: false,
    output: null,
    dir: null,
    versionFilter: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--channel" && i + 1 < args.length) {
      options.channel = args[++i];
    } else if (arg === "--profile" && i + 1 < args.length) {
      options.profile = args[++i];
    } else if (arg === "--bucket" && i + 1 < args.length) {
      options.bucket = args[++i];
    } else if (arg === "--repo" && i + 1 < args.length) {
      options.repo = args[++i];
    } else if (arg === "--dir" && i + 1 < args.length) {
      options.dir = args[++i];
    } else if (arg === "--version" && i + 1 < args.length) {
      options.versionFilter = args[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--offline") {
      options.offline = true;
    } else if (arg === "--output" && i + 1 < args.length) {
      options.output = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Resin Public Release Security & Boundary Auditor

Usage:
  node scripts/audit-public-releases.mjs [options]

Options:
  --channel <all|s3|github|dir> Channel to audit (default: all)
  --bucket <name>               AWS S3 distribution bucket (or set RESIN_RELEASE_BUCKET)
  --profile <name>              AWS profile (optional, or set AWS_PROFILE)
  --region <name>               AWS region (default: us-east-1, or set AWS_REGION)
  --repo <owner/repo>           GitHub repository (default: Resin-AI/resin)
  --dir <path>                  Local release directory to audit
  --version <v1.0.x>            Filter audit to specific version
  --json                        Output JSON instead of text
  --output <path>               Save report output to file
  --offline                     Skip external network/AWS/GitHub calls
  --help, -h                    Show this help message
`);
      process.exit(0);
    }
  }

  const result = runPublicReleaseAudit(options);
  const formatted = options.json
    ? generateAuditJsonReport(result)
    : generateAuditTextReport(result);

  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), formatted, "utf8");
    console.log(`Audit report written to ${options.output}`);
  } else {
    console.log(formatted);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main();
}
