/**
 * The cloud withholds segment tools and segment validation asks from a device that does not
 * declare `and-chain-segments-v1` and `-v2`, per request. Every request that fetches the catalog, a tool
 * artifact or an invocation must therefore declare what this device supports.
 */
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudCatalogClient } from "../../src/proxy/client.js";
import { CloudInvocationRouter } from "../../src/proxy/router.js";

const HEADER = "x-resin-workflow-validation-capabilities";
const identity = async () => ({
  cloudUrl: "https://cloud.resin.local",
  accessToken: "token-1",
  accountId: "acc-1",
  workspaceId: "ws-1",
  deviceId: "dev-1",
  installationId: "inst-1",
  userId: "user-1",
});
const declared = (init: RequestInit | undefined): string[] =>
  String(new Headers(init?.headers).get(HEADER) ?? "").split(",");

describe("the workflow capabilities a device declares", () => {
  it("are sent when fetching the catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const client = new CloudCatalogClient({
      identityProvider: identity,
      workspaceId: "ws-1",
      deviceId: "dev-1",
      fetchFn: fetchMock,
    });
    await client.fetchCatalogSnapshot().catch(() => undefined);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(declared(init)).toEqual(
      expect.arrayContaining(["and-chain-segments-v1", "and-chain-segments-v2"]),
    );
  });

  it("are sent when downloading a tool artifact", async () => {
    const bytes = Buffer.from("bundle");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    const client = new CloudCatalogClient({ identityProvider: identity, fetchFn: fetchMock });
    await client.downloadArtifact(digest);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(declared(init)).toEqual(
      expect.arrayContaining(["and-chain-segments-v1", "and-chain-segments-v2"]),
    );
  });

  it("are sent when invoking a cloud tool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }),
      );
    const router = new CloudInvocationRouter({ identityProvider: identity, fetchFn: fetchMock });
    await router
      .forwardInvocation("report", {}, {
        workspaceId: "ws-1",
        sessionId: "s-1",
        workspaceRoot: "/w",
        canonicalRoot: "/w",
        isSymlinked: false,
        symlinkChain: [],
      } as never)
      .catch(() => undefined);
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/invoke"));
    expect(declared((call as [string, RequestInit])[1])).toEqual(
      expect.arrayContaining(["and-chain-segments-v1", "and-chain-segments-v2"]),
    );
  });
});
