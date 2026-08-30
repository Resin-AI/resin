import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IpcClient, type StoredCloudCredentials, resolvePaths } from "@resin/observer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/cli.js";
import {
  PrivacyCommandError,
  collectPrivacyStatus,
  parsePrivacyFlags,
  privacyCommand,
  readLocalPrivacyStatus,
  requestPrivacyExport,
  setDeviceTelemetry,
} from "../src/commands/privacy.js";

const temporaryHomes: string[] = [];
const TOKEN_SENTINEL = "atk_super_secret_privacy_token";
const PRIVATE_ERROR_SENTINEL = "private backend stack and tenant details";

async function createTemporaryHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-privacy-command-"));
  temporaryHomes.push(home);
  return home;
}

function createCredentials(accessToken = TOKEN_SENTINEL): StoredCloudCredentials {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    cloudUrl: "https://cloud.resin.test",
    accessToken,
    refreshToken: "rtk_super_secret_privacy_token",
    claims: {
      accountId: "acc_privacy_test",
      deviceId: "dev_privacy_test",
      installationId: "inst_privacy_test",
      workspaceId: "ws_privacy_test",
      scopes: [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "privacy:read",
        "privacy:write",
      ],
      rawUploadConsent: false,
      issuedAt,
      expiresAt,
      tokenType: "access",
    },
    deviceId: "dev_privacy_test",
    workspaceId: "ws_privacy_test",
    storedAt: issuedAt,
  };
}
function createScopedToken(
  scopes: StoredCloudCredentials["claims"]["scopes"],
  marker: string,
): string {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      accountId: "acc_privacy_test",
      deviceId: "dev_privacy_test",
      installationId: "inst_privacy_test",
      workspaceId: "ws_privacy_test",
      scopes,
      rawUploadConsent: false,
      issuedAt,
      expiresAt,
      tokenType: "access",
      marker,
    }),
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

