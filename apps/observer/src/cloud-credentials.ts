import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { SecretManager } from "@resin/crypto";
import {
  type AuthClaims,
  AuthClaimsSchema,
  type TokenRotationRequest,
  TokenRotationRequestSchema,
  TokenRotationResponseSchema,
} from "@resin/protocol";
import { z } from "zod";
import { resolvePaths } from "./paths.js";

/**
 * Validated schema for persistent cloud device credentials.
 */
export const StoredCloudCredentialsSchema = z.object({
  cloudUrl: z.string().url("cloudUrl must be a valid URL"),
  accessToken: z.string().min(1, "accessToken cannot be empty"),
  refreshToken: z.string().min(1, "refreshToken cannot be empty").optional(),
  claims: AuthClaimsSchema,
  deviceId: z.string().min(1, "deviceId cannot be empty"),
  workspaceId: z.string().min(1, "workspaceId cannot be empty"),
  storedAt: z.string().min(1, "storedAt cannot be empty"),
});

export type StoredCloudCredentials = z.infer<typeof StoredCloudCredentialsSchema>;

export interface PersistCloudCredentialsInput {
  cloudUrl: string;
  accessToken: string;
  refreshToken?: string;
  claims?: AuthClaims;
  deviceId?: string;
  workspaceId?: string;
  storedAt?: string;
}

export type CloudCredentialStatus =
  | "missing"
  | "valid"
  | "expired"
  | "invalid"
  | "offline"
  | "revoked";

export interface CloudCredentialLoadResult {
  status: CloudCredentialStatus;
  credentials?: StoredCloudCredentials;
  reason?: string;
}

export type CloudCredentialRefreshFailure = "unavailable" | "revoked" | "invalid";

export interface CloudRequestIdentity {
  readonly cloudUrl: string;
  readonly accessToken: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly userId: string;
}

export interface CloudCredentialStoreOptions {
  home?: string;
  resinHome?: string;
  tokenFilePath?: string;
  secretManager?: SecretManager;
  fetchImpl?: typeof fetch;
}

/**
 * Validates that an issuing origin uses HTTPS or loopback HTTP.
 */
export function isAllowedOrigin(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.protocol === "https:") {
      return true;
    }
    if (parsed.protocol === "http:") {
      const hostname = parsed.hostname.toLowerCase();
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "[::1]"
      );
    }
    return false;
  } catch {
    return false;
  }
}
function resolveClaimUserId(claims: AuthClaims): string | undefined {
  return claims.userId?.trim() || claims.subject?.trim() || undefined;
}

function requireClaimUserId(claims: AuthClaims): string {
  const userId = resolveClaimUserId(claims);
  if (!userId) {
    throw new Error("Claims must contain a non-empty userId or subject");
  }
  return userId;
}

/**
 * Safely decodes and validates JWT claims without executing external code.
 */
export function parseJwtClaims(token: string): AuthClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT token format: missing payload segment");
  }

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
  } catch (err: unknown) {
    throw new Error(
      `Failed to base64url decode token payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse token payload JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return AuthClaimsSchema.parse(parsed);
}

/**
 * Vault secret keys used for ancillary storage.
 */
export const ANCILLARY_VAULT_KEYS = {
  ACCESS_TOKEN: "cloud_device_access_token",
  REFRESH_TOKEN: "cloud_device_refresh_token",
  ORIGIN: "cloud_device_origin",
} as const;

/**
 * Cross-process credential lock tuning. A lock older than the stale age is treated as
 * abandoned by a dead or hung holder; a caller waits at most the timeout before failing closed.
 */
const CREDENTIAL_LOCK_RETRY_MS = 10;
const CREDENTIAL_LOCK_STALE_MS = 30_000;
const CREDENTIAL_LOCK_TIMEOUT_MS = 45_000;

/**
 * Raised when the cross-process credential lock cannot be acquired within its bounded wait.
 */
class CredentialLockUnavailableError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for the credential lock at ${lockPath}`);
    this.name = "CredentialLockUnavailableError";
  }
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Reports whether a process recorded in the lock file is still running in this namespace.
 * Signal 0 performs an existence check without delivering a signal; ESRCH means no such process.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

