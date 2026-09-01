#!/usr/bin/env node

/**
 * Resin Public Release Publisher
 *
 * Fixed CLI Modes & Library API:
 * 1. mirror-runtimes: Mirror and verify all 4 pinned upstream Deno runtimes to S3.
 * 2. verify-candidate: Verify candidate package integrity, signatures, and assets before upload.
 * 3. publish-immutable: Upload immutable release objects to S3 with HEAD-before-PUT and immutable cache-control.
 * 4. verify-public: Anonymous manual-redirect public CDN verification with zero credentials.
 * 5. promote: Receipt-gated channels.json promotion with CloudFront invalidation.
 * 6. record-smoke: Post-promotion smoke verification recording public-release-smoke.json.
 * 7. freeze: Emergency signed freeze notice publication, version revocation, and anonymous verification.
 */

import { execFile as defaultExecFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import zlib from "node:zlib";

import {
  PINNED_DENO_RUNTIME,
  PINNED_DENO_UPSTREAM_ASSETS,
  PLATFORMS,
  RELEASE_VERSION,
  createDeterministicTar,
  extractTarEntries,
  gzipDeterministic,
} from "./package-release.mjs";
import {
  DEFAULT_CHANNEL_TTL_MS,
  DEFAULT_MANIFEST_TTL_MS,
  RELEASE_SIGNING_ALGORITHM,
  REVOKED_RELEASE_KEY_IDS,
  canonicalJson,
  createSignedFreezeNotice,
  createTestReleaseSigningKey,
  loadReleaseSigningKeyFromEnv,
  loadTrustedReleaseKeysFromEnv,
  signReleasePayload,
  trustedKeysFromSigningKey,
  verifyReleasePayloadSignature,
  verifySignedFreezeNotice,
} from "./release-trust.mjs";

const execFileAsync = promisify(defaultExecFile);

export const IMMUTABLE_CACHE_CONTROL = "public,max-age=31536000,immutable";
export const CHANNELS_CACHE_CONTROL = "public,max-age=60,s-maxage=60,must-revalidate";
export const PRODUCTION_BASE_URL = "https://dist.resin.sh";
export const CHANNELS_S3_KEY = "releases/v1/channels.json";
export const CHANNELS_INVALIDATION_PATH = "/releases/v1/channels.json";

export const REQUIRED_RUNTIME_PLATFORMS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

export const REQUIRED_ARTIFACT_PLATFORMS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl-x64",
]);

export const PUBLISHER_MODES = Object.freeze([
  "mirror-runtimes",
  "verify-candidate",
  "publish-immutable",
  "verify-public",
  "promote",
  "record-smoke",
  "freeze",
]);

export const INSTALLER_FILENAMES = Object.freeze([
  "install.sh",
  "install.ps1",
  "install-helper-v1.mjs",
]);

export const CONTRACTED_INSTALLERS = Object.freeze(["posix", "powershell"]);

/**
 * Loads and parses installer results if passed as a file path or JSON string.
 */
export function loadInstallerResults(input) {
  if (input === null || input === undefined) return null;
  if (Array.isArray(input)) return input;
  if (input !== null && Object.prototype.toString.call(input) === "[object Object]") {
    if (Array.isArray(input.results)) return input.results;
    return input;
  }
  if (Object.prototype.toString.call(input) === "[object String]") {
    const trimmed = input.trim();
    if (fs.existsSync(trimmed)) {
      try {
        const content = fs.readFileSync(trimmed, "utf8");
        return JSON.parse(content);
      } catch (err) {
        throw new Error(
          `Failed to parse installer results JSON from file '${trimmed}': ${err.message}`,
        );
      }
    }
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse installer results JSON: ${err.message}`);
    }
  }
  throw new Error(`Unsupported installer results input type: ${input?.constructor?.name ?? input}`);
}

/**
 * Strictly validates an installer results array according to contract schema:
 * - Must be an array of exactly 2 objects: "posix" and "powershell".
 * - No unknown, duplicate, or missing installer names.
 * - Each item:
 *   - installer: "posix" | "powershell"
 *   - status: "PASSED" | "FAILED"
 *   - installedVersion: string | null
 *   - entrypointUrl: valid HTTPS string
 *   - durationMs: non-negative number
 *   - error: string | null
 */
export function validateInstallerResults(results) {
  if (results === null || results === undefined) return null;
  if (!Array.isArray(results)) {
    throw new Error("Installer results must be an array of exactly two installer objects.");
  }
  if (results.length !== 2) {
    throw new Error(
      `Installer results must contain exactly two installer objects ('posix' and 'powershell'), received ${results.length}.`,
    );
  }

  const seen = new Set();
  const validated = [];

  for (let idx = 0; idx < results.length; idx++) {
    const item = results[idx];
    if (
      !item ||
      Array.isArray(item) ||
      Object.prototype.toString.call(item) !== "[object Object]"
    ) {
      throw new Error(`Installer result at index ${idx} must be a non-null object.`);
    }

    if (Object.prototype.toString.call(item.installer) !== "[object String]") {
      throw new Error(`Installer result at index ${idx} missing required 'installer' field.`);
    }

    if (!CONTRACTED_INSTALLERS.includes(item.installer)) {
      throw new Error(
        `Unknown installer '${item.installer}'. Allowed installers: ${CONTRACTED_INSTALLERS.join(", ")}.`,
      );
    }

    if (seen.has(item.installer)) {
      throw new Error(`Duplicate installer result for '${item.installer}'.`);
    }
    seen.add(item.installer);

    if (item.status !== "PASSED" && item.status !== "FAILED") {
      throw new Error(
        `Installer result for '${item.installer}' has invalid status '${item.status}'. Allowed: PASSED, FAILED.`,
      );
    }

    if (
      Object.prototype.toString.call(item.installedVersion) !== "[object String]" &&
      item.installedVersion !== null
    ) {
      throw new Error(
        `Installer result for '${item.installer}' installedVersion must be a string or null, received ${item.installedVersion?.constructor?.name ?? item.installedVersion}.`,
      );
    }

    if (
      Object.prototype.toString.call(item.entrypointUrl) !== "[object String]" ||
      !item.entrypointUrl.trim()
    ) {
      throw new Error(`Installer result for '${item.installer}' missing required 'entrypointUrl'.`);
    }

    try {
      const parsedUrl = new URL(item.entrypointUrl);
      if (parsedUrl.protocol !== "https:") {
        throw new Error(
          `Installer result for '${item.installer}' entrypointUrl must use HTTPS, received '${item.entrypointUrl}'.`,
        );
      }
    } catch (err) {
      if (err.message.includes("must use HTTPS")) throw err;
      throw new Error(
        `Installer result for '${item.installer}' has invalid entrypointUrl '${item.entrypointUrl}': ${err.message}`,
      );
    }

    if (!Number.isFinite(item.durationMs) || Number.isNaN(item.durationMs) || item.durationMs < 0) {
      throw new Error(
        `Installer result for '${item.installer}' durationMs must be a non-negative number, received ${item.durationMs}.`,
      );
    }

    if (Object.prototype.toString.call(item.error) !== "[object String]" && item.error !== null) {
      throw new Error(
        `Installer result for '${item.installer}' error must be a string or null, received ${item.error?.constructor?.name ?? item.error}.`,
      );
    }

    validated.push({
      installer: item.installer,
      status: item.status,
      installedVersion: item.installedVersion,
      entrypointUrl: item.entrypointUrl,
      durationMs: item.durationMs,
      error: item.error,
    });
  }

  for (const required of CONTRACTED_INSTALLERS) {
    if (!seen.has(required)) {
      throw new Error(`Installer results missing required '${required}' record.`);
    }
  }

  return validated;
}

export function sha256Hex(data) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data))
    .digest("hex");
}

export function fileSha256(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

export function validatePathSafety(relPath, label = "path") {
  if (
    Object.prototype.toString.call(relPath) !== "[object String]" ||
    relPath.trim().length === 0
  ) {
    throw new Error(`Invalid empty ${label}.`);
  }
  const normalized = relPath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Path traversal or invalid absolute ${label} detected: '${relPath}'.`);
  }
  return normalized;
}

