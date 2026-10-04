/**
 * The local record of which recorded calls and private values the cloud's validation asks checked,
 * and the bound on how often any one of them is checked.
 *
 * Every answer says something about the recorded data it was checked against; even a single
 * plan-level verdict is one bit. The ledger bounds those bits: each recorded call and each private
 * reference a plan resolves is checked by at most `maxChecksPerKeyPerDay` answered asks in any 24
 * hours. Every admitted ask is appended to an owner-only JSON-lines audit file the user can read to
 * see what was checked and when; entries leave it once they are older than that window, so the file
 * holds one day of asks. The read, the check and the write happen under an exclusive lock. A
 * ledger with a line this device cannot read is moved aside (`<file>.corrupt-<epoch ms>`, the
 * newest few kept for the user to inspect) and counting starts over, rather than refusing every
 * ask until someone deletes it.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectorySync, writeNewPrivateFileSync } from "@resin/observer";

/** The ledger's file name under the Resin state directory, shared by the daemon and every gateway. */
export const WORKFLOW_VALIDATION_ASK_LEDGER_FILE_NAME = "workflow-validation-asks.jsonl";

/** Answered asks one recorded call or private reference may be checked by in any 24 hours. */
export const DEFAULT_MAX_CHECKS_PER_KEY_PER_DAY = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 30_000;
/** How long an admission waits for another holder before refusing. */
const LOCK_WAIT_MS = 2_000;
/** How long a waiter sleeps between attempts at the lock. */
const LOCK_RETRY_MS = 25;
/** Unreadable ledgers kept beside the live one; older ones are removed. */
const MAX_CORRUPT_LEDGERS = 3;

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

/**
 * Whether an ask was admitted. A refusal says why: `limit-reached` names a key at its daily bound
 * and when the window frees a check for every bound key (`retryAt`, epoch ms), so a caller can wait
 * for it instead of asking again; `ledger-unavailable` means the ledger could not be read, moved
 * aside or locked, and nothing is known about the bound.
 */
export type ValidationAskAdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: "limit-reached"; key: string; retryAt: number }
  | { admitted: false; reason: "ledger-unavailable" };

export class FileValidationAskLedger {
  private readonly filePath: string;
  private readonly maxChecksPerKeyPerDay: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: {
    filePath: string;
    maxChecksPerKeyPerDay?: number;
    now?: () => number;
    /** Told when an unreadable ledger is moved aside. */
    log?: (message: string) => void;
  }) {
    this.filePath = options.filePath;
    this.maxChecksPerKeyPerDay =
      options.maxChecksPerKeyPerDay ?? DEFAULT_MAX_CHECKS_PER_KEY_PER_DAY;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /**
   * Admits one ask and records it, or refuses it when anything it checks is at its daily bound,
   * when the ledger cannot be read, or when the lock cannot be taken. The same ask (request id and
   * plan digest) is admitted again without counting twice, so a decision whose delivery failed can
   * be re-sent.
   */
  async admit(ask: ValidationAskAdmission): Promise<ValidationAskAdmissionResult> {
    ensurePrivateDirectorySync(path.dirname(this.filePath));
    const lock = await this.lock();
    if (lock === undefined) return { admitted: false, reason: "ledger-unavailable" };
    try {
      const entries = this.read();
      if (entries === undefined) return { admitted: false, reason: "ledger-unavailable" };
      if (
        entries.some(
          (entry) => entry.requestId === ask.requestId && entry.planDigest === ask.planDigest,
        )
      ) {
        return { admitted: true };
      }
      const now = this.now();
      const recent = entries.filter((entry) => now - Date.parse(entry.at) < DAY_MS);
      const keys = [...new Set(ask.keys)];
      let blocked: { key: string; retryAt: number } | undefined;
      for (const key of keys) {
        const checks = recent
          .filter((entry) => entry.keys.includes(key))
          .map((entry) => Date.parse(entry.at))
          .sort((left, right) => left - right);
        if (checks.length < this.maxChecksPerKeyPerDay) continue;
        // The key frees a check once all but `max - 1` of its counted checks have aged out.
        const retryAt = checks[checks.length - this.maxChecksPerKeyPerDay]! + DAY_MS;
        if (blocked === undefined || retryAt > blocked.retryAt) blocked = { key, retryAt };
      }
      if (blocked !== undefined) return { admitted: false, reason: "limit-reached", ...blocked };
      const entry: ValidationAskLedgerEntry = {
        at: new Date(now).toISOString(),
        requestId: ask.requestId,
        planDigest: ask.planDigest,
        keys,
      };
      // Entries past the window no longer count toward any bound: the write that adds this one
      // drops them, so the file holds one window of asks.
      if (recent.length < entries.length) this.rewrite([...recent, entry]);
      else this.append(entry);
      return { admitted: true };
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  /** Takes the ledger's exclusive lock file; undefined when another holder keeps it. */
  private async lock(): Promise<string | undefined> {
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
      // Waits without blocking the event loop the daemon and gateways share with everything else.
      await delay(LOCK_RETRY_MS);
    }
  }

  /**
   * Every entry; an empty ledger after moving aside one with any line that cannot be read as an
   * entry; undefined when the file cannot be read or moved aside.
   */
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
      const entry = parseEntry(line);
      if (entry === undefined) return this.quarantine() ? [] : undefined;
      entries.push(entry);
    }
    return entries;
  }

  /** Moves an unreadable ledger aside, keeping the newest few; false when it cannot be moved. */
  private quarantine(): boolean {
    const target = `${this.filePath}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.filePath, target);
    } catch {
      return false;
    }
    this.log(
      `workflow validation: the local check ledger had an unreadable line; moved it to ${target} and started a new one`,
    );
    const prefix = `${path.basename(this.filePath)}.corrupt-`;
    try {
      const kept = fs
        .readdirSync(path.dirname(this.filePath))
        .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
        .sort(
          (left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)),
        );
      for (const name of kept.slice(MAX_CORRUPT_LEDGERS)) {
        fs.rmSync(path.join(path.dirname(this.filePath), name), { force: true });
      }
    } catch {
      // Older copies are kept for inspection only; failing to trim them leaves the ledger usable.
    }
    return true;
  }

  private append(entry: ValidationAskLedgerEntry): void {
    const fd = fs.openSync(this.filePath, "a", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Replaces the ledger with `entries` by writing a private temporary file and renaming it. */
  private rewrite(entries: readonly ValidationAskLedgerEntry[]): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeNewPrivateFileSync(
        temporary,
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function parseEntry(line: string): ValidationAskLedgerEntry | undefined {
  let entry: Partial<ValidationAskLedgerEntry>;
  try {
    entry = JSON.parse(line) as Partial<ValidationAskLedgerEntry>;
  } catch {
    return undefined;
  }
  if (
    entry === null ||
    typeof entry !== "object" ||
    typeof entry.at !== "string" ||
    !Number.isFinite(Date.parse(entry.at)) ||
    typeof entry.requestId !== "string" ||
    typeof entry.planDigest !== "string" ||
    !Array.isArray(entry.keys) ||
    !entry.keys.every((key) => typeof key === "string")
  ) {
    return undefined;
  }
  return entry as ValidationAskLedgerEntry;
}