/**
 * Canonical owner-only credential boundary shared by CLI and daemon.
 */
export class CloudCredentialStore {
  private readonly tokenFilePath: string;
  private readonly secretManager?: SecretManager;
  private readonly fetchImpl: typeof fetch;
  private refreshPromise: Promise<CloudRequestIdentity | null> | null = null;
  private lastRefreshFailure: CloudCredentialRefreshFailure | null = null;
  private credentialLockDepth = 0;

  constructor(options: CloudCredentialStoreOptions = {}) {
    if (options.tokenFilePath) {
      this.tokenFilePath = path.resolve(options.tokenFilePath);
    } else {
      const paths = resolvePaths({
        home: options.home,
        resinHome: options.resinHome,
      });
      this.tokenFilePath = path.join(paths.stateDir, "device-token.json");
    }

    this.secretManager = options.secretManager;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  getTokenFilePath(): string {
    return this.tokenFilePath;
  }

  getLastRefreshFailure(): CloudCredentialRefreshFailure | null {
    return this.lastRefreshFailure;
  }

  /**
   * Loads and validates stored credentials from the owner-only file.
   */
  async load(): Promise<CloudCredentialLoadResult> {
    let fileContent: string;
    try {
      fileContent = await fs.readFile(this.tokenFilePath, "utf8");
    } catch (err: unknown) {
      // SAFETY: fs.readFile error carries standard NodeJS.ErrnoException code.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" };
      }
      return {
        status: "invalid",
        reason: `Failed to read credential file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(fileContent);
    } catch {
      return {
        status: "invalid",
        reason: "Credential file contains invalid JSON",
      };
    }

    const validationResult = StoredCloudCredentialsSchema.safeParse(parsedRaw);
    if (!validationResult.success) {
      return {
        status: "invalid",
        reason: `Credential schema validation failed: ${validationResult.error.message}`,
      };
    }

    const creds = validationResult.data;

    // Validate origin HTTPS or loopback HTTP
    if (!isAllowedOrigin(creds.cloudUrl)) {
      return {
        status: "invalid",
        reason: "Credential cloudUrl must use HTTPS or loopback HTTP without embedded credentials",
      };
    }

    // Validate claim binding equality
    if (creds.claims.deviceId !== creds.deviceId) {
      return {
        status: "invalid",
        reason: "Claims deviceId does not match top-level deviceId",
      };
    }

    if (creds.claims.workspaceId !== creds.workspaceId) {
      return {
        status: "invalid",
        reason: "Claims workspaceId does not match top-level workspaceId",
      };
    }

    if (!resolveClaimUserId(creds.claims)) {
      return {
        status: "invalid",
        reason: "Claims must contain a non-empty userId or subject",
      };
    }

    if (!creds.claims.accountId || creds.claims.accountId.trim().length === 0) {
      return {
        status: "invalid",
        reason: "Claims must contain a non-empty accountId",
      };
    }

    if (!creds.claims.installationId || creds.claims.installationId.trim().length === 0) {
      return {
        status: "invalid",
        reason: "Claims must contain a non-empty installationId",
      };
    }

    // Check expiration
    const expiresAtMs = new Date(creds.claims.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || Date.now() >= expiresAtMs) {
      return {
        status: "expired",
        credentials: creds,
        reason: "Access token is expired",
      };
    }

    return {
      status: "valid",
      credentials: creds,
    };
  }

  /**
   * Runs `operation` while holding the cross-process credential lock. Nested calls made by the
   * same store instance reuse the held lock, so a rotation can commit its own result atomically.
   */
  private async runWithCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.credentialLockDepth > 0) {
      this.credentialLockDepth += 1;
      try {
        return await operation();
      } finally {
        this.credentialLockDepth -= 1;
      }
    }

    const lockPath = `${this.tokenFilePath}.lock`;
    const owner = randomUUID();
    const deadline = Date.now() + CREDENTIAL_LOCK_TIMEOUT_MS;

    for (;;) {
      let handle: FileHandle | null = null;
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          await fs
            .mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
            .catch(() => undefined);
        } else if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
      }

      if (handle) {
        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
              owner,
            }),
            "utf8",
          );
          await handle.chmod(0o600).catch(() => undefined);
        } catch (error) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        } finally {
          await handle.close().catch(() => undefined);
        }

        this.credentialLockDepth = 1;
        try {
          return await operation();
        } finally {
          this.credentialLockDepth = 0;
          // A holder that overran the stale age may have lost the lock to another process,
          // which owns cleanup from that point on.
          const held = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (held !== null && held.includes(owner)) {
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
          }
        }
      }

      if (await this.takeOverStaleCredentialLock(lockPath)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new CredentialLockUnavailableError(lockPath);
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, CREDENTIAL_LOCK_RETRY_MS);
      await promise;
    }
  }

  /**
   * Removes a lock abandoned by a dead or hung holder, returning whether it was taken over.
   */
  private async takeOverStaleCredentialLock(lockPath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch {
      return false;
    }

    let acquiredAtMs = Number.NaN;
    let holderPid: number | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
      if (typeof parsed.acquiredAt === "string") {
        acquiredAtMs = new Date(parsed.acquiredAt).getTime();
      }
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
        holderPid = parsed.pid;
      }
    } catch {
      // Malformed payload: fall back to the lock file's own age below.
    }
    if (!Number.isFinite(acquiredAtMs)) {
      const stats = await fs.stat(lockPath).catch(() => null);
      if (!stats) {
        return false;
      }
      acquiredAtMs = stats.mtimeMs;
    }

    const ageMs = Date.now() - acquiredAtMs;
    const holderIsDead = holderPid !== undefined && !isProcessAlive(holderPid);
    if (ageMs < CREDENTIAL_LOCK_STALE_MS && !holderIsDead) {
      return false;
    }

    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    return true;
  }

  /**
   * Atomically commits credentials to the owner-only file (mode 0600)
   * and synchronizes ancillary vault secrets.
   */
  async persist(
    input: StoredCloudCredentials | PersistCloudCredentialsInput,
  ): Promise<StoredCloudCredentials> {
    if (!isAllowedOrigin(input.cloudUrl)) {
      throw new Error("Cloud URL must use HTTPS or loopback HTTP without embedded credentials");
    }

    const claims = input.claims ?? parseJwtClaims(input.accessToken);
    const deviceId = input.deviceId ?? claims.deviceId;
    const workspaceId = input.workspaceId ?? claims.workspaceId;

    if (claims.deviceId !== deviceId) {
      throw new Error("DeviceId does not match claims deviceId");
    }
    if (claims.workspaceId !== workspaceId) {
      throw new Error("WorkspaceId does not match claims workspaceId");
    }
    requireClaimUserId(claims);
    if (!claims.accountId || claims.accountId.trim().length === 0) {
      throw new Error("Claims must contain a non-empty accountId");
    }
    if (!claims.installationId || claims.installationId.trim().length === 0) {
      throw new Error("Claims must contain a non-empty installationId");
    }

    const credsToStore: StoredCloudCredentials = {
      cloudUrl: input.cloudUrl,
      accessToken: input.accessToken,
      claims,
      deviceId,
      workspaceId,
      storedAt: input.storedAt ?? new Date().toISOString(),
    };
    if (input.refreshToken) {
      credsToStore.refreshToken = input.refreshToken;
    }

    // Strict schema check before disk write
    StoredCloudCredentialsSchema.parse(credsToStore);

    const tokenDirectory = path.dirname(this.tokenFilePath);
    await fs.mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(tokenDirectory, 0o700);
    } catch {
      // Ignored if chmod fails on some filesystems
    }

    const serialized = JSON.stringify(credsToStore, null, 2);

    // Every write of the credential file happens under the cross-process lock so concurrent
    // stores cannot interleave a rotation with a pairing, rollback, or another rotation.
    await this.runWithCredentialLock(async () => {
      const tempTokenPath = path.join(
        tokenDirectory,
        `.${path.basename(this.tokenFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );

      try {
        await fs.writeFile(tempTokenPath, serialized, { mode: 0o600, encoding: "utf8" });
        try {
          await fs.chmod(tempTokenPath, 0o600);
        } catch {
          // Ignored
        }
        await fs.rename(tempTokenPath, this.tokenFilePath);
        try {
          await fs.chmod(this.tokenFilePath, 0o600);
        } catch {
          // Ignored
        }
      } catch (err) {
        await fs.rm(tempTokenPath, { force: true }).catch(() => undefined);
        throw err;
      }
    });

    // Synchronize ancillary vault secrets if SecretManager available
    if (this.secretManager) {
      try {
        await this.secretManager.addSecret(
          ANCILLARY_VAULT_KEYS.ACCESS_TOKEN,
          credsToStore.accessToken,
          {
            description: "Resin Cloud Device Access Token",
            workspaceId,
          },
        );
        if (credsToStore.refreshToken) {
          await this.secretManager.addSecret(
            ANCILLARY_VAULT_KEYS.REFRESH_TOKEN,
            credsToStore.refreshToken,
            {
              description: "Resin Cloud Device Refresh Token",
              workspaceId,
            },
          );
        }
        await this.secretManager.addSecret(ANCILLARY_VAULT_KEYS.ORIGIN, credsToStore.cloudUrl, {
          description: "Resin Cloud Credential Origin",
          workspaceId,
        });
      } catch {
        // Ancillary store failure must not fail the primary owner-only credential file commit
      }
    }

    this.lastRefreshFailure = null;

    return credsToStore;
  }

  /**
   * Captures an in-memory snapshot of current stored credentials for installer rollback.
   */
  async snapshot(): Promise<StoredCloudCredentials | null> {
    const result = await this.load();
    return result.credentials ?? null;
  }

  /**
   * Restores credentials from a snapshot during rollback without journaling secrets.
   */
  async restore(snapshot: StoredCloudCredentials | null): Promise<void> {
    if (snapshot === null) {
      await this.purge();
    } else {
      await this.persist(snapshot);
    }
  }

  /**
   * Purges credentials from both the owner-only file and ancillary vault.
   */
  async purge(): Promise<{ purgedSecrets: boolean; purgedFile: boolean }> {
    let purgedFile = false;
    try {
      await fs.rm(this.tokenFilePath, { force: true });
      purgedFile = true;
    } catch {
      purgedFile = false;
    }

    let purgedSecrets = false;
    if (this.secretManager) {
      try {
        await this.secretManager.deleteSecret(ANCILLARY_VAULT_KEYS.ACCESS_TOKEN);
        await this.secretManager.deleteSecret(ANCILLARY_VAULT_KEYS.REFRESH_TOKEN);
        await this.secretManager.deleteSecret(ANCILLARY_VAULT_KEYS.ORIGIN);
        purgedSecrets = true;
      } catch {
        purgedSecrets = false;
      }
    }

    return { purgedSecrets, purgedFile };
  }

  private identityFromCredentials(credentials: StoredCloudCredentials): CloudRequestIdentity {
    return {
      cloudUrl: credentials.cloudUrl,
      accessToken: credentials.accessToken,
      accountId: credentials.claims.accountId,
      workspaceId: credentials.claims.workspaceId,
      deviceId: credentials.claims.deviceId,
      installationId: credentials.claims.installationId,
      userId: requireClaimUserId(credentials.claims),
    };
  }

  /**
   * Retrieves active CloudRequestIdentity, refreshing automatically before expiry
   * or when forced. Concurrent refreshes are deduplicated in-process and serialized
   * across processes that share one credential file.
   */
  async getRequestIdentity(
    options: { forceRefresh?: boolean } = {},
  ): Promise<CloudRequestIdentity | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const loadResult = await this.load();
    if (
      loadResult.status === "missing" ||
      loadResult.status === "invalid" ||
      !loadResult.credentials
    ) {
      if (options.forceRefresh) {
        this.lastRefreshFailure = "unavailable";
      }
      return null;
    }

    const credentials = loadResult.credentials;
    const expiresAtMs = new Date(credentials.claims.expiresAt).getTime();
    const isCloseToExpiry = Date.now() >= expiresAtMs - 60_000;
    const needsRefresh = options.forceRefresh || loadResult.status === "expired" || isCloseToExpiry;

    if (!needsRefresh && loadResult.status === "valid") {
      this.lastRefreshFailure = null;
      return this.identityFromCredentials(credentials);
    }

    if (!credentials.refreshToken) {
      if (loadResult.status === "valid" && !options.forceRefresh) {
        this.lastRefreshFailure = null;
        return this.identityFromCredentials(credentials);
      }
      this.lastRefreshFailure = "unavailable";
      return null;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.performTokenRefresh(credentials).finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async performTokenRefresh(
    currentCredentials: StoredCloudCredentials,
  ): Promise<CloudRequestIdentity | null> {
    this.lastRefreshFailure = null;
    if (!currentCredentials.refreshToken) {
      this.lastRefreshFailure = "unavailable";
      return null;
    }

    const intendedRefreshToken = currentCredentials.refreshToken;
    const intendedStoredAt = currentCredentials.storedAt;

    try {
      // Serialize the entire re-read/rotate/persist cycle across processes so exactly one client
      // spends a given refresh token; every other client adopts the credential it persisted.
      return await this.runWithCredentialLock(() =>
        this.rotateRefreshToken(currentCredentials, intendedRefreshToken, intendedStoredAt),
      );
    } catch (error) {
      if (!(error instanceof CredentialLockUnavailableError)) {
        throw error;
      }
      // The lock could not be taken in bounded time, so this process cannot tell whether its
      // refresh token is still current. Never replay it: converge on disk or fail closed.
      return this.adoptOrRetainOnTransientFailure(
        currentCredentials,
        intendedRefreshToken,
        intendedStoredAt,
      );
    }
  }

  /**
   * Rotates the refresh token while holding the credential lock. The lock spans the round trip,
   * so a concurrent client can only proceed after this rotation has been committed to disk.
   */
  private async rotateRefreshToken(
    currentCredentials: StoredCloudCredentials,
    intendedRefreshToken: string,
    intendedStoredAt: string,
  ): Promise<CloudRequestIdentity | null> {
    const alreadyRotated = await this.adoptNewerCredentials(intendedRefreshToken, intendedStoredAt);
    if (alreadyRotated) {
      return alreadyRotated;
    }

    const refreshPayload: TokenRotationRequest = {
      grantType: "refresh_token",
      refreshToken: intendedRefreshToken,
      deviceId: currentCredentials.deviceId,
      installationId: currentCredentials.claims.installationId,
    };
    TokenRotationRequestSchema.parse(refreshPayload);

    const refreshEndpoint = `${currentCredentials.cloudUrl.replace(/\/+$/, "")}/v1/auth/token/refresh`;

    let response: Response;
    try {
      response = await this.fetchImpl(refreshEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": currentCredentials.claims.accountId,
          "x-workspace-id": currentCredentials.claims.workspaceId,
          "x-device-id": currentCredentials.deviceId,
        },
        body: JSON.stringify(refreshPayload),
      });
    } catch {
      return this.adoptOrRetainOnTransientFailure(
        currentCredentials,
        intendedRefreshToken,
        intendedStoredAt,
      );
    }

    if (!response.ok) {
      if (
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429
      ) {
        return this.adoptOrRetainOnTransientFailure(
          currentCredentials,
          intendedRefreshToken,
          intendedStoredAt,
        );
      }

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        // Only the credential that was actually rejected is genuinely revoked; a newer one on
        // disk belongs to another client and must survive this refusal.
        const adopted = await this.adoptNewerCredentials(intendedRefreshToken, intendedStoredAt);
        if (adopted) {
          return adopted;
        }
        this.lastRefreshFailure = "revoked";
        await this.purge();
        return null;
      }

      this.lastRefreshFailure = "invalid";
      return null;
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      this.lastRefreshFailure = "invalid";
      return null;
    }

