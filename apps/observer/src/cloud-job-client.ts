import { createHash } from "node:crypto";
import {
  type ArtifactDownloadOptions,
  ArtifactIntegrityError,
  ArtifactSizeExceededError,
  type DownloadedArtifact,
  JobAbortedError,
  type JobExecutionResult,
  type JobExecutionStatus,
  JobFailedError,
  JobMalformedResponseError,
  type JobPollOptions,
  type JobStatusResponse,
  JobStatusResponseSchema,
  JobTimeoutError,
  PROTOCOL_VERSION,
  ProtocolError,
  RateLimitedError,
} from "@resin/protocol";
import { CloudCredentialStore, type CloudRequestIdentity } from "./cloud-credentials.js";

/**
 * Default maximum size for artifact download: 50 MiB.
 */
export const DEFAULT_MAX_ARTIFACT_SIZE_BYTES = 52_428_800;

/**
 * Default maximum polling duration: 60 seconds.
 */
export const DEFAULT_MAX_POLL_WAIT_MS = 60_000;

/**
 * Default initial polling interval: 500 ms.
 */
export const DEFAULT_INITIAL_POLL_INTERVAL_MS = 500;

/**
 * Default maximum polling interval: 5,000 ms.
 */
export const DEFAULT_MAX_POLL_INTERVAL_MS = 5_000;

/**
 * Default backoff multiplier factor: 1.5.
 */
export const DEFAULT_BACKOFF_FACTOR = 1.5;

/**
 * Helper to normalize SHA-256 strings (strips 'sha256:' and lowercases).
 */
export function normalizeSha256Digest(digest?: string): string | undefined {
  if (!digest) return undefined;
  const trimmed = digest.trim().toLowerCase();
  return trimmed.startsWith("sha256:") ? trimmed.slice(7) : trimmed;
}

/**
 * Parses HTTP Retry-After header into milliseconds.
 * Supports numeric seconds as well as HTTP-date formats.
 */
export function parseRetryAfterHeader(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  const seconds = Number.parseFloat(trimmed);
  if (!Number.isNaN(seconds) && Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const diffMs = parsedDate - Date.now();
    return Math.max(0, diffMs);
  }

  return undefined;
}

/**
 * Helper to pause execution with AbortSignal cancellation support.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new JobAbortedError("Operation was aborted"));
    }

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new JobAbortedError("Operation was aborted"));
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Reads response body chunks enforcing maximum byte limit.
 */
