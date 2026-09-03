import { createHash } from "node:crypto";
import { ProtocolError, type ProtocolErrorCode } from "@resin/protocol";
import { z } from "zod";
import type { CloudCredentialRefreshFailure, CloudRequestIdentity } from "./cloud-credentials.js";
import type { JsonObject, JsonValue } from "./normalization/redaction.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);
export type AuthRecoveryStatus =
  | "AUTHENTICATED"
  | "REFRESHING"
  | "DEGRADED_OFFLINE"
  | "UNAUTHENTICATED";

export type AuthRecoveryCategory =
  | "TOKEN_EXPIRED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "REFRESH_UNAVAILABLE"
  | "REFRESH_REVOKED"
  | "REFRESH_INVALID";

export type AuthRecoverySnapshot = {
  readonly status: AuthRecoveryStatus;
  readonly category: AuthRecoveryCategory | null;
  readonly remediation: string | null;
  readonly lastTransitionAt: string;
  readonly refreshAttempts: number;
};

export interface AuthRecoveryControllerOptions {
  getRefreshFailure?: () => CloudCredentialRefreshFailure | null;
  now?: () => Date;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export const AUTH_RECOVERY_REMEDIATION = "Run `resin login` to resume cloud sync.";
export const AUTH_RECOVERY_RETRY_REMEDIATION =
  "Cloud authentication is temporarily unavailable; cloud sync will retry automatically.";
export const AUTH_ERROR_BODY_LIMIT_BYTES = 16 * 1024;
const AUTH_ERROR_BODY_MAX_CHUNKS = 256;

const TOKEN_EXPIRY_CODES = {
  token_expired: true,
  expired_token: true,
  jwt_expired: true,
} as const;
const REVOKED_CODES = {
  device_revoked: true,
  invalid_grant: true,
  revoked_token: true,
  unauthorized_client: true,
} as const;

const CREDENTIAL_FORBIDDEN_CODES = {
  device_revoked: true,
  invalid_grant: true,
  revoked_token: true,
  unauthorized_client: true,
  token_expired: true,
  expired_token: true,
  jwt_expired: true,
  invalid_token: true,
} as const;

function extractErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      const lower = value.toLowerCase();
      for (const code of Object.keys(CREDENTIAL_FORBIDDEN_CODES)) {
        if (lower.includes(code)) {
          return code;
        }
      }
      return null;
    }
  }

  if (typeof obj !== "object" || obj === null) {
    return null;
  }

  const record = obj as Record<string, unknown>;
  if (typeof record.code === "string" && record.code.trim()) {
    return record.code.trim().toLowerCase();
  }
  if (typeof record.error_code === "string" && record.error_code.trim()) {
    return record.error_code.trim().toLowerCase();
  }
  if (typeof record.errorCode === "string" && record.errorCode.trim()) {
    return record.errorCode.trim().toLowerCase();
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim().toLowerCase();
  }
  if (typeof record.error === "object" && record.error !== null) {
    const inner = record.error as Record<string, unknown>;
    if (typeof inner.code === "string" && inner.code.trim()) {
      return inner.code.trim().toLowerCase();
    }
    if (typeof inner.message === "string" && inner.message.trim()) {
      return inner.message.trim().toLowerCase();
    }
  }
  return null;
}

function extractWwwAuthenticate(
  headers?: Headers | Record<string, string | string[] | undefined> | null,
): string {
  if (!headers) {
    return "";
  }
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("www-authenticate")?.toLowerCase() ?? "";
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const val =
    record["www-authenticate"] ?? record["WWW-Authenticate"] ?? record["Www-Authenticate"];
  if (Array.isArray(val)) {
    return val.join(" ").toLowerCase();
  }
  if (typeof val === "string") {
    return val.toLowerCase();
  }
  return "";
}

/**
 * Classifies a 403 Forbidden response as either a credential-level failure
 * (requiring auth recovery/degradation) or a resource-scoped failure
 * (such as a tenant/workspace mismatch that should fail the batch without degrading auth).
 */
