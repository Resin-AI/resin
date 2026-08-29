import {
  type CapabilityEnvelope,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  hashCanonicalContent,
  normalizeSha256,
} from "@resin/contracts";
import {
  type CatalogSnapshotRequest,
  type CatalogSnapshotResponse,
  CatalogSnapshotResponseSchema,
  PROTOCOL_VERSION,
  type ProjectRegistrationRequest,
  type ProjectRegistrationResponse,
  ProjectRegistrationResponseSchema,
  type ProtocolClient,
  ProtocolError,
  ValidationError,
  validateProjectRegistrationRequest,
  validateProjectRegistrationResponse,
} from "@resin/protocol";
import { z } from "zod";
import { computeManifestDigest } from "../registry/validator.js";
import { CloudCircuitBreaker } from "./circuit-breaker.js";

export interface CloudRequestIdentity {
  cloudUrl: string;
  accessToken: string;
  accountId: string;
  workspaceId: string;
  deviceId: string;
  installationId: string;
  userId: string;
}

export type CloudIdentityProvider = (options?: {
  forceRefresh?: boolean;
}) => Promise<CloudRequestIdentity | null>;

export interface CloudCatalogClientOptions {
  workspaceId?: string;
  deviceId?: string;
  baseUrl?: string;
  authToken?: string;
  identityProvider?: CloudIdentityProvider;
  protocolClient?: ProtocolClient;
  circuitBreaker?: CloudCircuitBreaker;
  defaultEnvelope?: CapabilityEnvelope;
  fetchFn?: typeof fetch;
  snapshotFetcher?: (
    request: CatalogSnapshotRequest,
    signal?: AbortSignal,
  ) => Promise<CatalogSnapshotResponse>;
  projectRegistrar?: (
    request: ProjectRegistrationRequest,
    signal?: AbortSignal,
  ) => Promise<ProjectRegistrationResponse>;
}

interface ProjectRegistrarCarrier {
  registerProject(
    req: ProjectRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<ProjectRegistrationResponse>;
}

function isProjectRegistrarCarrier(
  client: ProtocolClient | null | undefined,
): client is ProtocolClient & ProjectRegistrarCarrier {
  if (!client || !(client instanceof Object)) return false;
  return "registerProject" in client && client.registerProject instanceof Function;
}

const RawErrorPayloadSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
type RawErrorPayload = z.infer<typeof RawErrorPayloadSchema>;

function toErrorDetails(
  value?: RawErrorPayload | Error | string | number | boolean | null,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (
    !value ||
    Object.prototype.toString.call(value) !== "[object Object]" ||
    value instanceof Error
  ) {
    return undefined;
  }
  const details: Record<string, string | number | boolean | null | undefined> = {};
  for (const [k, v] of Object.entries(value)) {
    if (
      v === null ||
      v === undefined ||
      v === true ||
      v === false ||
      Object.prototype.toString.call(v) === "[object String]" ||
      Object.prototype.toString.call(v) === "[object Number]"
    ) {
      details[k] = v;
    }
  }
  return details;
}

export class CloudCatalogClient {
  readonly workspaceId?: string;
  readonly deviceId?: string;
  private readonly baseUrl?: string;
  private readonly authToken?: string;
  private readonly identityProvider?: CloudIdentityProvider;
  private readonly protocolClient?: ProtocolClient;
  private readonly circuitBreaker: CloudCircuitBreaker;
  private readonly defaultEnvelope?: CapabilityEnvelope;
  private readonly fetchFn: typeof fetch;
  private isPaused = false;
  private readonly snapshotFetcher?: (
    request: CatalogSnapshotRequest,
    signal?: AbortSignal,
  ) => Promise<CatalogSnapshotResponse>;
  private readonly projectRegistrar?: (
    request: ProjectRegistrationRequest,
    signal?: AbortSignal,
  ) => Promise<ProjectRegistrationResponse>;

  constructor(options: CloudCatalogClientOptions = {}) {
    this.workspaceId = options.workspaceId;
    this.deviceId =
      options.deviceId || (options.workspaceId ? `device_${options.workspaceId}` : undefined);
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.identityProvider = options.identityProvider;
    this.protocolClient = options.protocolClient;
    this.circuitBreaker = options.circuitBreaker ?? new CloudCircuitBreaker();
    this.defaultEnvelope = options.defaultEnvelope;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.snapshotFetcher = options.snapshotFetcher;
    this.projectRegistrar = options.projectRegistrar;
  }

