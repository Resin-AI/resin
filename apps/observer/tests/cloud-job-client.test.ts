import { createHash } from "node:crypto";
import {
  ArtifactIntegrityError,
  ArtifactSizeExceededError,
  JobAbortedError,
  JobFailedError,
  JobMalformedResponseError,
  JobTimeoutError,
  ProtocolError,
  RateLimitedError,
} from "@resin/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CloudRequestIdentity } from "../src/cloud-credentials.js";
import {
  CloudJobClient,
  normalizeSha256Digest,
  parseRetryAfterHeader,
} from "../src/cloud-job-client.js";
import { CloudObservationClient } from "../src/cloud-runtime.js";

function makeTestIdentity(overrides: Partial<CloudRequestIdentity> = {}): CloudRequestIdentity {
  return {
    accountId: "acc-test-1",
    workspaceId: "ws-test-1",
    deviceId: "dev-test-1",
    installationId: "inst-test-1",
    userId: "user-test-1",
    accessToken: "jwt-test-token-valid",
    cloudUrl: "https://api.resin.local",
    ...overrides,
  };
}

function makeFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  // SAFETY: Test mock wrapper conforms to global fetch function signature.
  return fn as typeof fetch;
}

function jsonResponse<T>(
  data: T,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("CloudJobClient & Helpers", () => {
  it("normalizes sha256 digests correctly", () => {
    expect(normalizeSha256Digest(undefined)).toBeUndefined();
    expect(normalizeSha256Digest("   ")).toBe("");
    expect(
      normalizeSha256Digest(
        "sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
      ),
    ).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(
      normalizeSha256Digest("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"),
    ).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("parses HTTP Retry-After headers in seconds and HTTP-date formats", () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("5")).toBe(5000);
    expect(parseRetryAfterHeader("2.5")).toBe(2500);

    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const parsedMs = parseRetryAfterHeader(futureDate);
    expect(parsedMs).toBeGreaterThan(8000);
    expect(parsedMs).toBeLessThanOrEqual(11000);

    expect(parseRetryAfterHeader("invalid-date-string")).toBeUndefined();
  });

  it("fetches job status with authentication headers and returns validated response", async () => {
    const identity = makeTestIdentity();
    const fetchMock = makeFetch(
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: "job-100",
          status: "running",
          progress: 45,
        }),
      ),
    );

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
    });

    const status = await client.getJobStatus("/v1/jobs/job-100");
    expect(status.jobId).toBe("job-100");
    expect(status.status).toBe("running");
    expect(status.progress).toBe(45);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.resin.local/v1/jobs/job-100");
    expect(calledInit.headers.Authorization).toBe("Bearer jwt-test-token-valid");
    expect(calledInit.headers["x-account-id"]).toBe("acc-test-1");
  });

  it("handles 401 on job status lookup with one forced token refresh retry", async () => {
    let callCount = 0;
    const initialIdentity = makeTestIdentity({ accessToken: "expired-token" });
    const refreshedIdentity = makeTestIdentity({ accessToken: "fresh-token" });

    const identityProviderMock = vi
      .fn()
      .mockImplementation(async (opts?: { forceRefresh?: boolean }) => {
        return opts?.forceRefresh ? refreshedIdentity : initialIdentity;
      });

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      callCount++;
      const authHeader = init?.headers?.Authorization;
      if (authHeader === "Bearer expired-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      return jsonResponse({
        jobId: "job-101",
        status: "completed",
        downloadUrl: "https://s3.amazonaws.com/results/101.json",
      });
    });

    const client = new CloudJobClient({
      identityProvider: identityProviderMock,
      fetchImpl: fetchMock,
    });

    const status = await client.getJobStatus("job-101");
    expect(status.status).toBe("completed");
    expect(callCount).toBe(2);
    expect(identityProviderMock).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("throws ProtocolError(unauthorized) when 401 persists after forced token refresh", async () => {
    const identity = makeTestIdentity();
    const fetchMock = makeFetch(
      vi.fn().mockImplementation(async () => new Response("Unauthorized", { status: 401 })),
    );

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
    });

    try {
      await client.getJobStatus("job-102");
      expect.unreachable("Should have thrown ProtocolError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ProtocolError);
      // SAFETY: err is verified as ProtocolError by the preceding assertion.
      const protoErr = err as ProtocolError;
      expect(protoErr.code).toBe("unauthorized");
      expect(protoErr.status).toBe(401);
    }
  });

  it("throws ProtocolError(not_found) on 404 and RateLimitedError on 429", async () => {
    const identity = makeTestIdentity();
    const notFoundFetch = makeFetch(
      vi.fn().mockImplementation(async () => new Response("Not Found", { status: 404 })),
    );

    const client404 = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: notFoundFetch,
    });
    try {
      await client404.getJobStatus("job-missing");
      expect.unreachable("Should have thrown ProtocolError");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ProtocolError);
      // SAFETY: err is verified as ProtocolError by the preceding assertion.
      const protoErr = err as ProtocolError;
      expect(protoErr.code).toBe("not_found");
      expect(protoErr.status).toBe(404);
    }
    const rateLimitFetch = makeFetch(
      vi
        .fn()
        .mockResolvedValue(
          new Response("Too Many Requests", { status: 429, headers: { "retry-after": "10" } }),
        ),
    );

    const client429 = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: rateLimitFetch,
    });
    await expect(client429.getJobStatus("job-limited")).rejects.toThrow(RateLimitedError);
  });

  it("throws JobMalformedResponseError when response JSON or schema is invalid", async () => {
    const identity = makeTestIdentity();
    const invalidJsonFetch = makeFetch(
      vi.fn().mockResolvedValue(
        new Response("INVALID_JSON{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const clientBadJson = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: invalidJsonFetch,
    });
    await expect(clientBadJson.getJobStatus("job-bad-json")).rejects.toThrow(
      JobMalformedResponseError,
    );

    const invalidSchemaFetch = makeFetch(
      vi.fn().mockResolvedValue(
        jsonResponse({
          // missing required jobId and invalid status
          status: "not-a-valid-status",
        }),
      ),
    );

    const clientBadSchema = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: invalidSchemaFetch,
    });
    await expect(clientBadSchema.getJobStatus("job-bad-schema")).rejects.toThrow(
      JobMalformedResponseError,
    );
  });

  it("polls job through queued -> running -> completed transitions", async () => {
    const identity = makeTestIdentity();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async () => {
      pollCount++;
      let status = "queued";
      if (pollCount === 2) status = "running";
      if (pollCount >= 3) status = "completed";

      return jsonResponse(
        {
          jobId: "job-poll-1",
          status,
          downloadUrl:
            status === "completed" ? "https://s3.amazonaws.com/results/res.json" : undefined,
          sha256:
            status === "completed"
              ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
              : undefined,
        },
        { headers: { "retry-after": "0.01" } },
      );
    });

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
      defaultPollOptions: {
        initialIntervalMs: 10,
        maxIntervalMs: 50,
      },
    });

    const finalStatus = await client.pollJob("job-poll-1", { maxWaitMs: 2000 });
    expect(finalStatus.status).toBe("completed");
    expect(pollCount).toBe(3);
  });

  it("throws JobFailedError when polling observes a failed job status", async () => {
    const identity = makeTestIdentity();
    const fetchMock = makeFetch(
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: "job-fail",
          status: "failed",
          error: "Memory allocation failed in worker Lambda",
          errorCode: "terminal",
          details: { exitCode: 137 },
        }),
      ),
    );

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
    });

    await expect(client.pollJob("job-fail", { maxWaitMs: 1000 })).rejects.toThrow(JobFailedError);
  });

  it("throws JobTimeoutError when polling duration exceeds maxWaitMs", async () => {
    const identity = makeTestIdentity();
    const fetchMock = makeFetch(
      vi.fn().mockImplementation(async () =>
        jsonResponse(
          {
            jobId: "job-timeout",
            status: "running",
          },
          { headers: { "retry-after": "0.05" } },
        ),
      ),
    );

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
      defaultPollOptions: {
        initialIntervalMs: 50,
      },
    });
    await expect(client.pollJob("job-timeout", { maxWaitMs: 100 })).rejects.toThrow(
      JobTimeoutError,
    );
  });

  it("throws JobAbortedError when AbortSignal is triggered", async () => {
    const identity = makeTestIdentity();
    const controller = new AbortController();
    controller.abort();

    const client = new CloudJobClient({
      identityProvider: async () => identity,
      fetchImpl: makeFetch(vi.fn()),
    });

    await expect(client.pollJob("job-aborted", { signal: controller.signal })).rejects.toThrow(
      JobAbortedError,
    );
  });

  it("downloads artifact from presigned URL and verifies SHA-256 digest", async () => {
    const samplePayload = JSON.stringify({ result: "success", score: 98 });
    const sampleBytes = new TextEncoder().encode(samplePayload);
    const expectedSha256 = createHash("sha256").update(sampleBytes).digest("hex");

    const fetchMock = makeFetch(
      vi.fn().mockResolvedValue(
        new Response(sampleBytes, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(sampleBytes.byteLength),
          },
        }),
      ),
    );

    const client = new CloudJobClient({
      fetchImpl: fetchMock,
    });

    const downloaded = await client.downloadArtifact(
      "https://s3.amazonaws.com/test-bucket/results/res.json?X-Amz-Signature=xyz",
      {
        expectedSha256: `sha256:${expectedSha256}`,
      },
    );

    expect(downloaded.sizeBytes).toBe(sampleBytes.byteLength);
    expect(downloaded.sha256).toBe(expectedSha256);
    expect(new TextDecoder().decode(downloaded.bytes)).toBe(samplePayload);

    // Verify S3 request does not include device bearer Authorization header
    const [, fetchInit] = fetchMock.mock.calls[0];
    expect(fetchInit?.headers?.Authorization).toBeUndefined();
  });

  it("rejects artifact download when SHA-256 digest does not match expected", async () => {
    const samplePayload = "tampered or corrupted content";
    const sampleBytes = new TextEncoder().encode(samplePayload);

    const fetchMock = makeFetch(
      vi.fn().mockResolvedValue(
        new Response(sampleBytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );

    const client = new CloudJobClient({
      fetchImpl: fetchMock,
    });

    await expect(
      client.downloadArtifact("https://s3.amazonaws.com/test-bucket/results/bad.bin", {
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow(ArtifactIntegrityError);
  });

  it("rejects artifact download when declared Content-Length or payload exceeds maxSizeBytes", async () => {
    const oversizedFetch = makeFetch(
      vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(10), {
          status: 200,
          headers: { "content-length": "100000000" },
        }),
      ),
    );

    const client = new CloudJobClient({
      fetchImpl: oversizedFetch,
    });

    await expect(
      client.downloadArtifact("https://s3.amazonaws.com/test-bucket/results/huge.bin", {
        maxSizeBytes: 1024, // 1KB limit
      }),
    ).rejects.toThrow(ArtifactSizeExceededError);
  });

  it("downloads result and tool artifacts together via fetchJobArtifacts without executing them", async () => {
    const resultPayload = JSON.stringify({ modelOutput: "optimized code" });
    const resultBytes = new TextEncoder().encode(resultPayload);
    const resultSha = createHash("sha256").update(resultBytes).digest("hex");

    const toolPayload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip header bytes
    const toolSha = createHash("sha256").update(toolPayload).digest("hex");

    const fetchMock = makeFetch(
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("result.json")) {
          return new Response(resultBytes, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("tool.tar.gz")) {
          return new Response(toolPayload, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const client = new CloudJobClient({
      fetchImpl: fetchMock,
    });

    const statusResponse = {
      jobId: "job-with-tools",
      status: "completed",
      downloadUrl: "https://s3.amazonaws.com/results/result.json",
      sha256: resultSha,
      tool: {
        toolId: "tool-test-1",
        version: "1.0.0",
        downloadUrl: "https://s3.amazonaws.com/tools/tool.tar.gz",
        sha256: toolSha,
      },
    };

    const { resultArtifact, toolArtifact } = await client.fetchJobArtifacts(statusResponse);

    expect(resultArtifact).toBeDefined();
    expect(resultArtifact?.sha256).toBe(resultSha);
    expect(new TextDecoder().decode(resultArtifact?.bytes)).toBe(resultPayload);

    expect(toolArtifact).toBeDefined();
    expect(toolArtifact?.sha256).toBe(toolSha);
    expect(toolArtifact?.bytes).toEqual(toolPayload);
  });
});

describe("CloudObservationClient End-to-End sendBatchAndFetchResult", () => {
  it("handles synchronous batch response without async job fields", async () => {
    const identity = makeTestIdentity();
    const fetchMock = makeFetch(
      vi.fn().mockResolvedValue(
        jsonResponse({
          batchId: "batch-sync-1",
          status: "accepted",
          acceptedCount: 5,
          rejectedCount: 0,
        }),
      ),
    );

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
    });

    const result = await client.sendBatchAndFetchResult({
      batchId: "batch-sync-1",
      observations: [],
    });

    expect(result.jobId).toBe("batch-sync-1");
    expect(result.status).toBe("completed");
    expect(result.resultBytes).toBeUndefined();
  });

  it("handles asynchronous batch response driving ingestion -> poll -> verified download", async () => {
    const identity = makeTestIdentity();
    const resultPayload = JSON.stringify({
      summary: "Batch processed successfully",
      candidatesGenerated: 2,
    });
    const resultBytes = new TextEncoder().encode(resultPayload);
    const resultSha = createHash("sha256").update(resultBytes).digest("hex");

    let pollStep = 0;
    const fetchMock = makeFetch(
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        // 1. Ingestion POST
        if (url.endsWith("/v1/observations/batch")) {
          return jsonResponse({
            batchId: "batch-async-1",
            status: "accepted",
            acceptedCount: 10,
            rejectedCount: 0,
            jobId: "job-async-777",
            statusUrl: "https://api.resin.local/v1/jobs/job-async-777",
          });
        }

        // 2. Job Polling GET
        if (url.includes("/v1/jobs/job-async-777")) {
          pollStep++;
          const status = pollStep < 2 ? "running" : "completed";
          return jsonResponse(
            {
              jobId: "job-async-777",
              status,
              downloadUrl:
                status === "completed"
                  ? "https://s3.amazonaws.com/results/res-777.json?sig=123"
                  : undefined,
              sha256: status === "completed" ? resultSha : undefined,
              sizeBytes: status === "completed" ? resultBytes.byteLength : undefined,
            },
            { headers: { "retry-after": "0.01" } },
          );
        }

        // 3. Presigned S3 GET
        if (url.includes("res-777.json")) {
          return new Response(resultBytes, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const client = new CloudObservationClient({
      identityProvider: async () => identity,
      fetchImpl: fetchMock,
    });

    const result = await client.sendBatchAndFetchResult({
      batchId: "batch-async-1",
      observations: [],
    });

    expect(result.jobId).toBe("job-async-777");
    expect(result.status).toBe("completed");
    expect(result.resultSha256).toBe(resultSha);
    expect(result.resultBytes).toBeDefined();
    expect(new TextDecoder().decode(result.resultBytes)).toBe(resultPayload);
  });
});
