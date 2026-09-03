import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";
import { SecretManager } from "@resin/crypto";
import {
  type CloudCredentialLoadResult,
  type CloudCredentialStatus,
  CloudCredentialStore,
  type CloudCredentialStoreOptions,
  type CloudRequestIdentity,
  type PersistCloudCredentialsInput,
  type StoredCloudCredentials,
} from "@resin/observer";
import {
  type AuthClaims,
  type AuthScope,
  type DeviceAuthBootstrapRequest,
  DeviceAuthBootstrapRequestSchema,
  type DeviceAuthBootstrapResponse,
  DeviceAuthBootstrapResponseSchema,
  type DeviceTokenExchangeRequest,
  DeviceTokenExchangeRequestSchema,
  type DeviceTokenExchangeResponse,
  DeviceTokenExchangeResponseSchema,
  areClaimsExpired,
} from "@resin/protocol";
import { z } from "zod";

export {
  type CloudCredentialLoadResult,
  type CloudCredentialStatus,
  type CloudCredentialStoreOptions,
  type CloudRequestIdentity,
  type PersistCloudCredentialsInput,
  type StoredCloudCredentials,
  type StoredCloudCredentials as StoredDeviceCredentials,
  CloudCredentialStore,
};

export const DEFAULT_CLOUD_URL = "https://api.resin.sh";
export const DEFAULT_DEVICE_AUTH_SCOPES = Object.freeze([
  "device:connect",
  "observations:write",
  "catalog:read",
  "artifacts:read",
  "deployments:read",
  "telemetry:write",
  "privacy:read",
  "privacy:write",
  "control:read",
  "control:write",
  "control:report",
] satisfies Exclude<AuthScope, "privacy:delete">[]);

/**
 * Validates and normalizes a Cloud URL.
 * Only HTTPS or loopback HTTP origins without credentials, query parameters, or fragments are permitted.
 */
export function validateCloudUrl(value: string): string {
  if (!value || String(value) !== value) {
    throw new Error("Cloud URL must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Cloud URL format: ${value}`);
  }

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`Cloud URL must use HTTPS: ${value}`);
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud URL must not include credentials, a query, or a fragment");
  }

  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/**
 * Checks if a stored credential record is unexpired, contains valid non-empty
 * account/workspace/device/subject claims, has every ordinary pairing scope
 * without the one-time privacy deletion scope, and matches the expected cloud
 * origin.
 */
