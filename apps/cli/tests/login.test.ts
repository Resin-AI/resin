import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import {
  loginCommand,
  parseLoginFlags,
  performPairing,
  validateCloudUrl,
} from "../src/commands/login.js";
import { DEFAULT_DEVICE_AUTH_SCOPES, DeviceAuthClient } from "../src/service/auth-bootstrap.js";

const ACCESS_TOKEN = "access-token-must-never-be-printed";
const REFRESH_TOKEN = "refresh-token-must-never-be-printed";
const VERIFICATION_URI = "https://auth.resin.sh/device";
const VERIFICATION_URI_COMPLETE = "https://auth.resin.sh/device?code=ABCD-9876";

function successfulDeviceFetch() {
  let binding: { deviceId: string; installationId: string } | undefined;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/auth/device/code")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        deviceId: string;
        installationId: string;
      };
      binding = { deviceId: body.deviceId, installationId: body.installationId };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          deviceCode: "device-code-sec-1234",
          userCode: "ABCD-9876",
          verificationUri: VERIFICATION_URI,
          verificationUriComplete: VERIFICATION_URI_COMPLETE,
          expiresIn: 900,
          interval: 1,
        }),
      } as Response;
    }

    if (url.endsWith("/v1/auth/device/token")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          accessToken: ACCESS_TOKEN,
          refreshToken: REFRESH_TOKEN,
          tokenType: "Bearer",
          expiresIn: 3600,
          scope: DEFAULT_DEVICE_AUTH_SCOPES.join(" "),
          claims: {
            accountId: "acc_live_01",
            workspaceId: "ws_live_01",
            deviceId: binding?.deviceId ?? "dev_live_01",
            installationId: binding?.installationId ?? "inst_live_01",
            scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
            rawUploadConsent: false,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "access",
            userId: "usr_alice",
            subject: "usr_alice",
          },
        }),
      } as Response;
    }
    if (url.endsWith("/v1/auth/logout")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ success: true }),
      } as Response;
    }

    return {
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "not_found" }),
    } as Response;
  });
}

async function captureOutput(action: () => Promise<number>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await action();
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("parseLoginFlags & validateCloudUrl", () => {
  it("parses valid login options", () => {
    const flags = parseLoginFlags([
      "--home=/tmp/resin-home",
      "--cloud-url",
      "https://api.resin.sh",
      "--account",
      "acc_123",
      "--workspace=ws_456",
      "--device-id",
      "dev_789",
      "--installation-id=inst_abc",
      "--json",
    ]);

    expect(flags).toEqual({
      home: "/tmp/resin-home",
      cloudUrl: "https://api.resin.sh",
      accountId: "acc_123",
      workspaceId: "ws_456",
      deviceId: "dev_789",
      installationId: "inst_abc",
      json: true,
    });
  });

  it("validates and normalizes secure cloud origins", () => {
    expect(validateCloudUrl("https://api.resin.sh")).toBe("https://api.resin.sh");
    expect(validateCloudUrl("https://api.resin.sh/")).toBe("https://api.resin.sh");
    expect(validateCloudUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(validateCloudUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => validateCloudUrl("http://insecure.example.com")).toThrow(/must use HTTPS/);
    expect(() => validateCloudUrl("https://user:pass@api.resin.sh")).toThrow(
      /must not include credentials/,
    );
    expect(() => validateCloudUrl("https://cloud.example.com?redirect=evil")).toThrow(
      /must not include credentials/,
    );
  });

  it("exposes login through command and global help", async () => {
    const commandHelp = await captureOutput(() => main(["login", "--help"]));
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stdout).toContain("resin login [options]");
    expect(commandHelp.stdout).toContain("--cloud-url <https-url>");

    const globalHelp = await captureOutput(() => main(["help"]));
    expect(globalHelp.exitCode).toBe(0);
    expect(globalHelp.stdout).toContain("login        Authenticate this installation");
  });

  it("returns a failure exit for invalid flags", async () => {
    const result = await captureOutput(() => loginCommand(["--json", "--bogus"]));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "error",
      success: false,
      error: 'Unknown option "--bogus"',
    });
  });
});