  pauseCloudCalls(): void {
    this.isPaused = true;
  }

  resumeCloudCalls(): void {
    this.isPaused = false;
  }

  isCloudPaused(): boolean {
    return this.isPaused;
  }

  getCircuitBreaker(): CloudCircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Fetches a scoped cloud catalog snapshot, validating schema, canonical checksum, and manifest digests.
   */
  async fetchCatalogSnapshot(
    options: {
      currentVersion?: string;
      filterScopes?: string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<CatalogSnapshotResponse> {
    // 1. Check paused state
    if (this.isPaused) {
      throw new ProtocolError(
        "terminal",
        "Cloud catalog client is paused due to authentication failure / revocation",
        { status: 401 },
      );
    }

    // 2. Check circuit breaker state
    if (!this.circuitBreaker.canExecute()) {
      const health = this.circuitBreaker.getHealth();
      throw new ProtocolError(
        "retryable",
        `Cloud catalog service is currently offline/unavailable (circuit state: ${health.circuitState}, status: ${health.status})`,
        {
          status: 503,
          details: {
            status: health.status,
            circuitState: health.circuitState,
            failureCount: health.failureCount,
            consecutiveSuccesses: health.consecutiveSuccesses,
            lastStateChange: health.lastStateChange,
            lastFailureTime: health.lastFailureTime,
            lastSuccessTime: health.lastSuccessTime,
            lastErrorReason: health.lastErrorReason,
            nextRetryAllowedAt: health.nextRetryAllowedAt,
          },
        },
      );
    }

    const workspaceId = this.workspaceId;
    const deviceId = this.deviceId;
    if (!workspaceId || !deviceId) {
      throw new ValidationError("Cloud catalog snapshot requires valid workspaceId and deviceId", {
        details: {
          workspaceId: this.workspaceId,
          deviceId: this.deviceId,
        },
      });
    }

    try {
      // 3. Fetch snapshot from provider
      const request: CatalogSnapshotRequest = {
        workspaceId,
        deviceId,
        currentVersion: options.currentVersion,
        filterScopes: options.filterScopes,
      };

      const rawResponse = await this.executeFetch(request, options.signal);

      // 3. Validate response schema with protocol parser
      const parsed = CatalogSnapshotResponseSchema.safeParse(rawResponse);
      if (!parsed.success) {
        throw new ValidationError("Invalid catalog snapshot response schema from cloud", {
          details: {
            issues: parsed.error.issues.map((i) => ({
              code: i.code,
              message: i.message,
              path: i.path.map((p) => String(p)),
            })),
          },
        });
      }
      const response = parsed.data;

      // 4. Verify canonical checksum
      const computedChecksum = hashCanonicalContent({
        tools: response.tools,
        activeDeployments: response.activeDeployments,
      });

      if (normalizeSha256(computedChecksum) !== normalizeSha256(response.checksum)) {
        throw new ValidationError(
          "Catalog snapshot checksum mismatch: payload may be tampered or corrupted",
          {
            details: {
              expected: response.checksum,
              computed: computedChecksum,
            },
          },
        );
      }

      // 5. Validate individual ToolManifests and digests
      for (const tool of response.tools) {
        const manifestResult = ToolManifestSchema.safeParse(tool);
        if (!manifestResult.success) {
          throw new ValidationError(
            `Invalid tool manifest schema for tool '${tool.id || tool.name}'`,
            {
              details: {
                issues: manifestResult.error.issues.map((i) => ({
                  code: i.code,
                  message: i.message,
                  path: i.path.map((p) => String(p)),
                })),
                toolId: tool.id,
              },
            },
          );
        }

        // Verify manifest digest
        const manifest = manifestResult.data;
        if (manifest.digest) {
          const computedDigest = computeManifestDigest(manifest);
          if (normalizeSha256(manifest.digest) !== normalizeSha256(computedDigest)) {
            throw new ValidationError(
              `Manifest digest verification failed for tool '${manifest.id}'`,
              {
                details: { declaredDigest: manifest.digest, computedDigest },
              },
            );
          }
        }
      }

      // 6. Record success in circuit breaker
      this.circuitBreaker.recordSuccess();

      return response;
    } catch (error) {
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async executeFetch(
    request: CatalogSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshotResponse> {
    if (this.isPaused) {
      throw new ProtocolError(
        "terminal",
        "Cloud catalog client is paused due to authentication failure / revocation",
      );
    }

    // Path 1: Custom snapshot fetcher
    if (this.snapshotFetcher) {
      return await this.snapshotFetcher(request, signal);
    }

    // Path 2: ProtocolClient instance
    if (this.protocolClient) {
      return this.protocolClient.getCatalogSnapshot(request.currentVersion);
    }

    // Path 3: Identity-driven or direct HTTP REST fetch
    if (this.identityProvider || this.baseUrl) {
      let identity = this.identityProvider ? await this.identityProvider() : null;
      if (this.identityProvider && !identity) {
        this.isPaused = true;
        throw new ProtocolError(
          "terminal",
          "No cloud credentials available or credentials revoked",
          {
            status: 401,
          },
        );
      }

      const targetBaseUrl = identity?.cloudUrl ?? this.baseUrl;
      if (!targetBaseUrl) {
        throw new Error("No baseUrl or identity cloudUrl configured for CloudCatalogClient");
      }

      const targetWorkspaceId =
        identity?.workspaceId ?? request.workspaceId ?? this.workspaceId ?? "";
      const targetDeviceId = identity?.deviceId ?? request.deviceId ?? this.deviceId ?? "";

      const url = new URL(`${targetBaseUrl}/v1/catalog/snapshot`);
      url.searchParams.set("workspaceId", targetWorkspaceId);
      url.searchParams.set("deviceId", targetDeviceId);
      if (request.currentVersion) {
        url.searchParams.set("currentVersion", request.currentVersion);
      }
      if (request.filterScopes && request.filterScopes.length > 0) {
        url.searchParams.set("filterScopes", request.filterScopes.join(","));
      }

      const buildHeaders = (id: CloudRequestIdentity | null) => {
        const headers: Record<string, string> = {};
        headers.Accept = "application/json";
        headers["x-protocol-version"] = PROTOCOL_VERSION;
        if (id) {
          headers.Authorization = `Bearer ${id.accessToken}`;
          headers["x-account-id"] = id.accountId;
          headers["x-workspace-id"] = id.workspaceId;
          headers["x-device-id"] = id.deviceId;
          headers["x-installation-id"] = id.installationId;
          if (id.userId) {
            headers["x-user-id"] = id.userId;
          }
        } else {
          if (this.authToken) {
            headers.Authorization = `Bearer ${this.authToken}`;
          }
          if (targetWorkspaceId) {
            headers["x-workspace-id"] = targetWorkspaceId;
          }
          if (targetDeviceId) {
            headers["x-device-id"] = targetDeviceId;
          }
        }
        return headers;
      };

      let response = await this.fetchFn(url.toString(), {
        headers: buildHeaders(identity),
        signal,
      });

      if (response.status === 401 && this.identityProvider) {
        identity = await this.identityProvider({ forceRefresh: true });
        if (!identity) {
          this.isPaused = true;
          throw new ProtocolError(
            "terminal",
            "Cloud credentials revoked or invalid after 401 refresh",
            {
              status: 401,
            },
          );
        }
        response = await this.fetchFn(url.toString(), {
          headers: buildHeaders(identity),
          signal,
        });
        if (response.status === 401) {
          this.isPaused = true;
          throw new ProtocolError(
            "terminal",
            "Cloud credentials unauthorized (401) after refresh retry",
            {
              status: 401,
            },
          );
        }
      }

      if (!response.ok) {
        let parsedPayload: RawErrorPayload | undefined;
        try {
          const raw = await response.json();
          const parsed = RawErrorPayloadSchema.safeParse(raw);
          if (parsed.success) {
            parsedPayload = parsed.data;
          }
        } catch {
          // ignore non-json response body
        }

        const errMessage =
          parsedPayload &&
          "message" in parsedPayload &&
          Object.prototype.toString.call(parsedPayload.message) === "[object String]"
            ? String(parsedPayload.message)
            : null;
        const message =
          errMessage ||
          `Cloud catalog snapshot failed with HTTP ${response.status}: ${response.statusText}`;

        const errorDetails = toErrorDetails(parsedPayload);
        if (response.status === 401 || response.status === 403) {
          this.isPaused = true;
          throw new ProtocolError("terminal", message, {
            status: response.status,
            details: errorDetails,
          });
        }

        if (response.status === 429) {
          throw new ProtocolError("retryable", message, {
            status: 429,
            details: errorDetails,
          });
        }
        if (response.status >= 500) {
          throw new ProtocolError("retryable", message, {
            status: response.status,
            details: errorDetails,
          });
        }

        throw new ProtocolError("terminal", message, {
          status: response.status,
          details: errorDetails,
        });
      }

      return CatalogSnapshotResponseSchema.parse(await response.json());
    }

    throw new Error(
      "No transport configured for CloudCatalogClient (provide baseUrl, identityProvider, protocolClient, or snapshotFetcher)",
    );
  }

  /**
   * Registers project metadata with the cloud catalog.
   * Posts authenticated request through configured transport, maps offline/network absence to local_only,
   * returns strictly validated response, and preserves local UUID.
   */
  async registerProject(
    request: ProjectRegistrationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProjectRegistrationResponse> {
    // 1. Check paused state
    if (this.isPaused) {
      throw new ProtocolError(
        "terminal",
        "Cloud catalog client is paused due to authentication failure / revocation",
        { status: 401 },
      );
    }

    // 2. Validate the registration request shape
    const validatedRequest = validateProjectRegistrationRequest(request);

    // 3. Check circuit breaker / offline status
    if (!this.circuitBreaker.canExecute()) {
      return {
        outcome: "local_only",
        projectId: validatedRequest.project.projectId,
      };
    }

    try {
      const rawResponse = await this.executeProjectRegistrationFetch(
        validatedRequest,
        options.signal,
      );

      // 4. Strict validation of response schema and projectId match
      const validatedResponse = validateProjectRegistrationResponse(
        rawResponse,
        validatedRequest.project.projectId,
      );
      // 5. Record success in circuit breaker
      this.circuitBreaker.recordSuccess();

      return validatedResponse;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // If error is network absence or offline state, map to local_only
      if (this.isOfflineOrNetworkError(err)) {
        this.circuitBreaker.recordFailure(err);
        return {
          outcome: "local_only",
          projectId: validatedRequest.project.projectId,
        };
      }

      // Record other failures and rethrow
      this.circuitBreaker.recordFailure(err);
      throw error;
    }
  }

  private isOfflineOrNetworkError(
    error:
      | Error
      | { code?: string; name?: string; message?: string; status?: number }
      | string
      | number
      | boolean
      | null
      | undefined,
  ): boolean {
    if (!error) return false;
    if (error instanceof TypeError) {
      return true;
    }
    const err = error instanceof Object ? error : undefined;
    if (!err) return false;
    if ("name" in err && (err.name === "FetchError" || err.name === "AbortError")) {
      return true;
    }
    const code =
      "code" in err && Object.prototype.toString.call(err.code) === "[object String]"
        ? String(err.code)
        : "";
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET"
    ) {
      return true;
    }
    const msg =
      "message" in err && Object.prototype.toString.call(err.message) === "[object String]"
        ? String(err.message).toLowerCase()
        : "";
    if (
      msg.includes("fetch failed") ||
      msg.includes("failed to fetch") ||
      msg.includes("network error") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("offline") ||
      msg.includes("eai_again") ||
      msg.includes("socket hang up") ||
      msg.includes("timed out") ||
      msg.includes("no transport configured")
    ) {
      return true;
    }
    return false;
  }

  private async executeProjectRegistrationFetch(
    request: ProjectRegistrationRequest,
    signal?: AbortSignal,
  ): Promise<ProjectRegistrationResponse> {
    if (this.isPaused) {
      throw new ProtocolError(
        "terminal",
        "Cloud catalog client is paused due to authentication failure / revocation",
      );
    }

    // Path 1: Custom project registrar
    if (this.projectRegistrar) {
      return await this.projectRegistrar(request, signal);
    }
    // Path 2: ProtocolClient instance
    if (isProjectRegistrarCarrier(this.protocolClient)) {
      return await this.protocolClient.registerProject(request, signal);
    }

    // Path 3: Identity-driven or direct HTTP REST fetch
    if (this.identityProvider || this.baseUrl) {
      let identity: CloudRequestIdentity | null = null;
      if (this.identityProvider) {
        try {
          identity = await this.identityProvider();
        } catch (err) {
          this.isPaused = true;
          throw new ProtocolError(
            "terminal",
            `Identity provider failed: ${err instanceof Error ? err.message : String(err)}`,
            { status: 401 },
          );
        }
      }
      if (this.identityProvider && !identity) {
        this.isPaused = true;
        throw new ProtocolError(
          "terminal",
          "No cloud credentials available or credentials revoked",
          {
            status: 401,
          },
        );
      }

      const targetBaseUrl = identity?.cloudUrl ?? this.baseUrl;
      if (!targetBaseUrl) {
        throw new Error(
          "No baseUrl or identity cloudUrl configured for CloudCatalogClient project registration",
        );
      }

      const targetWorkspaceId = identity?.workspaceId ?? this.workspaceId ?? "";
      const targetDeviceId = identity?.deviceId ?? this.deviceId ?? "";

      const url = new URL(`${targetBaseUrl}/v1/projects`);

      const buildRegHeaders = (id: CloudRequestIdentity | null) => {
        const headers: Record<string, string> = {};
        headers["Content-Type"] = "application/json";
        headers.Accept = "application/json";
        headers["x-protocol-version"] = PROTOCOL_VERSION;
        if (id) {
          headers.Authorization = `Bearer ${id.accessToken}`;
          headers["x-account-id"] = id.accountId;
          headers["x-workspace-id"] = id.workspaceId;
          headers["x-device-id"] = id.deviceId;
          headers["x-installation-id"] = id.installationId;
          if (id.userId) {
            headers["x-user-id"] = id.userId;
          }
        } else {
          if (this.authToken) {
            headers.Authorization = `Bearer ${this.authToken}`;
          }
          if (targetWorkspaceId) {
            headers["x-workspace-id"] = targetWorkspaceId;
          }
          if (targetDeviceId) {
            headers["x-device-id"] = targetDeviceId;
          }
        }
        return headers;
      };

      let response = await this.fetchFn(url.toString(), {
        method: "POST",
        headers: buildRegHeaders(identity),
        body: JSON.stringify(request),
        signal,
      });

      if (response.status === 401 && this.identityProvider) {
        identity = await this.identityProvider({ forceRefresh: true });
        if (!identity) {
          this.isPaused = true;
          throw new ProtocolError(
            "terminal",
            "Cloud credentials revoked or invalid after 401 refresh",
            {
              status: 401,
            },
          );
        }
        response = await this.fetchFn(url.toString(), {
          method: "POST",
          headers: buildRegHeaders(identity),
          body: JSON.stringify(request),
          signal,
        });
        if (response.status === 401) {
          this.isPaused = true;
          throw new ProtocolError(
            "terminal",
            "Cloud credentials unauthorized (401) after refresh retry",
            {
              status: 401,
            },
          );
        }
      }

      if (!response.ok) {
        let parsedPayload: RawErrorPayload | undefined;
        try {
          const raw = await response.json();
          const parsed = RawErrorPayloadSchema.safeParse(raw);
          if (parsed.success) {
            parsedPayload = parsed.data;
          }
        } catch {
          // ignore non-json error body
        }

        const errMessage =
          parsedPayload &&
          "message" in parsedPayload &&
          Object.prototype.toString.call(parsedPayload.message) === "[object String]"
            ? String(parsedPayload.message)
            : null;
        const message =
          errMessage ||
          `Project registration failed with HTTP ${response.status}: ${response.statusText}`;

        const errorDetails = toErrorDetails(parsedPayload);
        if (response.status === 401 || response.status === 403) {
          this.isPaused = true;
          throw new ProtocolError("terminal", message, {
            status: response.status,
            details: errorDetails,
          });
        }

        if (response.status === 429) {
          throw new ProtocolError("retryable", message, {
            status: 429,
            details: errorDetails,
          });
        }
        if (response.status >= 500) {
          throw new ProtocolError("retryable", message, {
            status: response.status,
            details: errorDetails,
          });
        }

        throw new ProtocolError("terminal", message, {
          status: response.status,
          details: errorDetails,
        });
      }

      const json = await response.json();
      return validateProjectRegistrationResponse(
        ProjectRegistrationResponseSchema.parse(json),
        request.project.projectId,
      );
    }
    throw new Error(
      "No transport configured for CloudCatalogClient project registration (provide baseUrl or projectRegistrar)",
    );
  }
}
