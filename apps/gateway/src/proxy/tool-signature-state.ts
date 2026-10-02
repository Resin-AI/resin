import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type V1ToolCertificate, V1ToolCertificateSchema } from "@resin/contracts";
import { z } from "zod";

/**
 * File in the daemon state directory (`<resinHome>/state`) holding tool certificate check
 * outcomes, the certificates last fetched, and the summary `resin status` reads.
 */
export const TOOL_SIGNATURES_STATE_FILE_NAME = "tool-signatures.json";

export const TOOL_CERTIFICATE_OUTCOMES = [
  "verified",
  "missing-certificate",
  "unpinned-origin",
  "unknown-key",
  "invalid-signature",
  "binding-mismatch",
  "digest-mismatch",
] as const;

export type ToolCertificateOutcome = (typeof TOOL_CERTIFICATE_OUTCOMES)[number];

/** Outcomes that mean a certificate was present but did not prove what the client runs. */
export const TOOL_CERTIFICATE_FAILURE_OUTCOMES: ReadonlySet<ToolCertificateOutcome> = new Set([
  "unknown-key",
  "invalid-signature",
  "binding-mismatch",
  "digest-mismatch",
]);

export interface ToolCertificateCheckRecord {
  toolId: string;
  version: string;
  artifactDigest: string;
  outcome: ToolCertificateOutcome;
  checkedAt: string;
}

/** Counts over the latest checks of every scope; what `resin status` shows. */
export interface ToolSignatureSummary {
  mode: "report-only" | "enforce";
  verified: number;
  /** No certificate for the tool version (including a cloud that does not issue them yet). */
  missing: number;
  /** The cloud origin has no pinned key, so nothing could be verified. */
  unpinned: number;
  /** Present but failed: unknown key, bad signature, or wrong bindings or digests. */
  failed: number;
  updatedAt: string;
}

const MAX_SCOPES = 32;
const MAX_RECORDS_PER_SCOPE = 1000;
const MAX_CERTIFICATE_SCOPES = 8;
const MAX_CERTIFICATES_PER_SCOPE = 2000;

const OutcomeSchema = z.enum(TOOL_CERTIFICATE_OUTCOMES);

const CountSchema = z.number().int().nonnegative();

const SummarySchema = z.object({
  mode: z.enum(["report-only", "enforce"]),
  verified: CountSchema,
  missing: CountSchema,
  unpinned: CountSchema,
  failed: CountSchema,
  updatedAt: z.string(),
});

const RecordSchema = z.object({
  toolId: z.string().min(1).max(256),
  version: z.string().min(1).max(256),
  artifactDigest: z.string().min(1).max(256),
  outcome: OutcomeSchema,
  checkedAt: z.string(),
});

const StateFileSchema = z.object({
  version: z.literal(1),
  summary: z.unknown().optional(),
  scopes: z.record(
    z.object({
      checkedAt: z.string(),
      records: z.array(RecordSchema).max(MAX_RECORDS_PER_SCOPE),
    }),
  ),
  certificates: z.record(
    z.object({
      fetchedAt: z.string(),
      certificates: z.array(z.unknown()).max(MAX_CERTIFICATES_PER_SCOPE),
    }),
  ),
});

type StateFile = z.infer<typeof StateFileSchema>;

function emptyState(): StateFile {
  return { version: 1, scopes: {}, certificates: {} };
}

/** Opaque, stable key for a scope; the file never needs to name accounts or workspaces. */
export function toolSignatureScopeKey(parts: readonly string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function keepNewest<T>(
  entries: Record<string, T>,
  limit: number,
  stamp: (value: T) => string,
): Record<string, T> {
  const sorted = Object.entries(entries).sort(([, a], [, b]) => stamp(b).localeCompare(stamp(a)));
  return Object.fromEntries(sorted.slice(0, limit));
}

export function summarizeToolSignatureRecords(
  records: readonly ToolCertificateCheckRecord[],
  mode: ToolSignatureSummary["mode"],
  updatedAt: string,
): ToolSignatureSummary {
  const summary: ToolSignatureSummary = {
    mode,
    verified: 0,
    missing: 0,
    unpinned: 0,
    failed: 0,
    updatedAt,
  };
  for (const record of records) {
    if (record.outcome === "verified") summary.verified += 1;
    else if (record.outcome === "missing-certificate") summary.missing += 1;
    else if (record.outcome === "unpinned-origin") summary.unpinned += 1;
    else summary.failed += 1;
  }
  return summary;
}

/**
 * Persists tool certificate outcomes and the last fetched certificates as one owner-only JSON
 * file. Several gateway processes may share it: every write re-reads, merges its own scope and
 * renames a temp file into place, so readers never see a partial file. Every failure is swallowed;
 * this state is report-only and must never affect a sync.
 */
export class ToolSignatureStateStore {
  readonly filePath: string;

  constructor(options: { filePath: string }) {
    this.filePath = path.resolve(options.filePath);
  }

  private read(): StateFile {
    try {
      const parsed = StateFileSchema.safeParse(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      return parsed.success ? parsed.data : emptyState();
    } catch {
      return emptyState();
    }
  }

  /** The certificates last stored for `scopeKey`; individually invalid entries are dropped. */
  readCertificates(scopeKey: string): V1ToolCertificate[] {
    const entry = this.read().certificates[scopeKey];
    if (!entry) return [];
    const certificates: V1ToolCertificate[] = [];
    for (const raw of entry.certificates) {
      const parsed = V1ToolCertificateSchema.safeParse(raw);
      if (parsed.success) certificates.push(parsed.data);
    }
    return certificates;
  }

  /** The latest outcomes of `scopeKey`'s last check pass. */
  readRecords(scopeKey: string): ToolCertificateCheckRecord[] {
    return this.read().scopes[scopeKey]?.records ?? [];
  }

  readSummary(): ToolSignatureSummary | undefined {
    const parsed = SummarySchema.safeParse(this.read().summary);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Replaces one scope's outcomes (and, when given, one scope's certificates) and recomputes the
   * summary over every scope. Returns false when nothing could be written.
   */
  write(update: {
    scopeKey: string;
    records: readonly ToolCertificateCheckRecord[];
    mode: ToolSignatureSummary["mode"];
    certificates?: { scopeKey: string; certificates: readonly V1ToolCertificate[] };
    now: Date;
  }): boolean {
    try {
      const state = this.read();
      const now = update.now.toISOString();
      state.scopes[update.scopeKey] = {
        checkedAt: now,
        records: update.records.slice(0, MAX_RECORDS_PER_SCOPE).map((record) => ({ ...record })),
      };
      state.scopes = keepNewest(state.scopes, MAX_SCOPES, (scope) => scope.checkedAt);
      if (update.certificates) {
        state.certificates[update.certificates.scopeKey] = {
          fetchedAt: now,
          certificates: update.certificates.certificates.slice(0, MAX_CERTIFICATES_PER_SCOPE),
        };
        state.certificates = keepNewest(
          state.certificates,
          MAX_CERTIFICATE_SCOPES,
          (entry) => entry.fetchedAt,
        );
      }
      state.summary = summarizeToolSignatureRecords(
        Object.values(state.scopes).flatMap((scope) => scope.records),
        update.mode,
        now,
      );

      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
      } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
      }
      return true;
    } catch {
      return false;
    }
  }
}
