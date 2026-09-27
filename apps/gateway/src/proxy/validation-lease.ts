import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "@resin/observer";

/** A held lease: renewed while its pass runs, released when the pass ends. */
export interface WorkflowValidationPassLeaseHandle {
  /** Marks the lease as held now, so a long pass is never mistaken for an abandoned one. */
  renew(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Device-wide single owner for a validation pass.
 *
 * Every `resin mcp` gateway and the background daemon on one device run a validation worker
 * against the same device identity. Without a shared owner two of them could list the same ask
 * and each check and deliver it; the cloud keeps the first decision and declines the second as a
 * conflict, but the second check still ran and its decision was still sent. The lease makes one
 * process answer at a time: a worker that cannot take it skips its pass, and by its next pass the
 * holder's answers are recorded and no longer listed.
 */
export interface WorkflowValidationPassLease {
  /**
   * How long a pass may hold the lease. The worker starts no new ask past this, so a live holder
   * always renews well within the stale bound.
   */
  readonly maxHoldMs: number;
  /** Takes the lease, or returns undefined when another live process holds it. */
  tryAcquire(): Promise<WorkflowValidationPassLeaseHandle | undefined>;
}

/** The lease's file name under the Resin state directory, the same for the daemon and every gateway. */
export const WORKFLOW_VALIDATION_LEASE_FILE_NAME = "workflow-validation.lease";

/**
 * A holder that died without releasing leaves the file behind; a lease not renewed for this long
 * is taken over even when its PID has been reused.
 */
export const WORKFLOW_VALIDATION_LEASE_STALE_MS = 30 * 60_000;

/** A takeover is a few file operations; a guard older than this was left by a process that died. */
const WORKFLOW_VALIDATION_TAKEOVER_GUARD_STALE_MS = 60_000;

interface LeasePayload {
  pid: number;
  token: string;
  acquiredAt: number;
}

function parsePayload(text: string): LeasePayload | undefined {
  try {
    const value = JSON.parse(text) as Partial<LeasePayload>;
    if (
      typeof value.pid === "number" &&
      typeof value.token === "string" &&
      typeof value.acquiredAt === "number"
    ) {
      return { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt };
    }
  } catch {
    // An unreadable lease is treated as abandoned.
  }
  return undefined;
}

/** The lease as an exclusively created file under the Resin state directory. */
export class FileWorkflowValidationPassLease implements WorkflowValidationPassLease {
  readonly maxHoldMs: number;
  private readonly filePath: string;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: {
    filePath: string;
    staleMs?: number;
    now?: () => number;
    isAlive?: (pid: number) => boolean;
  }) {
    this.filePath = options.filePath;
    this.staleMs = options.staleMs ?? WORKFLOW_VALIDATION_LEASE_STALE_MS;
    // Half the stale bound: one more bounded check after the cutoff still renews in time.
    this.maxHoldMs = Math.floor(this.staleMs / 2);
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  async tryAcquire(): Promise<WorkflowValidationPassLeaseHandle | undefined> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Two attempts: the second follows the takeover of an abandoned lease.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        await fs.writeFile(this.filePath, this.payload(token), { flag: "wx", mode: 0o600 });
        return {
          renew: async () => await this.renew(token),
          release: async () => await this.release(token),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await this.takeOverIfAbandoned())) return undefined;
    }
    return undefined;
  }

  private payload(token: string): string {
    return JSON.stringify({ pid: process.pid, token, acquiredAt: this.now() });
  }

  private isAbandoned(holder: LeasePayload | undefined): boolean {
    return (
      holder === undefined ||
      this.now() - holder.acquiredAt > this.staleMs ||
      (holder.pid !== process.pid && !this.isAlive(holder.pid))
    );
  }

  /**
   * Removes an abandoned lease. Only the process holding the takeover guard (an exclusively created
   * sibling file) may remove one, and it re-reads the lease under the guard, so of several processes
   * judging the same file abandoned exactly one removes it and none removes a successor's lease. The
   * lease is moved aside atomically and checked once more: a holder that renewed at that instant
   * gets its lease back.
   */
  private async takeOverIfAbandoned(): Promise<boolean> {
    const guard = `${this.filePath}.takeover`;
    try {
      await fs.writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A guard left by a process that died mid-takeover is cleared for the next attempt.
      const guardAge = await fs
        .stat(guard)
        .then((stat) => this.now() - stat.mtimeMs)
        .catch(() => 0);
      if (guardAge > WORKFLOW_VALIDATION_TAKEOVER_GUARD_STALE_MS) {
        await fs.rm(guard, { force: true });
      }
      return false;
    }
    try {
      let text: string;
      try {
        text = await fs.readFile(this.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      if (!this.isAbandoned(parsePayload(text))) return false;
      const aside = `${this.filePath}.${randomUUID()}.stale`;
      try {
        await fs.rename(this.filePath, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const moved = await fs.readFile(aside, "utf8");
      if (moved !== text && !this.isAbandoned(parsePayload(moved))) {
        await fs.link(aside, this.filePath).catch(() => undefined);
        await fs.rm(aside, { force: true });
        return false;
      }
      await fs.rm(aside, { force: true });
      return true;
    } finally {
      await fs.rm(guard, { force: true });
    }
  }

  private async holds(token: string): Promise<boolean> {
    const current = await fs.readFile(this.filePath, "utf8").catch(() => undefined);
    return current !== undefined && parsePayload(current)?.token === token;
  }

  private async renew(token: string): Promise<void> {
    if (!(await this.holds(token))) return;
    const next = `${this.filePath}.${randomUUID()}.renew`;
    await fs.writeFile(next, this.payload(token), { mode: 0o600 });
    await fs.rename(next, this.filePath);
  }

  private async release(token: string): Promise<void> {
    if (!(await this.holds(token))) return;
    await fs.rm(this.filePath, { force: true });
  }
}