async function readBodyWithLimit(
  response: Response,
  maxSizeBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const contentLengthStr = response.headers.get("content-length");
  if (contentLengthStr) {
    const declaredSize = Number.parseInt(contentLengthStr, 10);
    if (!Number.isNaN(declaredSize) && declaredSize > maxSizeBytes) {
      throw new ArtifactSizeExceededError(declaredSize, maxSizeBytes);
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel("Aborted");
          throw new JobAbortedError("Artifact download was aborted");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedBytes += value.byteLength;
          if (receivedBytes > maxSizeBytes) {
            await reader.cancel("Size limit exceeded");
            throw new ArtifactSizeExceededError(receivedBytes, maxSizeBytes);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const result = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  if (signal?.aborted) {
    throw new JobAbortedError("Artifact download was aborted");
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxSizeBytes) {
    throw new ArtifactSizeExceededError(arrayBuffer.byteLength, maxSizeBytes);
  }
  return new Uint8Array(arrayBuffer);
}

/**
 * Options for configuring CloudJobClient.
 */
export interface CloudJobClientOptions {
  credentialStore?: CloudCredentialStore;
  identityProvider?: (options?: { forceRefresh?: boolean }) => Promise<CloudRequestIdentity | null>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  defaultPollOptions?: JobPollOptions;
  defaultDownloadOptions?: ArtifactDownloadOptions;
}

interface InternalJobStatusFetchResult {
  statusResponse: JobStatusResponse;
  retryAfterMs?: number;
}

/**
 * CloudJobClient handles authenticated async job polling, exponential backoff,
 * terminal failure extraction, and size/digest-verified artifact retrieval.
 *
 * CRITICAL SECURITY INVARIANTS:
 * - Downloaded tool bytes are NEVER executed or activated by this client.
 * - Presigned URLs are NEVER persisted or cached long-term.
 */
export class CloudJobClient {
  private readonly credentialStore: CloudCredentialStore;
  private readonly identityProvider: (options?: {
    forceRefresh?: boolean;
  }) => Promise<CloudRequestIdentity | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl?: string;
  private readonly defaultPollOptions: JobPollOptions;
  private readonly defaultDownloadOptions: ArtifactDownloadOptions;

  constructor(options: CloudJobClientOptions = {}) {
    this.credentialStore = options.credentialStore ?? new CloudCredentialStore();
    this.identityProvider =
      options.identityProvider ??
      (async (opts) => {
        return this.credentialStore.getRequestIdentity({
          forceRefresh: opts?.forceRefresh,
        });
      });
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = options.baseUrl;
    this.defaultPollOptions = {
      maxWaitMs: options.defaultPollOptions?.maxWaitMs ?? DEFAULT_MAX_POLL_WAIT_MS,
      initialIntervalMs:
        options.defaultPollOptions?.initialIntervalMs ?? DEFAULT_INITIAL_POLL_INTERVAL_MS,
      maxIntervalMs: options.defaultPollOptions?.maxIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      backoffFactor: options.defaultPollOptions?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
    };
    this.defaultDownloadOptions = {
      maxSizeBytes: options.defaultDownloadOptions?.maxSizeBytes ?? DEFAULT_MAX_ARTIFACT_SIZE_BYTES,
    };
  }

  private resolveStatusEndpoint(statusUrlOrJobId: string, cloudUrl?: string): string {
    if (statusUrlOrJobId.startsWith("http://") || statusUrlOrJobId.startsWith("https://")) {
      return statusUrlOrJobId;
    }

    const base = (this.baseUrl ?? cloudUrl ?? "").replace(/\/+$/, "");
    if (statusUrlOrJobId.startsWith("/")) {
      return `${base}${statusUrlOrJobId}`;
    }

    return `${base}/v1/jobs/${encodeURIComponent(statusUrlOrJobId)}`;
  }

  /**
   * Executes an authenticated GET request for job status with single forced token refresh on 401.
   */
  private async executeFetchJobStatus(
    url: string,
    identity: CloudRequestIdentity,
    signal?: AbortSignal,
    isRetry = false,
  ): Promise<InternalJobStatusFetchResult> {
    if (signal?.aborted) {
      throw new JobAbortedError("Job status request was aborted");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${identity.accessToken}`,
          "x-account-id": identity.accountId,
          "x-workspace-id": identity.workspaceId,
          "x-device-id": identity.deviceId,
          "x-installation-id": identity.installationId,
          "x-protocol-version": PROTOCOL_VERSION,
        },
        signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new JobAbortedError("Job status request was aborted");
      }
      throw new ProtocolError(
        "retryable",
        `Failed to reach cloud job endpoint: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // Handle 401 with a single forced-refresh retry
    if (response.status === 401 && !isRetry) {
      const refreshedIdentity = await this.identityProvider({ forceRefresh: true });
      if (refreshedIdentity) {
        return this.executeFetchJobStatus(url, refreshedIdentity, signal, true);
      }
      throw new ProtocolError(
        "unauthorized",
        "Job status request rejected (401 Unauthorized) and token refresh failed",
        { status: 401 },
      );
    }

    if (response.status === 401) {
      throw new ProtocolError("unauthorized", "Job status request rejected (401 Unauthorized)", {
        status: 401,
      });
    }

    if (response.status === 404) {
      throw new ProtocolError("not_found", `Job status endpoint not found: ${url}`, {
        status: 404,
      });
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
      throw new RateLimitedError("Job status polling rate limited (429)", {
        retryAfterMs,
      });
    }

    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        // ignore
      }
      throw new ProtocolError(
        response.status >= 500 ? "retryable" : "validation",
        `Job status request failed with HTTP ${response.status}: ${bodyText}`,
        { status: response.status },
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err: unknown) {
      throw new JobMalformedResponseError("Invalid JSON in job status response", { cause: err });
    }

    const parsed = JobStatusResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new JobMalformedResponseError(
        `Job status schema validation failed: ${parsed.error.message}`,
        { issues: parsed.error.issues, rawJson: json },
      );
    }

    const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
    return {
      statusResponse: parsed.data,
      retryAfterMs,
    };
  }

  /**
   * Fetches the current job status once.
   */
  async getJobStatus(statusUrlOrJobId: string, signal?: AbortSignal): Promise<JobStatusResponse> {
    const identity = await this.identityProvider();
    if (!identity) {
      throw new ProtocolError(
        "unauthorized",
        "No active cloud credentials available for job status lookup",
        { status: 401 },
      );
    }

    const targetUrl = this.resolveStatusEndpoint(statusUrlOrJobId, identity.cloudUrl);
    const result = await this.executeFetchJobStatus(targetUrl, identity, signal);
    return result.statusResponse;
  }

  /**
   * Polls an async job until completion or failure with bounded exponential backoff.
   */
  async pollJob(
    statusUrlOrJobId: string,
    options: JobPollOptions = {},
  ): Promise<JobStatusResponse> {
    const maxWaitMs =
      options.maxWaitMs ?? this.defaultPollOptions.maxWaitMs ?? DEFAULT_MAX_POLL_WAIT_MS;
    const initialIntervalMs =
      options.initialIntervalMs ??
      this.defaultPollOptions.initialIntervalMs ??
      DEFAULT_INITIAL_POLL_INTERVAL_MS;
    const maxIntervalMs =
      options.maxIntervalMs ??
      this.defaultPollOptions.maxIntervalMs ??
      DEFAULT_MAX_POLL_INTERVAL_MS;
    const backoffFactor =
      options.backoffFactor ?? this.defaultPollOptions.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    const signal = options.signal;

    const startTime = Date.now();
    let currentInterval = initialIntervalMs;

    const identity = await this.identityProvider();
    if (!identity) {
      throw new ProtocolError(
        "unauthorized",
        "No active cloud credentials available for job polling",
        { status: 401 },
      );
    }
    const targetUrl = this.resolveStatusEndpoint(statusUrlOrJobId, identity.cloudUrl);
    while (true) {
      if (signal?.aborted) {
        throw new JobAbortedError("Job polling was aborted", statusUrlOrJobId);
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        throw new JobTimeoutError(statusUrlOrJobId, elapsed);
      }

      const { statusResponse, retryAfterMs } = await this.executeFetchJobStatus(
        targetUrl,
        identity,
        signal,
      );

      if (statusResponse.status === "completed") {
        return statusResponse;
      }

      if (statusResponse.status === "failed") {
        throw new JobFailedError(
          statusResponse.jobId,
          statusResponse.error ?? "Asynchronous job reported failure",
          {
            failureReason: statusResponse.error,
            errorCode: statusResponse.errorCode,
            details: statusResponse.details,
          },
        );
      }

      // Status is "accepted" | "queued" | "running" -> calculate next interval
      let waitMs = currentInterval;
      if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
        waitMs = retryAfterMs;
      } else {
        currentInterval = Math.min(Math.round(currentInterval * backoffFactor), maxIntervalMs);
      }

      const remainingMs = maxWaitMs - (Date.now() - startTime);
      if (remainingMs <= 0) {
        throw new JobTimeoutError(statusUrlOrJobId, Date.now() - startTime);
      }

      const sleepDuration = Math.min(waitMs, remainingMs);
      await sleep(sleepDuration, signal);
    }
  }

  /**
   * Downloads an artifact (result payload or tool archive) from a presigned GET URL.
   * Enforces configured maximum byte size and verifies exact SHA-256 digest before returning.
   *
   * NEVER executes or activates downloaded tool bytes.
   */
  async downloadArtifact(
    downloadUrl: string,
    options: ArtifactDownloadOptions = {},
  ): Promise<DownloadedArtifact> {
    const maxSizeBytes =
      options.maxSizeBytes ??
      this.defaultDownloadOptions.maxSizeBytes ??
      DEFAULT_MAX_ARTIFACT_SIZE_BYTES;
    const signal = options.signal;

    if (signal?.aborted) {
      throw new JobAbortedError("Artifact download was aborted");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(downloadUrl, {
        method: "GET",
        signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new JobAbortedError("Artifact download was aborted");
      }
      throw new ProtocolError(
        "retryable",
        `Failed to download artifact: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new ProtocolError(
        response.status >= 500 ? "retryable" : "terminal",
        `Artifact download failed with HTTP ${response.status}: ${response.statusText}`,
        { status: response.status },
      );
    }

    const bytes = await readBodyWithLimit(response, maxSizeBytes, signal);

    // Compute actual SHA-256
    const actualDigestHex = createHash("sha256").update(bytes).digest("hex");

    // Check against expectedSha256 if supplied
    if (options.expectedSha256) {
      const normalizedExpected = normalizeSha256Digest(options.expectedSha256);
      if (normalizedExpected && normalizedExpected !== actualDigestHex) {
        throw new ArtifactIntegrityError(options.expectedSha256, actualDigestHex);
      }
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: actualDigestHex,
      contentType,
    };
  }

  /**
   * Retrieves verified result and tool payloads from a completed job status response.
   */
  async fetchJobArtifacts(
    statusResponse: JobStatusResponse,
    options: ArtifactDownloadOptions = {},
  ): Promise<{
    resultArtifact?: DownloadedArtifact;
    toolArtifact?: DownloadedArtifact;
  }> {
    let resultArtifact: DownloadedArtifact | undefined;
    let toolArtifact: DownloadedArtifact | undefined;

    // 1. Download result payload if downloadUrl or descriptor available
    const resultUrl = statusResponse.downloadUrl ?? statusResponse.result?.downloadUrl;
    const expectedResultSha =
      statusResponse.sha256 ??
      statusResponse.result?.sha256 ??
      statusResponse.descriptor?.sha256 ??
      statusResponse.result?.descriptor?.sha256;
    const expectedResultSize =
      statusResponse.sizeBytes ??
      statusResponse.result?.sizeBytes ??
      statusResponse.descriptor?.sizeBytes ??
      statusResponse.result?.descriptor?.sizeBytes ??
      statusResponse.descriptor?.size ??
      statusResponse.result?.descriptor?.size;

    if (resultUrl) {
      resultArtifact = await this.downloadArtifact(resultUrl, {
        ...options,
        expectedSha256: expectedResultSha,
        maxSizeBytes: expectedResultSize ?? options.maxSizeBytes,
      });
    }

    // 2. Download tool payload if tool descriptor with downloadUrl is available
    const toolUrl = statusResponse.tool?.downloadUrl ?? statusResponse.result?.tool?.downloadUrl;
    const expectedToolSha =
      statusResponse.tool?.sha256 ??
      statusResponse.tool?.descriptor?.sha256 ??
      statusResponse.result?.tool?.sha256 ??
      statusResponse.result?.tool?.descriptor?.sha256;
    const expectedToolSize =
      statusResponse.tool?.sizeBytes ??
      statusResponse.tool?.descriptor?.sizeBytes ??
      statusResponse.tool?.descriptor?.size ??
      statusResponse.result?.tool?.sizeBytes ??
      statusResponse.result?.tool?.descriptor?.sizeBytes ??
      statusResponse.result?.tool?.descriptor?.size;

    if (toolUrl) {
      toolArtifact = await this.downloadArtifact(toolUrl, {
        ...options,
        expectedSha256: expectedToolSha,
        maxSizeBytes: expectedToolSize ?? options.maxSizeBytes,
      });
    }

    return { resultArtifact, toolArtifact };
  }
}
