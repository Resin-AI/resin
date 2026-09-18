import type { StoredCloudCredentials } from "@resin/observer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAccountProfile } from "../src/service/account-profile.js";

const credentials: StoredCloudCredentials = {
  cloudUrl: "https://cloud.example.com",
  accessToken: "access-token-not-for-display",
  refreshToken: "refresh-token-not-for-display",
  deviceId: "device-1",
  workspaceId: "workspace-1",
  storedAt: "2026-09-18T00:00:00.000Z",
  claims: {
    accountId: "account-1",
    userId: "user-1",
    subject: "user-1",
    deviceId: "device-1",
    installationId: "installation-1",
    workspaceId: "workspace-1",
    scopes: ["catalog:read"],
    rawUploadConsent: false,
    issuedAt: "2026-09-18T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    tokenType: "access",
  },
};
const profile = {
  schemaVersion: "1.0.0",
  accountId: "account-1",
  userId: "user-1",
  email: "member@example.com",
  membershipType: "pro",
};

afterEach(() => vi.restoreAllMocks());

describe("account profile lookup", () => {
  it("uses the credential issuer and a bounded non-redirecting bearer request", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(profile));
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);

    expect(await fetchAccountProfile(credentials, request)).toEqual(profile);
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://cloud.example.com/v1/account/profile",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.accessToken}`,
          "Cache-Control": "no-store",
        },
        redirect: "error",
        signal: controller.signal,
      },
    );
  });

  it.each([
    { accountId: "another-account" },
    { userId: "another-user" },
    { email: "opaque-user-id" },
    { membershipType: "admin" },
  ])("discards mismatched or invalid profile data %j", async (overrides) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...profile, ...overrides }));
    expect(await fetchAccountProfile(credentials, request)).toBeNull();
  });

  it.each([401, 403, 404, 503])(
    "treats HTTP %s as unavailable without refreshing credentials",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
      expect(await fetchAccountProfile(credentials, request)).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("treats network and malformed JSON failures as unavailable", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("not json"));
    expect(await fetchAccountProfile(credentials, request)).toBeNull();
    expect(await fetchAccountProfile(credentials, request)).toBeNull();
  });

  it("rejects a redirected response even if its profile matches", async () => {
    const response = Response.json(profile);
    Object.defineProperty(response, "redirected", { value: true });
    expect(
      await fetchAccountProfile(credentials, vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).toBeNull();
  });

  it("rejects an oversized body and strips unrelated response fields", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...profile, padding: "x".repeat(4_096) }))
      .mockResolvedValueOnce(Response.json({ ...profile, accessToken: "never-display" }));
    expect(await fetchAccountProfile(credentials, request)).toBeNull();
    expect(await fetchAccountProfile(credentials, request)).toEqual(profile);
  });

  it.each([
    "http://remote.example.com",
    "https://user:secret@cloud.example.com",
    "https://cloud.example.com?token=secret",
  ])("does not send credentials to an unsafe issuer %s", async (cloudUrl) => {
    const request = vi.fn<typeof fetch>();
    expect(await fetchAccountProfile({ ...credentials, cloudUrl }, request)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("supports loopback local cloud without weakening identity binding", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(profile));
    expect(
      await fetchAccountProfile({ ...credentials, cloudUrl: "http://127.0.0.1:4200" }, request),
    ).toEqual(profile);
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4200/v1/account/profile");
  });
});
