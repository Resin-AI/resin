import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type V1LockedToolEntry, V1LockedToolEntrySchema } from "@resin/contracts";
import { type AccountToolAccessResponse, AccountToolAccessResponseSchema } from "@resin/protocol";
import type { ArtifactCache } from "@resin/runtime";
import { z } from "zod";
import { ProjectLockManager } from "../project/lock-manager.js";
import type { ToolRegistry } from "../registry/registry.js";

const OwnerSchema = AccountToolAccessResponseSchema.extend({
  cloudUrl: z.string().url(),
  revocationId: z.string().optional(),
  proofId: z.string().optional(),
  epoch: z.number().int().nonnegative().optional(),
});
const ManagedEntrySchema = z.object({
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  entry: V1LockedToolEntrySchema,
  workspaceId: z.string().optional(),
  projectId: z.string().uuid().optional(),
  lockPath: z.string().optional(),
  activationId: z.string().optional(),
});
type ManagedEntry = z.infer<typeof ManagedEntrySchema>;
type Owner = z.infer<typeof OwnerSchema>;
export interface ManagedToolIdentity {
  cloudUrl: string;
  accountId: string;
  userId: string;
}
export interface ManagedToolConfirmation {
  cloudUrl?: string;
  accountId?: string;
  userId?: string;
  toolAccess?: AccountToolAccessResponse["toolAccess"];
  proofId?: string;
  revocationId?: string;
  epoch?: number;
}
interface ManagedToolTuple {
  toolId: string;
  version?: string;
  artifactDigest?: string;
  manifestDigest?: string;
}