export function classifyForbiddenResponse(
  body: unknown,
  headers?: Headers | Record<string, string | string[] | undefined> | null,
): "credential" | "resource" {
  const challenge = extractWwwAuthenticate(headers);
  for (const code of Object.keys(CREDENTIAL_FORBIDDEN_CODES)) {
    if (challenge.includes(code)) {
      return "credential";
    }
  }

  const code = extractErrorCode(body);
  if (code && code in CREDENTIAL_FORBIDDEN_CODES) {
    return "credential";
  }

  if (code === "permission_denied" || (code && code.startsWith("permission_denied"))) {
    let detailText = "";
    if (typeof body === "string") {
      detailText = body;
    } else if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof record.message === "string") parts.push(record.message);
      if (typeof record.error_description === "string") parts.push(record.error_description);
      if (typeof record.reason === "string") parts.push(record.reason);
      if (typeof record.details === "string") parts.push(record.details);
      if (typeof record.details === "object" && record.details !== null) {
        parts.push(JSON.stringify(record.details));
      }
      detailText = parts.join(" ");
    }

    if (
      /(device|token|credential)/i.test(detailText) ||
      /(device|token|credential)/i.test(challenge)
    ) {
      return "credential";
    }
  }

  return "resource";
}

/**
 * Safe, actionable failure propagated when a cloud request fails with HTTP 403
 * due to a resource-scoped authorization error (e.g. workspace or tenant mismatch).
 * Does not trigger auth degradation or require re-login.
 */
export class ResourceForbiddenError extends ProtocolError {
  readonly workspaceId?: string;

