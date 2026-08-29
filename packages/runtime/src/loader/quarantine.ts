import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "@resin/contracts";
import { z } from "zod";

export type QuarantineReason =
  | "signature_mismatch"
  | "digest_mismatch"
  | "path_traversal"
  | "decompression_bomb"
  | "corrupted_archive"
  | "manifest_invalid"
  | "policy_violation"
  | "symlink_escape"
  | "resource_limit_exceeded"
  | "unapproved_candidate"
  | "approval_drift"
  | "unexpected_effect"
  | "corrupted_target"
  | "identity_mismatch"
  | "version_mismatch"
  | "manifest_mismatch";

export interface QuarantineDirectoryOptions {
  preserveSource?: boolean;
}

export const QuarantineRecordSchema = z.object({
  quarantineId: z.string().min(1),
  digest: z.string().optional(),
  reason: z.enum([
    "signature_mismatch",
    "digest_mismatch",
    "path_traversal",
    "decompression_bomb",
    "corrupted_archive",
    "manifest_invalid",
    "policy_violation",
    "symlink_escape",
    "resource_limit_exceeded",
    "unapproved_candidate",
    "approval_drift",
    "unexpected_effect",
    "corrupted_target",
    "identity_mismatch",
    "version_mismatch",
    "manifest_mismatch",
  ]),
  quarantinedAt: z.string(),
  details: z.record(z.unknown()).default({}),
  sourceIdentifier: z.string().optional(),
  payloadSize: z.number().int().nonnegative(),
  quarantinePath: z.string(),
});
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;

export interface QuarantineManagerOptions {
  quarantineDir: string;
}

/**
 * Normalizes and extracts a safe hex digest prefix, or recomputes sha256 from data buffer.
 */
function sanitizeHexDigest(rawDigest: string | undefined, data?: Buffer | string): string {
  if (rawDigest) {
    const stripped = rawDigest.replace(/^sha256:/i, "").trim();
    if (/^[0-9a-fA-F]{16,64}$/.test(stripped)) {
      return stripped.slice(0, 16).toLowerCase();
    }
  }
  if (data !== undefined) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  }
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Recursively copies regular files from source directory into target directory
 * using strict lstat and no-follow semantics, rejecting symlinks and special files,
 * and reserving the 'record.json' filename for quarantine audit records.
 */
async function copyQuarantineDirectorySafe(
  sourceRoot: string,
  targetRoot: string,
): Promise<{ totalSize: number; rejectedSymlinks: string[] }> {
  let totalSize = 0;
  const rejectedSymlinks: string[] = [];

  async function walk(currentSrc: string): Promise<void> {
    const srcStat = await fs.promises.lstat(currentSrc);
    if (srcStat.isSymbolicLink()) {
      rejectedSymlinks.push(currentSrc);
      return;
    }
    if (!srcStat.isDirectory()) {
      return;
    }

    const dirents = await fs.promises.readdir(currentSrc, { withFileTypes: true });
    for (const dirent of dirents) {
      const srcPath = path.join(currentSrc, dirent.name);
      let entryStat: fs.Stats;
      try {
        entryStat = await fs.promises.lstat(srcPath);
      } catch {
        continue;
      }

      if (entryStat.isSymbolicLink()) {
        rejectedSymlinks.push(srcPath);
        continue;
      }

      const relPath = path.relative(sourceRoot, srcPath);
      // Validate no escape
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
        continue;
      }

      if (entryStat.isDirectory()) {
        const destDir = path.resolve(targetRoot, relPath);
        if (!destDir.startsWith(targetRoot + path.sep) && destDir !== targetRoot) {
          continue;
        }
        await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 });
        await walk(srcPath);
      } else if (entryStat.isFile()) {
        // Reserve record.json so source payloads never overwrite or collide with the audit record
        let targetRelPath = relPath;
        const normalizedRel = relPath.replace(/\\/g, "/");
        if (normalizedRel === "record.json" || path.basename(relPath) === "record.json") {
          targetRelPath = path.join(path.dirname(relPath), "source_record.json");
        }

        const destFile = path.resolve(targetRoot, targetRelPath);
        if (!destFile.startsWith(targetRoot + path.sep)) {
          continue;
        }

        await fs.promises.mkdir(path.dirname(destFile), { recursive: true, mode: 0o700 });
        const content = await fs.promises.readFile(srcPath);
        totalSize += content.length;
        await fs.promises.writeFile(destFile, content, { mode: 0o600, flag: "w" });
      }
      // Non-regular files (FIFOs, sockets, block/character devices) are strictly ignored/rejected
    }
  }

  const rootStat = await fs.promises.lstat(sourceRoot).catch(() => null);
  if (rootStat && !rootStat.isSymbolicLink() && rootStat.isDirectory()) {
    await walk(sourceRoot);
  }

  return { totalSize, rejectedSymlinks };
}