    const parseResult = TokenRotationResponseSchema.safeParse(responseJson);
    if (!parseResult.success) {
      this.lastRefreshFailure = "invalid";
      return null;
    }

    const rotation = parseResult.data;
    let newClaims: AuthClaims;
    try {
      newClaims = parseJwtClaims(rotation.accessToken);
    } catch {
      this.lastRefreshFailure = "invalid";
      return null;
    }

    const currentUserId = requireClaimUserId(currentCredentials.claims);
    const isMatch =
      newClaims.accountId === currentCredentials.claims.accountId &&
      newClaims.workspaceId === currentCredentials.claims.workspaceId &&
      newClaims.deviceId === currentCredentials.claims.deviceId &&
      newClaims.installationId === currentCredentials.claims.installationId &&
      resolveClaimUserId(newClaims) === currentUserId &&
      rotation.claims.accountId === currentCredentials.claims.accountId &&
      rotation.claims.workspaceId === currentCredentials.claims.workspaceId &&
      rotation.claims.deviceId === currentCredentials.claims.deviceId &&
      rotation.claims.installationId === currentCredentials.claims.installationId &&
      resolveClaimUserId(rotation.claims) === currentUserId;
    if (!isMatch) {
      const adopted = await this.adoptNewerCredentials(intendedRefreshToken, intendedStoredAt);
      if (adopted) {
        return adopted;
      }
      this.lastRefreshFailure = "revoked";
      await this.purge();
      throw new Error("Rotated token claims do not match original tenant/device binding");
    }

