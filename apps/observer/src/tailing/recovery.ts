import fs from "node:fs";
import path from "node:path";
import type { SourceCursor } from "@resin/harness-contracts";

/**
 * File descriptor and inode snapshot for lineage tracking.
 */
export interface FileIdentitySnapshot {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/**
 * Historical lineage entry when a file undergoes rotation or truncation.
 */
export interface LineageEntry {
  generation: number;
  fileIdentity: FileIdentitySnapshot;
  finalOffset: number;
  finalLine: number;
  rotatedAt: string;
  reason: "rotation" | "truncation" | "replacement" | "archival";
  archivePath?: string;
}

/**
 * Detected recovery condition.
 */
export type RecoveryCondition =
  | "normal"
  | "truncated"
  | "rotated"
  | "replaced"
  | "archived"
  | "inaccessible"
  | "missing";

/**
 * Assessment outcome returned by the recovery engine.
 */
export interface RecoveryAssessment {
  condition: RecoveryCondition;
  isActionable: boolean;
  currentIdentity?: FileIdentitySnapshot;
  previousIdentity?: FileIdentitySnapshot;
  suggestedOffset: number;
  suggestedLine: number;
  generation: number;
  archivePath?: string;
  message: string;
}

/**
 * Options for permission retry with exponential backoff.
 */
export interface PermissionRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Source recovery engine detecting file truncation, log rotation, copy-truncate,
 * archival, replacement, and permission recovery with lineage tracking.
 */
export class SourceRecoveryEngine {
  private generation = 0;
  private currentIdentity?: FileIdentitySnapshot;
  private lineageHistory: LineageEntry[] = [];

  constructor(initialSnapshot?: FileIdentitySnapshot) {
    this.currentIdentity = initialSnapshot;
  }

  /**
   * Returns unique device:inode string for file identity.
   */
  static getFileKey(stat: { dev: number; ino: number }): string {
    return `${stat.dev}:${stat.ino}`;
  }

  /**
   * Captures a FileIdentitySnapshot from fs.Stats.
   */
  static snapshotStat(stat: fs.Stats): FileIdentitySnapshot {
    return {
      ino: stat.ino,
      dev: stat.dev,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    };
  }