function key(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sameEntry(tool: ManagedToolTuple, entry: V1LockedToolEntry): boolean {
  return (
    tool.toolId === entry.toolId &&
    (!tool.version || tool.version === entry.version) &&
    (!tool.manifestDigest ||
      tool.manifestDigest.replace(/^sha256:/, "") ===
        entry.manifestDigest.replace(/^sha256:/, "")) &&
    (!tool.artifactDigest ||
      tool.artifactDigest.replace(/^sha256:/, "") === entry.artifactDigest.replace(/^sha256:/, ""))
  );
}

/** Local ownership receipts and durable positive denial. Never infers ownership from a lock alone. */
export class ManagedToolAccess {
  private readonly deniedInMemory = new Map<string, Owner>();
  private readonly pendingProofBases = new Map<string, string | undefined>();
  private readonly knownOwners = new Map<string, Owner>();
  private readonly knownEntries = new Map<string, ManagedEntry>();
  private readonly toolIndex = new Map<string, Set<string>>();
  private readonly unresolvedReceiptNames = new Set<string>();
  private receiptDirectoryRevision?: string;
  private receiptNames: string[] = [];
  private ownerDirectoryRevision?: string;
  private ownerNames: string[] = [];
  private readonly ownerFileCache = new Map<string, { revision: string; owner: Owner }>();
  private ownersSnapshot?: Map<string, Owner>;
  private readonly receiptFileCache = new Map<string, { revision: string; entry: ManagedEntry }>();
  private readonly ownersDir: string;
  private readonly entriesDir: string;
  private db?: DatabaseSync;
  private authorityAvailable = false;

  constructor(
    readonly stateDir: string,
    readonly artifactCache: ArtifactCache,
    readonly identity?: ManagedToolIdentity,
  ) {
    this.ownersDir = path.join(stateDir, "accounts");
    this.entriesDir = path.join(stateDir, "tools");
  }

  private ownerKey(identity: ManagedToolIdentity): string {
    return key([new URL(identity.cloudUrl).origin, identity.accountId]);
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    }
    if (fs.realpathSync(this.stateDir) !== path.resolve(this.stateDir)) {
      throw new Error("Refusing managed state access through a symlinked state directory");
    }
    if (!this.db) {
      const dbPath = path.join(this.stateDir, "tool-access.db");
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50;");
        this.initDb(db);
        this.db = db;
      } catch (error) {
        try {
          db.close();
        } catch {}
        throw error;
      }
    }
    return this.db;
  }

  private initDb(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_authorizations (
        owner_key TEXT PRIMARY KEY,
        cloud_url TEXT NOT NULL,
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool_access TEXT NOT NULL,
        revocation_id TEXT,
        proof_id TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.seedLegacyOwners(db);
  }

  private seedLegacyOwners(db: DatabaseSync): void {
    if (!fs.existsSync(this.ownersDir)) return;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO owner_authorizations (
        owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const name of this.files(this.ownersDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const ownerKey = name.slice(0, -5);
      try {
        const owner = OwnerSchema.parse(
          JSON.parse(fs.readFileSync(path.join(this.ownersDir, name), "utf8")),
        );
        if (name === `${this.ownerKey(owner)}.json`) {
          insert.run(
            ownerKey,
            owner.cloudUrl,
            owner.accountId,
            owner.userId,
            owner.toolAccess,
            owner.revocationId ?? null,
            owner.proofId ?? crypto.randomUUID(),
            owner.epoch ?? 0,
            Date.now(),
          );
        }
      } catch {
        /* Unreadable data is not proof of inactivity. */
      }
    }
  }

  private importLegacyDenialIfPresent(ownerKey: string): void {
    const file = path.join(this.ownersDir, `${ownerKey}.json`);
    if (!fs.existsSync(file)) return;
    try {
      const owner = OwnerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (owner.toolAccess !== "subscription_inactive") return;
      if (this.ownerKey(owner) !== ownerKey) return;

      const db = this.getDb();
      const rows = db
        .prepare(`
        INSERT INTO owner_authorizations (
          owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch, updated_at
        ) VALUES (?, ?, ?, ?, 'subscription_inactive', ?, ?, 1, ?)
        ON CONFLICT(owner_key) DO UPDATE SET
          tool_access = 'subscription_inactive',
          revocation_id = CASE
            WHEN owner_authorizations.tool_access = 'subscription_inactive' AND owner_authorizations.revocation_id IS NOT NULL
              THEN owner_authorizations.revocation_id
            ELSE excluded.revocation_id
          END,
          proof_id = excluded.proof_id,
          epoch = owner_authorizations.epoch + 1,
          updated_at = excluded.updated_at
        RETURNING owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch;
      `)
        .all(
          ownerKey,
          owner.cloudUrl,
          owner.accountId,
          owner.userId,
          owner.revocationId ?? crypto.randomUUID(),
          owner.proofId ?? crypto.randomUUID(),
          Date.now(),
        ) as unknown as Array<{
        owner_key: string;
        cloud_url: string;
        account_id: string;
        user_id: string;
        tool_access: "subscription_inactive";
        revocation_id: string | null;
        proof_id: string;
        epoch: number;
      }>;

      if (rows.length > 0) {
        const row = rows[0];
        const canonicalRevocationId = row.revocation_id ?? undefined;
        // Mirror canonical revocation/proof/epoch back to disk so future observations never diverge
        const canonicalOwner: Owner = {
          schemaVersion: "1.0.0",
          cloudUrl: row.cloud_url,
          accountId: row.account_id,
          userId: row.user_id,
          toolAccess: "subscription_inactive",
          revocationId: canonicalRevocationId,
          proofId: row.proof_id,
          epoch: Number(row.epoch),
        };
        this.write(file, canonicalOwner);
        this.knownOwners.set(ownerKey, canonicalOwner);
      }
    } catch {
      /* Unreadable data is not proof of inactivity */
    }
  }

  /**
   * Reuse a single ownership read across a batch of tool checks.
   *
   * Catalog adoption and sync visit every registered tool. Each visit previously
   * re-read the owners directory, so a large catalog walked it thousands of times
   * per second and dominated process CPU.
   */
  withOwnerSnapshot<T>(fn: () => T): T {
    if (this.ownersSnapshot) return fn();
    this.ownersSnapshot = this.readOwners();
    try {
      return fn();
    } finally {
      this.ownersSnapshot = undefined;
    }
  }

  private readOwners(): Map<string, Owner> {
    if (this.ownersSnapshot) return this.ownersSnapshot;
    const owners = new Map<string, Owner>(this.knownOwners);
    let dbSucceeded = false;
    try {
      const db = this.getDb();
      const rows = db
        .prepare(`
        SELECT owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch
        FROM owner_authorizations;
      `)
        .all() as unknown as Array<{
        owner_key: string;
        cloud_url: string;
        account_id: string;
        user_id: string;
        tool_access: "allowed" | "subscription_inactive";
        revocation_id: string | null;
        proof_id: string;
        epoch: number;
      }>;
      for (const row of rows) {
        const owner: Owner = {
          schemaVersion: "1.0.0",
          cloudUrl: row.cloud_url,
          accountId: row.account_id,
          userId: row.user_id,
          toolAccess: row.tool_access,
          revocationId: row.revocation_id ?? undefined,
          proofId: row.proof_id,
          epoch: Number(row.epoch),
        };
        owners.set(row.owner_key, owner);
        this.knownOwners.set(row.owner_key, owner);
      }
      dbSucceeded = true;
    } catch {
      // Authoritative DB read failed. Do not blindly trust allowed JSON on authority failure.
    }
    this.authorityAvailable = dbSucceeded;

    // Check disk accounts directory to honor live legacy process revocations
    if (fs.existsSync(this.ownersDir)) {
      for (const name of this.ownerFiles()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const ownerKey = name.slice(0, -5);
        const owner = this.readOwnerFile(name);
        if (!owner) continue;
        if (name !== `${this.ownerKey(owner)}.json`) continue;

        const existing = owners.get(ownerKey);
        if (owner.toolAccess === "subscription_inactive") {
          // Live legacy revocation: import into authoritative DB so CAS cannot overwrite it!
          if (dbSucceeded && existing?.toolAccess !== "subscription_inactive") {
            this.importLegacyDenialIfPresent(ownerKey);
          }
          owners.set(ownerKey, owner);
          this.knownOwners.set(ownerKey, owner);
        } else if (!existing && !dbSucceeded && !this.knownOwners.has(ownerKey)) {
          // Only adopt legacy allowed if DB succeeded or fresh uninitialized cold process
          // Never trust legacy allowed over unknown DB state where a denial mirror write may have failed!
        } else if (existing?.toolAccess === "subscription_inactive") {
          // NEVER import legacy allowed over authoritative denial
        }
      }
    }

    for (const [id, owner] of this.deniedInMemory) {
      if (owners.get(id)?.proofId === this.pendingProofBases.get(id)) owners.set(id, owner);
      else {
        this.deniedInMemory.delete(id);
        this.pendingProofBases.delete(id);
      }
    }
    return owners;
  }

  private addKnownEntry(name: string, entry: ManagedEntry): void {
    this.unresolvedReceiptNames.delete(name);
    const existing = this.knownEntries.get(name);
    if (existing && existing.entry.toolId !== entry.entry.toolId) {
      const oldSet = this.toolIndex.get(existing.entry.toolId);
      if (oldSet) {
        oldSet.delete(name);
        if (oldSet.size === 0) {
          this.toolIndex.delete(existing.entry.toolId);
        }
      }
    }
    this.knownEntries.set(name, entry);
    let set = this.toolIndex.get(entry.entry.toolId);
    if (!set) {
      set = new Set<string>();
      this.toolIndex.set(entry.entry.toolId, set);
    }
    set.add(name);
  }

  private syncDiscovery(): void {
    if (!fs.existsSync(this.entriesDir)) return;
    let revision: string;
    try {
      const stat = fs.statSync(this.entriesDir, { bigint: true });
      revision = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return;
    }
    if (revision === this.receiptDirectoryRevision) {
      return;
    }

    let names: string[];
    try {
      names = fs.readdirSync(this.entriesDir);
    } catch {
      return;
    }

    this.receiptDirectoryRevision = revision;
    this.receiptNames = names;

    for (const unresolved of this.unresolvedReceiptNames) {
      if (!names.includes(unresolved)) {
        this.unresolvedReceiptNames.delete(unresolved);
      }
    }

    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      // Receipt filenames bind the tool tuple; only activation proof changes in place.
      if (this.knownEntries.has(name)) {
        this.unresolvedReceiptNames.delete(name);
        continue;
      }
      // Newly discovered receipt: read it now so we can index its toolId
      try {
        this.readReceiptFile(name);
      } catch {
        // Unreadable or malformed newly discovered record: track for retry without broad scan
        this.unresolvedReceiptNames.add(name);
      }
    }
  }

  private retryUnresolved(): void {
    if (this.unresolvedReceiptNames.size === 0) return;
    for (const name of this.unresolvedReceiptNames) {
      try {
        this.readReceiptFile(name);
      } catch {
        // Retain in unresolvedReceiptNames until successful parse or directory listing proves absence
      }
    }
  }

  /**
   * Cache the owners directory listing by directory revision.
   *
   * Revocation checks run once per catalog entry, so re-listing this directory on
   * every check made tool discovery the gateway's dominant CPU cost.
   */
  private ownerFiles(): string[] {
    try {
      const stat = fs.statSync(this.ownersDir, { bigint: true });
      const revision = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (revision !== this.ownerDirectoryRevision) {
        this.ownerNames = fs.readdirSync(this.ownersDir);
        this.ownerDirectoryRevision = revision;
      }
      return this.ownerNames;
    } catch {
      return this.files(this.ownersDir);
    }
  }

  /**
   * Read one owner file, reusing the parsed value until its own revision changes.
   *
   * A directory revision cannot observe an in-place rewrite, so each file carries
   * its own mtime/size revision. Live legacy revocations are therefore still
   * honored, without an open+parse for every tool check.
   */
  private readOwnerFile(name: string): Owner | undefined {
    const file = path.join(this.ownersDir, name);
    let revision: string;
    try {
      const stat = fs.statSync(file, { bigint: true });
      // Include identity and both timestamps: an atomic rename changes inode and
      // ctime, an in-place write changes mtime, and size catches equal-timestamp rewrites.
      revision = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch {
      this.ownerFileCache.delete(name);
      return undefined;
    }
    const cached = this.ownerFileCache.get(name);
    if (cached && cached.revision === revision) return cached.owner;
    try {
      const owner = OwnerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      this.ownerFileCache.set(name, { revision, owner });
      return owner;
    } catch {
      /* Unreadable data is not proof of inactivity. */
      return undefined;
    }
  }

  /**
   * Read and validate one receipt file, reusing the parsed value until the file
   * itself changes.
   *
   * The safety requirement is that an in-place activation change is observed, not
   * that the bytes are re-parsed. A file's own revision detects every replacement
   * and content change, so renewal and revocation are still seen immediately,
   * while profile-guided profiling showed Zod re-validation plus readFileUtf8 and
   * their garbage collection were the gateway's largest CPU consumers.
   */
  private readReceiptFile(name: string): ManagedEntry | undefined {
    const file = path.join(this.entriesDir, name);
    let revision: string;
    try {
      const stat = fs.statSync(file, { bigint: true });
      // Include identity and both timestamps: an atomic rename changes inode and
      // ctime, an in-place write changes mtime, and size catches equal-timestamp rewrites.
      revision = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch {
      this.receiptFileCache.delete(name);
      return undefined;
    }
    const cached = this.receiptFileCache.get(name);
    if (cached && cached.revision === revision) {
      this.addKnownEntry(name, cached.entry);
      return cached.entry;
    }
    const entry = ManagedEntrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    this.receiptFileCache.set(name, { revision, entry });
    this.addKnownEntry(name, entry);
    return entry;
  }

  private entries(tool?: ManagedToolTuple): ManagedEntry[] {
    this.syncDiscovery();
    this.retryUnresolved();

    if (tool) {
      const filenames = this.toolIndex.get(tool.toolId);
      if (!filenames || filenames.size === 0) {
        return [];
      }
      const result: ManagedEntry[] = [];
      for (const name of filenames) {
        try {
          const entry = this.readReceiptFile(name);
          if (entry) {
            result.push(entry);
          } else {
            const fallback = this.knownEntries.get(name);
            if (fallback) result.push(fallback);
          }
        } catch {
          // Keep known receipts when files gone/unreadable as current failclosed provenance policy
          const fallback = this.knownEntries.get(name);
          if (fallback) {
            result.push(fallback);
          }
        }
      }
      return result;
    }

    // Global entries() for purge and cross-owner equality: refresh all known receipts from disk
    if (fs.existsSync(this.entriesDir)) {
      for (const name of this.receiptNames) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          this.readReceiptFile(name);
        } catch {
          /* Keep known receipts when files gone/unreadable */
        }
      }
    }
    return [...this.knownEntries.values()];
  }

  private files(directory: string): string[] {
    try {
      return fs.readdirSync(directory);
    } catch {
      return [];
    }
  }

  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(file)) !== path.resolve(path.dirname(file))) {
      throw new Error("Refusing managed metadata write through a symlink");
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
      // A rename can preserve mtime granularity; never serve the previous parse.
      const directory = path.dirname(file);
      if (directory === this.ownersDir) {
        this.ownerFileCache.delete(path.basename(file));
      } else if (directory === this.entriesDir) {
        this.receiptFileCache.delete(path.basename(file));
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  captureConfirmation(): ManagedToolConfirmation {
    if (!this.identity) {
      return {};
    }
    const id = this.ownerKey(this.identity);
    const owner = this.readOwners().get(id);
    if (!owner) {
      return {
        cloudUrl: new URL(this.identity.cloudUrl).origin,
        accountId: this.identity.accountId,
        userId: this.identity.userId,
      };
    }
    return {
      cloudUrl: owner.cloudUrl,
      accountId: owner.accountId,
      userId: owner.userId,
      toolAccess: owner.toolAccess,
      proofId: owner.proofId,
      revocationId: owner.revocationId,
      epoch: owner.epoch,
    };
  }

  confirm(
    response: AccountToolAccessResponse,
    observed: ManagedToolConfirmation = this.captureConfirmation(),
  ): ManagedToolConfirmation | undefined {
    if (
      !this.identity ||
      response.accountId !== this.identity.accountId ||
      response.userId !== this.identity.userId
    ) {
      return undefined;
    }

    const cloudUrl = new URL(this.identity.cloudUrl).origin;
    const id = this.ownerKey(this.identity);
    const now = Date.now();

    if (response.toolAccess === "subscription_inactive") {
      const previous = this.knownOwners.get(id);
      const newRevocationId =
        previous?.toolAccess === "subscription_inactive" && previous.revocationId
          ? previous.revocationId
          : crypto.randomUUID();
      const newProofId = crypto.randomUUID();
      const provisionalOwner: Owner = {
        schemaVersion: "1.0.0",
        cloudUrl,
        accountId: response.accountId,
        userId: response.userId,
        toolAccess: "subscription_inactive",
        revocationId: newRevocationId,
        proofId: newProofId,
        epoch: (previous?.epoch ?? 0) + 1,
      };

      // Retain in-memory denial BEFORE any fallible persistence (original safety semantics)
      this.deniedInMemory.set(id, provisionalOwner);
      this.pendingProofBases.set(id, previous?.proofId);

      try {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO owner_authorizations (
            owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch, updated_at
          ) VALUES (
            ?, ?, ?, ?, 'subscription_inactive', ?, ?, 1, ?
          )
          ON CONFLICT(owner_key) DO UPDATE SET
            tool_access = 'subscription_inactive',
            revocation_id = CASE
              WHEN owner_authorizations.tool_access = 'subscription_inactive' AND owner_authorizations.revocation_id IS NOT NULL
                THEN owner_authorizations.revocation_id
              ELSE excluded.revocation_id
            END,
            proof_id = excluded.proof_id,
            epoch = owner_authorizations.epoch + 1,
            updated_at = excluded.updated_at
          RETURNING owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch;
        `);

        const rows = stmt.all(
          id,
          cloudUrl,
          response.accountId,
          response.userId,
          newRevocationId,
          newProofId,
          now,
        ) as unknown as Array<{
          owner_key: string;
          cloud_url: string;
          account_id: string;
          user_id: string;
          tool_access: "subscription_inactive";
          revocation_id: string | null;
          proof_id: string;
          epoch: number;
        }>;

        const row = rows[0];
        const canonicalRevocationId = row.revocation_id ?? undefined;
        const canonicalOwner: Owner = {
          schemaVersion: "1.0.0",
          cloudUrl: row.cloud_url,
          accountId: row.account_id,
          userId: row.user_id,
          toolAccess: "subscription_inactive",
          revocationId: canonicalRevocationId,
          proofId: row.proof_id,
          epoch: Number(row.epoch),
        };

        // Mirrored JSON on disk constructed from actual SQL RETURNING row
        this.write(path.join(this.ownersDir, `${id}.json`), canonicalOwner);
        this.deniedInMemory.delete(id);
        this.pendingProofBases.delete(id);
        this.knownOwners.set(id, canonicalOwner);

        return {
          cloudUrl: canonicalOwner.cloudUrl,
          accountId: canonicalOwner.accountId,
          userId: canonicalOwner.userId,
          toolAccess: "subscription_inactive",
          proofId: canonicalOwner.proofId,
          revocationId: canonicalOwner.revocationId,
          epoch: canonicalOwner.epoch,
        };
      } catch (error) {
        // Persistence failed, but in-memory denial is preserved and authoritative
        this.knownOwners.set(id, provisionalOwner);
        throw error;
      }
    }

    // Before attempting allowance CAS: import any verified live legacy denial into the DB
    // so a stale observed allowance cannot match an old allowed DB row and overwrite the denial!
    this.importLegacyDenialIfPresent(id);

    const newProofId = crypto.randomUUID();
    const observedRevocationId = observed.revocationId ?? null;
    const observedProofId = observed.proofId ?? null;
    const observedToolAccess = observed.toolAccess ?? null;

    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO owner_authorizations (
        owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch, updated_at
      )
      SELECT ?, ?, ?, ?, 'allowed', ?, ?, 1, ?
      WHERE (? IS NULL AND (? IS NULL OR ? != 'subscription_inactive'))
         OR EXISTS (SELECT 1 FROM owner_authorizations WHERE owner_key = ?)
      ON CONFLICT(owner_key) DO UPDATE SET
        tool_access = 'allowed',
        revocation_id = owner_authorizations.revocation_id,
        proof_id = excluded.proof_id,
        epoch = owner_authorizations.epoch + 1,
        updated_at = excluded.updated_at
      WHERE (
        (owner_authorizations.tool_access != 'subscription_inactive' AND (
          (owner_authorizations.revocation_id IS NULL AND ? IS NULL) OR
          owner_authorizations.revocation_id = ?
        ))
        OR
        (owner_authorizations.tool_access = 'subscription_inactive' AND
         ? = 'subscription_inactive' AND
         owner_authorizations.proof_id = ? AND
         (
           (owner_authorizations.revocation_id IS NULL AND ? IS NULL) OR
           owner_authorizations.revocation_id = ?
         )
        )
      )
      RETURNING owner_key, cloud_url, account_id, user_id, tool_access, revocation_id, proof_id, epoch;
    `);

    const rows = stmt.all(
      id,
      cloudUrl,
      response.accountId,
      response.userId,
      observedRevocationId,
      newProofId,
      now,
      observedProofId,
      observedToolAccess,
      observedToolAccess,
      id,
      observedRevocationId,
      observedRevocationId,
      observedToolAccess,
      observedProofId,
      observedRevocationId,
      observedRevocationId,
    ) as unknown as Array<{
      owner_key: string;
      cloud_url: string;
      account_id: string;
      user_id: string;
      tool_access: "allowed";
      revocation_id: string | null;
      proof_id: string;
      epoch: number;
    }>;

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    const owner: Owner = {
      schemaVersion: "1.0.0",
      cloudUrl: row.cloud_url,
      accountId: row.account_id,
      userId: row.user_id,
      toolAccess: "allowed",
      revocationId: row.revocation_id ?? undefined,
      proofId: row.proof_id,
      epoch: Number(row.epoch),
    };

    this.write(path.join(this.ownersDir, `${id}.json`), owner);
    this.knownOwners.set(id, owner);

    return {
      cloudUrl: owner.cloudUrl,
      accountId: owner.accountId,
      userId: owner.userId,
      toolAccess: "allowed",
      proofId: owner.proofId,
      revocationId: owner.revocationId,
      epoch: owner.epoch,
    };
  }

  isInactive(): boolean {
    const owners = this.readOwners();
    return Boolean(
      this.identity &&
        (!this.authorityAvailable ||
          owners.get(this.ownerKey(this.identity))?.toolAccess === "subscription_inactive"),
    );
  }

  isBlocked(tool: ManagedToolTuple): boolean {
    const owners = this.readOwners();
    const entries = this.entries(tool).filter((record) => sameEntry(tool, record.entry));

    // If authoritative storage is unavailable, fail-closed on all proven managed tuples (including credentialless)
    // Sys and unmanaged tools (which have no recorded managed receipts) remain unblocked
    if (!this.authorityAvailable && entries.length > 0) {
      return true;
    }

    if (this.identity) {
      const currentOwner = this.ownerKey(this.identity);
      const currentEntries = entries.filter((record) => record.owner === currentOwner);
      if (
        currentEntries.length > 0 &&
        (owners.get(currentOwner)?.toolAccess === "subscription_inactive" ||
          currentEntries.every(
            (record) => record.activationId !== owners.get(currentOwner)?.revocationId,
          ))
      ) {
        return true;
      }
    }
    return (
      entries.some(
        (record) =>
          owners.get(record.owner)?.toolAccess === "subscription_inactive" ||
          record.activationId !== owners.get(record.owner)?.revocationId,
      ) &&
      !entries.some(
        (record) =>
          owners.get(record.owner)?.toolAccess !== "subscription_inactive" &&
          record.activationId === owners.get(record.owner)?.revocationId,
      )
    );
  }

  assertAllowed(tool: ManagedToolTuple): void {
    if (this.isBlocked(tool)) throw new Error("Managed tool access is unavailable");
  }

  isManaged(tool: ManagedToolTuple): boolean {
    return this.entries(tool).some((record) => sameEntry(tool, record.entry));
  }

  record(
    entry: V1LockedToolEntry,
    workspaceId?: string,
    lockManager?: ProjectLockManager,
    adopting = false,
    confirmation?: ManagedToolConfirmation,
  ): void {
    if (!this.identity) return;

    // Adoption of an already-recorded receipt is a pure no-op. Resolve it before any
    // ownership read: adopting runs once per registered tool, so reading the owners
    // directory here made a catalog pass walk it thousands of times per second.
    const ownerKey = this.ownerKey(this.identity);
    const receiptFile = path.join(
      this.entriesDir,
      `${key({
        owner: ownerKey,
        entry,
        workspaceId,
        projectId: lockManager?.projectId,
        lockPath: lockManager?.lockPath,
      })}.json`,
    );
    if (adopting && fs.existsSync(receiptFile)) return;

    const owners = this.readOwners();
    // A prior transient failure must be retried before accepting any new receipt.
    if (!this.authorityAvailable) return;

    // Validate confirmation identity if provided
    if (confirmation) {
      if (
        (confirmation.accountId && confirmation.accountId !== this.identity.accountId) ||
        (confirmation.userId && confirmation.userId !== this.identity.userId)
      ) {
        return;
      }
    }

    const receipt = {
      owner: ownerKey,
      entry,
      workspaceId,
      projectId: lockManager?.projectId,
      lockPath: lockManager?.lockPath,
    };
    const file = receiptFile;

    const currentOwner = owners.get(receipt.owner);
    let activationId: string | undefined;
    if (adopting) {
      activationId = undefined;
    } else if (confirmation) {
      activationId =
        confirmation.toolAccess === "subscription_inactive" ? undefined : confirmation.revocationId;
    } else {
      activationId = currentOwner?.revocationId;
    }

    // Protect against overwriting a newer valid receipt at same filename with a stale confirmation
    if (fs.existsSync(file)) {
      try {
        const existing = ManagedEntrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
        const existingActive =
          existing.activationId !== undefined &&
          existing.activationId === currentOwner?.revocationId;
        const incomingActive =
          activationId !== undefined && activationId === currentOwner?.revocationId;

        // Conservative rejection: do not overwrite an active receipt with a stale/unactivated one
        if (existingActive && !incomingActive) {
          return;
        }

        // Avoid rewriting identical JSON every sync, which invalidates directory revision for all processes
        if (
          existing.activationId === activationId &&
          existing.owner === receipt.owner &&
          existing.workspaceId === receipt.workspaceId &&
          existing.projectId === receipt.projectId &&
          existing.lockPath === receipt.lockPath &&
          sameEntry(receipt.entry, existing.entry)
        ) {
          this.addKnownEntry(path.basename(file), existing);
          return;
        }
      } catch {
        /* Overwrite malformed existing record */
      }
    }

    const record = ManagedEntrySchema.parse({
      ...receipt,
      activationId,
    });
    this.write(file, record);
    this.addKnownEntry(path.basename(file), record);
  }
  /** Pre-upgrade catalog manifests carry explicit cloud account ownership; local locks do not. */
  adopt(registry: ToolRegistry | undefined, lockManager?: ProjectLockManager): void {
    if (!this.identity || !registry) return;
    // Resolve the committed lockfile once. Looking each tool up individually re-read
    // and re-cloned the whole lock, making adoption quadratic in the tool count.
    const lock = lockManager?.readLock();
    const byName = lock?.tools ?? {};
    const byToolId = new Map<string, V1LockedToolEntry>();
    if (lock) {
      for (const entry of Object.values(lock.tools)) {
        if (!byToolId.has(entry.toolId)) byToolId.set(entry.toolId, entry);
      }
    }
    // Resolve ownership once for the whole pass; record() is called per tool and each
    // call would otherwise re-read the owners directory.
    this.withOwnerSnapshot(() =>
      this.adoptRegisteredTools(registry, lockManager, byName, byToolId),
    );
  }

  private adoptRegisteredTools(
    registry: ToolRegistry,
    lockManager: ProjectLockManager | undefined,
    byName: Record<string, V1LockedToolEntry>,
    byToolId: Map<string, V1LockedToolEntry>,
  ): void {
    const identity = this.identity;
    if (!identity) return;
    for (const tool of registry.getAllRegisteredTools()) {
      const meta = tool.manifest.metadata;
      if (
        !meta ||
        meta.accountId !== identity.accountId ||
        (meta.source !== "registry" && meta.source !== "cloud")
      )
        continue;
      const locked = byName[tool.name] ?? byToolId.get(tool.toolId);
      const parsed = V1LockedToolEntrySchema.safeParse({
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        manifestDigest: tool.manifestDigest,
        artifactDigest: tool.artifactDigest ?? meta.artifactDigest,
        status: "active",
      });
      if (!parsed.success) continue;
      this.record(
        parsed.data,
        tool.workspaceId ?? (typeof meta.workspaceId === "string" ? meta.workspaceId : undefined),
        undefined,
        true,
      );
      if (
        locked &&
        locked.toolId === tool.toolId &&
        locked.version === tool.version &&
        locked.artifactDigest.replace(/^sha256:/, "") ===
          parsed.data.artifactDigest.replace(/^sha256:/, "")
      ) {
        this.record(locked, tool.workspaceId, lockManager, true);
      }
    }
  }

  /**
   * Live cleanup invoked during production sync/runtime. Non-destructive: immediately hides
   * blocked tools from in-memory dispatch without deleting shared locks, DB records, or cache bytes.
   */
  async cleanup(registry?: ToolRegistry): Promise<void> {
    if (registry) {
      registry.setManagedToolAccess(this);
    }
  }

  /**
   * Quiescent maintenance only. Never called during production sync/runtime.
   * Performs physical eviction of lockfile entries, registry state, and owned artifact bytes
   * for permanently inactive accounts when no other active owner shares the artifacts.
   */
  async purgeInactiveTools(registry?: ToolRegistry): Promise<void> {
    const owners = this.readOwners();
    const records = this.entries();
    const failures: unknown[] = [];
    for (const record of records) {
      const freshOwners = this.readOwners();
      const currentOwner = freshOwners.get(record.owner);
      if (currentOwner?.toolAccess !== "subscription_inactive") continue;

      const freshRecords = this.entries();
      const cleanRecordDigest = record.entry.artifactDigest.replace(/^sha256:/, "");

      // Check if this artifact digest is used by ANY active tool in the system
      const isArtifactReferencedByActiveTool = freshRecords.some((other) => {
        const otherOwner = freshOwners.get(other.owner);
        const otherCleanDigest = other.entry.artifactDigest.replace(/^sha256:/, "");
        if (otherCleanDigest !== cleanRecordDigest) return false;
        return (
          otherOwner?.toolAccess !== "subscription_inactive" &&
          other.activationId === otherOwner?.revocationId
        );
      });
      if (isArtifactReferencedByActiveTool) continue;

      const shared = freshRecords.some(
        (other) =>
          other.owner !== record.owner &&
          sameEntry(record.entry, other.entry) &&
          freshOwners.get(other.owner)?.toolAccess !== "subscription_inactive",
      );

      try {
        if (
          record.lockPath &&
          record.projectId &&
          path.basename(record.lockPath) === "resin.lock" &&
          path.basename(path.dirname(record.lockPath)) === ".resin" &&
          fs.existsSync(record.lockPath)
        ) {
          const sharedLock =
            shared &&
            freshRecords.some(
              (other) =>
                other.owner !== record.owner &&
                other.lockPath === record.lockPath &&
                sameEntry(record.entry, other.entry) &&
                freshOwners.get(other.owner)?.toolAccess !== "subscription_inactive",
            );
          if (!sharedLock) {
            if (fs.realpathSync(record.lockPath) !== path.resolve(record.lockPath)) {
              throw new Error("Refusing managed cleanup through a symlinked project lock");
            }
            const manager = new ProjectLockManager({
              lockPath: record.lockPath,
              projectId: record.projectId,
            });
            manager.remove(record.entry.name, record.entry);
          }
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        if (registry && !shared) await registry.removeManagedTool(record.entry, record.workspaceId);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.artifactCache.removeOwnedArtifactReference(
          record.entry.artifactDigest,
          record.projectId ? `${record.projectId}:${record.entry.name}` : undefined,
          record.entry.toolId,
          record.entry.version,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Managed tool purge will retry");
  }

  close(): void {
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
    this.authorityAvailable = false;
  }
}
