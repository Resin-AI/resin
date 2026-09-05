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
  private readonly ownersDir: string;
  private readonly entriesDir: string;
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

  private readOwners(): Map<string, Owner> {
    const owners = new Map(this.knownOwners);
    if (fs.existsSync(this.ownersDir)) {
      for (const name of this.files(this.ownersDir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const owner = OwnerSchema.parse(
            JSON.parse(fs.readFileSync(path.join(this.ownersDir, name), "utf8")),
          );
          if (name === `${this.ownerKey(owner)}.json`) {
            owners.set(name.slice(0, -5), owner);
            this.knownOwners.set(name.slice(0, -5), owner);
          }
        } catch {
          /* Unreadable data is not proof of inactivity. */
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

  private entries(): ManagedEntry[] {
    if (!fs.existsSync(this.entriesDir)) return [...this.knownEntries.values()];
    for (const name of this.files(this.entriesDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const entry = ManagedEntrySchema.parse(
          JSON.parse(fs.readFileSync(path.join(this.entriesDir, name), "utf8")),
        );
        this.knownEntries.set(name, entry);
      } catch {
        /* Never delete using malformed ownership records. */
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
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  /** Serialize managed sync/download/removal across standalone processes. Busy cycles retry later. */
  acquireSync(): (() => void) | undefined {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.stateDir) !== path.resolve(this.stateDir)) {
      throw new Error("Refusing managed synchronization through a symlinked state directory");
    }
    const database = new DatabaseSync(path.join(this.stateDir, "sync.db"));
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      return () => {
        try {
          database.exec("COMMIT;");
        } finally {
          database.close();
        }
      };
    } catch (error) {
      database.close();
      if (error instanceof Error && "errcode" in error && error.errcode === 5) return undefined;
      throw error;
    }
  }

  confirm(response: AccountToolAccessResponse): void {
    if (
      !this.identity ||
      response.accountId !== this.identity.accountId ||
      response.userId !== this.identity.userId
    )
      return;
    const previous = this.readOwners().get(this.ownerKey(this.identity));
    const owner = OwnerSchema.parse({
      ...response,
      cloudUrl: new URL(this.identity.cloudUrl).origin,
      proofId: crypto.randomUUID(),
      revocationId:
        response.toolAccess === "subscription_inactive"
          ? previous?.toolAccess === "subscription_inactive"
            ? previous.revocationId
            : crypto.randomUUID()
          : previous?.revocationId,
    });
    const id = this.ownerKey(owner);
    if (owner.toolAccess === "subscription_inactive") {
      this.deniedInMemory.set(id, owner);
      this.pendingProofBases.set(id, this.knownOwners.get(id)?.proofId);
    }
    // Persist before allowing restoration; a failed write retains the previous denial.
    this.write(path.join(this.ownersDir, `${id}.json`), owner);
    this.deniedInMemory.delete(id);
    this.pendingProofBases.delete(id);
    this.knownOwners.set(id, owner);
  }

  isInactive(): boolean {
    return Boolean(
      this.identity &&
        this.readOwners().get(this.ownerKey(this.identity))?.toolAccess === "subscription_inactive",
    );
  }

  isBlocked(tool: ManagedToolTuple): boolean {
    const owners = this.readOwners();
    const entries = this.entries().filter((record) => sameEntry(tool, record.entry));
    if (this.identity) {
      const currentOwner = this.ownerKey(this.identity);
      const currentEntries = entries.filter((record) => record.owner === currentOwner);
      if (
        currentEntries.length > 0 &&
        (owners.get(currentOwner)?.toolAccess === "subscription_inactive" ||
          currentEntries.every(
            (record) => record.activationId !== owners.get(currentOwner)?.revocationId,
          ))
      )
        return true;
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
    return this.entries().some((record) => sameEntry(tool, record.entry));
  }

  record(
    entry: V1LockedToolEntry,
    workspaceId?: string,
    lockManager?: ProjectLockManager,
    adopting = false,
  ): void {
    if (!this.identity) return;
    const receipt = {
      owner: this.ownerKey(this.identity),
      entry,
      workspaceId,
      projectId: lockManager?.projectId,
      lockPath: lockManager?.lockPath,
    };
    const file = path.join(this.entriesDir, `${key(receipt)}.json`);
    if (adopting && fs.existsSync(file)) return;
    const record = ManagedEntrySchema.parse({
      ...receipt,
      activationId: adopting ? undefined : this.readOwners().get(receipt.owner)?.revocationId,
    });
    this.write(file, record);
  }

  /** Pre-upgrade catalog manifests carry explicit cloud account ownership; local locks do not. */
  adopt(registry: ToolRegistry | undefined, lockManager?: ProjectLockManager): void {
    if (!this.identity || !registry) return;
    for (const tool of registry.getAllRegisteredTools()) {
      const meta = tool.manifest.metadata;
      if (
        !meta ||
        meta.accountId !== this.identity.accountId ||
        (meta.source !== "registry" && meta.source !== "cloud")
      )
        continue;
      const locked = lockManager?.getLockedTool(tool.toolId);
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

  async cleanup(registry?: ToolRegistry): Promise<void> {
    const owners = this.readOwners();
    const records = this.entries();
    const failures: unknown[] = [];
    // Receipts survive cleanup to prevent stale handlers and snapshots from rehydrating.
    for (const record of records) {
      if (owners.get(record.owner)?.toolAccess !== "subscription_inactive") continue;
      const shared = records.some(
        (other) =>
          other.owner !== record.owner &&
          sameEntry(record.entry, other.entry) &&
          owners.get(other.owner)?.toolAccess !== "subscription_inactive",
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
            records.some(
              (other) =>
                other.owner !== record.owner &&
                other.lockPath === record.lockPath &&
                sameEntry(record.entry, other.entry) &&
                owners.get(other.owner)?.toolAccess !== "subscription_inactive",
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
        if (!shared) {
          await this.artifactCache.removeOwnedArtifactReference(
            record.entry.artifactDigest,
            record.projectId ? `${record.projectId}:${record.entry.name}` : undefined,
            record.entry.toolId,
            record.entry.version,
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Managed tool cleanup will retry");
  }
}
