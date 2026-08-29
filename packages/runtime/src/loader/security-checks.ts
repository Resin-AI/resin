import fs from "node:fs";
import path from "node:path";
import type { CanonicalJsonRecord } from "@resin/contracts";
import { type BundleLimits, DEFAULT_BUNDLE_LIMITS } from "../bundle/spec.js";
export type BundleSecurityErrorCode =
  | "PATH_TRAVERSAL"
  | "ABSOLUTE_PATH"
  | "SYMLINK_ESCAPE"
  | "DEVICE_FILE_PROHIBITED"
  | "FILE_COUNT_EXCEEDED"
  | "FILE_SIZE_EXCEEDED"
  | "DECOMPRESSED_SIZE_EXCEEDED"
  | "DECOMPRESSION_BOMB_DETECTED"
  | "RESERVED_FILENAME"
  | "INVALID_PATH_CHARACTERS"
  | "DIGEST_MISMATCH";

export interface DecompressionStats {
  fileCount: number;
  totalDecompressedBytes: number;
}

export class BundleSecurityError extends Error {
  readonly code: BundleSecurityErrorCode;
  readonly targetPath?: string;
  readonly details?: CanonicalJsonRecord;

  constructor(
    code: BundleSecurityErrorCode,
    message: string,
    targetPath?: string,
    details?: CanonicalJsonRecord,
  ) {
    super(message);
    this.name = "BundleSecurityError";
    this.code = code;
    this.targetPath = targetPath;
    this.details = details;
  }
}

/**
 * Windows reserved device names (case-insensitive).
 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Validates a single relative file path inside a tool bundle.
 *
 * Checks:
 * - No path traversal (../ or ..\ or ..)
 * - No absolute paths (/ or \\ or C:\)
 * - No null bytes or control characters
 * - No device file names
 * - No .git directory tampering
 */
export function validateBundleEntryPath(entryPath: string): string {
  if (!entryPath || Object.prototype.toString.call(entryPath) !== "[object String]") {
    throw new BundleSecurityError(
      "INVALID_PATH_CHARACTERS",
      "Bundle entry path must be a non-empty string",
      entryPath,
    );
  }

  // Check for null bytes or control characters
  if (/[\0\r\n]/.test(entryPath)) {
    throw new BundleSecurityError(
      "INVALID_PATH_CHARACTERS",
      `Bundle entry path contains prohibited control characters: ${JSON.stringify(entryPath)}`,
      entryPath,
    );
  }

  // Check for absolute paths on Unix or Windows
  if (
    entryPath.startsWith("/") ||
    entryPath.startsWith("\\") ||
    /^[a-zA-Z]:[/\\]/.test(entryPath)
  ) {
    throw new BundleSecurityError(
      "ABSOLUTE_PATH",
      `Bundle entry path cannot be absolute: ${entryPath}`,
      entryPath,
    );
  }

  // Split path segments and inspect
  const segments = entryPath.split(/[/\\]+/);
  for (const segment of segments) {
    if (segment === "..") {
      throw new BundleSecurityError(
        "PATH_TRAVERSAL",
        `Path traversal detected in bundle path: ${entryPath}`,
        entryPath,
      );
    }

    const baseNameWithoutExt = segment.split(".")[0]?.toLowerCase() ?? "";
    if (WINDOWS_RESERVED_NAMES.has(baseNameWithoutExt)) {
      throw new BundleSecurityError(
        "DEVICE_FILE_PROHIBITED",
        `Bundle path references prohibited device file name: ${segment}`,
        entryPath,
      );
    }

    if (segment === ".git") {
      throw new BundleSecurityError(
        "RESERVED_FILENAME",
        `Bundle path cannot reference .git metadata: ${entryPath}`,
        entryPath,
      );
    }
  }

  const normalized = path.posix.normalize(entryPath.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === "..") {
    throw new BundleSecurityError(
      "PATH_TRAVERSAL",
      `Normalized path traversal detected: ${entryPath}`,
      entryPath,
    );
  }

  return normalized;
}

/**
 * Resolves a safe extraction path under the target root, verifying that the target does not escape.
 */