describe("login device flow & browser launch", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-login-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("attempts to open verification URI in browser first, presents safe URL + code, and never prints tokens", async () => {
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);

    const result = await captureOutput(() =>
      loginCommand(["--home", home, "--cloud-url", "https://api.resin.sh"], {
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(VERIFICATION_URI_COMPLETE);
    expect(result.stdout).toContain("A browser window was opened for Resin authorization.");
    expect(result.stdout).toContain(`1. Navigate to: ${VERIFICATION_URI_COMPLETE}`);
    expect(result.stdout).toContain("2. Enter code:   ABCD-9876");
    expect(result.stdout).toContain("Authenticated successfully.");
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);

    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const saved = JSON.parse(await fs.readFile(tokenFilePath, "utf-8"));
    expect(saved.accessToken).toBe(ACCESS_TOKEN);
    expect(saved.claims.accountId).toBe("acc_live_01");
  });

  it("falls back cleanly to printed URL and code when browser open fails or throws", async () => {
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockRejectedValue(new Error("No GUI available"));

    const result = await captureOutput(() =>
      loginCommand(["--home", home, "--cloud-url", "https://api.resin.sh"], {
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain("A browser could not be opened automatically.");
    expect(result.stdout).toContain("2. Enter code:   ABCD-9876");
    expect(result.stdout).toContain("Authenticated successfully.");
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
  });

  it("supports machine-readable json mode with verification payload and does not launch browser", async () => {
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn();

    const result = await captureOutput(() =>
      loginCommand(["--json", "--home", home, "--cloud-url", "https://api.resin.sh/"], {
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(openBrowser).not.toHaveBeenCalled();

    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        type: "verification",
        userCode: "ABCD-9876",
        verificationUri: VERIFICATION_URI,
        verificationUriComplete: VERIFICATION_URI_COMPLETE,
        expiresIn: 900,
      },
      {
        type: "success",
        success: true,
        deviceId: expect.stringMatching(/^dev_/),
        workspaceId: "ws_live_01",
        accountId: "acc_live_01",
        userId: "usr_alice",
        storedInSecretStore: expect.any(Boolean),
        tokenFilePath: path.join(home, ".resin", "state", "device-token.json"),
      },
    ]);
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);
  });

  it("emits a machine-readable error and returns a failure exit on backend error", async () => {
    const customFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        error: "temporarily_unavailable",
        error_description: "temporarily unavailable",
      }),
    });

    const result = await captureOutput(() =>
      loginCommand(["--json", "--home", home, "--cloud-url", "https://api.resin.sh"], {
        customFetch: customFetch as unknown as typeof fetch,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "error",
      success: false,
      error: "Device code request failed (503): temporarily unavailable",
    });
    expect(result.stderr).toBe("");
  });
});