  constructor(
    message = "Forbidden: resource access denied",
    options: {
      workspaceId?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super("permission_denied", message, {
      status: 403,
      details: {
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...options.details,
      },
      cause: options.cause,
    });
    this.name = "ResourceForbiddenError";
    this.workspaceId = options.workspaceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function responseErrorCode<T>(value: T): string | null {
  const schema = z.union([
    z.object({ code: z.string() }),
    z.object({ error: z.string() }),
    z.object({ error: z.object({ code: z.string() }) }),
  ]);
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if ("code" in data && data.code) return data.code.toLowerCase();
  if ("error" in data) {
    const errStr = z.string().safeParse(data.error);
    if (errStr.success) {
      return errStr.data.toLowerCase();
    }
    const errObj = z.object({ code: z.string() }).safeParse(data.error);
    if (errObj.success) {
      return errObj.data.code.toLowerCase();
    }
  }
  return null;
}

function cancelResponseBody(response: Response): void {
  if (!response.body || response.bodyUsed) {
    return;
  }
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Some fetch implementations throw synchronously when a stream cannot be cancelled.
  }
}
async function readCappedAuthErrorJson(response: Response): Promise<JsonObject | null> {
  const body = response.body;
  if (!body || response.bodyUsed) {
    return null;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    cancelResponseBody(response);
    return null;
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      Number.isFinite(contentLength) &&
      contentLength >= 0 &&
      contentLength > AUTH_ERROR_BODY_LIMIT_BYTES
    ) {
      cancelResponseBody(response);
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      chunkCount += 1;
      if (chunkCount > AUTH_ERROR_BODY_MAX_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > AUTH_ERROR_BODY_LIMIT_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    const result = JsonObjectSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Classifies only a small allowlist of authentication response signals. Authentication error
 * bodies are read through a strict byte cap, never retained, surfaced, or included in errors.
 */
export async function classifyAuthResponse(
  response: Response,
): Promise<AuthRecoveryCategory | null> {
  if (response.status < 400 || response.status > 403) {
    return null;
  }

  const challenge = response.headers.get("www-authenticate")?.toLowerCase() ?? "";
  if (challenge.includes("token_expired") || challenge.includes("expired")) {
    cancelResponseBody(response);
    return "TOKEN_EXPIRED";
  }

  const rawJson = await readCappedAuthErrorJson(response);
  const errorCode = responseErrorCode(rawJson);
  if (errorCode && errorCode in TOKEN_EXPIRY_CODES) {
    return "TOKEN_EXPIRED";
  }
  if (errorCode && errorCode in REVOKED_CODES) {
    return "REFRESH_REVOKED";
  }
  if (response.status === 401) {
    return "UNAUTHORIZED";
  }
  if (response.status === 403) {
    const forbiddenScope = classifyForbiddenResponse(rawJson, response.headers);
    if (forbiddenScope === "credential") {
      return "FORBIDDEN";
    }
    return null;
  }
  return null;
}
export function classifyAuthError<E>(error: E): AuthRecoveryCategory | null {
  if (error instanceof ResourceForbiddenError) {
    return null;
  }

  if (error instanceof ProtocolError) {
    switch (error.code) {
      case "token_expired":
        return "TOKEN_EXPIRED";
      case "device_revoked":
      case "invalid_grant":
        return "REFRESH_REVOKED";
      case "unauthorized":
        return "UNAUTHORIZED";
      case "permission_denied": {
        const forbiddenScope = classifyForbiddenResponse({
          code: error.code,
          message: error.message,
          details: error.details,
        });
        return forbiddenScope === "credential" ? "FORBIDDEN" : null;
      }
      default:
        break;
    }
  }

  const statusParsed = z.object({ status: z.number() }).safeParse(error);
  if (statusParsed.success) {
    if (statusParsed.data.status === 401) {
      return "UNAUTHORIZED";
    }
    if (statusParsed.data.status === 403) {
      const forbiddenScope = classifyForbiddenResponse(error);
      return forbiddenScope === "credential" ? "FORBIDDEN" : null;
    }
  }
  return null;
}

function protocolCodeForCategory(category: AuthRecoveryCategory): ProtocolErrorCode {
  switch (category) {
    case "TOKEN_EXPIRED":
      return "token_expired";
    case "FORBIDDEN":
      return "permission_denied";
    case "REFRESH_REVOKED":
      return "invalid_grant";
    default:
      return "unauthorized";
  }
}

function statusLabel(status: number): string {
  if (status === 401) {
    return "401 Unauthorized";
  }
  if (status === 403) {
    return "403 Forbidden";
  }
  return `HTTP ${status}`;
}

type AuthRecoverySubscription = (listener: () => void) => () => void;

function remediationForCategory(category: AuthRecoveryCategory): string {
  return category === "REFRESH_UNAVAILABLE"
    ? AUTH_RECOVERY_RETRY_REMEDIATION
    : AUTH_RECOVERY_REMEDIATION;
}

/**
 * Safe, actionable failure propagated to the durable observation buffer. It deliberately contains
 * no response body, request body, token, or transcript content.
 */
export class AuthRecoveryError extends ProtocolError {
  readonly authStatus = "DEGRADED_OFFLINE" as const;
  readonly category: AuthRecoveryCategory;
  readonly remediation: string;
  private readonly subscribeToRecovery?: AuthRecoverySubscription;

  constructor(
    category: AuthRecoveryCategory,
    options: {
      status?: number;
      afterRefresh?: boolean;
      message?: string;
      subscribeToRecovery?: AuthRecoverySubscription;
    } = {},
  ) {
    const status = options.status ?? (category === "FORBIDDEN" ? 403 : 401);
    const remediation = remediationForCategory(category);
    const message =
      options.message ??
      (options.afterRefresh
        ? `Cloud request failed with HTTP ${status} after token refresh; observations remain queued locally. ${remediation}`
        : options.status
          ? `Cloud request rejected (${statusLabel(status)}); token refresh failed. Observations remain queued locally. ${remediation}`
          : `Cloud authentication is unavailable; observations remain queued locally. ${remediation}`);

    super(protocolCodeForCategory(category), message, {
      status,
      details: {
        authStatus: "DEGRADED_OFFLINE",
        category,
        remediation,
      },
    });
    this.name = "AuthRecoveryError";
    this.category = category;
    this.remediation = remediation;
    this.subscribeToRecovery = options.subscribeToRecovery;
  }

  onRecovered(listener: () => void): () => void {
    if (!this.subscribeToRecovery) {
      return () => undefined;
    }
    return this.subscribeToRecovery(listener);
  }
}

function categoryForRefreshFailure(
  failure: CloudCredentialRefreshFailure | null,
): AuthRecoveryCategory {
  switch (failure) {
    case "revoked":
      return "REFRESH_REVOKED";
    case "invalid":
      return "REFRESH_INVALID";
    default:
      return "REFRESH_UNAVAILABLE";
  }
}

type AccessTokenIdentity = Pick<CloudRequestIdentity, "accessToken">;

function credentialFingerprint(identity: AccessTokenIdentity): string {
  return createHash("sha256").update(identity.accessToken).digest("hex");
}

/**
 * Coordinates exactly one refresh attempt for any number of concurrent rejected cloud requests.
 * The controller owns no credentials and exposes only a frozen, non-secret status snapshot.
 */
export class AuthRecoveryController {
  private status: AuthRecoveryStatus = "UNAUTHENTICATED";
  private category: AuthRecoveryCategory | null = null;
  private remediation: string | null = null;
  private lastTransitionAt: string;
  private refreshAttempts = 0;
  private refreshPromise: Promise<CloudRequestIdentity | null> | null = null;
  private degradedCredentialFingerprint: string | null = null;
  private refreshRetryTimer: NodeJS.Timeout | null = null;
  private refreshRetryAttempt = 0;
  private readonly recoveryListeners = new Set<() => void>();
  private readonly getRefreshFailure?: () => CloudCredentialRefreshFailure | null;
  private readonly now: () => Date;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(options: AuthRecoveryControllerOptions = {}) {
    this.getRefreshFailure = options.getRefreshFailure;
    this.now = options.now ?? (() => new Date());
    this.retryBaseDelayMs = Math.max(1, Math.floor(options.retryBaseDelayMs ?? 1_000));
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      Math.floor(options.retryMaxDelayMs ?? 60_000),
    );
    this.lastTransitionAt = this.now().toISOString();
  }

  getSnapshot(): AuthRecoverySnapshot {
    return Object.freeze({
      status: this.status,
      category: this.category,
      remediation: this.remediation,
      lastTransitionAt: this.lastTransitionAt,
      refreshAttempts: this.refreshAttempts,
    });
  }

  setAuthenticated(): void {
    const recovered = this.status !== "AUTHENTICATED";
    this.clearRefreshRetry();
    this.refreshRetryAttempt = 0;
    this.degradedCredentialFingerprint = null;
    this.transition("AUTHENTICATED", null, null);
    if (!recovered) {
      return;
    }

    const listeners = [...this.recoveryListeners];
    this.recoveryListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Recovery must not be rolled back by an observer callback.
      }
    }
  }

  acceptIdentity(identity: AccessTokenIdentity): boolean {
    if (
      this.status === "DEGRADED_OFFLINE" &&
      this.degradedCredentialFingerprint === credentialFingerprint(identity)
    ) {
      return false;
    }
    this.setAuthenticated();
    return true;
  }

  setUnauthenticated(): void {
    if (this.status === "DEGRADED_OFFLINE") {
      return;
    }
    this.clearRefreshRetry();
    this.refreshRetryAttempt = 0;
    this.degradedCredentialFingerprint = null;
    this.transition("UNAUTHENTICATED", null, null);
  }

  setDegraded(category: AuthRecoveryCategory, rejectedIdentity?: AccessTokenIdentity): void {
    if (rejectedIdentity) {
      this.degradedCredentialFingerprint = credentialFingerprint(rejectedIdentity);
    }
    if (category !== "REFRESH_UNAVAILABLE") {
      this.clearRefreshRetry();
      this.refreshRetryAttempt = 0;
    }
    this.transition("DEGRADED_OFFLINE", category, remediationForCategory(category));
  }

  createError(
    category: AuthRecoveryCategory = this.category ?? "REFRESH_UNAVAILABLE",
    options: { status?: number; afterRefresh?: boolean; message?: string } = {},
  ): AuthRecoveryError {
    return new AuthRecoveryError(category, {
      ...options,
      subscribeToRecovery: (listener) => this.subscribeToRecovery(listener),
    });
  }

  async recover(
    category: AuthRecoveryCategory,
    rejectedIdentity: AccessTokenIdentity | undefined,
    refreshIdentity: () => Promise<CloudRequestIdentity | null>,
  ): Promise<CloudRequestIdentity | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const rejectedCredentialFingerprint = rejectedIdentity
      ? credentialFingerprint(rejectedIdentity)
      : this.degradedCredentialFingerprint;

    this.clearRefreshRetry();
    this.refreshAttempts += 1;
    this.transition("REFRESHING", category, null);

    const recovery = (async (): Promise<CloudRequestIdentity | null> => {
      let refreshedIdentity: CloudRequestIdentity | null = null;
      try {
        refreshedIdentity = await refreshIdentity();
      } catch {
        // Raw refresh errors are intentionally not surfaced or retained.
      }

      const refreshFailure = this.getRefreshFailure?.() ?? null;
      const refreshedCredentialFingerprint = refreshedIdentity
        ? credentialFingerprint(refreshedIdentity)
        : null;
      const credentialChanged =
        !rejectedCredentialFingerprint ||
        (refreshedCredentialFingerprint !== null &&
          refreshedCredentialFingerprint !== rejectedCredentialFingerprint);
      if (refreshedIdentity && credentialChanged && !refreshFailure) {
        this.setAuthenticated();
        return refreshedIdentity;
      }

      const degradedCategory = categoryForRefreshFailure(refreshFailure);
      this.setDegraded(degradedCategory, rejectedIdentity);
      if (degradedCategory === "REFRESH_UNAVAILABLE") {
        this.scheduleRefreshRetry(category, rejectedIdentity, refreshIdentity);
      }
      return null;
    })();

    this.refreshPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (this.refreshPromise === recovery) {
        this.refreshPromise = null;
      }
    }
  }

