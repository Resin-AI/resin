import crypto from "node:crypto";
import { ProtocolError, ValidationError } from "@resin/protocol";
import { describe, expect, it, vi } from "vitest";
import { CloudCatalogClient } from "../../src/proxy/client.js";

function bytesResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/gzip", ...headers },
  });
}

describe("CloudCatalogClient artifact download", () => {
  const artifact = Buffer.from("deterministic bundle bytes");
  const digest = crypto.createHash("sha256").update(artifact).digest("hex");

  it("downloads through the public digest route with identity headers and verifies the digest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(bytesResponse(artifact, { "x-manifest-sha256": "m".repeat(64) }));
    const client = new CloudCatalogClient({
      identityProvider: async () => ({
        cloudUrl: "https://cloud.resin.local",
        accessToken: "token-1",
        accountId: "acc-1",
        workspaceId: "ws-1",
        deviceId: "dev-1",
        installationId: "inst-1",
        userId: "user-1",
      }),
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const result = await client.downloadArtifact(`sha256:${digest}`);
    expect(result.digest).toBe(digest);
    expect(Buffer.compare(result.bytes, artifact)).toBe(0);
    expect(result.manifestDigest).toBe("m".repeat(64));

    // SAFETY: fetchMock was called once with [url, init] arguments.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cloud.resin.local/v1/artifacts/${digest}/download?workspaceId=ws-1`);
    // SAFETY: RequestInit headers passed as record in test fetch.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-1");
    expect(headers["x-workspace-id"]).toBe("ws-1");
    expect(headers["x-device-id"]).toBe("dev-1");
  });

  it("rejects bytes that do not hash to the requested digest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(bytesResponse(Buffer.from("tampered")));
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "token-1",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.downloadArtifact(digest)).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps 404 responses to terminal protocol errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404, statusText: "Not Found" }));
    const client = new CloudCatalogClient({
      workspaceId: "ws-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "token-1",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.downloadArtifact(digest)).rejects.toBeInstanceOf(ProtocolError);
  });
});
