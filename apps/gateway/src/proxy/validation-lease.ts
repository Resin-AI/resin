import fs from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "@resin/observer";

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
  /** Takes the lease, or returns undefined when another live process holds it. */
  tryAcquire(): Promise<(() => Promise<void>) | undefined>;
}

/**
 * A holder that died without releasing leaves the file behind; a lease older than this is taken
 * over even when its PID has been reused. A pass is one list plus at most one bounded check per
 * ask, so a live holder releases long before this.
 */
/** The lease's file name under the Resin state directory, the same for the daemon and every gateway. */
export const WORKFLOW_VALIDATION_LEASE_FILE_NAME = "workflow-validation.lease";

export const WORKFLOW_VALIDATION_LEASE_STALE_MS = 30 * 60_000;

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
    // An unreadable lease is treated as abandoned below.
  }
  return undefined;
}

/** The lease as an exclusively created file under the Resin state directory. */
export class FileWorkflowValidationPassLease implements WorkflowValidationPassLease {
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
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? isProcessAlive;
  }

  async tryAcquire(): Promise<(() => Promise<void>) | undefined> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Two attempts: the second follows the removal of an abandoned lease.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload: LeasePayload = {
        pid: process.pid,
        token: `${process.pid}:${this.now()}:${Math.random().toString(36).slice(2)}`,
        acquiredAt: this.now(),
      };
      try {
        await fs.writeFile(this.filePath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
        return async () => await this.release(payload.token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await this.removeIfAbandoned())) return undefined;
    }
    return undefined;
  }

  /** Removes the lease file when its holder is gone or it outlived the stale bound. */
  private async removeIfAbandoned(): Promise<boolean> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      // Released between our create and our read: free to retry.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const holder = parsePayload(text);
    const abandoned =
      holder === undefined ||
      this.now() - holder.acquiredAt > this.staleMs ||
      (holder.pid !== process.pid && !this.isAlive(holder.pid));
    if (!abandoned) return false;
    // Only the file just judged abandoned may be removed; a fresh holder's file is kept.
    const current = await fs.readFile(this.filePath, "utf8").catch(() => undefined);
    if (current !== text) return current === undefined;
    await fs.rm(this.filePath, { force: true });
    return true;
  }

  private async release(token: string): Promise<void> {
    const current = await fs.readFile(this.filePath, "utf8").catch(() => undefined);
    if (current === undefined || parsePayload(current)?.token !== token) return;
    await fs.rm(this.filePath, { force: true });
  }
}