    const updatedCredentials: StoredCloudCredentials = {
      cloudUrl: currentCredentials.cloudUrl,
      accessToken: rotation.accessToken,
      refreshToken: rotation.refreshToken ?? currentCredentials.refreshToken,
      claims: newClaims,
      deviceId: currentCredentials.deviceId,
      workspaceId: currentCredentials.workspaceId,
      storedAt: new Date().toISOString(),
    };

    await this.persist(updatedCredentials);
    return this.identityFromCredentials(updatedCredentials);
  }

  /**
   * Returns the identity of a credential newer than the one this call intended to use, so a
   * client converges on a rotation another process already committed instead of replaying or
   * deleting it. Returns null while the credential this call read is still the one on disk.
   */
  private async adoptNewerCredentials(
    intendedRefreshToken: string,
    intendedStoredAt: string,
  ): Promise<CloudRequestIdentity | null> {
    const loadResult = await this.load();
    const persisted = loadResult.credentials;
    if (!persisted) {
      return null;
    }
    if (
      persisted.refreshToken === intendedRefreshToken &&
      persisted.storedAt === intendedStoredAt
    ) {
      return null;
    }
    this.lastRefreshFailure = null;
    return this.identityFromCredentials(persisted);
  }

  /**
   * Transient failure posture: adopt a credential another client rotated, otherwise keep serving
   * the still-valid access token without spending the refresh token a second time.
   */
  private async adoptOrRetainOnTransientFailure(
    currentCredentials: StoredCloudCredentials,
    intendedRefreshToken: string,
    intendedStoredAt: string,
  ): Promise<CloudRequestIdentity | null> {
    const adopted = await this.adoptNewerCredentials(intendedRefreshToken, intendedStoredAt);
    if (adopted) {
      return adopted;
    }
    this.lastRefreshFailure = "unavailable";
    const expiresAtMs = new Date(currentCredentials.claims.expiresAt).getTime();
    return Date.now() < expiresAtMs ? this.identityFromCredentials(currentCredentials) : null;
  }
}