export const DRY_RUN_TOKEN_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Strictly normalizes and validates release S3 object key prefix according to contract:
 * - Empty string ("") for production releases (fixed-root releases/v1/*).
 * - Exact "dry-runs/<token>" for disposable staging runs, where token matches [A-Za-z0-9][A-Za-z0-9._-]{0,127}.
 * - Rejects slashes after dry-runs/, dot segments (., ..), percent-encoding, null bytes, backslashes, leading/trailing separators.
 * - In production mode, strictly rejects non-empty key prefix.
 */
export function validateKeyPrefix(keyPrefix, options = {}) {
  const isProduction =
    options.isProduction === true ||
    options.environment === "production" ||
    process.env.RESIN_ENVIRONMENT === "production" ||
    process.env.TARGET_ENV === "production" ||
    (options.testOnly === false &&
      options.environment !== "staging" &&
      options.environment !== "test");

  if (keyPrefix === undefined || keyPrefix === null || keyPrefix === "") {
    return "";
  }

  if (Object.prototype.toString.call(keyPrefix) !== "[object String]") {
    throw new Error(
      `Invalid keyPrefix type: expected string, received ${keyPrefix?.constructor?.name ?? keyPrefix}.`,
    );
  }

  const trimmed = keyPrefix.trim();
  if (trimmed === "") {
    return "";
  }

  if (isProduction) {
    throw new Error(
      `Production release rejects non-empty key prefix '${trimmed}'. Production objects must be written to fixed root 'releases/v1/*'.`,
    );
  }

  if (trimmed.includes("\\")) {
    throw new Error(`Invalid key prefix '${trimmed}': backslashes are not permitted.`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`Invalid key prefix '${trimmed}': null bytes are not permitted.`);
  }
  if (trimmed.includes("%")) {
    throw new Error(`Invalid key prefix '${trimmed}': percent-encoding is not permitted.`);
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new Error(
      `Invalid key prefix '${trimmed}': leading and trailing slashes are not permitted.`,
    );
  }
  if (!trimmed.startsWith("dry-runs/")) {
    throw new Error(
      `Invalid key prefix '${trimmed}': non-empty prefix must start with 'dry-runs/'.`,
    );
  }

  const token = trimmed.slice("dry-runs/".length);
  if (!token) {
    throw new Error(`Invalid key prefix '${trimmed}': missing token after 'dry-runs/'.`);
  }
  if (token.includes("/")) {
    throw new Error(
      `Invalid key prefix '${trimmed}': multiple path segments / slashes after 'dry-runs/' are not permitted.`,
    );
  }
  if (token === "." || token === ".." || token.includes("..")) {
    throw new Error(
      `Invalid key prefix '${trimmed}': dot segments / relative path traversal are not permitted.`,
    );
  }
  if (!DRY_RUN_TOKEN_REGEX.test(token)) {
    throw new Error(
      `Invalid key prefix token '${token}': must match [A-Za-z0-9][A-Za-z0-9._-]{0,127} (length 1-128, starting with alphanumeric).`,
    );
  }

  return `dry-runs/${token}`;
}

export const normalizeKeyPrefix = validateKeyPrefix;

export function applyKeyPrefix(key, keyPrefix) {
  if (Object.prototype.toString.call(key) !== "[object String]" || key.length === 0) {
    throw new Error("Invalid empty S3 key.");
  }
  const cleanKey = key.replace(/^\/+/, "");
  const normalizedPrefix = keyPrefix ? normalizeKeyPrefix(keyPrefix) : "";
  if (!normalizedPrefix) {
    return cleanKey;
  }
  if (cleanKey.startsWith(`${normalizedPrefix}/`)) {
    return cleanKey;
  }
  return `${normalizedPrefix}/${cleanKey}`;
}

export function deriveInvalidationPath(key, keyPrefix) {
  const finalKey = keyPrefix !== undefined ? applyKeyPrefix(key, keyPrefix) : key;
  const cleanKey = finalKey.replace(/^\/+/, "");
  return `/${cleanKey}`;
}

export function derivePublicUrl(baseUrl, key, keyPrefix) {
  const cleanBase = (baseUrl || PRODUCTION_BASE_URL).replace(/\/+$/, "");
  const finalKey = keyPrefix !== undefined ? applyKeyPrefix(key, keyPrefix) : key;
  return `${cleanBase}/${finalKey.replace(/^\/+/, "")}`;
}

export function resolveSigningKey(options = {}) {
  if (options.keyPair) return options.keyPair;
  if (options.testOnly === true) return createTestReleaseSigningKey();
  return loadReleaseSigningKeyFromEnv();
}

export function resolveTrustedKeys(options = {}) {
  if (options.trustedKeys) return options.trustedKeys;
  if (options.keyPair) return trustedKeysFromSigningKey(options.keyPair);
  if (options.testOnly === true) {
    const testKey = createTestReleaseSigningKey();
    return trustedKeysFromSigningKey(testKey);
  }
  return loadTrustedReleaseKeysFromEnv();
}

export function writeReceipt(receiptDir, phase, data) {
  if (!receiptDir) return data;
  fs.mkdirSync(receiptDir, { recursive: true });
  const filename = `${phase}-receipt.json`;
  const filePath = path.join(receiptDir, filename);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return { ...data, receiptPath: filePath };
}

export function readReceipt(receiptDirOrFile, phase) {
  if (!receiptDirOrFile) return null;
  let targetFile = receiptDirOrFile;
  if (fs.existsSync(receiptDirOrFile) && fs.statSync(receiptDirOrFile).isDirectory()) {
    targetFile = path.join(receiptDirOrFile, `${phase}-receipt.json`);
  }
  if (!fs.existsSync(targetFile)) return null;
  return JSON.parse(fs.readFileSync(targetFile, "utf8"));
}

export function determineContentType(filePathOrKey) {
  const ext = path.extname(filePathOrKey).toLowerCase();
  if (filePathOrKey.endsWith(".tar.gz")) return "application/gzip";
  if (ext === ".json") return "application/json";
  if (ext === ".zip") return "application/zip";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".sh") return "text/x-shellscript";
  if (ext === ".ps1") return "text/plain";
  if (ext === ".mjs" || ext === ".js") return "application/javascript";
  return "application/octet-stream";
}

/**
 * AWS CLI abstraction executing via an injected runner or child_process.execFile.
 */
