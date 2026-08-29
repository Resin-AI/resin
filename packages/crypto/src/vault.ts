import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EncryptedVaultOptions,
  SecretMetadata,
  SecretRecord,
  SecretStore,
  SetSecretOptions,
} from "./types.js";

/**
 * Vault file format schema stored on disk.
 */
interface VaultFilePayload {
  version: number;
  salt: string;
  kdf: "pbkdf2" | "scrypt" | "argon2";
  kdfIterations: number;
  records: Record<string, SecretRecord>;
  updatedAt: number;
}

const DEFAULT_VAULT_VERSION = 1;
const DEFAULT_KDF_ITERATIONS = 100_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_THRESHOLD_MS = 10_000;

function delay(ms: number): Promise<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  setTimeout(resolve, ms);
  return promise;
}
/**
 * EncryptedVaultSecretStore implements an encrypted, file-backed (or in-memory)
 * secret store using AES-256-GCM, PBKDF2 key derivation, file locking, and strict 0600 permissions.
 */
export class EncryptedVaultSecretStore implements SecretStore {
  readonly name = "encrypted-vault";

  private readonly vaultPath?: string;
  private readonly isInMemory: boolean;
  private readonly kdf: "pbkdf2" | "scrypt" | "argon2";
  private readonly kdfIterations: number;
  private readonly lockTimeoutMs: number;

  private vaultSalt: Buffer;
  private derivedKey: Buffer;
  private inMemoryRecords: Record<string, SecretRecord> = {};

  constructor(options: EncryptedVaultOptions = {}) {
    this.vaultPath =
      options.vaultPath && options.vaultPath !== ":memory:"
        ? path.resolve(options.vaultPath)
        : undefined;
    this.isInMemory = !this.vaultPath;
    this.kdf = options.kdf ?? "pbkdf2";
    this.kdfIterations = options.kdfIterations ?? DEFAULT_KDF_ITERATIONS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

    const rawPassphrase =
      options.passphrase ?? process.env.RESIN_VAULT_PASSPHRASE ?? this.resolveMachineMasterKey();

    // Initialize or load vault salt
    if (!this.isInMemory && fs.existsSync(this.vaultPath!)) {
      try {
        const content = fs.readFileSync(this.vaultPath!, "utf-8");
        const parsed: VaultFilePayload = JSON.parse(content);
        this.vaultSalt = Buffer.from(parsed.salt, "hex");
      } catch {
        this.vaultSalt = randomBytes(32);
      }
    } else {
      this.vaultSalt = randomBytes(32);
    }

    // Derive 256-bit AES key from master passphrase
    this.derivedKey = pbkdf2Sync(rawPassphrase, this.vaultSalt, this.kdfIterations, 32, "sha512");
  }

  isAvailable(): boolean {
    return true;
  }

  /**
   * Deterministically resolves a machine-scoped fallback key based on machine id/user if no passphrase provided.
   */
  private resolveMachineMasterKey(): string {
    const userInfo = os.userInfo();
    const machineSeed = `${os.hostname()}:${userInfo.username}:${userInfo.homedir}:resin-vault-seed`;
    return createHash("sha256").update(machineSeed).digest("hex");
  }

