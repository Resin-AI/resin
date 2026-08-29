import type { SecretRedactor } from "./redaction.js";

/**
 * Types and interfaces for named-secret storage and capability mediation.
 */

/**
 * Secret alias identifier.
 */
export type SecretAlias = string;

/**
 * Supported mediation modes for injecting secrets without disclosing raw values.
 */
export type MediationMode =
  | "header_template"
  | "bearer_token"
  | "query_template"
  | "command_stdin"
  | "command_env";

/**
 * Metadata associated with a stored secret.
 * Plaintext secrets are never stored in metadata.
 */
export interface SecretMetadata {
  /**
   * Unique name of the secret.
   */
  name: string;

  /**
   * Primary alias for the secret.
   */
  alias?: SecretAlias;

  /**
   * Additional aliases for the secret.
   */
  aliases?: SecretAlias[];

  /**
   * Workspace identifier for multi-tenant isolation.
   */
  workspaceId?: string;

  /**
   * Cryptographic SHA-256 fingerprint of the secret value for verification and tracking.
   */
  fingerprint: string;

  /**
   * Timestamp (epoch ms) when the secret was created.
   */
  createdAt: number;

  /**
   * Timestamp (epoch ms) when the secret was last updated or rotated.
   */
  updatedAt: number;

  /**
   * Secret version number, incremented on rotation.
   */
  version: number;

  /**
   * Allowed mediation modes for this secret. If omitted, all modes are allowed.
   */
  allowedMediationModes?: MediationMode[];

  /**
   * Arbitrary tags for categorization and querying.
   */
  tags?: string[];

  /**
   * Optional human-readable description.
   */
  description?: string;
}

/**
 * Encrypted secret record stored in persistent vaults.
 */
export interface SecretRecord {
  name: string;
  alias?: SecretAlias;
  aliases?: SecretAlias[];
  workspaceId?: string;
  encryptedValue: string; // Base64 or Hex encoded ciphertext
  iv: string; // Base64 or Hex encoded initialization vector
  tag: string; // Base64 or Hex encoded authentication tag
  salt: string; // Base64 or Hex encoded KDF salt
  kdf: "pbkdf2" | "scrypt" | "argon2";
  kdfIterations?: number;
  metadata: SecretMetadata;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/**
 * Secret addition and update options.
 */
export interface SetSecretOptions {
  alias?: SecretAlias;
  aliases?: SecretAlias[];
  workspaceId?: string;
  allowedMediationModes?: MediationMode[];
  tags?: string[];
  description?: string;
}

/**
 * Core interface for secret storage backends.
 */
export interface SecretStore {
  /**
   * Unique name of the storage backend (e.g. "encrypted-vault", "mac-keychain", "linux-secret-service").
   */
  readonly name: string;

  /**
   * Retrieves and decrypts the plaintext value of a secret by name or alias.
   * Returns null if the secret is not found.
   */
  getSecret(nameOrAlias: string, workspaceId?: string): Promise<string | null>;

  /**
   * Encrypts and stores a named secret with optional metadata.
   */
  setSecret(name: string, value: string, options?: SetSecretOptions): Promise<SecretMetadata>;

  /**
   * Deletes a named secret from the store.
   * Returns true if deleted, false if not found.
   */
  deleteSecret(name: string, workspaceId?: string): Promise<boolean>;

  /**
   * Lists metadata for all stored secrets in the given workspace.
   * Raw secret values are never included in metadata.
   */
  listMetadata(workspaceId?: string): Promise<SecretMetadata[]>;

  /**
   * Retrieves metadata for a specific secret by name or alias.
   */
  getMetadata(nameOrAlias: string, workspaceId?: string): Promise<SecretMetadata | null>;

  /**
   * Checks if a secret exists by name or alias.
   */
  hasSecret(nameOrAlias: string, workspaceId?: string): Promise<boolean>;

  /**
   * Purges all secrets in the store (or all secrets for a specific workspace).
   * Returns the count of purged secrets.
   */
  purgeSecrets(workspaceId?: string): Promise<number>;

  /**
   * Checks if this store backend is available on the current platform/host.
   */
  isAvailable?(): Promise<boolean> | boolean;

  /**
   * Closes any open resources or locks.
   */
  close?(): Promise<void> | void;
}

/**
 * Configuration options for the encrypted vault secret store.
 */
export interface EncryptedVaultOptions {
  /**
   * Path to the encrypted vault file on disk.
   * If omitted or set to ":memory:", vault operates in-memory.
   */
  vaultPath?: string;

  /**
   * Master passphrase used for key derivation.
   * If omitted, attempts to read from RESIN_VAULT_PASSPHRASE or generates a deterministic machine key.
   */
  passphrase?: string;

  /**
   * KDF algorithm to use (default: "pbkdf2").
   */
  kdf?: "pbkdf2" | "scrypt" | "argon2";

  /**
   * Number of KDF iterations (default: 100,000 for PBKDF2).
   */
  kdfIterations?: number;

  /**
   * Timeout in milliseconds to wait for acquiring file locks (default: 5000).
   */
  lockTimeoutMs?: number;
}

/**
 * Configuration options for keychain secret stores.
 */
export interface KeychainOptions {
  /**
   * Service name used in system keychain (default: "resin").
   */
  serviceName?: string;

  /**
   * Fallback secret store to use if system keychain is unavailable.
   */
  fallbackStore?: SecretStore;
}

/**
 * Options for secret redaction.
 */
export interface RedactionOptions {
  /**
   * Replacement string for redacted secrets (default: "[REDACTED_SECRET]").
   */
  maskText?: string;

  /**
   * Whether to redact base64 and hex encoded variants of registered secrets (default: true).
   */
  redactEncodings?: boolean;

  /**
   * Whether to include standard pattern matchers for Bearer tokens, GitHub tokens, AWS keys, etc. (default: true).
   */
  matchStandardPatterns?: boolean;
}

/**
 * Options for SecretManager.
 */
export interface SecretManagerOptions {
  /**
   * Underlying secret store implementation.
   */
  store?: SecretStore;

  /**
   * Secret redactor instance.
   */
  redactor?: SecretRedactor;

  /**
   * Master passphrase for default encrypted vault.
   */
  passphrase?: string;

  /**
   * Path to vault file on disk.
   */
  vaultPath?: string;
}