  dispose(): void {
    this.clearRefreshRetry();
    this.recoveryListeners.clear();
  }

  private subscribeToRecovery(listener: () => void): () => void {
    if (this.status === "AUTHENTICATED") {
      queueMicrotask(listener);
      return () => undefined;
    }

    this.recoveryListeners.add(listener);
    return () => {
      this.recoveryListeners.delete(listener);
    };
  }

  private scheduleRefreshRetry(
    category: AuthRecoveryCategory,
    rejectedIdentity: AccessTokenIdentity | undefined,
    refreshIdentity: () => Promise<CloudRequestIdentity | null>,
  ): void {
    if (this.refreshRetryTimer || this.status !== "DEGRADED_OFFLINE") {
      return;
    }

    const exponent = Math.min(this.refreshRetryAttempt, 20);
    const retryDelayMs = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** exponent);
    this.refreshRetryAttempt += 1;
    this.refreshRetryTimer = setTimeout(() => {
      this.refreshRetryTimer = null;
      void this.recover(category, rejectedIdentity, refreshIdentity).catch(() => {
        this.setDegraded("REFRESH_UNAVAILABLE", rejectedIdentity);
        this.scheduleRefreshRetry(category, rejectedIdentity, refreshIdentity);
      });
    }, retryDelayMs);
    this.refreshRetryTimer.unref();
  }

  private clearRefreshRetry(): void {
    if (!this.refreshRetryTimer) {
      return;
    }
    clearTimeout(this.refreshRetryTimer);
    this.refreshRetryTimer = null;
  }

  private transition(
    status: AuthRecoveryStatus,
    category: AuthRecoveryCategory | null,
    remediation: string | null,
  ): void {
    if (this.status === status && this.category === category && this.remediation === remediation) {
      return;
    }
    this.status = status;
    this.category = category;
    this.remediation = remediation;
    this.lastTransitionAt = this.now().toISOString();
  }
}