  /**
   * Probes the given file and compares with last known state to detect
   * rotations, truncations, replacements, or permission errors.
   */
  async probe(
    filePath: string,
    currentOffset: number,
    currentLine = 1,
  ): Promise<RecoveryAssessment> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      // SAFETY: Filesystem call error exposes NodeJS.ErrnoException code property.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          condition: "missing",
          isActionable: true,
          suggestedOffset: 0,
          suggestedLine: 1,
          generation: this.generation,
          message: `Transcript file does not exist: ${filePath}`,
        };
      }
      if (code === "EACCES" || code === "EPERM") {
        return {
          condition: "inaccessible",
          isActionable: true,
          suggestedOffset: currentOffset,
          suggestedLine: currentLine,
          generation: this.generation,
          message: `Permission denied reading transcript: ${filePath}`,
        };
      }
      throw err;
    }

    const currentSnapshot = SourceRecoveryEngine.snapshotStat(stat);

    // First time seeing the file
    if (!this.currentIdentity) {
      this.currentIdentity = currentSnapshot;
      return {
        condition: "normal",
        isActionable: false,
        currentIdentity: currentSnapshot,
        suggestedOffset: currentOffset,
        suggestedLine: currentLine,
        generation: this.generation,
        message: "Initial file snapshot captured.",
      };
    }

    const prev = this.currentIdentity;

    // 1. Inode / Device Change -> Rotation or Replacement
    if (prev.ino !== currentSnapshot.ino || prev.dev !== currentSnapshot.dev) {
      this.generation++;
      const archiveCandidate = await this.findRecentArchivedFile(filePath);

      const entry: LineageEntry = {
        generation: this.generation,
        fileIdentity: prev,
        finalOffset: currentOffset,
        finalLine: currentLine,
        rotatedAt: new Date().toISOString(),
        reason: archiveCandidate ? "archival" : "rotation",
        archivePath: archiveCandidate ?? undefined,
      };
      this.lineageHistory.push(entry);
      this.currentIdentity = currentSnapshot;

      return {
        condition: archiveCandidate ? "archived" : "rotated",
        isActionable: true,
        currentIdentity: currentSnapshot,
        previousIdentity: prev,
        suggestedOffset: 0,
        suggestedLine: 1,
        generation: this.generation,
        archivePath: archiveCandidate ?? undefined,
        message: `File rotation detected (inode changed from ${prev.ino} to ${currentSnapshot.ino}). Resetting offset to 0.`,
      };
    }

    // 2. File Size Smaller than Current Read Offset -> Truncation / Copy-Truncate
    if (currentSnapshot.size < currentOffset) {
      this.generation++;
      const entry: LineageEntry = {
        generation: this.generation,
        fileIdentity: prev,
        finalOffset: currentOffset,
        finalLine: currentLine,
        rotatedAt: new Date().toISOString(),
        reason: "truncation",
      };
      this.lineageHistory.push(entry);
      this.currentIdentity = currentSnapshot;

      return {
        condition: "truncated",
        isActionable: true,
        currentIdentity: currentSnapshot,
        previousIdentity: prev,
        suggestedOffset: 0,
        suggestedLine: 1,
        generation: this.generation,
        message: `File truncation detected (size shrank from >=${currentOffset} to ${currentSnapshot.size}). Resetting offset to 0.`,
      };
    }

    // Update snapshot with latest size/mtime
    this.currentIdentity = currentSnapshot;

    return {
      condition: "normal",
      isActionable: false,
      currentIdentity: currentSnapshot,
      suggestedOffset: currentOffset,
      suggestedLine: currentLine,
      generation: this.generation,
      message: "File is normal.",
    };
  }

  /**
   * Searches the parent directory for candidate archived rotated files.
   * e.g. transcript.jsonl.1, transcript.1.jsonl, transcript.jsonl.old, transcript.jsonl.bak
   */
  async findRecentArchivedFile(activeFilePath: string): Promise<string | null> {
    try {
      const dir = path.dirname(activeFilePath);
      const baseName = path.basename(activeFilePath);
      const entries = await fs.promises.readdir(dir);

      const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

      for (const entry of entries) {
        if (entry === baseName) continue;
        if (entry.startsWith(baseName) || entry.includes(baseName)) {
          const fullPath = path.join(dir, entry);
          try {
            const st = await fs.promises.stat(fullPath);
            if (st.isFile()) {
              candidates.push({ filePath: fullPath, mtimeMs: st.mtimeMs });
            }
          } catch {
            // Ignore unreadable candidates
          }
        }
      }

      if (candidates.length === 0) return null;

      // Return most recently modified archive file
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return candidates[0]?.filePath ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Creates an updated reset SourceCursor following a rotation or truncation event.
   */
  createRecoveryCursor(assessment: RecoveryAssessment, sequence: number): SourceCursor {
    return {
      offset: assessment.suggestedOffset,
      line: assessment.suggestedLine,
      sequence,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Executes an async operation with exponential backoff on permission errors (EACCES / EPERM).
   */
  async withPermissionRetry<T>(
    operation: () => Promise<T>,
    options: PermissionRetryOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 5;
    const initialDelay = options.initialDelayMs ?? 50;
    const maxDelay = options.maxDelayMs ?? 1000;
    const factor = options.backoffFactor ?? 2;

    let delay = initialDelay;
    let attempts = 0;

    while (true) {
      try {
        return await operation();
      } catch (err: unknown) {
        attempts++;
        // SAFETY: Filesystem operation error exposes NodeJS.ErrnoException code property.
        const code = (err as NodeJS.ErrnoException).code;
        const isPermission = code === "EACCES" || code === "EPERM" || code === "EBUSY";

        if (isPermission && attempts <= maxRetries) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, delay);
          await promise;
          delay = Math.min(maxDelay, delay * factor);
          continue;
        }

        throw err;
      }
    }
  }

  /**
   * Returns current rotation generation.
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Returns full lineage history of rotations/truncations.
   */
  getLineageHistory(): LineageEntry[] {
    return [...this.lineageHistory];
  }

  /**
   * Resets the recovery engine state.
   */
  reset(): void {
    this.generation = 0;
    this.currentIdentity = undefined;
    this.lineageHistory.length = 0;
  }
}