  /**
   * Acquires cross-process lock file on vaultPath.
   */
  private async acquireLock(): Promise<() => void> {
    if (this.isInMemory || !this.vaultPath) {
      return () => {};
    }

    const lockPath = `${this.vaultPath}.lock`;
    const startTime = Date.now();

    while (Date.now() - startTime < this.lockTimeoutMs) {
      try {
        // Ensure directory exists with 0700 permissions
        const dir = path.dirname(lockPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }

        // Check if existing lock is stale
        if (fs.existsSync(lockPath)) {
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Ignored if race occurred
          }
        }
        // Try exclusive lock creation with 0600 mode
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
        const lockPayload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
        fs.writeSync(fd, lockPayload);
        fs.closeSync(fd);

        return () => {
          try {
            if (fs.existsSync(lockPath)) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Ignored
          }
        };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Lock held, wait with jitter
          await delay(20 + Math.random() * 30);
        } else {
          throw err;
        }
      }
    }

    throw new Error(
      `Failed to acquire lock for vault '${this.vaultPath}' within ${this.lockTimeoutMs}ms`,
    );
  }

  /**
   * Helper to execute an operation inside a file lock.
   */
  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await op();
    } finally {
      release();
    }
  }

  /**
   * Loads current vault records from disk or in-memory cache.
   */
  private loadRecords(): Record<string, SecretRecord> {
    if (this.isInMemory || !this.vaultPath) {
      return this.inMemoryRecords;
    }

    if (!fs.existsSync(this.vaultPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(this.vaultPath, "utf-8");
      const parsed: VaultFilePayload = JSON.parse(content);
      return parsed.records ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Saves records to disk atomically with strict 0600 permissions.
   */
  private saveRecords(records: Record<string, SecretRecord>): void {
    if (this.isInMemory || !this.vaultPath) {
      this.inMemoryRecords = records;
      return;
    }

    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const payload: VaultFilePayload = {
      version: DEFAULT_VAULT_VERSION,
      salt: this.vaultSalt.toString("hex"),
      kdf: this.kdf,
      kdfIterations: this.kdfIterations,
      records,
      updatedAt: Date.now(),
    };

    const tmpPath = `${this.vaultPath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC,
      0o600,
    );
    fs.writeSync(fd, JSON.stringify(payload, null, 2), undefined, "utf-8");
    fs.closeSync(fd);
    fs.chmodSync(tmpPath, 0o600);

    // Atomic rename
    fs.renameSync(tmpPath, this.vaultPath);
    fs.chmodSync(this.vaultPath, 0o600);
  }

  /**
   * Encrypts plaintext string using AES-256-GCM.
   */
  private encryptValue(plaintext: string): {
    ciphertextHex: string;
    ivHex: string;
    tagHex: string;
  } {
    const iv = randomBytes(12); // 96-bit IV for AES-GCM
    const cipher = createCipheriv("aes-256-gcm", this.derivedKey, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertextHex: encrypted.toString("hex"),
      ivHex: iv.toString("hex"),
      tagHex: tag.toString("hex"),
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM.
   */
  private decryptValue(ciphertextHex: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");

    const decipher = createDecipheriv("aes-256-gcm", this.derivedKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return decrypted.toString("utf-8");
  }

  /**
   * Finds a secret record by name or alias, checking workspaceId match if specified.
   */
  private findRecord(
    records: Record<string, SecretRecord>,
    nameOrAlias: string,
    workspaceId?: string,
  ): SecretRecord | null {
    // 1. Direct name lookup
    const byName = records[nameOrAlias];
    if (byName) {
      if (!workspaceId || !byName.workspaceId || byName.workspaceId === workspaceId) {
        return byName;
      }
    }

    // 2. Alias lookup
    for (const record of Object.values(records)) {
      const aliases = record.aliases ?? (record.alias ? [record.alias] : []);
      if (aliases.includes(nameOrAlias)) {
        if (!workspaceId || !record.workspaceId || record.workspaceId === workspaceId) {
          return record;
        }
      }
    }

    return null;
  }

  async getSecret(nameOrAlias: string, workspaceId?: string): Promise<string | null> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      const record = this.findRecord(records, nameOrAlias, workspaceId);
      if (!record) {
        return null;
      }

      try {
        return this.decryptValue(record.encryptedValue, record.iv, record.tag);
      } catch (err) {
        throw new Error(`Failed to decrypt secret '${nameOrAlias}': ${(err as Error).message}`);
      }
    });
  }

  async setSecret(
    name: string,
    value: string,
    options: SetSecretOptions = {},
  ): Promise<SecretMetadata> {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Secret name must be a non-empty string");
    }

    return this.withLock(async () => {
      const records = this.loadRecords();
      const existing = records[name];
      const now = Date.now();
      const version = existing ? existing.version + 1 : 1;
      const createdAt = existing ? existing.createdAt : now;

      const fingerprint = createHash("sha256").update(value).digest("hex");
      const { ciphertextHex, ivHex, tagHex } = this.encryptValue(value);

      const aliases = options.aliases
        ? Array.from(new Set(options.aliases))
        : options.alias
          ? [options.alias]
          : (existing?.aliases ?? (existing?.alias ? [existing.alias] : []));

      const metadata: SecretMetadata = {
        name,
        alias: options.alias ?? existing?.alias ?? aliases[0],
        aliases,
        workspaceId: options.workspaceId ?? existing?.workspaceId,
        fingerprint,
        createdAt,
        updatedAt: now,
        version,
        allowedMediationModes:
          options.allowedMediationModes ?? existing?.metadata?.allowedMediationModes,
        tags: options.tags ?? existing?.metadata?.tags,
        description: options.description ?? existing?.metadata?.description,
      };

      const record: SecretRecord = {
        name,
        alias: metadata.alias,
        aliases: metadata.aliases,
        workspaceId: metadata.workspaceId,
        encryptedValue: ciphertextHex,
        iv: ivHex,
        tag: tagHex,
        salt: this.vaultSalt.toString("hex"),
        kdf: this.kdf,
        kdfIterations: this.kdfIterations,
        metadata,
        createdAt,
        updatedAt: now,
        version,
      };

      records[name] = record;
      this.saveRecords(records);

      return metadata;
    });
  }

  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      const record = this.findRecord(records, name, workspaceId);
      if (!record) {
        return false;
      }

      delete records[record.name];
      this.saveRecords(records);
      return true;
    });
  }

  async listMetadata(workspaceId?: string): Promise<SecretMetadata[]> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      const result: SecretMetadata[] = [];

      for (const record of Object.values(records)) {
        if (!workspaceId || !record.workspaceId || record.workspaceId === workspaceId) {
          result.push({ ...record.metadata });
        }
      }

      return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      const record = this.findRecord(records, nameOrAlias, workspaceId);
      return record ? { ...record.metadata } : null;
    });
  }

  async hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      return this.findRecord(records, nameOrAlias, workspaceId) !== null;
    });
  }

  async purgeSecrets(workspaceId?: string): Promise<number> {
    return this.withLock(async () => {
      const records = this.loadRecords();
      let purgedCount = 0;

      if (!workspaceId) {
        purgedCount = Object.keys(records).length;
        this.saveRecords({});
      } else {
        const remaining: Record<string, SecretRecord> = {};
        for (const [key, record] of Object.entries(records)) {
          if (record.workspaceId === workspaceId) {
            purgedCount++;
          } else {
            remaining[key] = record;
          }
        }
        this.saveRecords(remaining);
      }

      return purgedCount;
    });
  }

  async close(): Promise<void> {
    // In-memory or file-backed cleanup
  }
}