export async function runAwsCli(args, options = {}) {
  const runner = options.runner;
  if (
    runner instanceof Function ||
    Object.prototype.toString.call(runner) === "[object Function]"
  ) {
    return runner("aws", args, options);
  }
  try {
    const { stdout, stderr } = await execFileAsync("aws", args, {
      env: { ...process.env, ...options.env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (error) {
    const err = new Error(
      `AWS CLI failed: aws ${args.join(" ")}\n${error.stderr ? error.stderr.toString() : error.message}`,
    );
    err.exitCode = error.code ?? 1;
    err.stdout = error.stdout ? error.stdout.toString() : "";
    err.stderr = error.stderr ? error.stderr.toString() : "";
    throw err;
  }
}

export async function s3HeadObject(params, options = {}) {
  const { bucket, key } = params;
  validatePathSafety(key, "S3 key");
  const args = ["s3api", "head-object", "--bucket", bucket, "--key", key];
  if (options.region) args.push("--region", options.region);

  try {
    const result = await runAwsCli(args, options);
    let meta = {};
    try {
      meta = JSON.parse(result.stdout || "{}");
    } catch {
      meta = {};
    }
    return {
      exists: true,
      contentLength: meta.ContentLength !== undefined ? Number(meta.ContentLength) : undefined,
      eTag: meta.ETag ? String(meta.ETag).replace(/"/g, "") : undefined,
      cacheControl: meta.CacheControl,
      contentType: meta.ContentType,
      metadata: meta.Metadata || {},
    };
  } catch (error) {
    const errMsg = (error.stderr || error.message || "").toLowerCase();
    if (
      errMsg.includes("notfound") ||
      errMsg.includes("404") ||
      errMsg.includes("nosuchkey") ||
      error.exitCode === 254 ||
      error.exitCode === 255
    ) {
      return { exists: false };
    }
    throw error;
  }
}

export async function s3PutObject(params, options = {}) {
  const { bucket, key, filePath, body, cacheControl, contentType } = params;
  validatePathSafety(key, "S3 key");
  let tempFilePath = null;
  let uploadFilePath = filePath;

  if (!uploadFilePath && body !== undefined) {
    tempFilePath = path.join(
      os.tmpdir(),
      `resin-put-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    );
    fs.writeFileSync(tempFilePath, Buffer.isBuffer(body) ? body : Buffer.from(body));
    uploadFilePath = tempFilePath;
  }

  if (!uploadFilePath || !fs.existsSync(uploadFilePath)) {
    throw new Error(`Cannot put S3 object '${key}': source file missing.`);
  }

  const args = [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    uploadFilePath,
    "--cache-control",
    cacheControl || IMMUTABLE_CACHE_CONTROL,
    "--content-type",
    contentType || determineContentType(key),
  ];
  if (params.metadata && Object.prototype.toString.call(params.metadata) === "[object Object]") {
    const metaPairs = Object.entries(params.metadata)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    if (metaPairs) {
      args.push("--metadata", metaPairs);
    }
  }
  if (options.region) args.push("--region", options.region);

  try {
    const result = await runAwsCli(args, options);
    return { success: true, stdout: result.stdout };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // ignore
      }
    }
  }
}

export async function cloudFrontCreateInvalidation(params, options = {}) {
  const { distributionId, paths } = params;
  if (!distributionId) {
    throw new Error("CloudFront invalidation requires a valid distribution ID.");
  }
  const invalidationPaths = Array.isArray(paths) ? paths : [paths];
  const callerReference = `resin-inv-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const args = [
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    distributionId,
    "--paths",
    ...invalidationPaths,
  ];

  const result = await runAwsCli(args, options);
  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = {};
  }
  const invalidationId = parsed.Invalidation?.Id || callerReference;
  return {
    invalidationId,
    distributionId,
    paths: invalidationPaths,
    status: parsed.Invalidation?.Status || "InProgress",
  };
}

/**
 * Builds the deterministic upload plan for a release candidate.
 */
export function createUploadPlan(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const releaseDir =
    options.releaseDir ||
    options.distDir ||
    options.candidateDir ||
    path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  const runtimesDir = options.runtimesDir || path.resolve(rootDir, "dist/runtimes");
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, options);

  const manifestPath =
    options.manifestPath ||
    (fs.existsSync(path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`))
      ? path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`)
      : path.join(releaseDir, "manifest.json"));

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Release manifest not found at '${manifestPath}'.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestSha256 = fileSha256(manifestPath);
  const version = manifest.version || RELEASE_VERSION;

  const channelsPath = options.channelsPath || path.join(releaseDir, "channels.json");
  if (!fs.existsSync(channelsPath)) {
    throw new Error(`Release channels.json not found at '${channelsPath}'.`);
  }
  const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
  const channelsSha256 = fileSha256(channelsPath);

  const immutableUploads = [];

  // 1. Versioned manifest
  immutableUploads.push({
    type: "manifest",
    key: applyKeyPrefix(`releases/v1/manifests/manifest-${version}.json`, keyPrefix),
    filePath: manifestPath,
    sha256: manifestSha256,
    sizeBytes: fs.statSync(manifestPath).size,
    contentType: "application/json",
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    isImmutable: true,
  });

  // 2. Platform tarball artifacts
  for (const [platformId, asset] of Object.entries(manifest.assets || {})) {
    const filename = asset.filename;
    const localArtifactPath = path.join(releaseDir, filename);
    if (!fs.existsSync(localArtifactPath)) {
      throw new Error(
        `Release artifact for platform '${platformId}' missing: '${localArtifactPath}'.`,
      );
    }
    const sizeBytes = fs.statSync(localArtifactPath).size;
    const digest = fileSha256(localArtifactPath);
    if (asset.sha256 && digest !== asset.sha256) {
      throw new Error(
        `Release artifact SHA-256 mismatch for platform '${platformId}': expected ${asset.sha256}, got ${digest}.`,
      );
    }
    immutableUploads.push({
      type: "artifact",
      platform: platformId,
      key: applyKeyPrefix(`releases/v1/artifacts/v${version}/${filename}`, keyPrefix),
      filePath: localArtifactPath,
      sha256: digest,
      sizeBytes,
      contentType: determineContentType(filename),
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      isImmutable: true,
    });
  }

  // 3. Deno runtimes
  const denoRuntimes = manifest.runtimes?.deno || PINNED_DENO_RUNTIME;
  const denoVersion = denoRuntimes.version || PINNED_DENO_RUNTIME.version;
  for (const [platformId, runtimeAsset] of Object.entries(denoRuntimes.assets || {})) {
    const filename = runtimeAsset.filename;
    const candidateRuntimePaths = [
      options.runtimeAssets?.[platformId]?.filePath,
      path.join(releaseDir, filename),
      path.join(runtimesDir, filename),
      path.join(rootDir, "dist/runtimes", filename),
      path.join(rootDir, "dist/runtimes", `deno-v${denoVersion}`, filename),
      path.join(runtimesDir, `deno-v${denoVersion}`, filename),
    ].filter(Boolean);

    const runtimePath =
      candidateRuntimePaths.find((p) => fs.existsSync(p)) || candidateRuntimePaths[0];
    const expectedSha256 = runtimeAsset.sha256;

    let sizeBytes = 0;
    let digest = expectedSha256;
    if (fs.existsSync(runtimePath)) {
      sizeBytes = fs.statSync(runtimePath).size;
      digest = fileSha256(runtimePath);
      if (expectedSha256 && digest !== expectedSha256) {
        throw new Error(
          `Runtime artifact SHA-256 mismatch for '${filename}': expected ${expectedSha256}, got ${digest}.`,
        );
      }
    }

    immutableUploads.push({
      type: "runtime",
      platform: platformId,
      runtimeName: "deno",
      runtimeVersion: denoVersion,
      key: applyKeyPrefix(`releases/v1/runtimes/deno/v${denoVersion}/${filename}`, keyPrefix),
      filePath: runtimePath,
      sourceUrl:
        runtimeAsset.sourceUrl ||
        PINNED_DENO_UPSTREAM_ASSETS[platformId]?.sourceUrl ||
        `https://github.com/denoland/deno/releases/download/v${denoVersion}/${filename}`,
      sha256: digest,
      sizeBytes,
      contentType: "application/zip",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      isImmutable: true,
    });
  }

  // 4. Evidence files
  const evidenceFiles = [
    "release-evidence.json",
    "RELEASE-EVIDENCE.md",
    "sbom.json",
    "vulnerability-scan-evidence.json",
    "release-trust.json",
  ];
  for (const evidenceFilename of evidenceFiles) {
    const evPath = path.join(releaseDir, evidenceFilename);
    if (fs.existsSync(evPath)) {
      immutableUploads.push({
        type: "evidence",
        key: applyKeyPrefix(`releases/v1/evidence/v${version}/${evidenceFilename}`, keyPrefix),
        filePath: evPath,
        sha256: fileSha256(evPath),
        sizeBytes: fs.statSync(evPath).size,
        contentType: determineContentType(evidenceFilename),
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        isImmutable: true,
      });
    }
  }

  // 5. Installer assets (versioned immutable assets and mutable entrypoints)
  const candidateInstallerDirs = [
    options.installersDir
      ? path.isAbsolute(options.installersDir)
        ? options.installersDir
        : path.resolve(rootDir, options.installersDir)
      : null,
    path.resolve(releaseDir, "installers"),
    path.resolve(rootDir, "installers"),
    path.resolve(rootDir, "apps/cli/install"),
    path.resolve(process.cwd(), "apps/cli/install"),
    path.resolve(process.cwd(), "installers"),
  ].filter(Boolean);

  const installersDir =
    candidateInstallerDirs.find((d) => fs.existsSync(d)) ||
    (options.installersDir
      ? path.isAbsolute(options.installersDir)
        ? options.installersDir
        : path.resolve(rootDir, options.installersDir)
      : path.resolve(rootDir, "apps/cli/install"));

  const mutableInstallerUploads = [];
  for (const filename of INSTALLER_FILENAMES) {
    const candidatePaths = [
      options.installerAssets?.[filename]?.filePath,
      path.join(installersDir, filename),
      path.join(releaseDir, "installers", filename),
      path.join(rootDir, "installers", filename),
      path.join(rootDir, "apps/cli/install", filename),
      path.join(process.cwd(), "apps/cli/install", filename),
    ].filter(Boolean);

    const installerPath = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];

    let sizeBytes = 0;
    let digest = "";
    if (options.installerAssets?.[filename]?.buffer) {
      const buf = options.installerAssets[filename].buffer;
      sizeBytes = buf.length;
      digest = sha256Hex(buf);
    } else if (fs.existsSync(installerPath)) {
      sizeBytes = fs.statSync(installerPath).size;
      digest = fileSha256(installerPath);
    } else {
      throw new Error(`Installer asset '${filename}' not found at '${installerPath}'.`);
    }

    // Immutable versioned installer asset
    immutableUploads.push({
      type: "installer",
      name: filename,
      key: applyKeyPrefix(`releases/v1/installers/v${version}/${filename}`, keyPrefix),
      filePath: installerPath,
      sha256: digest,
      sizeBytes,
      contentType: determineContentType(filename),
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      isImmutable: true,
    });

    // Mutable installer entrypoint
    mutableInstallerUploads.push({
      type: "installer",
      name: filename,
      key: applyKeyPrefix(`releases/v1/installers/${filename}`, keyPrefix),
      filePath: installerPath,
      sha256: digest,
      sizeBytes,
      contentType: determineContentType(filename),
      cacheControl: CHANNELS_CACHE_CONTROL,
      isImmutable: false,
      invalidationPath: deriveInvalidationPath(`releases/v1/installers/${filename}`, keyPrefix),
    });
  }

  // 6. Candidate channel metadata
  const candidateChannelUpload = {
    type: "candidate-channel",
    key: applyKeyPrefix(`releases/v1/candidates/${manifestSha256}/channels.json`, keyPrefix),
    filePath: channelsPath,
    sha256: channelsSha256,
    sizeBytes: fs.statSync(channelsPath).size,
    contentType: "application/json",
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    isImmutable: true,
  };
  immutableUploads.push(candidateChannelUpload);

  // 7. Promoted mutable channel
  const mutableChannelUpload = {
    type: "channel",
    key: applyKeyPrefix(CHANNELS_S3_KEY, keyPrefix),
    filePath: channelsPath,
    sha256: channelsSha256,
    sizeBytes: fs.statSync(channelsPath).size,
    contentType: "application/json",
    cacheControl: CHANNELS_CACHE_CONTROL,
    isImmutable: false,
    invalidationPath: deriveInvalidationPath(CHANNELS_S3_KEY, keyPrefix),
  };

  return {
    version,
    keyPrefix,
    manifestSha256,
    channelsSha256,
    immutableUploads,
    mutableInstallerUploads,
    candidateChannelUpload,
    mutableChannelUpload,
    totalImmutableCount: immutableUploads.length,
  };
}

export async function mirrorRuntimes(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const denoVersion = options.denoVersion || PINNED_DENO_RUNTIME.version;
  const runtimesDir =
    options.runtimesDir || path.resolve(rootDir, "dist/runtimes", `deno-v${denoVersion}`);
  fs.mkdirSync(runtimesDir, { recursive: true });

  const bucket = options.bucket || process.env.RESIN_DISTRIBUTION_BUCKET;
  const fetchFn = options.fetch || globalThis.fetch;
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, options);
  const results = [];

  for (const platformId of REQUIRED_RUNTIME_PLATFORMS) {
    const upstream = PINNED_DENO_UPSTREAM_ASSETS[platformId];
    if (!upstream) {
      throw new Error(`Unsupported runtime platform '${platformId}'.`);
    }
    const localFilePath = path.join(runtimesDir, upstream.filename);
    let buffer = null;

    if (fs.existsSync(localFilePath)) {
      buffer = fs.readFileSync(localFilePath);
    } else if (options.runtimeAssets?.[platformId]?.buffer) {
      buffer = Buffer.from(options.runtimeAssets[platformId].buffer);
      fs.writeFileSync(localFilePath, buffer);
    } else {
      if (
        !(
          fetchFn instanceof Function ||
          Object.prototype.toString.call(fetchFn) === "[object Function]"
        )
      ) {
        throw new Error(`Fetch function required to download runtime for '${platformId}'.`);
      }
      const response = await fetchFn(upstream.sourceUrl, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(
          `Failed to download runtime from '${upstream.sourceUrl}': HTTP ${response.status} ${response.statusText}`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(localFilePath, buffer);
    }

    const computedSha256 = sha256Hex(buffer);
    if (computedSha256 !== upstream.sha256) {
      throw new Error(
        `Runtime SHA-256 mismatch for platform '${platformId}': expected ${upstream.sha256}, got ${computedSha256}.`,
      );
    }

    const s3Key = applyKeyPrefix(
      `releases/v1/runtimes/deno/v${denoVersion}/${upstream.filename}`,
      keyPrefix,
    );
    let uploadStatus = "local_only";

    if (bucket) {
      const head = await s3HeadObject({ bucket, key: s3Key }, options);
      if (head.exists) {
        if (head.contentLength !== undefined && head.contentLength !== buffer.length) {
          throw new Error(
            `Immutability violation / object clobbering rejected for '${s3Key}': existing size ${head.contentLength} != new size ${buffer.length}.`,
          );
        }
        uploadStatus = "skipped_identical";
      } else {
        await s3PutObject(
          {
            bucket,
            key: s3Key,
            filePath: localFilePath,
            cacheControl: IMMUTABLE_CACHE_CONTROL,
            contentType: "application/zip",
          },
          options,
        );
        uploadStatus = "uploaded";
      }
    }

    results.push({
      platform: platformId,
      filename: upstream.filename,
      sha256: computedSha256,
      sizeBytes: buffer.length,
      sourceUrl: upstream.sourceUrl,
      s3Key,
      uploadStatus,
    });
  }

  const receipt = {
    phase: "mirror-runtimes",
    timestamp: new Date().toISOString(),
    bucket: bucket || null,
    keyPrefix: keyPrefix || null,
    runtimes: results,
  };

  return writeReceipt(options.receiptDir, "mirror-runtimes", receipt);
}
/**
 * 2. Mode: verify-candidate
 * Unpacks candidate tarball (or verifies directory), enforces path traversal safety,
 * verifies Ed25519 signatures, platform assets, and metadata layout.
 */
export async function verifyCandidate(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, options);
  let candidateDir = options.candidateDir || options.releaseDir || options.distDir;
  let tempExtractDir = null;

  if (options.candidateTarball) {
    if (!fs.existsSync(options.candidateTarball)) {
      throw new Error(`Candidate tarball not found at '${options.candidateTarball}'.`);
    }
    const tarGzBuffer = fs.readFileSync(options.candidateTarball);
    const tarEntries = extractTarEntries(tarGzBuffer);

    // Enforce path traversal safety on every archive entry
    for (const entry of tarEntries) {
      const entryPath = entry.path || entry.name;
      validatePathSafety(entryPath, "candidate archive entry");
    }

    tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-candidate-verify-"));
    for (const entry of tarEntries) {
      const entryPath = entry.path || entry.name;
      if (entry.type === "dir" || entry.typeflag === "5" || entryPath.endsWith("/")) {
        fs.mkdirSync(path.join(tempExtractDir, entryPath), { recursive: true });
      } else {
        const fullPath = path.join(tempExtractDir, entryPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, entry.content);
      }
    }
    candidateDir = tempExtractDir;
  } else if (!candidateDir) {
    candidateDir = path.resolve(rootDir, "dist/release", `v${RELEASE_VERSION}`);
  }

  try {
    const releaseDir = fs.existsSync(path.join(candidateDir, "release"))
      ? path.join(candidateDir, "release")
      : candidateDir;

    const manifestPath = fs.existsSync(path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`))
      ? path.join(releaseDir, `manifest-${RELEASE_VERSION}.json`)
      : path.join(releaseDir, "manifest.json");

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Candidate manifest missing at '${manifestPath}'.`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const manifestSha256 = fileSha256(manifestPath);
    const trustedKeys = resolveTrustedKeys(options);

    // Verify manifest signature
    if (!Array.isArray(manifest.signatures) || manifest.signatures.length === 0) {
      throw new Error("Candidate manifest is unsigned.");
    }
    const { signatures: manifestSigs, ...manifestPayload } = manifest;
    const manifestSigResult = verifyReleasePayloadSignature(
      manifestPayload,
      manifestSigs[0],
      trustedKeys,
      options,
    );
    if (!manifestSigResult.valid) {
      throw new Error(
        `Candidate manifest signature verification failed: ${manifestSigResult.reason}`,
      );
    }

    // Verify all platform artifacts
    const verifiedAssets = [];
    for (const platformId of REQUIRED_ARTIFACT_PLATFORMS) {
      const asset = manifest.assets?.[platformId];
      if (!asset) {
        throw new Error(`Candidate manifest missing required asset platform '${platformId}'.`);
      }
      validatePathSafety(asset.filename, "manifest asset filename");
      const assetPath = path.join(releaseDir, asset.filename);
      if (!fs.existsSync(assetPath)) {
        throw new Error(`Candidate asset file missing on disk: '${assetPath}'.`);
      }
      const actualSize = fs.statSync(assetPath).size;
      const actualSha256 = fileSha256(assetPath);
      if (actualSha256 !== asset.sha256) {
        throw new Error(
          `Candidate asset digest mismatch for '${platformId}': expected ${asset.sha256}, got ${actualSha256}.`,
        );
      }
      if (asset.sizeBytes !== undefined && actualSize !== asset.sizeBytes) {
        throw new Error(
          `Candidate asset size mismatch for '${platformId}': expected ${asset.sizeBytes}, got ${actualSize}.`,
        );
      }
      // Check root-relative URL layout
      if (asset.url && !asset.url.startsWith(`/releases/v1/artifacts/v${manifest.version}/`)) {
        throw new Error(`Asset URL '${asset.url}' violates root-relative layout.`);
      }
      verifiedAssets.push({
        platform: platformId,
        filename: asset.filename,
        sha256: actualSha256,
        sizeBytes: actualSize,
      });
    }

    // Verify channels.json
    const channelsPath = path.join(releaseDir, "channels.json");
    if (!fs.existsSync(channelsPath)) {
      throw new Error(`Candidate channels.json missing at '${channelsPath}'.`);
    }
    const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
    const channelsSha256 = fileSha256(channelsPath);
    if (!Array.isArray(channels.signatures) || channels.signatures.length === 0) {
      throw new Error("Candidate channels.json is unsigned.");
    }
    const { signatures: chanSigs, ...chanPayload } = channels;
    const chanSigResult = verifyReleasePayloadSignature(
      chanPayload,
      chanSigs[0],
      trustedKeys,
      options,
    );
    if (!chanSigResult.valid) {
      throw new Error(`Candidate channels signature verification failed: ${chanSigResult.reason}`);
    }

    const stableManifestUrl = channels.channels?.stable?.manifestUrl;
    if (stableManifestUrl !== `/releases/v1/manifests/manifest-${manifest.version}.json`) {
      throw new Error(
        `Channel manifestUrl '${stableManifestUrl}' does not match expected '/releases/v1/manifests/manifest-${manifest.version}.json'.`,
      );
    }
    if (channels.channels?.stable?.manifestDigest !== manifestSha256) {
      throw new Error(
        `Channel manifestDigest '${channels.channels?.stable?.manifestDigest}' does not match manifest SHA-256 '${manifestSha256}'.`,
      );
    }

    const receipt = {
      phase: "verify-candidate",
      status: "verified",
      timestamp: new Date().toISOString(),
      keyPrefix: keyPrefix || null,
      releaseVersion: manifest.version,
      commitSha: manifest.releaseIdentity?.commitSha || null,
      manifestDigest: manifestSha256,
      channelsDigest: channelsSha256,
      verifiedAssets,
    };

    return writeReceipt(options.receiptDir, "verify-candidate", receipt);
  } finally {
    if (tempExtractDir && fs.existsSync(tempExtractDir)) {
      try {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 3. Mode: publish-immutable
 * Executes the upload plan for immutable objects using HEAD-before-PUT.
 * Fails closed on clobbering attempts with differing bytes. Never deletes.
 */
export async function publishImmutable(options = {}) {
  const bucket = options.bucket || process.env.RESIN_DISTRIBUTION_BUCKET;
  if (!bucket) {
    throw new Error(
      "RESIN_DISTRIBUTION_BUCKET environment variable or --bucket option is required.",
    );
  }

  const baseUrl = options.baseUrl || process.env.RESIN_DISTRIBUTION_BASE_URL;
  const isProduction =
    options.environment === "production" || process.env.RESIN_ENVIRONMENT === "production";
  if (isProduction && baseUrl && baseUrl !== PRODUCTION_BASE_URL) {
    throw new Error(
      `Production distribution base URL must be '${PRODUCTION_BASE_URL}', received '${baseUrl}'.`,
    );
  }
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, options);
  const plan = options.uploadPlan || createUploadPlan({ ...options, keyPrefix });
  const uploaded = [];
  const skipped = [];

  for (const item of plan.immutableUploads) {
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      throw new Error(`Cannot upload missing file '${item.filePath}' to '${item.key}'.`);
    }

    const head = await s3HeadObject({ bucket, key: item.key }, options);
    if (head.exists) {
      if (head.contentLength !== undefined && head.contentLength !== item.sizeBytes) {
        throw new Error(
          `Immutability violation / object clobbering rejected for key '${item.key}': existing size ${head.contentLength} bytes != candidate size ${item.sizeBytes} bytes.`,
        );
      }
      skipped.push({
        key: item.key,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes,
        reason: "identical_exists",
      });
    } else {
      await s3PutObject(
        {
          bucket,
          key: item.key,
          filePath: item.filePath,
          cacheControl: item.cacheControl || IMMUTABLE_CACHE_CONTROL,
          contentType: item.contentType,
        },
        options,
      );
      uploaded.push({ key: item.key, sha256: item.sha256, sizeBytes: item.sizeBytes });
    }
  }

  const receipt = {
    phase: "publish-immutable",
    status: "success",
    timestamp: new Date().toISOString(),
    bucket,
    keyPrefix: plan.keyPrefix ?? keyPrefix ?? null,
    baseUrl: baseUrl || null,
    manifestDigest: plan.manifestSha256,
    totalPlanned: plan.immutableUploads.length,
    uploadedCount: uploaded.length,
    skippedCount: skipped.length,
    uploaded,
    skipped,
    uploadPlan: plan,
  };

  return writeReceipt(options.receiptDir, "publish-immutable", receipt);
}

/**
 * 4. Mode: verify-public
 * Anonymous verification with manual redirects and zero credentials.
 * Asserts 200 OK, immutable cache-control, byte-for-byte digest/size parity, and signature validity.
 */
export async function verifyPublic(options = {}) {
  const baseUrl = (options.baseUrl || process.env.RESIN_DISTRIBUTION_BASE_URL || "").replace(
    /\/$/,
    "",
  );
  if (!baseUrl) {
    throw new Error(
      "RESIN_DISTRIBUTION_BASE_URL environment variable or --base-url option is required.",
    );
  }
  const isProduction =
    options.environment === "production" || process.env.RESIN_ENVIRONMENT === "production";
  if (isProduction && baseUrl !== PRODUCTION_BASE_URL) {
    throw new Error(
      `Production distribution base URL must be '${PRODUCTION_BASE_URL}', received '${baseUrl}'.`,
    );
  }

  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, options);
  const plan = options.uploadPlan || createUploadPlan({ ...options, keyPrefix });
  const fetchFn = options.fetch || globalThis.fetch;
  if (
    !(
      fetchFn instanceof Function || Object.prototype.toString.call(fetchFn) === "[object Function]"
    )
  ) {
    throw new Error("A valid fetch implementation is required for anonymous verification.");
  }

  const trustedKeys = resolveTrustedKeys(options);
  const verifiedObjects = [];

  for (const item of plan.immutableUploads) {
    const url = `${baseUrl}/${item.key.replace(/^\//, "")}`;

    // Anonymous request: NO credentials / Authorization header, manual redirect handling
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "*/*",
      },
    });

    if (response.status !== 200) {
      throw new Error(
        `Anonymous public verification failed for '${url}': HTTP ${response.status} ${response.statusText}`,
      );
    }

    const cacheControl = (
      response.headers?.get?.("cache-control") ||
      response.headers?.["cache-control"] ||
      ""
    ).toLowerCase();
    if (!cacheControl.includes("immutable") || !cacheControl.includes("max-age=31536000")) {
      throw new Error(
        `Cache-Control header violation on '${url}': expected 'public,max-age=31536000,immutable', got '${cacheControl}'.`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const bodyBuffer = Buffer.from(arrayBuffer);
    const actualDigest = sha256Hex(bodyBuffer);

    if (actualDigest !== item.sha256) {
      throw new Error(
        `Digest mismatch on public endpoint '${url}': expected ${item.sha256}, got ${actualDigest}.`,
      );
    }
    if (
      item.sizeBytes !== undefined &&
      item.sizeBytes > 0 &&
      bodyBuffer.length !== item.sizeBytes
    ) {
      throw new Error(
        `Size mismatch on public endpoint '${url}': expected ${item.sizeBytes} bytes, got ${bodyBuffer.length} bytes.`,
      );
    }

    // If manifest or candidate channel, verify cryptographic signature over downloaded body
    if (item.type === "manifest") {
      const parsedManifest = JSON.parse(bodyBuffer.toString("utf8"));
      const { signatures, ...payload } = parsedManifest;
      const sigResult = verifyReleasePayloadSignature(
        payload,
        signatures?.[0],
        trustedKeys,
        options,
      );
      if (!sigResult.valid) {
        throw new Error(
          `Public manifest signature verification failed for '${url}': ${sigResult.reason}`,
        );
      }
    } else if (item.type === "candidate-channel") {
      const parsedChannels = JSON.parse(bodyBuffer.toString("utf8"));
      const { signatures, ...payload } = parsedChannels;
      const sigResult = verifyReleasePayloadSignature(
        payload,
        signatures?.[0],
        trustedKeys,
        options,
      );
      if (!sigResult.valid) {
        throw new Error(
          `Public candidate channels signature verification failed for '${url}': ${sigResult.reason}`,
        );
      }
    }

    verifiedObjects.push({
      key: item.key,
      url,
      sha256: actualDigest,
      sizeBytes: bodyBuffer.length,
      cacheControl,
      verified: true,
    });
  }

  const receipt = {
    phase: "verify-public",
    status: "verified",
    timestamp: new Date().toISOString(),
    baseUrl,
    keyPrefix: plan.keyPrefix ?? keyPrefix ?? null,
    manifestDigest: plan.manifestSha256,
    verifiedCount: verifiedObjects.length,
    verifiedObjects,
  };

  return writeReceipt(options.receiptDir, "verify-public", receipt);
}

/**
 * Validates whether promotion can proceed based on the verify-public receipt.
 */
export function validatePromotionApproval(options = {}) {
  const isProduction =
    options.testOnly === false ||
    options.environment === "production" ||
    process.env.RESIN_ENVIRONMENT === "production";

  const receipt =
    options.verificationReceipt ||
    readReceipt(options.receiptDir, "verify-public") ||
    options.verifyPublicReceipt;

  if (!receipt) {
    if (options.approvals !== undefined) {
      return { valid: true, approvals: options.approvals };
    }
    return {
      valid: false,
      reason: "missing_or_unverified_receipt",
      errors: ["Missing or unverified verify-public receipt."],
    };
  }

  if (receipt.status !== "verified" || !Array.isArray(receipt.verifiedObjects)) {
    return {
      valid: false,
      reason: "missing_or_unverified_receipt",
      errors: ["Missing or unverified verify-public receipt."],
    };
  }

  const keyPrefix = normalizeKeyPrefix(options.keyPrefix ?? options.uploadPlan?.keyPrefix, {
    isProduction,
    environment: options.environment,
  });
  const plan = options.uploadPlan || createUploadPlan({ ...options, keyPrefix });
  const verifiedMap = new Map();
  for (const obj of receipt.verifiedObjects) {
    verifiedMap.set(obj.key, obj);
  }

  const errors = [];

  if (receipt.keyPrefix !== undefined) {
    const receiptPrefix = receipt.keyPrefix ? normalizeKeyPrefix(receipt.keyPrefix) : "";
    if (receiptPrefix !== keyPrefix) {
      errors.push(
        `Key prefix mismatch between verification receipt ('${receiptPrefix}') and promotion options ('${keyPrefix}').`,
      );
    }
  }

  for (const planned of plan.immutableUploads) {
    const verified = verifiedMap.get(planned.key);
    if (!verified) {
      errors.push(`Planned immutable key '${planned.key}' is missing from verification receipt.`);
    } else if (verified.sha256 !== planned.sha256) {
      errors.push(
        `Digest mismatch for key '${planned.key}': planned ${planned.sha256} != verified ${verified.sha256}.`,
      );
    } else if (planned.sizeBytes && verified.sizeBytes !== planned.sizeBytes) {
      errors.push(
        `Size mismatch for key '${planned.key}': planned ${planned.sizeBytes} != verified ${verified.sizeBytes}.`,
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, reason: "verification_receipt_incomplete", errors };
  }

  return { valid: true, receipt, approvals: options.approvals };
}

/**
 * 5. Mode: promote
 * Receipt-gated channel promotion. Updates S3 channels.json and invalidates CloudFront cache.
 */
export async function promote(options = {}) {
  const bucket = options.bucket || process.env.RESIN_DISTRIBUTION_BUCKET;
  if (!bucket) {
    throw new Error(
      "RESIN_DISTRIBUTION_BUCKET environment variable or --bucket option is required.",
    );
  }
  const distributionId = options.distributionId || process.env.RESIN_DISTRIBUTION_ID;
  if (!distributionId) {
    throw new Error(
      "RESIN_DISTRIBUTION_ID environment variable or --distribution-id option is required.",
    );
  }

  const isProduction =
    options.testOnly === false ||
    options.environment === "production" ||
    process.env.RESIN_ENVIRONMENT === "production" ||
    process.env.TARGET_ENV === "production";

  const keyPrefix = normalizeKeyPrefix(options.keyPrefix ?? options.uploadPlan?.keyPrefix, {
    isProduction,
    environment: options.environment,
  });

  const approval = validatePromotionApproval({ ...options, keyPrefix });
  if (!approval.valid) {
    throw new Error(
      `Promotion rejected: ${approval.errors ? approval.errors.join("; ") : approval.reason}`,
    );
  }

  const plan = options.uploadPlan || createUploadPlan({ ...options, keyPrefix });

  // 1. Publish and anonymously verify mutable installer assets first before touching channels.json
  const mutableInstallers = plan.mutableInstallerUploads || [];
  const installerInvalidationPaths = [];
  const verifiedInstallers = [];

  for (const item of mutableInstallers) {
    const installerHead = await s3HeadObject({ bucket, key: item.key }, options);
    let installerIdentical = false;
    if (installerHead.exists) {
      const existingSha = installerHead.metadata?.sha256 || installerHead.eTag;
      if (existingSha && existingSha === item.sha256) {
        installerIdentical = true;
      }
    }

    if (!installerIdentical) {
      await s3PutObject(
        {
          bucket,
          key: item.key,
          filePath: item.filePath,
          cacheControl: item.cacheControl || CHANNELS_CACHE_CONTROL,
          contentType: item.contentType || determineContentType(item.key),
          metadata: {
            sha256: item.sha256,
          },
        },
        options,
      );
      const invPath = item.invalidationPath || deriveInvalidationPath(item.key, keyPrefix);
      installerInvalidationPaths.push(invPath);
    }
  }

  // Invalidate mutable installer paths in CloudFront
  let installerInvalidationId = null;
  if (installerInvalidationPaths.length > 0) {
    const invalidation = await cloudFrontCreateInvalidation(
      {
        distributionId,
        paths: installerInvalidationPaths,
      },
      options,
    );
    installerInvalidationId = invalidation.invalidationId;
  }

  // Anonymously verify exact SHA-256 and bytes for each mutable installer entrypoint before touching channels.json
  const baseUrl = (
    options.baseUrl ||
    process.env.RESIN_DISTRIBUTION_BASE_URL ||
    PRODUCTION_BASE_URL
  ).replace(/\/$/, "");

  const fetchFn = options.fetch || globalThis.fetch;
  if (
    !(
      fetchFn instanceof Function || Object.prototype.toString.call(fetchFn) === "[object Function]"
    )
  ) {
    throw new Error("A valid fetch implementation is required for promotion verification.");
  }

  const installerVerificationAttempts =
    options.installerVerificationAttempts ?? (isProduction ? 30 : 1);
  const installerVerificationDelayMs = options.installerVerificationDelayMs ?? 2_000;
  const sleep =
    options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (const item of mutableInstallers) {
    const url = derivePublicUrl(baseUrl, item.key);
    let verifiedBody = null;
    let lastError = null;

    for (let attempt = 1; attempt <= installerVerificationAttempts; attempt += 1) {
      try {
        const response = await fetchFn(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "*/*",
          },
        });

        if (!response.ok || response.status !== 200) {
          throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
        }

        const bodyBuffer = Buffer.from(await response.arrayBuffer());
        const actualSha256 = sha256Hex(bodyBuffer);
        if (actualSha256 !== item.sha256) {
          throw new Error(`expected digest ${item.sha256}, got ${actualSha256}`);
        }
        if (bodyBuffer.length !== item.sizeBytes) {
          throw new Error(`expected size ${item.sizeBytes}, got ${bodyBuffer.length}`);
        }

        verifiedBody = bodyBuffer;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < installerVerificationAttempts) {
          await sleep(installerVerificationDelayMs);
        }
      }
    }

    if (!verifiedBody) {
      throw new Error(
        `Anonymous installer verification failed for '${url}' after ${installerVerificationAttempts} attempt(s): ${lastError?.message || String(lastError)}`,
      );
    }

    verifiedInstallers.push({
      key: item.key,
      url,
      sha256: sha256Hex(verifiedBody),
      sizeBytes: verifiedBody.length,
      verified: true,
    });
  }

  // 2. NOW upload and promote channels.json
  const channelsPath = plan.mutableChannelUpload.filePath;
  const newChannelsBuffer = fs.readFileSync(channelsPath);
  const newChannelsSha256 = sha256Hex(newChannelsBuffer);
  const channelsKey = applyKeyPrefix(CHANNELS_S3_KEY, keyPrefix);
  const invalidationPath = deriveInvalidationPath(CHANNELS_S3_KEY, keyPrefix);

  // HEAD-before-PUT for mutable channels.json
  let uploadStatus = "uploaded";
  const head = await s3HeadObject({ bucket, key: channelsKey }, options);

  let isIdentical = false;
  if (head.exists) {
    let fetchedAuthoritativeBytes = false;

    if (
      baseUrl &&
      (fetchFn instanceof Function ||
        Object.prototype.toString.call(fetchFn) === "[object Function]")
    ) {
      try {
        const resp = await fetchFn(`${baseUrl.replace(/\/$/, "")}/${channelsKey}`, {
          method: "GET",
          redirect: "manual",
        });
        if (resp.status === 200) {
          const arrBuf = await resp.arrayBuffer();
          const fetchedSha = sha256Hex(Buffer.from(arrBuf));
          if (fetchedSha === newChannelsSha256) {
            isIdentical = true;
            fetchedAuthoritativeBytes = true;
          }
        }
      } catch {
        // Fall back to head metadata
      }
    }

    if (!fetchedAuthoritativeBytes) {
      const existingSha = head.metadata?.sha256 || head.eTag;
      if (existingSha && existingSha === newChannelsSha256) {
        isIdentical = true;
      }
    }
  }

  let invalidationId = null;
  if (isIdentical) {
    uploadStatus = "skipped_identical";
  } else {
    await s3PutObject(
      {
        bucket,
        key: channelsKey,
        filePath: channelsPath,
        cacheControl: CHANNELS_CACHE_CONTROL,
        contentType: "application/json",
        metadata: {
          sha256: newChannelsSha256,
        },
      },
      options,
    );
    const invalidation = await cloudFrontCreateInvalidation(
      {
        distributionId,
        paths: [invalidationPath],
      },
      options,
    );
    invalidationId = invalidation.invalidationId;
  }

  const allInvalidationPaths = [
    ...installerInvalidationPaths,
    ...(invalidationId ? [invalidationPath] : []),
  ];

  const receipt = {
    phase: "promote",
    status: "success",
    uploadStatus,
    timestamp: new Date().toISOString(),
    bucket,
    keyPrefix: keyPrefix || null,
    s3Key: channelsKey,
    version: plan.version,
    promotedVersion: plan.version,
    channelsSha256: newChannelsSha256,
    invalidationId,
    distributionId,
    invalidationPaths: allInvalidationPaths,
    verifiedInstallers,
  };

  return writeReceipt(options.receiptDir, "promote", receipt);
}
/**
 * 6. Mode: record-smoke / runPostReleaseSmokeTests
 * Executes and records post-promotion smoke tests, outputting public-release-smoke.json.
 */
export async function recordSmoke(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const version = options.version || options.releaseVersion || RELEASE_VERSION;
  const baseUrl = (
    options.baseUrl ||
    process.env.RESIN_DISTRIBUTION_BASE_URL ||
    PRODUCTION_BASE_URL
  ).replace(/\/$/, "");
  const distributionId =
    options.distributionId || process.env.RESIN_DISTRIBUTION_ID || "unknown-dist-id";
  const fetchFn = options.fetch || globalThis.fetch;
  const trustedKeys = resolveTrustedKeys(options);
  const environment =
    options.environment ||
    process.env.TARGET_ENV ||
    process.env.RESIN_ENVIRONMENT ||
    (options.testOnly === false ? "production" : "staging");

  const isProduction =
    environment === "production" ||
    process.env.TARGET_ENV === "production" ||
    process.env.RESIN_ENVIRONMENT === "production" ||
    (options.testOnly === false && environment !== "staging" && environment !== "test");
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, { isProduction, environment });
  const channelsKey = applyKeyPrefix(CHANNELS_S3_KEY, keyPrefix);
  const releaseDir =
    options.releaseDir ||
    options.distDir ||
    options.candidateDir ||
    path.resolve(rootDir, `dist/release/v${version}`);
  let manifest = options.manifest;
  let manifestDigest = options.manifestDigest;
  if (!manifest && fs.existsSync(releaseDir)) {
    const manifestPath = fs.existsSync(path.join(releaseDir, `manifest-${version}.json`))
      ? path.join(releaseDir, `manifest-${version}.json`)
      : path.join(releaseDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifestDigest = manifestDigest || fileSha256(manifestPath);
      } catch {
        // ignore parse failure
      }
    }
  }

  const smokeTests = [];
  const verifiedArtifacts = [];
  const testedPublicUrls = [];
  let overallPassed = true;

  let channelStableVersion = null;
  let channelManifestUrl = null;
  let channelManifestDigest = null;

  // 1. Channel resolution and chain-binding verification
  const t0 = Date.now();
  const chanUrl = derivePublicUrl(baseUrl, channelsKey);
  testedPublicUrls.push(chanUrl);
  try {
    const chanResp = await fetchFn(chanUrl, { method: "GET", redirect: "manual" });
    if (!chanResp.ok) throw new Error(`HTTP ${chanResp.status}`);
    const chanJson = JSON.parse(Buffer.from(await chanResp.arrayBuffer()).toString("utf8"));
    const { signatures, ...payload } = chanJson;
    const sigCheck = verifyReleasePayloadSignature(payload, signatures?.[0], trustedKeys);
    if (!sigCheck.valid) throw new Error(`Signature check failed: ${sigCheck.reason}`);

    const stableChannel = chanJson.channels?.stable;
    if (!stableChannel) {
      throw new Error("Promoted channels.json is missing required 'channels.stable' entry.");
    }
    channelStableVersion = stableChannel.version;
    channelManifestUrl = stableChannel.manifestUrl;
    channelManifestDigest = stableChannel.manifestDigest || stableChannel.manifestSha256;

    if (channelStableVersion !== version) {
      throw new Error(
        `Channel stable version '${channelStableVersion}' does not match promoted release version '${version}'.`,
      );
    }
    if (!channelManifestUrl) {
      throw new Error("Channel stable entry is missing 'manifestUrl'.");
    }
    if (!channelManifestDigest) {
      throw new Error("Channel stable entry is missing 'manifestDigest'.");
    }

    smokeTests.push({
      name: "anonymous_channel_resolution",
      status: "PASSED",
      durationMs: Date.now() - t0,
      details: {
        currentVersion: chanJson.currentVersion,
        stableVersion: channelStableVersion,
        manifestUrl: channelManifestUrl,
        manifestDigest: channelManifestDigest,
      },
    });
  } catch (err) {
    overallPassed = false;
    smokeTests.push({
      name: "anonymous_channel_resolution",
      status: "FAILED",
      durationMs: Date.now() - t0,
      error: err.message,
    });
  }

  // 2. Exact immutable manifest fetch and chain-bound digest verification
  const t1 = Date.now();
  const manifestRelativePath = (
    channelManifestUrl || `/releases/v1/manifests/manifest-${version}.json`
  ).replace(/^\//, "");
  const manifestKey = applyKeyPrefix(manifestRelativePath, keyPrefix);
  const manifestUrl = derivePublicUrl(baseUrl, manifestKey);
  testedPublicUrls.push(manifestUrl);
  let downloadedManifest = null;
  let downloadedManifestSha256 = null;

  try {
    const manResp = await fetchFn(manifestUrl, { method: "GET", redirect: "manual" });
    if (!manResp.ok) throw new Error(`HTTP ${manResp.status}`);
    const manBuf = Buffer.from(await manResp.arrayBuffer());
    downloadedManifestSha256 = sha256Hex(manBuf);

    if (channelManifestDigest && downloadedManifestSha256 !== channelManifestDigest) {
      throw new Error(
        `Downloaded manifest SHA-256 '${downloadedManifestSha256}' does not match signed channel manifestDigest '${channelManifestDigest}'.`,
      );
    }

    downloadedManifest = JSON.parse(manBuf.toString("utf8"));
    manifest = manifest || downloadedManifest;
    const { signatures, ...payload } = downloadedManifest;
    const sigCheck = verifyReleasePayloadSignature(payload, signatures?.[0], trustedKeys);
    if (!sigCheck.valid) throw new Error(`Signature check failed: ${sigCheck.reason}`);

    verifiedArtifacts.push({
      type: "manifest",
      url: `/${manifestRelativePath}`,
      sha256: downloadedManifestSha256,
    });
    smokeTests.push({
      name: "signed_manifest_verification",
      status: "PASSED",
      durationMs: Date.now() - t1,
      details: { sha256: downloadedManifestSha256 },
    });
  } catch (err) {
    overallPassed = false;
    smokeTests.push({
      name: "signed_manifest_verification",
      status: "FAILED",
      durationMs: Date.now() - t1,
      error: err.message,
    });
  }

  // 3. Artifact cache header verification
  const t2 = Date.now();
  const artifactKey = applyKeyPrefix(
    `releases/v1/artifacts/v${version}/resin-v${version}-linux-x64.tar.gz`,
    keyPrefix,
  );
  const testArtifactUrl = derivePublicUrl(baseUrl, artifactKey);
  testedPublicUrls.push(testArtifactUrl);
  try {
    const artResp = await fetchFn(testArtifactUrl, { method: "HEAD", redirect: "manual" });
    const cc = (
      artResp.headers?.get?.("cache-control") ||
      artResp.headers?.["cache-control"] ||
      ""
    ).toLowerCase();
    if (!cc.includes("immutable") && !cc.includes("max-age=31536000")) {
      throw new Error(`Expected immutable cache control, received: '${cc}'`);
    }
    smokeTests.push({
      name: "artifact_cache_header_verification",
      status: "PASSED",
      durationMs: Date.now() - t2,
      details: { cacheControl: cc },
    });
  } catch (err) {
    overallPassed = false;
    smokeTests.push({
      name: "artifact_cache_header_verification",
      status: "FAILED",
      durationMs: Date.now() - t2,
      error: err.message,
    });
  }

  // 4. Installer verification
  const rawInstallerInput =
    options.installerResults !== undefined
      ? options.installerResults
      : options.installerResultsFile !== undefined
        ? options.installerResultsFile
        : options.installerReceipt?.results !== undefined
          ? options.installerReceipt.results
          : null;

  let loadedResults = null;
  if (rawInstallerInput !== null) {
    loadedResults = loadInstallerResults(rawInstallerInput);
  }

  let installerResults = null;
  if (loadedResults !== null) {
    installerResults = validateInstallerResults(loadedResults);
  }

  if (installerResults) {
    for (const res of installerResults) {
      if (res.entrypointUrl && !testedPublicUrls.includes(res.entrypointUrl)) {
        testedPublicUrls.push(res.entrypointUrl);
      }
    }

    const posix = installerResults.find((r) => r.installer === "posix");
    const powershell = installerResults.find((r) => r.installer === "powershell");

    const failures = [];
    if (posix.status !== "PASSED") {
      failures.push(`POSIX installer failed: ${posix.error || "status FAILED"}`);
    } else if (posix.installedVersion !== version) {
      failures.push(
        `POSIX installed version '${posix.installedVersion}' does not match release version '${version}'.`,
      );
    }

    if (powershell.status !== "PASSED") {
      failures.push(`PowerShell installer failed: ${powershell.error || "status FAILED"}`);
    } else if (powershell.installedVersion !== version) {
      failures.push(
        `PowerShell installed version '${powershell.installedVersion}' does not match release version '${version}'.`,
      );
    }

    const totalDuration = (posix.durationMs || 0) + (powershell.durationMs || 0);

    if (failures.length === 0) {
      smokeTests.push({
        name: "installer_qualification",
        status: "PASSED",
        durationMs: totalDuration,
        details: {
          posix: {
            status: posix.status,
            installedVersion: posix.installedVersion,
            entrypointUrl: posix.entrypointUrl,
          },
          powershell: {
            status: powershell.status,
            installedVersion: powershell.installedVersion,
            entrypointUrl: powershell.entrypointUrl,
          },
        },
      });
    } else {
      overallPassed = false;
      smokeTests.push({
        name: "installer_qualification",
        status: "FAILED",
        durationMs: totalDuration,
        error: failures.join("; "),
        details: {
          posix: {
            status: posix.status,
            installedVersion: posix.installedVersion,
            entrypointUrl: posix.entrypointUrl,
            error: posix.error,
          },
          powershell: {
            status: powershell.status,
            installedVersion: powershell.installedVersion,
            entrypointUrl: powershell.entrypointUrl,
            error: powershell.error,
          },
        },
      });
    }
  } else if (isProduction) {
    overallPassed = false;
    smokeTests.push({
      name: "installer_qualification",
      status: "FAILED",
      durationMs: 0,
      error: "Missing required production installer qualification results.",
    });
  } else {
    installerResults = [];
  }

  let sourceCommit =
    options.sourceCommit ||
    options.commitSha ||
    downloadedManifest?.releaseIdentity?.commitSha ||
    manifest?.releaseIdentity?.commitSha ||
    manifest?.commitSha ||
    null;

  if (sourceCommit !== null && sourceCommit !== undefined) {
    sourceCommit = String(sourceCommit).trim();
    if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
      throw new Error(
        `Source commit SHA must be an exact 40-character hex Git SHA, received '${sourceCommit}'.`,
      );
    }
  } else if (isProduction) {
    throw new Error(
      "Production smoke verification requires an exact 40-character hex source commit SHA from promoted candidate releaseIdentity.commitSha or --source-commit.",
    );
  } else {
    sourceCommit =
      process.env.RESIN_SOURCE_COMMIT && /^[0-9a-f]{40}$/i.test(process.env.RESIN_SOURCE_COMMIT)
        ? process.env.RESIN_SOURCE_COMMIT
        : "0123456789abcdef0123456789abcdef01234567";
  }

  const resolvedManifestDigest =
    downloadedManifestSha256 ||
    channelManifestDigest ||
    manifestDigest ||
    options.manifestDigest ||
    "unknown";

  const freezeOutcome =
    options.freezeOutcome ||
    (overallPassed
      ? {
          triggered: false,
          status: "NONE",
          noticeUrl: null,
          noticeSha256: null,
        }
      : options.freezeNotice
        ? {
            triggered: true,
            status: "FROZEN",
            noticeUrl:
              options.freezeNoticeUrl ||
              (options.freezeNoticeKey ? `${baseUrl}/${options.freezeNoticeKey}` : null),
            noticeSha256: options.freezeNoticeSha256 || null,
          }
        : {
            triggered: true,
            status: "PENDING_FREEZE",
            noticeUrl: null,
            noticeSha256: null,
          });
  const smokeEvidence = {
    schemaVersion: "1.0.0",
    timestamp: new Date().toISOString(),
    releaseVersion: version,
    keyPrefix: keyPrefix || null,
    sourceCommit,
    manifestDigest: resolvedManifestDigest,
    distributionBaseUrl: baseUrl,
    distributionId,
    channelsUrl: `/${channelsKey}`,
    manifestUrl: `/${manifestKey}`,
    testedPublicUrls,
    installerResults,
    freezeOutcome,
    status: overallPassed ? "PASSED" : "FAILED",
    verifiedArtifacts,
    smokeTests,
  };

  const outputDir = options.outputDir || options.receiptDir || process.cwd();
  fs.mkdirSync(outputDir, { recursive: true });
  const evidencePath = path.join(outputDir, "public-release-smoke.json");
  const smokeJson = `${JSON.stringify(smokeEvidence, null, 2)}\n`;
  fs.writeFileSync(evidencePath, smokeJson);

  const smokeSha256 = sha256Hex(Buffer.from(smokeJson, "utf8"));

  let smokeEvidenceS3Key = null;
  let evidencePublicUrl = null;

  const bucket = options.bucket || process.env.RESIN_DISTRIBUTION_BUCKET;
  if (bucket) {
    smokeEvidenceS3Key = applyKeyPrefix(
      `releases/v1/evidence/v${version}/public-release-smoke-${smokeSha256}.json`,
      keyPrefix,
    );
    await s3PutObject(
      {
        bucket,
        key: smokeEvidenceS3Key,
        body: smokeJson,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentType: "application/json",
      },
      options,
    );
    evidencePublicUrl = derivePublicUrl(baseUrl, smokeEvidenceS3Key);
    if (
      !options.skipEvidencePublicVerification &&
      baseUrl &&
      (fetchFn instanceof Function ||
        Object.prototype.toString.call(fetchFn) === "[object Function]")
    ) {
      const evResp = await fetchFn(evidencePublicUrl, { method: "GET", redirect: "manual" });
      if (!evResp.ok) {
        throw new Error(
          `Failed to anonymously retrieve smoke evidence from '${evidencePublicUrl}': HTTP ${evResp.status}`,
        );
      }
      const cc = (
        evResp.headers?.get?.("cache-control") ||
        evResp.headers?.["cache-control"] ||
        ""
      ).toLowerCase();
      if (!cc.includes("immutable") && !cc.includes("max-age=31536000")) {
        throw new Error(`Smoke evidence Cache-Control header must be immutable, received '${cc}'.`);
      }
      const retrievedBuf = Buffer.from(await evResp.arrayBuffer());
      const retrievedSha256 = sha256Hex(retrievedBuf);
      if (retrievedSha256 !== smokeSha256) {
        throw new Error(
          `Smoke evidence digest mismatch: expected ${smokeSha256}, got ${retrievedSha256}.`,
        );
      }
    }
  }

  const receipt = {
    phase: "record-smoke",
    status: overallPassed ? "success" : "failed",
    timestamp: new Date().toISOString(),
    distributionBaseUrl: baseUrl,
    distributionId,
    version,
    keyPrefix: keyPrefix || null,
    releaseVersion: version,
    sourceCommit,
    manifestDigest: resolvedManifestDigest,
    smokeEvidenceSha256: smokeSha256,
    evidenceS3Key: smokeEvidenceS3Key,
    evidencePublicUrl,
    passed: overallPassed,
    smokeEvidencePath: evidencePath,
  };
  writeReceipt(options.receiptDir, "record-smoke", receipt);
  return {
    success: overallPassed,
    smokeEvidence: {
      ...smokeEvidence,
      smokeEvidenceSha256: smokeSha256,
      evidenceS3Key: smokeEvidenceS3Key,
      evidencePublicUrl,
    },
    receiptPath: evidencePath,
    receipt,
  };
}

export const runPostReleaseSmokeTests = recordSmoke;

/**
 * 7. Mode: freeze
 * Emergency signed freeze notice publication, version revocation, channels update, and anonymous verification.
 */
export async function freeze(options = {}) {
  const bucket = options.bucket || process.env.RESIN_DISTRIBUTION_BUCKET;
  if (!bucket) {
    throw new Error(
      "RESIN_DISTRIBUTION_BUCKET environment variable or --bucket option is required.",
    );
  }
  const distributionId = options.distributionId || process.env.RESIN_DISTRIBUTION_ID;
  if (!distributionId) {
    throw new Error(
      "RESIN_DISTRIBUTION_ID environment variable or --distribution-id option is required.",
    );
  }
  const baseUrl = (
    options.baseUrl ||
    process.env.RESIN_DISTRIBUTION_BASE_URL ||
    PRODUCTION_BASE_URL
  ).replace(/\/$/, "");

  const isProduction =
    options.testOnly === false ||
    options.environment === "production" ||
    process.env.RESIN_ENVIRONMENT === "production" ||
    process.env.TARGET_ENV === "production";

  const keyPrefix = normalizeKeyPrefix(options.keyPrefix, {
    isProduction,
    environment: options.environment,
  });

  const targetVersion = options.targetVersion || options.version || RELEASE_VERSION;
  const incidentId = options.incidentId || `INC-FREEZE-${Date.now()}`;
  const reason =
    options.reason || "Post-promotion smoke verification failure or incident response.";
  const keyPair = resolveSigningKey(options);
  const trustedKeys = resolveTrustedKeys(options);

  const freezeParams = {
    incidentId,
    targetVersion,
    targetReleaseTag: options.targetReleaseTag || `v${targetVersion}`,
    targetCommitSha: options.targetCommitSha || "",
    targetManifestSha256: options.targetManifestSha256 || null,
    reason,
    failureEvidence: options.failureEvidence || null,
    frozenAt: options.frozenAt || new Date().toISOString(),
  };

  const signedNotice = createSignedFreezeNotice(freezeParams, keyPair);
  const noticeCanonical = canonicalJson(signedNotice);
  const noticeDigest = sha256Hex(noticeCanonical);
  const safeTimestamp = freezeParams.frozenAt.replace(/[:.]/g, "-");
  const freezeFilename = `${safeTimestamp}-${noticeDigest.slice(0, 16)}.json`;
  const freezeS3Key = applyKeyPrefix(
    `releases/v1/freezes/v${targetVersion}/${freezeFilename}`,
    keyPrefix,
  );
  const channelsS3Key = applyKeyPrefix(CHANNELS_S3_KEY, keyPrefix);
  const channelsInvalidationPath = deriveInvalidationPath(CHANNELS_S3_KEY, keyPrefix);

  // 1. Resolve and update channels.json with revoked version
  let currentChannels = options.currentChannels;
  if (!currentChannels) {
    if (options.channelsPath) {
      const explicitChannelsPath = path.resolve(options.channelsPath);
      if (!fs.existsSync(explicitChannelsPath)) {
        throw new Error(`Explicit channels file not found at '${options.channelsPath}'.`);
      }
      currentChannels = JSON.parse(fs.readFileSync(explicitChannelsPath, "utf8"));
    } else if (options.releaseDir || options.distDir || options.candidateDir) {
      const explicitDir = path.resolve(
        options.releaseDir || options.distDir || options.candidateDir,
      );
      const directPath = path.join(explicitDir, "channels.json");
      const nestedPath = path.join(explicitDir, "release", "channels.json");
      if (fs.existsSync(directPath)) {
        currentChannels = JSON.parse(fs.readFileSync(directPath, "utf8"));
      } else if (fs.existsSync(nestedPath)) {
        currentChannels = JSON.parse(fs.readFileSync(nestedPath, "utf8"));
      } else {
        throw new Error(
          `channels.json not found in explicitly specified release directory '${explicitDir}' (checked '${directPath}' and '${nestedPath}').`,
        );
      }
    } else if (options.rootDir) {
      const explicitRootDir = path.resolve(options.rootDir);
      const candidates = [
        path.resolve(explicitRootDir, `dist/release/v${targetVersion}/channels.json`),
        path.join(explicitRootDir, "release", "channels.json"),
        path.join(explicitRootDir, "channels.json"),
      ];
      const matched = candidates.find((p) => fs.existsSync(p));
      if (matched) {
        currentChannels = JSON.parse(fs.readFileSync(matched, "utf8"));
      } else {
        throw new Error(
          `channels.json not found under explicitly specified root directory '${explicitRootDir}' (checked ${candidates.map((c) => `'${c}'`).join(", ")}).`,
        );
      }
    } else {
      // Synthesize fresh minimal channels without touching ambient cwd artifacts
      currentChannels = {
        schemaVersion: "2.0.0",
        minSupportedVersion: "0.1.0",
        currentVersion: targetVersion,
        updatedAt: freezeParams.frozenAt,
        expiresAt:
          options.expiresAt ||
          new Date(Date.parse(freezeParams.frozenAt) + DEFAULT_CHANNEL_TTL_MS).toISOString(),
        channels: {
          stable: {
            version: targetVersion,
            manifestUrl: `/releases/v1/manifests/manifest-${targetVersion}.json`,
          },
        },
        revokedVersions: [],
        revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
      };
    }
  }

  const { signatures: _discarded, ...chanPayload } = currentChannels;
  const existingRevoked = Array.isArray(chanPayload.revokedVersions)
    ? chanPayload.revokedVersions
    : [];
  if (!existingRevoked.includes(targetVersion)) {
    existingRevoked.push(targetVersion);
  }
  chanPayload.revokedVersions = existingRevoked;
  chanPayload.updatedAt = freezeParams.frozenAt;
  chanPayload.expiresAt =
    options.expiresAt ||
    new Date(Date.parse(freezeParams.frozenAt) + DEFAULT_CHANNEL_TTL_MS).toISOString();
  const signedRevokedChannels = {
    ...chanPayload,
    signatures: [{ ...signReleasePayload(chanPayload, keyPair), signedAt: freezeParams.frozenAt }],
  };

  // 2. Upload immutable signed freeze notice
  await s3PutObject(
    {
      bucket,
      key: freezeS3Key,
      body: noticeCanonical,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: "application/json",
    },
    options,
  );
  // 3. Upload updated channels.json & invalidate CloudFront
  await s3PutObject(
    {
      bucket,
      key: channelsS3Key,
      body: JSON.stringify(signedRevokedChannels, null, 2),
      cacheControl: CHANNELS_CACHE_CONTROL,
      contentType: "application/json",
    },
    options,
  );

  const invalidation = await cloudFrontCreateInvalidation(
    {
      distributionId,
      paths: [channelsInvalidationPath],
    },
    options,
  );

  // 4. Anonymous retrieval & verification of freeze notice
  const fetchFn = options.fetch || globalThis.fetch;
  if (
    (fetchFn instanceof Function ||
      Object.prototype.toString.call(fetchFn) === "[object Function]") &&
    baseUrl
  ) {
    const noticeUrl = derivePublicUrl(baseUrl, freezeS3Key);
    const noticeResp = await fetchFn(noticeUrl, { method: "GET", redirect: "manual" });
    if (!noticeResp.ok) {
      throw new Error(
        `Anonymous fetch of freeze notice failed with HTTP ${noticeResp.status} from ${noticeUrl}`,
      );
    }
    const noticeBuf = Buffer.from(await noticeResp.arrayBuffer());
    const fetchedNotice = JSON.parse(noticeBuf.toString("utf8"));
    const verifyNotice = verifySignedFreezeNotice(fetchedNotice, trustedKeys, options);
    if (!verifyNotice.valid) {
      throw new Error(
        `Anonymous freeze notice signature verification failed: ${verifyNotice.reason}`,
      );
    }

    const chanUrl = derivePublicUrl(baseUrl, channelsS3Key);
    const chanResp = await fetchFn(chanUrl, { method: "GET", redirect: "manual" });
    if (!chanResp.ok) {
      throw new Error(
        `Anonymous fetch of frozen channels failed with HTTP ${chanResp.status} from ${chanUrl}`,
      );
    }
    const chanBuf = Buffer.from(await chanResp.arrayBuffer());
    const fetchedChannels = JSON.parse(chanBuf.toString("utf8"));
    const { signatures: chanSigs, ...chanPayloadRest } = fetchedChannels;
    const verifyChan = verifyReleasePayloadSignature(
      chanPayloadRest,
      chanSigs?.[0],
      trustedKeys,
      options,
    );
    if (!verifyChan.valid) {
      throw new Error(
        `Anonymous channels signature verification failed after freeze: ${verifyChan.reason}`,
      );
    }
  }

  const receipt = {
    phase: "freeze",
    status: "frozen",
    timestamp: freezeParams.frozenAt,
    bucket,
    keyPrefix: keyPrefix || null,
    incidentId,
    targetVersion,
    reason,
    freezeNoticeDigest: noticeDigest,
    noticeDigest,
    freezeS3Key,
    freezeNoticeKey: freezeS3Key,
    channelsS3Key,
    invalidationId: invalidation?.invalidationId || null,
    invalidationPaths: [channelsInvalidationPath],
    signedNotice,
  };
  // 5. Post-failure completion: update smoke evidence to FROZEN with verified signed notice binding and upload final immutable object
  const outputDir = options.outputDir || options.receiptDir || process.cwd();
  fs.mkdirSync(outputDir, { recursive: true });
  let priorEvidence =
    options.failureEvidence ||
    options.smokeEvidence ||
    readReceipt(options.receiptDir, "record-smoke")?.smokeEvidence;

  if (!priorEvidence) {
    const localEvidenceFile = path.join(outputDir, "public-release-smoke.json");
    if (fs.existsSync(localEvidenceFile)) {
      try {
        priorEvidence = JSON.parse(fs.readFileSync(localEvidenceFile, "utf8"));
      } catch {
        priorEvidence = null;
      }
    }
  }

  let finalSmokeEvidence = null;
  let finalSmokeEvidencePath = null;
  let finalSmokeEvidenceS3Key = null;
  let finalSmokeEvidenceUrl = null;
  let finalSmokeSha256 = null;

  if (priorEvidence) {
    const {
      smokeEvidenceSha256: _discardedSha,
      evidenceS3Key: _discardedKey,
      evidencePublicUrl: _discardedUrl,
      ...priorPayload
    } = priorEvidence;

    finalSmokeEvidence = {
      ...priorPayload,
      schemaVersion: priorPayload.schemaVersion || "1.0.0",
      timestamp: new Date().toISOString(),
      releaseVersion: targetVersion,
      sourceCommit: priorPayload.sourceCommit || "unknown",
      manifestDigest: priorPayload.manifestDigest || "unknown",
      distributionBaseUrl: baseUrl,
      distributionId,
      channelsUrl: `/${CHANNELS_S3_KEY}`,
      manifestUrl:
        priorPayload.manifestUrl || `/releases/v1/manifests/manifest-${targetVersion}.json`,
      testedPublicUrls: priorPayload.testedPublicUrls || [],
      installerResults: priorPayload.installerResults ?? null,
      status: "FAILED",
      verifiedArtifacts: priorPayload.verifiedArtifacts || [],
      smokeTests: priorPayload.smokeTests || [],
      freezeOutcome: {
        triggered: true,
        status: "FROZEN",
        noticeUrl: `${baseUrl}/${freezeS3Key}`,
        noticeSha256: noticeDigest,
      },
      originalFailureEvidence: priorPayload,
    };

    finalSmokeEvidencePath = path.join(outputDir, "public-release-smoke.json");
    const finalSmokeJson = `${JSON.stringify(finalSmokeEvidence, null, 2)}\n`;
    fs.writeFileSync(finalSmokeEvidencePath, finalSmokeJson);

    finalSmokeSha256 = sha256Hex(Buffer.from(finalSmokeJson, "utf8"));
    finalSmokeEvidenceS3Key = applyKeyPrefix(
      `releases/v1/evidence/v${targetVersion}/public-release-smoke-${finalSmokeSha256}.json`,
      keyPrefix,
    );
    finalSmokeEvidenceUrl = derivePublicUrl(baseUrl, finalSmokeEvidenceS3Key);

    await s3PutObject(
      {
        bucket,
        key: finalSmokeEvidenceS3Key,
        body: finalSmokeJson,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentType: "application/json",
      },
      options,
    );

    if (
      (fetchFn instanceof Function ||
        Object.prototype.toString.call(fetchFn) === "[object Function]") &&
      baseUrl
    ) {
      const resp = await fetchFn(finalSmokeEvidenceUrl, { method: "GET", redirect: "manual" });
      if (resp && resp.ok) {
        const retrievedBuf = Buffer.from(await resp.arrayBuffer());
        if (sha256Hex(retrievedBuf) !== finalSmokeSha256) {
          throw new Error("Finalized smoke evidence digest mismatch on public retrieval.");
        }
      }
    }

    receipt.finalSmokeEvidencePath = finalSmokeEvidencePath;
    receipt.finalSmokeEvidenceS3Key = finalSmokeEvidenceS3Key;
    receipt.finalSmokeEvidenceUrl = finalSmokeEvidenceUrl;
    receipt.finalSmokeSha256 = finalSmokeSha256;
    receipt.finalSmokeEvidence = finalSmokeEvidence;
  }

  return writeReceipt(options.receiptDir, "freeze", receipt);
}

/**
 * Main dispatcher supporting all fixed publisher modes.
 */
export async function publishPublicRelease(mode, options = {}) {
  switch (mode) {
    case "mirror-runtimes":
      return mirrorRuntimes(options);
    case "verify-candidate":
      return verifyCandidate(options);
    case "publish-immutable":
      return publishImmutable(options);
    case "verify-public":
      return verifyPublic(options);
    case "promote":
      return promote(options);
    case "record-smoke":
      return recordSmoke(options);
    case "freeze":
      return freeze(options);
    default:
      throw new Error(
        `Unknown publisher mode '${mode}'. Supported modes: ${PUBLISHER_MODES.join(", ")}`,
      );
  }
}

export function parseCliArgs(argv) {
  const options = {};
  let mode = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-") && !mode && PUBLISHER_MODES.includes(arg)) {
      mode = arg;
    } else if (arg === "--mode") {
      mode = argv[++i];
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice(7);
    } else if (arg === "--candidate-dir") {
      options.candidateDir = argv[++i];
    } else if (arg.startsWith("--candidate-dir=")) {
      options.candidateDir = arg.slice(16);
    } else if (arg === "--candidate-tarball") {
      options.candidateTarball = argv[++i];
    } else if (arg.startsWith("--candidate-tarball=")) {
      options.candidateTarball = arg.slice(20);
    } else if (arg === "--release-dir") {
      options.releaseDir = argv[++i];
    } else if (arg.startsWith("--release-dir=")) {
      options.releaseDir = arg.slice(14);
    } else if (arg === "--installers-dir") {
      options.installersDir = argv[++i];
    } else if (arg.startsWith("--installers-dir=")) {
      options.installersDir = arg.slice(17);
    } else if (arg === "--dist-dir") {
      options.distDir = argv[++i];
      options.releaseDir = options.distDir;
    } else if (arg.startsWith("--dist-dir=")) {
      options.distDir = arg.slice(11);
      options.releaseDir = options.distDir;
    } else if (arg === "--channels-path" || arg === "--channels") {
      options.channelsPath = argv[++i];
    } else if (arg.startsWith("--channels-path=")) {
      options.channelsPath = arg.slice(16);
    } else if (arg.startsWith("--channels=")) {
      options.channelsPath = arg.slice(11);
    } else if (arg === "--bucket") {
      options.bucket = argv[++i];
    } else if (arg.startsWith("--bucket=")) {
      options.bucket = arg.slice(9);
    } else if (arg === "--distribution-id") {
      options.distributionId = argv[++i];
    } else if (arg.startsWith("--distribution-id=")) {
      options.distributionId = arg.slice(18);
    } else if (arg === "--base-url") {
      options.baseUrl = argv[++i];
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice(11);
    } else if (arg === "--environment" || arg === "--env") {
      options.environment = argv[++i];
    } else if (arg.startsWith("--environment=")) {
      options.environment = arg.slice(14);
    } else if (arg.startsWith("--env=")) {
      options.environment = arg.slice(6);
    } else if (arg === "--receipt-dir") {
      options.receiptDir = argv[++i];
    } else if (arg.startsWith("--receipt-dir=")) {
      options.receiptDir = arg.slice(14);
    } else if (arg === "--target-version" || arg === "--version") {
      options.targetVersion = argv[++i];
    } else if (arg.startsWith("--target-version=") || arg.startsWith("--version=")) {
      options.targetVersion = arg.split("=")[1];
    } else if (arg === "--incident-id") {
      options.incidentId = argv[++i];
    } else if (arg.startsWith("--incident-id=")) {
      options.incidentId = arg.slice(14);
    } else if (arg === "--reason") {
      options.reason = argv[++i];
    } else if (arg.startsWith("--reason=")) {
      options.reason = arg.slice(9);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++i];
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice(13);
    } else if (arg === "--test-only") {
      options.testOnly = true;
    } else if (arg === "--source-commit" || arg === "--commit-sha") {
      options.sourceCommit = argv[++i];
    } else if (arg.startsWith("--source-commit=")) {
      options.sourceCommit = arg.slice(16);
    } else if (arg.startsWith("--commit-sha=")) {
      options.sourceCommit = arg.slice(13);
    } else if (arg === "--installer-results" || arg === "--installer-results-file") {
      options.installerResults = argv[++i];
    } else if (arg.startsWith("--installer-results=")) {
      options.installerResults = arg.slice(20);
    } else if (arg.startsWith("--installer-results-file=")) {
      options.installerResults = arg.slice(25);
    } else if (arg === "--key-prefix" || arg === "--prefix") {
      options.keyPrefix = argv[++i];
    } else if (arg.startsWith("--key-prefix=")) {
      options.keyPrefix = arg.slice(13);
    } else if (arg.startsWith("--prefix=")) {
      options.keyPrefix = arg.slice(9);
    }
  }
  return { mode, options };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const { mode, options } = parseCliArgs(process.argv.slice(2));
  if (!mode) {
    console.error(`Usage: node scripts/publish-public-release.mjs <mode> [options]`);
    console.error(`Modes: ${PUBLISHER_MODES.join(", ")}`);
    process.exit(1);
  }
  publishPublicRelease(mode, options)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result && result.success === false) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`❌ Publisher error [${mode}]:`, err.message);
      process.exit(1);
    });
}
