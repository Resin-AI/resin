import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../src/commands/init.js";
import { performPairing } from "../src/commands/login.js";
import { logoutCommand } from "../src/commands/logout.js";
import type { InstallerPairingMutation } from "../src/installer/installer.js";
import { DEFAULT_DEVICE_AUTH_SCOPES } from "../src/service/auth-bootstrap.js";

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

    return {
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "not_found" }),
    } as Response;
  });
}

async function captureOutput(action: (getStdout: () => string) => Promise<number>): Promise<{
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
    const exitCode = await action(() => stdout);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("init onboarding & pairing workflow", () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-init-home-"));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "resin-init-ws-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });
  it("displays formatted capability and privacy plan and proceeds on explicit interactive approval", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);
    let capturedStdoutAtPrompt = "";

    const result = await captureOutput(async (getStdout) => {
      const promptFn = vi.fn().mockImplementation(async (question: string) => {
        capturedStdoutAtPrompt = getStdout();
        return true;
      });

      const exitCode = await initCommand(
        ["--home", home, "--workspace", workspace, "--cloud-url", "https://api.resin.sh"],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
          promptFn,
        },
      );
      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(promptFn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Do you authorize Resin with the capability envelope and privacy plan displayed above?",
        ),
      );
      return exitCode;
    });

    expect(result.exitCode).toBe(0);

    // Prove privacy and capability details are printed before prompt
    expect(capturedStdoutAtPrompt).toContain("RESIN AUTHORIZATION PLAN");
    expect(capturedStdoutAtPrompt).toContain("1. CAPABILITY ENVELOPE (SANDBOX CONSTRAINTS):");
    expect(capturedStdoutAtPrompt).toContain("Filesystem Read/Write:");
    expect(capturedStdoutAtPrompt).toContain("Filesystem Deny Paths:");
    expect(capturedStdoutAtPrompt).toContain("Network Outbound:");
    expect(capturedStdoutAtPrompt).toContain("Allowed Commands:");
    expect(capturedStdoutAtPrompt).toContain("2. PRIVACY & OBSERVABILITY BOUNDARY:");
    expect(capturedStdoutAtPrompt).toContain("Redaction Strategy:");
    expect(capturedStdoutAtPrompt).toContain("Local-Only Mode:");
    expect(capturedStdoutAtPrompt).toContain("3. TARGET HARNESS REGISTRATIONS:");
    expect(capturedStdoutAtPrompt).toContain(`Target Workspace: ${workspace}`);
    expect(capturedStdoutAtPrompt).toContain("Status:          PENDING AUTHORIZATION");

    expect(result.stdout).toContain("RESIN AUTHORIZATION PLAN");
    expect(result.stdout).toContain("1. CAPABILITY ENVELOPE (SANDBOX CONSTRAINTS):");
    expect(result.stdout).toContain("2. PRIVACY & OBSERVABILITY BOUNDARY:");
    expect(result.stdout).toContain("3. TARGET HARNESS REGISTRATIONS:");
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });
  it("aborts cleanly and prevents pairing or file mutation when interactive authorization is denied", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);
    const promptFn = vi.fn().mockResolvedValue(false);

    const result = await captureOutput(async () => {
      return await initCommand(
        ["--home", home, "--workspace", workspace, "--cloud-url", "https://api.resin.sh"],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
          promptFn,
        },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain("RESIN AUTHORIZATION PLAN");
    expect(result.stderr).toContain("Authorization declined by user. Installation aborted.");
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();

    // Verify durable token file was not written
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });

  it("fails closed on EOF or non-yes prompt response and prevents pairing", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn();
    const promptFn = vi.fn().mockImplementation(async () => false);

    const result = await captureOutput(async () => {
      return await initCommand(
        ["--home", home, "--workspace", workspace, "--cloud-url", "https://api.resin.sh"],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
          promptFn,
        },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Authorization declined by user. Installation aborted.");
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("bypasses interactive prompt when --auto-approve is explicitly passed", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);
    const promptFn = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--home",
          home,
          "--workspace",
          workspace,
          "--auto-approve",
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
          promptFn,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(promptFn).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("rejects non-interactive init when authorization prerequisites are missing", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--non-interactive",
          "--home",
          home,
          "--workspace",
          workspace,
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Authorization required: Non-interactive execution must provide either --capabilities-file or explicit confirmation flag.",
    );
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("reaches browser-first pairing on interactive init and records pairing summary without leaking tokens", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--home",
          home,
          "--workspace",
          workspace,
          "--auto-approve",
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(VERIFICATION_URI_COMPLETE);
    expect(result.stdout).toContain("A browser window was opened for Resin authorization.");
    expect(result.stdout).toContain(`1. Navigate to: ${VERIFICATION_URI_COMPLETE}`);
    expect(result.stdout).toContain("2. Enter code:   ABCD-9876");
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);

    // Verify durable token file was written
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const saved = JSON.parse(await fs.readFile(tokenFilePath, "utf8"));
    expect(saved.accessToken).toBe(ACCESS_TOKEN);
    expect(saved.claims.accountId).toBe("acc_live_01");
  });

  it("falls back cleanly to printed URL and code when browser launch fails during init", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockRejectedValue(new Error("No graphical display found"));

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--home",
          home,
          "--workspace",
          workspace,
          "--auto-approve",
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith(VERIFICATION_URI_COMPLETE);
    expect(result.stdout).toContain("A browser could not be opened automatically.");
    expect(result.stdout).toContain("Setup continues automatically after authorization.");
    expect(result.stdout).toContain(`1. Navigate to: ${VERIFICATION_URI_COMPLETE}`);
    expect(result.stdout).toContain("2. Enter code:   ABCD-9876");
  });

  it("supports explicit --local-only to skip pairing and avoid network requests", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = vi.fn();
    const openBrowser = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        ["--local-only", "--home", home, "--workspace", workspace, "--auto-approve"],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();

    // Verify token file was not created
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });

  it("truthfully rejects non-interactive init when no pre-provisioned credentials exist", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--non-interactive",
          "--home",
          home,
          "--workspace",
          workspace,
          "--auto-approve",
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Non-interactive init requires valid pre-provisioned credentials or --local-only",
    );
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("accepts and reuses valid pre-provisioned credentials in non-interactive mode", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "preprovisioned-access-token",
        refreshToken: "preprovisioned-refresh-token",
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_preprovisioned",
        workspaceId: "ws_preprovisioned",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_preprovisioned",
          workspaceId: "ws_preprovisioned",
          deviceId: "dev_preprovisioned",
          installationId: "inst_preprovisioned",
          userId: "usr_preprovisioned",
          subject: "usr_preprovisioned",
          scopes: [...DEFAULT_DEVICE_AUTH_SCOPES],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const customFetch = vi.fn();
    const openBrowser = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--non-interactive",
          "--home",
          home,
          "--workspace",
          workspace,
          "--auto-approve",
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("fails closed non-interactively and re-pairs a legacy refresh family for new scopes", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    const legacyRefreshToken = "legacy-refresh-family-must-not-be-rotated";
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify({
        accessToken: "legacy-access-token",
        refreshToken: legacyRefreshToken,
        cloudUrl: "https://api.resin.sh",
        deviceId: "dev_legacy_scope_family",
        workspaceId: "ws_legacy_scope_family",
        storedAt: new Date().toISOString(),
        claims: {
          accountId: "acc_legacy_scope_family",
          workspaceId: "ws_legacy_scope_family",
          deviceId: "dev_legacy_scope_family",
          installationId: "inst_legacy_scope_family",
          userId: "usr_legacy_scope_family",
          subject: "usr_legacy_scope_family",
          familyId: "fam_legacy_scope_family",
          scopes: ["device:connect", "observations:write", "catalog:read", "artifacts:read"],
          rawUploadConsent: false,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          tokenType: "access",
        },
      }),
    );

    const nonInteractiveFetch = vi.fn();
    await expect(
      performPairing({
        cloudUrl: "https://api.resin.sh",
        home,
        tokenFilePath,
        nonInteractive: true,
        customFetch: nonInteractiveFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(
      "Non-interactive init requires valid pre-provisioned credentials or --local-only",
    );
    expect(nonInteractiveFetch).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(tokenFilePath, "utf8"))).toMatchObject({
      refreshToken: legacyRefreshToken,
    });

    const customFetch = successfulDeviceFetch();
    const openBrowser = vi.fn().mockResolvedValue(true);
    let pairing: InstallerPairingMutation | undefined;
    const output = await captureOutput(async () => {
      pairing = await performPairing({
        cloudUrl: "https://api.resin.sh",
        home,
        tokenFilePath,
        customFetch: customFetch as unknown as typeof fetch,
        openBrowser,
      });
      return 0;
    });

    expect(pairing).toMatchObject({
      paired: true,
      localOnly: false,
      reused: false,
    });
    expect(openBrowser).toHaveBeenCalledWith(VERIFICATION_URI_COMPLETE);
    expect(output.stdout).toContain("ABCD-9876");
    expect(customFetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.resin.sh/v1/auth/device/code",
      "https://api.resin.sh/v1/auth/device/token",
    ]);
    const codeRequest = customFetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(codeRequest?.body))).toMatchObject({
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

  it("leaves dry-run completely side-effect free and skips pairing", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const customFetch = vi.fn();
    const openBrowser = vi.fn();

    const result = await captureOutput(async () => {
      return await initCommand(
        [
          "--dry-run",
          "--home",
          home,
          "--workspace",
          workspace,
          "--cloud-url",
          "https://api.resin.sh",
        ],
        {
          customFsBridge: bridge,
          customFetch: customFetch as unknown as typeof fetch,
          openBrowser,
        },
      );
    });

    expect(result.exitCode).toBe(0);
    expect(customFetch).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();

    // Verify token file was not created
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();
  });

  it("revokes credentials remotely, purges local tokens, and preserves project/harness files on logout without leaking tokens", async () => {
    const tokenFilePath = path.join(home, ".resin", "state", "device-token.json");
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });

    // 1. Write strict valid canonical credentials
    const canonicalCredentials = {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      cloudUrl: "https://api.resin.sh",
      deviceId: "dev_canonical_01",
      workspaceId: "ws_canonical_01",
      storedAt: new Date().toISOString(),
      claims: {
        accountId: "acc_canonical_01",
        workspaceId: "ws_canonical_01",
        deviceId: "dev_canonical_01",
        installationId: "inst_canonical_01",
        userId: "usr_canonical_01",
        subject: "usr_canonical_01",
        scopes: ["device:connect", "observations:write"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        tokenType: "access",
      },
    };
    await fs.writeFile(tokenFilePath, JSON.stringify(canonicalCredentials, null, 2), "utf-8");

    // 2. Setup project, harness, and local storage files that must be preserved
    const projectManifestPath = path.join(workspace, "resin.json");
    const projectSourcePath = path.join(workspace, "src", "index.ts");
    const harnessConfigPath = path.join(home, ".claude.json");
    const localConfigPath = path.join(home, ".resin", "config", "resin.json");
    const localDataPath = path.join(home, ".resin", "data", "events.db");

    await fs.mkdir(path.dirname(projectSourcePath), { recursive: true });
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(localDataPath), { recursive: true });

    await fs.writeFile(
      projectManifestPath,
      JSON.stringify({ version: 1, name: "my-project" }),
      "utf-8",
    );
    await fs.writeFile(projectSourcePath, "export const value = 42;", "utf-8");
    await fs.writeFile(
      harnessConfigPath,
      JSON.stringify({ mcpServers: { resin: { command: "resin-mcp" } } }),
      "utf-8",
    );
    await fs.writeFile(
      localConfigPath,
      JSON.stringify({ telemetry: false, logRetentionDays: 7 }),
      "utf-8",
    );
    await fs.writeFile(localDataPath, "SQLITE-LOCAL-DATABASE-CONTENT", "utf-8");

    // 3. Stub stored-origin /v1/auth/logout and capture revocation request
    interface RevocationRecord {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }
    const capturedRevocations: RevocationRecord[] = [];
    const customFetch = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : "url" in input
                ? input.url
                : String(input);
        const method = init?.method ?? "GET";
        const rawHeaders = init?.headers;
        const headers: Record<string, string> =
          rawHeaders instanceof Headers
            ? Object.fromEntries(rawHeaders.entries())
            : Array.isArray(rawHeaders)
              ? Object.fromEntries(rawHeaders)
              : rawHeaders && typeof rawHeaders === "object"
                ? (rawHeaders as Record<string, string>)
                : {};

        let body: Record<string, unknown> = {};
        if (init?.body && typeof init.body === "string") {
          try {
            const parsed: unknown = JSON.parse(init.body);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>;
            }
          } catch {
            body = {};
          }
        }
        if (urlStr === "https://api.resin.sh/v1/auth/logout" && method === "POST") {
          capturedRevocations.push({ url: urlStr, method, headers, body });
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ success: true, revoked: true }),
          } as Response;
        }

        return {
          ok: false,
          status: 404,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "not_found" }),
        } as Response;
      });

    // 4. Invoke logoutCommand
    const result = await captureOutput(async () => {
      return await logoutCommand(["--home", home], {
        customFetch: customFetch as unknown as typeof fetch,
      });
    });

    // 5. Assertions
    expect(result.exitCode).toBe(0);

    // Bound revocation request verification
    expect(capturedRevocations).toHaveLength(1);
    const req = capturedRevocations[0];
    expect(req.url).toBe("https://api.resin.sh/v1/auth/logout");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(req.headers["x-resin-account-id"]).toBe("acc_canonical_01");
    expect(req.headers["x-resin-workspace-id"]).toBe("ws_canonical_01");
    expect(req.headers["x-resin-device-id"]).toBe("dev_canonical_01");
    expect(req.body).toEqual({ refreshToken: REFRESH_TOKEN });

    // Token removal verification
    expect(await fs.stat(tokenFilePath).catch(() => null)).toBeNull();

    // Preserved project and harness files verification
    expect(await fs.readFile(projectManifestPath, "utf-8")).toBe(
      JSON.stringify({ version: 1, name: "my-project" }),
    );
    expect(await fs.readFile(projectSourcePath, "utf-8")).toBe("export const value = 42;");
    expect(await fs.readFile(harnessConfigPath, "utf-8")).toContain("mcpServers");
    expect(await fs.readFile(localConfigPath, "utf-8")).toContain("telemetry");
    expect(await fs.readFile(localDataPath, "utf-8")).toBe("SQLITE-LOCAL-DATABASE-CONTENT");

    // Secret confidentiality verification: tokens must never be logged to stdout or stderr
    expect(result.stdout).not.toContain(ACCESS_TOKEN);
    expect(result.stdout).not.toContain(REFRESH_TOKEN);
    expect(result.stderr).not.toContain(ACCESS_TOKEN);
    expect(result.stderr).not.toContain(REFRESH_TOKEN);
  });
});
