import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkOwnerOnly, ensureOwnerOnly } from "@resin/windows-security";
import { z } from "zod";

/**
 * The identity a shared answer belongs to. Every field must match exactly before an entry is
 * served, so one cloud, login, workspace or device never reads another's answers. The file name
 * is only a digest of the scope; the scope stored inside the file is what is compared.
 */
export type DeviceSyncScope = Readonly<Record<string, string>>;

/** One cloud answer published for the other gateways of this OS user. */
export interface DeviceSyncEntry {
  scope: DeviceSyncScope;
  /** The store instance that fetched it. An instance never serves its own entries. */
  writer: string;
  /** When the cloud request that produced this answer started. */
  fetchedAt: number;
  /** Version of the separately stored body, when the answer has one. */
  version?: string;
  /** Small inline answer. Large answers live in the body file instead. */
  payload?: unknown;
}

export interface DeviceSyncStoreOptions {
  /** Directory for entries and locks. Created 0700; refused when another user owns it. */
  dir: string;
  /** A lock held longer than this is abandoned and may be taken over. Default 30 s. */
  lockStaleMs?: number;
  /** How often a gateway waiting on a peer's fetch re-checks for the result. Default 100 ms. */
  pollIntervalMs?: number;
  now?: () => number;
  /** Whether a lock holder's pid is still running on this host. */
  isProcessAlive?: (pid: number) => boolean;
}

export interface DeviceSyncRequest<T> {
  kind: string;
  scope: DeviceSyncScope;
  /** Oldest `fetchedAt` a peer's entry may carry and still be served instead of fetching. */
  notBefore: number;
  /** Maps a fresh peer entry to a result, or undefined when it cannot be used. */
  fromPeer: (entry: DeviceSyncEntry) => T | undefined;
  /** Makes the cloud call. `previous` is the last readable entry of any age. */
  fetch: (previous: DeviceSyncEntry | undefined) => Promise<T>;
}

const ENTRY_FORMAT = 1;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
/** An entry stamped further in the future than this was written under a different clock. */
const FUTURE_TOLERANCE_MS = 5_000;

const ScopeSchema = z.record(z.string());

const EntryFileSchema = z
  .object({
    format: z.literal(ENTRY_FORMAT),
    kind: z.string().min(1),
    scope: ScopeSchema,
    writer: z.string().min(1),
    fetchedAt: z.number().finite(),
    version: z.string().min(1).optional(),
    payload: z.unknown().optional(),
  })
  .strict();

const BodyFileSchema = z
  .object({
    format: z.literal(ENTRY_FORMAT),
    kind: z.string().min(1),
    scope: ScopeSchema,
    version: z.string().min(1),
    body: z.unknown(),
  })
  .strict();

const LockFileSchema = z
  .object({
    token: z.string().min(1),
    pid: z.number().int(),
    hostname: z.string(),
    acquiredAt: z.number().finite(),
  })
  .strict();

type LockFile = z.infer<typeof LockFileSchema>;

function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errnoCode(error) === "EPERM";
  }
}

