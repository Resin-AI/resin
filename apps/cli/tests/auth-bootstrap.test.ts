import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecretManager } from "@resin/crypto";
import type { DeviceAuthBootstrapResponse, DeviceTokenExchangeResponse } from "@resin/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEVICE_AUTH_SCOPES,
  DeviceAuthClient,
  type StoredDeviceCredentials,
  isReusableCredentialRecord,
} from "../src/service/auth-bootstrap.js";

describe("DeviceAuthClient & Auth Bootstrap", () => {
  let tempDir: string;
  let tokenFilePath: string;
  let vaultPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "te-auth-test-"));
    tokenFilePath = path.join(tempDir, "device-token.json");
    vaultPath = path.join(tempDir, "vault.json");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("requests device authorization code from cloud endpoint", async () => {
    const mockBootstrapResponse: DeviceAuthBootstrapResponse = {
      deviceCode: "device_code_1234567890abcdef",
      userCode: "ABCD-9876",
      verificationUri: "https://auth.resin.sh/device",
      verificationUriComplete: "https://auth.resin.sh/device?code=ABCD-9876",
      expiresIn: 900,
      interval: 1,
    };

    const mockFetch = vi.fn().mockResolvedValue(Response.json(mockBootstrapResponse));

    const client = new DeviceAuthClient({
      cloudUrl: "https://mock-cloud.resin.sh",
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    const response = await client.requestDeviceCode({
      deviceId: "dev_mock_test",
      workspaceId: "ws_test_1",
    });

    expect(response.userCode).toBe("ABCD-9876");
    expect(response.deviceCode).toBe("device_code_1234567890abcdef");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mock-cloud.resin.sh/v1/auth/device/code",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "dev_mock_test",
          installationId: "inst_dev_mock_test",
          hostname: os.hostname() || "localhost",
          platform:
            process.platform === "darwin"
              ? "darwin"
              : process.platform === "linux"
                ? "linux"
                : "other",
          arch: process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other",
          clientVersion: "1.0.0",
          scopes: [
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
          ],
        }),
      }),
    );
  });

  it("reuses only fully scoped ordinary credentials and rejects legacy refresh families", () => {
    const issuedAt = new Date().toISOString();
    const credentials: StoredDeviceCredentials = {
      cloudUrl: "https://api.resin.sh",
      accessToken: "atk_current_scope_family",
      refreshToken: "rtk_current_scope_family",
      claims: {
        accountId: "acc_scope_upgrade",
        deviceId: "dev_scope_upgrade",
        installationId: "inst_scope_upgrade",
        workspaceId: "ws_scope_upgrade",
        scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
        rawUploadConsent: false,
        issuedAt,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenType: "access",
        subject: "usr_scope_upgrade",
        familyId: "fam_scope_upgrade",
      },
      deviceId: "dev_scope_upgrade",
      workspaceId: "ws_scope_upgrade",
      storedAt: issuedAt,
    };

    expect(DEFAULT_DEVICE_AUTH_SCOPES).not.toContain("privacy:delete");
    expect(isReusableCredentialRecord(credentials, "https://api.resin.sh")).toBe(true);

    for (const missingScope of DEFAULT_DEVICE_AUTH_SCOPES) {
      const legacyFamily = {
        ...credentials,
        claims: {
          ...credentials.claims,
          scopes: DEFAULT_DEVICE_AUTH_SCOPES.filter((scope) => scope !== missingScope),
        },
      };
      expect(
        isReusableCredentialRecord(legacyFamily, "https://api.resin.sh"),
        `credential family missing ${missingScope} must require fresh approval`,
      ).toBe(false);
    }

    const overPrivilegedFamily: StoredDeviceCredentials = {
      ...credentials,
      claims: {
        ...credentials.claims,
        scopes: [...DEFAULT_DEVICE_AUTH_SCOPES, "privacy:delete"],
      },
    };
    expect(isReusableCredentialRecord(overPrivilegedFamily, "https://api.resin.sh")).toBe(false);
  });
  it("uses a one-time privacy:delete authorization without persisting it", async () => {
    vi.useFakeTimers();
    const ordinaryCredentialMarker = "ordinary-device-credential";
    const elevatedAccessToken = "atk_one_time_privacy_delete_access_token";
    const elevatedRefreshToken = "rtk_one_time_privacy_delete_refresh_token";
    await fs.writeFile(tokenFilePath, ordinaryCredentialMarker);

    const mockFetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/code")) {
        return Response.json({
          deviceCode: "device_code_privacy_delete_step_up",
          userCode: "DELE-1234",
          verificationUri: "https://auth.resin.sh/device",
          verificationUriComplete:
            "https://auth.resin.sh/device?user_code=DELE-1234&approval_nonce=nonce",
          expiresIn: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/v1/auth/device/token")) {
        const issuedAt = new Date(Date.now()).toISOString();
        return Response.json({
          accessToken: elevatedAccessToken,
          refreshToken: elevatedRefreshToken,
          tokenType: "Bearer",
          expiresIn: 3600,
          claims: {
            accountId: "acc_privacy_test",
            deviceId: "dev_privacy_test",
            installationId: "inst_privacy_test",
            workspaceId: "ws_privacy_test",
            scopes: ["privacy:delete"],
            rawUploadConsent: false,
            issuedAt,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "access",
            userId: "usr_privacy_test",
            subject: "usr_privacy_test",
          },
        });
      }
      if (url.endsWith("/v1/auth/logout")) {
        // SAFETY: Mock Response object for test.
        return { ok: true } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new DeviceAuthClient({
      cloudUrl: "https://mock-cloud.resin.sh",
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });
    const onUserCodeReceived = vi.fn();

    try {
      const pendingAuthorization = client.authorizeOnce({
        deviceId: "dev_privacy_test",
        installationId: "inst_privacy_test",
        scopes: ["privacy:delete"],
        onUserCodeReceived,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const authorization = await pendingAuthorization;

      expect(onUserCodeReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          userCode: "DELE-1234",
          verificationUri: "https://auth.resin.sh/device",
        }),
      );
      expect(authorization).toMatchObject({
        accessToken: elevatedAccessToken,
        claims: { scopes: ["privacy:delete"] },
      });
      expect(await fs.readFile(tokenFilePath, "utf8")).toBe(ordinaryCredentialMarker);

      const codeRequest = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
      expect(codeRequest.scopes).toEqual(["privacy:delete"]);
      await authorization.revoke();
      await authorization.revoke();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[2]?.[1]).toMatchObject({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: elevatedRefreshToken }),
      });
      expect(mockFetch.mock.calls[2]?.[1]?.headers).not.toHaveProperty("Authorization");
      expect(await fs.readFile(tokenFilePath, "utf8")).not.toContain(elevatedAccessToken);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls for token exchange handling pending state and returning tokens", async () => {
    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_live_test_access_token_12345",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "rtk_live_test_refresh_token_67890",
      claims: {
        accountId: "acc_test_user",
        deviceId: "dev_mock_test",
        installationId: "inst_dev_mock_test",
        workspaceId: "ws_test_1",
        scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
        userId: "usr_test_user",
        subject: "usr_test_user",
      },
    };

    let pollCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      return Response.json(mockTokenResponse);
    });

    const client = new DeviceAuthClient({
      cloudUrl: "https://mock-cloud.resin.sh",
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    const tokenResult = await client.pollTokenExchange({
      deviceCode: "device_code_1234567890abcdef",
      deviceId: "dev_mock_test",
      interval: 1,
      timeoutMs: 3_000,
    });

    expect(tokenResult.accessToken).toBe("atk_live_test_access_token_12345");
    expect(tokenResult.refreshToken).toBe("rtk_live_test_refresh_token_67890");
    expect(tokenResult.claims.workspaceId).toBe("ws_test_1");
    expect(pollCount).toBe(2);
    for (const [, init] of mockFetch.mock.calls) {
      // SAFETY: RequestInit body string JSON parsing in test assertion.
      expect(JSON.parse((init as RequestInit).body as string).installationId).toBe(
        "inst_dev_mock_test",
      );
    }
  });

  it("cancels immediately while waiting between device-token polls", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();
    const client = new DeviceAuthClient({
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });
    const controller = new AbortController();

    try {
      const pending = client.pollTokenExchange({
        deviceCode: "device_code_cancelled",
        deviceId: "dev_cancelled",
        interval: 5,
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      });
      const outcome = pending.catch((error: Error | string | { message?: string }) => error);
      controller.abort();

      expect(await outcome).toMatchObject({ message: "Device authorization was cancelled" });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out at the authorization deadline without making a late poll", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn();
    const client = new DeviceAuthClient({
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    try {
      const pending = client.pollTokenExchange({
        deviceCode: "device_code_timeout",
        deviceId: "dev_timeout",
        interval: 5,
        timeoutMs: 500,
      });
      const outcome = pending.catch((error: Error | string | { message?: string }) => error);
      await vi.advanceTimersByTimeAsync(500);

      expect(await outcome).toMatchObject({
        message: "Device authorization timed out waiting for user approval",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects token responses that are bound to another installation", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        accessToken: "atk_mismatched_device_binding_token_12345",
        refreshToken: "rtk_mismatched_device_binding_token_12345",
        tokenType: "Bearer",
        expiresIn: 3600,
        claims: {
          accountId: "acc_test_user",
          deviceId: "dev_expected",
          installationId: "inst_wrong_foreign_device",
          workspaceId: "ws_test_user",
          scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          tokenType: "access",
          userId: "usr_test_user",
          subject: "usr_test_user",
        },
      }),
    );
    const client = new DeviceAuthClient({
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    try {
      const poll = client.pollTokenExchange({
        deviceCode: "device_code_binding",
        deviceId: "dev_expected",
        installationId: "inst_expected",
        interval: 1,
      });
      const outcome = poll.catch((error: Error | string | { message?: string }) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toMatchObject({
        message: expect.stringMatching(/mismatched device binding/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles authorization errors: expired_token and access_denied", async () => {
    const mockExpiredFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "expired_token" }, { status: 400 }));

    const client1 = new DeviceAuthClient({
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockExpiredFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    await expect(
      client1.pollTokenExchange({
        deviceCode: "device_code_expired",
        deviceId: "dev_1",
        interval: 0.01,
      }),
    ).rejects.toThrow("Device code has expired");

    const mockDeniedFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "access_denied" }, { status: 400 }));

    const client2 = new DeviceAuthClient({
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockDeniedFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    await expect(
      client2.pollTokenExchange({
        deviceCode: "device_code_denied",
        deviceId: "dev_1",
        interval: 0.01,
      }),
    ).rejects.toThrow("Device authorization was denied by user");
  });

  it("stores, loads, and purges credentials securely", async () => {
    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_secure_stored_token",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "rtk_secure_stored_refresh_token",
      claims: {
        accountId: "acc_1",
        deviceId: "dev_test",
        installationId: "inst_test",
        workspaceId: "ws_secure_1",
        scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
        familyId: "fam_secure_test",
        userId: "usr_1",
        subject: "usr_1",
      },
    };

    // SAFETY: Mock Response for test.
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    const client = new DeviceAuthClient({
      tokenFilePath,
      vaultPath,
      passphrase: "test-passphrase-1234",
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
    });

    // 1. Store credentials
    const storeRes = await client.storeCredentials(mockTokenResponse, "dev_test", "ws_secure_1");
    expect(storeRes.storedInSecretStore).toBe(true);
    expect(storeRes.tokenFilePath).toBe(tokenFilePath);

    // Verify token file was written
    const fileContent = await fs.readFile(tokenFilePath, "utf8");
    const parsedFile = JSON.parse(fileContent);
    expect(parsedFile.accessToken).toBe("atk_secure_stored_token");
    expect(parsedFile.workspaceId).toBe("ws_secure_1");
    expect(parsedFile.cloudUrl).toBe("https://api.resin.sh");

    // 2. Load credentials
    const loaded = await client.loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe("atk_secure_stored_token");
    expect(loaded?.workspaceId).toBe("ws_secure_1");
    expect(loaded?.cloudUrl).toBe("https://api.resin.sh");

    // 3. Revoke the stored token family through the cloud logout endpoint.
    await expect(client.revokeToken()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resin.sh/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ refreshToken: "rtk_secure_stored_refresh_token" }),
      }),
    );

    // 4. Purge credentials
    const purgeRes = await client.purgeCredentials();
    expect(purgeRes.purgedSecrets).toBe(true);
    expect(purgeRes.purgedFile).toBe(true);

    // Verify token file removed
    const fileExists = await fs
      .stat(tokenFilePath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);
  });

  it("revokes credentials only at their persisted issuing cloud origin", async () => {
    const now = Date.now();
    const tokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_custom_origin",
      refreshToken: "rtk_custom_origin",
      tokenType: "Bearer",
      expiresIn: 3600,
      claims: {
        accountId: "acc_origin",
        deviceId: "dev_origin",
        installationId: "inst_origin",
        workspaceId: "ws_origin",
        scopes: ["device:connect"],
        rawUploadConsent: false,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        tokenType: "access",
        familyId: "fam_origin",
        userId: "usr_origin",
        subject: "usr_origin",
      },
    };
    const issuerClient = new DeviceAuthClient({
      cloudUrl: "https://tenant.example.com/cloud/",
      tokenFilePath,
      vaultPath,
    });
    await issuerClient.storeCredentials(tokenResponse, "dev_origin", "ws_origin");

    // SAFETY: Mock Response for test.
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    const logoutClient = new DeviceAuthClient({
      tokenFilePath,
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
    });

    await expect(logoutClient.revokeToken()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://tenant.example.com/cloud/v1/auth/logout",
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: "rtk_custom_origin" }),
      }),
    );
    expect(mockFetch).not.toHaveBeenCalledWith(
      "https://api.resin.sh/v1/auth/logout",
      expect.anything(),
    );
  });

  it("uses the prior default origin for credentials stored before origin binding", async () => {
    const now = Date.now();
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "atk_legacy_origin",
        refreshToken: "rtk_legacy_origin",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_legacy",
        workspaceId: "ws_legacy",
        claims: {
          accountId: "acc_legacy",
          deviceId: "dev_legacy",
          installationId: "inst_legacy",
          workspaceId: "ws_legacy",
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
          tokenType: "access",
          userId: "usr_legacy",
          subject: "usr_legacy",
        },
        storedAt: new Date(now).toISOString(),
      }),
      { mode: 0o600 },
    );
    // SAFETY: Mock Response for test.
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    const client = new DeviceAuthClient({
      tokenFilePath,
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
    });

    await expect(client.loadCredentials()).resolves.toMatchObject({
      cloudUrl: "https://api.resin.sh",
    });
    await expect(client.revokeToken()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resin.sh/v1/auth/logout",
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: "rtk_legacy_origin" }),
      }),
    );
  });

  it("preserves prior credentials when an atomic replacement cannot commit", async () => {
    const priorContents = JSON.stringify({
      cloudUrl: "https://api.resin.sh",
      accessToken: "atk_prior_login",
      claims: {
        accountId: "acc_prior",
        deviceId: "dev_prior",
        installationId: "inst_prior",
        workspaceId: "ws_prior",
        scopes: ["device:connect"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenType: "access",
        userId: "usr_prior",
        subject: "usr_prior",
      },
      deviceId: "dev_prior",
      workspaceId: "ws_prior",
      storedAt: new Date().toISOString(),
    });
    await fs.writeFile(tokenFilePath, priorContents, { mode: 0o600 });
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("simulated rename failure"));
    const secretManager = new SecretManager({
      vaultPath,
      passphrase: "test-passphrase-1234",
    });
    const client = new DeviceAuthClient({ tokenFilePath, secretManager });
    const now = Date.now();

    try {
      const result = await client.storeCredentials(
        {
          accessToken: "atk_replacement",
          refreshToken: "rtk_replacement",
          tokenType: "Bearer",
          expiresIn: 3600,
          claims: {
            accountId: "acc_replacement",
            deviceId: "dev_replacement",
            installationId: "inst_replacement",
            workspaceId: "ws_replacement",
            scopes: ["device:connect"],
            rawUploadConsent: false,
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 3_600_000).toISOString(),
            tokenType: "access",
            userId: "usr_replacement",
            subject: "usr_replacement",
          },
        },
        "dev_replacement",
        "ws_replacement",
      );

      expect(result).toEqual({ storedInSecretStore: false });
      expect(await fs.readFile(tokenFilePath, "utf8")).toBe(priorContents);
      await expect(
        secretManager.getStore().getSecret("cloud_device_access_token"),
      ).resolves.toBeNull();
    } finally {
      rename.mockRestore();
    }
  });

  it("fails bootstrap when credentials cannot be persisted to an owner-only file", async () => {
    const blockedParent = path.join(tempDir, "not-a-directory");
    await fs.writeFile(blockedParent, "blocking file");
    const client = new DeviceAuthClient({
      tokenFilePath: path.join(blockedParent, "device-token.json"),
    });
    const now = Date.now();
    vi.spyOn(client, "requestDeviceCode").mockResolvedValue({
      deviceCode: "device_code_storage_failure",
      userCode: "FAIL-1234",
      verificationUri: "https://resin.sh/device",
      expiresIn: 900,
      interval: 1,
    });
    vi.spyOn(client, "pollTokenExchange").mockResolvedValue({
      accessToken: "atk_storage_failure",
      refreshToken: "rtk_storage_failure",
      tokenType: "Bearer",
      expiresIn: 3600,
      claims: {
        accountId: "acc_storage_failure",
        deviceId: "dev_storage_failure",
        installationId: "inst_storage_failure",
        workspaceId: "ws_storage_failure",
        scopes: ["device:connect"],
        rawUploadConsent: false,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        tokenType: "access",
        userId: "usr_storage_failure",
        subject: "usr_storage_failure",
      },
    });

    const result = await client.bootstrap({
      deviceId: "dev_storage_failure",
      installationId: "inst_storage_failure",
      interactive: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not be persisted");
    await expect(client.loadCredentials()).resolves.toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "atomically replaces a token-file symlink without overwriting its target",
    async () => {
      const symlinkTarget = path.join(tempDir, "unrelated-owner-file");
      await fs.writeFile(symlinkTarget, "leave-this-content-untouched", { mode: 0o644 });
      await fs.symlink(symlinkTarget, tokenFilePath);
      const now = Date.now();
      const tokenResponse: DeviceTokenExchangeResponse = {
        accessToken: "atk_atomic_storage_test",
        refreshToken: "rtk_atomic_storage_test",
        tokenType: "Bearer",
        expiresIn: 3600,
        claims: {
          accountId: "acc_atomic",
          deviceId: "dev_atomic",
          installationId: "inst_atomic",
          workspaceId: "ws_atomic",
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
          tokenType: "access",
          userId: "usr_atomic",
          subject: "usr_atomic",
        },
      };
      const client = new DeviceAuthClient({
        tokenFilePath,
        vaultPath,
        passphrase: "test-passphrase-1234",
      });

      const result = await client.storeCredentials(tokenResponse, "dev_atomic", "ws_atomic");

      expect(result.tokenFilePath).toBe(tokenFilePath);
      expect(await fs.readFile(symlinkTarget, "utf8")).toBe("leave-this-content-untouched");
      expect((await fs.lstat(tokenFilePath)).isSymbolicLink()).toBe(false);
      expect((await fs.stat(tokenFilePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(tokenFilePath))).mode & 0o777).toBe(0o700);
    },
  );

  it("completes full bootstrap workflow end-to-end with user notification", async () => {
    const mockBootstrapResponse: DeviceAuthBootstrapResponse = {
      deviceCode: "device_code_full_bootstrap",
      userCode: "BOOT-1234",
      verificationUri: "https://auth.resin.sh/device",
      expiresIn: 900,
      interval: 1,
    };

    const mockTokenResponse: DeviceTokenExchangeResponse = {
      accessToken: "atk_full_bootstrap_token",
      refreshToken: "rtk_full_bootstrap_token",
      tokenType: "Bearer",
      expiresIn: 3600,
      claims: {
        accountId: "acc_bootstrap",
        deviceId: "dev_bootstrap",
        installationId: "inst_custom_bootstrap",
        workspaceId: "ws_bootstrap",
        scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
        userId: "usr_bootstrap",
        subject: "usr_bootstrap",
      },
    };
    const devicePayloads: Array<{ readonly installationId?: string }> = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.body) {
        devicePayloads.push(JSON.parse(String(init.body)));
      }
      if (url.includes("/v1/auth/device/code")) {
        return Response.json(mockBootstrapResponse);
      }
      if (url.includes("/v1/auth/device/token")) {
        return Response.json(mockTokenResponse);
      }
      return new Response(null, { status: 404 });
    });

    const client = new DeviceAuthClient({
      cloudUrl: "https://auth-cloud.resin.sh",
      // SAFETY: Mock fetch function implementing fetch interface for testing.
      customFetch: mockFetch as typeof fetch,
      tokenFilePath,
      vaultPath,
    });

    let notifiedUserCode = "";
    const bootstrapResult = await client.bootstrap({
      deviceId: "dev_bootstrap",
      installationId: "inst_custom_bootstrap",
      workspaceId: "ws_local_hint",
      pollIntervalMs: 20,
      onUserCodeReceived: (info) => {
        notifiedUserCode = info.userCode;
      },
    });

    expect(bootstrapResult.success).toBe(true);
    expect(bootstrapResult.accessToken).toBe("atk_full_bootstrap_token");
    expect(bootstrapResult.workspaceId).toBe("ws_bootstrap");
    expect(notifiedUserCode).toBe("BOOT-1234");
    expect(devicePayloads).toHaveLength(2);
    expect(devicePayloads.map((payload) => payload.installationId)).toEqual([
      "inst_custom_bootstrap",
      "inst_custom_bootstrap",
    ]);
    expect(JSON.parse(await fs.readFile(tokenFilePath, "utf8"))).toMatchObject({
      workspaceId: "ws_bootstrap",
      cloudUrl: "https://auth-cloud.resin.sh",
      claims: {
        installationId: "inst_custom_bootstrap",
        workspaceId: "ws_bootstrap",
      },
    });
  });
});