function privacySettings(metadataTelemetryEnabled: boolean, rawTranscriptUploadEnabled = false) {
  return {
    metadataTelemetryEnabled,
    rawTranscriptUploadEnabled,
    retentionDays: 30,
    // SAFETY: Typed activeHolds array for test setup.
    activeHolds: [] as Array<{ type: "legal_hold" }>,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function jsonResponse(value: Parameters<typeof JSON.stringify>[0], status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureOutput() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
    text(): string {
      return chunks.join("");
    },
  };
}

async function writeDaemonConfig(home: string, telemetryEnabled: boolean): Promise<string> {
  const configFile = resolvePaths({ home, env: {} }).configFile;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(
    configFile,
    `${JSON.stringify({
      version: "1.0.0",
      telemetryEnabled,
      custom: { preserved: true },
    })}\n`,
  );
  return configFile;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe("privacy argument parsing and CLI registration", () => {
  it("parses every privacy subcommand and common flags", () => {
    expect(parsePrivacyFlags(["status", "--json", "--home", "/tmp/privacy-home"])).toEqual({
      action: "status",
      confirm: false,
      json: true,
      home: "/tmp/privacy-home",
    });
    expect(parsePrivacyFlags(["telemetry", "disable", "--json"])).toEqual({
      action: "telemetry",
      telemetryAction: "disable",
      confirm: false,
      json: true,
      home: undefined,
    });
    expect(parsePrivacyFlags(["export"])).toMatchObject({ action: "export" });
    expect(parsePrivacyFlags(["delete", "--confirm"])).toMatchObject({
      action: "delete",
      confirm: true,
    });
  });

  it("rejects unknown actions, invalid telemetry values, and misplaced confirmation", () => {
    expect(() => parsePrivacyFlags(["unknown"])).toThrow(PrivacyCommandError);
    expect(() => parsePrivacyFlags(["telemetry", "sometimes"])).toThrow(
      "privacy telemetry enable|disable",
    );
    expect(() => parsePrivacyFlags(["status", "--confirm"])).toThrow(
      "only valid with privacy delete",
    );
  });

  it("dispatches resin privacy help through the CLI entrypoint", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const exitCode = await main(["privacy", "--help"], {
      isInitialized: false,
      stdout: { isTTY: false, write: stdout.writer.write },
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("resin privacy status");
    expect(stderr.text()).toBe("");
  });
});

describe("privacy status precedence and offline behavior", () => {
  it("lets a disabled device override enabled cloud consent", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, false);
    const customFetch = vi.fn().mockResolvedValue(jsonResponse(privacySettings(true, true)));

    const status = await collectPrivacyStatus({
      home,
      env: {},
      customFetch,
      loadCredentials: async () => createCredentials(),
    });

    expect(status.device.metadataTelemetryEnabled).toBe(false);
    expect(status.cloud.settings?.metadataTelemetryEnabled).toBe(true);
    expect(status.effective.metadataTelemetryEnabled).toBe(false);
    expect(status.effective.rawTranscriptUploadEnabled).toBe(true);
  });

  it("requires cloud and device consent for effective metadata telemetry", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, true);
    const customFetch = vi.fn().mockResolvedValue(jsonResponse(privacySettings(false)));

    const status = await collectPrivacyStatus({
      home,
      env: {},
      customFetch,
      loadCredentials: async () => createCredentials(),
    });

    expect(status.device.metadataTelemetryEnabled).toBe(true);
    expect(status.cloud.settings?.metadataTelemetryEnabled).toBe(false);
    expect(status.effective.metadataTelemetryEnabled).toBe(false);
  });

  it("reports cloud offline without failing status or enabling effective transmission", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, true);
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await privacyCommand(["status", "--json"], {
      home,
      env: {},
      customFetch: vi.fn().mockRejectedValue(new Error(PRIVATE_ERROR_SENTINEL)),
      loadCredentials: async () => createCredentials(),
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.text());
    expect(result.schemaVersion).toBe(1);
    expect(result.cloud).toMatchObject({
      paired: true,
      available: false,
      errorCode: "CLOUD_UNREACHABLE",
      settings: null,
    });
    expect(result.effective).toMatchObject({
      metadataTelemetryEnabled: false,
      rawTranscriptUploadEnabled: false,
    });
    expect(stdout.text()).not.toContain(PRIVATE_ERROR_SENTINEL);
    expect(stdout.text()).not.toContain(TOKEN_SENTINEL);
    expect(stderr.text()).toBe("");
  });

  it("reports raw transcript consent as unavailable while cloud status is unavailable", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, true);
    const stdout = captureOutput();

    const exitCode = await privacyCommand(["status"], {
      home,
      env: {},
      customFetch: vi.fn().mockRejectedValue(new Error(PRIVATE_ERROR_SENTINEL)),
      loadCredentials: async () => createCredentials(),
      stdout: stdout.writer,
      stderr: captureOutput().writer,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Raw transcript upload consent: unavailable");
    expect(stdout.text()).not.toContain("Raw transcript upload consent: disabled");
  });

  it("defaults raw transcript consent to false while unpaired", async () => {
    const home = await createTemporaryHome();
    const customFetch = vi.fn();
    const status = await collectPrivacyStatus({
      home,
      env: {},
      customFetch,
      loadCredentials: async () => null,
    });

    expect(status.cloud).toMatchObject({ paired: false, available: false, settings: null });
    expect(status.effective.rawTranscriptUploadEnabled).toBe(false);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("fails closed when local configuration is malformed", async () => {
    const home = await createTemporaryHome();
    const configFile = resolvePaths({ home, env: {} }).configFile;
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, "{ malformed private config");

    const status = await readLocalPrivacyStatus({ home, env: {} });
    expect(status).toMatchObject({
      metadataTelemetryEnabled: false,
      configuredMetadataTelemetryEnabled: false,
      configurationState: "invalid",
    });
  });
});