function sameScope(stored: Record<string, string>, expected: DeviceSyncScope): boolean {
  const storedKeys = Object.keys(stored);
  const expectedKeys = Object.keys(expected);
  if (storedKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => Object.hasOwn(stored, key) && stored[key] === expected[key]);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Per-user, on-disk rendezvous that lets several gateway processes share one cloud answer.
 *
 * Each (kind, scope) has an entry file, an optional body file and an advisory lock file. The
 * gateway that finds no fresh peer entry takes the lock, calls the cloud and publishes the answer;
 * the others wait for it and read the file instead of calling the cloud. Files are 0600 in a 0700
 * directory, every write is a temp-file rename, and anything unreadable is treated as absent. A lock
 * whose holder died is taken over once its pid is gone or it is older than `lockStaleMs`.
 */
export class DeviceSyncStore {
  readonly writerId = crypto.randomUUID();
  private readonly dir: string;
  private readonly lockStaleMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: DeviceSyncStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.clock = options.now ?? (() => Date.now());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  now(): number {
    return this.clock();
  }

  /**
   * Serves a fresh peer answer, waits for a peer that is already fetching, or fetches and lets the
   * caller publish. Any file-system failure degrades to calling `fetch` directly, exactly as a
   * gateway without peers would.
   */
  async coordinate<T>(request: DeviceSyncRequest<T>): Promise<T> {
    if (!this.ensureDirectory()) {
      return await request.fetch(undefined);
    }
    const lockPath = `${this.basePath(request.kind, request.scope)}.lock`;
    const waitStartedAt = this.now();
    for (;;) {
      const entry = this.read(request.kind, request.scope);
      const shared = this.serve(entry, request);
      if (shared !== undefined) return shared;

      const lock = this.tryLock(lockPath);
      if (lock === "unavailable") {
        return await request.fetch(entry);
      }
      if (lock !== "held") {
        try {
          // A peer may have published between the read above and taking the lock.
          const latest = this.read(request.kind, request.scope);
          const published = this.serve(latest, request);
          if (published !== undefined) return published;
          return await request.fetch(latest ?? entry);
        } finally {
          this.unlock(lockPath, lock.token);
        }
      }

      if (this.breakAbandonedLock(lockPath)) continue;
      // Never wait longer than a live holder may legitimately hold the lock.
      if (this.now() - waitStartedAt >= this.lockStaleMs) {
        return await request.fetch(entry);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Reads the entry for (kind, scope); missing, corrupt or foreign-scope files read as absent. */
  read(kind: string, scope: DeviceSyncScope): DeviceSyncEntry | undefined {
    const parsed = EntryFileSchema.safeParse(readJson(`${this.basePath(kind, scope)}.json`));
    if (!parsed.success || parsed.data.kind !== kind || !sameScope(parsed.data.scope, scope)) {
      return undefined;
    }
    const { writer, fetchedAt, version, payload } = parsed.data;
    return { scope, writer, fetchedAt, version, payload };
  }

  /** Reads the body published for `version`; anything else reads as absent. */
  readBody(kind: string, scope: DeviceSyncScope, version: string): unknown {
    const parsed = BodyFileSchema.safeParse(readJson(`${this.basePath(kind, scope)}.body.json`));
    if (
      !parsed.success ||
      parsed.data.kind !== kind ||
      parsed.data.version !== version ||
      !sameScope(parsed.data.scope, scope)
    ) {
      return undefined;
    }
    return parsed.data.body;
  }

  /**
   * Publishes an answer. The body, when given, is written before the entry that names its version,
   * so a reader that sees the entry also finds the body. Throws on file-system failure.
   */
  write(
    kind: string,
    scope: DeviceSyncScope,
    record: { fetchedAt: number; version?: string; payload?: unknown },
    body?: { version: string; value: unknown },
  ): void {
    if (!this.ensureDirectory()) {
      throw new Error(`Shared sync directory '${this.dir}' is not private to this user`);
    }
    const base = this.basePath(kind, scope);
    if (body) {
      this.writeAtomic(`${base}.body.json`, {
        format: ENTRY_FORMAT,
        kind,
        scope,
        version: body.version,
        body: body.value,
      });
    }
    this.writeAtomic(`${base}.json`, {
      format: ENTRY_FORMAT,
      kind,
      scope,
      writer: this.writerId,
      fetchedAt: record.fetchedAt,
      ...(record.version === undefined ? {} : { version: record.version }),
      ...(record.payload === undefined ? {} : { payload: record.payload }),
    });
  }

  /** Withdraws the entry so no peer serves it; the body is left for the next writer. */
  remove(kind: string, scope: DeviceSyncScope): void {
    try {
      fs.rmSync(`${this.basePath(kind, scope)}.json`, { force: true });
    } catch {
      // Best effort: a stale entry still ages out after one interval.
    }
  }

  private serve<T>(
    entry: DeviceSyncEntry | undefined,
    request: DeviceSyncRequest<T>,
  ): T | undefined {
    if (!entry || entry.writer === this.writerId) return undefined;
    if (entry.fetchedAt < request.notBefore) return undefined;
    if (entry.fetchedAt > this.now() + FUTURE_TOLERANCE_MS) return undefined;
    try {
      return request.fromPeer(entry);
    } catch {
      return undefined;
    }
  }

  private basePath(kind: string, scope: DeviceSyncScope): string {
    const canonical = JSON.stringify(
      Object.keys(scope)
        .sort()
        .map((key) => [key, scope[key]]),
    );
    const digest = crypto.createHash("sha256").update(`${kind}\n${canonical}`).digest("hex");
    return path.join(this.dir, `${kind}-${digest.slice(0, 32)}`);
  }

  /**
   * Creates the directory 0700 and refuses one that is itself a symlink (lstat does not follow
   * it) or is owned by another user.
   */
  private ensureDirectory(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.dir);
      if (!stat.isDirectory()) return false;
      if (process.platform !== "win32") {
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
        if ((stat.mode & 0o077) !== 0) fs.chmodSync(this.dir, 0o700);
      } else {
        // Same policy through the DACL: refuse a foreign owner, repair a DACL open to others.
        const check = checkOwnerOnly(this.dir, { requireProtected: true });
        if (!check.ownedByCurrentUser) return false;
        if (!check.ok) ensureOwnerOnly(this.dir, { directory: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  private writeAtomic(file: string, value: unknown): void {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  /**
   * Takes the lock by hard-linking a fully written temp file into place, so a lock file is never
   * observed half written. `unavailable` means the file system cannot host the lock at all.
   */
  private tryLock(lockPath: string): { token: string } | "held" | "unavailable" {
    const token = crypto.randomUUID();
    const temp = `${lockPath}.${token}.tmp`;
    const lock: LockFile = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: this.now(),
    };
    try {
      fs.writeFileSync(temp, JSON.stringify(lock), { mode: 0o600, flag: "wx" });
      fs.linkSync(temp, lockPath);
      return { token };
    } catch (error) {
      return errnoCode(error) === "EEXIST" ? "held" : "unavailable";
    } finally {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // A leftover temp file is harmless.
      }
    }
  }

  private unlock(lockPath: string, token: string): void {
    try {
      const current = LockFileSchema.safeParse(readJson(lockPath));
      // Never remove a lock another gateway took over after this one went stale.
      if (current.success && current.data.token === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // The lock ages out after lockStaleMs.
    }
  }

  private isAbandoned(lock: LockFile | undefined): boolean {
    if (!lock) return true;
    const age = this.now() - lock.acquiredAt;
    if (age > this.lockStaleMs || age < -this.lockStaleMs) return true;
    return (
      lock.hostname === os.hostname() && lock.pid !== process.pid && !this.isProcessAlive(lock.pid)
    );
  }

  /**
   * Removes an abandoned lock. Returns true when the caller should retry at once: the lock was
   * removed, or it vanished on its own.
   */
  private breakAbandonedLock(lockPath: string): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, "utf8");
    } catch (error) {
      return errnoCode(error) === "ENOENT";
    }
    let judged: LockFile | undefined;
    try {
      const parsed = LockFileSchema.safeParse(JSON.parse(raw));
      judged = parsed.success ? parsed.data : undefined;
    } catch {
      judged = undefined;
    }
    if (!this.isAbandoned(judged)) return false;

    // Move the lock aside, then confirm it is the one judged abandoned. A lock another waiter took
    // in between is put back unless a newer one already replaced it.
    const quarantine = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      fs.renameSync(lockPath, quarantine);
    } catch (error) {
      // Gone already: retry at once. Any other failure waits like a held lock, so a lock this
      // user cannot move never turns into a busy loop.
      return errnoCode(error) === "ENOENT";
    }
    try {
      const moved = LockFileSchema.safeParse(readJson(quarantine));
      const movedToken = moved.success ? moved.data.token : undefined;
      if (movedToken !== undefined && movedToken !== judged?.token) {
        try {
          fs.linkSync(quarantine, lockPath);
        } catch {
          // A newer lock exists; its holder proceeds and the displaced one will not unlink it.
        }
      }
    } finally {
      try {
        fs.rmSync(quarantine, { force: true });
      } catch {
        // Harmless leftover.
      }
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    return promise;
  }
}