export function isReusableCredentialRecord(
  creds: StoredCloudCredentials | null | undefined,
  expectedCloudUrl?: string,
): creds is StoredCloudCredentials {
  if (!creds || !creds.accessToken || !creds.claims) {
    return false;
  }
  if (areClaimsExpired(creds.claims)) {
    return false;
  }
  const accountId = creds.claims.accountId?.trim();
  const workspaceId = (creds.workspaceId ?? creds.claims.workspaceId)?.trim();
  const deviceId = (creds.deviceId ?? creds.claims.deviceId)?.trim();
  const subject = (creds.claims.subject ?? creds.claims.userId)?.trim();

  if (!accountId || !workspaceId || !deviceId || !subject) {
    return false;
  }

  const scopes = creds.claims.scopes;
  if (!Array.isArray(scopes) || scopes.includes("privacy:delete")) {
    return false;
  }
  for (const requiredScope of DEFAULT_DEVICE_AUTH_SCOPES) {
    if (!scopes.includes(requiredScope)) {
      return false;
    }
  }

  if (!creds.cloudUrl) {
    return false;
  }
  try {
    const origin = validateCloudUrl(creds.cloudUrl);
    if (expectedCloudUrl) {
      const expected = validateCloudUrl(expectedCloudUrl);
      if (origin !== expected) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

export interface DeviceAuthClientOptions {
  cloudUrl?: string;
  customFetch?: typeof fetch;
  secretManager?: SecretManager;
  tokenFilePath?: string;
  vaultPath?: string;
  passphrase?: string;
  home?: string;
  resinHome?: string;
  store?: CloudCredentialStore;
}

export interface DeviceAuthRequestParams {
  deviceId?: string;
  installationId?: string;
  hostname?: string;
  platform?: "darwin" | "linux" | "win32" | "other";
  arch?: "arm64" | "x64" | "arm" | "ia32" | "other";
  scopes?: AuthScope[];
  requestedScopes?: AuthScope[];
  workspaceId?: string;
  clientVersion?: string;
}

export interface DeviceAuthBootstrapOptions extends DeviceAuthRequestParams {
  interactive?: boolean;
  onUserCodeReceived?: (info: {
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
  }) => void | Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface DeviceAuthBootstrapResult {
  success: boolean;
  deviceId: string;
  workspaceId: string;
  accessToken: string;
  refreshToken?: string;
  claims: AuthClaims;
  storedInSecretStore: boolean;
  tokenFilePath?: string;
  reused?: boolean;
  error?: string;
}
export interface OneTimeDeviceAuthorizationOptions
  extends Omit<DeviceAuthBootstrapOptions, "interactive" | "requestedScopes" | "scopes"> {
  scopes: AuthScope[];
}

export interface OneTimeDeviceAuthorization {
  accessToken: string;
  tokenType: DeviceTokenExchangeResponse["tokenType"];
  expiresIn: number;
  claims: AuthClaims;
  deviceId: string;
  installationId: string;
  revoke: () => Promise<boolean>;
}

export class DeviceAuthClient {
  private readonly cloudUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly store: CloudCredentialStore;
  private readonly tokenFilePath?: string;

  constructor(options: DeviceAuthClientOptions = {}) {
    this.cloudUrl = validateCloudUrl(
      options.cloudUrl ?? process.env.RESIN_CLOUD_URL ?? DEFAULT_CLOUD_URL,
    );
    this.fetchImpl = options.customFetch ?? globalThis.fetch;
    this.tokenFilePath = options.tokenFilePath;

    if (options.store) {
      this.store = options.store;
    } else {
      const secretManager =
        options.secretManager ??
        (options.vaultPath || options.passphrase
          ? new SecretManager({
              vaultPath: options.vaultPath,
              passphrase: options.passphrase ?? "resin-device-vault-key",
            })
          : undefined);

      this.store = new CloudCredentialStore({
        secretManager,
        tokenFilePath: options.tokenFilePath,
        home: options.home,
        resinHome: options.resinHome,
      });
    }
  }

  async requestDeviceCode(
    params: DeviceAuthRequestParams = {},
  ): Promise<DeviceAuthBootstrapResponse> {
    const deviceId =
      params.deviceId ??
      `dev_${(os.hostname() || "localhost").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const installationId = params.installationId ?? `inst_${deviceId}`;
    const hostname = (params.hostname ?? os.hostname()).slice(0, 255) || "localhost";
    const rawPlatform = params.platform ?? process.platform;
    const platform: "darwin" | "linux" | "win32" | "other" =
      rawPlatform === "darwin" || rawPlatform === "linux" || rawPlatform === "win32"
        ? rawPlatform
        : "other";

    const rawArch = params.arch ?? process.arch;
    const arch: "arm64" | "x64" | "arm" | "ia32" | "other" =
      rawArch === "arm64" || rawArch === "x64" || rawArch === "arm" || rawArch === "ia32"
        ? rawArch
        : "other";

    const clientVersion = params.clientVersion ?? "1.0.0";
    const scopes = params.scopes ?? params.requestedScopes ?? [...DEFAULT_DEVICE_AUTH_SCOPES];

    const requestPayload: DeviceAuthBootstrapRequest = {
      deviceId,
      installationId,
      hostname,
      platform,
      arch,
      clientVersion,
      scopes,
    };

    DeviceAuthBootstrapRequestSchema.parse(requestPayload);

    const endpoint = `${this.cloudUrl}/v1/auth/device/code`;
    const res = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!res.ok) {
      let errorText: string | undefined;
      try {
        const rawJson: unknown = await res.json();
        const parsed = z
          .object({
            error_description: z.string().optional(),
            error: z.string().optional(),
            message: z.string().optional(),
          })
          .safeParse(rawJson);
        if (parsed.success) {
          errorText =
            (parsed.data.error_description && parsed.data.error_description.length > 0
              ? parsed.data.error_description
              : undefined) ??
            (parsed.data.error && parsed.data.error.length > 0 ? parsed.data.error : undefined) ??
            (parsed.data.message && parsed.data.message.length > 0
              ? parsed.data.message
              : undefined);
        }
      } catch {
        // ignore
      }
      if (!errorText && "text" in res && res.text instanceof Function) {
        try {
          const text = await res.text();
          if (text.length > 0) {
            errorText = text;
          }
        } catch {
          // ignore
        }
      }
      const desc = errorText || res.statusText || String(res.status);
      throw new Error(`Device code request failed (${res.status}): ${desc}`);
    }

    const raw: unknown = await res.json();
    return DeviceAuthBootstrapResponseSchema.parse(raw);
  }

  async pollTokenExchange(params: {
    deviceCode: string;
    deviceId: string;
    installationId?: string;
    interval?: number;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<DeviceTokenExchangeResponse> {
    const intervalMs = Math.max(1000, (params.interval ?? 5) * 1000);
    const timeoutMs = params.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    let currentInterval = intervalMs;

    const requestPayload: DeviceTokenExchangeRequest = {
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: params.deviceCode,
      deviceId: params.deviceId,
      installationId: params.installationId ?? `inst_${params.deviceId}`,
    };
    DeviceTokenExchangeRequestSchema.parse(requestPayload);

    const endpoint = `${this.cloudUrl}/v1/auth/device/token`;

    while (Date.now() < deadline) {
      if (params.abortSignal?.aborted) {
        throw new Error("Device authorization was cancelled");
      }

      const waitMs = Math.min(currentInterval, Math.max(0, deadline - Date.now()));
      await new Promise<void>((resolve, reject) => {
        const signal = params.abortSignal;
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("Device authorization was cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });

      if (Date.now() >= deadline) {
        break;
      }

      let res: Response;
      try {
        res = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: params.abortSignal,
        });
      } catch (err: unknown) {
        if (params.abortSignal?.aborted) {
          throw new Error("Device authorization was cancelled");
        }
        throw err;
      }

      if (!res.ok) {
        const AuthDeviceErrorSchema = z.object({
          error: z.string().optional(),
          error_description: z.string().optional(),
          interval: z.number().optional(),
          message: z.string().optional(),
        });
        type AuthDeviceError = z.infer<typeof AuthDeviceErrorSchema>;
        let errBody: AuthDeviceError = {};
        try {
          const rawErr = await res.json();
          const parsedErr = AuthDeviceErrorSchema.safeParse(rawErr);
          if (parsedErr.success) {
            errBody = parsedErr.data;
          }
        } catch {
          // Continue to fallback
        }

        const errorCode = errBody.error;

        if (errorCode === "authorization_pending") {
          if (Number.isFinite(errBody.interval) && Number(errBody.interval) > 0) {
            currentInterval = Number(errBody.interval) * 1000;
          }
          continue;
        }

        if (errorCode === "slow_down") {
          currentInterval += 5000;
          continue;
        }

        if (errorCode === "access_denied") {
          throw new Error("Device authorization was denied by user");
        }

        if (errorCode === "expired_token") {
          throw new Error("Device code has expired. Please restart the login process.");
        }

        let text = "";
        try {
          if ("text" in res && res.text instanceof Function) {
            text = await res.text();
          }
        } catch {
          // ignore
        }
        const desc =
          errBody.error_description ||
          errBody.message ||
          errorCode ||
          text ||
          res.statusText ||
          "unknown error";
        throw new Error(`Device token exchange failed: ${desc}`);
      }

      const raw: unknown = await res.json();
      const tokenResponse = DeviceTokenExchangeResponseSchema.parse(raw);
      if (
        tokenResponse.claims.deviceId !== requestPayload.deviceId ||
        tokenResponse.claims.installationId !== requestPayload.installationId
      ) {
        throw new Error("Token exchange response contains mismatched device binding claims");
      }
      return tokenResponse;
    }

    throw new Error("Device authorization timed out waiting for user approval");
  }
  async authorizeOnce(
    options: OneTimeDeviceAuthorizationOptions,
  ): Promise<OneTimeDeviceAuthorization> {
    if (options.scopes.length === 0) {
      throw new Error("One-time device authorization requires at least one explicit scope");
    }

    const deviceId = options.deviceId ?? `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const installationId = options.installationId ?? `inst_${deviceId}`;
    const authorization = await this.requestDeviceCode({
      deviceId,
      installationId,
      hostname: options.hostname,
      platform: options.platform,
      arch: options.arch,
      scopes: options.scopes,
      workspaceId: options.workspaceId,
      clientVersion: options.clientVersion,
    });

    await options.onUserCodeReceived?.({
      userCode: authorization.userCode,
      deviceCode: authorization.deviceCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresIn: authorization.expiresIn,
    });

    const token = await this.pollTokenExchange({
      deviceCode: authorization.deviceCode,
      deviceId,
      installationId,
      interval: options.pollIntervalMs ? options.pollIntervalMs / 1000 : authorization.interval,
      timeoutMs: options.timeoutMs ?? authorization.expiresIn * 1000,
      abortSignal: options.abortSignal,
    });
    const refreshToken = token.refreshToken;
    let revocation: Promise<boolean> | undefined;

    return {
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      expiresIn: token.expiresIn,
      claims: token.claims,
      deviceId,
      installationId,
      revoke: () => {
        if (!refreshToken) return Promise.resolve(false);
        revocation ??= (async () => {
          try {
            const response = await this.fetchImpl(`${this.cloudUrl}/v1/auth/logout`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refreshToken }),
            });
            return response.ok;
          } catch {
            return false;
          }
        })();
        return revocation;
      },
    };
  }

  async bootstrap(options: DeviceAuthBootstrapOptions = {}): Promise<DeviceAuthBootstrapResult> {
    const deviceId = options.deviceId ?? `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const installationId = options.installationId ?? `inst_${deviceId}`;
    const fallbackWorkspaceId = options.workspaceId ?? "ws_default";

    try {
      const bootstrapResponse = await this.requestDeviceCode({
        deviceId,
        installationId,
        hostname: options.hostname,
        platform: options.platform,
        arch: options.arch,
        scopes: options.scopes,
        requestedScopes: options.requestedScopes,
        workspaceId: options.workspaceId,
        clientVersion: options.clientVersion,
      });

      if (options.onUserCodeReceived) {
        await options.onUserCodeReceived({
          userCode: bootstrapResponse.userCode,
          deviceCode: bootstrapResponse.deviceCode,
          verificationUri: bootstrapResponse.verificationUri,
          verificationUriComplete: bootstrapResponse.verificationUriComplete,
          expiresIn: bootstrapResponse.expiresIn,
        });
      }

      const tokenResponse = await this.pollTokenExchange({
        deviceCode: bootstrapResponse.deviceCode,
        deviceId,
        installationId,
        interval: options.pollIntervalMs
          ? options.pollIntervalMs / 1000
          : bootstrapResponse.interval,
        timeoutMs: options.timeoutMs ?? bootstrapResponse.expiresIn * 1000,
        abortSignal: options.abortSignal,
      });

      const workspaceId = tokenResponse.claims.workspaceId;
      const storageResult = await this.storeCredentials(tokenResponse, deviceId, workspaceId);
      if (!storageResult.tokenFilePath) {
        throw new Error("Device credentials could not be persisted to owner-only storage");
      }

      return {
        success: true,
        deviceId,
        workspaceId,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        claims: tokenResponse.claims,
        storedInSecretStore: storageResult.storedInSecretStore,
        tokenFilePath: storageResult.tokenFilePath,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        deviceId,
        workspaceId: fallbackWorkspaceId,
        accessToken: "",
        claims: {
          accountId: "acc_default",
          deviceId,
          installationId,
          workspaceId: fallbackWorkspaceId,
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          tokenType: "access",
        },
        storedInSecretStore: false,
        error: msg,
      };
    }
  }

  async loadCredentials(): Promise<StoredCloudCredentials | null> {
    const result = await this.store.load();
    return result.credentials ?? null;
  }

  async loadCredentialResult(): Promise<CloudCredentialLoadResult> {
    return this.store.load();
  }
  async storeCredentials(
    tokenResponse: DeviceTokenExchangeResponse,
    deviceId: string,
    workspaceId: string,
  ): Promise<{ tokenFilePath?: string; storedInSecretStore: boolean }> {
    try {
      await this.store.persist({
        cloudUrl: this.cloudUrl,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        claims: tokenResponse.claims,
        deviceId,
        workspaceId,
      });

      return {
        tokenFilePath: this.store.getTokenFilePath(),
        storedInSecretStore: true,
      };
    } catch {
      return { storedInSecretStore: false };
    }
  }

  async snapshotCredentials(): Promise<StoredCloudCredentials | null> {
    return this.store.snapshot();
  }

  async restoreCredentials(snapshot: StoredCloudCredentials | null): Promise<void> {
    return this.store.restore(snapshot);
  }

  async purgeCredentials(): Promise<{ purgedSecrets: boolean; purgedFile: boolean }> {
    return this.store.purge();
  }

  async revokeToken(
    credsOrToken?:
      | StoredCloudCredentials
      | {
          accessToken: string;
          refreshToken?: string;
          claims?: {
            familyId?: string;
            accountId?: string;
            workspaceId?: string;
            deviceId?: string;
          };
          cloudUrl?: string;
          deviceId?: string;
        }
      | string,
  ): Promise<boolean> {
    try {
      let tokenToRevoke = "";
      let refreshToken: string | undefined;
      let familyId: string | undefined;
      let targetCloudUrl = this.cloudUrl;
      let accountId: string | undefined;
      let workspaceId: string | undefined;
      let deviceId: string | undefined;

      const stringParse = z.string().safeParse(credsOrToken);
      const RevokeCredentialsSchema = z.object({
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        claims: z
          .object({
            familyId: z.string().optional(),
            accountId: z.string().optional(),
            workspaceId: z.string().optional(),
            deviceId: z.string().optional(),
          })
          .passthrough()
          .optional(),
        cloudUrl: z.string().optional(),
        deviceId: z.string().optional(),
      });
      const credsParse = RevokeCredentialsSchema.safeParse(credsOrToken);

      if (stringParse.success) {
        tokenToRevoke = stringParse.data;
      } else if (credsParse.success) {
        tokenToRevoke = credsParse.data.accessToken;
        refreshToken = credsParse.data.refreshToken;
        familyId = credsParse.data.claims?.familyId;
        accountId = credsParse.data.claims?.accountId;
        workspaceId = credsParse.data.claims?.workspaceId;
        deviceId = credsParse.data.claims?.deviceId ?? credsParse.data.deviceId;
        if (credsParse.data.cloudUrl) {
          try {
            targetCloudUrl = validateCloudUrl(credsParse.data.cloudUrl);
          } catch {
            targetCloudUrl = this.cloudUrl;
          }
        }
      } else {
        const stored = await this.loadCredentials();
        if (stored) {
          tokenToRevoke = stored.accessToken;
          refreshToken = stored.refreshToken;
          familyId = stored.claims?.familyId;
          accountId = stored.claims?.accountId;
          workspaceId = stored.claims?.workspaceId;
          deviceId = stored.claims?.deviceId ?? stored.deviceId;
          if (stored.cloudUrl) {
            try {
              targetCloudUrl = validateCloudUrl(stored.cloudUrl);
            } catch {
              targetCloudUrl = this.cloudUrl;
            }
          }
        }
      }

      if (!tokenToRevoke && !refreshToken && !familyId) {
        return false;
      }

      const endpoint = `${targetCloudUrl}/v1/auth/logout`;
      const headers = {
        "Content-Type": "application/json",
      };
      if (tokenToRevoke) {
        // SAFETY: Attaching Bearer auth token header on logout request.
        Object.assign(headers, { Authorization: `Bearer ${tokenToRevoke}` });
      }
      if (accountId) {
        // SAFETY: Attaching account ID header on logout request.
        Object.assign(headers, { "x-resin-account-id": accountId });
      }
      if (workspaceId) {
        // SAFETY: Attaching workspace ID header on logout request.
        Object.assign(headers, { "x-resin-workspace-id": workspaceId });
      }
      if (deviceId) {
        // SAFETY: Attaching device ID header on logout request.
        Object.assign(headers, { "x-resin-device-id": deviceId });
      }

      const bodyPayload = refreshToken
        ? { refreshToken }
        : familyId
          ? { familyId }
          : { token: tokenToRevoke };

      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
