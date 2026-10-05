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
import { reportEvent } from "./error-reporting/facade.js";
import { resolvePaths } from "./paths.js";
import { ensurePrivateDirectory } from "./private-fs.js";

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
  /** The running Resin release, reported on every token refresh. Ignored when not a version. */
  clientVersion?: string;
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
 * Cross-process credential lock tuning.
 *
 * A holder rewrites the lock file's mtime (its heartbeat) every HEARTBEAT interval while it holds
 * the lock. A waiter takes the lock over only when the holder is provably gone: its pid is dead
 * on this host, or its heartbeat is older than the stale age (a hung, frozen or remote holder
 * whose pid cannot be probed). A live, heartbeating holder keeps the lock however slow its
 * refresh round trip is, because taking it over would replay the refresh token it is spending.
 *
 * MAX_HOLD bounds a holder that keeps heartbeating but never finishes (a wedged operation in a
 * live event loop). A holder's critical section is a refresh request capped by
 * TOKEN_REFRESH_TIMEOUT_MS plus local file I/O, so a holder past MAX_HOLD is not making progress
 * and taking over cannot race a request that is still in flight.
 *
 * A waiter gives up after TIMEOUT and never spends its token without the lock (see
 * `performTokenRefresh`).
 */
const CREDENTIAL_LOCK_RETRY_MS = 10;
const CREDENTIAL_LOCK_HEARTBEAT_MS = 5_000;
const CREDENTIAL_LOCK_STALE_MS = 30_000;
const CREDENTIAL_LOCK_MAX_HOLD_MS = 120_000;
const CREDENTIAL_LOCK_TIMEOUT_MS = 45_000;
/** Upper bound on one refresh round trip made while holding the credential lock. */
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
/** Access tokens this close to expiry are refreshed rather than served or adopted. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
/**
 * The cloud's answer when this device's sibling process rotated the presented refresh token
 * moments ago. Unlike reuse detection it revokes nothing: the successor is still live.
 */
const ALREADY_ROTATED_DESCRIPTION = "Refresh token was already rotated";

const RefreshErrorBodySchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

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
  private readonly clientVersion?: string;
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
    // An unparseable version is dropped rather than failing every refresh's payload validation.
    this.clientVersion = TokenRotationRequestSchema.shape.clientVersion.safeParse(
      options.clientVersion,
    ).data;
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
          await ensurePrivateDirectory(path.dirname(lockPath)).catch(() => undefined);
        } else if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
      }

      if (handle) {
        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              hostname: os.hostname(),
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

        // The heartbeat proves to waiters that this holder is alive and still working, so a
        // slow refresh round trip is never mistaken for an abandoned lock.
        const heartbeat = setInterval(() => {
          void this.touchCredentialLock(lockPath, owner);
        }, CREDENTIAL_LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        this.credentialLockDepth = 1;
        try {
          return await operation();
        } finally {
          clearInterval(heartbeat);
          this.credentialLockDepth = 0;
          // A holder that stopped heartbeating or overran the hold cap may have lost the lock
          // to another process, which owns cleanup from that point on.
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
   * Refreshes the heartbeat (mtime) of a lock this holder still owns. A lock already taken over
   * belongs to its new holder and is left alone.
   */
  private async touchCredentialLock(lockPath: string, owner: string): Promise<void> {
    const held = await fs.readFile(lockPath, "utf8").catch(() => null);
    if (held === null || !held.includes(owner)) {
      return;
    }
    const now = new Date();
    await fs.utimes(lockPath, now, now).catch(() => undefined);
  }

  /**
   * Removes a lock whose holder is provably gone, returning whether it was taken over. See the
   * lock tuning constants for the policy.
   */
  private async takeOverStaleCredentialLock(lockPath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch {
      return false;
    }
    const stats = await fs.stat(lockPath).catch(() => null);
    if (!stats) {
      return false;
    }

    let acquiredAtMs = Number.NaN;
    let holderPid: number | undefined;
    let holderHostname: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; hostname?: unknown; acquiredAt?: unknown };
      if (typeof parsed.acquiredAt === "string") {
        acquiredAtMs = new Date(parsed.acquiredAt).getTime();
      }
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
        holderPid = parsed.pid;
      }
      if (typeof parsed.hostname === "string") {
        holderHostname = parsed.hostname;
      }
    } catch {
      // Malformed payload: only the heartbeat (the lock file's mtime) can be judged.
    }

    const now = Date.now();
    const heartbeatAgeMs = now - stats.mtimeMs;
    const holdAgeMs = Number.isFinite(acquiredAtMs) ? now - acquiredAtMs : heartbeatAgeMs;
    // A pid only identifies a process on the host that wrote it. Locks from releases before the
    // heartbeat carry no hostname; they were written by a client on this machine.
    const holderOnThisHost = holderHostname === undefined || holderHostname === os.hostname();
    const holderIsDead = holderOnThisHost && holderPid !== undefined && !isProcessAlive(holderPid);
    if (
      !holderIsDead &&
      heartbeatAgeMs < CREDENTIAL_LOCK_STALE_MS &&
      holdAgeMs < CREDENTIAL_LOCK_MAX_HOLD_MS
    ) {
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
    // Windows: an owner-only directory DACL, inherited by the temporary token file and kept
    // across the rename below.
    await ensurePrivateDirectory(tokenDirectory);
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
    const needsRefresh =
      options.forceRefresh || loadResult.status === "expired" || isDueForRefresh(credentials);

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
    readCredentials: StoredCloudCredentials,
  ): Promise<CloudRequestIdentity | null> {
    this.lastRefreshFailure = null;
    try {
      // Serialize the entire re-read/rotate/persist cycle across processes so exactly one client
      // spends a given refresh token; every other client adopts the credential it persisted.
      return await this.runWithCredentialLock(() => this.refreshUnderLock(readCredentials));
    } catch (error) {
      if (!(error instanceof CredentialLockUnavailableError)) {
        throw error;
      }
      // The lock could not be taken in bounded time, so this process cannot tell whether its
      // refresh token is still current. Never replay it: converge on disk or fail closed.
      return this.adoptOrRetainOnTransientFailure(readCredentials);
    }
  }

  /**
   * Decides, from the credential on disk while holding the lock, whether a refresh is still
   * needed. The copy this process read before waiting for the lock may already have been spent
   * by a sibling (daemon, CLI, gateway), so only the on-disk refresh token is ever sent.
   */
  private async refreshUnderLock(
    readCredentials: StoredCloudCredentials,
  ): Promise<CloudRequestIdentity | null> {
    const persisted = (await this.load()).credentials;
    if (!persisted) {
      // Logged out (or corrupted) while this refresh waited: never resurrect a credential.
      this.lastRefreshFailure = "unavailable";
      return null;
    }
    if (!isSameCredential(persisted, readCredentials) && !isDueForRefresh(persisted)) {
      // A sibling already rotated and its access token is good: adopt it without refreshing.
      this.lastRefreshFailure = null;
      return this.identityFromCredentials(persisted);
    }
    return this.rotateRefreshToken(persisted, true);
  }

  /**
   * Spends `credentials.refreshToken`, which must be the token on disk under the held lock. The
   * lock spans the round trip, so a concurrent client can only proceed after this rotation has
   * been committed to disk. `retryAlreadyRotated` permits one retry with the on-disk successor
   * after the cloud reports that a sibling already rotated the token sent.
   */
  private async rotateRefreshToken(
    credentials: StoredCloudCredentials,
    retryAlreadyRotated: boolean,
  ): Promise<CloudRequestIdentity | null> {
    if (!credentials.refreshToken) {
      this.lastRefreshFailure = "unavailable";
      const expiresAtMs = new Date(credentials.claims.expiresAt).getTime();
      return Date.now() < expiresAtMs ? this.identityFromCredentials(credentials) : null;
    }

    const refreshPayload: TokenRotationRequest = {
      grantType: "refresh_token",
      refreshToken: credentials.refreshToken,
      deviceId: credentials.deviceId,
      installationId: credentials.claims.installationId,
      ...(this.clientVersion ? { clientVersion: this.clientVersion } : {}),
    };
    TokenRotationRequestSchema.parse(refreshPayload);

    const refreshEndpoint = `${credentials.cloudUrl.replace(/\/+$/, "")}/v1/auth/token/refresh`;

    let response: Response;
    try {
      response = await this.fetchImpl(refreshEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-account-id": credentials.claims.accountId,
          "x-workspace-id": credentials.claims.workspaceId,
          "x-device-id": credentials.deviceId,
        },
        body: JSON.stringify(refreshPayload),
        // Bounds how long this holder keeps the credential lock (see CREDENTIAL_LOCK_MAX_HOLD_MS).
        signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
      });
    } catch {
      return this.adoptOrRetainOnTransientFailure(credentials);
    }

    if (!response.ok) {
      if (
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429
      ) {
        return this.adoptOrRetainOnTransientFailure(credentials);
      }

      if (response.status === 400) {
        const refusal = RefreshErrorBodySchema.safeParse(await response.json().catch(() => null));
        if (
          refusal.success &&
          refusal.data.error === "invalid_grant" &&
          refusal.data.error_description === ALREADY_ROTATED_DESCRIPTION
        ) {
          return this.recoverAlreadyRotated(credentials, retryAlreadyRotated);
        }
      }

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        // Only the credential that was actually rejected is genuinely revoked; a newer one on
        // disk belongs to another client and must survive this refusal.
        const adopted = await this.adoptNewerCredentials(credentials);
        if (adopted) {
          return adopted;
        }
        this.lastRefreshFailure = "revoked";
        reportEvent("credential_refresh_failed", {
          reason: "revoked",
          http_status: response.status,
        });
        await this.purge();
        return null;
      }

      this.lastRefreshFailure = "invalid";
      reportEvent("credential_refresh_failed", { reason: "invalid", http_status: response.status });
      return null;
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      this.lastRefreshFailure = "invalid";
      reportEvent("credential_refresh_failed", { reason: "invalid_response" });
      return null;
    }

    const parseResult = TokenRotationResponseSchema.safeParse(responseJson);
    if (!parseResult.success) {
      this.lastRefreshFailure = "invalid";
      reportEvent("credential_refresh_failed", { reason: "invalid_response" });
      return null;
    }

    const rotation = parseResult.data;
    let newClaims: AuthClaims;
    try {
      newClaims = parseJwtClaims(rotation.accessToken);
    } catch {
      this.lastRefreshFailure = "invalid";
      reportEvent("credential_refresh_failed", { reason: "invalid_token" });
      return null;
    }

    const currentUserId = requireClaimUserId(credentials.claims);
    const isMatch =
      newClaims.accountId === credentials.claims.accountId &&
      newClaims.workspaceId === credentials.claims.workspaceId &&
      newClaims.deviceId === credentials.claims.deviceId &&
      newClaims.installationId === credentials.claims.installationId &&
      resolveClaimUserId(newClaims) === currentUserId &&
      rotation.claims.accountId === credentials.claims.accountId &&
      rotation.claims.workspaceId === credentials.claims.workspaceId &&
      rotation.claims.deviceId === credentials.claims.deviceId &&
      rotation.claims.installationId === credentials.claims.installationId &&
      resolveClaimUserId(rotation.claims) === currentUserId;
    if (!isMatch) {
      const adopted = await this.adoptNewerCredentials(credentials);
      if (adopted) {
        return adopted;
      }
      this.lastRefreshFailure = "revoked";
      reportEvent("credential_refresh_failed", { reason: "binding_mismatch" });
      await this.purge();
      throw new Error("Rotated token claims do not match original tenant/device binding");
    }

    const updatedCredentials: StoredCloudCredentials = {
      cloudUrl: credentials.cloudUrl,
      accessToken: rotation.accessToken,
      refreshToken: rotation.refreshToken ?? credentials.refreshToken,
      claims: newClaims,
      deviceId: credentials.deviceId,
      workspaceId: credentials.workspaceId,
      storedAt: new Date().toISOString(),
    };

    await this.persist(updatedCredentials);
    return this.identityFromCredentials(updatedCredentials);
  }

  /**
   * The cloud refused `spent` because this device's sibling rotated it moments ago; the token
   * family is intact, so the credential is never purged here. Converge on the successor the
   * sibling committed: adopt it while its access token is good, or spend it once. When no
   * successor is visible (the sibling's response was lost), keep serving the still-valid access
   * token and report the refresh unavailable.
   */
  private async recoverAlreadyRotated(
    spent: StoredCloudCredentials,
    retry: boolean,
  ): Promise<CloudRequestIdentity | null> {
    const persisted = (await this.load()).credentials;
    if (persisted && !isSameCredential(persisted, spent)) {
      if (!isDueForRefresh(persisted)) {
        this.lastRefreshFailure = null;
        return this.identityFromCredentials(persisted);
      }
      if (retry) {
        return this.rotateRefreshToken(persisted, false);
      }
    }
    reportEvent("credential_refresh_failed", { reason: "already_rotated", http_status: 400 });
    return this.adoptOrRetainOnTransientFailure(spent);
  }

  /**
   * Returns the identity of a credential newer than `spent`, so a client converges on a rotation
   * another process already committed instead of replaying or deleting it. Returns null while
   * `spent` is still the credential on disk.
   */
  private async adoptNewerCredentials(
    spent: StoredCloudCredentials,
  ): Promise<CloudRequestIdentity | null> {
    const persisted = (await this.load()).credentials;
    if (!persisted || isSameCredential(persisted, spent)) {
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
    credentials: StoredCloudCredentials,
  ): Promise<CloudRequestIdentity | null> {
    const adopted = await this.adoptNewerCredentials(credentials);
    if (adopted) {
      return adopted;
    }
    this.lastRefreshFailure = "unavailable";
    const expiresAtMs = new Date(credentials.claims.expiresAt).getTime();
    return Date.now() < expiresAtMs ? this.identityFromCredentials(credentials) : null;
  }
}

/** Whether two reads of device-token.json are the same committed credential. */
function isSameCredential(a: StoredCloudCredentials, b: StoredCloudCredentials): boolean {
  return a.refreshToken === b.refreshToken && a.storedAt === b.storedAt;
}

/** Whether a credential's access token is expired or within the proactive refresh margin. */
function isDueForRefresh(credentials: StoredCloudCredentials): boolean {
  const expiresAtMs = new Date(credentials.claims.expiresAt).getTime();
  return Number.isNaN(expiresAtMs) || Date.now() >= expiresAtMs - ACCESS_TOKEN_REFRESH_MARGIN_MS;
}