describe("performPairing reuse and rollback", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-pairing-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reuses valid unexpired credential records without invoking cloud flow", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "pre-existing-access-token",
        refreshToken: "pre-existing-refresh-token",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_preexisting",
        workspaceId: "ws_preexisting",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_preexisting",
          workspaceId: "ws_preexisting",
          deviceId: "dev_preexisting",
          installationId: "inst_preexisting",
          userId: "usr_preexisting",
          subject: "usr_preexisting",
          scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = vi.fn();
    const mutation = await performPairing({
      home,
      cloudUrl: "https://api.resin.sh",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(mutation.paired).toBe(true);
    expect(mutation.localOnly).toBe(false);
    expect(mutation.reused).toBe(true);
    expect(mutation.accountId).toBe("acc_preexisting");
    expect(mutation.workspaceId).toBe("ws_preexisting");
    expect(mutation.deviceId).toBe("dev_preexisting");
    expect(mutation.userId).toBe("usr_preexisting");
    expect(mutation.cloudUrl).toBe("https://api.resin.sh");
    expect(customFetch).not.toHaveBeenCalled();

    // Reused rollback should leave existing credentials intact
    if (mutation.rollback) {
      await mutation.rollback();
    }
    const content = JSON.parse(await fs.readFile(tokenFilePath, "utf8"));
    expect(content.accessToken).toBe("pre-existing-access-token");
  });

  it("re-pairs an unexpired legacy refresh family instead of reusing or refreshing it", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const legacyRefreshToken = "legacy-refresh-family";
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "legacy-access-token",
        refreshToken: legacyRefreshToken,
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_legacy_family",
        workspaceId: "ws_legacy_family",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_legacy_family",
          workspaceId: "ws_legacy_family",
          deviceId: "dev_legacy_family",
          installationId: "inst_legacy_family",
          userId: "usr_legacy_family",
          subject: "usr_legacy_family",
          familyId: "fam_legacy_family",
          scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);
    const output = await captureOutput(async () => {
      const mutation = await performPairing({
        home,
        cloudUrl: "https://api.resin.sh",
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      });
      expect(mutation.reused).toBe(false);
      return 0;
    });

    expect(openBrowser).toHaveBeenCalledWith(VERIFICATION_URI_COMPLETE);
    expect(output.stdout).toContain("ABCD-9876");
    expect(customFetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.resin.sh/v1/auth/device/code",
      "https://api.resin.sh/v1/auth/device/token",
    ]);
    const deviceCodeRequest = customFetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(deviceCodeRequest?.body))).toMatchObject({
      scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
    });
    expect(JSON.parse(await fs.readFile(tokenFilePath, "utf8"))).toMatchObject({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      claims: {
        scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
      },
    });
  });

  it("restores prior credentials on rollback after new pairing mutation", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "prior-token",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_old",
        workspaceId: "ws_old",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_old",
          workspaceId: "ws_old",
          deviceId: "dev_old",
          installationId: "inst_old",
          userId: "usr_old",
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 100_000).toISOString(),
          tokenType: "access",
        },
      }),
    );
    const customFetch = successfulDeviceFetch();
    const mutation = await performPairing({
      home,
      cloudUrl: "https://api.resin.sh",
      force: true,
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(mutation.paired).toBe(true);
    expect(mutation.reused).toBe(false);
    expect(mutation.accountId).toBe("acc_live_01");

    // Before rollback: token file has new credentials
    let current = JSON.parse(await fs.readFile(tokenFilePath, "utf8"));
    expect(current.accessToken).toBe(ACCESS_TOKEN);

    // After rollback: token file has restored prior credentials
    if (mutation.rollback) {
      await mutation.rollback();
    }
    current = JSON.parse(await fs.readFile(tokenFilePath, "utf8"));
    expect(current.accessToken).toBe("prior-token");
    expect(current.claims.accountId).toBe("acc_old");
  });

  it("purges newly created credentials on rollback when no prior credentials existed", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const customFetch = successfulDeviceFetch();
    const mutation = await performPairing({
      home,
      cloudUrl: "https://api.resin.sh",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(mutation.paired).toBe(true);
    expect(mutation.reused).toBe(false);

    // Verify token was saved
    expect(await fs.stat(tokenFilePath).catch(() => null)).not.toBeNull();

    // Perform rollback
    if (mutation.rollback) {
      await mutation.rollback();
    }

    // Verify token was purged
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });

  it("emits structured verification record in JSON mode and allows URL/code fallback without token output", async () => {
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn(async () => true);
    const result = await captureOutput(async () => {
      const pairingPromise = performPairing({
        home,
        json: true,
        cloudUrl: "https://api.resin.sh",
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      });
      return (await pairingPromise) ? 0 : 1;
    });
    expect(openBrowser).not.toHaveBeenCalled();

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const verificationRecord = JSON.parse(lines[0]);
    expect(verificationRecord).toEqual({
      type: "verification",
      userCode: "ABCD-9876",
      verificationUri: VERIFICATION_URI,
      verificationUriComplete: VERIFICATION_URI_COMPLETE,
      expiresIn: 900,
    });
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);
  });

  it("standalone login reuses valid same-origin credentials without re-authenticating", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "existing-valid-access-token",
        refreshToken: "existing-valid-refresh-token",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_existing_01",
        workspaceId: "ws_existing_01",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_existing_01",
          workspaceId: "ws_existing_01",
          deviceId: "dev_existing_01",
          installationId: "inst_existing_01",
          userId: "usr_existing_bob",
          subject: "usr_existing_bob",
          scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn(async () => true);

    const result = await captureOutput(() =>
      loginCommand(["--home", home, "--cloud-url", "https://api.resin.sh"], {
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(result.stdout).toContain("Authenticated successfully.");
    expect(result.stdout).toContain("acc_existing_01");
    expect(result.stdout).toContain("ws_existing_01");
    expect(result.stdout).toContain("dev_existing_01");
    expect(result.stdout).not.toContain("existing-valid-access-token");
    expect(result.stdout).not.toContain("existing-valid-refresh-token");
  });

  it("standalone login with --force replaces existing valid credentials", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "existing-valid-access-token",
        refreshToken: "existing-valid-refresh-token",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_existing_01",
        workspaceId: "ws_existing_01",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_existing_01",
          workspaceId: "ws_existing_01",
          deviceId: "dev_existing_01",
          installationId: "inst_existing_01",
          userId: "usr_existing_bob",
          subject: "usr_existing_bob",
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn(async () => true);
    const result = await captureOutput(async () => {
      return await loginCommand(
        ["--force", "--home", home, "--cloud-url", "https://api.resin.sh"],
        {
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });
    expect(customFetch).toHaveBeenCalled();
    expect(result.stdout).toContain("Authenticated successfully.");
    expect(result.stdout).toContain("acc_live_01");
  });

  it("standalone login does not reuse credentials from a different cloud origin", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "other-origin-token",
        refreshToken: "other-origin-refresh",
        cloudUrl: "https://other.resin.sh",
        deviceId: "dev_other",
        workspaceId: "ws_other",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_other",
          workspaceId: "ws_other",
          deviceId: "dev_other",
          installationId: "inst_other",
          userId: "usr_other",
          subject: "usr_other",
          scopes: ["device:connect"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn(async () => true);

    const result = await captureOutput(async () => {
      return await loginCommand(["--home", home, "--cloud-url", "https://api.resin.sh"], {
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      });
    });

    expect(result.exitCode).toBe(0);
    expect(customFetch).toHaveBeenCalled();
    expect(result.stdout).toContain("Authenticated successfully.");
    expect(result.stdout).toContain("acc_live_01");
  });
  it("remote revocation is invoked at persisted origin during rollback of newly approved credential", async () => {
    const logoutCalled = vi.fn();
    const baseFetch = successfulDeviceFetch();
    const customFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/auth/logout")) {
        logoutCalled(url, init);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ success: true }),
        } as Response;
      }
      return baseFetch(input, init);
    });

    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const mutation = await performPairing({
      home,
      cloudUrl: "https://api.resin.sh",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(mutation.paired).toBe(true);
    expect(await fs.stat(tokenFilePath).catch(() => null)).not.toBeNull();

    // Roll back newly created credentials
    await mutation.rollback?.();

    expect(logoutCalled).toHaveBeenCalledTimes(1);
    expect(logoutCalled.mock.calls[0][0]).toBe("https://api.resin.sh/v1/auth/logout");
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });

  it("transient revocation failure during rollback still restores/purges local state safely without throwing", async () => {
    const baseFetch = successfulDeviceFetch();
    const customFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/auth/logout")) {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "internal_error" }),
        } as Response;
      }
      return baseFetch(input, init);
    });

    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const mutation = await performPairing({
      home,
      cloudUrl: "https://api.resin.sh",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(mutation.paired).toBe(true);
    expect(await fs.stat(tokenFilePath).catch(() => null)).not.toBeNull();

    // Roll back should not throw even if remote revocation returns 500
    await expect(mutation.rollback?.()).resolves.toBeUndefined();

    // Local state is still purged
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });
});
