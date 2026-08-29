import { SystemKeychainStore } from "./keychain.js";
import { SecretRedactor } from "./redaction.js";
import type {
  MediationMode,
  SecretManagerOptions,
  SecretMetadata,
  SecretStore,
  SetSecretOptions,
} from "./types.js";
import { EncryptedVaultSecretStore } from "./vault.js";

/**
 * SecretManager coordinates secret storage, lifecycle (add, rotate, delete),
 * capability-scoped mediation access, and deterministic output redaction.
 */
export class SecretManager {
  private readonly store: SecretStore;
  private readonly redactor: SecretRedactor;

  constructor(options: SecretManagerOptions = {}) {
    this.redactor = options.redactor ?? new SecretRedactor();

    if (options.store) {
      this.store = options.store;
    } else if (options.vaultPath || options.passphrase) {
      this.store = new EncryptedVaultSecretStore({
        vaultPath: options.vaultPath,
        passphrase: options.passphrase,
      });
    } else {
      this.store = new SystemKeychainStore();
    }
  }

  /**
   * Adds a new named secret to the store and registers it with the redactor.
   */
  async addSecret(
    name: string,
    value: string,
    options: SetSecretOptions = {},
  ): Promise<SecretMetadata> {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Secret name must be a non-empty string");
    }
    if (value === undefined || value === null || typeof value !== "string") {
      throw new Error("Secret value must be a valid string");
    }

    const metadata = await this.store.setSecret(name, value, options);
    this.redactor.registerSecret(value, name);

    return metadata;
  }

  /**
   * Rotates an existing secret to a new value, incrementing its version.
   */
  async rotateSecret(
    name: string,
    newValue: string,
    workspaceId?: string,
  ): Promise<SecretMetadata> {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Secret name must be a non-empty string");
    }
    if (newValue === undefined || newValue === null || typeof newValue !== "string") {
      throw new Error("New secret value must be a valid string");
    }

    const existingMeta = await this.store.getMetadata(name, workspaceId);
    if (!existingMeta) {
      throw new Error(`Secret '${name}' not found for rotation`);
    }

    const metadata = await this.store.setSecret(name, newValue, {
      alias: existingMeta.alias,
      aliases: existingMeta.aliases,
      workspaceId: workspaceId ?? existingMeta.workspaceId,
      allowedMediationModes: existingMeta.allowedMediationModes,
      tags: existingMeta.tags,
      description: existingMeta.description,
    });

    this.redactor.registerSecret(newValue, name);
    return metadata;
  }

  /**
   * Deletes a named secret from the store.
   */
  async deleteSecret(name: string, workspaceId?: string): Promise<boolean> {
    const meta = await this.store.getMetadata(name, workspaceId);
    const deleted = await this.store.deleteSecret(name, workspaceId);
    if (deleted && meta) {
      this.redactor.unregisterSecret(name);
    }
    return deleted;
  }

  /**
   * Lists metadata for all stored secrets. Never returns raw values.
   */
  async listMetadata(workspaceId?: string): Promise<SecretMetadata[]> {
    return this.store.listMetadata(workspaceId);
  }

  /**
   * Retrieves metadata for a specific secret by name or alias.
   */
  async getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null> {
    return this.store.getMetadata(nameOrAlias, workspaceId);
  }

  /**
   * Checks if a secret exists by name or alias.
   */
  async hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean> {
    return this.store.hasSecret(nameOrAlias, workspaceId);
  }

  /**
   * Resolves a secret value exclusively for capability mediation.
   * Enforces existence, workspace isolation, and allowed mediation modes.
   */
  async getSecretForMediation(
    nameOrAlias: string,
    mode: MediationMode,
    workspaceId?: string,
  ): Promise<string> {
    const meta = await this.store.getMetadata(nameOrAlias);
    if (!meta) {
      throw new Error(`Secret '${nameOrAlias}' not found or undeclared`);
    }

    if (workspaceId && meta.workspaceId && meta.workspaceId !== workspaceId) {
      throw new Error(
        `Secret '${nameOrAlias}' belongs to workspace '${meta.workspaceId}', not '${workspaceId}'`,
      );
    }

    if (meta.allowedMediationModes && meta.allowedMediationModes.length > 0) {
      if (!meta.allowedMediationModes.includes(mode)) {
        throw new Error(
          `Mediation mode '${mode}' is not permitted for secret '${nameOrAlias}'. Allowed: ${meta.allowedMediationModes.join(", ")}`,
        );
      }
    }

    const value = await this.store.getSecret(nameOrAlias, workspaceId);
    if (value === null) {
      throw new Error(`Secret '${nameOrAlias}' could not be retrieved from store`);
    }

    return value;
  }

  /**
   * Purges all secrets in the store (or for a workspace) and resets the redactor.
   */
  async purgeSecrets(workspaceId?: string): Promise<number> {
    const count = await this.store.purgeSecrets(workspaceId);
    if (!workspaceId) {
      this.redactor.clear();
    }
    return count;
  }

  /**
   * Redacts secret patterns and registered secret values in a string.
   */
  redact(input: string): string {
    return this.redactor.redact(input);
  }

  /**
   * Deeply redacts secret patterns and registered values across structured objects.
   */
  redactObject<T>(obj: T): T {
    return this.redactor.redactObject(obj);
  }

  /**
   * Returns the underlying secret redactor.
   */
  getRedactor(): SecretRedactor {
    return this.redactor;
  }

  /**
   * Returns the underlying secret store.
   */
  getStore(): SecretStore {
    return this.store;
  }
}
