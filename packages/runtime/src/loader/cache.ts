import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CanonicalJsonRecord,
  type ToolManifest,
  ToolManifestSchema,
  type V1LockedToolEntry,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import { resolvePaths } from "@resin/observer";
import { computeSha256, parseTarArchive } from "../bundle/builder.js";
import { type KeyStore, verifyBundleSignature } from "../bundle/signature.js";
import {
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_SIGNATURE,
} from "../bundle/spec.js";
import { QuarantineManager, type QuarantineReason } from "./quarantine.js";
import { BundleSecurityError, validateBundleEntryPath } from "./security-checks.js";

/**
 * Reference attached to a cached artifact to prevent garbage collection.
 */
export interface ArtifactReference {
  refId: string;
  refType?: "active" | "canary" | "pinned" | "rollback" | "session" | "deployment";
  toolId?: string;
  version?: string;
  createdAt?: string;
  metadata?: CanonicalJsonRecord;
}

/**
 * Extraction metadata stored in .extracted within the artifact directory.
 */
export interface ExtractionMetadata {
  digest: string;
  extractedAt: string;
  fileCount: number;
  totalSizeBytes: number;
  entrypoint: string;
  verified: boolean;
}

export interface ArtifactCacheOptions {
  cacheDir?: string;
  quarantineManager?: QuarantineManager;
  keyStore?: KeyStore;
}

export interface VerifyLockedArtifactOptions {
  keyStore?: KeyStore;
  allowDevKeys?: boolean;
  requireExtractionMetadata?: boolean;
}

export interface VerifyLockedArtifactResult {
  valid: boolean;
  targetPath?: string;
  reason?: QuarantineReason;
  error?: string;
  manifest?: ToolManifest;
  metadata?: ExtractionMetadata;
}

export interface InstallLockedArtifactOptions {
  force?: boolean;
  reference?: {
    refId: string;
    refType?: "active" | "canary" | "pinned" | "rollback" | "session" | "deployment";
    metadata?: CanonicalJsonRecord;
  };
  keyStore?: KeyStore;
  allowDevKeys?: boolean;
}

/**
 * Content-addressed artifact cache managing extraction, staging, reference counts,
 * and exact version-locked artifact verification and deduplication.
 */
export class ArtifactCache {
  readonly cacheDir: string;
  readonly stagingDir: string;
  readonly quarantineDir: string;
  readonly refsFilePath: string;
  readonly quarantine: QuarantineManager;
  readonly keyStore?: KeyStore;

  private readonly activeInstalls = new Map<string, Promise<string>>();
  private refLock: Promise<void> = Promise.resolve();

  constructor(options: ArtifactCacheOptions = {}) {
    if (options.cacheDir) {
      this.cacheDir = path.resolve(options.cacheDir);
    } else {
      try {
        const daemonPaths = resolvePaths();
        this.cacheDir = path.join(daemonPaths.dataDir, "artifacts");
      } catch {
        this.cacheDir = path.join(os.homedir(), ".resin", "artifacts");
      }
    }
    this.stagingDir = path.join(this.cacheDir, ".staging");
    this.quarantineDir = path.join(this.cacheDir, "quarantine");
    this.refsFilePath = path.join(this.cacheDir, "refs.json");
    this.quarantine =
      options.quarantineManager ?? new QuarantineManager({ quarantineDir: this.quarantineDir });
    this.keyStore = options.keyStore;
  }

  private sanitizePathDigest(digest: string): string {
    if (!digest) return "";
    return digest.replace(/^sha256:/i, "").toLowerCase();
  }

  private strictNormalizeDigest(digest: string): string {
    if (!digest) return "";
    return normalizeSha256(digest, false);
  }