describe("atomic telemetry configuration and socket-only IPC reload", () => {
  it.each([
    { initial: true, requested: false },
    { initial: false, requested: true },
  ])(
    "persists $requested privately and reloads after changing $initial",
    async ({ initial, requested }) => {
      const home = await createTemporaryHome();
      const configFile = await writeDaemonConfig(home, initial);
      const reloadDaemon = vi.fn().mockResolvedValue({ success: true, errors: [] });

      const result = await setDeviceTelemetry(requested, {
        home,
        env: {},
        reloadDaemon,
      });

      expect(result).toEqual({
        configuredMetadataTelemetryEnabled: requested,
        metadataTelemetryEnabled: requested,
        reloaded: true,
      });
      expect(reloadDaemon).toHaveBeenCalledTimes(1);
      expect(reloadDaemon).toHaveBeenCalledWith({ telemetryEnabled: requested });
      const persisted = JSON.parse(await fs.readFile(configFile, "utf8"));
      expect(persisted.telemetryEnabled).toBe(requested);
      expect(persisted.custom).toEqual({ preserved: true });
      if (process.platform !== "win32") {
        expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(configFile))).mode & 0o777).toBe(0o700);
      }
      const directoryEntries = await fs.readdir(path.dirname(configFile));
      expect(directoryEntries).toEqual([path.basename(configFile)]);
    },
  );

  it("matches daemon boolean parsing so mixed-case true cannot enable a disable request", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, true);
    const reloadDaemon = vi.fn().mockResolvedValue({ success: true, errors: [] });

    const result = await setDeviceTelemetry(false, {
      home,
      env: { RESIN_TELEMETRY_ENABLED: "TRUE" },
      reloadDaemon,
    });

    expect(result.metadataTelemetryEnabled).toBe(false);
    expect(reloadDaemon).toHaveBeenCalledWith({ telemetryEnabled: false });
    await expect(
      readLocalPrivacyStatus({
        home,
        env: { RESIN_TELEMETRY_ENABLED: "TRUE" },
      }),
    ).resolves.toMatchObject({
      configuredMetadataTelemetryEnabled: false,
      environmentTelemetryEnabled: false,
      metadataTelemetryEnabled: false,
    });
  });

  it("rolls the file and runtime setting back when reload reports failure", async () => {
    const home = await createTemporaryHome();
    const configFile = await writeDaemonConfig(home, true);
    const original = await fs.readFile(configFile, "utf8");
    const reloadDaemon = vi
      .fn()
      .mockResolvedValueOnce({ success: false, errors: [PRIVATE_ERROR_SENTINEL] })
      .mockResolvedValueOnce({ success: true, errors: [] });

    await expect(setDeviceTelemetry(false, { home, env: {}, reloadDaemon })).rejects.toMatchObject({
      code: "DAEMON_RELOAD_FAILED",
    });

    expect(await fs.readFile(configFile, "utf8")).toBe(original);
    expect(reloadDaemon).toHaveBeenNthCalledWith(1, { telemetryEnabled: false });
    expect(reloadDaemon).toHaveBeenNthCalledWith(2, { telemetryEnabled: true });
  });

  it("reports runtime divergence when the rollback response reports failure", async () => {
    const home = await createTemporaryHome();
    const configFile = await writeDaemonConfig(home, false);
    const original = await fs.readFile(configFile, "utf8");
    const reloadDaemon = vi
      .fn()
      .mockResolvedValueOnce({ success: false, errors: [PRIVATE_ERROR_SENTINEL] })
      .mockResolvedValueOnce({ success: false, errors: [PRIVATE_ERROR_SENTINEL] });

    await expect(setDeviceTelemetry(true, { home, env: {}, reloadDaemon })).rejects.toMatchObject({
      code: "DAEMON_ROLLBACK_FAILED",
      message: expect.stringContaining("runtime state is unknown"),
    });

    expect(await fs.readFile(configFile, "utf8")).toBe(original);
    expect(reloadDaemon).toHaveBeenNthCalledWith(1, { telemetryEnabled: true });
    expect(reloadDaemon).toHaveBeenNthCalledWith(2, { telemetryEnabled: false });
  });

  it("reports runtime divergence when socket-only IPC rejects rollback and redacts its error", async () => {
    const home = await createTemporaryHome();
    const configFile = await writeDaemonConfig(home, true);
    const stderr = captureOutput();
    const reloadDaemon = vi.fn().mockRejectedValue(new Error(PRIVATE_ERROR_SENTINEL));

    const exitCode = await privacyCommand(["telemetry", "disable", "--json"], {
      home,
      env: {},
      reloadDaemon,
      stdout: captureOutput().writer,
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(await fs.readFile(configFile, "utf8")).telemetryEnabled).toBe(true);
    expect(JSON.parse(stderr.text()).error.code).toBe("DAEMON_ROLLBACK_FAILED");
    expect(stderr.text()).not.toContain(PRIVATE_ERROR_SENTINEL);
  });

  it("reloads daemon using socket-only IPC without token authentication when no custom reload function is provided", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, false);
    const connectSpy = vi.spyOn(IpcClient.prototype, "connect").mockResolvedValue();
    const reloadConfigSpy = vi
      .spyOn(IpcClient.prototype, "reloadConfig")
      .mockResolvedValue({ success: true, errors: [] });
    const closeSpy = vi.spyOn(IpcClient.prototype, "close").mockResolvedValue();

    try {
      const result = await setDeviceTelemetry(true, {
        home,
        env: {},
      });

      expect(result.configuredMetadataTelemetryEnabled).toBe(true);
      expect(result.reloaded).toBe(true);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(reloadConfigSpy).toHaveBeenCalledWith({ telemetryEnabled: true });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
      reloadConfigSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});

