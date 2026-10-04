import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ensurePrivateDirectorySync } from "../private-fs.js";

/**
 * File in the daemon state directory (`<resinHome>/state`) recording the last capture upload Resin
 * Cloud accepted. The daemon writes it; `resin status` reads it, also while the daemon is down.
 */
export const CLOUD_UPLOAD_STATUS_FILE_NAME = "cloud-upload-status.json";

const CountSchema = z.number().int().nonnegative();

const CloudUploadStatusSchema = z.object({
  version: z.literal(1),
  /** ISO time of the last upload batch the cloud accepted. */
  lastSuccessAt: z.string().datetime(),
  /** Observations in that batch. */
  lastBatchObservations: CountSchema,
  /** Accepted batches and observations since `since`, across daemon restarts. */
  totalBatches: CountSchema,
  totalObservations: CountSchema,
  /** ISO time of the first accepted batch counted in the totals. */
  since: z.string().datetime(),
});

export type CloudUploadStatus = z.infer<typeof CloudUploadStatusSchema>;

/** Parses a status file's JSON; null when absent or not a valid record. */
export function parseCloudUploadStatus(value: unknown): CloudUploadStatus | null {
  const parsed = CloudUploadStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Records every capture upload batch the cloud accepts (generic session observations and
 * finalized trajectories) and persists the running record, so a restart or update keeps the last
 * upload time. Persistence is best-effort: a failed write never affects an upload.
 */
export class CloudUploadStatusRecorder {
  private readonly filePath?: string;
  private readonly now: () => number;
  private status: CloudUploadStatus | null;

  constructor(options: { filePath?: string; now?: () => number } = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.status = this.read();
  }

  snapshot(): CloudUploadStatus | null {
    return this.status ? { ...this.status } : null;
  }

  recordSuccess(observations: number): void {
    const at = new Date(this.now()).toISOString();
    this.status = {
      version: 1,
      lastSuccessAt: at,
      lastBatchObservations: observations,
      totalBatches: (this.status?.totalBatches ?? 0) + 1,
      totalObservations: (this.status?.totalObservations ?? 0) + observations,
      since: this.status?.since ?? at,
    };
    this.persist(this.status);
  }

  private read(): CloudUploadStatus | null {
    if (!this.filePath) return null;
    try {
      return parseCloudUploadStatus(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return null;
    }
  }

  private persist(status: CloudUploadStatus): void {
    if (!this.filePath) return;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      ensurePrivateDirectorySync(path.dirname(this.filePath));
      fs.writeFileSync(temporaryPath, `${JSON.stringify(status)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Status is report-only; a leftover temp file is aged out by the daemon at startup.
      }
    }
  }
}
