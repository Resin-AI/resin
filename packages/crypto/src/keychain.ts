import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { KeychainOptions, SecretMetadata, SecretStore, SetSecretOptions } from "./types.js";
import { EncryptedVaultSecretStore } from "./vault.js";

const DEFAULT_SERVICE_NAME = "resin";

/**
 * MacKeychainSecretStore integrates with macOS Keychain via the /usr/bin/security CLI.
 * Falls back to an internal EncryptedVaultSecretStore when unavailable or on other platforms.
 */
export class MacKeychainSecretStore implements SecretStore {
  readonly name = "mac-keychain";

  private readonly serviceName: string;
  private readonly fallback: SecretStore;
  private metadataCache: Map<string, SecretMetadata> = new Map();

  constructor(options: KeychainOptions = {}) {
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.fallback = options.fallbackStore ?? new EncryptedVaultSecretStore();
  }

  isAvailable(): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    try {
      const res = spawnSync("/usr/bin/security", ["help"], { stdio: "pipe" });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  private buildAccountKey(name: string, workspaceId?: string): string {
    return workspaceId ? `${workspaceId}:${name}` : name;
  }

  async getSecret(nameOrAlias: string, workspaceId?: string): Promise<string | null> {
    if (!this.isAvailable()) {
      return this.fallback.getSecret(nameOrAlias, workspaceId);
    }

    const account = this.buildAccountKey(nameOrAlias, workspaceId);
    try {
      const res = spawnSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", this.serviceName, "-a", account, "-w"],
        { encoding: "utf-8", stdio: "pipe" },
      );

      if (res.status === 0 && res.stdout) {
        return res.stdout.trimEnd();
      }
    } catch {
      // Fall through to fallback
    }

    return this.fallback.getSecret(nameOrAlias, workspaceId);
  }

  async setSecret(
    name: string,
    value: string,
    options: SetSecretOptions = {},
  ): Promise<SecretMetadata> {
    const fallbackMeta = await this.fallback.setSecret(name, value, options);

    if (this.isAvailable()) {
      const account = this.buildAccountKey(name, options.workspaceId);
      try {
        spawnSync(
          "/usr/bin/security",
          [
            "add-generic-password",
            "-s",
            this.serviceName,
            "-a",
            account,
            "-w",
            value,
            "-U", // Update if exists
          ],
          { stdio: "pipe" },
        );
      } catch {
        // Ignored, fallback succeeded
      }
    }

    this.metadataCache.set(this.buildAccountKey(name, options.workspaceId), fallbackMeta);
    return fallbackMeta;
  }

  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    const fallbackDeleted = await this.fallback.deleteSecret(name, workspaceId);

    if (this.isAvailable()) {
      const account = this.buildAccountKey(name, workspaceId);
      try {
        spawnSync(
          "/usr/bin/security",
          ["delete-generic-password", "-s", this.serviceName, "-a", account],
          { stdio: "pipe" },
        );
      } catch {
        // Ignored
      }
    }

    this.metadataCache.delete(this.buildAccountKey(name, workspaceId));
    return fallbackDeleted;
  }

  async listMetadata(workspaceId?: string): Promise<SecretMetadata[]> {
    return this.fallback.listMetadata(workspaceId);
  }

  async getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null> {
    return this.fallback.getMetadata(nameOrAlias, workspaceId);
  }

  async hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return this.fallback.hasSecret(nameOrAlias, workspaceId);
    }
    const val = await this.getSecret(nameOrAlias, workspaceId);
    return val !== null;
  }

  async purgeSecrets(workspaceId?: string): Promise<number> {
    return this.fallback.purgeSecrets(workspaceId);
  }
}

/**
 * LinuxSecretServiceStore integrates with freedesktop Secret Service / secret-tool on Linux.
 * Falls back to an internal EncryptedVaultSecretStore when unavailable or on other platforms.
 */
export class LinuxSecretServiceStore implements SecretStore {
  readonly name = "linux-secret-service";

  private readonly serviceName: string;
  private readonly fallback: SecretStore;

  constructor(options: KeychainOptions = {}) {
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.fallback = options.fallbackStore ?? new EncryptedVaultSecretStore();
  }