export function resolveSafeTargetPath(targetRoot: string, relativeEntryPath: string): string {
  const normalizedRelative = validateBundleEntryPath(relativeEntryPath);
  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedTarget = path.resolve(resolvedTargetRoot, normalizedRelative);

  // Ensure resolved path starts with resolvedTargetRoot + separator
  if (
    resolvedTarget !== resolvedTargetRoot &&
    !resolvedTarget.startsWith(resolvedTargetRoot + path.sep)
  ) {
    throw new BundleSecurityError(
      "PATH_TRAVERSAL",
      `Resolved extraction path ${resolvedTarget} escapes target root ${resolvedTargetRoot}`,
      relativeEntryPath,
    );
  }

  return resolvedTarget;
}

/**
 * Validates that an existing filesystem path or symlink does not escape targetRoot.
 */
export function validateNoSymlinkEscapes(targetRoot: string, filePath: string): void {
  const resolvedRoot = path.resolve(targetRoot);
  if (!fs.existsSync(filePath)) return;

  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    const realTarget = fs.realpathSync(filePath);
    if (!realTarget.startsWith(resolvedRoot + path.sep) && realTarget !== resolvedRoot) {
      throw new BundleSecurityError(
        "SYMLINK_ESCAPE",
        `Symlink ${filePath} points outside target root to ${realTarget}`,
        filePath,
      );
    }
  }
}

/**
 * State tracker to guard against file count limits, size limits, and decompression bombs.
 */
export class BundleResourceTracker {
  private fileCount = 0;
  private totalDecompressedBytes = 0;
  private readonly limits: BundleLimits;
  private readonly compressedArchiveSizeBytes: number;

  constructor(compressedSizeBytes = 0, limits: Partial<BundleLimits> = {}) {
    this.limits = { ...DEFAULT_BUNDLE_LIMITS, ...limits };
    this.compressedArchiveSizeBytes = compressedSizeBytes;
  }

  /**
   * Tracks a new entry and enforces resource bounds.
   */
  trackEntry(relativePath: string, entrySizeBytes: number): void {
    if (this.fileCount + 1 > this.limits.maxFileCount) {
      throw new BundleSecurityError(
        "FILE_COUNT_EXCEEDED",
        `Bundle exceeds maximum file count limit of ${this.limits.maxFileCount} (found ${this.fileCount + 1})`,
        relativePath,
        { fileCount: this.fileCount + 1, maxFileCount: this.limits.maxFileCount },
      );
    }

    if (entrySizeBytes > this.limits.maxFileSizeBytes) {
      throw new BundleSecurityError(
        "FILE_SIZE_EXCEEDED",
        `File ${relativePath} size (${entrySizeBytes} bytes) exceeds maximum file limit of ${this.limits.maxFileSizeBytes} bytes`,
        relativePath,
        { entrySizeBytes, maxFileSizeBytes: this.limits.maxFileSizeBytes },
      );
    }

    const newTotal = this.totalDecompressedBytes + entrySizeBytes;
    if (newTotal > this.limits.maxDecompressedSizeBytes) {
      throw new BundleSecurityError(
        "DECOMPRESSED_SIZE_EXCEEDED",
        `Total uncompressed bundle size (${newTotal} bytes) exceeds limit of ${this.limits.maxDecompressedSizeBytes} bytes`,
        relativePath,
        {
          totalBytes: newTotal,
          maxBytes: this.limits.maxDecompressedSizeBytes,
        },
      );
    }

    // Check decompression ratio if archive size is known and significant
    if (this.compressedArchiveSizeBytes > 1024 && newTotal > 5 * 1024 * 1024) {
      const ratio = newTotal / this.compressedArchiveSizeBytes;
      if (ratio > this.limits.maxDecompressionRatio) {
        throw new BundleSecurityError(
          "DECOMPRESSION_BOMB_DETECTED",
          `Decompression ratio ${ratio.toFixed(1)} exceeds limit of ${this.limits.maxDecompressionRatio} (possible zip bomb)`,
          relativePath,
          { ratio, maxRatio: this.limits.maxDecompressionRatio },
        );
      }
    }

    this.fileCount++;
    this.totalDecompressedBytes += entrySizeBytes;
  }
  getStats(): DecompressionStats {
    return {
      fileCount: this.fileCount,
      totalDecompressedBytes: this.totalDecompressedBytes,
    };
  }
}
