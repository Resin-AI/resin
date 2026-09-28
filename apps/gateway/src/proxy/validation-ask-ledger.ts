/**
 * The local record of which recorded calls the cloud's validation asks checked, and the bound on
 * how often any one of them is checked.
 *
 * Every answer says something about the recorded calls it was checked against; even a single
 * plan-level verdict is one bit. The ledger bounds those bits: a recorded call is checked by at most
 * `maxChecksPerCallPerDay` answered asks in any 24 hours, and every admitted ask is appended to an
 * owner-only JSON-lines audit file the user can read to see what was checked and when.
 */

import fs from "node:fs";
import path from "node:path";

/** The ledger's file name under the Resin state directory, shared by the daemon and every gateway. */
export const WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME = "workflow-validation-asks.jsonl";

/** Answered asks one recorded call may be checked by in any 24 hours. */
export const DEFAULT_MAX_CHECKS_PER_CALL_PER_DAY = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Audit entries older than this are pruned when the ledger is rewritten. */
const RETENTION_MS = 30 * DAY_MS;

export interface ValidationAskLedgerEntry {
  at: string;
  requestId: string;
  planDigest: string;
  callIds: string[];
}

export interface ValidationAskAdmission {
  requestId: string;
  planDigest: string;
  callIds: readonly string[];
}

export class FileValidationAskLedger {
  private readonly filePath: string;
  private readonly maxChecksPerCallPerDay: number;
  private readonly now: () => number;

  constructor(options: { filePath: string; maxChecksPerCallPerDay?: number; now?: () => number }) {
    this.filePath = options.filePath;
    this.maxChecksPerCallPerDay =
      options.maxChecksPerCallPerDay ?? DEFAULT_MAX_CHECKS_PER_CALL_PER_DAY;
    this.now = options.now ?? Date.now;
  }

  /**
   * Admits one ask and records it, or refuses it when a call it checks is at its daily bound. The
   * same ask (request id and plan digest) is admitted again without counting twice, so a decision
   * whose delivery failed can be re-sent.
   */
  admit(ask: ValidationAskAdmission): boolean {
    const now = this.now();
    const entries = this.read().filter((entry) => now - Date.parse(entry.at) < RETENTION_MS);
    if (
      entries.some(
        (entry) => entry.requestId === ask.requestId && entry.planDigest === ask.planDigest,
      )
    ) {
      return true;
    }
    const recent = entries.filter((entry) => now - Date.parse(entry.at) < DAY_MS);
    for (const callId of new Set(ask.callIds)) {
      const checks = recent.filter((entry) => entry.callIds.includes(callId)).length;
      if (checks >= this.maxChecksPerCallPerDay) return false;
    }
    entries.push({
      at: new Date(now).toISOString(),
      requestId: ask.requestId,
      planDigest: ask.planDigest,
      callIds: [...new Set(ask.callIds)],
    });
    this.write(entries);
    return true;
  }

  private read(): ValidationAskLedgerEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: ValidationAskLedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as Partial<ValidationAskLedgerEntry>;
        if (
          typeof entry.at === "string" &&
          Number.isFinite(Date.parse(entry.at)) &&
          typeof entry.requestId === "string" &&
          typeof entry.planDigest === "string" &&
          Array.isArray(entry.callIds) &&
          entry.callIds.every((id) => typeof id === "string")
        ) {
          entries.push(entry as ValidationAskLedgerEntry);
        }
      } catch {
        // A torn line from an interrupted write is skipped; the rest of the ledger still counts.
      }
    }
    return entries;
  }

  /** Rewrites the ledger atomically as an owner-only file. */
  private write(entries: readonly ValidationAskLedgerEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