describe("cloud export and deletion", () => {
  it("requests an export with paired credentials and emits only allowlisted job fields", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jobId: "export_job_1",
        status: "queued",
        downloadAvailable: false,
        downloadUrl: "https://private.invalid/archive?token=signed_secret",
        accessToken: TOKEN_SENTINEL,
      }),
    );
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await privacyCommand(["export", "--json"], {
      customFetch,
      loadCredentials: async () => createCredentials(),
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "export",
      result: {
        jobId: "export_job_1",
        status: "queued",
        downloadAvailable: false,
      },
    });
    expect(stdout.text()).not.toContain(TOKEN_SENTINEL);
    expect(stdout.text()).not.toContain("signed_secret");
    expect(stderr.text()).toBe("");

    // SAFETY: Vitest mock call tuple extraction.
    const [url, init] = customFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://cloud.resin.test/api/user/data/export");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
    expect(init.body).toBe("{}");
  });

  it("returns a typed export result from the direct cloud contract", async () => {
    const result = await requestPrivacyExport({
      customFetch: vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: "export_job_2",
          status: "ready",
          downloadAvailable: true,
        }),
      ),
      loadCredentials: async () => createCredentials(),
    });

    expect(result).toEqual({
      jobId: "export_job_2",
      status: "ready",
      downloadAvailable: true,
      requestedAt: null,
      expiresAt: null,
    });
  });

  it("preserves a validated cloud base path for authenticated privacy requests", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jobId: "export_job_prefixed",
        status: "queued",
        downloadAvailable: false,
      }),
    );

    await requestPrivacyExport({
      customFetch,
      loadCredentials: async () => ({
        ...createCredentials(),
        cloudUrl: "https://cloud.resin.test/resin",
      }),
    });

    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(String(customFetch.mock.calls[0]?.[0])).toBe(
      "https://cloud.resin.test/resin/api/user/data/export",
    );
    expect(customFetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: `Bearer ${TOKEN_SENTINEL}`,
      }),
    });
  });

  it("does not send deletion when interactive confirmation is declined", async () => {
    const customFetch = vi.fn();
    const loadCredentials = vi.fn();
    const stdout = captureOutput();

    const exitCode = await privacyCommand(["delete"], {
      customFetch,
      loadCredentials,
      confirmDeletion: vi.fn().mockResolvedValue(false),
      stdout: stdout.writer,
      stderr: captureOutput().writer,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Deletion cancelled; no request was sent.");
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("requires --confirm in JSON mode without writing a prompt to stdout", async () => {
    const customFetch = vi.fn();
    const loadCredentials = vi.fn();
    const confirmDeletion = vi.fn();
    const stdout = captureOutput();
    const stderr = captureOutput();

    const exitCode = await privacyCommand(["delete", "--json"], {
      customFetch,
      loadCredentials,
      confirmDeletion,
      stdinIsTTY: true,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(JSON.parse(stderr.text())).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(confirmDeletion).not.toHaveBeenCalled();
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("requires visible one-time device approval and never persists or logs the elevated token", async () => {
    vi.useFakeTimers();
    const home = await createTemporaryHome();
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const ordinaryCredentialMarker = "ordinary-paired-device-token";
    const elevatedAccessToken = "atk_one_time_delete_token_never_log";
    const elevatedRefreshToken = "rtk_one_time_delete_token_never_log";
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, ordinaryCredentialMarker);

    const customFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/code")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          deviceId: "dev_privacy_test",
          installationId: "inst_privacy_test",
          scopes: ["privacy:delete"],
        });
        return jsonResponse({
          deviceCode: "device_code_privacy_delete_approval",
          userCode: "DELE-1234",
          verificationUri: "https://cloud.resin.test/device",
          verificationUriComplete:
            "https://cloud.resin.test/device?user_code=DELE-1234&approval_nonce=nonce",
          expiresIn: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/v1/auth/device/token")) {
        const issuedAt = new Date(Date.now()).toISOString();
        return jsonResponse({
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
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            tokenType: "access",
          },
        });
      }
      if (url.endsWith("/api/user/data/delete")) {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${elevatedAccessToken}`,
        });
        return jsonResponse({ jobId: "delete_job_approved", status: "queued" });
      }
      if (url.endsWith("/v1/auth/logout")) {
        expect(init?.headers).not.toMatchObject({
          Authorization: expect.any(String),
        });
        expect(init?.body).toBe(JSON.stringify({ refreshToken: elevatedRefreshToken }));
        return jsonResponse({ loggedOut: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const confirmDeletion = vi.fn().mockResolvedValue(true);
    const stdout = captureOutput();
    const stderr = captureOutput();

    try {
      const pendingCommand = privacyCommand(["delete"], {
        home,
        // SAFETY: Mock fetch matching fetch signature for test.
        customFetch: customFetch as typeof fetch,
        loadCredentials: async () => createCredentials(),
        confirmDeletion,
        stdinIsTTY: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        await pendingCommand,
        `${stderr.text()} Requests: ${customFetch.mock.calls.map(([input]) => String(input)).join(", ")}`,
      ).toBe(0);
      expect(confirmDeletion).toHaveBeenCalledTimes(1);
      expect(customFetch.mock.calls.map(([input]) => String(input))).toEqual([
        "https://cloud.resin.test/v1/auth/device/code",
        "https://cloud.resin.test/v1/auth/device/token",
        "https://cloud.resin.test/api/user/data/delete",
        "https://cloud.resin.test/v1/auth/logout",
      ]);
      expect(stderr.text()).toContain("one-time privacy:delete access");
      expect(stderr.text()).toContain("https://cloud.resin.test/device");
      expect(await fs.readFile(tokenFilePath, "utf8")).toBe(ordinaryCredentialMarker);
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(elevatedAccessToken);
      expect(`${stdout.text()}${stderr.text()}`).not.toContain(elevatedRefreshToken);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces production scopes and fails closed non-interactively without elevation", async () => {
    const home = await createTemporaryHome();
    const ordinaryToken = createScopedToken(
      [
        "device:connect",
        "observations:write",
        "catalog:read",
        "artifacts:read",
        "privacy:read",
        "privacy:write",
      ],
      "ordinary",
    );
    const elevatedToken = createScopedToken(["privacy:delete"], "elevated");
    const scopesByToken = {
      [ordinaryToken]: ["device:connect", "observations:write", "privacy:read", "privacy:write"],
      [elevatedToken]: ["privacy:delete"],
    };
    const scopeFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      // SAFETY: Cast headers to inspect Authorization header in test mock.
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const token = authorization?.replace(/^Bearer /, "") ?? "";
      const scopes = scopesByToken[token] ?? [];
      const url = String(input);
      if (url.endsWith("/api/user/privacy")) {
        return scopes.includes("privacy:read")
          ? jsonResponse(privacySettings(true))
          : jsonResponse({ error: "FORBIDDEN" }, 403);
      }
      if (url.endsWith("/api/user/data/delete")) {
        return scopes.includes("privacy:delete")
          ? jsonResponse({ jobId: "delete_job_elevated", status: "queued" })
          : jsonResponse({ error: "FORBIDDEN" }, 403);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const loadCredentials = async () => createCredentials(ordinaryToken);

    const status = await collectPrivacyStatus({
      home,
      // SAFETY: Mock fetch matching fetch signature for test.
      customFetch: scopeFetch as typeof fetch,
      loadCredentials,
    });
    expect(status.cloud).toMatchObject({ paired: true, available: true });

    const noElevationError = captureOutput();
    expect(
      await privacyCommand(["delete", "--confirm", "--json"], {
        home,
        env: {},
        // SAFETY: Mock fetch matching fetch signature for test.
        customFetch: scopeFetch as typeof fetch,
        loadCredentials,
        stdinIsTTY: false,
        stdout: captureOutput().writer,
        stderr: noElevationError.writer,
      }),
    ).toBe(1);
    expect(JSON.parse(noElevationError.text()).error.code).toBe("ELEVATION_REQUIRED");
    expect(scopeFetch).toHaveBeenCalledTimes(1);

    const ordinaryDeleteError = captureOutput();
    expect(
      await privacyCommand(["delete", "--confirm", "--json"], {
        home,
        env: { RESIN_PRIVACY_DELETE_TOKEN: ordinaryToken },
        // SAFETY: Mock fetch matching fetch signature for test.
        customFetch: scopeFetch as typeof fetch,
        loadCredentials,
        stdinIsTTY: false,
        stdout: captureOutput().writer,
        stderr: ordinaryDeleteError.writer,
      }),
    ).toBe(1);
    expect(JSON.parse(ordinaryDeleteError.text()).error.code).toBe("ELEVATION_REQUIRED");

    const elevatedStdout = captureOutput();
    const elevatedStderr = captureOutput();
    expect(
      await privacyCommand(["delete", "--confirm", "--json"], {
        home,
        env: { RESIN_PRIVACY_DELETE_TOKEN: elevatedToken },
        // SAFETY: Mock fetch matching fetch signature for test.
        customFetch: scopeFetch as typeof fetch,
        loadCredentials,
        stdinIsTTY: false,
        stdout: elevatedStdout.writer,
        stderr: elevatedStderr.writer,
      }),
    ).toBe(0);
    expect(JSON.parse(elevatedStdout.text()).result).toMatchObject({
      jobId: "delete_job_elevated",
      status: "queued",
    });
    expect(
      `${ordinaryDeleteError.text()}${elevatedStdout.text()}${elevatedStderr.text()}`,
    ).not.toContain(ordinaryToken);
    expect(
      `${ordinaryDeleteError.text()}${elevatedStdout.text()}${elevatedStderr.text()}`,
    ).not.toContain(elevatedToken);
    expect(
      scopeFetch.mock.calls.map(
        // SAFETY: Cast headers to inspect Authorization header in test assertion.
        ([, init]) => (init?.headers as Record<string, string>).Authorization,
      ),
    ).toEqual([`Bearer ${ordinaryToken}`, `Bearer ${ordinaryToken}`, `Bearer ${elevatedToken}`]);
  });

  it("surfaces active hold types but redacts cloud messages and credentials", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "ACTIVE_RETENTION_HOLD",
          message: PRIVATE_ERROR_SENTINEL,
          details: {
            activeHolds: [{ type: "legal_hold" }, { type: "security_incident" }],
          },
          accessToken: TOKEN_SENTINEL,
        },
        409,
      ),
    );
    const stderr = captureOutput();

    const exitCode = await privacyCommand(["delete", "--confirm", "--json"], {
      customFetch,
      loadCredentials: async () => createCredentials(),
      env: { RESIN_PRIVACY_DELETE_TOKEN: createScopedToken(["privacy:delete"], "hold") },
      stdout: captureOutput().writer,
      stderr: stderr.writer,
    });

    expect(exitCode).toBe(1);
    const payload = JSON.parse(stderr.text());
    expect(payload.error).toMatchObject({
      code: "ACTIVE_RETENTION_HOLD",
      activeHolds: [{ type: "legal_hold" }, { type: "security_incident" }],
    });
    expect(stderr.text()).not.toContain(PRIVATE_ERROR_SENTINEL);
    expect(stderr.text()).not.toContain(TOKEN_SENTINEL);
  });
});

describe("machine-readable privacy output", () => {
  it("emits schema version 1 without credentials or unrecognized private fields", async () => {
    const home = await createTemporaryHome();
    await writeDaemonConfig(home, true);
    const stdout = captureOutput();
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ...privacySettings(true),
        token: TOKEN_SENTINEL,
        privateError: PRIVATE_ERROR_SENTINEL,
      }),
    );

    const exitCode = await privacyCommand(["status", "--json"], {
      home,
      env: {},
      customFetch,
      loadCredentials: async () => createCredentials(),
      stdout: stdout.writer,
      stderr: captureOutput().writer,
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload).toMatchObject({
      schemaVersion: 1,
      cloud: {
        paired: true,
        available: true,
        accountId: "acc_privacy_test",
      },
      effective: {
        metadataTelemetryEnabled: true,
        rawTranscriptUploadEnabled: false,
        redactionStrategy: "metadata-only",
      },
    });
    expect(stdout.text()).not.toContain(TOKEN_SENTINEL);
    expect(stdout.text()).not.toContain("rtk_super_secret_privacy_token");
    expect(stdout.text()).not.toContain(PRIVATE_ERROR_SENTINEL);
    expect(stdout.text()).not.toContain("config.json");
  });
});
