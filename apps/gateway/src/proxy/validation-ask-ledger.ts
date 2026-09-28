/**
 * The local record of which recorded calls and private values the cloud's validation asks checked,
 * and the bound on how often any one of them is checked.
 *
 * Every answer says something about the recorded data it was checked against; even a single
 * plan-level verdict is one bit. The ledger bounds those bits: each recorded call and each private
 * reference a plan resolves is checked by at most `maxChecksPerKeyPerDay` answered asks in any 24
 * hours. Every admitted ask is appended to an owner-only JSON-lines audit file the user can read to
 * see what was checked and when. The read, the check and the append happen under an exclusive
 * lock, and a ledger this device cannot read refuses every ask rather than forgetting its count.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectorySync } from "@resin/observer";

/** The ledger's file name under the Resin state directory, shared by the daemon and every gateway. */
export const WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME = "workflow-validation-asks.jsonl";

/** Answered asks one recorded call or private reference may be checked by in any 24 hours. */
export const DEFAULT_MAX_CHECKS_PER_KEY_PER_DAY = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 30_000;
/** How long an admission waits for another holder before refusing. */
const LOCK_WAIT_MS = 2_000;

export interface ValidationAskLedgerEntry {
  at: string;
  requestId: string;
  planDigest: string;
  /** The recorded calls and private references the ask checks. */
  keys: string[];
}

export interface ValidationAskAdmission {
  requestId: string;
  planDigest: string;
  /** The recorded call ids and private references the ask checks. */
  keys: readonly string[];
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class FileValidationAskLedger {
  private readonly filePath: string;
  private readonly maxChecksPerKeyPerDay: number;
  private readonly now: () => number;

  constructor(options: { filePath: string; maxChecksPerKeyPerDay?: number; now?: () => number }) {
    this.filePath = options.filePath;
    this.maxChecksPerKeyPerDay =
      options.maxChecksPerKeyPerDay ?? DEFAULT_MAX_CHECKS_PER_KEY_PER_DAY;
    this.now = options.now ?? Date.now;
  }

  /**
   * Admits one ask and records it, or refuses it when anything it checks is at its daily bound,
   * when the ledger cannot be read, or when the lock cannot be taken. The same ask (request id and
   * plan digest) is admitted again without counting twice, so a decision whose delivery failed can
   * be re-sent.
   */
  admit(ask: ValidationAskAdmission): boolean {
    ensurePrivateDirectorySync(path.dirname(this.filePath));
    const lock = this.lock();
    if (lock === undefined) return false;
    try {
      const entries = this.read();
      if (entries === undefined) return false;
      if (
        entries.some(
          (entry) => entry.requestId === ask.requestId && entry.planDigest === ask.planDigest,
        )
      ) {
        return true;
      }
      const now = this.now();
      const recent = entries.filter((entry) => now - Date.parse(entry.at) < DAY_MS);
      const keys = [...new Set(ask.keys)];
      for (const key of keys) {
        const checks = recent.filter((entry) => entry.keys.includes(key)).length;
        if (checks >= this.maxChecksPerKeyPerDay) return false;
      }
      const entry: ValidationAskLedgerEntry = {
        at: new Date(now).toISOString(),
        requestId: ask.requestId,
        planDigest: ask.planDigest,
        keys,
      };
      const fd = fs.openSync(this.filePath, "a", 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  /** Takes the ledger's exclusive lock file; undefined when another holder keeps it. */
  private lock(): string | undefined {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
        return lockPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          // Only one waiter can move the stale lock aside; the others find it gone and retry `wx`,
          // so a lock another waiter has just re-taken is never removed.
          const aside = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
          try {
            fs.renameSync(lockPath, aside);
            // Between the stat and the rename another waiter may have broken the stale lock and
            // taken a fresh one: put a fresh lock back rather than remove it.
            if (Date.now() - fs.statSync(aside).mtimeMs <= STALE_LOCK_MS) {
              try {
                fs.linkSync(aside, lockPath);
              } catch (linkError) {
                if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
              }
            }
            fs.rmSync(aside, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      sleep(25);
    }
  }

  /** Every entry, or undefined when any line cannot be read as one. */
  private read(): ValidationAskLedgerEntry[] | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return undefined;
    }
    const entries: ValidationAskLedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let entry: Partial<ValidationAskLedgerEntry>;
      try {
        entry = JSON.parse(line) as Partial<ValidationAskLedgerEntry>;
      } catch {
        return undefined;
      }
      if (
        typeof entry.at !== "string" ||
        !Number.isFinite(Date.parse(entry.at)) ||
        typeof entry.requestId !== "string" ||
        typeof entry.planDigest !== "string" ||
        !Array.isArray(entry.keys) ||
        !entry.keys.every((key) => typeof key === "string")
      ) {
        return undefined;
      }
      entries.push(entry as ValidationAskLedgerEntry);
    }
    return entries;
  }
}