/**
 * Atomically writes a quarantine audit record file to targetDir without following symlinks.
 */
async function writeQuarantineRecordAtomic(
  targetDir: string,
  record: QuarantineRecord,
): Promise<void> {
  const recordFile = path.join(targetDir, "record.json");
  const tempFile = path.join(targetDir, `.record_${crypto.randomUUID()}.tmp`);
  const recordJson = canonicalJson(record);

  await fs.promises.writeFile(tempFile, recordJson, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.promises.rename(tempFile, recordFile);
}

/**
 * Quarantine manager isolating and inspecting corrupted, tampered, or malicious artifacts.
 */
export class QuarantineManager {
  readonly quarantineDir: string;

  constructor(options: QuarantineManagerOptions) {
    this.quarantineDir = path.resolve(options.quarantineDir);
  }

  async ensureDirectory(): Promise<void> {
    await fs.promises.mkdir(this.quarantineDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Quarantines an in-memory buffer or string artifact.
   */
  async quarantinePayload(
    payload: Buffer | string,
    reason: QuarantineReason,
    details: QuarantineRecord["details"] = {},
    digest?: string,
    sourceIdentifier?: string,
  ): Promise<QuarantineRecord> {
    await this.ensureDirectory();

    const timestamp = new Date().toISOString();
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const computedDigest = `sha256:${crypto.createHash("sha256").update(payloadBuffer).digest("hex")}`;
    const safeDigestHex = sanitizeHexDigest(digest, payloadBuffer);
    const safeUUID = crypto
      .randomUUID()
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8);
    const quarantineId = `quarantine_${Date.now()}_${safeDigestHex}_${safeUUID}`;

    // Verify quarantineId is strictly alphanumeric and safe
    if (!/^[a-zA-Z0-9_-]+$/.test(quarantineId)) {
      throw new Error("Invalid quarantine ID generated");
    }

    const resolvedQuarantineDir = path.resolve(this.quarantineDir);
    const targetDir = path.resolve(resolvedQuarantineDir, quarantineId);

    // Strict containment assertion before mkdir or file writing
    if (!targetDir.startsWith(resolvedQuarantineDir + path.sep)) {
      throw new Error("Quarantine target directory path escapes quarantine root");
    }

    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const totalSize = payloadBuffer.length;
    const payloadFile = path.join(targetDir, "payload.bin");
    await fs.promises.writeFile(payloadFile, payloadBuffer, { mode: 0o600, flag: "wx" });

    const record: QuarantineRecord = {
      quarantineId,
      digest: digest && /^sha256:[0-9a-fA-F]{64}$/i.test(digest) ? digest : computedDigest,
      reason,
      quarantinedAt: timestamp,
      details,
      sourceIdentifier,
      payloadSize: totalSize,
      quarantinePath: targetDir,
    };

    await writeQuarantineRecordAtomic(targetDir, record);
    return record;
  }

  /**
   * Quarantines a whole directory (e.g. invalid extracted artifact).
   */
  async quarantineDirectory(
    sourceDir: string,
    reason: QuarantineReason,
    details: QuarantineRecord["details"] = {},
    digest?: string,
    sourceIdentifier?: string,
    options: QuarantineDirectoryOptions = {},
  ): Promise<QuarantineRecord> {
    await this.ensureDirectory();

    const timestamp = new Date().toISOString();
    const safeDigestHex = sanitizeHexDigest(digest, sourceDir);
    const safeUUID = crypto
      .randomUUID()
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8);
    const quarantineId = `quarantine_${Date.now()}_${safeDigestHex}_${safeUUID}`;

    if (!/^[a-zA-Z0-9_-]+$/.test(quarantineId)) {
      throw new Error("Invalid quarantine ID generated");
    }

    const resolvedQuarantineDir = path.resolve(this.quarantineDir);
    const targetDir = path.resolve(resolvedQuarantineDir, quarantineId);

    // Strict containment assertion before mkdir or file writing
    if (!targetDir.startsWith(resolvedQuarantineDir + path.sep)) {
      throw new Error("Quarantine target directory path escapes quarantine root");
    }

    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });

    let totalSize = 0;
    let extraDetails: QuarantineRecord["details"] = { ...details };

    try {
      const srcStat = await fs.promises.lstat(sourceDir).catch(() => null);
      if (srcStat) {
        if (srcStat.isSymbolicLink()) {
          extraDetails = {
            ...extraDetails,
            rejectedSourceSymlink: true,
            originalSource: sourceDir,
          };
        } else {
          const copyResult = await copyQuarantineDirectorySafe(sourceDir, targetDir);
          totalSize = copyResult.totalSize;
          if (copyResult.rejectedSymlinks.length > 0) {
            extraDetails = {
              ...extraDetails,
              rejectedSymlinks: copyResult.rejectedSymlinks,
            };
          }
        }

        if (!options.preserveSource) {
          try {
            await fs.promises.rm(sourceDir, { recursive: true, force: true });
          } catch {
            // Ignore removal errors for source
          }
        }
      }
    } catch (err) {
      extraDetails = {
        ...extraDetails,
        quarantineCopyError: err instanceof Error ? err.message : String(err),
      };
    }

    const record: QuarantineRecord = {
      quarantineId,
      digest,
      reason,
      quarantinedAt: timestamp,
      details: extraDetails,
      sourceIdentifier,
      payloadSize: totalSize,
      quarantinePath: targetDir,
    };

    await writeQuarantineRecordAtomic(targetDir, record);
    return record;
  }

  /**
   * Retrieves a specific quarantine record by ID.
   */
  async getQuarantined(quarantineId: string): Promise<QuarantineRecord | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(quarantineId)) {
      return null;
    }
    const resolvedQuarantineDir = path.resolve(this.quarantineDir);
    const targetDir = path.resolve(resolvedQuarantineDir, quarantineId);
    if (!targetDir.startsWith(resolvedQuarantineDir + path.sep)) {
      return null;
    }

    const recordFile = path.join(targetDir, "record.json");
    try {
      const stat = await fs.promises.lstat(recordFile);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return null;
      }
      const raw = await fs.promises.readFile(recordFile, "utf8");
      return QuarantineRecordSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Lists all quarantined records.
   */
  async listQuarantined(): Promise<QuarantineRecord[]> {
    if (!fs.existsSync(this.quarantineDir)) return [];

    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(this.quarantineDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const records: QuarantineRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const targetDir = path.join(this.quarantineDir, entry.name);
      try {
        const dirStat = await fs.promises.lstat(targetDir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;

        const recordPath = path.join(targetDir, "record.json");
        const stat = await fs.promises.lstat(recordPath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;

        const raw = await fs.promises.readFile(recordPath, "utf8");
        const parsed = JSON.parse(raw);
        records.push(QuarantineRecordSchema.parse(parsed));
      } catch {
        // Skip unparseable or inaccessible records
      }
    }

    return records.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
  }

  /**
   * Purges old quarantine entries exceeding max age or limit.
   */
  async purgeQuarantine(
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ): Promise<{ purgedCount: number; freedBytes: number }> {
    const records = await this.listQuarantined();
    const now = Date.now();
    let purgedCount = 0;
    let freedBytes = 0;

    for (const record of records) {
      const recordTime = new Date(record.quarantinedAt).getTime();
      if (now - recordTime > maxAgeMs) {
        try {
          const resolvedPath = path.resolve(record.quarantinePath);
          if (resolvedPath.startsWith(this.quarantineDir + path.sep)) {
            await fs.promises.rm(resolvedPath, { recursive: true, force: true });
            purgedCount++;
            freedBytes += record.payloadSize;
          }
        } catch {
          // Ignore deletion error
        }
      }
    }

    return { purgedCount, freedBytes };
  }
}