  isAvailable(): boolean {
    if (process.platform !== "linux") {
      return false;
    }
    try {
      const res = spawnSync("secret-tool", ["--version"], { stdio: "pipe" });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  private buildAccountKey(name: string, workspaceId?: string): string {
    return workspaceId ? `${workspaceId}:${name}` : name;
  }

  async getSecret(nameOrAlias: string, workspaceId?: string): Promise<string | null> {
    if (!this.isAvailable()) {
      return this.fallback.getSecret(nameOrAlias, workspaceId);
    }

    const account = this.buildAccountKey(nameOrAlias, workspaceId);
    try {
      const res = spawnSync(
        "secret-tool",
        ["lookup", "service", this.serviceName, "account", account],
        { encoding: "utf-8", stdio: "pipe" },
      );

      if (res.status === 0 && res.stdout) {
        return res.stdout.trimEnd();
      }
    } catch {
      // Fall through to fallback
    }

    return this.fallback.getSecret(nameOrAlias, workspaceId);
  }

  async setSecret(
    name: string,
    value: string,
    options: SetSecretOptions = {},
  ): Promise<SecretMetadata> {
    const fallbackMeta = await this.fallback.setSecret(name, value, options);

    if (this.isAvailable()) {
      const account = this.buildAccountKey(name, options.workspaceId);
      try {
        const child = spawnSync(
          "secret-tool",
          [
            "store",
            `--label=Resin Secret: ${name}`,
            "service",
            this.serviceName,
            "account",
            account,
          ],
          { input: value, stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch {
        // Ignored
      }
    }

    return fallbackMeta;
  }

  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    const fallbackDeleted = await this.fallback.deleteSecret(name, workspaceId);

    if (this.isAvailable()) {
      const account = this.buildAccountKey(name, workspaceId);
      try {
        spawnSync("secret-tool", ["clear", "service", this.serviceName, "account", account], {
          stdio: "pipe",
        });
      } catch {
        // Ignored
      }
    }

    return fallbackDeleted;
  }

  async listMetadata(workspaceId?: string): Promise<SecretMetadata[]> {
    return this.fallback.listMetadata(workspaceId);
  }

  async getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null> {
    return this.fallback.getMetadata(nameOrAlias, workspaceId);
  }

  async hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return this.fallback.hasSecret(nameOrAlias, workspaceId);
    }
    const val = await this.getSecret(nameOrAlias, workspaceId);
    return val !== null;
  }

  async purgeSecrets(workspaceId?: string): Promise<number> {
    return this.fallback.purgeSecrets(workspaceId);
  }
}

/**
 * SystemKeychainStore automatically selects the native system keychain on macOS / Linux,
 * with full fallback to an EncryptedVaultSecretStore.
 */
export class SystemKeychainStore implements SecretStore {
  readonly name = "system-keychain";
  private readonly store: SecretStore;

  constructor(options: KeychainOptions = {}) {
    if (process.platform === "darwin") {
      this.store = new MacKeychainSecretStore(options);
    } else if (process.platform === "linux") {
      this.store = new LinuxSecretServiceStore(options);
    } else {
      this.store = options.fallbackStore ?? new EncryptedVaultSecretStore();
    }
  }

  isAvailable(): boolean {
    return this.store.isAvailable ? Boolean(this.store.isAvailable()) : true;
  }

  async getSecret(nameOrAlias: string, workspaceId?: string): Promise<string | null> {
    return this.store.getSecret(nameOrAlias, workspaceId);
  }

  async setSecret(
    name: string,
    value: string,
    options?: SetSecretOptions,
  ): Promise<SecretMetadata> {
    return this.store.setSecret(name, value, options);
  }

  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    return this.store.deleteSecret(name, workspaceId);
  }

  async listMetadata(workspaceId?: string): Promise<SecretMetadata[]> {
    return this.store.listMetadata(workspaceId);
  }

  async getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null> {
    return this.store.getMetadata(nameOrAlias, workspaceId);
  }

  async hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean> {
    return this.store.hasSecret(nameOrAlias, workspaceId);
  }

  async purgeSecrets(workspaceId?: string): Promise<number> {
    return this.store.purgeSecrets(workspaceId);
  }
}