  private async withRefLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.refLock;
    let release: () => void;
    this.refLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * Ensures necessary base cache directories exist.
   */
  async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await fs.promises.mkdir(this.stagingDir, { recursive: true });
    await fs.promises.mkdir(this.quarantineDir, { recursive: true });
  }

  ensureDirectoriesSync(): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
  }

  /**
   * Computes the directory path for a given content digest.
   */
  getArtifactPath(digest: string): string {
    const cleanDigest = this.sanitizePathDigest(digest);
    return path.join(this.cacheDir, cleanDigest);
  }

  /**
   * Checks whether an artifact with the given digest is already extracted and valid.
   */
  isArtifactCached(digest: string): boolean {
    const artifactPath = this.getArtifactPath(digest);
    if (!fs.existsSync(artifactPath)) return false;
    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) return false;

    // Check entrypoint presence
    const entrypointJs = path.join(artifactPath, BUNDLE_FILE_ENTRYPOINT_JS);
    const entrypointTs = path.join(artifactPath, BUNDLE_FILE_ENTRYPOINT_TS);
    return fs.existsSync(entrypointJs) || fs.existsSync(entrypointTs);
  }

  hasArtifact(digest: string): boolean {
    const artifactPath = this.getArtifactPath(digest);
    if (!fs.existsSync(artifactPath)) return false;
    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    return fs.existsSync(manifestPath);
  }

  /**
   * Invalidates and removes a cached artifact directory.
   */
  async invalidateArtifact(digest: string): Promise<void> {
    const artifactPath = this.getArtifactPath(digest);
    await fs.promises.rm(artifactPath, { recursive: true, force: true });
  }

  /**
   * Reads and parses the ToolManifest for an extracted artifact.
   */
  getArtifactManifest(digest: string): ToolManifest | null {
    const artifactPath = this.getArtifactPath(digest);
    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(content);
      return ToolManifestSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Creates a dedicated temporary staging directory for atomic bundle extraction.
   */
  async createStagingDirectory(digest?: string): Promise<string> {
    await this.ensureDirectories();
    const prefix = digest ? `${this.sanitizePathDigest(digest).slice(0, 16)}_` : "";
    const stagingId = `${prefix}${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const stagingPath = path.join(this.stagingDir, stagingId);
    await fs.promises.mkdir(stagingPath, { recursive: true });
    return stagingPath;
  }

  /**
   * Atomically commits a staging directory to the content-addressed artifact directory.
   */
  async commitStagingDirectory(
    stagingPath: string,
    digest: string,
    metadata?: ExtractionMetadata,
  ): Promise<string> {
    const targetPath = this.getArtifactPath(digest);

    // Write .extracted metadata in staging if provided
    if (metadata) {
      const metadataPath = path.join(stagingPath, ".extracted");
      await fs.promises.writeFile(metadataPath, canonicalJson(metadata), "utf8");
    }

    // If target directory already exists (e.g. concurrent extraction), verify and remove staging
    if (fs.existsSync(targetPath)) {
      await fs.promises.rm(stagingPath, { recursive: true, force: true });
      return targetPath;
    }

    try {
      await fs.promises.rename(stagingPath, targetPath);
    } catch (err) {
      // Fallback for cross-device rename or race condition
      if (fs.existsSync(targetPath)) {
        await fs.promises.rm(stagingPath, { recursive: true, force: true });
        return targetPath;
      }
      throw err;
    }

    return targetPath;
  }

  /**
   * Verifies the integrity of an extracted artifact by re-validating manifest and file presence.
   * Matches pre-2f38e23 semantics.
   */
  async verifyArtifactIntegrity(digest: string): Promise<boolean> {
    const artifactPath = this.getArtifactPath(digest);
    if (!fs.existsSync(artifactPath)) return false;

    const manifestPath = path.join(artifactPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) return false;

    try {
      const manifestRaw = await fs.promises.readFile(manifestPath, "utf8");
      ToolManifestSchema.parse(JSON.parse(manifestRaw));
      const entrypointJsPath = path.join(artifactPath, BUNDLE_FILE_ENTRYPOINT_JS);
      const entrypointTsPath = path.join(artifactPath, BUNDLE_FILE_ENTRYPOINT_TS);
      if (!fs.existsSync(entrypointJsPath) && !fs.existsSync(entrypointTsPath)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verifies an extracted directory against a V1LockedToolEntry.
   * Performs path traversal checks, symlink escape checks, manifest identity/version/digest checks,
   * entrypoint existence checks, and signature verification.
   */
  async verifyExtractedDirectory(
    dirPath: string,
    entry: V1LockedToolEntry,
    options: VerifyLockedArtifactOptions = {},
  ): Promise<VerifyLockedArtifactResult> {
    const expectedArtifactDigest = this.strictNormalizeDigest(entry.artifactDigest);
    const expectedManifestDigest = this.strictNormalizeDigest(entry.manifestDigest);

    if (!fs.existsSync(dirPath)) {
      return { valid: false, error: `Directory does not exist: ${dirPath}` };
    }

    const stat = await fs.promises.lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        valid: false,
        reason: "symlink_escape",
        error: `Artifact root path is not a directory or is a symlink: ${dirPath}`,
      };
    }

    // 1. Recursive security checks (path traversal, symlinks escaping dirPath)
    const files: string[] = [];
    const dirsToVisit = [dirPath];
    let realRootDir: string;
    try {
      realRootDir = await fs.promises.realpath(dirPath);
    } catch (err) {
      return {
        valid: false,
        reason: "corrupted_archive",
        error: `Failed to resolve realpath for ${dirPath}: ${err}`,
      };
    }

    while (dirsToVisit.length > 0) {
      const currentDir = dirsToVisit.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch (err) {
        return {
          valid: false,
          reason: "corrupted_archive",
          error: `Failed to read directory ${currentDir}: ${err}`,
        };
      }

      for (const ent of entries) {
        const fullPath = path.join(currentDir, ent.name);
        const relPath = path.relative(dirPath, fullPath);

        try {
          validateBundleEntryPath(relPath.replace(/\\/g, "/"));
        } catch (err) {
          const reason: QuarantineReason =
            err instanceof BundleSecurityError && err.code === "SYMLINK_ESCAPE"
              ? "symlink_escape"
              : "path_traversal";
          return { valid: false, reason, error: `Security check failed for ${relPath}: ${err}` };
        }

        const entryLstat = await fs.promises.lstat(fullPath);
        if (entryLstat.isSymbolicLink()) {
          try {
            const resolvedPath = await fs.promises.realpath(fullPath);
            if (!resolvedPath.startsWith(realRootDir + path.sep) && resolvedPath !== realRootDir) {
              return {
                valid: false,
                reason: "symlink_escape",
                error: `Symlink ${relPath} escapes artifact root (${resolvedPath})`,
              };
            }
          } catch {
            return {
              valid: false,
              reason: "symlink_escape",
              error: `Symlink ${relPath} is broken or escapes directory`,
            };
          }
        } else if (entryLstat.isDirectory()) {
          dirsToVisit.push(fullPath);
        } else if (entryLstat.isFile()) {
          files.push(relPath);
        }
      }
    }

    // 2. Manifest verification
    const manifestPath = path.join(dirPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, reason: "manifest_invalid", error: `Missing ${BUNDLE_FILE_MANIFEST}` };
    }

    let manifestContent: string;
    let parsedManifestRaw: unknown;
    try {
      manifestContent = await fs.promises.readFile(manifestPath, "utf8");
      parsedManifestRaw = JSON.parse(manifestContent);
    } catch (err) {
      return {
        valid: false,
        reason: "manifest_invalid",
        error: `Failed to read or parse manifest.json: ${err}`,
      };
    }

    const manifestParseResult = ToolManifestSchema.safeParse(parsedManifestRaw);
    if (!manifestParseResult.success) {
      return {
        valid: false,
        reason: "manifest_invalid",
        error: `Manifest schema validation failed: ${manifestParseResult.error.message}`,
      };
    }
    const manifest = manifestParseResult.data;

    // Identity verification
    if (manifest.id !== entry.toolId && manifest.id !== entry.name) {
      return {
        valid: false,
        reason: "identity_mismatch",
        error: `Manifest toolId '${manifest.id}' does not match locked entry toolId '${entry.toolId}'`,
      };
    }
    if (manifest.name !== entry.name) {
      return {
        valid: false,
        reason: "manifest_invalid",
        error: `Manifest name '${manifest.name}' does not match locked entry name '${entry.name}'`,
      };
    }
    if (manifest.version !== entry.version) {
      return {
        valid: false,
        reason: "version_mismatch",
        error: `Manifest version '${manifest.version}' does not match locked entry version '${entry.version}'`,
      };
    }

    // Canonical manifest digest verification
    const computedManifestDigest = computeSha256(canonicalJson(manifest));
    if (computedManifestDigest !== expectedManifestDigest) {
      return {
        valid: false,
        reason: "digest_mismatch",
        error: `Manifest canonical digest mismatch: expected ${expectedManifestDigest}, computed ${computedManifestDigest}`,
      };
    }

    // 3. Entrypoint verification
    const fallbackJsPath = path.join(dirPath, BUNDLE_FILE_ENTRYPOINT_JS);
    const fallbackTsPath = path.join(dirPath, BUNDLE_FILE_ENTRYPOINT_TS);
    const hasEntrypoint = fs.existsSync(fallbackJsPath) || fs.existsSync(fallbackTsPath);
    if (!hasEntrypoint) {
      return {
        valid: false,
        reason: "corrupted_archive",
        error: `No valid entrypoint found (checked ${BUNDLE_FILE_ENTRYPOINT_JS}, ${BUNDLE_FILE_ENTRYPOINT_TS})`,
      };
    }

    // 4. Signature verification (if signature.json exists or keyStore provided)
    const sigPath = path.join(dirPath, BUNDLE_FILE_SIGNATURE);
    const hasSig = fs.existsSync(sigPath);
    const keyStore = options.keyStore ?? this.keyStore;

    if (hasSig) {
      try {
        const sigContent = await fs.promises.readFile(sigPath, "utf8");
        const sigData = JSON.parse(sigContent);

        if (entry.signatureIdentity?.keyId && sigData.keyId !== entry.signatureIdentity.keyId) {
          return {
            valid: false,
            reason: "signature_mismatch",
            error: `Signature keyId '${sigData.keyId}' does not match locked entry keyId '${entry.signatureIdentity.keyId}'`,
          };
        }

        if (keyStore) {
          const fileDigests: Record<string, string> = {};
          for (const file of files) {
            if (file === BUNDLE_FILE_SIGNATURE || file === ".extracted") continue;
            const content = await fs.promises.readFile(path.join(dirPath, file));
            fileDigests[file.replace(/\\/g, "/")] = computeSha256(content);
          }

          const sigVerifyResult = await verifyBundleSignature(sigData, keyStore, {
            allowDevKeys: options.allowDevKeys,
            expectedFileDigests: fileDigests,
          });

          if (!sigVerifyResult.valid) {
            return {
              valid: false,
              reason: "signature_mismatch",
              error: `Bundle signature verification failed: ${sigVerifyResult.error ?? sigVerifyResult.reason}`,
            };
          }
        }
      } catch (err) {
        return {
          valid: false,
          reason: "signature_mismatch",
          error: `Signature inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    let metadata: ExtractionMetadata | undefined;
    const metaPath = path.join(dirPath, ".extracted");
    const hasMeta = fs.existsSync(metaPath);
    if (hasMeta) {
      try {
        const metaContent = await fs.promises.readFile(metaPath, "utf8");
        metadata = JSON.parse(metaContent);
      } catch (err) {
        return {
          valid: false,
          reason: "corrupted_archive",
          error: `Failed to read or parse .extracted metadata in ${dirPath}: ${err}`,
        };
      }

      if (!metadata || !metadata.verified || !metadata.digest) {
        return {
          valid: false,
          reason: "corrupted_archive",
          error: `Invalid or unverified .extracted metadata in ${dirPath}`,
        };
      }

      const normalizedMetaDigest = this.strictNormalizeDigest(metadata.digest);
      if (normalizedMetaDigest !== expectedArtifactDigest) {
        return {
          valid: false,
          reason: "digest_mismatch",
          error: `Extracted artifact digest '${normalizedMetaDigest}' does not match expected locked artifactDigest '${expectedArtifactDigest}'`,
        };
      }
    } else if (options.requireExtractionMetadata) {
      return {
        valid: false,
        reason: "corrupted_archive",
        error: `Missing required .extracted metadata in ${dirPath}`,
      };
    }

    return {
      valid: true,
      targetPath: dirPath,
      manifest,
      metadata,
    };
  }

  /**
   * Verifies the cached artifact directory corresponding to a V1LockedToolEntry.
   */
  async verifyLockedArtifact(
    entry: V1LockedToolEntry,
    options: VerifyLockedArtifactOptions = {},
  ): Promise<VerifyLockedArtifactResult> {
    const artifactDigest = this.strictNormalizeDigest(entry.artifactDigest);
    const targetPath = this.getArtifactPath(artifactDigest);
    if (!fs.existsSync(targetPath)) {
      return { valid: false, error: `Artifact directory does not exist: ${targetPath}` };
    }
    return this.verifyExtractedDirectory(targetPath, entry, {
      ...options,
      requireExtractionMetadata: options.requireExtractionMetadata ?? true,
    });
  }

  /**
   * Returns verified cached artifact path if present and valid.
   * If existing target is corrupt or tampered, it is quarantined and removed from cache.
   */
  async getVerifiedLockedArtifact(
    entry: V1LockedToolEntry,
    options: VerifyLockedArtifactOptions = {},
  ): Promise<string | null> {
    const artifactDigest = this.strictNormalizeDigest(entry.artifactDigest);
    const targetPath = this.getArtifactPath(artifactDigest);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    const result = await this.verifyLockedArtifact(entry, options);
    if (result.valid) {
      return targetPath;
    }

    // Corrupt target detected! Quarantine and remove from cacheDir
    await this.quarantine.quarantineDirectory(
      targetPath,
      result.reason ?? "corrupted_target",
      { entry, error: result.error, targetPath },
      artifactDigest,
      entry.name,
      { preserveSource: false },
    );
    if (fs.existsSync(targetPath)) {
      await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    }
    return null;
  }

  /**
   * Checks whether a locked artifact is cached and valid.
   */
  async isLockedArtifactCached(
    entry: V1LockedToolEntry,
    options: VerifyLockedArtifactOptions = {},
  ): Promise<boolean> {
    const artifactDigest = this.strictNormalizeDigest(entry.artifactDigest);
    const targetPath = this.getArtifactPath(artifactDigest);
    if (!fs.existsSync(targetPath)) {
      return false;
    }
    const manifestPath = path.join(targetPath, BUNDLE_FILE_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      return false;
    }

    const result = await this.verifyLockedArtifact(entry, options);
    return result.valid;
  }

  /**
   * Installs and verifies a locked artifact into cacheDir from an archive buffer, file path,
   * or extraction callback.
   * - Strict SHA-256 validation against entry.artifactDigest.
   * - Deduplicates identical immutable bytes across projects.
   * - Converges concurrent installations atomically.
   * - Records project/identity references strictly in refs.json without leaking to shared blob.
   */
  async installLockedArtifact(
    entry: V1LockedToolEntry,
    source: Buffer | Uint8Array | string | ((stagingDir: string) => Promise<void>),
    options: InstallLockedArtifactOptions = {},
  ): Promise<string> {
    const artifactDigest = this.strictNormalizeDigest(entry.artifactDigest);

    let targetPath: string;

    // 1. Fast path: reuse existing verified cached artifact (deduplication across projects)
    const existing =
      options.force === true
        ? null
        : await this.getVerifiedLockedArtifact(entry, {
            keyStore: options.keyStore ?? this.keyStore,
            allowDevKeys: options.allowDevKeys,
          });

    if (existing) {
      targetPath = existing;
    } else {
      // 2. Converge concurrent in-flight installations for the same artifact digest
      let inFlight = this.activeInstalls.get(artifactDigest);
      if (!inFlight) {
        inFlight = (async () => {
          const stagingPath = await this.createStagingDirectory(artifactDigest);
          try {
            // 3. Extract/populate staging directory
            if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
              const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
              const computedPayloadDigest = computeSha256(buf);
              if (computedPayloadDigest !== artifactDigest) {
                await this.quarantine.quarantinePayload(
                  buf,
                  "digest_mismatch",
                  { expected: artifactDigest, actual: computedPayloadDigest },
                  artifactDigest,
                  entry.name,
                );
                throw new BundleSecurityError(
                  "DIGEST_MISMATCH",
                  `Archive buffer SHA-256 digest ${computedPayloadDigest} does not match locked artifactDigest ${artifactDigest}`,
                  entry.name,
                  { expectedDigest: artifactDigest, actualDigest: computedPayloadDigest },
                );
              }

              let entries: Array<{
                path: string;
                mode?: number;
                size: number;
                typeflag: string;
                content?: Buffer;
              }>;
              try {
                entries = parseTarArchive(buf);
              } catch (err) {
                await this.quarantine.quarantinePayload(
                  buf,
                  "corrupted_archive",
                  { error: err instanceof Error ? err.message : String(err) },
                  artifactDigest,
                  entry.name,
                );
                throw new Error(`Failed to parse tar archive: ${err}`);
              }

              for (const ent of entries) {
                try {
                  validateBundleEntryPath(ent.path.replace(/\\/g, "/"));
                } catch (err) {
                  const reason: QuarantineReason =
                    err instanceof BundleSecurityError && err.code === "SYMLINK_ESCAPE"
                      ? "symlink_escape"
                      : "path_traversal";
                  await this.quarantine.quarantinePayload(
                    buf,
                    reason,
                    {
                      entryPath: ent.path,
                      error: err instanceof Error ? err.message : String(err),
                    },
                    artifactDigest,
                    entry.name,
                  );
                  throw err;
                }

                const targetFile = path.join(stagingPath, ent.path);
                if (ent.typeflag === "5" || ent.path.endsWith("/")) {
                  await fs.promises.mkdir(targetFile, { recursive: true, mode: 0o700 });
                } else {
                  await fs.promises.mkdir(path.dirname(targetFile), {
                    recursive: true,
                    mode: 0o700,
                  });
                  await fs.promises.writeFile(targetFile, ent.content ?? Buffer.alloc(0), {
                    mode: 0o600,
                  });
                }
              }
            } else if (Object.prototype.toString.call(source) === "[object String]") {
              // SAFETY: Object tag check confirms source is a filesystem path string.
              const sourcePath = source as string;
              const srcStat = await fs.promises.stat(sourcePath);
              if (srcStat.isDirectory()) {
                await this.copyDirectorySafe(sourcePath, stagingPath);
              } else {
                const fileBuf = await fs.promises.readFile(sourcePath);
                return this.installLockedArtifact(entry, fileBuf, options);
              }
            } else if (
              Object.prototype.toString.call(source) === "[object Function]" ||
              Object.prototype.toString.call(source) === "[object AsyncFunction]"
            ) {
              // SAFETY: Function type confirms source is a custom install function.
              const sourceFn = source as (path: string) => Promise<void>;
              await sourceFn(stagingPath);
            }

            // 4. Verify staged content against V1LockedToolEntry
            const verifyResult = await this.verifyExtractedDirectory(stagingPath, entry, {
              keyStore: options.keyStore ?? this.keyStore,
              allowDevKeys: options.allowDevKeys,
            });

            if (!verifyResult.valid) {
              await this.quarantine.quarantineDirectory(
                stagingPath,
                verifyResult.reason ?? "manifest_invalid",
                { entry, error: verifyResult.error },
                artifactDigest,
                entry.name,
                { preserveSource: false },
              );
              throw new Error(`Staged locked artifact verification failed: ${verifyResult.error}`);
            }

            // 5. Compute public file stats for .extracted (never leak project/identity metadata)
            let fileCount = 0;
            let totalSizeBytes = 0;
            const stack = [stagingPath];
            while (stack.length > 0) {
              const current = stack.pop()!;
              const dirents = await fs.promises.readdir(current, { withFileTypes: true });
              for (const d of dirents) {
                const p = path.join(current, d.name);
                const s = await fs.promises.lstat(p);
                if (s.isDirectory()) {
                  stack.push(p);
                } else if (s.isFile()) {
                  fileCount++;
                  totalSizeBytes += s.size;
                }
              }
            }

            const entrypointJs = path.join(stagingPath, BUNDLE_FILE_ENTRYPOINT_JS);
            const entrypoint = fs.existsSync(entrypointJs)
              ? BUNDLE_FILE_ENTRYPOINT_JS
              : BUNDLE_FILE_ENTRYPOINT_TS;

            const metadata: ExtractionMetadata = {
              digest: artifactDigest,
              extractedAt: new Date().toISOString(),
              fileCount,
              totalSizeBytes,
              entrypoint,
              verified: true,
            };

            // 6. Atomically commit staging directory
            return await this.commitStagingDirectory(stagingPath, artifactDigest, metadata);
          } finally {
            if (fs.existsSync(stagingPath)) {
              await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
            }
          }
        })();

        this.activeInstalls.set(artifactDigest, inFlight);
      }

      try {
        targetPath = await inFlight;
      } finally {
        this.activeInstalls.delete(artifactDigest);
      }
    }

    // 7. Add caller-specific reference (strictly isolated to refs.json and serialized)
    if (options.reference) {
      await this.acquireReference(artifactDigest, {
        refId: options.reference.refId,
        refType: options.reference.refType ?? "active",
        toolId: entry.toolId,
        version: entry.version,
        createdAt: new Date().toISOString(),
        metadata: options.reference.metadata,
      });
    }

    return targetPath;
  }

  private async copyDirectorySafe(srcDir: string, destDir: string): Promise<void> {
    const realSrc = await fs.promises.realpath(srcDir);
    const stack: Array<{ src: string; dest: string }> = [{ src: srcDir, dest: destDir }];

    while (stack.length > 0) {
      const { src, dest } = stack.pop()!;
      await fs.promises.mkdir(dest, { recursive: true });
      const entries = await fs.promises.readdir(src, { withFileTypes: true });

      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        const lstat = await fs.promises.lstat(srcPath);
        if (lstat.isSymbolicLink()) {
          const resolved = await fs.promises.realpath(srcPath);
          if (!resolved.startsWith(realSrc + path.sep) && resolved !== realSrc) {
            throw new BundleSecurityError("SYMLINK_ESCAPE", `Symlink ${srcPath} escapes directory`);
          }
          const linkTarget = await fs.promises.readlink(srcPath);
          await fs.promises.symlink(linkTarget, destPath);
        } else if (lstat.isDirectory()) {
          stack.push({ src: srcPath, dest: destPath });
        } else if (lstat.isFile()) {
          await fs.promises.copyFile(srcPath, destPath);
        }
      }
    }
  }

  // --- Reference Count Management ---

  private readRefsSync(): Record<string, ArtifactReference[]> {
    if (!fs.existsSync(this.refsFilePath)) return {};
    try {
      const content = fs.readFileSync(this.refsFilePath, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async readRefs(): Promise<Record<string, ArtifactReference[]>> {
    if (!fs.existsSync(this.refsFilePath)) return {};
    try {
      const content = await fs.promises.readFile(this.refsFilePath, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private async writeRefs(refs: Record<string, ArtifactReference[]>): Promise<void> {
    await this.ensureDirectories();
    const tempFile = `${this.refsFilePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(tempFile, canonicalJson(refs), "utf8");
    await fs.promises.rename(tempFile, this.refsFilePath);
  }

  /**
   * Acquires a reference to an artifact digest.
   * Serialized with withRefLock to guarantee atomic read-modify-write without lost updates.
   */
  async acquireReference(digest: string, ref: ArtifactReference): Promise<void> {
    return this.withRefLock(async () => {
      const cleanDigest = this.sanitizePathDigest(digest);
      const refs = await this.readRefs();
      const existing = refs[cleanDigest] ?? [];
      const filtered = existing.filter((r) => r.refId !== ref.refId);
      filtered.push(ref);
      refs[cleanDigest] = filtered;
      await this.writeRefs(refs);
    });
  }

  async addReference(digest: string, ref: ArtifactReference): Promise<void> {
    return this.acquireReference(digest, ref);
  }

  /**
   * Releases a specific reference by refId.
   * Serialized with withRefLock to guarantee atomic read-modify-write.
   */
  async releaseReference(digest: string, refId: string): Promise<boolean> {
    return this.withRefLock(async () => {
      const cleanDigest = this.sanitizePathDigest(digest);
      const refs = await this.readRefs();
      if (!refs[cleanDigest]) return false;

      const beforeLen = refs[cleanDigest].length;
      refs[cleanDigest] = refs[cleanDigest].filter((r) => r.refId !== refId);

      if (refs[cleanDigest].length === 0) {
        delete refs[cleanDigest];
      }

      if (beforeLen !== (refs[cleanDigest]?.length ?? 0)) {
        await this.writeRefs(refs);
        return true;
      }
      return false;
    });
  }

  async removeReference(digest: string, refId: string): Promise<void> {
    await this.releaseReference(digest, refId);
  }

  /**
   * Retrieves all active references for a specific digest.
   */
  async getReferences(digest: string): Promise<ArtifactReference[]> {
    return this.withRefLock(async () => {
      const cleanDigest = this.sanitizePathDigest(digest);
      const refs = await this.readRefs();
      return refs[cleanDigest] ?? [];
    });
  }

  /**
   * Retrieves all artifact references map.
   */
  async getAllReferences(): Promise<Record<string, ArtifactReference[]>> {
    return this.withRefLock(async () => {
      return this.readRefs();
    });
  }

  getAllReferencesSync(): Record<string, ArtifactReference[]> {
    return this.readRefsSync();
  }

  /**
   * Checks if an artifact has any active references.
   */
  async hasReferences(digest: string): Promise<boolean> {
    const refs = await this.getReferences(digest);
    return refs.length > 0;
  }
}
